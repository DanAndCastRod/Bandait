/**
 * Motor del Estudio: transporte en tiempo real sobre un AudioContext (sin React).
 *
 * Mismo patron que stemPlayer.ts:
 *   - Todas las fuentes de un tramo se programan contra el MISMO instante del reloj del
 *     AudioContext (graph.scheduleClips), asi quedan alineadas a la muestra sin depender de timers.
 *   - La repeticion no usa `source.loop`: se programan tramos consecutivos, cada uno empezando
 *     exactamente donde termina el anterior. Un intervalo solo agenda con anticipacion; el audio
 *     nunca depende de su puntualidad.
 *   - La posicion se calcula al pedirla (`position()`), para pintarla desde requestAnimationFrame.
 *
 * Lo propio del Estudio:
 *   - El grafo lo construye graph.buildGraph, el mismo que usa bounce.
 *   - `updateSession` aplica faders, paneo y efectos en caliente (graph.update); si cambian clips
 *     o la topologia, reprograma lo que falta por sonar 60 ms mas adelante, sin mover el reloj
 *     del transporte.
 *   - El clic (click.ts) sale directo a la salida: no pasa por el master ni por los medidores.
 *   - Medidores con AnalyserNode que se LEEN por funcion; no hay eventos por fotograma.
 *
 * Sin region de repeticion el transporte no se detiene al acabar el ultimo clip: sigue hasta los
 * 20 minutos de la sesion, para poder grabar mas alla de lo que ya existe.
 *
 * v2, pistas de instrumento: el grafo trae el instrumento de cada pista (graph.buildGraph con lo
 * que dejo `prepareInstruments`) y cada tramo programa, ademas de los clips de audio, las notas de
 * los clips MIDI (instruments/schedule.ts) en el mismo instante del reloj; las pistas cuyo
 * instrumento no esta disponible suenan con su congelado. `previewNote` toca una nota suelta (el
 * piano roll al dibujar) y `liveNoteOn`/`liveNoteOff` tocan en vivo (teclado MIDI o de
 * computadora), por la misma cadena de la pista.
 */
import { StudioClick, clickEventsInWindow, countInSeconds } from './click.ts'
import { gainToDb, gatedLufs, lufsFromMeanSquare } from './fx.ts'
import { buildGraph, clipsEqual, prepareGraphContext, scheduleClips, type BuiltStudioGraph } from './graph.ts'
import { instrumentTailSeconds, midiChangedTrackIds } from './instruments/core.ts'
import { needsPreparation, prepareInstruments, releaseInstruments } from './instruments/factory.ts'
import { scheduleMidiClips } from './instruments/schedule.ts'
import { kWeightingCoefficients, truePeakDb } from './loudness.ts'
import { STUDIO_MAX_SESSION_SECONDS, STUDIO_VOLUME_DB_MAX, STUDIO_VOLUME_DB_MIN, sessionEndSeconds, usedAssetIds, type StudioAsset, type StudioSession } from './session.ts'
import type {
  ClickSettings,
  EngineLoadProgress,
  EngineState,
  InstrumentPreparation,
  LoopRegionS,
  MasterMeterReading,
  MeterReading,
  PlayOptions,
  PlayStart,
  ResolveAudio,
  ScheduledClips,
  StudioBuffers,
  StudioEngineApi,
  StudioEngineOptions,
} from './types.ts'

// ---------------------------------------------------------------------------
// Logica pura
// ---------------------------------------------------------------------------

/** Margen entre "ahora" y el arranque programado: da tiempo a crear las fuentes. */
export const START_DELAY_S = 0.06
/** Con cuanta anticipacion se programa el siguiente tramo de una repeticion. */
export const SEGMENT_LOOKAHEAD_S = 1.5
/** Con cuanta anticipacion se programan los golpes del clic. */
export const CLICK_LOOKAHEAD_S = 1.0
/** Largo minimo de una region de repeticion. */
export const MIN_LOOP_S = 0.1
const TICK_MS = 25
/** Tiempo que una edicion de clips debe quedarse quieta, con el motor rodando, antes de reprogramar. */
export const RESCHEDULE_SETTLE_MS = 120

export const DEFAULT_CLICK: Readonly<ClickSettings> = { enabled: false, volumeDb: -6, countInBars: 1 }

/** Tramo de reproduccion: la posicion `offsetS` de la sesion suena en `ctxStart` y dura `lengthS`. */
export interface TransportSegment {
  ctxStart: number
  offsetS: number
  lengthS: number
}

/**
 * Posicion de la sesion en el instante `now` del contexto, dados los tramos programados (en
 * orden). Antes del primer tramo (conteo previo) devuelve su posicion de arranque.
 */
export function positionAt(segments: readonly TransportSegment[], now: number, fallback: number): number {
  if (segments.length === 0) return fallback
  let current = segments[0]
  for (const segment of segments) {
    if (segment.ctxStart <= now) current = segment
    else break
  }
  const elapsed = Math.min(Math.max(0, now - current.ctxStart), current.lengthS)
  return current.offsetS + elapsed
}

/**
 * Instante del contexto en que SALE del grafo lo que se programo en `scheduledCtxTime`. El grafo
 * retrasa la mezcla (5 ms del limitador del master, 6 ms por compresor): el cabezal, el clic y la
 * alineacion de las tomas se miden contra lo que se oye, no contra lo programado. Sin esto cada
 * sobregrabacion quedaba corrida ese retardo respecto a la base, y el error se acumulaba.
 */
export function audibleCtxTime(scheduledCtxTime: number, graphLatencyS: number): number {
  return scheduledCtxTime + (Number.isFinite(graphLatencyS) && graphLatencyS > 0 ? graphLatencyS : 0)
}

/** Posicion que se esta OYENDO en `now`: la programada hace `graphLatencyS` segundos. */
export function audiblePositionAt(segments: readonly TransportSegment[], now: number, graphLatencyS: number, fallback: number): number {
  return positionAt(segments, now - (Number.isFinite(graphLatencyS) && graphLatencyS > 0 ? graphLatencyS : 0), fallback)
}

