import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_AUTH_DB = "data/nutboard.db";
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const LOOPBACK_BINDS = ["127.0.0.1", "::1", "localhost"];
/** Words that would collide with the single-mint variables (MINT_NAME, MINT_TZ, MINT_KIND). */
const RESERVED_MINT_IDS = ["name", "tz", "kind"];

/** One PostgreSQL database nutboard reads: a mint, or the LNbits instance. */
export interface SourceConfig {
  /** short handle used in URLs (?mint=...) and environment variable names */
  id: string;
  /** display name */
  name: string;
  databaseUrl: string;
  /** Which mint software wrote the database; "auto" looks at the tables. Unused for LNbits. */
  mintKind: "auto" | "nutshell" | "cdk";
  /**
   * IANA time zone. Nutshell and LNbits store naive local timestamps, so this must be the zone their host runs in.
   * CDK stores Unix time; there the zone only decides which hour of the day an operation is filed under.
   */
  mintTz: string;
  /** PostgreSQL schema that holds the tables (the default, public, for all three) */
  pgSchema: string;
  /** Server-side statement timeout for every query. */
  statementTimeoutMs: number;
  poolMax: number;
}

/** Where kill requests are dropped for the root-side helper, and where the units it acts on are listed. */
export interface KillConfig {
  dir: string;
  conf: string;
}

