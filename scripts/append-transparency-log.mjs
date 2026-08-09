#!/usr/bin/env node
// Appends one entry to transparency-log.json: a hash-chained, append-only record of every
// production deploy's asset manifest (integrity.json), so a third party can verify what code
// has ever been live, not just what's live right now. Run this as the last step before every
// `wrangler deploy` -- see CLAUDE.md's deploy process.
//
// Honest scope note (also in docs/THREAT_MODEL.md): this log is self-hosted, git-committed and
// deployed alongside the rest of the site. It proves the deploy history is internally
// consistent -- no entry can be altered without breaking every entryHash after it -- but a host
// that could tamper with the live site could in principle also serve a tampered version of this
// log consistently to itself. Real protection needs an independent third party who fetches and
// archives entries over time, the same reason real Certificate Transparency needs multiple
// independent log operators, not one.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(ROOT, "transparency-log.json");

function sha384(str) {
  return "sha384-" + createHash("sha384").update(str).digest("base64");
}

const integrity = JSON.parse(readFileSync(join(ROOT, "integrity.json"), "utf8"));
const manifestHash = sha384(JSON.stringify(integrity.files));
const gitCommit = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();

const log = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { entries: [] };
const prev = log.entries.length ? log.entries[log.entries.length - 1] : null;

const entry = {
  sequence: prev ? prev.sequence + 1 : 1,
  timestamp: new Date().toISOString(),
  gitCommit,
  manifestHash,
  prevEntryHash: prev ? prev.entryHash : null,
};
// entryHash covers every field above -- computed last, deliberately not included in its own
// input, since it's the value that chains this entry to the ones after it.
entry.entryHash = sha384(JSON.stringify(entry));

log.entries.push(entry);
writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + "\n");

console.log(`Appended entry #${entry.sequence} to transparency-log.json`);
console.log(`  gitCommit:    ${gitCommit}`);
console.log(`  manifestHash: ${manifestHash}`);
console.log(`  entryHash:    ${entry.entryHash}`);
