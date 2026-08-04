// Standalone viewer for fragment-key share links — no unlock, no keyring, no
// IndexedDB. Reads {server, id} from the query string and the decryption key
// from location.hash (never sent to any server, per the URL spec — see
// docs/ARCHITECTURE.md "Fragment-key share links"), fetches the ciphertext,
// decrypts in-page, and renders it. Nothing here is ever persisted.

import { importDek, decryptTask, base64UrlToBuf } from "./crypto.js?v=20260804n";
import { pullShare } from "./sync.js?v=20260804n";

const STATUS_LABEL = { todo: "To Do", "in-progress": "In Progress", done: "Done" };
const PRIORITY_LABEL = { low: "Low", medium: "Medium", high: "High" };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(className, text) {
  return el("span", `badge ${className}`, text);
}

function formatDueDate(dueDate) {
  if (!dueDate) return null;
  const due = new Date(dueDate + "T00:00:00");
  return due.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function showError(message) {
  document.getElementById("shareViewLoading").hidden = true;
  const errorEl = document.getElementById("shareViewError");
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function renderTask(task) {
  const container = document.getElementById("shareViewContent");

  container.appendChild(el("h2", "share-view-title", task.title || "(untitled task)"));

  const meta = el("div", "share-view-meta");
  meta.appendChild(badge(`badge-status-${task.status}`, STATUS_LABEL[task.status] || task.status));
  meta.appendChild(badge(`badge-priority-${task.priority}`, PRIORITY_LABEL[task.priority] || task.priority));
  const dueLabel = formatDueDate(task.dueDate);
  if (dueLabel) meta.appendChild(badge("badge-due", dueLabel));
  container.appendChild(meta);

  if (task.tags && task.tags.length > 0) {
    const tagWrap = el("div", "task-tags");
    for (const tag of task.tags) tagWrap.appendChild(el("span", "tag-chip", tag));
    container.appendChild(tagWrap);
  }

  if (task.notes) {
    container.appendChild(el("p", "share-view-notes", task.notes));
  }

  if (task.subtasks && task.subtasks.length > 0) {
    container.appendChild(el("p", "share-view-section-label", "Subtasks"));
    const list = el("div", "subtask-list");
    for (const subtask of task.subtasks) {
      const row = el("div", `subtask-row${subtask.done ? " is-done" : ""}`);
      const checkbox = el("input");
      checkbox.type = "checkbox";
      checkbox.checked = !!subtask.done;
      checkbox.disabled = true;
      row.appendChild(checkbox);
      row.appendChild(el("span", "subtask-row-title", subtask.title));
      list.appendChild(row);
    }
    container.appendChild(list);
  }

  document.getElementById("shareViewLoading").hidden = true;
  container.hidden = false;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const server = params.get("server");
  const id = params.get("id");
  const key = location.hash.slice(1);

  if (!server || !id || !key) {
    showError("This link is incomplete — it's missing the server, id, or key it needs.");
    return;
  }

  let share;
  try {
    share = await pullShare(server, id);
  } catch (err) {
    showError("Couldn't reach the server this link points to. Check your connection and try again.");
    return;
  }

  if (!share) {
    showError("This link has expired, was revoked, or has already been viewed the maximum number of times it allowed.");
    return;
  }

  try {
    const dek = await importDek(base64UrlToBuf(key), false);
    const task = await decryptTask(share, dek);
    renderTask(task);
  } catch (err) {
    showError("Couldn't decrypt this link — the key looks wrong, or the link was corrupted.");
  }
}

main();
