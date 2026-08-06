// Isolated unit tests for iCalendar generation (js/ical.js).
// Run with: node js/ical.test.mjs

import assert from "node:assert/strict";
import { generateICS } from "./ical.js";

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
}

function task(overrides = {}) {
  return {
    id: "abc-123",
    title: "Task",
    notes: "",
    status: "todo",
    priority: "medium",
    dueDate: "2026-08-20",
    updatedAt: 1723800000000,
    ...overrides,
  };
}

await test("1. produces a well-formed VCALENDAR wrapper", async () => {
  const ics = generateICS([]);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.trim().endsWith("END:VCALENDAR"));
  assert.ok(ics.includes("VERSION:2.0"));
});

await test("2. tasks without a due date are skipped entirely", async () => {
  const ics = generateICS([task({ dueDate: null })]);
  assert.equal(ics.includes("BEGIN:VEVENT"), false);
});

await test("3. destructed placeholders are skipped even if they somehow carry a due date", async () => {
  const ics = generateICS([task({ destructed: true })]);
  assert.equal(ics.includes("BEGIN:VEVENT"), false);
});

await test("4. a real task produces one VEVENT with the right date format", async () => {
  const ics = generateICS([task({ dueDate: "2026-08-20" })]);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20260820"));
});

await test("5. done tasks map to STATUS:COMPLETED, others to NEEDS-ACTION", async () => {
  const doneIcs = generateICS([task({ status: "done" })]);
  const todoIcs = generateICS([task({ status: "todo" })]);
  assert.ok(doneIcs.includes("STATUS:COMPLETED"));
  assert.ok(todoIcs.includes("STATUS:NEEDS-ACTION"));
});

await test("6. special characters in title/notes are escaped per RFC 5545", async () => {
  const ics = generateICS([task({ title: "Call John; discuss, review\nfollow-up", notes: "" })]);
  assert.ok(ics.includes("Call John\\; discuss\\, review\\nfollow-up"));
});

await test("7. multiple tasks produce multiple VEVENTs", async () => {
  const ics = generateICS([task({ id: "a" }), task({ id: "b" }), task({ dueDate: null })]);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
});

await test("8. a very long title is folded at 75 octets per line, not left unfolded", async () => {
  const longTitle = "x".repeat(200);
  const ics = generateICS([task({ title: longTitle })]);
  const summaryLine = ics.split("\r\n").find((l) => l.startsWith("SUMMARY:"));
  assert.ok(summaryLine.length <= 75);
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
