import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAuthDb } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { KILL_TARGETS, createKillSwitch, parseUnits } from "../src/kill.ts";
import { createLabels } from "../src/labels.ts";
import { startServer } from "./helpers/server.ts";
import { VirtualAuthenticator } from "./helpers/virtual-authenticator.ts";

// ---------------------------------------------------------------------------- configuration

test("config: one mint as before, several through MINTS", () => {
  const one = loadConfig({ DATABASE_URL: "postgres://x/mint", MINT_NAME: "My mint", MINT_TZ: "Europe/Prague" });
  assert.equal(one.mints.length, 1);
  assert.deepEqual([one.mints[0].id, one.mints[0].name, one.mints[0].mintTz, one.siteName], ["mint", "My mint", "Europe/Prague", "My mint"]);
  assert.equal(one.lnbits, null);
  assert.equal(one.kill, null);

  const two = loadConfig({
    MINTS: "old, new-one",
    MINT_OLD_DATABASE_URL: "postgres://x/a",
    MINT_OLD_NAME: "Old",
    MINT_OLD_KIND: "nutshell",
    MINT_NEW_ONE_DATABASE_URL: "postgres://x/b",
    LNBITS_DATABASE_URL: "postgres://x/lnbits",
    KILL_SWITCH_DIR: "/run/nutboard-kill",
    SITE_NAME: "Both",
  });
  assert.deepEqual(two.mints.map((m) => [m.id, m.name, m.mintKind]), [["old", "Old", "nutshell"], ["new-one", "new-one", "auto"]]);
  assert.equal(two.siteName, "Both");
  assert.equal(two.lnbits?.name, "LNbits");
  assert.deepEqual(two.kill, { dir: "/run/nutboard-kill", conf: "/etc/nutboard/killswitch.conf" });

  assert.throws(() => loadConfig({}), /DATABASE_URL is required/);
  assert.throws(() => loadConfig({ MINTS: "a,b", MINT_A_DATABASE_URL: "postgres://x/a" }), /MINT_B_DATABASE_URL is required/);
  assert.throws(() => loadConfig({ MINTS: "a,a", MINT_A_DATABASE_URL: "postgres://x/a" }), /listed twice/);
  assert.throws(() => loadConfig({ MINTS: "name", MINT_NAME_DATABASE_URL: "postgres://x/a" }), /cannot be used/);
  assert.throws(() => loadConfig({ MINTS: "a b", MINT_A_DATABASE_URL: "postgres://x/a" }), /not a valid mint id/);
});

// ---------------------------------------------------------------------------- labels

test("labels: names are stored per wallet and account, cleaned up, and removable", () => {
  const labels = createLabels(openAuthDb(":memory:"));
  assert.deepEqual(labels.all(), { wallet: {}, account: {} });
  labels.set("wallet", "w1", "  Till \n at\tthe   shop ");
  labels.set("account", "a1", "Shop");
  assert.deepEqual(labels.all(), { wallet: { w1: "Till at the shop" }, account: { a1: "Shop" } });
  assert.equal(labels.set("wallet", "w1", "x".repeat(200)).wallet.w1.length, 60, "long names are cut");
  assert.deepEqual(labels.set("wallet", "w1", "   "), { wallet: {}, account: { a1: "Shop" } }, "an empty name removes the label");
  assert.throws(() => labels.set("user", "x", "y"), /kind must be/);
  assert.throws(() => labels.set("wallet", "", "y"), /id must be/);
  assert.throws(() => labels.set("wallet", "w1", 5), /name must be text/);
});

// ---------------------------------------------------------------------------- kill switch

test("kill switch: the unit list is read as data, never as a script", () => {
  const units = parseUnits(`
    # comment
    MINT_UNITS="cashu-mint.service cdk-mintd.service"
    LNBITS_UNITS=lnbits.service   # trailing comment
    LND_LINK_UNITS='wg-quick@wg0.service; rm -rf / $(reboot) other.service'
    SOMETHING_ELSE="x.service"
  `);
  assert.deepEqual(units.mints, ["cashu-mint.service", "cdk-mintd.service"]);
  assert.deepEqual(units.lnbits, ["lnbits.service"]);
  assert.deepEqual(units["lnd-link"], ["other.service"], "only plain unit names survive");
  assert.deepEqual(parseUnits(""), { mints: [], lnbits: [], "lnd-link": [] });
});

