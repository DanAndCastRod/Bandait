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

/**
 * Item de un setlist (bandait-protocol/WORKSPACE_V2.md, seccion 3).
 * `title`, `artist` y `key` son copia de respaldo para mostrar; la fuente de verdad es la
 * Song de la libreria referida por `songId`. `bpm` y `showKey` son los de ESTE show.
 */
export interface PlaylistSong {
  id: string
  /** v2: id de la Song de la libreria de la misma banda. */
  songId: string
  orderIndex: number
  title: string
  artist: string
  bpm: number
  key: string
  showKey: string
  camelot: string
  durationSec: number
  /** Como se ENTRA a este item (lo ejecuta el lider). */
  transitionMode: TransitionMode
  /** 0..4 compases de conteo antes del compas 1. */
  countInBars: number
  /** v2: conteo hablado en esos compases (true por defecto). */
  countInVoice: boolean
  /** v2: pausa en segundos antes de un auto_count_in (0..30). */
  gapSec: number
  notes?: string
}

/** Tipos de seccion (WORKSPACE_V2.md, seccion 2). */
export type SectionKind =
  | 'intro'
  | 'verse'
  | 'pre_chorus'
  | 'chorus'
  | 'bridge'
  | 'solo'
  | 'interlude'
  | 'outro'
  | 'break'
  | 'custom'

export interface SongSection {
  id: string
  kind: SectionKind
  label: string
  /** Duracion en compases (entero >= 1). */
  bars: number
  /** Cuerpo ChordPro de la seccion, sin directivas {start_of_*}. Puede ser "". */
  chordpro: string
  /** Aviso hablado: ausente = texto por defecto segun kind; null = sin aviso; string = ese texto. */
  cueText?: string | null
}

/** Cancion de la libreria de una banda. El lider usa `id` (y el de cada seccion) como clave estable. */
export interface Song {
  id: string
  title: string
  artist: string
  /** 40..260 */
  bpm: number
  beatsPerBar: number
  beatUnit: number
  key: string
  camelot?: string
  durationSec?: number
  sections: SongSection[]
  notes?: string
  updatedAt: string
}

export type VoiceOutput = 'drummer' | 'all_in_ear'

/** Conteos y avisos de voz de una banda (WORKSPACE_V2.md, seccion 5). */
export interface VoiceConfig {
  enabled: boolean
  provider: 'azure'
  voice: string
  /** Prosodia SSML, "+0%".."+50%". */
  rate: string
  countIn: boolean
  sectionCues: boolean
  cueLeadBars: 1 | 2
  output: VoiceOutput
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

/**
 * Workspace completo de un usuario en su forma v2 (bandait-protocol/WORKSPACE_V2.md): lo que
 * se guarda en localStorage y en la fila de Supabase, y lo que descarga el lider de escritorio.
 * Siempre pasa por `migrateWorkspace` (services/workspaceSchema.ts) al cargarse.
 * Los campos desconocidos se conservan: un hub mas nuevo puede agregar campos.
 */
export interface WorkspaceStore {
  schemaVersion: number
  bands: Band[]
  activeBandId: string
  membersMap: Record<string, BandMember[]>
  playlistsMap: Record<string, Playlist[]>
  equipmentMap: Record<string, EquipmentItem[]>
  stemsMap: Record<string, SongStems>
  songsMap: Record<string, Song[]>
  voiceMap: Record<string, VoiceConfig>
}

/** Forma minima aceptada al cargar (v1 o v2, antes de migrar). */
export type WorkspaceInput = Omit<WorkspaceStore, 'schemaVersion' | 'songsMap' | 'voiceMap'> & {
  schemaVersion?: unknown
  songsMap?: unknown
  voiceMap?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validacion defensiva de forma (datos de localStorage, de la nube o de un JSON importado
 * pueden venir corruptos). Acepta v1 y v2; la validacion completa de v2 esta en
 * `validateWorkspace` (services/workspaceSchema.ts).
 */
export function isWorkspaceShape(value: unknown): value is WorkspaceInput {
  if (!isPlainObject(value)) return false
  const bands = value.bands
  if (!Array.isArray(bands) || bands.length === 0) return false
  if (!bands.every((b) => isPlainObject(b) && typeof b.id === 'string' && typeof b.name === 'string')) return false
  if (typeof value.activeBandId !== 'string') return false
  // songsMap / voiceMap con forma invalida no invalidan el workspace: la migracion los repara.
  return (
    isPlainObject(value.membersMap) &&
    isPlainObject(value.playlistsMap) &&
    isPlainObject(value.equipmentMap) &&
    isPlainObject(value.stemsMap)
  )
}
