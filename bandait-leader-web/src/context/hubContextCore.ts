import { createContext, useContext } from 'react'
import type {
  Band,
  BandMember,
  EquipmentItem,
  MemberRole,
  Playlist,
  PlaylistSong,
  SongStems,
  UserProfile,
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
  inviteMember: (name: string, email: string, role: MemberRole, instrument: string) => void
  createPlaylist: (name: string, description: string) => void
  setActivePlaylist: (playlist: Playlist) => void
  updatePlaylistSong: (songId: string, updates: Partial<PlaylistSong>) => void
  reorderSongs: (fromIndex: number, toIndex: number) => void
  addSongToPlaylist: (song: Omit<PlaylistSong, 'id' | 'orderIndex'>) => void
  removeSongFromPlaylist: (songId: string) => void
  updateStemTrackVolume: (channel: number, volumeDb: number) => void
  addEquipment: (item: Omit<EquipmentItem, 'id' | 'bandId'>) => void
  removeEquipment: (id: string) => void
  /** Descarga la banda activa como JSON (el XLSX real esta pendiente). */
  exportWorkspaceJson: () => void
}

export const HubContext = createContext<HubContextType | undefined>(undefined)

export function useHub(): HubContextType {
  const context = useContext(HubContext)
  if (!context) {
    throw new Error('useHub must be used within a HubProvider')
  }
  return context
}
