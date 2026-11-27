/**
 * Interfaces y firmas del Estudio Bandait. Este archivo NO tiene implementacion ni valores en
 * tiempo de ejecucion: solo tipos. Cada modulo de `services/studio/` implementa su parte y los
 * componentes programan contra estas firmas.
 *
 * Como se usa:
 *   - Se importa siempre con `import type { ... } from './types.ts'` (verbatimModuleSyntax).
 *   - Un modulo de funciones exporta cada funcion con el nombre exacto de su interfaz `*Api` y
 *     cierra con una comprobacion de conformidad, que el compilador borra:
 *       void ({ moveClip, trimClip, splitClip } satisfies SessionOpsApi)
 *   - Un modulo de clase exporta la clase con el nombre indicado y `implements` su interfaz:
 *       export class StudioEngine implements StudioEngineApi { ... }
 *
 * Reglas comunes:
 *   - Los tipos del documento (`StudioSession`, `StudioClip`, `StudioMidiClip`...) y sus limites
 *     viven en session.ts. El contrato del cable es bandait-protocol/STUDIO_V2.md (lo que cambia
 *     en v2) sobre bandait-protocol/STUDIO_V1.md (lo demas).
 *   - Las secciones marcadas "v2" al final de este archivo son del Estudio v2
 *     (docs/PLAN_ESTUDIO_V2.md): se agregaron sin cambiar las firmas de v1. En v2 los tiempos de
 *     MIDI van en beats (sufijo `Beat` o `Beats`), no en segundos.
 *   - Tiempos en segundos (sufijo `S` o `Seconds`), niveles en dB (sufijo `Db`). Un nivel de
 *     silencio es `-Infinity`.
 *   - En el camino del audio no hay eventos por fotograma: medidores, posicion y niveles se LEEN
 *     con una funcion desde requestAnimationFrame. `onStateChange` solo avisa cambios discretos
 *     (reproducir, detener, cargar), nunca el avance del cabezal.
 *   - Modulos puros (sin DOM ni import.meta.env; se prueban con node --experimental-strip-types
 *     e importan con extension .ts): session, sessionOps, history, latency, loudness, peaks, wav,
 *     studioCloud; y en v2: midiOps, smf, commands (el keymap recibe el almacen inyectado) y la
 *     parte pura de midiInput (midiRecording). Los demas usan APIs del navegador.
 */
import type { CloudTarget } from '../stemCloud.ts'
import type { StemRole } from '../stemNames.ts'
import type {
  DrumVoice,
  StudioAsset,
  StudioAssetSource,
  StudioChord,
  StudioClip,
  StudioClipFadeShape,
  StudioFx,
  StudioFxParamsByType,
  StudioFxType,
  StudioInstrument,
  StudioInstrumentType,
  StudioMarker,
  StudioMarkerKind,
  StudioMaster,
  StudioMidiClip,
  StudioMidiNote,
  StudioReverb,
  StudioSession,
  StudioTrack,
  StudioTrackKind,
} from './session.ts'

// ===========================================================================
// sessionOps.ts (puro): operaciones de edicion
// ===========================================================================
//
// Todas son (session, args) => session NUEVA. Nunca mutan la entrada: copian solo lo que cambia
// (las pistas y clips intactos conservan su referencia, para que React y el motor comparen por
// identidad). Si la operacion no cambia nada devuelven la MISMA referencia de sesion.
// Un id inexistente o un resultado que violaria el contrato lanza StudioSessionError (los valores
// numericos fuera de rango se acotan al limite, no lanzan). No tocan `updatedAt`: lo pone
// studioStore al guardar. Los ids nuevos llegan por parametro (newStudioId de session.ts), asi
// las operaciones son deterministas.

/** Rejilla de ajuste de la linea de tiempo. */
export type SnapMode = 'off' | 'bar' | 'beat'

export interface MoveClipArgs {
  clipId: string
  /** Nueva posicion en la sesion; se acota a [0, 1200 - lengthS]. */
  startS: number
  /** Si viene y es otra pista, el clip cambia de pista (queda al final de su lista). */
  trackId?: string
}

export interface TrimClipArgs {
  clipId: string
  /** Borde que se arrastra. */
  edge: 'start' | 'end'
  /**
   * Tiempo de sesion donde debe quedar ese borde. Se acota a la ventana del audio y al largo
   * minimo del clip. Con 'start' cambian startS, offsetS y lengthS; con 'end', solo lengthS.
   * Los fades se recortan si ya no caben.
   */
  toS: number
}

export interface SplitClipArgs {
  clipId: string
  /** Tiempo de sesion del corte; debe caer dentro del clip dejando >= largo minimo a cada lado. */
  atS: number
  /** Id de la mitad derecha. La izquierda conserva el id original. */
  newClipId: string
}

export interface DuplicateClipArgs {
  clipId: string
  newClipId: string
  /** Por defecto, justo donde termina el original. */
  startS?: number
}

export interface DeleteClipArgs {
  clipId: string
}

export interface SetClipFadesArgs {
  clipId: string
  /** Lo que no viene no cambia. Se acotan para que fadeInS + fadeOutS <= lengthS. */
  fadeInS?: number
  fadeOutS?: number
  fadeShape?: StudioClipFadeShape
}

export interface SetClipPhaseInvertArgs {
  clipId: string
  /** Si se omite, invierte el estado actual del clip. */
  phaseInvert?: boolean
}

export interface SetClipGainArgs {
  clipId: string
  gainDb: number
}

export interface SetActiveTakeArgs {
  /**
   * Toma elegida. Queda `active: true`; las demas tomas de su mismo `takeGroup` en la misma
   * pista que se solapan con ella en el tiempo quedan `active: false` (STUDIO_V1.md 2.4).
   * En un clip sin grupo solo lo activa.
   */
  clipId: string
}

export interface AddTrackArgs {
  /** Pista completa (defaultTrack de session.ts arma una vacia). */
  track: StudioTrack
  /** Posicion en la lista; por defecto, al final. */
  index?: number
}

export interface RemoveTrackArgs {
  trackId: string
}

export type TrackPatch = Partial<Pick<StudioTrack, 'name' | 'role' | 'volumeDb' | 'pan' | 'mute' | 'solo' | 'reverbSendDb'>>

export interface UpdateTrackArgs {
  trackId: string
  patch: TrackPatch
}

export interface SetTrackFxArgs {
  /** Id de la pista, o 'master' (STUDIO_MASTER_ID) para la cadena del master. */
  trackId: string
  /** Cadena completa que reemplaza a la anterior. */
  fx: StudioFx[]
}

export type MasterPatch = Partial<Pick<StudioMaster, 'volumeDb' | 'reverb'>>

export interface UpdateMasterArgs {
  patch: MasterPatch
}

export type SessionMetaPatch = Partial<Pick<StudioSession, 'title' | 'songId' | 'bpm' | 'beatsPerBar' | 'key' | 'latencyOffsetMs'>>

export interface UpdateSessionMetaArgs {
  patch: SessionMetaPatch
}

export interface AddAssetArgs {
  /** Si ya existe un audio con ese id e identico contenido, no cambia nada. */
  asset: StudioAsset
}

export interface AddClipArgs {
  trackId: string
  clip: StudioClip
}

export interface SnapTimeArgs {
  timeS: number
  mode: SnapMode
}

export interface ApplyMixSuggestionArgs {
  suggestion: MixSuggestion
}

export interface SessionOpsApi {
  moveClip(session: StudioSession, args: MoveClipArgs): StudioSession
  trimClip(session: StudioSession, args: TrimClipArgs): StudioSession
  splitClip(session: StudioSession, args: SplitClipArgs): StudioSession
  duplicateClip(session: StudioSession, args: DuplicateClipArgs): StudioSession
  deleteClip(session: StudioSession, args: DeleteClipArgs): StudioSession
  setClipFades(session: StudioSession, args: SetClipFadesArgs): StudioSession
  setClipGain(session: StudioSession, args: SetClipGainArgs): StudioSession
  setActiveTake(session: StudioSession, args: SetActiveTakeArgs): StudioSession
  /** Lanza `too_many` si ya hay 16 pistas, `duplicate_id` si el id existe. */
  addTrack(session: StudioSession, args: AddTrackArgs): StudioSession
  /** Quita la pista con sus clips. Los audios quedan en `assets`. */
  removeTrack(session: StudioSession, args: RemoveTrackArgs): StudioSession
  updateTrack(session: StudioSession, args: UpdateTrackArgs): StudioSession
  setTrackFx(session: StudioSession, args: SetTrackFxArgs): StudioSession
  updateMaster(session: StudioSession, args: UpdateMasterArgs): StudioSession
  updateSessionMeta(session: StudioSession, args: UpdateSessionMetaArgs): StudioSession
  addAsset(session: StudioSession, args: AddAssetArgs): StudioSession
  /** Lanza `unknown_asset` si el audio del clip no esta en la sesion. */
  addClip(session: StudioSession, args: AddClipArgs): StudioSession
  /** Quita de `assets` los audios que ningun clip usa. */
  removeUnusedAssets(session: StudioSession): StudioSession
  /**
   * Aplica una sugerencia del asistente (STUDIO_V1.md 6.4): fader, paneo, o un efecto (si la
   * pista ya tiene ese tipo, mezcla los parametros y quita el bypass; si no, lo agrega con los
   * valores por defecto mas los propuestos; el limitador siempre queda de ultimo en el master).
   */
  applyMixSuggestion(session: StudioSession, args: ApplyMixSuggestionArgs): StudioSession
  /**
   * Unica operacion que no devuelve una sesion: el tiempo ajustado a la rejilla del BPM y el
   * compas de la sesion (compas 1 en 0 s). Con 'off' devuelve `timeS` acotado a >= 0.
   */
  snapTime(session: StudioSession, args: SnapTimeArgs): number
}

// ===========================================================================
// history.ts (puro): deshacer y rehacer
// ===========================================================================

export interface StudioHistory<T> {
  /**
   * Registra `state` como el presente. El primer push es la linea base (no se puede deshacer
   * mas alla). Un push despues de deshacer descarta lo que se podia rehacer. Un push con la
   * misma referencia que el presente no hace nada.
   */
  push(state: T, label?: string): void
  /** Vuelve un paso y devuelve ese estado; null si no hay a donde volver. */
  undo(): T | null
  /** Rehace un paso y devuelve ese estado; null si no hay nada que rehacer. */
  redo(): T | null
  canUndo(): boolean
  canRedo(): boolean
  /** Estado presente, o null si todavia no hubo push. */
  current(): T | null
  /** Etiqueta del paso que desharia `undo` ("Dividir clip"), o null. */
  undoLabel(): string | null
  redoLabel(): string | null
  /**
   * Todos los estados que el historial conserva, los que se pueden deshacer y los que se pueden
   * rehacer. Sirve para saber que audios sigue referenciando algun paso (no borrar su archivo).
   */
  states(): T[]
  clear(): void
}

export interface HistoryApi {
  /** `limit` = pasos que se pueden deshacer (el Estudio usa 100). Al pasarse, olvida el mas viejo. */
  createHistory<T>(limit: number): StudioHistory<T>
}

// ===========================================================================
// latency.ts (puro): alineacion de tomas y calibracion
// ===========================================================================

export interface DelayEstimate {
  /** Retardo de `recorded` respecto a `reference`, en muestras enteras, 0..maxDelay. */
  delaySamples: number
  /**
   * Confianza 0..1: pico de la correlacion normalizada, penalizado si hay un segundo pico
   * comparable. Por debajo de LATENCY_MIN_CONFIDENCE (constante de latency.ts, 0.5) la
   * calibracion se descarta.
   */
  confidence: number
}

export interface TakeStartInput {
  /** Posicion de la sesion al arrancar la reproduccion, en segundos. */
  positionAtStart: number
  /** Tiempo del AudioContext del primer bloque capturado. */
  firstBlockCtxTime: number
  /** Tiempo del AudioContext en que la reproduccion arranco en `positionAtStart`. */
  playStartCtxTime: number
  /** Latencia de ida y vuelta (calibrada o estimada) mas `latencyOffsetMs / 1000` de la sesion. */
  roundTripSeconds: number
}

/** Calibracion de una interfaz a una frecuencia. Se guarda por (etiqueta, sampleRate). */
export interface LatencyCalibration {
  /** `MediaDeviceInfo.label` de la entrada ("UMC202HD 192k"). */
  deviceLabel: string
  sampleRate: number
  roundTripSeconds: number
  confidence: number
  /** Diferencia entre la mayor y la menor de las mediciones de esa calibracion, en segundos. */
  spreadSeconds: number
  /** ISO 8601. */
  measuredAt: string
}

