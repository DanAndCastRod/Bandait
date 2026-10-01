import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import type {
  AuthProvider,
  Band,
  BandMember,
  EquipmentItem,
  MemberRole,
  Playlist,
  PlaylistSong,
  Song,
  UserProfile,
  VoiceConfig,
  WorkspaceStore,
} from '../types/hub'
import { defaultVoiceConfig, loadWorkspaceDocument, parseImportedWorkspace } from '../services/workspaceSchema'
import { authService } from '../services/authService'
import {
  consumeOAuthPending,
  consumeOAuthRedirectError,
  createWorkspaceCloudAdapter,
  getSupabaseClient,
  getSupabaseConfig,
  profileFromSupabaseUser,
  signInWithSupabaseGoogle,
  signOutSupabase,
} from '../services/supabaseClient'
import {
  WorkspaceSyncEngine,
  parseBackups,
  syncBackupsKey,
  type EngineStatus,
  type KeyValueStore,
  type SyncNotice,
} from '../services/workspaceSync'
import { checkRoleChange, resolveActorRole, roleEditBlockReason as roleBlockReason } from '../services/roles'
import { legacyEmailProfileId, localProfileId } from '../services/identity'
import { uuidv4 } from '../services/uuid'
import { downloadJson, slugify } from '../services/download'
import { createDemoWorkspace, createPersonalWorkspace } from './seedData'
import { HubContext, type HubContextType, type HubSyncStatus } from './hubContextCore'

const workspaceKey = (userId: string) => `bandait_workspace_${userId}`

const browserStore: KeyValueStore = {
  get(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value)
      return true
    } catch {
      return false
    }
  },
}

