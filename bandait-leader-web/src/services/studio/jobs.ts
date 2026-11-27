/**
 * Trabajos de IA del Estudio Bandait (STUDIO_V1.md seccion 6): revisar la peticion antes de
 * gastar, lanzar y sondear (mismo patron que stemAnalysis.ts: intervalo, tiempo limite y
 * reintentos viven en studioCloud.watchJob), textos de estado en espanol, y las medidas por pista
 * que recibe el asistente de mezcla (solo numeros: nunca se manda audio).
 *
 * v2 (STUDIO_V2.md seccion 4, al final del archivo): compose, analyze y chat con el mismo patron
 * (runJobV2: job_id elegido por el Hub y guardado antes de enviar, reintentos y retomar), las
 * peticiones armadas desde la sesion, el resultado convertido en propuesta (clip MIDI, marcas,
 * datos de la sesion) y la conversacion del chat (resumen de la sesion, recorte, tool_mode).
 *
 * Modulo sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts). Quien llama
 * le pasa las muestras ya renderizadas (bounce.renderMix o los buffers del motor).
 */
import { StemCloudError, type CloudTarget } from '../stemCloud.ts'
import { bandEnergiesDb, integratedLufs, truePeakDb, LOUDNESS_DEFAULT_TARGET_LUFS } from './loudness.ts'
import {
  STUDIO_BEATS_PER_BAR_MAX,
  STUDIO_BEATS_PER_BAR_MIN,
  STUDIO_BPM_MAX,
  STUDIO_BPM_MIN,
  STUDIO_MASTER_ID,
  STUDIO_MAX_ASSET_LABEL,
  STUDIO_MAX_BEAT,
  STUDIO_MAX_KEY,
  STUDIO_MAX_MARKERS,
  STUDIO_MAX_MARKER_LABEL,
  STUDIO_MAX_NOTES_PER_CLIP,
  STUDIO_MAX_PROMPT,
  STUDIO_MAX_SESSION_CHORDS,
  STUDIO_MAX_SESSION_CHORD_NAME,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACK_NAME,
  STUDIO_MAX_TRACKS,
  STUDIO_MIDI_MIN_NOTE_BEATS,
  STUDIO_TIME_EPSILON_S,
  beatsToSeconds,
  compareNotes,
  defaultMidiClip,
  findTrack,
  isStudioId,
  newStudioId,
  roundBeat,
  secondsToBeats,
  sessionEndSeconds,
  type StudioAsset,
  type StudioChord,
  type StudioClip,
  type StudioFxType,
  type StudioMarker,
  type StudioMidiClip,
  type StudioMidiNote,
  type StudioSession,
  type StudioTrack,
} from './session.ts'
import { normalizeNotes } from './midiOps.ts'
import {
  CHAT_SUMMARY_LITERAL_NOTES,
  CHAT_SUMMARY_MAX_CHORDS,
  isDrumTrack,
  midiClipDigest,
  midiClipMutedFlag,
  mixForSummary,
  sessionChordsForSummary,
  songChordChart,
  type ChatSummaryExtras,
  type MixForSummary,
} from './chatContext.ts'
import {
  STUDIO_CHAT_BODY_MAX_BYTES,
  STUDIO_JOB_MAX_RETRIES,
  STUDIO_JOB_POLL_MS,
  STUDIO_JOB_TIMEOUT_MS,
  STUDIO_MAX_CHAT_TOOL_CALLS,
  STUDIO_TOOL_CALL_ID_RE,
  estimateJob,
  estimateJobV2,
  jobRequestV2Bytes,
  sessionSummaryToWire,
  startJob,
  startJobV2,
  studioCloudErrorMessage,
  watchJob,
  watchJobV2,
} from './studioCloud.ts'
import type {
  AnalyzeJobRequest,
  BandEnergies,
  ChatJobRequest,
  CommandContext,
  ComposeContextTrack,
  ComposeJobRequest,
  ComposeRole,
  GenerateJobRequest,
  MixMetrics,
  MixSuggestion,
  SessionMetaPatch,
  StudioAnalysis,
  StudioChatMessage,
  StudioChatToolResult,
  StudioJobAsset,
  StudioJobEstimate,
  StudioJobEstimateV2,
  StudioJobKind,
  StudioJobKindV2,
  StudioJobRequest,
  StudioJobRequestV2,
  StudioJobState,
  StudioJobStateV2,
  StudioChatListen,
  StudioSessionSummary,
  StudioTrackSummary,
  TrackMetrics,
  WatchJobOptions,
} from './types.ts'

export { STUDIO_JOB_MAX_RETRIES, STUDIO_JOB_POLL_MS, STUDIO_JOB_TIMEOUT_MS }

/** Rangos de STUDIO_V1.md 6.1. */
export const JOB_TARGET_LUFS_MIN = -24
export const JOB_TARGET_LUFS_MAX = -6
export const JOB_DEFAULT_TARGET_LUFS = LOUDNESS_DEFAULT_TARGET_LUFS
export const JOB_GENERATE_SECONDS_MIN = 5
export const JOB_GENERATE_SECONDS_MAX = 240

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<StudioJobKind, string> = {
  master: 'Masterizar',
  separate: 'Separar en stems',
  generate: 'Generar audio',
  assist: 'Asistente de mezcla',
}

const STARTED_TEXT: Record<StudioJobKind, string> = {
  master: 'MASTERIZANDO EN MUSIC AI...',
  separate: 'SEPARANDO EN MUSIC AI...',
  generate: 'GENERANDO AUDIO...',
  assist: 'ANALIZANDO LA MEZCLA...',
}

const FAILED_TEXT: Record<StudioJobKind, string> = {
  master: 'LA MASTERIZACIÓN FALLÓ',
  separate: 'LA SEPARACIÓN FALLÓ',
  generate: 'LA GENERACIÓN FALLÓ',
  assist: 'EL ASISTENTE FALLÓ',
}

/** Nombre del trabajo para botones y titulos. */
export function jobKindLabel(kind: StudioJobKind): string {
  return KIND_LABELS[kind]
}

/** Texto de progreso de un trabajo en curso o terminado (mismo tono que separationStatusText). */
export function jobStatusText(state: StudioJobState): string {
  switch (state.status) {
    case 'STARTED':
      return STARTED_TEXT[state.kind]
    case 'IMPORTING':
      return state.total > 0 ? `COPIANDO AUDIOS ${state.done}/${state.total}...` : 'COPIANDO AUDIOS...'
    case 'SUCCEEDED':
      if (state.kind === 'assist') {
        const n = state.suggestions.length
        return n === 0 ? 'LISTO: SIN CAMBIOS PROPUESTOS' : n === 1 ? 'LISTO: 1 SUGERENCIA' : `LISTO: ${n} SUGERENCIAS`
      }
      return state.assets.length === 1 ? 'LISTO: 1 AUDIO NUEVO' : `LISTO: ${state.assets.length} AUDIOS NUEVOS`
    case 'FAILED':
      return FAILED_TEXT[state.kind]
  }
}

/** Mensaje en espanol para lo que lanzo un trabajo (error del Worker, de red o cualquier otro). */
export function jobErrorMessage(err: unknown): string {
  if (err instanceof StemCloudError) return err.message || studioCloudErrorMessage(err.code, err.status)
  if (err instanceof Error && err.message) return err.message
  return 'El trabajo falló por un motivo desconocido.'
}

/** "USD 0,20": dos decimales con coma. */
export function formatUsd(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0
  return `USD ${safe.toFixed(2).replace('.', ',')}`
}