/** Almacen inyectable: `localStorage` lo cumple; las pruebas pasan uno en memoria. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Latencias que informa el navegador, en segundos (0 si no las informa). */
export interface BrowserLatencyInput {
  /** AudioContext.baseLatency */
  baseLatency: number
  /** AudioContext.outputLatency */
  outputLatency: number
  /** MediaTrackSettings.latency de la entrada */
  inputLatency: number
}

export interface LatencyApi {
  /**
   * Correlacion cruzada normalizada: cuanto se retrasa `recorded` respecto a `reference`,
   * buscando de 0 a `maxDelayMs`. Con senal insuficiente devuelve confianza 0.
   */
  estimateDelaySamples(reference: Float32Array, recorded: Float32Array, sampleRate: number, maxDelayMs: number): DelayEstimate
  /**
   * positionAtStart + (firstBlockCtxTime - playStartCtxTime) - roundTripSeconds.
   * NO acota: un resultado negativo significa que la toma empieza antes del segundo 0; quien
   * arma el clip pone startS = 0 y offsetS = -resultado (STUDIO_V1.md 2.7).
   */
  takeStartSeconds(input: TakeStartInput): number
  /** Estimacion sin calibrar: baseLatency + outputLatency + inputLatency. */
  browserLatencySeconds(input: BrowserLatencyInput): number
  /** Senal de calibracion (rafaga de clics) para emitir y correlacionar, mono. */
  calibrationSignal(sampleRate: number): Float32Array
  /** Clave de almacenamiento: "bandait_studio_latency:<etiqueta normalizada>:<sampleRate>". */
  calibrationKey(deviceLabel: string, sampleRate: number): string
  loadCalibration(storage: KeyValueStorage, deviceLabel: string, sampleRate: number): LatencyCalibration | null
  saveCalibration(storage: KeyValueStorage, calibration: LatencyCalibration): void
  clearCalibration(storage: KeyValueStorage, deviceLabel: string, sampleRate: number): void
}

// ===========================================================================
// loudness.ts (puro): LUFS integrado y pico real (ITU-R BS.1770)
// ===========================================================================

/** Energia por banda en dB relativa a la energia total (<= 0, piso -120). STUDIO_V1.md 6.3. */
export interface BandEnergies {
  /** Hasta 200 Hz. */
  lowDb: number
  /** 200 a 2000 Hz. */
  lowMidDb: number
  /** 2000 a 6000 Hz. */
  highMidDb: number
  /** Desde 6000 Hz. */
  highDb: number
}

export interface LoudnessApi {
  /**
   * LUFS integrado con ponderacion K y doble compuerta (absoluta -70 LUFS, relativa -10 LU).
   * `channels`: 1 (mono) o 2 (izquierda, derecha), del mismo largo. Silencio o audio de menos
   * de 400 ms: -Infinity.
   */
  integratedLufs(channels: Float32Array[], sampleRate: number): number
  /** Pico real en dBTP, con sobremuestreo x4. Silencio: -Infinity. */
  truePeakDb(channels: Float32Array[], sampleRate: number): number
  /**
   * Ganancia en dB para llevar `currentLufs` a `targetLufs`. Si vienen `truePeakDb` y
   * `ceilingDb` (por defecto -1), la ganancia se limita para que el pico no pase el techo.
   * Con `currentLufs` -Infinity devuelve 0.
   */
  gainToTargetLufs(currentLufs: number, targetLufs: number, truePeakDb?: number, ceilingDb?: number): number
  /** Energia por banda para las metricas del asistente; null si es silencio. */
  bandEnergiesDb(channels: Float32Array[], sampleRate: number): BandEnergies | null
}

// ===========================================================================
// peaks.ts (puro): picos para dibujar formas de onda
// ===========================================================================

/**
 * Picos de UN canal. Cada cubeta resume `samplesPerBucket` muestras como minimo y maximo,
 * cuantizados a Int8: valor = round(muestra * 127), acotado a -127..127.
 */
export interface PeakData {
  min: Int8Array
  max: Int8Array
  samplesPerBucket: number
  /**
   * Valor eficaz (RMS) de cada cubeta, cuantizado a Uint8: round(rms * 255), 0..255. Opcional
   * (2026-11-26, forma de onda configurable): los picos guardados antes no lo traen y se
   * recalculan en segundo plano al abrir la sesion (studioState.ensurePeaks); mientras tanto la
   * forma de onda RMS usa el pico.
   */
  rms?: Uint8Array
}

/** Picos de un audio completo: lo que guarda studioStore.savePeaks. */
export interface AssetPeaks {
  assetId: string
  sampleRate: number
  /** Un PeakData por canal, todos con el mismo samplesPerBucket (PEAKS_BASE_BUCKET = 256). */
  channels: PeakData[]
}

/** Picos listos para pintar: una columna por pixel, en -1..1. */
export interface PeakColumns {
  min: Float32Array
  max: Float32Array
  /** RMS por columna en 0..1, si los picos lo traen y quien pide paso donde escribirlo. */
  rms?: Float32Array
}

export interface PeakRangeRequest {
  /** Frecuencia del audio al que pertenecen los picos. */
  sampleRate: number
  /** Ventana dentro del AUDIO (no de la sesion), en segundos: clip.offsetS .. offsetS + lengthS. */
  startS: number
  endS: number
  /** Columnas (pixeles) a devolver, >= 1. */
  columns: number
}

export interface PeaksApi {
  /** La ultima cubeta puede cubrir menos muestras. `samplesPerBucket` entero >= 1. */
  computePeaks(samples: Float32Array, samplesPerBucket: number): PeakData
  /**
   * Picos por rango: reagrupa las cubetas que cubren [startS, endS) en `columns` columnas
   * (minimo de minimos, maximo de maximos; el RMS como raiz de la media de los cuadrados).
   * Fuera del audio devuelve 0. No asigna por fotograma si se le pasa `out` del tamano
   * correcto; el RMS se escribe solo si los picos lo traen y `out` trae `rms` (o no hay `out`).
   */
  peaksForRange(peaks: PeakData, request: PeakRangeRequest, out?: PeakColumns): PeakColumns
}

// ===========================================================================
// wav.ts (puro): se AGREGA a services/wav.ts, sin cambiar lo que ya exporta
// ===========================================================================

export type WavBitDepth = 16 | 24

export interface WavHeader {
  /** 1 = PCM entero, 3 = coma flotante IEEE. WAVE_FORMAT_EXTENSIBLE se resuelve a 1 o 3. */
  format: 1 | 3
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** Byte donde empiezan las muestras. */
  dataOffset: number
  /** Bytes de muestras que declara el bloque `data` (0 en una toma que no se cerro). */
  dataBytes: number
  /** dataBytes / (channels * bitsPerSample / 8). */
  frames: number
  durationS: number
}

export interface WavHeaderInput {
  channels: number
  sampleRate: number
  bitDepth: WavBitDepth
  /** Bytes de muestras; 0 para escribir una cabecera provisional que se corrige al cerrar. */
  dataBytes: number
}

export interface WavApi {
  /** WAV PCM de 24 bits, canales intercalados (1 o 2), little endian. Satura fuera de [-1, 1]. */
  encodeWav24(channels: Float32Array[], sampleRate: number): ArrayBuffer
  /** WAV PCM de 16 o 24 bits, canales intercalados. Lo usa bounce. */
  encodeWavPcm(channels: Float32Array[], sampleRate: number, bitDepth: WavBitDepth): ArrayBuffer
  /** Cabecera canonica de 44 bytes. La usa el escritor de OPFS al abrir y al cerrar la toma. */
  buildWavHeader(input: WavHeaderInput): ArrayBuffer
  /**
   * Convierte un bloque Float32 a PCM de 24 bits little endian dentro de `out`, desde
   * `byteOffset`. Devuelve el siguiente byteOffset. No asigna memoria.
   */
  floatTo24(samples: Float32Array, out: Uint8Array, byteOffset: number): number
  /**
   * Lee la cabecera RIFF/WAVE (recorre los bloques hasta `data`). `bytes` basta con los
   * primeros kilobytes del archivo. null si no es un WAV que se pueda leer.
   */
  parseWavHeader(bytes: ArrayBuffer | Uint8Array): WavHeader | null
}

// ===========================================================================
// graph.ts: el grafo de audio, uno solo para tiempo real y para exportar
// ===========================================================================
//
// Por pista:  entrada (trackInputs) -> inserts (fx) -> paneo -> fader/mute/solo -> salida
//                                                               salida -> master
//                                                               salida -> envio -> reverb
// Master:     suma + retorno de reverb -> fx (eq, compresor) -> volumeDb -> limitador -> `master`
// Los clips NO son parte del grafo: los programa scheduleClips contra `trackInputs`.

/** Audio decodificado por id de audio (asset.id). Un audio que falta simplemente no suena. */
export type StudioBuffers = ReadonlyMap<string, AudioBuffer>

export interface GraphCapabilities {
  /** true si el worklet del limitador cargo; false = se usa un DynamicsCompressorNode de respaldo. */
  limiterWorklet: boolean
}

export interface StudioGraph {
  /** Nodo final de la mezcla. buildGraph NO lo conecta a `ctx.destination`: lo hace quien llama. */
  master: AudioNode
  /** Entrada de cada pista (id de pista -> nodo), donde se conectan las fuentes de los clips. */
  trackInputs: ReadonlyMap<string, AudioNode>
  /** Salida post-fader de cada pista, para medidores y para exportar pistas por separado. */
  trackOutputs: ReadonlyMap<string, AudioNode>
  /**
   * v2: instrumento de cada pista de instrumento disponible (id de pista -> nodo), ya conectado
   * a su `trackInputs`. Falta la pista cuyo instrumento no esta disponible (suena su congelado,
   * que se programa como un clip de audio desde el segundo 0). Opcional para no romper v1.
   */
  instruments?: ReadonlyMap<string, StudioInstrumentNode>
  /**
   * Aplica en caliente los cambios de parametros de `session` (fader, paneo, mute, solo, envio,
   * parametros y bypass de efectos, master, reverb) con rampas cortas, sin clics. Devuelve
   * false si la topologia cambio (pistas agregadas o quitadas, efectos agregados, quitados o
   * reordenados): en ese caso no aplica nada y quien llama debe reconstruir el grafo.
   */
  update(session: StudioSession): boolean
  /** Desconecta y libera todos los nodos. Idempotente. */
  dispose(): void
}

export interface ScheduleClipsOptions {
  /** Posicion de la sesion desde la que se reproduce, en segundos. */
  fromS: number
  /** Tiempo del contexto en que `fromS` debe sonar (ctx.currentTime + margen; 0 en offline). */
  atCtxTime: number
  /** Si viene, no programa nada mas alla de esta posicion (fin de una repeticion). */
  untilS?: number
  /** Si viene, solo programa los clips de estas pistas. */
  trackIds?: ReadonlySet<string>
}

export interface ScheduledClips {
  /** Detiene todas las fuentes en `atCtxTime` (por defecto, ya) con una rampa corta. */
  stop(atCtxTime?: number): void
  /** Desconecta las fuentes. Idempotente. */
  dispose(): void
}

export interface GraphApi {
  /**
   * Carga en el contexto lo que el grafo necesita antes de construirse (worklet del limitador).
   * Idempotente por contexto. Se llama una vez por AudioContext y por cada OfflineAudioContext.
   */
  prepareGraphContext(ctx: BaseAudioContext): Promise<GraphCapabilities>
  /**
   * Construye el grafo de `session` en `ctx`. Es sincrono y es EL MISMO para AudioContext y
   * OfflineAudioContext: lo que suena es lo que se exporta. No incluye el clic del Estudio.
   * `buffers` informa los canales de cada audio; buildGraph no programa clips (scheduleClips).
   * v2: `instruments` es lo que dejo listo `prepareInstruments` (worklets, plugins WAM creados);
   * sin el, las pistas de instrumento usan solo nodos nativos o quedan no disponibles.
   */
  buildGraph(ctx: BaseAudioContext, session: StudioSession, buffers: StudioBuffers, instruments?: InstrumentPreparation): StudioGraph
  /**
   * Programa los clips activos de la sesion contra el grafo, alineados a la muestra en el
   * reloj del contexto: ganancia de clip y fades incluidos. La usan el motor y bounce.
   */
  scheduleClips(ctx: BaseAudioContext, graph: StudioGraph, session: StudioSession, buffers: StudioBuffers, options: ScheduleClipsOptions): ScheduledClips
}

