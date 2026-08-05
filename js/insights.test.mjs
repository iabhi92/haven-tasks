// Isolated unit tests for the pure insights computation (js/insights.js).
// Run with: node js/insights.test.mjs

import assert from "node:assert/strict";
import { computeInsights } from "./insights.js";

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
    id: "t",
    title: "task",
    project: "Inbox",
    notes: "",
    status: "todo",
    priority: "medium",
    dueDate: null,
    tags: [],
    subtasks: [],
    recurrence: null,
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

await test("1. empty list: everything zeroed, no division-by-zero crash", async () => {
  const stats = computeInsights([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.completionRate, 0);
  assert.equal(stats.subtaskCompletionRate, null);
});

await test("2. counts by status/priority correctly", async () => {
  const stats = computeInsights([
    task({ status: "todo", priority: "high" }),
    task({ status: "done", priority: "high" }),
    task({ status: "done", priority: "low" }),
  ]);
  assert.deepEqual(stats.byStatus, { todo: 1, "in-progress": 0, done: 2 });
  assert.deepEqual(stats.byPriority, { low: 1, medium: 0, high: 2 });
  assert.equal(stats.completionRate, 67); // 2/3 rounded
});

await test("3. destructed placeholders are excluded from every stat", async () => {
  const stats = computeInsights([
    task({ status: "todo" }),
    task({ status: "done", destructed: true }), // should not be counted at all
  ]);
  assert.equal(stats.total, 1);
  assert.equal(stats.byStatus.done, 0);
});

await test("4. overdue: past due date + not done counts, done does not, future does not", async () => {
  const stats = computeInsights([
    task({ dueDate: "2020-01-01", status: "todo" }),
    task({ dueDate: "2020-01-01", status: "done" }),
    task({ dueDate: "2099-01-01", status: "todo" }),
    task({ dueDate: null, status: "todo" }),
  ]);
  assert.equal(stats.overdue, 1);
});

await test("5. projects are counted and sorted by frequency, descending", async () => {
  const stats = computeInsights([
    task({ project: "Work" }),
    task({ project: "Work" }),
    task({ project: "Personal" }),
  ]);
  assert.deepEqual(stats.byProject[0], ["Work", 2]);
  assert.deepEqual(stats.byProject[1], ["Personal", 1]);
});

await test("6. tags are counted, sorted, and capped at 10", async () => {
  const tasks = [];
  for (let i = 0; i < 15; i++) tasks.push(task({ tags: [`tag${i}`] }));
  tasks.push(task({ tags: ["tag0"] })); // tag0 now appears twice, should sort first
  const stats = computeInsights(tasks);
  assert.equal(stats.topTags.length, 10);
  assert.deepEqual(stats.topTags[0], ["tag0", 2]);
});

await test("7. subtask completion rate across all tasks combined, not per-task averaged", async () => {
  const stats = computeInsights([
    task({ subtasks: [{ id: "a", title: "x", done: true }, { id: "b", title: "y", done: false }] }),
    task({ subtasks: [{ id: "c", title: "z", done: true }] }),
  ]);
  assert.equal(stats.subtasksTotal, 3);
  assert.equal(stats.subtasksDone, 2);
  assert.equal(stats.subtaskCompletionRate, 67); // 2/3 rounded
});

await test("8. recurring task count only counts tasks with a recurrence set", async () => {
  const stats = computeInsights([task({ recurrence: "daily" }), task({ recurrence: null }), task({ recurrence: "weekly" })]);
  assert.equal(stats.recurringCount, 2);
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