/** Linea de costo para el panel de trabajos, antes de confirmar (sirve para v1 y v2). */
export function estimateText(estimate: Omit<StudioJobEstimate, 'kind'>): string {
  const cost = `Costo estimado: ${formatUsd(estimate.estimatedCostUsd)}.`
  const spent =
    estimate.budgetUsd === null
      ? `Gasto del mes: ${formatUsd(estimate.spentUsd)}.`
      : `Gasto del mes: ${formatUsd(estimate.spentUsd)} de ${formatUsd(estimate.budgetUsd)}.`
  return estimate.allowed ? `${cost} ${spent}` : `${cost} ${spent} Este trabajo pasaría el tope mensual de la banda.`
}

// ---------------------------------------------------------------------------
// Revision de la peticion (antes de gastar)
// ---------------------------------------------------------------------------

function between(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/**
 * Revisa una peticion contra STUDIO_V1.md 6.1 antes de salir a la red: null si sirve, o el
 * mensaje del problema. El Worker valida otra vez (400 bad_job).
 */
export function jobRequestProblem(req: StudioJobRequest): string | null {
  switch (req.kind) {
    case 'master':
    case 'separate': {
      if (!isStudioId(req.assetId)) return 'Falta elegir el audio que se va a procesar.'
      if (!(req.durationS > 0) || !between(req.durationS, 0, STUDIO_MAX_SESSION_SECONDS)) return 'El audio debe durar entre 0 y 20 minutos.'
      if (req.kind === 'master' && !between(req.targetLufs, JOB_TARGET_LUFS_MIN, JOB_TARGET_LUFS_MAX)) {
        return `El volumen objetivo debe estar entre ${JOB_TARGET_LUFS_MIN} y ${JOB_TARGET_LUFS_MAX} LUFS.`
      }
      return null
    }
    case 'generate': {
      if (req.provider !== 'lyria' && req.provider !== 'suno') return 'Proveedor de generación no admitido.'
      const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : ''
      if (prompt.length < 1) return 'Escribe qué quieres generar.'
      if (req.prompt.length > STUDIO_MAX_PROMPT) return `La descripción admite hasta ${STUDIO_MAX_PROMPT} caracteres.`
      if (!between(req.durationS, JOB_GENERATE_SECONDS_MIN, JOB_GENERATE_SECONDS_MAX)) {
        return `La duración debe estar entre ${JOB_GENERATE_SECONDS_MIN} y ${JOB_GENERATE_SECONDS_MAX} segundos.`
      }
      if (!between(req.bpm, STUDIO_BPM_MIN, STUDIO_BPM_MAX)) return `El tempo debe estar entre ${STUDIO_BPM_MIN} y ${STUDIO_BPM_MAX} BPM.`
      if (req.key !== null && (typeof req.key !== 'string' || req.key.length < 1 || req.key.length > STUDIO_MAX_KEY)) return 'La tonalidad no es válida.'
      if (typeof req.instrumental !== 'boolean') return 'Falta indicar si el audio es instrumental.'
      return null
    }
    case 'assist': {
      const m = req.metrics
      if (!between(m.targetLufs, JOB_TARGET_LUFS_MIN, JOB_TARGET_LUFS_MAX)) {
        return `El volumen objetivo debe estar entre ${JOB_TARGET_LUFS_MIN} y ${JOB_TARGET_LUFS_MAX} LUFS.`
      }
      if (m.tracks.length < 1) return 'El asistente necesita al menos una pista con audio.'
      if (m.tracks.length > STUDIO_MAX_TRACKS) return `El asistente admite hasta ${STUDIO_MAX_TRACKS} pistas.`
      return null
    }
  }
}

// ---------------------------------------------------------------------------
// Lanzar y sondear
// ---------------------------------------------------------------------------

export interface RunJobOptions extends WatchJobOptions {
  /**
   * Se llama una vez con el id del trabajo ANTES de enviarlo: el id lo elige el Hub. Quien llama
   * lo guarda para poder retomar el trabajo (resumeJob) si la pestana se cierra, la red se cae o
   * vence el tiempo de espera, en vez de lanzar (y pagar) otro.
   */
  onStarted?: (jobId: string) => void
  /** Inyectable para las pruebas. Por defecto `job_` mas 8 hexadecimales. */
  newJobId?: () => string
}

/**
 * Lanza un trabajo y lo consulta hasta que termina. GASTA CREDITOS: quien llama ya mostro el
 * costo (estimate) y el usuario confirmo. Devuelve el estado final (SUCCEEDED o FAILED), o null
 * si se aborto. Una peticion invalida lanza StemCloudError 'bad_job' sin salir a la red; los
 * errores del Worker (quota_exceeded, provider_unavailable...) se lanzan con mensaje en espanol.
 *
 * Si la respuesta del POST se pierde (error de red), el Worker pudo haber aceptado el trabajo:
 * no se relanza, se consulta el id. Solo si la nube dice que ese trabajo no existe (404) se
 * lanza el error de red original, y entonces reintentar es seguro.
 */
export async function runJob(target: CloudTarget, sessionId: string, req: StudioJobRequest, options: RunJobOptions = {}): Promise<StudioJobState | null> {
  const problem = jobRequestProblem(req)
  if (problem) throw new StemCloudError('bad_job', 400, problem)
  if (options.signal?.aborted) return null
  const jobId = (options.newJobId ?? (() => newStudioId('job')))()
  options.onStarted?.(jobId)
  try {
    const started = await startJob(target, sessionId, req, jobId)
    options.onState?.(started)
  } catch (err) {
    if (!(err instanceof StemCloudError) || err.code !== 'network') throw err
    try {
      return await watchJob(target, sessionId, jobId, options)
    } catch (inner) {
      if (inner instanceof StemCloudError && inner.code === 'no_job') throw err
      throw inner
    }
  }
  if (options.signal?.aborted) return null
  // Primera consulta despues de un intervalo: el proveedor nunca termina al instante.
  const interval = options.intervalMs ?? STUDIO_JOB_POLL_MS
  await (options.sleep ?? defaultSleep)(interval, options.signal)
  return watchJob(target, sessionId, jobId, options)
}

/**
 * Retoma un trabajo ya lanzado: lo consulta hasta que termina, sin lanzar nada. Un 404 `no_job`
 * significa que el trabajo nunca llego a crearse (no se cobro): quien llama puede relanzar.
 */
export function resumeJob(target: CloudTarget, sessionId: string, jobId: string, options: WatchJobOptions = {}): Promise<StudioJobState | null> {
  return watchJob(target, sessionId, jobId, options)
}

/** Trabajo lanzado que el Hub recuerda para poder retomarlo (por sesion y tipo). */
export interface PendingJob {
  jobId: string
  kind: StudioJobKind
  request: StudioJobRequest
  /** Lo que la seccion necesita para aceptar el resultado; debe ser serializable. */
  context: unknown
  /** Milisegundos de epoca en que se lanzo. */
  at: number
}

export function pendingJobKey(sessionId: string, kind: StudioJobKindV2): string {
  return `bandait_studio_job:${sessionId}:${kind}`
}

interface PendingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Lee un trabajo pendiente; null si no hay, si esta danado o si el almacenamiento falla. */
export function readPendingJob(storage: PendingStorage | null, sessionId: string, kind: StudioJobKind): PendingJob | null {
  return readPendingJobV2(storage, sessionId, kind) as PendingJob | null
}

/** Como readPendingJob, para cualquier trabajo (v1 o v2). */
export function readPendingJobV2(storage: PendingStorage | null, sessionId: string, kind: StudioJobKindV2): PendingJobV2 | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(pendingJobKey(sessionId, kind))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingJobV2> | null
    if (!parsed || typeof parsed.jobId !== 'string' || !/^job_[A-Za-z0-9_-]{1,76}$/.test(parsed.jobId)) return null
    if (parsed.kind !== kind || typeof parsed.request !== 'object' || parsed.request === null) return null
    return { jobId: parsed.jobId, kind, request: parsed.request as StudioJobRequestV2, context: parsed.context ?? null, at: typeof parsed.at === 'number' ? parsed.at : 0 }
  } catch {
    return null
  }
}

