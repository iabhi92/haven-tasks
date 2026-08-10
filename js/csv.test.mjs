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

// ---- Real Todoist export shape: TYPE=section/task/note rows, INDENT-based nesting ----
// Based on Todoist's documented CSV export columns: TYPE,CONTENT,PRIORITY,INDENT,AUTHOR,
// RESPONSIBLE,DATE,DATE_LANG,TIMEZONE. A section row is a project divider, not a task; a note
// row is a comment on the task above it; INDENT > 1 is a sub-task of the nearest task above it.

const TODOIST_CSV = [
  "TYPE,CONTENT,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE",
  "section,Groceries,,,,,,,",
  "task,Buy milk,4,1,,,2026-08-20,en,",
  "task,2% milk,1,2,,,,,",
  "note,Get the organic kind,,,,,,,",
  "task,Buy eggs,1,1,,,,,",
  "section,Errands,,,,,,,",
  "task,Pick up dry cleaning,2,1,,,,,",
].join("\n");

await test("12. Todoist section rows become the task's project, not a task themselves", async () => {
  const tasks = parseCSVToTasks(TODOIST_CSV);
  assert.equal(tasks.some((t) => t.title === "Groceries" || t.title === "Errands"), false);
  assert.equal(tasks.find((t) => t.title === "Buy milk").project, "Groceries");
  assert.equal(tasks.find((t) => t.title === "Pick up dry cleaning").project, "Errands");
});

await test("13. Todoist note rows fold into the preceding task's notes, not a separate task", async () => {
  const tasks = parseCSVToTasks(TODOIST_CSV);
  assert.equal(tasks.some((t) => t.title === "Get the organic kind"), false);
  assert.equal(tasks.find((t) => t.title === "Buy milk").notes, "Get the organic kind");
});

await test("14. Todoist INDENT > 1 becomes a Haven subtask, not a separate top-level task", async () => {
  const tasks = parseCSVToTasks(TODOIST_CSV);
  assert.equal(tasks.some((t) => t.title === "2% milk"), false);
  const buyMilk = tasks.find((t) => t.title === "Buy milk");
  assert.equal(buyMilk.subtasks.length, 1);
  assert.equal(buyMilk.subtasks[0].title, "2% milk");
  assert.equal(buyMilk.subtasks[0].done, false);
});

await test("15. Todoist's inverted numeric priority (4=highest) still maps correctly", async () => {
  const tasks = parseCSVToTasks(TODOIST_CSV);
  assert.equal(tasks.find((t) => t.title === "Buy milk").priority, "high");
  assert.equal(tasks.find((t) => t.title === "Buy eggs").priority, "low");
});

await test("16. Todoist export produces exactly the 3 real top-level tasks, not 7 rows' worth", async () => {
  const tasks = parseCSVToTasks(TODOIST_CSV);
  assert.equal(tasks.length, 3);
});

// ---- Realistic Notion database export: standard flat CSV, checkbox/select-style values ----
const NOTION_CSV = [
  'Name,Status,Due Date,Priority,Tags',
  'Write proposal,Not started,2026-08-15,High,"Work, Urgent"',
  'Buy birthday gift,Done,,Low,Personal',
].join("\n");

await test("17. a realistic Notion export maps through the generic aliaser correctly", async () => {
  const tasks = parseCSVToTasks(NOTION_CSV);
  assert.equal(tasks.length, 2);
  const proposal = tasks.find((t) => t.title === "Write proposal");
  assert.equal(proposal.status, "todo"); // "Not started" isn't a done/in-progress alias
  assert.equal(proposal.dueDate, "2026-08-15");
  assert.equal(proposal.priority, "high");
  assert.deepEqual(proposal.tags, ["Work", "Urgent"]);
  const gift = tasks.find((t) => t.title === "Buy birthday gift");
  assert.equal(gift.status, "done");
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
