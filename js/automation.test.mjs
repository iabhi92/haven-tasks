// Isolated unit tests for the pure automation-rule evaluator (js/automation.js).
// Run with: node js/automation.test.mjs

import assert from "node:assert/strict";
import { evaluateTask, applyAction } from "./automation.js";

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
}

function baseTask(overrides = {}) {
  return {
    id: "t1",
    title: "Some task",
    project: "Inbox",
    notes: "",
    status: "todo",
    priority: "medium",
    dueDate: null,
    tags: [],
    subtasks: [],
    recurrence: null,
    order: 0,
    createdAt: 1723800000000,
    updatedAt: 1723800000000,
    ...overrides,
  };
}

function rule(trigger, action, enabled = true) {
  return { id: "r1", trigger, action, enabled };
}

await test("1. onDone + addTag: fires when status is done, adds the tag", async () => {
  const task = baseTask({ status: "done" });
  const rules = [rule({ type: "onDone" }, { type: "addTag", value: "archived" })];
  const result = evaluateTask(rules, "onDone", task);
  assert.ok(result);
  assert.deepEqual(result.tags, ["archived"]);
});

await test("2. onDone: does not fire when status is not done", async () => {
  const task = baseTask({ status: "in-progress" });
  const rules = [rule({ type: "onDone" }, { type: "addTag", value: "archived" })];
  const result = evaluateTask(rules, "onDone", task);
  assert.equal(result, null);
});

await test("3. onOverdue: fires for a past due date on a non-done task", async () => {
  const task = baseTask({ dueDate: "2020-01-01", status: "todo" });
  const rules = [rule({ type: "onOverdue" }, { type: "setPriority", value: "high" })];
  const result = evaluateTask(rules, "onOverdue", task);
  assert.ok(result);
  assert.equal(result.priority, "high");
});

await test("4. onOverdue: does not fire for a done task even with a past due date", async () => {
  const task = baseTask({ dueDate: "2020-01-01", status: "done" });
  const rules = [rule({ type: "onOverdue" }, { type: "setPriority", value: "high" })];
  const result = evaluateTask(rules, "onOverdue", task);
  assert.equal(result, null);
});

await test("5. onOverdue: does not fire for a future due date", async () => {
  const task = baseTask({ dueDate: "2099-01-01", status: "todo" });
  const rules = [rule({ type: "onOverdue" }, { type: "setPriority", value: "high" })];
  const result = evaluateTask(rules, "onOverdue", task);
  assert.equal(result, null);
});

await test("6. onCreateWithTag: fires only when the created task already has the tag", async () => {
  const withTag = baseTask({ tags: ["urgent"] });
  const withoutTag = baseTask({ tags: ["someday"] });
  const rules = [rule({ type: "onCreateWithTag", tag: "urgent" }, { type: "setPriority", value: "high" })];
  assert.ok(evaluateTask(rules, "onCreateWithTag", withTag));
  assert.equal(evaluateTask(rules, "onCreateWithTag", withoutTag), null);
});

await test("7. disabled rules never fire", async () => {
  const task = baseTask({ status: "done" });
  const rules = [rule({ type: "onDone" }, { type: "addTag", value: "archived" }, false)];
  const result = evaluateTask(rules, "onDone", task);
  assert.equal(result, null);
});

await test("8. a rule's trigger.type only matches its own event", async () => {
  const task = baseTask({ status: "done", dueDate: "2020-01-01" });
  const rules = [rule({ type: "onOverdue" }, { type: "addTag", value: "late" })];
  // Evaluated as an "onDone" event — the onOverdue rule must not fire here,
  // even though the task also happens to satisfy an overdue condition.
  const result = evaluateTask(rules, "onDone", task);
  assert.equal(result, null);
});

await test("9. multiple rules for the same event apply in order, on top of each other", async () => {
  const task = baseTask({ status: "done" });
  const rules = [
    rule({ type: "onDone" }, { type: "addTag", value: "archived" }),
    rule({ type: "onDone" }, { type: "setPriority", value: "low" }),
  ];
  const result = evaluateTask(rules, "onDone", task);
  assert.ok(result);
  assert.deepEqual(result.tags, ["archived"]);
  assert.equal(result.priority, "low");
});

await test("10. addTag is idempotent — adding an already-present tag is a no-op, not a duplicate", async () => {
  const task = baseTask({ status: "done", tags: ["archived"] });
  const rules = [rule({ type: "onDone" }, { type: "addTag", value: "archived" })];
  const result = evaluateTask(rules, "onDone", task);
  // No actual change occurred (tag was already there), so the whole
  // evaluation should report "nothing changed", not a spurious update.
  assert.equal(result, null);
});

await test("11. removeTag removes only the matching tag", async () => {
  const result = applyAction(baseTask({ tags: ["a", "b", "c"] }), { type: "removeTag", value: "b" });
  assert.deepEqual(result.tags, ["a", "c"]);
});

await test("12. setStatus/setPriority reject invalid values rather than corrupting the field", async () => {
  const task = baseTask({ status: "todo", priority: "medium" });
  const badStatus = applyAction(task, { type: "setStatus", value: "not-a-real-status" });
  const badPriority = applyAction(task, { type: "setPriority", value: "not-a-real-priority" });
  assert.equal(badStatus.status, "todo");
  assert.equal(badPriority.priority, "medium");
});

await test("13. moveToProject sets the project field", async () => {
  const result = applyAction(baseTask({ project: "Inbox" }), { type: "moveToProject", value: "Work" });
  assert.equal(result.project, "Work");
});

await test("14. rules never chain: an onOverdue rule setting status to done does not also trigger an onDone rule in the same pass", async () => {
  const task = baseTask({ dueDate: "2020-01-01", status: "todo" });
  const rules = [
    rule({ type: "onOverdue" }, { type: "setStatus", value: "done" }),
    rule({ type: "onDone" }, { type: "addTag", value: "chained" }),
  ];
  // Only the onOverdue event is evaluated — the onDone rule must not also
  // run as a side effect within this same evaluateTask() call.
  const result = evaluateTask(rules, "onOverdue", task);
  assert.ok(result);
  assert.equal(result.status, "done");
  assert.equal((result.tags || []).includes("chained"), false);
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
