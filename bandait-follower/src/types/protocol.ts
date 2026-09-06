/** Bandait Protocol v2 — shared between leader and follower. */

export enum MessageType {
  SYNC_BEACON = "SYNC_BEACON",
  STATE_UPDATE = "STATE_UPDATE",
  SONG_LOAD = "SONG_LOAD",
  PLAY = "PLAY",
  STOP = "STOP",
  PANIC = "PANIC",
  FULL_STATE = "FULL_STATE",
  SETLIST_JUMP = "SETLIST_JUMP",
  COMMAND_ACK = "COMMAND_ACK",
}

export interface SetlistJumpAlert {
  song_id: string;
  title: string;
  order_index: number;
  previous_song_id?: string;
  triggered_by: string;
  timestamp_ns: number;
}

export type CommandType =
  | 'PLAY'
  | 'STOP'
  | 'PAUSE'
  | 'CUE_NEXT'
  | 'CUE_PREV'
  | 'JUMP_SONG'
  | 'TEMPO_NUDGE'
  | 'PANIC';

export interface ConcurrentCommand {
  command_id: string;
  command_type: CommandType;
  origin: string; // 'laptop' | 'director_mobile' | 'foh'
  sender_user_id: string;
  session_id: string;
  timestamp_ns: number;
  payload?: Record<string, unknown>;
}

export interface SessionState {
  sessionId: string;
  leaderIp: string;
  status: "IDLE" | "COUNTING" | "PLAYING" | "PAUSED";
  currentSongId: string | null;
  nextEventTimestamp: number; // leader time in ms
  bpm: number;
  beat: number; // 1-4
  bar?: number;
  jump_alert?: SetlistJumpAlert | null;
}

export interface Song {
  id: string;
  title: string;
  bpm: number;
  segments: Array<{ label: string; bars: number }>;
  lyrics: Array<{ time: number; text: string }>;
}

export interface SyncResult {
  rttMs: number;
  offsetMs: number;
  timestampMs: number;
}

export interface NetworkMessage {
  type: MessageType;
  sessionId: string;
  payload: Record<string, unknown>;
}
