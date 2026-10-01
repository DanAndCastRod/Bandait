/**
 * Bandait protocol v3 wire boundary (follower side).
 *
 * This is the ONLY module that knows the snake_case wire format defined in
 * bandait-protocol/CONTRACT_V3.md. Every payload that arrives from the socket
 * goes through a decode* function, which validates and narrows `unknown` into
 * a domain type or returns an error. Decoders never throw to the caller and
 * never crash on malformed input. Every outgoing payload is built by an
 * encode* function.
 */

import {
  BeatBeacon,
  CLIENT_ROLES,
  COMMAND_ORIGINS,
  COMMAND_REJECT_REASONS,
  COMMAND_TYPES,
  ClientRole,
  CommandAck,
  CommandOrigin,
  CommandPayloadMap,
  CommandRejectReason,
  CommandType,
  ControlCommand,
  JoinAck,
  JoinSessionRequest,
  LastCommand,
  LeaderInfo,
  PROTOCOL_VERSION,
  PeerEvent,
  SessionState,
  SetlistEntry,
  SetlistJump,
  SyncAck,
  TRANSITION_MODES,
  TRANSPORT_STATUSES,
  TransitionMode,
  TransportStatus,
} from '../types/protocol'

// ---------------------------------------------------------------------------
// Wire types (snake_case, exactly as on the socket)
// ---------------------------------------------------------------------------

export interface WireJoinSessionRequest {
  session_id: string
  client_id: string
  role: ClientRole
  alias: string
  protocol_version: number
}

export interface WireJoinSessionAck {
  status: 'joined'
  session_id: string
  protocol_version: number
  leader_instance_id?: string
  leader_time_ns: number
}

/** GET /leader-info.json (contract section 8). */
export interface WireLeaderInfo {
  protocol_version: number
  leader_instance_id: string
  session_id: string
  ip: string
  port: number
  follower_url: string
  director_url: string
}

export interface WireSyncRequest {
  client_send_ms: number
}

export interface WireSyncRequestAck {
  client_send_ms: number
  leader_time_ns: number
}

export type WireCommandPayload =
  | Record<string, never>
  | { expected_song_id: string }
  | { song_id: string }
  | { order_index: number }
  | { delta_bpm: number }

export interface WireControlCommand {
  session_id: string
  command_id: string
  type: CommandType
  origin: CommandOrigin
  sender_id: string
  payload: WireCommandPayload
}

export interface WireSetlistEntry {
  song_id: string
  title: string
  bpm: number
  order_index: number
  transition_mode: TransitionMode
}

export interface WireLastCommand {
  command_id: string
  type: CommandType
  origin: CommandOrigin
}

export interface WireSessionState {
  protocol_version: number
  leader_instance_id: string
  session_id: string
  status: TransportStatus
  state_version: number
  current_song_id: string | null
  current_order_index: number | null
  bpm: number
  beats_per_bar: number
  anchor_ns: number | null
  bar_offset: number
  paused_bar: number | null
  leader_time_ns: number
  setlist: WireSetlistEntry[]
  last_command: WireLastCommand | null
}

export interface WireCommandAck {
  command_id: string
  accepted: boolean
  duplicate: boolean
  action_taken: string
  reason: CommandRejectReason | null
  state_version: number
  state: WireSessionState
}

export interface WireBeatBeacon {
  session_id: string
  state_version: number
  anchor_ns: number
  bpm: number
  beats_per_bar: number
  bar_offset: number
  leader_time_ns: number
}

export interface WireSetlistJump {
  session_id: string
  song_id: string
  title: string
  order_index: number
  previous_song_id: string | null
  triggered_by: CommandOrigin
  timestamp_ns: number
}

export interface WirePeerEvent {
  sid: string
  client_id: string
  alias: string
  role: ClientRole
}

/** Socket.IO event names (contract sections 3 and 4). */
export const WireEvent = {
  JOIN_SESSION: 'join_session',
  SYNC_REQUEST: 'sync_request',
  CONTROL_COMMAND: 'control_command',
  FULL_STATE: 'full_state',
  STATE_UPDATE: 'state_update',
  BEAT_BEACON: 'beat_beacon',
  SETLIST_JUMP: 'setlist_jump',
  FOLLOWER_JOINED: 'follower_joined',
  FOLLOWER_LEFT: 'follower_left',
} as const

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type WireResult<T> = { ok: true; value: T } | { ok: false; error: string }

class WireError extends Error {}

