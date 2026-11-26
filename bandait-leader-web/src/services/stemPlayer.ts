/**
 * Reproductor multipista para estudiar stems en casa (Web Audio, sin React).
 *
 * - Cada pista se decodifica una vez (decodeAudioData) y suena por su GainNode hacia un master.
 * - Todas las fuentes de un tramo arrancan con el MISMO `when` del AudioContext y el MISMO
 *   playbackRate: quedan alineadas a la muestra, sin depender de timers.
 * - La repeticion de una seccion no usa `source.loop` (cada buffer podria tener otra duracion y
 *   desalinearse): se programan tramos [inicio, fin) consecutivos en el reloj del AudioContext,
 *   cada uno empezando exactamente donde termina el anterior. Un intervalo de 100 ms solo agenda
 *   el siguiente tramo con 1 s de anticipacion; el audio nunca depende de su puntualidad.
 * - La posicion se calcula al pedirla (position()), para que la UI la pinte con rAF. Siempre es
 *   la posicion de la CANCION (segundos del audio original), a cualquier velocidad.
 *
 * Velocidad y tono (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 5):
 * - Velocidad (0,50x..1,25x): playbackRate de las fuentes. Cada tramo lleva su velocidad, asi que
 *   en un bucle con Speed Ramp cada vuelta es un tramo con la suya. Cambiar la velocidad sonando
 *   parte el tramo actual en un instante comun del AudioContext (setValueAtTime en todas las
 *   fuentes y en el procesador): las pistas siguen alineadas y no hay corte.
 * - Tono (+-6 st): el master pasa por UN AudioWorkletNode estereo (GranularPitchShifter, ver
 *   pitchShifterCore.ts) que compensa el cambio de tono de la velocidad y aplica el pedido. Su
 *   latencia es fija (~80 ms) y se descuenta en position(): la posicion es la que se oye.
 * - Sin AudioWorklet (navegador viejo o modulo que no carga) la velocidad sigue funcionando como
 *   una cinta (cambia el tono) y el tono queda deshabilitado: shifterStatus() lo dice.
 */
import { PITCH_SHIFTER_PROCESSOR_NAME, pitchShifterLatencyFrames } from './pitchShifterCore.ts'
import { clampPitch, clampSpeed, DEFAULT_SPEED_RAMP, normalizeRamp, rampSpeedForLap, type SpeedRamp } from './stemPractice.ts'
import { clampLoop, dbToGain, type LoopRegion } from './stemTiming.ts'

export interface PlayerTrackInput {
  id: string
  blob: Blob | null
}

export type TrackLoadResult = { id: string; ok: true; duration: number } | { id: string; ok: false; error: string }

export type PlayerState = 'stopped' | 'playing' | 'paused'

/** 'pending' mientras carga el worklet; 'ready' con tono real; 'unavailable' = velocidad tipo cinta, sin tono. */
export type ShifterStatus = 'pending' | 'ready' | 'unavailable'

interface TrackNode {
  buffer: AudioBuffer | null
  gain: GainNode
  volumeDb: number
  muted: boolean
  solo: boolean
}

interface Segment {
  /** Tiempo del AudioContext en que arranca el tramo. */
  ctxStart: number
  /** Posicion de la cancion (s) al inicio del tramo. */
  offset: number
  /** Duracion en segundos de CANCION (en el reloj dura length / rate). */
  length: number
  /** Velocidad (playbackRate) del tramo. */
  rate: number
  /** Vuelta del bucle (0, 1, 2...) o -1 sin bucle. */
  lap: number
  /** Fuentes que suenan en este tramo (las de un tramo partido pasan a la parte nueva). */
  sources: AudioBufferSourceNode[]
  /** Fin del tramo en el reloj del AudioContext. */
  ctxEnd: number
}

/** Lo que la UI pinta con rAF: velocidad que se oye y vuelta del Speed Ramp (null si no aplica). */
export interface PracticeStatus {
  rate: number
  lap: number | null
}

const START_DELAY = 0.06
/** Margen para que un cambio de velocidad caiga en el mismo bloque en todas las fuentes. */
const RETIME_DELAY = 0.03
const LOOKAHEAD = 1.0
const TICK_MS = 100

function segmentEnd(seg: Segment): number {
  return seg.ctxEnd
}

/**
 * Tramo con su fin en el reloj calculado una vez. Al partir un tramo, la parte que ya sono termina
 * EXACTAMENTE en el instante del corte (recalcularlo con length / rate puede pasarse por la coma
 * flotante y hacer creer que todavia suena).
 */
