/**
 * Session lifetime for the follower app. Lives outside React so navigating
 * between Stage, Library and Settings never drops the socket or stops the
 * metronome. Only leave() (the SALIR button) ends the session.
 *
 * React reads it through useSyncExternalStore (src/hooks/useSession.ts). The
 * snapshot changes on connection/state/command events and on each sync sample
 * (about 1 Hz in steady state), never on beats.
 */

import { CommandAck, CommandSender, FollowerRole, SessionState, SetlistJump } from '../types/protocol'
import { ClockEstimate } from './clockSync'
import { AudioState, FlywheelClock, TransportInput, flywheelClock } from './flywheelClock'
import { getOrCreateClientId, sanitizeAlias } from './identity'
import { LinkState, computeLinkState } from './linkState'
import { CommandError, ConnectionPhase, SyncService, syncService } from './syncService'
import { ScreenWakeLock, WakeLockStatus, WakeMode, screenWakeLock } from './wakeLock'

/** Contract section 7: phase corrections need at least 3 new samples. */
export const MIN_SAMPLES_FOR_PHASE = 3

export interface JoinRequest {
  url: string
  sessionId: string
  role: FollowerRole
  alias: string
}

export interface SessionSnapshot {
  active: boolean
  sessionId: string | null
  url: string | null
  role: FollowerRole
  alias: string
  phase: ConnectionPhase
  connected: boolean
  joined: boolean
  reconnectAttempt: number
  lastError: string | null
  protocolError: string | null
  state: SessionState | null
  clock: ClockEstimate | null
  linkState: LinkState
  schedulerRunning: boolean
  audio: AudioState
  localMuted: boolean
  jumpAlert: SetlistJump | null
  wakeLock: WakeLockStatus
  /** What keeps the screen on: API / VIDEO / NO DISPONIBLE. */
  wakeMode: WakeMode
}

/** What the emergency slide did on this device. */
export type EmergencyOutcome =
  | { kind: 'local_mute' }
  | { kind: 'band_panic'; ack: CommandAck }

export function transportFromState(state: SessionState): TransportInput {
  return {
    status: state.status,
    anchorLeaderMs: state.anchorNs === null ? null : state.anchorNs / 1e6,
    bpm: state.bpm,
    beatsPerBar: state.beatsPerBar,
    barOffset: state.barOffset,
    stateVersion: state.stateVersion,
  }
}

export class SessionController {
  private snapshot: SessionSnapshot
  private readonly listeners = new Set<() => void>()
  private lastPanicCommandId: string | null = null

  constructor(
    private readonly sync: SyncService,
    private readonly clock: FlywheelClock,
    private readonly wakeLock: ScreenWakeLock = screenWakeLock,
  ) {
    this.snapshot = this.initialSnapshot()
    this.sync.setListener({
      onConnection: (info) =>
        this.patch({
          phase: info.phase,
          connected: info.connected,
          joined: info.joined,
          reconnectAttempt: info.reconnectAttempt,
          lastError: info.lastError,
          // Reset on reconnect (the service starts a fresh window); kept while
          // disconnected so the last figures stay visible next to FLYWHEEL.
          clock: this.sync.getClockEstimate(),
        }),
      onJoined: () => this.patch({ joined: true, protocolError: null }),
      onState: (state) => this.handleState(state),
      onBeacon: (beacon) => {
        this.clock.applyTransport({
          status: 'PLAYING',
          anchorLeaderMs: beacon.anchorNs / 1e6,
          bpm: beacon.bpm,
          beatsPerBar: beacon.beatsPerBar,
          barOffset: beacon.barOffset,
          stateVersion: beacon.stateVersion,
        })
        // Beacons arrive once per bar: only notify React if something changed.
        if (this.clock.isRunning() !== this.snapshot.schedulerRunning) this.patch({})
      },
      onSetlistJump: (jump) => this.patch({ jumpAlert: jump }),
      onClock: (estimate) => {
        if (estimate.sampleCount >= MIN_SAMPLES_FOR_PHASE) this.clock.setOffset(estimate.offsetMs)
        this.patch({ clock: estimate })
      },
      onProtocolError: (message) => {
        if (this.snapshot.protocolError !== message) this.patch({ protocolError: message })
      },
    })
    this.clock.onAudioChange(() => this.patch({}))
    this.wakeLock.onChange(() => this.patch({}))
  }

