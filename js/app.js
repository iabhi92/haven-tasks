import { getAllTasks, putTask, deleteTask, getKeyring, putKeyring } from "./store.js?v=20260803k";
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
  showSetupScreen,
  showRecoveryCodeScreen,
  showUnlockScreen,
  showRecoveryForm,
  showResetPassphraseScreen,
  showApp,
  showLockScreen,
  setSetupError,
  setUnlockError,
  setRecoveryError,
  setResetError,
} from "./ui.js?v=20260803k";
import {
  PBKDF2_ITERATIONS,
  KDF_NAME,
  generateSalt,
  deriveKek,
  generateDek,
  wrapDek,
  unwrapDek,
  importDek,
  encryptTask,
  decryptTask,
  generateRecoveryCode,
  normalizeRecoveryCode,
  bufToBase64,
  base64ToBuf,
} from "./crypto.js?v=20260803k";
import {
  generateSyncToken,
  pushRecords,
  pullRecords,
  pushKeyringBootstrap,
  pullKeyringBootstrap,
} from "./sync.js?v=20260803k";

const STATUSES = ["todo", "in-progress", "done"];

let tasks = [];
let view = "board";
let searchQuery = "";
let draggedId = null;
let dek = null; // the in-memory DEK CryptoKey — null whenever locked

const SYNC_SERVER_KEY = "haven-sync-server";
const SYNC_TOKEN_KEY = "haven-sync-token";
const SYNC_LAST_KEY = "haven-sync-last";

// Setup is a two-step flow (passphrase -> confirm recovery code saved), so the
// generated keyring/DEK/code have to sit here in between those two steps.
let pendingKeyring = null;
let pendingDek = null;
let pendingRecoveryCode = null;

// DEK recovered via recovery code, pending a new passphrase to re-wrap it under.
let recoveredDek = null;

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

// Encrypt-before-store: store.js only ever sees {id, iv, ciphertext, updatedAt} —
// id and updatedAt stay cleartext metadata (per docs/ARCHITECTURE.md §3), everything
// else about the task lives only inside the ciphertext.
async function persistTask(task) {
  const { iv, ciphertext } = await encryptTask(task, dek);
  await putTask({ id: task.id, iv, ciphertext, updatedAt: task.updatedAt });
}

// Decrypt-on-load: a record that fails to decrypt under the current DEK (corrupted,
// or somehow from a different keyring) is unrecoverable — skip it rather than let one
// bad record crash loading every other task.
async function loadAndDecryptTasks() {
  const records = await getAllTasks();
  const decrypted = [];
  for (const record of records) {
    try {
      decrypted.push(await decryptTask(record, dek));
    } catch (err) {
      console.error("Skipping a task record that failed to decrypt:", record.id, err);
    }
  }
  return decrypted;
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
  await persistTask(task);
}

async function updateTask(partial) {
  const task = tasks.find((t) => t.id === partial.id);
  if (!task) return;
  Object.assign(task, partial, { updatedAt: now() });
  render();
  await persistTask(task);
}

async function removeTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  render();
  await deleteTask(id);

  // Local storage hard-deletes immediately (as it always has, since Phase 1) — but
  // if sync is on, other devices need to learn about this deletion too, and once
  // it's gone locally there's no second chance to tell them. Push a tombstone now,
  // while we still know it happened. A deletion that occurs before sync was ever
  // enabled can never be propagated later — an honest, documented limitation, not
  // a bug (see docs/ARCHITECTURE.md §5).
  const config = getSyncConfig();
  if (config) {
    try {
      await pushRecords(config.server, config.token, [{ id, updatedAt: now(), deleted: true }]);
    } catch (err) {
      console.error("Failed to push deletion tombstone to sync server:", err);
    }
  }
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

// ---------- sync (Phase 6, optional) ----------