// ===========================================================================
// engine.ts: transporte en tiempo real. `export class StudioEngine implements StudioEngineApi`
// ===========================================================================

/** Devuelve el audio decodificado de un asset, o null si no esta en este equipo. */
export type ResolveAudio = (asset: StudioAsset) => Promise<AudioBuffer | null>

export type EngineStatus = 'empty' | 'loading' | 'stopped' | 'count_in' | 'playing'

export interface LoopRegionS {
  startS: number
  endS: number
}

export interface EngineState {
  status: EngineStatus
  /** Fin del ultimo clip activo, en segundos. */
  durationS: number
  loop: LoopRegionS | null
  /** Ids de audios de la sesion que no se pudieron resolver (no suenan). */
  missingAssetIds: string[]
  click: ClickSettings
}

export interface ClickSettings {
  enabled: boolean
  /** Volumen propio del clic; no pasa por el master ni entra en la mezcla exportada. */
  volumeDb: number
  /** Compases de conteo antes de arrancar cuando se pide `play({ countIn: true })`. 0..4. */
  countInBars: number
}

export interface PlayOptions {
  /** Posicion desde la que arranca; por defecto, la actual. */
  fromS?: number
  /** true = suena el conteo previo (ClickSettings.countInBars) antes de arrancar. */
  countIn?: boolean
}

/** Lo que el grabador necesita para alinear una toma (latency.takeStartSeconds). */
export interface PlayStart {
  /** Posicion de la sesion en la que arranca la reproduccion. */
  positionAtStart: number
  /**
   * Tiempo del AudioContext en que esa posicion SALE del grafo (despues del conteo, si lo hay):
   * el instante programado mas el retardo del grafo (limitador y compresores con anticipacion).
   * No incluye la latencia de salida del equipo: esa va en la calibracion de ida y vuelta.
   */
  playStartCtxTime: number
}

export interface MeterReading {
  /** Pico de la ultima ventana, en dBFS. */
  peakDb: number
  /** RMS de la ultima ventana, en dBFS. */
  rmsDb: number
}

export interface MasterMeterReading extends MeterReading {
  /** LUFS momentaneo (400 ms). */
  momentaryLufs: number
  /** LUFS integrado desde el ultimo resetMasterLoudness o el ultimo arranque. */
  integratedLufs: number
  /** Pico real maximo desde el ultimo reinicio, en dBTP. */
  truePeakDb: number
}

export interface EngineLoadProgress {
  done: number
  total: number
}

export interface StudioEngineOptions {
  /** Contexto a usar; por defecto el motor crea uno con `sampleRate` de la sesion al cargar. */
  context?: AudioContext
}

export interface StudioEngineApi {
  /**
   * Carga la sesion: resuelve y guarda el audio de cada asset usado por algun clip, prepara el
   * contexto y construye el grafo. Reemplaza lo que hubiera. Un audio que no se resuelve queda
   * en `missingAssetIds`; no hace fallar la carga.
   */
  load(session: StudioSession, resolveAudio: ResolveAudio, onProgress?: (progress: EngineLoadProgress) => void): Promise<void>
  /**
   * Arranca (reanuda el AudioContext si hace falta: debe llamarse desde un gesto del usuario).
   * Resuelve cuando la reproduccion quedo PROGRAMADA, con los datos de alineacion. Llamarlo
   * mientras ya suena devuelve el PlayStart vigente sin reprogramar.
   */
  play(options?: PlayOptions): Promise<PlayStart>
  /** Detiene y conserva la posicion. */
  pause(): void
  /** Detiene y vuelve a la posicion desde la que arranco la ultima reproduccion. */
  stop(): void
  /** Mueve el cabezal; si esta sonando, reprograma desde ahi. Se acota a [0, 1200]. */
  seek(positionS: number): void
  /**
   * Posicion actual en segundos, calculada del reloj del AudioContext. Barata y sin efectos:
   * se llama desde requestAnimationFrame. Durante el conteo devuelve la posicion de arranque.
   */
  position(): number
  /** Estado discreto actual (misma referencia mientras no cambie). */
  getState(): EngineState
  /** Region de repeticion, o null para quitarla. */
  setLoop(region: LoopRegionS | null): void
  /**
   * Sesion editada, en caliente. Cambios de mezcla se aplican con `graph.update`; cambios de
   * clips o de topologia reprograman sin cortar el transporte. Si la sesion trae audios nuevos
   * los resuelve con `resolveAudio` (el de `load` si no viene otro).
   */
  updateSession(session: StudioSession, resolveAudio?: ResolveAudio): Promise<void>
  /** Medidor post-fader de una pista. Pista inexistente: silencio. */
  readTrackMeter(trackId: string): MeterReading
  readMasterMeter(): MasterMeterReading
  resetMasterLoudness(): void
  setClick(settings: ClickSettings): void
  /** Avisa cambios de EngineState. Devuelve la funcion para dejar de escuchar. */
  onStateChange(listener: (state: EngineState) => void): () => void
  /** El AudioContext del motor, para que el grabador comparta reloj. Lo crea si no existe. */
  getContext(): AudioContext
  /** Audio ya decodificado de un asset (para picos y exportacion), o null. */
  getBuffer(assetId: string): AudioBuffer | null
  /** Todos los audios decodificados, para pasarlos a bounce. */
  getBuffers(): StudioBuffers
  /** Detiene, libera el grafo y cierra el contexto si lo creo el motor. Idempotente. */
  dispose(): void
}

// ===========================================================================
// bounce.ts: mezcla final sin tiempo real (OfflineAudioContext + buildGraph)
// ===========================================================================

export interface BounceOptions {
  /** 'mix' = una mezcla estereo; 'tracks' = un archivo por pista (post-fader, sin el master). */
  mode: 'mix' | 'tracks'
  bitDepth: WavBitDepth
  /** Frecuencia del archivo; normalmente session.sampleRate. */
  sampleRate: number
  /** Tramo a exportar; por defecto de 0 al fin del ultimo clip activo mas la cola de reverb. */
  range?: LoopRegionS
  /** Solo en modo 'tracks': pistas a exportar; por defecto todas las que tienen clips activos. */
  trackIds?: readonly string[]
  /** 0..1. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface BounceFile {
  /** WAV, `audio/wav`. */
  blob: Blob
  durationS: number
  /** LUFS integrado y pico real del archivo exportado (loudness.ts). */
  lufs: number
  truePeakDb: number
}

export interface BouncedTrack extends BounceFile {
  trackId: string
  name: string
  role: StemRole
}

export type BounceResult = { mode: 'mix'; mix: BounceFile } | { mode: 'tracks'; tracks: BouncedTrack[] }

export interface BounceApi {
  /**
   * Exporta la sesion. Respeta mute y solo en modo 'mix'; en modo 'tracks' cada pista se exporta
   * sola, ignorando mute y solo. Abortar rechaza con un DOMException 'AbortError'.
   */
  bounce(session: StudioSession, buffers: StudioBuffers, options: BounceOptions): Promise<BounceResult>
  /** La mezcla como AudioBuffer, sin codificar (para medir o normalizar). */
  renderMix(session: StudioSession, buffers: StudioBuffers, options: Pick<BounceOptions, 'sampleRate' | 'range' | 'signal'>): Promise<AudioBuffer>
}

// ===========================================================================
// recorder.ts: `export class StudioRecorder implements StudioRecorderApi`
// ===========================================================================

export interface StudioInputDevice {
  deviceId: string
  /** Vacio hasta que el usuario concede el permiso de microfono. */
  label: string
  groupId: string
}

export interface OpenInputOptions {
  deviceId: string
  /** Canales a pedir a la interfaz (la UMC202HD entrega 2). */
  channels: 1 | 2
}

export type RecorderWarning =
  /** El navegador dejo activo algun procesamiento de voz. */
  | 'echo_cancellation_on'
  | 'noise_suppression_on'
  | 'auto_gain_control_on'
  /** Entrego menos canales de los pedidos. */
  | 'fewer_channels'
  /** La frecuencia de la entrada no es la del AudioContext (el navegador remuestrea). */
  | 'sample_rate_mismatch'
  /** No hay calibracion para esta interfaz y frecuencia: se usa la estimacion del navegador. */
  | 'uncalibrated'

/** Lo que el navegador respeto de lo pedido (MediaStreamTrack.getSettings()). */
export interface RecorderSettingsReport {
  deviceId: string
  label: string
  channelCount: number
  /** Frecuencia de la entrada segun el navegador; null si no la informa. */
  sampleRate: number | null
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
  /** MediaTrackSettings.latency en segundos; null si no la informa. */
  inputLatencySeconds: number | null
  /** Calibracion vigente para esta interfaz y la frecuencia del contexto, o null. */
  calibration: LatencyCalibration | null
  warnings: RecorderWarning[]
}

/** Que canal de la interfaz graba en que pista. */
export interface RecorderArm {
  trackId: string
  /** 0 = entrada 1, 1 = entrada 2, 'stereo' = el par como un solo audio de dos canales. */
  channel: 0 | 1 | 'stereo'
}

export type RecorderStatus = 'closed' | 'open' | 'armed' | 'recording' | 'stopping' | 'calibrating'

export interface RecordingStart extends PlayStart {
  /** Latencia de ida y vuelta que se aplicara a la toma (incluye latencyOffsetMs). */
  roundTripSeconds: number
  calibrated: boolean
}

export interface RecordedTake {
  /** Id del audio nuevo; su archivo ya esta cerrado en OPFS (studioStore.getAsset lo lee). */
  assetId: string
  /** Canal de la interfaz del que salio. */
  channel: 0 | 1 | 'stereo'
  /** Pista para la que se armo. */
  trackId: string
  /** Posicion de la toma en la sesion (latency.takeStartSeconds); puede ser negativa. */
  startSeconds: number
  durationSeconds: number
  /** Bloques de audio perdidos entre el worklet y el escritor. Lo normal es 0. */
  droppedBlocks: number
  calibrated: boolean
  /** Entrada lista para sessionOps.addAsset: kind 'recording', WAV de 24 bits. */
  asset: StudioAsset
}

export interface StudioRecorderDeps {
  /** El contexto del motor (engine.getContext()): el grabador comparte su reloj. */
  context: AudioContext
  /** Sesion en la que se graba: los audios van a OPFS bajo su id. */
  sessionId: string
  /** Donde se guardan las calibraciones (localStorage en el navegador). */
  calibrationStorage: KeyValueStorage
  /** Ajuste manual de la sesion, leido al arrancar cada toma. */
  getLatencyOffsetMs: () => number
}

export interface StudioRecorderApi {
  /** Entradas de audio del equipo. Pide el permiso de microfono si hace falta para ver etiquetas. */
  listInputs(): Promise<StudioInputDevice[]>
  /**
   * Abre la entrada con deviceId exacto y echoCancellation, noiseSuppression y autoGainControl
   * en false, y la conecta al worklet de captura. Devuelve lo que el navegador respeto.
   */
  open(options: OpenInputOptions): Promise<RecorderSettingsReport>
  /** El informe de la entrada abierta, o null si no hay ninguna. */
  reportSettings(): RecorderSettingsReport | null
  /** Que canales se graban y a que pistas. Lista vacia = desarmar. */
  arm(arms: readonly RecorderArm[]): void
  /**
   * Empieza a capturar los canales armados y arranca el motor con conteo previo
   * (engine.play({ countIn: true })); si el motor ya suena, entra de inmediato (pinchazo).
   */
  start(engine: StudioEngineApi): Promise<RecordingStart>
  /**
   * Deja de capturar, cierra los WAV en OPFS y devuelve una toma por canal armado. NO detiene
   * el motor ni toca la sesion: quien llama agrega asset y clip con sessionOps.
   */
  stop(): Promise<RecordedTake[]>
  /**
   * Mide la latencia de ida y vuelta: emite latency.calibrationSignal por la salida, la graba
   * por la entrada 1 y correlaciona. Hace 3 mediciones, guarda la mediana y la devuelve. Rechaza
   * con un Error de mensaje en espanol si la confianza es baja (falta el cable de Salida 1 a
   * Entrada 1). Requiere la entrada abierta y el motor detenido.
   */
  calibrate(): Promise<LatencyCalibration>
  /** Nivel de un canal de la entrada (0 o 1), para pintar desde requestAnimationFrame. */
  readLevel(channel: 0 | 1): MeterReading
  /** Monitoreo por software (con retardo). Apagado por defecto. */
  setMonitor(enabled: boolean): void
  getStatus(): RecorderStatus
  onStatusChange(listener: (status: RecorderStatus) => void): () => void
  /** Suelta la entrada y el worklet. Si estaba grabando, primero cierra las tomas. Idempotente. */
  close(): Promise<void>
}

