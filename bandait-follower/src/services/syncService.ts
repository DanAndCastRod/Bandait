/**
 * Socket.IO link to the Bandait leader (contract v3, sections 2 to 5).
 *
 * - join_session with client_id / role / alias / protocol_version on every
 *   (re)connect; the leader answers with an ack and always a full_state.
 * - NTP-style sync_request with the client_send_ms echo. Exposes offset,
 *   median RTT and jitter (MAD of offsets) for the current connection only.
 * - Exactly one sync loop (a single setTimeout chain), cleared on disconnect.
 * - Infinite reconnection, backoff capped at 5 s.
 * - sendCommand(): UUID command_id, Socket.IO ack with a 2 s timeout and one
 *   retry with the SAME command_id (the leader deduplicates). Rejects at once
 *   when offline; never queues commands for later delivery.
 * - All payloads go through src/protocol/wire.ts.
 */

import { io } from 'socket.io-client'
import {
  WireEvent,
  decodeBeatBeacon,
  decodeCommandAck,
  decodeJoinAck,
  decodePeerEvent,
  decodeSessionState,
  decodeSetlistJump,
  decodeSyncAck,
  encodeControlCommand,
  encodeJoinSession,
  encodeSyncRequest,
} from '../protocol/wire'
import {
  BeatBeacon,
  CommandAck,
  CommandPayloadMap,
  CommandType,
  FollowerRole,
  JoinAck,
  PeerEvent,
  SessionState,
  SetlistJump,
} from '../types/protocol'
import { ClockEstimate, SyncSample, computeSyncSample, estimateClock } from './clockSync'
import { uuidv4 } from './identity'

// ---------------------------------------------------------------------------
// Socket abstraction (socket.io-client in production, a fake in tests)
// ---------------------------------------------------------------------------

export type SocketListenerFn = (...args: unknown[]) => void

export interface SocketLike {
  readonly connected: boolean
  /** socket.io: whether the client will keep trying to reconnect by itself. */
  readonly active?: boolean
  on(event: string, listener: SocketListenerFn): unknown
  emit(event: string, ...args: unknown[]): unknown
  connect(): unknown
  disconnect(): unknown
  removeAllListeners(): unknown
  readonly io?: {
    on(event: string, listener: SocketListenerFn): unknown
    removeAllListeners?(): unknown
  }
}

export interface SocketOptions {
  transports: string[]
  reconnection: boolean
  reconnectionAttempts: number
  reconnectionDelay: number
  reconnectionDelayMax: number
  randomizationFactor: number
  timeout: number
  forceNew: boolean
  autoConnect: boolean
}

export type SocketFactory = (url: string, options: SocketOptions) => SocketLike

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const RECONNECT_DELAY_MS = 500
export const RECONNECT_DELAY_MAX_MS = 5000
export const SYNC_BURST_COUNT = 8
export const SYNC_BURST_INTERVAL_MS = 150
export const SYNC_STEADY_INTERVAL_MS = 1000
export const SYNC_WINDOW = 15
export const SYNC_ACK_TIMEOUT_MS = 1000
export const JOIN_ACK_TIMEOUT_MS = 3000
export const JOIN_MAX_ATTEMPTS = 3
export const COMMAND_ACK_TIMEOUT_MS = 2000
export const COMMAND_MAX_ATTEMPTS = 2

