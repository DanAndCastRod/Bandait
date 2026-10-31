/**
 * Cliente del Worker `bandait-stems` (stems de las bandas en Cloudflare R2). Contrato completo en
 * bandait-stems-worker/README.md:
 *   GET    /v1/bands/{band}/songs/{song}/manifest        integrante
 *   PUT    /v1/bands/{band}/songs/{song}/files/{name}    Owner / MusicDirector
 *   GET    /v1/bands/{band}/songs/{song}/files/{name}    integrante
 *   PUT    /v1/bands/{band}/songs/{song}/manifest        Owner / MusicDirector (es el commit)
 *   DELETE /v1/bands/{band}/songs/{song}                 Owner / MusicDirector
 * `{band}` es el uuid de la banda compartida o `me` (workspace personal). Bearer = access_token
 * de la sesion de Supabase.
 *
 * Modulo sin DOM ni import.meta.env: la URL, el token y `fetch` llegan por parametro, asi se
 * prueba en scripts/verify-stems-logic.ts. La configuracion real vive en stemCloudConfig.ts.
 */
import { isStemRole, recognizeStem, stemExtension, type StemRole } from './stemNames.ts'
import { saveStemSong, type NewStemTrack, type StemSongRecord, type StoredStemTrack } from './stemStore.ts'

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

export interface CloudTarget {
  /** URL base del Worker, sin barra final. */
  baseUrl: string
  /** uuid de la banda compartida o 'me'. */
  band: string
  /** access_token vigente de Supabase, o null si no hay sesion. */
  getToken: () => Promise<string | null>
  fetchFn?: FetchFn
}

export interface CloudStem {
  file: string
  role: StemRole
  label: string
  size: number
}

export interface CloudManifest {
  version: 1
  song_id: string
  offset_ms: number
  stems: CloudStem[]
  updated_at?: string
}

/** Limites del Worker (README, API v1). */
export const CLOUD_MAX_STEMS = 16
export const CLOUD_MAX_FILE_BYTES = 200 * 1024 * 1024
export const CLOUD_MAX_OFFSET_MS = 10000
const LABEL_MAX = 60
const FILE_MAX = 120
const FILE_RE = /^[A-Za-z0-9 ._()-]{1,120}$/
const SONG_RE = /^[A-Za-z0-9_-]{1,80}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Extensiones que el lider (Python) puede decodificar. m4a/aac solo suenan en el hub. */
export const LEADER_PLAYABLE_EXTENSIONS: readonly string[] = ['mp3', 'wav', 'flac', 'ogg']

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
}

/** Error del Worker o de la red, con mensaje en espanol para la UI. */
export class StemCloudError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, message?: string) {
    super(message ?? cloudErrorMessage(code, status))
    this.code = code
    this.status = status
  }
}

const MESSAGES: Record<string, string> = {
  missing_token: 'Tu sesión de nube no está activa. Vuelve a entrar con Google.',
  invalid_token: 'Tu sesión de nube venció o no es válida. Vuelve a entrar con Google.',
  no_session: 'Necesitas una sesión de nube activa para usar los stems en la nube.',
  not_a_member: 'No eres integrante de esta banda en la nube.',
  not_an_editor: 'Solo el Owner o el Director musical de la banda pueden subir o borrar stems en la nube.',
  no_stems: 'Esta canción no tiene stems en la nube.',
  no_file: 'Falta un archivo en la nube: pide a quien los subió que los vuelva a subir.',
  bad_band: 'La banda no es válida para la nube de stems.',
  bad_song: 'El id de la canción no es válido para la nube de stems.',
  bad_file: 'El nombre de un archivo no es válido para la nube.',
  bad_manifest: 'La nube rechazó la lista de stems (formato inválido).',
  incomplete_upload: 'La subida de un archivo quedó incompleta. Reintenta.',
  missing_file: 'Falta un archivo en la nube al confirmar la subida. Reintenta.',
  length_required: 'El navegador no informó el tamaño del archivo. Reintenta.',
  file_too_large: 'Un archivo supera los 200 MB que admite la nube.',
  manifest_too_large: 'La lista de stems es demasiado grande para la nube.',
  not_audio: 'La nube solo acepta archivos de audio.',
  auth_unavailable: 'La nube no pudo verificar tu sesión en este momento. Reintenta en un rato.',
  too_many_stems: `La nube admite hasta ${CLOUD_MAX_STEMS} stems por canción.`,
  network: 'No hay conexión con la nube de stems. Revisa tu internet y reintenta.',
  bad_response: 'La nube devolvió una respuesta inesperada.',
  size_mismatch: 'Un archivo descargado no tiene el tamaño esperado. Reintenta.',
  missing_local: 'Falta un archivo de audio en este equipo; vuelve a importar los stems.',
}