export interface Config {
  /** Name of the dashboard itself: page title and the passkey's site name. */
  siteName: string;
  /** The mints to show, in display order; at least one. */
  mints: SourceConfig[];
  /** The LNbits database, when LNBITS_DATABASE_URL is set. */
  lnbits: SourceConfig | null;
  /** The kill switch, when KILL_SWITCH_DIR is set. */
  kill: KillConfig | null;
  host: string;
  port: number;
  /** Exact public origin the dashboard is served from, e.g. https://nutboard.lnpay.cz */
  origin: string;
  /** true when the origin is localhost (passkeys and cookies then work without HTTPS) */
  originIsLocal: boolean;
  /** SQLite file holding passkeys, sessions, wallet labels and the kill log (never a mint database). */
  authDb: string;
  /** Optional fixed one-time setup code for the first passkey. */
  setupCode: string | null;
  /** NUTBOARD_AUTH=off: no sign-in; only allowed when the app is local only. */
  authOff: boolean;
  /** How long computed statistics are cached in memory. */
  cacheTtlMs: number;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${key} must be a non-negative number, got "${raw}"`);
  }
  return n;
}

function kindEnv(env: NodeJS.ProcessEnv, key: string): SourceConfig["mintKind"] {
  const kind = (env[key] || "auto").toLowerCase();
  if (kind !== "auto" && kind !== "nutshell" && kind !== "cdk") {
    throw new Error(`${key} must be auto, nutshell or cdk, got "${env[key]}"`);
  }
  return kind;
}

/** Loads a .env file from the working directory if present (no dependency needed on Node >= 20.12). */
export function loadDotEnv(file = ".env"): void {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader === "function") loader.call(process, path);
}

export function authDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.AUTH_DB || DEFAULT_AUTH_DB;
}

/**
 * One mint: DATABASE_URL with MINT_NAME, MINT_TZ, MINT_KIND and PG_SCHEMA, as always.
 * Several: MINTS=old,new and for each id MINT_<ID>_DATABASE_URL, _NAME, _TZ, _KIND and _SCHEMA.
 */
function loadMints(env: NodeJS.ProcessEnv, shared: Pick<SourceConfig, "statementTimeoutMs" | "poolMax">): SourceConfig[] {
  const ids = (env.MINTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!ids.length) {
    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required, e.g. postgres://nutboard_ro:secret@localhost:5432/mint " +
          "(or MINTS=a,b with MINT_A_DATABASE_URL and MINT_B_DATABASE_URL for several mints)",
      );
    }
    return [{
      id: "mint",
      name: env.MINT_NAME || "Cashu mint",
      databaseUrl,
      mintKind: kindEnv(env, "MINT_KIND"),
      mintTz: env.MINT_TZ || "UTC",
      pgSchema: env.PG_SCHEMA || "public",
      ...shared,
    }];
  }
  const seen = new Set<string>();
  return ids.map((id) => {
    if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(id)) {
      throw new Error(`MINTS: "${id}" is not a valid mint id (letters, digits and dashes, at most 24 characters)`);
    }
    if (RESERVED_MINT_IDS.includes(id)) throw new Error(`MINTS: "${id}" cannot be used as a mint id`);
    if (seen.has(id)) throw new Error(`MINTS: "${id}" is listed twice`);
    seen.add(id);
    const prefix = `MINT_${id.toUpperCase().replaceAll("-", "_")}_`;
    const databaseUrl = env[`${prefix}DATABASE_URL`];
    if (!databaseUrl) throw new Error(`${prefix}DATABASE_URL is required for the mint "${id}" listed in MINTS`);
    return {
      id,
      name: env[`${prefix}NAME`] || id,
      databaseUrl,
      mintKind: kindEnv(env, `${prefix}KIND`),
      mintTz: env[`${prefix}TZ`] || env.MINT_TZ || "UTC",
      pgSchema: env[`${prefix}SCHEMA`] || env.PG_SCHEMA || "public",
      ...shared,
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const shared = {
    statementTimeoutMs: intEnv(env, "STATEMENT_TIMEOUT_MS", 30_000),
    poolMax: Math.max(1, intEnv(env, "PG_POOL_MAX", 4)),
  };
  const mints = loadMints(env, shared);
  const lnbits: SourceConfig | null = env.LNBITS_DATABASE_URL
    ? {
        id: "lnbits",
        name: env.LNBITS_NAME || "LNbits",
        databaseUrl: env.LNBITS_DATABASE_URL,
        mintKind: "auto",
        mintTz: env.LNBITS_TZ || "UTC",
        pgSchema: env.LNBITS_SCHEMA || "public",
        ...shared,
      }
    : null;
  const kill: KillConfig | null = env.KILL_SWITCH_DIR
    ? { dir: resolve(env.KILL_SWITCH_DIR), conf: resolve(env.KILL_SWITCH_CONF || "/etc/nutboard/killswitch.conf") }
    : null;

  const host = env.HOST || "127.0.0.1";
  const port = intEnv(env, "PORT", 3737);
  const origin = (env.ORIGIN || `http://localhost:${port}`).replace(/\/+$/, "");
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new Error(`ORIGIN must be a URL such as https://nutboard.lnpay.cz, got "${origin}"`);
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
    throw new Error(`ORIGIN must start with http:// or https://, got "${origin}"`);
  }
  if (originUrl.pathname !== "/" || originUrl.search || originUrl.hash) {
    throw new Error(`ORIGIN must be an origin without a path, got "${origin}"`);
  }
  const originIsLocal = LOCAL_HOSTNAMES.includes(originUrl.hostname);
  const authOff = env.NUTBOARD_AUTH === "off";
  if (authOff && !(originIsLocal && LOOPBACK_BINDS.includes(host))) {
    throw new Error("NUTBOARD_AUTH=off is only allowed when the dashboard is local (ORIGIN on localhost, HOST on loopback)");
  }
  return {
    // MINT_NAME used to name both the mint and the dashboard; it still names the dashboard when nothing else does.
    siteName: env.SITE_NAME || env.MINT_NAME || (mints.length === 1 ? mints[0].name : "nutboard"),
    mints,
    lnbits,
    kill,
    host,
    port,
    origin,
    originIsLocal,
    authDb: authDbPath(env),
    setupCode: env.SETUP_CODE || null,
    authOff,
    cacheTtlMs: intEnv(env, "CACHE_TTL_SECONDS", 30) * 1000,
  };
}
