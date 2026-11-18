/*
 * Builds a LOCAL fixture database that looks like a small LNbits instance, so the LNbits view of nutboard
 * can be developed and demoed without touching a real one.
 *
 * This script WRITES to the database it is pointed at. It refuses to run unless the database
 * name contains "dev", "test" or "fixture", and it recreates the LNbits tables from scratch.
 *
 *   createdb nutboard_lnbits_dev
 *   DEV_DATABASE_URL=postgres://localhost:5432/nutboard_lnbits_dev npm run seed:dev:lnbits
 *
 * Amounts are in millisatoshi as in LNbits; timestamps are written as UTC (LNBITS_TZ=UTC, the default).
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.DEV_DATABASE_URL;
if (!url) {
  console.error("DEV_DATABASE_URL is required (e.g. postgres://localhost:5432/nutboard_lnbits_dev)");
  process.exit(1);
}
const dbName = new URL(url).pathname.slice(1);
if (!/(dev|test|fixture)/i.test(dbName)) {
  console.error(`refusing to seed "${dbName}": the database name must contain dev, test or fixture`);
  process.exit(1);
}

const DAYS = Number(process.env.SEED_DAYS ?? 120);
let seed = Number(process.env.SEED ?? 42);
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const ts = (d: Date): string => d.toISOString().slice(0, 23).replace("T", " ");

type Row = Array<string | number | boolean | null>;
const now = new Date();
const dayMs = 86_400_000;
const start = new Date(now.getTime() - DAYS * dayMs);

// ---------- accounts and wallets ----------
const USERNAMES = ["shop", "donations", "family", null, null, null, null, null, null, null, null, null];
const accounts: Row[] = USERNAMES.map((username) => {
  const created = new Date(start.getTime() - randInt(1, 400) * dayMs);
  return [hex(16), null, username ? "not-a-real-hash" : null, username, null, ts(created), ts(created), null, true];
});
interface Wallet { id: string; balance: number; deleted: boolean }
const WALLET_NAMES = ["LNbits wallet", "Till", "Savings", "Tips", "Boltcard", "Withdraw links", "Shop CZK", "Test"];
const wallets: Wallet[] = [];
const walletRows: Row[] = [];
accounts.forEach((account, i) => {
  const count = i === 0 ? 4 : i < 3 ? 2 : 1;
  for (let n = 0; n < count; n++) {
    const id = hex(16);
    const deleted = i > 8 && n === 0 && rand() < 0.5;
    const created = new Date(start.getTime() - randInt(0, 300) * dayMs);
    wallets.push({ id, balance: 0, deleted });
    walletRows.push([
      id, n === 0 ? WALLET_NAMES[0] : pick(WALLET_NAMES.slice(1)), account[0] as string, `dev-admin-${hex(8)}`, `dev-invoice-${hex(8)}`,
      pick(["", "", "CZK", "USD", null]), deleted, ts(created), ts(created), null, "lightning", null,
    ]);
  }
});
const live = wallets.filter((w) => !w.deleted);

// ---------- payments ----------
const payments: Row[] = [];
const TAGS = [null, null, null, null, "lnurlp", "withdraw", "tpos", "boltcards", "lndhub"];
function add(wallet: Wallet, checkingId: string, amountMsat: number, feeMsat: number, status: string, at: Date, tag: string | null): void {
  payments.push([
    checkingId, amountMsat, feeMsat, wallet.id, "dev fixture memo", ts(at), checkingId.replace(/^internal_/, ""),
    status === "success" ? hex(32) : null, `lnbc${Math.abs(amountMsat) / 1000}n1${hex(20)}`, status, tag, null, ts(at), ts(at),
  ]);
}
for (let day = 0; day < DAYS; day++) {
  const events = randInt(2, 9);
  for (let i = 0; i < events; i++) {
    const at = new Date(Math.min(start.getTime() + day * dayMs + randInt(0, 86_399) * 1000, now.getTime() - 1000));
    const ageMs = now.getTime() - at.getTime();
    const roll = rand();
    const w = pick(live);
    if (roll < 0.5) {
      // an invoice: paid, abandoned, or (only recently) still open
      const amount = pick([1000, 2100, 5000, 21_000, 50_000, 100_000, 250_000]) * 1000;
      const state = rand() < 0.82 ? "success" : ageMs < dayMs ? "pending" : rand() < 0.5 ? "pending" : "failed";
      add(w, hex(32), amount, 0, state, at, pick(TAGS));
      if (state === "success") w.balance += amount;
    } else if (roll < 0.85) {
      // a payment out over Lightning; older rows keep the fee positive, newer ones negative, as LNbits did
      const amount = pick([500, 1000, 2100, 10_000, 30_000, 80_000]) * 1000;
      const fee = Math.floor(amount * 0.003 * rand());
      if (w.balance < amount + fee) continue;
      const state = rand() < 0.93 ? "success" : "failed";
      add(w, hex(32), -amount, day < DAYS / 2 ? fee : -fee, state, at, pick(TAGS));
      if (state === "success") w.balance -= amount + fee;
    } else {
      // a transfer between two wallets of this LNbits: never touches Lightning
      const to = pick(live.filter((x) => x !== w));
      const amount = pick([1000, 5000, 20_000]) * 1000;
      if (!to || w.balance < amount) continue;
      const hash = hex(32);
      add(w, `internal_${hash}`, -amount, 0, "success", at, null);
      add(to, hash, amount, 0, "success", at, null);
      w.balance -= amount;
      to.balance += amount;
    }
  }
}
// one payment still in flight
const busy = live.find((w) => w.balance > 50_000_000) ?? live[0];
add(busy, hex(32), -21_000_000, -30_000, "pending", new Date(now.getTime() - 120_000), null);

console.log(`generated: ${accounts.length} accounts, ${wallets.length} wallets, ${payments.length} payments`);

// ---------- write ----------
const schemaSql = readFileSync(resolve(fileURLToPath(new URL(".", import.meta.url)), "dev-schema-lnbits.sql"), "utf8");
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
  await insertBatch("accounts", ["id", "email", "password_hash", "username", "extra", "created_at", "updated_at", "pubkey", "activated"], accounts);
  await insertBatch(
    "wallets",
    ["id", "name", '"user"', "adminkey", "inkey", "currency", "deleted", "created_at", "updated_at", "extra", "wallet_type", "shared_wallet_id"],
    walletRows,
  );
  await insertBatch(
    "apipayments",
    ["checking_id", "amount", "fee", "wallet_id", "memo", "time", "payment_hash", "preimage", "bolt11", "status", "tag", "extension", "created_at", "updated_at"],
    payments,
  );
  await client.query("COMMIT");
  await client.query("ANALYZE");
  const total = await client.query("SELECT round(coalesce(sum(balance), 0) / 1000)::bigint AS sat FROM balances");
  console.log(`LNbits owes its wallets ${total.rows[0].sat} sat`);
  console.log(`seeded ${dbName}`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw err;
} finally {
  await client.end();
}
