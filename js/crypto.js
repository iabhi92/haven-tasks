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

// 32 random bytes (256 bits) via crypto.getRandomValues — never Math.random().
export function generateRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = bytesToBase32(bytes);
  return raw.match(/.{1,5}/g).join("-");
}

// Recovery codes are entered by hand — normalize case/formatting before using
// as KDF input so "abcd-efgh" and "ABCDEFGH" derive the same key.
export function normalizeRecoveryCode(code) {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}
