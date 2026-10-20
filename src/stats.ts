import { hasColumn, hasTable, type Db, type SchemaInfo } from "./db.ts";

/*
 * All statistics are plain SELECTs against the Nutshell mint schema. Nothing here writes.
 *
 * Time handling: Nutshell stores TIMESTAMP (without time zone) columns holding the mint
 * server's *local* time. Every query receives the configured mint time zone as $1 and
 * converts with `AT TIME ZONE`, so the API only ever emits UTC instants. Window bounds
 * are computed on the constant side of the comparison so indexes stay usable.
 */

// ---------- schema capabilities ----------

export interface Caps {
  /** SQL expression (alias q) for the moment ecash was issued for a mint quote */
  mintIssuedTime: string;
  /** SQL expression (alias q) for the amount actually issued for a mint quote */
  mintIssuedAmount: string;
  /** SQL expression (alias p) for the moment a promise was signed */
  promiseSignedTime: string;
  promisesMeltQuote: boolean;
  promisesSwapId: boolean;
  keysetBalance: boolean;
  keysetInputFee: boolean;
  keysetAmounts: boolean;
  keysetFinalExpiry: boolean;
  keysetVersion: boolean;
  balanceLog: boolean;
  meltExpiry: boolean;
  mintAmountPaid: boolean;
  /**
   * Mint-local timestamp (text) of the first promise that carries a mint_quote link, or null when none does yet.
   * Nutshell started linking outputs to quotes with migration 17; older rows have no link and cannot be
   * classified, so they count as "legacy" rather than as swaps.
   */
  mintLinkSince: string | null;
  /** Same for spent proofs and their melt_quote link. */
  spentLinkSince: string | null;
}

export async function capabilities(db: Db, schema: SchemaInfo): Promise<Caps> {
  const base = schemaCaps(schema);
  const row = await db.one<{ mint_link: string | null; spent_link: string | null }>(
    `SELECT to_char((SELECT min(created) FROM promises WHERE mint_quote IS NOT NULL), 'YYYY-MM-DD HH24:MI:SS') AS mint_link,
            to_char((SELECT min(created) FROM proofs_used WHERE melt_quote IS NOT NULL), 'YYYY-MM-DD HH24:MI:SS') AS spent_link`,
  );
  return { ...base, mintLinkSince: row.mint_link, spentLinkSince: row.spent_link };
}

function schemaCaps(schema: SchemaInfo): Omit<Caps, "mintLinkSince" | "spentLinkSince"> {
  const required: Array<[Parameters<typeof hasColumn>[1], string, string]> = [
    ["keysets", "unit", "11"],
    ["mint_quotes", "state", "20"],
    ["melt_quotes", "state", "20"],
    ["promises", "mint_quote", "17"],
    ["proofs_used", "melt_quote", "17"],
    ["proofs_pending", "melt_quote", "17"],
  ];
  for (const [table, column, migration] of required) {
    if (!hasTable(schema, table)) {
      throw new Error(`table "${table}" not found in schema "${schema.schema}" (is this a Nutshell mint database?)`);
    }
    if (!hasColumn(schema, table, column)) {
      throw new Error(
        `column ${table}.${column} is missing; nutboard needs a Nutshell database at migration ${migration} or later`,
      );
    }
  }
  const issuedTime = hasColumn(schema, "mint_quotes", "issued_time")
    ? "coalesce(q.issued_time, q.paid_time, q.created_time)"
    : "coalesce(q.paid_time, q.created_time)";
  const issuedAmount = hasColumn(schema, "mint_quotes", "amount_issued")
    ? "coalesce(q.amount_issued, q.amount)"
    : "q.amount";
  return {
    mintIssuedTime: issuedTime,
    mintIssuedAmount: issuedAmount,
    promiseSignedTime: hasColumn(schema, "promises", "signed_at")
      ? "coalesce(p.signed_at, p.created)"
      : "p.created",
    promisesMeltQuote: hasColumn(schema, "promises", "melt_quote"),
    promisesSwapId: hasColumn(schema, "promises", "swap_id"),
    keysetBalance: hasColumn(schema, "keysets", "balance") && hasColumn(schema, "keysets", "fees_paid"),
    keysetInputFee: hasColumn(schema, "keysets", "input_fee_ppk"),
    keysetAmounts: hasColumn(schema, "keysets", "amounts"),
    keysetFinalExpiry: hasColumn(schema, "keysets", "final_expiry"),
    keysetVersion: hasColumn(schema, "keysets", "version"),
    balanceLog: hasTable(schema, "balance_log"),
    meltExpiry: hasColumn(schema, "melt_quotes", "expiry"),
    mintAmountPaid: hasColumn(schema, "mint_quotes", "amount_paid"),
  };
}

// ---------- windows ----------

export const WINDOWS = [
  { key: "h24", label: "24 hours", interval: "24 hours" },
  { key: "d7", label: "7 days", interval: "7 days" },
  { key: "d30", label: "30 days", interval: "30 days" },
  { key: "all", label: "all time", interval: null },
] as const;
export type WindowKey = (typeof WINDOWS)[number]["key"];

/** Naive timestamp in mint-local time for "now minus interval"; $1 must be the mint time zone. */
function since(interval: string): string {
  return `((now() - interval '${interval}') AT TIME ZONE $1)`;
}

interface Measure {
  name: string;
  agg: string;
  where?: string;
}

/** Where a signed output came from; $3 must be caps.mintLinkSince (alias p). */
function originExpr(caps: Caps): string {
  return `CASE WHEN p.mint_quote IS NOT NULL THEN 'mint'
               ${caps.promisesMeltQuote ? "WHEN p.melt_quote IS NOT NULL THEN 'melt'" : ""}
               WHEN $3::timestamp IS NULL OR p.created >= $3::timestamp THEN 'swap'
               ELSE 'legacy' END`;
}

/** Outputs that are swap outputs for sure; $3 must be caps.mintLinkSince (alias p). */
function swapWhere(caps: Caps): string {
  return `p.mint_quote IS NULL ${caps.promisesMeltQuote ? "AND p.melt_quote IS NULL" : ""}
          AND ($3::timestamp IS NULL OR p.created >= $3::timestamp)`;
}

/** Nutshell does not record a swap id: outputs stored within the same second count as one swap. */
function swapOpExpr(caps: Caps): string {
  return caps.promisesSwapId
    ? "coalesce(p.swap_id, date_trunc('second', p.created)::text)"
    : "date_trunc('second', p.created)::text";
}

/** Builds one aggregate column per (window, measure): "<window>__<measure>". */
function windowed(measures: Measure[], timeCol = "t"): string {
  const parts: string[] = [];
  for (const w of WINDOWS) {
    for (const m of measures) {
      const conds: string[] = [];
      if (m.where) conds.push(m.where);
      if (w.interval) conds.push(`${timeCol} >= ${since(w.interval)}`);
      const filter = conds.length ? ` FILTER (WHERE ${conds.join(" AND ")})` : "";
      parts.push(`coalesce(${m.agg}${filter}, 0) AS "${w.key}__${m.name}"`);
    }
  }
  return parts.join(",\n       ");
}

type WindowTable = Record<WindowKey, Record<string, number>>;

function unpack(row: Record<string, number>): WindowTable {
  const out = { h24: {}, d7: {}, d30: {}, all: {} } as WindowTable;
  for (const [col, value] of Object.entries(row)) {
    const idx = col.indexOf("__");
    if (idx < 0) continue;
    const w = col.slice(0, idx) as WindowKey;
    out[w][col.slice(idx + 2)] = Number(value);
  }
  return out;
}

// ---------- ranges for time series ----------

export const RANGES = {
  "24h": { interval: "24 hours", bin: "1 hour", stepMs: 3_600_000 },
  "7d": { interval: "7 days", bin: "6 hours", stepMs: 6 * 3_600_000 },
  "30d": { interval: "30 days", bin: "1 day", stepMs: 86_400_000 },
  "90d": { interval: "90 days", bin: "1 day", stepMs: 86_400_000 },
  "1y": { interval: "365 days", bin: "1 week", stepMs: 7 * 86_400_000 },
  all: { interval: null, bin: null, stepMs: null },
} as const;
export type RangeKey = keyof typeof RANGES;

function bucketExpr(range: RangeKey, utcExpr: string): string {
  const r = RANGES[range];
  if (r.bin) return `date_bin(interval '${r.bin}', ${utcExpr}, timestamptz '1970-01-01 00:00:00+00')`;
  return `date_trunc('month', ${utcExpr})`;
}

// ---------- result types ----------

