import type { Db } from "./db.ts";
import { RANGES, WINDOWS, alignSeries, unpack, type RangeKey, type SeriesPoint, type WindowTable } from "./stats/shared.ts";

/*
 * Read-only figures from an LNbits database (PostgreSQL, LNbits 1.x). Plain SELECTs, nothing here writes.
 *
 * What nutboard looks at, and what it deliberately does not:
 *  - wallets and accounts: ids, names, who owns what. Never the API keys (adminkey, inkey).
 *  - apipayments: amount, fee, status, time and which extension made the payment. Never the invoice,
 *    the preimage or the memo.
 *  - balances: LNbits' own view of what each wallet holds.
 *
 * LNbits keeps amounts in millisatoshi; everything returned here is in sat. An outgoing payment has a
 * negative amount. A payment between two wallets of the same LNbits never touches Lightning: its outgoing
 * leg is stored with a checking_id that starts with "internal_".
 * Timestamps are naive and in the zone of the LNbits host (LNBITS_TZ, UTC by default).
 */

const REQUIRED: Array<[string, string[]]> = [
  ["wallets", ["id", "name", "user", "deleted"]],
  ["apipayments", ["amount", "fee", "wallet_id", "status", "checking_id"]],
  ["balances", ["wallet_id", "balance"]],
];
const TABLES = ["wallets", "apipayments", "balances", "accounts", "dbversions"] as const;

export interface LnbitsOverview {
  generatedAt: string;
  windows: typeof WINDOWS;
  /** wallets that are not deleted */
  wallets: number;
  deletedWallets: number;
  /** wallets holding more than nothing */
  fundedWallets: number;
  /** accounts that own at least one live wallet */
  accounts: number;
  /** what LNbits owes its wallets in total, in sat */
  balance: number;
  /** payments per window: received, sent over Lightning, moved between wallets, failed */
  payments: WindowTable;
  /** outgoing payments still in flight */
  pendingOut: { count: number; amount: number };
  /** invoices created in the last day and not paid yet (older ones are just abandoned) */
  openInvoices: number;
  lastPayment: Date | null;
  /** LNbits core migration level, if readable */
  schemaVersion: string | null;
}

export interface LnbitsWallet {
  id: string;
  name: string;
  /** id of the account that owns the wallet */
  account: string;
  /** the account's user name in LNbits, when it has one */
  accountName: string | null;
  currency: string | null;
  deleted: boolean;
  createdAt: Date | null;
  balance: number;
  received: number;
  sent: number;
  /** settled payments, both directions */
  payments: number;
  received30d: number;
  sent30d: number;
  lastActivity: Date | null;
}

export interface LnbitsPayment {
  at: Date;
  walletId: string;
  /** sat; negative when the wallet paid */
  amount: number;
  fee: number;
  status: string;
  /** the extension or feature that made the payment, when LNbits recorded one */
  tag: string | null;
  internal: boolean;
}

export interface LnbitsSeries {
  range: RangeKey;
  bin: string | null;
  buckets: string[];
  received: SeriesPoint[];
  sent: SeriesPoint[];
}

export interface LnbitsStats {
  overview(): Promise<LnbitsOverview>;
  wallets(): Promise<LnbitsWallet[]>;
  payments(limit: number, walletId: string | null): Promise<LnbitsPayment[]>;
  timeseries(range: RangeKey): Promise<LnbitsSeries>;
}

/** Whole sat from an aggregate of millisatoshi. */
const sat = (msatExpr: string): string => `round(coalesce(${msatExpr}, 0) / 1000.0)::bigint`;

