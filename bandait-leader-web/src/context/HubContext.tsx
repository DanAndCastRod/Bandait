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
  createBandCloudAdapter,
  createSharedBand,
  createWorkspaceCloudAdapter,
  deleteBandMember,
  getAuthRedirectUrl,
  getSupabaseClient,
  getSupabaseConfig,
  insertBandMembers,
  listSharedBands,
  profileFromSupabaseUser,
  signInWithSupabaseGoogle,
  signOutSupabase,
  subscribeSharedBands,
  toBandCloudRow,
  updateBandMemberRole,
} from '../services/supabaseClient'
import {
  WorkspaceSyncEngine,
  parseBackups,
  stableStringify,
  syncBackupsKey,
  syncMetaKey,
  type EngineStatus,
  type KeyValueStore,
  type SyncBackup,
  type SyncNotice,
} from '../services/workspaceSync'
import {
  canEditRole,
  canInviteRole,
  copyPlaylistToBand as copyPlaylistBetweenBands,
  inviteLink,
  invitesFromMembers,
  isValidEmail,
  membersFromRows,
  mergeWorkspace,
  normalizeEmail,
  personalPart,
  readInviteParam,
  remapBandId,
  resolveSharedRole,
  sliceBand,
  INVITE_PARAM,
  type SharedBand,
} from '../services/sharedBands'
import { checkRoleChange, resolveActorRole, roleEditBlockReason as roleBlockReason } from '../services/roles'
import { legacyEmailProfileId, localProfileId } from '../services/identity'
import { uuidv4 } from '../services/uuid'
import { downloadJson, slugify } from '../services/download'
import { createDemoWorkspace, createPersonalWorkspace } from './seedData'
import { HubContext, type HubActionResult, type HubContextType, type HubSyncStatus, type SharingInfo } from './hubContextCore'

const workspaceKey = (userId: string) => `bandait_workspace_${userId}`
/** Copia local de las bandas compartidas (para abrirlas sin conexion). */
const sharedCacheKey = (userId: string) => `bandait_shared_bands_${userId}`
/** Banda activa, aunque sea compartida (la parte personal solo guarda bandas personales). */
const activeBandKey = (userId: string) => `bandait_active_band_${userId}`
/** Ambito del motor de una banda compartida: metadatos y respaldos separados por cuenta y banda. */
const bandScope = (userId: string, bandId: string) => `${userId}_band_${bandId}`
/** Enlace de invitacion abierto antes del login: sobrevive a la redireccion de Google. */
const PENDING_INVITE_KEY = 'bandait_pending_invite'

const READ_ONLY_NOTICE =
  'Esta banda compartida es de solo lectura para tu rol. Solo el Owner y el MusicDirector editan canciones y setlists.'

/** Lee ?banda=<uuid>, lo guarda para despues del login y lo quita de la URL. */
function captureInviteFromUrl(): string | null {
  try {
    const url = new URL(window.location.href)
    const bandId = readInviteParam(url.search)
    if (bandId) {
      sessionStorage.setItem(PENDING_INVITE_KEY, bandId)
      url.searchParams.delete(INVITE_PARAM)
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
      return bandId
    }
    return sessionStorage.getItem(PENDING_INVITE_KEY)
  } catch {
    return null
  }
}

function clearPendingInvite(): void {
  try {
    sessionStorage.removeItem(PENDING_INVITE_KEY)
  } catch {
    // sin sessionStorage no hay nada que limpiar
  }
}

function readSharedCache(userId: string): SharedBand[] {
  const raw = browserStore.get(sharedCacheKey(userId))
  if (!raw) return []
  try {
    const list: unknown = JSON.parse(raw)
    if (!Array.isArray(list)) return []
    const out: SharedBand[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      if (typeof o.id !== 'string' || typeof o.ownerId !== 'string' || typeof o.role !== 'string') continue
      const data = toBandCloudRow(o.id, { content: o.data, updated_at: '' }).data
      if (!data) continue
      out.push({ id: o.id, ownerId: o.ownerId, role: o.role as MemberRole, data, members: Array.isArray(o.members) ? (o.members as BandMember[]) : [] })
    }
    return out
  } catch {
    return []
  }
}

/** Clave que cambia cuando cambian las bandas compartidas o el permiso de edicion en alguna. */
const sharedEnginesKey = (list: Iterable<SharedBand>) =>
  [...list]
    .map((sb) => `${sb.id}:${canEditRole(sb.role) ? 'w' : 'r'}`)
    .sort()
    .join(',')

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

