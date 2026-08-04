// Pure, side-effect-free crypto module. Every primitive here is a standard
// Web Crypto construction composed per docs/ARCHITECTURE.md — nothing here is
// invented. Do not import this into app.js/store.js until the vectors in
// docs/ARCHITECTURE.md §8 (js/crypto.test.mjs) all pass.
//
// KDF: PBKDF2-SHA256, 600,000 iterations — the explicitly-documented fallback
// in ARCHITECTURE.md when Argon2id/hash-wasm is deferred. Chosen over vendoring
// a WASM Argon2id implementation for v1: PBKDF2 is native to Web Crypto (no
// third-party code to vendor, review, or keep patched), at a cost documented
// in docs/THREAT_MODEL.md (weaker than Argon2id against GPU/ASIC brute force).

export const PBKDF2_ITERATIONS = 600000;
export const KDF_NAME = "pbkdf2-sha256";

// Exported: app.js needs these too, for encoding the salt into the keyring record.
export function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function generateSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

// URL-safe variants — used for the share-link fragment key (docs/ARCHITECTURE.md
// "Fragment-key share links"), where raw base64's +/= would need escaping.
export function bufToBase64Url(buf) {
  return bufToBase64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBuf(b64url) {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return base64ToBuf(padded + "=".repeat(padLen));
}

// ---------- key derivation ----------

// Derives a KEK (AES-256-GCM CryptoKey, non-extractable) from a passphrase or
// recovery code string + salt. Same function serves both KEK and KEK_r —
// they differ only in which secret string and which salt are passed in.
export async function deriveKek(secret, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// ---------- DEK lifecycle ----------

export async function generateDek() {
  // extractable: true so we can export it once to wrap — the DEK actually used
  // for task encrypt/decrypt should be re-imported non-extractable (see importDek).
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// Wrapping = AES-256-GCM encrypt of the raw DEK bytes under a KEK, fresh 96-bit IV.
export async function wrapDek(dek, kek) {
  const raw = await crypto.subtle.exportKey("raw", dek);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, raw);
  return { wrappedDek: bufToBase64(wrapped), wrapIv: bufToBase64(iv) };
}

// Returns raw DEK bytes (ArrayBuffer), not a CryptoKey — callers import via
// importDek(). AES-GCM's built-in auth tag means this throws on a wrong KEK
// or tampered ciphertext (fails closed) rather than returning garbage bytes.
export async function unwrapDek(wrappedDek, wrapIv, kek) {
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBuf(wrapIv) },
    kek,
    base64ToBuf(wrappedDek)
  );
}

// extractable defaults to false: the DEK held in memory during normal app use
// should never be exportable. Tests pass extractable:true to compare raw bytes.
export async function importDek(rawDekBytes, extractable = false) {
  return crypto.subtle.importKey("raw", rawDekBytes, { name: "AES-GCM" }, extractable, [
    "encrypt",
    "decrypt",
  ]);
}

// ---------- task encryption ----------

// Fresh random IV every call — the module never accepts a caller-supplied IV,
// so IV reuse with the same key isn't a mistake a caller can make.
export async function encryptTask(taskObject, dek) {
  const plaintext = new TextEncoder().encode(JSON.stringify(taskObject));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dek, plaintext);
  return { iv: bufToBase64(iv), ciphertext: bufToBase64(ciphertext) };
}

