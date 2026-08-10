#!/usr/bin/env node
// Independently re-verifies a sync server's deletion log — the same "provable, not just
// promised" pattern as scripts/verify-transparency-log.mjs, applied to server-side data deletion
// instead of code deploys. Fetches GET /deletion-log from the given server and recomputes every
// entry's hash from scratch, exactly the way server/storage.py's _append_deletion_log_entry()
// computed it originally, so this never has to trust the server's own arithmetic.
//
// Usage:
//   node scripts/verify-deletion-log.mjs [serverUrl] [--iv <iv> --ciphertext <ciphertext>]
//
// The optional --iv/--ciphertext pair lets you prove your OWN deletion is in the log: only
// someone who held the original iv/ciphertext (i.e. actually created that share) can compute the
// matching ciphertextHash, so finding it in the log is proof this specific content was deleted —
// the log itself never stores or reveals either value, only their hash.

import { createHash } from "node:crypto";

const DEFAULT_SERVER = "https://haven-sync.onrender.com";

function sha256Hex(str) {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

// Must match server/storage.py's json.dumps(obj, sort_keys=True, separators=(",", ":")) byte for
// byte, or every recomputed hash would mismatch regardless of whether the log is actually intact.
function canonicalJson(obj) {
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return JSON.stringify(sorted);
}

const args = process.argv.slice(2);
const server = args.find((a) => !a.startsWith("--")) || DEFAULT_SERVER;
const ivIndex = args.indexOf("--iv");
const ciphertextIndex = args.indexOf("--ciphertext");
const targetIv = ivIndex !== -1 ? args[ivIndex + 1] : null;
const targetCiphertext = ciphertextIndex !== -1 ? args[ciphertextIndex + 1] : null;

const res = await fetch(`${server.replace(/\/$/, "")}/deletion-log`);
if (!res.ok) {
  console.error(`Couldn't fetch the deletion log: HTTP ${res.status}`);
  process.exit(1);
}
const { entries } = await res.json();

let prevEntryHash = "GENESIS";
let ok = true;
for (const entry of entries) {
  const { entryHash, ...rest } = entry;
  const recomputed = sha256Hex(canonicalJson(rest));
  const hashOk = recomputed === entryHash;
  const linkOk = rest.prevEntryHash === prevEntryHash;
  if (!hashOk || !linkOk) {
    ok = false;
    console.error(`entry #${entry.sequence}: ${!hashOk ? "entryHash mismatch" : ""} ${!linkOk ? "prevEntryHash doesn't match previous entry" : ""}`.trim());
  } else {
    console.log(`entry #${entry.sequence}: OK (deleted ${new Date(entry.deletedAt).toISOString()})`);
  }
  prevEntryHash = entryHash;
}

if (!ok) {
  console.error("\nChain verification FAILED.");
  process.exit(1);
}
console.log(`\nChain verification OK — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, all links intact.`);

if (targetIv && targetCiphertext) {
  const targetHash = sha256Hex(targetIv + targetCiphertext);
  const match = entries.find((e) => e.ciphertextHash === targetHash);
  if (match) {
    console.log(`\nFound it: your deletion is entry #${match.sequence}, logged at ${new Date(match.deletedAt).toISOString()}.`);
  } else {
    console.log("\nNo entry in this log matches that iv/ciphertext — either it hasn't been deleted, or this isn't the server it was deleted from.");
  }
}
