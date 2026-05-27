/** Bandait Protocol v2 — shared between leader and follower. */

export enum MessageType {
  SYNC_BEACON = "SYNC_BEACON",
  STATE_UPDATE = "STATE_UPDATE",
  SONG_LOAD = "SONG_LOAD",
  PLAY = "PLAY",
  STOP = "STOP",
  PANIC = "PANIC",
  FULL_STATE = "FULL_STATE",
}

export interface SessionState {
  sessionId: string;
  leaderIp: string;
  status: "IDLE" | "COUNTING" | "PLAYING" | "PAUSED";
  currentSongId: string | null;
  nextEventTimestamp: number; // leader time in ms
  bpm: number;
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
