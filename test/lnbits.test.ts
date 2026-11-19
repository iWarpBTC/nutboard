import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { createLnbitsStats, type LnbitsStats } from "../src/lnbits.ts";
import { WINDOWS } from "../src/stats/index.ts";

/*
 * The LNbits figures against a fixture (npm run seed:dev:lnbits, then scripts/create-readonly-role.sql in it).
 * Besides the arithmetic this checks the promise in the footer: keys, invoices, preimages and memos are
 * out of the dashboard's reach.
 */
const TEST_DB = process.env.TEST_LNBITS_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_LNBITS_DATABASE_URL to run";

let db: Db;
let stats: LnbitsStats;

before(async () => {
  if (!TEST_DB) return;
  const config = loadConfig({ DATABASE_URL: "postgres://unused/unused", LNBITS_DATABASE_URL: TEST_DB });
  db = new Db(config.lnbits!);
  await db.verifyConnection();
  stats = await createLnbitsStats(db);
});
after(async () => {
  await db?.close();
});

test("lnbits: balances, wallets and windows describe the same ledger", { skip }, async () => {
  const [o, wallets] = await Promise.all([stats.overview(), stats.wallets()]);
  const live = wallets.filter((w) => !w.deleted && !w.accountDeleted);
  // a wallet whose owner LNbits marked "del:" is not live, whatever its deleted flag says
  for (const w of wallets) assert.equal(w.accountDeleted, w.account.startsWith("del:"), `wallet ${w.id}`);
  assert.ok(wallets.some((w) => w.accountDeleted && !w.deleted), "the fixture has a wallet of a deleted account");
  assert.equal(live.length, o.wallets);
  assert.equal(wallets.length - live.length, o.deletedWallets);
  assert.equal(new Set(live.map((w) => w.account)).size, o.accounts);
  // each wallet is rounded down to whole sat, the total is rounded once: at most one sat apart per wallet
  const sum = live.reduce((s, w) => s + w.balance, 0);
  assert.ok(Math.abs(sum - o.balance) <= live.length, `wallet balances ${sum} vs total ${o.balance}`);
  for (const w of live) assert.ok(w.balance >= 0, `wallet ${w.id} is not overdrawn`);

  const keys = WINDOWS.map((w) => w.key);
  for (const measure of ["received_count", "received_amount", "sent_count", "sent_amount", "internal_count", "failed_count"]) {
    for (let i = 1; i < keys.length; i++) {
      assert.ok(o.payments[keys[i - 1]][measure] <= o.payments[keys[i]][measure], `${measure} grows with the window`);
    }
  }
  // what came in minus what went out (with fees) is what the wallets hold; transfers between wallets cancel out
  const all = o.payments.all;
  const deleted = wallets.filter((w) => w.deleted);
  if (!deleted.length || deleted.every((w) => w.payments === 0)) {
    const net = all.received_amount - all.sent_amount - all.internal_amount - all.fees - o.pendingOut.amount;
    assert.ok(Math.abs(net - o.balance) <= 50 + live.length, `ledger ${net} vs balance view ${o.balance}`);
  }
});

test("lnbits: the series adds up and payments can be listed per wallet", { skip }, async () => {
  const [o, series, wallets] = await Promise.all([stats.overview(), stats.timeseries("all"), stats.wallets()]);
  const total = (points: Array<{ amount: number; count: number }>) => points.reduce((s, p) => ({ amount: s.amount + p.amount, count: s.count + p.count }), { amount: 0, count: 0 });
  assert.equal(total(series.received).count, o.payments.all.received_count);
  assert.equal(total(series.sent).count, o.payments.all.sent_count);
  assert.ok(Math.abs(total(series.received).amount - o.payments.all.received_amount) <= series.buckets.length, "received, rounded per bucket");
  assert.ok(Math.abs(total(series.sent).amount - o.payments.all.sent_amount) <= series.buckets.length, "sent, rounded per bucket");

  const recent = await stats.payments(25, null);
  assert.ok(recent.length <= 25);
  for (let i = 1; i < recent.length; i++) assert.ok(new Date(recent[i - 1].at) >= new Date(recent[i].at), "newest first");
  const busiest = [...wallets].sort((x, y) => y.payments - x.payments)[0];
  const own = await stats.payments(10, busiest.id);
  assert.ok(own.length > 0);
  assert.ok(own.every((p) => p.walletId === busiest.id));
  assert.deepEqual(await stats.payments(10, "no-such-wallet"), []);
});

test("lnbits: keys, invoices, preimages and memos are out of reach", { skip }, async () => {
  for (const [table, column] of [
    ["wallets", "adminkey"],
    ["wallets", "inkey"],
    ["apipayments", "bolt11"],
    ["apipayments", "preimage"],
    ["apipayments", "memo"],
    ["accounts", "password_hash"],
    ["accounts", "email"],
  ]) {
    await assert.rejects(db.query(`SELECT ${column} FROM ${table} LIMIT 1`), /permission denied/, `${table}.${column}`);
  }
  await assert.rejects(db.query("UPDATE wallets SET name = name"), /read-only|permission denied/);
});