export function writePendingJob(storage: PendingStorage | null, sessionId: string, job: PendingJob | PendingJobV2): void {
  try {
    storage?.setItem(pendingJobKey(sessionId, job.kind), JSON.stringify(job))
  } catch {
    // almacenamiento lleno o bloqueado: el trabajo sigue, solo no se podra retomar tras cerrar
  }
}

export function clearPendingJob(storage: PendingStorage | null, sessionId: string, kind: StudioJobKindV2): void {
  try {
    storage?.removeItem(pendingJobKey(sessionId, kind))
  } catch {
    // nada que limpiar
  }
}

/** Costo estimado de una peticion, sin lanzar nada. Revisa la peticion igual que runJob. */
export async function estimate(target: CloudTarget, sessionId: string, req: StudioJobRequest): Promise<StudioJobEstimate> {
  const problem = jobRequestProblem(req)
  if (problem) throw new StemCloudError('bad_job', 400, problem)
  return estimateJob(target, sessionId, req)
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

// ---------------------------------------------------------------------------
// Generacion: peticion desde la sesion
// ---------------------------------------------------------------------------

/** Segundos que duran `bars` compases al tempo y compas de la sesion. */
export function barsToSeconds(session: Pick<StudioSession, 'bpm' | 'beatsPerBar'>, bars: number): number {
  return (bars * session.beatsPerBar * 60) / session.bpm
}

export interface GenerateInput {
  provider: GenerateJobRequest['provider']
  prompt: string
  /** Largo pedido en compases de la sesion ("pad de 16 compases"). Gana sobre `durationS`. */
  bars?: number
  durationS?: number
  instrumental: boolean
}

/**
 * Peticion `generate` con el BPM y la tonalidad de la sesion. La duracion se acota a 5..240 s
 * (el proveedor puede devolver otra: el Hub recorta el clip al compas al agregarlo).
 */
export function generateRequestForSession(session: StudioSession, input: GenerateInput): GenerateJobRequest {
  const wanted = input.bars !== undefined ? barsToSeconds(session, input.bars) : input.durationS ?? 30
  const durationS = Number.isFinite(wanted) ? Math.min(JOB_GENERATE_SECONDS_MAX, Math.max(JOB_GENERATE_SECONDS_MIN, wanted)) : 30
  return {
    kind: 'generate',
    provider: input.provider,
    prompt: input.prompt.trim(),
    durationS: Math.round(durationS * 1000) / 1000,
    bpm: session.bpm,
    key: session.key,
    instrumental: input.instrumental,
  }
}

// ---------------------------------------------------------------------------
// Resultado: audios y sugerencias
// ---------------------------------------------------------------------------

/** Lo que el Hub sabe de un audio despues de decodificarlo. */
export interface DecodedAudioInfo {
  channels: number
  sampleRate: number
  durationS: number
}

/**
 * Entrada de `assets` (lista para sessionOps.addAsset) a partir del audio que dejo un trabajo.
 * Los datos que el Worker no conoce (null) se completan con lo que dio el decodificador.
 */
export function jobAssetToSessionAsset(asset: StudioJobAsset, decoded: DecodedAudioInfo): StudioAsset {
  const channels = asset.channels ?? (decoded.channels >= 2 ? 2 : 1)
  return {
    id: asset.id,
    file: asset.file,
    kind: asset.kind,
    label: asset.label.slice(0, STUDIO_MAX_ASSET_LABEL),
    channels,
    sampleRate: Math.round(asset.sampleRate ?? decoded.sampleRate),
    durationS: Math.min(STUDIO_MAX_SESSION_SECONDS, asset.durationS ?? decoded.durationS),
    size: asset.size,
    source: asset.source,
  }
}

/** Solo las sugerencias que apuntan a una pista que existe en la sesion (o al master). */
export function suggestionsForSession(session: StudioSession, suggestions: readonly MixSuggestion[]): MixSuggestion[] {
  return suggestions.filter((s) => s.trackId === STUDIO_MASTER_ID || findTrack(session, s.trackId) !== null)
}

function signedDb(value: number): string {
  const rounded = Math.round(value * 10) / 10
  const text = Math.abs(rounded).toFixed(1).replace('.', ',')
  return `${rounded < 0 ? '-' : rounded > 0 ? '+' : ''}${text} dB`
}

const FX_NAMES: Record<StudioFxType, string> = {
  eq: 'EQ',
  compressor: 'compresor',
  de_esser: 'de-esser',
  saturator: 'saturador',
  stereo_imager: 'imagen estéreo',
  limiter: 'limitador',
}

/** Titulo corto de una sugerencia para la lista del asistente: "Voz: fader a -3,0 dB". */
export function suggestionTitle(session: StudioSession, s: MixSuggestion): string {
  const where = s.trackId === STUDIO_MASTER_ID ? 'Master' : findTrack(session, s.trackId)?.name ?? s.trackId
  if (s.target === 'volume_db') return `${where}: fader a ${signedDb(s.value)}`
  if (s.target === 'pan') {
    const pct = Math.round(Math.abs(s.value) * 100)
    return `${where}: paneo ${pct === 0 ? 'al centro' : `${pct} % a la ${s.value < 0 ? 'izquierda' : 'derecha'}`}`
  }
  return `${where}: ajustar ${FX_NAMES[s.fxType]}`
}

// ---------------------------------------------------------------------------
// Medidas para el asistente
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? round2(value) : null
}

function roundBands(bands: BandEnergies | null): BandEnergies | null {
  if (!bands) return null
  return { lowDb: round2(bands.lowDb), lowMidDb: round2(bands.lowMidDb), highMidDb: round2(bands.highMidDb), highDb: round2(bands.highDb) }
}

/**
 * Medidas de una pista a partir de sus muestras (la pista sola, post-fader: bounce en modo
 * 'tracks'). `channels`: 1 o 2 Float32Array del mismo largo. Silencio = lufs, pico y bandas null.
 */
export function measureTrack(track: StudioTrack, channels: Float32Array[], sampleRate: number): TrackMetrics {
  const peak = truePeakDb(channels, sampleRate)
  const silent = !Number.isFinite(peak)
  return {
    trackId: track.id,
    name: track.name,
    role: track.role,
    lufs: silent ? null : finiteOrNull(integratedLufs(channels, sampleRate)),
    truePeakDb: silent ? null : finiteOrNull(peak),
    bands: silent ? null : roundBands(bandEnergiesDb(channels, sampleRate)),
    volumeDb: track.volumeDb,
    pan: track.pan,
    fx: track.fx,
  }
}

export interface MeasuredAudio {
  channels: Float32Array[]
  sampleRate: number
}

export interface MixMetricsInput {
  /** Volumen objetivo de la mezcla; se acota a -24..-6. Por defecto -14. */
  targetLufs?: number
  /** La mezcla completa (bounce.renderMix). */
  master: MeasuredAudio
  /** Cada pista sola con su audio. Las pistas sin audio no se mandan. */
  tracks: Array<{ track: StudioTrack; audio: MeasuredAudio }>
}

/** Cuerpo `metrics` del trabajo `assist` (STUDIO_V1.md 6.3). A lo sumo 16 pistas. */
export function buildMixMetrics(input: MixMetricsInput): MixMetrics {
  const wanted = input.targetLufs ?? JOB_DEFAULT_TARGET_LUFS
  const targetLufs = Number.isFinite(wanted) ? Math.min(JOB_TARGET_LUFS_MAX, Math.max(JOB_TARGET_LUFS_MIN, wanted)) : JOB_DEFAULT_TARGET_LUFS
  const masterPeak = truePeakDb(input.master.channels, input.master.sampleRate)
  const masterSilent = !Number.isFinite(masterPeak)
  return {
    targetLufs,
    master: {
      lufs: masterSilent ? null : finiteOrNull(integratedLufs(input.master.channels, input.master.sampleRate)),
      truePeakDb: masterSilent ? null : finiteOrNull(masterPeak),
    },
    tracks: input.tracks.slice(0, STUDIO_MAX_TRACKS).map(({ track, audio }) => measureTrack(track, audio.channels, audio.sampleRate)),
  }
}

