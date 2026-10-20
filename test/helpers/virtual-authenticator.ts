// A software passkey for tests: real P-256 keys, real authenticator data and signatures, "none" attestation.
// It plays the part of Face ID / iCloud Keychain so the server's WebAuthn checks run end to end.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

const sha256 = (data: string | Uint8Array): Buffer => createHash("sha256").update(data).digest();
const b64 = (buf: Uint8Array | string): string => Buffer.from(buf as Uint8Array).toString("base64url");

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}

type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;

/** Minimal CBOR encoder: integers, text, byte strings and maps, all WebAuthn needs. */
export function cbor(v: CborValue): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: unsupported ${typeof v}`);
}

const UP = 0x01;
const UV = 0x04;
const BE = 0x08; // backup eligible
const BS = 0x10; // backed up (a synced passkey)
const AT = 0x40;

interface StoredCredential {
  privateKey: KeyObject;
  rpId: string;
  userHandle: string;
  counter: number;
}

export interface Tamper {
  challenge?: string;
  origin?: string;
  signature?: boolean;
  id?: string;
}

export class VirtualAuthenticator {
  credentials = new Map<string, StoredCredential>();

  /** navigator.credentials.create() */
  create(options: { rp: { id: string }; user: { id: string }; challenge: string }, origin: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const id = randomBytes(16);
    const coseKey = cbor(
      new Map<CborValue, CborValue>([
        [1, 2], [3, -7], [-1, 1],
        [-2, Buffer.from(jwk.x as string, "base64url")],
        [-3, Buffer.from(jwk.y as string, "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(options.rp.id), Buffer.from([UP | UV | BE | BS | AT]), Buffer.alloc(4), Buffer.alloc(16), idLength, id, coseKey,
    ]);
    const clientData = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false });
    const attestationObject = cbor(new Map<CborValue, CborValue>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    this.credentials.set(b64(id), { privateKey, rpId: options.rp.id, userHandle: options.user.id, counter: 0 });
    return {
      id: b64(id),
      rawId: b64(id),
      type: "public-key",
      response: { clientDataJSON: b64(clientData), attestationObject: b64(attestationObject), transports: ["internal", "hybrid"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    } as unknown as RegistrationResponseJSON;
  }

  /** navigator.credentials.get(); `tamper` lets tests forge things a real authenticator never would. */
  get(options: { rpId: string; challenge: string }, origin: string, { id = [...this.credentials.keys()][0], tamper = {} as Tamper } = {}) {
    const cred = this.credentials.get(id);
    if (!cred) throw new Error(`no credential ${id}`);
    const authData = Buffer.concat([sha256(options.rpId), Buffer.from([UP | UV | BE | BS]), Buffer.alloc(4)]);
    const clientData = JSON.stringify({
      type: "webauthn.get", challenge: tamper.challenge ?? options.challenge, origin: tamper.origin ?? origin, crossOrigin: false,
    });
    let signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), cred.privateKey);
    if (tamper.signature) signature = Buffer.from(signature.map((b, i) => (i === signature.length - 1 ? b ^ 0xff : b)));
    return {
      id: tamper.id ?? id,
      rawId: tamper.id ?? id,
      type: "public-key",
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature), userHandle: cred.userHandle },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    } as unknown as AuthenticationResponseJSON;
  }
}