export const SOCKET_OPTIONS: SocketOptions = {
  transports: ['websocket'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: RECONNECT_DELAY_MS,
  reconnectionDelayMax: RECONNECT_DELAY_MAX_MS,
  randomizationFactor: 0.3,
  timeout: 4000,
  forceNew: true,
  autoConnect: true,
}

const defaultSocketFactory: SocketFactory = (url, options) => io(url, options) as unknown as SocketLike

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export interface ConnectionInfo {
  phase: ConnectionPhase
  connected: boolean
  joined: boolean
  reconnectAttempt: number
  lastError: string | null
}

export type StateSource = 'full' | 'update' | 'ack' | 'beacon'

export interface SyncListener {
  onConnection?(info: ConnectionInfo): void
  onJoined?(ack: JoinAck): void
  onState?(state: SessionState, source: StateSource): void
  onBeacon?(beacon: BeatBeacon): void
  onSetlistJump?(jump: SetlistJump): void
  onPeer?(kind: 'joined' | 'left', peer: PeerEvent): void
  onClock?(estimate: ClockEstimate): void
  onProtocolError?(message: string): void
}

export interface SessionParams {
  url: string
  sessionId: string
  clientId: string
  role: FollowerRole
  alias: string
}

export type CommandFailureReason = 'offline' | 'timeout' | 'connection_lost' | 'invalid_ack' | 'invalid_payload'

export class CommandError extends Error {
  readonly reason: CommandFailureReason
  constructor(reason: CommandFailureReason, message: string) {
    super(message)
    this.name = 'CommandError'
    this.reason = reason
  }
}

class AckTimeoutError extends Error {}
class ConnectionLostError extends Error {}

interface AckReply {
  raw: unknown
  /** Local time at which the ack callback ran (t3 for sync). */
  at: number
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SyncService {
  private readonly factory: SocketFactory
  private readonly now: () => number

  private socket: SocketLike | null = null
  private params: SessionParams | null = null
  private listener: SyncListener | null = null

  /** Bumped on every connect/disconnect/teardown; stale callbacks compare it. */
  private epoch = 0
  private phase: ConnectionPhase = 'idle'
  private joined = false
  private reconnectAttempt = 0
  private lastError: string | null = null

  private samples: SyncSample[] = []
  private estimate: ClockEstimate | null = null
  private state: SessionState | null = null

  private syncTimer: ReturnType<typeof setTimeout> | null = null
  private syncBurstRemaining = 0
  private manualReconnectTimer: ReturnType<typeof setTimeout> | null = null
  private manualReconnectAttempt = 0
  private readonly pending = new Set<(err: Error) => void>()

  private lastLoggedError = ''
  private lastLoggedAt = 0

  constructor(deps: { socketFactory?: SocketFactory; now?: () => number } = {}) {
    this.factory = deps.socketFactory ?? defaultSocketFactory
    this.now = deps.now ?? (() => performance.now())
  }

  setListener(listener: SyncListener | null): void {
    this.listener = listener
  }

  // ------------------------------------------------------------- lifecycle

  connect(params: SessionParams): void {
    this.teardown()
    this.params = { ...params }
    this.state = null
    this.samples = []
    this.estimate = null
    this.lastError = null
    this.reconnectAttempt = 0
    this.manualReconnectAttempt = 0
    this.phase = 'connecting'
    this.emitConnection()

    let socket: SocketLike
    try {
      socket = this.factory(params.url, SOCKET_OPTIONS)
    } catch (err) {
      this.lastError = `No se pudo crear la conexion: ${describeError(err)}`
      this.phase = 'reconnecting'
      this.emitConnection()
      return
    }
    this.socket = socket
    this.bind(socket)
  }

  /** Explicit leave (SALIR). Stops everything, including reconnection. */
  disconnect(): void {
    this.teardown()
    this.params = null
    this.state = null
    this.samples = []
    this.estimate = null
    this.lastError = null
    this.reconnectAttempt = 0
    this.phase = 'idle'
    this.emitConnection()
  }

  private teardown(): void {
    const socket = this.socket
    this.socket = null
    this.epoch++
    this.stopSyncLoop()
    this.clearManualReconnect()
    this.rejectPending(new ConnectionLostError('sesion cerrada'))
    this.joined = false
    if (socket) {
      try {
        socket.removeAllListeners()
      } catch {
        // Ignore.
      }
      try {
        socket.io?.removeAllListeners?.()
      } catch {
        // Ignore.
      }
      try {
        socket.disconnect()
      } catch {
        // Ignore.
      }
    }
  }

  private bind(socket: SocketLike): void {
    const current = () => this.socket === socket
    socket.on('connect', () => {
      if (current()) this.onSocketConnect(socket)
    })
    socket.on('disconnect', (reason: unknown) => {
      if (current()) this.onSocketDisconnect(socket, String(reason ?? 'desconocido'))
    })
    socket.on('connect_error', (err: unknown) => {
      if (!current()) return
      this.lastError = `No se pudo conectar: ${describeError(err)}`
      this.phase = 'reconnecting'
      this.emitConnection()
      if (socket.active === false) this.scheduleManualReconnect(socket)
    })
    socket.on(WireEvent.FULL_STATE, (raw: unknown) => {
      if (current()) this.handleState(raw, 'full')
    })
    socket.on(WireEvent.STATE_UPDATE, (raw: unknown) => {
      if (current()) this.handleState(raw, 'update')
    })
    socket.on(WireEvent.BEAT_BEACON, (raw: unknown) => {
      if (current()) this.handleBeacon(raw)
    })
    socket.on(WireEvent.SETLIST_JUMP, (raw: unknown) => {
      if (current()) this.handleJump(raw)
    })
    socket.on(WireEvent.FOLLOWER_JOINED, (raw: unknown) => {
      if (current()) this.handlePeer('joined', raw)
    })
    socket.on(WireEvent.FOLLOWER_LEFT, (raw: unknown) => {
      if (current()) this.handlePeer('left', raw)
    })
    socket.io?.on('reconnect_attempt', (attempt: unknown) => {
      if (!current()) return
      this.reconnectAttempt = typeof attempt === 'number' ? attempt : this.reconnectAttempt + 1
      this.phase = 'reconnecting'
      this.emitConnection()
    })
  }

  private onSocketConnect(socket: SocketLike): void {
    this.epoch++
    this.clearManualReconnect()
    this.phase = 'connected'
    this.lastError = null
    this.reconnectAttempt = 0
    this.manualReconnectAttempt = 0
    this.joined = false
    // Fresh window: after a reconnect, phase corrections need NEW samples.
    this.samples = []
    this.estimate = null
    this.emitConnection()
    this.startSyncLoop()
    this.sendJoin(socket, this.epoch, 1)
  }

  private onSocketDisconnect(socket: SocketLike, reason: string): void {
    this.epoch++
    this.stopSyncLoop()
    this.rejectPending(new ConnectionLostError(reason))
    this.joined = false
    this.phase = 'reconnecting'
    this.lastError = `Conexion perdida (${reason})`
    this.emitConnection()
    // 'io server disconnect' disables socket.io auto-reconnect: do it by hand.
    if (socket.active === false) this.scheduleManualReconnect(socket)
  }

  private scheduleManualReconnect(socket: SocketLike): void {
    if (this.manualReconnectTimer !== null || this.socket !== socket) return
    this.manualReconnectAttempt += 1
    const exp = Math.min(this.manualReconnectAttempt - 1, 10)
    const delay = Math.min(RECONNECT_DELAY_MAX_MS, RECONNECT_DELAY_MS * 2 ** exp)
    this.reconnectAttempt = this.manualReconnectAttempt
    this.manualReconnectTimer = setTimeout(() => {
      this.manualReconnectTimer = null
      if (this.socket !== socket || socket.connected) return
      try {
        socket.connect()
      } catch (err) {
        this.lastError = `Reconexion fallida: ${describeError(err)}`
        this.emitConnection()
        this.scheduleManualReconnect(socket)
      }
    }, delay)
  }

  private clearManualReconnect(): void {
    if (this.manualReconnectTimer !== null) {
      clearTimeout(this.manualReconnectTimer)
      this.manualReconnectTimer = null
    }
  }

  private sendJoin(socket: SocketLike, epoch: number, attempt: number): void {
    const params = this.params
    if (!params) return
    const payload = encodeJoinSession({
      sessionId: params.sessionId,
      clientId: params.clientId,
      role: params.role,
      alias: params.alias,
    })
    this.emitWithAck(socket, WireEvent.JOIN_SESSION, payload, JOIN_ACK_TIMEOUT_MS)
      .then((reply) => {
        if (epoch !== this.epoch) return
        const ack = decodeJoinAck(reply.raw)
        if (!ack.ok) {
          this.reportProtocolError(`Union a la sesion invalida: ${ack.error}`)
          return
        }
        if (ack.value.sessionId !== params.sessionId) {
          this.reportProtocolError(`El lider confirmo otra sesion (${ack.value.sessionId})`)
          return
        }
        this.joined = true
        this.emitConnection()
        this.listener?.onJoined?.(ack.value)
      })
      .catch((err: unknown) => {
        if (epoch !== this.epoch) return
        if (err instanceof AckTimeoutError) {
          if (attempt < JOIN_MAX_ATTEMPTS && socket.connected) this.sendJoin(socket, epoch, attempt + 1)
          else this.reportProtocolError('El lider no confirmo la union a la sesion')
        }
      })
  }

  // ------------------------------------------------------------- sync loop

  private startSyncLoop(): void {
    this.stopSyncLoop()
    this.syncBurstRemaining = SYNC_BURST_COUNT
    this.queueSync(0)
  }

  private stopSyncLoop(): void {
    if (this.syncTimer !== null) {
      clearTimeout(this.syncTimer)
      this.syncTimer = null
    }
  }

  private queueSync(delay: number): void {
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      const socket = this.socket
      if (!socket || !socket.connected) return // restarted on the next 'connect'
      this.runSync(socket)
      if (this.syncBurstRemaining > 0) this.syncBurstRemaining -= 1
      this.queueSync(this.syncBurstRemaining > 0 ? SYNC_BURST_INTERVAL_MS : SYNC_STEADY_INTERVAL_MS)
    }, delay)
  }

  private runSync(socket: SocketLike): void {
    const sendMs = this.now()
    const epoch = this.epoch
    this.emitWithAck(socket, WireEvent.SYNC_REQUEST, encodeSyncRequest(sendMs), SYNC_ACK_TIMEOUT_MS)
      .then((reply) => {
        if (epoch !== this.epoch) return
        const ack = decodeSyncAck(reply.raw)
        if (!ack.ok) {
          this.reportProtocolError(`sync_request ack invalido: ${ack.error}`)
          return
        }
        if (Math.abs(ack.value.clientSendMs - sendMs) > 1e-6) return // not the echo of this request
        const sample = computeSyncSample(sendMs, ack.value.leaderTimeNs, reply.at)
        if (!sample) return
        this.samples.push(sample)
        if (this.samples.length > SYNC_WINDOW) this.samples.shift()
        this.estimate = estimateClock(this.samples)
        if (this.estimate) this.listener?.onClock?.(this.estimate)
      })
      .catch(() => {
        // Lost or late sample: simply not counted.
      })
  }

  // -------------------------------------------------------------- inbound

  private handleState(raw: unknown, source: 'full' | 'update'): void {
    const res = decodeSessionState(raw)
    if (!res.ok) {
      this.reportProtocolError(`${source === 'full' ? 'full_state' : 'state_update'} invalido: ${res.error}`)
      return
    }
    if (source === 'full' && !this.joined) {
      this.joined = true
      this.emitConnection()
    }
    this.acceptState(res.value, source)
  }

  /**
   * Version gate. full_state is always authoritative (it also covers a leader
   * restart, where state_version starts over). Everything else must be newer.
   */
  private acceptState(state: SessionState, source: StateSource): boolean {
    const params = this.params
    if (!params) return false
    if (state.sessionId !== params.sessionId) {
      this.reportProtocolError(`Estado de otra sesion ignorado (${state.sessionId})`)
      return false
    }
    const prev = this.state
    // A different leader_instance_id means the leader restarted: version tracking
    // starts over and the lower state_version is accepted (contract section 4).
    const sameInstance = prev !== null && prev.leaderInstanceId === state.leaderInstanceId
    if (source !== 'full' && prev && sameInstance && state.stateVersion <= prev.stateVersion) return false
    this.state = state
    this.listener?.onState?.(state, source)
    return true
  }

  private handleBeacon(raw: unknown): void {
    const res = decodeBeatBeacon(raw)
    if (!res.ok) {
      this.reportProtocolError(`beat_beacon invalido: ${res.error}`)
      return
    }
    const beacon = res.value
    if (!this.params || beacon.sessionId !== this.params.sessionId) return
    const st = this.state
    if (st) {
      if (beacon.stateVersion < st.stateVersion) return // stale (e.g. in flight across a STOP)
      if (beacon.stateVersion === st.stateVersion && st.status !== 'PLAYING' && st.status !== 'COUNTING') return
      if (beacon.stateVersion > st.stateVersion) {
        // A state_update was missed; the beacon is newer evidence of PLAYING.
        const merged: SessionState = {
          ...st,
          status: 'PLAYING',
          stateVersion: beacon.stateVersion,
          anchorNs: beacon.anchorNs,
          bpm: beacon.bpm,
          beatsPerBar: beacon.beatsPerBar,
          barOffset: beacon.barOffset,
          pausedBar: null,
          leaderTimeNs: beacon.leaderTimeNs,
        }
        this.state = merged
        this.listener?.onState?.(merged, 'beacon')
      }
    }
    this.listener?.onBeacon?.(beacon)
  }

  private handleJump(raw: unknown): void {
    const res = decodeSetlistJump(raw)
    if (!res.ok) {
      this.reportProtocolError(`setlist_jump invalido: ${res.error}`)
      return
    }
    if (!this.params || res.value.sessionId !== this.params.sessionId) return
    this.listener?.onSetlistJump?.(res.value)
  }

  private handlePeer(kind: 'joined' | 'left', raw: unknown): void {
    const res = decodePeerEvent(raw)
    if (!res.ok) {
      this.reportProtocolError(`follower_${kind} invalido: ${res.error}`)
      return
    }
    this.listener?.onPeer?.(kind, res.value)
  }

  // ------------------------------------------------------------- commands

  async sendCommand<T extends CommandType>(type: T, payload?: CommandPayloadMap[T]): Promise<CommandAck> {
    const params = this.params
    const socket = this.socket
    if (!params || !socket || !socket.connected) {
      throw new CommandError('offline', 'Sin conexion con el lider: el comando no se envio.')
    }
    let effective: CommandPayloadMap[T] | undefined = payload
    if ((type === 'CUE_NEXT' || type === 'CUE_PREV') && !(payload && 'expectedSongId' in payload)) {
      const expected = this.state?.currentSongId
      effective = (expected ? { expectedSongId: expected } : {}) as CommandPayloadMap[T]
    }
    const commandId = uuidv4()
    const encoded = encodeControlCommand({
      sessionId: params.sessionId,
      commandId,
      type,
      origin: 'director_mobile',
      senderId: params.clientId,
      payload: effective,
    })
    if (!encoded.ok) throw new CommandError('invalid_payload', `Comando invalido: ${encoded.error}`)

    for (let attempt = 1; attempt <= COMMAND_MAX_ATTEMPTS; attempt++) {
      const s = this.socket
      if (!s || !s.connected) {
        throw attempt === 1
          ? new CommandError('offline', 'Sin conexion con el lider: el comando no se envio.')
          : new CommandError('connection_lost', 'Se perdio la conexion antes de la confirmacion.')
      }
      let reply: AckReply
      try {
        // Same command_id on the retry: the leader returns the stored ack.
        reply = await this.emitWithAck(s, WireEvent.CONTROL_COMMAND, encoded.value, COMMAND_ACK_TIMEOUT_MS)
      } catch (err) {
        if (err instanceof AckTimeoutError) {
          if (attempt < COMMAND_MAX_ATTEMPTS) continue
          throw new CommandError('timeout', 'El lider no confirmo el comando tras reintentar.')
        }
        if (err instanceof ConnectionLostError) {
          throw new CommandError('connection_lost', 'Se perdio la conexion antes de la confirmacion.')
        }
        throw new CommandError('offline', `No se pudo enviar el comando: ${describeError(err)}`)
      }
      const ack = decodeCommandAck(reply.raw)
      if (!ack.ok) throw new CommandError('invalid_ack', `Respuesta invalida del lider: ${ack.error}`)
      if (ack.value.commandId !== commandId) {
        throw new CommandError('invalid_ack', 'El ack del lider no corresponde a este comando.')
      }
      this.acceptState(ack.value.state, 'ack')
      return ack.value
    }
    throw new CommandError('timeout', 'El lider no confirmo el comando tras reintentar.')
  }

  // -------------------------------------------------------------- helpers

  private emitWithAck(socket: SocketLike, event: string, payload: unknown, timeoutMs: number): Promise<AckReply> {
    return new Promise<AckReply>((resolve, reject) => {
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(fail)
        reject(err)
      }
      const timer = setTimeout(() => fail(new AckTimeoutError(`${event}: sin ack en ${timeoutMs} ms`)), timeoutMs)
      this.pending.add(fail)
      try {
        socket.emit(event, payload, (raw: unknown) => {
          if (settled) return
          const at = this.now()
          settled = true
          clearTimeout(timer)
          this.pending.delete(fail)
          resolve({ raw, at })
        })
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private rejectPending(err: Error): void {
    for (const fail of [...this.pending]) fail(err)
    this.pending.clear()
  }

  private reportProtocolError(message: string): void {
    const t = this.now()
    if (message !== this.lastLoggedError || t - this.lastLoggedAt > 5000) {
      console.warn(`[SYNC] ${message}`)
      this.lastLoggedError = message
      this.lastLoggedAt = t
    }
    this.listener?.onProtocolError?.(message)
  }

  private emitConnection(): void {
    this.listener?.onConnection?.(this.getConnectionInfo())
  }

  // -------------------------------------------------------------- getters

  getConnectionInfo(): ConnectionInfo {
    return {
      phase: this.phase,
      connected: this.socket?.connected ?? false,
      joined: this.joined,
      reconnectAttempt: this.reconnectAttempt,
      lastError: this.lastError,
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false
  }

  getState(): SessionState | null {
    return this.state
  }

  getClockEstimate(): ClockEstimate | null {
    return this.estimate
  }

  getParams(): SessionParams | null {
    return this.params ? { ...this.params } : null
  }

  /** leader_ms = local_ms + offset. Null until there is an estimate. */
  localToLeaderMs(localMs: number): number | null {
    return this.estimate ? localMs + this.estimate.offsetMs : null
  }

  leaderToLocalMs(leaderMs: number): number | null {
    return this.estimate ? leaderMs - this.estimate.offsetMs : null
  }
}

export const syncService = new SyncService()