// ===========================================================================
// studioStore.ts: sesiones en IndexedDB "bandait_studio", audio en OPFS
// ===========================================================================
//
// IndexedDB `bandait_studio` v1:
//   - sessions: { id, band, title, songId, updatedAt, savedAt, etag, dirty, doc }   clave `id`
//               (`doc` es el documento del cable, snake_case: serializeSession)
//   - peaks:    { key: "<sessionId>/<assetId>", sessionId, peaks }                  indice sessionId
// OPFS: bandait_studio/<sessionId>/<file>      (`file` = asset.file, "<assetId>.<ext>")
//   El escritor de tomas (opfsWriter.worker.ts) escribe directo en esa ruta, con cabecera WAV
//   provisional (dataBytes 0) que corrige al cerrar. Una toma huerfana es un archivo de esa
//   carpeta que la sesion no lista.

export interface StoredSessionMeta {
  id: string
  /** uuid de la banda compartida o 'me' (cloudBandKey de stemCloud.ts). */
  band: string
  title: string
  songId: string | null
  /** `updatedAt` del documento. */
  updatedAt: string
  /** Cuando se guardo en este equipo, ISO 8601. */
  savedAt: string
  /** ETag de la ultima version conocida de la nube; null si nunca se subio ni se bajo. */
  etag: string | null
  /** true si hay cambios locales que no se han subido. */
  dirty: boolean
  /**
   * `updated_at` que puso el Worker en la ultima version subida o bajada (el de la lista de la
   * nube). Es lo que se compara para saber si la nube tiene otra version: `updatedAt` es la hora
   * de este equipo y nunca coincide con la del Worker. null si nunca se subio ni se bajo.
   */
  cloudUpdatedAt: string | null
}

export interface StoredSession {
  session: StudioSession
  meta: StoredSessionMeta
}

export interface SaveSessionOptions {
  band: string
  /** Lo que no viene se conserva de lo guardado (o null / true en una sesion nueva). */
  etag?: string | null
  dirty?: boolean
  cloudUpdatedAt?: string | null
}

/** Archivo de audio en OPFS que la sesion no lista: una toma que no llego a guardarse. */
export interface OrphanTake {
  sessionId: string
  file: string
  assetId: string
  /** Bytes en disco. */
  size: number
  /** Milisegundos desde epoch. */
  lastModified: number
  /** Cabecera leida del archivo; null si no se puede leer como WAV. */
  header: WavHeader | null
  /** Duracion estimada desde el tamano en disco (la cabecera de una toma sin cerrar dice 0). */
  estimatedDurationS: number
}

export interface StorageEstimate {
  usageBytes: number
  quotaBytes: number
}

export interface StudioStoreApi {
  /** Guarda (o reemplaza) la sesion. Pone `updatedAt` = ahora en el documento si `dirty` es true. */
  saveSession(session: StudioSession, options: SaveSessionOptions): Promise<StoredSession>
  loadSession(sessionId: string): Promise<StoredSession | null>
  /** Mas recientes primero. Con `band`, solo las de esa banda. */
  listSessions(band?: string): Promise<StoredSessionMeta[]>
  /** Borra el documento, sus picos y su carpeta de audio en OPFS. */
  deleteSession(sessionId: string): Promise<void>
  /** Escribe un audio en OPFS. Un audio es inmutable: si ya existe con el mismo tamano no hace nada. */
  putAsset(sessionId: string, file: string, data: Blob): Promise<void>
  /** El audio como File (un Blob respaldado por disco: no carga el archivo en memoria), o null. */
  getAsset(sessionId: string, file: string): Promise<File | null>
  hasAsset(sessionId: string, file: string): Promise<boolean>
  deleteAsset(sessionId: string, file: string): Promise<void>
  /** Archivos de audio de la carpeta de la sesion que no estan en `knownFiles` (asset.file). */
  listOrphanTakes(sessionId: string, knownFiles: readonly string[]): Promise<OrphanTake[]>
  /**
   * Repara la cabecera WAV de una toma sin cerrar (segun el tamano en disco) y devuelve su
   * entrada lista para sessionOps.addAsset (kind 'recording').
   */
  recoverOrphanTake(sessionId: string, file: string): Promise<StudioAsset>
  discardOrphanTake(sessionId: string, file: string): Promise<void>
  savePeaks(sessionId: string, peaks: AssetPeaks): Promise<void>
  loadPeaks(sessionId: string, assetId: string): Promise<AssetPeaks | null>
  /** Uso y cuota del almacenamiento del navegador (navigator.storage.estimate). */
  estimateStorage(): Promise<StorageEstimate | null>
  /** true si este navegador tiene OPFS e IndexedDB. Sin ellos el Estudio no abre. */
  isSupported(): boolean
}

// ===========================================================================
// Trabajos de IA (STUDIO_V1.md seccion 6). Tipos del Hub en camelCase; studioCloud traduce.
// ===========================================================================

export type StudioJobKind = 'master' | 'separate' | 'generate' | 'assist'

export interface MasterJobRequest {
  kind: 'master'
  /** Id (sin extension) de una mezcla ya subida con putAsset. */
  assetId: string
  durationS: number
  /** -24..-6; el Hub propone -14. */
  targetLufs: number
}

export interface SeparateJobRequest {
  kind: 'separate'
  assetId: string
  durationS: number
}

export interface GenerateJobRequest {
  kind: 'generate'
  provider: 'lyria' | 'suno'
  /** 1..1000 caracteres. */
  prompt: string
  /** 5..240 segundos; el proveedor puede devolver otra duracion. */
  durationS: number
  bpm: number
  key: string | null
  instrumental: boolean
}

export interface AssistJobRequest {
  kind: 'assist'
  metrics: MixMetrics
}

export type StudioJobRequest = MasterJobRequest | SeparateJobRequest | GenerateJobRequest | AssistJobRequest

/** Medidas de una pista para el asistente. Solo numeros: nunca se manda audio. */
export interface TrackMetrics {
  trackId: string
  name: string
  role: StemRole
  /** LUFS integrado de la pista sola, post-fader; null si es silencio. */
  lufs: number | null
  truePeakDb: number | null
  bands: BandEnergies | null
  volumeDb: number
  pan: number
  fx: StudioFx[]
}

export interface MixMetrics {
  /** Volumen objetivo de la mezcla, -24..-6. */
  targetLufs: number
  master: { lufs: number | null; truePeakDb: number | null }
  /** 1..16 pistas. */
  tracks: TrackMetrics[]
}

interface MixSuggestionBase {
  /** Id de una pista, o 'master' (STUDIO_MASTER_ID). */
  trackId: string
  /** Por que se propone, en espanol, 1..280 caracteres. */
  reason: string
}

export interface VolumeSuggestion extends MixSuggestionBase {
  target: 'volume_db'
  /** Fader nuevo, en dB. */
  value: number
}

export interface PanSuggestion extends MixSuggestionBase {
  /** Nunca para 'master'. */
  target: 'pan'
  value: number
}

export type FxSuggestion = {
  [T in StudioFxType]: MixSuggestionBase & {
    target: 'fx'
    /** 'limiter' solo con trackId 'master'. */
    fxType: T
    /** Solo los parametros que cambian. */
    params: Partial<StudioFxParamsByType[T]>
  }
}[StudioFxType]

/**
 * Cambio propuesto por el asistente. En el cable (STUDIO_V1.md 6.4) todas traen
 * track_id, target, value, fx_type, params y reason, con null en lo que no aplica.
 */
export type MixSuggestion = VolumeSuggestion | PanSuggestion | FxSuggestion

/** Audio que deja un trabajo en assets/ de la nube. Todavia NO es parte de la sesion. */
export interface StudioJobAsset {
  id: string
  file: string
  kind: 'master' | 'stem' | 'generated'
  label: string
  /** Rol del stem; null en master y generate. */
  role: StemRole | null
  size: number
  /** null cuando el Worker no los conoce: el Hub los completa al decodificar. */
  channels: 1 | 2 | null
  sampleRate: number | null
  durationS: number | null
  source: StudioAssetSource
}

export type StudioJobState =
  | { status: 'STARTED'; jobId: string; kind: StudioJobKind }
  /** El Worker copia los audios a R2, uno por consulta: hay que seguir consultando. */
  | { status: 'IMPORTING'; jobId: string; kind: StudioJobKind; done: number; total: number }
  | { status: 'SUCCEEDED'; jobId: string; kind: 'master' | 'separate' | 'generate'; assets: StudioJobAsset[]; costUsd: number | null }
  | { status: 'SUCCEEDED'; jobId: string; kind: 'assist'; suggestions: MixSuggestion[]; costUsd: number | null }
  /**
   * `resumable`: el trabajo NO fallo en la nube; el Hub dejo de esperarlo (tiempo limite). Se
   * puede volver a consultar con el mismo `jobId` sin lanzar (ni pagar) otro.
   */
  | { status: 'FAILED'; jobId: string; kind: StudioJobKind; error: string; resumable?: boolean }

/** Respuesta de POST .../jobs?estimate=1. */
export interface StudioJobEstimate {
  kind: StudioJobKind
  estimatedCostUsd: number
  /** Gasto del mes en curso de la banda. */
  spentUsd: number
  /** Tope mensual; null si no hay. */
  budgetUsd: number | null
  /** false si lanzar el trabajo daria 429 quota_exceeded. */
  allowed: boolean
}

// ===========================================================================
// studioCloud.ts (sin DOM): cliente de las rutas /studio del Worker
// ===========================================================================
//
// Mismo patron que stemCloud.ts: `CloudTarget` con `fetchFn` inyectable, y `authHeaders`, `send`
// y `failFrom` de stemCloud.ts tal cual. Los errores son `StemCloudError` (code, status) con
// mensaje en espanol propio del Estudio (studioCloudErrorMessage). OJO: el codigo `no_session`
// con estado 404 es "la sesion del Estudio no existe"; con estado 401 es "no hay sesion de
// nube" (STUDIO_V1.md seccion 7).

export interface CloudSessionSummary {
  id: string
  title: string
  songId: string | null
  updatedAt: string
}

export interface CloudSession {
  session: StudioSession
  /** ETag tal como llego (con comillas). Se devuelve en el siguiente putSession. */
  etag: string
}

export interface PutSessionOptions {
  /** ETag de la version sobre la que se edito; null = crear (If-None-Match: *). */
  ifMatch: string | null
}

export interface WatchJobOptions {
  /** Cada estado intermedio y el final. */
  onState?: (state: StudioJobState) => void
  /** Al abortar se deja de consultar y la promesa resuelve null. */
  signal?: AbortSignal
  /** Por defecto 3000 ms. */
  intervalMs?: number
  /** Por defecto 15 minutos; al pasarse resuelve un estado FAILED con mensaje de espera. */
  timeoutMs?: number
  /** Inyectables para las pruebas. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export interface StudioCloudApi {
  /** URL base de las rutas del Estudio: `${baseUrl}/v1/bands/${band}/studio`. */
  studioUrl(target: CloudTarget): string
  /** Mensaje en espanol para un codigo de error del Worker en las rutas del Estudio. */
  studioCloudErrorMessage(code: string, status?: number): string
  listSessions(target: CloudTarget): Promise<CloudSessionSummary[]>
  /** null si la sesion no existe en la nube (404 no_session). Valida con parseSession. */
  getSession(target: CloudTarget, sessionId: string): Promise<CloudSession | null>
  /**
   * Sube el documento (sessionToJson). 412 lanza StemCloudError 'session_conflict': quien llama
   * ofrece recargar o guardar como copia. 409 'missing_asset': falta subir un audio.
   */
  putSession(target: CloudTarget, session: StudioSession, options: PutSessionOptions): Promise<CloudSession>
  /** Devuelve cuantos objetos borro el Worker. */
  deleteSession(target: CloudTarget, sessionId: string): Promise<number>
  /** Sube un audio. Repetir con el mismo tamano es seguro; con otro, 409 'asset_exists'. */
  putAsset(target: CloudTarget, sessionId: string, file: string, data: Blob): Promise<{ file: string; size: number }>
  /** Descarga un audio completo. 404 lanza StemCloudError 'no_asset'. */
  getAsset(target: CloudTarget, sessionId: string, file: string, signal?: AbortSignal): Promise<Blob>
  /**
   * Lanza el trabajo (202). Devuelve su estado inicial, STARTED. Gasta creditos. Con `jobId`
   * (elegido por el Hub, `job_...`) el POST es idempotente: repetirlo no lanza otro trabajo.
   */
  startJob(target: CloudTarget, sessionId: string, request: StudioJobRequest, jobId?: string): Promise<StudioJobState>
  /** Costo estimado sin lanzar nada (POST .../jobs?estimate=1). */
  estimateJob(target: CloudTarget, sessionId: string, request: StudioJobRequest): Promise<StudioJobEstimate>
  /** Estado del trabajo. 404 lanza StemCloudError 'no_job'. En IMPORTING cada llamada copia un audio. */
  getJob(target: CloudTarget, sessionId: string, jobId: string): Promise<StudioJobState>
  /**
   * Consulta hasta SUCCEEDED o FAILED. 502 asset_copy_failed y los errores de red se reintentan
   * (hasta 8 seguidos); el resto se lanza. Abortar resuelve null. Mismo comportamiento que
   * watchSeparation de stemAnalysis.ts.
   */
  watchJob(target: CloudTarget, sessionId: string, jobId: string, options?: WatchJobOptions): Promise<StudioJobState | null>
}

