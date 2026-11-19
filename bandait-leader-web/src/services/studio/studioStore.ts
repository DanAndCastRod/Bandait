/**
 * Almacen local del Estudio Bandait: sesiones y picos en IndexedDB, audio en OPFS. Mismo patron y
 * manejo de errores que services/stemStore.ts. Usa APIs del navegador: no es un modulo puro.
 *
 * IndexedDB `bandait_studio` v1:
 *   - sessions: { id, band, title, songId, updatedAt, savedAt, etag, dirty, doc }   clave `id`
 *               (`doc` es el documento del cable, snake_case: serializeSession)
 *   - peaks:    { key: "<sessionId>/<assetId>", sessionId, peaks }                  indice sessionId
 *   - files:    { key: "<sessionId>/<file>", sessionId, file, size, savedAt, blob } indice sessionId
 *               (respaldo: SOLO se usa para el audio cuando el navegador no tiene OPFS)
 *
 * OPFS: bandait_studio/<sessionId>/<file>     (`file` = asset.file, "<assetId>.<ext>")
 *   El escritor de tomas (opfsWriter.worker.ts) escribe directo en esa ruta, con cabecera WAV
 *   provisional (dataBytes 0) que corrige al cerrar. Una toma huerfana es un archivo de esa
 *   carpeta que la sesion no lista.
 *
 * Sin OPFS el audio importado, generado o descargado se guarda en IndexedDB y el Estudio sirve
 * para reproducir y mezclar, pero NO para grabar (el escritor necesita OPFS) ni para recuperar
 * tomas. `storageBackend()` dice cual de los dos se esta usando.
 */
import { buildWavHeader, parseWavHeader } from '../wav.ts'
import {
  STUDIO_ID_RE,
  STUDIO_MAX_ASSET_BYTES,
  StudioSessionError,
  assetExtension,
  parseSession,
  serializeSession,
  type StudioAsset,
  type StudioSession,
  type WireStudioSession,
} from './session.ts'
import type {
  AssetPeaks,
  OrphanTake,
  PeakData,
  SaveSessionOptions,
  StorageEstimate,
  StoredSession,
  StoredSessionMeta,
  StudioStoreApi,
} from './types.ts'

const DB_NAME = 'bandait_studio'
const DB_VERSION = 1
const SESSIONS = 'sessions'
const PEAKS = 'peaks'
const FILES = 'files'

/** Carpeta raiz del Estudio en OPFS. El escritor de tomas la recibe de recorder.ts. */
export const STUDIO_OPFS_ROOT = 'bandait_studio'
/** Bytes del inicio del archivo que se leen para interpretar la cabecera WAV. */
const HEADER_PROBE_BYTES = 4096

const MIME: Record<string, string> = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' }

interface SessionRow extends StoredSessionMeta {
  doc: WireStudioSession
}

interface PeaksRow {
  key: string
  sessionId: string
  peaks: AssetPeaks
}

interface FileRow {
  key: string
  sessionId: string
  file: string
  size: number
  savedAt: string
  blob: Blob
}

/** Error con mensaje para mostrar al usuario. */
export class StudioStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioStoreError'
  }
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new StudioStoreError('Este navegador no permite guardar sesiones localmente (IndexedDB no disponible).'))
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      reject(new StudioStoreError('No se pudo abrir el almacenamiento local (¿navegación privada?).'))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(PEAKS)) {
        const peaks = db.createObjectStore(PEAKS, { keyPath: 'key' })
        peaks.createIndex('sessionId', 'sessionId', { unique: false })
      }
      if (!db.objectStoreNames.contains(FILES)) {
        const files = db.createObjectStore(FILES, { keyPath: 'key' })
        files.createIndex('sessionId', 'sessionId', { unique: false })
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
    req.onerror = () => reject(new StudioStoreError('No se pudo abrir el almacenamiento local (¿navegación privada?).'))
    req.onblocked = () => reject(new StudioStoreError('El almacenamiento local está bloqueado por otra pestaña del hub. Ciérrala y reintenta.'))
  }).catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

