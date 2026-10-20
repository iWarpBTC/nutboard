import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthError, createAuth, openAuthDb, type Auth } from "./auth.ts";
import { loadConfig, loadDotEnv, type Config } from "./config.ts";
import { Db } from "./db.ts";
import * as stats from "./stats.ts";

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

function rangeParam(url: URL, fallback: stats.RangeKey): stats.RangeKey {
  const v = param(url, "range", fallback);
  if (!(v in stats.RANGES)) throw new HttpError(400, `range must be one of ${Object.keys(stats.RANGES).join(", ")}`);
  return v as stats.RangeKey;
}

// ---------- main ----------

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const headers = securityHeaders(config);
  const build = readBuildInfo();
  console.log(`nutboard ${build.version} ${build.commit}${build.dirty ? "+dirty" : ""} (${build.source}${build.builtAt ? `, built ${build.builtAt}` : ""})`);
  const db = new Db(config);

  const info = await db.verifyConnection();
  const schema = await db.introspect();
  const caps = await stats.capabilities(db, schema);

  console.log(
    `connected to ${info.database} as ${info.user} (PostgreSQL ${info.serverVersion}), ` +
      `session read-only: ${info.transactionReadOnly}, nutshell db version: ${schema.dbVersion ?? "unknown"}`,
  );
  if (info.roleCanWrite) {
    console.warn(
      "WARNING: the database role holds write privileges on mint tables. nutboard only ever runs SELECTs " +
        "and forces read-only sessions, but a dedicated SELECT-only role is strongly recommended (see README).",
    );
  }
  if (info.superuser) {
    console.warn("WARNING: connected as a superuser; use a dedicated read-only role instead.");
  }
  const units = await stats.listUnits(db);
  console.log(`units: ${units.join(", ") || "(none yet)"}; mint time zone: ${config.mintTz}; mint local time: ${info.mintLocalNow}`);
  const tzCheck = await stats.timeZoneSanity(db, config.mintTz);
  if (tzCheck.newestRow) {
    console.log(`newest ledger row: ${tzCheck.newestRow} (mint local), ${Math.round((tzCheck.ageConfiguredSeconds ?? 0) / 60)} min ago as ${config.mintTz}`);
  }
  if (tzCheck.hint) console.warn(`WARNING: ${tzCheck.hint}`);

  let auth: Auth | null = null;
  if (config.authOff) {
    console.log("Sign-in is OFF (NUTBOARD_AUTH=off, local only).");
  } else {
    const authDb = openAuthDb(config.authDb);
    auth = createAuth(authDb, { origin: config.origin, setupCode: config.setupCode, rpName: config.mintName });
    console.log(`passkeys and sessions: ${config.authDb} (rpID ${auth.rpID})`);
  }

  async function resolveUnit(url: URL): Promise<string> {
    const list = await cached("units", config.cacheTtlMs, () => stats.listUnits(db));
    const unit = param(url, "unit", list.includes("sat") ? "sat" : (list[0] ?? "sat"));
    if (!list.includes(unit)) throw new HttpError(400, `unknown unit "${unit}"; known: ${list.join(", ")}`);
    return unit;
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
    const ttl = config.cacheTtlMs;
    switch (url.pathname) {
      case "/api/health": {
        const ping = await db.ping();
        const tz = await cached("tz-sanity", Math.max(ttl, 60_000), () => stats.timeZoneSanity(db, config.mintTz));
        return {
          build,
          timeZone: tz,
          ok: ping.ok,
          readOnly: ping.readOnly,
          dbLatencyMs: ping.latencyMs,
          mintName: config.mintName,
          mintTz: config.mintTz,
          nutshellDbVersion: schema.dbVersion,
          connection: {
            user: info.user,
            database: info.database,
            serverVersion: info.serverVersion,
            roleCanWrite: info.roleCanWrite,
            superuser: info.superuser,
          },
          cacheTtlSeconds: config.cacheTtlMs / 1000,
          authDisabled: config.authOff,
          serverTime: new Date().toISOString(),
        };
      }
      case "/api/units":
        return cached("units", ttl, () => stats.listUnits(db));
      case "/api/overview": {
        const unit = await resolveUnit(url);
        return cached(`overview:${unit}`, ttl, () => stats.overview(db, caps, unit));
      }
      case "/api/timeseries": {
        const unit = await resolveUnit(url);
        const range = rangeParam(url, "30d");
        return cached(`timeseries:${unit}:${range}`, ttl, () => stats.timeseries(db, caps, unit, range));
      }
      case "/api/keysets":
        return cached("keysets", ttl, () => stats.keysets(db, caps));
      case "/api/denominations": {
        const unit = await resolveUnit(url);
        return cached(`denominations:${unit}`, ttl, () => stats.denominations(db, unit));
      }
      case "/api/balance-log": {
        const unit = await resolveUnit(url);
        const range = rangeParam(url, "90d");
        return cached(`balance-log:${unit}:${range}`, ttl, () => stats.balanceLog(db, caps, unit, range));
      }
      case "/api/fees": {
        const unit = await resolveUnit(url);
        const range = rangeParam(url, "30d");
        return cached(`fees:${unit}:${range}`, ttl, () => stats.fees(db, caps, unit, range));
      }
      case "/api/hourly": {
        const unit = await resolveUnit(url);
        return cached(`hourly:${unit}`, ttl, () => stats.hourly(db, caps, unit));
      }
      case "/api/activity": {
        const unit = await resolveUnit(url);
        const limit = Math.min(200, Math.max(1, Number(param(url, "limit", "50")) || 50));
        return cached(`activity:${unit}:${limit}`, ttl, () => stats.recentActivity(db, caps, unit, limit));
      }
      case "/api/audit": {
        const unit = await resolveUnit(url);
        return cached(`audit:${unit}`, ttl, () => stats.audit(db, caps, unit));
      }
      default:
        throw new HttpError(404, "unknown endpoint");
    }
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    checkOrigin(req, config);
    if (url.pathname.startsWith("/api/auth/")) return authApi(req, res, url.pathname);
    if (url.pathname === "/api/public/fees" && req.method === "GET") {
      // Aggregate fee figures only: shown on the sign-in page to anyone.
      const unit = await resolveUnit(url);
      return sendJson(res, headers, 200, await cached(`public-fees:${unit}`, Math.max(config.cacheTtlMs, 300_000), () => stats.publicFees(db, caps, unit)));
    }
    if (auth) auth.requireSession(req);
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
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
      const known = err instanceof HttpError || err instanceof AuthError;
      const status = known ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(`${req.method} ${url.pathname}: ${message}`);
      if (!res.headersSent) {
        sendJson(res, headers, status, {
          error: status === 500 ? "Internal error" : message,
          ...(err instanceof AuthError ? { code: err.code } : {}),
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
      db.close().finally(() => process.exit(0));
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