function getSyncConfig() {
  const server = localStorage.getItem(SYNC_SERVER_KEY);
  const token = localStorage.getItem(SYNC_TOKEN_KEY);
  if (!server || !token) return null;
  return { server, token };
}

function setSyncConfig(server, token) {
  localStorage.setItem(SYNC_SERVER_KEY, server);
  localStorage.setItem(SYNC_TOKEN_KEY, token);
}

function clearSyncConfig() {
  localStorage.removeItem(SYNC_SERVER_KEY);
  localStorage.removeItem(SYNC_TOKEN_KEY);
  localStorage.removeItem(SYNC_LAST_KEY);
}

// Push every local record, then pull whatever changed remotely since the last
// sync and merge it in (last-write-wins by updatedAt — see docs/ARCHITECTURE.md
// §5). Pushing everything every time, not just a local diff, is the simple v1
// choice the brief explicitly allows ("CRDT-based merge is later") — the server
// upsert is idempotent, so a redundant push of an unchanged record is harmless,
// just not maximally efficient.
async function syncNow() {
  const config = getSyncConfig();
  if (!config) throw new Error("Sync is not configured");

  const localRecords = await getAllTasks();
  await pushRecords(config.server, config.token, localRecords);

  const since = Number(localStorage.getItem(SYNC_LAST_KEY) || "0");
  const remoteRecords = await pullRecords(config.server, config.token, since);

  for (const remote of remoteRecords) {
    const local = localRecords.find((r) => r.id === remote.id);
    if (local && local.updatedAt >= remote.updatedAt) continue; // local already newer or equal
    if (remote.deleted) {
      await deleteTask(remote.id);
    } else {
      await putTask({ id: remote.id, iv: remote.iv, ciphertext: remote.ciphertext, updatedAt: remote.updatedAt });
    }
  }

  localStorage.setItem(SYNC_LAST_KEY, String(now()));

  tasks = await loadAndDecryptTasks();
  render();

  return { pushed: localRecords.length, pulled: remoteRecords.length };
}

function refreshSyncModalState() {
  const config = getSyncConfig();
  const setupError = document.getElementById("syncSetupError");
  const statusEl = document.getElementById("syncStatus");
  setupError.textContent = "";
  statusEl.textContent = "";
  statusEl.classList.remove("is-ok");
  if (config) {
    document.getElementById("syncSetupSection").hidden = true;
    document.getElementById("syncActiveSection").hidden = false;
    document.getElementById("syncServerDisplay").textContent = config.server;
    document.getElementById("syncTokenDisplay").textContent = config.token;
  } else {
    document.getElementById("syncSetupSection").hidden = false;
    document.getElementById("syncActiveSection").hidden = true;
    document.getElementById("syncServerUrl").value = "";
    document.getElementById("syncTokenInput").value = "";
    document.getElementById("syncJoinFields").hidden = true;
    document.getElementById("syncJoinRecoveryCode").value = "";
    document.getElementById("syncJoinPassphrase").value = "";
  }
}

function openSyncModal() {
  refreshSyncModalState();
  document.getElementById("syncModal").hidden = false;
}

// Creating a fresh bucket: generate a token, publish this device's own recovery
// wrap (already sitting in its local keyring since Phase 4) so a second device
// can join later, then do a normal sync.
async function createSyncBucket(server, setupError, statusEl) {
  const token = generateSyncToken();
  const localKeyring = await getKeyring();

  statusEl.textContent = "Syncing…";
  try {
    await pushKeyringBootstrap(server, token, {
      wrappedDekRecovery: localKeyring.wrappedDekRecovery,
      wrapIvRecovery: localKeyring.wrapIvRecovery,
      saltRecovery: localKeyring.saltRecovery,
      updatedAt: now(),
    });
    setSyncConfig(server, token);
    localStorage.setItem(SYNC_LAST_KEY, "0");
    refreshSyncModalState();
    const result = await syncNow();
    statusEl.textContent = `Synced. Pushed ${result.pushed}, pulled ${result.pulled}.`;
    statusEl.classList.add("is-ok");
  } catch (err) {
    setupError.textContent = `Couldn't reach the sync server: ${err.message}`;
  }
}

