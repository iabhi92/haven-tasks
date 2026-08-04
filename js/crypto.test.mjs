// Isolated unit tests for js/crypto.js against the vectors in
// docs/ARCHITECTURE.md §8. Run with: node js/crypto.test.mjs
// No test framework/build step — Node's native Web Crypto (globalThis.crypto)
// makes this runnable directly, same primitives the browser uses.

import assert from "node:assert/strict";
import {
  deriveKek,
  wrapDek,
  unwrapDek,
  importDek,
  encryptTask,
  decryptTask,
  generateRecoveryCode,
  normalizeRecoveryCode,
  bufToBase64Url,
  base64UrlToBuf,
  generateSigningKeypair,
  exportSigningPublicKey,
  importSigningPublicKey,
  wrapSigningKey,
  unwrapSigningKey,
  signBytes,
  verifyBytes,
  sha256Hex,
  recoveryCodeToBytes,
  bytesToRecoveryCode,
  splitSecret,
  reconstructSecret,
  encodeShare,
  decodeShare,
} from "./crypto.js";

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
}

function fixedBytes(length, fill) {
  return new Uint8Array(length).fill(fill);
}

// ---- 1. Round-trip ----
await test("1. round-trip: encrypt a known task, decrypt, deep-equals original", async () => {
  const dek = await importDek(fixedBytes(32, 7), true);
  const task = {
    id: "fixed-id-1",
    title: "Buy Mum a birthday gift",
    notes: "",
    status: "todo",
    priority: "high",
    dueDate: "2026-08-20",
    order: 3,
    createdAt: 1723800000000,
    updatedAt: 1723800000000,
  };
  const record = await encryptTask(task, dek);
  const decrypted = await decryptTask(record, dek);
  assert.deepEqual(decrypted, task);
});

// ---- 2. Wrap/unwrap ----
await test("2. wrap/unwrap: fixed passphrase+salt, wrap fixed DEK, unwrap equals original bytes", async () => {
  const salt = fixedBytes(16, 1);
  const kek = await deriveKek("correct horse battery staple", salt);
  const originalDekBytes = fixedBytes(32, 9);
  const dek = await importDek(originalDekBytes, true);

  const { wrappedDek, wrapIv } = await wrapDek(dek, kek);
  const unwrappedBytes = new Uint8Array(await unwrapDek(wrappedDek, wrapIv, kek));

  assert.deepEqual(unwrappedBytes, originalDekBytes);
});

// ---- 3. Wrong passphrase fails closed ----
await test("3. wrong passphrase fails closed: unwrap throws, never returns garbage", async () => {
  const salt = fixedBytes(16, 2);
  const rightKek = await deriveKek("the real passphrase", salt);
  const wrongKek = await deriveKek("a guessed passphrase", salt);
  const dek = await importDek(fixedBytes(32, 5), true);
  const { wrappedDek, wrapIv } = await wrapDek(dek, rightKek);

  await assert.rejects(() => unwrapDek(wrappedDek, wrapIv, wrongKek));
});

// ---- 4. IV uniqueness ----
await test("4. IV uniqueness: encrypting the same plaintext twice yields different ciphertext", async () => {
  const dek = await importDek(fixedBytes(32, 3), true);
  const task = { id: "same-task", title: "Same title every time" };

  const first = await encryptTask(task, dek);
  const second = await encryptTask(task, dek);

  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  // both must still decrypt correctly despite differing ciphertext
  assert.deepEqual(await decryptTask(first, dek), task);
  assert.deepEqual(await decryptTask(second, dek), task);
});

