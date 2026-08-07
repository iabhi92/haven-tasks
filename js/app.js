import {
  getAllTasks,
  getTask,
  putTask,
  deleteTask,
  getKeyring,
  putKeyring,
  appendHistoryEntry,
  getAllHistoryEntries,
  getLastHistoryEntry,
  setActiveVault,
  getAllRules,
  putRule,
  deleteRule,
} from "./store.js?v=20260807a";
import { evaluateTask } from "./automation.js?v=20260807a";
import { computeInsights } from "./insights.js?v=20260807a";
import { generateICS } from "./ical.js?v=20260807a";
import { parseCSVToTasks } from "./csv.js?v=20260807a";
import { TEMPLATES, findTemplate } from "./templates.js?v=20260807a";
import {
  renderBoard,
  renderList,
  setEmptyState,
  setView,
  openEditModal,
  closeEditModal,
  readEditForm,
  openAddModal,
  closeAddModal,
  readAddForm,
  renderSubtaskList,
  showUndoToast,
  showInfoToast,
  getDragAfterElement,
  renderStats,
  renderBoardFooter,
  initPasswordToggles,
  initPassphraseFeedback,
  renderHistoryReport,
  renderAutomationRulesList,
  renderInsights,
  renderCalendar,
  renderAssistantTaskOptions,
  setAssistantProgress,
  showAssistantEnabled,
  setAssistantOutputText,
  setAssistantSuggestions,
  getSelectedAssistantSuggestions,
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
} from "./ui.js?v=20260807b";
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
  bufToBase64Url,
  generateSigningKeypair,
  exportSigningPublicKey,
  importSigningPublicKey,
  wrapSigningKey,
  unwrapSigningKey,
  signBytes,
  verifyBytes,
  sha256Hex,
  recoveryCodeToBytes,
  bytesToRecoveryCode,
  splitSecret,
  reconstructSecret,
  encodeShare,
  decodeShare,
  generateHardwareSecret,
  wrapRawBytes,
} from "./crypto.js?v=20260807a";
import {
  isWebAuthnAvailable,
  registerPasskey,
  writeLargeBlob,
  readLargeBlob,
} from "./webauthn.js?v=20260807a";
import {
  generateSyncToken,
  pushRecords,
  pullRecords,
  pushKeyringBootstrap,
  pullKeyringBootstrap,
  pushShare,
  deleteShare,
} from "./sync.js?v=20260807a";

const STATUSES = ["todo", "in-progress", "done"];

let tasks = [];
let view = "board";
let calendarMonth = new Date(); // any Date within the currently-viewed month — only year/month read
let searchQuery = "";
let smartView = "all";
let priorityFilter = "";
let tagFilter = "";
let sortMode = "manual";
let draggedId = null;
let dek = null; // the in-memory DEK CryptoKey — null whenever locked

// ---------- AI assistant (Layer 3, js/ai.js) ----------
// js/ai.js is dynamically imported (not a static top-of-file import like
// every other module here) specifically so nobody who never opens the AI
// panel and clicks Enable ever fetches it — matching the "opt-in, nothing
// downloads until you ask" claim in the panel's own copy and in
// docs/ARCHITECTURE.md "On-device AI assistant".
let assistantModule = null;
let assistantEnabled = false;
async function getAssistantModule() {
  if (!assistantModule) assistantModule = await import("./ai.js?v=20260807a");
  return assistantModule;
}

// Per-device Ed25519 identity for the tamper-evident history log (docs/
// ARCHITECTURE.md "Tamper-evident signed task history") — distinct from the
// DEK, unwrapped alongside it at unlock, null whenever locked.
let historySigningKey = null; // private CryptoKey, sign-only
let historySigningPublicKeyB64 = null; // this device's *current* public key
// The hash of the most-recently-appended entry's full signed content, used
// as the next entry's prevHash. Cached in memory rather than re-read from
// IndexedDB on every mutation; (re)initialized from the real last entry at
// unlock via primeHistoryChainTip().
let historyChainTip = "GENESIS";

// ---------- ephemeral / self-destructing tasks (Layer 3) ----------
// Each self-destructing task is encrypted under its own per-task key (not the
// shared vault DEK), which is itself wrapped under the DEK and stored
// alongside the ciphertext. "Erasing" a task means deleting the wrapped
// per-task key — the ciphertext can be left in place (or removed later) but
// is permanently undecryptable either way, since there's no copy of the raw
// key left anywhere. See docs/ARCHITECTURE.md "Ephemeral tasks".
// Non-extractable CryptoKeys, held only while unlocked — never the source of
// a repeat export, same discipline as the main `dek`.
const ephemeralTaskKeys = new Map(); // taskId -> CryptoKey
let ephemeralSweepInterval = null;

// ---------- local automation rules (Layer 3) ----------
// Runs entirely client-side against the already-decrypted in-memory task
// list — no server involved, ever. See docs/ARCHITECTURE.md "Local
// automation rules" and js/automation.js for the (deliberately non-chaining)
// evaluator itself.
let automationRules = [];
let automationSweepInProgress = false;

// ---------- duress / decoy vault (Layer 3) ----------
// Whichever passphrase the unlock form is given, it either opens the real
// vault or (if a decoy is configured and the main vault's passphrase didn't
// match) the decoy one — same form, same success behavior, same error on
// double failure. See docs/ARCHITECTURE.md "Duress / decoy vault" for what
// this does and doesn't guarantee.
let activeVaultIsDecoy = false;

// Projects are a lightweight client-side grouping — a plain string field on
// each task (default "Inbox"), same encrypted envelope as everything else.
// Not a separate key/vault per project (that's "compartmentalised vaults" in
// docs/FEATURES.md, a much bigger crypto change) — this is just a filter, the
// same pattern as tags. Because of that, a project only "exists" once at
// least one task belongs to it: there's nowhere to durably store an empty
// project without either a new encrypted store (schema/sync changes) or
// stashing the name in plaintext localStorage (which would leak a project
// name outside the encryption boundary — not acceptable here). An honest,
// documented limitation, not an oversight.
let activeProject = "Inbox";

let selectionMode = false;
let selectedIds = new Set();

// The task currently open in the share modal — held here (not re-read from
// `tasks` on click) so the share reflects what was on screen when "Share
// link…" was pressed, same as the edit form itself does.
let shareModalTask = null;

// {id, server} of the share currently shown in shareAfterSection — needed by
// the revoke button, which only has the id/server, not the decryption key
// (that part never leaves the URL fragment, so revoking never needs it).
let shareModalCreated = null;

const SYNC_SERVER_KEY = "haven-sync-server";
const SYNC_TOKEN_KEY = "haven-sync-token";
const SYNC_LAST_KEY = "haven-sync-last";

// Share links relay through a server too (someone has to host the ciphertext
// between sender and recipient), but unlike sync it needs no per-user setup:
// falls back to the project's own hosted relay if the user hasn't configured
// a sync server of their own. Either way the relay only ever sees ciphertext
// under a fresh key it never receives — see docs/ARCHITECTURE.md.
const DEFAULT_SHARE_SERVER = "https://haven-sync.onrender.com";
const SHARE_FIELDS = ["title", "notes", "status", "priority", "dueDate", "tags", "subtasks"];

// Setup is a two-step flow (passphrase -> confirm recovery code saved), so the
// generated keyring/DEK/code have to sit here in between those two steps.
let pendingKeyring = null;
let pendingDek = null;
let pendingRecoveryCode = null;
let pendingSigningKey = null;
let pendingSigningPublicKeyB64 = null;

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

// Partitions by status. In manual mode each group is ordered by the persisted
// drag-order; otherwise `list` is expected to already be sorted (by sortTasks())
// and that relative order is preserved via a stable partition, not re-sorted.
function groupByStatus(list) {
  const groups = { todo: [], "in-progress": [], done: [] };
  for (const t of list) groups[t.status].push(t);
  if (sortMode === "manual") {
    for (const status of STATUSES) groups[status].sort((a, b) => a.order - b.order);
  }
  return groups;
}

function matchesSearch(task, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    task.title.toLowerCase().includes(q) ||
    (task.notes || "").toLowerCase().includes(q) ||
    (task.tags || []).some((tag) => tag.toLowerCase().includes(q))
  );
}

// Same local-midnight comparison js/ui.js's dueBadgeInfo() uses, so "Today"/
// "overdue" here always agrees with what the due-date badge on the card shows.
function dueDiffDays(dueDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + "T00:00:00");
  return Math.round((due - today) / 86400000);
}

function matchesSmartView(task, smartViewValue) {
  if (smartViewValue === "all") return true;
  if (!task.dueDate) return false;
  const diff = dueDiffDays(task.dueDate);
  if (smartViewValue === "today") return diff === 0;
  if (smartViewValue === "upcoming") return diff > 0;
  if (smartViewValue === "overdue") return diff < 0 && task.status !== "done";
  return true;
}

function projectOf(task) {
  return task.project || "Inbox";
}

function visibleTasks() {
  return tasks.filter(
    (t) =>
      projectOf(t) === activeProject &&
      matchesSearch(t, searchQuery) &&
      matchesSmartView(t, smartView) &&
      (!priorityFilter || t.priority === priorityFilter) &&
      (!tagFilter || (t.tags || []).includes(tagFilter))
  );
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function sortTasks(list) {
  if (sortMode === "manual") return list;
  const sorted = [...list];
  if (sortMode === "dueDate") {
    sorted.sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });
  } else if (sortMode === "priority") {
    sorted.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
  } else if (sortMode === "created") {
    sorted.sort((a, b) => a.createdAt - b.createdAt);
  }
  return sorted;
}

function allTags() {
  const set = new Set();
  for (const t of tasks) for (const tag of t.tags || []) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Rebuilds the tag filter <select>'s options from whatever tags currently
// exist on any task, keeping the current selection if it's still a real tag.
function syncTagFilterOptions() {
  const select = document.getElementById("tagFilter");
  const tags = allTags();
  const current = select.value;
  select.textContent = "";
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All tags";
  select.appendChild(allOption);
  for (const tag of tags) {
    const opt = document.createElement("option");
    opt.value = tag;
    opt.textContent = tag;
    select.appendChild(opt);
  }
  select.value = tags.includes(current) ? current : "";
  if (select.value !== current) tagFilter = select.value;
}

function allProjects() {
  const set = new Set(["Inbox", activeProject]); // activeProject stays listed even with 0 tasks yet
  for (const t of tasks) set.add(projectOf(t));
  return [...set].sort((a, b) => (a === "Inbox" ? -1 : b === "Inbox" ? 1 : a.localeCompare(b)));
}

// Keeps the project switcher <select> and the add/edit modals' project
// <datalist> in sync with whatever projects currently exist.
function syncProjectUI() {
  const projects = allProjects();

  const switcher = document.getElementById("projectSwitcher");
  switcher.textContent = "";
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = p;
    switcher.appendChild(opt);
  }
  switcher.value = activeProject;

  const datalist = document.getElementById("projectOptions");
  datalist.textContent = "";
  for (const p of projects) {
    const opt = document.createElement("option");
    opt.value = p;
    datalist.appendChild(opt);
  }
}