/** Region de repeticion acotada a la sesion; null si no queda una region util. */
export function normalizeLoop(region: LoopRegionS | null): LoopRegionS | null {
  if (!region || !Number.isFinite(region.startS) || !Number.isFinite(region.endS)) return null
  const startS = Math.max(0, Math.min(region.startS, STUDIO_MAX_SESSION_SECONDS))
  const endS = Math.max(0, Math.min(region.endS, STUDIO_MAX_SESSION_SECONDS))
  return endS - startS >= MIN_LOOP_S ? { startS, endS } : null
}

/** Posicion acotada a la sesion. */
export function clampPosition(positionS: number): number {
  return Math.min(Math.max(0, Number.isFinite(positionS) ? positionS : 0), STUDIO_MAX_SESSION_SECONDS)
}

/**
 * Audios de la sesion que se pueden oir: los de algun clip (activo o no: una toma inactiva se
 * puede activar en caliente) y, en v2, las zonas del sampler y los congelados.
 */
export function assetsInUse(session: StudioSession): StudioAsset[] {
  const used = usedAssetIds(session)
  return session.assets.filter((asset) => used.has(asset.id))
}

/** Nota suelta del piano roll: lo que dura si no se dice otra cosa. */
export const PREVIEW_NOTE_S = 0.4
/** Margen para que una nota tocada en vivo no caiga en un bloque de audio ya calculado. */
export const LIVE_NOTE_DELAY_S = 0.005

/**
 * Que hay que reprogramar tras una edicion en caliente: los clips de audio y/o las notas de ciertas
 * pistas de instrumento ('all': todas). Lo que no esta en el alcance sigue sonando sin cortarse.
 */
export interface RescheduleScope {
  audio: boolean
  midi: ReadonlySet<string> | 'all'
}

export const FULL_RESCHEDULE: Readonly<RescheduleScope> = { audio: true, midi: 'all' }

/** Une dos alcances pendientes (la edicion sigue mientras espera el asentamiento). */
export function mergeScope(a: RescheduleScope | null, b: RescheduleScope): RescheduleScope {
  if (!a) return b
  const midi = a.midi === 'all' || b.midi === 'all' ? 'all' : new Set([...a.midi, ...b.midi])
  return { audio: a.audio || b.audio, midi }
}

/** true si el alcance no pide reprogramar nada. */
export function scopeIsEmpty(scope: RescheduleScope): boolean {
  return !scope.audio && scope.midi !== 'all' && scope.midi.size === 0
}

/** true si una tanda (de audio, o de notas de la pista trackId) entra en el alcance. */
export function batchInScope(batch: { kind: 'audio' | 'midi'; trackId: string | null }, scope: RescheduleScope): boolean {
  if (batch.kind === 'audio') return scope.audio
  return scope.midi === 'all' || (batch.trackId !== null && scope.midi.has(batch.trackId))
}

/**
 * Espera antes de soltar las notas de un tramo de repeticion terminado: su cola (relajacion del
 * synth, caida de la caja) sigue sonando despues del fin de la region. Soltarlas al empezar el
 * tramo siguiente las cortaba en seco en cada vuelta, con un clic.
 */
export function finishedSegmentReleaseMs(tailS: number): number {
  return (Math.max(0, Number.isFinite(tailS) ? tailS : 0) + 0.1) * 1000
}

/**
 * Posicion en la que la escucha sin repeticion se detiene sola: el fin del ultimo clip mas la cola
 * de los instrumentos (relajacion, caidas), con un minimo de 0.4 s. Asi la ultima nota suena
 * entera, igual que en la exportacion (bounce suma la misma cola).
 */
export function playbackStopS(durationS: number, tailS: number): number {
  const tail = Number.isFinite(tailS) && tailS > 0 ? tailS + 0.1 : 0
  return durationS + Math.max(0.4, tail)
}

/** Un ScheduledClips que maneja varios a la vez (clips de audio y notas de la misma tanda). */
export function combineScheduled(batches: readonly ScheduledClips[]): ScheduledClips {
  return {
    stop(atCtxTime?: number) {
      for (const batch of batches) batch.stop(atCtxTime)
    },
    dispose() {
      for (const batch of batches) batch.dispose()
    },
  }
}

/** Ajustes de clic validos: volumen en el rango del fader y de 0 a 4 compases enteros de conteo. */
export function normalizeClick(settings: ClickSettings): ClickSettings {
  const volume = Number.isFinite(settings.volumeDb) ? settings.volumeDb : DEFAULT_CLICK.volumeDb
  const bars = Number.isFinite(settings.countInBars) ? Math.floor(settings.countInBars) : DEFAULT_CLICK.countInBars
  return {
    enabled: settings.enabled === true,
    volumeDb: Math.max(STUDIO_VOLUME_DB_MIN, Math.min(STUDIO_VOLUME_DB_MAX, volume)),
    countInBars: Math.max(0, Math.min(4, bars)),
  }
}

/** Mayor valor absoluto de `data` desde el indice `from`. */
export function peakOf(data: Float32Array, from = 0): number {
  let peak = 0
  for (let i = Math.max(0, from); i < data.length; i++) {
    const v = data[i] < 0 ? -data[i] : data[i]
    if (v > peak) peak = v
  }
  return peak
}

/** Potencia media de `data` desde el indice `from`. */
export function meanSquareOf(data: Float32Array, from = 0): number {
  const start = Math.max(0, from)
  const n = data.length - start
  if (n <= 0) return 0
  let sum = 0
  for (let i = start; i < data.length; i++) sum += data[i] * data[i]
  return sum / n
}

// ---------------------------------------------------------------------------
// Medidores
// ---------------------------------------------------------------------------

const METER_WINDOW = 2048
const PEAK_WINDOW = 8192
const LOUDNESS_WINDOW = 32768
const LOUDNESS_STEP_S = 0.1
const LOUDNESS_BLOCK_S = 0.4
/** Muestras a cada lado del pico que se sobremuestrean para estimar el pico real. */
const TRUE_PEAK_HALF = 128
const TRUE_PEAK_TAPER = 32

const SILENT_METER: Readonly<MeterReading> = { peakDb: Number.NEGATIVE_INFINITY, rmsDb: Number.NEGATIVE_INFINITY }

