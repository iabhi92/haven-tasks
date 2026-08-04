// Rendering only. Never uses innerHTML for task-derived content — textContent or
// element properties only, so a task title/notes can never execute as markup.

const STATUS_LABEL = { todo: "To Do", "in-progress": "In Progress", done: "Done" };
const PRIORITY_LABEL = { low: "Low", medium: "Medium", high: "High" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dueBadgeInfo(dueDate) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + "T00:00:00");
  const diffDays = Math.round((due - today) / 86400000);

  let cls = "badge-due";
  let label = due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (diffDays < 0) { cls += " is-overdue"; }
  else if (diffDays === 0) { cls += " is-today"; label = "Today"; }
  return { cls, label };
}

function priorityBadge(priority) {
  const badge = el("span", `badge badge-priority-${priority}`, PRIORITY_LABEL[priority] || priority);
  return badge;
}

function subtaskProgressBadge(subtasks) {
  if (!subtasks || subtasks.length === 0) return null;
  const done = subtasks.filter((s) => s.done).length;
  const badge = el("span", "task-subtask-progress");
  const icon = el("span", "", "☑");
  const count = el("span", "", `${done}/${subtasks.length}`);
  badge.appendChild(icon);
  badge.appendChild(count);
  return badge;
}

function recurrenceBadge(recurrence) {
  if (!recurrence) return null;
  const label = recurrence.charAt(0).toUpperCase() + recurrence.slice(1);
  return el("span", "task-recurrence", `↻ ${label}`);
}

function tagChips(tags) {
  if (!tags || tags.length === 0) return null;
  const wrap = el("div", "task-tags");
  for (const tag of tags) {
    wrap.appendChild(el("span", "tag-chip", tag));
  }
  return wrap;
}

function dueBadge(dueDate) {
  const info = dueBadgeInfo(dueDate);
  if (!info) return null;
  return el("span", info.cls, info.label);
}

export function createTaskCard(task, { onOpen, onDragStart, onDragEnd, selectionMode, selectedIds, onToggleSelect }) {
  const selected = !!(selectedIds && selectedIds.has(task.id));
  const card = el("div", "task-card" + (task.status === "done" ? " is-done" : "") + (selected ? " is-selected" : ""));
  card.draggable = !selectionMode;
  card.dataset.id = task.id;
  card.setAttribute("role", "listitem");
  card.tabIndex = 0;

  if (selectionMode) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "task-select-checkbox";
    checkbox.checked = !!selected;
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => onToggleSelect(task.id));
    card.appendChild(checkbox);
  }

  card.appendChild(el("h3", "task-title", task.title));
  if (task.notes) {
    card.appendChild(el("p", "task-notes", task.notes));
  }

  const meta = el("div", "task-meta");
  meta.appendChild(priorityBadge(task.priority));
  const due = dueBadge(task.dueDate);
  if (due) meta.appendChild(due);
  const progress = subtaskProgressBadge(task.subtasks);
  if (progress) meta.appendChild(progress);
  const recurrence = recurrenceBadge(task.recurrence);
  if (recurrence) meta.appendChild(recurrence);
  card.appendChild(meta);

  const tags = tagChips(task.tags);
  if (tags) card.appendChild(tags);

  card.addEventListener("click", () => (selectionMode ? onToggleSelect(task.id) : onOpen(task)));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (selectionMode ? onToggleSelect(task.id) : onOpen(task));
  });
  card.addEventListener("dragstart", (e) => {
    card.classList.add("is-dragging");
    e.dataTransfer.setData("text/plain", task.id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart && onDragStart(task);
  });
  card.addEventListener("dragend", () => {
    card.classList.remove("is-dragging");
    onDragEnd && onDragEnd(task);
  });

  return card;
}