// Joining an existing bucket: fetch the originating device's recovery wrap,
// unwrap it with the recovery code to obtain the *same* DEK, verify the
// current local passphrase is actually correct (never trust it blindly — a
// typo here would silently lock this device out), then re-wrap the shared DEK
// under the existing local KEK and adopt the shared recovery wrap too. See
// docs/ARCHITECTURE.md §5 and the Phase 6 note in docs/THREAT_MODEL.md.
async function joinSyncBucket(server, token, setupError, statusEl) {
  const recoveryCode = document.getElementById("syncJoinRecoveryCode").value;
  const confirmPassphrase = document.getElementById("syncJoinPassphrase").value;

  if (!recoveryCode || !confirmPassphrase) {
    setupError.textContent = "Joining needs the recovery code and your current passphrase.";
    return;
  }

  const warned = confirm(
    "Joining replaces this device's encryption key with the shared one from the other device. " +
    "Any tasks on this device that haven't been synced anywhere else will become inaccessible " +
    "(not deleted, just unreadable with the new key). Continue?"
  );
  if (!warned) return;

  const bootstrap = await pullKeyringBootstrap(server, token);
  if (!bootstrap) {
    setupError.textContent = "No sync data found for that token yet — has sync been enabled on the other device?";
    return;
  }

  const kekR = await deriveKek(normalizeRecoveryCode(recoveryCode), base64ToBuf(bootstrap.saltRecovery));
  let sharedDekBytes;
  try {
    sharedDekBytes = await unwrapDek(bootstrap.wrappedDekRecovery, bootstrap.wrapIvRecovery, kekR);
  } catch {
    setupError.textContent = "That recovery code doesn't match this sync token.";
    return;
  }

  const localKeyring = await getKeyring();
  const localKek = await deriveKek(confirmPassphrase, base64ToBuf(localKeyring.salt));
  try {
    // Correctness check only — the unwrapped result is discarded either way,
    // this just confirms the entered passphrase before overwriting anything.
    await unwrapDek(localKeyring.wrappedDek, localKeyring.wrapIv, localKek);
  } catch {
    setupError.textContent = "That's not your current passphrase.";
    return;
  }

  const extractableSharedDek = await importDek(sharedDekBytes, true);
  const { wrappedDek: newWrappedDek, wrapIv: newWrapIv } = await wrapDek(extractableSharedDek, localKek);

  await putKeyring({
    ...localKeyring,
    wrappedDek: newWrappedDek,
    wrapIv: newWrapIv,
    saltRecovery: bootstrap.saltRecovery,
    wrappedDekRecovery: bootstrap.wrappedDekRecovery,
    wrapIvRecovery: bootstrap.wrapIvRecovery,
  });

  dek = await importDek(sharedDekBytes);
  setSyncConfig(server, token);
  localStorage.setItem(SYNC_LAST_KEY, "0");

  refreshSyncModalState();
  statusEl.textContent = "Syncing…";
  try {
    const result = await syncNow();
    statusEl.textContent = `Joined. Synced. Pushed ${result.pushed}, pulled ${result.pulled}.`;
    statusEl.classList.add("is-ok");
  } catch (err) {
    statusEl.textContent = `Joined, but couldn't reach the sync server yet: ${err.message}`;
  }
}