// ---- 5. Recovery path ----
await test("5. recovery path: wrap DEK under KEK_r, unwrap with recovery code, equals original", async () => {
  const recoveryCode = generateRecoveryCode();
  const saltRecovery = fixedBytes(16, 4);
  const kekR = await deriveKek(normalizeRecoveryCode(recoveryCode), saltRecovery);
  const originalDekBytes = fixedBytes(32, 11);
  const dek = await importDek(originalDekBytes, true);

  const { wrappedDek: wrappedDekRecovery, wrapIv: wrapIvRecovery } = await wrapDek(dek, kekR);

  // simulate the user re-typing the code later, formatted differently
  const reenteredCode = normalizeRecoveryCode(recoveryCode.toLowerCase().replace(/-/g, " "));
  const kekRAgain = await deriveKek(reenteredCode, saltRecovery);
  const unwrappedBytes = new Uint8Array(
    await unwrapDek(wrappedDekRecovery, wrapIvRecovery, kekRAgain)
  );

  assert.deepEqual(unwrappedBytes, originalDekBytes);
  // sanity-check the code shape itself: 32 bytes -> 52 base32 chars -> ten
  // 5-char groups plus one 2-char remainder group, dash-joined.
  assert.match(recoveryCode, /^([0-9A-Z]{5}-){9}[0-9A-Z]{5}-[0-9A-Z]{2}$/);
});

// ---- 6. Tamper detection ----
await test("6. tamper detection: flipping one ciphertext byte makes decryption throw", async () => {
  const dek = await importDek(fixedBytes(32, 6), true);
  const record = await encryptTask({ id: "t", title: "Tamper me" }, dek);

  const bytes = Buffer.from(record.ciphertext, "base64");
  bytes[0] ^= 0xff; // flip a byte
  const tampered = { ...record, ciphertext: bytes.toString("base64") };

  await assert.rejects(() => decryptTask(tampered, dek));
});

// ---- 7. Base64url round-trip (share-link fragment key encoding) ----
await test("7. base64url round-trip: encodes without +/=, decodes back to identical bytes", async () => {
  // 32 bytes of 0xff/0x00-heavy content is chosen to force + and / in
  // standard base64 output, so this actually exercises the substitution.
  const original = new Uint8Array(32);
  for (let i = 0; i < original.length; i++) original[i] = i % 2 === 0 ? 0xff : 0x00;

  const encoded = bufToBase64Url(original.buffer);
  assert.ok(!encoded.includes("+") && !encoded.includes("/") && !encoded.includes("="));

  const decoded = new Uint8Array(base64UrlToBuf(encoded));
  assert.deepEqual(decoded, original);
});

// ---- 8. History signing: keypair round-trip, wrap/unwrap, tamper detection ----
await test("8. history signing: generate, sign, verify with the exported raw public key", async () => {
  const { publicKey, privateKey } = await generateSigningKeypair();
  const data = new TextEncoder().encode(JSON.stringify({ taskId: "t1", op: "create" }));
  const signature = await signBytes(privateKey, data);

  const rawPub = await exportSigningPublicKey(publicKey);
  assert.equal(rawPub.byteLength, 32); // Ed25519 raw public keys are always 32 bytes

  const importedPub = await importSigningPublicKey(rawPub);
  const ok = await verifyBytes(importedPub, data, signature);
  assert.equal(ok, true);
});

await test("9. history signing: wrap/unwrap private key under a KEK, still signs identically", async () => {
  const salt = fixedBytes(16, 9);
  const kek = await deriveKek("a passphrase for the signing key test", salt);
  const { publicKey, privateKey } = await generateSigningKeypair();

  const { wrappedSigningKey, signingKeyWrapIv } = await wrapSigningKey(privateKey, kek);
  const unwrappedPrivateKey = await unwrapSigningKey(wrappedSigningKey, signingKeyWrapIv, kek);

  const data = new TextEncoder().encode("some canonical entry bytes");
  const signature = await signBytes(unwrappedPrivateKey, data);
  const rawPub = await exportSigningPublicKey(publicKey);
  const ok = await verifyBytes(await importSigningPublicKey(rawPub), data, signature);
  assert.equal(ok, true);
});