/** Un AnalyserNode por canal: AnalyserNode por si solo mezcla a mono y esconderia el paneo. */
class StereoTap {
  readonly input: ChannelSplitterNode
  readonly left: Float32Array<ArrayBuffer>
  readonly right: Float32Array<ArrayBuffer>
  private readonly analysers: [AnalyserNode, AnalyserNode]

  constructor(ctx: BaseAudioContext, fftSize: number) {
    this.input = ctx.createChannelSplitter(2)
    this.analysers = [ctx.createAnalyser(), ctx.createAnalyser()]
    this.analysers.forEach((analyser, channel) => {
      analyser.fftSize = fftSize
      this.input.connect(analyser, channel)
    })
    this.left = new Float32Array(fftSize)
    this.right = new Float32Array(fftSize)
  }

  read(): void {
    this.analysers[0].getFloatTimeDomainData(this.left)
    this.analysers[1].getFloatTimeDomainData(this.right)
  }

  dispose(): void {
    this.input.disconnect()
    for (const analyser of this.analysers) analyser.disconnect()
  }
}

class TrackMeter {
  readonly tap: StereoTap
  /** Se reutiliza en cada lectura: no hay asignacion por fotograma. */
  private readonly reading: MeterReading = { peakDb: Number.NEGATIVE_INFINITY, rmsDb: Number.NEGATIVE_INFINITY }

  constructor(ctx: BaseAudioContext) {
    this.tap = new StereoTap(ctx, METER_WINDOW)
  }

  read(): MeterReading {
    this.tap.read()
    this.reading.peakDb = gainToDb(Math.max(peakOf(this.tap.left), peakOf(this.tap.right)))
    this.reading.rmsDb = gainToDb(Math.sqrt(Math.max(meanSquareOf(this.tap.left), meanSquareOf(this.tap.right))))
    return this.reading
  }
}

/**
 * Medidor del master. Pico y RMS se leen del AnalyserNode en cada llamada. La sonoridad se
 * muestrea desde el intervalo del motor: cada 100 ms toma los ultimos 400 ms ya ponderados K
 * (dos IIRFilterNode con los coeficientes de BS.1770) como un bloque. Es una ESTIMACION del LUFS
 * integrado: si el navegador frena los timers (pestana oculta) se pierden bloques. La medida
 * exacta de un archivo es la de bounce (loudness.integratedLufs sobre todas las muestras).
 */
class MasterMeter {
  private readonly ctx: BaseAudioContext
  private readonly raw: StereoTap
  private readonly weighted: StereoTap
  private readonly shelf: IIRFilterNode
  private readonly highpass: IIRFilterNode
  private blocks = new Float64Array(4096)
  private blockCount = 0
  private lastBlockAt = Number.NEGATIVE_INFINITY
  private momentary = Number.NEGATIVE_INFINITY
  private integrated = Number.NEGATIVE_INFINITY
  private truePeak = 0
  private readonly slices: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]
  private readonly reading: MasterMeterReading = {
    peakDb: Number.NEGATIVE_INFINITY,
    rmsDb: Number.NEGATIVE_INFINITY,
    momentaryLufs: Number.NEGATIVE_INFINITY,
    integratedLufs: Number.NEGATIVE_INFINITY,
    truePeakDb: Number.NEGATIVE_INFINITY,
  }

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx
    this.raw = new StereoTap(ctx, PEAK_WINDOW)
    this.weighted = new StereoTap(ctx, LOUDNESS_WINDOW)
    const k = kWeightingCoefficients(ctx.sampleRate)
    this.shelf = ctx.createIIRFilter([k.shelf.b0, k.shelf.b1, k.shelf.b2], [1, k.shelf.a1, k.shelf.a2])
    this.highpass = ctx.createIIRFilter([k.highpass.b0, k.highpass.b1, k.highpass.b2], [1, k.highpass.a1, k.highpass.a2])
    this.shelf.connect(this.highpass)
    this.highpass.connect(this.weighted.input)
    const size = TRUE_PEAK_HALF * 2 + 1
    this.slices = [new Float32Array(size), new Float32Array(size)]
  }

  attach(node: AudioNode): void {
    node.connect(this.raw.input)
    node.connect(this.shelf)
  }

  detach(node: AudioNode): void {
    try {
      node.disconnect(this.raw.input)
      node.disconnect(this.shelf)
    } catch {
      // ya desconectado
    }
  }

  /** Reinicia el LUFS integrado y el pico real retenido. */
  reset(): void {
    this.blockCount = 0
    this.integrated = Number.NEGATIVE_INFINITY
    this.truePeak = 0
  }

  /** Actualiza pico real y sonoridad. `accumulate` = este instante cuenta para el LUFS integrado. */
  sample(now: number, accumulate: boolean): void {
    this.raw.read()
    this.holdTruePeak()
    if (now - this.lastBlockAt < LOUDNESS_STEP_S - 0.001) return
    this.lastBlockAt = now
    this.weighted.read()
    const length = this.weighted.left.length
    const from = length - Math.min(length, Math.round(LOUDNESS_BLOCK_S * this.ctx.sampleRate))
    const meanSquare = meanSquareOf(this.weighted.left, from) + meanSquareOf(this.weighted.right, from)
    this.momentary = lufsFromMeanSquare(meanSquare)
    if (!accumulate) return
    if (this.blockCount === this.blocks.length) {
      const grown = new Float64Array(this.blocks.length * 2)
      grown.set(this.blocks)
      this.blocks = grown
    }
    this.blocks[this.blockCount++] = meanSquare
    this.integrated = gatedLufs(this.blocks, this.blockCount)
  }

  /** Requiere `raw` recien leido. Solo sobremuestrea alrededor del pico, y solo si puede superar al retenido. */
  private holdTruePeak(): void {
    const { left, right } = this.raw
    let peak = 0
    let index = 0
    for (let i = 0; i < left.length; i++) {
      const l = left[i] < 0 ? -left[i] : left[i]
      const r = right[i] < 0 ? -right[i] : right[i]
      const v = l > r ? l : r
      if (v > peak) {
        peak = v
        index = i
      }
    }
    if (!(peak > 0) || peak < this.truePeak * 0.7) return
    const size = this.slices[0].length
    const start = index - TRUE_PEAK_HALF
    for (let i = 0; i < size; i++) {
      const at = start + i
      const inside = at >= 0 && at < left.length
      // Bordes atenuados: cortar la ventana en seco inventaria un sobrepaso que no existe.
      const taper = Math.min(1, (i + 1) / TRUE_PEAK_TAPER, (size - i) / TRUE_PEAK_TAPER)
      this.slices[0][i] = inside ? left[at] * taper : 0
      this.slices[1][i] = inside ? right[at] * taper : 0
    }
    const refined = Math.pow(10, truePeakDb(this.slices, this.ctx.sampleRate) / 20)
    this.truePeak = Math.max(this.truePeak, peak, Number.isFinite(refined) ? refined : 0)
  }

  read(): MasterMeterReading {
    this.raw.read()
    const from = this.raw.left.length - METER_WINDOW
    this.reading.peakDb = gainToDb(Math.max(peakOf(this.raw.left, from), peakOf(this.raw.right, from)))
    this.reading.rmsDb = gainToDb(Math.sqrt(Math.max(meanSquareOf(this.raw.left, from), meanSquareOf(this.raw.right, from))))
    this.reading.momentaryLufs = this.momentary
    this.reading.integratedLufs = this.integrated
    this.reading.truePeakDb = gainToDb(this.truePeak)
    return this.reading
  }

  dispose(): void {
    this.raw.dispose()
    this.weighted.dispose()
    this.shelf.disconnect()
    this.highpass.disconnect()
  }
}

