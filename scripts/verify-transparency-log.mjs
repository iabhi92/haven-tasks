#!/usr/bin/env node
// Independently re-verifies transparency-log.json's hash chain -- the same check
// transparency.html runs client-side, as a Node CLI for anyone who'd rather not trust the page's
// own JS to grade its own homework. Exits non-zero on the first broken link.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha384(str) {
  return "sha384-" + createHash("sha384").update(str).digest("base64");
}

const { entries } = JSON.parse(readFileSync(join(ROOT, "transparency-log.json"), "utf8"));

let prevHash = null;
let ok = true;
for (const entry of entries) {
  const { entryHash, ...rest } = entry;
  const recomputed = sha384(JSON.stringify(rest));
  const hashOk = recomputed === entryHash;
  const linkOk = rest.prevEntryHash === prevHash;
  if (!hashOk || !linkOk) {
    ok = false;
    console.error(`entry #${entry.sequence}: ${!hashOk ? "entryHash mismatch" : ""} ${!linkOk ? "prevEntryHash doesn't match previous entry" : ""}`.trim());
  } else {
    console.log(`entry #${entry.sequence}: OK (${entry.gitCommit.slice(0, 12)}, ${entry.timestamp})`);
  }
  prevHash = entryHash;
}

if (!ok) {
  console.error("\nChain verification FAILED.");
  process.exit(1);
}
console.log(`\nChain verification OK -- ${entries.length} entr${entries.length === 1 ? "y" : "ies"}, all links intact.`);
