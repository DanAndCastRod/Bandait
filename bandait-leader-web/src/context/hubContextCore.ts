import { createContext, useContext } from 'react'
import type {
  Band,
  BandMember,
  EquipmentItem,
  MemberRole,
  Playlist,
  PlaylistSong,
  Song,
  SongStems,
  UserProfile,
  VoiceConfig,
} from '../types/hub'
import type { EngineStatus, SyncBackup, SyncNotice } from '../services/workspaceSync'
import type { RoleChangeCheck } from '../services/roles'
import type { SupabaseConfigSource } from '../services/supabaseClient'

/** Estado de sincronizacion que muestra la UI. */
export type HubSyncStatus = { state: 'local_only'; detail: string } | EngineStatus

export interface CloudInfo {
  /** Hay URL y anon key validas (compilacion u override). */
  configured: boolean
  source: SupabaseConfigSource
  /** Configuracion presente pero rechazada (p. ej. service_role). */
  configError: string | null
  url: string
  /** Ya se comprobo si hay una sesion de Supabase guardada. */
  authReady: boolean
  /** Correo de la sesion de Supabase activa en este navegador, aunque el perfil actual sea local. */
  sessionEmail: string | null
}

/** Resultado de una accion que puede fallar en la nube. `link`: enlace de invitacion para copiar. */
export interface HubActionResult {
  ok: boolean
  message: string
  link?: string
  /** Banda a la que se refiere el resultado: la UI no lo muestra si la banda activa es otra. */
  bandId?: string
}

/** Bandas compartidas (docs/DEPLOY.md, seccion 3.11). */
export interface SharingInfo {
  /** null: aun no se comprobo; false: faltan las tablas en Supabase. */
  available: boolean | null
  error: string | null
  /** Hay una sesion de nube (requisito para compartir). */
  cloudSignedIn: boolean
  activeShared: boolean
  /** El rol permite editar canciones y setlists de la banda activa (siempre true en bandas personales). */
  activeCanEdit: boolean
  activeCanInvite: boolean
  /** Enlace para mandar a los invitados de la banda activa (solo si es compartida). */
  activeLink: string | null
  sharedBandIds: string[]
  /** Bandas donde el usuario puede escribir (destino posible de una copia de setlist). */
  editableBandIds: string[]
}

export interface HubContextType {
  user: UserProfile | null
  bands: Band[]
  activeBand: Band | null
  /** Rol del usuario en la banda activa, segun la lista de integrantes. */
  activeBandRole: MemberRole | null
  members: BandMember[]
  playlists: Playlist[]
  activePlaylist: Playlist | null
  songStems: SongStems | null
  equipment: EquipmentItem[]
  /** Libreria de canciones de la banda activa (songsMap[bandId]). */
  songs: Song[]
  /** Conteos y avisos de voz de la banda activa (voiceMap[bandId]). */
  voiceConfig: VoiceConfig

  // Identidad
  googleClientId: string
  googleClientIdSource: 'override' | 'build' | 'none'
  /** Devuelve un mensaje de error si el Client ID no es valido. */
  setGoogleClientId: (clientId: string) => string | null
  cloud: CloudInfo
  authNotice: string | null
  dismissAuthNotice: () => void
  /** Lanza Error con mensaje para el usuario si la credencial no pasa los controles. */
  loginWithGoogleCredential: (credentialJwt: string) => void
  loginWithLocalProfile: (name: string, email: string) => void
  loginWithDemoProfile: (profile: UserProfile) => void
  /** Redirige a Google via Supabase. Devuelve un mensaje de error si no se pudo iniciar. */
  signInWithCloudGoogle: () => Promise<string | null>
  logout: () => Promise<void>

  // Sincronizacion
  syncStatus: HubSyncStatus
  /** Cuenta de nube sin copia local: la UI espera la descarga inicial antes de mostrar datos. */
  initialSyncBlocking: boolean
  continueOffline: () => void
  retrySync: () => void
  syncNotice: SyncNotice | null
  dismissSyncNotice: () => void
  backups: SyncBackup[]
  /** Devuelve un mensaje de error o null si se restauro. */
  restoreBackup: (backupId: string) => string | null
  downloadBackup: (backupId: string) => void

  // Workspace
  switchBand: (bandId: string) => void
  createBand: (name: string, genre: string) => void
  /** Motivo por el que el usuario actual no puede cambiar el rol de ese integrante, o null. */
  roleEditBlockReason: (memberId: string) => string | null
  updateMemberRole: (memberId: string, newRole: MemberRole) => RoleChangeCheck
  /** En bandas compartidas crea la invitacion en la nube (por correo) y devuelve el enlace. */
  inviteMember: (name: string, email: string, role: MemberRole, instrument: string) => Promise<HubActionResult>
  /** Quita a un integrante (en compartidas, solo un Owner; RLS lo hace cumplir). */
  removeMember: (memberId: string) => Promise<HubActionResult>
  /** Salir de la banda compartida activa (no aplica a quien la creo). */
  leaveActiveBand: () => Promise<HubActionResult>
  /** Sube la banda activa como banda compartida e invita a sus integrantes con correo. */
  shareActiveBand: () => Promise<HubActionResult>
  /** Copia un setlist de la banda activa, con sus canciones, a otra banda editable. */
  copyPlaylistToBand: (playlistId: string, targetBandId: string) => HubActionResult
  sharing: SharingInfo
  createPlaylist: (name: string, description: string) => void
  setActivePlaylist: (playlist: Playlist) => void
  updatePlaylistSong: (songId: string, updates: Partial<PlaylistSong>) => void
  reorderSongs: (fromIndex: number, toIndex: number) => void
  addSongToPlaylist: (song: Omit<PlaylistSong, 'id' | 'orderIndex'>) => void
  removeSongFromPlaylist: (songId: string) => void
  updateStemTrackVolume: (channel: number, volumeDb: number) => void
  addEquipment: (item: Omit<EquipmentItem, 'id' | 'bandId'>) => void
  removeEquipment: (id: string) => void
  /** Crea una cancion en la libreria de la banda activa (id UUID v4 nuevo). */
  createSong: (data: Omit<Song, 'id' | 'updatedAt'>) => Song | null
  /** Guarda una cancion existente conservando su id y el de sus secciones. */
  saveSong: (song: Song) => void
  duplicateSong: (songId: string) => Song | null
  /** Borra la cancion y los items de setlist que la usan. */
  deleteSong: (songId: string) => void
  updateVoiceConfig: (updates: Partial<VoiceConfig>) => void
  /** Descarga la banda activa como JSON, con el workspace v2 completo en `workspace`. */
  exportWorkspaceJson: () => void
  /** Reemplaza el workspace por el de un JSON exportado (se migra y valida). */
  importWorkspaceJson: (text: string) => { ok: boolean; message: string }
}

export const HubContext = createContext<HubContextType | undefined>(undefined)

export function useHub(): HubContextType {
  const context = useContext(HubContext)
  if (!context) {
    throw new Error('useHub must be used within a HubProvider')
  }
  return context
}