// ---------------------------------------------------------------------------
// StudioEngine
// ---------------------------------------------------------------------------

/** Una tanda de fuentes: los clips de audio del tramo, o las notas de UNA pista de instrumento. */
interface SegmentBatch {
  kind: 'audio' | 'midi'
  trackId: string | null
  batch: ScheduledClips
}

interface Segment extends TransportSegment {
  /** Tandas de fuentes de este tramo (mas de una por pista si se reprogramo a mitad de camino). */
  batches: SegmentBatch[]
}

interface Deferred {
  timer: ReturnType<typeof setTimeout>
  run: () => void
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

function sameLoop(a: LoopRegionS | null, b: LoopRegionS | null): boolean {
  return a === b || (a !== null && b !== null && a.startS === b.startS && a.endS === b.endS)
}

export class StudioEngine implements StudioEngineApi {
  private ctx: AudioContext | null
  private readonly ownsContext: boolean
  /** Sesion que el grafo tiene aplicada. */
  private session: StudioSession | null = null
  /** Ultima sesion pedida (puede ir por delante de `session` mientras se resuelven audios). */
  private target: StudioSession | null = null
  private resolveAudio: ResolveAudio | null = null
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly missing = new Set<string>()
  private readonly resolving = new Map<string, Promise<AudioBuffer | null>>()
  /** Llego audio nuevo desde la ultima vez que se programo. */
  private buffersDirty = false
  private graph: BuiltStudioGraph | null = null
  /** Lo que prepareInstruments dejo listo en `ctx` (plugins WAM); se pasa a buildGraph. */
  private preparation: InstrumentPreparation | null = null
  private click: StudioClick | null = null
  private masterMeter: MasterMeter | null = null
  private readonly trackMeters = new Map<string, TrackMeter>()
  private state: EngineState = { status: 'empty', durationS: 0, loop: null, missingAssetIds: [], click: { ...DEFAULT_CLICK } }
  private readonly listeners = new Set<(state: EngineState) => void>()
  private segments: Segment[] = []
  private countIn: { endCtx: number; bars: number } | null = null
  private playStart: PlayStart | null = null
  private starting: Promise<PlayStart> | null = null
  private pausedAt = 0
  private startedFrom = 0
  private clickCursor = 0
  private timer: ReturnType<typeof setInterval> | null = null
  /** Reprogramacion pendiente por una edicion de clips en caliente (ver apply). */
  private rescheduleTimer: ReturnType<typeof setTimeout> | null = null
  /** Lo que la reprogramacion pendiente debe tocar (se acumula mientras la edicion sigue). */
  private pendingScope: RescheduleScope | null = null
  /** Invalida un play() en curso si llega pause/stop/seek mientras espera resume(). */
  private generation = 0
  /** Invalida una carga o una resolucion de audios cuando llega otra carga. */
  private loadGeneration = 0
  private loading: Promise<void> | null = null
  private readonly deferred = new Set<Deferred>()
  private disposed = false

  constructor(options: StudioEngineOptions = {}) {
    this.ctx = options.context ?? null
    this.ownsContext = !options.context
  }

  // ---- estado ----

  getState(): EngineState {
    return this.state
  }