function render() {
  const visible = visibleTasks();
  const hasAnyTasks = tasks.length > 0;
  const hasVisibleTasks = visible.length > 0;

  renderStats(tasks);
  renderBoardFooter(tasks);
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
    onOpen: async (task) => {
      if (task.destructed) {
        showInfoToast("This task self-destructed and can no longer be opened.");
        return;
      }
      // Registers this view (and erases the task if it just burned its last
      // one) *before* opening the modal — but still opens with the content
      // already decrypted into `task`, so a "burns after 1 view" task is
      // fully readable on the view that burns it, not blocked from it.
      if (task.selfDestruct && task.selfDestruct.mode === "views") {
        await registerEphemeralView(task.id);
      }
      editSubtasksDraft = (task.subtasks || []).map((s) => ({ ...s }));
      renderEditSubtasks();
      openEditModal(task);
      resetPomodoroStateForTask(task);
    },
    onDelete: (task) => deleteTasksWithUndo([task.id]),
    onDragStart: (task) => { draggedId = task.id; },
    onDragEnd: () => { draggedId = null; },
    selectionMode,
    selectedIds,
    onToggleSelect: (id) => {
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      render();
    },
  };

  const sortedVisible = sortTasks(visible);

  const sorted = [...sortedVisible].sort((a, b) => {
    const statusDiff = STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return sortMode === "manual" ? a.order - b.order : 0; // stable: keep sortTasks()'s order
  });

  renderBoard(groupByStatus(sortedVisible), handlers);
  renderList(sorted, handlers);
  syncTagFilterOptions();
  syncProjectUI();
  syncBulkActionBar();
  if (view === "insights") renderInsights(computeInsights(tasks));
  if (view === "calendar") {
    renderCalendar(calendarMonth, tasks, {
      onOpenTask: (task) => {
        editSubtasksDraft = (task.subtasks || []).map((s) => ({ ...s }));
        renderEditSubtasks();
        openEditModal(task);
        resetPomodoroStateForTask(task);
      },
    });
  }
  if (view === "assistant") renderAssistantTaskOptions(tasks);
  scheduleEphemeralSweep();
  scheduleAutomationSweep();
}

// render() runs far too often to await an async sweep inline (and
// sweepExpiredEphemeralTasks() itself calls render() again once it erases
// something) — this fire-and-forget wrapper with a reentrancy guard is what
// keeps that from turning into overlapping IndexedDB writes. Converges after
// one extra pass: an erased task no longer matches the sweep's own filter.
let sweepInProgress = false;
function scheduleEphemeralSweep() {
  if (sweepInProgress || !dek) return;
  sweepInProgress = true;
  sweepExpiredEphemeralTasks().finally(() => {
    sweepInProgress = false;
  });
}

function syncBulkActionBar() {
  const bar = document.getElementById("bulkActionBar");
  const count = document.getElementById("bulkActionCount");
  bar.hidden = selectedIds.size === 0;
  count.textContent = `${selectedIds.size} selected`;
}

function nextOrder(status) {
  const inStatus = tasks.filter((t) => t.status === status);
  if (inStatus.length === 0) return 0;
  return Math.max(...inStatus.map((t) => t.order)) + 1;
}

// Encrypt-before-store: store.js only ever sees {id, iv, ciphertext, updatedAt} —
// id and updatedAt stay cleartext metadata (per docs/ARCHITECTURE.md §3), everything
// else about the task lives only inside the ciphertext. `op`/`logHistory` feed the
// tamper-evident history log below — logHistory:false is for writes (like reorders)
// that aren't meaningful audit events, not a way to skip signing for content changes.
//
// `newSelfDestructSpec` (only passed from addTask, at creation) turns this
// into a fresh ephemeral task: `{mode: "time", expiresAt} | {mode: "views",
// maxViews}`. It's the one case persistTask generates a *new* per-task key
// rather than reusing whatever's already wrapped for this id — see
// docs/ARCHITECTURE.md "Ephemeral tasks".
async function persistTask(task, op = "update", logHistory = true, newSelfDestructSpec = null) {
  // selfDestruct/destructed are record-level metadata the UI attaches to the
  // in-memory task (see loadAndDecryptTasks/addTask) — stripped here so they
  // never end up duplicated inside the encrypted payload itself.
  const { selfDestruct: _sd, destructed: _d, erasedAt: _ea, ...content } = task;
  let iv, ciphertext;
  let selfDestruct = null;

  if (newSelfDestructSpec) {
    const rawTaskKey = await generateDek(); // extractable — only to wrap it, once
    const rawTaskKeyBytes = await crypto.subtle.exportKey("raw", rawTaskKey);
    const { wrappedDek: wrappedTaskKey, wrapIv: taskKeyWrapIv } = await wrapDek(rawTaskKey, dek);
    const taskKey = await importDek(rawTaskKeyBytes, false); // non-extractable for actual use
    ephemeralTaskKeys.set(task.id, taskKey);
    ({ iv, ciphertext } = await encryptTask(content, taskKey));
    selfDestruct = { ...newSelfDestructSpec, status: task.status, viewsUsed: 0, wrappedTaskKey, taskKeyWrapIv, erasedAt: null };
  } else if (ephemeralTaskKeys.has(task.id)) {
    const taskKey = ephemeralTaskKeys.get(task.id);
    ({ iv, ciphertext } = await encryptTask(content, taskKey));
    const existing = await getTask(task.id);
    if (existing && existing.selfDestruct) selfDestruct = { ...existing.selfDestruct, status: task.status };
  } else {
    ({ iv, ciphertext } = await encryptTask(content, dek));
  }

  const record = { id: task.id, iv, ciphertext, updatedAt: task.updatedAt };
  if (selfDestruct) record.selfDestruct = selfDestruct;
  await putTask(record);
  if (logHistory) await appendSignedHistoryEntry(task.id, op, iv, ciphertext);
}

// Deletes just the wrapped per-task key — see the module-level comment above
// `ephemeralTaskKeys` for why that alone makes the ciphertext permanently
// undecryptable. Safe to call on a task that's already erased or was never
// ephemeral (no-ops). Leaves the ciphertext row in place so the board can
// still show a "this task self-destructed" placeholder in its original
// column, and so the history entry below has a real payload hash to point
// at — see docs/ARCHITECTURE.md "Ephemeral tasks" for the honest scope note
// on what erasure does and doesn't guarantee.
async function eraseEphemeralTaskKey(taskId) {
  const record = await getTask(taskId);
  if (!record || !record.selfDestruct || !record.selfDestruct.wrappedTaskKey) return;

  const erasedRecord = {
    ...record,
    selfDestruct: { ...record.selfDestruct, wrappedTaskKey: null, taskKeyWrapIv: null, erasedAt: now() },
  };
  await putTask(erasedRecord);
  ephemeralTaskKeys.delete(taskId);
  await appendSignedHistoryEntry(taskId, "selfDestruct", record.iv, record.ciphertext);

  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx !== -1) {
    tasks[idx] = destructedTaskStub(tasks[idx], erasedRecord.selfDestruct.erasedAt);
    render(); // otherwise the board keeps showing stale content until some unrelated action re-renders it
  }
}

// The in-memory placeholder for an erased task — enough fields for every
// existing filter/sort/group/render path to treat it like any other task
// (empty title/notes/tags rather than missing ones), plus `destructed: true`
// so the UI can render it distinctly and refuse to open it for editing.
function destructedTaskStub(previous, erasedAt) {
  return {
    id: previous.id,
    title: "",
    project: previous.project,
    notes: "",
    status: previous.status,
    priority: previous.priority,
    dueDate: null,
    tags: [],
    subtasks: [],
    recurrence: null,
    order: previous.order,
    createdAt: previous.createdAt,
    updatedAt: now(),
    destructed: true,
    erasedAt,
  };
}

// Time-based fuses: checked against the in-memory task list (cheap — no IO
// unless something's actually expired) whenever render() runs, plus a coarse
// backstop interval for an idle tab left open past a task's expiry with no
// other interaction to trigger a render. View-based ("burn after reading")
// fuses are handled separately, at the point a task is opened — see
// registerEphemeralView().
async function sweepExpiredEphemeralTasks() {
  const expired = tasks.filter(
    (t) => !t.destructed && t.selfDestruct && t.selfDestruct.mode === "time" && t.selfDestruct.expiresAt <= now()
  );
  if (expired.length === 0) return;
  for (const t of expired) await eraseEphemeralTaskKey(t.id);
  render();
}

// Called when a "burn after reading" task is opened. Registers the view
// *before* showing the content (matches "burns after being opened" rather
// than "burns after being closed") — the task is still fully readable for
// this one view; erasure only blocks every view after it.
async function registerEphemeralView(taskId) {
  const record = await getTask(taskId);
  if (!record || !record.selfDestruct || record.selfDestruct.mode !== "views") return;
  if (!record.selfDestruct.wrappedTaskKey) return; // already erased

  const viewsUsed = record.selfDestruct.viewsUsed + 1;
  const updated = { ...record, selfDestruct: { ...record.selfDestruct, viewsUsed } };
  await putTask(updated);

  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx !== -1 && tasks[idx].selfDestruct) tasks[idx] = { ...tasks[idx], selfDestruct: { ...tasks[idx].selfDestruct, viewsUsed } };

  if (viewsUsed >= record.selfDestruct.maxViews) await eraseEphemeralTaskKey(taskId);
}

// ---------- local automation rules (Layer 3) ----------

async function loadAutomationRules() {
  const records = await getAllRules();
  const decrypted = [];
  for (const record of records) {
    try {
      // Reuses encryptTask/decryptTask as-is — they're already generic
      // AES-GCM-encrypt/decrypt-a-JSON-object, not actually task-specific.
      decrypted.push(await decryptTask(record, dek));
    } catch (err) {
      console.error("Skipping an automation rule that failed to decrypt:", record.id, err);
    }
  }
  automationRules = decrypted;
}

function renderAutomationModal() {
  renderAutomationRulesList(automationRules, { onDelete: removeAutomationRule });
}

async function addAutomationRule(trigger, action) {
  const rule = { id: uuid(), trigger, action, enabled: true, createdAt: now() };
  const { iv, ciphertext } = await encryptTask(rule, dek);
  await putRule({ id: rule.id, iv, ciphertext });
  automationRules.push(rule);
  renderAutomationModal();
  render(); // an onOverdue rule may match tasks that are already overdue — react now, not on the next unrelated render
}

async function removeAutomationRule(id) {
  automationRules = automationRules.filter((r) => r.id !== id);
  await deleteRule(id);
  renderAutomationModal();
}

// Same lazy-on-render + reentrancy-guard pattern as the ephemeral-task sweep
// above, and for the same reason: cheap to check on every render (a plain
// array filter, no IO, when there are no overdue matches — the common case),
// so there's no need for a dedicated polling loop.
async function sweepOverdueAutomationRules() {
  if (automationRules.length === 0) return;
  let anyChanged = false;
  for (let i = 0; i < tasks.length; i++) {
    const ruled = evaluateTask(automationRules, "onOverdue", tasks[i]);
    if (!ruled) continue;
    tasks[i] = { ...ruled, updatedAt: now() };
    await persistTask(tasks[i], "update");
    anyChanged = true;
  }
  if (anyChanged) render();
}

function scheduleAutomationSweep() {
  if (automationSweepInProgress || !dek) return;
  automationSweepInProgress = true;
  sweepOverdueAutomationRules().finally(() => {
    automationSweepInProgress = false;
  });
}

// ---------- tamper-evident history log ----------
// Every meaningful task mutation gets an append-only, hash-chained, signed
// entry — see docs/ARCHITECTURE.md "Tamper-evident signed task history".
// Entries record *that* and *when* a task changed (via a hash of its
// ciphertext), never the plaintext itself, so the log stays as
// privacy-preserving as everything else in the app.

// Fixed key order, no signature field yet — this is exactly what gets signed.
function historyEntryContent({ id, taskId, op, payloadHash, prevHash, timestamp, publicKey }) {
  return { id, taskId, op, payloadHash, prevHash, timestamp, publicKey };
}

async function canonicalBytes(obj) {
  return new TextEncoder().encode(JSON.stringify(obj));
}

// An entry's "own hash" (used as the *next* entry's prevHash) covers the
// signature too, like a git commit hash covers its own signature — so a
// resigned-but-otherwise-identical forged entry still breaks the chain.
async function historyEntryHash(entry) {
  return sha256Hex(await canonicalBytes({ ...historyEntryContent(entry), signature: entry.signature }));
}

async function primeHistoryChainTip() {
  const last = await getLastHistoryEntry();
  historyChainTip = last ? await historyEntryHash(last) : "GENESIS";
}

