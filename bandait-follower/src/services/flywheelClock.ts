/**
 * Bandait follower metronome scheduler ("flywheel"), contract sections 6 and 7.
 *
 * - The leader sends time instructions (anchor_ns, bpm, beats_per_bar,
 *   bar_offset). Clicks are synthesized locally; no audio is streamed.
 * - Lookahead scheduler: a 25 ms timer schedules every click that falls in
 *   the next 120 ms directly on the AudioContext clock. No per-beat timers.
 * - Time domains: leader ms -> local ms (performance.now) via the sync offset
 *   -> AudioContext seconds via AudioClockMapper (getOutputTimestamp when
 *   available, otherwise currentTime sampled against performance.now()).
 * - Anchor switches are never retroactive (rule 2): the current schedule
 *   holds until the new anchor, then the new parameters apply.
 * - Flywheel: nothing here depends on the socket. While disconnected it keeps
 *   scheduling with the last anchor/bpm/offset.
 * - Soft phase correction (section 7): error < 2 ms ignored; < 50 ms slewed
 *   toward an absolute target over at least one bar (bounded, never
 *   accumulating); larger errors re-anchor on the next beat boundary with no
 *   double click.
 * - STOP/PAUSE/PANIC cancel already scheduled nodes immediately.
 * - The AudioContext is only created or resumed inside armAudio(), which the
 *   UI must call from a user gesture (iOS).
 *
 * This class never touches React. The UI reads getVisualBeat() from rAF.
 */

import { TransportStatus } from '../types/protocol'
import { Segment, beatIndexAtOrAfter, beatLeaderMs, makeSegment, positionOfBeat, sameSchedule } from './transportMath'

// ---------------------------------------------------------------------------
// Web Audio subset (a fake implements this in tests)
// ---------------------------------------------------------------------------

export interface AudioParamLike {
  value: number
  setValueAtTime(value: number, time: number): unknown
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown
  cancelScheduledValues(startTime: number): unknown
  exponentialRampToValueAtTime(value: number, endTime: number): unknown
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown
  disconnect(): void
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: string
  readonly frequency: AudioParamLike
  onended: (() => void) | null
  start(when?: number): void
  stop(when?: number): void
}

export interface CompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike
  readonly knee: AudioParamLike
  readonly ratio: AudioParamLike
  readonly attack: AudioParamLike
  readonly release: AudioParamLike
}

export interface BufferSourceNodeLike extends AudioNodeLike {
  buffer: unknown
  start(when?: number): void
}

export interface AudioContextLike {
  readonly currentTime: number
  readonly state: string
  readonly destination: AudioNodeLike
  readonly baseLatency?: number
  readonly outputLatency?: number
  onstatechange: (() => void) | null
  resume(): Promise<void>
  createOscillator(): OscillatorNodeLike
  createGain(): GainNodeLike
  createDynamicsCompressor(): CompressorNodeLike
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): unknown
  createBufferSource(): BufferSourceNodeLike
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number }
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const LOOKAHEAD_INTERVAL_MS = 25
export const SCHEDULE_AHEAD_MS = 120
/** Beats later than this (local) are dropped instead of played late. */
export const LATE_TOLERANCE_MS = 20
/** Minimum lead for a node start on the audio clock. */
export const AUDIO_MIN_LEAD_SEC = 0.002
/** Old-schedule beats this close to a new anchor belong to the new schedule. */
export const SEGMENT_EPS_MS = 1
/** Two clicks from different schedules closer than this are a double click. */
export const MIN_CLICK_SPACING_MS = 60
export const PHASE_DEADBAND_MS = 2
export const PHASE_SLEW_LIMIT_MS = 50
/** Upper bound for the per-beat slew step. */
export const MAX_SLEW_STEP_MS = 5
export const MAPPER_ALPHA = 0.05
export const MAPPER_RESET_MS = 25

const MAX_BEATS_PER_TICK = 64
const HISTORY_LIMIT = 32
const CLICK_DURATION_SEC = 0.04
const DEFAULT_VOLUME = 0.8

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AudioState = 'unarmed' | 'armed' | 'suspended' | 'unsupported'
export type OffsetCorrection = 'initial' | 'direct' | 'ignored' | 'slew' | 'reanchor'
export type PanicSource = 'local' | 'remote'

export interface TransportInput {
  status: TransportStatus
  anchorLeaderMs: number | null
  bpm: number
  beatsPerBar: number
  barOffset: number
  stateVersion: number
}

