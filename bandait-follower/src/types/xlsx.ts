/**
 * Bandait 3.0 — Master Workbook & Multi-Band Protocol Definitions
 */

export type MemberRole = 'Owner' | 'MusicDirector' | 'Musician' | 'Substitute' | 'SoundEngineer'

export interface BandInfo {
  id: string
  name: string
  role: MemberRole
}

export type AuthProvider = 'google' | 'otp_whatsapp' | 'otp_sms'

export interface UserAuthSession {
  token: string
  userId: string
  userName: string
  activeBandId: string
  role: MemberRole
}

export type TransitionMode = 'manual_cue' | 'auto_count_in' | 'gapless'

export interface PlaylistItem {
  id: string
  playlist_id: string
  song_id: string
  order: number
  show_key?: string
  target_bpm?: number
  transition_mode: TransitionMode
  count_in_bars?: number
  transition_notes?: string
  created_at: string
  updated_at: string
}

export interface ExcelSongRow {
  id: string
  titulo: string
  artista: string
  bpm_original: number
  tono_original: string
  duracion_segundos: number
  letra_chordpro: string
}

export interface ExcelSetlistRow {
  setlist_id: string
  nombre_show: string
  cancion_id: string
  orden: number
  tono_show: string
  modo_transicion: string
  notas: string
}

export interface ExcelEquipoRow {
  usuario_id: string
  nombre: string
  telefono: string // WhatsApp / SMS OTP
  rol: MemberRole
}

export interface ExcelMasterWorkbook {
  canciones: ExcelSongRow[]
  setlists: ExcelSetlistRow[]
  equipo: ExcelEquipoRow[]
}

export type DiffChangeType = 'added' | 'updated' | 'deleted' | 'unchanged'

export interface DiffFieldChange {
  before: unknown
  after: unknown
}

export interface DiffItem<T = unknown> {
  entity_id: string
  change_type: DiffChangeType
  details: T
  diff_fields?: Record<string, DiffFieldChange>
}

export interface DiffPreview {
  canciones: DiffItem<ExcelSongRow>[]
  setlists: DiffItem<ExcelSetlistRow>[]
  equipo: DiffItem<ExcelEquipoRow>[]
  has_changes: boolean
  summary: {
    added: number
    updated: number
    deleted: number
    unchanged: number
  }
}
