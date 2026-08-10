#!/usr/bin/env node
// Independently verifies a redacted task certificate produced by exportTaskCertificate()
// (js/app.js, docs/ARCHITECTURE.md §5e-2/"Selective Merkle-inclusion proofs") — no Haven install
// needed, just this file and Node's own Web Crypto. Checks two separate claims:
//   1. The envelope (task fields + Merkle proof metadata) is signed by the embedded Ed25519 key,
//      unaltered since signing.
//   2. If a Merkle proof is present, that its leaf genuinely combines with its sibling path to the
//      claimed root — proof a specific history-log entry for this task is included in the vault's
//      tamper-evident log, without ever seeing any other entry.
// These are NOT cryptographically fused into one claim: the signature vouches for the task fields
// and the proof metadata as a package; the Merkle proof itself only vouches for chain inclusion.
// Said plainly in the output, not glossed over.
//
// Usage: node scripts/verify-task-certificate.mjs <path-to-certificate.json>
//
// Post-quantum signature (pqSignature/pqPublicKey, present when the exporting vault had an
// ML-DSA-87 identity active) is reported as present/absent but NOT deep-verified here — that
// needs the vendored noble-post-quantum library this standalone script deliberately doesn't pull
// in, to keep it a single, dependency-free file anyone can read top to bottom before running.
// Verify the PQ signature via the Haven app itself (import the file, check the reported status)
// if that matters for your use case.

import { readFileSync } from "node:fs";

function base64ToBuf(b64) {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function sha256Hex(dataBytes) {
  const digest = await crypto.subtle.digest("SHA-256", dataBytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function merkleParentHash(leftHex, rightHex) {
  return sha256Hex(new TextEncoder().encode(leftHex + rightHex));
}

async function verifyMerkleProof(leafHash, proof, root) {
  let hash = leafHash;
  for (const step of proof) {
    hash = step.position === "left" ? await merkleParentHash(step.hash, hash) : await merkleParentHash(hash, step.hash);
  }
  return hash === root;
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: node scripts/verify-task-certificate.mjs <path-to-certificate.json>");
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(filePath, "utf8"));

if (parsed.kind !== "task-certificate") {
  console.error(`Not a task certificate (kind: ${parsed.kind ?? "(missing)"})`);
  process.exit(1);
}
if (!parsed.signature || !parsed.publicKey) {
  console.error("No signature/publicKey present — this file was exported without an active signing identity and can't be verified.");
  process.exit(1);
}

// Destructuring + rest preserves the remaining keys' original order — the same trick
// verifyBackupSignature() in js/app.js uses, required because canonicalBytes() there is plain
// JSON.stringify() (insertion-order), not a sorted-keys canonicalization. Re-deriving the exact
// bytes that were signed means reproducing that exact key order, not just the same key set.
const { signature, pqSignature, pqPublicKey, ...withKey } = parsed;
const signedBytes = new TextEncoder().encode(JSON.stringify(withKey));

let signatureOk = false;
try {
  const publicKey = await crypto.subtle.importKey("raw", base64ToBuf(parsed.publicKey), { name: "Ed25519" }, false, ["verify"]);
  signatureOk = await crypto.subtle.verify("Ed25519", publicKey, base64ToBuf(signature), signedBytes);
} catch (err) {
  console.error(`Signature check errored: ${err.message}`);
}
console.log(`Ed25519 signature: ${signatureOk ? "VALID" : "INVALID"}`);
console.log(`Post-quantum signature: ${pqSignature ? "present (not deep-verified by this script — see header comment)" : "not present in this certificate"}`);

let merkleOk = null;
if (parsed.merkleProof) {
  const { root, leafHash, proof, entryOp, entryTimestamp, leafCount } = parsed.merkleProof;
  merkleOk = await verifyMerkleProof(leafHash, proof, root);
  console.log(`\nMerkle inclusion proof: ${merkleOk ? "VALID" : "INVALID"}`);
  console.log(`  Proves a history-log entry (op: "${entryOp}", recorded ${new Date(entryTimestamp).toISOString()}) is included`);
  console.log(`  among ${leafCount} entries in the vault's tamper-evident log, without revealing any of the others.`);
} else {
  console.log("\nNo Merkle proof present in this certificate (the task had no history-log entry at export time).");
}

console.log(`\nTask: "${parsed.task.title}" (${parsed.task.status}), exported ${new Date(parsed.exportedAt).toISOString()}`);

const overallOk = signatureOk && merkleOk !== false;
console.log(`\n${overallOk ? "Overall: PASSED" : "Overall: FAILED"} — treat the certificate's task content as ${overallOk ? "authentic and unaltered since signing" : "UNTRUSTED"}.`);
process.exit(overallOk ? 0 : 1);
