/*
 * Builds a LOCAL fixture database that looks like a busy CDK mint (cdk-mintd on PostgreSQL), so the
 * CDK dialect of nutboard can be developed and demoed without touching a real mint.
 *
 * This script WRITES to the database it is pointed at. It refuses to run unless the database
 * name contains "dev", "test" or "fixture", and it recreates all mint tables from scratch.
 *
 *   createdb nutboard_cdk_dev
 *   DEV_DATABASE_URL=postgres://localhost:5432/nutboard_cdk_dev npm run seed:dev:cdk
 *
 * The rows follow what cdk v0.18.3 writes: one completed_operations row per finished mint, swap and
 * melt, outputs in blind_signature and inputs in proof tagged with that operation, running totals in
 * keyset_amounts. One melt is left pending for days so the audit has something to show.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DEV_DATABASE_URL;
if (!url) {
  console.error("DEV_DATABASE_URL is required (e.g. postgres://localhost:5432/nutboard_cdk_dev)");
  process.exit(1);
}
const dbName = new URL(url).pathname.slice(1);
if (!/(dev|test|fixture)/i.test(dbName)) {
  console.error(`refusing to seed "${dbName}": the database name must contain dev, test or fixture`);
  process.exit(1);
}

const DAYS = Number(process.env.SEED_DAYS ?? 120);
const SEED = Number(process.env.SEED ?? 42);

// ---------- deterministic randomness ----------
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
function weighted<T>(items: Array<[T, number]>): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}
function poisson(lambda: number): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const point = (): Buffer => Buffer.concat([Buffer.from([2]), randomBytes(32)]);
const epoch = (d: Date): number => Math.floor(d.getTime() / 1000);
const addSec = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

function decompose(amount: number): number[] {
  const out: number[] = [];
  let bit = 1;
  while (amount > 0) {
    if (amount % 2 === 1) out.push(bit);
    amount = Math.floor(amount / 2);
    bit *= 2;
  }
  return out;
}
/** Binary decomposition with a few extra splits, like a wallet holding smaller notes. */
function splitRandom(amount: number, extraSplits: number): number[] {
  const parts = decompose(amount);
  for (let i = 0; i < extraSplits; i++) {
    const idx = parts.findIndex((p) => p > 1);
    if (idx < 0) break;
    const p = parts.splice(idx, 1)[0];
    parts.push(p / 2, p / 2);
  }
  return parts.sort((a, b) => b - a);
}

// ---------- model ----------
interface Keyset {
  id: string;
  unit: string;
  active: boolean;
  feePpk: number;
  validFrom: Date;
  issued: number;
  redeemed: number;
  pending: number;
  fees: number;
}
const now = new Date();
const dayMs = 86_400_000;
const start = new Date(now.getTime() - DAYS * dayMs);
const satSwitch = new Date(start.getTime() + Math.floor(DAYS * 0.25) * dayMs);
const usdStart = new Date(start.getTime() + Math.floor(DAYS * 0.5) * dayMs);

const keysets: Keyset[] = [
  { id: "00ad268c4d1f5826", unit: "sat", active: false, feePpk: 0, validFrom: new Date(start.getTime() - 60 * dayMs), issued: 0, redeemed: 0, pending: 0, fees: 0 },
  { id: "01" + "9a1f293253e41e".padEnd(64, "5"), unit: "sat", active: true, feePpk: 100, validFrom: satSwitch, issued: 0, redeemed: 0, pending: 0, fees: 0 },
  { id: "01" + "c074b96c7e2b0d".padEnd(64, "7"), unit: "usd", active: true, feePpk: 0, validFrom: usdStart, issued: 0, redeemed: 0, pending: 0, fees: 0 },
];
const outstanding = (k: Keyset) => k.issued - k.redeemed - k.pending;
function activeKeyset(unit: string, t: Date): Keyset | null {
  if (unit === "sat") return t < satSwitch ? keysets[0] : keysets[1];
  return t >= usdStart ? keysets[2] : null;
}
/** Keyset to spend from: mostly the active one, but old keysets get drained over time. */
function spendKeyset(unit: string, t: Date, amount: number): Keyset | null {
  const candidates = keysets.filter((k) => k.unit === unit && k.validFrom <= t && outstanding(k) >= amount);
  if (!candidates.length) return null;
  const active = activeKeyset(unit, t);
  const old = candidates.filter((k) => k !== active);
  if (old.length && rand() < 0.35) return old[0];
  return candidates.includes(active as Keyset) ? (active as Keyset) : candidates[0];
}