export async function decryptTask(record, dek) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBuf(record.iv) },
    dek,
    base64ToBuf(record.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ---------- recovery code ----------

// Crockford base32 — excludes I/L/O/U so a handwritten transcription of the
// recovery code can't be confused with 1/1/0/V.
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function bytesToBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

// Exact inverse of bytesToBase32 — trailing bits shorter than a byte are
// encoding padding (always zero-filled by bytesToBase32), not data, so
// they're dropped rather than turned into a partial trailing byte.
function base32ToBytes(str) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of str) {
    const charValue = BASE32_ALPHABET.indexOf(char);
    if (charValue === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | charValue;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function formatAsDashedCode(bytes) {
  return bytesToBase32(bytes).match(/.{1,5}/g).join("-");
}

// 32 random bytes (256 bits) via crypto.getRandomValues — never Math.random().
export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return formatAsDashedCode(bytes);
}

// Recovery codes are entered by hand — normalize case/formatting before using
// as KDF input so "abcd-efgh" and "ABCDEFGH" derive the same key.
export function normalizeRecoveryCode(code) {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// The raw 32 bytes behind an already-generated, already-normalized recovery
// code — needed to split it via Shamir secret sharing (below) without
// generating a second, different secret.
export function recoveryCodeToBytes(normalizedCode) {
  return base32ToBytes(normalizedCode);
}

// The inverse: reconstructed Shamir secret bytes -> the exact same dashed
// format generateRecoveryCode() produces, so a reconstructed code is
// indistinguishable from — and usable anywhere — an originally-generated one.
export function bytesToRecoveryCode(bytes) {
  return formatAsDashedCode(bytes);
}

// ---------- social recovery: Shamir secret sharing over GF(256) ----------
// Splits the recovery code's own 32 secret bytes into n shares, k of which
// reconstruct the original bytes exactly; k-1 reveal nothing (information-
// theoretic security, the standard Shamir 1979 guarantee). Reconstructing
// yields the *same* recovery code string, so it plugs directly into the
// existing recovery-code unlock flow — no separate recovery path to build or
// audit. See docs/ARCHITECTURE.md "Social recovery".

// Standard AES/Rijndael field: GF(2^8) with reduction polynomial
// x^8+x^4+x^3+x+1 (0x11B) and generator 3 — the same field choice used by
// most reference Shamir-secret-sharing implementations (e.g. ssss, ss).
// Not a novel construction; log/exp tables are the usual way to make GF(256)
// multiply/divide fast without a per-call polynomial reduction.
const GF_EXP = new Uint8Array(256);
const GF_LOG = new Uint8Array(256);
(function buildGfTables() {
  // Generator must be 3, not 2: 2 (0x02) only has multiplicative order 51 in
  // this field (a proper divisor of 255), so a table built by repeated
  // doubling alone silently cycles after 51 entries instead of covering all
  // 255 nonzero elements. 3 = double(x) XOR x is the standard choice (used
  // by Rijndael's own reference log/antilog tables) and is a true primitive
  // root here — verified by checking the loop below visits 255 distinct
  // values before repeating, not merely asserted.
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    let doubled = x << 1;
    if (doubled & 0x100) doubled ^= 0x11b;
    x = doubled ^ x;
  }
  GF_EXP[255] = GF_EXP[0]; // wrap, simplifies mult() below
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

function gfDiv(a, b) {
  if (a === 0) return 0;
  if (b === 0) throw new Error("GF(256) division by zero");
  return GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255];
}

// Splits `secretBytes` into `n` shares of which any `k` reconstruct it.
// Returns [{ index: 1..n, bytes: Uint8Array(secretBytes.length) }, ...].
export function splitSecret(secretBytes, k, n) {
  if (k < 2 || n < k || n > 255) throw new Error("Shamir split requires 2 <= k <= n <= 255");
  const shares = Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    bytes: new Uint8Array(secretBytes.length),
  }));

  for (let byteIdx = 0; byteIdx < secretBytes.length; byteIdx++) {
    // Random degree-(k-1) polynomial with this byte as the constant term —
    // never derived from anything but crypto.getRandomValues.
    const coeffs = new Uint8Array(k);
    coeffs[0] = secretBytes[byteIdx];
    for (let c = 1; c < k; c++) coeffs[c] = crypto.getRandomValues(new Uint8Array(1))[0];

    for (const share of shares) {
      let y = 0;
      let xPow = 1;
      for (let c = 0; c < k; c++) {
        y ^= gfMul(coeffs[c], xPow);
        xPow = gfMul(xPow, share.index);
      }
      share.bytes[byteIdx] = y;
    }
  }
  return shares;
}

