import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAuth, openAuthDb, parseCookies, type AuthResponse } from "../src/auth.ts";
import { VirtualAuthenticator, type Tamper } from "./helpers/virtual-authenticator.ts";

const ORIGIN = "http://localhost:3737";
const SETUP_CODE = "TEST-CODE-2345-6789-ABCD";
const quiet = (): void => {};

function fakeRes(): AuthResponse & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  };
}
const fakeReq = (cookie?: string) => ({ headers: { "user-agent": "node:test", ...(cookie ? { cookie } : {}) } });
const sessionFrom = (setCookie: string): string => setCookie.split(";")[0];

test("parseCookies tolerates junk from other sites", () => {
  assert.deepEqual(parseCookies("a=1; b=%zz; garbage; c=hello%20there"), { a: "1", b: "%zz", c: "hello there" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("passkeys belong to their site: a dashboard moved to a new domain asks for setup there", () => {
  const db = openAuthDb(":memory:");
  db.prepare("INSERT INTO auth_credentials (id, rp_id, public_key, name) VALUES ('abc', 'localhost', x'00', 'Local')").run();
  assert.equal(createAuth(db, { origin: ORIGIN, log: quiet }).status(fakeReq()).registered, true);
  const online = createAuth(db, { origin: "https://nutboard.example.com", log: quiet });
  assert.equal(online.status(fakeReq()).registered, false);
  assert.equal(online.cookieName, "__Host-nutboard", "HTTPS sites get a __Host- cookie");
});

test("the whole sign-in lifecycle against a software passkey", async () => {
  const db = openAuthDb(":memory:");
  const logged: string[] = [];
  const auth = createAuth(db, { origin: ORIGIN, setupCode: SETUP_CODE, log: (l) => logged.push(l) });
  const authenticator = new VirtualAuthenticator();
  assert.match(logged.join("\n"), /one-time setup code: \(from SETUP_CODE\)/);

  // nothing but sign-in answers without a session
  assert.deepEqual(auth.status(fakeReq()), { registered: false, authenticated: false, rpID: "localhost" });
  await assert.rejects(auth.authenticationOptions(), { code: "not_registered" });
  assert.throws(() => auth.requireSession(fakeReq()), { code: "signed_out", status: 401 });

  // the first passkey needs the one-time setup code
  await assert.rejects(auth.registrationOptions(fakeReq(), {}), { code: "bad_setup_code" });
  await assert.rejects(auth.registrationOptions(fakeReq(), { setupCode: "WRONG-CODE" }), { status: 403 });
  const opts = await auth.registrationOptions(fakeReq(), { setupCode: "test code 2345 6789 abcd" }); // forgiving format
  assert.equal(opts.options.authenticatorSelection?.residentKey, "required");
  assert.equal(opts.options.authenticatorSelection?.userVerification, "required");

  // registering signs you in with a strict cookie
  const r1 = fakeRes();
  await auth.registrationVerify(fakeReq(), r1, { flowId: opts.flowId, response: authenticator.create(opts.options, ORIGIN), name: "Test passkey" });
  assert.match(r1.headers["set-cookie"], /^nutboard_session_3737=[\w-]{43}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  let cookie = sessionFrom(r1.headers["set-cookie"]);
  assert.deepEqual(auth.status(fakeReq(cookie)), { registered: true, authenticated: true, rpID: "localhost" });

  // setup is closed once a passkey exists, even with the code
  await assert.rejects(auth.registrationOptions(fakeReq(), { setupCode: SETUP_CODE }), { code: "setup_closed" });

  // sign out, then sign in with the passkey
  const r2 = fakeRes();
  auth.logout(fakeReq(cookie), r2);
  assert.match(r2.headers["set-cookie"], /Max-Age=0/);
  assert.throws(() => auth.requireSession(fakeReq(cookie)), { code: "signed_out" }, "the old session is gone on the server too");

  async function signIn(tamper?: Tamper) {
    const o = await auth.authenticationOptions();
    const response = authenticator.get(o.options, ORIGIN, { tamper });
    const r = fakeRes();
    try {
      await auth.authenticationVerify(fakeReq(), r, { flowId: o.flowId, response });
      return { ok: true as const, cookie: sessionFrom(r.headers["set-cookie"]), flowId: o.flowId, response };
    } catch (err) {
      assert.equal(r.headers["set-cookie"], undefined, "no session on failure");
      return { ok: false as const, code: (err as { code: string }).code, flowId: o.flowId, response };
    }
  }
  const ok = await signIn();
  assert.equal(ok.ok, true);
  cookie = ok.ok ? ok.cookie : "";
  assert.equal(auth.status(fakeReq(cookie)).authenticated, true);

  // forged, replayed and phished sign-ins are refused
  const cases: Array<[string, Tamper, string]> = [
    ["wrong challenge", { challenge: "bm90LXRoZS1jaGFsbGVuZ2U" }, "verification_failed"],
    ["phished origin", { origin: "https://evil.example" }, "verification_failed"],
    ["bad signature", { signature: true }, "verification_failed"],
    ["unknown passkey", { id: "bm90LWEtcGFzc2tleQ" }, "unknown_passkey"],
  ];
  for (const [why, tamper, code] of cases) {
    const r = await signIn(tamper);
    assert.equal(r.ok, false, why);
    assert.equal(r.ok ? "" : r.code, code, why);
  }
  await assert.rejects(
    auth.authenticationVerify(fakeReq(), fakeRes(), { flowId: ok.flowId, response: ok.response }),
    { code: "expired" },
    "a flow is single use",
  );

  // passkeys can be added and removed, never the last one
  let list = auth.listPasskeys(fakeReq(cookie));
  assert.equal(list.length, 1);
  assert.equal(list[0].current, true);
  assert.throws(() => auth.deletePasskey(fakeReq(cookie), list[0].id), { code: "last_passkey" });
  await assert.rejects(auth.registrationOptions(fakeReq(), {}), { code: "setup_closed" }, "adding needs a session");
  const o2 = await auth.registrationOptions(fakeReq(cookie), {});
  const r3 = fakeRes();
  await auth.registrationVerify(fakeReq(cookie), r3, { flowId: o2.flowId, response: authenticator.create(o2.options, ORIGIN), name: "Second" });
  assert.equal(r3.headers["set-cookie"], undefined, "adding a passkey keeps the current session");
  list = auth.listPasskeys(fakeReq(cookie));
  assert.equal(list.length, 2);
  assert.deepEqual(auth.deletePasskey(fakeReq(cookie), list[1].id), { ok: true });
  assert.throws(() => auth.deletePasskey(fakeReq(cookie), "nope"), { code: "last_passkey" });

  // sign out everywhere ends every session
  const other = await signIn();
  assert.equal(other.ok, true);
  auth.logoutEverywhere(fakeReq(cookie), fakeRes());
  assert.throws(() => auth.requireSession(fakeReq(other.ok ? other.cookie : "")), { code: "signed_out" });
  assert.throws(() => auth.requireSession(fakeReq(cookie)), { code: "signed_out" });
});

// ---------------------------------------------------------------------------- HTTP layer (needs a mint database)

const TEST_DB = process.env.TEST_DATABASE_URL;
const PORT = 47_373;
const BASE = `http://127.0.0.1:${PORT}`;
const HTTP_ORIGIN = `http://localhost:${PORT}`;

function startServer(env: Record<string, string>): { child: ChildProcess; ready: Promise<string> } {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: TEST_DB, AUTH_DB: ":memory:", PORT: String(PORT), ORIGIN: HTTP_ORIGIN, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout?.on("data", (d) => {
      out += String(d);
      if (out.includes("nutboard →")) resolve(out);
    });
    child.stderr?.on("data", (d) => {
      out += String(d);
    });
    child.on("exit", (code) => reject(new Error(`server exited with ${code}: ${out}`)));
    setTimeout(() => reject(new Error(`server did not start: ${out}`)), 15_000).unref();
  });
  return { child, ready };
}

test("http: the API needs a session, the Host must be ours", { skip: TEST_DB ? false : "set TEST_DATABASE_URL to run" }, async () => {
  const { child, ready } = startServer({ SETUP_CODE });
  try {
    const out = await ready;
    assert.match(out, /one-time setup code/);
    const status = await fetch(`${BASE}/api/auth/status`, { headers: { Host: `localhost:${PORT}` } });
    assert.deepEqual(await status.json(), { registered: false, authenticated: false, rpID: "localhost" });
    const overview = await fetch(`${BASE}/api/overview`);
    assert.equal(overview.status, 401);
    assert.equal(((await overview.json()) as { code: string }).code, "signed_out");
    const page = await fetch(`${BASE}/`);
    assert.equal(page.status, 200, "the page itself is public; it shows the sign-in gate");
    const publicFees = await fetch(`${BASE}/api/public/fees`);
    assert.equal(publicFees.status, 200, "the aggregate fee summary is public");
    const pf = (await publicFees.json()) as { band: { min: number; max: number }; count: number; totalRatio: number | null };
    assert.deepEqual(pf.band, { min: 1000, max: 99999 });
    assert.ok(pf.count === 0 || (pf.totalRatio !== null && pf.totalRatio >= 0 && pf.totalRatio < 0.5), "a sane fee ratio");
    const fees = await fetch(`${BASE}/api/fees`);
    assert.equal(fees.status, 401, "the detailed fee table still needs a session");
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    // fetch() refuses to set Host, so use node:http for the DNS-rebinding case
    const badHost = await new Promise<number>((resolve, reject) => {
      request({ host: "127.0.0.1", port: PORT, path: "/api/auth/status", headers: { host: "evil.example" } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      }).on("error", reject).end();
    });
    assert.equal(badHost, 403);
    const crossSite = await fetch(`${BASE}/api/auth/logout`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(crossSite.status, 403);
  } finally {
    child.kill();
  }
});

test("http: NUTBOARD_AUTH=off is refused unless local", { skip: TEST_DB ? false : "set TEST_DATABASE_URL to run" }, async () => {
  const { child, ready } = startServer({ NUTBOARD_AUTH: "off", ORIGIN: "https://nutboard.example.com" });
  await assert.rejects(ready, /only allowed when the dashboard is local/);
  child.kill();
});
