/**
 * Test doubles: a fake Web Audio context driven by a manual clock and a fake
 * Socket.IO client socket. Not a test file itself (no .test suffix).
 */

import type {
  AudioContextLike,
  AudioNodeLike,
  AudioParamLike,
  BufferSourceNodeLike,
  CompressorNodeLike,
  GainNodeLike,
  OscillatorNodeLike,
  Timers,
} from '../flywheelClock'
import type { SocketLike, SocketListenerFn } from '../syncService'

// ---------------------------------------------------------------- audio

export class FakeParam implements AudioParamLike {
  value: number
  readonly events: Array<{ kind: string; value: number; time: number }> = []

  constructor(initial = 1) {
    this.value = initial
  }

  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'set', value, time })
    this.value = value
    return this
  }

  setTargetAtTime(value: number, time: number) {
    this.events.push({ kind: 'target', value, time })
    this.value = value
    return this
  }

  cancelScheduledValues(time: number) {
    this.events.push({ kind: 'cancel', value: NaN, time })
    return this
  }

  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'ramp', value, time })
    return this
  }
}

export class FakeNode implements AudioNodeLike {
  readonly connections: AudioNodeLike[] = []
  disconnected = false

  connect(destination: AudioNodeLike) {
    this.connections.push(destination)
    return destination
  }

  disconnect() {
    this.disconnected = true
  }
}

export class FakeGain extends FakeNode implements GainNodeLike {
  readonly gain = new FakeParam(1)
}

export class FakeOscillator extends FakeNode implements OscillatorNodeLike {
  type = 'sine'
  readonly frequency = new FakeParam(440)
  onended: (() => void) | null = null
  startTime: number | null = null
  readonly stopTimes: number[] = []

  start(when = 0) {
    this.startTime = when
  }

  stop(when = 0) {
    this.stopTimes.push(when)
  }

  /** Gain this oscillator feeds (playClick connects osc -> gain). */
  get clickGain(): FakeGain | null {
    const g = this.connections[0]
    return g instanceof FakeGain ? g : null
  }

  /** Cancelled = silenced before it could play: stop(0) or its gain cut. */
  get cancelled(): boolean {
    return this.stopTimes.includes(0) || (this.clickGain?.disconnected ?? false)
  }
}

class FakeCompressor extends FakeNode implements CompressorNodeLike {
  readonly threshold = new FakeParam(-24)
  readonly knee = new FakeParam(30)
  readonly ratio = new FakeParam(12)
  readonly attack = new FakeParam(0.003)
  readonly release = new FakeParam(0.25)
}

class FakeBufferSource extends FakeNode implements BufferSourceNodeLike {
  buffer: unknown = null
  start() {
    // Silent unlock buffer: nothing to do.
  }
}

export interface FakeAudioOptions {
  /** Simulated output latency reported via getOutputTimestamp (seconds). */
  outputTimestampLatencySec?: number
  /** Simulated ctx.outputLatency for the fallback path (seconds). */
  outputLatency?: number
}

/**
 * currentTime = CTX_ORIGIN_SEC + (now - createdAt) / 1000, continuous.
 */
export class FakeAudioContext implements AudioContextLike {
  static readonly CTX_ORIGIN_SEC = 0.5
  state = 'suspended'
  readonly destination = new FakeNode()
  onstatechange: (() => void) | null = null
  readonly oscillators: FakeOscillator[] = []
  readonly gains: FakeGain[] = []
  readonly outputLatency?: number
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number }
  private readonly createdAt: number

  constructor(
    private readonly now: () => number,
    options: FakeAudioOptions = {},
  ) {
    this.createdAt = now()
    if (options.outputLatency !== undefined) this.outputLatency = options.outputLatency
    const latency = options.outputTimestampLatencySec
    if (latency !== undefined) {
      this.getOutputTimestamp = () => ({ contextTime: this.currentTime - latency, performanceTime: this.now() })
    }
  }

  get currentTime(): number {
    return FakeAudioContext.CTX_ORIGIN_SEC + (this.now() - this.createdAt) / 1000
  }

  /** Naive mapping (no latency) from local ms to ctx seconds. */
  localToCtx(localMs: number): number {
    return FakeAudioContext.CTX_ORIGIN_SEC + (localMs - this.createdAt) / 1000
  }

  ctxToLocal(ctxSec: number): number {
    return (ctxSec - FakeAudioContext.CTX_ORIGIN_SEC) * 1000 + this.createdAt
  }

  resume(): Promise<void> {
    this.state = 'running'
    this.onstatechange?.()
    return Promise.resolve()
  }

  suspend(): void {
    this.state = 'suspended'
    this.onstatechange?.()
  }

  createOscillator(): FakeOscillator {
    const o = new FakeOscillator()
    this.oscillators.push(o)
    return o
  }

  createGain(): FakeGain {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }

  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor()
  }

  createBuffer(): unknown {
    return {}
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource()
  }

  /** Local ms of every click that was scheduled and not cancelled. */
  liveClickTimes(): number[] {
    return this.oscillators
      .filter((o) => o.startTime !== null && !o.cancelled)
      .map((o) => this.ctxToLocal(o.startTime as number))
  }
}

/** Timers that never fire: tests drive FlywheelClock.tick() by hand. */
export const manualTimers: Timers = {
  setInterval: () => 1,
  clearInterval: () => undefined,
}

// --------------------------------------------------------------- socket

export type AckFn = (response: unknown) => void
export type Responder = (event: string, payload: unknown, ack: AckFn | undefined) => void

export class FakeSocket implements SocketLike {
  connected = false
  active = true
  connectCalls = 0
  readonly handlers = new Map<string, SocketListenerFn[]>()
  readonly ioHandlers = new Map<string, SocketListenerFn[]>()
  readonly emitted: Array<{ event: string; payload: unknown; at: number }> = []
  responder: Responder | null = null

  readonly io = {
    on: (event: string, listener: SocketListenerFn) => {
      const list = this.ioHandlers.get(event) ?? []
      list.push(listener)
      this.ioHandlers.set(event, list)
      return this.io
    },
    removeAllListeners: () => {
      this.ioHandlers.clear()
    },
  }

  constructor(private readonly now: () => number = () => Date.now()) {}

  on(event: string, listener: SocketListenerFn) {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]) {
    const [payload, ack] = args
    this.emitted.push({ event, payload, at: this.now() })
    this.responder?.(event, payload, typeof ack === 'function' ? (ack as AckFn) : undefined)
    return this
  }

  connect() {
    this.connectCalls += 1
    return this
  }

  disconnect() {
    this.connected = false
    this.active = false
    return this
  }

  removeAllListeners() {
    this.handlers.clear()
    return this
  }

  fire(event: string, ...args: unknown[]) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args)
  }

  fireIo(event: string, ...args: unknown[]) {
    for (const fn of [...(this.ioHandlers.get(event) ?? [])]) fn(...args)
  }

  /** The transport opened (initial connect or a socket.io auto-reconnect). */
  serverConnect() {
    this.connected = true
    this.active = true
    this.fire('connect')
  }

  /** Wi-Fi drop: socket.io keeps trying to reconnect by itself. */
  drop(reason = 'transport close') {
    this.connected = false
    this.fire('disconnect', reason)
  }

  emitsOf(event: string): Array<{ event: string; payload: unknown; at: number }> {
    return this.emitted.filter((e) => e.event === event)
  }
}
