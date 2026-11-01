/**
 * Analisis con IA de una cancion (Worker bandait-stems, Music AI). Contrato en
 * bandait-stems-worker/README.md:
 *   POST /v1/bands/{band}/songs/{song}/analysis   cuerpo = mezcla WAV; 202 {status:"STARTED", job_id}
 *   POST .../analysis?separate=1                  cuerpo = la cancion completa (wav, flac, mp3, m4a; 95 MB);
 *                                                  202 {status:"STARTED", job_id, separate:true}. Music AI separa
 *                                                  los stems y el Worker los copia a R2, reemplazando los que hubiera.
 *   GET  /v1/bands/{band}/songs/{song}/analysis   {status:"STARTED"} | {status:"IMPORTING", done, total}
 *                                                  | {status:"SUCCEEDED", draft, created_at, stems?: manifiesto v1}
 *                                                  | {status:"FAILED", error} | 404 no_analysis
 *                                                  En IMPORTING cada GET copia UN stem: hay que seguir consultando.
 *                                                  502 stems_copy_failed se reintenta (es idempotente).
 * Solo Owner y MusicDirector (tambien para leer el borrador). El borrador queda guardado por
 * cancion en R2: lo puede haber lanzado el lider desde el portatil.
 *
 * Modulo sin DOM: la URL, el token y `fetch` llegan en el CloudTarget (ver stemCloud.ts).
 */
import { StemCloudError, authHeaders, cloudErrorMessage, failFrom, parseManifest, send, songUrl, type CloudManifest, type CloudTarget } from './stemCloud.ts'
import type { SectionKind, SongSection } from '../types/hub.ts'

export interface DraftSection {
  kind: SectionKind
  label: string
  bars: number
  start_bar: number
  chordpro: string
  cue_text: string | null
}

export interface AnalysisDraft {
  source: string
  bpm: number | null
  key: string | null
  beats_per_bar: number
  sections: DraftSection[]
  lyrics_unplaced: string[]
  notes: string[]
}

export type AnalysisState =
  | { status: 'none' }
  | { status: 'STARTED'; jobId: string | null }
  /** Separacion: el Worker esta copiando los stems de Music AI a R2 (uno por consulta). */
  | { status: 'IMPORTING'; done: number; total: number }
  /** `stems`: manifiesto nuevo de la nube cuando el analisis separo la cancion; null si no. */
  | { status: 'SUCCEEDED'; draft: AnalysisDraft; createdAt: string | null; stems: CloudManifest | null }
  | { status: 'FAILED'; error: string }

/** Cada cuanto se consulta y cuanto se espera como maximo (Music AI tarda 1-3 min). */
export const ANALYSIS_POLL_MS = 5000
export const ANALYSIS_TIMEOUT_MS = 6 * 60 * 1000
/** Limite del Worker para la mezcla (95 MB). */
export const ANALYSIS_MAX_BYTES = 95 * 1024 * 1024

const SECTION_KINDS: readonly SectionKind[] = ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'solo', 'interlude', 'outro', 'break', 'custom']

const ANALYSIS_MESSAGES: Record<string, string> = {
  analysis_unavailable: 'El análisis con IA no está disponible en este momento. Reintenta más tarde.',
  analysis_auth_failed: 'El servicio de análisis rechazó la conexión de Bandait. Avísale a quien administra Bandait.',
  analysis_failed: 'El servicio de análisis falló. Reintenta en unos minutos.',
  analysis_upload_failed: 'No se pudo enviar la mezcla al servicio de análisis. Reintenta.',
  not_an_editor: 'Solo el Owner o el Director musical de la banda pueden analizar canciones con IA.',
  not_a_member: 'No eres integrante de esta banda en la nube.',
  file_too_large: 'La mezcla supera los 95 MB que admite el análisis.',
  not_audio: 'El análisis solo acepta audio.',
  stems_copy_failed: 'No se pudo copiar un stem a la nube. Se reintenta solo.',
  separation_failed: 'Music AI no pudo separar la canción. Revisa el archivo y reintenta.',
  bad_audio_type: 'Ese archivo no es un audio que la separación acepte: usa WAV, FLAC, MP3 o M4A.',
  song_too_large: 'La canción supera los 95 MB que admite la separación. Usa un MP3 o un FLAC.',
  length_required: 'El navegador no informó el tamaño de la mezcla. Reintenta.',
  timeout: 'El análisis tarda más de lo normal. Vuelve a abrirlo más tarde: el resultado queda guardado en la nube.',
  bad_draft: 'La nube devolvió un borrador que el hub no entiende.',
}