// ###########################################################################
// v2: compose, analyze y chat (STUDIO_V2.md seccion 4)
// ###########################################################################

export const COMPOSE_ROLES: readonly ComposeRole[] = ['drums', 'bass', 'chords', 'melody']
export const COMPOSE_LENGTH_BARS_MIN = 1
export const COMPOSE_LENGTH_BARS_MAX = 64
export const COMPOSE_MAX_CONTEXT_TRACKS = 4
export const COMPOSE_MAX_CONTEXT_NOTES_PER_TRACK = 256
export const COMPOSE_MAX_CONTEXT_NOTES = 512
export const CHAT_MAX_MESSAGES = 40
export const CHAT_MAX_USER_TEXT = 4000
export const CHAT_MAX_MODEL_TEXT = 8000
export const CHAT_MAX_TOOL_RESULT_MESSAGE = 500
export const CHAT_SUMMARY_MAX_BYTES = 32768
/** Clips por pista en el resumen (los mas cercanos al cabezal si hay mas). */
export const CHAT_SUMMARY_MAX_CLIPS = 64
/** Vueltas seguidas con herramientas, sin mensaje del usuario, antes de mandar tool_mode 'none'. */
export const CHAT_MAX_TOOL_ROUNDS = 8
/** Fragmento para escuchar (STUDIO_V2.md 4.3.5): hasta 30 s, WAV mono de 16 kHz. */
export const CHAT_LISTEN_MAX_SECONDS = 30
export const CHAT_LISTEN_SAMPLE_RATE = 16000

const COMPOSE_CONTEXT_ROLES: readonly (ComposeRole | 'other')[] = [...COMPOSE_ROLES, 'other']

const KIND_LABELS_V2: Record<StudioJobKindV2, string> = {
  ...KIND_LABELS,
  compose: 'Componer MIDI',
  analyze: 'Analizar audio',
  chat: 'Asistente del Estudio',
}

const STARTED_TEXT_V2: Record<StudioJobKindV2, string> = {
  ...STARTED_TEXT,
  compose: 'COMPONIENDO...',
  analyze: 'ANALIZANDO EN MUSIC AI...',
  chat: 'EL ASISTENTE ESTÁ PENSANDO...',
}

const FAILED_TEXT_V2: Record<StudioJobKindV2, string> = {
  ...FAILED_TEXT,
  compose: 'LA COMPOSICIÓN FALLÓ',
  analyze: 'EL ANÁLISIS FALLÓ',
  chat: 'EL ASISTENTE FALLÓ',
}

/**
 * Trabajos que el Worker resuelve dentro del POST (STUDIO_V1.md 6 y STUDIO_V2.md 4): al volver
 * el POST ya terminaron, asi que se consultan sin esperar un intervalo (el chat no paga 3 s de
 * espera por vuelta).
 */
const SYNC_KINDS_V2: ReadonlySet<StudioJobKindV2> = new Set<StudioJobKindV2>(['generate', 'assist', 'compose', 'chat'])

export function jobKindLabelV2(kind: StudioJobKindV2): string {
  return KIND_LABELS_V2[kind]
}

/** Texto de progreso de cualquier trabajo (v1 o v2). */
export function jobStatusTextV2(state: StudioJobStateV2): string {
  if (state.status === 'STARTED') return STARTED_TEXT_V2[state.kind]
  if (state.status === 'FAILED') return FAILED_TEXT_V2[state.kind]
  if (state.status === 'IMPORTING') return state.total > 0 ? `COPIANDO AUDIOS ${state.done}/${state.total}...` : 'COPIANDO AUDIOS...'
  switch (state.kind) {
    case 'compose': {
      const n = state.notes.length
      return n === 0 ? 'LISTO: SIN NOTAS' : n === 1 ? 'LISTO: 1 NOTA' : `LISTO: ${n} NOTAS`
    }
    case 'analyze': {
      const m = state.analysis.markers.length
      const c = state.analysis.chords.length
      return `LISTO: ${m === 1 ? '1 SECCIÓN' : `${m} SECCIONES`} Y ${c === 1 ? '1 ACORDE' : `${c} ACORDES`}`
    }
    case 'chat': {
      const n = state.toolCalls.length
      return n === 0 ? 'LISTO: RESPUESTA DEL ASISTENTE' : n === 1 ? 'LISTO: 1 CAMBIO PROPUESTO' : `LISTO: ${n} CAMBIOS PROPUESTOS`
    }
    default:
      return jobStatusText(state)
  }
}

// ---------------------------------------------------------------------------
// v2 · Revision de la peticion (antes de gastar)
// ---------------------------------------------------------------------------

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

