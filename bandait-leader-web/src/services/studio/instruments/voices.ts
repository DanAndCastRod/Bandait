/**
 * Voces y polifonia de los instrumentos propios (synth, drums, sampler).
 *
 * Una voz es una nota viva: sus fuentes (osciladores, ruido, muestras), su cadena y, al final,
 * una ganancia de apagado (`killGain`) que solo se toca para robar la voz, cortarla (detener,
 * hi-hat cerrado) o apagarla al terminar la relajacion. Asi nunca hay que cancelar la
 * automatizacion de la envolvente: el apagado es una rampa lineal de 5 ms
 * (STUDIO_VOICE_STEAL_RAMP_S) en una etapa propia, y las fuentes se detienen al terminarla.
 *
 * El pool lleva las voces en tiempo del contexto, no en "ahora": las notas se programan con
 * anticipacion (o todas de una vez en offline), asi que "cuantas voces suenan" se pregunta para el
 * instante en que empieza la nota nueva. Con las mismas notas en el mismo orden, el robo es el
 * mismo en tiempo real y al exportar (determinista).
 */
import { setParam } from '../fx.ts'
import { STUDIO_INSTRUMENT_POLYPHONY, STUDIO_VOICE_STEAL_RAMP_S, type StudioInstrument, type StudioInstrumentType } from '../session.ts'
import type { StudioInstrumentNode } from '../types.ts'
import { dbToGain } from '../../stemTiming.ts'
import { pickVoiceToSteal } from './core.ts'
import type { VoiceMusicalPosition } from './analogDrift.ts'

function disconnect(node: AudioNode): void {
  try {
    node.disconnect()
  } catch {
    // ya desconectado
  }
}

export interface VoiceInit {
  pitch: number
  velocity: number
  startedAt: number
  owner: object | null
  /** true si viene de noteOn (sin fin conocido hasta noteOff). */
  live: boolean
  /** Posicion musical de una nota de clip (semilla de analog_drift); ausente en vivo. */
  musical?: VoiceMusicalPosition | null
}

/**
 * Esqueleto de una voz. Quien la arma conecta su cadena a `killGain`, agrega sus fuentes con
 * `addSource` (ya arrancadas) y fija `onRelease`.
 */
export class Voice {
  readonly pitch: number
  readonly velocity: number
  readonly startedAt: number
  readonly owner: object | null
  readonly live: boolean
  /**
   * Posicion musical (nota de un clip): semilla determinista de la deriva analogica, igual al
   * escuchar y al exportar. null en vivo: la deriva usa la hora del contexto.
   */
  readonly musical: VoiceMusicalPosition | null
  /** Note-off programado; null = sigue sostenida. */
  releaseAt: number | null = null
  /** Apagado programado (inicio de la rampa); Infinity = ninguno. */
  killAt = Number.POSITIVE_INFINITY
  /** Instante en que la voz deja de sonar. Infinity mientras este sostenida sin fin. */
  endsAt = Number.POSITIVE_INFINITY
  readonly killGain: GainNode
  /**
   * Programa la relajacion desde `when` y devuelve el instante en que queda en silencio. Por
   * defecto, silencio inmediato (la rampa de apagado).
   */
  onRelease: (when: number) => number = (when) => when
  private readonly sources: AudioScheduledSourceNode[] = []
  private readonly nodes: AudioNode[] = []
  private ended = 0
  private disposed = false

  constructor(ctx: BaseAudioContext, destination: AudioNode, init: VoiceInit) {
    this.pitch = init.pitch
    this.velocity = init.velocity
    this.startedAt = init.startedAt
    this.owner = init.owner
    this.live = init.live
    this.musical = init.musical ?? null
    this.killGain = ctx.createGain()
    this.killGain.gain.value = 1
    this.killGain.connect(destination)
  }

  /** Nodo de la cadena, para desconectarlo al final. */
  addNode(node: AudioNode): void {
    this.nodes.push(node)
  }

  /** Fuente ya arrancada. La voz se libera cuando terminan todas. */
  addSource(source: AudioScheduledSourceNode): void {
    this.sources.push(source)
    this.nodes.push(source)
    source.onended = () => {
      this.ended++
      if (this.ended >= this.sources.length) this.dispose()
    }
  }

  get hasSources(): boolean {
    return this.sources.length > 0
  }

  /** Note-off en `when`: relajacion y, al terminarla, apagado. Una sola vez. */
  release(when: number): void {
    if (this.disposed || this.releaseAt !== null) return
    const at = Math.max(when, this.startedAt)
    this.releaseAt = at
    const silentAt = this.onRelease(at)
    this.kill(Number.isFinite(silentAt) ? Math.max(at, silentAt) : at)
  }