// Normal-unlock path: reuse the existing signing key if the keyring has one,
// or transparently create one if it doesn't — covers accounts created before
// this feature shipped, as a one-time local migration on their next unlock.
// `isDecoy` switches every field this reads/writes to its "...Decoy" twin —
// the decoy vault gets its own fully working signing identity and history
// chain, not a second-class version of the feature. See docs/ARCHITECTURE.md
// "Duress / decoy vault".
async function ensureLocalSigningKeyOnUnlock(keyring, kek, isDecoy = false) {
  const f = (name) => name + (isDecoy ? "Decoy" : "");
  if (keyring[f("wrappedSigningKey")]) {
    historySigningKey = await unwrapSigningKey(keyring[f("wrappedSigningKey")], keyring[f("signingKeyWrapIv")], kek);
    historySigningPublicKeyB64 = keyring[f("signingPublicKey")];
    await primeHistoryChainTip();
    return;
  }
  const signingKeypair = await generateSigningKeypair();
  const signingPublicKeyB64 = bufToBase64(await exportSigningPublicKey(signingKeypair.publicKey));
  const { wrappedSigningKey, signingKeyWrapIv } = await wrapSigningKey(signingKeypair.privateKey, kek);
  await putKeyring({
    ...keyring,
    [f("signingPublicKey")]: signingPublicKeyB64,
    [f("wrappedSigningKey")]: wrappedSigningKey,
    [f("signingKeyWrapIv")]: signingKeyWrapIv,
    [f("signingKeyLog")]: [{ publicKey: signingPublicKeyB64, startedAt: now() }],
  });
  historySigningKey = await unwrapSigningKey(wrappedSigningKey, signingKeyWrapIv, kek);
  historySigningPublicKeyB64 = signingPublicKeyB64;
  await primeHistoryChainTip(); // no local entries predate this device's very first key
}

async function appendSignedHistoryEntry(taskId, op, iv, ciphertext) {
  if (!historySigningKey) return; // locked, or history not yet initialized — skip rather than throw
  const payloadHash = op === "delete" ? null : await sha256Hex(await canonicalBytes({ iv, ciphertext }));
  const content = historyEntryContent({
    id: uuid(),
    taskId,
    op,
    payloadHash,
    prevHash: historyChainTip,
    timestamp: now(),
    publicKey: historySigningPublicKeyB64,
  });
  const signature = bufToBase64(await signBytes(historySigningKey, await canonicalBytes(content)));
  const entry = { ...content, signature };
  await appendHistoryEntry(entry);
  historyChainTip = await historyEntryHash(entry);
}

// Walks the full local chain and reports whether it's intact. Checks two
// independent things per entry: (1) prevHash actually matches the previous
// entry's own hash — catches reordering/deletion/insertion; (2) the
// signature verifies under a *trusted* public key (one that's ever been this
// device's active signing key, per the keyring's signingKeyLog) — catches
// content tampering. Keeps checking every entry (not just up to the first
// break) and returns a per-entry breakdown — {index, op, taskId, timestamp,
// hashPrefix, ok} for each — so "Chain intact" is something a user can
// inspect entry-by-entry, not a bare claim asked to be taken on faith.
async function verifyHistoryChain() {
  const rawEntries = await getAllHistoryEntries(); // already vault-aware — see store.js setActiveVault()
  const keyring = await getKeyring();
  const signingKeyLog = activeVaultIsDecoy ? keyring?.signingKeyLogDecoy : keyring?.signingKeyLog;
  const trustedKeys = new Set((signingKeyLog || []).map((k) => k.publicKey));

  let expectedPrevHash = "GENESIS";
  let firstBreak = null;
  const entries = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    let reason = null;

    if (entry.prevHash !== expectedPrevHash) {
      reason = "chain-broken";
    } else if (!trustedKeys.has(entry.publicKey)) {
      reason = "untrusted-signer";
    } else {
      let signatureValid;
      try {
        const publicKey = await importSigningPublicKey(base64ToBuf(entry.publicKey));
        const data = await canonicalBytes(historyEntryContent(entry));
        signatureValid = await verifyBytes(publicKey, data, base64ToBuf(entry.signature));
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) reason = "bad-signature";
    }

    const ownHash = await historyEntryHash(entry);
    entries.push({
      index: i,
      op: entry.op,
      taskId: entry.taskId,
      timestamp: entry.timestamp,
      hashPrefix: ownHash.slice(0, 12),
      ok: reason === null,
      reason,
    });

    if (reason && firstBreak === null) firstBreak = { brokenAt: i, reason };
    // A hash chain's own definition of "next" only makes sense relative to
    // the *actual* previous entry, tampered or not — so expectedPrevHash
    // keeps advancing off the real stored data even after a break, letting
    // every remaining entry still be individually checked and shown.
    expectedPrevHash = ownHash;
  }

  return firstBreak
    ? { ok: false, brokenAt: firstBreak.brokenAt, reason: firstBreak.reason, entryCount: rawEntries.length, entries }
    : { ok: true, entryCount: rawEntries.length, entries };
}

// Decrypt-on-load: a record that fails to decrypt under the current DEK (corrupted,
// or somehow from a different keyring) is unrecoverable — skip it rather than let one
// bad record crash loading every other task. Ephemeral records (selfDestruct present)
// branch three ways: already erased -> a destructed placeholder stub, not yet erased
// -> decrypt under the per-task key (cached for future edits/erasure) with the
// selfDestruct metadata attached so the UI can show a countdown/views-remaining badge.
async function loadAndDecryptTasks() {
  const records = await getAllTasks();
  const decrypted = [];
  ephemeralTaskKeys.clear();
  for (const record of records) {
    try {
      if (record.selfDestruct) {
        if (!record.selfDestruct.wrappedTaskKey) {
          decrypted.push(
            destructedTaskStub({ id: record.id, status: record.selfDestruct.status, ...emptyTaskDefaults() }, record.selfDestruct.erasedAt)
          );
          continue;
        }
        const rawTaskKeyBytes = await unwrapDek(record.selfDestruct.wrappedTaskKey, record.selfDestruct.taskKeyWrapIv, dek);
        const taskKey = await importDek(rawTaskKeyBytes, false);
        ephemeralTaskKeys.set(record.id, taskKey);
        const task = await decryptTask(record, taskKey);
        decrypted.push({ ...task, selfDestruct: { ...record.selfDestruct } });
      } else {
        decrypted.push(await decryptTask(record, dek));
      }
    } catch (err) {
      console.error("Skipping a task record that failed to decrypt:", record.id, err);
    }
  }
  return decrypted;
}

// Placeholder field values for a destructed stub built straight from a
// storage record (loadAndDecryptTasks) rather than from an in-memory task
// that already has them (eraseEphemeralTaskKey) — see destructedTaskStub().
function emptyTaskDefaults() {
  return { project: "Inbox", priority: "medium", order: 0, createdAt: null };
}

async function addTask({ title, project, notes, status, priority, dueDate, tags, subtasks, recurrence, selfDestruct }) {
  const resolvedStatus = status || "todo";
  let task = {
    id: uuid(),
    title: title.trim(),
    project: (project || activeProject || "Inbox").trim() || "Inbox",
    notes: (notes || "").trim(),
    status: resolvedStatus,
    priority: priority || "medium",
    dueDate: dueDate || null,
    tags: tags || [],
    subtasks: subtasks || [],
    recurrence: recurrence || null,
    order: nextOrder(resolvedStatus),
    createdAt: now(),
    updatedAt: now(),
  };
  // Applied before the first persist, so the "create" history entry already
  // reflects any rule's effect rather than needing a second "update" entry
  // immediately after.
  const ruled = evaluateTask(automationRules, "onCreateWithTag", task);
  if (ruled) task = { ...ruled, updatedAt: now() };

  const displayTask = selfDestruct ? { ...task, selfDestruct: { ...selfDestruct, status: task.status, viewsUsed: 0 } } : task;
  tasks.push(displayTask);
  render();
  await persistTask(task, "create", true, selfDestruct || null);
}

// "YYYY-MM-DD" from a Date using local calendar fields, not toISOString()
// (UTC) — the exact bug that made the filter tests look broken on a UTC+10
// machine until it was the test's date math, not the app's, that was wrong.
function formatLocalDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Adds calendar days/weeks/months to a "YYYY-MM-DD" string using local-date
// arithmetic (Date's own month/day rollover), not UTC — same reasoning as
// dueDiffDays() above: this must agree with what the user sees on screen.
function addToDueDate(dueDate, freq) {
  const base = dueDate ? new Date(dueDate + "T00:00:00") : new Date();
  if (!dueDate) base.setHours(0, 0, 0, 0);
  if (freq === "daily") base.setDate(base.getDate() + 1);
  else if (freq === "weekly") base.setDate(base.getDate() + 7);
  else if (freq === "monthly") base.setMonth(base.getMonth() + 1);
  return formatLocalDate(base);
}

// Called right after a task's status becomes "done". If it's a recurring
// task, spawns the next occurrence as a fresh task (new id, status back to
// "todo", due date advanced by the recurrence rule, subtasks reset to
// undone) rather than mutating this one — the completed occurrence stays
// completed and visible in Done, exactly like Todoist/Asana-style recurrence.
async function maybeSpawnNextOccurrence(task) {
  if (!task.recurrence) return;
  const next = {
    id: uuid(),
    title: task.title,
    project: task.project || "Inbox",
    notes: task.notes || "",
    status: "todo",
    priority: task.priority,
    dueDate: addToDueDate(task.dueDate, task.recurrence),
    tags: [...(task.tags || [])],
    subtasks: (task.subtasks || []).map((s) => ({ ...s, done: false })),
    recurrence: task.recurrence,
    order: nextOrder("todo"),
    createdAt: now(),
    updatedAt: now(),
  };
  tasks.push(next);
  await persistTask(next, "create");
}

async function updateTask(partial) {
  const task = tasks.find((t) => t.id === partial.id);
  if (!task) return;
  const becameDone = partial.status === "done" && task.status !== "done";
  Object.assign(task, partial, { updatedAt: now() });
  if (becameDone) {
    const ruled = evaluateTask(automationRules, "onDone", task);
    if (ruled) Object.assign(task, ruled, { updatedAt: now() });
  }
  render();
  await persistTask(task, "update");
  if (becameDone) {
    await maybeSpawnNextOccurrence(task);
    render(); // the spawned occurrence needs to appear without a manual refresh
  }
}

async function removeTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  render();
  await deleteTask(id);
  await appendSignedHistoryEntry(id, "delete", null, null);

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

// The undo half of delete: re-adds a full task snapshot with a fresh
// updatedAt. No special sync handling needed beyond persistTask() itself —
// a later manual sync compares timestamps like any other edit, so this
// naturally wins over the tombstone removeTask() already pushed, the same
// last-write-wins rule docs/ARCHITECTURE.md §5 already documents.
async function restoreTask(snapshot) {
  const restored = { ...snapshot, updatedAt: now() };
  tasks.push(restored);
  render();
  await persistTask(restored);
}

