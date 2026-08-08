// Isolated unit tests for pure helpers in js/ui.js (relativeTime, parseTagsInput).
// Run with: node js/ui.test.mjs

import assert from "node:assert/strict";
import { relativeTime, parseTagsInput } from "./ui.js";

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

await test("relativeTime: under 60s is 'just now'", () => {
  assert.equal(relativeTime(Date.now() - 30 * SEC), "just now");
});

await test("relativeTime: 5 minutes ago", () => {
  assert.equal(relativeTime(Date.now() - 5 * MIN), "5 minutes ago");
});

await test("relativeTime: 59:59 promotes to '1 hour ago', not '60 minutes ago'", () => {
  // The exact boundary that was buggy: rounding 3599s/60 = 60 landed in the
  // minute bucket instead of promoting to the hour bucket.
  assert.equal(relativeTime(Date.now() - (3600 * SEC - 1)), "1 hour ago");
});

await test("relativeTime: 2 hours ago", () => {
  assert.equal(relativeTime(Date.now() - 2 * HOUR), "2 hours ago");
});

await test("relativeTime: 23:59:59 promotes to 'yesterday', not '24 hours ago'", () => {
  // numeric: "auto" renders day=-1 as the word "yesterday", not "1 day ago" —
  // the point of this vector is the boundary promotion out of the hour
  // bucket, not the exact wording.
  assert.equal(relativeTime(Date.now() - (DAY - 1)), "yesterday");
});

await test("relativeTime: 3 days ago", () => {
  assert.equal(relativeTime(Date.now() - 3 * DAY), "3 days ago");
});

await test("relativeTime: 6+ days falls back to an absolute date", () => {
  const ms = Date.now() - 10 * DAY;
  const result = relativeTime(ms);
  assert.equal(result, new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
});

await test("relativeTime: future timestamp reads 'in N minutes'", () => {
  assert.equal(relativeTime(Date.now() + 5 * MIN), "in 5 minutes");
});

await test("parseTagsInput: trims, dedupes, drops empties, preserves order", () => {
  assert.deepEqual(parseTagsInput("design,  review, design, , work "), ["design", "review", "work"]);
});

await test("parseTagsInput: empty string yields no tags", () => {
  assert.deepEqual(parseTagsInput(""), []);
});

await test("parseTagsInput: no commas is a single tag", () => {
  assert.deepEqual(parseTagsInput("solo"), ["solo"]);
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
