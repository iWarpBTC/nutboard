import pg from "pg";
import type { Config } from "./config.ts";

const { Pool, types } = pg;

// Nutshell stores amounts as BIGINT and SUM()/AVG() produce NUMERIC. node-postgres returns
// both as strings; satoshi/cent amounts are far below 2^53, so plain numbers are safe.
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

export const TABLES = [
  "keysets",
  "promises",
  "proofs_used",
  "proofs_pending",
  "mint_quotes",
  "melt_quotes",
  "balance_log",
  "dbversions",
] as const;
export type TableName = (typeof TABLES)[number];

export interface SchemaInfo {
  schema: string;
  /** table name -> set of column names visible to the connected role */
  columns: Map<string, Set<string>>;
  /** Nutshell migration version from the dbversions table, if readable */
  dbVersion: number | null;
}

export interface ConnectionInfo {
  user: string;
  database: string;
  serverVersion: string;
  transactionReadOnly: boolean;
  defaultTransactionReadOnly: boolean;
  superuser: boolean;
  /** true when the role holds INSERT/UPDATE/DELETE/TRUNCATE on any table in the schema */
  roleCanWrite: boolean;
  serverNow: Date;
  mintLocalNow: string;
}

export class ReadOnlyViolation extends Error {}

function assertIdentifier(name: string, what: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`${what} must be a plain identifier, got "${name}"`);
  }
  return name;
}

export class Db {
  readonly pool: pg.Pool;
  readonly config: Config;
  schema: SchemaInfo | null = null;
  info: ConnectionInfo | null = null;

  constructor(config: Config) {
    this.config = config;
    const schema = assertIdentifier(config.pgSchema, "PG_SCHEMA");
    // Startup parameters sent with the connection: every session is read-only before the first
    // statement runs, every statement is time-limited, and timestamps are bucketed in UTC.
    const options = [
      "-c default_transaction_read_only=on",
      `-c statement_timeout=${Math.floor(config.statementTimeoutMs)}`,
      "-c TimeZone=UTC",
      `-c search_path=${schema}`,
    ].join(" ");
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.poolMax,
      application_name: "nutboard",
      options,
      idleTimeoutMillis: 60_000,
      connectionTimeoutMillis: 10_000,
    });
    // verifyConnection() refuses to start unless the server confirms these settings took effect,
    // and ping() re-checks the live session on every health call.
    this.pool.on("error", (err) => console.error("idle client error:", err.message));
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  async one<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T> {
    const rows = await this.query<T>(text, params);
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
    return rows[0];
  }

  /** Verifies the session really is read-only and records who we are connected as. */
  async verifyConnection(): Promise<ConnectionInfo> {
    const row = await this.one<{
      user: string;
      database: string;
      server_version: string;
      ro: string;
      default_ro: string;
      superuser: boolean | null;
      server_now: Date;
      mint_local_now: string;
    }>(
      `SELECT current_user AS "user",
              current_database() AS database,
              current_setting('server_version') AS server_version,
              current_setting('transaction_read_only') AS ro,
              current_setting('default_transaction_read_only') AS default_ro,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
              now() AS server_now,
              to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI:SS') AS mint_local_now`,
      [this.config.mintTz],
    );
    const priv = await this.one<{ can_write: boolean }>(
      `SELECT coalesce(bool_or(has_table_privilege(current_user,
                quote_ident(table_schema) || '.' || quote_ident(table_name),
                'INSERT, UPDATE, DELETE, TRUNCATE')), false) AS can_write
         FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
      [this.config.pgSchema],
    );
    const info: ConnectionInfo = {
      user: row.user,
      database: row.database,
      serverVersion: row.server_version,
      transactionReadOnly: row.ro === "on",
      defaultTransactionReadOnly: row.default_ro === "on",
      superuser: row.superuser === true,
      roleCanWrite: priv.can_write,
      serverNow: row.server_now,
      mintLocalNow: row.mint_local_now,
    };
    if (!info.transactionReadOnly || !info.defaultTransactionReadOnly) {
      throw new ReadOnlyViolation(
        "the database session is not read-only (default_transaction_read_only is off); refusing to run",
      );
    }
    this.info = info;
    return info;
  }

  /** Reads which Nutshell tables/columns exist, so queries can adapt to the mint's migration level. */
  async introspect(): Promise<SchemaInfo> {
    const rows = await this.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = ANY($2::text[])`,
      [this.config.pgSchema, [...TABLES]],
    );
    const columns = new Map<string, Set<string>>();
    for (const r of rows) {
      let set = columns.get(r.table_name);
      if (!set) {
        set = new Set();
        columns.set(r.table_name, set);
      }
      set.add(r.column_name);
    }
    let dbVersion: number | null = null;
    if (columns.has("dbversions")) {
      try {
        const v = await this.query<{ db: string; version: number }>(
          `SELECT db, version FROM dbversions ORDER BY (db = 'mint') DESC, version DESC LIMIT 1`,
        );
        dbVersion = v[0]?.version ?? null;
      } catch (err) {
        console.warn("could not read dbversions:", (err as Error).message);
      }
    }
    this.schema = { schema: this.config.pgSchema, columns, dbVersion };
    return this.schema;
  }

  /** Cheap liveness probe that also re-checks the read-only flag of the pooled session. */
  async ping(): Promise<{ ok: true; readOnly: boolean; latencyMs: number }> {
    const started = performance.now();
    const row = await this.one<{ ro: string }>(`SELECT current_setting('transaction_read_only') AS ro`);
    return { ok: true, readOnly: row.ro === "on", latencyMs: Math.round(performance.now() - started) };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function hasColumn(schema: SchemaInfo, table: TableName, column: string): boolean {
  return schema.columns.get(table)?.has(column) ?? false;
}

export function hasTable(schema: SchemaInfo, table: TableName): boolean {
  return schema.columns.has(table);
}
