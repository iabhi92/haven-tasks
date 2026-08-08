// Standalone viewer for fragment-key share links — no unlock, no keyring, no
// IndexedDB. Reads {server, id} from the query string and the decryption
// key(s) from location.hash (never sent to any server, per the URL spec —
// see docs/ARCHITECTURE.md "Fragment-key share links"), fetches the
// ciphertext, decrypts in-page, and renders it. Nothing here is ever
// persisted.
//
// Two link formats, both supported: the current one (selective disclosure —
// docs/ARCHITECTURE.md "Selective disclosure share links") carries a JSON
// map of {field: key} in the fragment, one key per shared field, and the
// server's ciphertext is a {fields: {field: {iv, ciphertext}}} bundle. Links
// created before that feature carry a single raw key and a single whole-task
// ciphertext — still valid for up to their original expiry, so this viewer
// tells the two apart (see parseFragmentKey()) rather than breaking them.

import { importDek, decryptTask, base64UrlToBuf } from "./crypto.js?v=20260809i";
import { pullShare } from "./sync.js?v=20260806a";

const STATUS_LABEL = { todo: "To Do", "in-progress": "In Progress", done: "Done" };
const PRIORITY_LABEL = { low: "Low", medium: "Medium", high: "High" };
const SHARE_FIELD_LABEL = { title: "Title", notes: "Notes", status: "Status", priority: "Priority", dueDate: "Due date", tags: "Tags", subtasks: "Subtasks" };

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

// omittedFields is null for a pre-selective-disclosure link (every field
// was always shared, nothing to note) or a Set of field names the sender
// chose *not* to include — each gets a plain "not shared" note instead of
// silently vanishing, so it's visibly a deliberate omission, not a bug.
function renderTask(task, omittedFields) {
  const container = document.getElementById("shareViewContent");
  const omitted = (field) => omittedFields && omittedFields.has(field);
  const notSharedNote = (field) => el("p", "share-view-not-shared", `🔒 ${SHARE_FIELD_LABEL[field]} not shared`);

  container.appendChild(el("h2", "share-view-title", omitted("title") ? "(title not shared)" : task.title || "(untitled task)"));

  {
    // status/priority always have a real value on every task (never
    // naturally absent the way notes/tags/subtasks can be) — so, unlike
    // those, an omitted one always gets its own explicit badge rather than
    // silently vanishing from the row, which would read as "no priority"
    // instead of "priority not shared". dueDate is the one exception: it's
    // routinely and legitimately absent on a normal task too, so an
    // omitted due date stays silently absent, same as an unset one already
    // reads today — the lower-stakes, already-expected ambiguity.
    const meta = el("div", "share-view-meta");
    meta.appendChild(omitted("status") ? badge("share-view-not-shared-badge", "🔒 status") : badge(`badge-status-${task.status}`, STATUS_LABEL[task.status] || task.status));
    meta.appendChild(omitted("priority") ? badge("share-view-not-shared-badge", "🔒 priority") : badge(`badge-priority-${task.priority}`, PRIORITY_LABEL[task.priority] || task.priority));
    const dueLabel = !omitted("dueDate") && formatDueDate(task.dueDate);
    if (dueLabel) meta.appendChild(badge("badge-due", dueLabel));
    container.appendChild(meta); // status/priority badges above are unconditional, so meta is never empty
  }

  if (omitted("tags")) {
    container.appendChild(notSharedNote("tags"));
  } else if (task.tags && task.tags.length > 0) {
    const tagWrap = el("div", "task-tags");
    for (const tag of task.tags) tagWrap.appendChild(el("span", "tag-chip", tag));
    container.appendChild(tagWrap);
  }

  if (omitted("notes")) {
    container.appendChild(notSharedNote("notes"));
  } else if (task.notes) {
    container.appendChild(el("p", "share-view-notes", task.notes));
  }

  if (omitted("subtasks")) {
    container.appendChild(notSharedNote("subtasks"));
  } else if (task.subtasks && task.subtasks.length > 0) {
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

// Tells the current multi-field format apart from a pre-selective-disclosure
// link's single raw key: the current format's fragment decodes (as UTF-8,
// strictly — real key bytes essentially never happen to also be valid
// UTF-8) to a JSON object of {field: base64url key}. Anything that fails
// either step is treated as an old-style single key, not an error.
function parseFragmentKey(key) {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBuf(key));
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { multiField: true, keyMap: parsed };
  } catch {
    // falls through to the single-key legacy format
  }
  return { multiField: false };
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

  const parsedKey = parseFragmentKey(key);
  try {
    if (parsedKey.multiField) {
      const bundle = JSON.parse(share.ciphertext).fields;
      const task = {};
      const omittedFields = new Set(Object.keys(SHARE_FIELD_LABEL));
      for (const [field, keyB64url] of Object.entries(parsedKey.keyMap)) {
        if (!bundle[field]) continue;
        const fieldDek = await importDek(base64UrlToBuf(keyB64url), false);
        task[field] = await decryptTask(bundle[field], fieldDek);
        omittedFields.delete(field);
      }
      renderTask(task, omittedFields);
    } else {
      const dek = await importDek(base64UrlToBuf(key), false);
      const task = await decryptTask(share, dek);
      renderTask(task, null);
    }
  } catch (err) {
    showError("Couldn't decrypt this link — the key looks wrong, or the link was corrupted.");
  }
}

main();