  /**
   * Apaga la voz con la rampa de 5 ms que empieza en `at`. Si ya habia un apagado antes, no hace
   * nada; si el que habia era posterior, lo adelanta. Antes de que la voz empiece, la deja muda.
   */
  kill(at: number): void {
    if (this.disposed || !(at < this.killAt)) return
    const param = this.killGain.gain
    // Las unicas automatizaciones de killGain son apagados, todos posteriores a `at`.
    if (Number.isFinite(this.killAt)) param.cancelScheduledValues(at)
    param.setValueAtTime(1, at)
    param.linearRampToValueAtTime(0, at + STUDIO_VOICE_STEAL_RAMP_S)
    this.killAt = at
    this.endsAt = Math.min(this.endsAt, at + STUDIO_VOICE_STEAL_RAMP_S)
    const stopAt = at + STUDIO_VOICE_STEAL_RAMP_S + 0.001
    for (const source of this.sources) {
      try {
        // La ultima llamada a stop() es la que vale; antes del inicio, la fuente no suena.
        source.stop(stopAt)
      } catch {
        // ya detenida
      }
    }
  }

  /** true si la voz suena (o va a sonar) en el instante `t` y no esta apagada. */
  soundingAt(t: number): boolean {
    return this.startedAt <= t && this.endsAt > t && this.killAt > t
  }

  /** Desconecta ya. Idempotente. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // ya detenida
      }
    }
    for (const node of this.nodes) disconnect(node)
    disconnect(this.killGain)
  }
}

/** Voces de un instrumento, con el robo de STUDIO_V2.md 2.3. */
export class VoicePool {
  readonly polyphony: number
  voices: Voice[] = []
  private latestStart = Number.NEGATIVE_INFINITY

  constructor(polyphony: number = STUDIO_INSTRUMENT_POLYPHONY) {
    this.polyphony = Math.max(1, Math.floor(polyphony))
  }

  /**
   * Hace lugar para una nota que empieza en `at`: olvida las voces que ya terminaron y, si las que
   * suenan en `at` llegan al tope, roba las que hagan falta (apagado en `at`).
   */
  makeRoom(at: number, now: number): void {
    // Las notas llegan casi siempre en orden: si `at` no retrocede, lo terminado antes de `at` ya
    // no puede afectar a ninguna nota futura. Si retrocede (tocar en vivo), se poda por `now`.
    const horizon = at >= this.latestStart ? at : now
    this.latestStart = Math.max(this.latestStart, at)
    if (this.voices.some((v) => v.endsAt <= horizon)) this.voices = this.voices.filter((v) => v.endsAt > horizon)
    const active = this.voices.filter((v) => v.soundingAt(at))
    while (active.length >= this.polyphony) {
      const index = pickVoiceToSteal(
        active.map((v) => ({ startedAt: v.startedAt, releasedAt: v.releaseAt !== null && v.releaseAt <= at ? v.releaseAt : null, velocity: v.velocity })),
      )
      if (index < 0) break
      active[index].kill(at)
      active.splice(index, 1)
    }
  }

  add(voice: Voice): void {
    this.voices.push(voice)
  }

  /** Voces que suenan en `t`. */
  countAt(t: number): number {
    let n = 0
    for (const v of this.voices) if (v.soundingAt(t)) n++
    return n
  }

  /** Apaga en `at` todas las voces (o las de `owner`) que siguen sonando o todavia no empezaron. */
  killAll(at: number, owner?: object): void {
    for (const v of this.voices) {
      if (owner !== undefined && v.owner !== owner) continue
      if (v.endsAt > at) v.kill(at)
    }
  }

  /** Libera ya las voces de `owner` (o todas). */
  disposeAll(owner?: object): void {
    const keep: Voice[] = []
    for (const v of this.voices) {
      if (owner !== undefined && v.owner !== owner) keep.push(v)
      else v.dispose()
    }
    this.voices = keep
  }
}

/** Lo que cada tipo de instrumento propio aporta a PolyInstrument. */
export interface VoiceEngine {
  readonly type: Exclude<StudioInstrumentType, 'wam'>
  /** gain_db actual del instrumento. */
  gainDb(): number
  /**
   * Crea y programa una voz que empieza en `start`. `end` null = sostenida hasta noteOff. Debe
   * conectar su cadena a `voice.killGain` y registrar sus fuentes. Devuelve false si la nota no
   * suena (caja: nota fuera del mapa GM; sampler: ninguna zona; synth: todos los niveles en 0).
   */
  build(voice: Voice, start: number, end: number | null): boolean
  /** true si una nota nueva de `pitch` corta a una voz que suena con `otherPitch` (caja de ritmos). */
  chokes?(pitch: number, otherPitch: number): boolean
  /** Parametros nuevos del mismo tipo; false si no se pueden aplicar (otro tipo). */
  update(instrument: StudioInstrument): boolean
}

/**
 * Instrumento polifonico propio: salida con gain_db, 32 voces con robo, notas por pitch. Ademas
 * de StudioInstrumentNode ofrece `playNoteOwned`/`stopOwner`/`disposeOwner`, que usa
 * scheduleMidiClips para detener solo las notas de una tanda (reprogramar sin cortar las demas).
 */
export class PolyInstrument implements StudioInstrumentNode {
  readonly type: StudioInstrumentType
  readonly output: GainNode
  readonly polyphony: number
  private readonly ctx: BaseAudioContext
  private readonly engine: VoiceEngine
  private readonly pool: VoicePool
  private disposed = false

