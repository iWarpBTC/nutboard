/*
 * Builds a LOCAL fixture database that looks like a busy Nutshell mint, so nutboard can be
 * developed and demoed without touching a real mint.
 *
 * This script WRITES to the database it is pointed at. It refuses to run unless the database
 * name contains "dev", "test" or "fixture", and it recreates all mint tables from scratch.
 *
 *   createdb nutboard_dev
 *   DEV_DATABASE_URL=postgres://localhost:5432/nutboard_dev npm run seed:dev
 *
 * Timestamps are written as UTC, so run nutboard against it with MINT_TZ=UTC (the default).
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DEV_DATABASE_URL;
if (!url) {
  console.error("DEV_DATABASE_URL is required (e.g. postgres://localhost:5432/nutboard_dev)");
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
const ts = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");
const addSec = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);

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
  version: string;
  feePpk: number;
  firstSeen: Date;
  issued: number;
  redeemed: number;
  pending: number;
  fees: number;
}
const now = new Date();
const start = new Date(now.getTime() - DAYS * 86_400_000);
const dayMs = 86_400_000;
const satSwitch = new Date(start.getTime() + Math.floor(DAYS * 0.25) * dayMs);
// Rows before this date mimic a database older than Nutshell migration 17: no quote links on outputs and spent proofs.
const legacyUntil = new Date(start.getTime() + Math.floor(DAYS * 0.15) * dayMs);
const usdStart = new Date(start.getTime() + Math.floor(DAYS * 0.5) * dayMs);

const keysets: Keyset[] = [
  { id: "00ad268c4d1f5826", unit: "sat", active: false, version: "0.16.5", feePpk: 0, firstSeen: new Date(start.getTime() - 60 * dayMs), issued: 0, redeemed: 0, pending: 0, fees: 0 },
  { id: "009a1f293253e41e", unit: "sat", active: true, version: "0.18.0", feePpk: 100, firstSeen: satSwitch, issued: 0, redeemed: 0, pending: 0, fees: 0 },
  { id: "00c074b96c7e2b0d", unit: "usd", active: true, version: "0.18.0", feePpk: 0, firstSeen: usdStart, issued: 0, redeemed: 0, pending: 0, fees: 0 },
];
const outstanding = (k: Keyset) => k.issued - k.redeemed - k.pending;
function activeKeyset(unit: string, t: Date): Keyset | null {
  if (unit === "sat") return t < satSwitch ? keysets[0] : keysets[1];
  return t >= usdStart ? keysets[2] : null;
}
/** Keyset to spend from: mostly the active one, but old keysets get drained over time. */
function spendKeyset(unit: string, t: Date, amount: number): Keyset | null {
  const candidates = keysets.filter((k) => k.unit === unit && k.firstSeen <= t && outstanding(k) >= amount);
  if (!candidates.length) return null;
  const active = activeKeyset(unit, t);
  const old = candidates.filter((k) => k !== active);
  if (old.length && rand() < 0.35) return old[0];
  return candidates.includes(active as Keyset) ? (active as Keyset) : candidates[0];
}

type Row = Array<string | number | boolean | null>;
const mintQuotes: Row[] = [];
const meltQuotes: Row[] = [];
const promises: Row[] = [];
const proofsUsed: Row[] = [];
const proofsPending: Row[] = [];
const balanceLog: Row[] = [];

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
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

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

function addPromises(keyset: Keyset, amounts: number[], created: Date, signedAt: Date | null, link: { mint?: string; melt?: string }): void {
  amounts.forEach((amount, i) => {
    promises.push([
      amount, keyset.id, "02" + hex(32), signedAt ? "02" + hex(32) : null, ts(created),
      link.mint ?? null, null, link.melt ?? null, signedAt ? ts(signedAt) : null, i,
    ]);
    if (signedAt) hold(keyset, amount, 1);
  });
}
function addProofs(target: Row[], keyset: Keyset, amounts: number[], created: Date, melt: string | null): void {
  for (const amount of amounts) {
    target.push([amount, keyset.id, "02" + hex(32), hex(32), "02" + hex(32), null, ts(created), melt]);
  }
}
function inputFee(k: Keyset, n: number): number {
  return Math.ceil((n * k.feePpk) / 1000);
}

