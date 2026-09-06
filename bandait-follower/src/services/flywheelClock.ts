/**
 * Bandait 3.0 — Precision Web Audio Flywheel Engine
 * 
 * Generates local metronome clicks via wave synthesis (no audio streaming).
 * Implements autonomous flywheel clock that keeps steady tempo through Wi-Fi drops
 * and performs soft phase-alignment on reconnection.
 */

export interface FlywheelState {
  bpm: number
  beatsPerBar: number
  isPlaying: boolean
  isAutonomous: boolean
  currentBar: number
  currentBeat: number
}

export type BeatCallback = (bar: number, beat: number, time: number) => void
export type ModeCallback = (isAutonomous: boolean) => void

export class FlywheelClock {
  private audioCtx: AudioContext | null = null
  private limiterNode: DynamicsCompressorNode | null = null
  private masterGain: GainNode | null = null

  private bpm: number = 120
  private beatsPerBar: number = 4
  private isPlaying: boolean = false
  private isAutonomous: boolean = false

  private currentBar: number = 1
  private currentBeat: number = 1

  // Scheduler state
  private nextNoteTime: number = 0
  private timerId: number | null = null
  private lookaheadMs: number = 25.0
  private scheduleAheadSec: number = 0.1

  // Phase alignment
  private targetPhaseOffsetSec: number = 0
  private currentPhaseOffsetSec: number = 0

  private onBeatCb: BeatCallback | null = null
  private onModeCb: ModeCallback | null = null

  constructor() {
    // Lazy AudioContext initialization on first user interaction
  }

  private initAudio(): AudioContext {
    if (!this.audioCtx) {
      const AudioCtxClass =
        (typeof window !== 'undefined' && (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)) ||
        (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext
      if (!AudioCtxClass) {
        throw new Error('AudioContext is not supported in this environment')
      }
      this.audioCtx = new AudioCtxClass()

      // Safety Limiter at -0.5 dBFS (protect in-ear monitors)
      this.limiterNode = this.audioCtx.createDynamicsCompressor()
      this.limiterNode.threshold.setValueAtTime(-0.5, this.audioCtx.currentTime)
      this.limiterNode.knee.setValueAtTime(0.0, this.audioCtx.currentTime)
      this.limiterNode.ratio.setValueAtTime(20.0, this.audioCtx.currentTime)
      this.limiterNode.attack.setValueAtTime(0.001, this.audioCtx.currentTime)
      this.limiterNode.release.setValueAtTime(0.05, this.audioCtx.currentTime)

      this.masterGain = this.audioCtx.createGain()
      this.masterGain.gain.setValueAtTime(0.8, this.audioCtx.currentTime)

      this.masterGain.connect(this.limiterNode)
      this.limiterNode.connect(this.audioCtx.destination)
    }

    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume()
    }

    return this.audioCtx
  }

  public setCallbacks(onBeat: BeatCallback, onMode?: ModeCallback) {
    this.onBeatCb = onBeat
    if (onMode) this.onModeCb = onMode
  }

  public setBpm(newBpm: number) {
    this.bpm = Math.max(20, Math.min(500, newBpm))
  }

  public setVolume(vol: number) {
    if (this.masterGain && this.audioCtx) {
      const safeVol = Math.max(0, Math.min(1.0, vol))
      this.masterGain.gain.setValueAtTime(safeVol, this.audioCtx.currentTime)
    }
  }

  /**
   * Start flywheel playback, forcing beat = 1 on downbeat.
   */
  public start(bpm?: number, beatsPerBar: number = 4) {
    const ctx = this.initAudio()
    if (bpm) this.bpm = bpm
    this.beatsPerBar = beatsPerBar

    // Force beat = 1 on start
    this.currentBeat = 1
    this.currentBar = 1
    this.isPlaying = true
    this.isAutonomous = false
    this.currentPhaseOffsetSec = 0
    this.targetPhaseOffsetSec = 0

    this.nextNoteTime = ctx.currentTime + 0.05
    this.schedule()
  }

  public stop() {
    this.isPlaying = false
    this.isAutonomous = false
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId)
      this.timerId = null
    }
    this.currentBeat = 1
    this.currentBar = 1
  }

  /**
   * Set network connectivity state.
   * If disconnected during active playback, switches to autonomous Flywheel inertia mode.
   */
  public setConnected(connected: boolean) {
    if (!this.isPlaying) return

    const wasAutonomous = this.isAutonomous
    if (!connected) {
      this.isAutonomous = true
      if (!wasAutonomous && this.onModeCb) {
        this.onModeCb(true)
      }
    } else {
      this.isAutonomous = false
      if (wasAutonomous && this.onModeCb) {
        this.onModeCb(false)
      }
    }
  }

  /**
   * Sync clock phase from leader.
   * Uses soft phase-alignment if flywheel was autonomous to avoid abrupt audio jumps.
   */
  public syncLeaderPhase(targetTimeSec: number, beat: number, bar: number) {
    if (!this.isPlaying || !this.audioCtx) return

    const currentSec = this.audioCtx.currentTime
    const delta = targetTimeSec - currentSec

    if (this.isAutonomous) {
      // Slew-limited soft phase alignment: adjust by 15% per beat
      this.targetPhaseOffsetSec = delta
    } else {
      this.nextNoteTime = targetTimeSec
      this.currentBeat = beat
      this.currentBar = bar
    }
  }

  private schedule = () => {
    if (!this.isPlaying || !this.audioCtx) return

    while (this.nextNoteTime < this.audioCtx.currentTime + this.scheduleAheadSec) {
      this.playClick(this.nextNoteTime, this.currentBeat === 1)

      if (this.onBeatCb) {
        this.onBeatCb(this.currentBar, this.currentBeat, this.nextNoteTime)
      }

      this.advanceBeat()
    }

    this.timerId = window.setTimeout(this.schedule, this.lookaheadMs)
  }

  private advanceBeat() {
    const secondsPerBeat = 60.0 / this.bpm

    // Apply soft phase alignment convergence
    if (Math.abs(this.targetPhaseOffsetSec - this.currentPhaseOffsetSec) > 0.001) {
      const step = (this.targetPhaseOffsetSec - this.currentPhaseOffsetSec) * 0.15
      this.currentPhaseOffsetSec += step
    }

    this.nextNoteTime += secondsPerBeat + this.currentPhaseOffsetSec

    this.currentBeat++
    if (this.currentBeat > this.beatsPerBar) {
      this.currentBeat = 1
      this.currentBar++
    }
  }

  /**
   * Synthesize click pulse (no audio streaming).
   * Beat 1 (downbeat): 1600 Hz crisp click.
   * Beats 2-4: 800 Hz lighter pulse.
   */
  private playClick(time: number, isDownbeat: boolean) {
    if (!this.audioCtx || !this.masterGain) return

    const osc = this.audioCtx.createOscillator()
    const clickGain = this.audioCtx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(isDownbeat ? 1600 : 800, time)

    const amp = isDownbeat ? 1.0 : 0.6
    clickGain.gain.setValueAtTime(amp, time)
    clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.035)

    osc.connect(clickGain)
    clickGain.connect(this.masterGain)

    osc.start(time)
    osc.stop(time + 0.04)
  }

  public getState(): FlywheelState {
    return {
      bpm: this.bpm,
      beatsPerBar: this.beatsPerBar,
      isPlaying: this.isPlaying,
      isAutonomous: this.isAutonomous,
      currentBar: this.currentBar,
      currentBeat: this.currentBeat,
    }
  }
}

export const flywheelClock = new FlywheelClock()
