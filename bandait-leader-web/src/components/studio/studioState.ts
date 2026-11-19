/**
 * Estado del Estudio Bandait para la interfaz. `StudioController` es una clase sin React que une
 * el motor (engine.ts), el grabador (recorder.ts), el historial (history.ts), el almacen local
 * (studioStore.ts) y la nube (studioCloud.ts). Los componentes leen una foto inmutable con
 * `useStudio(controller)` y llaman metodos del controlador.
 *
 * Reglas:
 *   - La foto (`StudioSnapshot`) solo cambia con hechos discretos: una edicion, reproducir,
 *     detener, cargar, guardar. El cabezal, los medidores y los niveles NO pasan por aqui: se leen
 *     del motor desde `onFrame` (un solo requestAnimationFrame para todo el Estudio).
 *   - Toda edicion pasa por `apply` (un paso de deshacer) o por `applyLive` + `commitLive`
 *     (arrastres de fader: muchos cambios, un solo paso).
 *   - Los audios son inmutables: editar solo cambia el documento.
 *
 * PARTE 2 (StudioMixer, StudioInspector, StudioJobsPanel): reciben `StudioPanelProps` y usan
 * `controller.snapshot()`, `controller.apply`, `controller.applyLive`, `controller.commitLive`,
 * `controller.engine` (medidores, bounce con `engine.getBuffers()`), `controller.cloud` (destino
 * de la nube) e `controller.ingestAudio` + `controller.addAssetAsTrack` (audios de un trabajo).
 */
import { useSyncExternalStore } from 'react'
import { StemCloudError, type CloudTarget } from '../../services/stemCloud'
import { recognizeStem, stemBaseName, stemExtension, type StemRole } from '../../services/stemNames'
import { loadStemSong } from '../../services/stemStore'
import type { SectionSpan } from '../../services/stemTiming'
import { encodeWav24, parseWavHeader } from '../../services/wav'
import { StudioEngine } from '../../services/studio/engine'
import { createHistory, STUDIO_HISTORY_LIMIT } from '../../services/studio/history'
import { jobAssetToSessionAsset } from '../../services/studio/jobs'
import { clearCalibration } from '../../services/studio/latency'
import { computePeaks, PEAKS_BASE_BUCKET } from '../../services/studio/peaks'
import { StudioRecorder } from '../../services/studio/recorder'
import { cloudHasOtherVersion, referencedAssetFiles, takeClipWindows, type ClipWindow } from '../../services/studio/timelineMath'
import {
  assetFileName,
  defaultTrack,
  findClip,
  findTrack,
  newSession,
  newStudioId,
  STUDIO_ASSET_EXTENSIONS,
  STUDIO_MASTER_ID,
  STUDIO_MAX_ASSET_BYTES,
  STUDIO_MAX_ASSET_LABEL,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACK_NAME,
  STUDIO_MAX_TRACKS,
  STUDIO_MIN_CLIP_SECONDS,
  STUDIO_SAMPLE_RATES,
  type StudioAsset,
  type StudioAssetExtension,
  type StudioAssetKind,
  type StudioClip,
  type StudioFx,
  type StudioFxType,
  type StudioSession,
} from '../../services/studio/session'
import {
  addAsset,
  addClip,
  addTrack,
  deleteClip,
  duplicateClip,
  removeTrack,
  removeUnusedAssets,
  setActiveTake,
  setTrackFx,
  snapTime,
  splitClip,
  updateSessionMeta,
  updateTrack,
} from '../../services/studio/sessionOps'
import * as studioCloud from '../../services/studio/studioCloud'
import * as studioStore from '../../services/studio/studioStore'
import type {
  AssetPeaks,
  ClickSettings,
  CloudSessionSummary,
  EngineLoadProgress,
  EngineState,
  LoopRegionS,
  OrphanTake,
  RecorderArm,
  RecorderSettingsReport,
  RecorderStatus,
  RecordingStart,
  ResolveAudio,
  SessionMetaPatch,
  SnapMode,
  StoredSessionMeta,
  StudioHistory,
  StudioInputDevice,
  StudioJobAsset,
  TrackPatch,
} from '../../services/studio/types'

// ---------------------------------------------------------------------------
// Tipos de la foto
// ---------------------------------------------------------------------------

export type ArmChannel = RecorderArm['channel']

export interface StudioNotice {
  tone: 'error' | 'warn' | 'info'
  text: string
}

export interface StudioSaveState {
  /** Guardado en este equipo. */
  local: 'saved' | 'pending' | 'error'
  /** Hay cambios que no se han subido a la nube. */
  dirty: boolean
  etag: string | null
  cloud: 'idle' | 'saving' | 'conflict' | 'error'
  cloudDetail: string | null
  /** Audios subidos de los que hay que subir, mientras se guarda en la nube. */
  uploading: EngineLoadProgress | null
}

export interface StudioDeviceState {
  status: RecorderStatus
  inputs: StudioInputDevice[]
  deviceId: string | null
  report: RecorderSettingsReport | null
  monitor: boolean
  busy: 'listing' | 'opening' | 'calibrating' | null
}

/** Efecto elegido para editar en el inspector: una pista (o 'master') y un tipo de efecto. */
export interface StudioFxSelection {
  /** Id de la pista, o STUDIO_MASTER_ID. */
  targetId: string
  type: StudioFxType
}

export interface StudioSnapshot {
  session: StudioSession
  engine: EngineState
  /** null mientras carga audios: { done, total }. */
  loading: EngineLoadProgress | null
  ready: boolean
  selectedClipId: string | null
  /** PARTE 2: efecto que muestra el inspector, o null si no se eligio ninguno. */
  selectedFx: StudioFxSelection | null
  snap: SnapMode
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  /** Sube cada vez que llegan picos nuevos: la linea de tiempo se repinta. */
  peaksVersion: number
  /** Pista -> canal de la interfaz que graba en ella. */
  arms: Readonly<Record<string, ArmChannel>>
  device: StudioDeviceState
  /** Hay una toma en curso (incluye el cierre de archivos). */
  recording: boolean
  save: StudioSaveState
  notice: StudioNotice | null
  /** Motivo por el que este navegador no puede grabar, o null si puede. */
  recordBlockReason: string | null
  cloudAvailable: boolean
  canEditCloud: boolean
  sections: readonly SectionSpan[]
  orphanTakes: readonly OrphanTake[]
}

/** Lo que recibe cada panel del Estudio (los de la parte 2 incluidos). */
export interface StudioPanelProps {
  controller: StudioController
}

export interface StudioControllerOptions {
  session: StudioSession
  /** uuid de la banda compartida o 'me'. */
  band: string
  etag: string | null
  dirty: boolean
  cloud: CloudTarget | null
  canEditCloud: boolean
  sections: readonly SectionSpan[]
}

// ---------------------------------------------------------------------------
// Logica pura (sin DOM): se puede probar con node
// ---------------------------------------------------------------------------

// Ventanas de toma, compas y tiempo, y geometria de pistas viven en un modulo sin React para
// probarse con node (scripts/verify-studio-logic.ts); aqui se reexportan para la interfaz.
export {
  MAX_TAKE_LAPS,
  MIN_TAKE_LAP_S,
  RULER_H,
  TAKE_LANE_H,
  TRACK_ROW_H,
  barBeatAt,
  cloudHasOtherVersion,
  layoutTracks,
  maxTakeSeconds,
  referencedAssetFiles,
  takeClipWindows,
  type ClipWindow,
  type TakeWindowInput,
  type TrackRowLayout,
} from '../../services/studio/timelineMath'

/** "m:ss.mmm" */
export function formatTimecode(positionS: number): string {
  const ms = Math.max(0, Math.round((Number.isFinite(positionS) ? positionS : 0) * 1000))
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}

export function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= -60) return '-inf'
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

export function formatPan(pan: number): string {
  const p = Math.round(pan * 100)
  if (p === 0) return 'C'
  return p < 0 ? `I${-p}` : `D${p}`
}

