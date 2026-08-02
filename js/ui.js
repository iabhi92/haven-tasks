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

  row.appendChild(el("span", "list-row-title", task.title));

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

export function setView(view) {
  const board = document.getElementById("boardView");
  const list = document.getElementById("listView");
  const boardBtn = document.getElementById("viewBoardBtn");
  const listBtn = document.getElementById("viewListBtn");
  const isBoard = view === "board";
  board.hidden = !isBoard;
  list.hidden = isBoard;
  boardBtn.classList.toggle("is-active", isBoard);
  listBtn.classList.toggle("is-active", !isBoard);
  boardBtn.setAttribute("aria-selected", String(isBoard));
  listBtn.setAttribute("aria-selected", String(!isBoard));
}

export function setEmptyState({ hasAnyTasks, hasVisibleTasks, view }) {
  const empty = document.getElementById("emptyState");
  const noResults = document.getElementById("noResultsState");
  const board = document.getElementById("boardView");
  const list = document.getElementById("listView");

  if (!hasAnyTasks) {
    empty.hidden = false;
    noResults.hidden = true;
    board.hidden = true;
    list.hidden = true;
    return;
  }

  if (!hasVisibleTasks) {
    empty.hidden = true;
    noResults.hidden = false;
    board.hidden = true;
    list.hidden = true;
    return;
  }

  empty.hidden = true;
  noResults.hidden = true;
  setView(view);
}

export function openEditModal(task) {
  document.getElementById("editId").value = task.id;
  document.getElementById("editTitle").value = task.title;
  document.getElementById("editNotes").value = task.notes || "";
  document.getElementById("editStatus").value = task.status;
  document.getElementById("editPriority").value = task.priority;
  document.getElementById("editDueDate").value = task.dueDate || "";
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
  };
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