/** Mensaje en espanol para un error del analisis (codigo del Worker o de red). */
export function analysisErrorMessage(code: string, status = 0): string {
  if (ANALYSIS_MESSAGES[code]) return ANALYSIS_MESSAGES[code]
  if (status === 503) return ANALYSIS_MESSAGES.analysis_unavailable
  if (status === 502 && code.startsWith('analysis_')) return ANALYSIS_MESSAGES.analysis_failed
  if (status === 403) return ANALYSIS_MESSAGES.not_an_editor
  if (status === 413) return ANALYSIS_MESSAGES.file_too_large
  if (status === 415) return ANALYSIS_MESSAGES.not_audio
  return cloudErrorMessage(code, status)
}

function analysisError(err: StemCloudError): StemCloudError {
  return new StemCloudError(err.code, err.status, analysisErrorMessage(err.code, err.status))
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Valida el borrador recibido (defensivo: viene de otro servicio). */
export function parseDraft(raw: unknown): AnalysisDraft {
  if (typeof raw !== 'object' || raw === null) throw new StemCloudError('bad_draft', 200, ANALYSIS_MESSAGES.bad_draft)
  const d = raw as Record<string, unknown>
  if (!Array.isArray(d.sections)) throw new StemCloudError('bad_draft', 200, ANALYSIS_MESSAGES.bad_draft)
  const sections: DraftSection[] = []
  let nextBar = 1
  for (const s of d.sections) {
    if (typeof s !== 'object' || s === null) continue
    const e = s as Record<string, unknown>
    const bars = typeof e.bars === 'number' && Number.isInteger(e.bars) && e.bars >= 1 ? e.bars : null
    if (bars === null) continue
    const kind = SECTION_KINDS.includes(e.kind as SectionKind) ? (e.kind as SectionKind) : 'custom'
    const startBar = typeof e.start_bar === 'number' && Number.isInteger(e.start_bar) && e.start_bar >= 1 ? e.start_bar : nextBar
    sections.push({
      kind,
      label: str(e.label).trim().slice(0, 60) || 'Sección',
      bars,
      start_bar: startBar,
      chordpro: str(e.chordpro),
      cue_text: typeof e.cue_text === 'string' ? e.cue_text : null,
    })
    nextBar = startBar + bars
  }
  const bpm = typeof d.bpm === 'number' && Number.isFinite(d.bpm) && d.bpm > 0 ? d.bpm : null
  const bpb = typeof d.beats_per_bar === 'number' && Number.isInteger(d.beats_per_bar) && d.beats_per_bar >= 1 ? d.beats_per_bar : 4
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [])
  return {
    source: str(d.source, 'desconocido'),
    bpm,
    key: typeof d.key === 'string' && d.key.trim() ? d.key.trim() : null,
    beats_per_bar: bpb,
    sections,
    lyrics_unplaced: strings(d.lyrics_unplaced),
    notes: strings(d.notes),
  }
}

/**
 * Secciones del formulario a partir del borrador. Cada seccion conserva el id de la seccion previa
 * del mismo tipo y orden (la segunda estrofa toma el id de la segunda estrofa): el workspace nunca
 * cambia un id existente, y el lider, la PWA y el bucle de ENSAYO siguen reconociendo la seccion.
 * Las que no tienen pareja reciben un id nuevo. `cue_text` null en el borrador significa "sin
 * texto propuesto": queda el aviso por defecto segun el tipo.
 */
export function draftToSongSections(
  draft: AnalysisDraft,
  newId: () => string,
  previous: ReadonlyArray<Pick<SongSection, 'id' | 'kind'>> = [],
): SongSection[] {
  const byKind = new Map<SectionKind, string[]>()
  for (const p of previous) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p.id])
  return draft.sections.map((s) => {
    const id = byKind.get(s.kind)?.shift() ?? newId()
    const sec: SongSection = { id, kind: s.kind, label: s.label, bars: s.bars, chordpro: s.chordpro.replace(/\s+$/, '') }
    if (typeof s.cue_text === 'string' && s.cue_text.trim()) sec.cueText = s.cue_text.trim()
    return sec
  })
}

