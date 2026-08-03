import { getAllTasks, putTask, deleteTask } from "./store.js?v=20260803d";
import {
  renderBoard,
  renderList,
  setEmptyState,
  setView,
  openEditModal,
  closeEditModal,
  readEditForm,
  getDragAfterElement,
  renderStats,
  setPageSubtitle,
  openCmdk,
  closeCmdk,
  renderCmdkItems,
} from "./ui.js?v=20260803d";

const STATUSES = ["todo", "in-progress", "done"];

let tasks = [];
let view = "board";
let searchQuery = "";
let draggedId = null;

const THEME_KEY = "haven-theme";

function effectiveTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function wireThemeToggle() {
  const btn = document.getElementById("themeToggleBtn");

  const apply = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    btn.classList.toggle("is-dark", theme === "dark");
  };

  apply(effectiveTheme());

  btn.addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    apply(next);
  });

  // Only matters while no explicit choice is stored — once the user picks a
  // theme, that choice sticks regardless of OS setting until they pick again.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!localStorage.getItem(THEME_KEY)) apply(effectiveTheme());
  });
}

function uuid() {
  return crypto.randomUUID();
}

function now() {
  return Date.now();
}

function groupByStatus(list) {
  const groups = { todo: [], "in-progress": [], done: [] };
  for (const t of list) groups[t.status].push(t);
  for (const status of STATUSES) groups[status].sort((a, b) => a.order - b.order);
  return groups;
}

function matchesSearch(task, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    task.title.toLowerCase().includes(q) ||
    (task.notes || "").toLowerCase().includes(q)
  );
}

function visibleTasks() {
  return tasks.filter((t) => matchesSearch(t, searchQuery));
}

function render() {
  const visible = visibleTasks();
  const hasAnyTasks = tasks.length > 0;
  const hasVisibleTasks = visible.length > 0;

  renderStats(tasks);
  const dateStr = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  setPageSubtitle(`${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${dateStr}`);

  setEmptyState({ hasAnyTasks, hasVisibleTasks, view });

  // Always re-render board/list against current data, even when empty — the containers
  // may just be hidden behind the empty state, not absent, and stale nodes left over
  // from before the last item was removed should never linger in the DOM.
  const handlers = {
    onOpen: (task) => openEditModal(task),
    onDelete: (task) => removeTask(task.id),
    onDragStart: (task) => { draggedId = task.id; },
    onDragEnd: () => { draggedId = null; },
  };

  const sorted = [...visible].sort((a, b) => {
    const statusDiff = STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return a.order - b.order;
  });

  renderBoard(groupByStatus(visible), handlers);
  renderList(sorted, handlers);
}

function nextOrder(status) {
  const inStatus = tasks.filter((t) => t.status === status);
  if (inStatus.length === 0) return 0;
  return Math.max(...inStatus.map((t) => t.order)) + 1;
}

async function addTask({ title, priority, dueDate }) {
  const task = {
    id: uuid(),
    title: title.trim(),
    notes: "",
    status: "todo",
    priority: priority || "medium",
    dueDate: dueDate || null,
    order: nextOrder("todo"),
    createdAt: now(),
    updatedAt: now(),
  };
  tasks.push(task);
  render();
  await putTask(task);
}

async function updateTask(partial) {
  const task = tasks.find((t) => t.id === partial.id);
  if (!task) return;
  Object.assign(task, partial, { updatedAt: now() });
  render();
  await putTask(task);
}

async function removeTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  render();
  await deleteTask(id);
}

function exportTasks() {
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.getElementById("exportLink");
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `haven-tasks-${stamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

// RFC 5545 TEXT escaping — order matters, backslash first.
function icsEscape(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function icsTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function generateICS(taskList) {
  const withDue = taskList.filter((t) => t.dueDate);
  const stamp = icsTimestamp(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Haven//Tasks//EN", "CALSCALE:GREGORIAN"];
  for (const t of withDue) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${t.id}@haven.local`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${t.dueDate.replace(/-/g, "")}`);
    lines.push(`SUMMARY:${icsEscape(t.title)}`);
    if (t.notes) lines.push(`DESCRIPTION:${icsEscape(t.notes)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

function downloadICS(taskList, filename) {
  const blob = new Blob([generateICS(taskList)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.getElementById("exportLink");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function persistReorder(status) {
  const inStatus = tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);
  await Promise.all(inStatus.map((t) => putTask(t)));
}

function applyDropOrder(status, orderedIds) {
  orderedIds.forEach((id, index) => {
    const task = tasks.find((t) => t.id === id);
    if (task) {
      task.status = status;
      task.order = index;
      task.updatedAt = now();
    }
  });
}

function wireQuickAdd() {
  const form = document.getElementById("quickAddForm");
  const input = document.getElementById("quickAddInput");
  const priority = document.getElementById("quickAddPriority");
  const dueDate = document.getElementById("quickAddDueDate");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    addTask({ title, priority: priority.value, dueDate: dueDate.value });
    input.value = "";
    dueDate.value = "";
    priority.value = "medium";
    input.focus();
  });
}

function wireSearch() {
  const input = document.getElementById("searchInput");
  input.addEventListener("input", () => {
    searchQuery = input.value;
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input) {
      const tag = document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      input.focus();
    }
    if (e.key === "Escape") {
      closeEditModal();
      closeCmdk();
    }
  });
}

function wireViewToggle() {
  const boardBtn = document.getElementById("viewBoardBtn");
  const listBtn = document.getElementById("viewListBtn");
  boardBtn.addEventListener("click", () => {
    view = "board";
    setView(view);
    render();
  });
  listBtn.addEventListener("click", () => {
    view = "list";
    setView(view);
    render();
  });
}

function wireEditModal() {
  const overlay = document.getElementById("editModal");
  const form = document.getElementById("editForm");
  const cancelBtn = document.getElementById("editCancelBtn");
  const deleteBtn = document.getElementById("editDeleteBtn");
  const calendarBtn = document.getElementById("editAddToCalendarBtn");

  calendarBtn.addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    downloadICS([task], `haven-reminder-${task.dueDate}.ics`);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = readEditForm();
    if (!values.title) return;
    updateTask(values);
    closeEditModal();
  });

  cancelBtn.addEventListener("click", () => closeEditModal());

  deleteBtn.addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    if (confirm("Delete this task?")) {
      removeTask(id);
      closeEditModal();
    }
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeEditModal();
  });
}