type Row = Array<string | number | boolean | Buffer | null>;
const mintQuotes: Row[] = [];
const mintPayments: Row[] = [];
const mintIssued: Row[] = [];
const meltQuotes: Row[] = [];
const meltRequests: Row[] = [];
const signatures: Row[] = [];
const proofs: Row[] = [];
const operations: Row[] = [];
const sagas: Row[] = [];

const MINT_AMOUNTS: Array<[number, number]> = [
  [21, 5], [50, 4], [100, 10], [210, 6], [500, 8], [1000, 12], [2100, 8], [5000, 7],
  [10000, 6], [21000, 4], [50000, 2], [100000, 1], [250000, 0.3],
];
const USD_AMOUNTS: Array<[number, number]> = [[100, 6], [250, 5], [500, 8], [1000, 7], [2500, 4], [5000, 2], [10000, 1]];
const HOUR_WEIGHTS = Array.from({ length: 24 }, (_, h) => 1 + 3 * Math.exp(-(((h - 20) / 4) ** 2)) + 1.5 * Math.exp(-(((h - 12) / 3) ** 2)));
function randomTimeInDay(dayStart: Date): Date {
  const hour = weighted(HOUR_WEIGHTS.map((w, h) => [h, w] as [number, number]));
  return new Date(dayStart.getTime() + hour * 3_600_000 + randInt(0, 3599) * 1000);
}

/** Notes in circulation per keyset (amount -> count). Spending draws from here so the fixture ledger is consistent. */
const holdings = new Map<string, Map<number, number>>();
function hold(k: Keyset, amount: number, delta: number): void {
  let m = holdings.get(k.id);
  if (!m) {
    m = new Map();
    holdings.set(k.id, m);
  }
  m.set(amount, (m.get(amount) ?? 0) + delta);
}

/** Wallet-style proof selection: picks notes until their sum covers the target, or null if it cannot. */
function selectProofs(k: Keyset, target: number): number[] | null {
  const m = holdings.get(k.id);
  if (!m) return null;
  const avail = new Map([...m].filter(([, n]) => n > 0));
  const denoms = [...avail.keys()].sort((a, b) => b - a);
  const picked: number[] = [];
  let total = 0;
  for (const d of denoms) {
    let n = avail.get(d) ?? 0;
    while (n > 0 && total + d <= target && rand() < 0.85) {
      picked.push(d);
      total += d;
      n--;
    }
    avail.set(d, n);
  }
  if (total < target) {
    const remainder = target - total;
    const cover = denoms.filter((d) => (avail.get(d) ?? 0) > 0 && d >= remainder).sort((a, b) => a - b)[0];
    if (cover !== undefined) {
      picked.push(cover);
      total += cover;
    } else {
      for (const d of denoms) {
        let n = avail.get(d) ?? 0;
        while (n > 0 && total < target) {
          picked.push(d);
          total += d;
          n--;
        }
      }
      if (total < target) return null;
    }
  }
  for (const d of picked) hold(k, d, -1);
  return picked.sort((a, b) => b - a);
}
function returnProofs(k: Keyset, amounts: number[]): void {
  for (const d of amounts) hold(k, d, 1);
}
function inputFee(k: Keyset, n: number): number {
  return Math.ceil((n * k.feePpk) / 1000);
}