function validNote(n: StudioMidiNote): boolean {
  return (
    isInteger(n?.pitch, 0, 127) &&
    isInteger(n?.velocity, 1, 127) &&
    between(n?.start, 0, STUDIO_MAX_BEAT) &&
    between(n?.length, STUDIO_MIDI_MIN_NOTE_BEATS, STUDIO_MAX_BEAT)
  )
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

/** STUDIO_V2.md 4.1. */
export function composeRequestProblem(req: ComposeJobRequest): string | null {
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : ''
  if (prompt.length < 1) return 'Escribe qué quieres que componga.'
  if (prompt.length > STUDIO_MAX_PROMPT) return `La descripción admite hasta ${STUDIO_MAX_PROMPT} caracteres.`
  if (!between(req.bpm, STUDIO_BPM_MIN, STUDIO_BPM_MAX)) return `El tempo debe estar entre ${STUDIO_BPM_MIN} y ${STUDIO_BPM_MAX} BPM.`
  if (req.key !== null && (typeof req.key !== 'string' || req.key.length < 1 || req.key.length > STUDIO_MAX_KEY)) return 'La tonalidad no es válida.'
  if (!isInteger(req.beatsPerBar, STUDIO_BEATS_PER_BAR_MIN, STUDIO_BEATS_PER_BAR_MAX)) return 'El compás de la sesión no es válido.'
  if (!isInteger(req.lengthBars, COMPOSE_LENGTH_BARS_MIN, COMPOSE_LENGTH_BARS_MAX)) {
    return `El largo debe estar entre ${COMPOSE_LENGTH_BARS_MIN} y ${COMPOSE_LENGTH_BARS_MAX} compases.`
  }
  if (!COMPOSE_ROLES.includes(req.role)) return 'Elige qué componer: batería, bajo, acordes o melodía.'
  if (!Array.isArray(req.context) || req.context.length > COMPOSE_MAX_CONTEXT_TRACKS) return `Se pueden mandar hasta ${COMPOSE_MAX_CONTEXT_TRACKS} pistas de contexto.`
  let total = 0
  for (const t of req.context) {
    if (!COMPOSE_CONTEXT_ROLES.includes(t.role)) return 'Una pista de contexto tiene un rol no válido.'
    const name = typeof t.name === 'string' ? t.name.trim() : ''
    if (name.length < 1 || t.name.length > STUDIO_MAX_TRACK_NAME) return 'Una pista de contexto no tiene un nombre válido.'
    if (!Array.isArray(t.notes) || t.notes.length > COMPOSE_MAX_CONTEXT_NOTES_PER_TRACK) {
      return `Cada pista de contexto admite hasta ${COMPOSE_MAX_CONTEXT_NOTES_PER_TRACK} notas.`
    }
    if (!t.notes.every(validNote)) return 'Una nota de contexto no es válida.'
    total += t.notes.length
  }
  if (total > COMPOSE_MAX_CONTEXT_NOTES) return `El contexto admite hasta ${COMPOSE_MAX_CONTEXT_NOTES} notas entre todas las pistas.`
  return null
}

/** STUDIO_V2.md 4.2. */
export function analyzeRequestProblem(req: AnalyzeJobRequest): string | null {
  if (!isStudioId(req.assetId)) return 'Falta elegir el audio que se va a analizar.'
  if (!(req.durationS > 0) || !between(req.durationS, 0, STUDIO_MAX_SESSION_SECONDS)) return 'El audio debe durar entre 0 y 20 minutos.'
  return null
}

/** STUDIO_V2.md 4.3.1 y 4.3.2: forma de la conversacion y tope del resumen. */
export function chatRequestProblem(req: ChatJobRequest): string | null {
  const bad = (detail: string) => `La conversación con el asistente no es válida: ${detail}`
  const messages = req.messages
  if (!Array.isArray(messages) || messages.length < 1) return 'Escribe un mensaje para el asistente.'
  if (messages.length > CHAT_MAX_MESSAGES) return bad(`admite hasta ${CHAT_MAX_MESSAGES} mensajes.`)
  if (messages[0].role !== 'user') return bad('debe empezar con un mensaje tuyo.')
  const last = messages[messages.length - 1]
  if (last.role !== 'user' && last.role !== 'tool') return bad('el último mensaje debe ser tuyo o el resultado de los cambios.')
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user') {
      const text = typeof m.text === 'string' ? m.text : ''
      if (text.trim().length < 1) return 'Escribe un mensaje para el asistente.'
      if (text.length > CHAT_MAX_USER_TEXT) return `Cada mensaje admite hasta ${CHAT_MAX_USER_TEXT} caracteres.`
      if (m.audio !== undefined) {
        if (!isStudioId(m.audio.assetId)) return bad('un fragmento de audio no tiene un id válido.')
        if (!(m.audio.durationS > 0) || m.audio.durationS > CHAT_LISTEN_MAX_SECONDS) return `Un fragmento para escuchar dura hasta ${CHAT_LISTEN_MAX_SECONDS} s.`
      }
      continue
    }
    if (m.role === 'model') {
      if (m.text !== null && (typeof m.text !== 'string' || m.text.length < 1 || m.text.length > CHAT_MAX_MODEL_TEXT)) return bad('una respuesta del asistente es demasiado larga.')
      if (!Array.isArray(m.toolCalls) || m.toolCalls.length > STUDIO_MAX_CHAT_TOOL_CALLS) return bad('una respuesta trae demasiados cambios.')
      if (m.text === null && m.toolCalls.length === 0) return bad('hay una respuesta vacía del asistente.')
      if (m.toolCalls.some((c) => !STUDIO_TOOL_CALL_ID_RE.test(c.id))) return bad('una llamada del asistente no tiene id.')
      if (m.toolCalls.length === 0) continue
      const next = messages[i + 1]
      if (!next || next.role !== 'tool') return bad('faltan los resultados de los cambios propuestos.')
      if (next.toolResults.length !== m.toolCalls.length) return bad('cada cambio propuesto necesita un resultado.')
      for (let k = 0; k < m.toolCalls.length; k++) {
        const call = m.toolCalls[k]
        const result = next.toolResults[k]
        if (result.callId !== call.id || result.name !== call.name) return bad('los resultados no siguen el orden de los cambios propuestos.')
      }
      continue
    }
    // tool: solo inmediatamente despues de un 'model' con llamadas (comprobado arriba).
    const prev = messages[i - 1]
    if (!prev || prev.role !== 'model' || prev.toolCalls.length === 0) return bad('hay resultados de cambios sin una respuesta que los pida.')
    for (const r of m.toolResults) {
      if (r.response.status !== 'applied' && r.response.status !== 'rejected' && r.response.status !== 'failed') return bad('un resultado no tiene un estado válido.')
      if (typeof r.response.message !== 'string' || r.response.message.length > CHAT_MAX_TOOL_RESULT_MESSAGE) return bad('el mensaje de un resultado es demasiado largo.')
    }
  }
  if (req.toolMode !== undefined && req.toolMode !== 'auto' && req.toolMode !== 'none') return bad('modo de herramientas desconocido.')
  if (sessionSummaryBytes(req.sessionSummary) > CHAT_SUMMARY_MAX_BYTES) return 'La sesión es demasiado grande para resumirla al asistente.'
  return null
}

/** Revisa cualquier peticion (v1 o v2) antes de salir a la red. */
export function jobRequestProblemV2(req: StudioJobRequestV2): string | null {
  switch (req.kind) {
    case 'compose':
      return composeRequestProblem(req)
    case 'analyze':
      return analyzeRequestProblem(req)
    case 'chat':
      return chatRequestProblem(req)
    default:
      return jobRequestProblem(req)
  }
}

// ---------------------------------------------------------------------------
// v2 · Lanzar y sondear
// ---------------------------------------------------------------------------

export interface RunJobV2Options extends Omit<RunJobOptions, 'onState'> {
  onState?: (state: StudioJobStateV2) => void
}

/**
 * Como runJob, para cualquier trabajo (v1 o v2). GASTA CREDITOS. El `job_id` lo elige el Hub y
 * se entrega a `onStarted` ANTES de enviar (quien llama lo guarda con writePendingJob). Si la
 * respuesta del POST se pierde, se consulta ese id en vez de relanzar. Los trabajos que el Worker
 * resuelve dentro del POST (compose, chat, assist, generate) se consultan sin esperar.
 */
export async function runJobV2(target: CloudTarget, sessionId: string, req: StudioJobRequestV2, options: RunJobV2Options = {}): Promise<StudioJobStateV2 | null> {
  const problem = jobRequestProblemV2(req)
  if (problem) throw new StemCloudError('bad_job', 400, problem)
  if (options.signal?.aborted) return null
  const jobId = (options.newJobId ?? (() => newStudioId('job')))()
  options.onStarted?.(jobId)
  try {
    const started = await startJobV2(target, sessionId, req, jobId)
    options.onState?.(started)
  } catch (err) {
    if (!(err instanceof StemCloudError) || err.code !== 'network') throw err
    try {
      return await watchJobV2(target, sessionId, jobId, options)
    } catch (inner) {
      if (inner instanceof StemCloudError && inner.code === 'no_job') throw err
      throw inner
    }
  }
  if (options.signal?.aborted) return null
  if (!SYNC_KINDS_V2.has(req.kind)) {
    // Primera consulta despues de un intervalo: Music.AI nunca termina al instante.
    await (options.sleep ?? defaultSleep)(options.intervalMs ?? STUDIO_JOB_POLL_MS, options.signal)
  }
  return watchJobV2(target, sessionId, jobId, options)
}

/** Retoma un trabajo ya lanzado (v1 o v2) sin lanzar nada. */
export function resumeJobV2(
  target: CloudTarget,
  sessionId: string,
  jobId: string,
  options: Omit<WatchJobOptions, 'onState'> & { onState?: (state: StudioJobStateV2) => void } = {},
): Promise<StudioJobStateV2 | null> {
  return watchJobV2(target, sessionId, jobId, options)
}

/** Costo estimado de cualquier peticion, sin lanzar nada. */
export async function estimateV2(target: CloudTarget, sessionId: string, req: StudioJobRequestV2): Promise<StudioJobEstimateV2> {
  const problem = jobRequestProblemV2(req)
  if (problem) throw new StemCloudError('bad_job', 400, problem)
  return estimateJobV2(target, sessionId, req)
}

/** Trabajo lanzado (v1 o v2) que el Hub recuerda para poder retomarlo. */
export interface PendingJobV2 {
  jobId: string
  kind: StudioJobKindV2
  request: StudioJobRequestV2
  context: unknown
  at: number
}

// ---------------------------------------------------------------------------
// v2 · compose: peticion desde la sesion y clip propuesto
// ---------------------------------------------------------------------------

