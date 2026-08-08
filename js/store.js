// IndexedDB persistence. From Phase 3 on, crypto.js sits between app.js and this
// module so every task record written here is already ciphertext — this module
// itself doesn't know or care that encryption exists; it just stores records.

const DB_NAME = "haven";
const DECOY_DB_NAME = "haven-decoy"; // see docs/ARCHITECTURE.md "Duress / decoy vault"
const DB_VERSION = 6;
const STORE_NAME = "tasks";
const KEYRING_STORE = "keyring";
const KEYRING_KEY = "main";
// Append-only, keyed by an auto-incrementing `seq` (not `id`) specifically so
// getAll()/cursor order reflects actual append order — a UUID `id` primary
// key would sort lexicographically, breaking the hash chain's notion of
// "previous entry". See docs/ARCHITECTURE.md "Tamper-evident signed history".
const HISTORY_STORE = "historyLog";
// Encrypted the same way tasks are (see js/app.js's loadAutomationRules/
// addAutomationRule) — a rule's trigger/action values (tag names, project
// names) are just as much user content as a task title. See
// docs/ARCHITECTURE.md "Local automation rules".
const RULES_STORE = "rules";
// Same encrypted-JSON-object pattern as tasks and rules — a note's title/body
// is user content like anything else here. See docs/ARCHITECTURE.md "Notes".
const NOTES_STORE = "notes";
// A project name is only otherwise inferred from tasks' `project` field (like
// a tag), so a project with zero tasks in it had nowhere to durably exist —
// switching away from a freshly-created empty project made it vanish from the
// switcher. This store lets an explicitly-created project persist even with
// no tasks yet. Encrypted the same way, not a cleartext name list: a project
// name is as much user content as a task title. See docs/ARCHITECTURE.md
// "Projects".
const PROJECTS_STORE = "projects";

// Same object-store layout for both databases — the decoy DB just never
// happens to have anything in `keyring` (that always lives in the main "haven"
// DB, readable before either passphrase has been tried, since nothing knows
// yet which vault is being unlocked). Harmless unused store, not a schema fork.
// The decoy vault DOES get its own real `rules`/`tasks`/`historyLog` — every
// vault is fully functional, not a stripped-down second-class one.
function upgrade(db) {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    db.createObjectStore(STORE_NAME, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(KEYRING_STORE)) {
    // Out-of-line key: there is only ever one keyring record (KEYRING_KEY).
    db.createObjectStore(KEYRING_STORE);
  }
  if (!db.objectStoreNames.contains(HISTORY_STORE)) {
    db.createObjectStore(HISTORY_STORE, { keyPath: "seq", autoIncrement: true });
  }
  if (!db.objectStoreNames.contains(RULES_STORE)) {
    db.createObjectStore(RULES_STORE, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(NOTES_STORE)) {
    db.createObjectStore(NOTES_STORE, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(PROJECTS_STORE)) {
    db.createObjectStore(PROJECTS_STORE, { keyPath: "id" });
  }
}

function openNamedDB(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Tasks/history live in whichever vault's database is currently active — the
// main "haven" DB by default, or "haven-decoy" once a decoy-passphrase unlock
// switches it (see setActiveVault()). The keyring, below, is a separate
// connection that's always the main DB regardless — see its own comment.
let activeDbName = DB_NAME;
let dbPromise = null;

function openDB() {
  if (!dbPromise) dbPromise = openNamedDB(activeDbName);
  return dbPromise;
}

// Called once, right after an unlock succeeds against either the main or the
// decoy wrapped-DEK, before anything reads/writes tasks or history — so every
// call in this module for the rest of the session resolves against the right
// database. A no-op if the vault didn't actually change (avoids dropping and
// reopening the same connection on every normal-passphrase unlock).
//
// Accepts either the original boolean (isDecoy) or, for a compartmentalised
// vault (see js/app.js "compartmentalised vaults"), the target database name
// directly as a string — openNamedDB() already works with any name, so a
// compartment's own "haven-vault-<id>" database needs no changes here beyond
// accepting that string instead of forcing every caller through a two-vault
// boolean that doesn't generalize past main/decoy.
export function setActiveVault(isDecoyOrDbName) {
  const name = typeof isDecoyOrDbName === "string" ? isDecoyOrDbName : (isDecoyOrDbName ? DECOY_DB_NAME : DB_NAME);
  if (name === activeDbName) return;
  activeDbName = name;
  dbPromise = null;
}

export async function getAllTasks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getTask(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function putTask(task) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(task);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteTask(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Deliberately its own connection, always to the main "haven" DB — the
// keyring holds every vault's wrapped-DEK material (main, recovery, hardware,
// and decoy), and has to be readable *before* a passphrase attempt tells us
// which vault (if any) it unlocks. See docs/ARCHITECTURE.md "Duress / decoy
// vault" for why the decoy's wrapped copy lives here too, not off in
// "haven-decoy" where it'd be unreachable until we already knew to look.
let keyringDbPromise = null;
function openKeyringDB() {
  if (!keyringDbPromise) keyringDbPromise = openNamedDB(DB_NAME);
  return keyringDbPromise;
}

export async function getKeyring() {
  const db = await openKeyringDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYRING_STORE, "readonly");
    const req = tx.objectStore(KEYRING_STORE).get(KEYRING_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function putKeyring(record) {
  const db = await openKeyringDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYRING_STORE, "readwrite");
    tx.objectStore(KEYRING_STORE).put(record, KEYRING_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Append-only: always `add()`, never `put()` — a duplicate/overwrite attempt
// throws rather than silently replacing a past entry.
export async function appendHistoryEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readwrite");
    const req = tx.objectStore(HISTORY_STORE).add(entry);
    req.onsuccess = () => resolve(req.result); // the assigned `seq`
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllHistoryEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readonly");
    const req = tx.objectStore(HISTORY_STORE).getAll();
    req.onsuccess = () => resolve(req.result); // ascending by seq = append order
    req.onerror = () => reject(req.error);
  });
}

// Cursor in "prev" direction rather than getAll()+pop() — avoids reading the
// entire log just to find the current chain tip, which matters once the log
// is thousands of entries long.
export async function getLastHistoryEntry() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HISTORY_STORE, "readonly");
    const req = tx.objectStore(HISTORY_STORE).openCursor(null, "prev");
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllRules() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RULES_STORE, "readonly");
    const req = tx.objectStore(RULES_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putRule(rule) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RULES_STORE, "readwrite");
    tx.objectStore(RULES_STORE).put(rule);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteRule(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(RULES_STORE, "readwrite");
    tx.objectStore(RULES_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllNotes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTES_STORE, "readonly");
    const req = tx.objectStore(NOTES_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putNote(note) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTES_STORE, "readwrite");
    tx.objectStore(NOTES_STORE).put(note);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteNote(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTES_STORE, "readwrite");
    tx.objectStore(NOTES_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllProjects() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, "readonly");
    const req = tx.objectStore(PROJECTS_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putProject(project) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROJECTS_STORE, "readwrite");
    tx.objectStore(PROJECTS_STORE).put(project);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