// ===========================================================================
// flag.ts: interruptor del Estudio (ya implementado)
// ===========================================================================

export interface StudioFlagApi {
  /** Encendido por defecto; se apaga con VITE_BANDAIT_STUDIO === '0' o localStorage['bandait_studio'] === '0'. */
  studioEnabled(): boolean
}

// ###########################################################################
// ESTUDIO v2 (docs/PLAN_ESTUDIO_V2.md, bandait-protocol/STUDIO_V2.md)
// ###########################################################################

// ===========================================================================
// v2 · sessionOps.ts (puro): operaciones sobre pistas de instrumento, clips MIDI y marcas
// ===========================================================================
//
// Mismas reglas que SessionOpsApi: (session, args) => sesion NUEVA, sin mutar la entrada; la
// MISMA referencia si nada cambia; id inexistente o resultado invalido lanza StudioSessionError;
// numeros fuera de rango se acotan; ids nuevos por parametro. Se exportan desde sessionOps.ts
// junto a las de v1 y se comprueban aparte:
//   void ({ addInstrumentTrack, setInstrument, ... } satisfies SessionOpsV2Api)
// Todas las notas que entran pasan por midiOps.normalizeNotes (orden, solapes, recorte).
// Un clip MIDI solo va en una pista 'instrument' y un clip de audio solo en una 'audio': lo
// contrario lanza `bad_value` con ruta `track_id`.

export interface AddInstrumentTrackArgs {
  /** Pista completa con kind 'instrument' (defaultInstrumentTrack de session.ts). */
  track: StudioTrack
  /** Posicion en la lista; por defecto, al final. */
  index?: number
}

export interface SetInstrumentArgs {
  trackId: string
  /**
   * Instrumento completo que reemplaza al anterior. Cambiar de tipo esta permitido; las notas se
   * conservan. Con un sampler, cada zona debe usar un audio de la sesion (`unknown_asset`).
   */
  instrument: StudioInstrument
}

export interface AddMidiClipArgs {
  trackId: string
  /** Clip completo (defaultMidiClip de session.ts). Id unico entre clips de audio y MIDI. */
  clip: StudioMidiClip
}

export type MidiClipPatch = Partial<Pick<StudioMidiClip, 'notes' | 'loop' | 'loopBeats'>>

export interface UpdateMidiClipArgs {
  clipId: string
  /** Lo que no viene no cambia. `notes` se normaliza con el largo del clip. */
  patch: MidiClipPatch
}

export interface RemoveMidiClipArgs {
  clipId: string
}

export interface MoveMidiClipArgs {
  clipId: string
  /** Nueva posicion en beats; se acota a [0, fin de la sesion - lengthBeats]. */
  startBeat: number
  /** Si viene y es otra pista de instrumento, el clip cambia de pista (queda al final). */
  trackId?: string
}

export interface ResizeMidiClipArgs {
  clipId: string
  edge: 'start' | 'end'
  /**
   * Beat de la sesion donde debe quedar ese borde (acotado a largo minimo y fin de la sesion).
   * Con 'end' cambia solo lengthBeats; las notas que quedan fuera (start >= nuevo largo) se
   * quitan. Con 'start' las notas conservan su posicion ABSOLUTA en la sesion: se corren dentro
   * del clip y las que quedan antes del nuevo inicio se quitan.
   */
  toBeat: number
}

export interface DuplicateMidiClipArgs {
  clipId: string
  newClipId: string
  /** Por defecto, justo donde termina el original. */
  startBeat?: number
}

export interface SplitMidiClipArgs {
  clipId: string
  /** Beat de la sesion; debe dejar >= STUDIO_MIDI_MIN_CLIP_BEATS a cada lado (si no, no cambia nada). */
  atBeat: number
  /** Id de la mitad derecha; la izquierda conserva el id. Las notas que cruzan el corte se dividen. */
  newClipId: string
}

export interface SetFrozenAssetArgs {
  trackId: string
  /** Audio de la sesion con el render del instrumento, o null para quitar el congelado. */
  assetId: string | null
}

export interface SetMarkersArgs {
  /** Lista completa que reemplaza a la anterior (se ordena por beat e id). */
  markers: StudioMarker[]
}

export interface SetChordsArgs {
  /** Lista completa que reemplaza a la anterior (se ordena por beat y nombre); [] quita los acordes. */
  chords: StudioChord[]
}

export interface SessionOpsV2Api {
  /** Lanza `too_many` si ya hay 16 pistas, `duplicate_id` si el id existe, `bad_value` si kind no es 'instrument'. */
  addInstrumentTrack(session: StudioSession, args: AddInstrumentTrackArgs): StudioSession
  setInstrument(session: StudioSession, args: SetInstrumentArgs): StudioSession
  /** Lanza `too_many` (256 clips por pista, notas por clip o por sesion) y `duplicate_id`. */
  addMidiClip(session: StudioSession, args: AddMidiClipArgs): StudioSession
  updateMidiClip(session: StudioSession, args: UpdateMidiClipArgs): StudioSession
  removeMidiClip(session: StudioSession, args: RemoveMidiClipArgs): StudioSession
  moveMidiClip(session: StudioSession, args: MoveMidiClipArgs): StudioSession
  resizeMidiClip(session: StudioSession, args: ResizeMidiClipArgs): StudioSession
  duplicateMidiClip(session: StudioSession, args: DuplicateMidiClipArgs): StudioSession
  splitMidiClip(session: StudioSession, args: SplitMidiClipArgs): StudioSession
  /** Lanza `unknown_asset` si el audio no esta en la sesion y `bad_value` si la pista es de audio. */
  setFrozenAsset(session: StudioSession, args: SetFrozenAssetArgs): StudioSession
  /** Lanza `duplicate_id`, `too_many` o `session_too_long` como parseSession. */
  setMarkers(session: StudioSession, args: SetMarkersArgs): StudioSession
  /** Acordes de referencia (STUDIO_V2.md 2.9). Lanza `too_many`, `out_of_range` o `session_too_long`. */
  setChords(session: StudioSession, args: SetChordsArgs): StudioSession
}

// ===========================================================================
// v2 · midiOps.ts (puro): operaciones sobre las notas de UN clip
// ===========================================================================
//
// Trabajan sobre el arreglo de notas de un clip, en beats relativos al clip, y devuelven uno
// NUEVO (nunca mutan). El resultado siempre sale normalizado: ordenado por start y pitch
// (session.compareNotes), sin solapes del mismo pitch (la anterior se acorta hasta el inicio de
// la siguiente; si queda con menos de STUDIO_MIDI_MIN_NOTE_BEATS, se quita), con start en
// [0, clipLengthBeats), pitch 0..127, velocity 1..127, tiempos redondeados con roundBeat.
// La seleccion son indices en el arreglo ORDENADO; cada operacion devuelve la seleccion nueva
// (las mismas notas despues de editar, o las nuevas al agregar o duplicar).

/** Rejilla: '1/4' = un beat (negra), '1/16' = un cuarto de beat. */
export type QuantizeGrid = '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32'

/** Indices en el arreglo de notas ordenado. null en una firma = todas las notas. */
export type NoteSelection = readonly number[]

export interface MidiEditResult {
  notes: StudioMidiNote[]
  /** Indices (en `notes`) de las notas editadas o creadas. */
  selection: number[]
}

export interface QuantizeOptions {
  grid: QuantizeGrid
  /** Tresillos: la rejilla vale 2/3. */
  triplets: boolean
  /** 0..1: cuanto se acerca cada inicio a la rejilla (1 = del todo). */
  strength: number
  /** true = tambien ajusta el final de cada nota a la rejilla. Por defecto false. */
  ends?: boolean
}

export type HumanizePresetId = 'pocket' | 'keys' | 'strum' | 'analog'

/**
 * Opciones de midiOps.humanize. Un valor explicito es absoluto; lo que falta sale del preset (o de
 * los valores por defecto) escalado por `amount`. Ver midiOps.resolveHumanize.
 */
export interface HumanizeOptions {
  /** Preset musical opcional que fija valores base antes de aplicar overrides explicitos. */
  preset?: HumanizePresetId
  /**
   * 0..1: intensidad general. Escala micro-timing, velocidad, duracion, swing, strum y acento que
   * vienen del preset (amount / amount_del_preset). Por defecto la del preset (o 0.5).
   */
  amount?: number
  /** Desviacion maxima del inicio de cada nota en ms (0..60). Gana sobre timingBeats. */
  timingMs?: number
  /** Compatibilidad (asistente): desviacion maxima en beats (0..0.25), absoluta. */
  timingBeats?: number
  /** Variacion maxima de velocidad MIDI (0..64). Por defecto round(amount * 24). */
  velocityRange?: number
  /** Variacion proporcional maxima de duracion (0..0.5). Por defecto amount * 0.08. */
  lengthRatio?: number
  /**
   * Swing: fraccion del paso de la subdivision que se atrasa la nota impar (0..0.5; 0 = recto,
   * 0.33 = tresillo 66 %, 0.5 = puntillo 75 %). Idempotente: aplicarlo dos veces no lo suma.
   */
  swing?: number
  /** Subdivision de swing ('1/8' o '1/16'). Por defecto la del preset o '1/16'. */
  swingGrid?: '1/8' | '1/16'
  /** Rasgueo direccional en acordes simultaneos, en ms (-60..60; >0 grave a agudo). Gana sobre strumBeats. */
  strumMs?: number
  /** Compatibilidad (asistente): rasgueo en beats (-0.12..0.12), absoluto. */
  strumBeats?: number
  /** Acento metrico en tiempo fuerte y medio compas (0..1). */
  accentStrength?: number
  /** Compas de referencia para acentos metricos (por defecto 4). */
  beatsPerBar?: number
  /**
   * Posicion del clip en la sesion, en beats. La fase del acento y del swing es
   * clipStartBeat + nota.start (por defecto 0 = el clip empieza en un compas).
   */
  clipStartBeat?: number
  /** Tempo de la sesion para convertir ms a beats (por defecto 120). */
  bpm?: number
  /** Pista de bateria (instrumento `drums`): humanizacion por pieza General MIDI, sin rasgueo. */
  drumKit?: boolean
  /** Solo con drumKit: la caja (38, 39, 40) toca atras del tiempo estos ms (0..30). */
  laidBackMs?: number
  /** Semilla entera opcional para reproducibilidad determinista. */
  seed?: number
}

export interface NoteRange {
  /** Rango en beats del clip: una nota entra si se cruza con [startBeat, endBeat). */
  startBeat: number
  endBeat: number
  /** Rango de pitch, ambos incluidos. */
  lowPitch: number
  highPitch: number
}

export type VelocityMode = 'set' | 'add' | 'scale'