export interface Overview {
  unit: string;
  generatedAt: string;
  windows: typeof WINDOWS;
  mint: WindowTable;
  mintRequests: WindowTable;
  melt: WindowTable;
  signatures: WindowTable;
  spent: WindowTable;
  liabilities: {
    keysets: number;
    activeKeysets: number;
    keysetBalance: number | null;
    feesPaid: number | null;
    issued: number;
    issuedCount: number;
    redeemed: number;
    redeemedCount: number;
    pending: number;
    pendingCount: number;
    unsignedPromises: number;
    outstanding: number;
  };
  mintStates: Array<{ state: string; count: number; amount: number }>;
  meltStates: Array<{ state: string; count: number; amount: number }>;
  lastBalanceLog: BalanceLogRow | null;
  /** when quote links start in this database (rows before that are "legacy", origin unknown) */
  legacy: { mintLinkSince: string | null; spentLinkSince: string | null };
  /** most recent operations of each kind (UTC instants), null when there were none */
  lastActivity: { any: Date | null; signature: Date | null; mint: Date | null; melt: Date | null; swap: Date | null; request: Date | null };
}

export interface BalanceLogRow {
  time: Date;
  keysetBalance: number;
  keysetFeesPaid: number;
  backendBalance: number;
}

// ---------- queries ----------

export interface TimeZoneSanity {
  configured: string;
  /** newest signed output, as stored (naive mint-local time), or null on an empty ledger */
  newestRow: string | null;
  /** how old that row is when read in the configured zone (negative = in the future) */
  ageConfiguredSeconds: number | null;
  /** how old it would be if the mint wrote UTC */
  ageUtcSeconds: number | null;
  /** set when the configured zone cannot be right, with a suggestion */
  hint: string | null;
}

/**
 * Nutshell stores naive local timestamps, so a wrong MINT_TZ shifts everything by the zone offset.
 * Rows in the future prove the zone is wrong; rows that are hours old under the configured zone
 * but current under UTC strongly suggest the mint writes UTC (e.g. runs in a container).
 */
export async function timeZoneSanity(db: Db, tz: string): Promise<TimeZoneSanity> {
  const row = await db.one<{ newest: string | null; age_configured: number | null; age_utc: number | null }>(
    `SELECT to_char(max(created), 'YYYY-MM-DD HH24:MI:SS') AS newest,
            extract(epoch FROM (now() - (max(created) AT TIME ZONE $1)))::float8 AS age_configured,
            extract(epoch FROM (now() - (max(created) AT TIME ZONE 'UTC')))::float8 AS age_utc
       FROM promises`,
    [tz],
  );
  let hint: string | null = null;
  const ageC = row.age_configured;
  const ageU = row.age_utc;
  if (ageC !== null && ageU !== null) {
    if (ageC < -120) {
      hint = `the newest ledger row is ${Math.round(-ageC / 60)} min in the future when read as ${tz}: MINT_TZ is wrong` +
        (Math.abs(ageU) < 300 ? " (the mint writes UTC; set MINT_TZ=UTC)" : "");
    } else if (tz !== "UTC" && ageC > 1800 && Math.abs(ageU) < 300) {
      hint = `the newest ledger row is ${Math.round(ageC / 60)} min old when read as ${tz} but current under UTC: the mint writes UTC; set MINT_TZ=UTC`;
    }
  }
  return { configured: tz, newestRow: row.newest, ageConfiguredSeconds: ageC, ageUtcSeconds: ageU, hint };
}

export async function listUnits(db: Db): Promise<string[]> {
  const rows = await db.query<{ unit: string }>(
    `SELECT DISTINCT unit FROM keysets WHERE unit IS NOT NULL ORDER BY unit`,
  );
  return rows.map((r) => r.unit);
}