// Deletes one or more tasks and offers an undo toast instead of a blocking
// confirm() dialog — delete immediately, make it reversible, per
// docs/FEATURES.md's "Bulk actions, undo" Layer 1 item.
async function deleteTasksWithUndo(ids) {
  const snapshots = tasks.filter((t) => ids.includes(t.id)).map((t) => ({ ...t }));
  if (snapshots.length === 0) return;
  for (const id of ids) await removeTask(id);
  const message = snapshots.length === 1 ? `Deleted "${snapshots[0].title}"` : `Deleted ${snapshots.length} tasks`;
  showUndoToast(message, async () => {
    for (const snap of snapshots) await restoreTask(snap);
  });
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

// exportTasks() writes plain JSON (the already-decrypted in-memory task
// list) — a portable backup, not a separately-encrypted file format. Import
// is the exact mirror: it never touches the network, reads a local file the
// same way an <input type="file"> always has, and whatever it adds goes
// through the same encrypt-before-store path as a task typed by hand.
// "Encrypted" here describes where the data lives once imported (the app's
// storage), not the backup file itself — encrypting the export file too
// would be a real, separate feature (its own passphrase/key entry UX), not
// implemented here.
const MAX_IMPORT_RECORDS = 500; // matches server/routes.py's MAX_RECORDS_PER_PUSH, same reasoning

function normalizeImportedTask(raw, fallbackStatus) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || typeof raw.title !== "string" || !raw.title.trim()) return null;
  const status = STATUSES.includes(raw.status) ? raw.status : fallbackStatus;
  return {
    id: raw.id,
    title: raw.title.trim(),
    project: typeof raw.project === "string" && raw.project.trim() ? raw.project.trim() : "Inbox",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    status,
    priority: ["low", "medium", "high"].includes(raw.priority) ? raw.priority : "medium",
    dueDate: typeof raw.dueDate === "string" ? raw.dueDate : null,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [],
    subtasks: Array.isArray(raw.subtasks)
      ? raw.subtasks
          .filter((s) => s && typeof s.title === "string")
          .map((s) => ({ id: typeof s.id === "string" ? s.id : uuid(), title: s.title, done: !!s.done }))
      : [],
    recurrence: ["daily", "weekly", "monthly"].includes(raw.recurrence) ? raw.recurrence : null,
    order: typeof raw.order === "number" ? raw.order : nextOrder(status),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now(),
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now(),
  };
}

// Merge, not overwrite: an imported task with an id that already exists
// locally only replaces the local copy if it's actually newer — the same
// last-write-wins rule the sync protocol uses (docs/ARCHITECTURE.md §5) —
// so re-importing the same backup twice, or importing a slightly stale
// backup over current data, can't silently destroy newer local edits.
// CSV rows have no id/timestamps of their own (unlike Haven's JSON export),
// so every row is always a brand-new task — there's nothing to merge
// against, unlike the JSON path below where re-importing the same backup
// is expected and must not create duplicates.
async function importTasksFromCSV(file) {
  const rows = parseCSVToTasks(await file.text());
  if (rows.length === 0) {
    showInfoToast("Import failed: no usable rows found. Expected a header row with a title/content column.");
    return;
  }

  const items = rows.slice(0, MAX_IMPORT_RECORDS);
  const created = items.map((row) => ({
    id: uuid(),
    ...row,
    subtasks: [],
    recurrence: null,
    order: nextOrder(row.status || "todo"),
    createdAt: now(),
    updatedAt: now(),
  }));

  tasks.push(...created);
  render();
  for (const task of created) await persistTask(task, "create");

  const skippedNote = rows.length > MAX_IMPORT_RECORDS ? ` (file had ${rows.length} rows, only the first ${MAX_IMPORT_RECORDS} were read)` : "";
  showInfoToast(`Import done: ${created.length} tasks added from CSV${skippedNote}.`);
}

// Merge, not overwrite: an imported task with an id that already exists
// locally only replaces the local copy if it's actually newer — the same
// last-write-wins rule the sync protocol uses (docs/ARCHITECTURE.md §5) —
// so re-importing the same backup twice, or importing a slightly stale
// backup over current data, can't silently destroy newer local edits.
async function importTasksFromJSON(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    showInfoToast("Import failed: that file isn't valid JSON.");
    return;
  }
  if (!Array.isArray(parsed)) {
    showInfoToast("Import failed: expected a JSON array of tasks (the format Haven's own export produces).");
    return;
  }

  const items = parsed.slice(0, MAX_IMPORT_RECORDS);
  let added = 0, updated = 0, skipped = 0;
  const toPersist = [];

  for (const raw of items) {
    const candidate = normalizeImportedTask(raw, "todo");
    if (!candidate) { skipped++; continue; }
    const existing = tasks.find((t) => t.id === candidate.id);
    if (!existing) {
      tasks.push(candidate);
      toPersist.push({ task: candidate, op: "create" });
      added++;
    } else if (candidate.updatedAt > existing.updatedAt) {
      Object.assign(existing, candidate);
      toPersist.push({ task: existing, op: "update" });
      updated++;
    } else {
      skipped++;
    }
  }

  render();
  for (const { task, op } of toPersist) await persistTask(task, op);

  const skippedNote = parsed.length > MAX_IMPORT_RECORDS ? ` (file had ${parsed.length}, only the first ${MAX_IMPORT_RECORDS} were read)` : "";
  showInfoToast(`Import done: ${added} added, ${updated} updated, ${skipped} skipped${skippedNote}.`);
}

async function importTasksFromFile(file) {
  const isCSV = file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv";
  if (isCSV) await importTasksFromCSV(file);
  else await importTasksFromJSON(file);
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
  // Sync config (server URL + token) lives in plaintext localStorage, outside
  // any vault's own encryption boundary — it isn't per-vault. Without this
  // guard, syncing while the decoy vault is active would push decoy tasks
  // into the *main* vault's sync bucket (whatever config was set up while
  // unlocked normally), mixing the two and defeating the whole point of
  // keeping the decoy separate. See docs/ARCHITECTURE.md "Duress / decoy
  // vault" — the decoy vault doesn't sync, full stop, same as ephemeral
  // tasks and for a related reason.
  if (activeVaultIsDecoy) throw new Error("Sync isn't available in this vault.");

  const config = getSyncConfig();
  if (!config) throw new Error("Sync is not configured");

  const localRecords = await getAllTasks();
  // Self-destructing tasks are local-only — never pushed. Otherwise the
  // erasure guarantee would have to account for a copy of the wrapped
  // per-task key already sitting on the sync server or a second device
  // before the fuse goes off, which local key-deletion alone can't cover.
  // See docs/ARCHITECTURE.md "Ephemeral tasks".
  const syncableRecords = localRecords.filter((r) => !r.selfDestruct);
  await pushRecords(config.server, config.token, syncableRecords);

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

  return { pushed: syncableRecords.length, pulled: remoteRecords.length };
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

// ---------- social recovery: split (settings, while unlocked) ----------

function openSocialRecoveryModal() {
  document.getElementById("socialRecoveryCodeInput").value = "";
  document.getElementById("socialRecoveryK").value = "2";
  document.getElementById("socialRecoveryN").value = "3";
  document.getElementById("socialRecoveryError").textContent = "";
  document.getElementById("socialRecoverySetupSection").hidden = false;
  document.getElementById("socialRecoveryResultSection").hidden = true;
  document.getElementById("socialRecoveryModal").hidden = false;
}

function closeSocialRecoveryModal() {
  document.getElementById("socialRecoveryModal").hidden = true;
  document.getElementById("socialRecoveryCodeInput").value = "";
}

function wireSocialRecoveryModal() {
  const overlay = document.getElementById("socialRecoveryModal");
  const errorEl = document.getElementById("socialRecoveryError");

  document.getElementById("socialRecoveryCancelBtn").addEventListener("click", () => closeSocialRecoveryModal());
  document.getElementById("socialRecoveryDoneBtn").addEventListener("click", () => closeSocialRecoveryModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeSocialRecoveryModal();
  });

  document.getElementById("socialRecoveryGenerateBtn").addEventListener("click", async () => {
    errorEl.textContent = "";
    const codeInput = document.getElementById("socialRecoveryCodeInput");
    const k = Number(document.getElementById("socialRecoveryK").value);
    const n = Number(document.getElementById("socialRecoveryN").value);

    if (k > n) {
      errorEl.textContent = "The number needed can't be more than the total number of shares.";
      return;
    }

    // Verify the entered code is actually this vault's real recovery code
    // before splitting it — never split and hand out pieces of a typo.
    const keyring = await getKeyring();
    const normalized = normalizeRecoveryCode(codeInput.value);
    const kekR = await deriveKek(normalized, base64ToBuf(keyring.saltRecovery));
    try {
      await unwrapDek(keyring.wrappedDekRecovery, keyring.wrapIvRecovery, kekR);
    } catch {
      errorEl.textContent = "That doesn't match this device's recovery code.";
      return;
    }

    const secretBytes = recoveryCodeToBytes(normalized);
    const shares = splitSecret(secretBytes, k, n);

    const listEl = document.getElementById("socialRecoveryShareList");
    listEl.textContent = "";
    shares.forEach((share, i) => {
      const encoded = encodeShare(k, share);
      const row = document.createElement("div");
      row.className = "social-recovery-share-row";
      const label = document.createElement("span");
      label.className = "social-recovery-share-label";
      label.textContent = `Share ${i + 1} of ${n}`;
      const value = document.createElement("span");
      value.className = "social-recovery-share-value";
      value.textContent = encoded;
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn btn-ghost btn-sm";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(encoded);
          const original = copyBtn.textContent;
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = original; }, 1500);
        } catch {
          // Clipboard unavailable — the text is already selectable/visible above.
        }
      });
      row.appendChild(label);
      row.appendChild(value);
      row.appendChild(copyBtn);
      listEl.appendChild(row);
    });

    document.getElementById("socialRecoverySetupSection").hidden = true;
    document.getElementById("socialRecoveryResultSection").hidden = false;
  });
}

// ---------- WebAuthn passkey unlock (settings, while unlocked) ----------
// See docs/ARCHITECTURE.md "WebAuthn passkey unlock" for the full design.
// Short version: a random 256-bit secret is stored via the authenticator's
// largeBlob extension; that secret becomes KEK_hw (imported directly, no
// PBKDF2 — it's already full entropy), which wraps a *second* copy of the
// DEK and the signing private key, parallel to the passphrase-wrapped
// copies. Requires re-entering the passphrase to obtain extractable raw
// bytes to re-wrap — the live in-memory `dek`/`historySigningKey` are
// deliberately non-extractable and stay that way.

async function openPasskeyModal() {
  document.getElementById("passkeySetupPassphrase").value = "";
  document.getElementById("passkeyError").textContent = "";
  document.getElementById("passkeyModal").hidden = false;
  await refreshPasskeyModalState();
}

async function refreshPasskeyModalState() {
  const keyring = await getKeyring();
  const hasPasskey = !!keyring.webauthnCredentialId;
  document.getElementById("passkeySetupSection").hidden = hasPasskey;
  document.getElementById("passkeyResultSection").hidden = !hasPasskey;
}

function closePasskeyModal() {
  document.getElementById("passkeyModal").hidden = true;
  document.getElementById("passkeySetupPassphrase").value = "";
}

function wirePasskeyModal() {
  const overlay = document.getElementById("passkeyModal");
  const errorEl = document.getElementById("passkeyError");

  document.getElementById("passkeyCancelBtn").addEventListener("click", () => closePasskeyModal());
  document.getElementById("passkeyDoneBtn").addEventListener("click", () => closePasskeyModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePasskeyModal();
  });

  document.getElementById("passkeyRegisterBtn").addEventListener("click", async () => {
    errorEl.textContent = "";
    if (!isWebAuthnAvailable()) {
      errorEl.textContent = "This browser doesn't support passkeys.";
      return;
    }

    const passphrase = document.getElementById("passkeySetupPassphrase").value;
    const keyring = await getKeyring();
    const kek = await deriveKek(passphrase, base64ToBuf(keyring.salt));

    let rawDekBytes, rawSigningKeyBytes;
    try {
      rawDekBytes = await unwrapDek(keyring.wrappedDek, keyring.wrapIv, kek);
      rawSigningKeyBytes = await unwrapDek(keyring.wrappedSigningKey, keyring.signingKeyWrapIv, kek);
    } catch {
      errorEl.textContent = "That's not your current passphrase.";
      return;
    }

    let registration;
    try {
      registration = await registerPasskey({
        userId: crypto.getRandomValues(new Uint8Array(16)),
        userName: "Haven vault",
      });
    } catch (err) {
      errorEl.textContent = "Couldn't create a passkey — it may have been cancelled.";
      return;
    }
    if (!registration.largeBlobSupported) {
      errorEl.textContent = "That authenticator doesn't support the storage this needs. Nothing was changed — try a different authenticator.";
      return;
    }

    const hardwareSecret = generateHardwareSecret();
    try {
      await writeLargeBlob(registration.credentialId, hardwareSecret);
    } catch (err) {
      errorEl.textContent = "Couldn't save the passkey's data — try again.";
      return;
    }

    const kekHw = await importDek(hardwareSecret);
    const { wrapped: wrappedDekHardware, iv: wrapIvHardware } = await wrapRawBytes(rawDekBytes, kekHw);
    const { wrapped: wrappedSigningKeyHardware, iv: signingKeyWrapIvHardware } = await wrapRawBytes(rawSigningKeyBytes, kekHw);

    await putKeyring({
      ...keyring,
      webauthnCredentialId: bufToBase64(registration.credentialId),
      wrappedDekHardware,
      wrapIvHardware,
      wrappedSigningKeyHardware,
      signingKeyWrapIvHardware,
    });

    document.getElementById("passkeySetupPassphrase").value = "";
    await refreshPasskeyModalState();
    document.getElementById("passkeyUnlockBtn").hidden = false;
  });

  document.getElementById("passkeyRemoveBtn").addEventListener("click", async () => {
    const keyring = await getKeyring();
    const { webauthnCredentialId, wrappedDekHardware, wrapIvHardware, wrappedSigningKeyHardware, signingKeyWrapIvHardware, ...rest } = keyring;
    await putKeyring(rest);
    await refreshPasskeyModalState();
    document.getElementById("passkeyUnlockBtn").hidden = true;
  });
}

