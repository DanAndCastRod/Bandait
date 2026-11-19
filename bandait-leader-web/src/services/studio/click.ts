/**
 * Metronomo del Estudio. Se programa en el reloj del AudioContext con anticipacion, desde el BPM
 * y el compas de la sesion (el compas 1 empieza en el segundo 0), igual que el clic del follower.
 *
 * Su salida va DIRECTO a `ctx.destination`: no pasa por el master, no lo mide el medidor y no
 * entra en bounce (bounce construye el grafo sin este modulo). Solo pasa por un retardo igual al
 * del grafo de mezcla, para sonar alineado con las pistas.
 *
 * La primera parte es logica pura (que golpes caen en una ventana de tiempo); la clase
 * `StudioClick` solo convierte esos golpes en sonido. El motor (engine.ts) decide las ventanas.
 */
import { dbToGain } from '../stemTiming.ts'

// ---------------------------------------------------------------------------
// Logica pura
// ---------------------------------------------------------------------------

/** Tolerancia, en golpes, para que un golpe en el borde exacto de una ventana no se pierda por redondeo. */
const BEAT_EPSILON = 1e-9

export function beatSeconds(bpm: number): number {
  return bpm > 0 ? 60 / bpm : 0
}

/** Lo que dura el conteo previo. `bars` se acota a 0..4 compases enteros. */
export function countInSeconds(bpm: number, beatsPerBar: number, bars: number): number {
  return countInBeats(beatsPerBar, bars) * beatSeconds(bpm)
}

function countInBeats(beatsPerBar: number, bars: number): number {
  const wholeBars = Math.max(0, Math.min(4, Math.floor(Number.isFinite(bars) ? bars : 0)))
  const perBar = Math.max(1, Math.floor(Number.isFinite(beatsPerBar) ? beatsPerBar : 4))
  return wholeBars * perBar
}

/** Golpe en tiempo de sesion. */
export interface ClickBeat {
  timeS: number
  /** Numero de golpe desde el segundo 0 (0 = primer tiempo del compas 1). */
  index: number
  /** true en el primer tiempo de cada compas. */
  accent: boolean
}

/** Primer golpe cuyo tiempo es >= `timeS` (el mismo calculo para los dos bordes de una ventana). */
function beatCeil(timeS: number, beat: number): number {
  return Math.max(0, Math.ceil(timeS / beat - BEAT_EPSILON))
}

/** Golpes de la sesion en [fromS, toS). Ventanas contiguas no repiten ni se saltan ninguno. */
export function beatsInRange(bpm: number, beatsPerBar: number, fromS: number, toS: number): ClickBeat[] {
  const beat = beatSeconds(bpm)
  const beats: ClickBeat[] = []
  if (!(beat > 0) || !(toS > fromS)) return beats
  const perBar = Math.max(1, Math.floor(beatsPerBar))
  const end = beatCeil(toS, beat)
  for (let index = beatCeil(fromS, beat); index < end; index++) {
    beats.push({ timeS: index * beat, index, accent: index % perBar === 0 })
  }
  return beats
}

/** Tramo de reproduccion: la posicion `offsetS` de la sesion suena en `ctxStart` y dura `lengthS`. */
export interface ClickSegment {
  ctxStart: number
  offsetS: number
  lengthS: number
}

export interface ClickWindow {
  /** Ventana en tiempo del AudioContext: [windowStart, windowEnd). */
  windowStart: number
  windowEnd: number
  bpm: number
  beatsPerBar: number
  /** Clic durante la reproduccion. El conteo previo suena aunque sea false. */
  enabled: boolean
  segments: readonly ClickSegment[]
  /** Conteo previo: termina en `endCtx` (donde arranca la reproduccion) y dura `bars` compases. */
  countIn: { endCtx: number; bars: number } | null
}

/** Golpe listo para sonar, en tiempo del AudioContext. */
export interface ClickEvent {
  ctxTime: number
  accent: boolean
}

/**
 * Golpes que caen en una ventana del reloj del contexto: los del conteo previo (hacia atras desde
 * el arranque, con acento al empezar cada compas de conteo) y, si el clic esta encendido, los de
 * cada tramo de reproduccion. Llamar con ventanas contiguas da cada golpe exactamente una vez.
 */