function domErrorName(err: unknown): string {
  return err instanceof DOMException ? err.name : ''
}

function friendlyError(err: unknown): Error {
  // Un documento invalido conserva su codigo y su ruta: lo interpreta quien llama.
  if (err instanceof StudioStoreError || err instanceof StudioSessionError) return err
  const name = domErrorName(err)
  if (name === 'QuotaExceededError') {
    return new StudioStoreError('No hay espacio suficiente en el almacenamiento del navegador. Borra sesiones o audios que no uses y reintenta.')
  }
  if (name === 'NoModificationAllowedError') {
    return new StudioStoreError('El archivo de audio está en uso (¿una grabación en curso u otra pestaña del hub?). Reintenta al terminar.')
  }
  return new StudioStoreError('No se pudo leer o guardar en el almacenamiento local del navegador.')
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

// ---------------------------------------------------------------------------
// Nombres y OPFS
// ---------------------------------------------------------------------------

function checkSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !STUDIO_ID_RE.test(sessionId)) throw new StudioStoreError('El id de la sesión no es válido.')
}

/** `file` debe ser "<id>.<ext>" con ext wav | flac | mp3. Devuelve el id del audio. */
function checkFile(file: string): string {
  const ext = typeof file === 'string' ? assetExtension(file) : null
  const id = ext ? file.slice(0, -(ext.length + 1)) : ''
  if (!ext || !STUDIO_ID_RE.test(id)) throw new StudioStoreError('El nombre del archivo de audio no es válido.')
  return id
}

function fileKey(sessionId: string, file: string): string {
  return `${sessionId}/${file}`
}

function hasOpfsApi(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function'
}

let opfsPromise: Promise<FileSystemDirectoryHandle | null> | null = null

/** Carpeta raiz del Estudio en OPFS; null si el navegador no tiene OPFS o no lo deja usar. */
function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (opfsPromise) return opfsPromise
  opfsPromise = (async () => {
    if (!hasOpfsApi()) return null
    try {
      const root = await navigator.storage.getDirectory()
      return await root.getDirectoryHandle(STUDIO_OPFS_ROOT, { create: true })
    } catch {
      // Navegacion privada o almacenamiento bloqueado: se usa el respaldo en IndexedDB.
      return null
    }
  })()
  return opfsPromise
}

async function sessionDir(root: FileSystemDirectoryHandle, sessionId: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await root.getDirectoryHandle(sessionId, { create })
  } catch (err) {
    if (domErrorName(err) === 'NotFoundError') return null
    throw err
  }
}

async function fileHandleOrNull(dir: FileSystemDirectoryHandle, file: string): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(file)
  } catch (err) {
    if (domErrorName(err) === 'NotFoundError') return null
    throw err
  }
}

async function removeEntryQuiet(dir: FileSystemDirectoryHandle, name: string, recursive = false): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive })
  } catch (err) {
    if (domErrorName(err) !== 'NotFoundError') throw err
  }
}

/** Cual almacen de audio usa este navegador. 'none' = ni OPFS ni IndexedDB. */
export async function storageBackend(): Promise<'opfs' | 'indexeddb' | 'none'> {
  if ((await opfsRoot()) !== null) return 'opfs'
  return typeof indexedDB !== 'undefined' ? 'indexeddb' : 'none'
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

/** Normaliza los metadatos de una fila leida (puede estar corrupta). */
function sanitizeMeta(value: unknown): StoredSessionMeta | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || typeof v.doc !== 'object' || v.doc === null) return null
  return {
    id: v.id,
    band: typeof v.band === 'string' ? v.band : 'me',
    title: typeof v.title === 'string' ? v.title : '',
    songId: typeof v.songId === 'string' ? v.songId : null,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '',
    savedAt: typeof v.savedAt === 'string' ? v.savedAt : '',
    etag: typeof v.etag === 'string' ? v.etag : null,
    dirty: v.dirty !== false,
    cloudUpdatedAt: typeof v.cloudUpdatedAt === 'string' ? v.cloudUpdatedAt : null,
  }
}

