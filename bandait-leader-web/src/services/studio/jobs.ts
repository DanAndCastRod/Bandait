/**
 * Trabajos de IA del Estudio Bandait (STUDIO_V1.md seccion 6): revisar la peticion antes de
 * gastar, lanzar y sondear (mismo patron que stemAnalysis.ts: intervalo, tiempo limite y
 * reintentos viven en studioCloud.watchJob), textos de estado en espanol, y las medidas por pista
 * que recibe el asistente de mezcla (solo numeros: nunca se manda audio).
 *
 * Modulo sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts). Quien llama
 * le pasa las muestras ya renderizadas (bounce.renderMix o los buffers del motor).
 */
import { StemCloudError, type CloudTarget } from '../stemCloud.ts'
import { bandEnergiesDb, integratedLufs, truePeakDb, LOUDNESS_DEFAULT_TARGET_LUFS } from './loudness.ts'
import {
  STUDIO_BPM_MAX,
  STUDIO_BPM_MIN,
  STUDIO_MASTER_ID,
  STUDIO_MAX_ASSET_LABEL,
  STUDIO_MAX_KEY,
  STUDIO_MAX_PROMPT,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACKS,
  findTrack,
  isStudioId,
  newStudioId,
  type StudioAsset,
  type StudioFxType,
  type StudioSession,
  type StudioTrack,
} from './session.ts'
import { STUDIO_JOB_MAX_RETRIES, STUDIO_JOB_POLL_MS, STUDIO_JOB_TIMEOUT_MS, estimateJob, startJob, studioCloudErrorMessage, watchJob } from './studioCloud.ts'
import type {
  BandEnergies,
  GenerateJobRequest,
  MixMetrics,
  MixSuggestion,
  StudioJobAsset,
  StudioJobEstimate,
  StudioJobKind,
  StudioJobRequest,
  StudioJobState,
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

/** Linea de costo para el panel de trabajos, antes de confirmar. */
export function estimateText(estimate: StudioJobEstimate): string {
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

export function pendingJobKey(sessionId: string, kind: StudioJobKind): string {
  return `bandait_studio_job:${sessionId}:${kind}`
}

interface PendingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Lee un trabajo pendiente; null si no hay, si esta danado o si el almacenamiento falla. */
export function readPendingJob(storage: PendingStorage | null, sessionId: string, kind: StudioJobKind): PendingJob | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(pendingJobKey(sessionId, kind))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingJob> | null
    if (!parsed || typeof parsed.jobId !== 'string' || !/^job_[A-Za-z0-9_-]{1,76}$/.test(parsed.jobId)) return null
    if (parsed.kind !== kind || typeof parsed.request !== 'object' || parsed.request === null) return null
    return { jobId: parsed.jobId, kind, request: parsed.request as StudioJobRequest, context: parsed.context ?? null, at: typeof parsed.at === 'number' ? parsed.at : 0 }
  } catch {
    return null
  }
}

export function writePendingJob(storage: PendingStorage | null, sessionId: string, job: PendingJob): void {
  try {
    storage?.setItem(pendingJobKey(sessionId, job.kind), JSON.stringify(job))
  } catch {
    // almacenamiento lleno o bloqueado: el trabajo sigue, solo no se podra retomar tras cerrar
  }
}

export function clearPendingJob(storage: PendingStorage | null, sessionId: string, kind: StudioJobKind): void {
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
