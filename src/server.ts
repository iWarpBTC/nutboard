import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, createAuth, openAuthDb, type Auth } from "./auth.ts";
import { loadConfig, loadDotEnv, type Config, type SourceConfig } from "./config.ts";
import { Db, type ConnectionInfo, type SchemaInfo } from "./db.ts";
import { KillError, createKillSwitch, type KillSwitch } from "./kill.ts";
import { LabelError, createLabels } from "./labels.ts";
import { createLnbitsStats, type LnbitsStats } from "./lnbits.ts";
import { RANGES, WINDOWS, createStats, type MintStats, type RangeKey } from "./stats/index.ts";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");
const VENDOR: Record<string, string> = {
  "/vendor/chart.umd.js": join(ROOT, "node_modules", "chart.js", "dist", "chart.umd.js"),
};
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

interface BuildInfo {
  version: string;
  commit: string;
  dirty: boolean;
  builtAt: string | null;
  source: "build.json" | "env" | "git" | "unknown";
}

/** What is running: deploy/push.sh writes build.json, Docker passes BUILD_COMMIT, a checkout asks git. */
function readBuildInfo(): BuildInfo {
  let version = "0.0.0";
  try {
    version = String((JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string }).version ?? version);
  } catch {
    /* keep the fallback */
  }
  try {
    const b = JSON.parse(readFileSync(join(ROOT, "build.json"), "utf8")) as { commit?: string; dirty?: boolean; builtAt?: string };
    if (b.commit) return { version, commit: b.commit, dirty: !!b.dirty, builtAt: b.builtAt ?? null, source: "build.json" };
  } catch {
    /* no build.json: not deployed by push.sh */
  }
  if (process.env.BUILD_COMMIT && process.env.BUILD_COMMIT !== "unknown") {
    return { version, commit: process.env.BUILD_COMMIT, dirty: false, builtAt: null, source: "env" };
  }
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim();
    const commit = git("rev-parse", "--short", "HEAD");
    return { version, commit, dirty: git("status", "--porcelain") !== "", builtAt: null, source: "git" };
  } catch {
    return { version, commit: "unknown", dirty: false, builtAt: null, source: "unknown" };
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- tiny TTL cache with in-flight de-duplication ----------

interface CacheEntry<T> {
  expires: number;
  value: Promise<T>;
}
const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;
  const value = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { expires: now + ttlMs, value });
  return value;
}

// ---------- helpers ----------

function securityHeaders(config: Config): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...(config.origin.startsWith("https:") ? { "strict-transport-security": "max-age=31536000" } : {}),
  };
}

function sendJson(res: ServerResponse, headers: Record<string, string>, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendFile(res: ServerResponse, headers: Record<string, string>, path: string): void {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    sendJson(res, headers, 404, { error: "not found" });
    return;
  }
  res.writeHead(200, {
    ...headers,
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "content-length": size,
    "cache-control": path.includes("/node_modules/") ? "public, max-age=86400" : "no-cache",
  });
  createReadStream(path).pipe(res);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw new HttpError(415, "Expected JSON");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/**
 * Only this app may call the API: the Host must be ours (blocks DNS rebinding) and every write must come from our
 * own origin (blocks cross-site requests; the session cookie is SameSite=Strict as well).
 */
function checkOrigin(req: IncomingMessage, config: Config): void {
  const host = String(req.headers.host || "");
  const ourHost = new URL(config.origin).host;
  const hostOk = host === ourHost || (config.originIsLocal && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host));
  if (!hostOk) throw new HttpError(403, "Forbidden host");
  const origin = req.headers.origin;
  const writes = req.method !== "GET" && req.method !== "HEAD";
  if ((writes && origin !== config.origin) || (origin && origin !== config.origin)) throw new HttpError(403, "Forbidden origin");
}

function param(url: URL, name: string, fallback: string): string {
  const v = url.searchParams.get(name);
  return v === null || v === "" ? fallback : v;
}

function rangeParam(url: URL, fallback: RangeKey): RangeKey {
  const v = param(url, "range", fallback);
  if (!(v in RANGES)) throw new HttpError(400, `range must be one of ${Object.keys(RANGES).join(", ")}`);
  return v as RangeKey;
}

// ---------- sources ----------

interface MintSource {
  config: SourceConfig;
  db: Db;
  info: ConnectionInfo;
  schema: SchemaInfo;
  stats: MintStats;
}
interface LnbitsSource {
  config: SourceConfig;
  db: Db;
  info: ConnectionInfo;
  stats: LnbitsStats;
}