interface LoadedState {
  personal: WorkspaceStore
  shared: SharedBand[]
  merged: WorkspaceStore
}

/** Parte personal + copia local de las compartidas (solo cuentas de nube), con la banda activa recordada. */
function loadStateFor(user: UserProfile | null): LoadedState {
  const personal = loadWorkspaceFor(user)
  const shared = user?.authProvider === 'supabase' ? readSharedCache(user.id) : []
  const active = (user && browserStore.get(activeBandKey(user.id))) || personal.activeBandId
  return { personal, shared, merged: mergeWorkspace(personal, shared, active) }
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
  const [initialState] = useState<LoadedState>(() => loadStateFor(user))
  const [workspace, setWorkspace] = useState<WorkspaceStore>(initialState.merged)
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
  const [sharedKey, setSharedKey] = useState(() => sharedEnginesKey(initialState.shared))
  /** null: aun no se sabe; false: las tablas no existen en Supabase (falta el SQL de la seccion 3.11). */
  const [sharedAvailable, setSharedAvailable] = useState<boolean | null>(null)
  const [sharedError, setSharedError] = useState<string | null>(null)

  const userRef = useRef<UserProfile | null>(user)
  const workspaceRef = useRef<WorkspaceStore>(workspace)
  const lastHandledRef = useRef<WorkspaceStore | null>(null)
  const engineRef = useRef<WorkspaceSyncEngine<WorkspaceStore> | null>(null)
  const loggingOutRef = useRef(false)

  // Particion del workspace unido. Una edicion del usuario se detecta comparando cada parte con
  // la ultima version conocida (carga inicial o adoptada de la nube), no por identidad de objeto.
  const sharedRef = useRef<Map<string, SharedBand>>(new Map(initialState.shared.map((sb) => [sb.id, sb])))
  const personalRef = useRef<WorkspaceStore>(initialState.personal)
  const knownPersonalRef = useRef<string>(stableStringify(initialState.personal))
  const storedPersonalRef = useRef<string | null>(null)
  const knownSliceRef = useRef<Map<string, string>>(
    new Map(initialState.shared.map((sb) => [sb.id, stableStringify(sliceBand(initialState.merged, sb.id))]))
  )
  const bandEnginesRef = useRef<Map<string, { key: string; engine: WorkspaceSyncEngine<WorkspaceStore> }>>(new Map())
  const pendingInviteRef = useRef<string | null>(captureInviteFromUrl())

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

  /** Bandas compartidas cargadas (id -> puede editar), derivado del estado y no de refs. */
  const sharedFlags = useMemo(
    () => new Map((sharedKey ? sharedKey.split(',') : []).map((p) => [p.slice(0, p.lastIndexOf(':')), p.endsWith(':w')] as const)),
    [sharedKey]
  )
  const activeIsShared = !!activeBand && sharedFlags.has(activeBand.id)
  const activeReadOnly = activeIsShared && !canEditRole(activeBandRole)
  /** Las acciones que editan la banda activa no corren si es compartida y el rol no edita. */
  const blockIfReadOnly = (): boolean => {
    if (!activeReadOnly) return false
    setAuthNotice(READ_ONLY_NOTICE)
    return true
  }

  const applyUser = useCallback((next: UserProfile | null) => {
    userRef.current = next
    const had = next ? readStoredWorkspace(next.id) !== null : false
    const loaded = loadStateFor(next)
    const ws = loaded.merged
    sharedRef.current = new Map(loaded.shared.map((sb) => [sb.id, sb]))
    personalRef.current = loaded.personal
    knownPersonalRef.current = stableStringify(loaded.personal)
    storedPersonalRef.current = null
    knownSliceRef.current = new Map(loaded.shared.map((sb) => [sb.id, stableStringify(sliceBand(ws, sb.id))]))
    workspaceRef.current = ws
    setUser(next)
    setHadLocalCopy(had)
    setWorkspace(ws)
    setActivePlaylistId(firstPlaylistId(ws))
    setOfflineChosen(false)
    setSyncNotice(null)
    setEngineStatus(null)
    setSharedKey(sharedEnginesKey(loaded.shared))
    setSharedAvailable(null)
    setSharedError(null)
  }, [])

  const saveSharedCache = useCallback((userId: string) => {
    const list = [...sharedRef.current.values()].map((sb) => ({ id: sb.id, ownerId: sb.ownerId, role: sb.role, data: sb.data, members: sb.members }))
    browserStore.set(sharedCacheKey(userId), JSON.stringify(list))
  }, [])

  /**
   * Reconstruye el workspace unido con la parte personal actual y las compartidas de sharedRef.
   * Marca como conocidas las partes compartidas resultantes (no son ediciones del usuario).
   */
  const rebuildMerged = useCallback((personal: WorkspaceStore, activeBandId: string): WorkspaceStore => {
    const merged = mergeWorkspace(personal, [...sharedRef.current.values()], activeBandId)
    const known = new Map<string, string>()
    for (const sb of sharedRef.current.values()) {
      const slice = sliceBand(merged, sb.id)
      if (slice) known.set(sb.id, stableStringify(slice))
    }
    knownSliceRef.current = known
    return merged
  }, [])

  const currentPersonal = useCallback(
    (ws: WorkspaceStore) => personalPart(ws, new Set(sharedRef.current.keys()), personalRef.current.activeBandId),
    []
  )

  // Persistencia local-first. La parte personal se guarda en localStorage y, si es una edicion,
  // se avisa a su motor. Cada banda compartida editada se avisa a su propio motor; si el rol no
  // permite editarla, la edicion se revierte (RLS la rechazaria igual).
  useEffect(() => {
    workspaceRef.current = workspace
    if (!user) return
    if (lastHandledRef.current === workspace) return
    lastHandledRef.current = workspace
    browserStore.set(activeBandKey(user.id), workspace.activeBandId)

    const personal = currentPersonal(workspace)
    const personalStr = stableStringify(personal)
    personalRef.current = personal
    if (personalStr !== storedPersonalRef.current) {
      storedPersonalRef.current = personalStr
      browserStore.set(workspaceKey(user.id), JSON.stringify(personal))
    }
    if (personalStr !== knownPersonalRef.current) {
      knownPersonalRef.current = personalStr
      engineRef.current?.notifyLocalChange(personal)
    }

    let sharedChanged = false
    let blocked = false
    for (const sb of sharedRef.current.values()) {
      const slice = sliceBand(workspace, sb.id)
      if (!slice) continue
      const sliceStr = stableStringify(slice)
      if (sliceStr === knownSliceRef.current.get(sb.id)) continue
      if (!canEditRole(sb.role)) {
        blocked = true
        continue
      }
      knownSliceRef.current.set(sb.id, sliceStr)
      sharedRef.current.set(sb.id, { ...sb, data: slice })
      bandEnginesRef.current.get(sb.id)?.engine.notifyLocalChange(slice)
      sharedChanged = true
    }
    if (sharedChanged) saveSharedCache(user.id)
    if (blocked) {
      setAuthNotice(READ_ONLY_NOTICE)
      setWorkspace(rebuildMerged(personal, workspace.activeBandId))
    }
  }, [user, workspace, currentPersonal, rebuildMerged, saveSharedCache])

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
      initialLocal: currentPersonal(workspaceRef.current),
      onApplyRemote: (data) => {
        const merged = rebuildMerged(data, workspaceRef.current.activeBandId)
        const personal = currentPersonal(merged)
        personalRef.current = personal
        knownPersonalRef.current = stableStringify(personal)
        workspaceRef.current = merged
        setWorkspace(merged)
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
  }, [cloudUserId, currentPersonal, rebuildMerged])

  // ---------------------------------------------------------------------------
  // Bandas compartidas: descubrimiento, motores por banda e invitaciones

  const sessionEmail = cloudSessionEmail ?? user?.email ?? ''

  /** Relee de la nube a que bandas compartidas pertenece la cuenta, con sus integrantes y roles. */
  const refreshShared = useCallback(async (): Promise<void> => {
    const client = getSupabaseClient()
    const me = userRef.current
    if (!client || !cloudUserId || !me || me.id !== cloudUserId) return
    const res = await listSharedBands(client)
    if (userRef.current?.id !== cloudUserId) return // cambio de cuenta mientras se leia
    if (!res.ok) {
      if (res.error.kind === 'schema') setSharedAvailable(false)
      setSharedError(res.error.message)
      return
    }
    setSharedAvailable(true)
    setSharedError(null)
    const email = sessionEmail
    const previous = sharedRef.current
    const next = new Map<string, SharedBand>()
    for (const row of res.bands) {
      const rows = res.members.filter((m) => m.band_id === row.id)
      const role = resolveSharedRole(row.owner_id, rows, cloudUserId, email)
      if (!role) continue
      // Si la banda ya estaba cargada, su contenido lo maneja su motor (puede tener ediciones sin subir).
      const data = previous.get(row.id)?.data ?? toBandCloudRow(row.id, { content: row.content, updated_at: row.updated_at }).data
      if (!data) continue
      const members = membersFromRows(rows, row.id, row.owner_id, cloudUserId, email, { name: me.name, email })
      next.set(row.id, { id: row.id, ownerId: row.owner_id, role, data, members })
    }
    const lost = [...previous.values()].filter((sb) => !next.has(sb.id))
    const oldIds = new Set(previous.keys())
    const personal = personalPart(workspaceRef.current, oldIds, personalRef.current.activeBandId)
    sharedRef.current = next

    let active = workspaceRef.current.activeBandId
    const invite = pendingInviteRef.current
    if (invite) {
      pendingInviteRef.current = null
      clearPendingInvite()
      if (next.has(invite)) {
        active = invite
      } else {
        setAuthNotice(
          `El enlace de invitación es para una banda a la que ${email || 'esta cuenta'} no tiene acceso. Entra con la cuenta de Google que invitaron o pide que te inviten con este correo.`
        )
      }
    }
    if (lost.length > 0) {
      setAuthNotice(`Ya no tienes acceso a: ${lost.map((sb) => sb.data.bands[0]?.name ?? 'banda compartida').join(', ')}.`)
    }
    const previousActive = workspaceRef.current.activeBandId
    const merged = rebuildMerged(personal, active)
    saveSharedCache(cloudUserId)
    workspaceRef.current = merged
    setWorkspace(merged)
    if (merged.activeBandId !== previousActive) setActivePlaylistId(firstPlaylistId(merged))
    setSharedKey(sharedEnginesKey(next.values()))
  }, [cloudUserId, sessionEmail, rebuildMerged, saveSharedCache])

  // Enlace de invitacion abierto sin sesion de nube: explicar como entrar (se aplica tras el login).
  useEffect(() => {
    if (pendingInviteRef.current && user?.authProvider !== 'supabase') {
      setAuthNotice('Abriste una invitación a una banda de Bandait. Entra con "Continuar con Google (nube)" usando el correo que invitaron.')
    }
  }, [user])

  // Descubrimiento: al abrir la sesion de nube, con avisos de realtime y al volver a la pestana.
  useEffect(() => {
    if (!cloudUserId) return
    const client = getSupabaseClient()
    if (!client) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void refreshShared(), 400)
    }
    schedule()
    const unsubscribe = subscribeSharedBands(client, schedule)
    const onFocus = () => schedule()
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    return () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
    }
  }, [cloudUserId, refreshShared])

  // Un motor de sincronizacion por banda compartida (la misma logica que el workspace personal).
  useEffect(() => {
    const engines = bandEnginesRef.current
    const client = getSupabaseClient()
    const wanted = new Map<string, string>()
    if (cloudUserId && client) {
      for (const part of sharedKey ? sharedKey.split(',') : []) wanted.set(part.slice(0, part.lastIndexOf(':')), part)
    }
    for (const [id, entry] of engines) {
      if (wanted.get(id) !== entry.key) {
        entry.engine.stop()
        engines.delete(id)
      }
    }
    if (!cloudUserId || !client) return
    for (const [id, key] of wanted) {
      if (engines.has(id)) continue
      const sb = sharedRef.current.get(id)
      if (!sb) continue
      const scope = bandScope(cloudUserId, id)
      // Solo lectura: nada local que subir; el motor solo baja y aplica.
      if (!canEditRole(sb.role)) browserStore.set(syncMetaKey(scope), JSON.stringify({ updatedAt: null, lastSyncedAt: null, dirty: false }))
      const engine = new WorkspaceSyncEngine<WorkspaceStore>({
        userId: scope,
        adapter: createBandCloudAdapter(client, id),
        store: browserStore,
        initialLocal: sb.data,
        onApplyRemote: (data) => {
          const current = sharedRef.current.get(id)
          if (!current) return
          sharedRef.current.set(id, { ...current, data })
          const merged = rebuildMerged(currentPersonal(workspaceRef.current), workspaceRef.current.activeBandId)
          saveSharedCache(cloudUserId)
          workspaceRef.current = merged
          setWorkspace(merged)
        },
        onStatus: (status) => {
          if (status.state === 'error' && status.retryInMs === null) setSharedError(`${sb.data.bands[0]?.name ?? 'Banda compartida'}: ${status.detail}`)
        },
        onNotice: setSyncNotice,
        onBackupsChanged: () => setBackupsVersion((v) => v + 1),
        newId: uuidv4,
      })
      engines.set(id, { key, engine })
      engine.start()
    }
  }, [cloudUserId, sharedKey, currentPersonal, rebuildMerged, saveSharedCache])

  // Al cerrar la sesion de nube (o cambiar de cuenta) se detienen todos los motores de bandas.
  useEffect(() => {
    const engines = bandEnginesRef.current
    return () => {
      for (const entry of engines.values()) entry.engine.stop()
      engines.clear()
    }
  }, [cloudUserId])

  /** Ambitos con respaldos: el workspace personal y cada banda compartida. */
  const backupScopes = useCallback((): Array<{ scope: string; bandId: string | null }> => {
    if (!cloudUserId) return []
    return [
      { scope: cloudUserId, bandId: null },
      ...[...sharedFlags.keys()].map((id) => ({ scope: bandScope(cloudUserId, id), bandId: id })),
    ]
  }, [cloudUserId, sharedFlags])

  const backups = useMemo(
    () =>
      backupScopes()
        .flatMap(({ scope }) => parseBackups(browserStore.get(syncBackupsKey(scope))))
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    // backupsVersion fuerza la relectura cuando un motor guarda un respaldo nuevo
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backupScopes, backupsVersion]
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
        const engines = [engineRef.current, ...[...bandEnginesRef.current.values()].map((e) => e.engine)].filter(
          (e): e is WorkspaceSyncEngine<WorkspaceStore> => e !== null
        )
        const results = await Promise.all(engines.map((e) => e.flush(3000).catch(() => false)))
        const allUploaded = results.every(Boolean)
        for (const e of engines) e.stop()
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

  const retrySync = () => {
    engineRef.current?.retryNow()
    for (const entry of bandEnginesRef.current.values()) entry.engine.retryNow()
    void refreshShared()
  }

  const findBackup = (backupId: string): { backup: SyncBackup; bandId: string | null } | null => {
    for (const { scope, bandId } of backupScopes()) {
      const backup = parseBackups(browserStore.get(syncBackupsKey(scope))).find((b) => b.id === backupId)
      if (backup) return { backup, bandId }
    }
    return null
  }

  const restoreBackup = (backupId: string): string | null => {
    const found = findBackup(backupId)
    if (!found) return 'Respaldo no encontrado.'
    // Quita _sync, valida y migra (un respaldo de la nube pudo ser v1).
    const data = loadWorkspaceDocument(found.backup.data)
    if (!data) {
      return 'El respaldo no tiene un formato de workspace válido. Descárgalo para revisarlo a mano.'
    }
    const restored = clone(data)
    const current = workspaceRef.current
    if (found.bandId) {
      // Respaldo de una banda compartida: reemplaza solo esa banda (edicion: su motor la sube).
      const sb = sharedRef.current.get(found.bandId)
      if (!sb) return 'Ya no tienes acceso a la banda de ese respaldo.'
      if (!canEditRole(sb.role)) return READ_ONLY_NOTICE
      const slice = sliceBand(restored, found.bandId)
      if (!slice) return 'El respaldo no corresponde a esa banda.'
      const merged = mergeWorkspace(currentPersonal(current), [...sharedRef.current.values()].map((x) => (x.id === sb.id ? { ...x, data: slice } : x)), current.activeBandId)
      setWorkspace(merged)
      return null
    }
    // Respaldo del workspace personal: las bandas compartidas no se tocan.
    const personal = personalPart(restored, new Set(sharedRef.current.keys()), restored.activeBandId)
    if (personal.bands.length === 0) return 'El respaldo no trae bandas personales.'
    const merged = mergeWorkspace(personal, [...sharedRef.current.values()], personal.activeBandId)
    // Es una edicion del usuario: se guarda y se sube como version nueva.
    setWorkspace(merged)
    setActivePlaylistId(firstPlaylistId(merged))
    return null
  }

  const downloadBackup = (backupId: string) => {
    const found = findBackup(backupId)
    if (!found) return
    const { backup } = found
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

  /** Refleja en la UI la lista de integrantes de una banda compartida sin tratarlo como edicion de contenido. */
  const setSharedMembers = (bandId: string, mutate: (list: BandMember[]) => BandMember[]) => {
    const sb = sharedRef.current.get(bandId)
    if (!sb) return
    sharedRef.current.set(bandId, { ...sb, members: mutate(sb.members) })
    setWorkspace(rebuildMerged(currentPersonal(workspaceRef.current), workspaceRef.current.activeBandId))
  }

  // En bandas personales es una guardia de cliente (services/roles.ts). En compartidas, RLS
  // decide en el servidor: aqui se refleja de inmediato y se revierte si la nube lo rechaza.
  const updateMemberRole = (memberId: string, newRole: MemberRole) => {
    if (!activeBand || !roleActor) return { ok: false, reason: 'Sin banda activa.' }
    const check = checkRoleChange(members, roleActor, memberId, newRole)
    if (!check.ok) return check
    const bandId = activeBand.id
    if (sharedFlags.has(bandId)) {
      const target = members.find((m) => m.id === memberId)
      const client = getSupabaseClient()
      if (!target || !client) return { ok: false, reason: 'Sin conexión con la nube.' }
      setSharedMembers(bandId, (list) => list.map((m) => (m.id === memberId ? { ...m, role: newRole } : m)))
      void updateBandMemberRole(client, bandId, target.email, newRole).then((res) => {
        if (!res.ok) setAuthNotice(`No se cambió el rol de ${target.name}: ${res.error.message}`)
        void refreshShared()
      })
      return check
    }
    setWorkspace((prev) => ({
      ...prev,
      membersMap: {
        ...prev.membersMap,
        [bandId]: (prev.membersMap[bandId] || []).map((m) => (m.id === memberId ? { ...m, role: newRole } : m)),
      },
    }))
    return check
  }

  const inviteMember = async (name: string, email: string, role: MemberRole, instrument: string): Promise<HubActionResult> => {
    if (!activeBand) return { ok: false, message: 'Sin banda activa.' }
    const bandId = activeBand.id
    const cleanEmail = normalizeEmail(email)
    if (!isValidEmail(cleanEmail)) return { ok: false, message: 'Escribe un correo válido (el de su cuenta de Google).' }
    if (sharedFlags.has(bandId)) {
      if (!canInviteRole(activeBandRole)) return { ok: false, message: 'Solo el Owner y el MusicDirector invitan integrantes.' }
      // Solo un Owner invita a otro Owner (lo mismo que exige RLS).
      const finalRole: MemberRole = role === 'Owner' && activeBandRole !== 'Owner' ? 'MusicDirector' : role
      const client = getSupabaseClient()
      if (!client) return { ok: false, message: 'Sin conexión con la nube.' }
      const res = await insertBandMembers(client, bandId, [
        { email: cleanEmail, role: finalRole, name: name.trim().slice(0, 120), instrument: instrument.trim().slice(0, 120) },
      ])
      if (!res.ok) return { ok: false, message: res.error.message }
      void refreshShared()
      return {
        ok: true,
        message: `${cleanEmail} ya tiene acceso. Mándale el enlace: al entrar con "Continuar con Google" usando ese correo verá la banda.`,
        bandId,
        link: inviteLink(getAuthRedirectUrl(), bandId),
      }
    }
    const newMember: BandMember = {
      id: `mem_${Date.now()}`,
      bandId,
      userId: `usr_invited_${Date.now()}`,
      name,
      email: cleanEmail,
      // Nunca se agrega a alguien directamente como Owner desde la invitacion.
      role: role === 'Owner' ? 'Musician' : role,
      instrument,
      joinedAt: new Date().toISOString().slice(0, 10),
    }
    setWorkspace((prev) => ({
      ...prev,
      membersMap: {
        ...prev.membersMap,
        [bandId]: [...(prev.membersMap[bandId] || []), newMember],
      },
    }))
    return {
      ok: true,
      message: cloudUserId
        ? 'Quedó en la lista, pero esta banda aún no está compartida: comparte la banda para que esa persona pueda entrar.'
        : 'Quedó solo en la lista de este navegador: para invitar de verdad inicia sesión con Google (nube) y comparte la banda.',
    }
  }

  /** Quita a un integrante de una banda compartida (un Owner a cualquiera). */
  const removeMember = async (memberId: string): Promise<HubActionResult> => {
    if (!activeBand) return { ok: false, message: 'Sin banda activa.' }
    const bandId = activeBand.id
    const target = members.find((m) => m.id === memberId)
    if (!target) return { ok: false, message: 'Integrante no encontrado.' }
    if (!sharedFlags.has(bandId)) {
      if (target.role === 'Owner') return { ok: false, message: 'No se puede quitar al Owner.' }
      setWorkspace((prev) => ({
        ...prev,
        membersMap: { ...prev.membersMap, [bandId]: (prev.membersMap[bandId] || []).filter((m) => m.id !== memberId) },
      }))
      return { ok: true, message: `${target.name} salió de la lista.` }
    }
    // RLS deja entrar siempre a quien la creo (owner_id), aunque se borre su fila: no tiene sentido quitarlo.
    if (target.userId === activeBand.ownerId) return { ok: false, message: 'Quien creó la banda no se puede quitar.' }
    const client = getSupabaseClient()
    if (!client) return { ok: false, message: 'Sin conexión con la nube.' }
    const res = await deleteBandMember(client, bandId, target.email)
    void refreshShared()
    return res.ok ? { ok: true, message: `${target.name} ya no tiene acceso a la banda.` } : { ok: false, message: res.error.message }
  }

  /** El usuario actual deja una banda compartida que no creo. */
  const leaveActiveBand = async (): Promise<HubActionResult> => {
    if (!activeBand || !sharedFlags.has(activeBand.id)) return { ok: false, message: 'Esta banda no es compartida.' }
    if (activeBand.ownerId === user?.id) return { ok: false, message: 'Creaste esta banda: no puedes salirte de ella.' }
    const client = getSupabaseClient()
    if (!client) return { ok: false, message: 'Sin conexión con la nube.' }
    const res = await deleteBandMember(client, activeBand.id, normalizeEmail(sessionEmail))
    if (!res.ok) return { ok: false, message: res.error.message }
    await refreshShared()
    return { ok: true, message: `Saliste de ${activeBand.name}.` }
  }

  /**
   * Convierte la banda activa (personal) en compartida: crea su fila en la nube con un id nuevo,
   * invita a los integrantes que tengan correo y la quita del workspace personal.
   */
  const shareActiveBand = async (): Promise<HubActionResult> => {
    const me = userRef.current
    if (!cloudUserId || !me) return { ok: false, message: 'Para compartir inicia sesión con "Continuar con Google (nube)".' }
    if (!activeBand) return { ok: false, message: 'Sin banda activa.' }
    if (sharedFlags.has(activeBand.id)) return { ok: true, message: 'La banda ya está compartida.', link: inviteLink(getAuthRedirectUrl(), activeBand.id) }
    if (sharedAvailable === false) return { ok: false, message: sharedError ?? 'Falta ejecutar docs/sql/bandas_compartidas.sql en Supabase.' }
    const client = getSupabaseClient()
    if (!client) return { ok: false, message: 'Sin conexión con la nube.' }
    const ws = workspaceRef.current
    const fromId = activeBand.id
    const slice = sliceBand(ws, fromId)
    if (!slice) return { ok: false, message: 'Sin banda activa.' }
    const newId = uuidv4()
    const content = remapBandId(slice, fromId, newId)
    content.bands = content.bands.map((b) => ({ ...b, ownerId: cloudUserId }))
    const created = await createSharedBand(client, newId, content, nowIso())
    if (!created.ok) return { ok: false, message: `No se pudo compartir: ${created.error.message}` }
    const invites = invitesFromMembers(ws.membersMap[fromId] ?? [], sessionEmail)
    const invited = await insertBandMembers(client, newId, invites)

    // Local: la banda sale del workspace personal y entra como compartida.
    const current = workspaceRef.current
    let personal = personalPart(current, new Set([...sharedRef.current.keys(), fromId]), personalRef.current.activeBandId)
    const createdPlaceholder = personal.bands.length === 0
    if (createdPlaceholder) {
      // El workspace personal nunca queda vacio (el formato exige al menos una banda). Se usa
      // una banda vacia y con nombre explicito: recrear la banda de ejemplo con datos de
      // muestra hacia parecer que se habia compartido otra banda.
      const placeholderId = `band_${uuidv4().slice(0, 8)}`
      personal = {
        ...personal,
        bands: [
          { id: placeholderId, name: 'Espacio personal', genre: '', ownerId: me.id, currentUserRole: 'Owner', membersCount: 1, createdAt: today() },
        ],
        activeBandId: placeholderId,
        membersMap: { [placeholderId]: [] },
        playlistsMap: { [placeholderId]: [] },
        equipmentMap: { [placeholderId]: [] },
        songsMap: { [placeholderId]: [] },
        voiceMap: { [placeholderId]: defaultVoiceConfig() },
      }
    }
    sharedRef.current.set(newId, { id: newId, ownerId: cloudUserId, role: 'Owner', data: content, members: [] })
    const merged = rebuildMerged(personal, newId)
    workspaceRef.current = merged
    setWorkspace(merged)
    setActivePlaylistId(firstPlaylistId(merged))
    setSharedKey(sharedEnginesKey(sharedRef.current.values()))
    saveSharedCache(cloudUserId)
    void refreshShared()
    const others = invites.filter((i) => i.email !== normalizeEmail(sessionEmail)).length
    const placeholderNote = createdPlaceholder
      ? ' Era tu única banda personal: se creó "Espacio personal", vacía, para tus bandas privadas.'
      : ''
    return {
      ok: true,
      message:
        (invited.ok
          ? `${activeBand.name} quedó compartida${others ? ` con ${others} integrante(s) invitado(s)` : ''}. Invita a más desde INTEGRANTES y mándales el enlace.`
          : `${activeBand.name} quedó compartida, pero no se pudieron crear las invitaciones: ${invited.error.message}`) + placeholderNote,
      link: inviteLink(getAuthRedirectUrl(), newId),
      bandId: newId,
    }
  }

  /** Copia un setlist de la banda activa (con sus canciones) a otra banda que el usuario pueda editar. */
  const copyPlaylistToBand = (playlistId: string, targetBandId: string): HubActionResult => {
    if (!activeBand) return { ok: false, message: 'Sin banda activa.' }
    const target = workspace.bands.find((b) => b.id === targetBandId)
    if (!target) return { ok: false, message: 'Banda de destino no encontrada.' }
    if (sharedFlags.has(targetBandId) && !sharedFlags.get(targetBandId)) {
      return { ok: false, message: `En ${target.name} tu rol es de solo lectura.` }
    }
    const result = copyPlaylistBetweenBands(workspaceRef.current, activeBand.id, playlistId, targetBandId, uuidv4, nowIso())
    if (!result) return { ok: false, message: 'No se pudo copiar el setlist.' }
    setWorkspace(result.workspace)
    const reused = result.reusedSongs ? `, ${result.reusedSongs} ya estaban` : ''
    return { ok: true, message: `"${result.playlist.name}" copiado a ${target.name}: ${result.createdSongs} canciones nuevas${reused}.` }
  }

  const sharing: SharingInfo = {
    available: sharedAvailable,
    error: sharedError,
    cloudSignedIn: !!cloudUserId,
    activeShared: activeIsShared,
    activeCanEdit: !activeReadOnly,
    activeCanInvite: activeIsShared ? canInviteRole(activeBandRole) : true,
    activeLink: activeIsShared && activeBand ? inviteLink(getAuthRedirectUrl(), activeBand.id) : null,
    sharedBandIds: [...sharedFlags.keys()],
    editableBandIds: workspace.bands.filter((b) => !sharedFlags.has(b.id) || sharedFlags.get(b.id)).map((b) => b.id),
  }

  const createPlaylist = (name: string, description: string) => {
    if (!activeBand || blockIfReadOnly()) return
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
    if (!activeBand || !activePlaylist || blockIfReadOnly()) return
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
    if (!activeBand || blockIfReadOnly()) return null
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
    if (!activeBand || blockIfReadOnly()) return
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
    if (!activeBand || blockIfReadOnly()) return
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
    if (!activeBand || blockIfReadOnly()) return
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
    // Reemplaza solo la parte personal: las bandas compartidas viven en la nube y no se tocan
    // (si el archivo las trae, p. ej. una exportacion de este mismo Hub, se ignoran).
    const sharedIds = new Set(sharedRef.current.keys())
    const imported = personalPart(clone(result.workspace), sharedIds, result.workspace.activeBandId)
    if (imported.bands.length === 0) {
      return { ok: false, message: 'El archivo solo trae bandas compartidas que ya tienes en la nube.' }
    }
    const merged = mergeWorkspace(imported, [...sharedRef.current.values()], imported.activeBandId)
    setWorkspace(merged)
    setActivePlaylistId(firstPlaylistId(merged))
    const warn = result.warnings.length > 0 ? ` (${result.warnings.length} advertencias de formato)` : ''
    const keptShared = sharedIds.size > 0 ? ` Tus ${sharedIds.size} banda(s) compartida(s) no se tocaron.` : ''
    return { ok: true, message: `Workspace importado: ${imported.bands.length} banda(s)${warn}.${keptShared}` }
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
    if (!activeBand || blockIfReadOnly()) return
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
    if (!activeBand || blockIfReadOnly()) return
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
    removeMember,
    leaveActiveBand,
    shareActiveBand,
    copyPlaylistToBand,
    sharing,
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