/**
 * Guarda (o reemplaza) la sesion. `etag` y `dirty` que no vienen se conservan de lo guardado
 * (null y true en una sesion nueva). Si la sesion queda `dirty`, su `updatedAt` pasa a ser ahora.
 * Un documento que no cumple el contrato lanza StudioSessionError y no se guarda.
 */
export async function saveSession(session: StudioSession, options: SaveSessionOptions): Promise<StoredSession> {
  try {
    checkSessionId(session.id)
    const db = await openDb()
    const tx = db.transaction(SESSIONS, 'readwrite')
    const store = tx.objectStore(SESSIONS)
    const done = txDone(tx)
    // Si el documento es invalido la transaccion termina sin escribir; su rechazo no interesa.
    done.catch(() => undefined)
    const previous = sanitizeMeta(await requestValue(store.get(session.id)))
    const dirty = options.dirty ?? previous?.dirty ?? true
    const etag = options.etag !== undefined ? options.etag : (previous?.etag ?? null)
    const cloudUpdatedAt = options.cloudUpdatedAt !== undefined ? options.cloudUpdatedAt : (previous?.cloudUpdatedAt ?? null)
    const savedAt = new Date().toISOString()
    const saved: StudioSession = dirty ? { ...session, updatedAt: savedAt } : session
    const doc = serializeSession(saved)
    const meta: StoredSessionMeta = {
      id: saved.id,
      band: options.band,
      title: saved.title,
      songId: saved.songId,
      updatedAt: saved.updatedAt,
      savedAt,
      etag,
      dirty,
      cloudUpdatedAt,
    }
    store.put({ ...meta, doc } satisfies SessionRow)
    await done
    return { session: saved, meta }
  } catch (err) {
    throw friendlyError(err)
  }
}