export function cloudErrorMessage(code: string, status = 0): string {
  if (MESSAGES[code]) return MESSAGES[code]
  if (status === 401) return MESSAGES.invalid_token
  if (status === 403) return 'La nube no te permite hacer esto en esta banda.'
  if (status >= 500) return `La nube de stems falló (HTTP ${status}). Reintenta en un rato.`
  return `La nube de stems respondió con un error (${code || `HTTP ${status}`}).`
}

/** `{band}` para la URL: el uuid de la banda compartida o 'me'. */
export function cloudBandKey(bandId: string | null | undefined, shared: boolean): string {
  return shared && bandId && UUID_RE.test(bandId) ? bandId : 'me'
}

/** La cancion puede ir a la nube (el Worker restringe el id). */
export function isCloudSongId(songId: string): boolean {
  return SONG_RE.test(songId)
}

/**
 * Nombres de archivo validos para el Worker, unicos sin distinguir mayusculas: sin tildes, con lo
 * que no sea `A-Za-z0-9 ._()-` cambiado por '_', sin '..' ni punto inicial, extension en
 * minusculas y a lo sumo 120 caracteres. Los repetidos se numeran: "Voz (2).mp3".
 */
export function cloudFileNames(fileNames: string[]): string[] {
  const used = new Set<string>()
  return fileNames.map((original) => {
    const ext = stemExtension(original) || 'mp3'
    const dot = original.lastIndexOf('.')
    let base = (dot > 0 ? original.slice(0, dot) : original)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9 ._()-]/g, '_')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.\s]+/, '')
      .replace(/[.\s]+$/, '')
      .replace(/\s+/g, ' ')
    if (base === '') base = 'stem'
    const maxBase = FILE_MAX - ext.length - 1 - 4
    if (base.length > maxBase) base = base.slice(0, maxBase).replace(/[.\s]+$/, '') || 'stem'
    let name = `${base}.${ext}`
    let n = 2
    while (used.has(name.toLowerCase())) name = `${base} (${n++}).${ext}`
    used.add(name.toLowerCase())
    return name
  })
}

export function leaderCanPlay(fileName: string): boolean {
  return LEADER_PLAYABLE_EXTENSIONS.includes(stemExtension(fileName))
}

/** Lo que se compara para saber si la nube tiene lo mismo que este equipo. */
function signature(offsetMs: number, stems: Array<{ role: string; label: string; size: number }>): string {
  const parts = stems.map((s) => `${s.role}|${s.label}|${s.size}`).sort()
  return `${Math.round(offsetMs)}#${parts.join(';')}`
}

/** true si el manifiesto de la nube coincide con los stems guardados en este equipo. */
export function manifestMatchesRecord(manifest: CloudManifest, record: StemSongRecord): boolean {
  return signature(manifest.offset_ms, manifest.stems) === signature(clampCloudOffset(record.offsetMs), record.tracks.map(cloudLabelOf))
}

function cloudLabelOf(t: Pick<StoredStemTrack, 'role' | 'label' | 'size'>) {
  return { role: t.role, label: cloudLabel(t.label, t.role), size: t.size }
}

function cloudLabel(label: string, role: StemRole): string {
  const trimmed = label.trim().slice(0, LABEL_MAX)
  return trimmed || role
}

function clampCloudOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0
  return Math.round(Math.max(-CLOUD_MAX_OFFSET_MS, Math.min(CLOUD_MAX_OFFSET_MS, ms)))
}