function simulateMint(unit: string, t: Date): void {
  const amount = weighted(unit === "sat" ? MINT_AMOUNTS : USD_AMOUNTS);
  const ageMs = now.getTime() - t.getTime();
  let state = weighted<string>([["ISSUED", 76], ["UNPAID", 17], ["PAID", 5], ["PENDING", 2]]);
  if (state === "PENDING" && ageMs > dayMs) state = "ISSUED";
  const quote = crypto.randomUUID();
  const paidAt = state === "UNPAID" ? null : addSec(t, randInt(5, 900));
  const issuedAt = state === "ISSUED" && paidAt ? addSec(paidAt, randInt(1, 600)) : null;
  mintQuotes.push([
    quote, "bolt11", `lnbc${amount}n1${hex(40)}`, hex(32), unit, amount, ts(t),
    paidAt ? ts(paidAt) : null, state, null, issuedAt ? ts(issuedAt) : null, paidAt ? ts(paidAt) : null,
    paidAt ? amount : null, issuedAt ? amount : null, ts(issuedAt ?? paidAt ?? t),
  ]);
  if (issuedAt) {
    const k = activeKeyset(unit, issuedAt);
    if (!k) return;
    addPromises(k, decompose(amount), issuedAt, issuedAt, issuedAt < legacyUntil ? {} : { mint: quote });
    k.issued += amount;
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
  addProofs(proofsUsed, from, inputs, t, null);
  addPromises(to, splitRandom(outAmount, randInt(0, 2)), t, t, {});
  from.redeemed += inSum;
  from.fees += fee;
  to.issued += outAmount;
}

let stuckMeltPlanted = false;
function simulateMelt(unit: string, t: Date): void {
  const amount = weighted(unit === "sat" ? MINT_AMOUNTS : USD_AMOUNTS);
  const feeReserve = Math.max(2, Math.ceil(amount * 0.01));
  const ageMs = now.getTime() - t.getTime();
  let state = weighted<string>([["PAID", 87], ["UNPAID", 10], ["PENDING", 3]]);
  if (state === "PENDING" && ageMs > 2 * 3_600_000) state = "UNPAID";
  // one deliberately stuck melt (a few days old) so the audit warning has something to show
  if (!stuckMeltPlanted && ageMs > 4 * 3_600_000 && ageMs < 3 * dayMs) state = "PENDING";
  const quote = crypto.randomUUID();
  const paidAt = state === "PAID" ? addSec(t, randInt(2, 60)) : null;
  const expiry = addSec(t, 900);
  let feePaid: number | null = null;
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
      if (state === "PAID" && paidAt) {
        feePaid = Math.floor(feeReserve * rand() * rand());
        proof = hex(32);
        const legacy = t < legacyUntil;
        addProofs(proofsUsed, from, inputs, paidAt, legacy ? null : quote);
        from.redeemed += inSum;
        from.fees += fee;
        const change = inSum - amount - feePaid - fee;
        if (change > 0) {
          addPromises(to, decompose(change), t, paidAt, legacy ? {} : { melt: quote });
          to.issued += change;
        }
        // blank change outputs the wallet sent but the mint did not need stay unsigned
        const blanks = randInt(0, 2);
        if (blanks) addPromises(to, Array(blanks).fill(1), t, null, { melt: quote });
      } else {
        if (ageMs > 2 * 3_600_000) stuckMeltPlanted = true;
        addProofs(proofsPending, from, inputs, t, quote);
        from.pending += inSum;
        addPromises(to, Array(Math.max(1, decompose(feeReserve).length)).fill(1), t, null, { melt: quote });
      }
    }
  }
  meltQuotes.push([
    quote, "bolt11", `lnbc${amount}n1${hex(40)}`, hex(32), unit, amount, feeReserve, ts(t),
    paidAt ? ts(paidAt) : null, feePaid, proof, state, ts(expiry), "",
  ]);
}

// ---------- simulate ----------
console.log(`simulating ${DAYS} days of mint activity (seed ${SEED})`);
let reserveDrift = 0;
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
  // daily balance log per unit
  const logAt = new Date(Math.min(dayStart.getTime() + dayMs - 1, now.getTime()));
  reserveDrift += randInt(-1500, 2500);
  for (const unit of ["sat", "usd"]) {
    const ks = keysets.filter((k) => k.unit === unit && k.firstSeen <= logAt);
    if (!ks.length) continue;
    const bal = ks.reduce((s, k) => s + outstanding(k), 0);
    const fees = ks.reduce((s, k) => s + k.fees, 0);
    const reserve = unit === "sat" ? 150_000 + reserveDrift : 20_000 + Math.floor(reserveDrift / 10);
    balanceLog.push([unit, bal, fees, Math.max(0, bal + fees + reserve), ts(logAt)]);
  }
}

console.log(
  `generated: ${mintQuotes.length} mint quotes, ${meltQuotes.length} melt quotes, ` +
    `${promises.length} promises, ${proofsUsed.length} spent proofs, ${proofsPending.length} pending proofs`,
);

// ---------- write ----------
const schemaSql = readFileSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "dev-schema.sql"), "utf8");
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
    "keysets",
    ["id", "derivation_path", "seed", "valid_from", "valid_to", "first_seen", "active", "version", "unit", "encrypted_seed", "seed_encryption_method", "input_fee_ppk", "amounts", "balance", "fees_paid", "final_expiry"],
    keysets.map((k, i) => [
      k.id, `m/0'/${k.unit === "sat" ? 0 : 2}'/${i}'`, "", ts(k.firstSeen), ts(k.firstSeen), ts(k.firstSeen), k.active, k.version, k.unit,
      "dev-fixture-not-a-real-seed", "aes", k.feePpk, JSON.stringify(Array.from({ length: 32 }, (_, b) => 2 ** b)),
      outstanding(k), k.fees, null,
    ]),
  );
  await insertBatch(
    "mint_quotes",
    ["quote", "method", "request", "checking_id", "unit", "amount", "created_time", "paid_time", "state", "pubkey", "issued_time", "last_checked", "amount_paid", "amount_issued", "updated_at"],
    mintQuotes,
  );
  await insertBatch(
    "melt_quotes",
    ["quote", "method", "request", "checking_id", "unit", "amount", "fee_reserve", "created_time", "paid_time", "fee_paid", "proof", "state", "expiry", "attempt"],
    meltQuotes,
  );
  await insertBatch("promises", ["amount", "id", "b_", "c_", "created", "mint_quote", "swap_id", "melt_quote", "signed_at", "order_index"], promises);
  await insertBatch("proofs_used", ["amount", "id", "c", "secret", "y", "witness", "created", "melt_quote"], proofsUsed);
  await insertBatch("proofs_pending", ["amount", "id", "c", "secret", "y", "witness", "created", "melt_quote"], proofsPending);
  await insertBatch("balance_log", ["unit", "keyset_balance", "keyset_fees_paid", "backend_balance", "time"], balanceLog);
  await client.query("COMMIT");
  await client.query("ANALYZE");
  for (const k of keysets) {
    console.log(`keyset ${k.id} (${k.unit}${k.active ? ", active" : ""}): balance ${outstanding(k)}, fees ${k.fees}`);
  }
  console.log(`seeded ${dbName}`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