export async function createLnbitsStats(db: Db): Promise<LnbitsStats> {
  const columns = await db.readableColumns(TABLES);
  for (const [table, needed] of REQUIRED) {
    const have = columns.get(table);
    const missing = needed.filter((c) => !have?.has(c));
    if (missing.length) {
      throw new Error(
        `LNbits: ${table}.${missing.join(", ")} is not readable in schema "${db.config.pgSchema}". ` +
          "Is LNBITS_DATABASE_URL an LNbits 1.x database, and did scripts/create-readonly-role.sql run in it?",
      );
    }
  }
  const tz = db.config.mintTz;
  const pay = columns.get("apipayments") as Set<string>;
  /** When a payment was made (alias p), as stored: naive, in the LNbits host's zone. */
  const T = pay.has("created_at") ? (pay.has("time") ? "coalesce(p.created_at, p.time)" : "p.created_at") : "p.time";
  const TAG = pay.has("tag")
    ? pay.has("extension") ? "coalesce(nullif(p.tag, ''), nullif(p.extension, ''))" : "nullif(p.tag, '')"
    : "NULL::text";
  const hasAccounts = (columns.get("accounts")?.has("id") && columns.get("accounts")?.has("username")) ?? false;
  const walletCols = columns.get("wallets") as Set<string>;
  const LIVE = "NOT coalesce(w.deleted, false)";
  /** Naive timestamp in LNbits time for "now minus interval"; $1 must be the time zone. */
  const since = (interval: string): string => `((now() - interval '${interval}') AT TIME ZONE $1)`;

  /** One column per (window, measure): "<window>__<measure>". A measure in millisatoshi is returned in whole sat. */
  function windowed(measures: Array<{ name: string; agg: string; where: string; msat?: boolean }>): string {
    const parts: string[] = [];
    for (const w of WINDOWS) {
      for (const m of measures) {
        const conds = [m.where];
        if (w.interval) conds.push(`t >= ${since(w.interval)}`);
        const filtered = `${m.agg} FILTER (WHERE ${conds.join(" AND ")})`;
        parts.push(`${m.msat ? sat(filtered) : `coalesce(${filtered}, 0)`} AS "${w.key}__${m.name}"`);
      }
    }
    return parts.join(",\n       ");
  }

  async function overview(): Promise<LnbitsOverview> {
    const paid = "status = 'success'";
    const paymentsQ = db.one<Record<string, number>>(
      `WITH src AS (
         SELECT p.amount, abs(p.fee) AS fee, p.status, ${T} AS t, (p.checking_id LIKE 'internal\\_%') AS internal
           FROM apipayments p)
       SELECT ${windowed([
         { name: "received_count", agg: "count(*)", where: `${paid} AND amount > 0` },
         { name: "received_amount", agg: "sum(amount)", msat: true, where: `${paid} AND amount > 0` },
         { name: "sent_count", agg: "count(*)", where: `${paid} AND amount < 0 AND NOT internal` },
         { name: "sent_amount", agg: "sum(-amount)", msat: true, where: `${paid} AND amount < 0 AND NOT internal` },
         { name: "fees", agg: "sum(fee)", msat: true, where: `${paid} AND amount < 0 AND NOT internal` },
         { name: "internal_count", agg: "count(*)", where: `${paid} AND amount < 0 AND internal` },
         { name: "internal_amount", agg: "sum(-amount)", msat: true, where: `${paid} AND amount < 0 AND internal` },
         { name: "failed_count", agg: "count(*)", where: "status = 'failed'" },
       ])}
         FROM src`,
      [tz],
    );
    const walletsQ = db.one<{ wallets: number; deleted: number; accounts: number }>(
      `SELECT count(*) FILTER (WHERE ${LIVE})::int AS wallets, count(*) FILTER (WHERE NOT ${LIVE})::int AS deleted,
              count(DISTINCT w."user") FILTER (WHERE ${LIVE})::int AS accounts
         FROM wallets w`,
    );
    const balanceQ = db.one<{ balance: number; funded: number }>(
      `SELECT ${sat("sum(b.balance)")} AS balance, count(*) FILTER (WHERE b.balance >= 1000)::int AS funded
         FROM (SELECT wallet_id, sum(balance) AS balance FROM balances GROUP BY wallet_id) b`,
    );
    const pendingQ = db.one<{ out_count: number; out_amount: number; open_invoices: number; last: Date | null }>(
      `SELECT count(*) FILTER (WHERE p.status = 'pending' AND p.amount < 0)::int AS out_count,
              ${sat("sum(-p.amount) FILTER (WHERE p.status = 'pending' AND p.amount < 0)")} AS out_amount,
              count(*) FILTER (WHERE p.status = 'pending' AND p.amount > 0 AND ${T} >= ${since("1 day")})::int AS open_invoices,
              (max(${T}) FILTER (WHERE p.status = 'success')) AT TIME ZONE $1 AS last
         FROM apipayments p`,
      [tz],
    );
    const versionQ: Promise<string | null> = columns.has("dbversions")
      ? db
          .query<{ version: number }>(`SELECT version FROM dbversions WHERE db = 'core' LIMIT 1`)
          .then((rows) => (rows[0] ? String(rows[0].version) : null))
          .catch(() => null)
      : Promise.resolve(null);
    const [payments, w, b, pending, schemaVersion] = await Promise.all([paymentsQ, walletsQ, balanceQ, pendingQ, versionQ]);
    return {
      generatedAt: new Date().toISOString(),
      windows: WINDOWS,
      wallets: w.wallets,
      deletedWallets: w.deleted,
      fundedWallets: b.funded,
      accounts: w.accounts,
      balance: b.balance,
      payments: unpack(payments),
      pendingOut: { count: pending.out_count, amount: pending.out_amount },
      openInvoices: pending.open_invoices,
      lastPayment: pending.last,
      schemaVersion,
    };
  }

  async function wallets(): Promise<LnbitsWallet[]> {
    const rows = await db.query<{
      id: string; name: string | null; account: string; account_name: string | null; currency: string | null;
      deleted: boolean; created_at: Date | null; balance: number; received: number; sent: number; payments: number;
      received_30d: number; sent_30d: number; last_activity: Date | null;
    }>(
      `WITH pay AS (
         SELECT p.wallet_id,
                ${sat("sum(p.amount) FILTER (WHERE p.amount > 0)")} AS received,
                ${sat("sum(-p.amount) FILTER (WHERE p.amount < 0)")} AS sent,
                count(*)::int AS payments,
                ${sat(`sum(p.amount) FILTER (WHERE p.amount > 0 AND ${T} >= ${since("30 days")})`)} AS received_30d,
                ${sat(`sum(-p.amount) FILTER (WHERE p.amount < 0 AND ${T} >= ${since("30 days")})`)} AS sent_30d,
                max(${T}) AS last_activity
           FROM apipayments p WHERE p.status = 'success' GROUP BY p.wallet_id),
       bal AS (SELECT wallet_id, sum(balance) AS balance FROM balances GROUP BY wallet_id)
       SELECT w.id, w.name, w."user" AS account,
              ${hasAccounts ? "nullif(a.username, '')" : "NULL::text"} AS account_name,
              ${walletCols.has("currency") ? "nullif(w.currency, '')" : "NULL::text"} AS currency,
              coalesce(w.deleted, false) AS deleted,
              ${walletCols.has("created_at") ? "(w.created_at AT TIME ZONE $1)" : "NULL::timestamptz"} AS created_at,
              floor(coalesce(b.balance, 0) / 1000.0)::bigint AS balance,
              coalesce(pay.received, 0) AS received, coalesce(pay.sent, 0) AS sent, coalesce(pay.payments, 0) AS payments,
              coalesce(pay.received_30d, 0) AS received_30d, coalesce(pay.sent_30d, 0) AS sent_30d,
              (pay.last_activity AT TIME ZONE $1) AS last_activity
         FROM wallets w
         LEFT JOIN pay ON pay.wallet_id = w.id
         LEFT JOIN bal b ON b.wallet_id = w.id
         ${hasAccounts ? 'LEFT JOIN accounts a ON a.id = w."user"' : ""}
        ORDER BY coalesce(b.balance, 0) DESC, pay.last_activity DESC NULLS LAST, w.id`,
      [tz],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? "",
      account: r.account,
      accountName: r.account_name,
      currency: r.currency,
      deleted: r.deleted,
      createdAt: r.created_at,
      balance: r.balance,
      received: r.received,
      sent: r.sent,
      payments: r.payments,
      received30d: r.received_30d,
      sent30d: r.sent_30d,
      lastActivity: r.last_activity,
    }));
  }

  async function payments(limit: number, walletId: string | null): Promise<LnbitsPayment[]> {
    const rows = await db.query<{
      at: Date; wallet_id: string; amount: number; fee: number; status: string; tag: string | null; internal: boolean;
    }>(
      `SELECT (${T} AT TIME ZONE $1) AS at, p.wallet_id, round(p.amount / 1000.0)::bigint AS amount,
              round(abs(p.fee) / 1000.0)::bigint AS fee, p.status, ${TAG} AS tag,
              (p.checking_id LIKE 'internal\\_%') AS internal
         FROM apipayments p
        WHERE ($3::text IS NULL OR p.wallet_id = $3)
          AND NOT (p.status = 'pending' AND p.amount > 0 AND ${T} < ${since("1 day")})
        ORDER BY ${T} DESC LIMIT $2`,
      [tz, limit, walletId],
    );
    return rows.map((r) => ({
      at: r.at, walletId: r.wallet_id, amount: r.amount, fee: r.fee, status: r.status, tag: r.tag, internal: r.internal,
    }));
  }

  async function timeseries(range: RangeKey): Promise<LnbitsSeries> {
    const r = RANGES[range];
    const utc = `(${T} AT TIME ZONE $1)`;
    const bucket = r.bin
      ? `date_bin(interval '${r.bin}', ${utc}, timestamptz '1970-01-01 00:00:00+00')`
      : `date_trunc('month', ${utc})`;
    const rows = await db.query<{ direction: "received" | "sent"; bucket: Date; count: number; amount: number; fee: number }>(
      `SELECT CASE WHEN p.amount > 0 THEN 'received' ELSE 'sent' END AS direction, ${bucket} AS bucket,
              count(*)::int AS count, ${sat("sum(abs(p.amount))")} AS amount, ${sat("sum(abs(p.fee))")} AS fee
         FROM apipayments p
        WHERE p.status = 'success' AND p.amount <> 0 AND NOT (p.amount < 0 AND p.checking_id LIKE 'internal\\_%')
          ${r.interval ? `AND ${T} >= ${since(r.interval)}` : ""}
        GROUP BY 1, 2 ORDER BY 2`,
      [tz],
    );
    const of = (direction: string) => rows.filter((row) => row.direction === direction);
    const a = alignSeries(range, {
      received: of("received").map(({ bucket, count, amount }) => ({ bucket, count, amount })),
      sent: of("sent"),
    });
    return { range, bin: a.bin, buckets: a.buckets, ...a.series };
  }

  return { overview, wallets, payments, timeseries };
}