await test("10. history signing: wrong KEK fails closed unwrapping the private key", async () => {
  const salt = fixedBytes(16, 10);
  const kek = await deriveKek("correct passphrase", salt);
  const wrongKek = await deriveKek("wrong passphrase", salt);
  const { privateKey } = await generateSigningKeypair();
  const { wrappedSigningKey, signingKeyWrapIv } = await wrapSigningKey(privateKey, kek);

  await assert.rejects(() => unwrapSigningKey(wrappedSigningKey, signingKeyWrapIv, wrongKek));
});

await test("11. history signing: tampering with signed bytes makes verification fail", async () => {
  const { publicKey, privateKey } = await generateSigningKeypair();
  const data = new TextEncoder().encode("entry-1");
  const signature = await signBytes(privateKey, data);

  const tamperedData = new TextEncoder().encode("entry-2"); // attacker rewrote the entry
  const ok = await verifyBytes(publicKey, tamperedData, signature);
  assert.equal(ok, false); // must fail closed, not throw or silently pass
});

await test("12. sha256Hex: known test vector for the empty string", async () => {
  const hash = await sha256Hex(new Uint8Array(0));
  assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

// ---- 13. Shamir secret sharing: split/reconstruct round-trip on a real recovery code ----
await test("13. SSS: 3-of-5 split, any 3 shares reconstruct the exact original recovery code bytes", async () => {
  const code = generateRecoveryCode();
  const secret = recoveryCodeToBytes(normalizeRecoveryCode(code));
  assert.equal(secret.length, 32);

  const shares = splitSecret(secret, 3, 5);
  assert.equal(shares.length, 5);

  // three different 3-subsets, all must reconstruct identically
  const subsets = [
    [shares[0], shares[1], shares[2]],
    [shares[1], shares[3], shares[4]],
    [shares[0], shares[2], shares[4]],
  ];
  for (const subset of subsets) {
    const reconstructed = reconstructSecret(subset);
    assert.deepEqual(reconstructed, secret);
  }
});

await test("14. SSS: fewer than k shares reconstructs to the WRONG secret, never the right one", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const shares = splitSecret(secret, 3, 5);
  // only 2 of the required 3 — Lagrange interpolation with too few points
  // silently produces garbage rather than the real secret (Shamir's scheme
  // has no built-in way to detect this; the app layer must verify separately).
  const reconstructed = reconstructSecret([shares[0], shares[1]]);
  assert.notDeepEqual(reconstructed, secret);
});

await test("15. SSS: encodeShare/decodeShare round-trips k, index, and bytes exactly", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const shares = splitSecret(secret, 2, 4);
  for (const share of shares) {
    const encoded = encodeShare(2, share);
    assert.match(encoded, /^([0-9A-Z]{5}-){10}[0-9A-Z]{5}$/); // 34 bytes -> 55 chars -> 11 groups of 5
    const decoded = decodeShare(encoded);
    assert.equal(decoded.k, 2);
    assert.equal(decoded.share.index, share.index);
    assert.deepEqual(decoded.share.bytes, share.bytes);
  }
});

await test("16. SSS: k=n (all shares required) still reconstructs correctly", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const shares = splitSecret(secret, 4, 4);
  const reconstructed = reconstructSecret(shares);
  assert.deepEqual(reconstructed, secret);
});

await test("17. SSS: full round trip produces the IDENTICAL recovery code string, usable in the existing unlock flow", async () => {
  const originalCode = generateRecoveryCode();
  const secret = recoveryCodeToBytes(normalizeRecoveryCode(originalCode));
  const shares = splitSecret(secret, 3, 5);
  const reconstructedSecret = reconstructSecret([shares[1], shares[2], shares[4]]);
  const reconstructedCode = bytesToRecoveryCode(reconstructedSecret);
  assert.equal(reconstructedCode, originalCode);
});

// ---- report ----
let allPassed = true;
for (const r of results) {
  if (r.ok) {
    console.log(`PASS - ${r.name}`);
  } else {
    allPassed = false;
    console.log(`FAIL - ${r.name}`);
    console.log(`       ${r.error.message}`);
  }
}
console.log(allPassed ? "\nAll vectors passed." : "\nSOME VECTORS FAILED.");
process.exit(allPassed ? 0 : 1);