function wireSyncModal() {
  const overlay = document.getElementById("syncModal");
  const serverInput = document.getElementById("syncServerUrl");
  const tokenInput = document.getElementById("syncTokenInput");
  const setupError = document.getElementById("syncSetupError");
  const statusEl = document.getElementById("syncStatus");

  tokenInput.addEventListener("input", () => {
    document.getElementById("syncJoinFields").hidden = !tokenInput.value.trim();
  });

  document.getElementById("enableSyncBtn").addEventListener("click", async () => {
    const server = serverInput.value.trim().replace(/\/+$/, "");
    setupError.textContent = "";

    if (!/^https?:\/\/.+/.test(server)) {
      setupError.textContent = "Enter a server URL starting with http:// or https://.";
      return;
    }

    const pastedToken = tokenInput.value.trim();
    if (pastedToken) {
      await joinSyncBucket(server, pastedToken, setupError, statusEl);
    } else {
      await createSyncBucket(server, setupError, statusEl);
    }
  });

  document.getElementById("disableSyncBtn").addEventListener("click", () => {
    clearSyncConfig();
    refreshSyncModalState();
  });

  document.getElementById("syncNowBtn").addEventListener("click", async () => {
    statusEl.textContent = "Syncing…";
    statusEl.classList.remove("is-ok");
    try {
      const result = await syncNow();
      statusEl.textContent = `Synced. Pushed ${result.pushed}, pulled ${result.pulled}.`;
      statusEl.classList.add("is-ok");
    } catch (err) {
      statusEl.textContent = `Couldn't reach the sync server: ${err.message}`;
    }
  });

  document.getElementById("copySyncTokenBtn").addEventListener("click", async () => {
    const config = getSyncConfig();
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config.token);
    } catch {
      // Non-fatal — the token text is user-select:all, manual copy still works.
    }
  });

  document.getElementById("closeSyncModalBtn").addEventListener("click", () => {
    overlay.hidden = true;
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
}

async function persistReorder(status) {
  const inStatus = tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);
  await Promise.all(inStatus.map((t) => persistTask(t)));
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
  const revealBtn = document.getElementById("viewRevealBtn");
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
  revealBtn.addEventListener("click", () => {
    view = "reveal";
    setView(view);
    render();
    updateReveal(document.getElementById("revealDemoInput").value);
  });
}

// Live plaintext/ciphertext demo — runs the exact same encryptTask() every real
// task goes through, on whatever the user is currently typing. Nothing here is
// persisted; it exists purely to show real bytes, per docs/ARCHITECTURE.md §6.
let revealToken = 0;

