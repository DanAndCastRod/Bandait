/**
 * Almacen local de stems: los archivos de audio se guardan en IndexedDB de ESTE navegador, por
 * `song_id` de la libreria. No van a localStorage (pesan varios MB) ni a Supabase (la subida a la
 * nube no esta decidida). Tampoco tocan el workspace v2: `stemsMap` sigue como esta y se sincroniza
 * igual que antes (bandait-protocol/WORKSPACE_V2.md no cambia).
 *
 * Base `bandait_stems` v1:
 *   - songs: { songId, offsetMs, updatedAt, tracks: StoredStemTrack[] }    (metadatos livianos)
 *   - files: { id, songId, blob }                                          (audio, indice songId)
 */
import { isStemRole, type StemRole } from './stemNames'
import { OFFSET_MAX_MS, OFFSET_MIN_MS } from './stemTiming'

const DB_NAME = 'bandait_stems'
const DB_VERSION = 1
const SONGS = 'songs'
const FILES = 'files'

export interface StoredStemTrack {
  id: string
  role: StemRole
  label: string
  fileName: string
  size: number
  mimeType: string
}

export interface StemSongRecord {
  songId: string
  /** Offset de alineacion en ms: tiempo del audio donde cae el compas 1. */
  offsetMs: number
  updatedAt: string
  tracks: StoredStemTrack[]
}

export interface NewStemTrack {
  role: StemRole
  label: string
  fileName: string
  blob: Blob
}

interface FileRow {
  id: string
  songId: string
  blob: Blob
}

/** Error con mensaje para mostrar al usuario. */
export class StemStoreError extends Error {}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StemStoreError('Este navegador no permite guardar archivos localmente (IndexedDB no disponible).'))
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      reject(new StemStoreError('No se pudo abrir el almacenamiento local (¿navegación privada?).'))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SONGS)) db.createObjectStore(SONGS, { keyPath: 'songId' })
      if (!db.objectStoreNames.contains(FILES)) {
        const files = db.createObjectStore(FILES, { keyPath: 'id' })
        files.createIndex('songId', 'songId', { unique: false })
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // Otra pestana actualiza la version: cerrar para no bloquearla; la proxima llamada reabre.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(new StemStoreError('No se pudo abrir el almacenamiento local (¿navegación privada?).'))
    req.onblocked = () => reject(new StemStoreError('El almacenamiento local está bloqueado por otra pestaña del hub. Ciérrala y reintenta.'))
  }).catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

function friendlyError(err: unknown): StemStoreError {
  if (err instanceof StemStoreError) return err
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'QuotaExceededError') {
    return new StemStoreError('No hay espacio suficiente en el almacenamiento del navegador. Borra stems de otras canciones y reintenta.')
  }
  return new StemStoreError('No se pudo leer o guardar en el almacenamiento local del navegador.')
}

function requestValue<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new DOMException('aborted', 'AbortError'))
    tx.onerror = () => reject(tx.error)
  })
}

/** Normaliza un registro leido (puede venir de una version vieja o estar corrupto). */
function sanitizeRecord(value: unknown): StemSongRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.songId !== 'string' || !Array.isArray(v.tracks)) return null
  const tracks: StoredStemTrack[] = []
  for (const t of v.tracks) {
    if (typeof t !== 'object' || t === null) continue
    const r = t as Record<string, unknown>
    if (typeof r.id !== 'string' || typeof r.fileName !== 'string') continue
    const role = isStemRole(r.role) ? r.role : 'unknown'
    tracks.push({
      id: r.id,
      role,
      label: typeof r.label === 'string' ? r.label : r.fileName,
      fileName: r.fileName,
      size: typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0,
      mimeType: typeof r.mimeType === 'string' ? r.mimeType : '',
    })
  }
  return {
    songId: v.songId,
    offsetMs: clampOffset(typeof v.offsetMs === 'number' ? v.offsetMs : 0),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    tracks,
  }
}

