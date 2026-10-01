/**
 * Cliente Socket.IO del Hub hacia el lider de escritorio, alineado con
 * bandait-protocol/CONTRACT_V3.md. Este modulo es la frontera de codificacion: en el
 * cable todo va en snake_case.
 *
 * HOY NO SE USA EN PRODUCCION. El Hub se publica en https://bandait.releven.cc/hub/ y una
 * pagina HTTPS no puede abrir ws:// hacia un lider en la LAN (el navegador lo bloquea como
 * contenido mixto). Por eso StageView/TransportBar no se montan y el control de transporte
 * del director vive en el follower PWA. Queda listo para un Hub servido por http desde la LAN.
 */
import { io, type Socket } from 'socket.io-client'
import { uuidv4 } from './uuid'

export const PROTOCOL_VERSION = 3

export type CommandType =
  | 'PLAY'
  | 'STOP'
  | 'PAUSE'
  | 'RESUME'
  | 'CUE_NEXT'
  | 'CUE_PREV'
  | 'JUMP_SONG'
  | 'TEMPO_NUDGE'
  | 'PANIC'

export type SessionStatusV3 = 'IDLE' | 'COUNTING' | 'PLAYING' | 'PAUSED'
export type TransitionModeV3 = 'manual_cue' | 'auto_count_in' | 'gapless'

export interface SetlistEntryV3 {
  song_id: string
  title: string
  bpm: number
  order_index: number
  transition_mode: TransitionModeV3
}

export interface SessionStateV3 {
  protocol_version: number
  session_id: string
  status: SessionStatusV3
  state_version: number
  current_song_id: string | null
  current_order_index: number | null
  bpm: number
  beats_per_bar: number
  anchor_ns: number | null
  bar_offset: number
  paused_bar: number | null
  leader_time_ns: number
  setlist: SetlistEntryV3[]
  last_command: { command_id: string; type: CommandType; origin: string } | null
}

export interface JoinAckV3 {
  status: 'joined'
  session_id: string
  protocol_version: number
  leader_time_ns: number
}

export interface CommandAckV3 {
  command_id: string
  accepted: boolean
  duplicate: boolean
  action_taken: string
  reason: null | 'invalid_type' | 'conflict' | 'no_setlist' | 'out_of_range'
  state_version: number
  state: SessionStateV3
}

export interface BeatBeaconV3 {
  session_id: string
  state_version: number
  anchor_ns: number
  bpm: number
  beats_per_bar: number
  bar_offset: number
  leader_time_ns: number
}

export interface SetlistJumpV3 {
  session_id: string
  song_id: string
  title: string
  order_index: number
  previous_song_id: string | null
  triggered_by: string
  timestamp_ns: number
}

/** Payload por tipo de comando (seccion 3 del contrato). */
export type CommandPayload =
  | Record<string, never>
  | { song_id: string }
  | { order_index: number }
  | { expected_song_id?: string }
  | { delta_bpm: number }

export interface ControlCommandV3 {
  session_id: string
  command_id: string
  type: CommandType
  origin: 'hub'
  sender_id: string
  payload: CommandPayload
}

export interface SyncSample {
  rtt_ms: number
  offset_ms: number
  leader_time_ns: number
}

export class LeaderAckTimeoutError extends Error {
  constructor(event: string, timeoutMs: number) {
    super(`El lider no respondio "${event}" en ${timeoutMs} ms.`)
    this.name = 'LeaderAckTimeoutError'
  }
}

function isMixedContent(leaderUrl: string): boolean {
  if (typeof window === 'undefined') return false
  return window.location.protocol === 'https:' && /^(http|ws):\/\//i.test(leaderUrl)
}

class HubSocketService {
  private socket: Socket | null = null
  private sessionId = 'default'
  private alias = 'Web Hub'
  private readonly clientId = uuidv4()
  private stateListeners = new Set<(state: SessionStateV3) => void>()
  private beaconListeners = new Set<(beacon: BeatBeaconV3) => void>()
  private jumpListeners = new Set<(jump: SetlistJumpV3) => void>()
  private connectionListeners = new Set<(connected: boolean) => void>()

