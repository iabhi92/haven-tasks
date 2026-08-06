// Isolated unit tests for CSV parsing + task mapping (js/csv.js).
// Run with: node js/csv.test.mjs

import assert from "node:assert/strict";
import { parseCSV, csvRowToTask, parseCSVToTasks } from "./csv.js";

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
}

await test("1. parses a simple comma-delimited CSV into rows", async () => {
  const rows = parseCSV("a,b,c\n1,2,3");
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "2", "3"]]);
});

await test("2. handles a quoted field containing a comma", async () => {
  const rows = parseCSV('title,notes\n"Buy milk, eggs",fine');
  assert.deepEqual(rows[1], ["Buy milk, eggs", "fine"]);
});

await test("3. handles an escaped quote inside a quoted field", async () => {
  const rows = parseCSV('title\n"Say ""hi"" to John"');
  assert.deepEqual(rows[1], ['Say "hi" to John']);
});

await test("4. handles a quoted field containing a newline", async () => {
  const rows = parseCSV('title,notes\nTask,"line one\nline two"');
  assert.deepEqual(rows[1], ["Task", "line one\nline two"]);
});

await test("5. csvRowToTask returns null for a row with no title", async () => {
  assert.equal(csvRowToTask({ notes: "no title here" }), null);
  assert.equal(csvRowToTask({ title: "   " }), null);
});

await test("6. parseCSVToTasks maps common Todoist-style headers", async () => {
  const csv = "CONTENT,PRIORITY,DATE\nFinish report,4,2026-08-20";
  const tasks = parseCSVToTasks(csv);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Finish report");
  assert.equal(tasks[0].priority, "high");
  assert.equal(tasks[0].dueDate, "2026-08-20");
});

await test("7. parseCSVToTasks maps generic Title/Due Date/Tags headers", async () => {
  const csv = 'Title,Due Date,Tags,Notes\n"Call the vet","8/20/2026","health, urgent","Ask about vaccines"';
  const tasks = parseCSVToTasks(csv);
  assert.equal(tasks[0].title, "Call the vet");
  assert.equal(tasks[0].dueDate, "2026-08-20");
  assert.deepEqual(tasks[0].tags, ["health", "urgent"]);
  assert.equal(tasks[0].notes, "Ask about vaccines");
});

await test("8. unknown/unrecognized columns are ignored, not fatal", async () => {
  const csv = "TYPE,CONTENT,INDENT,AUTHOR\ntask,Do the thing,1,someone@example.com";
  const tasks = parseCSVToTasks(csv);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Do the thing");
});

await test("9. rows with no usable title are skipped, not crashed on", async () => {
  const csv = "Title,Notes\nReal task,ok\n,orphan note with no title";
  const tasks = parseCSVToTasks(csv);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "Real task");
});

await test("10. an unparseable due date is dropped (null), not guessed at", async () => {
  const csv = "Title,Due\nSome task,not a real date";
  const tasks = parseCSVToTasks(csv);
  assert.equal(tasks[0].dueDate, null);
});

await test("11. status aliases map completed/done/yes to Haven's 'done'", async () => {
  const csv = "Title,Completed\nA,true\nB,false";
  const tasks = parseCSVToTasks(csv);
  assert.equal(tasks[0].status, "done");
  assert.equal(tasks[1].status, "todo");
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
