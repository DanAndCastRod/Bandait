/**
 * Bandait protocol v3: domain types used by the follower app.
 *
 * These are camelCase on purpose. The wire format (snake_case, normative in
 * bandait-protocol/CONTRACT_V3.md) lives only in src/protocol/wire.ts, which
 * decodes and encodes at the boundary. Nothing else in the app should touch
 * raw socket payloads.
 */

export const PROTOCOL_VERSION = 3

export type TransportStatus = 'IDLE' | 'COUNTING' | 'PLAYING' | 'PAUSED'
export const TRANSPORT_STATUSES: readonly TransportStatus[] = ['IDLE', 'COUNTING', 'PLAYING', 'PAUSED']

export type ClientRole = 'musician' | 'director' | 'foh' | 'hub'
export const CLIENT_ROLES: readonly ClientRole[] = ['musician', 'director', 'foh', 'hub']

/** Roles this follower app can join as. */
export type FollowerRole = Extract<ClientRole, 'musician' | 'director'>

export type CommandOrigin = 'director_mobile' | 'laptop_foh' | 'hub'
export const COMMAND_ORIGINS: readonly CommandOrigin[] = ['director_mobile', 'laptop_foh', 'hub']

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
export const COMMAND_TYPES: readonly CommandType[] = [
  'PLAY',
  'STOP',
  'PAUSE',
  'RESUME',
  'CUE_NEXT',
  'CUE_PREV',
  'JUMP_SONG',
  'TEMPO_NUDGE',
  'PANIC',
]

export type TransitionMode = 'manual_cue' | 'auto_count_in' | 'gapless'
export const TRANSITION_MODES: readonly TransitionMode[] = ['manual_cue', 'auto_count_in', 'gapless']

export type CommandRejectReason = 'invalid_type' | 'conflict' | 'no_setlist' | 'out_of_range'
export const COMMAND_REJECT_REASONS: readonly CommandRejectReason[] = [
  'invalid_type',
  'conflict',
  'no_setlist',
  'out_of_range',
]

export interface SetlistEntry {
  songId: string
  title: string
  bpm: number
  orderIndex: number
  transitionMode: TransitionMode
}

export interface LastCommand {
  commandId: string
  type: CommandType
  origin: CommandOrigin
}

/** SessionState (contract section 4). All *Ns fields are leader monotonic time. */
export interface SessionState {
  protocolVersion: number
  /**
   * UUID of the leader process. When it changes the leader restarted and the
   * follower restarts its state_version tracking (contract section 4).
   */
  leaderInstanceId: string
  sessionId: string
  status: TransportStatus
  stateVersion: number
  currentSongId: string | null
  currentOrderIndex: number | null
  bpm: number
  beatsPerBar: number
  /** Null unless PLAYING or COUNTING (the decoder enforces it). */
  anchorNs: number | null
  barOffset: number
  pausedBar: number | null
  leaderTimeNs: number
  setlist: SetlistEntry[]
  lastCommand: LastCommand | null
}

export interface JoinSessionRequest {
  sessionId: string
  clientId: string
  role: ClientRole
  alias: string
}

export interface JoinAck {
  sessionId: string
  protocolVersion: number
  /** Present on v3 leaders that follow the 2026-09-30 contract revision. */
  leaderInstanceId: string | null
  leaderTimeNs: number
}

/** GET /leader-info.json (contract section 8): the follower is served by the leader. */
export interface LeaderInfo {
  protocolVersion: number
  leaderInstanceId: string
  sessionId: string
  ip: string
  port: number
  followerUrl: string
  directorUrl: string
}

export interface SyncAck {
  clientSendMs: number
  leaderTimeNs: number
}

export interface BeatBeacon {
  sessionId: string
  stateVersion: number
  anchorNs: number
  bpm: number
  beatsPerBar: number
  barOffset: number
  leaderTimeNs: number
}

export interface SetlistJump {
  sessionId: string
  songId: string
  title: string
  orderIndex: number
  previousSongId: string | null
  triggeredBy: CommandOrigin
  timestampNs: number
}

export interface PeerEvent {
  sid: string
  clientId: string
  alias: string
  role: ClientRole
}

export interface CommandAck {
  commandId: string
  accepted: boolean
  duplicate: boolean
  actionTaken: string
  reason: CommandRejectReason | null
  stateVersion: number
  state: SessionState
}

export type EmptyPayload = Record<string, never>

/** Domain payload per command type (contract section 3). */
export interface CommandPayloadMap {
  PLAY: EmptyPayload
  STOP: EmptyPayload
  PAUSE: EmptyPayload
  RESUME: EmptyPayload
  /** expectedSongId is filled automatically by SyncService from the last known state. */
  CUE_NEXT: { expectedSongId?: string }
  CUE_PREV: { expectedSongId?: string }
  JUMP_SONG: { songId: string } | { orderIndex: number }
  TEMPO_NUDGE: { deltaBpm: number }
  PANIC: EmptyPayload
}

export interface ControlCommand<T extends CommandType = CommandType> {
  sessionId: string
  commandId: string
  type: T
  origin: CommandOrigin
  senderId: string
  payload?: CommandPayloadMap[T]
}

/** Signature shared by everything that can send a control command. */
export type CommandSender = <T extends CommandType>(
  type: T,
  payload?: CommandPayloadMap[T],
) => Promise<CommandAck>
