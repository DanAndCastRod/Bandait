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
 *
 * v2 (docs/PLAN_ESTUDIO_V2.md): pistas de instrumento, clips MIDI, piano roll, entrada MIDI y
 * archivos .mid. La foto suma la pista elegida, el editor activo (linea de tiempo o piano roll),
 * el estado del piano roll (herramienta, rejilla, seleccion de notas) y el de la entrada MIDI.
 * Los comandos del registro (services/studio/commands.ts) se conectan a metodos de esta clase:
 * toggleEditor, zoomIn/zoomOut, setPianoTool, transposeNotes, nudgeNotes, quantizeSelection,
 * deleteSelection, duplicateSelection, splitSelection, selectAll, copyNotes/cutNotes/pasteNotes,
 * toggleTrackMute/toggleTrackSolo, selectAdjacentTrack, toggleComputerKeyboard, importMidiFile y
 * exportSessionMidi. Ningun componente de esta parte escucha el teclado por su cuenta.
 */
import { useSyncExternalStore } from 'react'
import { StemCloudError, type CloudTarget } from '../../services/stemCloud'
import { stemBaseName, stemExtension, type StemRole } from '../../services/stemNames'
import { loadStemSong } from '../../services/stemStore'
import type { SectionSpan } from '../../services/stemTiming'
import { encodeWav24, parseWavHeader } from '../../services/wav'
import { bounce, bounceRange, soloTrackSession } from '../../services/studio/bounce'
import { COMPUTER_KEYBOARD_DEFAULT_OCTAVE } from '../../services/studio/computerKeyboard'
import { StudioEngine, playbackStopS } from '../../services/studio/engine'
import { instrumentTailSeconds } from '../../services/studio/instruments/core'
import { createHistory, STUDIO_HISTORY_LIMIT } from '../../services/studio/history'
import { instrumentAvailability } from '../../services/studio/instruments/index'
import { jobAssetToSessionAsset } from '../../services/studio/jobs'
import { clearCalibration } from '../../services/studio/latency'
import { StudioMidiInput } from '../../services/studio/midiInput'
import {
  addNotes,
  duplicateNotes,
  gridBeats,
  invertSelection,
  legato,
  moveNotes,
  normalizeNotes,
  quantize,
  humanize,
  humanizeClipContext,
  removeNotes,
  resizeNotes,
  setVelocity,
  splitNotesAt,
  transpose,
} from '../../services/studio/midiOps'
import { applyGrooveTemplate, describeGroove, grooveFromAudio, type GrooveGrid, type StudioGrooveTemplate } from '../../services/studio/groove'
import { computePeaks, peaksHaveRms, PEAKS_BASE_BUCKET } from '../../services/studio/peaks'
import { StudioRecorder } from '../../services/studio/recorder'
import { midiClipExportNotes, parseSmf, SMF_DRUM_CHANNEL, writeSmf } from '../../services/studio/smf'
import { adjacentMarkerBeat, cloudHasOtherVersion, referencedAssetFiles, takeClipWindows, tapTempo as computeTapTempo, TAP_TEMPO_RESET_MS, type ClipWindow } from '../../services/studio/timelineMath'
import {
  assetFileName,
  beatsToSeconds,
  sessionEndSeconds,
  STUDIO_MARKER_KIND_LABELS,
  STUDIO_MAX_MARKERS,
  defaultInstrument,
  defaultInstrumentTrack,
  defaultMidiClip,
  defaultTrack,
  findClip,
  findMidiClip,
  findTrack,
  newSession,
  newStudioId,
  roundBeat,
  secondsToBeats,
  STUDIO_ASSET_EXTENSIONS,
  STUDIO_BPM_MAX,
  STUDIO_BPM_MIN,
  STUDIO_INSTRUMENT_TYPE_LABELS,
  STUDIO_MASTER_ID,
  STUDIO_MAX_ASSET_BYTES,
  STUDIO_MAX_ASSET_LABEL,
  STUDIO_MAX_BEAT,
  STUDIO_MAX_NOTES_PER_CLIP,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACK_NAME,
  STUDIO_MAX_TRACKS,
  STUDIO_MIN_CLIP_SECONDS,
  STUDIO_REVERB_SEND_DB_MIN,
  STUDIO_SAMPLE_RATES,
  type MidiClipLocation,
  type StudioAsset,
  type StudioAssetExtension,
  type StudioAssetKind,
  type StudioClip,
  type StudioClipFadeShape,
  type StudioFx,
  type StudioFxType,
  type StudioInstrument,
  type StudioMidiNote,
  type StudioParamInstrumentType,
  type StudioSamplerZone,
  type StudioSession,
} from '../../services/studio/session'
import {
  addAsset,
  addClip,
  addInstrumentTrack,
  addMidiClip,
  addTrack,
  clipsRangeS,
  copyClips,
  deleteClips,
  duplicateTrack,
  fadeClipsAt,
  joinClips,
  moveClipsBy,
  moveTrack,
  pasteClips,
  pasteCursorAfterCopy,
  pastePosition,
  removeTrack,
  removeUnusedAssets,
  setActiveTake,
  setChords,
  setClipFades,
  setClipGain,
  setClipPhaseInvert,
  setFrozenAsset,
  setInstrument,
  setMarkers,
  setTrackFx,
  snapTime,
  splitClip,
  splitMidiClip,
  toggleClipsActive,
  trimClipsAt,
  updateMidiClip,
  updateSessionMeta,
  updateTrack,
  type ClipClipboard,
  type PasteCursor,
} from '../../services/studio/sessionOps'
import * as studioCloud from '../../services/studio/studioCloud'
import * as studioStore from '../../services/studio/studioStore'
import type {
  AssetPeaks,
  ClickSettings,
  CloudSessionSummary,
  EngineLoadProgress,
  EngineState,
  HumanizeOptions,
  HumanizePresetId,
  LoopRegionS,
  MidiAccessStatus,
  MidiEditResult,
  MidiInputDevice,
  MidiNoteEvent,
  MidiTake,
  MixMetrics,
  NoteSelection,
  OrphanTake,
  PlayStart,
  QuantizeGrid,
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
  StudioChatListen,
  StudioVcsCommitMeta,
  StudioVcsIndex,
  TrackPatch,
} from '../../services/studio/types'
import type { ChatMixMeasurement, ChatSummaryExtras } from '../../services/studio/chatContext'
import { measureMix, renderListenExcerpt, type MeasureMixOptions } from '../../services/studio/chatAudio'
import {
  alignPhaseCrossCorrelation,
  barkBandEnergiesDb,
  detectBpmLocal,
  detectChordsViterbi,
  detectKeyLocal,
  downmixMono,
} from '../../services/studio/dspMath'
import { integratedLufs } from '../../services/studio/loudness'
import { applyAutoMasterToSession, type AutoMasterProfile, type AutoMasterTone } from '../../services/studio/mastering'
import { optimizeBarkMixUnmasking, type MixUnmaskResult, type TrackSpectralInput } from '../../services/studio/mixOptimizer'
import {
  computeDefaultClickBars,
  generateChordProgressionNotes,
  synthesizeClickGuideWav,
  type GenerateProgressionOptions,
} from '../../services/studio/productionTools'
import { applySongStructureToSession, songToStudioSeed } from '../../services/studio/songStudioBridge'
import {
  createStudioCollabChannel,
  mergeCollaborativeSession,
  type RealtimeClientLike,
  type StudioCollabEvent,
  type StudioCollabHandle,
  type StudioCollaboratorPresence,
} from '../../services/studio/studioCollab'
import {
  commitStudioLocal,
  emptyStudioVcsBundle,
  mergeStudioVcsIndices,
  parseStoredVcsBundle,
  resolveLocalCommitSession,
  serializeVcsBundle,
  type StudioVcsBundle,
} from '../../services/studio/studioVcs'
import { classifyAudioRole } from '../../services/studio/trackClassifier'
import {
  computeNormalizedClipGainDb,
  reverseChannels,
  splitClipByStripSilence,
  type StripSilenceOptions,
} from '../../services/studio/waveOps'
import { normalizeBranchName } from '../../services/versionControl'
import { serializeSession } from '../../services/studio/session'
import type { Song } from '../../types/hub'

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

/** Editor que ocupa el area central: la linea de tiempo o el piano roll del clip abierto. */
export type StudioEditorView = 'timeline' | 'piano_roll'

/** Herramientas del piano roll (atajos 1..5 en el registro de comandos). */
export type PianoTool = 'select' | 'draw' | 'erase' | 'cut' | 'velocity'

export interface PianoRollState {
  tool: PianoTool
  grid: QuantizeGrid
  triplets: boolean
  /** Ajuste a la rejilla al dibujar y mover (Alt mientras se arrastra lo suspende). */
  snap: boolean
  /** Indices (en el arreglo ordenado de notas del clip abierto) de las notas elegidas. */
  selection: readonly number[]
  /** Fuerza de cuantizar, 0..1. */
  quantizeStrength: number
  /** Intensidad de humanizacion (tiempo, velocidad y duracion), 0..1. */
  humanizeAmount: number
  /** Ultimo preset de humanizacion elegido en el popover (lo usa tambien H en la linea de tiempo). */
  humanizePreset: HumanizePresetId | null
  /** Plantilla de groove tomada de un clip de audio (en memoria, no viaja en la sesion). */
  groove: StudioGrooveTemplate | null
  /** Largo de la nota que dibuja la herramienta de dibujar, en beats (el ultimo usado). */
  drawLength: number
}

export interface StudioMidiState {
  /** Permiso de Web MIDI; 'prompt' mientras no se pidio. */
  access: MidiAccessStatus
  devices: readonly MidiInputDevice[]
  /** Dispositivo abierto, o null. */
  deviceId: string | null
  /** Canal 0..15 o todos. */
  channel: number | 'all'
  /** Teclado de la computadora como teclado musical. */
  keyboard: boolean
  /** Octava base del teclado de la computadora (4 = Do central en la A). */
  octave: number
  /** Pista de instrumento armada para grabar MIDI y tocar en vivo. */
  armedTrackId: string | null
  /** Cuantizar la toma MIDI al terminar, con la rejilla del piano roll. */
  quantizeOnStop: boolean
}

/**
 * Pedidos de vista que el registro de comandos manda a la interfaz: zoom, ver toda la sesion,
 * centrar en el cabezal (los atiende el editor activo) y renombrar una pista (su cabecera).
 */
export type StudioViewCommand =
  | { type: 'zoom'; direction: 1 | -1 }
  | { type: 'fit' }
  | { type: 'center' }
  | { type: 'rename_track'; trackId: string }

export interface StudioSnapshot {
  session: StudioSession
  engine: EngineState
  /** null mientras carga audios: { done, total }. */
  loading: EngineLoadProgress | null
  ready: boolean
  /** Clip elegido principal: de audio o MIDI (los ids son unicos entre los dos). */
  selectedClipId: string | null
  /**
   * Todos los clips elegidos (Shift o Ctrl + clic, Ctrl+A), con el principal incluido. Vacio si
   * no hay clip elegido. Copiar, cortar, borrar, duplicar, mover, dividir y cuantizar actuan sobre
   * todos; lo que trabaja con un solo clip (inspector, piano roll) usa `selectedClipId`.
   */
  selectedClipIds: readonly string[]
  /** Pista elegida (la del clip elegido o la que se toco en la cabecera). */
  selectedTrackId: string | null
  editor: StudioEditorView
  /** Clip MIDI abierto en el piano roll, o null. */
  pianoClipId: string | null
  piano: PianoRollState
  midi: StudioMidiState
  /** Pista que se esta congelando (render a audio), o null. */
  freezing: string | null
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
  /** Estado de Control de Versiones (ramas y commits). */
  vcs: {
    activeBranch: string
    index: StudioVcsIndex
    saving: boolean
  }
  /** Comparacion auditiva A/B instantanea sin cortes (`active: 'A'` edicion actual, `'B'` snapshot). */
  abState: {
    active: 'A' | 'B'
    commitId: string
    label: string
  } | null
  /** Integrantes conectados en tiempo real a esta banda/sesion. */
  collaborators: readonly StudioCollaboratorPresence[]
  /** Modo cientifico LAB (divulgacion progresiva: espectrograma, Lissajous, matriz Bark). */
  labMode: boolean
  /** Ultimo resultado del optimizador anti-enmascaramiento Bark (para matriz termica LAB). */
  lastUnmaskResult: MixUnmaskResult | null
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
  actor?: { userId: string; name: string; role: string }
  collabClient?: RealtimeClientLike | null
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

/**
 * Color por rol (fidelidad DAW, REQUERIMIENTOS_WEB_3.0.md seccion 4.2): la misma paleta, fija por
 * rol, para que la voz o la bateria se reconozcan de un vistazo en cualquier sesion. Los roles
 * genericos (otro, instrumental, sin asignar) toman el color de su posicion.
 */
const ROLE_COLORS: Readonly<Partial<Record<StemRole, string>>> = {
  vocals: '#D98E73',
  backing_vocals: '#B48EDB',
  drums: '#D9A24E',
  bass: '#7AA5D6',
  guitar: '#B8CF7A',
  keys: '#5CC8C2',
  strings: '#9AA6E0',
  wind: '#7AC4D6',
  click: '#8E97A3',
  guide: '#8E97A3',
}

/** Color de una pista: el de su rol, o el de su posicion (cabecera, clips, canal y piano roll usan el mismo). */
export function trackColor(index: number, role?: StemRole): string {
  const byRole = role ? ROLE_COLORS[role] : undefined
  if (byRole) return byRole
  return TRACK_COLORS[((index % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length]
}

/** Nombre de un archivo sin carpeta ni extension: "tomas/Voz 1.wav" -> "Voz 1". */
export function fileTitle(path: string): string {
  const base = stemBaseName(path)
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).trim() || 'Audio'
}

export const FX_ORDER: readonly StudioFxType[] = ['eq', 'compressor', 'de_esser', 'saturator', 'stereo_imager', 'limiter']

/** Cadena de efectos de una pista o del master ('master'). Pista inexistente: cadena vacia. */
export function fxChainOf(session: StudioSession, targetId: string): readonly StudioFx[] {
  if (targetId === STUDIO_MASTER_ID) return session.master.fx
  return findTrack(session, targetId)?.fx ?? []
}

/**
 * Sesion con `fx` puesto en la cadena de `targetId`: reemplaza al del mismo tipo o, si no estaba,
 * lo inserta en el orden EQ, compresor, de_esser, saturator, stereo_imager, limitador (el limitador siempre queda de ultimo).
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

const PITCH_NAMES: readonly string[] = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si']

/** Nombre de una nota MIDI en solfeo: 60 -> "Do4" (Do central, como el teclado de la computadora). */
export function pitchName(pitch: number): string {
  const p = Math.round(pitch)
  return `${PITCH_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`
}

/** true si el pitch es una tecla negra. */
export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((Math.round(pitch) % 12) + 12) % 12)
}

/** "compas.tiempo" (desde 1) de un beat de la sesion. */
export function formatBarBeat(beat: number, beatsPerBar: number): string {
  const b = Math.max(0, beat)
  const bar = Math.floor(b / beatsPerBar + 1e-9)
  const inBar = b - bar * beatsPerBar
  const whole = Math.floor(inBar + 1e-9)
  const frac = inBar - whole
  return `${bar + 1}.${whole + 1}${frac > 0.001 ? `.${Math.round(frac * 100)}` : ''}`
}

/** El navegador ofrece Web MIDI (Chrome y Edge de escritorio). */
export function midiSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && typeof (navigator as Navigator & { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
  } catch {
    return false
  }
}

/** true si el archivo es un MIDI estandar (.mid o .midi). */
export function isMidiFile(file: { name: string; type: string }): boolean {
  return /\.(mid|midi)$/i.test(file.name) || file.type === 'audio/midi' || file.type === 'audio/x-midi'
}

/** Entrega un archivo al usuario como descarga del navegador. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // El navegador ya tomo el archivo: se libera la URL un momento despues.
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Nombre de archivo seguro para descargar: sin caracteres que el sistema no admite. */
export function safeFileName(name: string, fallback: string): string {
  const clean = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean || fallback
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
  fullSong?: Song | null
  updatedBy: string | null
  cloud?: CloudTarget | null
  canEditCloud?: boolean
}

export async function createSession(input: CreateSessionInput): Promise<OpenedSession> {
  const key = input.song?.key.trim().slice(0, 12) || null
  let session = newSession({
    title: input.title,
    sampleRate: preferredSampleRate(),
    bpm: input.song ? Math.min(260, Math.max(40, input.song.bpm)) : undefined,
    beatsPerBar: input.song ? Math.min(12, Math.max(1, Math.round(input.song.beatsPerBar))) : undefined,
    key,
    songId: input.song?.id ?? null,
    updatedBy: input.updatedBy,
  })
  // Si viene la cancion completa de la libreria, poblar marcadores de seccion y acordes ChordPro de una vez.
  if (input.fullSong) {
    const seed = songToStudioSeed(input.fullSong)
    session = {
      ...session,
      markers: seed.markers,
      chords: seed.chords,
    }
  }
  const stored = await studioStore.saveSession(session, { band: input.band, etag: null, dirty: true })
  // Subida colaborativa inmediata a R2 en bandas compartidas para que el resto de la banda vea la sesion al instante.
  if (input.cloud && input.canEditCloud && input.band !== 'me') {
    try {
      const remote = await studioCloud.putSession(input.cloud, stored.session, { ifMatch: null })
      await studioStore.saveSession(remote.session, {
        band: input.band,
        etag: remote.etag,
        dirty: false,
        cloudUpdatedAt: remote.session.updatedAt,
      })
      return { session: remote.session, etag: remote.etag, dirty: false }
    } catch {
      // Sin conexion o fallo transitorio: queda guardada localmente con dirty=true para subir luego.
    }
  }
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
// Soporte de grabacion (Escritorio OPFS multipista + Movil 1-pista hasta 3 min)
// ---------------------------------------------------------------------------

/** Motivo por el que este navegador no puede grabar (sin contar el ancho de pantalla), o null. */
export async function recordingBlockReason(): Promise<string | null> {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return 'Este entorno no tiene audio.'
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
    return 'Este navegador no ofrece las funciones de micrófono y AudioWorklet que la grabación necesita.'
  }
  if ((await studioStore.storageBackend()) === 'none') {
    return 'Este navegador tiene el almacenamiento local bloqueado (¿navegación privada estricta?).'
  }
  return null
}