/** Valida un manifiesto recibido (defensivo: la nube podria tener datos de otra version). */
export function parseManifest(raw: unknown, songId: string): CloudManifest {
  if (typeof raw !== 'object' || raw === null) throw new StemCloudError('bad_response', 200)
  const m = raw as Record<string, unknown>
  if (m.version !== 1 || m.song_id !== songId || !Array.isArray(m.stems)) throw new StemCloudError('bad_response', 200)
  const stems: CloudStem[] = []
  for (const s of m.stems) {
    if (typeof s !== 'object' || s === null) throw new StemCloudError('bad_response', 200)
    const e = s as Record<string, unknown>
    if (typeof e.file !== 'string' || !FILE_RE.test(e.file) || typeof e.size !== 'number' || !Number.isSafeInteger(e.size) || e.size < 1) {
      throw new StemCloudError('bad_response', 200)
    }
    const role: StemRole = isStemRole(e.role) ? e.role : recognizeStem(e.file) ?? 'unknown'
    stems.push({ file: e.file, role, label: typeof e.label === 'string' && e.label ? e.label : e.file, size: e.size })
  }
  return {
    version: 1,
    song_id: songId,
    offset_ms: typeof m.offset_ms === 'number' && Number.isFinite(m.offset_ms) ? Math.round(m.offset_ms) : 0,
    stems,
    updated_at: typeof m.updated_at === 'string' ? m.updated_at : undefined,
  }
}

// ---- HTTP ----

function songUrl(target: CloudTarget, songId: string): string {
  if (!isCloudSongId(songId)) throw new StemCloudError('bad_song', 400)
  return `${target.baseUrl.replace(/\/+$/, '')}/v1/bands/${encodeURIComponent(target.band)}/songs/${encodeURIComponent(songId)}`
}

async function authHeaders(target: CloudTarget): Promise<Record<string, string>> {
  let token: string | null
  try {
    token = await target.getToken()
  } catch {
    token = null
  }
  if (!token) throw new StemCloudError('no_session', 401)
  return { Authorization: `Bearer ${token}` }
}

async function send(target: CloudTarget, url: string, init: RequestInit): Promise<Response> {
  const fetchFn = target.fetchFn ?? ((input: string, i?: RequestInit) => fetch(input, i))
  let res: Response
  try {
    res = await fetchFn(url, init)
  } catch {
    throw new StemCloudError('network', 0)
  }
  return res
}

async function failFrom(res: Response): Promise<StemCloudError> {
  let code = ''
  try {
    const body = (await res.json()) as unknown
    if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') code = (body as { error: string }).error
  } catch {
    code = ''
  }
  return new StemCloudError(code, res.status)
}

/** Manifiesto de la cancion, o null si no tiene stems en la nube (404 no_stems). */
export async function getManifest(target: CloudTarget, songId: string): Promise<CloudManifest | null> {
  const headers = await authHeaders(target)
  const res = await send(target, `${songUrl(target, songId)}/manifest`, { method: 'GET', headers, cache: 'no-store' })
  if (res.status === 404) {
    const err = await failFrom(res)
    if (err.code === 'no_stems' || err.code === '') return null
    throw err
  }
  if (!res.ok) throw await failFrom(res)
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new StemCloudError('bad_response', res.status)
  }
  return parseManifest(raw, songId)
}

export interface UploadInput {
  record: StemSongRecord
  /** Audio de cada pista (id de pista -> blob), de loadStemSong. */
  blobs: Map<string, Blob>
  /** Manifiesto actual de la nube: los archivos con el mismo nombre y tamano no se vuelven a subir. */
  existing?: CloudManifest | null
}

/**
 * Sube los stems: primero cada archivo (PUT files/{name}) y despues el manifiesto, que es el
 * commit. `onProgress(hechos, total)` cuenta archivos (los que ya estaban en la nube cuentan como
 * hechos). Si falla a mitad, la nube conserva el manifiesto anterior.
 */