// ---------- duress / decoy vault setup (while unlocked) ----------
// Deliberately not conditional on whether a decoy already exists — same
// modal, same copy, same button, every time. A UI that changed shape once a
// decoy was configured (a "manage" view instead of a "set up" one, a status
// line, anything) would itself be a tell to anyone skimming the app after a
// forced unlock. Running this again just replaces whatever decoy vault was
// there before, passphrase and all — a rotate, not an edit.
async function setupDecoyVault(decoyPassphrase) {
  const keyring = await getKeyring();
  const saltDecoyBytes = generateSalt();
  const kekDecoy = await deriveKek(decoyPassphrase, saltDecoyBytes);
  const dekDecoy = await generateDek();
  const { wrappedDek: wrappedDekDecoy, wrapIv: wrapIvDecoy } = await wrapDek(dekDecoy, kekDecoy);

  // A fully independent signing identity, not a second-class one — the decoy
  // vault's own "Verify task history" panel works exactly like the real
  // vault's, because it's backed by real, separate key material.
  const signingKeypair = await generateSigningKeypair();
  const signingPublicKeyDecoyB64 = bufToBase64(await exportSigningPublicKey(signingKeypair.publicKey));
  const { wrappedSigningKey: wrappedSigningKeyDecoy, signingKeyWrapIv: signingKeyWrapIvDecoy } = await wrapSigningKey(
    signingKeypair.privateKey,
    kekDecoy
  );

  await putKeyring({
    ...keyring,
    saltDecoy: bufToBase64(saltDecoyBytes),
    wrappedDekDecoy,
    wrapIvDecoy,
    signingPublicKeyDecoy: signingPublicKeyDecoyB64,
    wrappedSigningKeyDecoy,
    signingKeyWrapIvDecoy,
    signingKeyLogDecoy: [{ publicKey: signingPublicKeyDecoyB64, startedAt: now() }],
  });
}

function openDecoyVaultModal() {
  document.getElementById("decoyVaultPassphrase").value = "";
  document.getElementById("decoyVaultPassphraseConfirm").value = "";
  document.getElementById("decoyVaultError").textContent = "";
  document.getElementById("decoyVaultModal").hidden = false;
}

function closeDecoyVaultModal() {
  document.getElementById("decoyVaultModal").hidden = true;
}

function wireDecoyVaultModal() {
  const overlay = document.getElementById("decoyVaultModal");
  const errorEl = document.getElementById("decoyVaultError");

  document.getElementById("decoyVaultCancelBtn").addEventListener("click", () => closeDecoyVaultModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDecoyVaultModal();
  });

  document.getElementById("decoyVaultCreateBtn").addEventListener("click", async () => {
    errorEl.textContent = "";
    const passphrase = document.getElementById("decoyVaultPassphrase").value;
    const confirmValue = document.getElementById("decoyVaultPassphraseConfirm").value;

    if (passphrase.length < 10) {
      errorEl.textContent = "Must be at least 10 characters.";
      return;
    }
    if (passphrase !== confirmValue) {
      errorEl.textContent = "Passphrases don't match.";
      return;
    }

    await setupDecoyVault(passphrase);
    document.getElementById("decoyVaultPassphrase").value = "";
    document.getElementById("decoyVaultPassphraseConfirm").value = "";
    closeDecoyVaultModal();
    showInfoToast("Decoy vault ready — its passphrase opens it from the lock screen, same as this one.");
  });
}

function openAutomationModal() {
  document.getElementById("automationError").textContent = "";
  document.getElementById("automationModal").hidden = false;
  renderAutomationModal();
}

function closeAutomationModal() {
  document.getElementById("automationModal").hidden = true;
}

function wireAutomationModal() {
  const overlay = document.getElementById("automationModal");
  const errorEl = document.getElementById("automationError");

  document.getElementById("automationCloseBtn").addEventListener("click", () => closeAutomationModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAutomationModal();
  });

  document.getElementById("automationAddRuleBtn").addEventListener("click", async () => {
    errorEl.textContent = "";
    const triggerType = document.getElementById("automationTrigger").value;
    const triggerTag = document.getElementById("automationTriggerTag").value.trim();
    const actionType = document.getElementById("automationAction").value;
    const actionValue = document.getElementById("automationActionValue").value.trim();

    if (triggerType === "onCreateWithTag" && !triggerTag) {
      errorEl.textContent = 'This trigger needs a tag — fill in the "Tag" field above.';
      return;
    }
    if (["addTag", "removeTag", "moveToProject"].includes(actionType) && !actionValue) {
      errorEl.textContent = "This action needs a value.";
      return;
    }
    if (actionType === "setPriority" && !["low", "medium", "high"].includes(actionValue)) {
      errorEl.textContent = 'Priority must be exactly "low", "medium", or "high".';
      return;
    }
    if (actionType === "setStatus" && !["todo", "in-progress", "done"].includes(actionValue)) {
      errorEl.textContent = 'Status must be exactly "todo", "in-progress", or "done".';
      return;
    }

    const trigger = triggerType === "onCreateWithTag" ? { type: triggerType, tag: triggerTag } : { type: triggerType };
    const action = { type: actionType, value: actionValue };
    await addAutomationRule(trigger, action);

    document.getElementById("automationTriggerTag").value = "";
    document.getElementById("automationActionValue").value = "";
  });
}

// ---------- board / project templates (Ecosystem & polish) ----------
// Applying a template just calls addTask() once per starter task, so a
// template-created task is completely indistinguishable afterward from one
// typed by hand — same encryption, same history-log entry, same automation
// rules triggered on creation. See docs/ARCHITECTURE.md.

function populateTemplateSelect() {
  const select = document.getElementById("templateSelect");
  select.textContent = "";
  for (const t of TEMPLATES) {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
}

function updateTemplatePreview() {
  const template = findTemplate(document.getElementById("templateSelect").value);
  if (!template) return;
  document.getElementById("templateDescription").textContent =
    `${template.description} (${template.tasks.length} task${template.tasks.length === 1 ? "" : "s"})`;
  document.getElementById("templateProjectName").value = template.name;
}

function openTemplateModal() {
  populateTemplateSelect();
  updateTemplatePreview();
  document.getElementById("templateModal").hidden = false;
}

function closeTemplateModal() {
  document.getElementById("templateModal").hidden = true;
}

function wireTemplateModal() {
  const overlay = document.getElementById("templateModal");
  document.getElementById("templateSelect").addEventListener("change", () => updateTemplatePreview());
  document.getElementById("templateCancelBtn").addEventListener("click", () => closeTemplateModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeTemplateModal();
  });

  document.getElementById("templateApplyBtn").addEventListener("click", async () => {
    const template = findTemplate(document.getElementById("templateSelect").value);
    if (!template) return;
    const projectName = document.getElementById("templateProjectName").value.trim() || template.name;

    for (const starterTask of template.tasks) {
      await addTask({ ...starterTask, project: projectName });
    }

    activeProject = projectName;
    closeTemplateModal();
    render();
    showInfoToast(`Added ${template.tasks.length} tasks from "${template.name}" to "${projectName}".`);
  });
}

// Lock-screen unlock — no passphrase involved at all. Re-derives KEK_hw from
// the largeBlob secret, unwraps the hardware-wrapped copies of the DEK and
// signing key, and proceeds exactly like a normal unlock from there.
async function unlockWithPasskey() {
  const errorEl = document.getElementById("unlockError");
  setUnlockError("");
  const keyring = await getKeyring();
  if (!keyring.webauthnCredentialId) return;

  let secretBytes;
  try {
    secretBytes = await readLargeBlob(base64ToBuf(keyring.webauthnCredentialId));
  } catch (err) {
    setUnlockError("Couldn't use the passkey — it may have been cancelled or isn't available on this device.");
    return;
  }
  if (!secretBytes) {
    setUnlockError("No passkey data found. Unlock with your passphrase instead.");
    return;
  }

  try {
    const kekHw = await importDek(secretBytes);
    const rawDekBytes = await unwrapDek(keyring.wrappedDekHardware, keyring.wrapIvHardware, kekHw);
    dek = await importDek(rawDekBytes);
    const rawSigningKeyBytes = await unwrapDek(keyring.wrappedSigningKeyHardware, keyring.signingKeyWrapIvHardware, kekHw);
    historySigningKey = await crypto.subtle.importKey("pkcs8", rawSigningKeyBytes, { name: "Ed25519" }, false, ["sign"]);
    historySigningPublicKeyB64 = keyring.signingPublicKey;
    await primeHistoryChainTip();
  } catch (err) {
    setUnlockError("Couldn't unlock with this passkey.");
    return;
  }

  await afterUnlock();
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

// logHistory:false — a drag-drop reorder changes only display order, not
// task content, so it isn't a meaningful audit event (and logging one entry
// per task on every reorder would drown out real edits in the history view).
async function persistReorder(status) {
  const inStatus = tasks.filter((t) => t.status === status).sort((a, b) => a.order - b.order);
  await Promise.all(inStatus.map((t) => persistTask(t, "update", false)));
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

const WEEKDAY_NAMES = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

// Parses a quick-add title like "call dentist fri #health" into structured
// fields, client-side only (never leaves the browser, same as everything
// else typed into this app). Deliberately scoped: bare weekday names,
// "today"/"tomorrow", and #tags. No time-of-day parsing ("3pm") because the
// task schema has no due-time field to put it in — a parsed time would have
// to be silently discarded, and silently discarding what someone typed is
// worse than just leaving "3pm" as plain text in the title. No "next <day>"
// either: the semantics of "next friday" genuinely differ between apps
// (this week's vs. the following week's), and a wrong guess there is worse
// than not parsing it — left as a bare weekday still works fine, it just
// won't skip ahead a week.
function parseQuickAdd(input) {
  let title = input;
  const tags = [];

  title = title.replace(/#([a-zA-Z0-9_-]+)/g, (_, tag) => {
    tags.push(tag);
    return "";
  });

  let dueDate = null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  title = title.replace(/\b(today|tomorrow|tmrw)\b/i, (match) => {
    const d = new Date(today);
    if (/tomorrow|tmrw/i.test(match)) d.setDate(d.getDate() + 1);
    dueDate = formatLocalDate(d);
    return "";
  });

  if (!dueDate) {
    // Global regex + a "stop after the first real match" flag: .replace()
    // without /g only ever tests the first word in the string and gives up
    // even if that word isn't a weekday, so a non-global regex here would
    // silently never reach "fri" in "call dentist fri" — every word has to
    // actually be checked.
    let matched = false;
    title = title.replace(/\b([a-zA-Z]+)\b/g, (match, word) => {
      if (matched) return match;
      const target = WEEKDAY_NAMES[word.toLowerCase()];
      if (target === undefined) return match;
      matched = true;
      const daysAhead = (target - today.getDay() + 7) % 7;
      const d = new Date(today);
      d.setDate(d.getDate() + daysAhead);
      dueDate = formatLocalDate(d);
      return "";
    });
  }

  title = title.replace(/\s+/g, " ").trim();
  return { title, dueDate, tags };
}

function wireQuickAdd() {
  const form = document.getElementById("quickAddForm");
  const input = document.getElementById("quickAddInput");
  const priority = document.getElementById("quickAddPriority");
  const dueDate = document.getElementById("quickAddDueDate");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    // The explicit due-date picker wins if the user set it directly — NLP
    // parsing only fills in what wasn't already stated some other way.
    const parsed = parseQuickAdd(raw);
    const title = parsed.title || raw;
    addTask({
      title,
      priority: priority.value,
      dueDate: dueDate.value || parsed.dueDate,
      tags: parsed.tags,
    });
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
      closeAddModal();
      closeCmdk();
    }
  });
}