interface Op {
  id: string;
  kind: "mint" | "batch_mint" | "swap" | "melt";
}
const newOp = (kind: Op["kind"]): Op => ({ id: crypto.randomUUID(), kind });

/** Outputs: stored as blinded messages when the operation starts, signed (c set) when it finishes. */
function addOutputs(k: Keyset, amounts: number[], op: Op, quote: string | null, created: Date, signedAt: Date | null): void {
  amounts.forEach((amount, i) => {
    signatures.push([
      point(), amount, k.id, signedAt ? point() : null, quote, epoch(created), signedAt ? epoch(signedAt) : null, op.kind, op.id, i,
    ]);
    if (signedAt) hold(k, amount, 1);
  });
}
function addInputs(k: Keyset, amounts: number[], op: Op, quote: string | null, created: Date, state: "SPENT" | "PENDING"): void {
  for (const amount of amounts) {
    proofs.push([point(), amount, k.id, hex(32), point(), state, quote, epoch(created), op.kind, op.id]);
  }
}
function complete(op: Op, at: Date, issued: number, redeemed: number, fee: number, payment: { amount: number; fee: number } | null): void {
  operations.push([
    op.id, op.kind, epoch(at), issued, redeemed, fee, payment?.amount ?? null, payment?.fee ?? null, op.kind === "swap" ? null : "bolt11",
  ]);
}

function simulateMint(unit: string, t: Date): void {
  const amount = weighted(unit === "sat" ? MINT_AMOUNTS : USD_AMOUNTS);
  const state = weighted<string>([["ISSUED", 78], ["UNPAID", 17], ["PAID", 5]]);
  const quote = crypto.randomUUID();
  const lookup = hex(32);
  const paidAt = state === "UNPAID" ? null : addSec(t, randInt(5, 900));
  const issuedAt = state === "ISSUED" && paidAt ? addSec(paidAt, randInt(1, 600)) : null;
  const k = issuedAt ? activeKeyset(unit, issuedAt) : null;
  const issued = issuedAt && k ? amount : 0;
  mintQuotes.push([
    quote, amount, unit, `lnbc${amount}n1${hex(40)}`, epoch(t) + 3600, lookup, epoch(t), paidAt ? amount : 0, issued,
    "bolt11", "payment_hash", epoch(issuedAt ?? paidAt ?? t), paidAt ? epoch(paidAt) : 0,
  ]);
  if (paidAt) mintPayments.push([quote, lookup, epoch(paidAt), amount]);
  if (issuedAt && k) {
    // A few wallets mint several quotes in one request; cdk then stores the outputs without a quote id.
    const op = newOp(rand() < 0.04 ? "batch_mint" : "mint");
    mintIssued.push([quote, amount, epoch(issuedAt)]);
    addOutputs(k, decompose(amount), op, op.kind === "mint" ? quote : null, issuedAt, issuedAt);
    k.issued += amount;
    complete(op, issuedAt, amount, 0, 0, null);
  }
}

function simulateSwap(unit: string, t: Date): void {
  const target = weighted(unit === "sat" ? MINT_AMOUNTS : USD_AMOUNTS) + randInt(0, 200);
  const from = spendKeyset(unit, t, target);
  const to = activeKeyset(unit, t);
  if (!from || !to) return;
  const inputs = selectProofs(from, target);
  if (!inputs) return;
  const inSum = sum(inputs);
  const fee = inputFee(from, inputs.length);
  const outAmount = inSum - fee;
  if (outAmount <= 0) {
    returnProofs(from, inputs);
    return;
  }
  const op = newOp("swap");
  addInputs(from, inputs, op, null, t, "SPENT");
  addOutputs(to, splitRandom(outAmount, randInt(0, 2)), op, null, t, t);
  from.redeemed += inSum;
  from.fees += fee;
  to.issued += outAmount;
  complete(op, t, outAmount, inSum, fee, null);
}