/** Estado del ultimo analisis de la cancion (404 no_analysis = 'none'). */
export async function getAnalysis(target: CloudTarget, songId: string): Promise<AnalysisState> {
  const headers = await authHeaders(target)
  const res = await send(target, `${songUrl(target, songId)}/analysis`, { method: 'GET', headers, cache: 'no-store' })
  if (res.status === 404) {
    const err = await failFrom(res)
    if (err.code === 'no_analysis' || err.code === '') return { status: 'none' }
    throw analysisError(err)
  }
  if (!res.ok) throw analysisError(await failFrom(res))
  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    throw new StemCloudError('bad_response', res.status)
  }
  const status = str(body.status)
  if (status === 'SUCCEEDED') {
    let stems: CloudManifest | null = null
    if (body.stems !== undefined && body.stems !== null) {
      try {
        stems = parseManifest(body.stems, songId)
      } catch {
        stems = null
      }
    }
    return { status: 'SUCCEEDED', draft: parseDraft(body.draft), createdAt: typeof body.created_at === 'string' ? body.created_at : null, stems }
  }
  if (status === 'IMPORTING') {
    const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)
    const total = count(body.total)
    return { status: 'IMPORTING', done: Math.min(count(body.done), total || count(body.done)), total }
  }
  if (status === 'FAILED') return { status: 'FAILED', error: str(body.error).trim() || 'El servicio de análisis no pudo analizar la canción.' }
  // STARTED, QUEUED u otro estado intermedio de Music AI: sigue en curso.
  return { status: 'STARTED', jobId: typeof body.job_id === 'string' ? body.job_id : null }
}

/** Sube la mezcla y lanza el analisis (202). */
export async function startAnalysis(target: CloudTarget, songId: string, wav: Blob): Promise<{ jobId: string | null }> {
  if (wav.size > ANALYSIS_MAX_BYTES) throw new StemCloudError('file_too_large', 413, ANALYSIS_MESSAGES.file_too_large)
  const headers = await authHeaders(target)
  headers['Content-Type'] = 'audio/wav'
  const res = await send(target, `${songUrl(target, songId)}/analysis`, { method: 'POST', headers, body: wav })
  if (!res.ok) throw analysisError(await failFrom(res))
  try {
    const body = (await res.json()) as { job_id?: unknown }
    return { jobId: typeof body.job_id === 'string' ? body.job_id : null }
  } catch {
    return { jobId: null }
  }
}

// ---------------------------------------------------------------------------
// Separacion: subir la cancion completa y que Music AI devuelva los stems
// ---------------------------------------------------------------------------

/** Consulta de la separacion: cada GET en IMPORTING copia un stem, asi que se consulta seguido. */
export const SEPARATION_POLL_MS = 3000
/** Music AI tarda ~1 min y la copia ~7 consultas; con margen para canciones largas. */
export const SEPARATION_TIMEOUT_MS = 15 * 60 * 1000
/** Reintentos seguidos ante 502 stems_copy_failed o errores de red antes de rendirse. */
export const SEPARATION_MAX_RETRIES = 8
/** Lo que acepta el selector de archivo. */
export const SEPARATION_ACCEPT = 'audio/*,.wav,.flac,.mp3,.m4a'

const SEPARATION_TYPES: Record<string, string> = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4' }

/**
 * Content-Type para subir la cancion: el del archivo si es audio/*, o el de su extension
 * (algunos navegadores dejan vacio el tipo de .flac o .m4a). null si no es un audio aceptado.
 */
export function separationContentType(file: { name: string; type?: string }): string | null {
  const type = (file.type ?? '').trim().toLowerCase()
  if (type.startsWith('audio/')) return type
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? ''
  return SEPARATION_TYPES[ext] ?? null
}

/** Revisa el archivo antes de subirlo: null si sirve, o el mensaje del problema. */
export function separationFileProblem(file: { name: string; type?: string; size: number }): string | null {
  if (!separationContentType(file)) return ANALYSIS_MESSAGES.bad_audio_type
  if (file.size > ANALYSIS_MAX_BYTES) return ANALYSIS_MESSAGES.song_too_large
  if (file.size === 0) return ANALYSIS_MESSAGES.bad_audio_type
  return null
}

/** Texto de progreso de una separacion en curso (o terminada). */
export function separationStatusText(state: AnalysisState): string {
  switch (state.status) {
    case 'STARTED':
      return 'SEPARANDO EN MUSIC AI...'
    case 'IMPORTING':
      return state.total > 0 ? `COPIANDO STEMS ${state.done}/${state.total}...` : 'COPIANDO STEMS...'
    case 'SUCCEEDED':
      return state.stems ? `LISTO: ${state.stems.stems.length} STEMS EN LA NUBE` : 'LISTO'
    case 'FAILED':
      return 'LA SEPARACIÓN FALLÓ'
    default:
      return 'ESPERANDO A MUSIC AI...'
  }
}