function makeSegment(ctxStart: number, offset: number, length: number, rate: number, lap: number, sources: AudioBufferSourceNode[], ctxEnd?: number): Segment {
  return { ctxStart, offset, length, rate, lap, sources, ctxEnd: ctxEnd ?? ctxStart + length / rate }
}

export class StemPlayer {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private shifter: AudioWorkletNode | null = null
  private shifterState: ShifterStatus = 'pending'
  private shifterReady: Promise<ShifterStatus> | null = null
  /** Latencia del procesador de tono, en segundos (0 sin el). */
  private latency = 0
  private readonly tracks = new Map<string, TrackNode>()
  private segments: Segment[] = []
  private state: PlayerState = 'stopped'
  private pausedAt = 0
  private loop: LoopRegion | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private masterDb = 0
  private speed = 1
  private semitones = 0
  private ramp: SpeedRamp = DEFAULT_SPEED_RAMP
  /** Vuelta con la que arranca el proximo play (se conserva al pausar, vuelve a 0 al parar). */
  private lapCursor = 0
  private disposed = false
  /** Invalida un play() en curso si llega pause/stop/seek mientras espera resume(). */
  private generation = 0
  private readonly listeners = new Set<(state: PlayerState) => void>()
  duration = 0

  private ensureContext(): AudioContext {
    if (this.disposed) throw new Error('disposed')
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        typeof window !== 'undefined'
          ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined
      if (!Ctor) throw new Error('Este navegador no tiene Web Audio.')
      this.ctx = new Ctor({ latencyHint: 'playback' })
      this.master = this.ctx.createGain()
      this.master.gain.value = dbToGain(this.masterDb)
      this.master.connect(this.ctx.destination)
      this.shifterReady = this.prepareShifter(this.ctx)
    }
    return this.ctx
  }

  /**
   * Carga el worklet del tono y lo intercala entre el master y la salida. Si falla, el master
   * queda directo a la salida y la velocidad funciona como cinta.
   */
  private async prepareShifter(ctx: AudioContext): Promise<ShifterStatus> {
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('sin AudioWorklet')
      const { PITCH_SHIFTER_WORKLET_URL } = await import('./pitchShifterModule.ts')
      await ctx.audioWorklet.addModule(PITCH_SHIFTER_WORKLET_URL)
      if (this.disposed || this.ctx !== ctx || !this.master) return this.shifterState
      const node = new AudioWorkletNode(ctx, PITCH_SHIFTER_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      })
      this.param(node, 'speed')?.setValueAtTime(this.speed, ctx.currentTime)
      this.param(node, 'semitones')?.setValueAtTime(this.semitones, ctx.currentTime)
      // Si ya esta sonando (play antes de que cargue), el cambio de latencia correria la posicion:
      // se intercala igual y se reinicia en la posicion actual.
      const wasPlaying = this.state === 'playing'
      const pos = this.position()
      this.master.disconnect()
      this.master.connect(node)
      node.connect(ctx.destination)
      this.shifter = node
      this.latency = pitchShifterLatencyFrames(ctx.sampleRate) / ctx.sampleRate
      this.shifterState = 'ready'
      if (wasPlaying) this.restartAt(pos)
    } catch {
      if (!this.disposed) this.shifterState = 'unavailable'
    }
    return this.shifterState
  }

  private param(node: AudioWorkletNode | null, name: string): AudioParam | null {
    return node ? (node.parameters as unknown as Map<string, AudioParam>).get(name) ?? null : null
  }

  /** Estado del procesador de tono. */
  shifterStatus(): ShifterStatus {
    return this.shifterState
  }

  /** Resuelve cuando se sabe si hay tono real ('ready') o no ('unavailable'). */
  whenShifterSettled(): Promise<ShifterStatus> {
    try {
      this.ensureContext()
    } catch {
      return Promise.resolve('unavailable')
    }
    return this.shifterReady ?? Promise.resolve(this.shifterState)
  }

  onStateChange(listener: (state: PlayerState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private setState(state: PlayerState) {
    if (this.state === state) return
    this.state = state
    for (const l of this.listeners) l(state)
  }

  getState(): PlayerState {
    return this.state
  }

  /**
   * Decodifica las pistas una por una (asi el pico de memoria es un archivo a la vez). Un archivo
   * que falla no detiene a los demas: su resultado trae el error para mostrarlo en esa pista.
   */
  async load(inputs: PlayerTrackInput[], onTrack?: (result: TrackLoadResult) => void): Promise<TrackLoadResult[]> {
    const ctx = this.ensureContext()
    const results: TrackLoadResult[] = []
    for (const input of inputs) {
      let result: TrackLoadResult
      if (!input.blob) {
        result = { id: input.id, ok: false, error: 'Falta el archivo en el almacenamiento local.' }
      } else {
        try {
          const data = await input.blob.arrayBuffer()
          if (this.disposed) return results
          const buffer = await ctx.decodeAudioData(data)
          if (this.disposed) return results
          this.attachTrack(input.id, buffer)
          result = { id: input.id, ok: true, duration: buffer.duration }
        } catch {
          if (this.disposed) return results
          result = {
            id: input.id,
            ok: false,
            error: 'No se pudo decodificar: archivo dañado o formato que este navegador no reproduce.',
          }
        }
      }
      results.push(result)
      onTrack?.(result)
    }
    this.duration = Math.max(0, ...[...this.tracks.values()].map((t) => t.buffer?.duration ?? 0))
    // El procesador de tono queda listo antes de poder reproducir (su latencia entra en la posicion).
    if (this.shifterReady) await this.shifterReady
    return results
  }

  private attachTrack(id: string, buffer: AudioBuffer) {
    const ctx = this.ensureContext()
    const old = this.tracks.get(id)
    if (old) old.gain.disconnect()
    const gain = ctx.createGain()
    gain.connect(this.master as GainNode)
    this.tracks.set(id, { buffer, gain, volumeDb: old?.volumeDb ?? 0, muted: old?.muted ?? false, solo: old?.solo ?? false })
    this.applyGains()
  }

  hasAudio(): boolean {
    return this.duration > 0
  }

  // ---- mezcla ----

  setTrackVolume(id: string, db: number) {
    const t = this.tracks.get(id)
    if (!t) return
    t.volumeDb = db
    this.applyGains()
  }

  setTrackMute(id: string, muted: boolean) {
    const t = this.tracks.get(id)
    if (!t) return
    t.muted = muted
    this.applyGains()
  }

  setTrackSolo(id: string, solo: boolean) {
    const t = this.tracks.get(id)
    if (!t) return
    t.solo = solo
    this.applyGains()
  }

  setMasterVolume(db: number) {
    this.masterDb = db
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(dbToGain(db), this.ctx.currentTime, 0.015)
  }

  private applyGains() {
    if (!this.ctx) return
    const anySolo = [...this.tracks.values()].some((t) => t.solo)
    const now = this.ctx.currentTime
    for (const t of this.tracks.values()) {
      const audible = !t.muted && (!anySolo || t.solo)
      // Rampa corta: cambiar la ganancia de golpe produce un clic audible.
      t.gain.gain.setTargetAtTime(audible ? dbToGain(t.volumeDb) : 0, now, 0.015)
    }
  }

  // ---- velocidad, tono y Speed Ramp ----

  getSpeed(): number {
    return this.speed
  }

  getPitch(): number {
    return this.semitones
  }

  getSpeedRamp(): SpeedRamp {
    return this.ramp
  }

  /** El Speed Ramp manda: esta encendido y hay un bucle. */
  rampActive(): boolean {
    return this.ramp.enabled && this.loop !== null
  }

  /** Velocidad base (0,50x..1,25x). Con el Speed Ramp activo se guarda y aplica al apagarlo. */
  setSpeed(speed: number) {
    const next = clampSpeed(speed)
    if (next === this.speed) return
    this.speed = next
    if (this.state === 'playing' && !this.rampActive()) this.retime(next)
  }

  /** Tono en semitonos (+-6). Sin worklet se guarda pero no suena. */
  setPitch(semitones: number) {
    const next = clampPitch(semitones)
    if (next === this.semitones) return
    this.semitones = next
    const p = this.param(this.shifter, 'semitones')
    if (p && this.ctx) {
      p.cancelScheduledValues(this.ctx.currentTime)
      p.setValueAtTime(next, this.ctx.currentTime)
    }
  }

  /** Configura el Speed Ramp. Cambiarlo sonando vuelve a la primera vuelta. */
  setSpeedRamp(ramp: SpeedRamp) {
    const next = normalizeRamp(ramp)
    const prev = this.ramp
    if (next.enabled === prev.enabled && next.start === prev.start && next.step === prev.step && next.top === prev.top) return
    this.ramp = next
    this.lapCursor = 0
    if (this.state === 'playing' && this.loop) this.restartAt(this.position(), false)
  }

  /** Velocidad que se oye y vuelta del Speed Ramp (para pintar con rAF; no asigna estado React). */
  practiceStatus(): PracticeStatus {
    const seg = this.state === 'playing' ? this.heardSegment() : null
    if (seg) return { rate: seg.rate, lap: this.rampActive() && seg.lap >= 0 ? seg.lap : null }
    if (this.rampActive()) return { rate: rampSpeedForLap(this.ramp, this.lapCursor), lap: this.lapCursor }
    return { rate: this.speed, lap: null }
  }

  // ---- transporte ----

  /** Tramo que se oye ahora (descontada la latencia del procesador). */
  private heardSegment(): Segment | null {
    if (!this.ctx || this.segments.length === 0) return null
    const t = this.ctx.currentTime - this.latency
    let seg = this.segments[0]
    for (const s of this.segments) {
      if (s.ctxStart <= t) seg = s
      else break
    }
    return seg
  }

  position(): number {
    if (this.state !== 'playing' || !this.ctx || this.segments.length === 0) return this.pausedAt
    const seg = this.heardSegment() as Segment
    const t = this.ctx.currentTime - this.latency
    const elapsed = Math.min(Math.max(0, (t - seg.ctxStart) * seg.rate), seg.length)
    return seg.offset + elapsed
  }

  getLoop(): LoopRegion | null {
    return this.loop
  }

  /** Region a repetir (null = sin repeticion). Se recorta a la duracion del audio. */
  setLoop(region: LoopRegion | null) {
    this.loop = region ? clampLoop(region, this.duration) : null
    this.lapCursor = 0
    const pos = this.position()
    const target = this.loop && (pos < this.loop.start || pos >= this.loop.end) ? this.loop.start : pos
    if (this.state === 'playing') this.restartAt(target, false)
    else this.pausedAt = target
  }

  async play(): Promise<void> {
    if (this.disposed || this.state === 'playing' || !this.hasAudio()) return
    const ctx = this.ensureContext()
    const gen = ++this.generation
    if (ctx.state !== 'running') {
      try {
        await ctx.resume()
      } catch {
        return
      }
    }
    if (this.shifterReady) await this.shifterReady
    if (gen !== this.generation || this.disposed) return
    let from = this.pausedAt
    if (from >= this.duration - 0.01) from = 0
    this.startAt(from)
  }

  pause() {
    if (this.state !== 'playing') {
      this.generation++
      return
    }
    const seg = this.heardSegment()
    if (seg && seg.lap >= 0) this.lapCursor = seg.lap
    this.pausedAt = this.position()
    this.halt()
    this.setState('paused')
  }

  stop() {
    this.halt()
    this.lapCursor = 0
    this.pausedAt = this.loop ? this.loop.start : 0
    this.setState('stopped')
  }

  seek(sec: number) {
    const target = Math.min(Math.max(0, Number.isFinite(sec) ? sec : 0), this.duration)
    if (this.state === 'playing') this.restartAt(target)
    else this.pausedAt = target
  }

  /** `keepLap` = seguir en la vuelta que suena (salto, carga del worklet); false = primera vuelta. */
  private restartAt(pos: number, keepLap = true) {
    const seg = this.heardSegment()
    if (keepLap && seg && seg.lap >= 0) this.lapCursor = seg.lap
    this.halt()
    this.startAt(pos)
  }

  private startAt(from: number) {
    const ctx = this.ctx
    if (!ctx) return
    const when = ctx.currentTime + START_DELAY
    this.segments = []
    const loop = this.loop
    if (loop) {
      const offset = from >= loop.start && from < loop.end ? from : loop.start
      this.schedule(when, offset, loop.end - offset, this.lapCursor)
    } else {
      this.schedule(when, from, Math.max(0, this.duration - from), -1)
    }
    this.pausedAt = from
    this.setState('playing')
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  /** Velocidad de un tramo nuevo: la de su vuelta con Speed Ramp, o la base. */
  private rateFor(lap: number): number {
    return lap >= 0 && this.ramp.enabled ? rampSpeedForLap(this.ramp, lap) : this.speed
  }

  private schedule(when: number, offset: number, length: number, lap: number): Segment | null {
    const ctx = this.ctx
    if (!ctx || length <= 0) return null
    const rate = this.rateFor(lap)
    const sources: AudioBufferSourceNode[] = []
    for (const t of this.tracks.values()) {
      if (!t.buffer || offset >= t.buffer.duration) continue
      const src = ctx.createBufferSource()
      src.buffer = t.buffer
      src.playbackRate.value = rate
      src.connect(t.gain)
      src.onended = () => {
        src.disconnect()
      }
      // `duration` va en segundos de buffer (no depende del playbackRate).
      src.start(when, offset, Math.min(length, t.buffer.duration - offset))
      sources.push(src)
    }
    this.param(this.shifter, 'speed')?.setValueAtTime(rate, when)
    const seg = makeSegment(when, offset, length, rate, lap, sources)
    this.segments.push(seg)
    return seg
  }

  /**
   * Cambia la velocidad sonando: en un instante comun `tc` todas las fuentes y el procesador pasan
   * a la nueva; el tramo actual se parte ahi y los tramos futuros se vuelven a programar.
   */
  private retime(rate: number) {
    const ctx = this.ctx
    if (!ctx || this.segments.length === 0) return
    const tc = ctx.currentTime + RETIME_DELAY
    const keep: Segment[] = []
    // Ya hay un tramo que suena en `tc` (partido o reprogramado): los posteriores se descartan y
    // tick() los vuelve a programar desde su nuevo final.
    let live = false
    for (const seg of this.segments) {
      if (seg.ctxStart >= tc) {
        if (live) {
          this.stopSources(seg.sources)
          continue
        }
        // Todavia no arranca (play o un cambio anterior hace menos de RETIME_DELAY): conserva su
        // inicio y solo cambia de velocidad.
        for (const src of seg.sources) src.playbackRate.value = rate
        keep.push(makeSegment(seg.ctxStart, seg.offset, seg.length, rate, seg.lap, seg.sources))
        live = true
        continue
      }
      if (segmentEnd(seg) <= tc) {
        keep.push(seg)
        continue
      }
      const posAtTc = seg.offset + (tc - seg.ctxStart) * seg.rate
      for (const src of seg.sources) src.playbackRate.setValueAtTime(rate, tc)
      keep.push(makeSegment(seg.ctxStart, seg.offset, posAtTc - seg.offset, seg.rate, seg.lap, [], tc))
      keep.push(makeSegment(tc, posAtTc, seg.offset + seg.length - posAtTc, rate, seg.lap, seg.sources))
      live = true
    }
    const speedParam = this.param(this.shifter, 'speed')
    if (speedParam) {
      speedParam.cancelScheduledValues(tc)
      speedParam.setValueAtTime(rate, tc)
    }
    this.segments = keep
    this.tick()
  }

  private tick() {
    const ctx = this.ctx
    if (!ctx || this.state !== 'playing' || this.segments.length === 0) return
    const now = ctx.currentTime
    const heard = now - this.latency
    const last = this.segments[this.segments.length - 1]
    const lastEnd = segmentEnd(last)
    const loop = this.loop
    if (loop) {
      const len = loop.end - loop.start
      let end = lastEnd
      let lap = Math.max(0, last.lap)
      while (end - now < LOOKAHEAD) {
        lap++
        const seg = this.schedule(end, loop.start, len, lap)
        if (!seg) break
        end = segmentEnd(seg)
      }
    } else if (heard >= lastEnd) {
      this.halt()
      this.pausedAt = 0
      this.setState('stopped')
      return
    }
    // Olvidar los tramos que ya se oyeron enteros (position() solo mira el actual).
    while (this.segments.length > 1 && this.segments[1].ctxStart <= heard) this.segments.shift()
  }

  private stopSources(sources: AudioBufferSourceNode[]) {
    for (const src of sources) {
      src.onended = null
      try {
        src.stop()
      } catch {
        // ya detenida
      }
      src.disconnect()
    }
  }

  private halt() {
    this.generation++
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const seg of this.segments) this.stopSources(seg.sources)
    this.segments = []
    if (this.shifter && this.ctx) {
      // Lo que queda en la linea de retardo del procesador es audio viejo: se desvanece y vacia.
      this.shifter.port.postMessage('flush')
      const speedParam = this.param(this.shifter, 'speed')
      if (speedParam) {
        speedParam.cancelScheduledValues(this.ctx.currentTime)
        speedParam.setValueAtTime(this.speed, this.ctx.currentTime)
      }
    }
  }

  /** Detiene todo, desconecta los nodos y cierra el AudioContext. El objeto queda inutilizable. */
  dispose() {
    if (this.disposed) return
    this.halt()
    this.disposed = true
    for (const t of this.tracks.values()) {
      t.gain.disconnect()
      t.buffer = null
    }
    this.tracks.clear()
    this.master?.disconnect()
    this.master = null
    if (this.shifter) {
      this.shifter.port.postMessage('dispose')
      this.shifter.disconnect()
      this.shifter = null
    }
    this.listeners.clear()
    const ctx = this.ctx
    this.ctx = null
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }
}