test("kill switch: a request is a file with a fixed name, written only after the exact phrase", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nutboard-kill-"));
  const conf = join(dir, "killswitch.conf");
  const requests = join(dir, "requests");
  writeFileSync(conf, 'MINT_UNITS="cashu-mint.service"\nLNBITS_UNITS="lnbits.service"\nLND_LINK_UNITS="wg-quick@wg0.service"\n');
  try {
    const kill = createKillSwitch(openAuthDb(":memory:"), { dir: requests, conf });
    const who = { credentialId: null, userAgent: "node:test" };

    // the helper's directory is missing: say so, and refuse
    let status = await kill.status();
    assert.match(status.problems.join(" "), /does not exist/);
    assert.throws(() => kill.request("mints", "STOP MINTS", who), { code: "not_installed", status: 503 });

    mkdirSync(requests); // what the tmpfiles rule does on the server
    status = await kill.status();
    assert.deepEqual(status.problems, []);
    assert.deepEqual(status.units.map((u) => [u.group, u.unit]), [["mints", "cashu-mint.service"], ["lnbits", "lnbits.service"], ["lnd-link", "wg-quick@wg0.service"]]);
    assert.deepEqual(status.pending, []);

    assert.throws(() => kill.request("everything", "STOP ALL", who), { code: "unknown_target" });
    assert.throws(() => kill.request("mints", "stop mints", who), { code: "not_confirmed" });
    assert.throws(() => kill.request("../../etc/passwd", "x", who), { code: "unknown_target" });
    assert.deepEqual(readdirSync(requests), [], "nothing was written by refused requests");
    assert.equal((await kill.status()).log.length, 0);

    for (const t of KILL_TARGETS) kill.request(t.id, t.confirm, who);
    assert.deepEqual(readdirSync(requests).sort(), ["all.request", "lnbits.request", "lnd-link.request", "mints.request"]);
    status = await kill.status();
    assert.deepEqual([...status.pending].sort(), ["all", "lnbits", "lnd-link", "mints"]);
    assert.equal(status.log.length, 4);
    assert.equal(status.log[0].userAgent, "node:test");
    assert.ok(KILL_TARGETS.find((t) => t.id === "lnd-link")?.groups.includes("lnd-link"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------- HTTP layer (needs fixture databases)

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_LNBITS = process.env.TEST_LNBITS_DATABASE_URL;
const PORT = 47_374;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = `http://localhost:${PORT}`;
const skip = TEST_DB ? false : "set TEST_DATABASE_URL to run";

const json = (res: Response) => res.json() as Promise<Record<string, unknown>>;
const send = (path: string, method: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method, headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("http: two mints, labels and the kill switch from one instance", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nutboard-http-"));
  writeFileSync(join(dir, "killswitch.conf"), 'MINT_UNITS="cashu-mint.service"\n');
  const { child, ready } = startServer({
    MINTS: "a,b",
    MINT_A_DATABASE_URL: TEST_DB as string,
    MINT_A_NAME: "First",
    MINT_B_DATABASE_URL: TEST_DB as string,
    MINT_B_NAME: "Second",
    ...(TEST_LNBITS ? { LNBITS_DATABASE_URL: TEST_LNBITS } : {}),
    KILL_SWITCH_DIR: dir,
    KILL_SWITCH_CONF: join(dir, "killswitch.conf"),
    SITE_NAME: "Both mints",
    PORT: String(PORT),
    ORIGIN,
    NUTBOARD_AUTH: "off",
  });
  try {
    await ready;
    const health = await json(await fetch(`${BASE}/api/health`));
    assert.equal(health.siteName, "Both mints");
    assert.deepEqual((health.mints as Array<{ id: string; name: string }>).map((m) => [m.id, m.name]), [["a", "First"], ["b", "Second"]]);
    assert.equal(health.mint, "a", "the first mint is the default");
    assert.equal(health.killSwitch, true);
    assert.equal((await json(await fetch(`${BASE}/api/health?mint=b`))).mintName, "Second");
    assert.equal((await fetch(`${BASE}/api/overview?mint=nope`)).status, 400);

    const a = await json(await fetch(`${BASE}/api/overview?mint=a`));
    const b = await json(await fetch(`${BASE}/api/overview?mint=b`));
    assert.deepEqual((a.liabilities as { outstanding: number }).outstanding, (b.liabilities as { outstanding: number }).outstanding, "same database, same figures");

    const summary = await json(await fetch(`${BASE}/api/summary`));
    const mints = summary.mints as Array<{ id: string; error: string | null; units: Array<{ unit: string; outstanding: number }> }>;
    assert.deepEqual(mints.map((m) => [m.id, m.error]), [["a", null], ["b", null]]);
    const satOf = (m: (typeof mints)[number]) => m.units.find((u) => u.unit === "sat")?.outstanding ?? 0;
    const lnbitsBalance = TEST_LNBITS ? ((summary.lnbits as { balance: number }).balance) : 0;
    assert.equal((summary.liabilitiesSat as { total: number }).total, satOf(mints[0]) + satOf(mints[1]) + lnbitsBalance);
    if (!TEST_LNBITS) {
      assert.equal(summary.lnbits, null);
      assert.equal((await fetch(`${BASE}/api/lnbits/overview`)).status, 404);
    }

    // labels: the one thing besides the kill switch that can be written
    assert.deepEqual(await json(await fetch(`${BASE}/api/labels`)), { wallet: {}, account: {} });
    assert.deepEqual(await json(await send("/api/labels", "PUT", { kind: "wallet", id: "w1", name: " Till " })), { wallet: { w1: "Till" }, account: {} });
    assert.equal((await send("/api/labels", "PUT", { kind: "nope", id: "w1", name: "x" })).status, 400);
    assert.equal((await fetch(`${BASE}/api/labels`, { method: "PUT", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" })).status, 403, "writes only from our own origin");
    assert.equal((await send("/api/overview", "POST", {})).status, 405, "statistics cannot be written");

    // kill switch: its state is shown, but with sign-in off it cannot be pulled
    const status = await json(await fetch(`${BASE}/api/kill`));
    assert.equal(status.enabled, true);
    assert.deepEqual((status.units as Array<{ unit: string }>).map((u) => u.unit), ["cashu-mint.service"]);
    const refused = await send("/api/kill", "POST", { target: "mints", confirm: "STOP MINTS" });
    assert.equal(refused.status, 403);
    assert.match(String((await json(refused)).error), /needs sign-in/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".request")), []);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("http: the kill switch end to end, behind a passkey", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nutboard-http-"));
  writeFileSync(join(dir, "killswitch.conf"), 'MINT_UNITS="cashu-mint.service"\nLNBITS_UNITS="lnbits.service"\n');
  const port = PORT + 1;
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;
  const SETUP_CODE = "TEST-CODE-2345-6789-ABCD";
  const { child, ready } = startServer({
    DATABASE_URL: TEST_DB as string,
    KILL_SWITCH_DIR: dir,
    KILL_SWITCH_CONF: join(dir, "killswitch.conf"),
    PORT: String(port),
    ORIGIN: origin,
    SETUP_CODE,
  });
  const call = (path: string, method: string, body: unknown, cookie?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
  try {
    await ready;
    // without a session nothing can be written, and not even the state of the services is shown
    for (const [path, method, body] of [
      ["/api/kill", "POST", { target: "all", confirm: "STOP ALL" }],
      ["/api/labels", "PUT", { kind: "wallet", id: "w", name: "n" }],
    ] as const) {
      const res = await call(path, method, body);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal((await json(res)).code, "signed_out");
    }
    assert.equal((await fetch(`${base}/api/kill`)).status, 401);
    assert.equal((await fetch(`${base}/api/summary`)).status, 401);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".request")), []);

    // set up a passkey over HTTP, as the browser does
    const authenticator = new VirtualAuthenticator();
    const opts = (await json(await call("/api/auth/register/options", "POST", { setupCode: SETUP_CODE }))) as unknown as {
      flowId: string;
      options: Parameters<VirtualAuthenticator["create"]>[0];
    };
    const registered = await call("/api/auth/register/verify", "POST", { flowId: opts.flowId, response: authenticator.create(opts.options, origin), name: "Test key" });
    assert.equal(registered.status, 200);
    const cookie = String(registered.headers.get("set-cookie")).split(";")[0];

    // signed in: the phrase still has to be exact, the origin still has to be ours
    assert.equal((await call("/api/kill", "POST", { target: "lnbits", confirm: "stop lnbits" }, cookie)).status, 400);
    const foreign = await fetch(`${base}/api/kill`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ target: "lnbits", confirm: "STOP LNBITS" }),
    });
    assert.equal(foreign.status, 403);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".request")), []);

    const done = await call("/api/kill", "POST", { target: "lnbits", confirm: "STOP LNBITS" }, cookie);
    assert.equal(done.status, 202);
    const after = await json(done);
    assert.deepEqual(after.pending, ["lnbits"]);
    assert.ok(existsSync(join(dir, "lnbits.request")));
    const log = after.log as Array<{ target: string; passkey: string | null }>;
    assert.deepEqual([log[0].target, log[0].passkey], ["lnbits", "Test key"], "logged with the passkey that confirmed it");
    assert.deepEqual(await json(await call("/api/labels", "PUT", { kind: "wallet", id: "w", name: "Till" }, cookie)), { wallet: { w: "Till" }, account: {} });
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