  // ----------------------------------------------------------- store API

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): SessionSnapshot => this.snapshot

  // ------------------------------------------------------------- actions

  join(request: JoinRequest): void {
    const alias = sanitizeAlias(request.alias)
    this.lastPanicCommandId = null
    this.clock.reset()
    this.patch({
      ...this.initialSnapshot(),
      active: true,
      sessionId: request.sessionId,
      url: request.url,
      role: request.role,
      alias,
      phase: 'connecting',
    })
    // A sleeping screen suspends JS and the metronome: keep it on while active.
    this.wakeLock.enable()
    this.sync.connect({
      url: request.url,
      sessionId: request.sessionId,
      clientId: getOrCreateClientId(),
      role: request.role,
      alias,
    })
  }

  /**
   * Retry keeping the screen on from a user gesture (ACTIVAR AUDIO): the video
   * fallback may have been refused without one (auto=1 join).
   */
  ensureWakeLock(): void {
    if (this.snapshot.active) this.wakeLock.enable()
  }

  /** SALIR: the only path that closes the socket and stops the metronome. */
  leave(): void {
    this.sync.disconnect()
    this.wakeLock.disable()
    this.clock.reset()
    this.lastPanicCommandId = null
    this.patch(this.initialSnapshot())
  }

  sendCommand: CommandSender = (type, payload) => this.sync.sendCommand(type, payload)

  /**
   * Emergency slide, scoped by role:
   * - musician: LOCAL emergency mute only. Silences this device's click and
   *   in-ear at once and sends NOTHING to the leader (the band keeps playing).
   * - director: PANIC to the whole band plus the same local silence.
   * Both latch until a deliberate tap re-arms audio. A leader PANIC still
   * silences everyone (handleState).
   */
  emergencyStop(): Promise<EmergencyOutcome> {
    if (this.snapshot.role !== 'director') {
      this.clock.setLocalMuted(true)
      this.patch({})
      return Promise.resolve({ kind: 'local_mute' })
    }
    return this.panicLocal().then((ack) => ({ kind: 'band_panic' as const, ack }))
  }

  /** Director emergency: silence this device (latched) and PANIC the band if online. */
  private panicLocal(): Promise<CommandAck> {
    this.clock.panic('local')
    this.patch({})
    if (!this.sync.isConnected()) {
      return Promise.reject(new CommandError('offline', 'Sin conexion: solo se silencio este equipo.'))
    }
    return this.sync.sendCommand('PANIC')
  }

  /** Director PANIC button: silence now; released by the next PLAY. */
  panicRemote(): Promise<CommandAck> {
    this.clock.panic('remote')
    this.patch({})
    return this.sync.sendCommand('PANIC')
  }

  dismissJumpAlert = (): void => {
    if (this.snapshot.jumpAlert) this.patch({ jumpAlert: null })
  }

  // ------------------------------------------------------------ internals

  private handleState(state: SessionState): void {
    const last = state.lastCommand
    if (last && last.type === 'PANIC' && last.commandId !== this.lastPanicCommandId) {
      // Contract rule 7: clients silence all local audio, not just the transport.
      this.lastPanicCommandId = last.commandId
      this.clock.panic('remote')
    }
    this.clock.applyTransport(transportFromState(state))
    this.patch({ state })
  }

  private initialSnapshot(): SessionSnapshot {
    return {
      active: false,
      sessionId: null,
      url: null,
      role: 'musician',
      alias: '',
      phase: 'idle',
      connected: false,
      joined: false,
      reconnectAttempt: 0,
      lastError: null,
      protocolError: null,
      state: null,
      clock: null,
      linkState: 'LOST',
      schedulerRunning: false,
      audio: this.clock.getAudioState(),
      localMuted: this.clock.isLocallyMuted(),
      jumpAlert: null,
      wakeLock: this.wakeLock.getStatus(),
      wakeMode: this.wakeLock.getMode(),
    }
  }

  private patch(partial: Partial<SessionSnapshot>): void {
    const merged: SessionSnapshot = { ...this.snapshot, ...partial }
    merged.schedulerRunning = this.clock.isRunning()
    merged.audio = this.clock.getAudioState()
    merged.localMuted = this.clock.isLocallyMuted()
    merged.wakeLock = this.wakeLock.getStatus()
    merged.wakeMode = this.wakeLock.getMode()
    const clock = merged.connected ? merged.clock : null
    merged.linkState = computeLinkState({
      connected: merged.connected,
      sampleCount: clock?.sampleCount ?? 0,
      jitterMs: clock?.jitterMs ?? null,
      rttMs: clock?.rttMs ?? null,
      schedulerRunning: merged.schedulerRunning,
    })
    this.snapshot = merged
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A UI listener must never break the session.
      }
    }
  }
}

export const session = new SessionController(syncService, flywheelClock)