/** Rol de una pista como contexto de compose (STUDIO_V2.md 4.1). */
export function composeRoleForTrack(track: StudioTrack): ComposeRole | 'other' {
  if (track.instrument?.type === 'drums' || track.role === 'drums') return 'drums'
  if (track.role === 'bass') return 'bass'
  if (track.role === 'keys' || track.role === 'guitar' || track.role === 'strings') return 'chords'
  if (track.role === 'vocals' || track.role === 'backing_vocals' || track.role === 'wind') return 'melody'
  return 'other'
}

/**
 * Notas que SUENAN de un clip dentro de [fromBeat, toBeat) de la sesion, en beats de la sesion:
 * con la repeticion (`loop`) desplegada y cada nota recortada al final del clip (STUDIO_V2.md 2.4).
 */
export function soundingClipNotes(clip: StudioMidiClip, fromBeat: number, toBeat: number): StudioMidiNote[] {
  // Un clip silenciado no suena (STUDIO_V2.md 2.4).
  if (clip.muted) return []
  const clipEnd = clip.startBeat + clip.lengthBeats
  const lo = Math.max(fromBeat, clip.startBeat)
  const hi = Math.min(toBeat, clipEnd)
  if (!(hi > lo)) return []
  const out: StudioMidiNote[] = []
  const looping = clip.loop && clip.loopBeats > 0 && clip.loopBeats < clip.lengthBeats
  const span = looping ? clip.loopBeats : clip.lengthBeats
  const firstRound = Math.max(0, Math.floor((lo - clip.startBeat) / span) - 1)
  const lastRound = looping ? Math.ceil((hi - clip.startBeat) / span) : 0
  for (let round = firstRound; round <= lastRound; round++) {
    const base = clip.startBeat + round * span
    for (const n of clip.notes) {
      if (looping && n.start >= clip.loopBeats) continue
      const start = base + n.start
      if (start >= clipEnd || start >= hi) continue
      const end = Math.min(start + n.length, clipEnd)
      if (end <= lo) continue
      out.push({ pitch: n.pitch, start, length: end - start, velocity: n.velocity })
    }
  }
  return out.sort(compareNotes)
}

/**
 * Contexto de compose: las pistas de instrumento (o las de `trackIds`) con notas en el tramo
 * [startBeat, startBeat + lengthBeats), en beats relativos a startBeat. Hasta 4 pistas, 256 notas
 * por pista y 512 en total (las primeras en el tiempo).
 */
export function composeContextForSession(session: StudioSession, startBeat: number, lengthBeats: number, trackIds?: readonly string[]): ComposeContextTrack[] {
  const wanted = trackIds ? trackIds.map((id) => findTrack(session, id)).filter((t): t is StudioTrack => t !== null) : session.tracks
  const out: ComposeContextTrack[] = []
  let total = 0
  for (const track of wanted) {
    if (out.length >= COMPOSE_MAX_CONTEXT_TRACKS || total >= COMPOSE_MAX_CONTEXT_NOTES) break
    if (track.kind !== 'instrument') continue
    const end = startBeat + lengthBeats
    const sounding = track.midiClips.flatMap((clip) => soundingClipNotes(clip, startBeat, end)).sort(compareNotes)
    const notes: StudioMidiNote[] = []
    for (const n of sounding) {
      if (notes.length >= COMPOSE_MAX_CONTEXT_NOTES_PER_TRACK || total + notes.length >= COMPOSE_MAX_CONTEXT_NOTES) break
      // Una nota que empezo antes del tramo entra desde el inicio del tramo.
      const s = Math.max(n.start, startBeat)
      const length = roundBeat(Math.min(n.start + n.length, end) - s)
      if (length < STUDIO_MIDI_MIN_NOTE_BEATS) continue
      notes.push({ pitch: n.pitch, start: roundBeat(s - startBeat), length, velocity: n.velocity })
    }
    if (notes.length === 0) continue
    total += notes.length
    const name = track.name.trim().slice(0, STUDIO_MAX_TRACK_NAME) || 'Pista'
    out.push({ role: composeRoleForTrack(track), name, notes })
  }
  return out
}

export interface ComposeInput {
  prompt: string
  role: ComposeRole
  /** 1..64 compases de la sesion. */
  lengthBars: number
  /** Beat de la sesion donde ira el clip (para el contexto). */
  startBeat: number
  /** Pistas de contexto; por defecto, las de instrumento con notas en el tramo. */
  contextTrackIds?: readonly string[]
}

/** Peticion compose con el tempo, la tonalidad y el compas de la sesion. */
export function composeRequestForSession(session: StudioSession, input: ComposeInput): ComposeJobRequest {
  const lengthBars = Number.isFinite(input.lengthBars)
    ? Math.min(COMPOSE_LENGTH_BARS_MAX, Math.max(COMPOSE_LENGTH_BARS_MIN, Math.round(input.lengthBars)))
    : 4
  const lengthBeats = lengthBars * session.beatsPerBar
  const startBeat = Number.isFinite(input.startBeat) ? Math.max(0, input.startBeat) : 0
  return {
    kind: 'compose',
    prompt: input.prompt.trim(),
    bpm: session.bpm,
    key: session.key,
    beatsPerBar: session.beatsPerBar,
    lengthBars,
    role: input.role,
    context: composeContextForSession(session, startBeat, lengthBeats, input.contextTrackIds),
  }
}

type ComposeSucceeded = Extract<StudioJobStateV2, { status: 'SUCCEEDED'; kind: 'compose' }>

/**
 * Clip MIDI propuesto con el resultado de compose (listo para sessionOps.addMidiClip): sin
 * repeticion, `loopBeats` = `lengthBeats`, notas validadas otra vez (normalizeNotes).
 */
export function composeResultToClip(state: ComposeSucceeded, placement: { clipId: string; startBeat: number }): StudioMidiClip {
  const lengthBeats = roundBeat(Math.min(STUDIO_MAX_BEAT, state.lengthBeats))
  const notes = normalizeNotes(state.notes, lengthBeats).slice(0, STUDIO_MAX_NOTES_PER_CLIP)
  return defaultMidiClip({ id: placement.clipId, startBeat: roundBeat(Math.max(0, placement.startBeat)), lengthBeats, notes })
}

// ---------------------------------------------------------------------------
// v2 · analyze: peticion y propuestas (marcas, datos de la sesion)
// ---------------------------------------------------------------------------

export function analyzeRequestForAsset(asset: StudioAsset): AnalyzeJobRequest {
  return { kind: 'analyze', assetId: asset.id, durationS: Math.min(STUDIO_MAX_SESSION_SECONDS, asset.durationS) }
}

/** Donde esta, en la sesion, el audio analizado (el clip que el usuario eligio). */
export interface AnalysisPlacement {
  /** Posicion del clip en la sesion. */
  clipStartS: number
  /** Inicio de la ventana del clip dentro del audio. */
  clipOffsetS: number
  /** Largo de la ventana; lo que cae fuera no se propone. null = todo el audio. */
  clipLengthS: number | null
  bpm: number
}

export function analysisPlacementForClip(session: StudioSession, clip: StudioClip): AnalysisPlacement {
  return { clipStartS: clip.startS, clipOffsetS: clip.offsetS, clipLengthS: clip.lengthS, bpm: session.bpm }
}

/** beat = (inicio del clip + tiempo en el audio - offset del clip) * bpm / 60 (STUDIO_V2.md 4.2). */
export function analysisTimeToBeat(timeS: number, placement: AnalysisPlacement): number {
  return secondsToBeats(placement.clipStartS + timeS - placement.clipOffsetS, placement.bpm)
}

/**
 * Marcas propuestas a partir del analisis: las que caen dentro de la ventana del clip y de la
 * sesion (0..1200 s), en beats redondeados, ordenadas por beat e id, hasta 256.
 */
