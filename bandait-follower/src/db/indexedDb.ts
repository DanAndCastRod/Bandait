/**
 * IndexedDB wrapper for offline song/setlist storage.
 */

const DB_NAME = "bandait-follower";
const DB_VERSION = 2;

export interface StoredStem {
  id: string; // `${songId}_${stemType}`
  songId: string;
  stemType: string; // 'drums' | 'bass' | 'vocals' | 'other' | 'click' | 'prompts'
  data: ArrayBuffer;
  size: number;
  mimeType: string;
  updatedAt: number;
}

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
      if (!db.objectStoreNames.contains("stemBlobs")) {
        const stemStore = db.createObjectStore("stemBlobs", { keyPath: "id" });
        stemStore.createIndex("songId", "songId", { unique: false });
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
    const stores = ["songs", "setlists"];
    if (db.objectStoreNames.contains("stemBlobs")) {
      stores.push("stemBlobs");
    }
    const tx = db.transaction(stores, "readwrite");
    tx.objectStore("songs").clear();
    tx.objectStore("setlists").clear();
    if (db.objectStoreNames.contains("stemBlobs")) {
      tx.objectStore("stemBlobs").clear();
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ----------------------------------------------------------------------------
// STEM BLOB STORAGE OPERATIONS (SPRINT 4)
// ----------------------------------------------------------------------------

export async function saveStem(stem: StoredStem): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("stemBlobs", "readwrite");
    tx.objectStore("stemBlobs").put(stem);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStem(songId: string, stemType: string): Promise<StoredStem | null> {
  const db = await openDb();
  const id = `${songId}_${stemType}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("stemBlobs", "readonly");
    const request = tx.objectStore("stemBlobs").get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function getStemsBySong(songId: string): Promise<StoredStem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("stemBlobs", "readonly");
    const store = tx.objectStore("stemBlobs");
    const index = store.index("songId");
    const request = index.getAll(IDBKeyRange.only(songId));
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteStemsBySong(songId: string): Promise<void> {
  const stems = await getStemsBySong(songId);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("stemBlobs", "readwrite");
    const store = tx.objectStore("stemBlobs");
    for (const stem of stems) {
      store.delete(stem.id);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllStems(): Promise<StoredStem[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("stemBlobs", "readonly");
    const request = tx.objectStore("stemBlobs").getAll();
    request.onsuccess = () => resolve(request.result ?? []);
    request.onerror = () => reject(request.error);
  });
}

export async function clearStems(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("stemBlobs", "readwrite");
    tx.objectStore("stemBlobs").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