const TRACK_COLORS: readonly string[] = ['#5CC8C2', '#7AA5D6', '#B8CF7A', '#D9A24E', '#B48EDB', '#7AC4D6', '#D98E73', '#9AA6E0']

/** Color de una pista segun su posicion (cabecera y clips usan el mismo). */
export function trackColor(index: number): string {
  return TRACK_COLORS[((index % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length]
}

/** Nombre de un archivo sin carpeta ni extension: "tomas/Voz 1.wav" -> "Voz 1". */
export function fileTitle(path: string): string {
  const base = stemBaseName(path)
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).trim() || 'Audio'
}

const FX_ORDER: readonly StudioFxType[] = ['eq', 'compressor', 'limiter']

/** Cadena de efectos de una pista o del master ('master'). Pista inexistente: cadena vacia. */
export function fxChainOf(session: StudioSession, targetId: string): readonly StudioFx[] {
  if (targetId === STUDIO_MASTER_ID) return session.master.fx
  return findTrack(session, targetId)?.fx ?? []
}

/**
 * Sesion con `fx` puesto en la cadena de `targetId`: reemplaza al del mismo tipo o, si no estaba,
 * lo inserta en el orden EQ, compresor, limitador (el limitador siempre queda de ultimo).
 */
export function withFx(session: StudioSession, targetId: string, fx: StudioFx): StudioSession {
  const chain = fxChainOf(session, targetId)
  const next = chain.slice()
  const at = chain.findIndex((item) => item.type === fx.type)
  if (at >= 0) next[at] = fx
  else {
    const rank = FX_ORDER.indexOf(fx.type)
    const before = chain.findIndex((item) => FX_ORDER.indexOf(item.type) > rank)
    next.splice(before >= 0 ? before : chain.length, 0, fx)
  }
  return setTrackFx(session, { trackId: targetId, fx: next })
}

/** Sesion sin el efecto de ese tipo en la cadena de `targetId`. */
export function withoutFx(session: StudioSession, targetId: string, type: StudioFxType): StudioSession {
  const chain = fxChainOf(session, targetId)
  if (!chain.some((item) => item.type === type)) return session
  return setTrackFx(session, { trackId: targetId, fx: chain.filter((item) => item.type !== type) })
}

/** Mensaje para el usuario de cualquier error del Estudio. */
export function errorText(err: unknown, fallback = 'Algo falló en el Estudio.'): string {
  if (err instanceof Error && err.message) return err.message
  return fallback
}

// ---------------------------------------------------------------------------
// Lista de sesiones (este equipo + nube)
// ---------------------------------------------------------------------------

export interface SessionEntry {
  id: string
  title: string
  songId: string | null
  updatedAt: string
  local: StoredSessionMeta | null
  cloud: CloudSessionSummary | null
}

export interface SessionListResult {
  entries: SessionEntry[]
  /** Mensaje si la nube no respondio; la lista local sale igual. */
  cloudError: string | null
}

export async function listSessionEntries(band: string, cloud: CloudTarget | null): Promise<SessionListResult> {
  const local = await studioStore.listSessions(band)
  let remote: CloudSessionSummary[] = []
  let cloudError: string | null = null
  if (cloud) {
    try {
      remote = await studioCloud.listSessions(cloud)
    } catch (err) {
      cloudError = errorText(err, 'No se pudo consultar la nube del Estudio.')
    }
  }
  const byId = new Map<string, SessionEntry>()
  for (const meta of local) {
    byId.set(meta.id, { id: meta.id, title: meta.title, songId: meta.songId, updatedAt: meta.updatedAt, local: meta, cloud: null })
  }
  for (const summary of remote) {
    const entry = byId.get(summary.id)
    if (entry) entry.cloud = summary
    else byId.set(summary.id, { id: summary.id, title: summary.title, songId: summary.songId, updatedAt: summary.updatedAt, local: null, cloud: summary })
  }
  const entries = [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return { entries, cloudError }
}

export interface OpenedSession {
  session: StudioSession
  etag: string | null
  dirty: boolean
}

/**
 * Sesion lista para abrir. Si esta en este equipo se usa esa copia, salvo que no tenga cambios
 * propios y la nube tenga otra version: entonces gana la nube. Si solo esta en la nube se baja
 * (el documento; los audios se bajan al cargarla).
 */
export async function openSessionEntry(entry: SessionEntry, band: string, cloud: CloudTarget | null): Promise<OpenedSession> {
  const stored = entry.local ? await studioStore.loadSession(entry.id) : null
  const cloudIsOther = entry.cloud !== null && (!stored || (!stored.meta.dirty && cloudHasOtherVersion(entry.cloud.updatedAt, stored.meta)))
  if (cloud && cloudIsOther) {
    try {
      const remote = await studioCloud.getSession(cloud, entry.id)
      if (remote) {
        await studioStore.saveSession(remote.session, { band, etag: remote.etag, dirty: false, cloudUpdatedAt: remote.session.updatedAt })
        return { session: remote.session, etag: remote.etag, dirty: false }
      }
    } catch (err) {
      if (!stored) throw err
      // Sin nube se abre la copia de este equipo.
    }
  }
  if (!stored) throw new Error('Esta sesión no está en este equipo y no se pudo bajar de la nube.')
  return { session: stored.session, etag: stored.meta.etag, dirty: stored.meta.dirty }
}

/** Frecuencia del AudioContext de este equipo si el contrato la admite; si no, 48000. */
export function preferredSampleRate(): number {
  try {
    const scope = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext
    if (!Ctor) return 48000
    const ctx = new Ctor()
    const rate = ctx.sampleRate
    void ctx.close().catch(() => undefined)
    return STUDIO_SAMPLE_RATES.includes(rate) ? rate : 48000
  } catch {
    return 48000
  }
}

export interface CreateSessionInput {
  title: string
  band: string
  song: { id: string; bpm: number; beatsPerBar: number; key: string } | null
  updatedBy: string | null
}

export async function createSession(input: CreateSessionInput): Promise<OpenedSession> {
  const key = input.song?.key.trim().slice(0, 12) || null
  const session = newSession({
    title: input.title,
    sampleRate: preferredSampleRate(),
    bpm: input.song ? Math.min(260, Math.max(40, input.song.bpm)) : undefined,
    beatsPerBar: input.song ? Math.min(12, Math.max(1, Math.round(input.song.beatsPerBar))) : undefined,
    key,
    songId: input.song?.id ?? null,
    updatedBy: input.updatedBy,
  })
  const stored = await studioStore.saveSession(session, { band: input.band, etag: null, dirty: true })
  return { session: stored.session, etag: null, dirty: true }
}

/** Cambia el titulo de una sesion que no esta abierta (la baja antes si solo esta en la nube). */
export async function renameSessionEntry(entry: SessionEntry, title: string, band: string, cloud: CloudTarget | null): Promise<void> {
  const opened = await openSessionEntry(entry, band, cloud)
  const next = updateSessionMeta(opened.session, { patch: { title } })
  if (next === opened.session) return
  await studioStore.saveSession(next, { band, etag: opened.etag, dirty: true })
}

// ---------------------------------------------------------------------------
// Soporte de grabacion
// ---------------------------------------------------------------------------

/** Motivo por el que este navegador no puede grabar (sin contar el ancho de pantalla), o null. */
export async function recordingBlockReason(): Promise<string | null> {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'Este entorno no tiene audio.'
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean; brands?: { brand: string }[] } }
  const ua = nav.userAgent
  const mobile = nav.userAgentData?.mobile === true || /Android|iPhone|iPad|Mobile/i.test(ua)
  const chromium = nav.userAgentData?.brands?.some((b) => b.brand === 'Chromium') === true || /Chrome\/|Edg\//.test(ua)
  if (mobile || !chromium) return 'La grabación solo funciona en Chrome o Edge de escritorio.'
  if (!nav.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') return 'Este navegador no ofrece las funciones de audio que la grabación necesita.'
  if ((await studioStore.storageBackend()) !== 'opfs') return 'Este navegador no tiene el almacenamiento de archivos (OPFS) que la grabación necesita.'
  return null
}

// ---------------------------------------------------------------------------
// Controlador
// ---------------------------------------------------------------------------

const SAVE_DEBOUNCE_MS = 700
const END_CHECK_MS = 250
const UPLOADED_PREFIX = 'bandait_studio_uploaded:'
const INPUT_KEY = 'bandait_studio_input'

const KEPT_EXTENSIONS: readonly string[] = STUDIO_ASSET_EXTENSIONS

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** Almacen de calibraciones que nunca lanza (navegacion privada). */
const calibrationStorage = {
  getItem(key: string): string | null {
    try {
      return safeLocalStorage()?.getItem(key) ?? null
    } catch {
      return null
    }
  },
  setItem(key: string, value: string): void {
    try {
      safeLocalStorage()?.setItem(key, value)
    } catch {
      // Sin almacenamiento la calibracion vale solo para esta visita.
    }
  },
  removeItem(key: string): void {
    try {
      safeLocalStorage()?.removeItem(key)
    } catch {
      // Igual que arriba.
    }
  },
}

export interface IngestedAudio {
  asset: StudioAsset
}

export interface AddAssetAsTrackOptions {
  name: string
  role?: StemRole
  /** Posicion del clip en la sesion. Por defecto 0. */
  startS?: number
  /** Ventana dentro del audio. Por defecto 0. */
  offsetS?: number
}

export class StudioController {
  readonly engine = new StudioEngine()
  readonly band: string
  readonly cloud: CloudTarget | null
  readonly sessionId: string

  private snap: StudioSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly history: StudioHistory<StudioSession> = createHistory<StudioSession>(STUDIO_HISTORY_LIMIT)
  private recorder: StudioRecorder | null = null
  private recorderOff: (() => void) | null = null
  private readonly peaks = new Map<string, AssetPeaks>()
  private readonly peaksPending = new Set<string>()
  /** Audios recien importados, ya decodificados, hasta que el motor los pide. */
  private readonly decoded = new Map<string, AudioBuffer>()
  private readonly frameCallbacks = new Set<() => void>()
  private frameHandle = 0
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()
  private endTimer: ReturnType<typeof setInterval> | null = null
  private engineOff: (() => void) | null = null
  /** Sube con cada edicion: detecta cambios hechos mientras se guardaba en la nube. */
  private editCount = 0
  private recStart: RecordingStart | null = null
  private recLoop: LoopRegionS | null = null
  /** Se pidio detener la toma mientras el grabador todavia arrancaba. */
  private recCancel = false
  private disposed = false

  constructor(options: StudioControllerOptions) {
    this.band = options.band
    this.cloud = options.cloud
    this.sessionId = options.session.id
    this.history.push(options.session)
    this.snap = {
      session: options.session,
      engine: this.engine.getState(),
      loading: { done: 0, total: 0 },
      ready: false,
      selectedClipId: null,
      selectedFx: null,
      snap: 'bar',
      canUndo: false,
      canRedo: false,
      undoLabel: null,
      redoLabel: null,
      peaksVersion: 0,
      arms: {},
      device: { status: 'closed', inputs: [], deviceId: null, report: null, monitor: false, busy: null },
      recording: false,
      save: { local: 'saved', dirty: options.dirty, etag: options.etag, cloud: 'idle', cloudDetail: null, uploading: null },
      notice: null,
      recordBlockReason: null,
      cloudAvailable: options.cloud !== null,
      canEditCloud: options.canEditCloud,
      sections: options.sections,
      orphanTakes: [],
    }
  }

  // ---- foto ----

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot = (): StudioSnapshot => this.snap

  private emit(patch: Partial<StudioSnapshot>): void {
    if (this.disposed) return
    this.snap = { ...this.snap, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  private historyPatch(): Pick<StudioSnapshot, 'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'> {
    return { canUndo: this.history.canUndo(), canRedo: this.history.canRedo(), undoLabel: this.history.undoLabel(), redoLabel: this.history.redoLabel() }
  }

  notify(tone: StudioNotice['tone'], text: string): void {
    this.emit({ notice: { tone, text } })
  }

  dismissNotice(): void {
    if (this.snap.notice) this.emit({ notice: null })
  }

  private fail(err: unknown, fallback?: string): void {
    // Un play() cancelado por pause/stop no es un error para el usuario.
    if (err instanceof DOMException && err.name === 'AbortError') return
    this.notify('error', errorText(err, fallback))
  }

  // ---- ciclo de vida ----

  /** Carga los audios y deja el motor listo. Se llama una vez, despues de construir. */
  async start(): Promise<void> {
    this.engineOff = this.engine.onStateChange((state) => this.emit({ engine: state }))
    this.endTimer = setInterval(() => this.checkEnd(), END_CHECK_MS)
    void recordingBlockReason().then((reason) => this.emit({ recordBlockReason: reason }))
    try {
      await this.engine.load(this.snap.session, this.resolveAudio, (progress) => this.emit({ loading: progress }))
    } catch (err) {
      this.fail(err, 'No se pudo preparar el audio de la sesión.')
    }
    this.emit({ loading: null, ready: true, engine: this.engine.getState() })
    void this.ensurePeaks()
    void this.refreshOrphans()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.queueLocalSave()
    }
    this.disposed = true
    this.listeners.clear()
    this.frameCallbacks.clear()
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle)
    this.frameHandle = 0
    if (this.endTimer) clearInterval(this.endTimer)
    this.engineOff?.()
    this.recorderOff?.()
    const recorder = this.recorder
    this.recorder = null
    try {
      // Si habia una toma en curso, close() la cierra en disco: aparecera como toma por recuperar.
      await recorder?.close()
    } catch {
      // Se esta cerrando la sesion: no hay a quien avisar.
    }
    await this.saving.catch(() => undefined)
    this.engine.dispose()
    this.decoded.clear()
    this.peaks.clear()
  }

  /** Un solo requestAnimationFrame para cabezal, medidores y niveles. Devuelve como dejar de escuchar. */
  onFrame(callback: () => void): () => void {
    this.frameCallbacks.add(callback)
    if (!this.frameHandle && !this.disposed) this.frameHandle = requestAnimationFrame(this.frame)
    return () => {
      this.frameCallbacks.delete(callback)
      if (this.frameCallbacks.size === 0 && this.frameHandle) {
        cancelAnimationFrame(this.frameHandle)
        this.frameHandle = 0
      }
    }
  }

  private frame = (): void => {
    this.frameHandle = 0
    if (this.disposed) return
    for (const callback of [...this.frameCallbacks]) callback()
    if (this.frameCallbacks.size > 0) this.frameHandle = requestAnimationFrame(this.frame)
  }

  /** Sin repeticion ni grabacion, la reproduccion se detiene poco despues del ultimo clip. */
  private checkEnd(): void {
    const state = this.engine.getState()
    if (state.status !== 'playing' || state.loop || this.snap.recording || !(state.durationS > 0)) return
    if (this.engine.position() > state.durationS + 0.4) this.engine.stop()
  }

  // ---- audio ----

  private resolveAudio: ResolveAudio = async (asset) => {
    const ready = this.decoded.get(asset.id)
    if (ready) {
      this.decoded.delete(asset.id)
      return ready
    }
    let file: Blob | null = await studioStore.getAsset(this.sessionId, asset.file).catch(() => null)
    if (!file && this.cloud) {
      try {
        file = await studioCloud.getAsset(this.cloud, this.sessionId, asset.file)
        await studioStore.putAsset(this.sessionId, asset.file, file).catch(() => undefined)
        this.markUploaded(asset.file)
      } catch {
        return null
      }
    }
    if (!file) return null
    const ctx = this.engine.getContext()
    return ctx.decodeAudioData(await file.arrayBuffer())
  }

  getPeaks(assetId: string): AssetPeaks | null {
    return this.peaks.get(assetId) ?? null
  }

  /** Calcula (o lee del almacen) los picos de los audios ya decodificados que no los tienen. */
  private async ensurePeaks(): Promise<void> {
    for (const asset of this.snap.session.assets) {
      if (this.disposed) return
      if (this.peaks.has(asset.id) || this.peaksPending.has(asset.id)) continue
      const buffer = this.engine.getBuffer(asset.id)
      if (!buffer) continue
      this.peaksPending.add(asset.id)
      try {
        let peaks = await studioStore.loadPeaks(this.sessionId, asset.id).catch(() => null)
        if (!peaks || peaks.channels.length === 0) {
          const channels = []
          for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
            channels.push(computePeaks(buffer.getChannelData(c), PEAKS_BASE_BUCKET))
            // Cede el hilo entre canales: un audio largo no congela la interfaz.
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
          peaks = { assetId: asset.id, sampleRate: buffer.sampleRate, channels }
          void studioStore.savePeaks(this.sessionId, peaks).catch(() => undefined)
        }
        this.peaks.set(asset.id, peaks)
        this.emit({ peaksVersion: this.snap.peaksVersion + 1 })
      } finally {
        this.peaksPending.delete(asset.id)
      }
    }
  }

  private syncEngine(session: StudioSession): void {
    void this.engine
      .updateSession(session)
      .then(() => this.ensurePeaks())
      .catch((err: unknown) => this.fail(err))
  }

  // ---- edicion ----

  /** Un paso de deshacer. Devuelve false si no cambio nada. */
  apply(next: StudioSession, label: string): boolean {
    if (next === this.snap.session) return false
    this.history.push(next, label)
    this.setSession(next)
    return true
  }

  /** `apply` con una operacion que puede lanzar (StudioSessionError): el error se muestra. */
  run(label: string, operation: (session: StudioSession) => StudioSession): boolean {
    try {
      return this.apply(operation(this.snap.session), label)
    } catch (err) {
      this.fail(err)
      return false
    }
  }

  /** Cambio en caliente sin paso de deshacer (arrastre de un fader). Cerrar con `commitLive`. */
  applyLive(next: StudioSession): void {
    if (next === this.snap.session) return
    this.setSession(next, false)
  }

  /** Registra el estado actual como un paso de deshacer y programa el guardado. */
  commitLive(label: string): void {
    if (this.history.current() === this.snap.session) return
    this.history.push(this.snap.session, label)
    this.emit(this.historyPatch())
    this.scheduleSave()
  }

  private setSession(next: StudioSession, save = true): void {
    this.editCount++
    const selectedClipId = this.snap.selectedClipId && findClip(next, this.snap.selectedClipId) ? this.snap.selectedClipId : null
    let arms = this.snap.arms
    if (Object.keys(arms).some((trackId) => !findTrack(next, trackId))) {
      arms = Object.fromEntries(Object.entries(arms).filter(([trackId]) => findTrack(next, trackId)))
    }
    this.emit({ session: next, selectedClipId, arms, ...this.historyPatch() })
    this.syncEngine(next)
    if (save) this.scheduleSave()
  }

  undo(): void {
    if (this.snap.recording) return
    const previous = this.history.undo()
    if (previous) this.setSession(previous)
  }

  redo(): void {
    if (this.snap.recording) return
    const next = this.history.redo()
    if (next) this.setSession(next)
  }

  select(clipId: string | null): void {
    if (clipId !== this.snap.selectedClipId) this.emit({ selectedClipId: clipId })
  }

  /** Elige el efecto que edita el inspector (mezclador e inspector comparten esta eleccion). */
  selectFx(selection: StudioFxSelection | null): void {
    const current = this.snap.selectedFx
    if (selection?.targetId === current?.targetId && selection?.type === current?.type) return
    this.emit({ selectedFx: selection })
  }

  setSnap(mode: SnapMode): void {
    if (mode !== this.snap.snap) this.emit({ snap: mode })
  }

  setSections(sections: readonly SectionSpan[]): void {
    this.emit({ sections })
  }

  updateMeta(patch: SessionMetaPatch, label: string): void {
    this.run(label, (session) => updateSessionMeta(session, { patch }))
  }

  // ---- clips ----

  /** Divide en el cabezal el clip elegido; sin eleccion, todos los clips activos bajo el cabezal. */
  splitAtPlayhead(): void {
    const atS = this.engine.position()
    this.run('Dividir clip', (session) => {
      const selected = this.snap.selectedClipId
      const ids = selected
        ? [selected]
        : session.tracks.flatMap((track) => track.clips.filter((clip) => clip.active && atS > clip.startS && atS < clip.startS + clip.lengthS).map((clip) => clip.id))
      let next = session
      for (const clipId of ids) next = splitClip(next, { clipId, atS, newClipId: newStudioId('clp') })
      return next
    })
  }

  duplicateSelected(): void {
    const clipId = this.snap.selectedClipId
    if (!clipId) return
    const newClipId = newStudioId('clp')
    if (this.run('Duplicar clip', (session) => duplicateClip(session, { clipId, newClipId }))) this.select(newClipId)
  }

  deleteSelected(): void {
    const clipId = this.snap.selectedClipId
    if (!clipId) return
    this.run('Borrar clip', (session) => deleteClip(session, { clipId }))
  }

  activateTake(clipId: string): void {
    this.run('Elegir toma', (session) => setActiveTake(session, { clipId }))
  }

  /** Mueve el clip elegido un paso de la rejilla (o 10 ms sin rejilla). Alternativa de teclado al arrastre. */
  nudgeSelected(direction: -1 | 1): void {
    const clipId = this.snap.selectedClipId
    if (!clipId) return
    this.run('Mover clip', (session) => {
      const loc = findClip(session, clipId)
      if (!loc) return session
      const mode = this.snap.snap
      const beatS = 60 / session.bpm
      const step = mode === 'bar' ? beatS * session.beatsPerBar : mode === 'beat' ? beatS : 0.01
      const target = snapTime(session, { timeS: Math.max(0, loc.clip.startS + direction * step), mode })
      const startS = Math.max(0, Math.min(target, STUDIO_MAX_SESSION_SECONDS - loc.clip.lengthS))
      if (startS === loc.clip.startS) return session
      const tracks = session.tracks.slice()
      const clips = loc.track.clips.slice()
      clips[loc.clipIndex] = { ...loc.clip, startS }
      tracks[loc.trackIndex] = { ...loc.track, clips }
      return { ...session, tracks }
    })
  }

  // ---- pistas ----

  addEmptyTrack(): void {
    this.run('Agregar pista', (session) => {
      if (session.tracks.length >= STUDIO_MAX_TRACKS) throw new Error(`El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas por sesión.`)
      return addTrack(session, { track: defaultTrack({ id: newStudioId('trk'), name: `Pista ${session.tracks.length + 1}` }) })
    })
  }

  removeTrack(trackId: string): void {
    this.run('Quitar pista', (session) => removeTrack(session, { trackId }))
  }

  updateTrack(trackId: string, patch: TrackPatch, label: string): void {
    this.run(label, (session) => updateTrack(session, { trackId, patch }))
  }

  /** Fader o paneo mientras se arrastra: sin paso de deshacer hasta `commitLive`. */
  updateTrackLive(trackId: string, patch: TrackPatch): void {
    try {
      this.applyLive(updateTrack(this.snap.session, { trackId, patch }))
    } catch (err) {
      this.fail(err)
    }
  }

  setArm(trackId: string, channel: ArmChannel | null): void {
    if (this.snap.recording) return
    const arms: Record<string, ArmChannel> = { ...this.snap.arms }
    if (channel === null) delete arms[trackId]
    else arms[trackId] = channel
    this.emit({ arms })
  }

  // ---- transporte ----

  play(): void {
    if (!this.snap.ready) return
    this.engine.play().catch((err: unknown) => this.fail(err, 'No se pudo reproducir.'))
  }

  pause(): void {
    this.engine.pause()
  }

  togglePlay(): void {
    if (this.snap.recording) {
      void this.stopRecording()
      return
    }
    const status = this.engine.getState().status
    if (status === 'playing' || status === 'count_in') this.pause()
    else this.play()
  }

  /** Detiene (y cierra la toma si se estaba grabando). Detenido, un segundo STOP vuelve al inicio. */
  stop(): void {
    if (this.snap.recording) {
      void this.stopRecording()
      return
    }
    const status = this.engine.getState().status
    if (status === 'playing' || status === 'count_in') this.engine.stop()
    else this.engine.seek(this.engine.getState().loop?.startS ?? 0)
  }

  seek(positionS: number): void {
    if (this.snap.recording) return
    this.engine.seek(positionS)
  }

  setLoop(region: LoopRegionS | null): void {
    if (this.snap.recording) return
    this.engine.setLoop(region)
  }

  setClick(patch: Partial<ClickSettings>): void {
    this.engine.setClick({ ...this.engine.getState().click, ...patch })
  }

  // ---- dispositivo y grabacion ----

  private ensureRecorder(): StudioRecorder {
    if (this.recorder) return this.recorder
    const recorder = new StudioRecorder({
      context: this.engine.getContext(),
      sessionId: this.sessionId,
      calibrationStorage,
      getLatencyOffsetMs: () => this.snap.session.latencyOffsetMs,
    })
    this.recorder = recorder
    this.recorderOff = recorder.onStatusChange((status) => this.emit({ device: { ...this.snap.device, status } }))
    return recorder
  }

  private patchDevice(patch: Partial<StudioDeviceState>): void {
    this.emit({ device: { ...this.snap.device, ...patch } })
  }

  async refreshInputs(): Promise<void> {
    if (!this.snap.ready || this.snap.device.busy) return
    this.patchDevice({ busy: 'listing' })
    try {
      const inputs = await this.ensureRecorder().listInputs()
      this.patchDevice({ inputs, busy: null })
    } catch (err) {
      this.patchDevice({ busy: null })
      this.fail(err, 'No se pudieron listar las entradas de audio.')
    }
  }

  /** Entrada que el usuario eligio la ultima vez en este navegador, o '' si nunca eligio. */
  preferredInputId(): string {
    try {
      return safeLocalStorage()?.getItem(INPUT_KEY) ?? ''
    } catch {
      return ''
    }
  }

  /**
   * Abre una entrada. `deviceId` vacio o 'default' es la entrada por defecto del sistema (el
   * microfono y el controlador propios del equipo). Si la entrada pedida ya no esta conectada,
   * se abre la de por defecto y se avisa, sin bloquear la grabacion.
   */
  async openInput(deviceId: string, remember = true): Promise<boolean> {
    if (!this.snap.ready || this.snap.device.busy || this.snap.recording) return false
    this.patchDevice({ busy: 'opening' })
    const recorder = this.ensureRecorder()
    const isDefault = deviceId === '' || deviceId === 'default'
    let report
    let openedId = deviceId
    try {
      try {
        report = await recorder.open({ deviceId, channels: 2 })
      } catch (err) {
        if (isDefault) throw err
        report = await recorder.open({ deviceId: 'default', channels: 2 })
        openedId = 'default'
        this.notify('warn', 'La entrada elegida no está conectada: se abrió la entrada por defecto del equipo.')
      }
      recorder.setMonitor(false)
      this.patchDevice({ report, deviceId: openedId, monitor: false, busy: null, status: recorder.getStatus() })
      // Una pista armada en una entrada que esta no tiene pasa a la Entrada 1.
      if (report.channelCount === 1) {
        const arms: Record<string, ArmChannel> = {}
        for (const trackId of Object.keys(this.snap.arms)) arms[trackId] = 0
        this.emit({ arms })
      }
      if (remember && openedId === deviceId) {
        try {
          safeLocalStorage()?.setItem(INPUT_KEY, deviceId)
        } catch {
          // Sin almacenamiento (navegacion privada) la eleccion dura lo que la pestana.
        }
      }
      return true
    } catch (err) {
      this.patchDevice({ busy: null })
      this.fail(err, 'No se pudo abrir la entrada de audio.')
      return false
    }
  }

  /** Suelta la entrada (por ejemplo antes de abrir la prueba de interfaz, que usa la suya). */
  async closeInput(): Promise<void> {
    if (this.snap.recording) return
    const recorder = this.recorder
    this.recorder = null
    this.recorderOff?.()
    this.recorderOff = null
    try {
      await recorder?.close()
    } catch (err) {
      this.fail(err)
    }
    this.patchDevice({ status: 'closed', report: null, deviceId: null, monitor: false, busy: null })
  }

  async calibrate(): Promise<void> {
    const recorder = this.recorder
    if (!recorder || this.snap.device.busy || this.snap.recording) return
    this.engine.pause()
    this.patchDevice({ busy: 'calibrating' })
    try {
      await recorder.calibrate()
      this.patchDevice({ report: recorder.reportSettings(), busy: null })
      this.notify('info', 'Latencia calibrada: las tomas nuevas se alinean con esta medida.')
    } catch (err) {
      this.patchDevice({ report: recorder.reportSettings(), busy: null })
      this.fail(err, 'No se pudo medir la latencia.')
    }
  }

  /** Olvida la calibracion de la entrada abierta. */
  forgetCalibration(): void {
    const report = this.snap.device.report
    if (!report?.calibration) return
    clearCalibration(calibrationStorage, report.calibration.deviceLabel, report.calibration.sampleRate)
    // El grabador arma su informe al abrir: se reabre la misma entrada para que lo rehaga.
    const deviceId = this.snap.device.deviceId
    if (deviceId) void this.openInput(deviceId)
  }

  setMonitor(enabled: boolean): void {
    const recorder = this.recorder
    if (!recorder) return
    recorder.setMonitor(enabled)
    this.patchDevice({ monitor: enabled })
  }

  /** Nivel de una entrada para pintar desde `onFrame`; null si no hay entrada abierta. */
  readInputLevel(channel: 0 | 1): { peakDb: number; rmsDb: number } | null {
    const recorder = this.recorder
    if (!recorder || recorder.getStatus() === 'closed') return null
    return recorder.readLevel(channel)
  }

  /** Posicion de la sesion desde la que corre la toma en curso (para dibujarla), o null. */
  recordingFromS(): number | null {
    if (!this.snap.recording || !this.recStart) return null
    return this.recLoop ? Math.max(this.recLoop.startS, Math.min(this.recStart.positionAtStart, this.recLoop.endS)) : this.recStart.positionAtStart
  }

  toggleRecord(): void {
    if (this.snap.recording) void this.stopRecording()
    else void this.startRecording()
  }

  async startRecording(): Promise<void> {
    if (this.snap.recording || !this.snap.ready) return
    if (this.snap.recordBlockReason) {
      this.notify('warn', this.snap.recordBlockReason)
      return
    }
    // Sin entrada abierta se usa la recordada o, si no hay, la de por defecto del equipo.
    if (!this.recorder || this.recorder.getStatus() === 'closed') {
      const opened = await this.openInput(this.preferredInputId() || 'default', false)
      if (!opened) return
    }
    const recorder = this.recorder
    if (!recorder || recorder.getStatus() === 'closed') return
    const arms: RecorderArm[] = Object.entries(this.snap.arms)
      .filter(([trackId]) => findTrack(this.snap.session, trackId))
      .map(([trackId, channel]) => ({ trackId, channel }))
    if (arms.length === 0) {
      this.notify('warn', 'Arma al menos una pista (botón R de la pista) antes de grabar.')
      return
    }
    try {
      recorder.arm(arms)
      this.recLoop = this.engine.getState().loop
      this.recCancel = false
      this.emit({ recording: true, notice: null })
      const started = await recorder.start(this.engine)
      this.recStart = started
      // Se pidio detener mientras el grabador todavia arrancaba (esperaba al escritor de OPFS):
      // la toma se cierra apenas existe, en vez de quedar grabando sin que nadie lo sepa.
      if (this.recCancel) {
        this.recCancel = false
        await this.stopRecording()
      }
    } catch (err) {
      this.recStart = null
      this.emit({ recording: false })
      this.fail(err, 'No se pudo empezar a grabar.')
    }
  }

  async stopRecording(): Promise<void> {
    const recorder = this.recorder
    const start = this.recStart
    if (!recorder || !this.snap.recording) return
    if (!start) {
      // Todavia esta arrancando: se cancela el arranque del motor y se deja anotado. Si el
      // grabador aun no llamo a engine.play(), pause() no cancela nada: startRecording revisa la
      // bandera cuando recorder.start resuelve y cierra la toma.
      this.recCancel = true
      this.engine.pause()
      return
    }
    this.recStart = null
    try {
      const takes = await recorder.stop()
      this.engine.stop()
      const stats = recorder.getLastTakeStats()
      let next = this.snap.session
      let dropped = 0
      let uncalibrated = false
      for (const take of takes) {
        const windows = findTrack(next, take.trackId)
          ? takeClipWindows({
              startSeconds: take.startSeconds,
              durationSeconds: take.durationSeconds,
              positionAtStart: start.positionAtStart,
              loop: this.recLoop,
            })
          : []
        if (windows.length === 0) {
          // Toma que no deja nada (se detuvo durante el conteo): su archivo no debe quedar huerfano.
          void studioStore.deleteAsset(this.sessionId, take.asset.file).catch(() => undefined)
          continue
        }
        dropped += take.droppedBlocks
        uncalibrated = uncalibrated || !take.calibrated
        next = addTakeClips(addAsset(next, { asset: take.asset }), take.trackId, take.assetId, windows)
      }
      if (next !== this.snap.session) this.apply(next, 'Grabar toma')
      else this.notify('warn', 'La toma quedó vacía: no se agregó nada.')
      // El escritor deja de escribir al llegar al tope de tamano por audio y el transporte sigue
      // en GRABANDO: sin este aviso, lo tocado despues del corte se perdia en silencio.
      if (stats?.truncated) {
        this.notify('error', 'La toma llegó al tope de 200 MB por audio y se cortó ahí: lo que se tocó después NO quedó grabado. Graba tomas más cortas (el panel DISPOSITIVO muestra el máximo).')
      } else if (stats?.error) {
        this.notify('error', `La toma tuvo un error al escribirse y puede estar incompleta: ${stats.error}`)
      } else if (dropped > 0) this.notify('warn', `La toma perdió ${dropped} bloques de audio: puede tener saltos. Revisa la prueba de interfaz.`)
      else if (uncalibrated && takes.length > 0) this.notify('info', 'Toma grabada sin calibrar: si suena corrida, calibra la latencia o usa el ajuste en ms.')
    } catch (err) {
      this.engine.pause()
      this.fail(err, 'No se pudo cerrar la toma.')
      void this.refreshOrphans()
    } finally {
      this.emit({ recording: false })
    }
  }

  // ---- importar ----

  /**
   * Guarda un audio como asset inmutable de la sesion y lo deja decodificado para el motor.
   * wav, flac y mp3 de 1 o 2 canales se guardan tal cual; lo demas se convierte a WAV de 24 bits.
   */
  async ingestAudio(blob: Blob, name: string, kind: StudioAssetKind, label?: string, source: StudioAsset['source'] = null): Promise<IngestedAudio> {
    if (blob.size === 0) throw new Error(`"${name}" está vacío.`)
    if (blob.size > STUDIO_MAX_ASSET_BYTES) throw new Error(`"${name}" pesa más de 200 MB, el máximo por audio.`)
    const ctx = this.engine.getContext()
    const header = await blob.slice(0, 4096).arrayBuffer()
    let buffer: AudioBuffer
    try {
      buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
    } catch {
      throw new Error(`"${name}" no se pudo leer como audio.`)
    }
    const ext = stemExtension(name)
    const id = newStudioId('ast')
    let stored = blob
    let fileExt: StudioAssetExtension = 'wav'
    let sampleRate = buffer.sampleRate
    if (KEPT_EXTENSIONS.includes(ext) && buffer.numberOfChannels <= 2) {
      fileExt = ext as StudioAssetExtension
      // La frecuencia real del archivo solo se conoce en WAV; en flac y mp3 se anota la decodificada.
      if (ext === 'wav') sampleRate = parseWavHeader(header)?.sampleRate ?? buffer.sampleRate
    } else {
      const channels = [buffer.getChannelData(0)]
      if (buffer.numberOfChannels > 1) channels.push(buffer.getChannelData(1))
      stored = new Blob([encodeWav24(channels, buffer.sampleRate)], { type: 'audio/wav' })
      if (stored.size > STUDIO_MAX_ASSET_BYTES) throw new Error(`"${name}" pasa de 200 MB al convertirlo a WAV. Conviértelo antes a MP3 o FLAC.`)
    }
    const asset: StudioAsset = {
      id,
      file: assetFileName(id, fileExt),
      kind,
      label: (label ?? fileTitle(name)).slice(0, STUDIO_MAX_ASSET_LABEL),
      channels: buffer.numberOfChannels > 1 ? 2 : 1,
      sampleRate: Math.min(192000, Math.max(8000, Math.round(sampleRate))),
      durationS: buffer.duration,
      size: stored.size,
      source,
    }
    await studioStore.putAsset(this.sessionId, asset.file, stored)
    this.decoded.set(id, buffer)
    return { asset }
  }

  /**
   * Sube a la nube un audio que ya esta en este equipo (la mezcla que se manda a masterizar, el
   * audio que se va a separar) y lo recuerda como subido. Repetir es seguro: un audio es inmutable.
   */
  async ensureAssetInCloud(file: string): Promise<void> {
    const cloud = this.cloud
    if (!cloud) throw new Error('Necesitas una sesión de nube activa para subir audio del Estudio.')
    const blob = await studioStore.getAsset(this.sessionId, file)
    if (!blob) throw new Error('Ese audio no está en este equipo: no se puede subir.')
    await studioCloud.putAsset(cloud, this.sessionId, file, blob)
    this.markUploaded(file)
  }

  /**
   * Trae a este equipo un audio que un trabajo de IA dejo en la nube, con su mismo nombre de
   * archivo (no se vuelve a subir al guardar), y devuelve su entrada lista para `addAsset`. NO
   * toca la sesion: quien llama lo agrega cuando el usuario acepta.
   */
  async adoptCloudAsset(jobAsset: StudioJobAsset, options: { blob?: Blob; signal?: AbortSignal } = {}): Promise<StudioAsset> {
    const cloud = this.cloud
    if (!cloud) throw new Error('Necesitas una sesión de nube activa para bajar audio del Estudio.')
    let blob: Blob | null = await studioStore.getAsset(this.sessionId, jobAsset.file).catch(() => null)
    if (!blob) {
      // `options.blob`: quien llama ya lo bajo (para escucharlo antes de aceptar).
      blob = options.blob ?? (await studioCloud.getAsset(cloud, this.sessionId, jobAsset.file, options.signal))
      await studioStore.putAsset(this.sessionId, jobAsset.file, blob)
    }
    this.markUploaded(jobAsset.file)
    let buffer: AudioBuffer
    try {
      buffer = await this.engine.getContext().decodeAudioData(await blob.arrayBuffer())
    } catch {
      throw new Error(`"${jobAsset.label || jobAsset.file}" no se pudo leer como audio.`)
    }
    this.decoded.set(jobAsset.id, buffer)
    return jobAssetToSessionAsset(jobAsset, { channels: buffer.numberOfChannels, sampleRate: buffer.sampleRate, durationS: buffer.duration })
  }

  /** Sesion con el audio agregado como una pista nueva con un clip. No aplica: devuelve la sesion. */
  addAssetAsTrack(session: StudioSession, asset: StudioAsset, options: AddAssetAsTrackOptions): StudioSession {
    if (session.tracks.length >= STUDIO_MAX_TRACKS) throw new Error(`El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas por sesión.`)
    const trackId = newStudioId('trk')
    const name = options.name.trim().slice(0, STUDIO_MAX_TRACK_NAME) || 'Pista'
    let next = addAsset(session, { asset })
    next = addTrack(next, { track: defaultTrack({ id: trackId, name, role: options.role }) })
    const clip = clipForAsset(asset, options.startS ?? 0, options.offsetS ?? 0)
    return clip ? addClip(next, { trackId, clip }) : next
  }

  /** Importa archivos de audio: en una pista existente (`trackId`, en `atS`) o una pista nueva por archivo. */
  async importFiles(files: readonly File[], target?: { trackId: string; atS: number }): Promise<void> {
    if (files.length === 0) return
    if (this.snap.recording) {
      this.notify('warn', 'No se puede importar audio mientras se graba. Detén la toma y vuelve a soltar los archivos.')
      return
    }
    if (!this.snap.ready) {
      // Antes esto volvia sin decir nada: soltar archivos justo al abrir la sesion "no hacia nada".
      this.notify('warn', 'La sesión todavía está cargando. Espera un momento y vuelve a soltar los archivos.')
      return
    }
    // Cada archivo se guarda primero; la sesion se arma al final SOBRE LA VIGENTE, para no pisar
    // lo que se haya editado (un fader, un clip) mientras se decodificaba.
    const imported: { asset: StudioAsset; name: string }[] = []
    const problems: string[] = []
    this.emit({ loading: { done: 0, total: files.length } })
    let done = 0
    for (const file of files) {
      try {
        const { asset } = await this.ingestAudio(file, file.name, 'import')
        imported.push({ asset, name: file.name })
      } catch (err) {
        problems.push(errorText(err, `No se pudo importar "${file.name}".`))
      }
      done++
      this.emit({ loading: { done, total: files.length } })
    }
    this.emit({ loading: null })
    const base = this.snap.session
    let next = base
    for (const { asset, name } of imported) {
      try {
        if (target && findTrack(next, target.trackId)) {
          const clip = clipForAsset(asset, target.atS, 0)
          next = addAsset(next, { asset })
          if (clip) next = addClip(next, { trackId: target.trackId, clip })
        } else {
          next = this.addAssetAsTrack(next, asset, { name: fileTitle(name), role: recognizeStem(name) ?? 'unknown' })
        }
      } catch (err) {
        problems.push(errorText(err, `No se pudo agregar "${name}" a la sesión.`))
      }
    }
    if (next !== base) this.apply(next, imported.length > 1 ? 'Importar audios' : 'Importar audio')
    if (problems.length > 0) this.notify('error', problems.join(' '))
  }

  /** Trae los stems locales de la cancion (services/stemStore.ts) como pistas, alineados al compas 1. */
  async importSongStems(songId: string): Promise<void> {
    if (!this.snap.ready || this.snap.recording) return
    let loaded: Awaited<ReturnType<typeof loadStemSong>>
    try {
      loaded = await loadStemSong(songId)
    } catch (err) {
      this.fail(err, 'No se pudieron leer los stems de la canción.')
      return
    }
    if (!loaded || loaded.record.tracks.length === 0) {
      this.notify('info', 'Esta canción no tiene stems guardados en este equipo. Impórtalos en PISTAS o arrastra los archivos aquí.')
      return
    }
    const { record, blobs } = loaded
    const base = this.snap.session
    let next = base
    const problems: string[] = []
    let done = 0
    this.emit({ loading: { done, total: record.tracks.length } })
    // offsetMs = tiempo del audio donde cae el compas 1; en el Estudio el compas 1 esta en 0 s.
    const offsetS = record.offsetMs / 1000
    for (const track of record.tracks) {
      const blob = blobs.get(track.id)
      try {
        if (!blob) throw new Error(`Falta el archivo de "${track.label}" en este equipo.`)
        const { asset } = await this.ingestAudio(blob, track.fileName, 'stem', track.label)
        next = this.addAssetAsTrack(next, asset, { name: track.label, role: track.role, startS: Math.max(0, -offsetS), offsetS: Math.max(0, offsetS) })
      } catch (err) {
        problems.push(errorText(err, `No se pudo importar "${track.label}".`))
      }
      done++
      this.emit({ loading: { done, total: record.tracks.length } })
    }
    this.emit({ loading: null })
    if (next !== base) {
      if (this.snap.session !== base) this.notify('warn', 'La sesión cambió mientras se importaban los stems; vuelve a importarlos.')
      else this.apply(next, 'Importar stems de la canción')
    }
    if (problems.length > 0) this.notify('error', problems.join(' '))
  }

  // ---- tomas huerfanas ----

  private async refreshOrphans(): Promise<void> {
    if (this.snap.recording) return
    try {
      const orphanTakes = await studioStore.listOrphanTakes(this.sessionId, [...this.referencedFiles()])
      this.emit({ orphanTakes })
    } catch {
      // Sin OPFS no hay tomas que recuperar.
    }
  }

  async recoverOrphan(file: string): Promise<void> {
    try {
      const asset = await studioStore.recoverOrphanTake(this.sessionId, file)
      this.apply(this.addAssetAsTrack(this.snap.session, asset, { name: 'Toma recuperada' }), 'Recuperar toma')
    } catch (err) {
      this.fail(err, 'No se pudo recuperar la toma.')
    }
    void this.refreshOrphans()
  }

  /**
   * Archivos que algun estado de la sesion sigue usando: el vigente, cada paso de deshacer y
   * rehacer, y los audios guardados que aun no entraron. Graba una toma y pulsa Ctrl+Z: el audio
   * sale de la sesion vigente, pero Ctrl+Y lo trae de vuelta; no es una toma huerfana.
   */
  private referencedFiles(): Set<string> {
    return referencedAssetFiles([this.snap.session, ...this.history.states()], this.decoded.keys())
  }

  async discardOrphan(file: string): Promise<void> {
    if (this.referencedFiles().has(file)) {
      // Borrarlo dejaria un paso del historial apuntando a un audio que ya no existe.
      this.notify('warn', 'Ese audio todavía lo usa un paso de deshacer o rehacer: no se descartó.')
      void this.refreshOrphans()
      return
    }
    try {
      await studioStore.discardOrphanTake(this.sessionId, file)
    } catch (err) {
      this.fail(err, 'No se pudo descartar la toma.')
    }
    void this.refreshOrphans()
  }

  // ---- guardado ----

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.snap.save.local !== 'pending' || !this.snap.save.dirty) this.emit({ save: { ...this.snap.save, local: 'pending', dirty: true } })
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.queueLocalSave()
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * Guarda YA lo que estuviera esperando el temporizador (y lo aplicado en vivo sin confirmar).
   * La interfaz lo llama al ocultarse o cerrarse la pagina: un cambio hecho menos de 700 ms antes
   * de cerrar la pestana ya no se pierde.
   */
  flushLocalSave(): void {
    const pending = this.saveTimer !== null || this.history.current() !== this.snap.session
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (pending && this.snap.ready) void this.queueLocalSave()
  }

  /** true si cerrar la pagina ahora perderia trabajo: guardado local pendiente o subida a la nube en curso. */
  hasUnsavedWork(): boolean {
    return this.saveTimer !== null || this.snap.save.local === 'pending' || this.snap.save.cloud === 'saving'
  }

  /** Guardados en serie: nunca dos escrituras de la misma sesion a la vez. */
  private queueLocalSave(): Promise<void> {
    const session = this.snap.session
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        try {
          await studioStore.saveSession(session, { band: this.band, dirty: true })
          if (this.snap.session === session && !this.saveTimer) this.emit({ save: { ...this.snap.save, local: 'saved' } })
        } catch (err) {
          this.emit({ save: { ...this.snap.save, local: 'error' } })
          this.fail(err, 'No se pudo guardar la sesión en este equipo.')
        }
      })
    return this.saving
  }

  private uploadedFiles(): Set<string> {
    try {
      const raw = safeLocalStorage()?.getItem(UPLOADED_PREFIX + this.sessionId)
      const list: unknown = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [])
    } catch {
      return new Set()
    }
  }

  private storeUploaded(files: Set<string>): void {
    try {
      safeLocalStorage()?.setItem(UPLOADED_PREFIX + this.sessionId, JSON.stringify([...files]))
    } catch {
      // Sin almacenamiento, la proxima vez se vuelven a subir (el Worker no los reescribe).
    }
  }

  private markUploaded(file: string): void {
    const files = this.uploadedFiles()
    if (files.has(file)) return
    files.add(file)
    this.storeUploaded(files)
  }

  /**
   * GUARDAR: sube los audios que falten y el documento. `overwrite` pisa la version de la nube
   * (tras un conflicto). El documento que se sube no lista los audios que ningun clip usa.
   */
  async saveToCloud(overwrite = false): Promise<void> {
    const cloud = this.cloud
    if (!cloud || this.snap.save.cloud === 'saving' || this.snap.recording) return
    if (!this.snap.canEditCloud) {
      this.notify('warn', 'Solo el Owner o el Director musical de la banda pueden guardar el Estudio en la nube.')
      return
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.queueLocalSave()
    const version = this.editCount
    const document = removeUnusedAssets(this.snap.session)
    this.emit({ save: { ...this.snap.save, cloud: 'saving', cloudDetail: null, uploading: { done: 0, total: document.assets.length } } })
    try {
      let etag = this.snap.save.etag
      if (overwrite) etag = (await studioCloud.getSession(cloud, this.sessionId))?.etag ?? null
      let saved: Awaited<ReturnType<typeof studioCloud.putSession>>
      try {
        await this.uploadAssets(cloud, document, false)
        saved = await studioCloud.putSession(cloud, document, { ifMatch: etag })
      } catch (err) {
        if (!(err instanceof StemCloudError) || err.code !== 'missing_asset') throw err
        // La nube perdio un audio que este equipo creia subido: se suben todos de nuevo, una vez.
        await this.uploadAssets(cloud, document, true)
        saved = await studioCloud.putSession(cloud, document, { ifMatch: etag })
      }
      const dirty = this.editCount !== version
      // Se anota la hora que puso el Worker: al reabrir se compara contra la lista de la nube
      // y, si coincide, no se vuelve a bajar el documento (que pisaria el de este equipo).
      await studioStore.saveSession(this.snap.session, { band: this.band, etag: saved.etag, dirty, cloudUpdatedAt: saved.session.updatedAt }).catch(() => undefined)
      this.emit({ save: { local: dirty ? this.snap.save.local : 'saved', dirty, etag: saved.etag, cloud: 'idle', cloudDetail: null, uploading: null } })
    } catch (err) {
      const conflict = err instanceof StemCloudError && (err.code === 'session_conflict' || err.status === 412)
      this.emit({
        save: {
          ...this.snap.save,
          cloud: conflict ? 'conflict' : 'error',
          cloudDetail: conflict ? 'Alguien guardó esta sesión en la nube después de que la abriste.' : errorText(err, 'No se pudo guardar en la nube.'),
          uploading: null,
        },
      })
    }
  }

  private async uploadAssets(cloud: CloudTarget, document: StudioSession, all: boolean): Promise<void> {
    const uploaded = all ? new Set<string>() : this.uploadedFiles()
    let done = 0
    for (const asset of document.assets) {
      if (!uploaded.has(asset.file)) {
        const file = await studioStore.getAsset(this.sessionId, asset.file)
        if (!file) throw new Error(`Falta en este equipo el audio "${asset.label || asset.file}": no se puede subir la sesión.`)
        await studioCloud.putAsset(cloud, this.sessionId, asset.file, file)
        uploaded.add(asset.file)
        this.storeUploaded(uploaded)
      }
      done++
      this.emit({ save: { ...this.snap.save, uploading: { done, total: document.assets.length } } })
    }
  }

  dismissCloudError(): void {
    if (this.snap.save.cloud === 'error' || this.snap.save.cloud === 'conflict') this.emit({ save: { ...this.snap.save, cloud: 'idle', cloudDetail: null } })
  }

  /** Tras un conflicto: descarta lo de este equipo y carga la version de la nube. */
  async reloadFromCloud(): Promise<void> {
    const cloud = this.cloud
    if (!cloud || this.snap.recording) return
    this.emit({ save: { ...this.snap.save, cloud: 'saving', cloudDetail: null } })
    try {
      const remote = await studioCloud.getSession(cloud, this.sessionId)
      if (!remote) throw new Error('Esta sesión ya no existe en la nube.')
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      await this.saving.catch(() => undefined)
      await studioStore.saveSession(remote.session, { band: this.band, etag: remote.etag, dirty: false })
      // Otra frecuencia cambia el AudioContext del motor: el grabador tiene que crearse de nuevo.
      if (remote.session.sampleRate !== this.snap.session.sampleRate) await this.closeInput()
      this.history.clear()
      this.history.push(remote.session)
      this.editCount++
      this.emit({
        session: remote.session,
        selectedClipId: null,
        arms: {},
        ...this.historyPatch(),
        save: { local: 'saved', dirty: false, etag: remote.etag, cloud: 'idle', cloudDetail: null, uploading: null },
      })
      await this.engine.load(remote.session, this.resolveAudio, (progress) => this.emit({ loading: progress }))
      this.emit({ loading: null })
      void this.ensurePeaks()
      void this.refreshOrphans()
    } catch (err) {
      this.emit({ loading: null, save: { ...this.snap.save, cloud: 'error', cloudDetail: errorText(err, 'No se pudo recargar la sesión de la nube.') } })
    }
  }
}

