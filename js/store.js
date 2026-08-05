// IndexedDB persistence. From Phase 3 on, crypto.js sits between app.js and this
// module so every task record written here is already ciphertext — this module
// itself doesn't know or care that encryption exists; it just stores records.

const DB_NAME = "haven";
const DB_VERSION = 3;
const STORE_NAME = "tasks";
const KEYRING_STORE = "keyring";
const KEYRING_KEY = "main";
// Append-only, keyed by an auto-incrementing `seq` (not `id`) specifically so
// getAll()/cursor order reflects actual append order — a UUID `id` primary
// key would sort lexicographically, breaking the hash chain's notion of
// "previous entry". See docs/ARCHITECTURE.md "Tamper-evident signed history".
const HISTORY_STORE = "historyLog";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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

export async function getKeyring() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEYRING_STORE, "readonly");
    const req = tx.objectStore(KEYRING_STORE).get(KEYRING_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function putKeyring(record) {
  const db = await openDB();
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