export async function uploadStems(
  target: CloudTarget,
  songId: string,
  input: UploadInput,
  onProgress?: (done: number, total: number) => void
): Promise<CloudManifest> {
  const { record, blobs } = input
  const tracks = record.tracks
  if (tracks.length === 0) throw new StemCloudError('bad_manifest', 400)
  if (tracks.length > CLOUD_MAX_STEMS) throw new StemCloudError('too_many_stems', 400)
  for (const t of tracks) {
    const blob = blobs.get(t.id)
    if (!blob || blob.size === 0) throw new StemCloudError('missing_local', 0)
    if (blob.size > CLOUD_MAX_FILE_BYTES) throw new StemCloudError('file_too_large', 413)
  }
  const base = songUrl(target, songId)
  const names = cloudFileNames(tracks.map((t) => t.fileName))
  const already = new Map((input.existing?.stems ?? []).map((s) => [s.file.toLowerCase(), s.size]))
  const total = tracks.length
  let done = 0
  onProgress?.(done, total)

  for (let i = 0; i < tracks.length; i++) {
    const blob = blobs.get(tracks[i].id) as Blob
    const name = names[i]
    if (already.get(name.toLowerCase()) !== blob.size) {
      const headers = await authHeaders(target)
      headers['Content-Type'] = MIME_BY_EXT[stemExtension(name)] ?? 'application/octet-stream'
      const res = await send(target, `${base}/files/${encodeURIComponent(name)}`, { method: 'PUT', headers, body: blob })
      if (!res.ok) throw await failFrom(res)
    }
    done += 1
    onProgress?.(done, total)
  }

  const manifest: CloudManifest = {
    version: 1,
    song_id: songId,
    offset_ms: clampCloudOffset(record.offsetMs),
    stems: tracks.map((t, i) => ({ file: names[i], role: t.role, label: cloudLabel(t.label, t.role), size: (blobs.get(t.id) as Blob).size })),
  }
  const headers = await authHeaders(target)
  headers['Content-Type'] = 'application/json'
  const res = await send(target, `${base}/manifest`, { method: 'PUT', headers, body: JSON.stringify(manifest) })
  if (!res.ok) throw await failFrom(res)
  try {
    return parseManifest(await res.json(), songId)
  } catch {
    return manifest
  }
}

/**
 * Descarga el manifiesto y cada archivo. Devuelve las pistas listas para guardarlas en el
 * almacen local (stemStore.saveStemSong) y el offset; no toca IndexedDB.
 */
export async function downloadStemFiles(
  target: CloudTarget,
  songId: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ manifest: CloudManifest; tracks: NewStemTrack[] }> {
  const manifest = await getManifest(target, songId)
  if (!manifest || manifest.stems.length === 0) throw new StemCloudError('no_stems', 404)
  const base = songUrl(target, songId)
  const tracks: NewStemTrack[] = []
  const total = manifest.stems.length
  onProgress?.(0, total)
  for (const stem of manifest.stems) {
    const headers = await authHeaders(target)
    const res = await send(target, `${base}/files/${encodeURIComponent(stem.file)}`, { method: 'GET', headers, cache: 'no-store' })
    if (!res.ok) throw await failFrom(res)
    let blob: Blob
    try {
      blob = await res.blob()
    } catch {
      throw new StemCloudError('network', 0)
    }
    if (blob.size !== stem.size) throw new StemCloudError('size_mismatch', 200)
    const type = MIME_BY_EXT[stemExtension(stem.file)] ?? blob.type
    tracks.push({ role: stem.role, label: stem.label, fileName: stem.file, blob: blob.type === type ? blob : new Blob([blob], { type }) })
    onProgress?.(tracks.length, total)
  }
  return { manifest, tracks }
}

/**
 * Descarga los stems de la nube (manifiesto y despues archivos) y los guarda en IndexedDB,
 * reemplazando los de este equipo. Si la descarga falla a mitad, lo local no se toca.
 */
export async function downloadStems(
  target: CloudTarget,
  songId: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ record: StemSongRecord; manifest: CloudManifest }> {
  const { manifest, tracks } = await downloadStemFiles(target, songId, onProgress)
  const record = await saveStemSong(songId, tracks, 'replace', manifest.offset_ms)
  return { record, manifest }
}

/** Borra los stems de la cancion en la nube. Devuelve cuantos objetos borro el Worker. */
export async function deleteCloudStems(target: CloudTarget, songId: string): Promise<number> {
  const headers = await authHeaders(target)
  const res = await send(target, songUrl(target, songId), { method: 'DELETE', headers })
  if (!res.ok) throw await failFrom(res)
  try {
    const body = (await res.json()) as { deleted?: unknown }
    return typeof body.deleted === 'number' ? body.deleted : 0
  } catch {
    return 0
  }
}
