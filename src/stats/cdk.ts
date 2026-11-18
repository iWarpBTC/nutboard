import type { Db, SchemaInfo } from "../db.ts";
import {
  RANGES,
  WINDOWS,
  assembleTimeseries,
  unpack,
  type ActivityRow,
  type AuditCheck,
  type DenominationRow,
  type FeeBucket,
  type FeeStats,
  type HourRow,
  type KeysetRow,
  type MintStats,
  type Overview,
  type PublicFees,
  type RangeKey,
  type Timeseries,
} from "./shared.ts";

/*
 * Statistics for a CDK mint (cdk-mintd on PostgreSQL). Plain SELECTs, nothing here writes.
 *
 * How a CDK database differs from a Nutshell one:
 *
 *  - Timestamps are Unix seconds. There is no mint-local time to get wrong; MINT_TZ only decides
 *    which hour of the day an operation is filed under.
 *  - Every finished mint, melt and swap is one row in completed_operations, so nothing has to be
 *    estimated. For a melt, total_redeemed is the inputs, total_issued the change, fee_collected
 *    the input fee, payment_amount the invoice and payment_fee what Lightning cost.
 *  - completed_operations carries no unit. An operation belongs to the unit of the keyset its
 *    outputs or inputs were made with; on a mint with a single unit that lookup is skipped.
 *  - Outputs live in blind_signature (c IS NULL until signed), inputs in proof with a state column.
 *    Both carry the operation_kind and operation_id of the operation that created them.
 *  - The mint keeps running totals per keyset in keyset_amounts.
 *  - A mint quote has no state column: nothing paid is UNPAID, more paid than issued is PAID, else ISSUED.
 *  - The Lightning backend balance is not recorded anywhere, so there is no reserve to chart.
 */

const MINT_KINDS = "('mint', 'batch_mint')";

/** Derived state of a mint quote (alias q), as cdk computes it. */
const MINT_STATE = `CASE WHEN q.amount_paid = 0 AND q.amount_issued = 0 THEN 'UNPAID'
                         WHEN q.amount_paid > q.amount_issued THEN 'PAID' ELSE 'ISSUED' END`;

/** Unix seconds of "now minus interval", computed on the constant side so indexes stay usable. */
function sinceEpoch(interval: string): string {
  return `extract(epoch FROM now() - interval '${interval}')::bigint`;
}

interface Measure {
  name: string;
  agg: string;
  where?: string;
}

/** Builds one aggregate column per (window, measure): "<window>__<measure>"; timeCol holds Unix seconds. */
function windowed(measures: Measure[], timeCol = "t"): string {
  const parts: string[] = [];
  for (const w of WINDOWS) {
    for (const m of measures) {
      const conds: string[] = [];
      if (m.where) conds.push(m.where);
      if (w.interval) conds.push(`${timeCol} >= ${sinceEpoch(w.interval)}`);
      const filter = conds.length ? ` FILTER (WHERE ${conds.join(" AND ")})` : "";
      parts.push(`coalesce(${m.agg}${filter}, 0) AS "${w.key}__${m.name}"`);
    }
  }
  return parts.join(",\n       ");
}

function bucketExpr(range: RangeKey, epochExpr: string): string {
  const r = RANGES[range];
  if (r.bin) return `date_bin(interval '${r.bin}', to_timestamp(${epochExpr}), timestamptz '1970-01-01 00:00:00+00')`;
  return `date_trunc('month', to_timestamp(${epochExpr}))`;
}

/**
 * Body of a CTE listing the finished operations of one unit; `unit` is the placeholder holding the unit.
 * With a single unit every operation belongs to it, and the placeholder is only mentioned so that the
 * statement uses the same parameters either way.
 */
function opsBody(multiUnit: boolean, unit: string): string {
  const scope = multiUnit
    ? `co.operation_id IN (
         SELECT b.operation_id FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
          WHERE k.unit = ${unit} AND b.operation_id IS NOT NULL
         UNION
         SELECT p.operation_id FROM proof p JOIN keyset k ON k.id = p.keyset_id
          WHERE k.unit = ${unit} AND p.operation_id IS NOT NULL)`
    : `${unit}::text IS NOT NULL`;
  return `SELECT co.operation_id, co.operation_kind AS kind, co.completed_at AS t,
                 co.total_issued, co.total_redeemed, co.fee_collected,
                 coalesce(co.payment_amount, 0) AS payment_amount, coalesce(co.payment_fee, 0) AS payment_fee
            FROM completed_operations co
           WHERE ${scope}`;
}

/** Melt operation -> melt quote, through the inputs that carry both ids. */
const MELT_LINK = `SELECT DISTINCT ON (p.operation_id) p.operation_id, p.quote_id
                     FROM proof p WHERE p.operation_kind = 'melt' AND p.quote_id IS NOT NULL
                    ORDER BY p.operation_id`;

const RECORD_LIMIT = 20;
const PUBLIC_BAND = { min: 1000, max: 99_999 };
const PUBLIC_MIN_PAYMENTS = 5;
const HANDS_OFF =
  "nutboard only reads. Do not edit a CDK mint database by hand while the mint runs: stop cdk-mintd and take a " +
  "backup (pg_dump) first, and prefer restarting the mint, which re-checks unfinished operations on startup.";

function take<T>(rows: T[]): { records: T[]; truncated: boolean } {
  return { records: rows.slice(0, RECORD_LIMIT), truncated: rows.length > RECORD_LIMIT };
}