let stuckMeltPlanted = false;
function simulateMelt(unit: string, t: Date): void {
  const amount = weighted(unit === "sat" ? MINT_AMOUNTS : USD_AMOUNTS);
  const feeReserve = Math.max(2, Math.ceil(amount * 0.01));
  const ageMs = now.getTime() - t.getTime();
  let state = weighted<string>([["PAID", 87], ["UNPAID", 10], ["PENDING", 3]]);
  if (state === "PENDING" && ageMs > 2 * 3_600_000) state = "UNPAID";
  // one deliberately stuck melt (a few days old) so the audit warnings have something to show
  if (!stuckMeltPlanted && ageMs > 4 * 3_600_000 && ageMs < 3 * dayMs) state = "PENDING";
  const quote = crypto.randomUUID();
  const paidAt = state === "PAID" ? addSec(t, randInt(2, 60)) : null;
  let proof: string | null = null;
  if (state !== "UNPAID") {
    const from = spendKeyset(unit, t, amount + feeReserve + 8);
    let inputs: number[] | null = null;
    if (from) {
      // the wallet must also cover input fees, which depend on how many notes it ends up using
      let fee = 0;
      for (let i = 0; i < 4; i++) {
        inputs = selectProofs(from, amount + feeReserve + fee);
        if (!inputs) break;
        const f = inputFee(from, inputs.length);
        if (f <= fee) break;
        returnProofs(from, inputs);
        inputs = null;
        fee = f;
      }
    }
    if (!from || !inputs) {
      state = "UNPAID";
    } else {
      const inSum = sum(inputs);
      const fee = inputFee(from, inputs.length);
      const to = activeKeyset(unit, t) ?? from;
      const op = newOp("melt");
      if (state === "PAID" && paidAt) {
        const feePaid = Math.floor(feeReserve * rand() * rand());
        proof = hex(32);
        addInputs(from, inputs, op, quote, t, "SPENT");
        from.redeemed += inSum;
        from.fees += fee;
        const change = inSum - amount - feePaid - fee;
        // cdk signs the change it owes and deletes the blank outputs it did not need
        if (change > 0) {
          addOutputs(to, decompose(change), op, quote, t, paidAt);
          to.issued += change;
        }
        complete(op, paidAt, Math.max(0, change), inSum, fee, { amount, fee: feePaid });
      } else {
        if (ageMs > 2 * 3_600_000) stuckMeltPlanted = true;
        addInputs(from, inputs, op, quote, t, "PENDING");
        from.pending += inSum;
        addOutputs(to, Array(Math.max(1, decompose(feeReserve).length)).fill(1), op, quote, t, null);
        meltRequests.push([quote, inSum, fee]);
        sagas.push([op.id, "melt", "payment_attempted", quote, epoch(t), epoch(addSec(t, 3))]);
      }
    }
  }
  meltQuotes.push([
    quote, unit, amount, `lnbc${amount}n1${hex(40)}`, feeReserve, epoch(t) + 900, state, proof, hex(32), epoch(t),
    paidAt ? epoch(paidAt) : null, "bolt11", "payment_hash",
  ]);
}

// ---------- simulate ----------
console.log(`simulating ${DAYS} days of CDK mint activity (seed ${SEED})`);
for (let day = 0; day < DAYS; day++) {
  const dayStart = new Date(start.getTime() + day * dayMs);
  const growth = 0.45 + 0.55 * (day / DAYS);
  const weekend = [0, 6].includes(dayStart.getUTCDay()) ? 0.8 : 1;
  const plan: Array<[string, (u: string, t: Date) => void, number]> = [
    ["sat", simulateMint, 26],
    ["sat", simulateSwap, 48],
    ["sat", simulateMelt, 17],
  ];
  if (dayStart >= usdStart) {
    plan.push(["usd", simulateMint, 4], ["usd", simulateSwap, 7], ["usd", simulateMelt, 3]);
  }
  const events: Array<[string, (u: string, t: Date) => void, Date]> = [];
  for (const [unit, fn, rate] of plan) {
    const n = poisson(rate * growth * weekend);
    for (let i = 0; i < n; i++) events.push([unit, fn, randomTimeInDay(dayStart)]);
  }
  events.sort((a, b) => a[2].getTime() - b[2].getTime());
  for (const [unit, fn, t] of events) {
    if (t > now) continue;
    fn(unit, t);
  }
}