function run<T>(fn: () => T): WireResult<T> {
  try {
    return { ok: true, value: fn() }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

// ---------------------------------------------------------------------------
// Field readers (throw WireError; wrapped by run())
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

function asObject(value: unknown, path: string): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WireError(`${path}: se esperaba un objeto`)
  }
  return value as Obj
}

function has(o: Obj, key: string, path: string): unknown {
  if (!(key in o)) throw new WireError(`${path}.${key}: campo requerido ausente`)
  return o[key]
}

function str(o: Obj, key: string, path: string, opts: { nonEmpty?: boolean } = {}): string {
  const v = has(o, key, path)
  if (typeof v !== 'string') throw new WireError(`${path}.${key}: se esperaba string`)
  if (opts.nonEmpty && v.length === 0) throw new WireError(`${path}.${key}: string vacio`)
  return v
}

function nullableStr(o: Obj, key: string, path: string): string | null {
  const v = has(o, key, path)
  if (v === null) return null
  if (typeof v !== 'string') throw new WireError(`${path}.${key}: se esperaba string o null`)
  return v
}

function bool(o: Obj, key: string, path: string): boolean {
  const v = has(o, key, path)
  if (typeof v !== 'boolean') throw new WireError(`${path}.${key}: se esperaba boolean`)
  return v
}

function finiteNumber(o: Obj, key: string, path: string): number {
  const v = has(o, key, path)
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new WireError(`${path}.${key}: se esperaba numero finito`)
  }
  return v
}

function int(o: Obj, key: string, path: string, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const v = has(o, key, path)
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new WireError(`${path}.${key}: se esperaba entero`)
  }
  if (v < min || v > max) throw new WireError(`${path}.${key}: fuera de rango [${min}, ${max}]`)
  return v
}

function nullableInt(o: Obj, key: string, path: string, min?: number, max?: number): number | null {
  const v = has(o, key, path)
  if (v === null) return null
  return int(o, key, path, min, max)
}

/** Leader monotonic nanoseconds: non-negative safe integer (contract section 2). */
function ns(o: Obj, key: string, path: string): number {
  return int(o, key, path, 0)
}

function nullableNs(o: Obj, key: string, path: string): number | null {
  return nullableInt(o, key, path, 0)
}

function oneOf<T extends string>(o: Obj, key: string, path: string, allowed: readonly T[]): T {
  const v = has(o, key, path)
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new WireError(`${path}.${key}: valor no permitido (${String(v)})`)
  }
  return v as T
}

function bpmField(o: Obj, key: string, path: string): number {
  const v = finiteNumber(o, key, path)
  // Sanity bound only: a zero or negative bpm would divide by zero in the
  // scheduler. The musical range (40..260) is enforced by the leader.
  if (v <= 0 || v > 1000) throw new WireError(`${path}.${key}: bpm fuera de rango (${v})`)
  return v
}