/** Subida con progreso (XMLHttpRequest: fetch no informa el avance de lo que envia). */
function xhrUpload(url: string, headers: Record<string, string>, body: Blob, onUpload: (fraction: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onUpload(Math.min(1, e.loaded / e.total))
    }
    xhr.onload = () => resolve(new Response(xhr.responseText || null, { status: xhr.status, headers: { 'Content-Type': 'application/json' } }))
    xhr.onerror = () => reject(new StemCloudError('network', 0))
    xhr.onabort = () => reject(new StemCloudError('network', 0))
    xhr.send(body)
  })
}

/**
 * Sube la cancion completa y lanza la separacion (202). Solo editores. Reemplaza los stems de la
 * nube cuando termina. `onUpload` recibe la fraccion subida (0..1) si el navegador la informa.
 */
export async function startSeparation(
  target: CloudTarget,
  songId: string,
  file: Blob & { name?: string },
  onUpload?: (fraction: number) => void
): Promise<{ jobId: string | null }> {
  const contentType = separationContentType({ name: file.name ?? '', type: file.type })
  if (!contentType) throw new StemCloudError('bad_audio_type', 415, ANALYSIS_MESSAGES.bad_audio_type)
  if (file.size > ANALYSIS_MAX_BYTES) throw new StemCloudError('file_too_large', 413, ANALYSIS_MESSAGES.song_too_large)
  const headers = await authHeaders(target)
  headers['Content-Type'] = contentType
  const url = `${songUrl(target, songId)}/analysis?separate=1`
  // El navegador pone Content-Length a partir del Blob. Con fetch inyectado (pruebas) no hay XHR.
  const useXhr = !!onUpload && !target.fetchFn && typeof XMLHttpRequest !== 'undefined'
  let res: Response
  if (useXhr) {
    try {
      res = await xhrUpload(url, headers, file, onUpload)
    } catch (err) {
      throw err instanceof StemCloudError ? err : new StemCloudError('network', 0)
    }
  } else {
    res = await send(target, url, { method: 'POST', headers, body: file })
  }
  if (!res.ok) throw analysisError(await failFrom(res))
  onUpload?.(1)
  try {
    const body = (await res.json()) as { job_id?: unknown }
    return { jobId: typeof body.job_id === 'string' ? body.job_id : null }
  } catch {
    return { jobId: null }
  }
}

export interface WatchOptions {
  /** Cada estado intermedio (STARTED, IMPORTING) y el final. */
  onState?: (state: AnalysisState) => void
  /** Al abortar se deja de consultar y la promesa resuelve null. */
  signal?: AbortSignal
  intervalMs?: number
  timeoutMs?: number
  /** Inyectables para las pruebas. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}

/**
 * Consulta la separacion hasta que termina: SUCCEEDED (con el manifiesto nuevo) o FAILED. Cada
 * GET en IMPORTING hace avanzar la copia, por eso se consulta cada 3 s. 502 stems_copy_failed y
 * los errores de red se reintentan (hasta SEPARATION_MAX_RETRIES seguidos); el resto de errores
 * se lanza. Abortar (componente desmontado) resuelve null sin consultar mas.
 */
export async function watchSeparation(target: CloudTarget, songId: string, opts: WatchOptions = {}): Promise<AnalysisState | null> {
  const interval = opts.intervalMs ?? SEPARATION_POLL_MS
  const timeout = opts.timeoutMs ?? SEPARATION_TIMEOUT_MS
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? (() => Date.now())
  const since = now()
  let retries = 0
  for (;;) {
    if (opts.signal?.aborted) return null
    let state: AnalysisState
    try {
      state = await getAnalysis(target, songId)
      retries = 0
    } catch (err) {
      const retryable = err instanceof StemCloudError && (err.code === 'stems_copy_failed' || err.code === 'network')
      if (!retryable || ++retries > SEPARATION_MAX_RETRIES) throw err
      if (opts.signal?.aborted) return null
      await sleep(interval, opts.signal)
      continue
    }
    if (opts.signal?.aborted) return null
    opts.onState?.(state)
    if (state.status === 'SUCCEEDED' || state.status === 'FAILED') return state
    if (now() - since > timeout) {
      const failed: AnalysisState = { status: 'FAILED', error: ANALYSIS_MESSAGES.timeout }
      opts.onState?.(failed)
      return failed
    }
    await sleep(interval, opts.signal)
  }
}