export function createListRow(task, { onOpen, onDelete, selectionMode, selectedIds, onToggleSelect }) {
  const selected = !!(selectedIds && selectedIds.has(task.id));
  const row = el("div", "list-row" + (task.status === "done" ? " is-done" : "") + (selected ? " is-selected" : ""));
  row.dataset.id = task.id;

  const titleCell = el("span", "list-row-title-cell");
  const titleRow = el("span", "list-row-title-row");
  if (selectionMode) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "list-row-select-checkbox";
    checkbox.checked = !!selected;
    checkbox.addEventListener("click", (e) => e.stopPropagation());
    checkbox.addEventListener("change", () => onToggleSelect(task.id));
    titleRow.appendChild(checkbox);
  }
  titleRow.appendChild(el("span", "list-row-title", task.title));
  const progress = subtaskProgressBadge(task.subtasks);
  if (progress) titleRow.appendChild(progress);
  const recurrence = recurrenceBadge(task.recurrence);
  if (recurrence) titleRow.appendChild(recurrence);
  titleCell.appendChild(titleRow);
  const tags = tagChips(task.tags);
  if (tags) titleCell.appendChild(tags);
  row.appendChild(titleCell);

  const status = el("span", `badge badge-status-${task.status}`, STATUS_LABEL[task.status] || task.status);
  row.appendChild(status);

  row.appendChild(priorityBadge(task.priority));

  const due = dueBadge(task.dueDate);
  const dueSlot = el("span", "");
  if (due) dueSlot.appendChild(due);
  row.appendChild(dueSlot);

  const actions = el("span", "list-row-actions");
  const delBtn = el("button", "list-row-delete", "Delete");
  delBtn.type = "button";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    onDelete(task);
  });
  actions.appendChild(delBtn);
  row.appendChild(actions);

  row.addEventListener("click", () => (selectionMode ? onToggleSelect(task.id) : onOpen(task)));
  return row;
}

export function renderBoard(tasksByStatus, handlers) {
  for (const status of Object.keys(STATUS_LABEL)) {
    const col = document.getElementById(`col-${status}`);
    const countEl = document.getElementById(`count-${status}`);
    col.textContent = "";
    const tasks = tasksByStatus[status] || [];
    countEl.textContent = String(tasks.length);
    if (tasks.length === 0) {
      // Columns no longer have a background box, so an empty one needs a visible
      // anchor — otherwise there's nothing marking it as a drop target at rest.
      col.appendChild(el("div", "board-col-empty", "No tasks"));
    }
    for (const task of tasks) {
      col.appendChild(createTaskCard(task, handlers));
    }
  }
}

export function renderList(tasks, handlers) {
  const body = document.getElementById("listBody");
  body.textContent = "";
  for (const task of tasks) {
    body.appendChild(createListRow(task, handlers));
  }
}

const VIEW_PANEL_IDS = { board: "boardView", list: "listView", reveal: "revealView", history: "historyView" };
const VIEW_BTN_IDS = { board: "viewBoardBtn", list: "viewListBtn", reveal: "viewRevealBtn", history: "viewHistoryBtn" };

export function setView(view) {
  for (const key of Object.keys(VIEW_PANEL_IDS)) {
    const isActive = key === view;
    document.getElementById(VIEW_PANEL_IDS[key]).hidden = !isActive;
    const btn = document.getElementById(VIEW_BTN_IDS[key]);
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  }
}

function hideAllViewPanels() {
  for (const id of Object.values(VIEW_PANEL_IDS)) {
    document.getElementById(id).hidden = true;
  }
}

export function setEmptyState({ hasAnyTasks, hasVisibleTasks, view }) {
  const empty = document.getElementById("emptyState");
  const noResults = document.getElementById("noResultsState");

  // The reveal and history pages don't depend on whether any real tasks exist —
  // both must stay reachable even on a genuinely empty board.
  if (view === "reveal" || view === "history") {
    empty.hidden = true;
    noResults.hidden = true;
    setView(view);
    return;
  }

  if (!hasAnyTasks) {
    empty.hidden = false;
    noResults.hidden = true;
    hideAllViewPanels();
    return;
  }

  if (!hasVisibleTasks) {
    empty.hidden = true;
    noResults.hidden = false;
    hideAllViewPanels();
    return;
  }

  empty.hidden = true;
  noResults.hidden = true;
  setView(view);
}