export async function overview(db: Db, caps: Caps, unit: string): Promise<Overview> {
  const tz = db.config.mintTz;

  const mintQ = db.one<Record<string, number>>(
    `WITH src AS (
       SELECT ${caps.mintIssuedAmount} AS amount, ${caps.mintIssuedTime} AS t
         FROM mint_quotes q WHERE q.unit = $2 AND q.state = 'ISSUED')
     SELECT ${windowed([
       { name: "count", agg: "count(*)" },
       { name: "amount", agg: "sum(amount)" },
       { name: "avg", agg: "avg(amount)" },
       { name: "max", agg: "max(amount)" },
     ])}
       FROM src`,
    [tz, unit],
  );

  const requestsQ = db.one<Record<string, number>>(
    `WITH src AS (
       SELECT q.amount, q.created_time AS t, q.state FROM mint_quotes q WHERE q.unit = $2)
     SELECT ${windowed([
       { name: "count", agg: "count(*)" },
       { name: "amount", agg: "sum(amount)" },
       { name: "issued_count", agg: "count(*)", where: "state = 'ISSUED'" },
       { name: "unpaid_count", agg: "count(*)", where: "state = 'UNPAID'" },
     ])}
       FROM src`,
    [tz, unit],
  );

  const meltQ = db.one<Record<string, number>>(
    `WITH src AS (
       SELECT q.amount, coalesce(q.fee_reserve, 0) AS fee_reserve, coalesce(q.fee_paid, 0) AS fee_paid,
              coalesce(q.paid_time, q.created_time) AS t
         FROM melt_quotes q WHERE q.unit = $2 AND q.state = 'PAID')
     SELECT ${windowed([
       { name: "count", agg: "count(*)" },
       { name: "amount", agg: "sum(amount)" },
       { name: "fee_reserve", agg: "sum(fee_reserve)" },
       { name: "fee_paid", agg: "sum(fee_paid)" },
       { name: "avg", agg: "avg(amount)" },
       { name: "max", agg: "max(amount)" },
     ])}
       FROM src`,
    [tz, unit],
  );

  const signaturesQ = db.one<Record<string, number>>(
    `WITH src AS (
       SELECT p.amount, ${caps.promiseSignedTime} AS t, ${originExpr(caps)} AS origin, ${swapOpExpr(caps)} AS op
         FROM promises p JOIN keysets k ON k.id = p.id
        WHERE k.unit = $2 AND p.c_ IS NOT NULL)
     SELECT ${windowed([
       { name: "count", agg: "count(*)" },
       { name: "amount", agg: "sum(amount)" },
       { name: "mint_count", agg: "count(*)", where: "origin = 'mint'" },
       { name: "mint_amount", agg: "sum(amount)", where: "origin = 'mint'" },
       { name: "swap_count", agg: "count(*)", where: "origin = 'swap'" },
       { name: "swap_amount", agg: "sum(amount)", where: "origin = 'swap'" },
       { name: "swap_ops", agg: "count(DISTINCT op)", where: "origin = 'swap'" },
       { name: "melt_count", agg: "count(*)", where: "origin = 'melt'" },
       { name: "melt_amount", agg: "sum(amount)", where: "origin = 'melt'" },
       { name: "legacy_count", agg: "count(*)", where: "origin = 'legacy'" },
       { name: "legacy_amount", agg: "sum(amount)", where: "origin = 'legacy'" },
     ])}
       FROM src`,
    [tz, unit, caps.mintLinkSince],
  );

  const spentQ = db.one<Record<string, number>>(
    `WITH src AS (
       SELECT u.amount, u.created AS t, (u.melt_quote IS NOT NULL) AS is_melt,
              (u.melt_quote IS NULL AND $3::timestamp IS NOT NULL AND u.created < $3::timestamp) AS is_legacy
         FROM proofs_used u JOIN keysets k ON k.id = u.id
        WHERE k.unit = $2)
     SELECT ${windowed([
       { name: "count", agg: "count(*)" },
       { name: "amount", agg: "sum(amount)" },
       { name: "melt_count", agg: "count(*)", where: "is_melt" },
       { name: "melt_amount", agg: "sum(amount)", where: "is_melt" },
       { name: "swap_count", agg: "count(*)", where: "NOT is_melt AND NOT is_legacy" },
       { name: "swap_amount", agg: "sum(amount)", where: "NOT is_melt AND NOT is_legacy" },
       { name: "legacy_count", agg: "count(*)", where: "is_legacy" },
       { name: "legacy_amount", agg: "sum(amount)", where: "is_legacy" },
     ])}
       FROM src`,
    [tz, unit, caps.spentLinkSince],
  );

  const keysetsQ = db.one<{
    keysets: number;
    active_keysets: number;
    keyset_balance: number | null;
    fees_paid: number | null;
  }>(
    `SELECT count(*)::int AS keysets,
            count(*) FILTER (WHERE active)::int AS active_keysets,
            ${
              caps.keysetBalance
                ? "coalesce(sum(balance), 0)::bigint AS keyset_balance, coalesce(sum(fees_paid), 0)::bigint AS fees_paid"
                : "NULL::bigint AS keyset_balance, NULL::bigint AS fees_paid"
            }
       FROM keysets WHERE unit = $1`,
    [unit],
  );

  const pendingQ = db.one<{ pending: number; pending_count: number }>(
    `SELECT coalesce(sum(u.amount), 0)::bigint AS pending, count(*)::int AS pending_count
       FROM proofs_pending u JOIN keysets k ON k.id = u.id WHERE k.unit = $1`,
    [unit],
  );

  const unsignedQ = db.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM promises p JOIN keysets k ON k.id = p.id
      WHERE k.unit = $1 AND p.c_ IS NULL`,
    [unit],
  );

  const mintStatesQ = db.query<{ state: string; count: number; amount: number }>(
    `SELECT coalesce(state, 'UNKNOWN') AS state, count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount
       FROM mint_quotes WHERE unit = $1 GROUP BY 1 ORDER BY 1`,
    [unit],
  );
  const meltStatesQ = db.query<{ state: string; count: number; amount: number }>(
    `SELECT coalesce(state, 'UNKNOWN') AS state, count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount
       FROM melt_quotes WHERE unit = $1 GROUP BY 1 ORDER BY 1`,
    [unit],
  );

  const lastActivityQ = db.one<{
    last_signature: Date | null;
    last_mint: Date | null;
    last_melt: Date | null;
    last_swap: Date | null;
    last_request: Date | null;
  }>(
    `SELECT (SELECT max(${caps.promiseSignedTime}) FROM promises p JOIN keysets k ON k.id = p.id
              WHERE k.unit = $2 AND p.c_ IS NOT NULL) AT TIME ZONE $1 AS last_signature,
            (SELECT max(${caps.mintIssuedTime}) FROM mint_quotes q WHERE q.unit = $2 AND q.state = 'ISSUED') AT TIME ZONE $1 AS last_mint,
            (SELECT max(coalesce(q.paid_time, q.created_time)) FROM melt_quotes q WHERE q.unit = $2 AND q.state = 'PAID') AT TIME ZONE $1 AS last_melt,
            (SELECT max(${caps.promiseSignedTime}) FROM promises p JOIN keysets k ON k.id = p.id
              WHERE k.unit = $2 AND p.c_ IS NOT NULL AND ${swapWhere(caps)}) AT TIME ZONE $1 AS last_swap,
            (SELECT max(q.created_time) FROM mint_quotes q WHERE q.unit = $2) AT TIME ZONE $1 AS last_request`,
    [tz, unit, caps.mintLinkSince],
  );

  const lastLogQ: Promise<BalanceLogRow | null> = caps.balanceLog
    ? db
        .query<{ time: Date; keyset_balance: number; keyset_fees_paid: number; backend_balance: number }>(
          `SELECT (time AT TIME ZONE $1) AS time, keyset_balance, keyset_fees_paid, backend_balance
             FROM balance_log WHERE unit = $2 ORDER BY time DESC LIMIT 1`,
          [tz, unit],
        )
        .then((rows) =>
          rows[0]
            ? {
                time: rows[0].time,
                keysetBalance: rows[0].keyset_balance,
                keysetFeesPaid: rows[0].keyset_fees_paid,
                backendBalance: rows[0].backend_balance,
              }
            : null,
        )
    : Promise.resolve(null);

  const [mint, requests, melt, signatures, spent, ks, pending, unsigned, mintStates, meltStates, lastBalanceLog, last] =
    await Promise.all([
      mintQ,
      requestsQ,
      meltQ,
      signaturesQ,
      spentQ,
      keysetsQ,
      pendingQ,
      unsignedQ,
      mintStatesQ,
      meltStatesQ,
      lastLogQ,
      lastActivityQ,
    ]);
  const latest = (...ds: Array<Date | null>): Date | null =>
    ds.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

  const sig = unpack(signatures);
  const sp = unpack(spent);
  const issued = sig.all.amount;
  const redeemed = sp.all.amount;

  return {
    unit,
    generatedAt: new Date().toISOString(),
    windows: WINDOWS,
    mint: unpack(mint),
    mintRequests: unpack(requests),
    melt: unpack(melt),
    signatures: sig,
    spent: sp,
    liabilities: {
      keysets: ks.keysets,
      activeKeysets: ks.active_keysets,
      keysetBalance: ks.keyset_balance,
      feesPaid: ks.fees_paid,
      issued,
      issuedCount: sig.all.count,
      redeemed,
      redeemedCount: sp.all.count,
      pending: pending.pending,
      pendingCount: pending.pending_count,
      unsignedPromises: unsigned.n,
      outstanding: issued - redeemed,
    },
    mintStates,
    meltStates,
    lastBalanceLog,
    legacy: { mintLinkSince: caps.mintLinkSince, spentLinkSince: caps.spentLinkSince },
    lastActivity: {
      any: latest(last.last_signature, last.last_mint, last.last_melt, last.last_swap),
      signature: last.last_signature,
      mint: last.last_mint,
      melt: last.last_melt,
      swap: last.last_swap,
      request: last.last_request,
    },
  };
}

// ---------- public fee summary (shown before sign-in) ----------

export interface PublicFees {
  unit: string;
  /** the window that had enough payments, or null when even all time has too few */
  range: RangeKey | null;
  band: { min: number; max: number };
  count: number;
  freeCount: number;
  /** routing fee the node paid, as a share of the amount (volume-weighted) */
  lnRatio: number | null;
  /** mint input fee as a share of the amount, over payments whose inputs are linked */
  mintRatio: number | null;
  totalRatio: number | null;
  medianTotalRatio: number | null;
  medianLnRatio: number | null;
  /** the active keyset's input fee per proof, in ppk (also public through the mint's own API) */
  inputFeePpk: number | null;
}

const PUBLIC_BAND = { min: 1000, max: 99_999 };
const PUBLIC_MIN_PAYMENTS = 5;

/** Aggregate fee figures for reasonably sized payments; nothing about individual payments or balances. */
export async function publicFees(db: Db, caps: Caps, unit: string): Promise<PublicFees> {
  const tz = db.config.mintTz;
  const keyset = await db.query<{ input_fee_ppk: number | null }>(
    caps.keysetInputFee
      ? `SELECT input_fee_ppk FROM keysets WHERE unit = $1 AND active ORDER BY first_seen DESC NULLS LAST LIMIT 1`
      : `SELECT NULL::int AS input_fee_ppk FROM keysets WHERE unit = $1 LIMIT 1`,
    [unit],
  );
  const inputFeePpk = keyset[0]?.input_fee_ppk ?? null;
  const empty: PublicFees = {
    unit, range: null, band: PUBLIC_BAND, count: 0, freeCount: 0, lnRatio: null, mintRatio: null, totalRatio: null,
    medianTotalRatio: null, medianLnRatio: null, inputFeePpk,
  };
  for (const range of ["30d", "90d", "all"] as const) {
    const r = RANGES[range];
    const bound = r.interval ? `AND coalesce(q.paid_time, q.created_time) >= ${since(r.interval)}` : "AND $1::text <> ''";
    const row = await db.one<{
      count: number; amount: number; ln_fee: number; free_count: number; linked_count: number;
      linked_amount: number | null; mint_fee: number | null; median_total_ratio: number | null; median_ln_ratio: number | null;
    }>(
      `WITH m AS (
         SELECT q.quote, q.amount, coalesce(q.fee_paid, 0) AS fee_paid
           FROM melt_quotes q
          WHERE q.unit = $2 AND q.state = 'PAID' AND q.amount BETWEEN $3 AND $4 ${bound}),
       inputs AS (SELECT u.melt_quote, sum(u.amount) AS s FROM proofs_used u JOIN m ON m.quote = u.melt_quote GROUP BY u.melt_quote),
       change AS (
         ${
           caps.promisesMeltQuote
             ? "SELECT p.melt_quote, sum(p.amount) AS s FROM promises p JOIN m ON m.quote = p.melt_quote WHERE p.c_ IS NOT NULL GROUP BY p.melt_quote"
             : "SELECT NULL::text AS melt_quote, 0::bigint AS s WHERE false"
         })
       SELECT count(*)::int AS count, coalesce(sum(m.amount), 0)::bigint AS amount, coalesce(sum(m.fee_paid), 0)::bigint AS ln_fee,
              count(*) FILTER (WHERE m.fee_paid = 0)::int AS free_count,
              count(i.melt_quote)::int AS linked_count,
              (sum(m.amount) FILTER (WHERE i.s IS NOT NULL))::bigint AS linked_amount,
              (sum(i.s - m.amount - m.fee_paid - coalesce(c.s, 0)) FILTER (WHERE i.s IS NOT NULL))::bigint AS mint_fee,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY (i.s - m.amount - coalesce(c.s, 0))::float8 / m.amount) FILTER (WHERE i.s IS NOT NULL))::float8 AS median_total_ratio,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.fee_paid::float8 / m.amount))::float8 AS median_ln_ratio
         FROM m LEFT JOIN inputs i ON i.melt_quote = m.quote LEFT JOIN change c ON c.melt_quote = m.quote`,
      [tz, unit, PUBLIC_BAND.min, PUBLIC_BAND.max],
    );
    if (row.count < PUBLIC_MIN_PAYMENTS) continue;
    const lnRatio = row.amount > 0 ? row.ln_fee / row.amount : null;
    const mintRatio = row.linked_amount && row.mint_fee !== null ? row.mint_fee / row.linked_amount : null;
    return {
      ...empty,
      range,
      count: row.count,
      freeCount: row.free_count,
      lnRatio,
      mintRatio,
      totalRatio: lnRatio === null ? null : lnRatio + (mintRatio ?? 0),
      medianTotalRatio: row.median_total_ratio ?? row.median_ln_ratio,
      medianLnRatio: row.median_ln_ratio,
    };
  }
  return empty;
}

// ---------- Lightning fees by payment size ----------

export interface FeeBucket {
  /** floor(log10(amount)); null for the total row */
  magnitude: number | null;
  count: number;
  amount: number;
  /** what the Lightning node paid in routing fees (melt_quotes.fee_paid) */
  lnFee: number;
  /** what wallets were asked to reserve for fees */
  feeReserve: number;
  /** payments that cost no routing fee (direct channel or internal settlement) */
  freeCount: number;
  /** median of fee_paid / amount over the payments */
  medianLnRatio: number | null;
  maxLnFee: number;
  /** payments whose inputs are linked (needed for the mint fee) */
  linkedCount: number;
  /** ecash input fees the mint kept on those linked payments: inputs - amount - LN fee - change */
  mintFee: number | null;
  /** payment volume the mint fee refers to */
  mintFeeBase: number | null;
}

export interface FeeStats {
  unit: string;
  range: RangeKey;
  buckets: FeeBucket[];
  total: FeeBucket | null;
}

/**
 * Paid melts grouped by order of magnitude of the amount, so that the fixed base fee on tiny payments
 * does not distort the fee percentages of real ones.
 */
export async function fees(db: Db, caps: Caps, unit: string, range: RangeKey): Promise<FeeStats> {
  const tz = db.config.mintTz;
  const r = RANGES[range];
  const bound = r.interval ? `AND coalesce(q.paid_time, q.created_time) >= ${since(r.interval)}` : "AND $1::text <> ''";
  const rows = await db.query<{
    magnitude: number | null;
    count: number;
    amount: number;
    ln_fee: number;
    fee_reserve: number;
    free_count: number;
    median_ln_ratio: number | null;
    max_ln_fee: number;
    linked_count: number;
    mint_fee: number | null;
    mint_fee_base: number | null;
  }>(
    `WITH m AS (
       SELECT q.quote, q.amount, coalesce(q.fee_paid, 0) AS fee_paid, coalesce(q.fee_reserve, 0) AS fee_reserve,
              floor(log(10, q.amount::numeric))::int AS mag
         FROM melt_quotes q
        WHERE q.unit = $2 AND q.state = 'PAID' AND q.amount > 0 ${bound}),
     inputs AS (
       SELECT u.melt_quote, sum(u.amount) AS s FROM proofs_used u JOIN m ON m.quote = u.melt_quote GROUP BY u.melt_quote),
     change AS (
       ${
         caps.promisesMeltQuote
           ? "SELECT p.melt_quote, sum(p.amount) AS s FROM promises p JOIN m ON m.quote = p.melt_quote WHERE p.c_ IS NOT NULL GROUP BY p.melt_quote"
           : "SELECT NULL::text AS melt_quote, 0::bigint AS s WHERE false"
       })
     SELECT m.mag AS magnitude, count(*)::int AS count, sum(m.amount)::bigint AS amount, sum(m.fee_paid)::bigint AS ln_fee,
            sum(m.fee_reserve)::bigint AS fee_reserve, count(*) FILTER (WHERE m.fee_paid = 0)::int AS free_count,
            (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.fee_paid::float8 / m.amount))::float8 AS median_ln_ratio,
            max(m.fee_paid)::bigint AS max_ln_fee,
            count(i.melt_quote)::int AS linked_count,
            (sum(i.s - m.amount - m.fee_paid - coalesce(c.s, 0)) FILTER (WHERE i.s IS NOT NULL))::bigint AS mint_fee,
            (sum(m.amount) FILTER (WHERE i.s IS NOT NULL))::bigint AS mint_fee_base
       FROM m LEFT JOIN inputs i ON i.melt_quote = m.quote LEFT JOIN change c ON c.melt_quote = m.quote
      GROUP BY ROLLUP (m.mag) ORDER BY m.mag NULLS LAST`,
    [tz, unit],
  );
  const map = (row: (typeof rows)[number]): FeeBucket => ({
    magnitude: row.magnitude,
    count: row.count,
    amount: row.amount,
    lnFee: row.ln_fee,
    feeReserve: row.fee_reserve,
    freeCount: row.free_count,
    medianLnRatio: row.median_ln_ratio,
    maxLnFee: row.max_ln_fee,
    linkedCount: row.linked_count,
    mintFee: row.mint_fee,
    mintFeeBase: row.mint_fee_base,
  });
  const buckets = rows.filter((row) => row.magnitude !== null).map(map);
  const totalRow = rows.find((row) => row.magnitude === null);
  return { unit, range, buckets, total: totalRow ? map(totalRow) : null };
}

export interface SeriesPoint {
  bucket: string;
  count: number;
  amount: number;
  fee?: number;
}

export interface Timeseries {
  unit: string;
  range: RangeKey;
  bin: string | null;
  buckets: string[];
  mint: SeriesPoint[];
  melt: SeriesPoint[];
  swap: SeriesPoint[];
}

export async function timeseries(db: Db, caps: Caps, unit: string, range: RangeKey): Promise<Timeseries> {
  const tz = db.config.mintTz;
  const r = RANGES[range];
  const bucket = bucketExpr(range, "(t AT TIME ZONE $1)");
  const bound = r.interval ? `AND t >= ${since(r.interval)}` : "";

  const mintQ = db.query<{ bucket: Date; count: number; amount: number }>(
    `SELECT ${bucket} AS bucket, count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount
       FROM (SELECT ${caps.mintIssuedAmount} AS amount, ${caps.mintIssuedTime} AS t
               FROM mint_quotes q WHERE q.unit = $2 AND q.state = 'ISSUED') s
      WHERE t IS NOT NULL ${bound}
      GROUP BY 1 ORDER BY 1`,
    [tz, unit],
  );
  const meltQ = db.query<{ bucket: Date; count: number; amount: number; fee: number }>(
    `SELECT ${bucket} AS bucket, count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount,
            coalesce(sum(fee_paid), 0)::bigint AS fee
       FROM (SELECT q.amount, coalesce(q.fee_paid, 0) AS fee_paid, coalesce(q.paid_time, q.created_time) AS t
               FROM melt_quotes q WHERE q.unit = $2 AND q.state = 'PAID') s
      WHERE t IS NOT NULL ${bound}
      GROUP BY 1 ORDER BY 1`,
    [tz, unit],
  );
  const swapQ = db.query<{ bucket: Date; count: number; amount: number }>(
    `SELECT ${bucket} AS bucket, count(DISTINCT op)::int AS count, coalesce(sum(amount), 0)::bigint AS amount
       FROM (SELECT p.amount, ${caps.promiseSignedTime} AS t, ${swapOpExpr(caps)} AS op
               FROM promises p JOIN keysets k ON k.id = p.id
              WHERE k.unit = $2 AND p.c_ IS NOT NULL AND ${swapWhere(caps)}) s
      WHERE t IS NOT NULL ${bound}
      GROUP BY 1 ORDER BY 1`,
    [tz, unit, caps.mintLinkSince],
  );
  const [mint, melt, swap] = await Promise.all([mintQ, meltQ, swapQ]);

  const toKey = (d: Date) => d.toISOString();
  const keys = new Set<string>();
  for (const rows of [mint, melt, swap]) for (const row of rows) keys.add(toKey(row.bucket));
  if (r.stepMs) {
    // Fill the whole range so quiet periods render as zero instead of disappearing.
    const now = Date.now();
    const start = Math.floor((now - msOf(r.interval)) / r.stepMs) * r.stepMs;
    for (let t = start; t <= now; t += r.stepMs) keys.add(new Date(t).toISOString());
  } else if (keys.size) {
    const sorted = [...keys].sort();
    const first = new Date(sorted[0]);
    const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    const end = new Date();
    while (cursor <= end) {
      keys.add(cursor.toISOString());
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  const buckets = [...keys].sort();
  const align = <T extends { bucket: Date; count: number; amount: number; fee?: number }>(rows: T[]) => {
    const map = new Map(rows.map((row) => [toKey(row.bucket), row]));
    return buckets.map((b) => {
      const row = map.get(b);
      const point: SeriesPoint = { bucket: b, count: row?.count ?? 0, amount: row?.amount ?? 0 };
      if (row && row.fee !== undefined) point.fee = row.fee;
      return point;
    });
  };
  return {
    unit,
    range,
    bin: r.bin,
    buckets,
    mint: align(mint),
    melt: align(melt),
    swap: align(swap),
  };
}

function msOf(interval: string): number {
  const [n, u] = interval.split(" ");
  const num = Number(n);
  switch (u) {
    case "hour":
    case "hours":
      return num * 3_600_000;
    case "day":
    case "days":
      return num * 86_400_000;
    case "week":
    case "weeks":
      return num * 7 * 86_400_000;
    default:
      throw new Error(`unsupported interval ${interval}`);
  }
}

export interface KeysetRow {
  id: string;
  unit: string | null;
  active: boolean;
  version: string | null;
  derivationPath: string | null;
  validFrom: Date | null;
  firstSeen: Date | null;
  inputFeePpk: number | null;
  balance: number | null;
  feesPaid: number | null;
  denominations: number | null;
  finalExpiry: number | null;
  signedCount: number;
  issued: number;
  unsignedCount: number;
  spentCount: number;
  redeemed: number;
  pendingCount: number;
  pending: number;
  /** issued - redeemed - pending; what keysets.balance should equal */
  computedBalance: number;
  balanceMatches: boolean | null;
}

export async function keysets(db: Db, caps: Caps): Promise<KeysetRow[]> {
  const rows = await db.query<{
    id: string;
    unit: string | null;
    active: boolean;
    version: string | null;
    derivation_path: string | null;
    valid_from: Date | null;
    first_seen: Date | null;
    input_fee_ppk: number | null;
    balance: number | null;
    fees_paid: number | null;
    amounts: string | null;
    final_expiry: number | null;
    signed_count: number;
    issued: number;
    unsigned_count: number;
    spent_count: number;
    redeemed: number;
    pending_count: number;
    pending: number;
  }>(
    `WITH sig AS (
       SELECT id, count(*) FILTER (WHERE c_ IS NOT NULL)::int AS signed_count,
              coalesce(sum(amount) FILTER (WHERE c_ IS NOT NULL), 0)::bigint AS issued,
              count(*) FILTER (WHERE c_ IS NULL)::int AS unsigned_count
         FROM promises GROUP BY id),
     used AS (
       SELECT id, count(*)::int AS spent_count, coalesce(sum(amount), 0)::bigint AS redeemed
         FROM proofs_used GROUP BY id),
     pend AS (
       SELECT id, count(*)::int AS pending_count, coalesce(sum(amount), 0)::bigint AS pending
         FROM proofs_pending GROUP BY id)
     SELECT k.id, k.unit, k.active,
            ${caps.keysetVersion ? "k.version" : "NULL::text AS version"},
            k.derivation_path,
            (k.valid_from AT TIME ZONE $1) AS valid_from,
            (k.first_seen AT TIME ZONE $1) AS first_seen,
            ${caps.keysetInputFee ? "k.input_fee_ppk" : "NULL::int AS input_fee_ppk"},
            ${caps.keysetBalance ? "k.balance, k.fees_paid" : "NULL::bigint AS balance, NULL::bigint AS fees_paid"},
            ${caps.keysetAmounts ? "k.amounts" : "NULL::text AS amounts"},
            ${caps.keysetFinalExpiry ? "k.final_expiry" : "NULL::bigint AS final_expiry"},
            coalesce(s.signed_count, 0) AS signed_count, coalesce(s.issued, 0) AS issued,
            coalesce(s.unsigned_count, 0) AS unsigned_count,
            coalesce(u.spent_count, 0) AS spent_count, coalesce(u.redeemed, 0) AS redeemed,
            coalesce(p.pending_count, 0) AS pending_count, coalesce(p.pending, 0) AS pending
       FROM keysets k
       LEFT JOIN sig s ON s.id = k.id
       LEFT JOIN used u ON u.id = k.id
       LEFT JOIN pend p ON p.id = k.id
      ORDER BY k.active DESC, k.first_seen DESC NULLS LAST, k.id`,
    [db.config.mintTz],
  );
  return rows.map((r) => {
    const computedBalance = r.issued - r.redeemed - r.pending;
    let denominations: number | null = null;
    if (r.amounts) {
      try {
        const parsed = JSON.parse(r.amounts);
        if (Array.isArray(parsed)) denominations = parsed.length;
      } catch {
        denominations = null;
      }
    }
    return {
      id: r.id,
      unit: r.unit,
      active: r.active,
      version: r.version,
      derivationPath: r.derivation_path,
      validFrom: r.valid_from,
      firstSeen: r.first_seen,
      inputFeePpk: r.input_fee_ppk,
      balance: r.balance,
      feesPaid: r.fees_paid,
      denominations,
      finalExpiry: r.final_expiry,
      signedCount: r.signed_count,
      issued: r.issued,
      unsignedCount: r.unsigned_count,
      spentCount: r.spent_count,
      redeemed: r.redeemed,
      pendingCount: r.pending_count,
      pending: r.pending,
      computedBalance,
      balanceMatches: r.balance === null ? null : r.balance === computedBalance,
    };
  });
}

export interface DenominationRow {
  amount: number;
  issued: number;
  spent: number;
  pending: number;
  outstanding: number;
}

export async function denominations(db: Db, unit: string): Promise<DenominationRow[]> {
  const rows = await db.query<{ amount: number; issued: number; spent: number; pending: number }>(
    `WITH iss AS (
       SELECT p.amount, count(*)::int AS n FROM promises p JOIN keysets k ON k.id = p.id
        WHERE k.unit = $1 AND p.c_ IS NOT NULL GROUP BY 1),
     spent AS (
       SELECT u.amount, count(*)::int AS n FROM proofs_used u JOIN keysets k ON k.id = u.id
        WHERE k.unit = $1 GROUP BY 1),
     pend AS (
       SELECT u.amount, count(*)::int AS n FROM proofs_pending u JOIN keysets k ON k.id = u.id
        WHERE k.unit = $1 GROUP BY 1)
     SELECT coalesce(i.amount, s.amount, p.amount) AS amount,
            coalesce(i.n, 0) AS issued, coalesce(s.n, 0) AS spent, coalesce(p.n, 0) AS pending
       FROM iss i
       FULL JOIN spent s ON s.amount = i.amount
       FULL JOIN pend p ON p.amount = coalesce(i.amount, s.amount)
      ORDER BY 1`,
    [unit],
  );
  return rows.map((r) => ({
    amount: r.amount,
    issued: r.issued,
    spent: r.spent,
    pending: r.pending,
    outstanding: r.issued - r.spent,
  }));
}

export async function balanceLog(db: Db, caps: Caps, unit: string, range: RangeKey): Promise<BalanceLogRow[]> {
  if (!caps.balanceLog) return [];
  const r = RANGES[range];
  const bound = r.interval ? `AND time >= ${since(r.interval)}` : "";
  // Keep the last entry per bucket so long histories stay small.
  const bucket = bucketExpr(range, "(time AT TIME ZONE $1)");
  const rows = await db.query<{ time: Date; keyset_balance: number; keyset_fees_paid: number; backend_balance: number }>(
    `SELECT DISTINCT ON (${bucket}) (time AT TIME ZONE $1) AS time, keyset_balance, keyset_fees_paid, backend_balance
       FROM balance_log WHERE unit = $2 ${bound}
      ORDER BY ${bucket}, time DESC`,
    [db.config.mintTz, unit],
  );
  return rows
    .map((row) => ({
      time: row.time,
      keysetBalance: row.keyset_balance,
      keysetFeesPaid: row.keyset_fees_paid,
      backendBalance: row.backend_balance,
    }))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}

export interface HourRow {
  hour: number;
  mints: number;
  melts: number;
  swaps: number;
}

/** Completed operations by hour of day (mint-local time) over the last 30 days. */
export async function hourly(db: Db, caps: Caps, unit: string): Promise<HourRow[]> {
  const tz = db.config.mintTz;
  const rows = await db.query<{ hour: number; mints: number; melts: number; swaps: number }>(
    `WITH hours AS (SELECT generate_series(0, 23) AS hour),
     mints AS (
       SELECT extract(hour FROM ${caps.mintIssuedTime})::int AS hour, count(*)::int AS n
         FROM mint_quotes q
        WHERE q.unit = $2 AND q.state = 'ISSUED' AND ${caps.mintIssuedTime} >= ${since("30 days")}
        GROUP BY 1),
     melts AS (
       SELECT extract(hour FROM coalesce(q.paid_time, q.created_time))::int AS hour, count(*)::int AS n
         FROM melt_quotes q
        WHERE q.unit = $2 AND q.state = 'PAID' AND coalesce(q.paid_time, q.created_time) >= ${since("30 days")}
        GROUP BY 1),
     swaps AS (
       SELECT extract(hour FROM t)::int AS hour, count(DISTINCT op)::int AS n
         FROM (SELECT ${caps.promiseSignedTime} AS t, ${swapOpExpr(caps)} AS op
                 FROM promises p JOIN keysets k ON k.id = p.id
                WHERE k.unit = $2 AND p.c_ IS NOT NULL AND ${swapWhere(caps)}
                  AND p.created >= ${since("30 days")}) s
        GROUP BY 1)
     SELECT h.hour, coalesce(mi.n, 0) AS mints, coalesce(me.n, 0) AS melts, coalesce(sw.n, 0) AS swaps
       FROM hours h
       LEFT JOIN mints mi ON mi.hour = h.hour
       LEFT JOIN melts me ON me.hour = h.hour
       LEFT JOIN swaps sw ON sw.hour = h.hour
      ORDER BY h.hour`,
    [tz, unit, caps.mintLinkSince],
  );
  return rows;
}

export interface ActivityRow {
  kind: "mint" | "melt" | "swap";
  at: Date;
  amount: number;
  fee: number | null;
  inputs: number | null;
}

/** Most recent completed operations (last 30 days), newest first. */
export async function recentActivity(db: Db, caps: Caps, unit: string, limit: number): Promise<ActivityRow[]> {
  const tz = db.config.mintTz;
  const rows = await db.query<{ kind: ActivityRow["kind"]; at: Date; amount: number; fee: number | null; inputs: number | null }>(
    `SELECT * FROM (
       SELECT 'mint'::text AS kind, (${caps.mintIssuedTime} AT TIME ZONE $1) AS at,
              ${caps.mintIssuedAmount} AS amount, NULL::bigint AS fee, NULL::int AS inputs
         FROM mint_quotes q
        WHERE q.unit = $2 AND q.state = 'ISSUED' AND ${caps.mintIssuedTime} >= ${since("30 days")}
       UNION ALL
       SELECT 'melt', (coalesce(q.paid_time, q.created_time) AT TIME ZONE $1), q.amount, q.fee_paid, NULL
         FROM melt_quotes q
        WHERE q.unit = $2 AND q.state = 'PAID' AND coalesce(q.paid_time, q.created_time) >= ${since("30 days")}
       UNION ALL
       SELECT 'swap', (max(t) AT TIME ZONE $1), sum(amount), NULL, count(*)::int
         FROM (SELECT ${swapOpExpr(caps)} AS op, p.amount, ${caps.promiseSignedTime} AS t
                 FROM promises p JOIN keysets k ON k.id = p.id
                WHERE k.unit = $2 AND p.c_ IS NOT NULL AND ${swapWhere(caps).replaceAll("$3", "$4")}
                  AND p.created >= ${since("30 days")}) s
        GROUP BY op
     ) e
     WHERE at IS NOT NULL
     ORDER BY at DESC
     LIMIT $3`,
    [tz, unit, limit, caps.mintLinkSince],
  );
  return rows;
}

export type CheckStatus = "ok" | "warn" | "fail" | "info" | "skip";

export interface AuditCheck {
  id: string;
  title: string;
  status: CheckStatus;
  summary: string;
  details?: Record<string, unknown>;
  /** the offending rows (at most RECORD_LIMIT), for the operator to look at */
  records?: Array<Record<string, unknown>>;
  truncated?: boolean;
  /** what the finding means and how the operator can address it; nutboard itself never changes anything */
  remedy?: string;
}

const RECORD_LIMIT = 20;
const SAFETY =
  "Any change below is made by you with psql and a role that may write, never by nutboard: stop the mint first, " +
  "take a backup (pg_dump), make the change in one transaction, start the mint and re-check here.";

function take<T>(rows: T[]): { records: T[]; truncated: boolean } {
  return { records: rows.slice(0, RECORD_LIMIT), truncated: rows.length > RECORD_LIMIT };
}

export async function audit(db: Db, caps: Caps, unit: string): Promise<AuditCheck[]> {
  const tz = db.config.mintTz;
  const link = caps.mintLinkSince;
  const checks: AuditCheck[] = [];
  const modern = `($2::timestamp IS NULL OR t >= $2::timestamp)`;
  const legacy = `($2::timestamp IS NOT NULL AND t < $2::timestamp)`;

  const [
    ks,
    lastLog,
    mintVsPromises,
    mintMismatches,
    meltTotals,
    stalePending,
    stalePendingRows,
    staleMelts,
    staleMeltRows,
    paidNotIssued,
    paidNotIssuedRows,
    orphans,
    orphanRows,
    unsignedOld,
    unsignedRows,
  ] = await Promise.all([
    keysets(db, caps),
    caps.balanceLog
      ? db.query<{ time: Date; keyset_balance: number; keyset_fees_paid: number; backend_balance: number }>(
          `SELECT (time AT TIME ZONE $1) AS time, keyset_balance, keyset_fees_paid, backend_balance
             FROM balance_log WHERE unit = $2 ORDER BY time DESC LIMIT 1`,
          [tz, unit],
        )
      : Promise.resolve([]),
    db.one<{
      quotes_count: number;
      quotes_amount: number;
      promises_amount: number;
      mismatched_count: number;
      legacy_count: number;
      legacy_amount: number;
    }>(
      `WITH linked AS (SELECT mint_quote, sum(amount) AS s FROM promises WHERE c_ IS NOT NULL AND mint_quote IS NOT NULL GROUP BY mint_quote),
            q AS (SELECT ${caps.mintIssuedAmount} AS amount_issued, ${caps.mintIssuedTime} AS t, coalesce(l.s, 0) AS promised
                    FROM mint_quotes q LEFT JOIN linked l ON l.mint_quote = q.quote
                   WHERE q.unit = $1 AND q.state = 'ISSUED')
       SELECT count(*) FILTER (WHERE ${modern})::int AS quotes_count,
              coalesce(sum(amount_issued) FILTER (WHERE ${modern}), 0)::bigint AS quotes_amount,
              coalesce(sum(promised) FILTER (WHERE ${modern}), 0)::bigint AS promises_amount,
              count(*) FILTER (WHERE ${modern} AND promised <> amount_issued)::int AS mismatched_count,
              count(*) FILTER (WHERE ${legacy})::int AS legacy_count,
              coalesce(sum(amount_issued) FILTER (WHERE ${legacy}), 0)::bigint AS legacy_amount
         FROM q`,
      [unit, link],
    ),
    db.query<Record<string, unknown>>(
      `WITH linked AS (SELECT mint_quote, sum(amount) AS s, count(*) AS n FROM promises WHERE c_ IS NOT NULL AND mint_quote IS NOT NULL GROUP BY mint_quote)
       SELECT q.quote, q.amount, ${caps.mintIssuedAmount} AS amount_issued, coalesce(l.s, 0)::bigint AS promises_amount,
              coalesce(l.n, 0)::int AS promises_count, (${caps.mintIssuedTime} AT TIME ZONE $3) AS issued_at
         FROM mint_quotes q LEFT JOIN linked l ON l.mint_quote = q.quote
        WHERE q.unit = $1 AND q.state = 'ISSUED' AND ($2::timestamp IS NULL OR ${caps.mintIssuedTime} >= $2::timestamp)
          AND coalesce(l.s, 0) <> ${caps.mintIssuedAmount}
        ORDER BY ${caps.mintIssuedTime} DESC LIMIT ${RECORD_LIMIT + 1}`,
      [unit, link, tz],
    ),
    db.one<{ inputs: number; paid: number; change: number; paid_count: number; legacy_count: number; legacy_amount: number }>(
      `WITH q AS (SELECT q.quote, q.amount, coalesce(q.fee_paid, 0) AS fee_paid,
                         ($2::timestamp IS NULL OR coalesce(q.paid_time, q.created_time) >= $2::timestamp) AS modern
                    FROM melt_quotes q WHERE q.unit = $1 AND q.state = 'PAID')
       SELECT (SELECT coalesce(sum(u.amount), 0)::bigint FROM proofs_used u JOIN q ON q.quote = u.melt_quote WHERE q.modern) AS inputs,
              (SELECT coalesce(sum(amount + fee_paid), 0)::bigint FROM q WHERE modern) AS paid,
              (SELECT count(*)::int FROM q WHERE modern) AS paid_count,
              (SELECT count(*)::int FROM q WHERE NOT modern) AS legacy_count,
              (SELECT coalesce(sum(amount), 0)::bigint FROM q WHERE NOT modern) AS legacy_amount,
              ${
                caps.promisesMeltQuote
                  ? `(SELECT coalesce(sum(p.amount), 0)::bigint FROM promises p JOIN q ON q.quote = p.melt_quote WHERE q.modern AND p.c_ IS NOT NULL)`
                  : "0::bigint"
              } AS change`,
      [unit, caps.spentLinkSince],
    ),
    db.one<{ n: number; amount: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, coalesce(sum(u.amount), 0)::bigint AS amount, (min(u.created) AT TIME ZONE $1) AS oldest
         FROM proofs_pending u JOIN keysets k ON k.id = u.id
        WHERE k.unit = $2 AND u.created < ${since("1 hour")}`,
      [tz, unit],
    ),
    db.query<Record<string, unknown>>(
      `SELECT u.melt_quote, q.state AS quote_state, u.id AS keyset, count(*)::int AS proofs,
              coalesce(sum(u.amount), 0)::bigint AS amount, (min(u.created) AT TIME ZONE $1) AS oldest
         FROM proofs_pending u JOIN keysets k ON k.id = u.id LEFT JOIN melt_quotes q ON q.quote = u.melt_quote
        WHERE k.unit = $2 AND u.created < ${since("1 hour")}
        GROUP BY u.melt_quote, q.state, u.id ORDER BY oldest LIMIT ${RECORD_LIMIT + 1}`,
      [tz, unit],
    ),
    db.one<{ n: number; amount: number; oldest: Date | null }>(
      `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::bigint AS amount, (min(created_time) AT TIME ZONE $1) AS oldest
         FROM melt_quotes WHERE unit = $2 AND state = 'PENDING' AND created_time < ${since("1 hour")}`,
      [tz, unit],
    ),
    db.query<Record<string, unknown>>(
      `SELECT q.quote, q.checking_id AS payment_hash, q.amount, coalesce(q.fee_reserve, 0)::bigint AS fee_reserve,
              (q.created_time AT TIME ZONE $1) AS created_at,
              (SELECT count(*) FROM proofs_pending u WHERE u.melt_quote = q.quote)::int AS pending_proofs,
              (SELECT coalesce(sum(amount), 0) FROM proofs_pending u WHERE u.melt_quote = q.quote)::bigint AS pending_amount
         FROM melt_quotes q
        WHERE q.unit = $2 AND q.state = 'PENDING' AND q.created_time < ${since("1 hour")}
        ORDER BY q.created_time LIMIT ${RECORD_LIMIT + 1}`,
      [tz, unit],
    ),
    db.one<{ n: number; amount: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::bigint AS amount
         FROM mint_quotes WHERE unit = $1 AND state = 'PAID'`,
      [unit],
    ),
    db.query<Record<string, unknown>>(
      `SELECT quote, amount, (paid_time AT TIME ZONE $1) AS paid_at
         FROM mint_quotes WHERE unit = $2 AND state = 'PAID'
        ORDER BY paid_time DESC NULLS LAST LIMIT ${RECORD_LIMIT + 1}`,
      [tz, unit],
    ),
    db.one<{ promises: number; proofs: number }>(
      `SELECT (SELECT count(*)::int FROM promises p WHERE NOT EXISTS (SELECT 1 FROM keysets k WHERE k.id = p.id)) AS promises,
              (SELECT count(*)::int FROM proofs_used u WHERE NOT EXISTS (SELECT 1 FROM keysets k WHERE k.id = u.id)) AS proofs`,
    ),
    db.query<Record<string, unknown>>(
      `SELECT * FROM (
         SELECT 'promises'::text AS "table", p.id AS keyset, count(*)::int AS rows, coalesce(sum(amount), 0)::bigint AS amount
           FROM promises p WHERE NOT EXISTS (SELECT 1 FROM keysets k WHERE k.id = p.id) GROUP BY p.id
         UNION ALL
         SELECT 'proofs_used', u.id, count(*)::int, coalesce(sum(amount), 0)::bigint
           FROM proofs_used u WHERE NOT EXISTS (SELECT 1 FROM keysets k WHERE k.id = u.id) GROUP BY u.id
       ) o LIMIT ${RECORD_LIMIT + 1}`,
    ),
    db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM promises p JOIN keysets k ON k.id = p.id
        WHERE k.unit = $2 AND p.c_ IS NULL AND p.created < ${since("1 hour")}
          ${caps.promisesMeltQuote ? "AND p.melt_quote IS NULL" : ""}`,
      [tz, unit],
    ),
    db.query<Record<string, unknown>>(
      `SELECT p.id AS keyset, p.amount, (p.created AT TIME ZONE $1) AS created_at, p.mint_quote, q.state AS quote_state
         FROM promises p JOIN keysets k ON k.id = p.id LEFT JOIN mint_quotes q ON q.quote = p.mint_quote
        WHERE k.unit = $2 AND p.c_ IS NULL AND p.created < ${since("1 hour")}
          ${caps.promisesMeltQuote ? "AND p.melt_quote IS NULL" : ""}
        ORDER BY p.created DESC LIMIT ${RECORD_LIMIT + 1}`,
      [tz, unit],
    ),
  ]);

  // 1. keyset balance column vs ledger
  const unitKeysets = ks.filter((k) => k.unit === unit);
  if (!caps.keysetBalance) {
    checks.push({
      id: "keyset_balance",
      title: "Keyset balances match the ledger",
      status: "skip",
      summary: "keysets.balance is not available on this Nutshell version (migration 27 adds it).",
    });
  } else {
    const mismatched = unitKeysets.filter((k) => k.balanceMatches === false);
    const ids = mismatched.map((k) => `'${k.id}'`).join(", ");
    checks.push({
      id: "keyset_balance",
      title: "Keyset balances match the ledger",
      status: mismatched.length ? "fail" : "ok",
      summary: mismatched.length
        ? `${mismatched.length} of ${unitKeysets.length} keysets have balance != issued - redeemed - pending`
        : `all ${unitKeysets.length} keysets: balance = issued - redeemed - pending`,
      records: mismatched.length
        ? mismatched.map((k) => ({
            keyset: k.id,
            active: k.active,
            balance_column: k.balance,
            issued: k.issued,
            redeemed: k.redeemed,
            pending: k.pending,
            ledger_balance: k.computedBalance,
            diff: (k.balance ?? 0) - k.computedBalance,
          }))
        : undefined,
      remedy: mismatched.length
        ? "keysets.balance is the mint's running counter, kept since Nutshell migration 27 and used by try_debit_keyset_balance " +
          "to refuse redemptions beyond it; the ledger (signed outputs - spent proofs - pending proofs) is the truth, and the " +
          "counter was seeded from exactly that ledger when the column was introduced. A counter below the ledger (negative diff) " +
          "can make the mint refuse the last few sats of valid ecash on that keyset; a counter above it only weakens an internal " +
          "safety check. Neither changes anyone's balance, and historic crashes between the two writes of an operation are the usual " +
          "cause. Reset the counter to the ledger value:\n\n" +
          "UPDATE keysets k SET balance =\n" +
          "    (SELECT coalesce(sum(amount), 0) FROM promises WHERE id = k.id AND c_ IS NOT NULL)\n" +
          "  - (SELECT coalesce(sum(amount), 0) FROM proofs_used WHERE id = k.id)\n" +
          "  - (SELECT coalesce(sum(amount), 0) FROM proofs_pending WHERE id = k.id)\n" +
          `WHERE k.id IN (${ids});\n\n` +
          SAFETY
        : undefined,
    });
  }

  // 2. backend reserve
  if (!caps.balanceLog || lastLog.length === 0) {
    checks.push({
      id: "backend_reserve",
      title: "Lightning backend covers outstanding ecash",
      status: "skip",
      summary: "no balance_log entries for this unit.",
      remedy:
        "Nutshell's ledger watchdog writes a balance_log row each time it compares the Lightning backend balance with " +
        "the keyset balances (it shuts the mint down on a mismatch unless MINT_WATCHDOG_IGNORE_MISMATCH is set). " +
        "Enable the watchdog in the mint's settings to get this check; nothing in the ledger needs fixing.",
    });
  } else {
    const l = lastLog[0];
    const reserve = l.backend_balance - l.keyset_balance;
    const ageMs = Date.now() - l.time.getTime();
    const stale = ageMs > 7 * 86_400_000;
    checks.push({
      id: "backend_reserve",
      title: "Lightning backend covers outstanding ecash",
      status: reserve < 0 ? "fail" : stale ? "warn" : "ok",
      summary:
        reserve < 0
          ? `backend balance is ${-reserve} ${unit} short of the keyset balance (as of ${l.time.toISOString()})`
          : `backend holds ${reserve} ${unit} more than outstanding ecash${stale ? " (last log entry older than 7 days)" : ""}`,
      details: {
        loggedAt: l.time,
        backendBalance: l.backend_balance,
        keysetBalance: l.keyset_balance,
        keysetFeesPaid: l.keyset_fees_paid,
      },
      remedy:
        reserve < 0
          ? "The Lightning node holds less than the ecash in circulation: the mint cannot honour every melt. Top up the node " +
            "(or find where funds left it) before anything else; no ledger edit fixes this."
          : undefined,
    });
  }

  // 3. issued quotes vs signed mint promises (only quotes issued since outputs carry a quote link)
  {
    const m = mintVsPromises;
    const diff = m.quotes_amount - m.promises_amount;
    const legacyNote = m.legacy_count
      ? ` ${m.legacy_count} older quotes (${m.legacy_amount} ${unit}) predate the quote link and cannot be checked.`
      : "";
    const { records, truncated } = take(mintMismatches);
    checks.push({
      id: "mint_quotes_vs_promises",
      title: "Issued mint quotes equal signed mint outputs",
      status: diff === 0 && m.mismatched_count === 0 ? "ok" : "warn",
      summary:
        diff === 0 && m.mismatched_count === 0
          ? `${m.quotes_count} issued quotes since ${link ?? "the start"}, ${m.quotes_amount} ${unit} on both sides.${legacyNote}`
          : `${m.mismatched_count} of ${m.quotes_count} issued quotes since ${link ?? "the start"} differ from their signed outputs ` +
            `(quotes ${m.quotes_amount} ${unit}, outputs ${m.promises_amount} ${unit}).${legacyNote}`,
      details: { ...m, linkSince: link },
      records: records.length ? records : undefined,
      truncated,
      remedy:
        "Nutshell links outputs to their mint quote since migration 17 (mid-2024); quotes issued before that have no " +
        "linked outputs and are reported separately, not as a problem. For a linked quote the outputs should add up to the " +
        "issued amount; fewer usually means a mint call that stored its outputs but failed before signing and was then " +
        "retried with fresh outputs, more means the quote was issued twice. Nothing to edit: the sat amounts of the signed " +
        "outputs are what circulates, the quote row is bookkeeping. Investigate only when a quote shows signed outputs " +
        "above its amount.",
    });
  }

  // 4. melt accounting
  if (meltTotals.paid_count === 0) {
    checks.push({
      id: "melt_accounting",
      title: "Melt inputs cover payments and change",
      status: "skip",
      summary: "no paid melt quotes yet.",
    });
  } else if (meltTotals.inputs === 0) {
    checks.push({
      id: "melt_accounting",
      title: "Melt inputs cover payments and change",
      status: "info",
      summary: "spent proofs are not linked to melt quotes in this database (pre-migration-17 data); cannot reconcile.",
      details: meltTotals,
    });
  } else {
    const margin = meltTotals.inputs - meltTotals.paid - meltTotals.change;
    const legacyNote = meltTotals.legacy_count
      ? ` ${meltTotals.legacy_count} older melts (${meltTotals.legacy_amount} ${unit}) predate the proof link and cannot be checked.`
      : "";
    checks.push({
      id: "melt_accounting",
      title: "Melt inputs cover payments and change",
      status: margin >= 0 ? "ok" : "fail",
      summary:
        margin >= 0
          ? `${meltTotals.paid_count} paid melts since ${caps.spentLinkSince ?? "the start"}: inputs ${meltTotals.inputs} = payments+LN fees ${meltTotals.paid} + change ${meltTotals.change} + input fees ${margin} ${unit}.${legacyNote}`
          : `melt outputs exceed inputs by ${-margin} ${unit}.${legacyNote}`,
      details: { ...meltTotals, inputFees: margin, linkSince: caps.spentLinkSince },
      remedy:
        margin < 0
          ? "More value left through paid melts (payments, Lightning fees and change) than the spent proofs that funded them. " +
            "That is a real loss, not bookkeeping: compare each paid melt's inputs with amount + fee_paid + change to find the " +
            "quotes responsible, then check those payments on the Lightning node."
          : undefined,
    });
  }

  // 5. stale pending proofs
  {
    const { records, truncated } = take(stalePendingRows);
    checks.push({
      id: "stale_pending_proofs",
      title: "No proofs stuck in pending",
      status: stalePending.n > 0 ? "warn" : "ok",
      summary:
        stalePending.n > 0
          ? `${stalePending.n} proofs (${stalePending.amount} ${unit}) pending for more than 1 hour, oldest ${stalePending.oldest?.toISOString()}`
          : "no proofs pending for longer than 1 hour",
      details: stalePending.n > 0 ? stalePending : undefined,
      records: records.length ? records : undefined,
      truncated,
      remedy:
        stalePending.n > 0
          ? "Pending proofs are inputs reserved by an operation that has not finished. Rows with a melt quote belong to that melt: " +
            "see the stuck melts check, they are resolved together with it. Rows without a melt quote come from a swap that crashed " +
            "between reserving and finishing; they block those notes for the wallet that holds them. Nutshell's own rollback for such " +
            "a case deletes the pending rows and adds their amount back to the keyset counter:\n\n" +
            "UPDATE keysets k SET balance = balance + (SELECT coalesce(sum(amount), 0) FROM proofs_pending WHERE id = k.id AND melt_quote IS NULL AND created < now()::timestamp - interval '1 hour')\n" +
            " WHERE k.id IN (SELECT DISTINCT id FROM proofs_pending WHERE melt_quote IS NULL AND created < now()::timestamp - interval '1 hour');\n" +
            "DELETE FROM proofs_pending WHERE melt_quote IS NULL AND created < now()::timestamp - interval '1 hour';\n\n" +
            SAFETY
          : undefined,
    });
  }

  // 6. stale pending melts
  {
    const { records, truncated } = take(staleMeltRows);
    checks.push({
      id: "stale_pending_melts",
      title: "No melt quotes stuck in pending",
      status: staleMelts.n > 0 ? "warn" : "ok",
      summary:
        staleMelts.n > 0
          ? `${staleMelts.n} melt quotes (${staleMelts.amount} ${unit}) pending for more than 1 hour, oldest ${staleMelts.oldest?.toISOString()}`
          : "no melt quotes pending for longer than 1 hour",
      details: staleMelts.n > 0 ? staleMelts : undefined,
      records: records.length ? records : undefined,
      truncated,
      remedy:
        staleMelts.n > 0
          ? "A pending melt is an outgoing Lightning payment whose outcome the mint does not know; the wallet's inputs stay " +
            "reserved (pending proofs) until it does. Restart the mint first: at startup Nutshell asks the backend about every " +
            "pending melt and commits it (settled) or rolls it back (failed). Payments the backend reports as pending, not found " +
            "or that error out stay pending for ever, so look the payment_hash up on your Lightning node (lncli trackpayment, " +
            "lightning-cli listpays, ...). If the node says the payment failed or never existed, roll back by hand; if it was " +
            "paid, finalize by hand; the README section \"Fixing inconsistencies\" has the SQL for both. " +
            SAFETY
          : undefined,
    });
  }

  // 7. paid but not issued
  {
    const { records, truncated } = take(paidNotIssuedRows);
    checks.push({
      id: "paid_not_issued",
      title: "Paid mint quotes awaiting issuance",
      status: "info",
      summary:
        paidNotIssued.n > 0
          ? `${paidNotIssued.n} quotes paid (${paidNotIssued.amount} ${unit}) whose ecash has not been claimed yet`
          : "every paid mint quote has been issued",
      details: paidNotIssued,
      records: records.length ? records : undefined,
      truncated,
      remedy:
        paidNotIssued.n > 0
          ? "Someone paid the invoice but their wallet never asked for the ecash (closed app, lost connection). The sats sit on " +
            "your node and the quote stays claimable, so nothing needs fixing; old ones are money the mint keeps unless you refund " +
            "them out of band."
          : undefined,
    });
  }

  // 8. orphans (global, not unit specific)
  {
    const { records, truncated } = take(orphanRows);
    checks.push({
      id: "orphan_rows",
      title: "Every promise and spent proof references a known keyset",
      status: orphans.promises + orphans.proofs > 0 ? "fail" : "ok",
      summary:
        orphans.promises + orphans.proofs > 0
          ? `${orphans.promises} promises and ${orphans.proofs} spent proofs reference keysets that do not exist`
          : "no orphaned rows (checked across all units)",
      details: orphans.promises + orphans.proofs > 0 ? orphans : undefined,
      records: records.length ? records : undefined,
      truncated,
      remedy:
        orphans.promises + orphans.proofs > 0
          ? "Rows that point at a keyset id missing from the keysets table are invisible to every per-unit figure here and to " +
            "the mint's balance views. Usually the keysets row was deleted or renamed (migration 18 rewrote deprecated ids); " +
            "restore the keyset row rather than deleting the ledger rows."
          : undefined,
    });
  }

  // 9. unsigned outputs not tied to a melt
  {
    const { records, truncated } = take(unsignedRows);
    checks.push({
      id: "unsigned_outputs",
      title: "No stale unsigned outputs outside melts",
      status: unsignedOld.n > 0 ? "warn" : "ok",
      summary:
        unsignedOld.n > 0
          ? `${unsignedOld.n} blinded messages older than 1 hour were stored but never signed (and are not melt change)`
          : "no stale unsigned blinded messages outside melt change",
      records: records.length ? records : undefined,
      truncated,
      remedy:
        unsignedOld.n > 0
          ? "A mint or swap stored the wallet's outputs and then failed before signing them (unpaid quote, invalid inputs, crash). " +
            "They carry no value and no balance, so they are harmless; the only effect is that the same blinded message cannot be " +
            "submitted again, which wallets avoid by generating fresh ones. Safe to delete if you want a clean table:\n\n" +
            "DELETE FROM promises WHERE c_ IS NULL AND melt_quote IS NULL AND created < now()::timestamp - interval '1 day';\n\n" +
            SAFETY
          : undefined,
    });
  }

  return checks;
}