export async function createCdkStats(db: Db, schema: SchemaInfo): Promise<MintStats> {
  for (const table of ["keyset", "blind_signature", "proof", "mint_quote", "melt_quote", "completed_operations"] as const) {
    if (!schema.columns.has(table)) {
      throw new Error(
        `table "${table}" is not readable in schema "${schema.schema}"; nutboard needs it on a CDK mint ` +
          "(re-run scripts/create-readonly-role.sql to refresh the grants)",
      );
    }
  }
  const hasAmounts = schema.columns.has("keyset_amounts");
  const hasSagas = schema.columns.has("saga_state");
  const hasPayments = schema.columns.has("mint_quote_payments");
  const tz = db.config.mintTz;

  // The unit list changes only when the operator adds a unit; remember it briefly.
  let unitsCache: { at: number; value: Promise<string[]> } | null = null;
  function listUnits(): Promise<string[]> {
    if (unitsCache && Date.now() - unitsCache.at < 10_000) return unitsCache.value;
    const value = db
      .query<{ unit: string }>(`SELECT DISTINCT unit FROM keyset WHERE unit IS NOT NULL ORDER BY unit`)
      .then((rows) => rows.map((r) => r.unit))
      .catch((err) => {
        unitsCache = null;
        throw err;
      });
    unitsCache = { at: Date.now(), value };
    return value;
  }
  /** CTE body with the operations of the unit bound to `placeholder`. */
  async function ops(placeholder: string): Promise<string> {
    return opsBody((await listUnits()).length > 1, placeholder);
  }

  // ---------- keysets ----------

  async function keysets(): Promise<KeysetRow[]> {
    const rows = await db.query<{
      id: string;
      unit: string | null;
      active: boolean;
      version: string | null;
      derivation_path: string | null;
      valid_from: Date | null;
      input_fee_ppk: number | null;
      counter: number | null;
      fee_collected: number | null;
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
         SELECT keyset_id, count(*) FILTER (WHERE c IS NOT NULL)::int AS signed_count,
                coalesce(sum(amount) FILTER (WHERE c IS NOT NULL), 0)::bigint AS issued,
                count(*) FILTER (WHERE c IS NULL)::int AS unsigned_count
           FROM blind_signature GROUP BY keyset_id),
       inp AS (
         SELECT keyset_id, count(*) FILTER (WHERE state = 'SPENT')::int AS spent_count,
                coalesce(sum(amount) FILTER (WHERE state = 'SPENT'), 0)::bigint AS redeemed,
                count(*) FILTER (WHERE state = 'PENDING')::int AS pending_count,
                coalesce(sum(amount) FILTER (WHERE state = 'PENDING'), 0)::bigint AS pending
           FROM proof GROUP BY keyset_id)
       SELECT k.id, k.unit, k.active, k.issuer_version AS version, k.derivation_path,
              CASE WHEN k.valid_from > 0 THEN to_timestamp(k.valid_from) END AS valid_from,
              k.input_fee_ppk,
              ${
                hasAmounts
                  ? "(a.total_issued - a.total_redeemed)::bigint AS counter, a.fee_collected::bigint AS fee_collected"
                  : "NULL::bigint AS counter, NULL::bigint AS fee_collected"
              },
              k.amounts, k.valid_to::bigint AS final_expiry,
              coalesce(s.signed_count, 0) AS signed_count, coalesce(s.issued, 0) AS issued,
              coalesce(s.unsigned_count, 0) AS unsigned_count,
              coalesce(i.spent_count, 0) AS spent_count, coalesce(i.redeemed, 0) AS redeemed,
              coalesce(i.pending_count, 0) AS pending_count, coalesce(i.pending, 0) AS pending
         FROM keyset k
         LEFT JOIN sig s ON s.keyset_id = k.id
         LEFT JOIN inp i ON i.keyset_id = k.id
         ${hasAmounts ? "LEFT JOIN keyset_amounts a ON a.keyset_id = k.id" : ""}
        ORDER BY k.active DESC, k.valid_from DESC NULLS LAST, k.id`,
    );
    return rows.map((r) => {
      // Same meaning as Nutshell's keysets.balance: what is still spendable, pending inputs excluded.
      // CDK's own totals only move when an input is finally spent, so pending comes off here.
      const computedBalance = r.issued - r.redeemed - r.pending;
      const balance = r.counter === null ? (hasAmounts ? 0 - r.pending : null) : r.counter - r.pending;
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
        // CDK records one creation time per keyset; it serves as both.
        firstSeen: r.valid_from,
        inputFeePpk: r.input_fee_ppk,
        balance,
        feesPaid: hasAmounts ? (r.fee_collected ?? 0) : null,
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
        balanceMatches: balance === null ? null : balance === computedBalance,
      };
    });
  }

  // ---------- overview ----------

  async function overview(unit: string): Promise<Overview> {
    const o = await ops("$1");

    const mintQ = db.one<Record<string, number>>(
      `WITH ops AS (${o})
       SELECT ${windowed([
         { name: "count", agg: "count(*)" },
         { name: "amount", agg: "sum(total_issued)" },
         { name: "avg", agg: "avg(total_issued)" },
         { name: "max", agg: "max(total_issued)" },
       ])}
         FROM ops WHERE kind IN ${MINT_KINDS}`,
      [unit],
    );

    const requestsQ = db.one<Record<string, number>>(
      `WITH src AS (
         SELECT coalesce(q.amount, q.amount_paid) AS amount, q.created_time AS t, ${MINT_STATE} AS state
           FROM mint_quote q WHERE q.unit = $1)
       SELECT ${windowed([
         { name: "count", agg: "count(*)" },
         { name: "amount", agg: "sum(amount)" },
         { name: "issued_count", agg: "count(*)", where: "state = 'ISSUED'" },
         { name: "unpaid_count", agg: "count(*)", where: "state = 'UNPAID'" },
       ])}
         FROM src`,
      [unit],
    );

    const meltQ = db.one<Record<string, number>>(
      `WITH ops AS (${o}), link AS (${MELT_LINK}),
       src AS (
         SELECT m.payment_amount AS amount, m.payment_fee AS fee_paid, coalesce(q.fee_reserve, 0) AS fee_reserve, m.t
           FROM ops m LEFT JOIN link l ON l.operation_id = m.operation_id LEFT JOIN melt_quote q ON q.id = l.quote_id
          WHERE m.kind = 'melt')
       SELECT ${windowed([
         { name: "count", agg: "count(*)" },
         { name: "amount", agg: "sum(amount)" },
         { name: "fee_reserve", agg: "sum(fee_reserve)" },
         { name: "fee_paid", agg: "sum(fee_paid)" },
         { name: "avg", agg: "avg(amount)" },
         { name: "max", agg: "max(amount)" },
       ])}
         FROM src`,
      [unit],
    );

    const signaturesQ = db.one<Record<string, number>>(
      `WITH src AS (
         SELECT b.amount, coalesce(b.signed_time, b.created_time) AS t, b.operation_id AS op,
                CASE WHEN b.operation_kind IN ${MINT_KINDS} THEN 'mint'
                     WHEN b.operation_kind IN ('swap', 'melt') THEN b.operation_kind
                     ELSE 'legacy' END AS origin
           FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
          WHERE k.unit = $1 AND b.c IS NOT NULL)
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
      [unit],
    );

    const spentQ = db.one<Record<string, number>>(
      `WITH src AS (
         SELECT p.amount, p.created_time AS t, coalesce(p.operation_kind, '') AS kind
           FROM proof p JOIN keyset k ON k.id = p.keyset_id
          WHERE k.unit = $1 AND p.state = 'SPENT')
       SELECT ${windowed([
         { name: "count", agg: "count(*)" },
         { name: "amount", agg: "sum(amount)" },
         { name: "melt_count", agg: "count(*)", where: "kind = 'melt'" },
         { name: "melt_amount", agg: "sum(amount)", where: "kind = 'melt'" },
         { name: "swap_count", agg: "count(*)", where: "kind = 'swap'" },
         { name: "swap_amount", agg: "sum(amount)", where: "kind = 'swap'" },
         { name: "legacy_count", agg: "count(*)", where: "kind NOT IN ('swap', 'melt')" },
         { name: "legacy_amount", agg: "sum(amount)", where: "kind NOT IN ('swap', 'melt')" },
       ])}
         FROM src`,
      [unit],
    );

    const keysetsQ = db.one<{ keysets: number; active_keysets: number; counter: number | null; fees: number | null }>(
      `SELECT count(*)::int AS keysets, count(*) FILTER (WHERE k.active)::int AS active_keysets,
              ${
                hasAmounts
                  ? "coalesce(sum(a.total_issued - a.total_redeemed), 0)::bigint AS counter, coalesce(sum(a.fee_collected), 0)::bigint AS fees"
                  : "NULL::bigint AS counter, NULL::bigint AS fees"
              }
         FROM keyset k ${hasAmounts ? "LEFT JOIN keyset_amounts a ON a.keyset_id = k.id" : ""}
        WHERE k.unit = $1`,
      [unit],
    );

    const pendingQ = db.one<{ pending: number; pending_count: number }>(
      `SELECT coalesce(sum(p.amount), 0)::bigint AS pending, count(*)::int AS pending_count
         FROM proof p JOIN keyset k ON k.id = p.keyset_id WHERE k.unit = $1 AND p.state = 'PENDING'`,
      [unit],
    );

    const unsignedQ = db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
        WHERE k.unit = $1 AND b.c IS NULL`,
      [unit],
    );

    const mintStatesQ = db.query<{ state: string; count: number; amount: number }>(
      `SELECT ${MINT_STATE} AS state, count(*)::int AS count, coalesce(sum(coalesce(q.amount, q.amount_paid)), 0)::bigint AS amount
         FROM mint_quote q WHERE q.unit = $1 GROUP BY 1 ORDER BY 1`,
      [unit],
    );
    const meltStatesQ = db.query<{ state: string; count: number; amount: number }>(
      `SELECT coalesce(state, 'UNKNOWN') AS state, count(*)::int AS count, coalesce(sum(amount), 0)::bigint AS amount
         FROM melt_quote WHERE unit = $1 GROUP BY 1 ORDER BY 1`,
      [unit],
    );

    const lastQ = db.one<{
      last_mint: Date | null;
      last_melt: Date | null;
      last_swap: Date | null;
      last_signature: Date | null;
      last_request: Date | null;
    }>(
      `WITH ops AS (${o})
       SELECT to_timestamp((SELECT max(t) FROM ops WHERE kind IN ${MINT_KINDS})) AS last_mint,
              to_timestamp((SELECT max(t) FROM ops WHERE kind = 'melt')) AS last_melt,
              to_timestamp((SELECT max(t) FROM ops WHERE kind = 'swap')) AS last_swap,
              to_timestamp((SELECT max(coalesce(b.signed_time, b.created_time)) FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
                             WHERE k.unit = $1 AND b.c IS NOT NULL)) AS last_signature,
              to_timestamp((SELECT max(q.created_time) FROM mint_quote q WHERE q.unit = $1)) AS last_request`,
      [unit],
    );

    const [mint, requests, melt, signatures, spent, ks, pending, unsigned, mintStates, meltStates, last] = await Promise.all([
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
      lastQ,
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
        // Spendable balance by the mint's own totals: pending inputs are not redeemed yet, so they come off here.
        keysetBalance: ks.counter === null ? null : ks.counter - pending.pending,
        feesPaid: ks.fees,
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
      lastBalanceLog: null,
      legacy: { mintLinkSince: null, spentLinkSince: null },
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

  // ---------- time series ----------

  async function timeseries(unit: string, range: RangeKey): Promise<Timeseries> {
    const r = RANGES[range];
    const bound = r.interval ? `AND t >= ${sinceEpoch(r.interval)}` : "";
    const rows = await db.query<{ kind: "mint" | "melt" | "swap"; bucket: Date; count: number; amount: number; fee: number }>(
      `WITH ops AS (${await ops("$1")})
       SELECT CASE WHEN kind IN ${MINT_KINDS} THEN 'mint' ELSE kind END AS kind,
              ${bucketExpr(range, "t")} AS bucket, count(*)::int AS count,
              coalesce(sum(CASE WHEN kind = 'melt' THEN payment_amount ELSE total_issued END), 0)::bigint AS amount,
              coalesce(sum(payment_fee), 0)::bigint AS fee
         FROM ops
        WHERE kind IN ('mint', 'batch_mint', 'melt', 'swap') ${bound}
        GROUP BY 1, 2 ORDER BY 2`,
      [unit],
    );
    const of = (kind: string) => rows.filter((row) => row.kind === kind);
    const plain = (kind: string) => of(kind).map(({ bucket, count, amount }) => ({ bucket, count, amount }));
    return assembleTimeseries(unit, range, plain("mint"), of("melt"), plain("swap"));
  }

  async function hourly(unit: string): Promise<HourRow[]> {
    return db.query<HourRow>(
      `WITH ops AS (${await ops("$1")}),
       hours AS (SELECT generate_series(0, 23) AS hour),
       o AS (SELECT extract(hour FROM to_timestamp(t) AT TIME ZONE $2)::int AS hour, kind
               FROM ops WHERE t >= ${sinceEpoch("30 days")})
       SELECT h.hour, count(o.kind) FILTER (WHERE o.kind IN ${MINT_KINDS})::int AS mints,
              count(o.kind) FILTER (WHERE o.kind = 'melt')::int AS melts,
              count(o.kind) FILTER (WHERE o.kind = 'swap')::int AS swaps
         FROM hours h LEFT JOIN o ON o.hour = h.hour
        GROUP BY h.hour ORDER BY h.hour`,
      [unit, tz],
    );
  }

  async function recentActivity(unit: string, limit: number): Promise<ActivityRow[]> {
    // The newest rows are picked first; only then are the outputs of each swap counted.
    return db.query<ActivityRow>(
      `WITH ops AS (${await ops("$1")}),
       recent AS (
         SELECT operation_id, kind, t, total_issued, payment_amount, payment_fee
           FROM ops
          WHERE kind IN ('mint', 'batch_mint', 'melt', 'swap') AND t >= ${sinceEpoch("30 days")}
          ORDER BY t DESC LIMIT $2)
       SELECT CASE WHEN r.kind IN ${MINT_KINDS} THEN 'mint' ELSE r.kind END AS kind, to_timestamp(r.t) AS at,
              (CASE WHEN r.kind = 'melt' THEN r.payment_amount ELSE r.total_issued END)::bigint AS amount,
              (CASE WHEN r.kind = 'melt' THEN r.payment_fee END)::bigint AS fee,
              CASE WHEN r.kind = 'swap' THEN (SELECT count(*)::int FROM blind_signature b
                                              WHERE b.operation_kind = 'swap' AND b.operation_id = r.operation_id) END AS inputs
         FROM recent r ORDER BY r.t DESC`,
      [unit, limit],
    );
  }

  // ---------- fees ----------

  /** Paid melts of one unit (alias m), optionally limited in time; `bound` is appended to the WHERE clause. */
  function meltsCte(o: string, bound: string): string {
    return `ops AS (${o}), link AS (${MELT_LINK}),
       m AS (
         SELECT x.payment_amount AS amount, x.payment_fee AS fee_paid, x.fee_collected,
                x.total_redeemed AS inputs, x.total_issued AS change, coalesce(q.fee_reserve, 0) AS fee_reserve
           FROM ops x LEFT JOIN link l ON l.operation_id = x.operation_id LEFT JOIN melt_quote q ON q.id = l.quote_id
          WHERE x.kind = 'melt' AND x.payment_amount > 0 ${bound})`;
  }

  async function fees(unit: string, range: RangeKey): Promise<FeeStats> {
    const r = RANGES[range];
    const bound = r.interval ? `AND x.t >= ${sinceEpoch(r.interval)}` : "";
    const rows = await db.query<{
      magnitude: number | null;
      count: number;
      amount: number;
      ln_fee: number;
      fee_reserve: number;
      free_count: number;
      median_ln_ratio: number | null;
      max_ln_fee: number;
      mint_fee: number;
    }>(
      `WITH ${meltsCte(await ops("$1"), bound)}
       SELECT floor(log(10, m.amount::numeric))::int AS magnitude, count(*)::int AS count, sum(m.amount)::bigint AS amount,
              sum(m.fee_paid)::bigint AS ln_fee, sum(m.fee_reserve)::bigint AS fee_reserve,
              count(*) FILTER (WHERE m.fee_paid = 0)::int AS free_count,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.fee_paid::float8 / m.amount))::float8 AS median_ln_ratio,
              max(m.fee_paid)::bigint AS max_ln_fee, sum(m.fee_collected)::bigint AS mint_fee
         FROM m
        GROUP BY ROLLUP (floor(log(10, m.amount::numeric))::int) ORDER BY 1 NULLS LAST`,
      [unit],
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
      // Every finished melt records its own input fee, so all of them count.
      linkedCount: row.count,
      mintFee: row.mint_fee,
      mintFeeBase: row.amount,
    });
    const totalRow = rows.find((row) => row.magnitude === null);
    return {
      unit,
      range,
      buckets: rows.filter((row) => row.magnitude !== null).map(map),
      total: totalRow && totalRow.count > 0 ? map(totalRow) : null,
    };
  }

  /** Aggregate fee figures for reasonably sized payments; nothing about individual payments or balances. */
  async function publicFees(unit: string): Promise<PublicFees> {
    const keyset = await db.query<{ input_fee_ppk: number | null }>(
      `SELECT input_fee_ppk FROM keyset WHERE unit = $1 AND active ORDER BY valid_from DESC NULLS LAST LIMIT 1`,
      [unit],
    );
    const inputFeePpk = keyset[0]?.input_fee_ppk ?? null;
    const empty: PublicFees = {
      unit, range: null, band: PUBLIC_BAND, count: 0, freeCount: 0, lnRatio: null, mintRatio: null, totalRatio: null,
      medianTotalRatio: null, medianLnRatio: null, inputFeePpk,
    };
    const o = await ops("$1");
    for (const range of ["30d", "90d", "all"] as const) {
      const r = RANGES[range];
      const bound = `AND x.payment_amount BETWEEN $2 AND $3 ${r.interval ? `AND x.t >= ${sinceEpoch(r.interval)}` : ""}`;
      const row = await db.one<{
        count: number; amount: number; ln_fee: number; mint_fee: number; free_count: number;
        median_total_ratio: number | null; median_ln_ratio: number | null;
      }>(
        `WITH ${meltsCte(o, bound)}
         SELECT count(*)::int AS count, coalesce(sum(m.amount), 0)::bigint AS amount, coalesce(sum(m.fee_paid), 0)::bigint AS ln_fee,
                coalesce(sum(m.fee_collected), 0)::bigint AS mint_fee, count(*) FILTER (WHERE m.fee_paid = 0)::int AS free_count,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY (m.fee_paid + m.fee_collected)::float8 / m.amount))::float8 AS median_total_ratio,
                (percentile_cont(0.5) WITHIN GROUP (ORDER BY m.fee_paid::float8 / m.amount))::float8 AS median_ln_ratio
           FROM m`,
        [unit, PUBLIC_BAND.min, PUBLIC_BAND.max],
      );
      if (row.count < PUBLIC_MIN_PAYMENTS) continue;
      const lnRatio = row.amount > 0 ? row.ln_fee / row.amount : null;
      const mintRatio = row.amount > 0 ? row.mint_fee / row.amount : null;
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

  // ---------- denominations ----------

  async function denominations(unit: string): Promise<DenominationRow[]> {
    const rows = await db.query<{ amount: number; issued: number; spent: number; pending: number }>(
      `WITH iss AS (
         SELECT b.amount, count(*)::int AS n FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
          WHERE k.unit = $1 AND b.c IS NOT NULL GROUP BY 1),
       inp AS (
         SELECT p.amount, count(*) FILTER (WHERE p.state = 'SPENT')::int AS spent,
                count(*) FILTER (WHERE p.state = 'PENDING')::int AS pending
           FROM proof p JOIN keyset k ON k.id = p.keyset_id
          WHERE k.unit = $1 AND p.state IN ('SPENT', 'PENDING') GROUP BY 1)
       SELECT coalesce(i.amount, p.amount) AS amount, coalesce(i.n, 0) AS issued,
              coalesce(p.spent, 0) AS spent, coalesce(p.pending, 0) AS pending
         FROM iss i FULL JOIN inp p ON p.amount = i.amount
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

  // ---------- audit ----------

  async function audit(unit: string): Promise<AuditCheck[]> {
    const o = await ops("$1");
    const hour = sinceEpoch("1 hour");
    const checks: AuditCheck[] = [];

    const [
      ks,
      opsVsLedger,
      meltTotals,
      meltShortRows,
      mintTotals,
      mintMismatchRows,
      stalePending,
      stalePendingRows,
      staleMelts,
      staleMeltRows,
      sagas,
      sagaRows,
      paidNotIssued,
      paidNotIssuedRows,
      orphans,
      orphanRows,
      unsignedOld,
      unsignedRows,
    ] = await Promise.all([
      keysets(),
      // What the operations log says was issued and redeemed, next to what the outputs and inputs add up to.
      db.one<{ log_issued: number; log_redeemed: number; led_issued: number; led_redeemed: number; unlogged_outputs: number }>(
        `WITH ops AS (${o})
         SELECT (SELECT coalesce(sum(total_issued), 0)::bigint FROM ops) AS log_issued,
                (SELECT coalesce(sum(total_redeemed), 0)::bigint FROM ops) AS log_redeemed,
                (SELECT coalesce(sum(b.amount), 0)::bigint FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
                  WHERE k.unit = $1 AND b.c IS NOT NULL AND b.operation_id IN (SELECT operation_id FROM ops)) AS led_issued,
                (SELECT coalesce(sum(p.amount), 0)::bigint FROM proof p JOIN keyset k ON k.id = p.keyset_id
                  WHERE k.unit = $1 AND p.state = 'SPENT' AND p.operation_id IN (SELECT operation_id FROM ops)) AS led_redeemed,
                (SELECT count(*)::int FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
                  WHERE k.unit = $1 AND b.c IS NOT NULL
                    AND (b.operation_id IS NULL OR b.operation_id NOT IN (SELECT operation_id FROM ops))) AS unlogged_outputs`,
        [unit],
      ),
      db.one<{ n: number; inputs: number; paid: number; change: number; fees: number; short: number; unlogged: number }>(
        `WITH ops AS (${o}), link AS (${MELT_LINK})
         SELECT count(*)::int AS n, coalesce(sum(total_redeemed), 0)::bigint AS inputs,
                coalesce(sum(payment_amount + payment_fee), 0)::bigint AS paid, coalesce(sum(total_issued), 0)::bigint AS change,
                coalesce(sum(fee_collected), 0)::bigint AS fees,
                count(*) FILTER (WHERE total_redeemed < payment_amount + payment_fee + total_issued + fee_collected)::int AS short,
                (SELECT count(*)::int FROM melt_quote q WHERE q.unit = $1 AND q.state = 'PAID'
                    AND NOT EXISTS (SELECT 1 FROM link l WHERE l.quote_id = q.id)) AS unlogged
           FROM ops WHERE kind = 'melt'`,
        [unit],
      ),
      db.query<Record<string, unknown>>(
        `WITH ops AS (${o})
         SELECT operation_id, to_timestamp(t) AS completed_at, total_redeemed AS inputs, payment_amount, payment_fee,
                total_issued AS change, fee_collected AS input_fee,
                (total_redeemed - payment_amount - payment_fee - total_issued - fee_collected) AS margin
           FROM ops
          WHERE kind = 'melt' AND total_redeemed < payment_amount + payment_fee + total_issued + fee_collected
          ORDER BY t DESC LIMIT ${RECORD_LIMIT + 1}`,
        [unit],
      ),
      db.one<{ quotes: number; quotes_amount: number; outputs_amount: number }>(
        `SELECT (SELECT count(*)::int FROM mint_quote q WHERE q.unit = $1 AND q.amount_issued > 0) AS quotes,
                (SELECT coalesce(sum(q.amount_issued), 0)::bigint FROM mint_quote q WHERE q.unit = $1) AS quotes_amount,
                (SELECT coalesce(sum(b.amount), 0)::bigint FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
                  WHERE k.unit = $1 AND b.c IS NOT NULL AND b.operation_kind IN ${MINT_KINDS}) AS outputs_amount`,
        [unit],
      ),
      // Only quotes whose outputs carry the quote id can be compared one by one (a batch mint spreads its outputs over several quotes).
      db.query<Record<string, unknown>>(
        `WITH linked AS (SELECT quote_id, sum(amount)::bigint AS s, count(*)::int AS n FROM blind_signature
                          WHERE c IS NOT NULL AND quote_id IS NOT NULL AND operation_kind = 'mint' GROUP BY quote_id)
         SELECT q.id AS quote, q.amount_paid, q.amount_issued, l.s AS outputs_amount, l.n AS outputs
           FROM mint_quote q JOIN linked l ON l.quote_id = q.id
          WHERE q.unit = $1 AND l.s <> q.amount_issued
          ORDER BY q.created_time DESC LIMIT ${RECORD_LIMIT + 1}`,
        [unit],
      ),
      db.one<{ n: number; amount: number; oldest: Date | null }>(
        `SELECT count(*)::int AS n, coalesce(sum(p.amount), 0)::bigint AS amount, to_timestamp(min(p.created_time)) AS oldest
           FROM proof p JOIN keyset k ON k.id = p.keyset_id
          WHERE k.unit = $1 AND p.state = 'PENDING' AND p.created_time < ${hour}`,
        [unit],
      ),
      db.query<Record<string, unknown>>(
        `SELECT p.operation_kind AS operation, p.operation_id, p.quote_id, p.keyset_id AS keyset, count(*)::int AS proofs,
                coalesce(sum(p.amount), 0)::bigint AS amount, to_timestamp(min(p.created_time)) AS oldest
           FROM proof p JOIN keyset k ON k.id = p.keyset_id
          WHERE k.unit = $1 AND p.state = 'PENDING' AND p.created_time < ${hour}
          GROUP BY 1, 2, 3, 4 ORDER BY oldest LIMIT ${RECORD_LIMIT + 1}`,
        [unit],
      ),
      db.one<{ n: number; amount: number; oldest: Date | null }>(
        `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::bigint AS amount, to_timestamp(min(created_time)) AS oldest
           FROM melt_quote WHERE unit = $1 AND state = 'PENDING' AND created_time < ${hour}`,
        [unit],
      ),
      db.query<Record<string, unknown>>(
        `SELECT q.id AS quote, q.request_lookup_id AS payment_lookup_id, q.amount, q.fee_reserve, to_timestamp(q.created_time) AS created_at,
                (SELECT count(*) FROM proof p WHERE p.quote_id = q.id AND p.state = 'PENDING')::int AS pending_proofs
           FROM melt_quote q
          WHERE q.unit = $1 AND q.state = 'PENDING' AND q.created_time < ${hour}
          ORDER BY q.created_time LIMIT ${RECORD_LIMIT + 1}`,
        [unit],
      ),
      hasSagas
        ? db.one<{ n: number; oldest: Date | null }>(
            `SELECT count(*)::int AS n, to_timestamp(min(updated_at)) AS oldest FROM saga_state WHERE updated_at < ${hour}`,
          )
        : Promise.resolve({ n: 0, oldest: null }),
      hasSagas
        ? db.query<Record<string, unknown>>(
            `SELECT operation_id, operation_kind AS operation, state, quote_id, to_timestamp(created_at) AS started_at,
                    to_timestamp(updated_at) AS last_step_at
               FROM saga_state WHERE updated_at < ${hour} ORDER BY updated_at LIMIT ${RECORD_LIMIT + 1}`,
          )
        : Promise.resolve([]),
      db.one<{ n: number; amount: number }>(
        `SELECT count(*)::int AS n, coalesce(sum(amount_paid - amount_issued), 0)::bigint AS amount
           FROM mint_quote WHERE unit = $1 AND amount_paid > amount_issued`,
        [unit],
      ),
      db.query<Record<string, unknown>>(
        `SELECT q.id AS quote, q.amount_paid, q.amount_issued,
                ${hasPayments ? "to_timestamp((SELECT max(timestamp) FROM mint_quote_payments p WHERE p.quote_id = q.id))" : "NULL::timestamptz"} AS paid_at
           FROM mint_quote q WHERE q.unit = $1 AND q.amount_paid > q.amount_issued
          ORDER BY q.created_time DESC LIMIT ${RECORD_LIMIT + 1}`,
        [unit],
      ),
      db.one<{ outputs: number; inputs: number }>(
        `SELECT (SELECT count(*)::int FROM blind_signature b WHERE NOT EXISTS (SELECT 1 FROM keyset k WHERE k.id = b.keyset_id)) AS outputs,
                (SELECT count(*)::int FROM proof p WHERE NOT EXISTS (SELECT 1 FROM keyset k WHERE k.id = p.keyset_id)) AS inputs`,
      ),
      db.query<Record<string, unknown>>(
        `SELECT * FROM (
           SELECT 'blind_signature'::text AS "table", b.keyset_id AS keyset, count(*)::int AS rows, coalesce(sum(amount), 0)::bigint AS amount
             FROM blind_signature b WHERE NOT EXISTS (SELECT 1 FROM keyset k WHERE k.id = b.keyset_id) GROUP BY b.keyset_id
           UNION ALL
           SELECT 'proof', p.keyset_id, count(*)::int, coalesce(sum(amount), 0)::bigint
             FROM proof p WHERE NOT EXISTS (SELECT 1 FROM keyset k WHERE k.id = p.keyset_id) GROUP BY p.keyset_id
         ) x LIMIT ${RECORD_LIMIT + 1}`,
      ),
      db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
          WHERE k.unit = $1 AND b.c IS NULL AND b.created_time < ${hour}`,
        [unit],
      ),
      db.query<Record<string, unknown>>(
        `SELECT b.operation_kind AS operation, b.operation_id, b.quote_id, b.keyset_id AS keyset, count(*)::int AS outputs,
                coalesce(sum(b.amount), 0)::bigint AS amount, to_timestamp(min(b.created_time)) AS oldest
           FROM blind_signature b JOIN keyset k ON k.id = b.keyset_id
          WHERE k.unit = $1 AND b.c IS NULL AND b.created_time < ${hour}
          GROUP BY 1, 2, 3, 4 ORDER BY oldest DESC LIMIT ${RECORD_LIMIT + 1}`,
        [unit],
      ),
    ]);

    // 1. the mint's running totals vs the ledger
    const unitKeysets = ks.filter((k) => k.unit === unit);
    if (!hasAmounts) {
      checks.push({
        id: "keyset_balance",
        title: "Keyset totals match the ledger",
        status: "skip",
        summary: "keyset_amounts is not readable (older CDK schema, or the role lacks SELECT on it).",
      });
    } else {
      const mismatched = unitKeysets.filter((k) => k.balanceMatches === false);
      checks.push({
        id: "keyset_balance",
        title: "Keyset totals match the ledger",
        status: mismatched.length ? "fail" : "ok",
        summary: mismatched.length
          ? `${mismatched.length} of ${unitKeysets.length} keysets: keyset_amounts differs from signed outputs - spent inputs`
          : `all ${unitKeysets.length} keysets: keyset_amounts = signed outputs - spent inputs`,
        records: mismatched.length
          ? mismatched.map((k) => ({
              keyset: k.id,
              active: k.active,
              totals_balance: (k.balance ?? 0) + k.pending,
              issued: k.issued,
              redeemed: k.redeemed,
              ledger_balance: k.issued - k.redeemed,
              diff: (k.balance ?? 0) - k.computedBalance,
            }))
          : undefined,
        remedy: mismatched.length
          ? "keyset_amounts holds running totals the mint updates each time it signs an output or marks an input spent; " +
            "the rows in blind_signature and proof are the truth. The totals are bookkeeping for reporting, so a difference " +
            "does not change what anyone can spend, but it means some write did not go through as a whole, which is worth a " +
            "bug report to the CDK project with the mint's log from that time. " +
            HANDS_OFF
          : undefined,
      });
    }

    // 2. backend reserve
    checks.push({
      id: "backend_reserve",
      title: "Lightning backend covers outstanding ecash",
      status: "skip",
      summary: "CDK does not record the balance of its Lightning backend, so this cannot be checked from the database.",
      remedy:
        "Compare the outstanding ecash shown at the top with the spendable balance of the Lightning node yourself. " +
        "If the node backs more than one mint, add their outstanding amounts together first.",
    });

    // 3. the operations log vs outputs and inputs
    {
      const v = opsVsLedger;
      const issuedDiff = v.log_issued - v.led_issued;
      const redeemedDiff = v.log_redeemed - v.led_redeemed;
      const ok = issuedDiff === 0 && redeemedDiff === 0 && v.unlogged_outputs === 0;
      checks.push({
        id: "operations_vs_ledger",
        title: "Operations log matches outputs and inputs",
        status: ok ? "ok" : "warn",
        summary: ok
          ? `finished operations account for every signed output: issued ${v.log_issued} ${unit}, redeemed ${v.log_redeemed} ${unit}`
          : `operations log says issued ${v.log_issued} / redeemed ${v.log_redeemed} ${unit}, their outputs and inputs add up to ` +
            `${v.led_issued} / ${v.led_redeemed} ${unit}; ${v.unlogged_outputs} signed outputs belong to no finished operation`,
        details: ok ? undefined : v,
        remedy: ok
          ? undefined
          : "Activity, fees and swap counts on this page come from completed_operations, the outstanding amount from the " +
            "outputs and inputs themselves. When the two disagree the outstanding amount is the one to trust. Signed outputs " +
            "without a finished operation appear in a database that was imported from another mint (a migrated Nutshell " +
            "ledger has no operations log), or when an operation was cut off between signing and being recorded.",
      });
    }

    // 4. issued quotes vs signed mint outputs
    {
      const m = mintTotals;
      const diff = m.quotes_amount - m.outputs_amount;
      const { records, truncated } = take(mintMismatchRows);
      checks.push({
        id: "mint_quotes_vs_promises",
        title: "Issued mint quotes equal signed mint outputs",
        status: diff === 0 && records.length === 0 ? "ok" : "warn",
        summary:
          diff === 0 && records.length === 0
            ? `${m.quotes} issued quotes, ${m.quotes_amount} ${unit} on both sides.`
            : `quotes say ${m.quotes_amount} ${unit} was issued, mint outputs add up to ${m.outputs_amount} ${unit}` +
              (records.length ? `; ${records.length}${truncated ? "+" : ""} quotes differ from their own outputs` : ""),
        details: m,
        records: records.length ? records : undefined,
        truncated,
        remedy:
          "For every mint the outputs signed should add up to the amount recorded as issued on the quote. More signed than " +
          "recorded means ecash left the mint without a matching payment and needs investigating; less usually means outputs " +
          "that were stored for a mint which then failed. The signed outputs are what circulates, the quote is bookkeeping.",
      });
    }

    // 5. melt accounting
    if (meltTotals.n === 0) {
      checks.push({
        id: "melt_accounting",
        title: "Melt inputs cover payments and change",
        status: meltTotals.unlogged > 0 ? "info" : "skip",
        summary:
          meltTotals.unlogged > 0
            ? `${meltTotals.unlogged} paid melt quotes have no finished operation to reconcile (imported history).`
            : "no paid melts yet.",
      });
    } else {
      const margin = meltTotals.inputs - meltTotals.paid - meltTotals.change - meltTotals.fees;
      const { records, truncated } = take(meltShortRows);
      const unlogged = meltTotals.unlogged > 0 ? ` ${meltTotals.unlogged} paid melt quotes have no finished operation and are not included.` : "";
      checks.push({
        id: "melt_accounting",
        title: "Melt inputs cover payments and change",
        status: meltTotals.short > 0 ? "fail" : "ok",
        summary:
          meltTotals.short > 0
            ? `${meltTotals.short} of ${meltTotals.n} melts paid out more than their inputs were worth.${unlogged}`
            : `${meltTotals.n} melts: inputs ${meltTotals.inputs} = payments+LN fees ${meltTotals.paid} + change ${meltTotals.change} + input fees ${meltTotals.fees}` +
              `${margin > 0 ? ` + ${margin} kept (change the wallet did not ask for)` : ""} ${unit}.${unlogged}`,
        details: { ...meltTotals, kept: margin },
        records: records.length ? records : undefined,
        truncated,
        remedy:
          meltTotals.short > 0
            ? "For these melts the payment, its Lightning fee, the change and the input fee together exceed the inputs. " +
              "That is a real loss, not bookkeeping: look the payments up on the Lightning node and report it to the CDK project."
            : undefined,
      });
    }

    // 6. stale pending inputs
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
            ? "Pending proofs are inputs reserved by an operation that has not finished; the wallet cannot use them meanwhile. " +
              "Inputs of a melt are released or spent together with it (see the stuck melts check). For a swap, an unfinished " +
              "operation is rolled back when the mint starts, so restarting cdk-mintd is the first thing to try. " +
              HANDS_OFF
            : undefined,
      });
    }

    // 7. stale pending melts
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
            ? "A pending melt is an outgoing payment whose outcome the mint does not know yet; its inputs stay reserved until it " +
              "does. On startup cdk-mintd asks the payment backend about every pending melt and settles or releases it, so restart " +
              "the mint first. If the quote stays pending, look the payment up on the Lightning node by the lookup id shown here: " +
              "the node, not the database, decides whether the money left. " +
              HANDS_OFF
            : undefined,
      });
    }

    // 8. unfinished operations
    if (!hasSagas) {
      checks.push({
        id: "stuck_operations",
        title: "No operation left unfinished",
        status: "skip",
        summary: "saga_state is not readable (older CDK schema, or the role lacks SELECT on it).",
      });
    } else {
      const { records, truncated } = take(sagaRows);
      checks.push({
        id: "stuck_operations",
        title: "No operation left unfinished",
        status: sagas.n > 0 ? "warn" : "ok",
        summary:
          sagas.n > 0
            ? `${sagas.n} operations started but not finished for more than 1 hour, oldest step ${sagas.oldest?.toISOString()}`
            : "no swap or melt is waiting to be finished",
        records: records.length ? records : undefined,
        truncated,
        remedy:
          sagas.n > 0
            ? "CDK writes a row to saga_state when a swap or melt starts and removes it when the operation completes or is " +
              "rolled back. A row that stays means the mint stopped in the middle, or a melt is still waiting for its payment. " +
              "The mint resumes or undoes these when it starts, so a restart normally clears them. " +
              HANDS_OFF
            : undefined,
      });
    }

    // 9. paid but not issued
    {
      const { records, truncated } = take(paidNotIssuedRows);
      checks.push({
        id: "paid_not_issued",
        title: "Paid mint quotes awaiting issuance",
        status: "info",
        summary:
          paidNotIssued.n > 0
            ? `${paidNotIssued.n} quotes with ${paidNotIssued.amount} ${unit} paid that has not been claimed as ecash yet`
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

    // 10. orphans (global, not unit specific)
    {
      const { records, truncated } = take(orphanRows);
      const n = orphans.outputs + orphans.inputs;
      checks.push({
        id: "orphan_rows",
        title: "Every output and input references a known keyset",
        status: n > 0 ? "fail" : "ok",
        summary:
          n > 0
            ? `${orphans.outputs} outputs and ${orphans.inputs} inputs reference keysets that do not exist`
            : "no orphaned rows (checked across all units)",
        details: n > 0 ? orphans : undefined,
        records: records.length ? records : undefined,
        truncated,
        remedy:
          n > 0
            ? "Rows that point at a keyset id missing from the keyset table are invisible to every per-unit figure here, and the " +
              "mint can neither verify nor sign for them. That only happens when a keyset row was removed or an import left rows " +
              "behind; restore the keyset row from a backup rather than deleting the ledger rows."
            : undefined,
      });
    }

    // 11. unsigned outputs
    {
      const { records, truncated } = take(unsignedRows);
      checks.push({
        id: "unsigned_outputs",
        title: "No stale unsigned outputs",
        status: unsignedOld.n > 0 ? "warn" : "ok",
        summary:
          unsignedOld.n > 0
            ? `${unsignedOld.n} blinded messages older than 1 hour were stored but never signed`
            : "no stale unsigned blinded messages",
        records: records.length ? records : undefined,
        truncated,
        remedy:
          unsignedOld.n > 0
            ? "The mint stores a wallet's outputs before it signs them and removes the unsigned ones when the operation ends. " +
              "Old unsigned rows belong to an operation that never finished: with a pending melt they are its change outputs " +
              "and will be signed or removed with it, otherwise see the unfinished operations check. They carry no value."
            : undefined,
      });
    }

    return checks;
  }

  return {
    kind: "cdk",
    features: { balanceLog: false, exactSwaps: true, localTimestamps: false },
    listUnits,
    timeZoneSanity: () => Promise.resolve(null),
    overview,
    timeseries,
    keysets,
    denominations,
    balanceLog: () => Promise.resolve([]),
    fees,
    publicFees,
    hourly,
    recentActivity,
    audit,
  };
}