function protocolVersionField(o: Obj, path: string): number {
  const v = int(o, 'protocol_version', path)
  if (v !== PROTOCOL_VERSION) {
    throw new WireError(`${path}.protocol_version: version ${v} incompatible (se requiere ${PROTOCOL_VERSION})`)
  }
  return v
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

function readSetlistEntry(value: unknown, path: string): SetlistEntry {
  const o = asObject(value, path)
  return {
    songId: str(o, 'song_id', path, { nonEmpty: true }),
    title: str(o, 'title', path),
    bpm: bpmField(o, 'bpm', path),
    orderIndex: int(o, 'order_index', path, 0),
    transitionMode: oneOf(o, 'transition_mode', path, TRANSITION_MODES),
  }
}

function readLastCommand(value: unknown, path: string): LastCommand | null {
  if (value === null) return null
  const o = asObject(value, path)
  return {
    commandId: str(o, 'command_id', path, { nonEmpty: true }),
    type: oneOf(o, 'type', path, COMMAND_TYPES),
    origin: oneOf(o, 'origin', path, COMMAND_ORIGINS),
  }
}

function readSessionState(value: unknown, path: string): SessionState {
  const o = asObject(value, path)
  // First: a leader on another protocol version must be reported as such.
  const protocolVersion = protocolVersionField(o, path)
  const status = oneOf(o, 'status', path, TRANSPORT_STATUSES)
  const anchorNs = nullableNs(o, 'anchor_ns', path)
  const clicking = status === 'PLAYING' || status === 'COUNTING'
  if (clicking && anchorNs === null) {
    throw new WireError(`${path}.anchor_ns: requerido cuando status es ${status}`)
  }
  const setlistRaw = has(o, 'setlist', path)
  if (!Array.isArray(setlistRaw)) throw new WireError(`${path}.setlist: se esperaba lista`)
  return {
    protocolVersion,
    leaderInstanceId: str(o, 'leader_instance_id', path, { nonEmpty: true }),
    sessionId: str(o, 'session_id', path, { nonEmpty: true }),
    status,
    stateVersion: int(o, 'state_version', path, 0),
    currentSongId: nullableStr(o, 'current_song_id', path),
    currentOrderIndex: nullableInt(o, 'current_order_index', path, 0),
    bpm: bpmField(o, 'bpm', path),
    beatsPerBar: int(o, 'beats_per_bar', path, 1, 32),
    // Contract: anchor_ns is null except in PLAYING/COUNTING. A stray anchor in
    // IDLE/PAUSED is normalized away so nothing downstream can click on it.
    anchorNs: clicking ? anchorNs : null,
    barOffset: int(o, 'bar_offset', path, 1),
    pausedBar: nullableInt(o, 'paused_bar', path),
    leaderTimeNs: ns(o, 'leader_time_ns', path),
    setlist: setlistRaw.map((entry, i) => readSetlistEntry(entry, `${path}.setlist[${i}]`)),
    lastCommand: readLastCommand(has(o, 'last_command', path), `${path}.last_command`),
  }
}

export function decodeSessionState(raw: unknown): WireResult<SessionState> {
  return run(() => readSessionState(raw, 'SessionState'))
}

export function decodeJoinAck(raw: unknown): WireResult<JoinAck> {
  return run(() => {
    const path = 'join_session_ack'
    const o = asObject(raw, path)
    const status = str(o, 'status', path)
    if (status !== 'joined') throw new WireError(`${path}.status: se esperaba "joined" (${status})`)
    const instance = o.leader_instance_id
    if (instance !== undefined && (typeof instance !== 'string' || instance.length === 0)) {
      throw new WireError(`${path}.leader_instance_id: se esperaba string no vacio`)
    }
    return {
      sessionId: str(o, 'session_id', path, { nonEmpty: true }),
      protocolVersion: protocolVersionField(o, path),
      leaderInstanceId: typeof instance === 'string' ? instance : null,
      leaderTimeNs: ns(o, 'leader_time_ns', path),
    }
  })
}

/** IPv4 / hostname as the leader advertises it: no scheme, port, path or spaces. */
function hostField(o: Obj, key: string, path: string): string {
  const v = str(o, key, path, { nonEmpty: true })
  if (/[\s/:?#@]/.test(v)) throw new WireError(`${path}.${key}: host invalido (${v})`)
  return v
}

export function decodeLeaderInfo(raw: unknown): WireResult<LeaderInfo> {
  return run(() => {
    const path = 'leader_info'
    const o = asObject(raw, path)
    return {
      protocolVersion: protocolVersionField(o, path),
      leaderInstanceId: str(o, 'leader_instance_id', path, { nonEmpty: true }),
      sessionId: str(o, 'session_id', path, { nonEmpty: true }),
      ip: hostField(o, 'ip', path),
      port: int(o, 'port', path, 1, 65535),
      followerUrl: str(o, 'follower_url', path),
      directorUrl: str(o, 'director_url', path),
    }
  })
}

export function decodeSyncAck(raw: unknown): WireResult<SyncAck> {
  return run(() => {
    const path = 'sync_request_ack'
    const o = asObject(raw, path)
    return {
      clientSendMs: finiteNumber(o, 'client_send_ms', path),
      leaderTimeNs: ns(o, 'leader_time_ns', path),
    }
  })
}

export function decodeCommandAck(raw: unknown): WireResult<CommandAck> {
  return run(() => {
    const path = 'command_ack'
    const o = asObject(raw, path)
    const accepted = bool(o, 'accepted', path)
    const reasonRaw = has(o, 'reason', path)
    let reason: CommandRejectReason | null = null
    if (reasonRaw !== null) reason = oneOf(o, 'reason', path, COMMAND_REJECT_REASONS)
    if (!accepted && reason === null) throw new WireError(`${path}.reason: requerido cuando accepted es false`)
    return {
      commandId: str(o, 'command_id', path, { nonEmpty: true }),
      accepted,
      duplicate: bool(o, 'duplicate', path),
      actionTaken: str(o, 'action_taken', path),
      reason: accepted ? null : reason,
      stateVersion: int(o, 'state_version', path, 0),
      state: readSessionState(has(o, 'state', path), `${path}.state`),
    }
  })
}

export function decodeBeatBeacon(raw: unknown): WireResult<BeatBeacon> {
  return run(() => {
    const path = 'beat_beacon'
    const o = asObject(raw, path)
    return {
      sessionId: str(o, 'session_id', path, { nonEmpty: true }),
      stateVersion: int(o, 'state_version', path, 0),
      anchorNs: ns(o, 'anchor_ns', path),
      bpm: bpmField(o, 'bpm', path),
      beatsPerBar: int(o, 'beats_per_bar', path, 1, 32),
      barOffset: int(o, 'bar_offset', path, 1),
      leaderTimeNs: ns(o, 'leader_time_ns', path),
    }
  })
}

export function decodeSetlistJump(raw: unknown): WireResult<SetlistJump> {
  return run(() => {
    const path = 'setlist_jump'
    const o = asObject(raw, path)
    return {
      sessionId: str(o, 'session_id', path, { nonEmpty: true }),
      songId: str(o, 'song_id', path, { nonEmpty: true }),
      title: str(o, 'title', path),
      orderIndex: int(o, 'order_index', path, 0),
      previousSongId: nullableStr(o, 'previous_song_id', path),
      triggeredBy: oneOf(o, 'triggered_by', path, COMMAND_ORIGINS),
      timestampNs: ns(o, 'timestamp_ns', path),
    }
  })
}

export function decodePeerEvent(raw: unknown): WireResult<PeerEvent> {
  return run(() => {
    const path = 'follower_event'
    const o = asObject(raw, path)
    return {
      sid: str(o, 'sid', path, { nonEmpty: true }),
      clientId: str(o, 'client_id', path),
      alias: str(o, 'alias', path),
      role: oneOf(o, 'role', path, CLIENT_ROLES),
    }
  })
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

export function encodeJoinSession(req: JoinSessionRequest): WireJoinSessionRequest {
  return {
    session_id: req.sessionId,
    client_id: req.clientId,
    role: req.role,
    alias: req.alias,
    protocol_version: PROTOCOL_VERSION,
  }
}

export function encodeSyncRequest(clientSendMs: number): WireSyncRequest {
  return { client_send_ms: clientSendMs }
}

function encodeCommandPayload<T extends CommandType>(type: T, payload: CommandPayloadMap[T] | undefined): WireCommandPayload {
  switch (type) {
    case 'JUMP_SONG': {
      const p = payload as CommandPayloadMap['JUMP_SONG'] | undefined
      if (p && 'songId' in p && typeof p.songId === 'string' && p.songId.length > 0) {
        return { song_id: p.songId }
      }
      if (p && 'orderIndex' in p && Number.isInteger(p.orderIndex) && p.orderIndex >= 0) {
        return { order_index: p.orderIndex }
      }
      throw new WireError('JUMP_SONG requiere songId o orderIndex (entero >= 0)')
    }
    case 'CUE_NEXT':
    case 'CUE_PREV': {
      const p = payload as CommandPayloadMap['CUE_NEXT'] | undefined
      if (p && typeof p.expectedSongId === 'string' && p.expectedSongId.length > 0) {
        return { expected_song_id: p.expectedSongId }
      }
      return {}
    }
    case 'TEMPO_NUDGE': {
      const p = payload as CommandPayloadMap['TEMPO_NUDGE'] | undefined
      if (!p || !Number.isInteger(p.deltaBpm) || p.deltaBpm === 0) {
        throw new WireError('TEMPO_NUDGE requiere deltaBpm entero distinto de 0')
      }
      return { delta_bpm: p.deltaBpm }
    }
    default:
      return {}
  }
}

/**
 * Builds a control_command payload. No client timestamp is ever included
 * (contract rule 10: the leader orders by its own receive time).
 */
export function encodeControlCommand<T extends CommandType>(cmd: ControlCommand<T>): WireResult<WireControlCommand> {
  return run(() => {
    if (!(COMMAND_TYPES as readonly string[]).includes(cmd.type)) {
      throw new WireError(`type no permitido: ${String(cmd.type)}`)
    }
    if (!cmd.sessionId) throw new WireError('session_id vacio')
    if (!cmd.commandId) throw new WireError('command_id vacio')
    return {
      session_id: cmd.sessionId,
      command_id: cmd.commandId,
      type: cmd.type,
      origin: cmd.origin,
      sender_id: cmd.senderId,
      payload: encodeCommandPayload(cmd.type, cmd.payload),
    }
  })
}