export function analysisToMarkers(analysis: StudioAnalysis, placement: AnalysisPlacement, newId: () => string = () => newStudioId('mk')): StudioMarker[] {
  const out: StudioMarker[] = []
  for (const m of analysis.markers) {
    if (out.length >= STUDIO_MAX_MARKERS) break
    const inClip = m.timeS - placement.clipOffsetS
    if (inClip < -STUDIO_TIME_EPSILON_S) continue
    if (placement.clipLengthS !== null && inClip > placement.clipLengthS + STUDIO_TIME_EPSILON_S) continue
    const seconds = placement.clipStartS + Math.max(0, inClip)
    if (seconds > STUDIO_MAX_SESSION_SECONDS + STUDIO_TIME_EPSILON_S) continue
    const beat = roundBeat(Math.min(STUDIO_MAX_BEAT, secondsToBeats(seconds, placement.bpm)))
    out.push({ id: newId(), beat, label: m.label.slice(0, STUDIO_MAX_MARKER_LABEL), kind: m.kind })
  }
  return out.sort((a, b) => a.beat - b.beat || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Acordes del analisis para guardar en la sesion (STUDIO_V2.md 2.9 y 4.2): los que caen dentro de
 * la ventana del clip, recortados a ella, en beats de la sesion con la posicion del clip y el bpm
 * de `placement`; hasta 2048, sin pasar de los 1200 s.
 */
export function analysisToChords(analysis: StudioAnalysis, placement: AnalysisPlacement): StudioChord[] {
  const out: StudioChord[] = []
  const windowEnd = placement.clipLengthS ?? Infinity
  for (const c of analysis.chords) {
    if (out.length >= STUDIO_MAX_SESSION_CHORDS) break
    const name = c.name.trim().slice(0, STUDIO_MAX_SESSION_CHORD_NAME)
    if (!name) continue
    const from = Math.max(0, c.startS - placement.clipOffsetS)
    const to = Math.min(windowEnd, c.endS - placement.clipOffsetS)
    if (!(to > from + STUDIO_TIME_EPSILON_S)) continue
    const startS = placement.clipStartS + from
    const endS = Math.min(STUDIO_MAX_SESSION_SECONDS, placement.clipStartS + to)
    if (!(endS > startS)) continue
    const beat = roundBeat(secondsToBeats(startS, placement.bpm))
    const lengthBeats = roundBeat(secondsToBeats(endS, placement.bpm) - beat)
    if (!(lengthBeats > 0)) continue
    out.push({ beat, lengthBeats, name })
  }
  return out
}

/**
 * Marcas del analisis ya agregadas, vueltas a ubicar en beats con un tempo nuevo. Las marcas viven
 * en beats, pero las del analisis senalan instantes del AUDIO, que no se mueve al cambiar el tempo:
 * si se aplica el tempo del analisis despues de las marcas, cada una se recalcula desde sus
 * segundos para que el coro siga cayendo donde esta. Las marcas sin entrada en el mapa no cambian.
 */
export function rebeatMarkers(markers: readonly StudioMarker[], secondsById: ReadonlyMap<string, number>, bpm: number): StudioMarker[] {
  return markers.map((m) => {
    const seconds = secondsById.get(m.id)
    return seconds === undefined ? m : { ...m, beat: roundBeat(Math.min(STUDIO_MAX_BEAT, secondsToBeats(seconds, bpm))) }
  })
}

/**
 * Datos de la sesion que el analisis propone cambiar (solo los que difieren). La interfaz ofrece
 * cada uno como un paso de deshacer aparte (sessionOps.updateSessionMeta).
 */
export function analysisSessionPatch(session: StudioSession, analysis: StudioAnalysis): SessionMetaPatch {
  const patch: SessionMetaPatch = {}
  if (analysis.bpm !== null) {
    const bpm = Math.round(Math.min(STUDIO_BPM_MAX, Math.max(STUDIO_BPM_MIN, analysis.bpm)) * 100) / 100
    if (bpm !== session.bpm) patch.bpm = bpm
  }
  if (analysis.key !== null && analysis.key !== session.key) patch.key = analysis.key
  if (analysis.beatsPerBar !== session.beatsPerBar) patch.beatsPerBar = analysis.beatsPerBar
  return patch
}

// ---------------------------------------------------------------------------
// v2 · chat: resumen de la sesion y conversacion
// ---------------------------------------------------------------------------

/** Lo que la vista sabe y el documento no: cabezal y seleccion. */
export interface ChatView {
  playheadBeat: number
  selection: { trackId: string | null; clipIds: readonly string[]; context: CommandContext }
  /** Loop activo del transporte, en beats (opcional). */
  loop?: { startBeat: number; endBeat: number } | null
}

/** Loop valido para el resumen (inicio antes del fin, beats >= 0), o null. */
function summaryLoop(loop: ChatView['loop']): { startBeat: number; endBeat: number } | null {
  if (!loop || !Number.isFinite(loop.startBeat) || !Number.isFinite(loop.endBeat)) return null
  const startBeat = Math.max(0, loop.startBeat)
  return loop.endBeat > startBeat ? { startBeat, endBeat: loop.endBeat } : null
}

function distanceTo(point: number, start: number, end: number): number {
  return point < start ? start - point : point > end ? point - end : 0
}

/** Los `max` elementos mas cercanos al cabezal, devueltos en su orden original. */
function nearest<T>(items: readonly T[], max: number, distance: (item: T) => number): T[] {
  if (items.length <= max) return [...items]
  const ranked = items.map((item, index) => ({ item, index, d: distance(item) })).sort((a, b) => a.d - b.d || a.index - b.index)
  return ranked
    .slice(0, max)
    .sort((a, b) => a.index - b.index)
    .map((r) => r.item)
}

function trackSummary(
  track: StudioTrack,
  playheadBeat: number,
  session: Pick<StudioSession, 'bpm' | 'beatsPerBar'>,
  maxClips: number,
  literalNotes: number,
  mix: MixForSummary | null,
): StudioTrackSummary {
  const playheadS = beatsToSeconds(playheadBeat, session.bpm)
  const drums = isDrumTrack(track)
  const instrument = track.instrument
    ? {
        type: track.instrument.type,
        preset: track.instrument.type === 'synth' || track.instrument.type === 'drums' ? track.instrument.preset : null,
        pluginId: track.instrument.type === 'wam' ? track.instrument.pluginId : null,
      }
    : null
  const clips = nearest(track.clips, maxClips, (c) => distanceTo(playheadS, c.startS, c.startS + c.lengthS)).map((c) => ({
    id: c.id,
    startS: c.startS,
    lengthS: c.lengthS,
    active: c.active,
  }))
  const midiClips = nearest(track.midiClips, maxClips, (c) => distanceTo(playheadBeat, c.startBeat, c.startBeat + c.lengthBeats)).map((c) => {
    let pitchMin: number | null = null
    let pitchMax: number | null = null
    for (const n of c.notes) {
      if (pitchMin === null || n.pitch < pitchMin) pitchMin = n.pitch
      if (pitchMax === null || n.pitch > pitchMax) pitchMax = n.pitch
    }
    return {
      id: c.id,
      startBeat: c.startBeat,
      lengthBeats: c.lengthBeats,
      loop: c.loop,
      noteCount: c.notes.length,
      pitchMin,
      pitchMax,
      digest: midiClipDigest(c, session.beatsPerBar, drums, literalNotes),
      // Silenciado (tecla 0): el asistente lo ve en la lista pero sabe que no suena.
      ...midiClipMutedFlag(c),
    }
  })
  const measured = mix?.byTrack.get(track.id)
  return {
    ...(measured ? { mix: measured } : {}),
    id: track.id,
    kind: track.kind,
    name: track.name,
    role: track.role,
    volumeDb: track.volumeDb,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    reverbSendDb: track.reverbSendDb,
    fx: track.fx,
    instrument,
    clips,
    midiClips,
  }
}

/** Cuanto lleva el resumen; fitSessionSummary lo baja paso a paso para caber en 32 KB. */
export interface SummaryOptions {
  /** Notas literales por clip MIDI (0 = ninguna). Por defecto 64. */
  literalNotes?: number
  /** Acordes de la sesion (0 = ninguno). Por defecto 256. */
  maxChords?: number
  /** false = sin la progresion de la cancion. */
  songChart?: boolean
  /** Cancion del repertorio y medicion de mezcla (no estan en el documento). */
  extras?: ChatSummaryExtras
}

/**
 * Resumen de la sesion para el asistente (STUDIO_V2.md 4.3.2): estructura, notas MIDI resumidas
 * (digest), acordes guardados, progresion de la cancion (sin letra) y medicion de mezcla. Nunca
 * audio ni letras.
 */
export function buildSessionSummary(session: StudioSession, view: ChatView, maxClipsPerTrack = CHAT_SUMMARY_MAX_CLIPS, options: SummaryOptions = {}): StudioSessionSummary {
  const playheadBeat = Number.isFinite(view.playheadBeat) ? Math.max(0, view.playheadBeat) : 0
  const max = Math.max(0, Math.min(CHAT_SUMMARY_MAX_CLIPS, Math.floor(maxClipsPerTrack)))
  const literalNotes = Math.max(0, Math.floor(options.literalNotes ?? CHAT_SUMMARY_LITERAL_NOTES))
  const mix = options.extras?.mix ? mixForSummary(options.extras.mix.measurement, options.extras.mix.version) : null
  const chords = sessionChordsForSummary(session.chords, playheadBeat, Math.max(0, Math.min(CHAT_SUMMARY_MAX_CHORDS, options.maxChords ?? CHAT_SUMMARY_MAX_CHORDS)))
  const songChart = options.songChart === false ? null : songChordChart(options.extras?.song)
  return {
    title: session.title,
    bpm: session.bpm,
    beatsPerBar: session.beatsPerBar,
    key: session.key,
    lengthS: sessionEndSeconds(session),
    playheadBeat,
    selection: {
      trackId: view.selection.trackId,
      clipIds: view.selection.clipIds.slice(0, CHAT_SUMMARY_MAX_CLIPS),
      context: view.selection.context,
    },
    loop: summaryLoop(view.loop),
    tracks: session.tracks.slice(0, STUDIO_MAX_TRACKS).map((t) => trackSummary(t, playheadBeat, session, max, literalNotes, mix)),
    markers: (session.markers ?? []).slice(0, STUDIO_MAX_MARKERS),
    ...(chords.length > 0 ? { chords } : {}),
    ...(songChart ? { songChart } : {}),
    ...(mix ? { mixMeasured: mix.mixMeasured } : {}),
    master: { volumeDb: session.master.volumeDb, fx: session.master.fx, reverb: session.master.reverb },
  }
}

export function sessionSummaryBytes(summary: StudioSessionSummary): number {
  return utf8Length(JSON.stringify(sessionSummaryToWire(summary)))
}

/**
 * Resumen que cabe en 32 KB (STUDIO_V2.md 4.3.2). Degrada en este orden y se detiene en cuanto
 * cabe: (1) sin notas literales; (2) clips por pista 32, 16, 8, 4 y 0 (quedan los cercanos al
 * cabezal); (3) acordes de la sesion 64 y despues ninguno; (4) sin la progresion de la cancion.
 * Si ni asi cabe, devuelve el ultimo (chatRequestProblem lo informa).
 */
export function fitSessionSummary(session: StudioSession, view: ChatView, extras: ChatSummaryExtras = {}): StudioSessionSummary {
  const steps: Array<[number, SummaryOptions]> = [
    [CHAT_SUMMARY_MAX_CLIPS, { extras }],
    [CHAT_SUMMARY_MAX_CLIPS, { extras, literalNotes: 0 }],
    ...[32, 16, 8, 4, 0].map((clips): [number, SummaryOptions] => [clips, { extras, literalNotes: 0 }]),
    [0, { extras, literalNotes: 0, maxChords: 64 }],
    [0, { extras, literalNotes: 0, maxChords: 0 }],
    [0, { extras, literalNotes: 0, maxChords: 0, songChart: false }],
  ]
  let summary = buildSessionSummary(session, view, steps[0][0], steps[0][1])
  for (const [clips, options] of steps.slice(1)) {
    if (sessionSummaryBytes(summary) <= CHAT_SUMMARY_MAX_BYTES) return summary
    summary = buildSessionSummary(session, view, clips, options)
  }
  return summary
}

/**
 * 'none' despues de 8 vueltas seguidas con herramientas sin un mensaje del usuario (STUDIO_V2.md
 * 4.3.4): el modelo solo puede responder texto y el bucle se cierra.
 */
export function chatToolMode(messages: readonly StudioChatMessage[]): 'auto' | 'none' {
  let rounds = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') break
    if (m.role === 'model' && m.toolCalls.length > 0) rounds++
  }
  return rounds >= CHAT_MAX_TOOL_ROUNDS ? 'none' : 'auto'
}

/** Agrega el mensaje del usuario; `audio` es el fragmento ya subido que el asistente escuchara. */
export function appendUserMessage(messages: readonly StudioChatMessage[], text: string, audio?: StudioChatListen | null): StudioChatMessage[] {
  const body = text.trim().slice(0, CHAT_MAX_USER_TEXT)
  return [...messages, audio ? { role: 'user', text: body, audio: { ...audio } } : { role: 'user', text: body }]
}

type ChatSucceeded = Extract<StudioJobStateV2, { status: 'SUCCEEDED'; kind: 'chat' }>

/**
 * Agrega la respuesta del asistente tal como llego (las llamadas, con su `signature`, intactas).
 * Solo el texto se corta en 8000 caracteres para que la conversacion siga siendo valida.
 */
export function appendModelReply(messages: readonly StudioChatMessage[], state: ChatSucceeded): StudioChatMessage[] {
  const text = state.reply === null ? null : state.reply.slice(0, CHAT_MAX_MODEL_TEXT)
  return [...messages, { role: 'model', text, toolCalls: state.toolCalls }]
}

export function appendToolResults(messages: readonly StudioChatMessage[], results: readonly StudioChatToolResult[]): StudioChatMessage[] {
  return [...messages, { role: 'tool', toolResults: [...results] }]
}

/**
 * Recorta la conversacion por el principio para que quepa: a lo sumo 40 mensajes y, si se da
 * `fits`, lo que esa funcion acepte. Solo corta en el inicio de un mensaje del usuario, asi la
 * conversacion sigue empezando por 'user' y ningun par llamada-resultado queda partido. Si ni el
 * ultimo turno del usuario cabe, devuelve ese ultimo turno.
 */
export function trimChatMessages(messages: readonly StudioChatMessage[], fits?: (candidate: readonly StudioChatMessage[]) => boolean): StudioChatMessage[] {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') starts.push(i)
  if (starts.length === 0) return [...messages]
  for (const start of starts) {
    const candidate = messages.slice(start)
    if (candidate.length <= CHAT_MAX_MESSAGES && (!fits || fits(candidate))) return candidate
  }
  return messages.slice(starts[starts.length - 1])
}

/**
 * Peticion chat lista para runJobV2: la conversacion recortada a 40 mensajes y a 192 KB de
 * cuerpo, el resumen de la sesion y el tool_mode que toca.
 */
export function chatRequestForSession(messages: readonly StudioChatMessage[], summary: StudioSessionSummary): ChatJobRequest {
  const toolMode = chatToolMode(messages)
  const fits = (candidate: readonly StudioChatMessage[]) =>
    jobRequestV2Bytes({ kind: 'chat', messages: [...candidate], sessionSummary: summary, toolMode }) <= STUDIO_CHAT_BODY_MAX_BYTES
  return { kind: 'chat', messages: trimChatMessages(messages, fits), sessionSummary: summary, toolMode }
}
