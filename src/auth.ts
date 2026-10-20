// Passkey sign-in for the operator(s) of the dashboard: Face ID / Touch ID via WebAuthn, no passwords, no e-mail,
// no resets. The first passkey can only be created with a one-time setup code that the server prints to its log;
// after that, new passkeys can only be added from a signed-in session. Passkeys and sessions live in a small
// local SQLite file (AUTH_DB); the mint database is never touched.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

const ALGORITHMS = [-8, -7, -257]; // EdDSA, ES256 (Apple passkeys), RS256
const FLOW_TTL_MS = 5 * 60_000;
const MAX_FLOWS = 50;
const SESSION_MAX_MS = 30 * 86_400_000; // signed in for at most 30 days…
const SESSION_IDLE_MS = 7 * 86_400_000; // …and out after a week without use
const TOUCH_EVERY_MS = 60 * 60_000;
const MAX_SETUP_FAILURES = 10;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The parts of a request/response the auth layer needs (real http objects or test doubles). */
export interface AuthRequest {
  headers: IncomingHttpHeaders;
}
export interface AuthResponse {
  setHeader(name: string, value: string): unknown;
}

interface CredentialRow {
  id: string;
  rp_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}
interface SessionRow {
  token_hash: string;
  credential_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_agent: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Passkeys that can open the dashboard (WebAuthn credentials) and signed-in sessions.
CREATE TABLE IF NOT EXISTS auth_credentials (
  id           TEXT    PRIMARY KEY,               -- credential ID (base64url)
  rp_id        TEXT    NOT NULL,                  -- the site it was made for (a passkey only works on its own domain)
  public_key   BLOB    NOT NULL,                  -- COSE public key
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                              -- JSON array, e.g. ["internal","hybrid"]
  device_type  TEXT,                              -- multiDevice = synced passkey (iCloud Keychain)
  backed_up    INTEGER NOT NULL DEFAULT 0,
  name         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash    TEXT    PRIMARY KEY,              -- SHA-256 of the cookie; the cookie itself is never stored
  credential_id TEXT    REFERENCES auth_credentials(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,                 -- unix ms
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  user_agent    TEXT
);`;

/** Opens (and creates) the SQLite file that holds passkeys and sessions. */
export function openAuthDb(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

const sha256 = (s: string | Uint8Array): Buffer => createHash("sha256").update(s).digest();
const now = (): number => Date.now();

function makeSetupCode(): string {
  const bytes = randomBytes(20);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return (chars.match(/.{4}/g) ?? [chars]).join("-"); // 20 characters ≈ 99 bits
}
const normalizeCode = (c: unknown): string => String(c ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

export function parseCookies(header = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw; // someone else's malformed cookie must not break the dashboard
    }
  }
  return out;
}

export interface AuthOptions {
  /** the exact origin the app is served from, e.g. "https://nutboard.lnpay.cz" */
  origin: string;
  /** optional fixed setup code (SETUP_CODE env); otherwise a random one is generated */
  setupCode?: string | null;
  rpName?: string;
  log?: (line: string) => void;
}

interface Flow {
  kind: "register" | "login";
  challenge: string;
  expires: number;
  needsSession?: boolean;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  device_type: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
  current: boolean;
}

export function createAuth(db: DatabaseSync, { origin, setupCode = null, rpName = "nutboard", log = console.log }: AuthOptions) {
  const url = new URL(origin);
  const rpID = url.hostname;
  const secure = url.protocol === "https:";
  // Browsers share localhost cookies across ports, so the local name includes the port.
  const cookieName = secure ? "__Host-nutboard" : `nutboard_session_${url.port || 80}`;
  const flows = new Map<string, Flow>();
  let code: string | null = null;
  let setupFailures = 0;

  const q = {
    count: db.prepare("SELECT COUNT(*) AS n FROM auth_credentials WHERE rp_id = ?"),
    userId: db.prepare("SELECT value FROM settings WHERE key = 'webauthn_user_id'"),
    insertUserId: db.prepare("INSERT INTO settings (key, value) VALUES ('webauthn_user_id', ?)"),
    existing: db.prepare("SELECT id, transports FROM auth_credentials WHERE rp_id = ?"),
    credential: db.prepare("SELECT * FROM auth_credentials WHERE id = ? AND rp_id = ?"),
    insertCredential: db.prepare(
      `INSERT INTO auth_credentials (id, rp_id, public_key, counter, transports, device_type, backed_up, name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    touchCredential: db.prepare(
      "UPDATE auth_credentials SET counter = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
    ),
    listCredentials: db.prepare(
      "SELECT id, name, device_type, backed_up, created_at, last_used_at FROM auth_credentials WHERE rp_id = ? ORDER BY created_at",
    ),
    deleteCredential: db.prepare("DELETE FROM auth_credentials WHERE id = ? AND rp_id = ?"),
    deleteCredentialSessions: db.prepare("DELETE FROM auth_sessions WHERE credential_id = ?"),
    insertSession: db.prepare(
      `INSERT INTO auth_sessions (token_hash, credential_id, created_at, last_seen_at, expires_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    session: db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?"),
    touchSession: db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?"),
  };

  // Passkeys are bound to their domain: a dashboard moved to a new address asks for setup again there.
  const passkeyCount = (): number => Number((q.count.get(rpID) as { n: number }).n);

  function userId(): Uint8Array<ArrayBuffer> {
    const row = q.userId.get() as { value: string } | undefined;
    if (row) return new Uint8Array(Buffer.from(row.value, "base64url"));
    const id = randomBytes(32);
    q.insertUserId.run(id.toString("base64url"));
    return new Uint8Array(id);
  }

  /** While no passkey exists, keep a one-time setup code and show it in the server log. */
  function armSetup(): void {
    if (passkeyCount() > 0) {
      code = null;
      return;
    }
    if (setupCode && normalizeCode(setupCode).length < 12) log("  SETUP_CODE is short; use at least 12 characters.");
    code = setupCode ? normalizeCode(setupCode) : normalizeCode(makeSetupCode());
    setupFailures = 0;
    const shown = setupCode ? "(from SETUP_CODE)" : (code.match(/.{4}/g) ?? [code]).join("-");
    log(
      `\n  No passkey yet. Open ${origin} and enter the one-time setup code: ${shown}\n` +
        `  It works until the first passkey is created; a restart makes a new one.\n`,
    );
  }

  function checkSetupCode(given: unknown): void {
    if (!code) throw new AuthError(403, "setup_closed", "Setup is closed: a passkey already exists");
    if (setupFailures >= MAX_SETUP_FAILURES) {
      throw new AuthError(429, "setup_locked", "Too many wrong codes; restart the server for a new one");
    }
    const a = sha256(normalizeCode(given));
    const b = sha256(code);
    if (!timingSafeEqual(a, b)) {
      setupFailures += 1;
      throw new AuthError(403, "bad_setup_code", "Wrong setup code");
    }
  }

  function startFlow(kind: Flow["kind"], challenge: string, extra: Partial<Flow> = {}): string {
    for (const [id, f] of flows) if (f.expires < now()) flows.delete(id);
    if (flows.size >= MAX_FLOWS) flows.delete(flows.keys().next().value as string);
    const flowId = randomBytes(18).toString("base64url");
    flows.set(flowId, { kind, challenge, expires: now() + FLOW_TTL_MS, ...extra });
    return flowId;
  }

  function takeFlow(flowId: unknown, kind: Flow["kind"]): Flow {
    const key = String(flowId ?? "");
    const f = flows.get(key);
    flows.delete(key); // single use, whatever happens next
    if (!f || f.kind !== kind || f.expires < now()) throw new AuthError(400, "expired", "This sign-in attempt expired; try again");
    return f;
  }

  // ---------------------------------------------------------------- sessions

  function cookie(value: string, maxAgeS: number): string {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
  }

  function startSession(res: AuthResponse, credentialId: string, req: AuthRequest): void {
    const token = randomBytes(32).toString("base64url");
    const t = now();
    q.insertSession.run(
      sha256(token).toString("hex"), credentialId, t, t, t + SESSION_MAX_MS, String(req.headers["user-agent"] ?? "").slice(0, 200),
    );
    res.setHeader("Set-Cookie", cookie(token, Math.floor(SESSION_MAX_MS / 1000)));
  }

  /** The signed-in session for this request, or null. */
  function session(req: AuthRequest): SessionRow | null {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (!token) return null;
    const hash = sha256(token).toString("hex");
    const s = q.session.get(hash) as SessionRow | undefined;
    const t = now();
    if (!s || s.expires_at <= t || s.last_seen_at + SESSION_IDLE_MS <= t) {
      if (s) q.deleteSession.run(hash);
      return null;
    }
    if (t - s.last_seen_at > TOUCH_EVERY_MS) q.touchSession.run(t, hash);
    return s;
  }

  function requireSession(req: AuthRequest): SessionRow {
    const s = session(req);
    if (!s) throw new AuthError(401, "signed_out", "Sign in required");
    return s;
  }

  function logout(req: AuthRequest, res: AuthResponse): void {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (token) q.deleteSession.run(sha256(token).toString("hex"));
    res.setHeader("Set-Cookie", cookie("", 0));
  }

  // ---------------------------------------------------------------- registration

  async function registrationOptions(req: AuthRequest, body: { setupCode?: unknown }) {
    const existing = q.existing.all(rpID) as Array<{ id: string; transports: string | null }>;
    const signedIn = session(req);
    if (existing.length) {
      if (!signedIn) throw new AuthError(403, "setup_closed", "Setup is closed: sign in to add another passkey");
    } else {
      checkSetupCode(body.setupCode);
    }
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userID: userId(),
      userName: "nutboard",
      userDisplayName: rpName,
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: JSON.parse(c.transports ?? "[]") as AuthenticatorTransport[],
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
      preferredAuthenticatorType: "localDevice",
    });
    const flowId = startFlow("register", options.challenge, { needsSession: existing.length > 0 });
    return { flowId, options };
  }

  async function registrationVerify(
    req: AuthRequest,
    res: AuthResponse,
    body: { flowId?: unknown; response?: RegistrationResponseJSON; name?: unknown },
  ) {
    const flow = takeFlow(body.flowId, "register");
    if (flow.needsSession) requireSession(req);
    else if (!code) throw new AuthError(403, "setup_closed", "Setup is closed: a passkey already exists");
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      result = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: flow.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch (err) {
      throw new AuthError(400, "verification_failed", `Passkey could not be verified: ${(err as Error).message}`);
    }
    if (!result.verified || !result.registrationInfo) throw new AuthError(400, "verification_failed", "Passkey could not be verified");
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    const n = passkeyCount();
    q.insertCredential.run(
      credential.id,
      rpID,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      String(body.name ?? "").trim().slice(0, 60) || `Passkey ${n + 1}`,
    );
    if (n === 0) {
      code = null; // setup is over for good
      startSession(res, credential.id, req);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- authentication

  async function authenticationOptions() {
    if (!passkeyCount()) throw new AuthError(409, "not_registered", "No passkey has been set up yet");
    // No allowCredentials: the passkey is discoverable, so there is no user name to type.
    const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
    return { flowId: startFlow("login", options.challenge), options };
  }

  async function authenticationVerify(
    req: AuthRequest,
    res: AuthResponse,
    body: { flowId?: unknown; response?: AuthenticationResponseJSON },
  ) {
    const flow = takeFlow(body.flowId, "login");
    const cred = q.credential.get(String(body.response?.id ?? ""), rpID) as CredentialRow | undefined;
    if (!cred) throw new AuthError(401, "unknown_passkey", "This passkey does not belong to this dashboard");
    const handle = body.response?.response?.userHandle;
    if (handle && handle !== Buffer.from(userId()).toString("base64url")) {
      throw new AuthError(401, "unknown_passkey", "This passkey does not belong to this dashboard");
    }
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      result = await verifyAuthenticationResponse({
        response: body.response as AuthenticationResponseJSON,
        expectedChallenge: flow.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: JSON.parse(cred.transports ?? "[]") as AuthenticatorTransport[],
        },
        requireUserVerification: true,
      });
    } catch (err) {
      throw new AuthError(401, "verification_failed", `Sign-in could not be verified: ${(err as Error).message}`);
    }
    if (!result.verified) throw new AuthError(401, "verification_failed", "Sign-in could not be verified");
    q.touchCredential.run(result.authenticationInfo.newCounter, cred.id);
    startSession(res, cred.id, req);
    return { ok: true };
  }

  // ---------------------------------------------------------------- management (signed in)

  function listPasskeys(req: AuthRequest): PasskeyInfo[] {
    const current = requireSession(req).credential_id;
    return (q.listCredentials.all(rpID) as Array<Omit<PasskeyInfo, "backed_up" | "current"> & { backed_up: number }>).map((c) => ({
      ...c,
      backed_up: !!c.backed_up,
      current: c.id === current,
    }));
  }

  function deletePasskey(req: AuthRequest, id: string) {
    requireSession(req);
    if (passkeyCount() <= 1) throw new AuthError(409, "last_passkey", "The last passkey cannot be removed");
    if (!q.deleteCredential.run(id, rpID).changes) throw new AuthError(404, "not_found", "Passkey not found");
    q.deleteCredentialSessions.run(id);
    return { ok: true };
  }

  function logoutEverywhere(req: AuthRequest, res: AuthResponse) {
    requireSession(req);
    db.exec("DELETE FROM auth_sessions");
    res.setHeader("Set-Cookie", cookie("", 0));
    return { ok: true };
  }

  function status(req: AuthRequest) {
    return { registered: passkeyCount() > 0, authenticated: !!session(req), rpID };
  }

  armSetup();
  return {
    rpID,
    cookieName,
    status,
    session,
    requireSession,
    logout,
    logoutEverywhere,
    listPasskeys,
    deletePasskey,
    registrationOptions,
    registrationVerify,
    authenticationOptions,
    authenticationVerify,
  };
}

export type Auth = ReturnType<typeof createAuth>;

/** Remove every passkey and session (server-side recovery); the next start prints a new setup code. */
export function resetAuth(db: DatabaseSync): void {
  db.exec("DELETE FROM auth_sessions; DELETE FROM auth_credentials;");
}
