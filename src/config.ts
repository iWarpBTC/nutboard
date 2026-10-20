import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_AUTH_DB = "data/nutboard.db";
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];
const LOOPBACK_BINDS = ["127.0.0.1", "::1", "localhost"];

export interface Config {
  /** PostgreSQL connection string for the Nutshell mint database. */
  databaseUrl: string;
  /** IANA time zone the mint server runs in. Nutshell stores naive local timestamps. */
  mintTz: string;
  /** PostgreSQL schema that holds the Nutshell tables (Nutshell uses the default, i.e. public). */
  pgSchema: string;
  host: string;
  port: number;
  /** Exact public origin the dashboard is served from, e.g. https://nutboard.lnpay.cz */
  origin: string;
  /** true when the origin is localhost (passkeys and cookies then work without HTTPS) */
  originIsLocal: boolean;
  /** SQLite file holding passkeys and sessions (never the mint database). */
  authDb: string;
  /** Optional fixed one-time setup code for the first passkey. */
  setupCode: string | null;
  /** NUTBOARD_AUTH=off: no sign-in; only allowed when the app is local only. */
  authOff: boolean;
  /** How long computed statistics are cached in memory. */
  cacheTtlMs: number;
  /** Server-side statement timeout for every query. */
  statementTimeoutMs: number;
  poolMax: number;
  /** Display name shown in the dashboard header. */
  mintName: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required, e.g. postgres://nutboard_ro:secret@localhost:5432/mint",
    );
  }
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
    databaseUrl,
    mintTz: env.MINT_TZ || "UTC",
    pgSchema: env.PG_SCHEMA || "public",
    host,
    port,
    origin,
    originIsLocal,
    authDb: authDbPath(env),
    setupCode: env.SETUP_CODE || null,
    authOff,
    cacheTtlMs: intEnv(env, "CACHE_TTL_SECONDS", 30) * 1000,
    statementTimeoutMs: intEnv(env, "STATEMENT_TIMEOUT_MS", 30_000),
    poolMax: Math.max(1, intEnv(env, "PG_POOL_MAX", 4)),
    mintName: env.MINT_NAME || "Nutshell mint",
  };
}