  /**
   * Conecta al lider y se une a la sesion con role "hub". Lanza Error si la pagina es
   * HTTPS y el lider es http/ws (contenido mixto: el navegador lo bloquearia igual).
   */
  connect(leaderUrl: string, options: { sessionId?: string; alias?: string } = {}): void {
    if (isMixedContent(leaderUrl)) {
      throw new Error(
        'Una pagina HTTPS no puede conectarse a un lider http/ws en la LAN (contenido mixto). Usa el follower PWA para el control en vivo.'
      )
    }
    this.disconnect()
    this.sessionId = options.sessionId ?? 'default'
    this.alias = options.alias ?? this.alias
    const socket = io(leaderUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
    })
    this.socket = socket

    socket.on('connect', () => {
      this.connectionListeners.forEach((cb) => cb(true))
      // El lider responde por ack y ademas emite full_state a este socket.
      this.join().catch((err: unknown) => console.warn('[Socket] join_session sin respuesta:', err))
    })
    socket.on('disconnect', () => this.connectionListeners.forEach((cb) => cb(false)))
    socket.on('full_state', (state: SessionStateV3) => this.stateListeners.forEach((cb) => cb(state)))
    socket.on('state_update', (state: SessionStateV3) => this.stateListeners.forEach((cb) => cb(state)))
    socket.on('beat_beacon', (beacon: BeatBeaconV3) => this.beaconListeners.forEach((cb) => cb(beacon)))
    socket.on('setlist_jump', (jump: SetlistJumpV3) => this.jumpListeners.forEach((cb) => cb(jump)))
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.disconnect()
      this.socket = null
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false
  }

  join(timeoutMs = 3000): Promise<JoinAckV3> {
    return this.emitWithAck<JoinAckV3>(
      'join_session',
      {
        session_id: this.sessionId,
        client_id: this.clientId,
        role: 'hub',
        alias: this.alias,
        protocol_version: PROTOCOL_VERSION,
      },
      timeoutMs
    )
  }

  /**
   * Envia un control_command y espera el command_ack. Si vence el timeout reintenta con el
   * MISMO command_id (idempotente segun el contrato: el lider devuelve duplicate: true).
   * La promesa se resuelve con el ack aunque accepted sea false; quien llama decide.
   */
  async sendCommand(
    type: CommandType,
    payload: CommandPayload = {},
    options: { timeoutMs?: number; retries?: number } = {}
  ): Promise<CommandAckV3> {
    const timeoutMs = options.timeoutMs ?? 2000
    const retries = options.retries ?? 1
    const message: ControlCommandV3 = {
      session_id: this.sessionId,
      command_id: uuidv4(),
      type,
      origin: 'hub',
      sender_id: this.clientId,
      payload,
    }
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.emitWithAck<CommandAckV3>('control_command', message, timeoutMs)
      } catch (err) {
        lastError = err
        if (!(err instanceof LeaderAckTimeoutError)) throw err
      }
    }
    throw lastError
  }

  /** Una muestra de sincronizacion estilo NTP (seccion 2 del contrato). */
  async syncRequest(timeoutMs = 1000): Promise<SyncSample> {
    const client_send_ms = performance.now()
    const ack = await this.emitWithAck<{ client_send_ms: number; leader_time_ns: number }>(
      'sync_request',
      { client_send_ms },
      timeoutMs
    )
    const t3 = performance.now()
    return {
      rtt_ms: t3 - ack.client_send_ms,
      offset_ms: ack.leader_time_ns / 1e6 - (ack.client_send_ms + t3) / 2,
      leader_time_ns: ack.leader_time_ns,
    }
  }

  onState(cb: (state: SessionStateV3) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  onBeatBeacon(cb: (beacon: BeatBeaconV3) => void): () => void {
    this.beaconListeners.add(cb)
    return () => this.beaconListeners.delete(cb)
  }

  onSetlistJump(cb: (jump: SetlistJumpV3) => void): () => void {
    this.jumpListeners.add(cb)
    return () => this.jumpListeners.delete(cb)
  }

  onConnectionChange(cb: (connected: boolean) => void): () => void {
    this.connectionListeners.add(cb)
    return () => this.connectionListeners.delete(cb)
  }

  private emitWithAck<T>(event: string, data: unknown, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.socket
      if (!socket || !socket.connected) {
        reject(new Error('Sin conexion con el lider.'))
        return
      }
      socket.timeout(timeoutMs).emit(event, data, (err: Error | null, response: T) => {
        if (err) reject(new LeaderAckTimeoutError(event, timeoutMs))
        else resolve(response)
      })
    })
  }
}

export const socketService = new HubSocketService()
