/**
 * Reproductor multipista para estudiar stems en casa (Web Audio, sin React).
 *
 * - Cada pista se decodifica una vez (decodeAudioData) y suena por su GainNode hacia un master.
 * - Todas las fuentes de un tramo arrancan con el MISMO `when` del AudioContext: quedan alineadas
 *   a la muestra, sin depender de timers.
 * - La repeticion de una seccion no usa `source.loop` (cada buffer podria tener otra duracion y
 *   desalinearse): se programan tramos [inicio, fin) consecutivos en el reloj del AudioContext,
 *   cada uno empezando exactamente donde termina el anterior. Un intervalo de 100 ms solo agenda
 *   el siguiente tramo con 1 s de anticipacion; el audio nunca depende de su puntualidad.
 * - La posicion se calcula al pedirla (position()), para que la UI la pinte con rAF.
 */
import { clampLoop, dbToGain, type LoopRegion } from './stemTiming'

export interface PlayerTrackInput {
  id: string
  blob: Blob | null
}

export type TrackLoadResult = { id: string; ok: true; duration: number } | { id: string; ok: false; error: string }

export type PlayerState = 'stopped' | 'playing' | 'paused'

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
  length: number
}

const START_DELAY = 0.06
const LOOKAHEAD = 1.0
const TICK_MS = 100

export class StemPlayer {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private readonly tracks = new Map<string, TrackNode>()
  private readonly sources = new Set<AudioBufferSourceNode>()
  private segments: Segment[] = []
  private state: PlayerState = 'stopped'
  private pausedAt = 0
  private loop: LoopRegion | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private masterDb = 0
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
    }
    return this.ctx
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

  // ---- transporte ----

  position(): number {
    if (this.state !== 'playing' || !this.ctx || this.segments.length === 0) return this.pausedAt
    const now = this.ctx.currentTime
    let seg = this.segments[0]
    for (const s of this.segments) {
      if (s.ctxStart <= now) seg = s
      else break
    }
    const elapsed = Math.min(Math.max(0, now - seg.ctxStart), seg.length)
    return seg.offset + elapsed
  }

  getLoop(): LoopRegion | null {
    return this.loop
  }

  /** Region a repetir (null = sin repeticion). Se recorta a la duracion del audio. */
  setLoop(region: LoopRegion | null) {
    this.loop = region ? clampLoop(region, this.duration) : null
    const pos = this.position()
    const target = this.loop && (pos < this.loop.start || pos >= this.loop.end) ? this.loop.start : pos
    if (this.state === 'playing') this.restartAt(target)
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
    this.pausedAt = this.position()
    this.halt()
    this.setState('paused')
  }

  stop() {
    this.halt()
    this.pausedAt = this.loop ? this.loop.start : 0
    this.setState('stopped')
  }

  seek(sec: number) {
    const target = Math.min(Math.max(0, Number.isFinite(sec) ? sec : 0), this.duration)
    if (this.state === 'playing') this.restartAt(target)
    else this.pausedAt = target
  }

  private restartAt(pos: number) {
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
      this.schedule(when, offset, loop.end - offset)
    } else {
      this.schedule(when, from, Math.max(0, this.duration - from))
    }
    this.pausedAt = from
    this.setState('playing')
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  private schedule(when: number, offset: number, length: number) {
    const ctx = this.ctx
    if (!ctx || length <= 0) return
    for (const t of this.tracks.values()) {
      if (!t.buffer || offset >= t.buffer.duration) continue
      const src = ctx.createBufferSource()
      src.buffer = t.buffer
      src.connect(t.gain)
      src.onended = () => {
        this.sources.delete(src)
        src.disconnect()
      }
      src.start(when, offset, Math.min(length, t.buffer.duration - offset))
      this.sources.add(src)
    }
    this.segments.push({ ctxStart: when, offset, length })
  }

  private tick() {
    const ctx = this.ctx
    if (!ctx || this.state !== 'playing' || this.segments.length === 0) return
    const now = ctx.currentTime
    const last = this.segments[this.segments.length - 1]
    const lastEnd = last.ctxStart + last.length
    const loop = this.loop
    if (loop) {
      const len = loop.end - loop.start
      let end = lastEnd
      while (end - now < LOOKAHEAD) {
        this.schedule(end, loop.start, len)
        end += len
      }
      // Olvidar los tramos ya terminados (position() solo mira el actual).
      while (this.segments.length > 1 && this.segments[1].ctxStart <= now) this.segments.shift()
    } else if (now >= lastEnd) {
      this.halt()
      this.pausedAt = 0
      this.setState('stopped')
    }
  }

  private halt() {
    this.generation++
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const src of this.sources) {
      src.onended = null
      try {
        src.stop()
      } catch {
        // ya detenida
      }
      src.disconnect()
    }
    this.sources.clear()
    this.segments = []
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
    this.listeners.clear()
    const ctx = this.ctx
    this.ctx = null
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined)
  }
}