// Tags are stored as a plain string[] on the task object (same encrypted envelope,
// no separate tag entity) — freeform, deduped, order-preserved, empty strings dropped.
function parseTagsInput(value) {
  const seen = new Set();
  const tags = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

// Subtasks are managed as live draft state in app.js (not a simple form field
// read on submit), since add/remove/toggle need to update the modal immediately.
// This is the pure render step: draw whatever list app.js currently holds.
export function renderSubtaskList(containerId, subtasks, { onToggle, onRemove }) {
  const container = document.getElementById(containerId);
  container.textContent = "";
  for (const subtask of subtasks) {
    const row = el("div", "subtask-row" + (subtask.done ? " is-done" : ""));
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = subtask.done;
    checkbox.addEventListener("change", () => onToggle(subtask.id));
    row.appendChild(checkbox);
    row.appendChild(el("span", "subtask-row-title", subtask.title));
    const removeBtn = el("button", "subtask-row-remove", "×");
    removeBtn.type = "button";
    removeBtn.setAttribute("aria-label", `Remove subtask: ${subtask.title}`);
    removeBtn.addEventListener("click", () => onRemove(subtask.id));
    row.appendChild(removeBtn);
    container.appendChild(row);
  }
}

export function openEditModal(task) {
  document.getElementById("editId").value = task.id;
  document.getElementById("editTitle").value = task.title;
  document.getElementById("editProject").value = task.project || "Inbox";
  document.getElementById("editNotes").value = task.notes || "";
  document.getElementById("editStatus").value = task.status;
  document.getElementById("editPriority").value = task.priority;
  document.getElementById("editDueDate").value = task.dueDate || "";
  document.getElementById("editTags").value = (task.tags || []).join(", ");
  document.getElementById("editRecurrence").value = task.recurrence || "";
  document.getElementById("editModal").hidden = false;
  document.getElementById("editTitle").focus();
}

export function closeEditModal() {
  document.getElementById("editModal").hidden = true;
}

export function readEditForm() {
  return {
    id: document.getElementById("editId").value,
    title: document.getElementById("editTitle").value.trim(),
    project: document.getElementById("editProject").value.trim() || "Inbox",
    notes: document.getElementById("editNotes").value.trim(),
    status: document.getElementById("editStatus").value,
    priority: document.getElementById("editPriority").value,
    dueDate: document.getElementById("editDueDate").value || null,
    tags: parseTagsInput(document.getElementById("editTags").value),
    recurrence: document.getElementById("editRecurrence").value || null,
  };
}

export function openAddModal() {
  document.getElementById("addTaskForm").reset();
  document.getElementById("addModal").hidden = false;
  document.getElementById("addTitle").focus();
}

export function closeAddModal() {
  document.getElementById("addModal").hidden = true;
}

export function readAddForm() {
  return {
    title: document.getElementById("addTitle").value.trim(),
    project: document.getElementById("addProject").value.trim() || "Inbox",
    notes: document.getElementById("addNotes").value.trim(),
    status: document.getElementById("addStatus").value,
    priority: document.getElementById("addPriority").value,
    dueDate: document.getElementById("addDueDate").value || null,
    tags: parseTagsInput(document.getElementById("addTags").value),
    recurrence: document.getElementById("addRecurrence").value || null,
  };
}

// ---------- lock screen ----------

const LOCK_PANEL_IDS = ["setupForm", "recoveryCodeScreen", "unlockForm", "recoveryForm", "resetPassphraseForm"];

function showLockPanel(id, focusId) {
  for (const panelId of LOCK_PANEL_IDS) {
    document.getElementById(panelId).hidden = panelId !== id;
  }
  if (focusId) document.getElementById(focusId).focus();
}

export function showSetupScreen() {
  showLockPanel("setupForm", "setupPassphrase");
}

export function showRecoveryCodeScreen(code) {
  document.getElementById("recoveryCodeText").textContent = code;
  document.getElementById("recoveryCodeConfirmCheckbox").checked = false;
  document.getElementById("recoveryCodeContinueBtn").disabled = true;
  showLockPanel("recoveryCodeScreen");
}

export function showUnlockScreen() {
  showLockPanel("unlockForm", "unlockPassphrase");
}

export function showRecoveryForm() {
  showLockPanel("recoveryForm", "recoveryCodeInput");
}

export function showResetPassphraseScreen() {
  showLockPanel("resetPassphraseForm", "resetPassphrase");
}

export function showApp() {
  document.getElementById("lockScreen").hidden = true;
  document.getElementById("rail").hidden = false;
  document.getElementById("mainWrap").hidden = false;
}

export function showLockScreen() {
  document.getElementById("rail").hidden = true;
  document.getElementById("mainWrap").hidden = true;
  document.getElementById("lockScreen").hidden = false;
}

export function setSetupError(message) {
  document.getElementById("setupError").textContent = message || "";
}

export function setUnlockError(message) {
  document.getElementById("unlockError").textContent = message || "";
}

export function setRecoveryError(message) {
  document.getElementById("recoveryError").textContent = message || "";
}

export function setResetError(message) {
  document.getElementById("resetError").textContent = message || "";
}

// ---------- stat pills ----------

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(paths) {
  const node = document.createElementNS(SVG_NS, "svg");
  node.setAttribute("viewBox", "0 0 20 20");
  node.setAttribute("fill", "none");
  node.setAttribute("aria-hidden", "true");
  for (const attrs of paths) {
    const shape = document.createElementNS(SVG_NS, attrs.tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "tag") continue;
      shape.setAttribute(key, value);
    }
    node.appendChild(shape);
  }
  return node;
}