// ---------------------------------------------------------------------------
// Ayudas de documento
// ---------------------------------------------------------------------------

/** Clip que muestra el audio desde `offsetS`, puesto en `startS`. null si no queda nada que mostrar. */
function clipForAsset(asset: StudioAsset, startS: number, offsetS: number): StudioClip | null {
  const start = Math.max(0, Math.min(startS, STUDIO_MAX_SESSION_SECONDS - STUDIO_MIN_CLIP_SECONDS))
  const offset = Math.max(0, offsetS)
  const lengthS = Math.min(asset.durationS - offset, STUDIO_MAX_SESSION_SECONDS - start)
  if (!(lengthS >= STUDIO_MIN_CLIP_SECONDS)) return null
  return { id: newStudioId('clp'), assetId: asset.id, startS: start, offsetS: offset, lengthS, gainDb: 0, fadeInS: 0, fadeOutS: 0, takeGroup: null, active: true }
}

/**
 * Agrega las ventanas de una toma a la pista. Si la toma tiene varias vueltas o pisa clips
 * activos, todo queda en un mismo `takeGroup` y suena la ultima vuelta: las demas quedan como
 * tomas alternativas (STUDIO_V1.md 2.4).
 */
function addTakeClips(session: StudioSession, trackId: string, assetId: string, windows: readonly ClipWindow[]): StudioSession {
  const track = findTrack(session, trackId)
  if (!track || windows.length === 0) return session
  const overlapsWindow = (clip: StudioClip) => windows.some((w) => clip.startS < w.startS + w.lengthS && w.startS < clip.startS + clip.lengthS)
  const rivals = track.clips.filter((clip) => clip.active && overlapsWindow(clip))
  const grouped = windows.length > 1 || rivals.length > 0
  const group = grouped ? (rivals.find((clip) => clip.takeGroup !== null)?.takeGroup ?? newStudioId('tk')) : null
  let next = session
  if (group !== null && rivals.some((clip) => clip.takeGroup !== group)) {
    const rivalIds = new Set(rivals.map((clip) => clip.id))
    const tracks = next.tracks.map((t) => (t.id === trackId ? { ...t, clips: t.clips.map((c) => (rivalIds.has(c.id) ? { ...c, takeGroup: group } : c)) } : t))
    next = { ...next, tracks }
  }
  let lastId = ''
  windows.forEach((w, index) => {
    const last = index === windows.length - 1
    const id = newStudioId('clp')
    if (last) lastId = id
    // Fades cortos por defecto: una toma que entra o sale a mitad de una nota no hace clic.
    const fade = w.lengthS > 0.2 ? 0.005 : 0
    next = addClip(next, {
      trackId,
      clip: { id, assetId, startS: w.startS, offsetS: w.offsetS, lengthS: w.lengthS, gainDb: 0, fadeInS: fade, fadeOutS: fade * 2, takeGroup: group, active: last },
    })
  })
  return group !== null && lastId ? setActiveTake(next, { clipId: lastId }) : next
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

/** Foto del Estudio; el componente se repinta solo cuando cambia. */
export function useStudio(controller: StudioController): StudioSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.snapshot)
}
