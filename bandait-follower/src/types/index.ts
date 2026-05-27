export interface SessionState {
  session_id: string
  leader_ip: string
  status: 'IDLE' | 'COUNTING' | 'PLAYING' | 'PAUSED'
  current_song_id: string | null
  next_event_timestamp: number
  bpm: number
  beat: number
}

export interface Song {
  id: string
  title: string
  bpm: number
  key?: string
  segments?: Array<{ label: string; bars: number }>
  lyrics?: Array<{ time: number; text: string }>
  audio_path?: string | null
}

export type NetworkHealth = 'good' | 'warning' | 'critical'
