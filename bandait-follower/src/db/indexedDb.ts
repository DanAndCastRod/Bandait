/**
 * IndexedDB wrapper for offline song/setlist storage.
 */

const DB_NAME = "bandait-follower";
const DB_VERSION = 1;

export interface StoredSong {
  id: string;
  title: string;
  bpm: number;
  key: string;
  segments: Array<{ label: string; bars: number }>;
  lyrics: Array<{ time: number; text: string }>;
}

export interface StoredSetlist {
  id: string;
  name: string;
  songs: StoredSong[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("songs")) {
        db.createObjectStore("songs", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("setlists")) {
        db.createObjectStore("setlists", { keyPath: "id" });
      }
    };
  });
}

export async function saveSetlist(setlist: StoredSetlist): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["setlists", "songs"], "readwrite");
  tx.objectStore("setlists").put(setlist);
  for (const song of setlist.songs) {
    tx.objectStore("songs").put(song);
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSetlist(id: string): Promise<StoredSetlist | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("setlists", "readonly");
    const store = tx.objectStore("setlists");
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllSetlists(): Promise<StoredSetlist[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("setlists", "readonly");
    const store = tx.objectStore("setlists");
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function getSong(id: string): Promise<StoredSong | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("songs", "readonly");
    const request = tx.objectStore("songs").get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["songs", "setlists"], "readwrite");
    tx.objectStore("songs").clear();
    tx.objectStore("setlists").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
