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

export function createTaskCard(task, { onOpen, onDragStart, onDragEnd }) {
  const card = el("div", "task-card" + (task.status === "done" ? " is-done" : ""));
  card.draggable = true;
  card.dataset.id = task.id;
  card.setAttribute("role", "listitem");
  card.tabIndex = 0;

  card.appendChild(el("h3", "task-title", task.title));
  if (task.notes) {
    card.appendChild(el("p", "task-notes", task.notes));
  }

  const meta = el("div", "task-meta");
  meta.appendChild(priorityBadge(task.priority));
  const due = dueBadge(task.dueDate);
  if (due) meta.appendChild(due);
  card.appendChild(meta);

  const tags = tagChips(task.tags);
  if (tags) card.appendChild(tags);

  card.addEventListener("click", () => onOpen(task));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter") onOpen(task);
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

export function createListRow(task, { onOpen, onDelete }) {
  const row = el("div", "list-row" + (task.status === "done" ? " is-done" : ""));
  row.dataset.id = task.id;

  const titleCell = el("span", "list-row-title-cell");
  titleCell.appendChild(el("span", "list-row-title", task.title));
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

  row.addEventListener("click", () => onOpen(task));
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

const VIEW_PANEL_IDS = { board: "boardView", list: "listView", reveal: "revealView" };
const VIEW_BTN_IDS = { board: "viewBoardBtn", list: "viewListBtn", reveal: "viewRevealBtn" };

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

  // The reveal page has its own live demo input and doesn't depend on whether any
  // real tasks exist — it must stay reachable even on a genuinely empty board.
  if (view === "reveal") {
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

export function openEditModal(task) {
  document.getElementById("editId").value = task.id;
  document.getElementById("editTitle").value = task.title;
  document.getElementById("editNotes").value = task.notes || "";
  document.getElementById("editStatus").value = task.status;
  document.getElementById("editPriority").value = task.priority;
  document.getElementById("editDueDate").value = task.dueDate || "";
  document.getElementById("editTags").value = (task.tags || []).join(", ");
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
    notes: document.getElementById("editNotes").value.trim(),
    status: document.getElementById("editStatus").value,
    priority: document.getElementById("editPriority").value,
    dueDate: document.getElementById("editDueDate").value || null,
    tags: parseTagsInput(document.getElementById("editTags").value),
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
    notes: document.getElementById("addNotes").value.trim(),
    status: document.getElementById("addStatus").value,
    priority: document.getElementById("addPriority").value,
    dueDate: document.getElementById("addDueDate").value || null,
    tags: parseTagsInput(document.getElementById("addTags").value),
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