export interface MidiOpsApi {
  /** Largo de la rejilla en beats ('1/8' -> 0.5; con tresillos, 1/3). */
  gridBeats(grid: QuantizeGrid, triplets: boolean): number
  /** Ordena, resuelve solapes del mismo pitch, acota y recorta al largo del clip. */
  normalizeNotes(notes: readonly StudioMidiNote[], clipLengthBeats: number): StudioMidiNote[]
  /** Agrega notas (la seleccion son las agregadas que sobreviven a la normalizacion). */
  addNotes(notes: readonly StudioMidiNote[], added: readonly StudioMidiNote[], clipLengthBeats: number): MidiEditResult
  removeNotes(notes: readonly StudioMidiNote[], selection: NoteSelection): StudioMidiNote[]
  /** Mueve en el tiempo (beats) y en pitch (semitonos); se acota al clip y a 0..127. */
  moveNotes(notes: readonly StudioMidiNote[], selection: NoteSelection, deltaBeats: number, deltaPitch: number, clipLengthBeats: number): MidiEditResult
  /** Cambia el inicio ('start', el final queda fijo) o el final ('end'); largo minimo respetado. */
  resizeNotes(notes: readonly StudioMidiNote[], selection: NoteSelection, edge: 'start' | 'end', deltaBeats: number, clipLengthBeats: number): MidiEditResult
  /** Transpone; las notas que saldrian de 0..127 se acotan. Flechas = 1, Shift = 12. */
  transpose(notes: readonly StudioMidiNote[], selection: NoteSelection | null, semitones: number, clipLengthBeats: number): MidiEditResult
  /** 'set' fija, 'add' suma, 'scale' multiplica; el resultado se redondea y acota a 1..127. */
  setVelocity(notes: readonly StudioMidiNote[], selection: NoteSelection | null, value: number, mode: VelocityMode): MidiEditResult
  /** inicio' = inicio + (rejilla_mas_cercana - inicio) * strength; el largo se conserva salvo `ends`. */
  quantize(notes: readonly StudioMidiNote[], selection: NoteSelection | null, options: QuantizeOptions, clipLengthBeats: number): MidiEditResult
  /** Aplica variacion organica/analogica en micro-timing, velocidad y duracion. */
  humanize(notes: readonly StudioMidiNote[], selection: NoteSelection | null, options: HumanizeOptions, clipLengthBeats: number): MidiEditResult
  /** Cada nota se alarga hasta el inicio de la siguiente nota (de cualquier pitch) de la seleccion; la ultima no cambia. */
  legato(notes: readonly StudioMidiNote[], selection: NoteSelection | null, clipLengthBeats: number): MidiEditResult
  /** Copia la seleccion corrida `offsetBeats` (lo que cae fuera del clip se descarta). */
  duplicateNotes(notes: readonly StudioMidiNote[], selection: NoteSelection, offsetBeats: number, clipLengthBeats: number): MidiEditResult
  /** Corta en dos las notas que cruzan `atBeat` (beat del clip). Herramienta "cortar nota". */
  splitNotesAt(notes: readonly StudioMidiNote[], selection: NoteSelection | null, atBeat: number, clipLengthBeats: number): MidiEditResult
  /** Indices de las notas dentro del rango (seleccion por rectangulo). */
  notesInRange(notes: readonly StudioMidiNote[], range: NoteRange): number[]
}

// ===========================================================================
// v2 · smf.ts (puro, sin dependencias): archivos MIDI estandar tipo 0 y 1
// ===========================================================================

export interface SmfTrack {
  /** Meta evento de nombre de pista (0x03), o null. */
  name: string | null
  /** Canal 0..15 de la primera nota; null si la pista no tiene notas. */
  channel: number | null
  /** true si sus notas van por el canal 10 (indice 9): percusion General MIDI. */
  isDrums: boolean
  /**
   * Notas en beats desde el INICIO DEL ARCHIVO (ticks / division), ordenadas y normalizadas
   * (solapes del mismo pitch resueltos como en midiOps). Una nota sin note-off se cierra al
   * final de la pista. Note-on con velocidad 0 es note-off.
   */
  notes: StudioMidiNote[]
}

export interface SmfFile {
  format: 0 | 1
  /** Division (ticks por negra). La division SMPTE no se admite (lanza). */
  ticksPerBeat: number
  /** Primer meta de tempo (0x51) convertido a BPM, o null si no hay (el usuario decide; 120 por norma). */
  bpm: number | null
  /**
   * Negras por compas del primer meta de compas (0x58): numerador * 4 / 2^denominador (6/8 da 3).
   * null si no hay meta o si no da un entero de negras (7/8): ver timeSignature.
   */
  beatsPerBar: number | null
  /** Primer compas tal como viene en el archivo ("6/8"), o null si no trae. */
  timeSignature: string | null
  /** Solo las pistas con notas, en el orden del archivo. */
  tracks: SmfTrack[]
  /** true si el archivo trae mas de un tempo (el Estudio usa el primero: sin mapa de tempo). */
  tempoChanges: boolean
}

export interface SmfWriteClip {
  /** Nombre de la pista en el archivo. */
  name: string
  /** Notas en beats desde el inicio de la sesion (clip.startBeat + nota.start). */
  notes: readonly StudioMidiNote[]
  /** Canal 0..15; por defecto 0, y 9 para una caja de ritmos. */
  channel?: number
}

export interface SmfApi {
  /**
   * Lee un archivo MIDI estandar tipo 0 o 1. Lanza un Error con mensaje en espanol si no es un
   * SMF (cabecera MThd), es tipo 2, usa division SMPTE o esta truncado.
   */
  parseSmf(bytes: Uint8Array | ArrayBuffer): SmfFile
  /**
   * Escribe un SMF tipo 1 con 480 ticks por negra: pista 0 de tempo y compas, y una pista por
   * clip (un solo clip tambien va como tipo 1). Determinista: mismos datos, mismos bytes.
   */
  writeSmf(clips: readonly SmfWriteClip[], bpm: number, beatsPerBar: number): Uint8Array
}

// ===========================================================================
// v2 · commands.ts: registro unico de comandos, atajos y paleta
// ===========================================================================
//
// La interfaz, el teclado, la paleta (Ctrl+K) y el chat llaman al MISMO registro. Los atajos se
// escriben como texto canonico: modificadores en el orden Ctrl, Alt, Shift y una tecla, unidos
// con '+': "Ctrl+Shift+Z", "Space", "Delete", "ArrowUp", "Plus", "Minus", "?", "1". Teclas:
// letras A..Z y digitos 0..9 por `event.code` (no dependen de la distribucion del teclado),
// simbolos ("?", "Plus", "Minus") por `event.key`, y nombres: Space, Enter, Escape, Tab,
// Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.
// "Ctrl" es Ctrl en Windows y Linux, y Cmd (metaKey) en macOS. Con un simbolo, Shift no cuenta
// ("?" ya implica Shift en muchas distribuciones). Mapa por defecto: plan, seccion 6.

export type CommandContext = 'global' | 'timeline' | 'piano_roll' | 'mixer'

export type CommandCategory = 'transporte' | 'edicion' | 'pistas' | 'herramientas' | 'vista' | 'archivo' | 'midi' | 'mezcla' | 'marcas'

/** Nombres de la lista cerrada de herramientas del asistente (fixtures/studio_chat_tools_v2.json). */
export type AssistantToolName =
  | 'set_session_meta'
  | 'add_audio_track'
  | 'add_instrument_track'
  | 'remove_track'
  | 'set_track_mix'
  | 'set_track_fx'
  | 'set_master'
  | 'set_instrument'
  | 'add_midi_clip'
  | 'replace_midi_notes'
  | 'transpose_midi_clip'
  | 'quantize_midi_clip'
  | 'humanize_midi_clip'
  | 'move_clip'
  | 'duplicate_clip'
  | 'split_clip'
  | 'delete_clip'
  | 'set_clip_gain'
  | 'add_marker'
  | 'remove_marker'
  | 'auto_master_session'
  | 'unmask_mix_tracks'
  | 'generate_click_guide'

export interface StudioCommand<Ctx> {
  /** Id estable con punto: "transport.play_pause", "midi.quantize". Es el que guarda el keymap. */
  id: string
  /** Nombre en espanol para la paleta y la hoja de atajos. */
  label: string
  category: CommandCategory
  /** Atajos por defecto, canonicos (el primero es el que se muestra). [] = sin atajo. */
  defaultShortcuts: readonly string[]
  /** Donde vale el atajo. 'global' vale en todos los contextos. */
  context: CommandContext
  /** true si el asistente puede pedirlo (entonces `assistantTool` no es null). */
  assistantAllowed: boolean
  /** Herramienta del asistente que lo invoca, con command_id = id (STUDIO_V2.md 4.3.3). */
  assistantTool: AssistantToolName | null
  /** false = deshabilitado (la paleta lo muestra gris y el atajo no hace nada). Por defecto true. */
  isEnabled?(ctx: Ctx): boolean
  /**
   * Ejecuta. `args` llega del asistente (argumentos de la herramienta, snake_case, ya validados
   * con su esquema) o de la interfaz; el teclado lo llama sin args. Un cambio de la sesion es UN
   * paso de deshacer. Lanza un Error con mensaje en espanol si no se puede aplicar (el chat lo
   * devuelve como `failed`).
   */
  run(ctx: Ctx, args?: Readonly<Record<string, unknown>>): void | Promise<void>
}

export interface CommandRegistry<Ctx> {
  /** Lanza si el id ya existe. */
  register(command: StudioCommand<Ctx>): void
  get(id: string): StudioCommand<Ctx> | null
  /** En orden de registro. */
  list(): readonly StudioCommand<Ctx>[]
  /** Los que valen en `context` (los suyos mas los globales). */
  forContext(context: CommandContext): readonly StudioCommand<Ctx>[]
  /** El comando de una herramienta del asistente, o null si no hay (el chat responde `failed`). */
  forAssistantTool(name: string): StudioCommand<Ctx> | null
  /** Ejecuta por id. Lanza si no existe o si esta deshabilitado. */
  run(id: string, ctx: Ctx, args?: Readonly<Record<string, unknown>>): Promise<void>
}

export interface ParsedShortcut {
  /** Ctrl (o Cmd en macOS). */
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Token canonico de la tecla ("Z", "Space", "ArrowUp", "?"). */
  key: string
}

