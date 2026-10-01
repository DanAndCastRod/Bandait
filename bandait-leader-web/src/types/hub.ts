/**
 * Bandait Cloud & Web Admin Hub Types
 * Multi-band, Google Auth, Setlists, Stems & Technical Equipment
 */

export type MemberRole = 'Owner' | 'MusicDirector' | 'Musician' | 'Substitute' | 'SoundEngineer'

/**
 * Origen de la identidad del usuario del Hub:
 * - supabase: Google via Supabase Auth. Unica identidad verificada y unica que sincroniza con la nube.
 * - google_local: boton de Google Identity Services. El token NO se verifica en un servidor:
 *   es un perfil local de este navegador, sin nube.
 * - local: perfil local creado con nombre y correo. Sin verificacion, sin nube.
 * - demo: perfiles de demostracion con datos ficticios. Sin nube.
 */
export type AuthProvider = 'supabase' | 'google_local' | 'local' | 'demo'

export interface UserProfile {
  id: string
  name: string
  email: string
  avatarUrl?: string
  authProvider: AuthProvider
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

/** Workspace completo de un usuario: lo que se guarda en localStorage y en la fila de Supabase. */
export interface WorkspaceStore {
  bands: Band[]
  activeBandId: string
  membersMap: Record<string, BandMember[]>
  playlistsMap: Record<string, Playlist[]>
  equipmentMap: Record<string, EquipmentItem[]>
  stemsMap: Record<string, SongStems>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validacion defensiva de forma (datos de localStorage o de la nube pueden venir corruptos). */
export function isWorkspaceStore(value: unknown): value is WorkspaceStore {
  if (!isPlainObject(value)) return false
  const bands = value.bands
  if (!Array.isArray(bands) || bands.length === 0) return false
  if (!bands.every((b) => isPlainObject(b) && typeof b.id === 'string' && typeof b.name === 'string')) return false
  if (typeof value.activeBandId !== 'string') return false
  return (
    isPlainObject(value.membersMap) &&
    isPlainObject(value.playlistsMap) &&
    isPlainObject(value.equipmentMap) &&
    isPlainObject(value.stemsMap)
  )
}
