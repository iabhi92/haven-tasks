import { getAllTasks, putTask, deleteTask } from "./store.js";
import {
  renderBoard,
  renderList,
  setEmptyState,
  setView,
  openEditModal,
  closeEditModal,
  readEditForm,
  getDragAfterElement,
} from "./ui.js";

const STATUSES = ["todo", "in-progress", "done"];

let tasks = [];
let view = "board";
let searchQuery = "";
let draggedId = null;

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

  setEmptyState({ hasAnyTasks, hasVisibleTasks, view });
  if (!hasAnyTasks || !hasVisibleTasks) return;

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

async function boot() {
  tasks = await getAllTasks();
  wireQuickAdd();
  wireSearch();
  wireViewToggle();
  wireEditModal();
  wireDragAndDrop();
  render();
  document.getElementById("quickAddInput").focus();
}

boot();
