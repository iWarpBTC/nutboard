/*
 * Shapes and small helpers shared by every mint dialect. The HTTP API returns exactly these types,
 * so the frontend does not care whether the numbers came from a Nutshell or a CDK database.
 */

import type { MintKind } from "../db.ts";

// ---------- windows ----------

export const WINDOWS = [
  { key: "h24", label: "24 hours", interval: "24 hours" },
  { key: "d7", label: "7 days", interval: "7 days" },
  { key: "d30", label: "30 days", interval: "30 days" },
  { key: "all", label: "all time", interval: null },
] as const;
export type WindowKey = (typeof WINDOWS)[number]["key"];

export type WindowTable = Record<WindowKey, Record<string, number>>;

export function unpack(row: Record<string, number>): WindowTable {
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

export function msOf(interval: string): number {
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

export interface DenominationRow {
  amount: number;
  issued: number;
  spent: number;
  pending: number;
  outstanding: number;
}

export interface HourRow {
  hour: number;
  mints: number;
  melts: number;
  swaps: number;
}

export interface ActivityRow {
  kind: "mint" | "melt" | "swap";
  at: Date;
  amount: number;
  fee: number | null;
  inputs: number | null;
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

// ---------- time series assembly ----------

export interface BucketRow {
  bucket: Date;
  count: number;
  amount: number;
  fee?: number;
}

/** Puts any number of named series on one common axis and fills quiet periods with zeros. */
export function alignSeries<K extends string>(
  range: RangeKey,
  series: Record<K, BucketRow[]>,
): { bin: string | null; buckets: string[]; series: Record<K, SeriesPoint[]> } {
  const r = RANGES[range];
  const toKey = (d: Date) => d.toISOString();
  const names = Object.keys(series) as K[];
  const keys = new Set<string>();
  for (const name of names) for (const row of series[name]) keys.add(toKey(row.bucket));
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
  const align = (rows: BucketRow[]): SeriesPoint[] => {
    const map = new Map(rows.map((row) => [toKey(row.bucket), row]));
    return buckets.map((b) => {
      const row = map.get(b);
      const point: SeriesPoint = { bucket: b, count: row?.count ?? 0, amount: row?.amount ?? 0 };
      if (row && row.fee !== undefined) point.fee = row.fee;
      return point;
    });
  };
  const aligned = {} as Record<K, SeriesPoint[]>;
  for (const name of names) aligned[name] = align(series[name]);
  return { bin: r.bin, buckets, series: aligned };
}

/** The mint, melt and swap series of one unit on a common axis. */
export function assembleTimeseries(
  unit: string,
  range: RangeKey,
  mint: BucketRow[],
  melt: BucketRow[],
  swap: BucketRow[],
): Timeseries {
  const a = alignSeries(range, { mint, melt, swap });
  return { unit, range, bin: a.bin, buckets: a.buckets, ...a.series };
}

// ---------- dialects ----------

export type { MintKind } from "../db.ts";

/** What a dialect can offer; the frontend hides or rewords what is missing. */
export interface Features {
  /** the mint records its Lightning backend balance (Nutshell's balance_log) */
  balanceLog: boolean;
  /** swaps are recorded as operations instead of being estimated from outputs stored in the same second */
  exactSwaps: boolean;
  /** timestamps are naive mint-local time, so MINT_TZ has to match the mint host */
  localTimestamps: boolean;
}

/** One implementation per supported mint software. Every method runs plain SELECTs and nothing else. */
export interface MintStats {
  readonly kind: MintKind;
  readonly features: Features;
  listUnits(): Promise<string[]>;
  /** null when the mint stores absolute timestamps and no zone can be misconfigured */
  timeZoneSanity(): Promise<TimeZoneSanity | null>;
  overview(unit: string): Promise<Overview>;
  timeseries(unit: string, range: RangeKey): Promise<Timeseries>;
  keysets(): Promise<KeysetRow[]>;
  denominations(unit: string): Promise<DenominationRow[]>;
  balanceLog(unit: string, range: RangeKey): Promise<BalanceLogRow[]>;
  fees(unit: string, range: RangeKey): Promise<FeeStats>;
  publicFees(unit: string): Promise<PublicFees>;
  hourly(unit: string): Promise<HourRow[]>;
  recentActivity(unit: string, limit: number): Promise<ActivityRow[]>;
  audit(unit: string): Promise<AuditCheck[]>;
}
