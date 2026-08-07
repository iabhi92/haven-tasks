// Pure evaluator — no IO, no app.js module state, so it's independently
// testable and app.js stays the only place that decides what to persist and
// when. See docs/ARCHITECTURE.md "Local automation rules".
//
// Rule shape: { id, trigger: {type, tag?}, action: {type, value}, enabled }
// trigger.type: "onDone" | "onOverdue" | "onCreateWithTag"
// action.type: "addTag" | "removeTag" | "setPriority" | "setStatus" | "moveToProject"
//
// Deliberately no rule chaining: evaluateTask() is called once per event by
// app.js, against the rules whose trigger.type matches that event, and the
// result is persisted directly — it is never fed back in as a new event for
// the same or another rule to react to. Without that boundary, two rules
// could trigger each other indefinitely (rule A sets status to done, which
// rule B's onDone trigger reacts to, which changes something rule A's own
// trigger cares about, forever). A boring, finite evaluation model beats an
// engine that can loop.

const TODAY_ISO_LENGTH = 10; // "YYYY-MM-DD"

export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// `originalTask` is the task as it was *before* any rule in this pass
// touched it — onCreateWithTag checks tags at creation time, not tags a
// still-earlier rule in the same pass might have just added or removed.
function ruleConditionMet(rule, originalTask, currentTask) {
  const t = rule.trigger;
  if (t.type === "onCreateWithTag") {
    return (originalTask.tags || []).includes(t.tag);
  }
  if (t.type === "onDone") {
    return currentTask.status === "done";
  }
  if (t.type === "onOverdue") {
    return (
      !!currentTask.dueDate &&
      currentTask.dueDate.slice(0, TODAY_ISO_LENGTH) < todayStr() &&
      currentTask.status !== "done"
    );
  }
  return false;
}

export function applyAction(task, action) {
  const next = { ...task, tags: [...(task.tags || [])] };
  switch (action.type) {
    case "addTag":
      if (action.value && !next.tags.includes(action.value)) next.tags.push(action.value);
      break;
    case "removeTag":
      next.tags = next.tags.filter((tag) => tag !== action.value);
      break;
    case "setPriority":
      if (["low", "medium", "high"].includes(action.value)) next.priority = action.value;
      break;
    case "setStatus":
      if (["todo", "in-progress", "done"].includes(action.value)) next.status = action.value;
      break;
    case "moveToProject":
      if (action.value) next.project = action.value;
      break;
  }
  return next;
}

// Runs every enabled rule whose trigger.type === eventType against one task,
// applying actions in rule order. Returns the updated task, or null if
// nothing actually changed (so callers can skip a no-op persist/history
// entry) — compares by value, not reference, since applyAction() always
// returns a fresh object even when the value ends up identical (e.g. adding
// a tag that's already present).
export function evaluateTask(rules, eventType, task) {
  const originalTask = task;
  let current = task;
  let changed = false;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.trigger.type !== eventType) continue;
    if (!ruleConditionMet(rule, originalTask, current)) continue;
    const next = applyAction(current, rule.action);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next;
      changed = true;
    }
  }
  return changed ? current : null;
}