function wireSelectMode() {
  const btn = document.getElementById("selectModeBtn");
  btn.addEventListener("click", () => {
    selectionMode = !selectionMode;
    btn.setAttribute("aria-pressed", String(selectionMode));
    btn.textContent = selectionMode ? "Done" : "Select";
    if (!selectionMode) selectedIds.clear();
    render();
  });
}

function wireImport() {
  const input = document.getElementById("importFileInput");
  input.addEventListener("change", async () => {
    const file = input.files[0];
    input.value = ""; // so re-selecting the same file still fires "change"
    if (!file) return;
    await importTasksFromFile(file);
  });
}

function wireBulkActions() {
  document.getElementById("bulkStatusSelect").addEventListener("change", async (e) => {
    const status = e.target.value;
    if (!status) return;
    for (const id of selectedIds) await updateTask({ id, status });
    e.target.value = "";
    selectedIds.clear();
    render();
  });

  document.getElementById("bulkDeleteBtn").addEventListener("click", async () => {
    const ids = [...selectedIds];
    selectedIds.clear();
    await deleteTasksWithUndo(ids);
  });

  document.getElementById("bulkCancelBtn").addEventListener("click", () => {
    selectedIds.clear();
    render();
  });
}

function wireFilterBar() {
  const bar = document.getElementById("filterBar");

  bar.querySelectorAll("[data-smart-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      smartView = btn.dataset.smartView;
      bar.querySelectorAll("[data-smart-view]").forEach((b) => b.classList.toggle("is-active", b === btn));
      render();
    });
  });

  document.getElementById("priorityFilter").addEventListener("change", (e) => {
    priorityFilter = e.target.value;
    render();
  });

  document.getElementById("tagFilter").addEventListener("change", (e) => {
    tagFilter = e.target.value;
    render();
  });

  document.getElementById("sortBy").addEventListener("change", (e) => {
    sortMode = e.target.value;
    render();
  });
}

function wireProjectSwitcher() {
  const switcher = document.getElementById("projectSwitcher");
  const addBtn = document.getElementById("addProjectBtn");
  const addRow = document.getElementById("projectAddRow");
  const addInput = document.getElementById("projectAddInput");
  const confirmBtn = document.getElementById("projectAddConfirmBtn");
  const cancelBtn = document.getElementById("projectAddCancelBtn");

  switcher.addEventListener("change", () => {
    activeProject = switcher.value;
    // Reset filters that were scoped to the previous project's data — a
    // priority/tag/smart-view filter carried over could silently show an
    // empty board in the new project and look like a bug.
    smartView = "all";
    priorityFilter = "";
    tagFilter = "";
    document.querySelectorAll("[data-smart-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.smartView === "all"));
    document.getElementById("priorityFilter").value = "";
    document.getElementById("tagFilter").value = "";
    render();
  });

  addBtn.addEventListener("click", () => {
    addRow.hidden = false;
    addInput.value = "";
    addInput.focus();
  });

  const confirmAdd = () => {
    const name = addInput.value.trim();
    if (!name) return;
    activeProject = name;
    addRow.hidden = true;
    render();
  };
  confirmBtn.addEventListener("click", confirmAdd);
  addInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); confirmAdd(); }
    if (e.key === "Escape") { addRow.hidden = true; }
  });
  cancelBtn.addEventListener("click", () => { addRow.hidden = true; });
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
  document.getElementById("viewHistoryBtn").addEventListener("click", () => {
    view = "history";
    setView(view);
    render();
  });
  document.getElementById("viewInsightsBtn").addEventListener("click", () => {
    view = "insights";
    setView(view);
    render(); // render() itself calls renderInsights() when view === "insights"
  });
  document.getElementById("viewCalendarBtn").addEventListener("click", () => {
    view = "calendar";
    setView(view);
    render();
  });
  document.getElementById("viewAssistantBtn").addEventListener("click", () => {
    view = "assistant";
    setView(view);
    render();
    if (assistantEnabled) showAssistantEnabled();
  });
}

// ---------- AI assistant (Layer 3, js/ai.js) ----------

function wireAssistantView() {
  document.getElementById("assistantEnableBtn").addEventListener("click", async () => {
    const btn = document.getElementById("assistantEnableBtn");
    btn.disabled = true;
    setAssistantProgress(0, "Starting…");
    try {
      const { loadAssistant } = await getAssistantModule();
      await loadAssistant((progress) => {
        if (progress.status === "progress" && progress.total) {
          const pct = Math.round((progress.loaded / progress.total) * 100);
          setAssistantProgress(progress.loaded / progress.total, `Downloading model… ${pct}%`);
        } else if (progress.status === "progress_total" && progress.total) {
          setAssistantProgress(progress.progress / 100, `Downloading model… ${Math.round(progress.progress)}%`);
        } else if (progress.status === "ready") {
          setAssistantProgress(1, "Ready.");
        }
      });
      assistantEnabled = true;
      showAssistantEnabled();
    } catch (err) {
      setAssistantProgress(null, null);
      btn.disabled = false;
      showInfoToast("Couldn't load the AI assistant — check your connection and try again.");
    }
  });

  document.getElementById("assistantFocusBtn").addEventListener("click", async () => {
    const btn = document.getElementById("assistantFocusBtn");
    btn.disabled = true;
    setAssistantOutputText("Thinking… this can take about a minute on your device.");
    try {
      const { generateFocusSummary } = await getAssistantModule();
      const reply = await generateFocusSummary(tasks);
      setAssistantOutputText(reply || "(no response)");
    } catch (err) {
      setAssistantOutputText("Something went wrong generating a response. Try again.");
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("assistantBreakdownBtn").addEventListener("click", async () => {
    const select = document.getElementById("assistantTaskSelect");
    const task = tasks.find((t) => t.id === select.value);
    if (!task) {
      showInfoToast("Add a task first, then pick it here.");
      return;
    }
    const btn = document.getElementById("assistantBreakdownBtn");
    btn.disabled = true;
    setAssistantOutputText("Thinking… this can take about a minute on your device.");
    try {
      const { generateSubtaskSuggestions } = await getAssistantModule();
      const suggestions = await generateSubtaskSuggestions(task);
      if (suggestions.length === 0) setAssistantOutputText("No suggestions came back — try again or rephrase the task title.");
      else setAssistantSuggestions(suggestions);
    } catch (err) {
      setAssistantOutputText("Something went wrong generating suggestions. Try again.");
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("assistantAddSubtasksBtn").addEventListener("click", async () => {
    const select = document.getElementById("assistantTaskSelect");
    const task = tasks.find((t) => t.id === select.value);
    const selected = getSelectedAssistantSuggestions();
    if (!task || selected.length === 0) return;
    task.subtasks = [...(task.subtasks || []), ...selected.map((title) => ({ id: uuid(), title, done: false }))];
    task.updatedAt = now();
    await persistTask(task, "update");
    render();
    setAssistantOutputText(`Added ${selected.length} subtask${selected.length === 1 ? "" : "s"} to "${task.title}".`);
    showInfoToast(`Added ${selected.length} subtask${selected.length === 1 ? "" : "s"}.`);
  });
}

function wireCalendarView() {
  document.getElementById("calendarPrevBtn").addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    render();
  });
  document.getElementById("calendarNextBtn").addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    render();
  });
  document.getElementById("calendarTodayBtn").addEventListener("click", () => {
    calendarMonth = new Date();
    render();
  });
  document.getElementById("calendarExportBtn").addEventListener("click", () => {
    const ics = generateICS(tasks);
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "haven-tasks.ics";
    link.click();
    URL.revokeObjectURL(url);
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

function wireHistoryView() {
  document.getElementById("verifyHistoryBtn").addEventListener("click", async () => {
    const report = await verifyHistoryChain();
    renderHistoryReport(report);
  });
}

let addRevealToken = 0;

// Subtasks are edited as a live draft (add/toggle/remove all update the modal
// immediately), unlike the rest of the form which is only read on submit — so
// they live here as module state rather than inside readAddForm()/readEditForm().
let addSubtasksDraft = [];
let editSubtasksDraft = [];

function subtaskId() {
  return uuid();
}

function renderAddSubtasks() {
  renderSubtaskList("addSubtaskList", addSubtasksDraft, {
    onToggle: (id) => {
      const s = addSubtasksDraft.find((x) => x.id === id);
      if (s) s.done = !s.done;
      renderAddSubtasks();
      if (dek) updateAddReveal();
    },
    onRemove: (id) => {
      addSubtasksDraft = addSubtasksDraft.filter((x) => x.id !== id);
      renderAddSubtasks();
      if (dek) updateAddReveal();
    },
  });
}

function renderEditSubtasks() {
  renderSubtaskList("editSubtaskList", editSubtasksDraft, {
    onToggle: (id) => {
      const s = editSubtasksDraft.find((x) => x.id === id);
      if (s) s.done = !s.done;
      renderEditSubtasks();
    },
    onRemove: (id) => {
      editSubtasksDraft = editSubtasksDraft.filter((x) => x.id !== id);
      renderEditSubtasks();
    },
  });
}

async function updateAddReveal() {
  const token = ++addRevealToken;
  const { title, project, notes, status, priority, dueDate, tags, recurrence } = readAddForm();
  const demoTask = {
    id: "demo-preview",
    title,
    project,
    notes,
    status: status || "todo",
    priority: priority || "medium",
    dueDate: dueDate || null,
    tags: tags || [],
    subtasks: addSubtasksDraft,
    recurrence: recurrence || null,
    order: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  const record = await encryptTask(demoTask, dek);
  if (token !== addRevealToken) return; // a newer keystroke already superseded this one

  document.getElementById("addRevealPlaintext").textContent = JSON.stringify(demoTask, null, 2);
  document.getElementById("addRevealCiphertext").textContent = JSON.stringify(
    { id: demoTask.id, iv: record.iv, ciphertext: record.ciphertext, updatedAt: demoTask.updatedAt },
    null,
    2
  );
}

function wireAddModal() {
  const overlay = document.getElementById("addModal");
  const form = document.getElementById("addTaskForm");
  const cancelBtn = document.getElementById("addCancelBtn");

  document.getElementById("openAddModalBtn").addEventListener("click", () => {
    addSubtasksDraft = [];
    renderAddSubtasks();
    openAddModal();
    document.getElementById("addProject").value = activeProject;
    if (dek) updateAddReveal();
  });

  for (const id of ["addTitle", "addProject", "addNotes", "addStatus", "addPriority", "addDueDate", "addRecurrence", "addTags"]) {
    document.getElementById(id).addEventListener("input", () => {
      if (dek) updateAddReveal();
    });
  }

  const addSubtaskInput = document.getElementById("addSubtaskInput");
  const addSubtask = () => {
    const title = addSubtaskInput.value.trim();
    if (!title) return;
    addSubtasksDraft.push({ id: subtaskId(), title, done: false });
    addSubtaskInput.value = "";
    renderAddSubtasks();
    if (dek) updateAddReveal();
  };
  document.getElementById("addSubtaskAddBtn").addEventListener("click", addSubtask);
  addSubtaskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSubtask();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = readAddForm();
    if (!values.title) return;
    addTask({ ...values, subtasks: addSubtasksDraft });
    closeAddModal();
  });

  cancelBtn.addEventListener("click", () => closeAddModal());

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeAddModal();
  });
}

// ---------- time tracking + Pomodoro (Ecosystem & polish) ----------
// Scoped to whichever task's edit modal is currently open — there's no
// background timer that keeps running once the modal closes. Closing the
// modal (Cancel, Save, Delete, or clicking outside) always saves whatever
// time has actually elapsed first, never discards it.
const POMODORO_DURATION_SECONDS = 25 * 60;
let pomodoroInterval = null;
let pomodoroRemainingSeconds = POMODORO_DURATION_SECONDS;
let pomodoroElapsedThisSession = 0;
let pomodoroTaskId = null;

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updatePomodoroUI() {
  document.getElementById("pomodoroDisplay").textContent = formatCountdown(pomodoroRemainingSeconds);
  document.getElementById("pomodoroStartBtn").hidden = !!pomodoroInterval;
  document.getElementById("pomodoroPauseBtn").hidden = !pomodoroInterval;
}

// Called whenever the edit modal opens, so the countdown/total always
// reflect the task actually being viewed rather than a stale previous one.
function resetPomodoroStateForTask(task) {
  pomodoroRemainingSeconds = POMODORO_DURATION_SECONDS;
  pomodoroElapsedThisSession = 0;
  pomodoroTaskId = task.id;
  updatePomodoroUI();
  document.getElementById("pomodoroTotal").textContent = `Total: ${formatDuration(task.timeSpentSeconds || 0)}`;
}

function startPomodoro() {
  if (pomodoroInterval) return;
  pomodoroInterval = setInterval(() => {
    pomodoroRemainingSeconds--;
    pomodoroElapsedThisSession++;
    updatePomodoroUI();
    if (pomodoroRemainingSeconds <= 0) stopAndSavePomodoro({ resetCountdown: true });
  }, 1000);
  updatePomodoroUI();
}

function pausePomodoro() {
  if (pomodoroInterval) {
    clearInterval(pomodoroInterval);
    pomodoroInterval = null;
  }
  updatePomodoroUI();
}

// Persists whatever elapsed this session (if any) onto the task's running
// total, then clears the in-progress session state. `logHistory: false` —
// same reasoning as reorders (docs comment on persistTask): a time-tracking
// tick isn't a meaningful content-audit event the way a title/status change
// is, so it doesn't need its own signed history entry.
async function stopAndSavePomodoro({ resetCountdown } = {}) {
  if (pomodoroInterval) {
    clearInterval(pomodoroInterval);
    pomodoroInterval = null;
  }
  if (pomodoroElapsedThisSession > 0 && pomodoroTaskId) {
    const task = tasks.find((t) => t.id === pomodoroTaskId);
    if (task) {
      task.timeSpentSeconds = (task.timeSpentSeconds || 0) + pomodoroElapsedThisSession;
      task.updatedAt = now();
      await persistTask(task, "update", false);
      const totalEl = document.getElementById("pomodoroTotal");
      if (totalEl) totalEl.textContent = `Total: ${formatDuration(task.timeSpentSeconds)}`;
      render(); // otherwise the card's time-spent badge stays stale until some unrelated render
    }
  }
  pomodoroElapsedThisSession = 0;
  if (resetCountdown) pomodoroRemainingSeconds = POMODORO_DURATION_SECONDS;
  updatePomodoroUI();
}

function wirePomodoro() {
  document.getElementById("pomodoroStartBtn").addEventListener("click", () => startPomodoro());
  document.getElementById("pomodoroPauseBtn").addEventListener("click", () => pausePomodoro());
  document.getElementById("pomodoroResetBtn").addEventListener("click", () => stopAndSavePomodoro({ resetCountdown: true }));
}

function wireEditModal() {
  const overlay = document.getElementById("editModal");
  const form = document.getElementById("editForm");
  const cancelBtn = document.getElementById("editCancelBtn");
  const deleteBtn = document.getElementById("editDeleteBtn");

  const editSubtaskInput = document.getElementById("editSubtaskInput");
  const addEditSubtask = () => {
    const title = editSubtaskInput.value.trim();
    if (!title) return;
    editSubtasksDraft.push({ id: subtaskId(), title, done: false });
    editSubtaskInput.value = "";
    renderEditSubtasks();
  };
  document.getElementById("editSubtaskAddBtn").addEventListener("click", addEditSubtask);
  editSubtaskInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addEditSubtask();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = readEditForm();
    if (!values.title) return;
    updateTask({ ...values, subtasks: editSubtasksDraft });
    closeEditModalAndSaveTimer();
  });

  cancelBtn.addEventListener("click", () => closeEditModalAndSaveTimer());

  deleteBtn.addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    deleteTasksWithUndo([id]);
    closeEditModalAndSaveTimer();
  });

  document.getElementById("editShareBtn").addEventListener("click", () => {
    const id = document.getElementById("editId").value;
    const task = tasks.find((t) => t.id === id);
    if (task) openShareModal(task);
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeEditModalAndSaveTimer();
  });
}