// Reconstructs the original secret from >= k shares via Lagrange
// interpolation at x=0, done independently per byte position. Any k
// *correct* shares reconstruct exactly; wrong/mismatched shares reconstruct
// to garbage bytes silently (Shamir's scheme has no built-in way to detect
// that) — callers must independently verify the result, which
// recoveryCodeToBytes()'s caller does for free by attempting the normal
// recovery-code unwrap (AES-GCM's auth tag fails closed on wrong input).
export function reconstructSecret(shares) {
  const k = shares.length;
  const length = shares[0].bytes.length;
  const secret = new Uint8Array(length);

  for (let byteIdx = 0; byteIdx < length; byteIdx++) {
    let result = 0;
    for (let i = 0; i < k; i++) {
      const xi = shares[i].index;
      const yi = shares[i].bytes[byteIdx];
      let numerator = 1;
      let denominator = 1;
      for (let j = 0; j < k; j++) {
        if (i === j) continue;
        const xj = shares[j].index;
        numerator = gfMul(numerator, xj);
        denominator = gfMul(denominator, xj ^ xi); // (xj - x) at x=0 is xj; GF subtraction is XOR
      }
      result ^= gfMul(yi, gfDiv(numerator, denominator));
    }
    secret[byteIdx] = result;
  }
  return secret;
}

// Share encoding: [k, index, ...32 secret-share bytes] -> dashed base32, the
// same visual format as a recovery code so it's transcribable the same way.
// Embedding k lets the reconstruction UI show "you have 2 of 3 needed"
// without the user having to remember or re-enter the threshold separately.
export function encodeShare(k, share) {
  const bytes = new Uint8Array(2 + share.bytes.length);
  bytes[0] = k;
  bytes[1] = share.index;
  bytes.set(share.bytes, 2);
  return formatAsDashedCode(bytes);
}

export function decodeShare(encoded) {
  const bytes = base32ToBytes(normalizeRecoveryCode(encoded));
  if (bytes.length < 3) throw new Error("Not a valid share — too short");
  return { k: bytes[0], share: { index: bytes[1], bytes: bytes.slice(2) } };
}

// ---------- tamper-evident history signing (Layer 2) ----------
// A per-device Ed25519 identity used only to sign local history-log entries
// (docs/ARCHITECTURE.md "Tamper-evident signed task history") — a distinct
// keypair from the DEK, so compromising one doesn't implicate the other.

export async function generateSigningKeypair() {
  // extractable: true so the private key can be exported once to wrap, same
  // pattern as generateDek().
  return crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
}

export async function exportSigningPublicKey(publicKey) {
  return crypto.subtle.exportKey("raw", publicKey);
}

export async function importSigningPublicKey(rawBytes) {
  return crypto.subtle.importKey("raw", rawBytes, { name: "Ed25519" }, false, ["verify"]);
}

// Wraps the private key's PKCS8 export under a KEK with AES-256-GCM, exactly
// like wrapDek/unwrapDek wrap the DEK — the private key is just opaque bytes
// to AES-GCM, whether they encode a symmetric key or an asymmetric one.
export async function wrapSigningKey(privateKey, kek) {
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", privateKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, kek, pkcs8);
  return { wrappedSigningKey: bufToBase64(wrapped), signingKeyWrapIv: bufToBase64(iv) };
}

export async function unwrapSigningKey(wrappedSigningKey, signingKeyWrapIv, kek) {
  const pkcs8 = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBuf(signingKeyWrapIv) },
    kek,
    base64ToBuf(wrappedSigningKey)
  );
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

export async function signBytes(privateKey, dataBytes) {
  return crypto.subtle.sign("Ed25519", privateKey, dataBytes);
}

export async function verifyBytes(publicKey, dataBytes, signatureBytes) {
  return crypto.subtle.verify("Ed25519", publicKey, signatureBytes, dataBytes);
}

// Hex, not base64: history entries are inspectable/exportable JSON meant to
// be eyeballed and diffed, where hex reads unambiguously at a glance.
export async function sha256Hex(dataBytes) {
  const digest = await crypto.subtle.digest("SHA-256", dataBytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