export function clickEventsInWindow(input: ClickWindow): ClickEvent[] {
  const events: ClickEvent[] = []
  const beat = beatSeconds(input.bpm)
  if (!(beat > 0) || !(input.windowEnd > input.windowStart)) return events
  const perBar = Math.max(1, Math.floor(input.beatsPerBar))
  if (input.countIn) {
    const total = countInBeats(perBar, input.countIn.bars)
    for (let i = 0; i < total; i++) {
      const ctxTime = input.countIn.endCtx - (total - i) * beat
      if (ctxTime >= input.windowStart && ctxTime < input.windowEnd) events.push({ ctxTime, accent: i % perBar === 0 })
    }
  }
  if (input.enabled) {
    for (const segment of input.segments) {
      const from = Math.max(input.windowStart, segment.ctxStart)
      const to = Math.min(input.windowEnd, segment.ctxStart + segment.lengthS)
      if (!(to > from)) continue
      const base = segment.offsetS - segment.ctxStart
      for (const b of beatsInRange(input.bpm, perBar, base + from, base + to)) {
        events.push({ ctxTime: b.timeS - base, accent: b.accent })
      }
    }
  }
  events.sort((a, b) => a.ctxTime - b.ctxTime)
  return events
}

// ---------------------------------------------------------------------------
// Sonido
// ---------------------------------------------------------------------------

const ACCENT_HZ = 1568
const BEAT_HZ = 1046.5
const CLICK_SECONDS = 0.045
/** Un golpe que llega con mas retraso que esto no se toca: sonaria fuera de tiempo. */
const LATE_TOLERANCE_S = 0.005
/** Tope del retardo del clic: muy por encima del retardo de cualquier cadena de efectos del Estudio. */
const MAX_CLICK_DELAY_S = 0.5

export class StudioClick {
  private readonly ctx: AudioContext
  private readonly output: GainNode
  private readonly voices = new Set<{ osc: OscillatorNode; gain: GainNode; at: number }>()
  private disposed = false

  /** Retrasa el clic lo mismo que el grafo retrasa la mezcla (ver setDelayS). */
  private readonly delay: DelayNode

  constructor(ctx: AudioContext, volumeDb: number) {
    this.ctx = ctx
    this.output = ctx.createGain()
    this.output.gain.value = dbToGain(volumeDb)
    this.delay = ctx.createDelay(MAX_CLICK_DELAY_S)
    this.delay.delayTime.value = 0
    // Directo a la salida: fuera del master y de la mezcla exportada.
    this.output.connect(this.delay)
    this.delay.connect(ctx.destination)
  }

  /**
   * Retardo del grafo de mezcla (limitador y compresores con anticipacion). El clic no pasa por
   * ese grafo: sin este retardo sonaria unos milisegundos ANTES que las pistas, y quien graba
   * contra el clic quedaria corrido respecto a la base.
   */
  setDelayS(seconds: number): void {
    if (this.disposed) return
    const value = Number.isFinite(seconds) ? Math.max(0, Math.min(MAX_CLICK_DELAY_S, seconds)) : 0
    this.delay.delayTime.setValueAtTime(value, this.ctx.currentTime)
  }

  setVolumeDb(volumeDb: number): void {
    if (this.disposed) return
    this.output.gain.setTargetAtTime(dbToGain(volumeDb), this.ctx.currentTime, 0.015)
  }

  /** Programa los golpes. Los que ya pasaron se descartan. */
  schedule(events: readonly ClickEvent[]): void {
    if (this.disposed) return
    const now = this.ctx.currentTime
    for (const event of events) {
      if (event.ctxTime < now - LATE_TOLERANCE_S) continue
      const at = Math.max(event.ctxTime, now)
      const osc = this.ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.value = event.accent ? ACCENT_HZ : BEAT_HZ
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(event.accent ? 1 : 0.7, at + 0.001)
      gain.gain.exponentialRampToValueAtTime(0.001, at + CLICK_SECONDS)
      osc.connect(gain)
      gain.connect(this.output)
      const voice = { osc, gain, at }
      osc.onended = () => {
        this.voices.delete(voice)
        osc.disconnect()
        gain.disconnect()
      }
      osc.start(at)
      osc.stop(at + CLICK_SECONDS + 0.005)
      this.voices.add(voice)
    }
  }

  /**
   * Quita los golpes programados que todavia no empezaron (desde `fromCtxTime`, por defecto
   * ahora). El que ya esta sonando termina solo: son 45 ms.
   */
  cancel(fromCtxTime?: number): void {
    const from = fromCtxTime ?? this.ctx.currentTime
    for (const voice of [...this.voices]) {
      if (voice.at < from) continue
      this.voices.delete(voice)
      voice.osc.onended = null
      try {
        voice.osc.stop()
      } catch {
        // ya detenido
      }
      voice.osc.disconnect()
      voice.gain.disconnect()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.cancel(Number.NEGATIVE_INFINITY)
    this.disposed = true
    this.output.disconnect()
    this.delay.disconnect()
  }
}