// Closing the edit modal by any path always stops and saves an in-progress
// Pomodoro session first — see the module comment above wirePomodoro().
function closeEditModalAndSaveTimer() {
  stopAndSavePomodoro({ resetCountdown: true });
  closeEditModal();
}

// ---------- share links (fresh-key, no account, Layer 2) ----------
// The relay server never sees the decryption key — it lives only in the
// resulting URL's fragment (`#...`), which browsers never transmit to any
// server per the URL spec. See docs/ARCHITECTURE.md "Fragment-key share links".

function shareServerUrl() {
  const config = getSyncConfig();
  return (config && config.server) || DEFAULT_SHARE_SERVER;
}

async function createShareLink(task, { ttlSeconds, maxViews } = {}) {
  const shareDek = await generateDek();
  const snapshot = {};
  for (const field of SHARE_FIELDS) snapshot[field] = task[field];

  const { iv, ciphertext } = await encryptTask(snapshot, shareDek);
  const rawKey = await crypto.subtle.exportKey("raw", shareDek);
  const server = shareServerUrl();
  const { id } = await pushShare(server, iv, ciphertext, { ttlSeconds, maxViews });

  const url = new URL("shared.html", location.href);
  url.searchParams.set("server", server);
  url.searchParams.set("id", id);
  url.hash = bufToBase64Url(rawKey);
  return { url: url.toString(), id, server };
}

function openShareModal(task) {
  shareModalTask = task;
  shareModalCreated = null;
  document.getElementById("shareError").textContent = "";
  document.getElementById("shareRevokeStatus").textContent = "";
  document.getElementById("shareRevokeStatus").classList.remove("is-ok");
  document.getElementById("shareExpiry").value = "604800";
  document.getElementById("shareMaxViews").value = "";
  document.getElementById("shareBeforeSection").hidden = false;
  document.getElementById("shareAfterSection").hidden = true;
  document.getElementById("shareLinkOutput").value = "";
  document.getElementById("shareRevokeBtn").disabled = false;
  document.getElementById("shareRevokeBtn").textContent = "Revoke link";
  document.getElementById("shareModal").hidden = false;
}

function closeShareModal() {
  document.getElementById("shareModal").hidden = true;
  shareModalTask = null;
  shareModalCreated = null;
}