function wireDragAndDrop() {
  for (const status of STATUSES) {
    const col = document.getElementById(`col-${status}`);

    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("is-drag-over");
      // Query the whole document, not just this column: on a cross-column drag the
      // dragged card still lives in the *source* column's subtree at this point, and
      // we need to relocate it into `col` regardless of where it currently sits.
      const dragging = document.querySelector(".task-card.is-dragging");
      if (!dragging) return;
      const afterElement = getDragAfterElement(col, e.clientY);
      if (afterElement == null) {
        col.appendChild(dragging);
      } else {
        col.insertBefore(dragging, afterElement);
      }
    });

    col.addEventListener("dragleave", (e) => {
      if (e.target === col) col.classList.remove("is-drag-over");
    });

    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("is-drag-over");
      if (!draggedId) return;

      const orderedIds = [...col.querySelectorAll(".task-card")].map((c) => c.dataset.id);
      const sourceTask = tasks.find((t) => t.id === draggedId);
      const sourceStatus = sourceTask ? sourceTask.status : status;

      applyDropOrder(status, orderedIds);
      render();

      await persistReorder(status);
      if (sourceStatus !== status) await persistReorder(sourceStatus);
    });
  }
}

function getCmdkItems() {
  return [
    { label: "New task", hint: "Enter", action: () => document.getElementById("quickAddInput").focus() },
    { label: "Focus search", hint: "/", action: () => document.getElementById("searchInput").focus() },
    { label: "Switch to board view", action: () => { view = "board"; setView(view); render(); } },
    { label: "Switch to list view", action: () => { view = "list"; setView(view); render(); } },
    { label: "Export all tasks as JSON", hint: ".json", action: exportTasks },
    {
      label: "Export calendar reminders (.ics)",
      hint: ".ics",
      action: () => downloadICS(tasks, `haven-reminders-${new Date().toISOString().slice(0, 10)}.ics`),
    },
  ];
}

let cmdkFiltered = [];
let cmdkActiveIndex = 0;

function updateCmdkList(query) {
  const q = query.trim().toLowerCase();
  cmdkFiltered = getCmdkItems().filter((item) => !q || item.label.toLowerCase().includes(q));
  cmdkActiveIndex = 0;
  renderCmdkItems(cmdkFiltered, cmdkActiveIndex);
}

function runCmdkItem(index) {
  const item = cmdkFiltered[index];
  if (!item) return;
  closeCmdk();
  item.action();
}

function wireCommandPalette() {
  const overlay = document.getElementById("cmdkModal");
  const input = document.getElementById("cmdkInput");
  const list = document.getElementById("cmdkList");
  const openBtn = document.getElementById("openCmdkBtn");

  const open = () => {
    openCmdk();
    updateCmdkList("");
  };

  openBtn.addEventListener("click", open);

  document.addEventListener("keydown", (e) => {
    // Accept either modifier rather than sniffing navigator.platform (deprecated,
    // unreliable) — harmless to support both Cmd+K and Ctrl+K on every OS.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      open();
    }
  });

  input.addEventListener("input", () => updateCmdkList(input.value));

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cmdkActiveIndex = Math.min(cmdkActiveIndex + 1, cmdkFiltered.length - 1);
      renderCmdkItems(cmdkFiltered, cmdkActiveIndex);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cmdkActiveIndex = Math.max(cmdkActiveIndex - 1, 0);
      renderCmdkItems(cmdkFiltered, cmdkActiveIndex);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runCmdkItem(cmdkActiveIndex);
    } else if (e.key === "Escape") {
      closeCmdk();
    }
  });

  list.addEventListener("click", (e) => {
    const item = e.target.closest(".cmdk-item");
    if (!item) return;
    runCmdkItem(Number(item.dataset.index));
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeCmdk();
  });
}

async function boot() {
  tasks = await getAllTasks();
  wireQuickAdd();
  wireSearch();
  wireViewToggle();
  wireEditModal();
  wireDragAndDrop();
  wireCommandPalette();
  render();
  document.getElementById("quickAddInput").focus();
}

wireThemeToggle();
boot();