/** Lo que se usa de un KeyboardEvent (las pruebas pasan objetos simples). */
export interface KeyEventLike {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

/** id de comando -> atajos canonicos. Un comando ausente usa sus defaultShortcuts. */
export type Keymap = Readonly<Record<string, readonly string[]>>

export interface ShortcutConflict {
  shortcut: string
  /** Comandos que comparten el atajo en contextos que se pisan (iguales, o uno es 'global'). */
  commandIds: string[]
}

export interface CommandsApi {
  createCommandRegistry<Ctx>(): CommandRegistry<Ctx>
  /** Lee un atajo escrito ("ctrl+shift+z", "Ctrl + K"); null si no es valido. */
  parseShortcut(text: string): ParsedShortcut | null
  /** Texto canonico ("Ctrl+Shift+Z"). */
  formatShortcut(shortcut: ParsedShortcut): string
  /** Texto para mostrar segun la plataforma: en macOS "Cmd+Shift+Z". */
  displayShortcut(shortcut: string, platform: 'mac' | 'other'): string
  /** Atajo canonico de una pulsacion, o null si es solo un modificador o una tecla no admitida. */
  shortcutFromEvent(event: KeyEventLike, platform: 'mac' | 'other'): string | null
  /** Mapa con los atajos por defecto de todos los comandos. */
  defaultKeymap(commands: readonly StudioCommand<unknown>[]): Keymap
  findConflicts(commands: readonly StudioCommand<unknown>[], keymap: Keymap): ShortcutConflict[]
  /**
   * Por defecto + lo guardado en `storage` (clave KEYMAP_STORAGE_KEY = "bandait_studio_keymap",
   * JSON con solo los comandos cambiados). Algo ilegible o un id desconocido se ignora.
   */
  loadKeymap(storage: KeyValueStorage, commands: readonly StudioCommand<unknown>[]): Keymap
  /** Guarda solo las diferencias con el mapa por defecto. Rechaza (lanza) si hay choques. */
  saveKeymap(storage: KeyValueStorage, commands: readonly StudioCommand<unknown>[], keymap: Keymap): void
  /** Borra lo guardado: vuelve al mapa por defecto. */
  resetKeymap(storage: KeyValueStorage): void
  /**
   * Id del comando que dispara la pulsacion en `context`, o null. Con `inTextField` true
   * (input, textarea, select o contenteditable con foco) devuelve null SIEMPRE: los atajos nunca
   * se disparan mientras se escribe. Un comando del contexto activo gana sobre uno global.
   */
  matchEvent(
    event: KeyEventLike,
    context: CommandContext,
    inTextField: boolean,
    commands: readonly StudioCommand<unknown>[],
    keymap: Keymap,
    platform: 'mac' | 'other',
  ): string | null
}

// ===========================================================================
// v2 · instruments.ts: instrumentos en el grafo (los mismos en tiempo real y en offline)
// ===========================================================================
//
// synth y drums con nodos nativos (OscillatorNode, BiquadFilterNode, GainNode, AudioBuffer de
// ruido con semilla fija) o un AudioWorklet propio; sampler con AudioBufferSourceNode. Todo se
// programa en el reloj del contexto (ningun setTimeout en el camino del audio) y es determinista
// (STUDIO_V2.md 2.3): lo que suena es lo que exporta bounce con OfflineAudioContext.

export interface InstrumentAvailability {
  available: boolean
  /** Por que no esta disponible, en espanol ("El plugin no esta en la lista de este Hub"); null si lo esta. */
  reason: string | null
}

/** Un instrumento vivo en un contexto de audio, con su polifonia. */
export interface StudioInstrumentNode {
  readonly type: StudioInstrumentType
  /** Salida del instrumento (despues de su gain_db); se conecta a la entrada de la pista. */
  readonly output: AudioNode
  /** Voces simultaneas antes de robar (STUDIO_INSTRUMENT_POLYPHONY = 32). */
  readonly polyphony: number
  /** Empieza una nota en el tiempo `when` del contexto (tocar en vivo y grabar). */
  noteOn(pitch: number, velocity: number, when: number): void
  /** Termina la nota mas antigua de ese pitch en `when` (empieza la relajacion). */
  noteOff(pitch: number, when: number): void
  /** Nota con inicio y fin ya conocidos (clips): lo que usan scheduleMidiClips y bounce. */
  playNote(pitch: number, velocity: number, startTime: number, endTime: number): void
  /** Corta todo con una rampa corta en `when` (por defecto, ya). Detener o saltar. */
  allNotesOff(when?: number): void
  /**
   * Aplica en caliente parametros nuevos del MISMO tipo (y, en sampler, zonas). Devuelve false si
   * cambio el tipo o el plugin: quien llama reconstruye el instrumento.
   */
  update(instrument: StudioInstrument): boolean
  /** Voces sonando ahora (para pruebas y medidores). */
  activeVoices(): number
  /** Desconecta y libera. Idempotente. */
  dispose(): void
}

/** Estado de una voz para decidir cual robar. Tiempos del contexto. */
export interface VoiceInfo {
  startedAt: number
  /** Cuando recibio su note-off; null si sigue sostenida. */
  releasedAt: number | null
  velocity: number
}

/** Lo que prepareInstruments deja listo para buildGraph (que es sincrono). */
export interface InstrumentPreparation {
  /** true si cargaron los worklets propios (si no, se usan nodos nativos de respaldo). */
  workletReady: boolean
  /** Instrumentos WAM ya creados en este contexto, por id de pista. */
  wamNodes: ReadonlyMap<string, StudioInstrumentNode>
  /** Pistas cuyo instrumento no esta disponible, con el motivo (suena su congelado si lo hay). */
  unavailable: ReadonlyMap<string, string>
}

export interface ScheduleMidiOptions extends ScheduleClipsOptions {
  /** Tiempo del contexto en que se pidio programar; no se programa nada antes de este instante. */
  nowCtxTime?: number
}

export interface InstrumentsApi {
  /**
   * Carga worklets y crea los plugins WAM que la sesion usa (asincrono). Se llama antes de cada
   * buildGraph, en el AudioContext y en cada OfflineAudioContext. Idempotente por contexto.
   */
  prepareInstruments(ctx: BaseAudioContext, session: StudioSession): Promise<InstrumentPreparation>
  /** synth, drums y sampler siempre; wam solo si el plugin esta en la lista cerrada. */
  instrumentAvailability(instrument: StudioInstrument): InstrumentAvailability
  /** Crea el instrumento (sincrono); null si no esta disponible. Para wam usa preparation.wamNodes. */
  createInstrument(
    ctx: BaseAudioContext,
    trackId: string,
    instrument: StudioInstrument,
    buffers: StudioBuffers,
    preparation: InstrumentPreparation,
  ): StudioInstrumentNode | null
  /**
   * Indice de la voz a robar (STUDIO_V2.md 2.3): la relajada mas antigua; si no hay, la mas
   * antigua; a igual antiguedad, la de menor velocidad. -1 con la lista vacia. Puro.
   */
  pickVoiceToSteal(voices: readonly VoiceInfo[]): number
  /** 440 * 2^((pitch - 69) / 12). Puro. */
  noteFrequency(pitch: number): number
  /**
   * Programa las notas de los clips MIDI de la sesion (con repeticion y recorte, STUDIO_V2.md
   * 2.4) contra `graph.instruments`, y los congelados de las pistas no disponibles contra
   * `graph.trackInputs`. Mismas opciones y misma alineacion que scheduleClips; beats a segundos
   * con session.bpm. La usan el motor y bounce.
   */
  scheduleMidiClips(ctx: BaseAudioContext, graph: StudioGraph, session: StudioSession, buffers: StudioBuffers, options: ScheduleMidiOptions): ScheduledClips
}

/** Voz de la caja de ritmos y su nota canonica, para el piano roll en modo percusion. */
export interface DrumLane {
  voice: DrumVoice
  pitch: number
  label: string
}

// ===========================================================================
// v2 · wamHost.ts: anfitrion de plugins WAM 2.0 (lista cerrada)
// ===========================================================================
//
// Solo plugins EMPAQUETADOS con el Hub (import estatico de un modulo del propio bundle). Nunca
// codigo desde una URL: el documento no trae URL (STUDIO_V2.md 2.3.4). La lista
// STUDIO_WAM_PLUGINS vive en wamHost.ts y en esta etapa esta VACIA.

export interface WamPluginDescriptor {
  /** Patron STUDIO_WAM_PLUGIN_ID_RE; es el plugin_id del documento. */
  id: string
  name: string
  vendor: string
  /** Version exacta empaquetada. */
  version: string
  /** Licencia verificada (MIT, Apache-2.0, BSD-2-Clause o BSD-3-Clause). */
  license: string
  /** Import del modulo del plugin, empaquetado con el Hub. */
  loadModule(): Promise<unknown>
}

export interface WamHostApi {
  /** La lista cerrada. Hoy vacia. */
  listPlugins(): readonly WamPluginDescriptor[]
  pluginAvailability(pluginId: string): InstrumentAvailability
  /** Crea el plugin con su estado. Rechaza con un Error en espanol si no esta en la lista o no carga. */
  createWamInstrument(ctx: BaseAudioContext, pluginId: string, state: Readonly<Record<string, unknown>>): Promise<StudioInstrumentNode>
  /** Estado actual del plugin, para guardarlo en el documento (hasta 16384 bytes serializado). */
  getWamState(node: StudioInstrumentNode): Promise<Record<string, unknown>>
}

// ===========================================================================
// v2 · midiInput.ts: Web MIDI, teclado de computadora y grabacion a clip
// ===========================================================================
//
// Web MIDI existe en Chrome y Edge de escritorio (navigator.requestMIDIAccess). Los mensajes
// traen `timeStamp` en el reloj de performance.now(); se pasan al reloj del AudioContext con
// AudioContext.getOutputTimestamp() (contextTime, performanceTime) para alinear la toma igual que
// el audio (STUDIO_V1.md 2.7, sin latencia de entrada de audio). Teclado de computadora: por
// `event.code`, fila A..K = Do..Do (W, E, T, Y, U = sostenidos), Z y X bajan y suben la octava;
// velocidad fija 100; no se dispara con el foco en un campo de texto.

export type MidiAccessStatus = 'unsupported' | 'prompt' | 'granted' | 'denied'

export interface MidiInputDevice {
  id: string
  name: string
  manufacturer: string
  connected: boolean
}

export interface MidiNoteEvent {
  type: 'on' | 'off'
  pitch: number
  /** 1..127 en 'on'; en 'off', la velocidad de liberacion (0 si no viene). */
  velocity: number
  /** Canal 0..15 (el teclado de computadora usa 0). */
  channel: number
  /** Tiempo del AudioContext del evento. */
  ctxTime: number
  source: 'midi' | 'keyboard'
}

export interface MidiRecordOptions {
  /** Pista de instrumento armada. */
  trackId: string
  /** Lo que devolvio engine.play() (despues del conteo): el beat 0 de la toma. */
  playStart: PlayStart
  bpm: number
  /** Canal a grabar, o 'all'. */
  channel: number | 'all'
  /** Cuantizar al terminar; null = no. */
  quantize: QuantizeOptions | null
}

/** Resultado de una toma MIDI: lo que necesita sessionOps.addMidiClip (falta el id). */
export interface MidiTake {
  trackId: string
  /** Beat de la sesion donde empieza el clip (inicio del compas de la primera nota). */
  startBeat: number
  /** Hasta el final del compas de la ultima nota. */
  lengthBeats: number
  /** Relativas al clip, normalizadas (midiOps.normalizeNotes). */
  notes: StudioMidiNote[]
  /** Notas que seguian apretadas al parar: se cerraron en el instante de parada. */
  hangingNotes: number
}

export interface MidiRecordingApi {
  /** Puro: pasa un timeStamp de performance.now() al reloj del contexto. */
  performanceToCtxTime(timeStampMs: number, stamp: { contextTime: number; performanceTime: number }): number
  /**
   * Puro: eventos capturados -> toma. Eventos antes de `playStart.playStartCtxTime` se descartan;
   * beat = (ctxTime - playStartCtxTime) * bpm / 60 + secondsToBeats(positionAtStart). Null si no
   * hubo ninguna nota.
   */
  eventsToTake(events: readonly MidiNoteEvent[], options: MidiRecordOptions & { stopCtxTime: number; beatsPerBar: number }): MidiTake | null
  /** Puro: pitch de una tecla de la computadora (event.code) con la octava base (4 = Do central 60), o null. */
  computerKeyPitch(code: string, baseOctave: number): number | null
}

export interface MidiInputApi {
  isSupported(): boolean
  /** Pide el permiso de Web MIDI (sin sysex). */
  requestAccess(): Promise<MidiAccessStatus>
  listInputs(): MidiInputDevice[]
  /** Conexion y desconexion de dispositivos. Devuelve la funcion para dejar de escuchar. */
  onDevicesChange(listener: (devices: MidiInputDevice[]) => void): () => void
  /** Escucha un dispositivo y canal (y suelta el anterior). */
  open(deviceId: string, channel: number | 'all'): void
  /** Activa o desactiva el teclado de computadora como teclado musical (escucha en `target`). */
  setComputerKeyboard(enabled: boolean, target?: EventTarget): void
  /** Notas entrantes (para tocar el instrumento en vivo). Devuelve la funcion para dejar de escuchar. */
  onNote(listener: (event: MidiNoteEvent) => void): () => void
  startRecording(options: MidiRecordOptions): void
  /** Termina la toma en `stopCtxTime`; null si no hubo notas. No toca la sesion. */
  stopRecording(stopCtxTime: number): MidiTake | null
  isRecording(): boolean
  /** Suelta el dispositivo, el teclado y los oyentes. Idempotente. */
  close(): void
}

// ===========================================================================
// v2 · audioToMidi.ts: audio a notas en el navegador (sin costo por uso)
// ===========================================================================
//
// Solo si se puede instalar y verificar un modelo abierto con licencia permisiva (por ejemplo
// Basic Pitch de Spotify, licencia a confirmar). Si no, availability() dice por que y transcribe
// rechaza: la interfaz queda con el motivo.

export interface AudioToMidiAvailability {
  available: boolean
  /** En espanol, si no esta disponible ("El modelo no esta instalado en esta version del Hub"). */
  reason: string | null
  /** Modelo y version, si lo hay. */
  model: string | null
  /** Licencia verificada del modelo, si lo hay. */
  license: string | null
}

export interface AudioToMidiOptions {
  /** Tempo de la sesion: las notas salen en beats. */
  bpm: number
  /** 0..1, sensibilidad de inicio de nota; por defecto la del modelo. */
  onsetThreshold?: number
  /** Notas mas cortas se descartan; por defecto 60 ms. */
  minNoteMs?: number
  /** Rango de pitch a conservar. */
  lowPitch?: number
  highPitch?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface AudioToMidiApi {
  availability(): AudioToMidiAvailability
  /**
   * Notas en beats relativos al INICIO del buffer, normalizadas. Rechaza con un Error en espanol
   * si no esta disponible; abortar rechaza con DOMException 'AbortError'.
   */
  transcribe(buffer: AudioBuffer, options: AudioToMidiOptions): Promise<StudioMidiNote[]>
}

// ===========================================================================
// v2 · Trabajos de IA nuevos (STUDIO_V2.md seccion 4). Hub en camelCase; studioCloud traduce.
// ===========================================================================
//
// Tipos aparte (sufijo V2) para no cambiar StudioJobKind ni StudioJobState de v1, que ya usan
// jobs.ts y los paneles. studioCloud puede implementar StudioCloudJobsV2Api ampliando sus
// funciones o con funciones nuevas.

export type StudioJobKindV2 = StudioJobKind | 'compose' | 'analyze' | 'chat'

export type ComposeRole = 'drums' | 'bass' | 'chords' | 'melody'

export interface ComposeContextTrack {
  role: ComposeRole | 'other'
  /** 1..60 caracteres. */
  name: string
  /** 0..256 notas en beats relativos al inicio del tramo a componer; 512 entre todas. */
  notes: StudioMidiNote[]
}

export interface ComposeJobRequest {
  kind: 'compose'
  /** 1..1000 caracteres. */
  prompt: string
  bpm: number
  key: string | null
  beatsPerBar: number
  /** 1..64 compases. */
  lengthBars: number
  role: ComposeRole
  /** 0..4 pistas. */
  context: ComposeContextTrack[]
}

export interface AnalyzeJobRequest {
  kind: 'analyze'
  /** Id (sin extension) de un audio ya subido con putAsset. */
  assetId: string
  durationS: number
}

export type AssistantToolStatus = 'applied' | 'rejected' | 'failed'

/**
 * Llamada a herramienta tal como la pidio el modelo. Se devuelve INTACTA en el turno siguiente:
 * `arguments` queda en snake_case (no se traduce) y `signature` es opaca.
 */
export interface StudioChatToolCall {
  /** "call_1", "call_2"... (lo pone el Worker). */
  id: string
  /** Normalmente un AssistantToolName; puede no serlo (se responde 'failed'). */
  name: string
  arguments: Record<string, unknown>
  signature: string | null
}

export interface StudioChatToolResult {
  callId: string
  name: string
  response: {
    status: AssistantToolStatus
    /** 0..500 caracteres, en espanol, para el modelo. */
    message: string
  }
}

/**
 * Fragmento de audio para que el asistente lo escuche (STUDIO_V2.md 4.3.5): un audio ya subido a
 * assets/ de la sesion (WAV mono 16 kHz, hasta 30 s). Solo con `listen` en la estimacion.
 */
export interface StudioChatListen {
  /** Id sin extension. */
  assetId: string
  /** > 0 y <= 30. */
  durationS: number
}

export type StudioChatMessage =
  | { role: 'user'; text: string; audio?: StudioChatListen }
  | { role: 'model'; text: string | null; toolCalls: StudioChatToolCall[] }
  | { role: 'tool'; toolResults: StudioChatToolResult[] }

export interface StudioTrackSummary {
  id: string
  kind: StudioTrackKind
  name: string
  role: StemRole
  volumeDb: number
  pan: number
  mute: boolean
  solo: boolean
  reverbSendDb: number
  fx: StudioFx[]
  instrument: { type: StudioInstrumentType; preset: string | null; pluginId: string | null } | null
  /** 0..64 clips de audio (los mas cercanos al cabezal si hay mas). */
  clips: Array<{ id: string; startS: number; lengthS: number; active: boolean }>
  /** 0..64 clips MIDI. pitchMin y pitchMax son null sin notas (el registro del clip). */
  midiClips: Array<{
    id: string
    startBeat: number
    lengthBeats: number
    loop: boolean
    noteCount: number
    pitchMin: number | null
    pitchMax: number | null
    /** Resumen de las notas (opcional; chatContext.midiClipDigest). */
    digest?: MidiClipDigest
    /** Solo si el clip esta silenciado (tecla 0): se ve pero no suena (STUDIO_V2.md 4.3.2). */
    muted?: true
  }>
  /** Medicion de la pista sola (opcional; solo con `mixMeasured` en el resumen). */
  mix?: TrackMixSummary
}

/** Resumen de las notas de un clip MIDI para el asistente (STUDIO_V2.md 4.3.2, MidiDigest). */
export interface MidiClipDigest {
  /** Largo resumido: loopBeats con loop, si no lengthBeats. */
  spanBeats: number
  /** [nombre, peso por duracion] de mayor a menor; vacio en bateria. */
  pitchClasses: Array<[string, number]>
  /** Solo bateria: [pitch GM, golpes]. */
  hits?: Array<[number, number]>
  notesPerBar: number
  grid: MidiGridName
  /** Entero, o null sin notas. */
  velocityMean: number | null
  /** [pitch, start_beat, dur_beats, velocity] con start relativo al clip; solo patrones de hasta 64 notas. */
  notes?: Array<[number, number, number, number]>
}

export type MidiGridName = '1/4' | '1/8' | '1/8t' | '1/16' | '1/16t' | '1/32' | 'libre'

export interface TrackMixSummary {
  lufs: number | null
  truePeakDb: number | null
  bands: BandEnergies | null
  /** Fader de la pista al medir. */
  volumeDb: number
}

/** Progresion de acordes de la cancion del repertorio (STUDIO_V2.md 4.3.2, SongChart). Sin letra. */
export interface SongChartSummary {
  title: string
  key: string | null
  bpm: number
  beatsPerBar: number
  sections: Array<{ label: string; kind: string; startBar: number; bars: number; chords: string }>
}

/**
 * Lo que el asistente sabe de la sesion (STUDIO_V2.md 4.3.2). Nunca audio ni letras. Los campos
 * opcionales se omiten si el Hub no tiene el dato.
 */
export interface StudioSessionSummary {
  title: string
  bpm: number
  beatsPerBar: number
  key: string | null
  /** Fin del ultimo clip activo (sessionEndSeconds). */
  lengthS: number
  playheadBeat: number
  selection: { trackId: string | null; clipIds: string[]; context: CommandContext }
  /** Loop activo del transporte, en beats; null u omitido si no hay loop (cable `loop`, opcional). */
  loop?: { startBeat: number; endBeat: number } | null
  tracks: StudioTrackSummary[]
  markers: StudioMarker[]
  /** Acordes de la sesion mas cercanos al cabezal, [beat, lengthBeats, nombre] (1..256). */
  chords?: Array<[number, number, string]>
  songChart?: SongChartSummary
  mixMeasured?: { fresh: boolean; masterLufs: number | null; masterTruePeakDb: number | null }
  master: { volumeDb: number; fx: StudioFx[]; reverb: StudioReverb }
}

export interface ChatJobRequest {
  kind: 'chat'
  /** 1..40 mensajes; el primero de 'user', el ultimo de 'user' o 'tool'. */
  messages: StudioChatMessage[]
  sessionSummary: StudioSessionSummary
  /** Por defecto 'auto'; 'none' tras 8 vueltas seguidas con herramientas. */
  toolMode?: 'auto' | 'none'
}

export type StudioJobRequestV2 = StudioJobRequest | ComposeJobRequest | AnalyzeJobRequest | ChatJobRequest

export interface StudioAnalysisMarker {
  /** Segundos dentro del AUDIO analizado (no de la sesion). */
  timeS: number
  label: string
  kind: StudioMarkerKind
}

export interface StudioAnalysisChord {
  startS: number
  endS: number
  /** "C#m", "A", "F#7". */
  name: string
}

/** Resultado de analyze (STUDIO_V2.md 4.2). Tiempos en segundos del audio. */
export interface StudioAnalysis {
  bpm: number | null
  key: string | null
  beatsPerBar: number
  /** Inicio del primer compas dentro del audio, o null. */
  downbeatS: number | null
  markers: StudioAnalysisMarker[]
  chords: StudioAnalysisChord[]
}

export type StudioJobStateV2 =
  | { status: 'STARTED'; jobId: string; kind: StudioJobKindV2 }
  | { status: 'IMPORTING'; jobId: string; kind: StudioJobKindV2; done: number; total: number }
  | Extract<StudioJobState, { status: 'SUCCEEDED' }>
  | {
      status: 'SUCCEEDED'
      jobId: string
      kind: 'compose'
      /** Ordenadas, sin solapes, en beats relativos al clip nuevo. */
      notes: StudioMidiNote[]
      lengthBeats: number
      /** En espanol: que compuso. */
      description: string
      costUsd: number | null
    }
  | { status: 'SUCCEEDED'; jobId: string; kind: 'analyze'; analysis: StudioAnalysis; costUsd: number | null }
  | { status: 'SUCCEEDED'; jobId: string; kind: 'chat'; reply: string | null; toolCalls: StudioChatToolCall[]; costUsd: number | null }
  | { status: 'FAILED'; jobId: string; kind: StudioJobKindV2; error: string; resumable?: boolean }

export interface StudioJobEstimateV2 extends Omit<StudioJobEstimate, 'kind'> {
  kind: StudioJobKindV2
  /** Solo chat: el Worker escucha fragmentos de audio (STUDIO_CHAT_LISTEN, STUDIO_V2.md 4.3.5). */
  listen?: boolean
}

/**
 * Respuesta de `GET`/`POST .../studio/_cleanup` (STUDIO_V2.md 3.1): audios de la nube que ninguna
 * sesion usa, ningun trabajo en curso necesita y tienen mas de 2 horas.
 */
export interface StudioCleanupReport {
  orphans: number
  bytes: number
  /** Hasta 20 `<session>/<archivo>` de muestra. */
  sample: string[]
  sessions: number
  /** Sesiones saltadas por un trabajo en curso. */
  protectedSessions: number
  /** false: no se pudo revisar todo y no se borro nada (ver `blocked`). */
  complete: boolean
  blocked: 'session_unreadable' | 'incomplete' | null
  /** Solo en la limpieza (POST); en la inspeccion, 0. */
  deleted: number
  deletedBytes: number
}

export interface StudioCloudCleanupApi {
  /** Cuenta los audios huerfanos de la banda sin borrar nada. Cualquier integrante. */
  inspectOrphans(target: CloudTarget): Promise<StudioCleanupReport>
  /** Borra los audios huerfanos. Solo Owner o Director musical (403 not_an_editor). */
  cleanOrphans(target: CloudTarget): Promise<StudioCleanupReport>
}

export interface StudioCloudJobsV2Api {
  /** Como startJob, con los kind de v2. `chat` admite un cuerpo de hasta 192 KB. */
  startJobV2(target: CloudTarget, sessionId: string, request: StudioJobRequestV2, jobId?: string): Promise<StudioJobStateV2>
  estimateJobV2(target: CloudTarget, sessionId: string, request: StudioJobRequestV2): Promise<StudioJobEstimateV2>
  getJobV2(target: CloudTarget, sessionId: string, jobId: string): Promise<StudioJobStateV2>
  watchJobV2(
    target: CloudTarget,
    sessionId: string,
    jobId: string,
    options?: Omit<WatchJobOptions, 'onState'> & { onState?: (state: StudioJobStateV2) => void },
  ): Promise<StudioJobStateV2 | null>
}

// ===========================================================================
// Control de versiones del Estudio (STUDIO_V2.md 7.2)
// ===========================================================================

export interface StudioVcsCommitMeta {
  id: string
  branch: string
  parentId: string | null
  message: string
  authorId: string | null
  authorName: string
  createdAt: string
  trackCount: number
  bpm: number
  key: string | null
  assetFiles: string[]
}

export interface StudioVcsIndex {
  version: 1
  branches: Record<string, string>
  commits: StudioVcsCommitMeta[]
  protectedAssets: string[]
  etag: string | null
}

export interface PostStudioVcsOptions {
  branch: string
  message: string
  authorName?: string
  parentId?: string | null
  session: StudioSession
}

export interface StudioCloudVcsApi {
  getVcs(target: CloudTarget, sessionId: string): Promise<StudioVcsIndex>
  postVcs(target: CloudTarget, sessionId: string, options: PostStudioVcsOptions): Promise<{ commit: StudioVcsCommitMeta; vcs: StudioVcsIndex }>
  getCommit(target: CloudTarget, sessionId: string, commitId: string): Promise<StudioSession>
  deleteVcsBranch(target: CloudTarget, sessionId: string, branch: string): Promise<StudioVcsIndex>
}

