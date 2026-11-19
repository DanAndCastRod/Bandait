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
 *   - Los tipos del documento (`StudioSession`, `StudioClip`...) y sus limites viven en
 *     session.ts. El contrato del cable es bandait-protocol/STUDIO_V1.md.
 *   - Tiempos en segundos (sufijo `S` o `Seconds`), niveles en dB (sufijo `Db`). Un nivel de
 *     silencio es `-Infinity`.
 *   - En el camino del audio no hay eventos por fotograma: medidores, posicion y niveles se LEEN
 *     con una funcion desde requestAnimationFrame. `onStateChange` solo avisa cambios discretos
 *     (reproducir, detener, cargar), nunca el avance del cabezal.
 *   - Modulos puros (sin DOM ni import.meta.env; se prueban con node --experimental-strip-types
 *     e importan con extension .ts): session, sessionOps, history, latency, loudness, peaks, wav,
 *     studioCloud. Los demas usan APIs del navegador.
 */
import type { CloudTarget } from '../stemCloud.ts'
import type { StemRole } from '../stemNames.ts'
import type {
  StudioAsset,
  StudioAssetSource,
  StudioClip,
  StudioFx,
  StudioFxParamsByType,
  StudioFxType,
  StudioMaster,
  StudioSession,
  StudioTrack,
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
   * (minimo de minimos, maximo de maximos). Fuera del audio devuelve 0. No asigna por
   * fotograma si se le pasa `out` del tamano correcto.
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
   */
  buildGraph(ctx: BaseAudioContext, session: StudioSession, buffers: StudioBuffers): StudioGraph
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