export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.round(Math.min(OFFSET_MAX_MS, Math.max(OFFSET_MIN_MS, ms)))
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `stem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** Metadatos de todas las canciones con stems guardados en este navegador (sin audio). */
export async function listStemSongs(): Promise<StemSongRecord[]> {
  try {
    const db = await openDb()
    const tx = db.transaction(SONGS, 'readonly')
    const rows = await requestValue(tx.objectStore(SONGS).getAll())
    return rows.map(sanitizeRecord).filter((r): r is StemSongRecord => r !== null)
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Metadatos y audio de una cancion. Una pista cuyo archivo falta queda sin blob (la UI lo avisa). */
export async function loadStemSong(songId: string): Promise<{ record: StemSongRecord; blobs: Map<string, Blob> } | null> {
  try {
    const db = await openDb()
    const tx = db.transaction([SONGS, FILES], 'readonly')
    const recordRaw = await requestValue(tx.objectStore(SONGS).get(songId))
    const record = sanitizeRecord(recordRaw)
    if (!record) return null
    const rows = (await requestValue(tx.objectStore(FILES).index('songId').getAll(songId))) as FileRow[]
    const blobs = new Map<string, Blob>()
    for (const row of rows) if (row && typeof row.id === 'string' && row.blob instanceof Blob) blobs.set(row.id, row.blob)
    return { record, blobs }
  } catch (err) {
    throw friendlyError(err)
  }
}

/**
 * Guarda pistas de una cancion. mode 'replace' borra las anteriores; 'append' las conserva.
 * Todo en una transaccion: si falta espacio no queda la mitad guardada.
 */
export async function saveStemSong(
  songId: string,
  tracks: NewStemTrack[],
  mode: 'replace' | 'append'
): Promise<StemSongRecord> {
  try {
    const db = await openDb()
    const tx = db.transaction([SONGS, FILES], 'readwrite')
    const songs = tx.objectStore(SONGS)
    const files = tx.objectStore(FILES)
    const done = txDone(tx)

    const previous = sanitizeRecord(await requestValue(songs.get(songId)))
    let kept: StoredStemTrack[] = []
    if (previous && mode === 'append') {
      kept = previous.tracks
    } else if (previous) {
      const oldKeys = await requestValue(files.index('songId').getAllKeys(songId))
      for (const key of oldKeys) files.delete(key)
    }

    const added: StoredStemTrack[] = []
    for (const t of tracks) {
      const id = newId()
      files.put({ id, songId, blob: t.blob } satisfies FileRow)
      added.push({ id, role: t.role, label: t.label, fileName: t.fileName, size: t.blob.size, mimeType: t.blob.type })
    }
    const record: StemSongRecord = {
      songId,
      offsetMs: previous?.offsetMs ?? 0,
      updatedAt: new Date().toISOString(),
      tracks: [...kept, ...added],
    }
    songs.put(record)
    await done
    return record
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Cambia solo metadatos (offset, rol o etiqueta de pistas) sin reescribir el audio. */
export async function updateStemMeta(
  songId: string,
  patch: { offsetMs?: number; tracks?: Array<Pick<StoredStemTrack, 'id' | 'role' | 'label'>> }
): Promise<StemSongRecord | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(SONGS, 'readwrite')
    const store = tx.objectStore(SONGS)
    const done = txDone(tx)
    const current = sanitizeRecord(await requestValue(store.get(songId)))
    if (!current) {
      await done
      return null
    }
    const next: StemSongRecord = { ...current, updatedAt: new Date().toISOString() }
    if (patch.offsetMs !== undefined) next.offsetMs = clampOffset(patch.offsetMs)
    if (patch.tracks) {
      const byId = new Map(patch.tracks.map((t) => [t.id, t]))
      next.tracks = current.tracks.map((t) => {
        const p = byId.get(t.id)
        return p ? { ...t, role: p.role, label: p.label } : t
      })
    }
    store.put(next)
    await done
    return next
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Borra una pista (metadatos y audio). Si era la ultima, borra la cancion del almacen. */
export async function deleteStemTrack(songId: string, trackId: string): Promise<StemSongRecord | null> {
  try {
    const db = await openDb()
    const tx = db.transaction([SONGS, FILES], 'readwrite')
    const songs = tx.objectStore(SONGS)
    const done = txDone(tx)
    const current = sanitizeRecord(await requestValue(songs.get(songId)))
    tx.objectStore(FILES).delete(trackId)
    let next: StemSongRecord | null = null
    if (current) {
      const tracks = current.tracks.filter((t) => t.id !== trackId)
      if (tracks.length === 0) songs.delete(songId)
      else {
        next = { ...current, tracks, updatedAt: new Date().toISOString() }
        songs.put(next)
      }
    }
    await done
    return next
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Borra todos los stems de una cancion (metadatos y audio). */
export async function deleteStemSong(songId: string): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction([SONGS, FILES], 'readwrite')
    const done = txDone(tx)
    const files = tx.objectStore(FILES)
    tx.objectStore(SONGS).delete(songId)
    const keys = await requestValue(files.index('songId').getAllKeys(songId))
    for (const key of keys) files.delete(key)
    await done
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Uso del almacenamiento del navegador (puede no estar disponible). */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const { usage, quota } = await navigator.storage.estimate()
    return typeof usage === 'number' && typeof quota === 'number' ? { usage, quota } : null
  } catch {
    return null
  }
}

/** Pide que el navegador no borre el almacen por presion de espacio. Sin efecto si lo niega. */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.persist) await navigator.storage.persist()
  } catch {
    // Opcional: sin persistencia el navegador puede liberar el espacio si se queda sin disco.
  }
}