// ---------------------------------------------------------------------------
// Controlador
// ---------------------------------------------------------------------------

const SAVE_DEBOUNCE_MS = 700
const CLOUD_AUTOSAVE_DEBOUNCE_MS = 2500
const END_CHECK_MS = 250
const UPLOADED_PREFIX = 'bandait_studio_uploaded:'
const INPUT_KEY = 'bandait_studio_input'
const MIDI_INPUT_KEY = 'bandait_studio_midi_input'

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
  private readonly viewListeners = new Set<(command: StudioViewCommand) => void>()
  private midiInput: StudioMidiInput | null = null
  private readonly midiOffs: (() => void)[] = []
  /** pitch -> pista en la que sono la nota en vivo: su note-off va a la misma pista. */
  private readonly liveNotes = new Map<number, string>()
  /** Toma MIDI en curso; `only` = sin audio armado; `started` = ya corre en midiInput. */
  private midiRec: { trackId: string; only: boolean; started: boolean } | null = null
  /** Notas copiadas del piano roll, con la primera en el beat 0. */
  private noteClipboard: StudioMidiNote[] | null = null
  /** Clips copiados en la linea de tiempo (sessionOps.copyClips) y donde cae el proximo pegado. */
  private clipClipboard: ClipClipboard | null = null
  private pasteCursor: PasteCursor | null = null
  /** Golpes del tap tempo (ms de performance.now) y temporizador que cierra el paso de deshacer. */
  private taps: number[] = []
  private tapTimer: ReturnType<typeof setTimeout> | null = null
  /** Compases de conteo que vuelven al reactivar el conteo previo. */
  private lastCountInBars = 1
  /** Ultima medicion de mezcla (asistente de mezcla o MEDIR MEZCLA), con la version del documento. */
  private mixMeasurement: ChatMixMeasurement | null = null
  /** Cancion del repertorio ligada a la sesion (la pone la vista, que tiene la libreria). */
  private linkedSong: Song | null = null
  private readonly actor: { userId: string; name: string; role: string }
  private readonly collabClient: RealtimeClientLike | null
  private collabHandle: StudioCollabHandle | null = null
  private cloudAutoSaveTimer: ReturnType<typeof setTimeout> | null = null
  private lastCloudBase: StudioSession
  private vcsBundle: StudioVcsBundle = emptyStudioVcsBundle()
  private abWorkingBackup: StudioSession | null = null
  private widgetsToggleHandler: (() => void) | null = null

  constructor(options: StudioControllerOptions) {
    this.band = options.band
    this.cloud = options.cloud
    this.sessionId = options.session.id
    this.actor = options.actor ?? { userId: 'local', name: 'Integrante', role: 'Musician' }
    this.collabClient = options.collabClient ?? null
    this.lastCloudBase = options.session
    this.history.push(options.session)
    this.snap = {
      session: options.session,
      engine: this.engine.getState(),
      loading: { done: 0, total: 0 },
      ready: false,
      selectedClipId: null,
      selectedClipIds: [],
      selectedTrackId: null,
      editor: 'timeline',
      pianoClipId: null,
      piano: { tool: 'draw', grid: '1/16', triplets: false, snap: true, selection: [], quantizeStrength: 1, humanizeAmount: 0.4, humanizePreset: null, groove: null, drawLength: 0.25 },
      midi: {
        access: midiSupported() ? 'prompt' : 'unsupported',
        devices: [],
        deviceId: null,
        channel: 'all',
        keyboard: false,
        octave: COMPUTER_KEYBOARD_DEFAULT_OCTAVE,
        armedTrackId: null,
        quantizeOnStop: false,
      },
      freezing: null,
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
      vcs: { activeBranch: 'main', index: emptyStudioVcsBundle().index, saving: false },
      abState: null,
      collaborators: [],
      labMode: false,
      lastUnmaskResult: null,
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
    // Elegir un clip sin decir cuales quedan elegidos es elegir solo ese (seleccion simple).
    if (patch.selectedClipId !== undefined && patch.selectedClipIds === undefined) {
      patch = { ...patch, selectedClipIds: patch.selectedClipId ? [patch.selectedClipId] : [] }
    }
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
    this.collabHandle = createStudioCollabChannel({
      client: this.collabClient,
      bandId: this.band,
      initialPresence: {
        userId: this.actor.userId,
        name: this.actor.name,
        role: this.actor.role,
        sessionId: this.sessionId,
        branch: this.vcsBundle.activeBranch,
        selectedTrackId: this.snap.selectedTrackId,
      },
      onPeersChange: (peers) => {
        this.emit({ collaborators: peers.filter((p) => p.sessionId === this.sessionId || p.sessionId === null) })
      },
      onEvent: (event) => {
        void this.handleCollabEvent(event)
      },
    })
    void this.initVcs()
    try {
      await this.engine.load(this.snap.session, this.resolveAudio, (progress) => this.emit({ loading: progress }))
    } catch (err) {
      this.fail(err, 'No se pudo preparar el audio de la sesión.')
    }
    this.emit({ loading: null, ready: true, engine: this.engine.getState() })
    void this.ensurePeaks()
    void this.refreshOrphans()
    void this.restoreMidiAccess()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    if (this.cloudAutoSaveTimer) {
      clearTimeout(this.cloudAutoSaveTimer)
      this.cloudAutoSaveTimer = null
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.queueLocalSave()
    }
    if (this.tapTimer) {
      clearTimeout(this.tapTimer)
      this.tapTimer = null
    }
    this.collabHandle?.dispose()
    this.collabHandle = null
    this.disposed = true
    this.listeners.clear()
    this.frameCallbacks.clear()
    this.viewListeners.clear()
    for (const off of this.midiOffs.splice(0)) off()
    this.midiInput?.close()
    this.midiInput = null
    this.liveNotes.clear()
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
    if (this.engine.position() > playbackStopS(state.durationS, instrumentTailSeconds(this.snap.session))) this.engine.stop()
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
        const stored = await studioStore.loadPeaks(this.sessionId, asset.id).catch(() => null)
        const compute = async (): Promise<AssetPeaks> => {
          const channels = []
          for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
            channels.push(computePeaks(buffer.getChannelData(c), PEAKS_BASE_BUCKET))
            // Cede el hilo entre canales: un audio largo no congela la interfaz.
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
          const fresh: AssetPeaks = { assetId: asset.id, sampleRate: buffer.sampleRate, channels }
          void studioStore.savePeaks(this.sessionId, fresh).catch(() => undefined)
          return fresh
        }
        if (stored && stored.channels.length > 0) {
          // Se muestran ya los picos guardados. Los de antes del RMS (peaks.ts) se recalculan una
          // vez desde el audio decodificado y se vuelven a guardar con el RMS.
          this.peaks.set(asset.id, stored)
          this.emit({ peaksVersion: this.snap.peaksVersion + 1 })
          if (!peaksHaveRms(stored.channels)) {
            const upgraded = await compute()
            if (this.disposed) return
            this.peaks.set(asset.id, upgraded)
            this.emit({ peaksVersion: this.snap.peaksVersion + 1 })
          }
        } else {
          const fresh = await compute()
          if (this.disposed) return
          this.peaks.set(asset.id, fresh)
          this.emit({ peaksVersion: this.snap.peaksVersion + 1 })
        }
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

  /**
   * Un paso de deshacer. Devuelve false si no cambio nada. `extra` cambia a la vez otros datos de
   * la foto (por ejemplo, la seleccion de notas que deja una edicion del piano roll).
   */
  apply(next: StudioSession, label: string, extra: Partial<StudioSnapshot> = {}): boolean {
    if (next === this.snap.session) {
      if (Object.keys(extra).length > 0) this.emit(extra)
      return false
    }
    this.history.push(next, label)
    this.setSession(next, true, extra)
    return true
  }

  /** `apply` con una operacion que puede lanzar (StudioSessionError): el error se muestra. */
  run(label: string, operation: (session: StudioSession) => StudioSession, extra: Partial<StudioSnapshot> = {}): boolean {
    try {
      return this.apply(operation(this.snap.session), label, extra)
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

  private setSession(next: StudioSession, save = true, extra: Partial<StudioSnapshot> = {}): void {
    this.editCount++
    if (save && this.snap.abState?.active === 'B') {
      this.abWorkingBackup = null
      extra = { ...extra, abState: { ...this.snap.abState, active: 'A' } }
    }
    const exists = (id: string) => findClip(next, id) !== null || findMidiClip(next, id) !== null
    const wantedClip = extra.selectedClipId !== undefined ? extra.selectedClipId : this.snap.selectedClipId
    const wantedIds = extra.selectedClipIds ?? (extra.selectedClipId !== undefined ? (extra.selectedClipId ? [extra.selectedClipId] : []) : this.snap.selectedClipIds)
    const keptIds = wantedIds.filter(exists)
    let selectedClipId = wantedClip && exists(wantedClip) ? wantedClip : null
    // Si el principal desaparecio pero quedan otros elegidos, el principal pasa al primero.
    if (selectedClipId === null && keptIds.length > 0) selectedClipId = keptIds[0]
    if (selectedClipId !== null && !keptIds.includes(selectedClipId)) keptIds.push(selectedClipId)
    const current = this.snap.selectedClipIds
    const selectedClipIds = keptIds.length === current.length && keptIds.every((id, i) => id === current[i]) ? current : keptIds
    const wantedTrack = extra.selectedTrackId !== undefined ? extra.selectedTrackId : this.snap.selectedTrackId
    const selectedTrackId = wantedTrack && findTrack(next, wantedTrack) ? wantedTrack : null
    let arms = this.snap.arms
    if (Object.keys(arms).some((trackId) => findTrack(next, trackId)?.kind !== 'audio')) {
      arms = Object.fromEntries(Object.entries(arms).filter(([trackId]) => findTrack(next, trackId)?.kind === 'audio'))
    }
    // El piano roll se cierra si su clip ya no existe; la seleccion de notas se acota a las que hay.
    const wantedPiano = extra.pianoClipId !== undefined ? extra.pianoClipId : this.snap.pianoClipId
    const pianoLoc = wantedPiano ? findMidiClip(next, wantedPiano) : null
    const piano = extra.piano ?? this.snap.piano
    const noteCount = pianoLoc?.clip.notes.length ?? 0
    const selection = piano.selection.every((index) => index < noteCount) ? piano.selection : piano.selection.filter((index) => index < noteCount)
    const armedTrack = this.snap.midi.armedTrackId ? findTrack(next, this.snap.midi.armedTrackId) : null
    const midi = this.snap.midi.armedTrackId && armedTrack?.kind !== 'instrument' ? { ...this.snap.midi, armedTrackId: null } : this.snap.midi
    this.emit({
      ...extra,
      session: next,
      selectedClipId,
      selectedClipIds,
      selectedTrackId,
      arms,
      pianoClipId: pianoLoc ? pianoLoc.clip.id : null,
      editor: pianoLoc ? (extra.editor ?? this.snap.editor) : 'timeline',
      piano: selection === piano.selection ? piano : { ...piano, selection },
      midi,
      ...this.historyPatch(),
    })
    this.syncEngine(next)
    if (save) this.scheduleSave()
  }

  undo(): void {
    if (this.snap.recording) return
    const previous = this.history.undo()
    if (previous) this.setSession(previous, true, { piano: { ...this.snap.piano, selection: [] } })
  }

  redo(): void {
    if (this.snap.recording) return
    const next = this.history.redo()
    if (next) this.setSession(next, true, { piano: { ...this.snap.piano, selection: [] } })
  }

  /** Pista de un clip de audio o MIDI, o null. */
  private trackOfClip(clipId: string): string | null {
    const session = this.snap.session
    return findClip(session, clipId)?.track.id ?? findMidiClip(session, clipId)?.track.id ?? null
  }

  /** Elige un clip (de audio o MIDI) y su pista, y solo ese. null quita la eleccion de clips. */
  select(clipId: string | null): void {
    if (clipId === this.snap.selectedClipId && this.snap.selectedClipIds.length <= 1) return
    const trackId = clipId ? (this.trackOfClip(clipId) ?? this.snap.selectedTrackId) : this.snap.selectedTrackId
    this.emit({ selectedClipId: clipId, selectedTrackId: trackId })
    this.collabHandle?.updatePresence({ selectedTrackId: trackId })
  }

  /** Shift o Ctrl + clic: agrega el clip a la seleccion, o lo quita si ya estaba. */
  toggleClipSelection(clipId: string): void {
    const ids = this.snap.selectedClipIds
    if (ids.includes(clipId)) {
      const rest = ids.filter((id) => id !== clipId)
      const primary = rest.length === 0 ? null : this.snap.selectedClipId === clipId ? rest[rest.length - 1] : this.snap.selectedClipId
      this.emit({ selectedClipIds: rest, selectedClipId: primary })
      return
    }
    const trackId = this.trackOfClip(clipId)
    if (!trackId) return
    this.emit({ selectedClipIds: [...ids, clipId], selectedClipId: clipId, selectedTrackId: trackId })
  }

  /** Hace principal un clip que ya esta elegido, sin soltar a los demas (arrastre de varios). */
  focusSelectedClip(clipId: string): void {
    if (!this.snap.selectedClipIds.includes(clipId) || this.snap.selectedClipId === clipId) return
    this.emit({ selectedClipId: clipId, selectedClipIds: this.snap.selectedClipIds, selectedTrackId: this.trackOfClip(clipId) ?? this.snap.selectedTrackId })
  }

  /** Elige varios clips; el principal es `primary` o el primero. Los ids que no existen se ignoran. */
  selectClips(clipIds: readonly string[], primary?: string): void {
    const session = this.snap.session
    const ids = [...new Set(clipIds)].filter((id) => findClip(session, id) || findMidiClip(session, id))
    const main = primary && ids.includes(primary) ? primary : (ids[0] ?? null)
    this.emit({ selectedClipIds: ids, selectedClipId: main, selectedTrackId: main ? (this.trackOfClip(main) ?? this.snap.selectedTrackId) : this.snap.selectedTrackId })
  }

  /** Ctrl+A en la linea de tiempo: todos los clips que suenan (las tomas alternativas no). */
  selectAllClips(): void {
    const ids = this.snap.session.tracks.flatMap((track) => [...track.clips.filter((clip) => clip.active).map((clip) => clip.id), ...track.midiClips.map((clip) => clip.id)])
    const primary = this.snap.selectedClipId && ids.includes(this.snap.selectedClipId) ? this.snap.selectedClipId : undefined
    this.selectClips(ids, primary)
  }

  /** Elige una pista (cabecera o fila vacia de la linea de tiempo). */
  selectTrack(trackId: string | null): void {
    if (trackId === this.snap.selectedTrackId) return
    if (trackId !== null && !findTrack(this.snap.session, trackId)) return
    this.emit({ selectedTrackId: trackId })
    this.collabHandle?.updatePresence({ selectedTrackId: trackId })
  }

  /** Pista elegida por posicion relativa (flechas arriba y abajo en la linea de tiempo). */
  selectAdjacentTrack(direction: -1 | 1): void {
    const tracks = this.snap.session.tracks
    if (tracks.length === 0) return
    const at = tracks.findIndex((track) => track.id === this.snap.selectedTrackId)
    const next = at < 0 ? (direction > 0 ? 0 : tracks.length - 1) : Math.min(tracks.length - 1, Math.max(0, at + direction))
    this.selectTrack(tracks[next].id)
  }

  // ---- vista: editor activo y zoom ----

  /** El editor activo escucha los pedidos de vista (zoom del registro de comandos). */
  onViewCommand(listener: (command: StudioViewCommand) => void): () => void {
    this.viewListeners.add(listener)
    return () => {
      this.viewListeners.delete(listener)
    }
  }

  private viewCommand(command: StudioViewCommand): void {
    for (const listener of [...this.viewListeners]) listener(command)
  }

  zoomIn(): void {
    this.viewCommand({ type: 'zoom', direction: 1 })
  }

  zoomOut(): void {
    this.viewCommand({ type: 'zoom', direction: -1 })
  }

  /** Zoom para ver toda la sesion (Shift+Z). */
  zoomToFit(): void {
    this.viewCommand({ type: 'fit' })
  }

  /** Lleva la vista al cabezal (Shift+C). */
  centerOnPlayhead(): void {
    this.viewCommand({ type: 'center' })
  }

  /** F2: pone el foco en el nombre de la pista elegida para escribir uno nuevo. */
  renameSelectedTrack(): void {
    const trackId = this.snap.selectedTrackId
    if (!trackId || !findTrack(this.snap.session, trackId)) {
      this.notify('info', 'Elige una pista (clic en su cabecera o con las teclas 1 a 9) para renombrarla.')
      return
    }
    if (this.snap.editor !== 'timeline') this.showTimeline()
    this.viewCommand({ type: 'rename_track', trackId })
  }

  /** Abre un clip MIDI en el piano roll (por defecto el clip elegido). */
  openPianoRoll(clipId?: string): boolean {
    const id = clipId ?? this.snap.selectedClipId
    const loc = id ? findMidiClip(this.snap.session, id) : null
    if (!loc) {
      this.notify('info', 'Elige un clip MIDI (o crea uno con doble clic en una pista de instrumento) para abrir el piano roll.')
      return false
    }
    const sameClip = loc.clip.id === this.snap.pianoClipId
    this.emit({
      editor: 'piano_roll',
      pianoClipId: loc.clip.id,
      selectedClipId: loc.clip.id,
      selectedTrackId: loc.track.id,
      piano: sameClip ? this.snap.piano : { ...this.snap.piano, selection: [] },
    })
    return true
  }

  showTimeline(): void {
    if (this.snap.editor !== 'timeline') this.emit({ editor: 'timeline' })
  }

  /** Tab: alterna la linea de tiempo y el piano roll del clip MIDI elegido (o del ultimo abierto). */
  toggleEditor(): void {
    if (this.snap.editor === 'piano_roll') {
      this.showTimeline()
      return
    }
    const selected = this.snap.selectedClipId && findMidiClip(this.snap.session, this.snap.selectedClipId) ? this.snap.selectedClipId : null
    if (selected) {
      this.openPianoRoll(selected)
      return
    }
    // Sin clip MIDI elegido: el ultimo abierto, o el primero de la pista de instrumento elegida.
    const track = this.snap.selectedTrackId ? findTrack(this.snap.session, this.snap.selectedTrackId) : null
    const fallback = this.snap.pianoClipId ?? (track?.kind === 'instrument' ? (track.midiClips[0]?.id ?? null) : null)
    this.openPianoRoll(fallback ?? undefined)
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

  /** Ids de los clips elegidos que todavia existen. */
  selectedClips(): string[] {
    const session = this.snap.session
    return this.snap.selectedClipIds.filter((id) => findClip(session, id) || findMidiClip(session, id))
  }

  /**
   * Nombre del paso de deshacer para una accion sobre clips: "Borrar clip", "Borrar clip MIDI" o
   * "Borrar 3 clips".
   */
  private clipsLabel(verb: string, clipIds: readonly string[]): string {
    if (clipIds.length !== 1) return `${verb} ${clipIds.length} clips`
    return findMidiClip(this.snap.session, clipIds[0]) ? `${verb} clip MIDI` : `${verb} clip`
  }

  /**
   * Clips sobre los que actuan dividir, recortar y los fundidos: los elegidos; sin eleccion, los
   * de la pista elegida que el cabezal cruza; sin pista elegida, los de todas las pistas.
   */
  private clipsAtPlayhead(atS: number): string[] {
    const chosen = this.selectedClips()
    if (chosen.length > 0) return chosen
    const session = this.snap.session
    const atBeat = secondsToBeats(atS, session.bpm)
    const track = this.snap.selectedTrackId ? findTrack(session, this.snap.selectedTrackId) : null
    const tracks = track ? [track] : session.tracks
    return tracks.flatMap((t) => [
      ...t.clips.filter((clip) => clip.active && atS > clip.startS && atS < clip.startS + clip.lengthS).map((clip) => clip.id),
      ...t.midiClips.filter((clip) => atBeat > clip.startBeat && atBeat < clip.startBeat + clip.lengthBeats).map((clip) => clip.id),
    ])
  }

  /**
   * S: divide en el cabezal los clips elegidos; sin eleccion, los de la pista elegida que cruza
   * el cabezal (y sin pista elegida, los de todas las pistas).
   */
  splitAtPlayhead(): void {
    const atS = this.engine.position()
    const ids = this.clipsAtPlayhead(atS)
    if (ids.length === 0) return
    this.run('Dividir clip', (session) => {
      const atBeat = secondsToBeats(atS, session.bpm)
      let next = session
      for (const clipId of ids) {
        if (findClip(next, clipId)) next = splitClip(next, { clipId, atS, newClipId: newStudioId('clp') })
        else if (findMidiClip(next, clipId)) next = splitMidiClip(next, { clipId, atBeat, newClipId: newStudioId('mid') })
      }
      return next
    })
  }

  /** Ctrl+D: copia los clips elegidos justo detras del bloque que forman; quedan elegidas las copias. */
  duplicateSelected(): void {
    const ids = this.selectedClips()
    const session = this.snap.session
    const board = copyClips(session, ids)
    if (!board) return
    let result: ReturnType<typeof pasteClips>
    try {
      result = pasteClips(session, board, { atS: board.startS + board.spanS, trackId: null, newClipId: (kind) => newStudioId(kind === 'audio' ? 'clp' : 'mid') })
    } catch (err) {
      this.fail(err)
      return
    }
    const primary = result.clipIds[result.clipIds.length - 1] ?? null
    this.apply(result.session, this.clipsLabel('Duplicar', ids), { selectedClipIds: result.clipIds, selectedClipId: primary })
  }

  /** Supr: borra todos los clips elegidos (un paso de deshacer). */
  deleteSelected(): void {
    const ids = this.selectedClips()
    if (ids.length === 0) return
    this.run(this.clipsLabel('Borrar', ids), (session) => deleteClips(session, ids))
  }

  // ---- portapapeles de clips (linea de tiempo) ----

  /** Hay clips copiados para pegar. */
  hasClipClipboard(): boolean {
    return this.clipClipboard !== null && this.clipClipboard.items.length > 0
  }

  /** Ctrl+C en la linea de tiempo: copia los clips elegidos. false si no habia ninguno. */
  copyClips(): boolean {
    const board = copyClips(this.snap.session, this.selectedClips())
    if (!board || board.items.length === 0) return false
    this.clipClipboard = board
    this.pasteCursor = pasteCursorAfterCopy(board, this.engine.position())
    return true
  }

  /**
   * Ctrl+X: copia y borra. Pegar sin mover el cabezal devuelve los clips a su lugar; con el cabezal
   * en otro sitio, los pone ahi (cortar y pegar = mover).
   */
  cutClips(): void {
    const ids = this.selectedClips()
    if (!this.copyClips() || !this.clipClipboard) return
    this.pasteCursor = { playheadS: this.engine.position(), nextS: this.clipClipboard.startS }
    this.run(this.clipsLabel('Cortar', ids), (session) => deleteClips(session, ids))
  }

  /**
   * Ctrl+V: pega en la misma pista de lo copiado (o en la pista elegida si todo salio de una sola
   * y es compatible), en el cabezal si se movio desde que se copio; si no, justo detras del
   * original. Pegar otra vez sin mover el cabezal pone la copia detras de la anterior.
   */
  pasteClips(): void {
    const board = this.clipClipboard
    if (!board || board.items.length === 0) return
    const playhead = this.engine.position()
    const { atS, cursor } = pastePosition(board, this.pasteCursor ?? pasteCursorAfterCopy(board, playhead), playhead)
    let result: ReturnType<typeof pasteClips>
    try {
      result = pasteClips(this.snap.session, board, { atS, trackId: this.snap.selectedTrackId, newClipId: (kind) => newStudioId(kind === 'audio' ? 'clp' : 'mid') })
    } catch (err) {
      this.fail(err)
      return
    }
    const label = board.items.length === 1 ? (board.items[0].kind === 'midi' ? 'Pegar clip MIDI' : 'Pegar clip') : `Pegar ${board.items.length} clips`
    if (this.apply(result.session, label, { selectedClipIds: result.clipIds, selectedClipId: result.clipIds[result.clipIds.length - 1] ?? null })) this.pasteCursor = cursor
  }

  /** Unir (Shift+J): funde los clips MIDI elegidos de cada pista, o trozos seguidos de un mismo audio. */
  joinSelected(): void {
    const ids = this.selectedClips()
    let result: ReturnType<typeof joinClips>
    try {
      result = joinClips(this.snap.session, ids)
    } catch (err) {
      this.fail(err)
      return
    }
    if (result.session === this.snap.session) {
      this.notify('info', 'Para unir, elige dos o más clips MIDI de una misma pista (Shift + clic), o trozos seguidos de un mismo audio.')
      return
    }
    this.apply(result.session, 'Unir clips', { selectedClipIds: result.clipIds, selectedClipId: result.clipIds[0] ?? null })
  }

  /** Alt+[ y Alt+]: recorta el inicio o el final de los clips al cabezal. */
  trimSelectedToPlayhead(edge: 'start' | 'end'): void {
    const atS = this.engine.position()
    const ids = this.clipsAtPlayhead(atS)
    const before = this.snap.session
    this.run(edge === 'start' ? 'Recortar inicio al cabezal' : 'Recortar final al cabezal', (session) => trimClipsAt(session, ids, edge, atS))
    if (this.snap.session === before) this.notify('info', 'El cabezal tiene que estar dentro del clip para recortarlo ahí.')
  }

  /** Fundido de entrada (del inicio al cabezal) o de salida (del cabezal al final) en los clips de audio. */
  fadeSelectedToPlayhead(edge: 'in' | 'out'): void {
    const atS = this.engine.position()
    const ids = this.clipsAtPlayhead(atS)
    const before = this.snap.session
    this.run(edge === 'in' ? 'Fundido de entrada' : 'Fundido de salida', (session) => fadeClipsAt(session, ids, edge, atS))
    if (this.snap.session === before) this.notify('info', 'Pon el cabezal dentro de un clip de audio: el fundido va del borde del clip al cabezal.')
  }

  /** 0: silencia los clips elegidos (audio y MIDI), o los vuelve a hacer sonar. */
  toggleSelectedClipsMute(): void {
    const session = this.snap.session
    const ids = this.selectedClips()
    if (ids.length === 0) {
      this.notify('info', 'Elige uno o más clips para silenciarlos (0).')
      return
    }
    const silence = ids.some((id) => {
      const audio = findClip(session, id)
      if (audio) return audio.clip.active
      const midi = findMidiClip(session, id)
      return midi !== null && !midi.clip.muted
    })
    this.run(this.clipsLabel(silence ? 'Silenciar' : 'Hacer sonar', ids), (current) => toggleClipsActive(current, ids))
  }

  /** Ctrl+L: loop con el rango de la seleccion (clips elegidos, o notas elegidas en el piano roll). */
  loopSelection(): void {
    const session = this.snap.session
    let range: { startS: number; endS: number } | null
    const loc = this.snap.editor === 'piano_roll' ? this.pianoClip() : null
    if (loc) {
      const picked = this.snap.piano.selection.map((index) => loc.clip.notes[index]).filter(Boolean)
      const from = picked.length > 0 ? Math.min(...picked.map((n) => n.start)) : 0
      const to = picked.length > 0 ? Math.max(...picked.map((n) => n.start + n.length)) : loc.clip.lengthBeats
      range = { startS: beatsToSeconds(loc.clip.startBeat + from, session.bpm), endS: beatsToSeconds(loc.clip.startBeat + Math.min(to, loc.clip.lengthBeats), session.bpm) }
    } else {
      range = clipsRangeS(session, this.selectedClips())
    }
    if (!range || range.endS - range.startS < 0.05) {
      this.notify('info', 'Elige uno o más clips (o notas en el piano roll) para hacer loop con su rango.')
      return
    }
    this.setLoop({ startS: range.startS, endS: range.endS })
  }

  /** Clip MIDI nuevo y vacio en una pista de instrumento. Devuelve su id, o null si no se pudo. */
  addMidiClipAt(trackId: string, startBeat: number, lengthBeats?: number): string | null {
    const session = this.snap.session
    const track = findTrack(session, trackId)
    if (!track || track.kind !== 'instrument') {
      this.notify('warn', 'Los clips MIDI van en pistas de instrumento. Crea una con el botón INSTRUMENTO.')
      return null
    }
    const id = newStudioId('mid')
    const length = lengthBeats ?? session.beatsPerBar
    const ok = this.run('Agregar clip MIDI', (current) => addMidiClip(current, { trackId, clip: defaultMidiClip({ id, startBeat: Math.max(0, startBeat), lengthBeats: length }) }), {
      selectedClipId: id,
      selectedTrackId: trackId,
    })
    return ok ? id : null
  }

  /**
   * Clip MIDI de 4 compases en el compas del cabezal, en la pista de instrumento elegida (o la
   * primera que haya). Devuelve su id.
   */
  addMidiClipAtPlayhead(): string | null {
    const session = this.snap.session
    const picked = this.snap.selectedTrackId ? findTrack(session, this.snap.selectedTrackId) : null
    const track = picked?.kind === 'instrument' ? picked : session.tracks.find((t) => t.kind === 'instrument')
    if (!track) {
      this.notify('warn', 'No hay pistas de instrumento. Crea una con el botón INSTRUMENTO.')
      return null
    }
    const beat = secondsToBeats(this.engine.position(), session.bpm)
    const bar = Math.floor(beat / session.beatsPerBar + 1e-9) * session.beatsPerBar
    return this.addMidiClipAt(track.id, bar, session.beatsPerBar * 4)
  }

  activateTake(clipId: string): void {
    this.run('Elegir toma', (session) => setActiveTake(session, { clipId }))
  }

  /**
   * Mueve los clips elegidos un paso de la rejilla (o 10 ms sin rejilla; un cuarto de beat si el
   * principal es MIDI). El principal cae en la rejilla y los demas lo acompanan con la misma
   * distancia. Alternativa de teclado al arrastre.
   */
  nudgeSelected(direction: -1 | 1): void {
    const ids = this.selectedClips()
    const primary = this.snap.selectedClipId
    if (ids.length === 0 || !primary) return
    const session = this.snap.session
    const range = clipsRangeS(session, [primary])
    if (!range) return
    const mode = this.snap.snap
    const beatS = 60 / session.bpm
    const isMidi = findMidiClip(session, primary) !== null
    const step = mode === 'bar' ? beatS * session.beatsPerBar : mode === 'beat' ? beatS : isMidi ? beatS / 4 : 0.01
    let target = Math.max(0, range.startS + direction * step)
    if (mode !== 'off') target = snapTime(session, { timeS: target, mode })
    else if (isMidi) target = Math.round(target / step) * step
    const delta = target - range.startS
    this.run(this.clipsLabel('Mover', ids), (current) => moveClipsBy(current, ids, delta))
  }

  // ---- piano roll ----
  //
  // Toda edicion de notas pasa por `editNotes` (un paso de deshacer con la seleccion nueva). Las
  // funciones de abajo son las que conectan los comandos del registro (parte 2): transponer,
  // mover, cuantizar, legato, duplicar, borrar, copiar y pegar actuan sobre la seleccion del clip
  // abierto; sin seleccion, transponer, cuantizar y legato actuan sobre todas las notas.

  /** Clip abierto en el piano roll, o null. */
  pianoClip(): MidiClipLocation | null {
    const id = this.snap.pianoClipId
    return id ? findMidiClip(this.snap.session, id) : null
  }

  setPiano(patch: Partial<Omit<PianoRollState, 'selection'>>): void {
    const piano = this.snap.piano
    const next = { ...piano, ...patch }
    if (Object.keys(patch).every((key) => piano[key as keyof PianoRollState] === next[key as keyof PianoRollState])) return
    this.emit({ piano: next })
  }

  setPianoTool(tool: PianoTool): void {
    this.setPiano({ tool })
  }

  /** Paso de la rejilla del piano roll en beats (con tresillos, 2/3). */
  pianoGridBeats(): number {
    return gridBeats(this.snap.piano.grid, this.snap.piano.triplets)
  }

  selectNotes(selection: NoteSelection): void {
    const loc = this.pianoClip()
    const count = loc?.clip.notes.length ?? 0
    const clean = [...new Set(selection)].filter((index) => Number.isInteger(index) && index >= 0 && index < count).sort((a, b) => a - b)
    const current = this.snap.piano.selection
    if (clean.length === current.length && clean.every((index, i) => index === current[i])) return
    this.emit({ piano: { ...this.snap.piano, selection: clean } })
  }

  selectAllNotes(): void {
    const loc = this.pianoClip()
    if (loc) this.selectNotes(loc.clip.notes.map((_note, index) => index))
  }

  clearNoteSelection(): void {
    this.selectNotes([])
  }

  /**
   * Edita las notas del clip abierto con una operacion de midiOps (un paso de deshacer). La
   * operacion recibe las notas, el largo del clip y la seleccion; devuelve el resultado o null
   * si no hay nada que hacer.
   */
  editNotes(label: string, edit: (notes: readonly StudioMidiNote[], clipLengthBeats: number, selection: NoteSelection) => MidiEditResult | null): boolean {
    const loc = this.pianoClip()
    if (!loc || this.snap.recording) return false
    let result: MidiEditResult | null
    try {
      result = edit(loc.clip.notes, loc.clip.lengthBeats, this.snap.piano.selection)
    } catch (err) {
      this.fail(err)
      return false
    }
    if (!result) return false
    const notes = result.notes
    return this.run(label, (session) => updateMidiClip(session, { clipId: loc.clip.id, patch: { notes } }), { piano: { ...this.snap.piano, selection: result.selection } })
  }

  /** Selection o null (= todas) para las operaciones que admiten las dos. */
  private selectionOrAll(): NoteSelection | null {
    return this.snap.piano.selection.length > 0 ? this.snap.piano.selection : null
  }

  transposeNotes(semitones: number): void {
    const selection = this.selectionOrAll()
    const label = Math.abs(semitones) === 12 ? 'Transponer una octava' : 'Transponer notas'
    this.editNotes(label, (notes, length) => (notes.length === 0 ? null : transpose(notes, selection, semitones, length)))
  }

  /** Mueve las notas elegidas un paso de la rejilla. */
  nudgeNotes(direction: -1 | 1): void {
    const step = this.pianoGridBeats()
    this.editNotes('Mover notas', (notes, length, selection) => (selection.length === 0 ? null : moveNotes(notes, selection, direction * step, 0, length)))
  }

  quantizeNotes(): void {
    const { grid, triplets, quantizeStrength } = this.snap.piano
    const selection = this.selectionOrAll()
    this.editNotes('Cuantizar notas', (notes, length) => (notes.length === 0 ? null : quantize(notes, selection, { grid, triplets, strength: quantizeStrength }, length)))
  }

  /**
   * Opciones por defecto de humanizar (boton del piano roll y H en la linea de tiempo): el ultimo
   * preset elegido en el popover con la intensidad del deslizador.
   */
  private defaultHumanizeOptions(): HumanizeOptions {
    const { humanizeAmount, humanizePreset } = this.snap.piano
    return { amount: humanizeAmount, ...(humanizePreset ? { preset: humanizePreset } : {}) }
  }

  /** Recuerda el preset elegido en el popover (para H y el boton rapido). */
  setHumanizePreset(preset: HumanizePresetId | null): void {
    this.setPiano({ humanizePreset: preset })
  }

  humanizeNotes(options?: HumanizeOptions): void {
    const opts: HumanizeOptions = options ?? this.defaultHumanizeOptions()
    const selection = this.selectionOrAll()
    const loc = this.pianoClip()
    if (!loc) return
    // Fase del clip en la sesion, tempo (ms -> beats), compas y bateria por instrumento.
    const context = humanizeClipContext(this.snap.session, loc)
    this.editNotes('Humanizar notas', (notes, length) => (notes.length === 0 ? null : humanize(notes, selection, { ...context, ...opts }, length)))
  }

  legatoNotes(): void {
    const selection = this.selectionOrAll()
    this.editNotes('Legato', (notes, length) => (notes.length < 2 ? null : legato(notes, selection, length)))
  }

  /** Copia la seleccion justo despues de su ultima nota (ajustado a la rejilla). */
  duplicateNotes(): void {
    const step = this.pianoGridBeats()
    this.editNotes('Duplicar notas', (notes, length, selection) => {
      if (selection.length === 0) return null
      const picked = selection.map((index) => notes[index]).filter(Boolean)
      const first = Math.min(...picked.map((n) => n.start))
      const last = Math.max(...picked.map((n) => n.start + n.length))
      const offset = Math.max(step, Math.ceil((last - first) / step - 1e-9) * step)
      return duplicateNotes(notes, selection, offset, length)
    })
  }

  deleteNotes(): void {
    this.editNotes('Borrar notas', (notes, _length, selection) => (selection.length === 0 ? null : { notes: removeNotes(notes, selection), selection: [] }))
  }

  setNotesVelocity(value: number, mode: 'set' | 'add' | 'scale' = 'set'): void {
    const selection = this.selectionOrAll()
    this.editNotes('Velocidad de notas', (notes) => (notes.length === 0 ? null : setVelocity(notes, selection, value, mode)))
  }

  /** Corta en el cabezal las notas elegidas (o todas) que lo cruzan. */
  splitNotesAtPlayhead(): void {
    const loc = this.pianoClip()
    if (!loc) return
    const at = secondsToBeats(this.engine.position(), this.snap.session.bpm) - loc.clip.startBeat
    if (!(at > 0 && at < loc.clip.lengthBeats)) {
      this.notify('info', 'El cabezal está fuera del clip abierto: no hay notas que cortar ahí.')
      return
    }
    const selection = this.selectionOrAll()
    this.editNotes('Cortar notas', (notes, length) => splitNotesAt(notes, selection, at, length))
  }

  copyNotes(): boolean {
    const loc = this.pianoClip()
    const selection = this.snap.piano.selection
    if (!loc || selection.length === 0) return false
    const picked = selection.map((index) => loc.clip.notes[index]).filter(Boolean)
    const first = Math.min(...picked.map((n) => n.start))
    this.noteClipboard = picked.map((n) => ({ ...n, start: roundBeat(n.start - first) }))
    return true
  }

  cutNotes(): void {
    if (this.copyNotes()) this.deleteNotes()
  }

  /** Pega las notas copiadas en el cabezal (si cae dentro del clip) o al inicio del clip. */
  pasteNotes(): void {
    const copied = this.noteClipboard
    const loc = this.pianoClip()
    if (!copied || copied.length === 0 || !loc) return
    const rel = secondsToBeats(this.engine.position(), this.snap.session.bpm) - loc.clip.startBeat
    const step = this.pianoGridBeats()
    const at = rel >= 0 && rel < loc.clip.lengthBeats ? Math.floor(rel / step + 1e-9) * step : 0
    this.editNotes('Pegar notas', (notes, length) => addNotes(notes, copied.map((n) => ({ ...n, start: roundBeat(n.start + at) })), length))
  }

  /** Escucha una nota en el instrumento de la pista del piano roll (o de la pista elegida). */
  previewPitch(pitch: number, velocity = 100): void {
    const trackId = this.pianoClip()?.track.id ?? this.snap.selectedTrackId
    if (trackId) this.engine.previewNote(trackId, pitch, velocity)
  }

  // ---- edicion segun el editor activo (comandos globales de la parte 2) ----

  /** Supr: notas elegidas en el piano roll, o el clip elegido en la linea de tiempo. */
  deleteSelection(): void {
    if (this.snap.editor === 'piano_roll') this.deleteNotes()
    else this.deleteSelected()
  }

  duplicateSelection(): void {
    if (this.snap.editor === 'piano_roll') this.duplicateNotes()
    else this.duplicateSelected()
  }

  /** S: corta notas en el piano roll; divide clips en la linea de tiempo. */
  splitSelection(): void {
    if (this.snap.editor === 'piano_roll') this.splitNotesAtPlayhead()
    else this.splitAtPlayhead()
  }

  /** Q: cuantiza las notas del piano roll, o los clips MIDI elegidos enteros en la linea de tiempo. */
  quantizeSelection(): void {
    if (this.snap.editor === 'piano_roll') {
      this.quantizeNotes()
      return
    }
    const midiIds = this.selectedClips().filter((id) => findMidiClip(this.snap.session, id))
    if (midiIds.length === 0) {
      this.notify('info', 'Cuantizar actúa sobre clips MIDI: elígelos en la línea de tiempo o abre uno en el piano roll.')
      return
    }
    const { grid, triplets, quantizeStrength } = this.snap.piano
    this.run(midiIds.length === 1 ? 'Cuantizar clip MIDI' : `Cuantizar ${midiIds.length} clips MIDI`, (session) => {
      let next = session
      for (const clipId of midiIds) {
        const loc = findMidiClip(next, clipId)
        if (!loc) continue
        next = updateMidiClip(next, { clipId, patch: { notes: quantize(loc.clip.notes, null, { grid, triplets, strength: quantizeStrength }, loc.clip.lengthBeats).notes } })
      }
      return next
    })
  }

  /** H: humaniza tiempo, velocidad y duracion en el piano roll, o los clips MIDI elegidos en la linea de tiempo. */
  humanizeSelection(options?: HumanizeOptions): void {
    if (this.snap.editor === 'piano_roll') {
      this.humanizeNotes(options)
      return
    }
    const midiIds = this.selectedClips().filter((id) => findMidiClip(this.snap.session, id))
    if (midiIds.length === 0) {
      this.notify('info', 'Humanizar actúa sobre clips MIDI: elígelos en la línea de tiempo o abre uno en el piano roll.')
      return
    }
    const opts: HumanizeOptions = options ?? this.defaultHumanizeOptions()
    this.run(midiIds.length === 1 ? 'Humanizar clip MIDI' : `Humanizar ${midiIds.length} clips MIDI`, (session) => {
      let next = session
      for (const clipId of midiIds) {
        const loc = findMidiClip(next, clipId)
        if (!loc) continue
        next = updateMidiClip(next, {
          clipId,
          patch: { notes: humanize(loc.clip.notes, null, { ...humanizeClipContext(next, loc), ...opts }, loc.clip.lengthBeats).notes },
        })
      }
      return next
    })
  }

  // -------------------------------------------------------------------------
  // Groove de la banda: plantilla tomada de un clip de audio y aplicada a notas MIDI (groove.ts).

  /** Clips de audio de la sesion de los que se puede tomar un groove (para el popover). */
  grooveSourceClips(): Array<{ clipId: string; label: string }> {
    const out: Array<{ clipId: string; label: string }> = []
    const { session } = this.snap
    for (const track of session.tracks) {
      if (track.kind !== 'audio') continue
      for (const clip of track.clips) {
        if (clip.active === false) continue
        const bar = Math.floor(secondsToBeats(clip.startS, session.bpm) / Math.max(1, session.beatsPerBar)) + 1
        out.push({ clipId: clip.id, label: `${track.name} · compás ${bar} (${Math.round(clip.lengthS)} s)` })
      }
    }
    return out
  }

  /**
   * Toma el groove de un clip de audio (por id, o el clip de audio elegido en la linea de tiempo):
   * ataques, desplazamiento mediano y velocidad relativa por paso de la rejilla, de hasta 60 s.
   */
  captureGrooveFromClip(clipId?: string, grid: GrooveGrid = '1/16'): StudioGrooveTemplate | null {
    const session = this.snap.session
    const id = clipId ?? this.selectedClips().find((c) => findClip(session, c) !== null)
    const loc = id ? findClip(session, id) : null
    if (!loc) {
      this.notify('info', 'Elige un clip de audio (por ejemplo, la batería grabada) para tomar su groove.')
      return null
    }
    const seg = this.getClipSegmentChannels(loc.clip)
    if (!seg) {
      this.notify('warn', 'El audio de ese clip todavía no está cargado.')
      return null
    }
    const limit = Math.min(seg.channels[0].length, Math.round(seg.sampleRate * 60))
    const mono = downmixMono(seg.channels.map((ch) => ch.subarray(0, limit)))
    let template: StudioGrooveTemplate | null
    try {
      template = grooveFromAudio(mono, seg.sampleRate, {
        clipStartS: loc.clip.startS,
        bpm: session.bpm,
        beatsPerBar: session.beatsPerBar,
        grid,
        label: loc.track.name,
        sourceClipId: loc.clip.id,
      })
    } catch (err) {
      this.fail(err)
      return null
    }
    if (!template) {
      this.notify('warn', 'No hay suficientes golpes claros en ese clip para tomar un groove (hacen falta al menos 8).')
      return null
    }
    this.setPiano({ groove: template })
    this.notify('info', `Groove tomado: ${describeGroove(template)}.`)
    return template
  }

  /** Olvida la plantilla de groove. */
  clearGroove(): void {
    this.setPiano({ groove: null })
  }

  /**
   * Aplica el groove tomado a las notas elegidas del piano roll (todas si no hay seleccion) o a
   * los clips MIDI elegidos en la linea de tiempo. `strength` cuantiza hacia la plantilla (0..1).
   */
  applyGroove(options: { strength?: number; velocityStrength?: number } = {}): void {
    const template = this.snap.piano.groove
    if (!template) {
      this.notify('info', 'Primero toma el groove de un clip de audio (Humanización > Groove de la banda).')
      return
    }
    const strength = options.strength ?? 1
    const velocityStrength = options.velocityStrength ?? 0.5
    if (this.snap.editor === 'piano_roll') {
      const loc = this.pianoClip()
      if (!loc) return
      const selection = this.selectionOrAll()
      const bpm = this.snap.session.bpm
      this.editNotes('Aplicar groove', (notes, length) =>
        notes.length === 0 ? null : applyGrooveTemplate(notes, selection, template, { strength, velocityStrength, clipStartBeat: loc.clip.startBeat, bpm }, length),
      )
      return
    }
    const midiIds = this.selectedClips().filter((id) => findMidiClip(this.snap.session, id))
    if (midiIds.length === 0) {
      this.notify('info', 'El groove se aplica a clips MIDI: elígelos en la línea de tiempo o abre uno en el piano roll.')
      return
    }
    this.run(midiIds.length === 1 ? 'Aplicar groove' : `Aplicar groove a ${midiIds.length} clips`, (session) => {
      let next = session
      for (const clipId of midiIds) {
        const loc = findMidiClip(next, clipId)
        if (!loc) continue
        const notes = applyGrooveTemplate(loc.clip.notes, null, template, { strength, velocityStrength, clipStartBeat: loc.clip.startBeat, bpm: next.bpm }, loc.clip.lengthBeats).notes
        next = updateMidiClip(next, { clipId, patch: { notes } })
      }
      return next
    })
  }

  /** Ctrl+A: todas las notas en el piano roll; todos los clips en la linea de tiempo. */
  selectAll(): void {
    if (this.snap.editor === 'piano_roll') this.selectAllNotes()
    else this.selectAllClips()
  }

  /** Ctrl+C: notas en el piano roll, clips en la linea de tiempo. */
  copySelection(): void {
    if (this.snap.editor === 'piano_roll') this.copyNotes()
    else this.copyClips()
  }

  cutSelection(): void {
    if (this.snap.editor === 'piano_roll') this.cutNotes()
    else this.cutClips()
  }

  pasteSelection(): void {
    if (this.snap.editor === 'piano_roll') this.pasteNotes()
    else this.pasteClips()
  }

  // ---- piano roll: atajos de DAW ----

  /** Ctrl+I: elige las notas que no estaban elegidas. */
  invertNoteSelection(): void {
    const loc = this.pianoClip()
    if (loc) this.selectNotes(invertSelection(loc.clip.notes.length, this.snap.piano.selection))
  }

  /** Alt+Arriba y Alt+Abajo: suben o bajan la velocidad de las notas elegidas (o de todas). */
  nudgeNotesVelocity(delta: number): void {
    const selection = this.selectionOrAll()
    this.editNotes('Velocidad de notas', (notes) => (notes.length === 0 ? null : setVelocity(notes, selection, delta, 'add')))
  }

  /** Shift+Derecha y Shift+Izquierda: alargan o acortan las notas elegidas un paso de la rejilla. */
  resizeSelectedNotes(direction: -1 | 1): void {
    const step = this.pianoGridBeats()
    this.editNotes(direction > 0 ? 'Alargar notas' : 'Acortar notas', (notes, length, selection) =>
      selection.length === 0 ? null : resizeNotes(notes, selection, 'end', direction * step, length),
    )
  }

  // ---- navegacion y transporte ----

  /** Fin de la sesion (Fin). */
  goToEnd(): void {
    this.seek(sessionEndSeconds(this.snap.session))
  }

  /** Coma y punto: el cabezal va a la linea de compas anterior o siguiente. */
  stepBar(direction: -1 | 1): void {
    const session = this.snap.session
    const barS = (60 / session.bpm) * session.beatsPerBar
    const at = this.engine.position() / barS
    const target = direction > 0 ? (Math.floor(at + 1e-6) + 1) * barS : (Math.ceil(at - 1e-6) - 1) * barS
    this.seek(Math.max(0, Math.min(STUDIO_MAX_SESSION_SECONDS, target)))
  }

  /**
   * Ctrl+Izquierda y Ctrl+Derecha: marca anterior o siguiente (las marcas de la sesion y el
   * inicio de las secciones de la cancion). Sin marca anterior, va al inicio.
   */
  goToMarker(direction: -1 | 1): void {
    const session = this.snap.session
    const points = [...session.markers.map((m) => ({ beat: m.beat })), ...this.snap.sections.map((s) => ({ beat: secondsToBeats(s.startSec, session.bpm) }))]
    const beat = adjacentMarkerBeat(points, secondsToBeats(this.engine.position(), session.bpm), direction)
    if (beat === null) {
      if (direction < 0) this.seek(0)
      else this.notify('info', 'No hay más marcas después del cabezal. Agrega una con Shift+M.')
      return
    }
    this.seek(beatsToSeconds(beat, session.bpm))
  }

  /** Shift+M: marca nueva en el cabezal (un paso de deshacer). */
  addMarkerAtPlayhead(): void {
    if (this.snap.recording) return
    const session = this.snap.session
    const beat = roundBeat(secondsToBeats(this.engine.position(), session.bpm))
    if (session.markers.some((m) => Math.abs(m.beat - beat) < 0.01)) {
      this.notify('info', 'Ya hay una marca en el cabezal.')
      return
    }
    const label = `${STUDIO_MARKER_KIND_LABELS.marker} ${session.markers.length + 1}`
    this.run(`Agregar marca ${label}`, (current) => {
      if (current.markers.length >= STUDIO_MAX_MARKERS) throw new Error(`La sesión admite hasta ${STUDIO_MAX_MARKERS} marcas.`)
      return setMarkers(current, { markers: [...current.markers, { id: newStudioId('mk'), beat, label, kind: 'marker' }] })
    })
  }

  /**
   * Shift+T: tap tempo. Desde el tercer golpe el tempo cambia en vivo; una pausa de 2 s cierra la
   * serie como un solo paso de deshacer.
   */
  tapTempo(): void {
    if (this.snap.recording) return
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const { taps, bpm } = computeTapTempo(this.taps, now, STUDIO_BPM_MIN, STUDIO_BPM_MAX)
    this.taps = taps
    if (this.tapTimer) clearTimeout(this.tapTimer)
    this.tapTimer = setTimeout(() => {
      this.tapTimer = null
      this.taps = []
      this.commitLive('Tap tempo')
    }, TAP_TEMPO_RESET_MS)
    if (bpm === null) {
      this.notify('info', `Tap tempo: sigue marcando el pulso (${taps.length} de 3).`)
      return
    }
    try {
      this.applyLive(updateSessionMeta(this.snap.session, { patch: { bpm } }))
      this.notify('info', `Tap tempo: ${bpm} BPM.`)
    } catch (err) {
      this.fail(err)
    }
  }

  /** Shift+K: activa o quita el conteo previo antes de grabar (los compases de ClickSettings). */
  toggleCountIn(): void {
    const bars = this.engine.getState().click.countInBars
    if (bars > 0) this.lastCountInBars = bars
    const next = bars > 0 ? 0 : this.lastCountInBars
    this.setClick({ countInBars: next })
    this.notify('info', next > 0 ? `Conteo previo: ${next === 1 ? '1 compás' : `${next} compases`} antes de grabar.` : 'Conteo previo apagado: la grabación arranca de inmediato.')
  }

  // ---- pistas: atajos de DAW ----

  /** Shift+R: arma o desarma la pista elegida (audio en la Entrada 1; instrumento para MIDI). */
  toggleArmSelectedTrack(): void {
    const track = this.snap.selectedTrackId ? findTrack(this.snap.session, this.snap.selectedTrackId) : null
    if (!track) {
      this.notify('info', 'Elige una pista para armarla.')
      return
    }
    if (track.kind === 'instrument') this.armMidiTrack(this.snap.midi.armedTrackId === track.id ? null : track.id)
    else this.setArm(track.id, this.snap.arms[track.id] !== undefined ? null : 0)
  }

  /** Ctrl+Shift+D: copia la pista elegida debajo de ella. */
  duplicateSelectedTrack(): void {
    const trackId = this.snap.selectedTrackId
    if (!trackId) {
      this.notify('info', 'Elige una pista para duplicarla.')
      return
    }
    const newTrackId = newStudioId('trk')
    this.run(
      'Duplicar pista',
      (session) => duplicateTrack(session, { trackId, newTrackId, newClipId: (kind) => newStudioId(kind === 'audio' ? 'clp' : 'mid') }),
      { selectedTrackId: newTrackId, selectedClipId: null },
    )
  }

  /** Alt+Arriba y Alt+Abajo en la linea de tiempo: sube o baja la pista elegida. */
  moveSelectedTrack(direction: -1 | 1): void {
    const tracks = this.snap.session.tracks
    const index = tracks.findIndex((t) => t.id === this.snap.selectedTrackId)
    if (index < 0) return
    const trackId = tracks[index].id
    this.run(direction < 0 ? 'Subir pista' : 'Bajar pista', (session) => moveTrack(session, { trackId, toIndex: index + direction }))
  }

  /** 1..9 en la linea de tiempo: elige la pista por su numero (y suelta los clips elegidos). */
  selectTrackByNumber(position: number): void {
    const track = this.snap.session.tracks[position - 1]
    if (!track) return
    this.emit({ selectedTrackId: track.id, selectedClipId: null })
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
    // Una pista de instrumento se arma para MIDI (armMidiTrack), no con una entrada de audio.
    if (channel !== null && findTrack(this.snap.session, trackId)?.kind !== 'audio') return
    const arms: Record<string, ArmChannel> = { ...this.snap.arms }
    if (channel === null) delete arms[trackId]
    else arms[trackId] = channel
    this.emit({ arms })
  }

  /** Mute de una pista (por defecto la elegida). */
  toggleTrackMute(trackId: string | null = this.snap.selectedTrackId): void {
    const track = trackId ? findTrack(this.snap.session, trackId) : null
    if (track) this.updateTrack(track.id, { mute: !track.mute }, track.mute ? 'Quitar mute' : 'Mute')
  }

  /** Solo de una pista (por defecto la elegida). */
  toggleTrackSolo(trackId: string | null = this.snap.selectedTrackId): void {
    const track = trackId ? findTrack(this.snap.session, trackId) : null
    if (track) this.updateTrack(track.id, { solo: !track.solo }, track.solo ? 'Quitar solo' : 'Solo')
  }

  // ---- pistas de instrumento ----

  /**
   * Pista de instrumento nueva. `option` es el preset (synth y drums) o el plugin (wam). Devuelve
   * el id de la pista, o null si no se pudo.
   */
  addInstrumentTrack(type: StudioParamInstrumentType | 'wam', option?: string): string | null {
    const session = this.snap.session
    if (session.tracks.length >= STUDIO_MAX_TRACKS) {
      this.notify('warn', `El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas por sesión.`)
      return null
    }
    let instrument: StudioInstrument
    try {
      if (type === 'wam') {
        if (!option) throw new Error('Elige un plugin de la lista de este Hub.')
        instrument = { type: 'wam', pluginId: option, state: {} }
      } else {
        instrument = defaultInstrument(type, option ?? null)
      }
    } catch (err) {
      this.fail(err)
      return null
    }
    const sameType = session.tracks.filter((track) => track.instrument?.type === type).length
    const id = newStudioId('trk')
    const name = `${STUDIO_INSTRUMENT_TYPE_LABELS[type]} ${sameType + 1}`.slice(0, STUDIO_MAX_TRACK_NAME)
    const ok = this.run('Agregar pista de instrumento', (current) => addInstrumentTrack(current, { track: defaultInstrumentTrack({ id, name, instrument }) }), {
      selectedTrackId: id,
      selectedClipId: null,
    })
    return ok ? id : null
  }

  /** Reemplaza el instrumento de la pista (un paso de deshacer). */
  setTrackInstrument(trackId: string, instrument: StudioInstrument, label: string): boolean {
    return this.run(label, (session) => setInstrument(session, { trackId, instrument }))
  }

  /** Parametro del instrumento mientras se arrastra: sin paso de deshacer hasta `commitLive`. */
  setTrackInstrumentLive(trackId: string, instrument: StudioInstrument): void {
    try {
      this.applyLive(setInstrument(this.snap.session, { trackId, instrument }))
    } catch (err) {
      this.fail(err)
    }
  }

  /**
   * Agrega al sampler una zona con un audio de la sesion (`assetId`) o con un archivo nuevo. La
   * zona cubre todas las notas y velocidades; su nota raiz es `rootPitch`.
   */
  async addSamplerZone(trackId: string, source: { assetId: string } | { file: File }, rootPitch = 60): Promise<void> {
    if (this.snap.recording) return
    let added: StudioAsset | null = null
    try {
      if ('file' in source) added = (await this.ingestAudio(source.file, source.file.name, 'import')).asset
    } catch (err) {
      this.fail(err, 'No se pudo leer el audio para el sampler.')
      return
    }
    this.run('Agregar zona del sampler', (session) => {
      let next = added ? addAsset(session, { asset: added }) : session
      const track = findTrack(next, trackId)
      if (!track || track.instrument?.type !== 'sampler') throw new Error('La pista ya no tiene un sampler.')
      const assetId = added ? added.id : 'assetId' in source ? source.assetId : ''
      const asset = next.assets.find((item) => item.id === assetId)
      if (!asset) throw new Error('Ese audio ya no está en la sesión.')
      const zone: StudioSamplerZone = {
        assetId,
        rootPitch: Math.min(127, Math.max(0, Math.round(rootPitch))),
        lowPitch: 0,
        highPitch: 127,
        lowVelocity: 1,
        highVelocity: 127,
        offsetS: 0,
        lengthS: Math.max(STUDIO_MIN_CLIP_SECONDS, Math.min(asset.durationS, STUDIO_MAX_SESSION_SECONDS)),
        gainDb: 0,
        tuneCents: 0,
      }
      next = setInstrument(next, { trackId, instrument: { ...track.instrument, zones: [...track.instrument.zones, zone] } })
      return next
    })
  }

  /**
   * Congela la pista: renderiza su instrumento a un audio de la sesion (sin efectos, fader,
   * paneo ni envio, desde el segundo 0) y lo anota en `frozen_asset_id`. Ese audio suena en un
   * equipo donde el instrumento no este disponible (STUDIO_V2.md 2.2). Un paso de deshacer.
   */
  async freezeTrack(trackId: string): Promise<void> {
    if (this.snap.freezing || this.snap.recording || !this.snap.ready) return
    const session = this.snap.session
    const track = findTrack(session, trackId)
    if (!track || track.kind !== 'instrument' || !track.instrument) return
    const availability = instrumentAvailability(track.instrument)
    if (!availability.available) {
      this.notify('warn', `No se puede congelar: ${availability.reason ?? 'el instrumento no está disponible en este equipo.'}`)
      return
    }
    if (track.midiClips.every((clip) => clip.notes.length === 0)) {
      this.notify('warn', 'La pista no tiene notas: no hay nada que congelar.')
      return
    }
    this.emit({ freezing: trackId })
    try {
      // Solo el instrumento: lo congelado entra donde entrarian los clips, antes de los efectos.
      const dry = {
        ...session,
        tracks: session.tracks.map((t) => (t.id === trackId ? { ...t, fx: [], volumeDb: 0, pan: 0, mute: false, solo: false, reverbSendDb: STUDIO_REVERB_SEND_DB_MIN } : t)),
      }
      const solo = soloTrackSession(dry, trackId)
      const range = solo ? bounceRange(solo, undefined, false) : null
      if (!solo || !range) throw new Error('La pista no tiene nada que suene.')
      const result = await bounce(solo, this.engine.getBuffers(), { mode: 'tracks', bitDepth: 24, sampleRate: session.sampleRate, range: { startS: 0, endS: range.endS }, trackIds: [trackId] })
      const file = result.mode === 'tracks' ? result.tracks[0] : null
      if (!file) throw new Error('El render de la pista quedó vacío.')
      const { asset } = await this.ingestAudio(file.blob, `${track.name}.wav`, 'bounce', `Congelado: ${track.name}`.slice(0, STUDIO_MAX_ASSET_LABEL))
      this.run('Congelar pista', (current) => setFrozenAsset(addAsset(current, { asset }), { trackId, assetId: asset.id }))
    } catch (err) {
      this.fail(err, 'No se pudo congelar la pista.')
    } finally {
      this.emit({ freezing: null })
    }
  }

  /** Quita el congelado (el audio sigue en la sesion hasta guardar en la nube sin usarlo). */
  unfreezeTrack(trackId: string): void {
    this.run('Quitar congelado', (session) => setFrozenAsset(session, { trackId, assetId: null }))
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
    // Solo MIDI (ninguna pista de audio armada): no necesita entrada de audio ni OPFS.
    const midiTrackId = this.midiRecordTarget()
    const hasAudioArms = Object.keys(this.snap.arms).some((trackId) => findTrack(this.snap.session, trackId)?.kind === 'audio')
    if (midiTrackId && !hasAudioArms) {
      await this.startMidiOnlyRecording(midiTrackId)
      return
    }
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
      if (midiTrackId) this.midiRec = { trackId: midiTrackId, only: false, started: false }
      const started = await recorder.start(this.engine)
      this.recStart = started
      if (midiTrackId) this.beginMidiTake(midiTrackId, started, false)
      // Se pidio detener mientras el grabador todavia arrancaba (esperaba al escritor de OPFS):
      // la toma se cierra apenas existe, en vez de quedar grabando sin que nadie lo sepa.
      if (this.recCancel) {
        this.recCancel = false
        await this.stopRecording()
      }
    } catch (err) {
      this.recStart = null
      this.abortMidiTake()
      this.emit({ recording: false })
      this.fail(err, 'No se pudo empezar a grabar.')
    }
  }

  async stopRecording(): Promise<void> {
    if (this.midiRec?.only) {
      await this.stopMidiOnlyRecording()
      return
    }
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
    // La toma MIDI se cierra en el instante de parar, antes de esperar a los archivos de audio.
    const midiTake = this.finishMidiTake()
    try {
      const takes = await recorder.stop()
      this.engine.stop()
      const stats = recorder.getLastTakeStats()
      let next = midiTake ? this.withMidiTake(this.snap.session, midiTake) : this.snap.session
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
      if (next !== this.snap.session) this.apply(next, midiTake && takes.length === 0 ? 'Grabar MIDI' : 'Grabar toma')
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

  // ---- MIDI: entrada, tocar en vivo y grabar ----

  private patchMidi(patch: Partial<StudioMidiState>): void {
    this.emit({ midi: { ...this.snap.midi, ...patch } })
  }

  private ensureMidi(): StudioMidiInput {
    if (this.midiInput) return this.midiInput
    const input = new StudioMidiInput({ getContext: () => this.engine.getContext() })
    this.midiInput = input
    this.midiOffs.push(
      input.onNote(this.handleMidiNote),
      input.onDevicesChange((devices) => {
        const deviceId = this.snap.midi.deviceId
        // El dispositivo abierto se desconecto: deja de figurar como abierto.
        const stillThere = deviceId !== null && devices.some((d) => d.id === deviceId && d.connected)
        this.patchMidi({ devices, deviceId: stillThere ? deviceId : null })
      }),
      input.onOctaveChange((octave) => this.patchMidi({ octave })),
    )
    return input
  }

  /** Si el permiso ya estaba dado en este navegador, abre MIDI sin preguntar (y el ultimo dispositivo). */
  private async restoreMidiAccess(): Promise<void> {
    if (this.snap.midi.access === 'unsupported') return
    try {
      const status = await this.ensureMidi().queryAccess()
      if (status === 'granted') await this.midiRequestAccess()
      else if (status !== this.snap.midi.access) this.patchMidi({ access: status })
    } catch {
      // Sin Permissions API se pregunta cuando el usuario lo pida.
    }
  }

  /** Pide el permiso de Web MIDI (sin sysex) y abre el dispositivo recordado o el primero. */
  async midiRequestAccess(): Promise<void> {
    if (this.disposed) return
    const input = this.ensureMidi()
    const access = await input.requestAccess()
    const devices = input.listInputs()
    this.patchMidi({ access, devices })
    if (access !== 'granted' || this.snap.midi.deviceId) return
    let remembered = ''
    try {
      remembered = safeLocalStorage()?.getItem(MIDI_INPUT_KEY) ?? ''
    } catch {
      remembered = ''
    }
    const pick = devices.find((d) => d.id === remembered && d.connected) ?? devices.find((d) => d.connected)
    if (pick) this.midiSelectDevice(pick.id, false)
  }

  /** Abre un dispositivo MIDI con el canal elegido. */
  midiSelectDevice(deviceId: string, remember = true): void {
    try {
      this.ensureMidi().open(deviceId, this.snap.midi.channel)
      this.patchMidi({ deviceId })
      if (remember) {
        try {
          safeLocalStorage()?.setItem(MIDI_INPUT_KEY, deviceId)
        } catch {
          // Sin almacenamiento la eleccion dura lo que la pestana.
        }
      }
    } catch (err) {
      this.patchMidi({ deviceId: null })
      this.fail(err, 'No se pudo abrir el dispositivo MIDI.')
    }
  }

  midiSetChannel(channel: number | 'all'): void {
    if (channel === this.snap.midi.channel) return
    this.patchMidi({ channel })
    const deviceId = this.snap.midi.deviceId
    if (deviceId) this.midiSelectDevice(deviceId, false)
  }

  /** Teclado de la computadora como teclado musical (fila A..K, Z y X cambian la octava). */
  setComputerKeyboard(enabled: boolean): void {
    const input = this.ensureMidi()
    input.setComputerKeyboard(enabled)
    this.patchMidi({ keyboard: enabled, octave: input.getComputerKeyboardOctave() })
  }

  toggleComputerKeyboard(): void {
    this.setComputerKeyboard(!this.snap.midi.keyboard)
  }

  setKeyboardOctave(octave: number): void {
    const input = this.ensureMidi()
    input.setComputerKeyboardOctave(octave)
    this.patchMidi({ octave: input.getComputerKeyboardOctave() })
  }

  /** Arma una pista de instrumento para grabar MIDI y tocarla en vivo (una a la vez). */
  armMidiTrack(trackId: string | null): void {
    if (this.snap.recording) return
    if (trackId !== null && findTrack(this.snap.session, trackId)?.kind !== 'instrument') return
    if (trackId !== this.snap.midi.armedTrackId) {
      this.midiPanic()
      this.patchMidi({ armedTrackId: trackId })
    }
  }

  setMidiQuantizeOnStop(enabled: boolean): void {
    this.patchMidi({ quantizeOnStop: enabled })
  }

  /** Notas entrantes (dispositivo o teclado), para indicadores de la interfaz. Devuelve como dejar de escuchar. */
  onMidiNote(listener: (event: MidiNoteEvent) => void): () => void {
    if (this.disposed) return () => undefined
    return this.ensureMidi().onNote(listener)
  }

  /** Corta todas las notas que suenan en vivo (nota colgada). */
  midiPanic(): void {
    this.engine.liveAllNotesOff()
    this.liveNotes.clear()
  }

  /** Pista que suena al tocar: la armada para MIDI, si no la pista de instrumento elegida. */
  private liveTargetTrack(): string | null {
    const session = this.snap.session
    const armed = this.snap.midi.armedTrackId
    if (armed && findTrack(session, armed)?.kind === 'instrument') return armed
    const picked = this.pianoClip()?.track.id ?? this.snap.selectedTrackId
    return picked && findTrack(session, picked)?.kind === 'instrument' ? picked : null
  }

  private handleMidiNote = (event: MidiNoteEvent): void => {
    if (event.type === 'on') {
      const target = this.liveTargetTrack()
      if (!target) return
      const previous = this.liveNotes.get(event.pitch)
      if (previous) this.engine.liveNoteOff(previous, event.pitch)
      if (this.engine.liveNoteOn(target, event.pitch, event.velocity)) this.liveNotes.set(event.pitch, target)
      return
    }
    const target = this.liveNotes.get(event.pitch)
    if (target) {
      this.engine.liveNoteOff(target, event.pitch)
      this.liveNotes.delete(event.pitch)
    }
  }

  /** Pista de instrumento armada para MIDI que existe, o null. */
  private midiRecordTarget(): string | null {
    const armed = this.snap.midi.armedTrackId
    return armed && findTrack(this.snap.session, armed)?.kind === 'instrument' ? armed : null
  }

  private beginMidiTake(trackId: string, playStart: PlayStart, only: boolean): void {
    const input = this.ensureMidi()
    const session = this.snap.session
    const loop = this.recLoop
    const { grid, triplets } = this.snap.piano
    input.startRecording({
      trackId,
      playStart: { positionAtStart: playStart.positionAtStart, playStartCtxTime: playStart.playStartCtxTime },
      bpm: session.bpm,
      channel: this.snap.midi.channel,
      quantize: this.snap.midi.quantizeOnStop ? { grid, triplets, strength: 1 } : null,
      beatsPerBar: session.beatsPerBar,
      loop: loop ? { startBeat: secondsToBeats(loop.startS, session.bpm), endBeat: secondsToBeats(loop.endS, session.bpm) } : null,
    })
    this.midiRec = { trackId, only, started: true }
  }

  /** Cierra la toma MIDI en este instante; null si no habia o no se toco nada. */
  private finishMidiTake(): MidiTake | null {
    const rec = this.midiRec
    this.midiRec = null
    const input = this.midiInput
    if (!rec?.started || !input?.isRecording()) return null
    return input.stopRecording(this.engine.getContext().currentTime)
  }

  private abortMidiTake(): void {
    this.midiRec = null
    if (this.midiInput?.isRecording()) this.midiInput.stopRecording(0)
  }

  /** Sesion con la toma MIDI como clip nuevo en su pista. */
  private withMidiTake(session: StudioSession, take: MidiTake): StudioSession {
    if (findTrack(session, take.trackId)?.kind !== 'instrument') return session
    const id = newStudioId('mid')
    return addMidiClip(session, { trackId: take.trackId, clip: defaultMidiClip({ id, startBeat: take.startBeat, lengthBeats: take.lengthBeats, notes: take.notes }) })
  }

  private async startMidiOnlyRecording(trackId: string): Promise<void> {
    this.recLoop = this.engine.getState().loop
    this.recCancel = false
    this.midiRec = { trackId, only: true, started: false }
    this.ensureMidi()
    this.emit({ recording: true, notice: null })
    try {
      const started = await this.engine.play({ countIn: true })
      this.recStart = { ...started, roundTripSeconds: 0, calibrated: true }
      this.beginMidiTake(trackId, started, true)
      if (this.recCancel) {
        this.recCancel = false
        await this.stopMidiOnlyRecording()
      }
    } catch (err) {
      this.recStart = null
      this.abortMidiTake()
      this.emit({ recording: false })
      this.fail(err, 'No se pudo empezar a grabar MIDI.')
    }
  }

  private async stopMidiOnlyRecording(): Promise<void> {
    if (!this.snap.recording) return
    if (!this.recStart) {
      // Todavia arrancaba: se cancela y startMidiOnlyRecording cierra la toma al resolver.
      this.recCancel = true
      this.engine.pause()
      return
    }
    this.recStart = null
    const take = this.finishMidiTake()
    this.engine.stop()
    try {
      if (!take) {
        this.notify('warn', 'La toma MIDI quedó vacía: no llegó ninguna nota. Revisa el dispositivo y el canal, o usa el teclado de la computadora.')
        return
      }
      this.apply(this.withMidiTake(this.snap.session, take), 'Grabar MIDI', { selectedClipId: null })
      if (take.hangingNotes > 0) this.notify('info', `${take.hangingNotes === 1 ? 'Una nota seguía apretada' : `${take.hangingNotes} notas seguían apretadas`} al parar: se cerraron ahí.`)
    } catch (err) {
      this.fail(err, 'No se pudo guardar la toma MIDI.')
    } finally {
      this.emit({ recording: false })
    }
  }

  // ---- archivos MIDI (.mid) ----

  /**
   * Importa un archivo MIDI estandar: una pista de instrumento por pista del archivo (caja de
   * ritmos si va por el canal 10), con un clip desde el compas 1. Si la sesion no tiene pistas,
   * toma el tempo y el compas del archivo. Un paso de deshacer.
   */
  async importMidiFile(file: File): Promise<void> {
    if (this.snap.recording) {
      this.notify('warn', 'No se puede importar MIDI mientras se graba.')
      return
    }
    let parsed: ReturnType<typeof parseSmf>
    try {
      parsed = parseSmf(new Uint8Array(await file.arrayBuffer()))
    } catch (err) {
      this.fail(err, `"${file.name}" no se pudo leer como archivo MIDI.`)
      return
    }
    if (parsed.tracks.length === 0) {
      this.notify('warn', `"${file.name}" no tiene notas.`)
      return
    }
    const warnings: string[] = []
    this.run(parsed.tracks.length > 1 ? 'Importar archivo MIDI' : 'Importar pista MIDI', (session) => {
      let next = session
      if (session.tracks.length === 0 && (parsed.bpm !== null || parsed.beatsPerBar !== null)) {
        const bpm = parsed.bpm !== null ? Math.min(STUDIO_BPM_MAX, Math.max(STUDIO_BPM_MIN, Math.round(parsed.bpm * 100) / 100)) : undefined
        const beatsPerBar = parsed.beatsPerBar !== null ? Math.min(12, Math.max(1, parsed.beatsPerBar)) : undefined
        next = updateSessionMeta(next, { patch: { ...(bpm !== undefined ? { bpm } : {}), ...(beatsPerBar !== undefined ? { beatsPerBar } : {}) } })
      } else if (parsed.bpm !== null && Math.abs(parsed.bpm - session.bpm) > 0.01) {
        warnings.push(`El archivo viene a ${Math.round(parsed.bpm)} BPM; las notas quedan en compases a los ${session.bpm} BPM de la sesión.`)
      }
      if (session.tracks.length === 0 && parsed.beatsPerBar === null && parsed.timeSignature !== null) {
        warnings.push(`El archivo viene en ${parsed.timeSignature}, que no es un número entero de negras por compás: la sesión conserva su compás.`)
      }
      if (parsed.tempoChanges) warnings.push('El archivo cambia de tempo: el Estudio usa un solo tempo por sesión.')
      const maxBeat = Math.min(STUDIO_MAX_BEAT, secondsToBeats(STUDIO_MAX_SESSION_SECONDS, next.bpm))
      const base = fileTitle(file.name)
      let skipped = 0
      parsed.tracks.forEach((smfTrack, index) => {
        if (next.tracks.length >= STUDIO_MAX_TRACKS) {
          skipped++
          return
        }
        let notes = smfTrack.notes.filter((n) => n.start < maxBeat)
        if (notes.length > STUDIO_MAX_NOTES_PER_CLIP) {
          warnings.push(`"${smfTrack.name ?? base}" tiene más de ${STUDIO_MAX_NOTES_PER_CLIP} notas: se importaron las primeras.`)
          notes = notes.slice(0, STUDIO_MAX_NOTES_PER_CLIP)
        }
        if (notes.length === 0) return
        const last = Math.max(...notes.map((n) => n.start + n.length))
        const lengthBeats = Math.min(maxBeat, Math.max(next.beatsPerBar, Math.ceil(last / next.beatsPerBar - 1e-9) * next.beatsPerBar))
        const instrument = defaultInstrument(smfTrack.isDrums ? 'drums' : 'synth')
        const name = (smfTrack.name?.trim() || (parsed.tracks.length > 1 ? `${base} ${index + 1}` : base)).slice(0, STUDIO_MAX_TRACK_NAME)
        const trackId = newStudioId('trk')
        next = addInstrumentTrack(next, { track: defaultInstrumentTrack({ id: trackId, name, instrument }) })
        next = addMidiClip(next, { trackId, clip: defaultMidiClip({ id: newStudioId('mid'), startBeat: 0, lengthBeats, notes: normalizeNotes(notes, lengthBeats) }) })
      })
      if (skipped > 0) warnings.push(`El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas: ${skipped === 1 ? 'quedó 1 pista' : `quedaron ${skipped} pistas`} del archivo sin importar.`)
      return next
    })
    if (warnings.length > 0) this.notify('warn', warnings.join(' '))
  }

  /** Un clip MIDI como archivo .mid (tipo 1). null si el clip no existe. */
  exportMidiClip(clipId: string): { blob: Blob; name: string } | null {
    const session = this.snap.session
    const loc = findMidiClip(session, clipId)
    if (!loc) return null
    const bytes = writeSmf(
      [{ name: loc.track.name, notes: midiClipExportNotes(loc.clip), channel: loc.track.instrument?.type === 'drums' ? SMF_DRUM_CHANNEL : 0 }],
      session.bpm,
      session.beatsPerBar,
    )
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }), name: `${safeFileName(`${session.title} - ${loc.track.name}`, 'clip')}.mid` }
  }

  /** Todas las pistas de instrumento como archivo .mid (una pista del archivo por pista). null si no hay notas. */
  exportSessionMidi(): { blob: Blob; name: string } | null {
    const session = this.snap.session
    // Los clips silenciados no suenan: tampoco entran al .mid (STUDIO_V2.md 2.4).
    const clips = session.tracks
      .filter((track) => track.kind === 'instrument' && track.midiClips.some((clip) => !clip.muted && clip.notes.length > 0))
      .map((track) => ({
        name: track.name,
        notes: track.midiClips.flatMap((clip) => (clip.muted ? [] : midiClipExportNotes(clip))),
        channel: track.instrument?.type === 'drums' ? SMF_DRUM_CHANNEL : 0,
      }))
    if (clips.length === 0) return null
    const bytes = writeSmf(clips, session.bpm, session.beatsPerBar)
    return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/midi' }), name: `${safeFileName(session.title, 'sesion')}.mid` }
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

  // -------------------------------------------------------------------------
  // Contexto del asistente del chat (STUDIO_V2.md 4.3.2 y 4.3.5)
  // -------------------------------------------------------------------------

  /** Version del documento: sube con cada cambio de la sesion (tambien deshacer y rehacer). */
  get docVersion(): number {
    return this.editCount
  }

  /** La vista avisa que cancion del repertorio corresponde a la sesion (o null). */
  setLinkedSong(song: Song | null): void {
    this.linkedSong = song
  }

  /** Guarda una medicion de mezcla hecha sobre la version `version` del documento. */
  rememberMixMeasurement(metrics: MixMetrics, version = this.editCount): void {
    this.mixMeasurement = { metrics, version, measuredAt: Date.now() }
  }

  /** Ultima medicion de mezcla, o null. `fresh` lo decide la version (mixForSummary). */
  lastMixMeasurement(): ChatMixMeasurement | null {
    return this.mixMeasurement
  }

  /** Datos del resumen del chat que no estan en el documento: cancion ligada y medicion. */
  chatExtras(): ChatSummaryExtras {
    const songId = this.snap.session.songId
    const song = songId && this.linkedSong?.id === songId ? this.linkedSong : null
    return { song, mix: { measurement: this.mixMeasurement, version: this.editCount } }
  }

  /**
   * MEDIR MEZCLA: mide la mezcla y cada pista en este equipo (la medicion del asistente de mezcla)
   * y la deja guardada para el resumen del chat. Gratis: no sale audio ni se llama a la nube.
   */
  async measureForChat(options: MeasureMixOptions = {}): Promise<ChatMixMeasurement> {
    const version = this.editCount
    const metrics = await measureMix(this.snap.session, this.engine.getBuffers(), options)
    this.rememberMixMeasurement(metrics, version)
    return this.mixMeasurement!
  }

  /**
   * ESCUCHAR FRAGMENTO: arma hasta 30 s de la mezcla desde `startS` (mono, 16 kHz) y lo sube a
   * assets/ de la sesion en la nube, SIN agregarlo al documento (STUDIO_V2.md 4.3.5). Devuelve la
   * referencia para el mensaje del chat. No cobra: el recargo va en el mensaje que lo lleva.
   */
  async prepareListenExcerpt(startS: number, signal?: AbortSignal): Promise<StudioChatListen> {
    const cloud = this.cloud
    if (!cloud) throw new Error('Necesitas una sesión de nube activa para que el asistente escuche.')
    const excerpt = await renderListenExcerpt(this.snap.session, this.engine.getBuffers(), startS, { signal })
    const assetId = newStudioId('ast')
    await studioCloud.putAsset(cloud, this.sessionId, `${assetId}.wav`, excerpt.blob)
    return { assetId, durationS: excerpt.durationS }
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
          const buf = this.decoded.get(asset.id)
          const monoSlice =
            buf && buf.length > 0
              ? buf.getChannelData(0).subarray(0, Math.min(buf.length, Math.round(buf.sampleRate * 10)))
              : null
          const classified = classifyAudioRole(name, monoSlice, buf?.sampleRate)
          next = this.addAssetAsTrack(next, asset, { name: fileTitle(name), role: classified.role })
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
   * rehacer, los snapshots del control de versiones, y los audios guardados que aun no entraron.
   */
  private referencedFiles(): Set<string> {
    const files = referencedAssetFiles([this.snap.session, ...this.history.states()], this.decoded.keys())
    for (const protectedFile of this.vcsBundle.index.protectedAssets) files.add(protectedFile)
    return files
  }

  async discardOrphan(file: string): Promise<void> {
    if (this.referencedFiles().has(file)) {
      // Borrarlo dejaria un paso del historial o un snapshot apuntando a un audio que ya no existe.
      this.notify('warn', 'Ese audio todavía lo usa un paso de deshacer o una versión guardada: no se descartó.')
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

  // ---- guardado y colaboracion en tiempo real ----

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    if (this.snap.save.local !== 'pending' || !this.snap.save.dirty) this.emit({ save: { ...this.snap.save, local: 'pending', dirty: true } })
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.queueLocalSave()
    }, SAVE_DEBOUNCE_MS)

    if (this.cloud && this.band !== 'me' && this.snap.canEditCloud && !this.snap.recording) {
      if (this.cloudAutoSaveTimer) clearTimeout(this.cloudAutoSaveTimer)
      this.cloudAutoSaveTimer = setTimeout(() => {
        this.cloudAutoSaveTimer = null
        if (!this.disposed && this.snap.save.dirty && !this.snap.recording) {
          void this.saveToCloud(false)
        }
      }, CLOUD_AUTOSAVE_DEBOUNCE_MS)
    }
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
    const session = this.abWorkingBackup ?? this.snap.session
    this.saving = this.saving
      .catch(() => undefined)
      .then(async () => {
        try {
          await studioStore.saveSession(session, { band: this.band, dirty: true })
          if ((this.abWorkingBackup ?? this.snap.session) === session && !this.saveTimer) {
            this.emit({ save: { ...this.snap.save, local: 'saved' } })
          }
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
   * (tras un conflicto). En caso de colision 412 intenta primero una fusion colaborativa de 3 vias
   * (`mergeCollaborativeSession`) para que dos musicos editando distintas pistas nunca se pisen.
   */
  async saveToCloud(overwrite = false): Promise<void> {
    const cloud = this.cloud
    if (!cloud || this.snap.save.cloud === 'saving' || this.snap.recording) return
    if (!this.snap.canEditCloud) {
      this.notify('warn', 'Tu rol en esta banda es de solo lectura: no puedes guardar cambios en la nube.')
      return
    }
    if (this.cloudAutoSaveTimer) {
      clearTimeout(this.cloudAutoSaveTimer)
      this.cloudAutoSaveTimer = null
    }
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.queueLocalSave()
    const version = this.editCount
    const workingSession = this.abWorkingBackup ?? this.snap.session
    const document = removeUnusedAssets(workingSession)
    this.emit({ save: { ...this.snap.save, cloud: 'saving', cloudDetail: null, uploading: { done: 0, total: document.assets.length } } })
    try {
      let etag = this.snap.save.etag
      if (overwrite) etag = (await studioCloud.getSession(cloud, this.sessionId))?.etag ?? null
      let saved: Awaited<ReturnType<typeof studioCloud.putSession>>
      try {
        await this.uploadAssets(cloud, document, false)
        saved = await studioCloud.putSession(cloud, document, { ifMatch: etag })
      } catch (err) {
        if (err instanceof StemCloudError && err.code === 'missing_asset') {
          await this.uploadAssets(cloud, document, true)
          saved = await studioCloud.putSession(cloud, document, { ifMatch: etag })
        } else if (!overwrite && err instanceof StemCloudError && (err.code === 'session_conflict' || err.status === 412)) {
          // Resolucion automatica de 3 vias por entidad antes de molestar al musico con un conflicto.
          const remote = await studioCloud.getSession(cloud, this.sessionId)
          if (!remote) throw err
          const merged = mergeCollaborativeSession(this.lastCloudBase, workingSession, remote.session)
          const mergedDoc = removeUnusedAssets(merged)
          await this.uploadAssets(cloud, mergedDoc, false)
          saved = await studioCloud.putSession(cloud, mergedDoc, { ifMatch: remote.etag })
          this.lastCloudBase = saved.session
          if (!this.abWorkingBackup) {
            this.history.push(merged, 'Fusión colaborativa')
            this.setSession(merged, false)
          } else {
            this.abWorkingBackup = merged
          }
          await this.engine.load(this.snap.session, this.resolveAudio).catch(() => undefined)
          void this.ensurePeaks()
          this.notify('info', 'Cambios combinados en tiempo real con la banda.')
        } else {
          throw err
        }
      }
      this.lastCloudBase = saved.session
      const dirty = this.editCount !== version
      await studioStore.saveSession(this.abWorkingBackup ?? this.snap.session, {
        band: this.band,
        etag: saved.etag,
        dirty,
        cloudUpdatedAt: saved.session.updatedAt,
      }).catch(() => undefined)
      this.emit({ save: { local: dirty ? this.snap.save.local : 'saved', dirty, etag: saved.etag, cloud: 'idle', cloudDetail: null, uploading: null } })
      this.collabHandle?.broadcast({
        type: 'session_saved',
        sessionId: this.sessionId,
        etag: saved.etag,
        senderId: this.actor.userId,
        updatedAt: saved.session.updatedAt,
      })
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
      if (remote.session.sampleRate !== this.snap.session.sampleRate) await this.closeInput()
      this.lastCloudBase = remote.session
      this.abWorkingBackup = null
      this.history.clear()
      this.history.push(remote.session)
      this.editCount++
      this.midiPanic()
      this.emit({
        session: remote.session,
        abState: null,
        selectedClipId: null,
        selectedTrackId: null,
        editor: 'timeline',
        pianoClipId: null,
        piano: { ...this.snap.piano, selection: [] },
        midi: { ...this.snap.midi, armedTrackId: null },
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

  // -------------------------------------------------------------------------
  // Colaboracion Realtime, Control de Versiones (VCS) y A/B Instantaneo
  // -------------------------------------------------------------------------

  toggleLabMode(): void {
    this.emit({ labMode: !this.snap.labMode })
  }

  setWidgetsToggleHandler(fn: (() => void) | null): void {
    this.widgetsToggleHandler = fn
  }

  toggleWidgets(): void {
    this.widgetsToggleHandler?.()
  }

  private async initVcs(): Promise<void> {
    try {
      const storedRaw = await studioStore.loadVcsBundle(this.sessionId)
      if (storedRaw) {
        this.vcsBundle = parseStoredVcsBundle(storedRaw)
        this.emit({
          vcs: { activeBranch: this.vcsBundle.activeBranch, index: this.vcsBundle.index, saving: false },
        })
        this.collabHandle?.updatePresence({ branch: this.vcsBundle.activeBranch })
      }
    } catch {
      // Sin IndexedDB el VCS vive en memoria para esta visita.
    }
    if (this.cloud) {
      await this.refreshVcsFromCloud()
    }
  }

  async refreshVcsFromCloud(): Promise<void> {
    if (!this.cloud || this.disposed) return
    try {
      const remoteIndex = await studioCloud.getVcs(this.cloud, this.sessionId)
      const mergedIndex = mergeStudioVcsIndices(this.vcsBundle.index, remoteIndex)
      this.vcsBundle = { ...this.vcsBundle, index: mergedIndex }
      await studioStore.saveVcsBundle(this.sessionId, serializeVcsBundle(this.vcsBundle)).catch(() => undefined)
      this.emit({
        vcs: { activeBranch: this.vcsBundle.activeBranch, index: mergedIndex, saving: false },
      })
    } catch {
      // Ignorar cuando se trabaja offline.
    }
  }

  private async handleCollabEvent(event: StudioCollabEvent): Promise<void> {
    if (this.disposed || event.sessionId !== this.sessionId) return
    if (event.type === 'vcs_updated') {
      await this.refreshVcsFromCloud()
      return
    }
    if (event.type === 'session_saved' && this.cloud && !this.snap.recording && this.snap.save.cloud !== 'saving') {
      if (event.etag === this.snap.save.etag) return
      if (this.snap.abState?.active === 'B') return
      try {
        const remote = await studioCloud.getSession(this.cloud, this.sessionId)
        if (!remote) return
        if (!this.snap.save.dirty) {
          this.lastCloudBase = remote.session
          await studioStore.saveSession(remote.session, {
            band: this.band,
            etag: remote.etag,
            dirty: false,
            cloudUpdatedAt: remote.session.updatedAt,
          }).catch(() => undefined)
          this.history.push(remote.session, 'Actualización en vivo')
          this.setSession(remote.session, false, {
            save: { ...this.snap.save, local: 'saved', dirty: false, etag: remote.etag, cloud: 'idle', cloudDetail: null },
          })
          await this.engine.load(remote.session, this.resolveAudio).catch(() => undefined)
          void this.ensurePeaks()
        } else {
          const merged = mergeCollaborativeSession(this.lastCloudBase, this.snap.session, remote.session)
          this.lastCloudBase = remote.session
          this.history.push(merged, 'Fusión en vivo')
          this.setSession(merged, false, {
            save: { ...this.snap.save, etag: remote.etag },
          })
          await this.engine.load(merged, this.resolveAudio).catch(() => undefined)
          void this.ensurePeaks()
          this.scheduleSave()
        }
      } catch {
        // La sesion seguira sincronizandose en el proximo guardado.
      }
    }
  }

  /** Guarda un snapshot inmutable en la rama activa (o en `branch`) y lo sincroniza con R2. */
  async commitVcsSnapshot(message?: string, branch?: string): Promise<StudioVcsCommitMeta | null> {
    if (this.snap.recording) return null
    if (this.snap.abState?.active === 'B') await this.toggleAbListening()
    const targetBranch = normalizeBranchName(branch ?? this.vcsBundle.activeBranch ?? 'main')
    const cleanDoc = removeUnusedAssets(this.snap.session)
    const localCommitId = newStudioId('cmt')
    const { bundle: localBundle, commit: localCommit } = commitStudioLocal({
      bundle: this.vcsBundle,
      session: cleanDoc,
      branch: targetBranch,
      message: message?.trim() || `Snapshot (${targetBranch})`,
      authorId: this.actor.userId,
      authorName: this.actor.name,
      commitId: localCommitId,
    })
    this.vcsBundle = localBundle
    await studioStore.saveVcsBundle(this.sessionId, serializeVcsBundle(localBundle)).catch(() => undefined)

    const syncingCloud = Boolean(this.cloud && this.snap.canEditCloud)
    const nextAb = this.snap.abState ?? { active: 'A' as const, commitId: localCommit.id, label: localCommit.message }
    this.emit({
      vcs: { activeBranch: localBundle.activeBranch, index: localBundle.index, saving: syncingCloud },
      abState: nextAb,
    })
    this.collabHandle?.updatePresence({ branch: localBundle.activeBranch })

    if (!this.cloud || !this.snap.canEditCloud) {
      this.notify('info', `Versión guardada en este equipo (${localCommit.branch}).`)
      return localCommit
    }

    try {
      await this.uploadAssets(this.cloud, cleanDoc, false)
      const { commit: remoteCommit, vcs: remoteVcs } = await studioCloud.postVcs(this.cloud, this.sessionId, {
        branch: localCommit.branch,
        message: localCommit.message,
        authorName: this.actor.name,
        parentId: localCommit.parentId,
        session: cleanDoc,
      })
      const nextLocalCommits = { ...this.vcsBundle.localCommits }
      if (remoteCommit.id !== localCommit.id) {
        delete nextLocalCommits[localCommit.id]
      }
      nextLocalCommits[remoteCommit.id] = serializeSession(cleanDoc)
      const filteredLocalIndex: StudioVcsIndex =
        remoteCommit.id !== localCommit.id
          ? {
              ...this.vcsBundle.index,
              commits: this.vcsBundle.index.commits.filter((c) => c.id !== localCommit.id),
            }
          : this.vcsBundle.index
      const mergedIndex = mergeStudioVcsIndices(filteredLocalIndex, remoteVcs)
      this.vcsBundle = {
        activeBranch: targetBranch,
        index: mergedIndex,
        localCommits: nextLocalCommits,
      }
      await studioStore.saveVcsBundle(this.sessionId, serializeVcsBundle(this.vcsBundle)).catch(() => undefined)
      const updatedAb =
        this.snap.abState?.commitId === localCommit.id
          ? { ...this.snap.abState, commitId: remoteCommit.id, label: remoteCommit.message }
          : this.snap.abState
      this.emit({
        vcs: { activeBranch: targetBranch, index: mergedIndex, saving: false },
        abState: updatedAb,
        save: { ...this.snap.save, uploading: null },
      })
      this.collabHandle?.broadcast({
        type: 'vcs_updated',
        sessionId: this.sessionId,
        branch: remoteCommit.branch,
        commitId: remoteCommit.id,
        senderId: this.actor.userId,
      })
      this.notify('info', `Versión "${remoteCommit.message}" guardada en la rama ${remoteCommit.branch}.`)
      return remoteCommit
    } catch (err) {
      this.emit({
        vcs: { activeBranch: this.vcsBundle.activeBranch, index: this.vcsBundle.index, saving: false },
        save: { ...this.snap.save, uploading: null },
      })
      this.notify('warn', `Versión guardada localmente; falló la subida a la nube: ${errorText(err)}`)
      return localCommit
    }
  }

  /** Carga la sesion completa de un commit (desde cache local en 0 ms o desde R2). */
  async loadVcsCommitSession(commitId: string): Promise<StudioSession | null> {
    const local = resolveLocalCommitSession(this.vcsBundle, commitId)
    if (local) return local
    if (!this.cloud) return null
    try {
      const remote = await studioCloud.getCommit(this.cloud, this.sessionId, commitId)
      this.vcsBundle = {
        ...this.vcsBundle,
        localCommits: { ...this.vcsBundle.localCommits, [commitId]: serializeSession(remote) },
      }
      await studioStore.saveVcsBundle(this.sessionId, serializeVcsBundle(this.vcsBundle)).catch(() => undefined)
      return remote
    } catch (err) {
      this.fail(err, 'No se pudo descargar esa versión de la nube.')
      return null
    }
  }

  /** Cambia a una rama existente o crea una rama nueva a partir de la mezcla actual. */
  async switchVcsBranch(rawBranch: string): Promise<void> {
    if (this.snap.recording) return
    const branch = normalizeBranchName(rawBranch)
    if (branch === this.vcsBundle.activeBranch) return
    if (this.snap.abState?.active === 'B') await this.toggleAbListening()

    const headCommitId = this.vcsBundle.index.branches[branch]
    if (!headCommitId) {
      // Rama nueva: crear su primer snapshot con el estado vigente.
      await this.commitVcsSnapshot(`Rama inicial: ${branch}`, branch)
      return
    }
    const targetSession = await this.loadVcsCommitSession(headCommitId)
    if (!targetSession) return
    this.vcsBundle = { ...this.vcsBundle, activeBranch: branch }
    await studioStore.saveVcsBundle(this.sessionId, serializeVcsBundle(this.vcsBundle)).catch(() => undefined)
    this.collabHandle?.updatePresence({ branch })
    this.apply(targetSession, `Cambiar a rama ${branch}`, {
      vcs: { activeBranch: branch, index: this.vcsBundle.index, saving: false },
    })
    await this.engine.load(targetSession, this.resolveAudio).catch(() => undefined)
    void this.ensurePeaks()
  }

  /** Restaura cualquier commit previo en la rama actual como un paso de deshacer. */
  async restoreVcsCommit(commitId: string): Promise<void> {
    if (this.snap.recording) return
    if (this.snap.abState?.active === 'B') await this.toggleAbListening()
    const targetSession = await this.loadVcsCommitSession(commitId)
    if (!targetSession) return
    const meta = this.vcsBundle.index.commits.find((c) => c.id === commitId)
    this.apply(targetSession, `Restaurar: ${meta?.message ?? commitId}`)
    await this.engine.load(targetSession, this.resolveAudio).catch(() => undefined)
    void this.ensurePeaks()
    this.notify('info', `Restaurada la versión "${meta?.message ?? commitId}".`)
  }

  /** Elige que commit sirve como referencia B para la comparacion auditiva instantanea. */
  async setAbReferenceCommit(commitId: string | null): Promise<void> {
    if (this.snap.abState?.active === 'B') await this.toggleAbListening()
    if (!commitId) {
      this.emit({ abState: null })
      return
    }
    const meta = this.vcsBundle.index.commits.find((c) => c.id === commitId)
    if (!meta) return
    // Pre-cargar el commit en cache local para que el boton A/B conmute en 0 ms reales.
    const refSession = await this.loadVcsCommitSession(commitId)
    if (refSession) {
      await this.engine.load(this.snap.session, this.resolveAudio).catch(() => undefined)
    }
    this.emit({
      abState: { active: 'A', commitId, label: meta.message || meta.branch },
    })
  }

  /** Alterna en vivo (sin detener el cabezal ni ensuciar el historial) entre A (actual) y B (snapshot). */
  async toggleAbListening(): Promise<void> {
    if (this.snap.recording) return
    let ab = this.snap.abState
    if (!ab) {
      const latest = this.vcsBundle.index.commits[0]
      if (!latest) {
        this.notify('info', 'Guarda primero un snapshot (Alt+G) para comparar A/B al instante.')
        return
      }
      ab = { active: 'A', commitId: latest.id, label: latest.message || latest.branch }
    }

    if (ab.active === 'A') {
      const refSession = await this.loadVcsCommitSession(ab.commitId)
      if (!refSession) return
      this.abWorkingBackup = this.snap.session
      this.emit({
        session: refSession,
        abState: { ...ab, active: 'B' },
      })
      this.syncEngine(refSession)
    } else {
      const working = this.abWorkingBackup ?? this.snap.session
      this.abWorkingBackup = null
      this.emit({
        session: working,
        abState: { ...ab, active: 'A' },
      })
      this.syncEngine(working)
    }
  }

  // -------------------------------------------------------------------------
  // Transformaciones Matematicas de Onda, Deteccion Local, Auto-Master y Bark
  // -------------------------------------------------------------------------

  private getClipSegmentChannels(clip: StudioClip): { channels: Float32Array[]; sampleRate: number } | null {
    const buffer = this.engine.getBuffer(clip.assetId)
    if (!buffer || buffer.length === 0) return null
    const sr = buffer.sampleRate
    const from = Math.max(0, Math.min(buffer.length - 1, Math.floor(clip.offsetS * sr)))
    const to = Math.max(from + 1, Math.min(buffer.length, Math.ceil((clip.offsetS + clip.lengthS) * sr)))
    const channels: Float32Array[] = []
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
      channels.push(buffer.getChannelData(c).subarray(from, to))
    }
    return { channels, sampleRate: sr }
  }

  /** Normaliza los clips de audio elegidos a un objetivo exacto de sonoridad (-14 LUFS o -1 dBTP). */
  normalizeSelectedClips(mode: 'lufs' | 'peak' = 'lufs', targetDb = mode === 'lufs' ? -14 : -1): void {
    const audioIds = this.selectedClips().filter((id) => findClip(this.snap.session, id) !== null)
    if (audioIds.length === 0) {
      this.notify('info', 'Elige al menos un clip de audio para normalizarlo.')
      return
    }
    let adjusted = 0
    let lastSummary = ''
    this.run(audioIds.length === 1 ? 'Normalizar clip' : `Normalizar ${audioIds.length} clips`, (session) => {
      let next = session
      for (const clipId of audioIds) {
        const loc = findClip(next, clipId)
        if (!loc) continue
        const seg = this.getClipSegmentChannels(loc.clip)
        if (!seg) continue
        const norm = computeNormalizedClipGainDb(seg.channels, seg.sampleRate, { mode, targetDb })
        next = setClipGain(next, { clipId, gainDb: norm.gainDb })
        adjusted++
        lastSummary =
          mode === 'lufs'
            ? `${norm.gainDb >= 0 ? '+' : ''}${norm.gainDb.toFixed(1)} dB (${targetDb} LUFS)`
            : `${norm.gainDb >= 0 ? '+' : ''}${norm.gainDb.toFixed(1)} dB (${targetDb} dBTP)`
      }
      return next
    })
    if (adjusted > 0) {
      this.notify('info', adjusted === 1 ? `Clip normalizado: ${lastSummary}.` : `${adjusted} clips normalizados (${mode.toUpperCase()}).`)
    }
  }

  /** Invierte la polaridad (180 grados) de los clips de audio elegidos. */
  invertSelectedClipsPhase(): void {
    const audioIds = this.selectedClips().filter((id) => findClip(this.snap.session, id) !== null)
    if (audioIds.length === 0) {
      this.notify('info', 'Elige un clip de audio para invertir su polaridad.')
      return
    }
    const first = findClip(this.snap.session, audioIds[0])
    const targetInvert = !(first?.clip.phaseInvert === true)
    this.run(targetInvert ? 'Invertir fase (180°)' : 'Restaurar fase (0°)', (session) => {
      let next = session
      for (const clipId of audioIds) {
        next = setClipPhaseInvert(next, { clipId, phaseInvert: targetInvert })
      }
      return next
    })
  }

  /** Cambia la curva matematica de fundido (`linear`, `exp`, `scurve`) de los clips elegidos. */
  setSelectedClipsFadeShape(fadeShape: StudioClipFadeShape): void {
    const audioIds = this.selectedClips().filter((id) => findClip(this.snap.session, id) !== null)
    if (audioIds.length === 0) return
    this.run('Curva de fundido', (session) => {
      let next = session
      for (const clipId of audioIds) {
        const loc = findClip(next, clipId)
        if (!loc) continue
        next = setClipFades(next, {
          clipId,
          fadeInS: loc.clip.fadeInS,
          fadeOutS: loc.clip.fadeOutS,
          fadeShape,
        })
      }
      return next
    })
  }

  /** Recorta silencios intermedios con histeresis de Schmitt dejando regiones limpias con micro-fades. */
  stripSilenceSelectedClip(options: StripSilenceOptions = {}): void {
    const audioIds = this.selectedClips().filter((id) => findClip(this.snap.session, id) !== null)
    if (audioIds.length === 0) {
      this.notify('info', 'Elige un clip de audio para limpiar sus silencios (Strip Silence).')
      return
    }
    let totalRegions = 0
    const newSelection: string[] = []
    this.run('Limpiar silencios (Strip Silence)', (session) => {
      let next = session
      for (const clipId of audioIds) {
        const loc = findClip(next, clipId)
        if (!loc) continue
        const seg = this.getClipSegmentChannels(loc.clip)
        if (!seg) continue
        const subClips = splitClipByStripSilence(loc.clip, seg.channels, seg.sampleRate, options, newStudioId)
        if (subClips.length === 0) continue
        totalRegions += subClips.length
        for (const sc of subClips) newSelection.push(sc.id)
        next = {
          ...next,
          tracks: next.tracks.map((t) =>
            t.id === loc.track.id
              ? { ...t, clips: [...t.clips.filter((c) => c.id !== clipId), ...subClips] }
              : t,
          ),
        }
      }
      return next
    }, newSelection.length > 0 ? { selectedClipIds: newSelection, selectedClipId: newSelection[0] } : {})

    if (totalRegions > 0) {
      this.notify('info', `Strip Silence completado: ${totalRegions} ${totalRegions === 1 ? 'región activa conservada' : 'regiones activas conservadas'}.`)
    } else {
      this.notify('warn', 'No se detectaron regiones sobre el umbral de silencio en el clip elegido.')
    }
  }

  /** Invierte el audio del clip elegido en reversa guardando un nuevo StudioAsset inmutable de 24 bits. */
  async reverseSelectedClip(): Promise<void> {
    if (this.snap.recording) return
    const clipId = this.snap.selectedClipId
    const loc = clipId ? findClip(this.snap.session, clipId) : null
    if (!loc) {
      this.notify('info', 'Elige un clip de audio para invertirlo en reversa.')
      return
    }
    const seg = this.getClipSegmentChannels(loc.clip)
    if (!seg) {
      this.notify('warn', 'El audio del clip todavía no está decodificado.')
      return
    }
    try {
      const reversed = reverseChannels(seg.channels)
      const wavBlob = new Blob([encodeWav24(reversed, seg.sampleRate)], { type: 'audio/wav' })
      const baseAsset = this.snap.session.assets.find((a) => a.id === loc.clip.assetId)
      const label = `${baseAsset?.label ?? loc.track.name} (Reversa)`.slice(0, STUDIO_MAX_ASSET_LABEL)
      const { asset } = await this.ingestAudio(wavBlob, `${label}.wav`, 'import', label)
      this.run('Reversa de clip', (session) => {
        const added = addAsset(session, { asset })
        return {
          ...added,
          tracks: added.tracks.map((t) =>
            t.id === loc.track.id
              ? {
                  ...t,
                  clips: t.clips.map((c) =>
                    c.id === loc.clip.id
                      ? { ...c, assetId: asset.id, offsetS: 0, lengthS: Math.min(loc.clip.lengthS, asset.durationS) }
                      : c,
                  ),
                }
              : t,
          ),
        }
      })
      void this.ensurePeaks()
    } catch (err) {
      this.fail(err, 'No se pudo invertir el clip en reversa.')
    }
  }

  /**
   * Alinea automaticamente en tiempo y polaridad el clip elegido respecto a otra pista de audio
   * mediante correlacion cruzada generalizada GCC-PHAT.
   */
  alignSelectedClipPhase(referenceTrackId?: string): void {
    const session = this.snap.session
    const clipId = this.snap.selectedClipId
    const targetLoc = clipId ? findClip(session, clipId) : null
    if (!targetLoc) {
      this.notify('info', 'Elige el clip de audio que quieres alinear en fase.')
      return
    }
    const targetSeg = this.getClipSegmentChannels(targetLoc.clip)
    if (!targetSeg) return

    const refTrack = referenceTrackId
      ? findTrack(session, referenceTrackId)
      : session.tracks.find(
          (t) =>
            t.id !== targetLoc.track.id &&
            t.kind === 'audio' &&
            !t.mute &&
            t.clips.some(
              (c) =>
                c.active &&
                c.startS < targetLoc.clip.startS + targetLoc.clip.lengthS &&
                targetLoc.clip.startS < c.startS + c.lengthS,
            ),
        )
    if (!refTrack || refTrack.kind !== 'audio') {
      this.notify('warn', 'Necesitas otra pista de audio activa que suene al mismo tiempo como referencia.')
      return
    }
    const refClip = refTrack.clips.find(
      (c) =>
        c.active &&
        c.startS < targetLoc.clip.startS + targetLoc.clip.lengthS &&
        targetLoc.clip.startS < c.startS + c.lengthS,
    )
    if (!refClip) return
    const refSeg = this.getClipSegmentChannels(refClip)
    if (!refSeg || refSeg.sampleRate !== targetSeg.sampleRate) {
      this.notify('warn', 'Los dos clips deben compartir la misma frecuencia de muestreo para alinearse sub-muestra.')
      return
    }

    const overlapStartS = Math.max(targetLoc.clip.startS, refClip.startS)
    const overlapEndS = Math.min(targetLoc.clip.startS + targetLoc.clip.lengthS, refClip.startS + refClip.lengthS)
    const maxLenS = Math.min(6, overlapEndS - overlapStartS)
    if (maxLenS < 0.1) {
      this.notify('warn', 'El solapamiento entre ambos clips es demasiado corto para correlacionar fase.')
      return
    }

    const sr = targetSeg.sampleRate
    const tFrom = Math.max(0, Math.floor((overlapStartS - targetLoc.clip.startS) * sr))
    const rFrom = Math.max(0, Math.floor((overlapStartS - refClip.startS) * sr))
    const count = Math.min(
      Math.floor(maxLenS * sr),
      targetSeg.channels[0].length - tFrom,
      refSeg.channels[0].length - rFrom,
    )
    if (count < 256) return

    const targetMono = downmixMono(targetSeg.channels.map((ch) => ch.subarray(tFrom, tFrom + count)))
    const refMono = downmixMono(refSeg.channels.map((ch) => ch.subarray(rFrom, rFrom + count)))
    const res = alignPhaseCrossCorrelation(refMono, targetMono, sr, 40)

    const newStartS = Math.max(0, Math.min(STUDIO_MAX_SESSION_SECONDS - targetLoc.clip.lengthS, targetLoc.clip.startS - res.lagSeconds))
    const currentInverted = targetLoc.clip.phaseInvert === true
    const nextInverted = res.polarity === -1 ? !currentInverted : currentInverted

    this.run('Alinear fase GCC-PHAT', (cur) => {
      let next: StudioSession = {
        ...cur,
        tracks: cur.tracks.map((t) =>
          t.id === targetLoc.track.id
            ? { ...t, clips: t.clips.map((c) => (c.id === targetLoc.clip.id ? { ...c, startS: newStartS } : c)) }
            : t,
        ),
      }
      if (nextInverted !== currentInverted) {
        next = setClipPhaseInvert(next, { clipId: targetLoc.clip.id, phaseInvert: nextInverted })
      }
      return next
    })
    const polTxt = res.polarity === -1 ? ' + polaridad invertida 180°' : ''
    this.notify('info', `Fase alineada con "${refTrack.name}": ${res.lagMs >= 0 ? '-' : '+'}${Math.abs(res.lagMs).toFixed(2)} ms (${res.lagSamples} muestras)${polTxt}.`)
  }

  /** Detecta localmente BPM, Tonalidad (Krumhansl-Schmuckler) y Acordes (HMM Viterbi) sin usar cuota IA. */
  detectLocalMusicalAnalysis(clipId?: string): { bpm: number | null; key: string | null; chordsCount: number } | null {
    const session = this.snap.session
    const targetId = clipId ?? this.snap.selectedClipId
    let mono: Float32Array | null = null
    let sr = session.sampleRate
    let startBeatOffset = 0

    if (targetId) {
      const loc = findClip(session, targetId)
      if (loc) {
        const seg = this.getClipSegmentChannels(loc.clip)
        if (seg) {
          const limit = Math.min(seg.channels[0].length, Math.round(seg.sampleRate * 45))
          mono = downmixMono(seg.channels.map((ch) => ch.subarray(0, limit)))
          sr = seg.sampleRate
          startBeatOffset = secondsToBeats(loc.clip.startS, session.bpm)
        }
      }
    }

    if (!mono) {
      // Mezclar hasta 45 s de las pistas de audio audibles como fuente de analisis.
      for (const track of session.tracks) {
        if (track.kind !== 'audio' || track.mute || track.role === 'click') continue
        for (const clip of track.clips) {
          if (!clip.active) continue
          const seg = this.getClipSegmentChannels(clip)
          if (!seg) continue
          sr = seg.sampleRate
          const limit = Math.min(seg.channels[0].length, Math.round(sr * 45))
          const clipMono = downmixMono(seg.channels.map((ch) => ch.subarray(0, limit)))
          if (!mono) {
            mono = new Float32Array(clipMono)
            startBeatOffset = secondsToBeats(clip.startS, session.bpm)
          } else {
            const n = Math.min(mono.length, clipMono.length)
            for (let i = 0; i < n; i++) mono[i] += clipMono[i]
          }
          break
        }
      }
    }

    if (!mono || mono.length < 2048) {
      this.notify('warn', 'Importa o graba un clip de audio antes de ejecutar el detector musical local.')
      return null
    }

    const bpmRes = detectBpmLocal(mono, sr)
    const keyRes = detectKeyLocal(mono, sr)
    const effectiveBpm = bpmRes?.bpm ?? session.bpm
    const chords = detectChordsViterbi(mono, sr, effectiveBpm, { stepBeats: 2, startBeatOffset: roundBeat(startBeatOffset) })

    this.run('Detección musical local', (cur) => {
      let next = updateSessionMeta(cur, {
        patch: {
          ...(bpmRes ? { bpm: bpmRes.bpm } : {}),
          ...(keyRes ? { key: keyRes.key } : {}),
        },
      })
      if (chords.length > 0) {
        next = setChords(next, { chords })
      }
      return next
    })

    const parts: string[] = []
    if (bpmRes) parts.push(`${bpmRes.bpm} BPM`)
    if (keyRes) parts.push(`Tono ${keyRes.key} (${keyRes.camelot})`)
    if (chords.length > 0) parts.push(`${chords.length} acordes detectados`)
    this.notify('info', `Análisis DSP local (0 cuota IA): ${parts.join(' · ')}.`)
    return {
      bpm: bpmRes?.bpm ?? null,
      key: keyRes?.key ?? null,
      chordsCount: chords.length,
    }
  }

  /** Calibra al instante la cadena completa del Bus Master hacia un objetivo LUFS / True Peak local. */
  applyAutoMaster(profile: AutoMasterProfile = 'streaming', tone: AutoMasterTone = 'balanced', targetLufsOverride?: number): void {
    const session = this.snap.session
    let measuredLufs: number | null = this.mixMeasurement?.metrics.master.lufs ?? null
    let measuredBarkDb: Float32Array | null = null

    // Si hay buffers de audio cargados, tomar una ventana representativa rapida para medir balance espectral.
    const mixWindowSamples = Math.round(session.sampleRate * 12)
    let mixL: Float32Array | null = null
    let mixR: Float32Array | null = null
    for (const track of session.tracks) {
      if (track.kind !== 'audio' || track.mute || track.role === 'click' || track.role === 'guide') continue
      const firstClip = track.clips.find((c) => c.active)
      if (!firstClip) continue
      const seg = this.getClipSegmentChannels(firstClip)
      if (!seg || seg.channels.length === 0) continue
      const len = Math.min(mixWindowSamples, seg.channels[0].length)
      if (!mixL || !mixR) {
        mixL = new Float32Array(mixWindowSamples)
        mixR = new Float32Array(mixWindowSamples)
      }
      const gain = Math.pow(10, (track.volumeDb + firstClip.gainDb) / 20)
      const chL = seg.channels[0]
      const chR = seg.channels[seg.channels.length > 1 ? 1 : 0]
      for (let i = 0; i < len; i++) {
        mixL[i] += chL[i] * gain
        mixR[i] += chR[i] * gain
      }
    }

    if (mixL && mixR) {
      if (measuredLufs === null || !Number.isFinite(measuredLufs)) {
        const lufs = integratedLufs([mixL, mixR], session.sampleRate)
        if (Number.isFinite(lufs)) measuredLufs = lufs
      }
      measuredBarkDb = barkBandEnergiesDb(downmixMono([mixL, mixR]), session.sampleRate)
    }

    let summary = ''
    this.run('Auto-Master local', (cur) => {
      const applied = applyAutoMasterToSession(cur, {
        profile,
        tone,
        targetLufsOverride,
        measuredLufs,
        measuredBarkDb,
      })
      summary = applied.result.summary
      return applied.session
    })
    if (summary) this.notify('info', summary)
  }

  /** Ejecuta el optimizador psicoacustico de 24 bandas Bark para desenmascarar pistas en colision. */
  unmaskMixBark(strength = 0.75): MixUnmaskResult {
    const session = this.snap.session
    const inputs: TrackSpectralInput[] = []
    for (const track of session.tracks) {
      if (track.kind !== 'audio' || track.mute) continue
      const clip = track.clips.find((c) => c.active)
      if (!clip) continue
      const seg = this.getClipSegmentChannels(clip)
      if (!seg || seg.channels.length === 0) continue
      const maxSamples = Math.min(seg.channels[0].length, Math.round(seg.sampleRate * 10))
      inputs.push({
        trackId: track.id,
        samples: downmixMono(seg.channels.map((ch) => ch.subarray(0, maxSamples))),
        sampleRate: seg.sampleRate,
      })
    }

    const res = optimizeBarkMixUnmasking(session, inputs, { strength })
    if (res.actions.length === 0) {
      this.emit({ lastUnmaskResult: res })
      this.notify('info', 'La mezcla actual no presenta colisiones espectrales críticas entre pistas activas.')
      return res
    }
    this.apply(res.session, 'Desenmascarar mezcla (Bark)', { lastUnmaskResult: res })
    this.notify(
      'info',
      `Desenmascarado Bark aplicado en ${res.actions.length} ${res.actions.length === 1 ? 'pista' : 'pistas'} (-${res.reductionPct}% solapamiento espectral).`,
    )
    return res
  }

  /** Sintetiza una pista WAV PCM de 24 bits con clic acentuado y avisos previos de seccion. */
  async generateClickGuideTrack(bars?: number, subdivision: 'quarter' | 'eighth' = 'quarter'): Promise<void> {
    if (this.snap.recording) return
    const session = this.snap.session
    const totalBars = bars ?? computeDefaultClickBars(session)
    try {
      const { blob } = synthesizeClickGuideWav({
        bpm: session.bpm,
        beatsPerBar: session.beatsPerBar,
        bars: totalBars,
        subdivision,
        sampleRate: session.sampleRate,
        markers: session.markers,
      })
      const label = `Clic y Guía (${session.bpm} BPM)`
      const { asset } = await this.ingestAudio(blob, 'Clic_Guia.wav', 'stem', label)
      this.run('Generar pista de clic y guía', (cur) => {
        const existingClick = cur.tracks.find((t) => t.kind === 'audio' && t.role === 'click')
        if (existingClick) {
          const clip = clipForAsset(asset, 0, 0)
          let next = addAsset(cur, { asset })
          next = {
            ...next,
            tracks: next.tracks.map((t) => (t.id === existingClick.id ? { ...t, clips: clip ? [clip] : [] } : t)),
          }
          return next
        }
        return this.addAssetAsTrack(cur, asset, { name: 'Clic / Guía', role: 'click', startS: 0 })
      })
      void this.ensurePeaks()
      this.notify('info', `Pista de clic y guía sintetizada (${totalBars} compases a ${session.bpm} BPM).`)
    } catch (err) {
      this.fail(err, 'No se pudo generar la pista de clic.')
    }
  }

  /** Genera e inserta un clip MIDI con una progresion armonica de acordes en la tonalidad de la sesion. */
  insertChordProgressionClip(
    options: Omit<GenerateProgressionOptions, 'key' | 'beatsPerBar' | 'sessionChords'> & { trackId?: string; startBeat?: number },
  ): string | null {
    if (this.snap.recording) return null
    const session = this.snap.session
    const generated = generateChordProgressionNotes({
      ...options,
      key: session.key,
      beatsPerBar: session.beatsPerBar,
      sessionChords: session.chords,
    })
    const clipId = newStudioId('mid')
    const defaultStartBeat =
      Math.floor(secondsToBeats(this.engine.position(), session.bpm) / session.beatsPerBar + 1e-9) * session.beatsPerBar
    const startBeat = roundBeat(options.startBeat ?? defaultStartBeat)

    let targetTrackId = options.trackId ?? null
    const ok = this.run(
      'Insertar progresión de acordes',
      (cur) => {
        let next = cur
        let track = targetTrackId ? findTrack(next, targetTrackId) : null
        if (!track || track.kind !== 'instrument') {
          const picked = this.snap.selectedTrackId ? findTrack(next, this.snap.selectedTrackId) : null
          track =
            picked?.kind === 'instrument' && picked.instrument?.type !== 'drums'
              ? picked
              : next.tracks.find((t) => t.kind === 'instrument' && t.instrument?.type !== 'drums') ?? null
        }
        if (!track) {
          if (next.tracks.length >= STUDIO_MAX_TRACKS) throw new Error(`El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas.`)
          const newId = newStudioId('trk')
          const inst = defaultInstrument('synth', options.voicing === 'bass' ? 'sub_bass' : 'electric_piano')
          const newTrack = defaultInstrumentTrack({
            id: newId,
            name: options.voicing === 'bass' ? 'Bajo Progresión' : 'Acordes Piano',
            instrument: inst,
            role: options.voicing === 'bass' ? 'bass' : 'keys',
          })
          next = addInstrumentTrack(next, { track: newTrack })
          track = newTrack
        }
        targetTrackId = track.id
        return addMidiClip(next, {
          trackId: track.id,
          clip: defaultMidiClip({
            id: clipId,
            startBeat,
            lengthBeats: generated.lengthBeats,
            notes: generated.notes,
          }),
        })
      },
      { selectedClipId: clipId },
    )
    return ok ? clipId : null
  }

  /** Sincroniza marcadores, acordes ChordPro, BPM, compas y tonalidad desde la ficha oficial de la cancion. */
  syncStructureFromSong(song: Song): void {
    if (this.snap.recording) return
    const ok = this.run('Sincronizar estructura desde Canción', (cur) => applySongStructureToSession(cur, song))
    if (ok) this.notify('info', `Estructura y acordes importados de «${song.title}».`)
  }

  /** Vincula una maqueta libre a una cancion recién promovida en la librería. */
  linkSongId(songId: string): void {
    if (!songId || this.snap.session.songId === songId) return
    this.run('Vincular sesión a canción', (cur) => ({ ...cur, songId }))
  }

  /** Inserta una grabacion rapida (widget movil de ideas) como nueva pista de audio en la sesion abierta. */
  async addQuickIdeaBlob(blob: Blob, label: string, meta?: { bpm?: number; key?: string | null }): Promise<void> {
    if (this.snap.recording) return
    try {
      const { asset } = await this.ingestAudio(blob, `${safeFileName(label, 'Idea')}.wav`, 'recording', label)
      this.run('Agregar idea rápida', (cur) => {
        let next = this.addAssetAsTrack(cur, asset, { name: label.slice(0, STUDIO_MAX_TRACK_NAME), role: 'other', startS: 0 })
        if (meta?.bpm && cur.tracks.length === 0) {
          next = updateSessionMeta(next, { patch: { bpm: meta.bpm, ...(meta.key ? { key: meta.key } : {}) } })
        }
        return next
      })
      void this.ensurePeaks()
      this.notify('info', `Idea «${label}» agregada a la sesión.`)
    } catch (err) {
      this.fail(err, 'No se pudo agregar la grabación rápida.')
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