/** La sesion guardada, o null si no existe. Un documento danado lanza StudioStoreError. */
export async function loadSession(sessionId: string): Promise<StoredSession | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(SESSIONS, 'readonly')
    const raw: unknown = await requestValue(tx.objectStore(SESSIONS).get(sessionId))
    const meta = sanitizeMeta(raw)
    if (!meta) return null
    let session: StudioSession
    try {
      session = parseSession((raw as SessionRow).doc)
    } catch {
      throw new StudioStoreError('La sesión guardada en este equipo está dañada y no se puede abrir.')
    }
    return { session, meta }
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Metadatos de las sesiones de este navegador, las guardadas mas recientemente primero. */
export async function listSessions(band?: string): Promise<StoredSessionMeta[]> {
  try {
    const db = await openDb()
    const tx = db.transaction(SESSIONS, 'readonly')
    const rows: unknown[] = await requestValue(tx.objectStore(SESSIONS).getAll())
    return rows
      .map(sanitizeMeta)
      .filter((meta): meta is StoredSessionMeta => meta !== null && (band === undefined || meta.band === band))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Borra el documento, sus picos y todo su audio (carpeta de OPFS y respaldo). */
export async function deleteSession(sessionId: string): Promise<void> {
  try {
    checkSessionId(sessionId)
    const db = await openDb()
    const tx = db.transaction([SESSIONS, PEAKS, FILES], 'readwrite')
    const done = txDone(tx)
    tx.objectStore(SESSIONS).delete(sessionId)
    const peaks = tx.objectStore(PEAKS)
    const files = tx.objectStore(FILES)
    const peakKeys = requestValue(peaks.index('sessionId').getAllKeys(sessionId))
    const fileKeys = requestValue(files.index('sessionId').getAllKeys(sessionId))
    for (const key of await peakKeys) peaks.delete(key)
    for (const key of await fileKeys) files.delete(key)
    await done
    const root = await opfsRoot()
    if (root) await removeEntryQuiet(root, sessionId, true)
  } catch (err) {
    throw friendlyError(err)
  }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

async function idbFile(sessionId: string, file: string): Promise<FileRow | null> {
  const db = await openDb()
  const tx = db.transaction(FILES, 'readonly')
  const row: unknown = await requestValue(tx.objectStore(FILES).get(fileKey(sessionId, file)))
  if (typeof row !== 'object' || row === null) return null
  const r = row as Partial<FileRow>
  return r.blob instanceof Blob ? (row as FileRow) : null
}

/**
 * Escribe un audio. Un audio es inmutable: si ya existe con el mismo tamano no hace nada; con
 * otro tamano lanza StudioStoreError. La escritura es atomica (si falla no queda la mitad).
 */
export async function putAsset(sessionId: string, file: string, data: Blob): Promise<void> {
  try {
    checkSessionId(sessionId)
    checkFile(file)
    if (data.size > STUDIO_MAX_ASSET_BYTES) throw new StudioStoreError('El audio pasa de 200 MB, el máximo por archivo del Estudio.')
    if (data.size === 0) throw new StudioStoreError('El audio está vacío.')
    const conflict = 'Ya existe un audio con ese nombre y otro tamaño. Un audio del Estudio no se reemplaza.'

    const root = await opfsRoot()
    if (root) {
      const dir = await sessionDir(root, sessionId, true)
      if (!dir) throw new StudioStoreError('No se pudo crear la carpeta de la sesión.')
      const existing = await fileHandleOrNull(dir, file)
      if (existing) {
        const size = (await existing.getFile()).size
        if (size === data.size) return
        throw new StudioStoreError(conflict)
      }
      const handle = await dir.getFileHandle(file, { create: true })
      let writable: FileSystemWritableFileStream | null = null
      try {
        writable = await handle.createWritable()
        await writable.write(data)
        await writable.close()
      } catch (err) {
        try {
          await writable?.abort()
        } catch {
          // Ya estaba cerrado.
        }
        // No dejar un archivo vacio que despues pareceria un audio existente de otro tamano.
        await removeEntryQuiet(dir, file).catch(() => undefined)
        throw err
      }
      return
    }

    const db = await openDb()
    const tx = db.transaction(FILES, 'readwrite')
    const store = tx.objectStore(FILES)
    const done = txDone(tx)
    done.catch(() => undefined)
    const previous = (await requestValue(store.get(fileKey(sessionId, file)))) as Partial<FileRow> | undefined
    if (previous && previous.blob instanceof Blob) {
      if (previous.blob.size === data.size) {
        await done
        return
      }
      throw new StudioStoreError(conflict)
    }
    store.put({ key: fileKey(sessionId, file), sessionId, file, size: data.size, savedAt: new Date().toISOString(), blob: data } satisfies FileRow)
    await done
  } catch (err) {
    throw friendlyError(err)
  }
}

/** El audio como File (respaldado por disco en OPFS: no carga el archivo en memoria), o null. */
export async function getAsset(sessionId: string, file: string): Promise<File | null> {
  try {
    checkSessionId(sessionId)
    checkFile(file)
    const root = await opfsRoot()
    if (root) {
      const dir = await sessionDir(root, sessionId, false)
      const handle = dir ? await fileHandleOrNull(dir, file) : null
      return handle ? await handle.getFile() : null
    }
    const row = await idbFile(sessionId, file)
    if (!row) return null
    const ext = assetExtension(file)
    return new File([row.blob], file, { type: row.blob.type || (ext ? MIME[ext] : '') })
  } catch (err) {
    throw friendlyError(err)
  }
}

export async function hasAsset(sessionId: string, file: string): Promise<boolean> {
  try {
    checkSessionId(sessionId)
    checkFile(file)
    const root = await opfsRoot()
    if (root) {
      const dir = await sessionDir(root, sessionId, false)
      return dir ? (await fileHandleOrNull(dir, file)) !== null : false
    }
    return (await idbFile(sessionId, file)) !== null
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Borra un audio. Que no exista no es un error. */
export async function deleteAsset(sessionId: string, file: string): Promise<void> {
  try {
    checkSessionId(sessionId)
    checkFile(file)
    const root = await opfsRoot()
    if (root) {
      const dir = await sessionDir(root, sessionId, false)
      if (dir) await removeEntryQuiet(dir, file)
      return
    }
    const db = await openDb()
    const tx = db.transaction(FILES, 'readwrite')
    const done = txDone(tx)
    tx.objectStore(FILES).delete(fileKey(sessionId, file))
    await done
  } catch (err) {
    throw friendlyError(err)
  }
}

// ---------------------------------------------------------------------------
// Tomas huerfanas
// ---------------------------------------------------------------------------

/**
 * Archivos de audio de la carpeta de la sesion que no estan en `knownFiles`. Llamar al abrir la
 * sesion, no mientras se graba: la toma en curso todavia no esta en el documento y saldria aqui.
 * Sin OPFS no hay tomas (no se puede grabar): lista vacia.
 */
export async function listOrphanTakes(sessionId: string, knownFiles: readonly string[]): Promise<OrphanTake[]> {
  try {
    checkSessionId(sessionId)
    const root = await opfsRoot()
    const dir = root ? await sessionDir(root, sessionId, false) : null
    if (!dir) return []
    const known = new Set(knownFiles)
    const orphans: OrphanTake[] = []
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || known.has(name)) continue
      const ext = assetExtension(name)
      if (!ext) continue // archivos temporales del navegador (.crswap) y nombres ajenos
      const assetId = name.slice(0, -(ext.length + 1))
      if (!STUDIO_ID_RE.test(assetId)) continue
      let file: File
      try {
        file = await (handle as FileSystemFileHandle).getFile()
      } catch {
        continue // en uso por el escritor de tomas
      }
      // Una toma del Estudio es siempre un WAV PCM. Un mp3 o flac suelto en la carpeta es un
      // audio importado cuyo paso se deshizo: no es una toma y RECUPERAR no sabria leerlo.
      if (ext !== 'wav') continue
      const header = parseWavHeader(await file.slice(0, HEADER_PROBE_BYTES).arrayBuffer())
      if (!header) continue
      const frameBytes = header ? (header.channels * header.bitsPerSample) / 8 : 0
      const estimatedDurationS =
        header && frameBytes > 0 && header.sampleRate > 0 ? Math.max(0, file.size - header.dataOffset) / frameBytes / header.sampleRate : 0
      orphans.push({ sessionId, file: name, assetId, size: file.size, lastModified: file.lastModified, header, estimatedDurationS })
    }
    return orphans.sort((a, b) => a.lastModified - b.lastModified)
  } catch (err) {
    throw friendlyError(err)
  }
}

/**
 * Repara la cabecera WAV de una toma sin cerrar segun el tamano en disco y devuelve su entrada
 * lista para sessionOps.addAsset (kind 'recording'). Lo que no se alcanzo a volcar a disco antes
 * de cerrarse la pestana (hasta unos 2 segundos) se pierde.
 */
export async function recoverOrphanTake(sessionId: string, file: string): Promise<StudioAsset> {
  try {
    checkSessionId(sessionId)
    const assetId = checkFile(file)
    const root = await opfsRoot()
    const dir = root ? await sessionDir(root, sessionId, false) : null
    const handle = dir ? await fileHandleOrNull(dir, file) : null
    if (!handle) throw new StudioStoreError('La toma ya no está en este equipo.')
    const onDisk = await handle.getFile()
    const header = parseWavHeader(await onDisk.slice(0, HEADER_PROBE_BYTES).arrayBuffer())
    if (!header || header.format !== 1 || (header.channels !== 1 && header.channels !== 2) || (header.bitsPerSample !== 16 && header.bitsPerSample !== 24)) {
      throw new StudioStoreError('El archivo no es una toma del Estudio que se pueda recuperar.')
    }
    const frameBytes = (header.channels * header.bitsPerSample) / 8
    const frames = Math.floor(Math.max(0, onDisk.size - header.dataOffset) / frameBytes)
    const dataBytes = frames * frameBytes
    if (frames === 0) throw new StudioStoreError('La toma está vacía: no quedó audio escrito en disco.')
    const size = header.dataOffset + dataBytes

    if (header.dataBytes !== dataBytes || onDisk.size !== size) {
      const repaired = buildWavHeader({ channels: header.channels, sampleRate: header.sampleRate, bitDepth: header.bitsPerSample, dataBytes })
      if (repaired.byteLength !== header.dataOffset) throw new StudioStoreError('La cabecera de la toma no tiene el formato del Estudio y no se puede reparar.')
      const writable = await handle.createWritable({ keepExistingData: true })
      try {
        await writable.write({ type: 'write', position: 0, data: repaired })
        await writable.truncate(size)
        await writable.close()
      } catch (err) {
        try {
          await writable.abort()
        } catch {
          // Ya estaba cerrado.
        }
        throw err
      }
    }
    return {
      id: assetId,
      file,
      kind: 'recording',
      label: 'Toma recuperada',
      channels: header.channels,
      sampleRate: header.sampleRate,
      durationS: frames / header.sampleRate,
      size,
      source: null,
    }
  } catch (err) {
    throw friendlyError(err)
  }
}

export async function discardOrphanTake(sessionId: string, file: string): Promise<void> {
  return deleteAsset(sessionId, file)
}

// ---------------------------------------------------------------------------
// Picos
// ---------------------------------------------------------------------------

function isPeakData(value: unknown): value is PeakData {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<PeakData>
  return (
    v.min instanceof Int8Array &&
    v.max instanceof Int8Array &&
    v.min.length === v.max.length &&
    typeof v.samplesPerBucket === 'number' &&
    v.samplesPerBucket >= 1
  )
}

function sanitizePeaks(value: unknown, assetId: string): AssetPeaks | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<AssetPeaks>
  if (v.assetId !== assetId || typeof v.sampleRate !== 'number' || !(v.sampleRate > 0)) return null
  if (!Array.isArray(v.channels) || v.channels.length === 0 || !v.channels.every(isPeakData)) return null
  return { assetId, sampleRate: v.sampleRate, channels: v.channels }
}

export async function savePeaks(sessionId: string, peaks: AssetPeaks): Promise<void> {
  try {
    checkSessionId(sessionId)
    const db = await openDb()
    const tx = db.transaction(PEAKS, 'readwrite')
    const done = txDone(tx)
    tx.objectStore(PEAKS).put({ key: fileKey(sessionId, peaks.assetId), sessionId, peaks } satisfies PeaksRow)
    await done
  } catch (err) {
    throw friendlyError(err)
  }
}

/** Los picos guardados de un audio, o null si no hay (o estan danados: se recalculan). */
export async function loadPeaks(sessionId: string, assetId: string): Promise<AssetPeaks | null> {
  try {
    const db = await openDb()
    const tx = db.transaction(PEAKS, 'readonly')
    const row = (await requestValue(tx.objectStore(PEAKS).get(fileKey(sessionId, assetId)))) as Partial<PeaksRow> | undefined
    return row ? sanitizePeaks(row.peaks, assetId) : null
  } catch (err) {
    throw friendlyError(err)
  }
}

// ---------------------------------------------------------------------------
// Capacidad
// ---------------------------------------------------------------------------

/** Uso y cuota del almacenamiento del navegador (puede no estar disponible). */
export async function estimateStorage(): Promise<StorageEstimate | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const { usage, quota } = await navigator.storage.estimate()
    return typeof usage === 'number' && typeof quota === 'number' ? { usageBytes: usage, quotaBytes: quota } : null
  } catch {
    return null
  }
}

/**
 * true si este navegador tiene OPFS e IndexedDB (lo que el Estudio completo necesita). Con solo
 * IndexedDB el audio cae al respaldo y no se puede grabar: ver `storageBackend`.
 */
export function isSupported(): boolean {
  return typeof indexedDB !== 'undefined' && hasOpfsApi()
}

void ({
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  putAsset,
  getAsset,
  hasAsset,
  deleteAsset,
  listOrphanTakes,
  recoverOrphanTake,
  discardOrphanTake,
  savePeaks,
  loadPeaks,
  estimateStorage,
  isSupported,
} satisfies StudioStoreApi)