async function updateReveal(title) {
  const token = ++revealToken;
  const demoTask = {
    id: "demo-preview",
    title,
    notes: "",
    status: "todo",
    priority: "medium",
    dueDate: null,
    order: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  const record = await encryptTask(demoTask, dek);
  if (token !== revealToken) return; // a newer keystroke already superseded this one

  document.getElementById("revealPlaintext").textContent = JSON.stringify(demoTask, null, 2);
  document.getElementById("revealCiphertext").textContent = JSON.stringify(
    { id: demoTask.id, iv: record.iv, ciphertext: record.ciphertext, updatedAt: demoTask.updatedAt },
    null,
    2
  );
}

function wireRevealView() {
  const input = document.getElementById("revealDemoInput");
  input.addEventListener("input", () => {
    if (dek) updateReveal(input.value);
  });

  document.getElementById("dumpDbBtn").addEventListener("click", async () => {
    // The real, currently-stored records — exactly what DevTools would show,
    // just surfaced inside the app itself instead of making the user go find it.
    const records = await getAllTasks();
    document.getElementById("dbDumpOutput").textContent = JSON.stringify(records, null, 2);
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

function getCmdkItems() {
  return [
    { label: "New task", hint: "Enter", action: () => document.getElementById("quickAddInput").focus() },
    { label: "Focus search", hint: "/", action: () => document.getElementById("searchInput").focus() },
    { label: "Switch to board view", action: () => { view = "board"; setView(view); render(); } },
    { label: "Switch to list view", action: () => { view = "list"; setView(view); render(); } },
    {
      label: "How your data is protected",
      action: () => {
        view = "reveal";
        setView(view);
        render();
        updateReveal(document.getElementById("revealDemoInput").value);
      },
    },
    { label: "Export all tasks as JSON", hint: ".json", action: exportTasks },
    { label: "Sync settings", action: openSyncModal },
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

async function afterUnlock() {
  tasks = await loadAndDecryptTasks();
  render();
  showApp();
  document.getElementById("quickAddInput").focus();
}

function wireLockScreen() {
  const setupForm = document.getElementById("setupForm");
  const unlockForm = document.getElementById("unlockForm");
  const recoveryForm = document.getElementById("recoveryForm");
  const resetPassphraseForm = document.getElementById("resetPassphraseForm");
  const recoveryCheckbox = document.getElementById("recoveryCodeConfirmCheckbox");
  const recoveryContinueBtn = document.getElementById("recoveryCodeContinueBtn");
  const copyRecoveryCodeBtn = document.getElementById("copyRecoveryCodeBtn");
  const forgotPassphraseBtn = document.getElementById("forgotPassphraseBtn");
  const backToUnlockBtn = document.getElementById("backToUnlockBtn");

  setupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const passphrase = document.getElementById("setupPassphrase").value;
    const confirmPassphrase = document.getElementById("setupPassphraseConfirm").value;
    setSetupError("");

    if (passphrase.length < 10) {
      setSetupError("Passphrase must be at least 10 characters.");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      setSetupError("Passphrases don't match.");
      return;
    }

    const salt = generateSalt();
    const kek = await deriveKek(passphrase, salt);
    const newDek = await generateDek();
    const { wrappedDek, wrapIv } = await wrapDek(newDek, kek);

    const recoveryCode = generateRecoveryCode();
    const saltRecovery = generateSalt();
    const kekR = await deriveKek(normalizeRecoveryCode(recoveryCode), saltRecovery);
    const { wrappedDek: wrappedDekRecovery, wrapIv: wrapIvRecovery } = await wrapDek(newDek, kekR);

    // Self-verify both wraps before the user is ever shown the code — never show a
    // recovery code, or finish a setup, that quietly doesn't actually work.
    const rawDekBytes = await unwrapDek(wrappedDek, wrapIv, kek);
    await unwrapDek(wrappedDekRecovery, wrapIvRecovery, kekR);

    pendingDek = await importDek(rawDekBytes);
    pendingKeyring = {
      kdf: KDF_NAME,
      kdfParams: { iterations: PBKDF2_ITERATIONS },
      salt: bufToBase64(salt),
      wrappedDek,
      wrapIv,
      saltRecovery: bufToBase64(saltRecovery),
      wrappedDekRecovery,
      wrapIvRecovery,
      version: 1,
    };
    pendingRecoveryCode = recoveryCode;

    document.getElementById("setupPassphrase").value = "";
    document.getElementById("setupPassphraseConfirm").value = "";

    showRecoveryCodeScreen(recoveryCode);
  });

  recoveryCheckbox.addEventListener("change", () => {
    recoveryContinueBtn.disabled = !recoveryCheckbox.checked;
  });

  copyRecoveryCodeBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pendingRecoveryCode || "");
    } catch {
      // Clipboard permission denied/unavailable — the code text itself has
      // user-select:all, so manual copy still works. Non-fatal either way.
    }
  });

  recoveryContinueBtn.addEventListener("click", async () => {
    await putKeyring(pendingKeyring);
    dek = pendingDek;
    pendingKeyring = null;
    pendingDek = null;
    pendingRecoveryCode = null;
    await afterUnlock();
  });

  unlockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const passphraseInput = document.getElementById("unlockPassphrase");
    setUnlockError("");

    const keyring = await getKeyring();
    const kek = await deriveKek(passphraseInput.value, base64ToBuf(keyring.salt));

    try {
      const rawDekBytes = await unwrapDek(keyring.wrappedDek, keyring.wrapIv, kek);
      dek = await importDek(rawDekBytes);
    } catch {
      // AES-GCM auth-tag failure on a wrong KEK — fails closed, never a garbage DEK.
      setUnlockError("Wrong passphrase.");
      passphraseInput.value = "";
      passphraseInput.focus();
      return;
    }

    // Same reasoning as the setup path — the passphrase's job is done once it's
    // derived the KEK above, so it shouldn't keep sitting in the DOM.
    passphraseInput.value = "";

    await afterUnlock();
  });

  forgotPassphraseBtn.addEventListener("click", () => {
    setUnlockError("");
    document.getElementById("unlockPassphrase").value = "";
    setRecoveryError("");
    document.getElementById("recoveryCodeInput").value = "";
    showRecoveryForm();
  });

  backToUnlockBtn.addEventListener("click", () => {
    setRecoveryError("");
    showUnlockScreen();
  });

  recoveryForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const codeInput = document.getElementById("recoveryCodeInput");
    setRecoveryError("");

    const keyring = await getKeyring();
    if (!keyring.wrappedDekRecovery) {
      setRecoveryError("No recovery code was ever set up on this device.");
      return;
    }

    const kekR = await deriveKek(normalizeRecoveryCode(codeInput.value), base64ToBuf(keyring.saltRecovery));

    try {
      const rawDekBytes = await unwrapDek(keyring.wrappedDekRecovery, keyring.wrapIvRecovery, kekR);
      // extractable: true — it's about to be wrapped again under a new passphrase-derived KEK.
      recoveredDek = await importDek(rawDekBytes, true);
    } catch {
      setRecoveryError("That recovery code doesn't match.");
      codeInput.value = "";
      codeInput.focus();
      return;
    }

    codeInput.value = "";
    showResetPassphraseScreen();
  });

  resetPassphraseForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newPassphrase = document.getElementById("resetPassphrase").value;
    const confirmNewPassphrase = document.getElementById("resetPassphraseConfirm").value;
    setResetError("");

    if (newPassphrase.length < 10) {
      setResetError("Passphrase must be at least 10 characters.");
      return;
    }
    if (newPassphrase !== confirmNewPassphrase) {
      setResetError("Passphrases don't match.");
      return;
    }

    // Same pattern as changing a passphrase normally (docs/ARCHITECTURE.md §2): only
    // salt/wrappedDek/wrapIv change. Task data and the recovery wrap are untouched —
    // the same recovery code keeps working after this.
    const keyring = await getKeyring();
    const newSalt = generateSalt();
    const newKek = await deriveKek(newPassphrase, newSalt);
    const { wrappedDek: newWrappedDek, wrapIv: newWrapIv } = await wrapDek(recoveredDek, newKek);

    await putKeyring({ ...keyring, salt: bufToBase64(newSalt), wrappedDek: newWrappedDek, wrapIv: newWrapIv });

    const rawDekBytes = await unwrapDek(newWrappedDek, newWrapIv, newKek);
    dek = await importDek(rawDekBytes);
    recoveredDek = null;

    document.getElementById("resetPassphrase").value = "";
    document.getElementById("resetPassphraseConfirm").value = "";

    await afterUnlock();
  });
}

function wireLockButton() {
  document.getElementById("lockBtn").addEventListener("click", () => {
    dek = null;
    tasks = [];
    document.getElementById("unlockPassphrase").value = "";
    setUnlockError("");
    showLockScreen();
    showUnlockScreen();
  });
}

async function boot() {
  const keyring = await getKeyring();
  if (keyring) {
    showUnlockScreen();
  } else {
    showSetupScreen();
  }
  wireLockScreen();
  wireLockButton();
  wireQuickAdd();
  wireSearch();
  wireViewToggle();
  wireEditModal();
  wireDragAndDrop();
  wireCommandPalette();
  wireRevealView();
  wireSyncModal();
}

wireThemeToggle();
boot();
