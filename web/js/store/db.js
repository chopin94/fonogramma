// IndexedDB: archivio locale (funziona anche offline).
const DB_NAME = 'fonogramma';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('patients')) db.createObjectStore('patients', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('visits')) db.createObjectStore('visits', { keyPath: 'id' }).createIndex('patientId', 'patientId');
      if (!db.objectStoreNames.contains('recordings')) {
        const s = db.createObjectStore('recordings', { keyPath: 'id' });
        s.createIndex('visitId', 'visitId');
        s.createIndex('patientId', 'patientId');
      }
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function get(store, key) {
  const db = await open();
  return p(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value, key) {
  const db = await open();
  return p(db.transaction(store, 'readwrite').objectStore(store).put(value, key));
}

export async function del(store, key) {
  const db = await open();
  return p(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function all(store) {
  const db = await open();
  return p(db.transaction(store).objectStore(store).getAll());
}

export async function byIndex(store, index, value) {
  const db = await open();
  return p(db.transaction(store).objectStore(store).index(index).getAll(IDBKeyRange.only(value)));
}

export async function persist() {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
