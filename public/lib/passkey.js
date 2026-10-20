// Browser side of passkey sign-in: turns the server's WebAuthn options (JSON, base64url) into
// navigator.credentials calls and the resulting credential back into JSON for the server to verify.

const toBuffer = (b64url) => {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
};

const toBase64url = (buffer) => {
  let s = "";
  for (const byte of new Uint8Array(buffer)) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const withIds = (list = []) => list.map((c) => ({ ...c, id: toBuffer(c.id) }));

export const passkeysSupported = () => typeof window.PublicKeyCredential === "function" && !!navigator.credentials?.create;

/** Create a passkey (Face ID / Touch ID; stored in iCloud Keychain on Apple devices). */
export async function createPasskey(options) {
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBuffer(options.challenge),
      user: { ...options.user, id: toBuffer(options.user.id) },
      excludeCredentials: withIds(options.excludeCredentials),
    },
  });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toBase64url(r.clientDataJSON),
      attestationObject: toBase64url(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}

/** Sign in with a passkey; no user name needed (the passkey is discoverable). */
export async function usePasskey(options) {
  const cred = await navigator.credentials.get({
    publicKey: { ...options, challenge: toBuffer(options.challenge), allowCredentials: withIds(options.allowCredentials) },
  });
  const r = cred.response;
  return {
    id: cred.id,
    rawId: toBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: toBase64url(r.clientDataJSON),
      authenticatorData: toBase64url(r.authenticatorData),
      signature: toBase64url(r.signature),
      userHandle: r.userHandle ? toBase64url(r.userHandle) : undefined,
    },
    clientExtensionResults: cred.getClientExtensionResults?.() ?? {},
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
  };
}
