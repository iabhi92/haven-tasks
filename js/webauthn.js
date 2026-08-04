// Thin wrapper around the WebAuthn API for passkey unlock (docs/ARCHITECTURE.md
// "WebAuthn passkey unlock"). Never touches the DEK or any Haven-specific
// crypto — it only ever moves opaque bytes in and out of the authenticator's
// largeBlob storage. js/app.js decides what those bytes mean.

export function isWebAuthnAvailable() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

// Registers a new resident credential requiring largeBlob support. This is
// deliberately a *request*, not a guarantee — largeBlobSupported must be
// checked in the result before relying on it; a real authenticator that
// doesn't support largeBlob still completes create() successfully, it just
// reports supported:false, per spec (support isn't something a website can
// force an authenticator to have).
export async function registerPasskey({ userId, userName, rpName = "Haven" }) {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { name: rpName },
      user: { id: userId, name: userName, displayName: userName },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256, wider authenticator compatibility
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      // "preferred", not "required": with "required", an authenticator that
      // lacks largeBlob support makes the WHOLE ceremony throw — and the
      // browser deliberately reports that as the same generic
      // NotAllowedError a cancelled/timed-out ceremony gets (a WebAuthn
      // privacy property: sites shouldn't be able to fingerprint an
      // authenticator's capabilities from *which* error they get). With
      // "preferred", create() succeeds either way and the real answer is
      // read from the result below — the only way to tell "unsupported"
      // apart from "cancelled" with a real, resolvable UI message.
      extensions: { largeBlob: { support: "preferred" } },
    },
  });
  const ext = credential.getClientExtensionResults();
  return {
    credentialId: new Uint8Array(credential.rawId),
    largeBlobSupported: !!ext.largeBlob?.supported,
  };
}

// Per the WebAuthn spec, largeBlob.write only happens during an assertion
// (get()), never during the create() that registers the credential — this is
// a second, separate ceremony/prompt, not a bug or extra step added here.
export async function writeLargeBlob(credentialId, secretBytes) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: "required",
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      extensions: { largeBlob: { write: secretBytes } },
    },
  });
  const ext = assertion.getClientExtensionResults();
  if (!ext.largeBlob?.written) throw new Error("Authenticator did not confirm the write");
  return true;
}

// Returns the stored secret bytes, or null if nothing was ever written
// (distinguish from a thrown error, which means the ceremony itself failed —
// wrong/removed authenticator, user cancelled, etc.).
export async function readLargeBlob(credentialId) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: "required",
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      extensions: { largeBlob: { read: true } },
    },
  });
  const ext = assertion.getClientExtensionResults();
  return ext.largeBlob?.blob ? new Uint8Array(ext.largeBlob.blob) : null;
}