export interface VisualBeat {
  bar: number
  beat: number
  beatsPerBar: number
  accent: boolean
  /** Local ms elapsed since this beat sounded. */
  sinceMs: number
}

export interface GeneratedBeatInfo {
  localMs: number
  bar: number
  beat: number
  accent: boolean
  hasAudio: boolean
}

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface FlywheelDeps {
  createAudioContext?: () => AudioContextLike | null
  now?: () => number
  timers?: Timers
}

interface ClickNodes {
  osc: OscillatorNodeLike
  gain: GainNodeLike
}

interface GeneratedBeat {
  seg: Segment
  k: number
  localMs: number
  bar: number
  beat: number
  accent: boolean
  node: ClickNodes | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

function finiteOrZero(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function defaultCreateAudioContext(): AudioContextLike | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return null
  try {
    return new Ctor({ latencyHint: 'interactive' }) as unknown as AudioContextLike
  } catch {
    try {
      return new Ctor() as unknown as AudioContextLike
    } catch {
      return null
    }
  }
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

const defaultTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

/** iOS 17+: play Web Audio even with the ring/silent switch on silent. */
function preferPlaybackAudioSession(): void {
  try {
    const nav = (typeof navigator !== 'undefined' ? navigator : null) as unknown as {
      audioSession?: { type: string }
    } | null
    if (nav?.audioSession) nav.audioSession.type = 'playback'
  } catch {
    // Not supported: nothing to do.
  }
}

function readOutputTimestamp(ctx: AudioContextLike): { contextTime: number; performanceTime: number } | null {
  if (typeof ctx.getOutputTimestamp !== 'function') return null
  try {
    const ts = ctx.getOutputTimestamp()
    if (
      ts &&
      typeof ts.contextTime === 'number' &&
      typeof ts.performanceTime === 'number' &&
      Number.isFinite(ts.contextTime) &&
      Number.isFinite(ts.performanceTime) &&
      ts.contextTime > 0 &&
      ts.performanceTime > 0
    ) {
      return { contextTime: ts.contextTime, performanceTime: ts.performanceTime }
    }
  } catch {
    // Fall through to null.
  }
  return null
}

/**
 * Maps local ms (performance.now) to AudioContext seconds such that a node
 * started at the returned time is HEARD at the given local time.
 * Smoothed with an EMA because currentTime advances in render quanta.
 */
export class AudioClockMapper {
  private deltaMs: number | null = null
  private useOutputTimestamp = false

  sample(ctx: AudioContextLike, nowMs: number): void {
    let raw: number | null = null
    const ts = readOutputTimestamp(ctx)
    if (ts) {
      this.useOutputTimestamp = true
      raw = ts.contextTime * 1000 - ts.performanceTime
    } else if (!this.useOutputTimestamp) {
      const latencySec = finiteOrZero(ctx.outputLatency) + finiteOrZero(ctx.baseLatency)
      raw = ctx.currentTime * 1000 - nowMs - latencySec * 1000
    }
    if (raw === null || !Number.isFinite(raw)) return
    if (this.deltaMs === null || Math.abs(raw - this.deltaMs) > MAPPER_RESET_MS) {
      this.deltaMs = raw
    } else {
      this.deltaMs += (raw - this.deltaMs) * MAPPER_ALPHA
    }
  }

  localToCtxSec(localMs: number): number | null {
    return this.deltaMs === null ? null : (localMs + this.deltaMs) / 1000
  }

  reset(): void {
    this.deltaMs = null
    this.useOutputTimestamp = false
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export class FlywheelClock {
  private readonly createCtx: () => AudioContextLike | null
  private readonly now: () => number
  private readonly timers: Timers

  private ctx: AudioContextLike | null = null
  private clickBus: GainNodeLike | null = null
  private master: GainNodeLike | null = null
  private audioState: AudioState = 'unarmed'
  private readonly audioListeners = new Set<() => void>()
  private readonly mapper = new AudioClockMapper()

  private inEarVolume = DEFAULT_VOLUME
  private clickVolume = DEFAULT_VOLUME
  private localMuted = false
  private remoteMuted = false

  private running = false
  /** segments[0] is the active schedule; the rest are pending, by anchor. */
  private segments: Segment[] = []
  private cursor: { seg: Segment; k: number } | null = null
  private history: GeneratedBeat[] = []
  private timer: unknown = null

  private appliedOffsetMs: number | null = null
  private targetOffsetMs: number | null = null
  private slewStepMs = 0

  constructor(deps: FlywheelDeps = {}) {
    this.createCtx = deps.createAudioContext ?? defaultCreateAudioContext
    this.now = deps.now ?? defaultNow
    this.timers = deps.timers ?? defaultTimers
  }

  // ------------------------------------------------------------------ audio

  /**
   * Creates or resumes the AudioContext. MUST be called synchronously from a
   * user gesture handler (click/touch); iOS stays silent otherwise. Also
   * releases a local PANIC mute.
   */
  armAudio(): Promise<boolean> {
    preferPlaybackAudioSession()
    if (!this.ctx) {
      let ctx: AudioContextLike | null = null
      try {
        ctx = this.createCtx()
      } catch {
        ctx = null
      }
      if (!ctx) {
        this.setAudioState('unsupported')
        return Promise.resolve(false)
      }
      this.ctx = ctx
      this.buildGraph(ctx)
      ctx.onstatechange = () => this.refreshAudioState()
    }
    const ctx = this.ctx
    this.localMuted = false
    this.unlockWithSilence(ctx)
    this.applyMasterGain(false)
    let resumed: Promise<void>
    try {
      resumed = ctx.state === 'running' ? Promise.resolve() : Promise.resolve(ctx.resume())
    } catch (err) {
      resumed = Promise.reject(err)
    }
    this.refreshAudioState()
    this.notifyAudio()
    return resumed.then(
      () => {
        this.refreshAudioState()
        this.mapper.reset()
        this.tick()
        return this.audioState === 'armed'
      },
      () => {
        this.refreshAudioState()
        return false
      },
    )
  }

  getAudioState(): AudioState {
    return this.audioState
  }

  isLocallyMuted(): boolean {
    return this.localMuted
  }

  isRemoteMuted(): boolean {
    return this.remoteMuted
  }

  onAudioChange(listener: () => void): () => void {
    this.audioListeners.add(listener)
    return () => {
      this.audioListeners.delete(listener)
    }
  }

  /** IN-EAR master gain (0..1). Applies to every local audio source. */
  setVolume(volume: number): void {
    this.inEarVolume = clamp01(volume)
    this.applyMasterGain(false)
  }

  getVolume(): number {
    return this.inEarVolume
  }

  /** Click channel gain (0..1), before the in-ear master. */
  setClickVolume(volume: number): void {
    this.clickVolume = clamp01(volume)
    if (this.ctx && this.clickBus) {
      try {
        this.clickBus.gain.setTargetAtTime(this.clickVolume, this.ctx.currentTime, 0.015)
      } catch {
        // Ignore: a closed context cannot be automated.
      }
    }
  }

  /**
   * Local emergency mute of ALL local audio (musician slide, mixer button).
   * Silences at once, including clicks already scheduled, but the transport
   * keeps running so the visual metronome stays in time. Nothing is sent to
   * the leader. Released by armAudio() (a deliberate user tap).
   */
  setLocalMuted(muted: boolean): void {
    this.localMuted = muted
    this.applyMasterGain(muted)
    if (muted) {
      const now = this.now()
      // Includes a click sounding right now (<= 40 ms long).
      for (const b of this.history) {
        if (b.localMs > now - CLICK_DURATION_SEC * 1000) this.cancelBeat(b)
      }
    }
    this.notifyAudio()
  }

  /**
   * PANIC: silence all local audio at once and cancel every scheduled click.
   * 'local' (this device's emergency control) stays muted until armAudio().
   * 'remote' (leader PANIC) is released by the next PLAYING transport.
   */
  panic(source: PanicSource): void {
    if (source === 'local') this.localMuted = true
    else this.remoteMuted = true
    this.applyMasterGain(true)
    this.stopTransport()
    this.notifyAudio()
  }

  // -------------------------------------------------------------- transport

  applyTransport(input: TransportInput): void {
    const clicking = (input.status === 'PLAYING' || input.status === 'COUNTING') && input.anchorLeaderMs !== null
    if (!clicking || input.anchorLeaderMs === null) {
      this.stopTransport()
      return
    }
    const seg = makeSegment({
      anchorLeaderMs: input.anchorLeaderMs,
      bpm: input.bpm,
      beatsPerBar: input.beatsPerBar,
      barOffset: input.barOffset,
      stateVersion: input.stateVersion,
    })
    if (!seg) return // Malformed: keep whatever is playing.

    if (this.remoteMuted) {
      this.remoteMuted = false
      this.applyMasterGain(false)
      this.notifyAudio()
    }

    if (!this.running) {
      this.running = true
      this.segments = [seg]
      this.cursor = null
      this.history = []
      this.ensureTimer()
      this.tick()
      return
    }
    this.insertSegment(seg)
    this.tick()
  }

  /** STOP / PAUSE / IDLE: cancel everything scheduled, right now. */
  stopTransport(): void {
    this.running = false
    this.segments = []
    this.cursor = null
    for (const b of this.history) this.cancelBeat(b)
    this.history = []
    this.slewStepMs = 0
    this.targetOffsetMs = this.appliedOffsetMs
    this.stopTimer()
  }

  /** Leaving the session: stop and forget the clock offset. */
  reset(): void {
    this.stopTransport()
    this.appliedOffsetMs = null
    this.targetOffsetMs = null
    this.remoteMuted = false
    this.mapper.reset()
    this.applyMasterGain(false)
    this.notifyAudio()
  }

  isRunning(): boolean {
    return this.running
  }

  getAppliedOffsetMs(): number | null {
    return this.appliedOffsetMs
  }

  /**
   * New clock offset estimate (leader_ms - local_ms). The caller only feeds
   * estimates built from at least 3 samples of the current connection.
   */
  setOffset(offsetMs: number): OffsetCorrection {
    if (!Number.isFinite(offsetMs)) return 'ignored'
    if (this.appliedOffsetMs === null) {
      this.appliedOffsetMs = offsetMs
      this.targetOffsetMs = offsetMs
      this.slewStepMs = 0
      if (this.running) this.tick()
      return 'initial'
    }
    if (!this.running) {
      // Nothing audible to protect: take it as is.
      this.appliedOffsetMs = offsetMs
      this.targetOffsetMs = offsetMs
      this.slewStepMs = 0
      return 'direct'
    }
    const error = offsetMs - this.appliedOffsetMs
    const magnitude = Math.abs(error)
    if (magnitude < PHASE_DEADBAND_MS) {
      // Inside the deadband: stop any slew where it is. Never accumulate.
      this.targetOffsetMs = this.appliedOffsetMs
      this.slewStepMs = 0
      return 'ignored'
    }
    if (magnitude < PHASE_SLEW_LIMIT_MS) {
      const beatsPerBar = this.segments[0]?.beatsPerBar ?? 4
      this.targetOffsetMs = offsetMs
      // Spread over at least one bar, and never more than MAX_SLEW_STEP_MS per beat.
      this.slewStepMs = Math.min(magnitude / beatsPerBar, MAX_SLEW_STEP_MS)
      return 'slew'
    }
    // Large error: re-anchor on the next beat boundary of the corrected grid.
    this.appliedOffsetMs = offsetMs
    this.targetOffsetMs = offsetMs
    this.slewStepMs = 0
    if (this.cursor) {
      const last = this.lastBeat()
      const fromLocal = last ? last.localMs + this.cursor.seg.beatMs / 2 : this.now()
      this.cursor.k = beatIndexAtOrAfter(this.cursor.seg, fromLocal + offsetMs)
    }
    this.tick()
    return 'reanchor'
  }

  // ---------------------------------------------------------------- readout

  /** Most recent beat that has already sounded (local clock), for the UI. */
  getVisualBeat(nowMs: number): VisualBeat | null {
    if (!this.running) return null
    for (let i = this.history.length - 1; i >= 0; i--) {
      const b = this.history[i]
      if (b.localMs <= nowMs) {
        return {
          bar: b.bar,
          beat: b.beat,
          beatsPerBar: b.seg.beatsPerBar,
          accent: b.accent,
          sinceMs: nowMs - b.localMs,
        }
      }
    }
    return null
  }

  getRecentBeats(): GeneratedBeatInfo[] {
    return this.history.map((b) => ({
      localMs: b.localMs,
      bar: b.bar,
      beat: b.beat,
      accent: b.accent,
      hasAudio: b.node !== null,
    }))
  }

  // -------------------------------------------------------------- scheduler

  /** One scheduler pass. Public so tests can drive it without timers. */
  tick(): void {
    if (!this.running || this.appliedOffsetMs === null || this.segments.length === 0) return
    const now = this.now()
    const ctx = this.ctx
    const audioLive = ctx !== null && ctx.state === 'running' && this.clickBus !== null
    if (audioLive && ctx) this.mapper.sample(ctx, now)
    if (!this.cursor) this.initCursor(now)
    const horizon = now + SCHEDULE_AHEAD_MS

    for (let i = 0; i < MAX_BEATS_PER_TICK; i++) {
      const cursor = this.cursor
      if (!cursor) return
      const next = this.segments[1]
      const leaderMs = beatLeaderMs(cursor.seg, cursor.k)
      if (next && leaderMs >= next.anchorLeaderMs - SEGMENT_EPS_MS) {
        // Rule 2: the old schedule held until here; switch now.
        this.segments.shift()
        const leaderNow = now + this.appliedOffsetMs
        this.cursor = { seg: next, k: beatIndexAtOrAfter(next, Math.max(next.anchorLeaderMs, leaderNow)) }
        continue
      }
      const offset = this.peekOffset()
      const localMs = leaderMs - offset
      if (localMs > horizon) break
      this.appliedOffsetMs = offset // commit this beat's slew step
      cursor.k += 1
      if (localMs < now - LATE_TOLERANCE_MS) continue // never play a stale click
      this.emitBeat(cursor.seg, cursor.k - 1, localMs, now, audioLive)
    }
  }

  private initCursor(now: number): void {
    if (this.appliedOffsetMs === null || this.segments.length === 0) return
    const leaderNow = now + this.appliedOffsetMs
    let idx = 0
    for (let i = 1; i < this.segments.length; i++) {
      if (this.segments[i].anchorLeaderMs <= leaderNow) idx = i
    }
    if (idx > 0) this.segments = this.segments.slice(idx)
    const seg = this.segments[0]
    this.cursor = { seg, k: beatIndexAtOrAfter(seg, leaderNow) }
  }

  private insertSegment(seg: Segment): void {
    const active = this.segments[0]
    const last = this.segments[this.segments.length - 1]
    if (last && sameSchedule(last, seg)) {
      last.stateVersion = Math.max(last.stateVersion, seg.stateVersion)
      return
    }
    if (!active || seg.anchorLeaderMs <= active.anchorLeaderMs + SEGMENT_EPS_MS) {
      // Starts no later than the active schedule: it supersedes everything,
      // effective from its anchor or from now (never retroactively).
      this.segments = [seg]
    } else {
      // Pending schedules at or after the new anchor are superseded by it.
      this.segments = this.segments.filter(
        (s, i) => i === 0 || s.anchorLeaderMs < seg.anchorLeaderMs - SEGMENT_EPS_MS,
      )
      this.segments.push(seg)
    }
    const cancelFrom = seg.anchorLeaderMs - SEGMENT_EPS_MS
    this.cancelGeneratedFrom(cancelFrom)
    if (this.cursor) {
      if (!this.segments.includes(this.cursor.seg)) {
        this.cursor = null
      } else {
        this.cursor.k = Math.min(this.cursor.k, beatIndexAtOrAfter(this.cursor.seg, cancelFrom))
      }
    }
  }

  /** Cancels not-yet-heard beats whose leader time is >= leaderMs. */
  private cancelGeneratedFrom(leaderMs: number): void {
    const now = this.now()
    const keep: GeneratedBeat[] = []
    for (const b of this.history) {
      if (b.localMs > now && beatLeaderMs(b.seg, b.k) >= leaderMs) this.cancelBeat(b)
      else keep.push(b)
    }
    this.history = keep
  }

  private peekOffset(): number {
    const applied = this.appliedOffsetMs ?? 0
    const target = this.targetOffsetMs ?? applied
    if (this.slewStepMs <= 0 || target === applied) return applied
    const remaining = target - applied
    if (Math.abs(remaining) <= this.slewStepMs) {
      return target
    }
    return applied + Math.sign(remaining) * this.slewStepMs
  }

  private lastBeat(): GeneratedBeat | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null
  }

  private emitBeat(seg: Segment, k: number, localMs: number, now: number, audioLive: boolean): void {
    const prev = this.lastBeat()
    if (prev) {
      const sameSeg = prev.seg === seg
      const minGap = sameSeg ? seg.beatMs / 2 : MIN_CLICK_SPACING_MS
      if (localMs - prev.localMs < minGap) {
        if (!sameSeg && prev.localMs > now + 5) {
          // The newer schedule wins over an old click that has not sounded yet.
          this.cancelBeat(prev)
          this.history.pop()
        } else {
          return // would be a double click
        }
      }
    }
    const pos = positionOfBeat(seg, k)
    const beat: GeneratedBeat = {
      seg,
      k,
      localMs,
      bar: pos.bar,
      beat: pos.beat,
      accent: pos.beat === 1,
      node: null,
    }
    if (audioLive && !this.localMuted && !this.remoteMuted && this.ctx) {
      const ctxTime = this.mapper.localToCtxSec(localMs)
      if (ctxTime !== null && ctxTime >= this.ctx.currentTime + AUDIO_MIN_LEAD_SEC) {
        beat.node = this.playClick(ctxTime, beat.accent)
      }
    }
    this.history.push(beat)
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
  }

  /** Synthesized click (no audio streaming): 1600 Hz downbeat, 800 Hz others. */
  private playClick(time: number, accent: boolean): ClickNodes | null {
    const ctx = this.ctx
    const bus = this.clickBus
    if (!ctx || !bus) return null
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(accent ? 1600 : 800, time)
      gain.gain.setValueAtTime(accent ? 1.0 : 0.6, time)
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.035)
      osc.connect(gain)
      gain.connect(bus)
      osc.onended = () => {
        try {
          osc.disconnect()
          gain.disconnect()
        } catch {
          // Already disconnected.
        }
      }
      osc.start(time)
      osc.stop(time + CLICK_DURATION_SEC)
      return { osc, gain }
    } catch {
      return null
    }
  }

  private cancelBeat(b: GeneratedBeat): void {
    const node = b.node
    if (!node) return
    b.node = null
    try {
      node.gain.disconnect()
    } catch {
      // Ignore.
    }
    try {
      node.osc.onended = null
      node.osc.stop(0)
    } catch {
      // Some engines throw on a second stop(); the gain is already disconnected.
    }
    try {
      node.osc.disconnect()
    } catch {
      // Ignore.
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return
    this.timer = this.timers.setInterval(() => this.tick(), LOOKAHEAD_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (this.timer === null) return
    this.timers.clearInterval(this.timer)
    this.timer = null
  }

  // ------------------------------------------------------------ audio graph

  private buildGraph(ctx: AudioContextLike): void {
    try {
      const t = ctx.currentTime
      // Safety limiter at -0.5 dBFS (protect in-ear monitors).
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.setValueAtTime(-0.5, t)
      limiter.knee.setValueAtTime(0, t)
      limiter.ratio.setValueAtTime(20, t)
      limiter.attack.setValueAtTime(0.001, t)
      limiter.release.setValueAtTime(0.05, t)

      const master = ctx.createGain()
      master.gain.setValueAtTime(this.effectiveMasterGain(), t)
      const clickBus = ctx.createGain()
      clickBus.gain.setValueAtTime(this.clickVolume, t)

      clickBus.connect(master)
      master.connect(limiter)
      limiter.connect(ctx.destination)
      this.master = master
      this.clickBus = clickBus
    } catch {
      this.master = null
      this.clickBus = null
    }
  }

  private unlockWithSilence(ctx: AudioContextLike): void {
    try {
      const buffer = ctx.createBuffer(1, 1, 22050)
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      src.start(0)
    } catch {
      // Best effort iOS unlock.
    }
  }

  private effectiveMasterGain(): number {
    return this.localMuted || this.remoteMuted ? 0 : this.inEarVolume
  }

  private applyMasterGain(immediate: boolean): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const value = this.effectiveMasterGain()
    const t = ctx.currentTime
    try {
      master.gain.cancelScheduledValues(0)
      if (immediate || value === 0) master.gain.setValueAtTime(value, t)
      else master.gain.setTargetAtTime(value, t, 0.015)
    } catch {
      // Closed context: nothing to silence.
    }
  }

  private refreshAudioState(): void {
    const ctx = this.ctx
    if (!ctx) {
      this.setAudioState(this.audioState === 'unsupported' ? 'unsupported' : 'unarmed')
      return
    }
    if (ctx.state === 'running') {
      this.setAudioState('armed')
    } else if (ctx.state === 'closed') {
      this.ctx = null
      this.master = null
      this.clickBus = null
      this.mapper.reset()
      this.setAudioState('unarmed')
    } else {
      // 'suspended' or iOS 'interrupted': needs a new gesture.
      this.mapper.reset()
      this.setAudioState('suspended')
    }
  }

  private setAudioState(next: AudioState): void {
    if (this.audioState === next) return
    this.audioState = next
    this.notifyAudio()
  }

  private notifyAudio(): void {
    for (const listener of this.audioListeners) {
      try {
        listener()
      } catch {
        // A UI listener must never break the scheduler.
      }
    }
  }
}

export const flywheelClock = new FlywheelClock()