  onStateChange(listener: (state: EngineState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(patch: Partial<EngineState>): void {
    const next: EngineState = { ...this.state, ...patch }
    const prev = this.state
    if (
      next.status === prev.status &&
      next.durationS === prev.durationS &&
      sameLoop(next.loop, prev.loop) &&
      sameIds(next.missingAssetIds, prev.missingAssetIds) &&
      next.click.enabled === prev.click.enabled &&
      next.click.volumeDb === prev.click.volumeDb &&
      next.click.countInBars === prev.click.countInBars
    ) {
      return
    }
    this.state = next
    for (const listener of [...this.listeners]) listener(next)
  }

  private isRolling(): boolean {
    return this.state.status === 'playing' || this.state.status === 'count_in'
  }

  // ---- contexto ----

  getContext(): AudioContext {
    return this.ensureContext(this.target?.sampleRate)
  }

  private ensureContext(sampleRate?: number): AudioContext {
    if (this.disposed) throw new Error('El motor del Estudio ya se cerró.')
    if (this.ctx) return this.ctx
    const scope = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext
    if (!Ctor) throw new Error('Este navegador no tiene Web Audio.')
    let ctx: AudioContext
    try {
      // 'interactive': la menor latencia de salida que ofrezca el equipo, para grabar encima.
      ctx = sampleRate ? new Ctor({ latencyHint: 'interactive', sampleRate }) : new Ctor({ latencyHint: 'interactive' })
    } catch {
      // El equipo no admite esa frecuencia: se usa la suya y el navegador convierte.
      ctx = new Ctor({ latencyHint: 'interactive' })
    }
    this.ctx = ctx
    return ctx
  }

  /** Cierra el contexto propio si su frecuencia no es la de la sesion, para crearlo de nuevo. */
  private releaseMismatchedContext(sampleRate: number): void {
    const ctx = this.ctx
    if (!ctx || !this.ownsContext || ctx.sampleRate === sampleRate) return
    this.click?.dispose()
    this.click = null
    this.masterMeter?.dispose()
    this.masterMeter = null
    releaseInstruments(ctx)
    this.preparation = null
    this.ctx = null
    if (ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }

  // ---- carga ----

  async load(session: StudioSession, resolveAudio: ResolveAudio, onProgress?: (progress: EngineLoadProgress) => void): Promise<void> {
    if (this.disposed) throw new Error('El motor del Estudio ya se cerró.')
    const generation = ++this.loadGeneration
    this.halt()
    this.resolveAudio = resolveAudio
    this.target = session
    const run = this.runLoad(session, resolveAudio, generation, onProgress)
    this.loading = run
    try {
      await run
    } finally {
      if (this.loading === run) this.loading = null
    }
  }

  private async runLoad(session: StudioSession, resolveAudio: ResolveAudio, generation: number, onProgress?: (progress: EngineLoadProgress) => void): Promise<void> {
    this.teardownGraph()
    // Los audios son inmutables: al recargar la misma sesion se conserva lo ya decodificado.
    if (this.session && this.session.id !== session.id) this.buffers.clear()
    this.session = null
    this.missing.clear()
    this.resolving.clear()
    this.pausedAt = 0
    this.startedFrom = 0
    this.setState({ status: 'loading', durationS: 0, loop: null, missingAssetIds: [] })
    this.releaseMismatchedContext(session.sampleRate)
    const ctx = this.ensureContext(session.sampleRate)

    const assets = assetsInUse(session)
    let done = 0
    onProgress?.({ done, total: assets.length })
    // Uno por uno: el pico de memoria al decodificar es un archivo a la vez.
    for (const asset of assets) {
      if (!this.buffers.has(asset.id)) {
        let buffer: AudioBuffer | null
        try {
          buffer = await resolveAudio(asset)
        } catch {
          buffer = null
        }
        if (generation !== this.loadGeneration || this.disposed) return
        if (buffer) this.buffers.set(asset.id, buffer)
        else this.missing.add(asset.id)
      }
      done++
      onProgress?.({ done, total: assets.length })
    }
    await prepareGraphContext(ctx)
    if (generation !== this.loadGeneration || this.disposed) return
    const preparation = await prepareInstruments(ctx, session)
    if (generation !== this.loadGeneration || this.disposed) return
    this.preparation = preparation

    this.pruneBuffers(session)
    this.mountGraph(ctx, session)
    this.session = session
    this.buffersDirty = false
    this.setState({ status: 'stopped', durationS: sessionEndSeconds(session), missingAssetIds: [...this.missing] })
    // Si llego una edicion mientras se cargaba, se aplica ahora.
    if (this.target && this.target !== session) await this.syncTo(this.target, false)
  }

  private mountGraph(ctx: AudioContext, session: StudioSession): void {
    const graph = buildGraph(ctx, session, this.buffers, this.preparation ?? undefined)
    graph.master.connect(ctx.destination)
    this.graph = graph
    if (!this.masterMeter) this.masterMeter = new MasterMeter(ctx)
    this.masterMeter.attach(graph.master)
    if (!this.click) this.click = new StudioClick(ctx, this.state.click.volumeDb)
    // El clic no pasa por el grafo: se retrasa lo mismo que la mezcla para sonar con ella.
    this.click.setDelayS(graph.latency.totalS)
  }

  private teardownGraph(): void {
    const graph = this.graph
    if (!graph) return
    this.masterMeter?.detach(graph.master)
    for (const meter of this.trackMeters.values()) meter.tap.dispose()
    this.trackMeters.clear()
    graph.dispose()
    this.graph = null
  }

  private pruneBuffers(session: StudioSession): void {
    const listed = new Set(session.assets.map((asset) => asset.id))
    for (const id of [...this.buffers.keys()]) if (!listed.has(id)) this.buffers.delete(id)
    for (const id of [...this.missing]) if (!listed.has(id)) this.missing.delete(id)
  }

  getBuffer(assetId: string): AudioBuffer | null {
    return this.buffers.get(assetId) ?? null
  }

  getBuffers(): StudioBuffers {
    return this.buffers
  }

  // ---- edicion en caliente ----

  async updateSession(session: StudioSession, resolveAudio?: ResolveAudio): Promise<void> {
    if (this.disposed) return
    if (resolveAudio) this.resolveAudio = resolveAudio
    if (this.loading) {
      this.target = session
      await this.loading
      return
    }
    if (!this.session || !this.graph || this.session.id !== session.id) {
      if (!this.resolveAudio) throw new Error('El motor no tiene cómo resolver los audios: hay que cargar la sesión con load().')
      await this.load(session, this.resolveAudio)
      return
    }
    await this.syncTo(session, resolveAudio !== undefined)
  }

  /**
   * Resuelve los audios que `session` usa y todavia no estan, y aplica la sesion mas reciente.
   * Sin audios nuevos es sincrono de punta a punta: un fader no espera a nadie.
   */
  private async syncTo(session: StudioSession, retryMissing: boolean): Promise<void> {
    const generation = this.loadGeneration
    this.target = session
    const needed = assetsInUse(session).filter((asset) => !this.buffers.has(asset.id) && (retryMissing || !this.missing.has(asset.id)))
    for (const asset of needed) {
      if (this.buffers.has(asset.id)) continue
      let pending = this.resolving.get(asset.id)
      if (!pending) {
        const resolver = this.resolveAudio
        // Dentro de una promesa: un resolvedor que lanza de forma sincrona tampoco tumba la edicion.
        pending = resolver ? Promise.resolve().then(() => resolver(asset)).catch(() => null) : Promise.resolve(null)
        this.resolving.set(asset.id, pending)
      }
      const buffer = await pending
      if (generation !== this.loadGeneration || this.disposed) return
      this.resolving.delete(asset.id)
      if (buffer) {
        if (!this.buffers.has(asset.id)) this.buffersDirty = true
        this.buffers.set(asset.id, buffer)
        this.missing.delete(asset.id)
      } else {
        this.missing.add(asset.id)
      }
    }
    // Un plugin WAM nuevo se crea antes de aplicar (buildGraph es sincrono). Sin WAM no se espera.
    const ctx = this.ctx
    if (ctx && this.target && needsPreparation(this.target, this.preparation)) {
      const preparation = await prepareInstruments(ctx, this.target)
      if (generation !== this.loadGeneration || this.disposed || ctx !== this.ctx) return
      this.preparation = preparation
    }
    if (this.target) this.apply(this.target)
  }

  private apply(next: StudioSession): void {
    const ctx = this.ctx
    const prev = this.session
    const graph = this.graph
    if (!ctx || !prev || !graph) return
    const newAudio = this.buffersDirty
    this.buffersDirty = false
    if (next === prev && !newAudio) {
      this.setState({ missingAssetIds: [...this.missing] })
      return
    }

    let retired: BuiltStudioGraph | null = null
    if (next !== prev && !graph.update(next)) {
      // Cambio la topologia (pistas o efectos): grafo nuevo. El viejo sigue sonando lo que le queda.
      retired = graph
      this.masterMeter?.detach(graph.master)
      for (const meter of this.trackMeters.values()) meter.tap.dispose()
      this.trackMeters.clear()
      this.mountGraph(ctx, next)
    }
    this.session = next
    const rolling = this.isRolling()
    if (rolling && (retired !== null || newAudio)) {
      this.cancelReschedule()
      this.reschedule(FULL_RESCHEDULE)
    } else if (rolling) {
      // Solo cambiaron clips (mover, recortar, ganancia, fades, notas): se reprograma cuando la
      // edicion se queda quieta. Arrastrar un deslizador de clip manda decenas de cambios por
      // segundo, y reprogramar en cada uno cortaba TODAS las pistas en cada evento (tremolo de
      // cortes). Los parametros de un instrumento no reprograman: graph.update los aplica.
      // Solo se reprograma lo que cambio: un clip de audio no toca las notas que suenan, y una
      // nota movida en una pista no vuelve a atacar las notas sostenidas de las otras.
      const scope: RescheduleScope = { audio: !clipsEqual(prev, next), midi: midiChangedTrackIds(prev, next) }
      if (!scopeIsEmpty(scope)) this.requestReschedule(scope)
    }
    if (retired) {
      const old = retired
      if (rolling) this.defer(() => old.dispose(), 250)
      else old.dispose()
    }
    if (next.bpm !== prev.bpm || next.beatsPerBar !== prev.beatsPerBar) this.resetClick()
    this.pruneBuffers(next)
    this.setState({ durationS: sessionEndSeconds(next), missingAssetIds: [...this.missing] })
  }

  private requestReschedule(scope: RescheduleScope): void {
    if (this.rescheduleTimer !== null) clearTimeout(this.rescheduleTimer)
    this.pendingScope = mergeScope(this.pendingScope, scope)
    this.rescheduleTimer = setTimeout(() => {
      this.rescheduleTimer = null
      const pending = this.pendingScope ?? FULL_RESCHEDULE
      this.pendingScope = null
      if (!this.disposed && this.isRolling()) this.reschedule(pending)
    }, RESCHEDULE_SETTLE_MS)
  }

  private cancelReschedule(): void {
    if (this.rescheduleTimer !== null) clearTimeout(this.rescheduleTimer)
    this.rescheduleTimer = null
    this.pendingScope = null
  }

  /**
   * Reprograma lo que falta por sonar de cada tramo, sin mover su reloj. Solo las tandas del
   * alcance: las demas siguen sonando sin cortarse ni volver a atacar sus notas.
   */
  private reschedule(scope: RescheduleScope): void {
    const ctx = this.ctx
    if (!ctx) return
    const sampleRate = ctx.sampleRate
    const cut = Math.round((ctx.currentTime + START_DELAY_S) * sampleRate) / sampleRate
    for (const segment of this.segments) {
      const end = segment.ctxStart + segment.lengthS
      if (end <= cut) continue
      const keep = segment.batches.filter((entry) => !batchInScope(entry, scope))
      const old = segment.batches.filter((entry) => batchInScope(entry, scope))
      if (segment.ctxStart >= cut) {
        // Todavia no empezo: se descarta y se programa entero.
        for (const entry of old) entry.batch.dispose()
        segment.batches = [...keep, ...this.scheduleSegment(segment.ctxStart, segment.offsetS, segment.lengthS, scope)]
      } else {
        for (const entry of old) {
          entry.batch.stop(cut)
          this.defer(() => entry.batch.dispose(), (cut - ctx.currentTime) * 1000 + 100)
        }
        const played = cut - segment.ctxStart
        segment.batches = [...keep, ...this.scheduleSegment(cut, segment.offsetS + played, segment.lengthS - played, scope)]
      }
    }
  }

  // ---- transporte ----

  position(): number {
    if (!this.isRolling() || !this.ctx) return this.pausedAt
    return audiblePositionAt(this.segments, this.ctx.currentTime, this.graphLatencyS(), this.pausedAt)
  }

  /** Retardo del grafo vigente (limitador y compresores), en segundos. */
  private graphLatencyS(): number {
    return this.graph?.latency.totalS ?? 0
  }

  play(options: PlayOptions = {}): Promise<PlayStart> {
    if (this.disposed) return Promise.reject(new Error('El motor del Estudio ya se cerró.'))
    if (this.isRolling() && this.playStart) return Promise.resolve(this.playStart)
    // Dos pulsaciones seguidas comparten un solo arranque: no hay dos reinicios de fase.
    if (this.starting) return this.starting
    const starting = this.begin(options)
    this.starting = starting
    const clear = () => {
      if (this.starting === starting) this.starting = null
    }
    starting.then(clear, clear)
    return starting
  }

  private async begin(options: PlayOptions): Promise<PlayStart> {
    const ctx = this.ctx
    if (!ctx || !this.session || !this.graph || this.state.status === 'loading') throw new Error('No hay una sesión cargada en el motor.')
    const generation = ++this.generation
    if (ctx.state !== 'running') await ctx.resume()
    if (generation !== this.generation || this.disposed) throw new DOMException('La reproducción se canceló antes de arrancar.', 'AbortError')
    return this.startAt(options.fromS ?? this.pausedAt, options.countIn === true)
  }

  private startAt(fromS: number, withCountIn: boolean): PlayStart {
    const ctx = this.ctx
    const session = this.session
    if (!ctx || !session) throw new Error('No hay una sesión cargada en el motor.')
    const loop = this.state.loop
    let from = clampPosition(fromS)
    if (loop && (from < loop.startS || from >= loop.endS)) from = loop.startS
    if (!loop && from >= STUDIO_MAX_SESSION_SECONDS - 0.01) from = 0
    const bars = withCountIn ? this.state.click.countInBars : 0
    const countS = countInSeconds(session.bpm, session.beatsPerBar, bars)
    const now = ctx.currentTime
    const playStartCtxTime = Math.round((now + START_DELAY_S + countS) * ctx.sampleRate) / ctx.sampleRate
    const lengthS = (loop ? loop.endS : STUDIO_MAX_SESSION_SECONDS) - from
    this.segments = [{ ctxStart: playStartCtxTime, offsetS: from, lengthS, batches: this.scheduleSegment(playStartCtxTime, from, lengthS) }]
    this.buffersDirty = false
    this.countIn = countS > 0 ? { endCtx: playStartCtxTime, bars } : null
    // Lo que el grabador alinea es el instante en que `from` se OYE, no el programado.
    this.playStart = { positionAtStart: from, playStartCtxTime: audibleCtxTime(playStartCtxTime, this.graphLatencyS()) }
    this.startedFrom = from
    this.pausedAt = from
    this.clickCursor = now
    this.masterMeter?.reset()
    this.setState({ status: countS > 0 ? 'count_in' : 'playing' })
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
    return this.playStart
  }

  /**
   * Programa un tramo: una tanda con los clips de audio y una por cada pista de instrumento (asi una
   * edicion reprograma solo la pista que cambio). Con `scope`, solo lo que entra en el alcance.
   */
  private scheduleSegment(ctxStart: number, offsetS: number, lengthS: number, scope: RescheduleScope = FULL_RESCHEDULE): SegmentBatch[] {
    const ctx = this.ctx
    const graph = this.graph
    const session = this.session
    if (!ctx || !graph || !session) throw new Error('No hay una sesión cargada en el motor.')
    // Con repeticion el tramo se corta en el fin de la region; sin ella los clips suenan enteros.
    const untilS = this.state.loop ? offsetS + lengthS : undefined
    const options = { fromS: offsetS, atCtxTime: ctxStart, untilS }
    // Clips de audio y notas MIDI contra el MISMO instante del reloj: quedan alineados a la muestra.
    const out: SegmentBatch[] = []
    if (scope.audio) out.push({ kind: 'audio', trackId: null, batch: scheduleClips(ctx, graph, session, this.buffers, options) })
    for (const track of session.tracks) {
      if (track.kind !== 'instrument') continue
      if (scope.midi !== 'all' && !scope.midi.has(track.id)) continue
      const batch = scheduleMidiClips(ctx, graph, session, this.buffers, { ...options, nowCtxTime: ctx.currentTime, trackIds: new Set([track.id]) })
      out.push({ kind: 'midi', trackId: track.id, batch })
    }
    return out
  }

  // ---- notas sueltas y en vivo (v2) ----

  /** Instrumento vivo de una pista, o null (pista de audio, instrumento no disponible o sin sesion). */
  private instrumentOf(trackId: string) {
    return this.graph?.instruments?.get(trackId) ?? null
  }

  /** Reanuda el contexto si hace falta: estas funciones se llaman desde un gesto del usuario. */
  private wake(ctx: AudioContext): void {
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined)
  }

  /**
   * Toca una nota suelta en el instrumento de la pista (escuchar al dibujar en el piano roll). Pasa
   * por la cadena de la pista (efectos, fader, mute). false si la pista no tiene instrumento vivo.
   */
  previewNote(trackId: string, pitch: number, velocity = 100, durationS = PREVIEW_NOTE_S): boolean {
    const ctx = this.ctx
    const node = this.instrumentOf(trackId)
    if (!ctx || !node || this.disposed) return false
    this.wake(ctx)
    const at = ctx.currentTime + LIVE_NOTE_DELAY_S
    node.playNote(pitch, velocity, at, at + Math.max(0.05, Number.isFinite(durationS) ? durationS : PREVIEW_NOTE_S))
    return true
  }

  /** Empieza una nota en vivo (teclado MIDI o de computadora) hasta su liveNoteOff. */
  liveNoteOn(trackId: string, pitch: number, velocity: number): boolean {
    const ctx = this.ctx
    const node = this.instrumentOf(trackId)
    if (!ctx || !node || this.disposed) return false
    this.wake(ctx)
    node.noteOn(pitch, velocity, ctx.currentTime + LIVE_NOTE_DELAY_S)
    return true
  }

  liveNoteOff(trackId: string, pitch: number): void {
    const ctx = this.ctx
    const node = this.instrumentOf(trackId)
    if (!ctx || !node || this.disposed) return
    node.noteOff(pitch, ctx.currentTime + LIVE_NOTE_DELAY_S)
  }

  /** Corta todo lo que suena en el instrumento de la pista (o de todas). Panico de MIDI. */
  liveAllNotesOff(trackId?: string): void {
    const instruments = this.graph?.instruments
    if (!instruments || this.disposed) return
    if (trackId !== undefined) instruments.get(trackId)?.allNotesOff()
    else for (const node of instruments.values()) node.allNotesOff()
  }

  pause(): void {
    if (!this.isRolling()) {
      this.generation++
      return
    }
    const position = this.position()
    this.halt()
    this.pausedAt = position
    this.setState({ status: 'stopped' })
  }

  stop(): void {
    if (this.state.status === 'empty' || this.state.status === 'loading') {
      this.generation++
      return
    }
    this.halt()
    this.pausedAt = this.startedFrom
    this.setState({ status: 'stopped' })
  }

  seek(positionS: number): void {
    const target = clampPosition(positionS)
    if (this.isRolling()) {
      this.halt()
      this.startAt(target, false)
    } else {
      this.generation++
      this.pausedAt = target
    }
  }

  setLoop(region: LoopRegionS | null): void {
    const loop = normalizeLoop(region)
    if (sameLoop(loop, this.state.loop)) return
    const position = this.position()
    const target = loop && (position < loop.startS || position >= loop.endS) ? loop.startS : position
    if (this.isRolling()) {
      this.halt()
      this.setState({ loop })
      this.startAt(target, false)
    } else {
      this.pausedAt = target
      this.setState({ loop })
    }
  }

  private tick(): void {
    const ctx = this.ctx
    const session = this.session
    if (!ctx || !session || !this.isRolling() || this.segments.length === 0) return
    const now = ctx.currentTime
    if (this.state.status === 'count_in' && this.playStart && now >= this.playStart.playStartCtxTime) this.setState({ status: 'playing' })

    const loop = this.state.loop
    const last = this.segments[this.segments.length - 1]
    let end = last.ctxStart + last.lengthS
    if (loop) {
      const lengthS = loop.endS - loop.startS
      while (end - now < SEGMENT_LOOKAHEAD_S) {
        this.segments.push({ ctxStart: end, offsetS: loop.startS, lengthS, batches: this.scheduleSegment(end, loop.startS, lengthS) })
        end += lengthS
      }
      // Olvidar los tramos ya terminados (position() solo mira el actual). Las notas se sueltan
      // despues de su cola: soltarlas ya cortaba en seco la relajacion en cada vuelta. Los clips de
      // audio terminaron en el fin de la region y se sueltan enseguida.
      const releaseMs = finishedSegmentReleaseMs(instrumentTailSeconds(session))
      while (this.segments.length > 1 && this.segments[1].ctxStart <= now) {
        const finished = this.segments.shift()
        if (!finished) continue
        for (const entry of finished.batches) {
          if (entry.kind === 'audio') entry.batch.dispose()
          else this.defer(() => entry.batch.dispose(), releaseMs)
        }
      }
    } else if (now >= end) {
      // Fin de los 20 minutos de la sesion.
      this.halt()
      this.pausedAt = 0
      this.setState({ status: 'stopped' })
      return
    }

    const horizon = Math.min(now + CLICK_LOOKAHEAD_S, end)
    if (this.click && horizon > this.clickCursor) {
      this.click.schedule(
        clickEventsInWindow({
          windowStart: this.clickCursor,
          windowEnd: horizon,
          bpm: session.bpm,
          beatsPerBar: session.beatsPerBar,
          enabled: this.state.click.enabled,
          segments: this.segments,
          countIn: this.countIn,
        }),
      )
      this.clickCursor = horizon
    }
    this.masterMeter?.sample(now, this.state.status === 'playing')
  }

  /** Detiene fuentes, clic e intervalo. No cambia el estado ni la posicion: lo hace quien llama. */
  private halt(): void {
    this.generation++
    this.cancelReschedule()
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const segment of this.segments) {
      for (const { batch } of segment.batches) {
        // Rampa corta antes de soltar las fuentes: cortar en seco hace clic.
        batch.stop()
        this.defer(() => batch.dispose(), 60)
      }
    }
    this.segments = []
    this.click?.cancel()
    this.countIn = null
    this.playStart = null
  }

  private defer(run: () => void, delayMs: number): void {
    const entry: Deferred = {
      run,
      timer: setTimeout(
        () => {
          this.deferred.delete(entry)
          run()
        },
        Math.max(0, delayMs),
      ),
    }
    this.deferred.add(entry)
  }

  private flushDeferred(): void {
    for (const entry of [...this.deferred]) {
      clearTimeout(entry.timer)
      entry.run()
    }
    this.deferred.clear()
  }

  // ---- clic ----

  setClick(settings: ClickSettings): void {
    const click = normalizeClick(settings)
    this.click?.setVolumeDb(click.volumeDb)
    this.setState({ click })
    this.resetClick()
  }

  /** Descarta los golpes ya programados y vuelve a programar desde ahora con los ajustes vigentes. */
  private resetClick(): void {
    if (!this.ctx || !this.click || !this.isRolling()) return
    const now = this.ctx.currentTime
    this.click.cancel(now)
    this.clickCursor = now
  }

  // ---- medidores ----

  /** El objeto devuelto se reutiliza entre lecturas de la misma pista: copiar si hay que guardarlo. */
  readTrackMeter(trackId: string): MeterReading {
    const ctx = this.ctx
    const output = this.graph?.trackOutputs.get(trackId)
    if (!ctx || !output) return SILENT_METER
    let meter = this.trackMeters.get(trackId)
    if (!meter) {
      // Se crea al primer uso: una pista que nadie mira no gasta analizadores.
      meter = new TrackMeter(ctx)
      output.connect(meter.tap.input)
      this.trackMeters.set(trackId, meter)
    }
    return meter.read()
  }

  /** El objeto devuelto se reutiliza entre lecturas: copiar si hay que guardarlo. */
  readMasterMeter(): MasterMeterReading {
    const meter = this.masterMeter
    if (!meter || !this.ctx) return SILENT_MASTER
    // Detenido no corre el intervalo: se muestrea aqui para que la cola de reverb siga midiendo.
    if (!this.isRolling()) meter.sample(this.ctx.currentTime, false)
    return meter.read()
  }

  resetMasterLoudness(): void {
    this.masterMeter?.reset()
  }

  // ---- cierre ----

  dispose(): void {
    if (this.disposed) return
    this.halt()
    this.flushDeferred()
    this.disposed = true
    this.loadGeneration++
    this.teardownGraph()
    this.masterMeter?.dispose()
    this.masterMeter = null
    this.click?.dispose()
    this.click = null
    this.buffers.clear()
    this.missing.clear()
    this.resolving.clear()
    this.listeners.clear()
    this.session = null
    this.target = null
    this.resolveAudio = null
    const ctx = this.ctx
    this.ctx = null
    if (ctx) releaseInstruments(ctx)
    this.preparation = null
    if (ctx && this.ownsContext && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }
}

const SILENT_MASTER: Readonly<MasterMeterReading> = {
  peakDb: Number.NEGATIVE_INFINITY,
  rmsDb: Number.NEGATIVE_INFINITY,
  momentaryLufs: Number.NEGATIVE_INFINITY,
  integratedLufs: Number.NEGATIVE_INFINITY,
  truePeakDb: Number.NEGATIVE_INFINITY,
}
