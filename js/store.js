// IndexedDB persistence. From Phase 3 on, crypto.js sits between app.js and this
// module so every task record written here is already ciphertext — this module
// itself doesn't know or care that encryption exists; it just stores records.

const DB_NAME = "haven";
const DB_VERSION = 2;
const STORE_NAME = "tasks";
const KEYRING_STORE = "keyring";
const KEYRING_KEY = "main";

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