/** How recently the passkey must have been used before the kill switch accepts a request. */
const FRESH_SESSION_MS = 5 * 60_000;

function warnAboutRole(what: string, info: ConnectionInfo): void {
  if (info.roleCanWrite) {
    console.warn(
      `WARNING: ${what}: the database role holds write privileges on its tables. nutboard only ever runs SELECTs ` +
        "and forces read-only sessions, but a dedicated SELECT-only role is strongly recommended (see README).",
    );
  }
  if (info.superuser) console.warn(`WARNING: ${what}: connected as a superuser; use a dedicated read-only role instead.`);
}

// ---------- main ----------

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const headers = securityHeaders(config);
  const build = readBuildInfo();
  console.log(`nutboard ${build.version} ${build.commit}${build.dirty ? "+dirty" : ""} (${build.source}${build.builtAt ? `, built ${build.builtAt}` : ""})`);

  // Every source is opened and checked before anything is served: a session that is not read-only stops the start.
  const mints: MintSource[] = [];
  for (const mc of config.mints) {
    const db = new Db(mc);
    const info = await db.verifyConnection();
    const schema = await db.introspect();
    const stats = await createStats(db, schema);
    console.log(
      `mint "${mc.id}" (${mc.name}): connected to ${info.database} as ${info.user} (PostgreSQL ${info.serverVersion}), ` +
        `session read-only: ${info.transactionReadOnly}, mint: ${schema.kind}, schema version: ${schema.schemaVersion ?? "unknown"}`,
    );
    warnAboutRole(`mint "${mc.id}"`, info);
    const units = await stats.listUnits();
    console.log(`  units: ${units.join(", ") || "(none yet)"}; time zone: ${mc.mintTz}; local time there: ${info.mintLocalNow}`);
    const tzCheck = await stats.timeZoneSanity();
    if (tzCheck?.newestRow) {
      console.log(`  newest ledger row: ${tzCheck.newestRow} (mint local), ${Math.round((tzCheck.ageConfiguredSeconds ?? 0) / 60)} min ago as ${mc.mintTz}`);
    }
    if (tzCheck?.hint) console.warn(`WARNING: mint "${mc.id}": ${tzCheck.hint}`);
    mints.push({ config: mc, db, info, schema, stats });
  }
  const mintById = new Map(mints.map((m) => [m.config.id, m]));

  let lnbits: LnbitsSource | null = null;
  if (config.lnbits) {
    const db = new Db(config.lnbits);
    const info = await db.verifyConnection();
    const stats = await createLnbitsStats(db);
    console.log(
      `LNbits (${config.lnbits.name}): connected to ${info.database} as ${info.user} (PostgreSQL ${info.serverVersion}), ` +
        `session read-only: ${info.transactionReadOnly}; time zone: ${config.lnbits.mintTz}`,
    );
    warnAboutRole("LNbits", info);
    lnbits = { config: config.lnbits, db, info, stats };
  }

  // nutboard's own SQLite file: passkeys and sessions, the names given to LNbits wallets, the kill log.
  const stateDb = openAuthDb(config.authDb);
  const labels = createLabels(stateDb);
  let auth: Auth | null = null;
  if (config.authOff) {
    console.log("Sign-in is OFF (NUTBOARD_AUTH=off, local only).");
  } else {
    auth = createAuth(stateDb, { origin: config.origin, setupCode: config.setupCode, rpName: config.siteName });
    console.log(`passkeys and sessions: ${config.authDb} (rpID ${auth.rpID})`);
  }
  let kill: KillSwitch | null = null;
  if (config.kill) {
    kill = createKillSwitch(stateDb, config.kill);
    const s = await kill.status();
    console.log(`kill switch: requests go to ${config.kill.dir}, units from ${config.kill.conf} (${s.units.length} units)`);
    for (const p of s.problems) console.warn(`WARNING: kill switch: ${p}`);
  }

  const ttl = config.cacheTtlMs;

  function mintOf(url: URL): MintSource {
    const id = param(url, "mint", mints[0].config.id);
    const m = mintById.get(id);
    if (!m) throw new HttpError(400, `unknown mint "${id}"; known: ${[...mintById.keys()].join(", ")}`);
    return m;
  }

  async function resolveUnit(m: MintSource, url: URL): Promise<string> {
    const list = await cached(`${m.config.id}:units`, ttl, () => m.stats.listUnits());
    const unit = param(url, "unit", list.includes("sat") ? "sat" : (list[0] ?? "sat"));
    if (!list.includes(unit)) throw new HttpError(400, `unknown unit "${unit}"; known: ${list.join(", ")}`);
    return unit;
  }

  function needLnbits(): LnbitsSource {
    if (!lnbits) throw new HttpError(404, "LNbits is not configured (LNBITS_DATABASE_URL)");
    return lnbits;
  }

  /** The few figures per source that the front page puts side by side. One failing source does not hide the others. */
  async function summary(): Promise<unknown> {
    const mintRows = await Promise.all(
      mints.map(async (m) => {
        const id = m.config.id;
        const base = { id, name: m.config.name, kind: m.stats.kind, exactSwaps: m.stats.features.exactSwaps };
        try {
          const units = await cached(`${id}:units`, ttl, () => m.stats.listUnits());
          const perUnit = await Promise.all(
            units.map(async (unit) => {
              const [o, checks] = await Promise.all([
                cached(`${id}:overview:${unit}`, ttl, () => m.stats.overview(unit)),
                cached(`${id}:audit:${unit}`, ttl, () => m.stats.audit(unit)),
              ]);
              const windows = Object.fromEntries(
                WINDOWS.map((w) => [w.key, {
                  minted: { count: o.mint[w.key].count, amount: o.mint[w.key].amount },
                  melted: { count: o.melt[w.key].count, amount: o.melt[w.key].amount },
                  swapped: { count: o.signatures[w.key].swap_ops, amount: o.signatures[w.key].swap_amount },
                }]),
              );
              const count = (status: string) => checks.filter((c) => c.status === status).length;
              return {
                unit,
                outstanding: o.liabilities.outstanding,
                pending: o.liabilities.pending,
                lastActivity: o.lastActivity.any,
                windows,
                audit: { fail: count("fail"), warn: count("warn") },
              };
            }),
          );
          return { ...base, units: perUnit, error: null };
        } catch (err) {
          console.error(`summary: mint "${id}": ${(err as Error).message}`);
          return { ...base, units: [], error: "could not read this mint's database" };
        }
      }),
    );
    let ln: { name: string; balance: number; wallets: number; fundedWallets: number; lastPayment: Date | null; payments: unknown; error: string | null } | null = null;
    if (lnbits) {
      const src = lnbits;
      try {
        const o = await cached("lnbits:overview", ttl, () => src.stats.overview());
        ln = { name: src.config.name, balance: o.balance, wallets: o.wallets, fundedWallets: o.fundedWallets, lastPayment: o.lastPayment, payments: o.payments, error: null };
      } catch (err) {
        console.error(`summary: LNbits: ${(err as Error).message}`);
        ln = { name: src.config.name, balance: 0, wallets: 0, fundedWallets: 0, lastPayment: null, payments: null, error: "could not read the LNbits database" };
      }
    }
    // What the Lightning node has to cover if all of this sits on one node: sat ecash plus LNbits balances.
    const mintSat = mintRows.reduce((s, m) => s + m.units.filter((u) => u.unit === "sat").reduce((x, u) => x + u.outstanding, 0), 0);
    return {
      generatedAt: new Date().toISOString(),
      windows: WINDOWS,
      mints: mintRows,
      lnbits: ln,
      liabilitiesSat: { mints: mintSat, lnbits: ln?.balance ?? 0, total: mintSat + (ln?.balance ?? 0) },
    };
  }

  /** Sign-in endpoints: the only API that answers without a session. */
  async function authApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method;
    if (method === "GET" && path === "/api/auth/status") {
      const body = auth ? auth.status(req) : { registered: true, authenticated: true, authDisabled: true, rpID: new URL(config.origin).hostname };
      return sendJson(res, headers, 200, body);
    }
    if (!auth) throw new HttpError(404, "Sign-in is off");
    if (method === "POST" && path === "/api/auth/register/options") {
      return sendJson(res, headers, 200, await auth.registrationOptions(req, await readJson(req)));
    }
    if (method === "POST" && path === "/api/auth/register/verify") {
      return sendJson(res, headers, 200, await auth.registrationVerify(req, res, await readJson(req)));
    }
    if (method === "POST" && path === "/api/auth/login/options") {
      return sendJson(res, headers, 200, await auth.authenticationOptions());
    }
    if (method === "POST" && path === "/api/auth/login/verify") {
      return sendJson(res, headers, 200, await auth.authenticationVerify(req, res, await readJson(req)));
    }
    if (method === "POST" && path === "/api/auth/logout") {
      auth.logout(req, res);
      return sendJson(res, headers, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/auth/logout-all") return sendJson(res, headers, 200, auth.logoutEverywhere(req, res));
    if (method === "GET" && path === "/api/auth/passkeys") return sendJson(res, headers, 200, auth.listPasskeys(req));
    if (method === "DELETE" && path.startsWith("/api/auth/passkeys/")) {
      let id: string;
      try {
        id = decodeURIComponent(path.slice("/api/auth/passkeys/".length));
      } catch {
        throw new HttpError(400, "Bad passkey id");
      }
      return sendJson(res, headers, 200, auth.deletePasskey(req, id));
    }
    throw new HttpError(404, "unknown endpoint");
  }

  async function statsApi(url: URL): Promise<unknown> {
    switch (url.pathname) {
      case "/api/health": {
        const m = mintOf(url);
        const id = m.config.id;
        const ping = await m.db.ping();
        const tz = await cached(`${id}:tz-sanity`, Math.max(ttl, 60_000), () => m.stats.timeZoneSanity());
        return {
          build,
          siteName: config.siteName,
          // what this dashboard shows: the mints, LNbits and whether the kill switch is installed
          mints: mints.map((x) => ({ id: x.config.id, name: x.config.name, kind: x.stats.kind })),
          lnbits: lnbits ? { name: lnbits.config.name } : null,
          killSwitch: !!kill,
          // the mint this answer is about (?mint=)
          mint: id,
          timeZone: tz,
          ok: ping.ok,
          readOnly: ping.readOnly,
          dbLatencyMs: ping.latencyMs,
          mintName: m.config.name,
          mintTz: m.config.mintTz,
          mintKind: m.stats.kind,
          schemaVersion: m.schema.schemaVersion,
          features: m.stats.features,
          nutshellDbVersion: m.schema.dbVersion,
          connection: {
            user: m.info.user,
            database: m.info.database,
            serverVersion: m.info.serverVersion,
            roleCanWrite: m.info.roleCanWrite,
            superuser: m.info.superuser,
          },
          cacheTtlSeconds: config.cacheTtlMs / 1000,
          authDisabled: config.authOff,
          serverTime: new Date().toISOString(),
        };
      }
      case "/api/summary":
        return cached("summary", ttl, summary);
      case "/api/units": {
        const m = mintOf(url);
        return cached(`${m.config.id}:units`, ttl, () => m.stats.listUnits());
      }
      case "/api/overview": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        return cached(`${m.config.id}:overview:${unit}`, ttl, () => m.stats.overview(unit));
      }
      case "/api/timeseries": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        const range = rangeParam(url, "30d");
        return cached(`${m.config.id}:timeseries:${unit}:${range}`, ttl, () => m.stats.timeseries(unit, range));
      }
      case "/api/keysets": {
        const m = mintOf(url);
        return cached(`${m.config.id}:keysets`, ttl, () => m.stats.keysets());
      }
      case "/api/denominations": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        return cached(`${m.config.id}:denominations:${unit}`, ttl, () => m.stats.denominations(unit));
      }
      case "/api/balance-log": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        const range = rangeParam(url, "90d");
        return cached(`${m.config.id}:balance-log:${unit}:${range}`, ttl, () => m.stats.balanceLog(unit, range));
      }
      case "/api/fees": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        const range = rangeParam(url, "30d");
        return cached(`${m.config.id}:fees:${unit}:${range}`, ttl, () => m.stats.fees(unit, range));
      }
      case "/api/hourly": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        return cached(`${m.config.id}:hourly:${unit}`, ttl, () => m.stats.hourly(unit));
      }
      case "/api/activity": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        const limit = Math.min(200, Math.max(1, Number(param(url, "limit", "50")) || 50));
        return cached(`${m.config.id}:activity:${unit}:${limit}`, ttl, () => m.stats.recentActivity(unit, limit));
      }
      case "/api/audit": {
        const m = mintOf(url);
        const unit = await resolveUnit(m, url);
        return cached(`${m.config.id}:audit:${unit}`, ttl, () => m.stats.audit(unit));
      }
      case "/api/lnbits/overview": {
        const src = needLnbits();
        return cached("lnbits:overview", ttl, () => src.stats.overview());
      }
      case "/api/lnbits/wallets": {
        const src = needLnbits();
        return cached("lnbits:wallets", ttl, () => src.stats.wallets());
      }
      case "/api/lnbits/payments": {
        const src = needLnbits();
        const limit = Math.min(200, Math.max(1, Number(param(url, "limit", "50")) || 50));
        const wallet = url.searchParams.get("wallet") || null;
        if (wallet && wallet.length > 200) throw new HttpError(400, "bad wallet id");
        return cached(`lnbits:payments:${limit}:${wallet ?? ""}`, ttl, () => src.stats.payments(limit, wallet));
      }
      case "/api/lnbits/timeseries": {
        const src = needLnbits();
        const range = rangeParam(url, "30d");
        return cached(`lnbits:timeseries:${range}`, ttl, () => src.stats.timeseries(range));
      }
      case "/api/labels":
        return labels.all();
      case "/api/kill": {
        // Asking systemd starts a process; a few seconds of cache keep a busy page from doing that in bursts.
        const k = kill;
        return k ? cached("kill", 5_000, () => k.status()) : { enabled: false };
      }
      default:
        throw new HttpError(404, "unknown endpoint");
    }
  }

  /** The two things a signed-in operator can change: a wallet's name, and the kill switch. */
  async function writeApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/api/labels" && req.method === "PUT") {
      const body = await readJson(req);
      try {
        sendJson(res, headers, 200, labels.set(body.kind, body.id, body.name));
      } catch (err) {
        if (err instanceof LabelError) throw new HttpError(400, err.message);
        throw err;
      }
      return true;
    }
    if (url.pathname === "/api/kill" && req.method === "POST") {
      if (!kill) throw new HttpError(404, "The kill switch is not configured (KILL_SWITCH_DIR)");
      // Never without sign-in, not even locally: NUTBOARD_AUTH=off is for looking at fixtures.
      if (!auth) throw new HttpError(403, "The kill switch needs sign-in; it does nothing while NUTBOARD_AUTH=off");
      // A session cookie alone is not enough either: the passkey has to have been used in the last few minutes.
      const session = auth.requireFreshSession(req, FRESH_SESSION_MS);
      const body = await readJson(req);
      kill.request(body.target, body.confirm, {
        credentialId: session.credential_id,
        userAgent: String(req.headers["user-agent"] ?? "").slice(0, 200) || null,
      });
      console.warn(`KILL SWITCH: "${String(body.target)}" requested`);
      cache.delete("kill");
      sendJson(res, headers, 202, await kill.status());
      return true;
    }
    return false;
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    checkOrigin(req, config);
    if (url.pathname.startsWith("/api/auth/")) return authApi(req, res, url.pathname);
    if (url.pathname === "/api/public/fees" && req.method === "GET") {
      // Aggregate fee figures only: shown on the sign-in page to anyone.
      const m = mintOf(url);
      const unit = await resolveUnit(m, url);
      return sendJson(res, headers, 200, await cached(`${m.config.id}:public-fees:${unit}`, Math.max(config.cacheTtlMs, 300_000), () => m.stats.publicFees(unit)));
    }
    if (auth) auth.requireSession(req);
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (await writeApi(req, res, url)) return;
      throw new HttpError(405, "method not allowed");
    }
    sendJson(res, headers, 200, await statsApi(url));
  }

  function staticFile(res: ServerResponse, pathname: string): void {
    const vendored = VENDOR[pathname];
    if (vendored) return sendFile(res, headers, vendored);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      throw new HttpError(400, "Bad path");
    }
    const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
    const file = resolve(PUBLIC_DIR, "." + (rel.startsWith("/") ? rel : "/" + rel));
    if (!file.startsWith(PUBLIC_DIR + "/")) throw new HttpError(404, "not found");
    sendFile(res, headers, file);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await api(req, res, url);
      else if (req.method === "GET" || req.method === "HEAD") staticFile(res, url.pathname);
      else throw new HttpError(405, "method not allowed");
    } catch (err) {
      const known = err instanceof HttpError || err instanceof AuthError || err instanceof KillError;
      const status = known ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(`${req.method} ${url.pathname}: ${message}`);
      if (!res.headersSent) {
        sendJson(res, headers, status, {
          error: status === 500 ? "Internal error" : message,
          ...(err instanceof AuthError || err instanceof KillError ? { code: err.code } : {}),
        });
      } else {
        res.end();
      }
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`nutboard → ${config.origin}  (listening on ${config.host}:${config.port})`);
  });

  const shutdown = (signal: string) => {
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      Promise.allSettled([...mints.map((m) => m.db.close()), ...(lnbits ? [lnbits.db.close()] : [])]).finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
