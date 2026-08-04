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