/** Copia local migrada a v2 (la migracion es idempotente: corre en cada carga). */
function readStoredWorkspace(userId: string): WorkspaceStore | null {
  const raw = browserStore.get(workspaceKey(userId))
  if (!raw) return null
  try {
    return loadWorkspaceDocument(JSON.parse(raw))
  } catch {
    return null
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Cambia el id de usuario dentro de un workspace importado (ownerId y userId de integrantes). */
function remapUserId(ws: WorkspaceStore, fromId: string, toId: string): WorkspaceStore {
  const copy = clone(ws)
  copy.bands = copy.bands.map((b) => (b.ownerId === fromId ? { ...b, ownerId: toId } : b))
  for (const bandId of Object.keys(copy.membersMap)) {
    copy.membersMap[bandId] = (copy.membersMap[bandId] || []).map((m) => (m.userId === fromId ? { ...m, userId: toId } : m))
  }
  return copy
}

/**
 * Workspace inicial de un usuario. No escribe nada: el efecto de persistencia lo hace.
 * Para cuentas de nube esto es solo la copia local de partida: el motor de sincronizacion
 * descarga la fila de la nube ANTES de escribir y reconcilia.
 */
function loadWorkspaceFor(user: UserProfile | null): WorkspaceStore {
  if (!user) return createDemoWorkspace()
  const stored = readStoredWorkspace(user.id)
  if (stored) return stored
  if (user.authProvider === 'demo') return createDemoWorkspace()
  // Workspace local de un perfil anterior con el mismo correo en ESTE navegador
  // (incluye los ids antiguos usr_google_<btoa(email)>). Solo localStorage; nunca la nube.
  if (user.email) {
    for (const candidate of [localProfileId(user.email), legacyEmailProfileId(user.email)]) {
      if (!candidate || candidate === user.id) continue
      const previous = readStoredWorkspace(candidate)
      if (previous) return remapUserId(previous, candidate, user.id)
    }
  }
  return createPersonalWorkspace(user)
}

function firstPlaylistId(ws: WorkspaceStore): string {
  const band = ws.bands.find((b) => b.id === ws.activeBandId) || ws.bands[0]
  return band ? ws.playlistsMap[band.id]?.[0]?.id ?? '' : ''
}

const EMPTY_SONGS: Song[] = []
const DEFAULT_VOICE: VoiceConfig = defaultVoiceConfig()

const nowIso = () => new Date().toISOString()
const today = () => new Date().toISOString().slice(0, 10)

const LOCAL_ONLY_DETAIL: Record<Exclude<AuthProvider, 'supabase'>, string> = {
  local: 'Perfil local: los datos viven solo en este navegador. Para sincronizar entre dispositivos inicia sesión con Google (nube).',
  google_local:
    'Perfil local de Google: el token no se verifica en un servidor, así que no abre la nube. Los datos viven solo en este navegador.',
  demo: 'Modo demo: datos ficticios guardados solo en este navegador.',
}

export const HubProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // El error de retorno de OAuth se lee y se limpia de la URL antes de crear el cliente de Supabase.
  const [authNotice, setAuthNotice] = useState<string | null>(() => {
    const err = consumeOAuthRedirectError()
    return err ? `El login con Google no se completó: ${err}` : null
  })
  const [cloudConfig] = useState(() => getSupabaseConfig())
  const [user, setUser] = useState<UserProfile | null>(() => {
    const stored = authService.getCurrentUser()
    if (stored?.authProvider === 'supabase' && !cloudConfig.isConfigured) {
      authService.logout()
      return null
    }
    return stored
  })
  const [hadLocalCopy, setHadLocalCopy] = useState(() => (user ? readStoredWorkspace(user.id) !== null : false))
  const [workspace, setWorkspace] = useState<WorkspaceStore>(() => loadWorkspaceFor(user))
  const [activePlaylistId, setActivePlaylistId] = useState<string>(() => firstPlaylistId(workspace))
  const [googleClientId, setGoogleClientIdState] = useState<string>(() => authService.getGoogleClientId())
  const [googleClientIdSource, setGoogleClientIdSource] = useState(() => authService.getGoogleClientIdSource())
  const [cloudAuthReady, setCloudAuthReady] = useState(() => !cloudConfig.isConfigured)
  const [cloudSessionUserId, setCloudSessionUserId] = useState<string | null>(null)
  const [cloudSessionEmail, setCloudSessionEmail] = useState<string | null>(null)
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null)
  const [backupsVersion, setBackupsVersion] = useState(0)
  const [offlineChosen, setOfflineChosen] = useState(false)

  const userRef = useRef<UserProfile | null>(user)
  const workspaceRef = useRef<WorkspaceStore>(workspace)
  /** Ultimo workspace que NO es una edicion del usuario (carga inicial o datos adoptados de la nube). */
  const nonEditRef = useRef<WorkspaceStore | null>(workspace)
  const lastHandledRef = useRef<WorkspaceStore | null>(null)
  const engineRef = useRef<WorkspaceSyncEngine<WorkspaceStore> | null>(null)
  const loggingOutRef = useRef(false)

  const activeBand = workspace.bands.find((b) => b.id === workspace.activeBandId) || workspace.bands[0] || null
  const members = activeBand ? workspace.membersMap[activeBand.id] || [] : []
  const playlists = activeBand ? workspace.playlistsMap[activeBand.id] || [] : []
  const activePlaylist = playlists.find((p) => p.id === activePlaylistId) || playlists[0] || null
  const equipment = activeBand ? workspace.equipmentMap[activeBand.id] || [] : []
  // Opcional: un documento con schemaVersion > 2 (hub mas nuevo) no se migra y podria no traerlos.
  const songs: Song[] = activeBand ? workspace.songsMap?.[activeBand.id] ?? EMPTY_SONGS : EMPTY_SONGS
  const voiceConfig: VoiceConfig = (activeBand ? workspace.voiceMap?.[activeBand.id] : undefined) ?? DEFAULT_VOICE
  const songStems = activePlaylist?.songs[0]
    ? workspace.stemsMap[activePlaylist.songs[0].id] || workspace.stemsMap['song_01'] || null
    : workspace.stemsMap['song_01'] || null

  const roleActor = user && activeBand ? { userId: user.id, bandOwnerId: activeBand.ownerId } : null
  const activeBandRole: MemberRole | null =
    roleActor && activeBand ? resolveActorRole(members, roleActor) ?? activeBand.currentUserRole : null

  const cloudUserId = user?.authProvider === 'supabase' && cloudSessionUserId === user.id ? user.id : null

  const applyUser = useCallback((next: UserProfile | null) => {
    userRef.current = next
    const had = next ? readStoredWorkspace(next.id) !== null : false
    const ws = loadWorkspaceFor(next)
    nonEditRef.current = ws
    workspaceRef.current = ws
    setUser(next)
    setHadLocalCopy(had)
    setWorkspace(ws)
    setActivePlaylistId(firstPlaylistId(ws))
    setOfflineChosen(false)
    setSyncNotice(null)
    setEngineStatus(null)
  }, [])

  // Persistencia local-first: cada cambio se guarda en localStorage; si es una edicion del
  // usuario y hay cuenta de nube, se avisa al motor (que sube con debounce).
  useEffect(() => {
    workspaceRef.current = workspace
    if (!user) return
    if (lastHandledRef.current === workspace) return
    lastHandledRef.current = workspace
    browserStore.set(workspaceKey(user.id), JSON.stringify(workspace))
    if (workspace !== nonEditRef.current) {
      engineRef.current?.notifyLocalChange(workspace)
    }
  }, [user, workspace])

  // Sesion de Supabase Auth: restaurar (getSession), seguir cambios (onAuthStateChange) y
  // procesar el retorno del login con Google (PKCE: ?code=... lo canjea supabase-js).
  useEffect(() => {
    const client = getSupabaseClient()
    if (!client) return
    let active = true

    const handleSession = (session: Session | null, event: AuthChangeEvent | 'INITIAL') => {
      if (!active) return
      const current = userRef.current
      if (session?.user) {
        setCloudSessionUserId(session.user.id)
        setCloudSessionEmail(session.user.email ?? null)
        const adopt = !current || current.authProvider === 'supabase' || consumeOAuthPending()
        if (!adopt) return // hay un perfil local elegido explicitamente; la sesion queda disponible en el modal NUBE
        const profile = profileFromSupabaseUser(session.user)
        authService.storeUser(profile)
        if (current && current.authProvider === 'supabase' && current.id === profile.id) {
          if (current.name !== profile.name || current.email !== profile.email || current.avatarUrl !== profile.avatarUrl) {
            userRef.current = profile
            setUser(profile)
          }
        } else {
          applyUser(profile)
        }
        return
      }
      setCloudSessionUserId(null)
      setCloudSessionEmail(null)
      if (current?.authProvider === 'supabase' && !loggingOutRef.current) {
        authService.logout()
        applyUser(null)
        setAuthNotice(
          event === 'INITIAL'
            ? 'No hay una sesión de nube activa en este navegador. Inicia sesión de nuevo; los cambios guardados aquí se subirán al volver.'
            : 'La sesión de nube terminó o expiró. Inicia sesión de nuevo; los cambios guardados aquí se subirán al volver.'
        )
      }
    }

    client.auth
      .getSession()
      .then(({ data }) => {
        handleSession(data.session, 'INITIAL')
      })
      .catch(() => {
        handleSession(null, 'INITIAL')
      })
      .finally(() => {
        if (active) setCloudAuthReady(true)
      })

    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION') return // ya cubierto por getSession
      // Diferido: supabase-js recomienda no llamar a la API de auth dentro del callback.
      setTimeout(() => handleSession(session, event), 0)
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [applyUser])

  // Motor de sincronizacion: solo existe con una sesion de Supabase confirmada para el usuario actual.
  useEffect(() => {
    if (!cloudUserId) return
    const client = getSupabaseClient()
    if (!client) return
    const engine = new WorkspaceSyncEngine<WorkspaceStore>({
      userId: cloudUserId,
      adapter: createWorkspaceCloudAdapter(client, cloudUserId),
      store: browserStore,
      initialLocal: workspaceRef.current,
      onApplyRemote: (data) => {
        nonEditRef.current = data
        workspaceRef.current = data
        setWorkspace(data)
      },
      onStatus: setEngineStatus,
      onNotice: setSyncNotice,
      onBackupsChanged: () => setBackupsVersion((v) => v + 1),
      newId: uuidv4,
    })
    engineRef.current = engine
    engine.start()
    const onOnline = () => engine.retryNow()
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('online', onOnline)
      engine.stop()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [cloudUserId])

  const backups = useMemo(
    () => (cloudUserId ? parseBackups(browserStore.get(syncBackupsKey(cloudUserId))) : []),
    // backupsVersion fuerza la relectura cuando el motor guarda un respaldo nuevo
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cloudUserId, backupsVersion]
  )

  let syncStatus: HubSyncStatus
  if (!user) {
    syncStatus = { state: 'local_only', detail: 'Sin sesión.' }
  } else if (user.authProvider !== 'supabase') {
    syncStatus = {
      state: 'local_only',
      detail: `${LOCAL_ONLY_DETAIL[user.authProvider]}${cloudConfig.isConfigured ? '' : ' Supabase no está configurado en este Hub.'}`,
    }
  } else if (!cloudUserId) {
    syncStatus = { state: 'syncing', phase: 'initial', detail: 'Verificando la sesión de nube...' }
  } else {
    syncStatus = engineStatus ?? { state: 'syncing', phase: 'initial', detail: 'Iniciando la sincronización...' }
  }
  const initialSyncBlocking =
    !!cloudUserId && !hadLocalCopy && !offlineChosen && syncStatus.state !== 'local_only' && syncStatus.phase === 'initial'

  // ---------------------------------------------------------------------------
  // Identidad

  const setGoogleClientId = (clientId: string): string | null => {
    const error = authService.setGoogleClientId(clientId)
    if (!error) {
      setGoogleClientIdState(authService.getGoogleClientId())
      setGoogleClientIdSource(authService.getGoogleClientIdSource())
    }
    return error
  }

  const loginWithGoogleCredential = useCallback(
    (credentialJwt: string) => {
      const logged = authService.loginWithGoogleCredential(credentialJwt, googleClientId)
      applyUser(logged)
    },
    [googleClientId, applyUser]
  )

  const loginWithLocalProfile = (name: string, email: string) => {
    applyUser(authService.loginWithLocalProfile(name, email))
  }

  const loginWithDemoProfile = (profile: UserProfile) => {
    applyUser(authService.loginWithDemoProfile(profile))
  }

  const signInWithCloudGoogle = async (): Promise<string | null> => {
    const { error } = await signInWithSupabaseGoogle()
    return error
  }

  const logout = async (): Promise<void> => {
    const current = userRef.current
    loggingOutRef.current = true
    try {
      if (current?.authProvider === 'supabase') {
        const engine = engineRef.current
        let allUploaded = true
        if (engine) {
          allUploaded = await engine.flush(3000).catch(() => false)
          engine.stop()
        }
        await signOutSupabase()
        if (!allUploaded) {
          setAuthNotice(
            'Quedaron cambios sin subir a la nube. Están guardados en este navegador y se subirán la próxima vez que inicies sesión aquí.'
          )
        }
      }
      authService.logout()
      applyUser(null)
    } finally {
      loggingOutRef.current = false
    }
  }

  // ---------------------------------------------------------------------------
  // Sincronizacion

  const retrySync = () => engineRef.current?.retryNow()

  const findBackup = (backupId: string) =>
    cloudUserId ? parseBackups(browserStore.get(syncBackupsKey(cloudUserId))).find((b) => b.id === backupId) ?? null : null

  const restoreBackup = (backupId: string): string | null => {
    const backup = findBackup(backupId)
    if (!backup) return 'Respaldo no encontrado.'
    // Quita _sync, valida y migra (un respaldo de la nube pudo ser v1).
    const data = loadWorkspaceDocument(backup.data)
    if (!data) {
      return 'El respaldo no tiene un formato de workspace válido. Descárgalo para revisarlo a mano.'
    }
    const restored = clone(data)
    // Es una edicion del usuario: se guarda y se sube como version nueva.
    setWorkspace(restored)
    setActivePlaylistId(firstPlaylistId(restored))
    return null
  }

  const downloadBackup = (backupId: string) => {
    const backup = findBackup(backupId)
    if (!backup) return
    downloadJson(`bandait_respaldo_${backup.side}_${backup.savedAt.replace(/[:.]/g, '-')}.json`, backup)
  }

  // ---------------------------------------------------------------------------
  // Workspace

  const switchBand = (bandId: string) => {
    setWorkspace((prev) => ({ ...prev, activeBandId: bandId }))
    const bandPlaylists = workspace.playlistsMap[bandId] || []
    if (bandPlaylists.length > 0) {
      setActivePlaylistId(bandPlaylists[0].id)
    }
  }

  const createBand = (name: string, genre: string) => {
    const newBandId = `band_${Date.now()}`
    const newBand: Band = {
      id: newBandId,
      name,
      genre,
      ownerId: user?.id || 'usr_personal',
      currentUserRole: 'Owner',
      membersCount: 1,
      createdAt: new Date().toISOString().slice(0, 10),
    }

    const ownerMember: BandMember = {
      id: `mem_${Date.now()}`,
      bandId: newBandId,
      userId: user?.id || 'usr_personal',
      name: user?.name || 'Director General',
      email: user?.email || '',
      role: 'Owner',
      instrument: 'Director General',
      joinedAt: new Date().toISOString().slice(0, 10),
    }

    setWorkspace((prev) => ({
      ...prev,
      bands: [...prev.bands, newBand],
      activeBandId: newBandId,
      membersMap: { ...prev.membersMap, [newBandId]: [ownerMember] },
      playlistsMap: { ...prev.playlistsMap, [newBandId]: [] },
      equipmentMap: { ...prev.equipmentMap, [newBandId]: [] },
      songsMap: { ...prev.songsMap, [newBandId]: [] },
      voiceMap: { ...prev.voiceMap, [newBandId]: defaultVoiceConfig() },
    }))
  }

  const roleEditBlockReason = (memberId: string): string | null => {
    if (!roleActor) return 'Sin banda activa.'
    return roleBlockReason(members, roleActor, memberId)
  }

  // Guardia de cliente (ver services/roles.ts): la aplicacion real necesita RLS por banda en el servidor.
  const updateMemberRole = (memberId: string, newRole: MemberRole) => {
    if (!activeBand || !roleActor) return { ok: false, reason: 'Sin banda activa.' }
    const check = checkRoleChange(members, roleActor, memberId, newRole)
    if (!check.ok) return check
    const bandId = activeBand.id
    setWorkspace((prev) => ({
      ...prev,
      membersMap: {
        ...prev.membersMap,
        [bandId]: (prev.membersMap[bandId] || []).map((m) => (m.id === memberId ? { ...m, role: newRole } : m)),
      },
    }))
    return check
  }

  const inviteMember = (name: string, email: string, role: MemberRole, instrument: string) => {
    if (!activeBand) return
    const newMember: BandMember = {
      id: `mem_${Date.now()}`,
      bandId: activeBand.id,
      userId: `usr_invited_${Date.now()}`,
      name,
      email,
      // Nunca se agrega a alguien directamente como Owner desde la invitacion.
      role: role === 'Owner' ? 'Musician' : role,
      instrument,
      joinedAt: new Date().toISOString().slice(0, 10),
    }
    setWorkspace((prev) => ({
      ...prev,
      membersMap: {
        ...prev.membersMap,
        [activeBand.id]: [...(prev.membersMap[activeBand.id] || []), newMember],
      },
    }))
  }

  const createPlaylist = (name: string, description: string) => {
    if (!activeBand) return
    const newPl: Playlist = {
      id: `pl_${Date.now()}`,
      bandId: activeBand.id,
      name,
      description,
      songs: [],
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    }
    setWorkspace((prev) => ({
      ...prev,
      playlistsMap: {
        ...prev.playlistsMap,
        [activeBand.id]: [...(prev.playlistsMap[activeBand.id] || []), newPl],
      },
    }))
    setActivePlaylistId(newPl.id)
  }

  const updateActivePlaylist = (mutate: (pl: Playlist) => Playlist) => {
    if (!activeBand || !activePlaylist) return
    const bandId = activeBand.id
    const playlistId = activePlaylist.id
    setWorkspace((prev) => ({
      ...prev,
      playlistsMap: {
        ...prev.playlistsMap,
        [bandId]: (prev.playlistsMap[bandId] || []).map((pl) =>
          pl.id === playlistId ? { ...mutate(pl), updatedAt: new Date().toISOString().slice(0, 10) } : pl
        ),
      },
    }))
  }

  const updatePlaylistSong = (songId: string, updates: Partial<PlaylistSong>) => {
    updateActivePlaylist((pl) => ({ ...pl, songs: pl.songs.map((s) => (s.id === songId ? { ...s, ...updates } : s)) }))
  }

  const reorderSongs = (fromIndex: number, toIndex: number) => {
    updateActivePlaylist((pl) => {
      if (toIndex < 0 || toIndex >= pl.songs.length) return pl
      const songs = [...pl.songs]
      const [moved] = songs.splice(fromIndex, 1)
      songs.splice(toIndex, 0, moved)
      return { ...pl, songs: songs.map((s, idx) => ({ ...s, orderIndex: idx + 1 })) }
    })
  }

  const addSongToPlaylist = (songData: Omit<PlaylistSong, 'id' | 'orderIndex'>) => {
    updateActivePlaylist((pl) => ({
      ...pl,
      songs: [...pl.songs, { ...songData, id: `song_${Date.now()}`, orderIndex: pl.songs.length + 1 }],
    }))
  }

  const removeSongFromPlaylist = (songId: string) => {
    updateActivePlaylist((pl) => ({
      ...pl,
      songs: pl.songs.filter((s) => s.id !== songId).map((s, idx) => ({ ...s, orderIndex: idx + 1 })),
    }))
  }

  // ---------------------------------------------------------------------------
  // Libreria de canciones (songsMap) y voz (voiceMap) de la banda activa

  const createSong = (data: Omit<Song, 'id' | 'updatedAt'>): Song | null => {
    if (!activeBand) return null
    const bandId = activeBand.id
    const song: Song = { ...data, id: uuidv4(), updatedAt: nowIso() }
    setWorkspace((prev) => ({
      ...prev,
      songsMap: { ...prev.songsMap, [bandId]: [...(prev.songsMap?.[bandId] ?? []), song] },
    }))
    return song
  }

  /**
   * Guarda una cancion editada (mismo id: nunca se regenera). Actualiza tambien la copia de
   * respaldo (title, artist, key) de los items de setlist que la usan; el BPM y el tono del
   * show de cada item no se tocan, salvo el tono si el item no estaba transpuesto.
   */
  const saveSong = (song: Song) => {
    if (!activeBand) return
    const bandId = activeBand.id
    const saved: Song = { ...song, updatedAt: nowIso() }
    setWorkspace((prev) => {
      const list = prev.songsMap?.[bandId] ?? []
      const exists = list.some((s) => s.id === saved.id)
      const nextSongs = exists ? list.map((s) => (s.id === saved.id ? saved : s)) : [...list, saved]
      const playlistsForBand = prev.playlistsMap[bandId] || []
      let playlistsChanged = false
      const nextPlaylists = playlistsForBand.map((pl) => {
        let changed = false
        const items = pl.songs.map((it) => {
          if (it.songId !== saved.id) return it
          if (it.title === saved.title && it.artist === saved.artist && it.key === saved.key) return it
          changed = true
          const showKey = it.showKey === it.key ? saved.key : it.showKey
          return { ...it, title: saved.title, artist: saved.artist, key: saved.key, showKey }
        })
        if (!changed) return pl
        playlistsChanged = true
        return { ...pl, songs: items }
      })
      return {
        ...prev,
        songsMap: { ...prev.songsMap, [bandId]: nextSongs },
        playlistsMap: playlistsChanged ? { ...prev.playlistsMap, [bandId]: nextPlaylists } : prev.playlistsMap,
      }
    })
  }

  /** Copia con ids NUEVOS (cancion y secciones): para el lider es otra cancion. */
  const duplicateSong = (songId: string): Song | null => {
    const original = songs.find((s) => s.id === songId)
    if (!original) return null
    const data: Omit<Song, 'id' | 'updatedAt'> & { id?: string; updatedAt?: string } = {
      ...clone(original),
      title: `${original.title} (copia)`,
      sections: original.sections.map((sec) => ({ ...clone(sec), id: uuidv4() })),
    }
    delete data.id
    delete data.updatedAt
    return createSong(data)
  }

  /** Borra la cancion y los items de setlist que la usan (un songId nunca queda roto). */
  const deleteSong = (songId: string) => {
    if (!activeBand) return
    const bandId = activeBand.id
    setWorkspace((prev) => {
      const playlistsForBand = prev.playlistsMap[bandId] || []
      let playlistsChanged = false
      const nextPlaylists = playlistsForBand.map((pl) => {
        if (!pl.songs.some((it) => it.songId === songId)) return pl
        playlistsChanged = true
        return {
          ...pl,
          songs: pl.songs.filter((it) => it.songId !== songId).map((it, idx) => ({ ...it, orderIndex: idx + 1 })),
          updatedAt: today(),
        }
      })
      return {
        ...prev,
        songsMap: { ...prev.songsMap, [bandId]: (prev.songsMap?.[bandId] ?? []).filter((s) => s.id !== songId) },
        playlistsMap: playlistsChanged ? { ...prev.playlistsMap, [bandId]: nextPlaylists } : prev.playlistsMap,
      }
    })
  }

  const updateVoiceConfig = (updates: Partial<VoiceConfig>) => {
    if (!activeBand) return
    const bandId = activeBand.id
    setWorkspace((prev) => ({
      ...prev,
      voiceMap: { ...prev.voiceMap, [bandId]: { ...(prev.voiceMap?.[bandId] ?? defaultVoiceConfig()), ...updates } },
    }))
  }

  /** Reemplaza el workspace por un JSON importado (migrado y validado). Es una edicion del usuario. */
  const importWorkspaceJson = (text: string): { ok: boolean; message: string } => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, message: 'El archivo no es un JSON válido.' }
    }
    const result = parseImportedWorkspace(parsed)
    if (!result.ok) return { ok: false, message: result.error }
    const imported = clone(result.workspace)
    setWorkspace(imported)
    setActivePlaylistId(firstPlaylistId(imported))
    const warn = result.warnings.length > 0 ? ` (${result.warnings.length} advertencias de formato)` : ''
    return { ok: true, message: `Workspace importado: ${imported.bands.length} banda(s)${warn}.` }
  }

  const updateStemTrackVolume = (channel: number, volumeDb: number) => {
    if (!songStems) return
    setWorkspace((prev) => {
      const currentSongId = activePlaylist?.songs[0]?.id || 'song_01'
      const existing = prev.stemsMap[currentSongId] || prev.stemsMap['song_01']
      if (!existing) return prev
      const updatedTracks = existing.tracks.map((t) => (t.channel === channel ? { ...t, volumeDb } : t))
      return {
        ...prev,
        stemsMap: { ...prev.stemsMap, [currentSongId]: { ...existing, tracks: updatedTracks } },
      }
    })
  }

  const addEquipment = (itemData: Omit<EquipmentItem, 'id' | 'bandId'>) => {
    if (!activeBand) return
    const newItem: EquipmentItem = { ...itemData, id: `eq_${Date.now()}`, bandId: activeBand.id }
    setWorkspace((prev) => ({
      ...prev,
      equipmentMap: {
        ...prev.equipmentMap,
        [activeBand.id]: [...(prev.equipmentMap[activeBand.id] || []), newItem],
      },
    }))
  }

  const removeEquipment = (id: string) => {
    if (!activeBand) return
    setWorkspace((prev) => ({
      ...prev,
      equipmentMap: {
        ...prev.equipmentMap,
        [activeBand.id]: (prev.equipmentMap[activeBand.id] || []).filter((eq) => eq.id !== id),
      },
    }))
  }

  const exportWorkspaceJson = () => {
    if (!activeBand) return
    const now = new Date()
    downloadJson(`bandait_${slugify(activeBand.name)}_${now.toISOString().slice(0, 10)}.json`, {
      bandait_version: '3.0.0',
      formato: 'json',
      exported_at: now.toISOString(),
      agrupacion: activeBand,
      miembros: members,
      setlists: playlists,
      canciones: songs,
      voz: voiceConfig,
      stems_catalogo: songStems,
      equipamiento: equipment,
      // Documento v2 completo (todas las bandas), el mismo que descarga el lider. Se puede
      // volver a importar desde PERFIL & SESION.
      workspace,
    })
  }

  const value: HubContextType = {
    user,
    bands: workspace.bands,
    activeBand,
    activeBandRole,
    members,
    playlists,
    activePlaylist,
    songStems,
    equipment,
    songs,
    voiceConfig,
    googleClientId,
    googleClientIdSource,
    setGoogleClientId,
    cloud: {
      configured: cloudConfig.isConfigured,
      source: cloudConfig.source,
      configError: cloudConfig.error,
      url: cloudConfig.url,
      authReady: cloudAuthReady,
      sessionEmail: cloudSessionEmail,
    },
    authNotice,
    dismissAuthNotice: () => setAuthNotice(null),
    loginWithGoogleCredential,
    loginWithLocalProfile,
    loginWithDemoProfile,
    signInWithCloudGoogle,
    logout,
    syncStatus,
    initialSyncBlocking,
    continueOffline: () => setOfflineChosen(true),
    retrySync,
    syncNotice,
    dismissSyncNotice: () => setSyncNotice(null),
    backups,
    restoreBackup,
    downloadBackup,
    switchBand,
    createBand,
    roleEditBlockReason,
    updateMemberRole,
    inviteMember,
    createPlaylist,
    setActivePlaylist: (pl) => setActivePlaylistId(pl.id),
    updatePlaylistSong,
    reorderSongs,
    addSongToPlaylist,
    removeSongFromPlaylist,
    updateStemTrackVolume,
    addEquipment,
    removeEquipment,
    createSong,
    saveSong,
    duplicateSong,
    deleteSong,
    updateVoiceConfig,
    exportWorkspaceJson,
    importWorkspaceJson,
  }

  return <HubContext.Provider value={value}>{children}</HubContext.Provider>
}