console.log(
  `generated: ${mintQuotes.length} mint quotes, ${meltQuotes.length} melt quotes, ${signatures.length} outputs, ` +
    `${proofs.length} inputs, ${operations.length} finished operations, ${sagas.length} unfinished`,
);

// ---------- write ----------
const schemaSql = readFileSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "dev-schema-cdk.sql"), "utf8");
const client = new pg.Client({ connectionString: url });
await client.connect();

async function insertBatch(table: string, columns: string[], rows: Row[]): Promise<void> {
  const chunk = Math.max(1, Math.floor(60_000 / columns.length));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = slice
      .map((row) => `(${row.map((v) => { params.push(v); return `$${params.length}`; }).join(",")})`)
      .join(",");
    await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}`, params);
  }
}

try {
  await client.query("BEGIN");
  await client.query(schemaSql);
  await insertBatch(
    "keyset",
    ["id", "unit", "active", "valid_from", "valid_to", "derivation_path", "input_fee_ppk", "derivation_path_index", "amounts", "issuer_version"],
    keysets.map((k, i) => [
      k.id, k.unit, k.active, epoch(k.validFrom), null, `m/129372'/${k.unit === "sat" ? 0 : 2}'/${i}'`, k.feePpk, i,
      JSON.stringify(Array.from({ length: 32 }, (_, b) => 2 ** b)), "cdk/0.18.3",
    ]),
  );
  await insertBatch(
    "keyset_amounts",
    ["keyset_id", "total_issued", "total_redeemed", "fee_collected"],
    keysets.map((k) => [k.id, k.issued, k.redeemed, k.fees]),
  );
  await insertBatch(
    "mint_quote",
    ["id", "amount", "unit", "request", "expiry", "request_lookup_id", "created_time", "amount_paid", "amount_issued", "payment_method", "request_lookup_id_kind", "updated_at", "last_checked"],
    mintQuotes,
  );
  await insertBatch("mint_quote_payments", ["quote_id", "payment_id", "timestamp", "amount"], mintPayments);
  await insertBatch("mint_quote_issued", ["quote_id", "amount", "timestamp"], mintIssued);
  await insertBatch(
    "melt_quote",
    ["id", "unit", "amount", "request", "fee_reserve", "expiry", "state", "payment_proof", "request_lookup_id", "created_time", "paid_time", "payment_method", "request_lookup_id_kind"],
    meltQuotes,
  );
  await insertBatch("melt_request", ["quote_id", "inputs_amount", "inputs_fee"], meltRequests);
  await insertBatch(
    "blind_signature",
    ["blinded_message", "amount", "keyset_id", "c", "quote_id", "created_time", "signed_time", "operation_kind", "operation_id", "order_index"],
    signatures,
  );
  await insertBatch(
    "proof",
    ["y", "amount", "keyset_id", "secret", "c", "state", "quote_id", "created_time", "operation_kind", "operation_id"],
    proofs,
  );
  await insertBatch(
    "completed_operations",
    ["operation_id", "operation_kind", "completed_at", "total_issued", "total_redeemed", "fee_collected", "payment_amount", "payment_fee", "payment_method"],
    operations,
  );
  await insertBatch("saga_state", ["operation_id", "operation_kind", "state", "quote_id", "created_at", "updated_at"], sagas);
  await client.query("COMMIT");
  await client.query("ANALYZE");
  for (const k of keysets) {
    console.log(`keyset ${k.id.slice(0, 16)} (${k.unit}${k.active ? ", active" : ""}): outstanding ${k.issued - k.redeemed}, pending ${k.pending}, fees ${k.fees}`);
  }
  console.log(`seeded ${dbName}`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