  constructor(ctx: BaseAudioContext, engine: VoiceEngine, polyphony: number = STUDIO_INSTRUMENT_POLYPHONY) {
    this.ctx = ctx
    this.engine = engine
    this.type = engine.type
    this.pool = new VoicePool(polyphony)
    this.polyphony = this.pool.polyphony
    this.output = ctx.createGain()
    this.output.gain.value = dbToGain(engine.gainDb())
  }

  noteOn(pitch: number, velocity: number, when: number): void {
    this.start(pitch, velocity, when, null, null)
  }

  noteOff(pitch: number, when: number): void {
    if (this.disposed) return
    const at = Math.max(when, this.ctx.currentTime)
    let oldest: Voice | null = null
    for (const v of this.pool.voices) {
      // Una voz robada o ya apagada no cuenta; una con sustain 0 (apagado programado) si.
      if (!v.live || v.pitch !== pitch || v.releaseAt !== null || v.killAt <= at) continue
      if (!oldest || v.startedAt < oldest.startedAt) oldest = v
    }
    oldest?.release(at)
  }

  playNote(pitch: number, velocity: number, startTime: number, endTime: number): void {
    this.start(pitch, velocity, startTime, endTime, null)
  }

  /**
   * playNote marcada con una tanda (`owner`), para detenerla aparte. `musical`: posicion de la nota
   * en la sesion, para que la deriva analogica sea la misma en vivo y en el export.
   */
  playNoteOwned(pitch: number, velocity: number, startTime: number, endTime: number, owner: object, musical?: VoiceMusicalPosition | null): void {
    this.start(pitch, velocity, startTime, endTime, owner, musical ?? null)
  }

  /** Apaga en `when` las notas de la tanda que suenan o todavia no empezaron. */
  stopOwner(owner: object, when: number): void {
    if (this.disposed) return
    this.pool.killAll(Math.max(when, this.ctx.currentTime), owner)
  }

  /** Libera ya las notas de la tanda. */
  disposeOwner(owner: object): void {
    if (this.disposed) return
    this.pool.disposeAll(owner)
  }

  allNotesOff(when?: number): void {
    if (this.disposed) return
    this.pool.killAll(Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime))
  }

  update(instrument: StudioInstrument): boolean {
    if (this.disposed || instrument.type !== this.type) return false
    if (!this.engine.update(instrument)) return false
    setParam(this.ctx, this.output.gain, dbToGain(this.engine.gainDb()), false)
    return true
  }

  activeVoices(): number {
    return this.pool.countAt(this.ctx.currentTime)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pool.disposeAll()
    disconnect(this.output)
  }

  private start(pitch: number, velocity: number, startTime: number, endTime: number | null, owner: object | null, musical: VoiceMusicalPosition | null = null): void {
    if (this.disposed || !Number.isFinite(startTime)) return
    const p = Math.round(pitch)
    if (!(p >= 0 && p <= 127)) return
    const vel = Math.max(1, Math.min(127, Math.round(Number.isFinite(velocity) ? velocity : 100)))
    const now = this.ctx.currentTime
    const start = Math.max(startTime, now)
    if (endTime !== null && !(endTime > start)) return
    if (this.engine.chokes) {
      for (const v of this.pool.voices) if (v.soundingAt(start) && this.engine.chokes(p, v.pitch)) v.kill(start)
    }
    this.pool.makeRoom(start, now)
    const voice = new Voice(this.ctx, this.output, { pitch: p, velocity: vel, startedAt: start, owner, live: endTime === null, musical })
    if (!this.engine.build(voice, start, endTime) || !voice.hasSources) {
      voice.dispose()
      return
    }
    this.pool.add(voice)
    if (endTime !== null) voice.release(endTime)
  }
}
