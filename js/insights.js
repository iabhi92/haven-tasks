// Pure computation — no IO, no app.js state. Takes the in-memory decrypted
// task list already held by app.js and derives a snapshot of stats from it.
// See docs/ARCHITECTURE.md "On-device insights" for the honest scope note on
// why this is a snapshot, not a history-over-time view.

import { todayStr } from "./automation.js?v=20260808b";

export function computeInsights(tasks) {
  const real = tasks.filter((t) => !t.destructed); // a destructed placeholder has no real content to count
  const total = real.length;

  const byStatus = { todo: 0, "in-progress": 0, done: 0 };
  const byPriority = { low: 0, medium: 0, high: 0 };
  const byProjectCounts = {};
  const tagCounts = {};
  let overdue = 0;
  let subtasksTotal = 0;
  let subtasksDone = 0;
  let recurringCount = 0;
  const today = todayStr();

  for (const t of real) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    const project = t.project || "Inbox";
    byProjectCounts[project] = (byProjectCounts[project] || 0) + 1;
    for (const tag of t.tags || []) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    if (t.dueDate && t.dueDate < today && t.status !== "done") overdue++;
    if (t.subtasks && t.subtasks.length > 0) {
      subtasksTotal += t.subtasks.length;
      subtasksDone += t.subtasks.filter((s) => s.done).length;
    }
    if (t.recurrence) recurringCount++;
  }

  const byProject = Object.entries(byProjectCounts).sort((a, b) => b[1] - a[1]);
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const completionRate = total === 0 ? 0 : Math.round((byStatus.done / total) * 100);
  const subtaskCompletionRate = subtasksTotal === 0 ? null : Math.round((subtasksDone / subtasksTotal) * 100);

  return {
    total,
    byStatus,
    byPriority,
    byProject,
    topTags,
    overdue,
    completionRate,
    subtasksTotal,
    subtasksDone,
    subtaskCompletionRate,
    recurringCount,
  };
}