const STAT_ICONS = {
  dueToday: () => svg([
    { tag: "circle", cx: 10, cy: 10, r: 7, stroke: "currentColor", "stroke-width": 1.6 },
    { tag: "path", d: "M10 6v4l3 2", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" },
  ]),
  overdue: () => svg([
    { tag: "path", d: "M10 3l8 14H2z", stroke: "currentColor", "stroke-width": 1.6, "stroke-linejoin": "round" },
    { tag: "path", d: "M10 8.5v3.5", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" },
    { tag: "circle", cx: 10, cy: 14.5, r: 0.9, fill: "currentColor" },
  ]),
  inProgress: () => svg([
    { tag: "path", d: "M16.5 10a6.5 6.5 0 1 1-2-4.7", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" },
    { tag: "path", d: "M16.5 4v4h-4", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" },
  ]),
  completed: () => svg([
    { tag: "path", d: "M4 10.5l4 4 8-9", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" },
  ]),
};

function computeStats(tasks) {
  // Compare as Date objects at local midnight, not ISO date strings — toISOString()
  // converts to UTC and can shift the calendar day in timezones ahead of UTC.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = Date.now() - 7 * 86400000;

  let dueToday = 0;
  let overdue = 0;
  let inProgress = 0;
  let completedThisWeek = 0;

  for (const t of tasks) {
    if (t.status !== "done" && t.dueDate) {
      const due = new Date(t.dueDate + "T00:00:00");
      const diffDays = Math.round((due - today) / 86400000);
      if (diffDays === 0) dueToday += 1;
      else if (diffDays < 0) overdue += 1;
    }
    if (t.status === "in-progress") inProgress += 1;
    if (t.status === "done" && t.updatedAt >= weekAgo) completedThisWeek += 1;
  }

  return [
    { key: "due-today", icon: "dueToday", value: dueToday, label: "Due today" },
    { key: "overdue", icon: "overdue", value: overdue, label: "Overdue" },
    { key: "in-progress", icon: "inProgress", value: inProgress, label: "In progress" },
    { key: "completed", icon: "completed", value: completedThisWeek, label: "Done this week" },
  ];
}

export function renderStats(tasks) {
  const row = document.getElementById("statsRow");
  row.textContent = "";
  for (const stat of computeStats(tasks)) {
    const pill = el("div", `stat-pill stat-pill-${stat.key}`);
    const iconWrap = el("div", "stat-pill-icon");
    iconWrap.appendChild(STAT_ICONS[stat.icon]());
    const text = el("div", "stat-pill-text");
    text.appendChild(el("div", "stat-pill-value", String(stat.value)));
    text.appendChild(el("div", "stat-pill-label", stat.label));
    pill.appendChild(iconWrap);
    pill.appendChild(text);
    row.appendChild(pill);
  }
}

export function setPageSubtitle(text) {
  document.getElementById("pageSubtitle").textContent = text;
}

const HISTORY_BREAK_REASON_TEXT = {
  "chain-broken": "This entry's link to the one before it doesn't match — something was inserted, removed, or reordered in the log.",
  "untrusted-signer": "This entry was signed by a key that was never one of this device's own signing keys.",
  "bad-signature": "This entry's signature doesn't match its content — something in it was changed after it was signed.",
};

const HISTORY_BREAK_REASON_SHORT = {
  "chain-broken": "Broken link",
  "untrusted-signer": "Untrusted signer",
  "bad-signature": "Bad signature",
};

const HISTORY_OP_LABEL = { create: "Created", update: "Updated", delete: "Deleted" };

export function renderHistoryReport(report) {
  const container = document.getElementById("historyReport");
  container.textContent = "";

  if (report.entryCount === 0) {
    container.appendChild(el("p", "history-report-line", "No history entries yet — add or edit a task, then check back."));
    return;
  }

  const line = report.ok
    ? el("p", "history-report-line history-report-ok", `Chain intact — all ${report.entryCount} signed ${report.entryCount === 1 ? "entry" : "entries"} verified below.`)
    : el("p", "history-report-line history-report-bad", `Problem found at entry ${report.brokenAt + 1} of ${report.entryCount}.`);
  container.appendChild(line);

  if (!report.ok) {
    container.appendChild(el("p", "history-report-detail", HISTORY_BREAK_REASON_TEXT[report.reason] || report.reason));
  }

  // The actual evidence, not just the verdict — every entry Verify checked,
  // so the claim above can be inspected rather than taken on faith.
  const wrap = el("div", "history-table-wrap");
  const table = document.createElement("table");
  table.className = "history-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["#", "When", "Change", "Task ID", "Entry hash", "Status"]) {
    headRow.appendChild(el("th", "", label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const entry of report.entries) {
    const row = document.createElement("tr");
    if (!entry.ok) row.classList.add("is-bad-entry");
    row.appendChild(el("td", "", String(entry.index + 1)));
    row.appendChild(el("td", "", new Date(entry.timestamp).toLocaleString()));
    row.appendChild(el("td", "", HISTORY_OP_LABEL[entry.op] || entry.op));
    row.appendChild(el("td", "history-table-mono", entry.taskId.slice(0, 8)));
    row.appendChild(el("td", "history-table-mono", entry.hashPrefix));
    const statusText = entry.ok ? "✓ Verified" : "✗ " + (HISTORY_BREAK_REASON_SHORT[entry.reason] || entry.reason);
    const statusCell = el("td", `history-table-status ${entry.ok ? "is-ok" : "is-bad"}`, statusText);
    if (!entry.ok) statusCell.title = HISTORY_BREAK_REASON_TEXT[entry.reason] || entry.reason;
    row.appendChild(statusCell);
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
}

// ---------- undo toast ----------

let undoToastTimer = null;

export function showUndoToast(message, onUndo) {
  clearTimeout(undoToastTimer);
  const toast = document.getElementById("undoToast");
  document.getElementById("undoToastMessage").textContent = message;
  const btn = document.getElementById("undoToastBtn");
  const freshBtn = btn.cloneNode(true); // drop any previous click listener
  btn.replaceWith(freshBtn);
  freshBtn.addEventListener("click", () => {
    clearTimeout(undoToastTimer);
    toast.hidden = true;
    onUndo();
  });
  toast.hidden = false;
  undoToastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}

// Same toast, no action button — for one-off status messages (e.g. an
// import summary) that don't have anything to undo.
export function showInfoToast(message) {
  clearTimeout(undoToastTimer);
  const toast = document.getElementById("undoToast");
  document.getElementById("undoToastMessage").textContent = message;
  document.getElementById("undoToastBtn").hidden = true;
  toast.hidden = false;
  undoToastTimer = setTimeout(() => {
    toast.hidden = true;
    document.getElementById("undoToastBtn").hidden = false;
  }, 6000);
}

// ---------- command palette ----------

export function openCmdk() {
  const overlay = document.getElementById("cmdkModal");
  overlay.hidden = false;
  const input = document.getElementById("cmdkInput");
  input.value = "";
  input.focus();
}

export function closeCmdk() {
  document.getElementById("cmdkModal").hidden = true;
}

export function renderCmdkItems(items, activeIndex) {
  const list = document.getElementById("cmdkList");
  list.textContent = "";
  if (items.length === 0) {
    list.appendChild(el("div", "cmdk-empty", "No matching commands"));
    return;
  }
  items.forEach((item, index) => {
    const row = el("div", "cmdk-item" + (index === activeIndex ? " is-active" : ""));
    row.setAttribute("role", "option");
    row.dataset.index = String(index);
    row.appendChild(el("span", "", item.label));
    if (item.hint) row.appendChild(el("kbd", "cmdk-item-hint", item.hint));
    list.appendChild(row);
  });
}

export function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll(".task-card:not(.is-dragging)")];
  return cards.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}
