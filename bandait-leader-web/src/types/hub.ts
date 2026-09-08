/**
 * Bandait Cloud & Web Admin Hub Types
 * Multi-band, Google Auth, Setlists, Stems & Technical Equipment
 */

export type MemberRole = 'Owner' | 'MusicDirector' | 'Musician' | 'Substitute' | 'SoundEngineer'

export interface UserProfile {
  id: string
  name: string
  email: string
  avatarUrl?: string
  authProvider: 'google' | 'guest'
  createdAt: string
}

export interface BandMember {
  id: string
  bandId: string
  userId: string
  name: string
  email: string
  phone?: string
  role: MemberRole
  instrument: string
  joinedAt: string
}

export interface Band {
  id: string
  name: string
  genre?: string
  ownerId: string
  currentUserRole: MemberRole
  membersCount: number
  createdAt: string
}

export type TransitionMode = 'manual_cue' | 'auto_count_in' | 'gapless'

export interface PlaylistSong {
  id: string
  orderIndex: number
  title: string
  artist: string
  bpm: number
  key: string
  showKey: string
  camelot: string
  durationSec: number
  transitionMode: TransitionMode
  countInBars: number
  notes?: string
}

export interface Playlist {
  id: string
  bandId: string
  name: string
  description?: string
  songs: PlaylistSong[]
  createdAt: string
  updatedAt: string
}

export type StemChannel = 1 | 2 | 3 | 4 | 5 | 6

export interface StemTrack {
  channel: StemChannel
  id: string
  name: string
  code: string
  filename?: string
  fileSizeMb?: number
  volumeDb: number // Reference gain (-60 to +6 dB)
  pan: number // -1.0 to 1.0
  limiterSafe: boolean // Safety limiter at -0.5 dBFS
  demucsStatus: 'ready' | 'processing' | 'unprocessed'
}

export interface SongStems {
  songId: string
  songTitle: string
  bpm: number
  tracks: StemTrack[]
}

export type EquipmentCategory = 'interface' | 'in_ear' | 'mic' | 'cabling' | 'instrument'

export interface EquipmentItem {
  id: string
  bandId: string
  category: EquipmentCategory
  name: string
  model: string
  assignedTo: string
  channelRouting: string
  rfFrequency?: string
  notes?: string
}