function wireShareModal() {
  const overlay = document.getElementById("shareModal");
  const createBtn = document.getElementById("shareCreateBtn");
  const copyBtn = document.getElementById("shareCopyBtn");
  const revokeBtn = document.getElementById("shareRevokeBtn");
  const errorEl = document.getElementById("shareError");
  const revokeStatusEl = document.getElementById("shareRevokeStatus");
  const output = document.getElementById("shareLinkOutput");

  document.getElementById("shareCancelBtn").addEventListener("click", () => closeShareModal());
  document.getElementById("shareDoneBtn").addEventListener("click", () => closeShareModal());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeShareModal();
  });

  createBtn.addEventListener("click", async () => {
    if (!shareModalTask) return;
    errorEl.textContent = "";
    createBtn.disabled = true;
    createBtn.textContent = "Creating…";
    try {
      const ttlSeconds = Number(document.getElementById("shareExpiry").value);
      const maxViewsRaw = document.getElementById("shareMaxViews").value;
      const maxViews = maxViewsRaw ? Number(maxViewsRaw) : undefined;
      const created = await createShareLink(shareModalTask, { ttlSeconds, maxViews });
      shareModalCreated = created;
      output.value = created.url;
      document.getElementById("shareBeforeSection").hidden = true;
      document.getElementById("shareAfterSection").hidden = false;
    } catch (err) {
      errorEl.textContent = "Couldn't create the link — check your connection and try again.";
    } finally {
      createBtn.disabled = false;
      createBtn.textContent = "Create link";
    }
  });

  copyBtn.addEventListener("click", async () => {
    output.select();
    try {
      await navigator.clipboard.writeText(output.value);
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    } catch {
      // Clipboard API can be unavailable; the input is already selected
      // above as a manual copy fallback.
    }
  });

  revokeBtn.addEventListener("click", async () => {
    if (!shareModalCreated) return;
    revokeBtn.disabled = true;
    revokeBtn.textContent = "Revoking…";
    revokeStatusEl.classList.remove("is-ok");
    try {
      await deleteShare(shareModalCreated.server, shareModalCreated.id);
      revokeStatusEl.textContent = "Revoked — this link no longer works for anyone who has it.";
      revokeStatusEl.classList.add("is-ok");
      copyBtn.disabled = true;
    } catch (err) {
      revokeStatusEl.textContent = "Couldn't revoke the link — check your connection and try again.";
      revokeBtn.disabled = false;
      revokeBtn.textContent = "Revoke link";
    }
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
      const becameDone = status === "done" && sourceStatus !== "done";

      applyDropOrder(status, orderedIds);
      if (becameDone && sourceTask) {
        const ruled = evaluateTask(automationRules, "onDone", sourceTask);
        if (ruled) Object.assign(sourceTask, ruled, { updatedAt: now() });
      }
      render();

      await persistReorder(status);
      if (sourceStatus !== status) await persistReorder(sourceStatus);
      if (becameDone && sourceTask) {
        await maybeSpawnNextOccurrence(sourceTask);
        render();
      }
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
    {
      label: "Verify task history",
      action: () => { view = "history"; setView(view); render(); },
    },
    {
      label: "Insights",
      action: () => { view = "insights"; setView(view); render(); },
    },
    {
      label: "Calendar",
      action: () => { view = "calendar"; setView(view); render(); },
    },
    { label: "Export all tasks as JSON", hint: ".json", action: exportTasks },
    { label: "Import tasks from JSON or CSV", action: () => document.getElementById("importFileInput").click() },
    { label: "New from template", action: openTemplateModal },
    { label: "Sync settings", action: openSyncModal },
    { label: "Set up social recovery", action: openSocialRecoveryModal },
    { label: "Add a passkey", action: openPasskeyModal },
    { label: "Set up a decoy vault", action: openDecoyVaultModal },
    { label: "Automation rules", action: openAutomationModal },
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
  await loadAutomationRules();
  render();
  showApp();
  document.getElementById("quickAddInput").focus();

  // Backstop for a tab left open with no other interaction past a task's
  // expiry — render() itself already sweeps on every real user action, this
  // just covers the idle case. Cleared on lock (see the lock-screen code)
  // rather than left running against a null `dek`.
  if (ephemeralSweepInterval) clearInterval(ephemeralSweepInterval);
  ephemeralSweepInterval = setInterval(() => scheduleEphemeralSweep(), 20000);
}

// Shared by both the direct "enter your recovery code" form and the
// "reconstruct from shares" flow below — a reconstructed code is just a
// string indistinguishable from an originally-generated one (see
// bytesToRecoveryCode()), so both paths converge on this single check.
// extractable: true on the resulting DEK — it's about to be wrapped again
// under a new passphrase-derived KEK in the reset-passphrase step.
async function attemptRecoveryWithCode(code) {
  const keyring = await getKeyring();
  if (!keyring.wrappedDekRecovery) {
    return { ok: false, reason: "No recovery code was ever set up on this device." };
  }
  const kekR = await deriveKek(normalizeRecoveryCode(code), base64ToBuf(keyring.saltRecovery));
  try {
    const rawDekBytes = await unwrapDek(keyring.wrappedDekRecovery, keyring.wrapIvRecovery, kekR);
    recoveredDek = await importDek(rawDekBytes, true);
  } catch {
    return { ok: false, reason: "That recovery code doesn't match." };
  }
  return { ok: true };
}

// ---------- social recovery: reconstruct-from-shares (lock screen) ----------

let collectedShares = []; // [{ k, share: { index, bytes } }]

function resetShareReconstructPanel() {
  collectedShares = [];
  document.getElementById("shareReconstructInput").value = "";
  document.getElementById("shareReconstructError").textContent = "";
  renderShareReconstructList();
}

function renderShareReconstructList() {
  const list = document.getElementById("shareReconstructList");
  list.textContent = "";
  for (const { share } of collectedShares) {
    const item = document.createElement("div");
    item.className = "share-reconstruct-item";
    item.textContent = `Share #${share.index} added`;
    list.appendChild(item);
  }
  const k = collectedShares[0]?.k;
  document.getElementById("shareProgressStatus").textContent = k
    ? `${collectedShares.length} of ${k} shares added`
    : "";
}

function wireShareReconstructPanel() {
  document.getElementById("useSharesInsteadBtn").addEventListener("click", () => {
    document.getElementById("recoveryForm").hidden = true;
    resetShareReconstructPanel();
    document.getElementById("shareReconstructPanel").hidden = false;
  });

  document.getElementById("backToCodeEntryBtn").addEventListener("click", () => {
    document.getElementById("shareReconstructPanel").hidden = true;
    document.getElementById("recoveryForm").hidden = false;
  });

  document.getElementById("addShareBtn").addEventListener("click", async () => {
    const input = document.getElementById("shareReconstructInput");
    const errorEl = document.getElementById("shareReconstructError");
    errorEl.textContent = "";

    let decoded;
    try {
      decoded = decodeShare(input.value);
    } catch {
      errorEl.textContent = "That doesn't look like a valid share.";
      return;
    }

    if (collectedShares.some((c) => c.share.index === decoded.share.index)) {
      errorEl.textContent = "You've already added this share.";
      return;
    }
    if (collectedShares.length > 0 && collectedShares[0].k !== decoded.k) {
      errorEl.textContent = "This share doesn't match the others you've entered — make sure they're all from the same set.";
      return;
    }

    collectedShares.push(decoded);
    input.value = "";
    renderShareReconstructList();

    if (collectedShares.length >= decoded.k) {
      const secretBytes = reconstructSecret(collectedShares.map((c) => c.share));
      const code = bytesToRecoveryCode(secretBytes);
      const result = await attemptRecoveryWithCode(code);
      if (!result.ok) {
        errorEl.textContent = "These shares don't reconstruct a valid recovery code — check they're entered correctly, or add another if you have a spare.";
        resetShareReconstructPanel();
        return;
      }
      document.getElementById("shareReconstructPanel").hidden = true;
      showResetPassphraseScreen();
    }
  });
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

    // A fresh per-device history-signing identity, wrapped under the same
    // passphrase KEK as the DEK — see docs/ARCHITECTURE.md "Tamper-evident
    // signed task history". Deliberately NOT wrapped under KEK_r too (v1
    // scope): a recovery-code reset starts a new signing identity instead of
    // recovering this one, documented there.
    const signingKeypair = await generateSigningKeypair();
    const signingPublicKeyRaw = await exportSigningPublicKey(signingKeypair.publicKey);
    const signingPublicKeyB64 = bufToBase64(signingPublicKeyRaw);
    const { wrappedSigningKey, signingKeyWrapIv } = await wrapSigningKey(signingKeypair.privateKey, kek);

    pendingDek = await importDek(rawDekBytes);
    pendingSigningKey = await unwrapSigningKey(wrappedSigningKey, signingKeyWrapIv, kek);
    pendingSigningPublicKeyB64 = signingPublicKeyB64;
    pendingKeyring = {
      kdf: KDF_NAME,
      kdfParams: { iterations: PBKDF2_ITERATIONS },
      salt: bufToBase64(salt),
      wrappedDek,
      wrapIv,
      saltRecovery: bufToBase64(saltRecovery),
      wrappedDekRecovery,
      wrapIvRecovery,
      signingPublicKey: signingPublicKeyB64,
      wrappedSigningKey,
      signingKeyWrapIv,
      signingKeyLog: [{ publicKey: signingPublicKeyB64, startedAt: now() }],
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
    historySigningKey = pendingSigningKey;
    historySigningPublicKeyB64 = pendingSigningPublicKeyB64;
    historyChainTip = "GENESIS"; // brand-new vault, nothing in the log yet
    pendingKeyring = null;
    pendingDek = null;
    pendingRecoveryCode = null;
    pendingSigningKey = null;
    pendingSigningPublicKeyB64 = null;
    await afterUnlock();
  });

  unlockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const passphraseInput = document.getElementById("unlockPassphrase");
    setUnlockError("");

    const keyring = await getKeyring();
    const kek = await deriveKek(passphraseInput.value, base64ToBuf(keyring.salt));

    let unlockedAsDecoy = false;
    let activeKek = kek;
    try {
      const rawDekBytes = await unwrapDek(keyring.wrappedDek, keyring.wrapIv, kek);
      dek = await importDek(rawDekBytes);
    } catch {
      dek = null;
    }

    // Wrong against the main vault — try the decoy vault, if one is
    // configured, before reporting failure. Whichever one the passphrase
    // actually opens, everything from here on is identical: same unlock
    // animation, same afterUnlock() call, nothing in this app's own behavior
    // distinguishes "opened the real vault" from "opened the decoy" for
    // anyone watching over a shoulder. See docs/ARCHITECTURE.md.
    if (!dek && keyring.saltDecoy) {
      try {
        const kekDecoy = await deriveKek(passphraseInput.value, base64ToBuf(keyring.saltDecoy));
        const rawDekBytes = await unwrapDek(keyring.wrappedDekDecoy, keyring.wrapIvDecoy, kekDecoy);
        dek = await importDek(rawDekBytes);
        unlockedAsDecoy = true;
        activeKek = kekDecoy;
      } catch {
        dek = null;
      }
    }

    if (!dek) {
      // AES-GCM auth-tag failure on a wrong KEK — fails closed, never a garbage DEK.
      setUnlockError("Wrong passphrase.");
      passphraseInput.value = "";
      passphraseInput.focus();
      return;
    }

    activeVaultIsDecoy = unlockedAsDecoy;
    setActiveVault(unlockedAsDecoy);
    await ensureLocalSigningKeyOnUnlock(keyring, activeKek, unlockedAsDecoy);

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
    document.getElementById("shareReconstructPanel").hidden = true;
    document.getElementById("recoveryForm").hidden = false;
    showRecoveryForm();
  });

  backToUnlockBtn.addEventListener("click", () => {
    setRecoveryError("");
    document.getElementById("shareReconstructPanel").hidden = true;
    document.getElementById("recoveryForm").hidden = false;
    showUnlockScreen();
  });

  wireShareReconstructPanel();

  recoveryForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const codeInput = document.getElementById("recoveryCodeInput");
    setRecoveryError("");

    const result = await attemptRecoveryWithCode(codeInput.value);
    if (!result.ok) {
      setRecoveryError(result.reason);
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

    // The old signing key was wrapped only under the now-forgotten passphrase's
    // KEK (v1 scope decision — see docs/ARCHITECTURE.md), so it's unrecoverable
    // here by construction. Roll a fresh one and *append* it to signingKeyLog
    // (never overwrite) so history entries signed before this reset stay
    // verifiable — they just belong to a previous segment of the chain.
    const signingKeypair = await generateSigningKeypair();
    const signingPublicKeyB64 = bufToBase64(await exportSigningPublicKey(signingKeypair.publicKey));
    const { wrappedSigningKey, signingKeyWrapIv } = await wrapSigningKey(signingKeypair.privateKey, newKek);
    const signingKeyLog = [...(keyring.signingKeyLog || []), { publicKey: signingPublicKeyB64, startedAt: now() }];

    await putKeyring({
      ...keyring,
      salt: bufToBase64(newSalt),
      wrappedDek: newWrappedDek,
      wrapIv: newWrapIv,
      signingPublicKey: signingPublicKeyB64,
      wrappedSigningKey,
      signingKeyWrapIv,
      signingKeyLog,
    });

    const rawDekBytes = await unwrapDek(newWrappedDek, newWrapIv, newKek);
    dek = await importDek(rawDekBytes);
    historySigningKey = await unwrapSigningKey(wrappedSigningKey, signingKeyWrapIv, newKek);
    historySigningPublicKeyB64 = signingPublicKeyB64;
    await primeHistoryChainTip();
    recoveredDek = null;

    document.getElementById("resetPassphrase").value = "";
    document.getElementById("resetPassphraseConfirm").value = "";

    await afterUnlock();
  });
}

function wireLockButton() {
  document.getElementById("lockBtn").addEventListener("click", () => {
    dek = null;
    historySigningKey = null;
    historySigningPublicKeyB64 = null;
    historyChainTip = "GENESIS";
    tasks = [];
    ephemeralTaskKeys.clear();
    automationRules = [];
    // Locking mid-Pomodoro just drops the in-progress session rather than
    // trying to persist against a `dek` that's about to become null — the
    // same trade-off closing the tab mid-session already has.
    if (pomodoroInterval) {
      clearInterval(pomodoroInterval);
      pomodoroInterval = null;
    }
    pomodoroElapsedThisSession = 0;
    pomodoroRemainingSeconds = POMODORO_DURATION_SECONDS;
    if (ephemeralSweepInterval) {
      clearInterval(ephemeralSweepInterval);
      ephemeralSweepInterval = null;
    }
    // Reset to the main vault so the *next* unlock attempt always tries the
    // real passphrase first again — nothing should remember which vault was
    // open last across a lock.
    activeVaultIsDecoy = false;
    setActiveVault(false);
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
    if (keyring.webauthnCredentialId && isWebAuthnAvailable()) {
      document.getElementById("passkeyUnlockBtn").hidden = false;
    }
  } else {
    showSetupScreen();
  }
  document.getElementById("passkeyUnlockBtn").addEventListener("click", () => unlockWithPasskey());
  initPasswordToggles();
  initPassphraseFeedback();
  wireLockScreen();
  wireLockButton();
  wireQuickAdd();
  wireSearch();
  wireFilterBar();
  wireSelectMode();
  wireBulkActions();
  wireImport();
  wireProjectSwitcher();
  wireViewToggle();
  wireEditModal();
  wireAddModal();
  wireShareModal();
  wireDragAndDrop();
  wireCommandPalette();
  wireRevealView();
  wireHistoryView();
  wireSyncModal();
  wireSocialRecoveryModal();
  wirePasskeyModal();
  wireDecoyVaultModal();
  wireAutomationModal();
  wireCalendarView();
  wirePomodoro();
  wireTemplateModal();
  wireAssistantView();
}

wireThemeToggle();
boot();

// PWA app-shell offline cache — registered unconditionally at load, not
// gated behind unlock, since it's about the static assets loading at all
// while offline, not the (already-offline-capable) task data itself. See
// docs/ARCHITECTURE.md "PWA install".
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.error("Service worker registration failed (app still works fully online):", err);
    });
  });
}
