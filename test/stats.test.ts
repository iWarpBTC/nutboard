import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { Db } from "../src/db.ts";
import { WINDOWS, createStats, type MintStats } from "../src/stats/index.ts";

/*
 * Checks that hold for every mint dialect, run against whichever fixture TEST_DATABASE_URL points at
 * (npm run seed:dev for Nutshell, npm run seed:dev:cdk for CDK), plus cross-checks against the raw CDK
 * tables. Figures reached by two independent routes have to agree.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL to run";

let db: Db;
let stats: MintStats;
let units: string[];

before(async () => {
  if (!TEST_DB) return;
  db = new Db(loadConfig({ DATABASE_URL: TEST_DB, STATEMENT_TIMEOUT_MS: "60000" }).mints[0]);
  await db.verifyConnection();
  stats = await createStats(db, await db.introspect());
  units = await stats.listUnits();
});
after(async () => {
  await db?.close();
});

test("stats: the fixture is recognised and has units", { skip }, () => {
  assert.ok(stats.kind === "nutshell" || stats.kind === "cdk");
  assert.ok(units.length > 0, "at least one unit");
  assert.equal(stats.features.exactSwaps, stats.kind === "cdk");
  assert.equal(stats.features.localTimestamps, stats.kind === "nutshell");
});

test("stats: liabilities, keysets and denominations describe the same ledger", { skip }, async () => {
  const keysets = await stats.keysets();
  for (const unit of units) {
    const o = await stats.overview(unit);
    const L = o.liabilities;
    assert.equal(L.outstanding, L.issued - L.redeemed);
    if (L.keysetBalance !== null) assert.equal(L.keysetBalance, L.outstanding - L.pending, `${unit}: the mint's counter matches the ledger`);

    const mine = keysets.filter((k) => k.unit === unit);
    assert.equal(mine.length, L.keysets);
    assert.equal(mine.reduce((s, k) => s + k.issued, 0), L.issued);
    assert.equal(mine.reduce((s, k) => s + k.redeemed, 0), L.redeemed);
    assert.equal(mine.reduce((s, k) => s + k.pending, 0), L.pending);
    for (const k of mine) {
      assert.equal(k.computedBalance, k.issued - k.redeemed - k.pending);
      assert.notEqual(k.balanceMatches, false, `keyset ${k.id}: counter matches the ledger`);
    }

    const denoms = await stats.denominations(unit);
    assert.equal(denoms.reduce((s, d) => s + d.amount * d.issued, 0), L.issued);
    assert.equal(denoms.reduce((s, d) => s + d.amount * d.spent, 0), L.redeemed);
    assert.equal(denoms.reduce((s, d) => s + d.amount * d.pending, 0), L.pending);
  }
});

test("stats: windows nest and the all-time series adds up to the all-time totals", { skip }, async () => {
  for (const unit of units) {
    const o = await stats.overview(unit);
    const keys = WINDOWS.map((w) => w.key);
    for (const table of [o.mint, o.melt, o.signatures, o.spent, o.mintRequests]) {
      for (let i = 1; i < keys.length; i++) {
        assert.ok(table[keys[i - 1]].count <= table[keys[i]].count, `${unit}: counts grow with the window`);
        assert.ok(table[keys[i - 1]].amount <= table[keys[i]].amount, `${unit}: amounts grow with the window`);
      }
    }
    const series = await stats.timeseries(unit, "all");
    const total = (points: Array<{ count: number; amount: number; fee?: number }>) => ({
      count: points.reduce((s, p) => s + p.count, 0),
      amount: points.reduce((s, p) => s + p.amount, 0),
      fee: points.reduce((s, p) => s + (p.fee ?? 0), 0),
    });
    assert.equal(total(series.mint).amount, o.mint.all.amount);
    assert.equal(total(series.mint).count, o.mint.all.count);
    assert.equal(total(series.melt).amount, o.melt.all.amount);
    assert.equal(total(series.melt).count, o.melt.all.count);
    assert.equal(total(series.melt).fee, o.melt.all.fee_paid);
    assert.equal(total(series.swap).amount, o.signatures.all.swap_amount);
    // Monthly buckets can split a Nutshell swap estimate, so only CDK's recorded swaps must match exactly.
    if (stats.features.exactSwaps) assert.equal(total(series.swap).count, o.signatures.all.swap_ops);

    const fees = await stats.fees(unit, "all");
    if (o.melt.all.count > 0) {
      assert.ok(fees.total, "a total row when there are paid melts");
      assert.equal(fees.total.count, o.melt.all.count);
      assert.equal(fees.total.amount, o.melt.all.amount);
      assert.equal(fees.total.lnFee, o.melt.all.fee_paid);
      assert.equal(fees.total.feeReserve, o.melt.all.fee_reserve);
      assert.equal(fees.buckets.reduce((s, b) => s + b.count, 0), fees.total.count);
    }
  }
});

test("stats: activity, hours and audit are well formed", { skip }, async () => {
  for (const unit of units) {
    const hours = await stats.hourly(unit);
    assert.deepEqual(hours.map((h) => h.hour), Array.from({ length: 24 }, (_, i) => i));

    const activity = await stats.recentActivity(unit, 25);
    assert.ok(activity.length <= 25);
    for (let i = 1; i < activity.length; i++) assert.ok(new Date(activity[i - 1].at) >= new Date(activity[i].at), "newest first");
    for (const a of activity) assert.ok(["mint", "melt", "swap"].includes(a.kind));

    const audit = await stats.audit(unit);
    assert.equal(new Set(audit.map((c) => c.id)).size, audit.length, "check ids are unique");
    for (const c of audit) {
      assert.ok(["ok", "warn", "fail", "info", "skip"].includes(c.status));
      assert.notEqual(c.status, "fail", `${unit}: ${c.id} fails on a consistent fixture: ${c.summary}`);
    }

    const pub = await stats.publicFees(unit);
    assert.ok(pub.count === 0 || (pub.totalRatio !== null && pub.totalRatio >= 0 && pub.totalRatio < 0.5), "a sane fee ratio");
  }
});

test("cdk: operations agree with quotes, outputs and inputs", { skip: skip || undefined }, async (t) => {
  if (stats.kind !== "cdk") return t.skip("not a CDK fixture");
  assert.equal(await stats.timeZoneSanity(), null, "Unix timestamps need no zone check");
  assert.deepEqual(await stats.balanceLog(units[0], "all"), []);
  for (const unit of units) {
    const o = await stats.overview(unit);
    // Minted: the operations log on one side, what the quotes say was issued on the other.
    const quotes = await db.one<{ issued: number; requests: number; paid_melts: number }>(
      `SELECT (SELECT coalesce(sum(amount_issued), 0)::bigint FROM mint_quote WHERE unit = $1) AS issued,
              (SELECT count(*)::int FROM mint_quote WHERE unit = $1) AS requests,
              (SELECT count(*)::int FROM melt_quote WHERE unit = $1 AND state = 'PAID') AS paid_melts`,
      [unit],
    );
    assert.equal(o.mint.all.amount, quotes.issued, `${unit}: mint operations add up to the issued quotes`);
    assert.equal(o.mintRequests.all.count, quotes.requests);
    assert.equal(o.melt.all.count, quotes.paid_melts, `${unit}: one finished melt per paid quote`);
    // Outputs by origin: every signed output of a mint or swap is accounted for by an operation.
    assert.equal(o.signatures.all.mint_amount, o.mint.all.amount);
    assert.equal(o.signatures.all.legacy_count, 0);
    assert.equal(o.spent.all.legacy_count, 0);
    assert.equal(o.signatures.all.amount, o.signatures.all.mint_amount + o.signatures.all.swap_amount + o.signatures.all.melt_amount);
    assert.equal(o.spent.all.amount, o.spent.all.swap_amount + o.spent.all.melt_amount);
    // Melts balance: inputs = payment + Lightning fee + change + input fee.
    const fees = await stats.fees(unit, "all");
    if (fees.total) {
      assert.equal(o.spent.all.melt_amount, fees.total.amount + fees.total.lnFee + o.signatures.all.melt_amount + (fees.total.mintFee ?? 0));
    }
    const audit = await stats.audit(unit);
    assert.equal(audit.find((c) => c.id === "operations_vs_ledger")?.status, "ok");
    assert.equal(audit.find((c) => c.id === "melt_accounting")?.status, "ok");
  }
});
