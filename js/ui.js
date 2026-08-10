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

function formatRemaining(ms) {
  const mins = Math.round(ms / 60000);
  if (mins <= 1) return "burning out";
  if (mins < 60) return `${mins}m left`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

// Not shown for a destructed task (there's a dedicated placeholder card for
// that instead) — only for an active fuse still counting down.
function selfDestructBadge(selfDestruct) {
  if (!selfDestruct) return null;
  const label =
    selfDestruct.mode === "time"
      ? `🔥 ${formatRemaining(selfDestruct.expiresAt - Date.now())}`
      : `🔥 ${selfDestruct.maxViews - selfDestruct.viewsUsed} view${selfDestruct.maxViews - selfDestruct.viewsUsed === 1 ? "" : "s"} left`;
  return el("span", "badge badge-self-destruct", label);
}

function timeSpentBadge(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const label = h > 0 ? `⏱ ${h}h ${m}m` : `⏱ ${m}m`;
  return el("span", "badge badge-time-spent", label);
}

function tagChips(tags) {
  if (!tags || tags.length === 0) return null;
  const wrap = el("div", "task-tags");
  for (const tag of tags) {
    wrap.appendChild(el("span", "tag-chip", tag));
  }
  return wrap;
}

// timeLock here is the non-secret progress shape {squarings, squaringsSolved}
// (see timeLockedTaskStub() in js/app.js) — never the puzzle's solution.
function timeLockProgressBar(timeLock) {
  const pct = timeLock.squarings > 0 ? Math.min(100, Math.round((timeLock.squaringsSolved / timeLock.squarings) * 100)) : 0;
  const wrap = el("div", "timelock-progress");
  const track = el("div", "timelock-progress-track");
  const fill = el("div", "timelock-progress-fill");
  fill.style.width = pct + "%";
  track.appendChild(fill);
  wrap.appendChild(track);
  wrap.appendChild(el("span", "timelock-progress-label", pct === 0 ? "Click to start unlocking" : `${pct}% solved — click to continue`));
  return wrap;
}

function dueBadge(dueDate) {
  const info = dueBadgeInfo(dueDate);
  if (!info) return null;
  return el("span", info.cls, info.label);
}

export function createTaskCard(task, { onOpen, onDragStart, onDragEnd, selectionMode, selectedIds, onToggleSelect }) {
  const selected = !!(selectedIds && selectedIds.has(task.id));
  const destructedCls = task.destructed ? " is-destructed" : "";
  const timeLockedCls = task.timeLocked ? " is-timelocked" : "";
  // Overdue takes visual precedence over priority on the card's accent
  // stripe (see .task-card[data-priority] / .task-card.is-overdue in
  // style.css) — a done task is never "overdue" regardless of its date.
  const overdueCls = !task.destructed && !task.timeLocked && task.status !== "done" && dueBadgeInfo(task.dueDate)?.cls.includes("is-overdue") ? " is-overdue" : "";
  const card = el("div", "task-card" + (task.status === "done" ? " is-done" : "") + (selected ? " is-selected" : "") + destructedCls + timeLockedCls + overdueCls);
  card.draggable = !selectionMode && !task.destructed && !task.timeLocked;
  card.dataset.id = task.id;
  if (!task.destructed && !task.timeLocked) card.dataset.priority = task.priority;
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

  if (task.destructed) {
    // No title/notes/tags to show — they're permanently gone, not just
    // hidden. A dedicated placeholder rather than trying to fit "erased" into
    // the normal card layout, so it can't be mistaken for a blank task.
    card.appendChild(el("p", "destructed-label", "🔥 This task self-destructed"));
    card.addEventListener("click", () => (selectionMode ? onToggleSelect(task.id) : onOpen(task)));
    return card;
  }

  if (task.timeLocked) {
    // No title/notes to show — genuinely not decrypted yet, not just
    // hidden by the UI. Click continues the real solve (see onOpen in
    // js/app.js), not an edit — there's nothing decrypted to edit.
    card.appendChild(el("p", "timelock-label", "🔒 Time-locked task"));
    card.appendChild(timeLockProgressBar(task.timeLock));
    card.addEventListener("click", () => (selectionMode ? onToggleSelect(task.id) : onOpen(task)));
    return card;
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
  const fuse = selfDestructBadge(task.selfDestruct);
  if (fuse) meta.appendChild(fuse);
  const timeSpent = timeSpentBadge(task.timeSpentSeconds);
  if (timeSpent) meta.appendChild(timeSpent);
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
  const destructedCls = task.destructed ? " is-destructed" : "";
  const timeLockedCls = task.timeLocked ? " is-timelocked" : "";
  const row = el("div", "list-row" + (task.status === "done" ? " is-done" : "") + (selected ? " is-selected" : "") + destructedCls + timeLockedCls);
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

  if (task.destructed) {
    titleRow.appendChild(el("span", "list-row-title destructed-label", "🔥 This task self-destructed"));
    titleCell.appendChild(titleRow);
    row.appendChild(titleCell);
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

  if (task.timeLocked) {
    titleRow.appendChild(el("span", "list-row-title timelock-label", "🔒 Time-locked task"));
    titleCell.appendChild(titleRow);
    titleCell.appendChild(timeLockProgressBar(task.timeLock));
    row.appendChild(titleCell);
    row.addEventListener("click", () => (selectionMode ? onToggleSelect(task.id) : onOpen(task)));
    return row;
  }

  titleRow.appendChild(el("span", "list-row-title", task.title));
  const progress = subtaskProgressBadge(task.subtasks);
  if (progress) titleRow.appendChild(progress);
  const recurrence = recurrenceBadge(task.recurrence);
  if (recurrence) titleRow.appendChild(recurrence);
  const fuse = selfDestructBadge(task.selfDestruct);
  if (fuse) titleRow.appendChild(fuse);
  const timeSpent = timeSpentBadge(task.timeSpentSeconds);
  if (timeSpent) titleRow.appendChild(timeSpent);
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

const VIEW_PANEL_IDS = { board: "boardView", list: "listView", reveal: "revealView", history: "historyView", insights: "insightsView", calendar: "calendarView", notes: "notesView", assistant: "assistantView" };
const VIEW_BTN_IDS = { board: "viewBoardBtn", list: "viewListBtn", reveal: "viewRevealBtn", history: "viewHistoryBtn", insights: "viewInsightsBtn", calendar: "viewCalendarBtn", notes: "viewNotesBtn", assistant: "viewAssistantBtn" };

export function setView(view) {
  for (const key of Object.keys(VIEW_PANEL_IDS)) {
    const isActive = key === view;
    document.getElementById(VIEW_PANEL_IDS[key]).hidden = !isActive;
    const btn = document.getElementById(VIEW_BTN_IDS[key]);
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  }
  // The board-footer summary only makes sense alongside the board/list views,
  // not the reveal/history/insights/calendar/assistant pages.
  document.getElementById("boardFooter").hidden = !(view === "board" || view === "list");
}

function hideAllViewPanels() {
  for (const id of Object.values(VIEW_PANEL_IDS)) {
    document.getElementById(id).hidden = true;
  }
  document.getElementById("boardFooter").hidden = true;
}

export function setEmptyState({ hasAnyTasks, hasVisibleTasks, view }) {
  const empty = document.getElementById("emptyState");
  const noResults = document.getElementById("noResultsState");

  // The reveal, history, insights, calendar, and assistant pages don't
  // depend on whether any real tasks exist — all five must stay reachable
  // even on a genuinely empty board (insights/calendar just show an empty
  // state rather than being unreachable; the assistant is useful even
  // before any tasks exist, since enabling it doesn't require any).
  if (view === "reveal" || view === "history" || view === "insights" || view === "calendar" || view === "notes" || view === "assistant") {
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
export function parseTagsInput(value) {
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

  // Self-destruct isn't editable after creation (no UI to change or cancel a
  // fuse once set) — just a read-only note of the current state, since the
  // form fields above are still real and still get saved normally.
  const note = document.getElementById("editSelfDestructNote");
  note.textContent = task.selfDestruct
    ? task.selfDestruct.mode === "time"
      ? `🔥 This task self-destructs at ${new Date(task.selfDestruct.expiresAt).toLocaleString()}.`
      : `🔥 This task self-destructs after ${task.selfDestruct.maxViews - task.selfDestruct.viewsUsed} more view${task.selfDestruct.maxViews - task.selfDestruct.viewsUsed === 1 ? "" : "s"}.`
    : "";
  note.hidden = !task.selfDestruct;

  // Sharing snapshots the currently-decrypted fields into an independent,
  // separately-encrypted copy on the share server (docs/ARCHITECTURE.md
  // "Fragment-key share links") — that copy has its own lifetime and
  // wouldn't be touched by this task's fuse going off, which would quietly
  // break the "burns and is gone" premise. Simplest honest fix: no sharing
  // an ephemeral task at all, rather than a share link that outlives it.
  const shareBtn = document.getElementById("editShareBtn");
  shareBtn.disabled = !!task.selfDestruct;
  shareBtn.title = task.selfDestruct ? "Self-destructing tasks can't be shared — a share link would outlive the fuse." : "";

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

const SELF_DESTRUCT_DURATIONS_MS = { "1h": 3600000, "1d": 86400000, "7d": 604800000 };

// Parses the addSelfDestructMode <select> into the spec shape app.js's
// addTask()/persistTask() expect — null for "never" (a normal task).
function readSelfDestructMode() {
  const value = document.getElementById("addSelfDestructMode").value;
  if (!value) return null;
  if (value === "views") return { mode: "views", maxViews: 1 };
  return { mode: "time", expiresAt: Date.now() + SELF_DESTRUCT_DURATIONS_MS[value] };
}

// Squarings-per-second is a conservative, once-measured estimate (see
// docs/ARCHITECTURE.md "Time-locked tasks") — real device speed varies, so
// actual solve time may be faster than the label; deliberately never
// slower by more than a small margin. Mutually exclusive with self-destruct
// in this version — combining "erases on open" with "can't be opened yet"
// is a real, untested interaction this pass doesn't take on.
const TIME_LOCK_SQUARINGS_PER_SEC = 150000;
const TIME_LOCK_DURATIONS_SEC = { demo: 10, "2m": 120, "10m": 600 };

function readTimeLockMode() {
  const value = document.getElementById("addTimeLockMode").value;
  if (!value) return null;
  return { squarings: TIME_LOCK_DURATIONS_SEC[value] * TIME_LOCK_SQUARINGS_PER_SEC };
}

export function readNoteForm() {
  return {
    title: document.getElementById("noteTitle").value.trim(),
    body: document.getElementById("noteBody").value,
    tags: parseTagsInput(document.getElementById("noteTags").value),
  };
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
    selfDestruct: readSelfDestructMode(),
    timeLockSquarings: readTimeLockMode()?.squarings || null,
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

// ---------- password fields: show/hide toggle, strength meter, match indicator ----------

// Wires every .field-password-toggle button in the document (works for any
// password field using the .field-password wrapper markup, present or future).
export function initPasswordToggles() {
  document.querySelectorAll(".field-password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.previousElementSibling;
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.classList.toggle("is-visible", !showing);
      btn.setAttribute("aria-label", showing ? "Show passphrase" : "Hide passphrase");
    });
  });
}

const STRENGTH_LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_CLASS = ["danger", "danger", "warn", "warn", "success"];

// A rough heuristic, not a real entropy estimate — enough to nudge someone
// away from "aaaaaaaaaa" without pretending to be a password-strength library.
function computePassphraseStrength(value) {
  if (!value) return 0;
  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 16) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/[0-9]/.test(value)) score += 1;
  if (/[^A-Za-z0-9\s]/.test(value) || value.trim().split(/\s+/).length >= 4) score += 1;
  return Math.min(score, 4);
}

function renderPassphraseStrength(meterId, value) {
  const meter = document.getElementById(meterId);
  if (!meter) return;
  const score = computePassphraseStrength(value);
  const cls = STRENGTH_CLASS[score];
  const lit = value ? Math.max(score, 1) : 0;
  meter.querySelectorAll(".strength-seg").forEach((seg, i) => {
    seg.className = "strength-seg" + (i < lit ? ` is-${cls}` : "");
  });
  const label = meter.querySelector(".strength-label");
  label.textContent = value ? STRENGTH_LABELS[score] : "";
  label.className = "strength-label" + (value ? ` is-${cls}` : "");
}

function renderPassphraseMatch(matchId, primaryValue, confirmValue) {
  const matchEl = document.getElementById(matchId);
  if (!matchEl) return;
  if (!confirmValue) {
    matchEl.textContent = "";
    matchEl.className = "passphrase-match";
    return;
  }
  const matches = primaryValue === confirmValue;
  matchEl.textContent = matches ? "Matches" : "Doesn't match yet";
  matchEl.className = "passphrase-match" + (matches ? " is-match" : " is-mismatch");
}

// The two passphrase-setting pairs on the lock screen (setup, and the
// recovery-code reset flow) — both need live strength + match feedback.
// Not the unlock or decoy-vault forms: those aren't "choosing a passphrase."
const PASSPHRASE_PAIRS = [
  { primary: "setupPassphrase", confirm: "setupPassphraseConfirm" },
  { primary: "resetPassphrase", confirm: "resetPassphraseConfirm" },
];

export function initPassphraseFeedback() {
  for (const { primary, confirm } of PASSPHRASE_PAIRS) {
    const primaryInput = document.getElementById(primary);
    const confirmInput = document.getElementById(confirm);
    if (!primaryInput || !confirmInput) continue;
    const meterId = `${primary}Strength`;
    const matchId = `${confirm}Match`;
    primaryInput.addEventListener("input", () => {
      renderPassphraseStrength(meterId, primaryInput.value);
      renderPassphraseMatch(matchId, primaryInput.value, confirmInput.value);
    });
    confirmInput.addEventListener("input", () => {
      renderPassphraseMatch(matchId, primaryInput.value, confirmInput.value);
    });
  }
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

// Fills the whitespace that otherwise trails below the board columns once
// there are only a few tasks, with genuinely useful summary content: how
// much of this week's workload is done, and what got finished recently.
// Visibility (board/list view only, and only once a task exists) is handled
// by setView()/hideAllViewPanels() below — this just renders content.
export function renderBoardFooter(tasks) {
  const footer = document.getElementById("boardFooter");
  footer.textContent = "";
  if (tasks.length === 0) return;

  const weekAgo = Date.now() - 7 * 86400000;
  const completedThisWeek = tasks
    .filter((t) => t.status === "done" && !t.destructed && t.updatedAt >= weekAgo)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const openCount = tasks.filter((t) => t.status !== "done" && !t.destructed).length;
  const total = completedThisWeek.length + openCount;
  const pct = total > 0 ? Math.round((completedThisWeek.length / total) * 100) : 0;

  const momentum = el("div", "board-footer-momentum");
  momentum.appendChild(el("span", "board-footer-label", "Weekly momentum"));
  const track = el("div", "insights-bar-track board-footer-track");
  const fill = el("div", "insights-bar-fill");
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  momentum.appendChild(track);
  momentum.appendChild(el("span", "board-footer-count", `${completedThisWeek.length} done this week`));
  footer.appendChild(momentum);

  if (completedThisWeek.length > 0) {
    const recent = el("div", "board-footer-recent");
    recent.appendChild(el("span", "board-footer-label", "Recently completed"));
    const chips = el("div", "board-footer-chips");
    for (const t of completedThisWeek.slice(0, 3)) {
      chips.appendChild(el("span", "board-footer-chip", t.title));
    }
    recent.appendChild(chips);
    footer.appendChild(recent);
  }
}

const HISTORY_BREAK_REASON_TEXT = {
  "chain-broken": "This entry's link to the one before it doesn't match — something was inserted, removed, or reordered in the log.",
  "untrusted-signer": "This entry was signed by a key that was never one of this device's own signing keys.",
  "bad-signature": "This entry's signature doesn't match its content — something in it was changed after it was signed.",
  "untrusted-pq-signer": "This entry's post-quantum signature was made with a key that was never one of this device's own — same check as \"untrusted signer\", for the second, hybrid signature.",
  "bad-pq-signature": "This entry's post-quantum signature doesn't match its content — the classical signature checked out, but the hybrid one didn't.",
};

export const HISTORY_BREAK_REASON_SHORT = {
  "chain-broken": "Broken link",
  "untrusted-signer": "Untrusted signer",
  "bad-signature": "Bad signature",
  "untrusted-pq-signer": "Untrusted PQ signer",
  "bad-pq-signature": "Bad PQ signature",
};

const HISTORY_OP_LABEL = { create: "Created", update: "Updated", delete: "Deleted", selfDestruct: "Self-destructed" };

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

const AUTOMATION_TRIGGER_LABEL = {
  onDone: "a task is marked Done",
  onOverdue: "a task's due date passes (and it's not Done)",
  onCreateWithTag: (rule) => `a task is created with tag "${rule.trigger.tag}"`,
};
const AUTOMATION_ACTION_LABEL = {
  addTag: (rule) => `add tag "${rule.action.value}"`,
  removeTag: (rule) => `remove tag "${rule.action.value}"`,
  setPriority: (rule) => `set priority to ${rule.action.value}`,
  setStatus: (rule) => `set status to ${rule.action.value}`,
  moveToProject: (rule) => `move to project "${rule.action.value}"`,
};

function describeAutomationRule(rule) {
  const triggerLabel = AUTOMATION_TRIGGER_LABEL[rule.trigger.type];
  const actionLabel = AUTOMATION_ACTION_LABEL[rule.action.type];
  const when = typeof triggerLabel === "function" ? triggerLabel(rule) : triggerLabel;
  const then = typeof actionLabel === "function" ? actionLabel(rule) : actionLabel;
  return { when, then };
}

export function renderAutomationRulesList(rules, { onDelete } = {}) {
  const container = document.getElementById("automationRulesList");
  container.textContent = "";

  if (rules.length === 0) {
    container.appendChild(el("p", "modal-help", "No rules yet — add one above."));
    return;
  }

  for (const rule of rules) {
    const { when, then } = describeAutomationRule(rule);
    const row = el("div", "automation-rule-row");
    const text = el("span", "automation-rule-text");
    text.appendChild(el("span", "", "When "));
    text.appendChild(el("strong", "", when));
    text.appendChild(el("span", "", ", "));
    text.appendChild(el("strong", "", then));
    text.appendChild(el("span", "", "."));
    row.appendChild(text);

    const delBtn = el("button", "list-row-delete", "Delete");
    delBtn.type = "button";
    delBtn.addEventListener("click", () => onDelete && onDelete(rule.id));
    row.appendChild(delBtn);

    container.appendChild(row);
  }
}

// "Updated 2 hours ago" style relative time, falling back to an absolute
// date once it's far enough back that "N days ago" stops being useful.
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function relativeTime(ms) {
  const diffSeconds = Math.round((ms - Date.now()) / 1000);
  if (Math.abs(diffSeconds) < 60) return "just now";
  // Bucket on the *rounded* unit value, not the raw seconds — otherwise
  // e.g. 3599s (59:59) rounds to "60 minutes ago" instead of promoting to
  // "1 hour ago" at the minute/hour boundary (and same for hour/day).
  const minutes = Math.round(diffSeconds / 60);
  if (Math.abs(minutes) < 60) return RELATIVE_TIME_FORMATTER.format(minutes, "minute");
  const hours = Math.round(diffSeconds / 3600);
  if (Math.abs(hours) < 24) return RELATIVE_TIME_FORMATTER.format(hours, "hour");
  const days = Math.round(diffSeconds / 86400);
  if (Math.abs(days) < 6) return RELATIVE_TIME_FORMATTER.format(days, "day");
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function renderNotesList(notes, { onOpen, onDelete } = {}) {
  const container = document.getElementById("notesList");
  container.textContent = "";

  if (notes.length === 0) {
    container.appendChild(el("p", "modal-help", "No notes yet — click “New note” to write one."));
    return;
  }

  for (const note of notes) {
    const card = el("div", "note-card");
    card.appendChild(el("h3", "note-card-title", note.title));
    if (note.body) {
      const preview = note.body.length > 160 ? note.body.slice(0, 160) + "…" : note.body;
      card.appendChild(el("p", "note-card-body", preview));
    }
    const tags = tagChips(note.tags);
    if (tags) card.appendChild(tags);
    card.appendChild(el("p", "note-card-meta", "Updated " + relativeTime(note.updatedAt)));
    card.addEventListener("click", () => onOpen && onOpen(note));

    const delBtn = el("button", "note-card-delete", "Delete");
    delBtn.type = "button";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onDelete && onDelete(note.id);
    });
    card.appendChild(delBtn);

    container.appendChild(card);
  }
}

const INSIGHTS_STATUS_LABEL = { todo: "To Do", "in-progress": "In Progress", done: "Done" };
const INSIGHTS_PRIORITY_LABEL = { low: "Low", medium: "Medium", high: "High" };

function insightsStatCard(value, label) {
  const card = el("div", "insights-stat-card");
  card.appendChild(el("div", "insights-stat-value", String(value)));
  card.appendChild(el("div", "insights-stat-label", label));
  return card;
}

function renderBarList(containerId, entries) {
  const container = document.getElementById(containerId);
  container.textContent = "";
  const max = Math.max(1, ...entries.map(([, count]) => count));
  if (entries.length === 0 || entries.every(([, count]) => count === 0)) {
    container.appendChild(el("p", "modal-help", "Nothing here yet."));
    return;
  }
  for (const [label, count] of entries) {
    const row = el("div", "insights-bar-row");
    row.appendChild(el("span", "insights-bar-label", label));
    const track = el("div", "insights-bar-track");
    const fill = el("div", "insights-bar-fill");
    fill.style.width = `${Math.round((count / max) * 100)}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el("span", "insights-bar-count", String(count)));
    container.appendChild(row);
  }
}

export function renderInsights(stats) {
  const grid = document.getElementById("insightsStatGrid");
  grid.textContent = "";
  grid.appendChild(insightsStatCard(stats.total, stats.total === 1 ? "task" : "tasks"));
  grid.appendChild(insightsStatCard(`${stats.completionRate}%`, "completion rate"));
  grid.appendChild(insightsStatCard(stats.overdue, "overdue"));
  grid.appendChild(insightsStatCard(stats.recurringCount, "recurring"));
  if (stats.subtaskCompletionRate !== null) {
    grid.appendChild(insightsStatCard(`${stats.subtaskCompletionRate}%`, `subtasks done (${stats.subtasksDone}/${stats.subtasksTotal})`));
  }

  renderBarList(
    "insightsByStatus",
    Object.keys(INSIGHTS_STATUS_LABEL).map((k) => [INSIGHTS_STATUS_LABEL[k], stats.byStatus[k] || 0])
  );
  renderBarList(
    "insightsByPriority",
    Object.keys(INSIGHTS_PRIORITY_LABEL).map((k) => [INSIGHTS_PRIORITY_LABEL[k], stats.byPriority[k] || 0])
  );
  renderBarList("insightsByProject", stats.byProject);

  const tagContainer = document.getElementById("insightsTopTags");
  tagContainer.textContent = "";
  if (stats.topTags.length === 0) {
    tagContainer.appendChild(el("p", "modal-help", "No tags used yet."));
  } else {
    for (const [tag, count] of stats.topTags) {
      const chip = el("span", "tag-chip", `${tag} · ${count}`);
      tagContainer.appendChild(chip);
    }
  }
}

const CALENDAR_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const CALENDAR_MAX_CHIPS_PER_DAY = 3;

function localDateToISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// `monthDate` is any Date within the month to display — only its
// year/month are read. Renders a 6-week (42-cell) grid starting on the
// Sunday on/before the 1st, so partial leading/trailing weeks from
// adjacent months fill out a consistent, non-jumping grid height.
export function renderCalendar(monthDate, tasks, { onOpenTask } = {}) {
  document.getElementById("calendarMonthLabel").textContent = monthDate.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const tasksByDate = new Map();
  for (const t of tasks) {
    if (t.destructed || !t.dueDate) continue;
    const key = t.dueDate.slice(0, 10);
    if (!tasksByDate.has(key)) tasksByDate.set(key, []);
    tasksByDate.get(key).push(t);
  }

  const grid = document.getElementById("calendarGrid");
  grid.textContent = "";
  for (const day of CALENDAR_WEEKDAYS) grid.appendChild(el("div", "calendar-weekday", day));

  const firstOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const todayISO = localDateToISO(new Date());

  for (let i = 0; i < 42; i++) {
    const cellDate = new Date(gridStart);
    cellDate.setDate(gridStart.getDate() + i);
    const iso = localDateToISO(cellDate);
    const isOutsideMonth = cellDate.getMonth() !== monthDate.getMonth();

    const cell = el(
      "div",
      "calendar-day" + (isOutsideMonth ? " is-outside-month" : "") + (iso === todayISO ? " is-today" : "")
    );
    cell.appendChild(el("div", "calendar-day-number", String(cellDate.getDate())));

    const dayTasks = (tasksByDate.get(iso) || []).sort((a, b) => a.title.localeCompare(b.title));
    if (dayTasks.length > 0) {
      const list = el("div", "calendar-day-tasks");
      for (const t of dayTasks.slice(0, CALENDAR_MAX_CHIPS_PER_DAY)) {
        const isOverdue = iso < todayISO && t.status !== "done";
        const chip = el(
          "button",
          "calendar-task-chip" + (t.status === "done" ? " is-done" : "") + (isOverdue ? " is-overdue" : ""),
          t.title
        );
        chip.type = "button";
        chip.addEventListener("click", () => onOpenTask && onOpenTask(t));
        list.appendChild(chip);
      }
      if (dayTasks.length > CALENDAR_MAX_CHIPS_PER_DAY) {
        list.appendChild(el("div", "calendar-day-more", `+${dayTasks.length - CALENDAR_MAX_CHIPS_PER_DAY} more`));
      }
      cell.appendChild(list);
    }

    grid.appendChild(cell);
  }
}

// ---------- AI assistant (js/ai.js) ----------

export function renderAssistantTaskOptions(tasks) {
  const select = document.getElementById("assistantTaskSelect");
  const previous = select.value;
  select.textContent = "";
  const openTasks = tasks.filter((t) => !t.destructed && t.status !== "done");
  for (const t of openTasks) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.title;
    select.appendChild(opt);
  }
  if (openTasks.some((t) => t.id === previous)) select.value = previous;
}

export function setAssistantProgress(fraction, label) {
  const wrap = document.getElementById("assistantProgress");
  const fill = document.getElementById("assistantProgressFill");
  const labelEl = document.getElementById("assistantProgressLabel");
  wrap.hidden = fraction === null;
  if (fraction !== null) fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  if (label) labelEl.textContent = label;
}

export function showAssistantEnabled() {
  document.getElementById("assistantEnableCard").hidden = true;
  document.getElementById("assistantActions").hidden = false;
}

export function setAssistantOutputText(text) {
  document.getElementById("assistantOutput").hidden = false;
  document.getElementById("assistantOutputText").hidden = false;
  document.getElementById("assistantOutputText").textContent = text;
  document.getElementById("assistantSuggestionList").hidden = true;
  document.getElementById("assistantAddSubtasksBtn").hidden = true;
}

export function setAssistantSuggestions(suggestions) {
  const list = document.getElementById("assistantSuggestionList");
  document.getElementById("assistantOutput").hidden = false;
  document.getElementById("assistantOutputText").hidden = true;
  list.hidden = false;
  list.textContent = "";
  for (const s of suggestions) {
    const item = el("li", "assistant-suggestion-item");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.value = s;
    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(" " + s));
    item.appendChild(label);
    list.appendChild(item);
  }
  const addBtn = document.getElementById("assistantAddSubtasksBtn");
  addBtn.hidden = suggestions.length === 0;
}

export function getSelectedAssistantSuggestions() {
  return [...document.querySelectorAll("#assistantSuggestionList input[type=checkbox]:checked")].map((c) => c.value);
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
