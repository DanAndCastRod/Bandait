import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import type { UserProfile, WorkspaceStore } from '../types/hub'
import { checkSupabasePublicKey, checkSupabaseUrl } from './jwt'
import { computeAuthRedirectUrl } from './identity'
import { uuidv4 } from './uuid'
import type { CloudAdapter, CloudError, CloudRow, FetchResult, RemoteHint, WriteResult } from './workspaceSync'
import { loadWorkspaceDocument } from './workspaceSchema'
import type { MemberRow } from './sharedBands'

/**
 * Supabase en el Web Admin Hub.
 *
 * Identidad: la unica identidad que puede usar la nube es la sesion de Supabase Auth
 * (Google como proveedor). La fila del workspace se indexa con `session.user.id` y las
 * politicas RLS de docs/DEPLOY.md exigen `auth.uid()::text = user_id`.
 *
 * Configuracion: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY en tiempo de compilacion;
 * el modal NUBE permite un override en localStorage. Nunca se acepta una service_role.
 */

export const STORAGE_SUPABASE_URL = 'bandait_supabase_url'
export const STORAGE_SUPABASE_KEY = 'bandait_supabase_anon_key'
const OAUTH_PENDING_KEY = 'bandait_oauth_pending'
export const WORKSPACE_TABLE = 'bandait_workspaces'

const BUILD_URL: string = (import.meta.env.VITE_SUPABASE_URL ?? '').trim()
const BUILD_KEY: string = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').trim()

/** Id de esta pestana: viaja en `_sync.client_id` para diagnostico. */
const TAB_CLIENT_ID = uuidv4()

export type SupabaseConfigSource = 'override' | 'build' | 'none'

export interface SupabaseConfig {
  url: string
  anonKey: string
  isConfigured: boolean
  source: SupabaseConfigSource
  /** Motivo por el que la configuracion presente se rechazo (p. ej. service_role). */
  error: string | null
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // almacenamiento bloqueado
  }
}

export function getSupabaseConfig(): SupabaseConfig {
  const overrideUrl = (safeGet(STORAGE_SUPABASE_URL) ?? '').trim()
  const overrideKey = (safeGet(STORAGE_SUPABASE_KEY) ?? '').trim()

  if (overrideUrl || overrideKey) {
    const keyCheck = checkSupabasePublicKey(overrideKey)
    if (!keyCheck.ok && keyCheck.secret) {
      // Una version anterior pudo haber guardado una clave secreta: se borra sin usarla.
      safeRemove(STORAGE_SUPABASE_KEY)
      safeRemove(STORAGE_SUPABASE_URL)
      return { url: '', anonKey: '', isConfigured: false, source: 'none', error: keyCheck.reason }
    }
    const urlCheck = checkSupabaseUrl(overrideUrl)
    if (!keyCheck.ok || !urlCheck.ok) {
      return {
        url: overrideUrl,
        anonKey: '',
        isConfigured: false,
        source: 'override',
        error: !keyCheck.ok ? keyCheck.reason : urlCheck.ok ? null : urlCheck.reason,
      }
    }
    return { url: urlCheck.url, anonKey: overrideKey, isConfigured: true, source: 'override', error: null }
  }

  if (BUILD_URL || BUILD_KEY) {
    const keyCheck = checkSupabasePublicKey(BUILD_KEY)
    const urlCheck = checkSupabaseUrl(BUILD_URL)
    if (!keyCheck.ok || !urlCheck.ok) {
      const reason = !keyCheck.ok
        ? `${keyCheck.reason}${keyCheck.secret ? ' La clave de compilación ya está dentro del bundle publicado: rótala y recompila con la anon key.' : ''}`
        : urlCheck.ok
          ? 'Configuración de compilación inválida.'
          : urlCheck.reason
      return { url: BUILD_URL, anonKey: '', isConfigured: false, source: 'build', error: reason }
    }
    return { url: urlCheck.url, anonKey: BUILD_KEY, isConfigured: true, source: 'build', error: null }
  }

  return { url: '', anonKey: '', isConfigured: false, source: 'none', error: null }
}

export type SaveConfigResult = { ok: true } | { ok: false; reason: string }

/** Guarda un override local. Rechaza service_role / sb_secret_ antes de tocar localStorage. */
export function saveSupabaseConfig(url: string, anonKey: string): SaveConfigResult {
  const keyCheck = checkSupabasePublicKey(anonKey)
  if (!keyCheck.ok) return { ok: false, reason: keyCheck.reason }
  const urlCheck = checkSupabaseUrl(url)
  if (!urlCheck.ok) return { ok: false, reason: urlCheck.reason }
  try {
    localStorage.setItem(STORAGE_SUPABASE_URL, urlCheck.url)
    localStorage.setItem(STORAGE_SUPABASE_KEY, anonKey.trim())
  } catch {
    return { ok: false, reason: 'No se pudo guardar en este navegador (almacenamiento bloqueado).' }
  }
  clientInstance = null
  return { ok: true }
}

export function clearSupabaseOverride(): void {
  safeRemove(STORAGE_SUPABASE_URL)
  safeRemove(STORAGE_SUPABASE_KEY)
  clientInstance = null
}

let clientInstance: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient | null {
  if (clientInstance) return clientInstance
  const config = getSupabaseConfig()
  if (!config.isConfigured) return null
  try {
    clientInstance = createClient(config.url, config.anonKey, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
    return clientInstance
  } catch (error) {
    console.error('[Supabase] No se pudo inicializar el cliente:', error)
    return null
  }
}

/** URL de retorno del login: origen + base real de la app (/hub/ en produccion, / en dev). */
export function getAuthRedirectUrl(): string {
  return computeAuthRedirectUrl(window.location.origin, window.location.pathname)
}

/**
 * Error devuelto por Supabase/Google en la URL de retorno (?error_description=... o #error=...).
 * Lo lee y limpia la URL. Debe llamarse una vez al arrancar.
 */
export function consumeOAuthRedirectError(): string | null {
  try {
    const url = new URL(window.location.href)
    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
    const description =
      url.searchParams.get('error_description') ?? hash.get('error_description') ?? url.searchParams.get('error') ?? hash.get('error')
    if (!description) return null
    for (const p of ['error', 'error_code', 'error_description']) url.searchParams.delete(p)
    const cleanHash = ['error', 'error_code', 'error_description'].some((p) => hash.has(p)) ? '' : url.hash
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${cleanHash}`)
    return description.replace(/\+/g, ' ')
  } catch {
    return null
  }
}

export function markOAuthPending(): void {
  try {
    sessionStorage.setItem(OAUTH_PENDING_KEY, String(Date.now()))
  } catch {
    // sin sessionStorage el retorno igual funciona si no hay perfil local activo
  }
}

/** true si este navegador inicio un login de nube en los ultimos 10 minutos. Lo consume. */
export function consumeOAuthPending(): boolean {
  try {
    const raw = sessionStorage.getItem(OAUTH_PENDING_KEY)
    sessionStorage.removeItem(OAUTH_PENDING_KEY)
    return !!raw && Date.now() - Number(raw) < 10 * 60 * 1000
  } catch {
    return false
  }
}

export async function signInWithSupabaseGoogle(): Promise<{ error: string | null }> {
  const client = getSupabaseClient()
  if (!client) {
    return { error: getSupabaseConfig().error ?? 'Supabase no está configurado en este Hub.' }
  }
  try {
    markOAuthPending()
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: getAuthRedirectUrl() },
    })
    return { error: error ? error.message : null }
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : 'No se pudo iniciar el login con Google.' }
  }
}

export async function signOutSupabase(): Promise<void> {
  const client = getSupabaseClient()
  if (!client) return
  try {
    // scope local: cierra solo este dispositivo (la laptop FOH no debe cerrar el telefono del director).
    await client.auth.signOut({ scope: 'local' })
  } catch (err) {
    console.warn('[Supabase] Error al cerrar sesión:', err)
  }
}

export function profileFromSupabaseUser(user: User): UserProfile {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const email = user.email ?? (typeof meta.email === 'string' ? meta.email : '')
  const name =
    (typeof meta.full_name === 'string' && meta.full_name) ||
    (typeof meta.name === 'string' && meta.name) ||
    email.split('@')[0] ||
    'Usuario'
  const avatar =
    (typeof meta.avatar_url === 'string' && meta.avatar_url) || (typeof meta.picture === 'string' && meta.picture) || undefined
  return {
    id: user.id,
    name,
    email,
    avatarUrl: avatar,
    authProvider: 'supabase',
    createdAt: user.created_at ?? new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Adaptador de la fila del workspace para el motor de sincronizacion
// ---------------------------------------------------------------------------

interface PgErrorLike {
  code?: string
  message?: string
}

export function classifySupabaseError(error: PgErrorLike | null, status: number): CloudError {
  const code = error?.code ?? ''
  const message = error?.message ?? 'Error desconocido'
  if (status === 0 || /failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(message)) {
    return { kind: 'network', message: 'Sin conexión con Supabase.', retryable: true }
  }
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') {
    return { kind: 'auth', message: 'La sesión de nube no es válida o expiró.', retryable: true }
  }
  if (status === 403 || code === '42501') {
    return {
      kind: 'permission',
      message: 'Permiso denegado por la base de datos (RLS). Revisa las políticas de docs/DEPLOY.md, sección 3.',
      retryable: false,
    }
  }
  if (code === '42P01' || code === 'PGRST205' || status === 404) {
    return {
      kind: 'schema',
      message: 'La tabla bandait_workspaces no existe en el proyecto Supabase. Ejecuta el SQL de docs/DEPLOY.md, sección 3.',
      retryable: false,
    }
  }
  if (status >= 500 || status === 429) {
    return { kind: 'network', message: `Supabase no disponible (HTTP ${status}).`, retryable: true }
  }
  return { kind: 'unknown', message: `Error de Supabase: ${message}`, retryable: false }
}

function readSyncField(workspace: unknown, field: string): string | null {
  if (!workspace || typeof workspace !== 'object') return null
  const sync = (workspace as Record<string, unknown>)._sync
  if (!sync || typeof sync !== 'object') return null
  const value = (sync as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : null
}

/**
 * Fila de la nube -> datos para el motor. `data` sale YA migrado a v2 (sin `_sync`), asi la
 * reconciliacion compara v2 contra v2: como la migracion es determinista, una fila v1 y la
 * copia local que ya se migro desde ese mismo v1 quedan "en sincronia" y no se escribe nada.
 * `raw` queda intacto para los respaldos.
 */
export function toWorkspaceCloudRow(record: { workspace: unknown; updated_at: unknown }): CloudRow<WorkspaceStore> {
  const raw = record.workspace
  const data = loadWorkspaceDocument(raw)
  return {
    data,
    raw,
    updatedAt: String(record.updated_at ?? ''),
    clientWriteId: readSyncField(raw, 'client_write_id'),
  }
}

function wrapWorkspace(data: WorkspaceStore, updatedAt: string, clientWriteId: string) {
  return {
    ...data,
    _sync: { schema: 1, client_write_id: clientWriteId, client_id: TAB_CLIENT_ID, updated_at: updatedAt },
  }
}

export function createWorkspaceCloudAdapter(client: SupabaseClient, userId: string): CloudAdapter<WorkspaceStore> {
  return {
    async fetchRow(): Promise<FetchResult<WorkspaceStore>> {
      try {
        const { data, error, status } = await client
          .from(WORKSPACE_TABLE)
          .select('workspace, updated_at')
          .eq('user_id', userId)
          .maybeSingle()
        if (error) return { ok: false, error: classifySupabaseError(error, status) }
        if (!data) return { ok: true, row: null }
        return { ok: true, row: toWorkspaceCloudRow(data as { workspace: unknown; updated_at: unknown }) }
      } catch (err) {
        return { ok: false, error: classifySupabaseError({ message: err instanceof Error ? err.message : String(err) }, 0) }
      }
    },

    async insertRow(ws, updatedAt, clientWriteId): Promise<WriteResult> {
      try {
        const { data, error, status } = await client
          .from(WORKSPACE_TABLE)
          .insert({ user_id: userId, workspace: wrapWorkspace(ws, updatedAt, clientWriteId), updated_at: updatedAt })
          .select('updated_at')
        if (error) {
          if (error.code === '23505' || status === 409) return { ok: false, conflict: true }
          return { ok: false, conflict: false, error: classifySupabaseError(error, status) }
        }
        const rows = (data ?? []) as Array<{ updated_at: unknown }>
        return { ok: true, updatedAt: rows[0] ? String(rows[0].updated_at) : updatedAt }
      } catch (err) {
        return {
          ok: false,
          conflict: false,
          error: classifySupabaseError({ message: err instanceof Error ? err.message : String(err) }, 0),
        }
      }
    },

    async updateRow(ws, updatedAt, clientWriteId, expectedUpdatedAt): Promise<WriteResult> {
      try {
        const { data, error, status } = await client
          .from(WORKSPACE_TABLE)
          .update({ workspace: wrapWorkspace(ws, updatedAt, clientWriteId), updated_at: updatedAt })
          .eq('user_id', userId)
          .eq('updated_at', expectedUpdatedAt)
          .select('updated_at')
        if (error) return { ok: false, conflict: false, error: classifySupabaseError(error, status) }
        const rows = (data ?? []) as Array<{ updated_at: unknown }>
        if (rows.length === 0) return { ok: false, conflict: true }
        return { ok: true, updatedAt: String(rows[0].updated_at) }
      } catch (err) {
        return {
          ok: false,
          conflict: false,
          error: classifySupabaseError({ message: err instanceof Error ? err.message : String(err) }, 0),
        }
      }
    },

    subscribe(onHint: (hint: RemoteHint) => void): () => void {
      const channel = client
        .channel(`bandait-ws-${userId}-${TAB_CLIENT_ID.slice(0, 8)}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: WORKSPACE_TABLE, filter: `user_id=eq.${userId}` },
          (payload) => {
            const rec = (payload.new ?? {}) as Record<string, unknown>
            onHint({
              updatedAt: typeof rec.updated_at === 'string' ? rec.updated_at : null,
              clientWriteId: readSyncField(rec.workspace, 'client_write_id'),
            })
          }
        )
        .subscribe()
      return () => {
        void client.removeChannel(channel)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Bandas compartidas (docs/sql/bandas_compartidas.sql)
// ---------------------------------------------------------------------------

export const BANDS_TABLE = 'bandait_bands'
export const MEMBERS_TABLE = 'bandait_band_members'

/** Documento de una banda compartida: valido solo si trae exactamente esa banda. */
export function toBandCloudRow(bandId: string, record: { content: unknown; updated_at: unknown }): CloudRow<WorkspaceStore> {
  const row = toWorkspaceCloudRow({ workspace: record.content, updated_at: record.updated_at })
  const ok = row.data !== null && row.data.bands.length === 1 && row.data.bands[0].id === bandId
  return ok ? row : { ...row, data: null }
}

function schemaAwareError(error: PgErrorLike | null, status: number): CloudError {
  const c = classifySupabaseError(error, status)
  if (c.kind === 'schema') {
    return { ...c, message: 'Las tablas de bandas compartidas no existen en Supabase. Ejecuta docs/sql/bandas_compartidas.sql.' }
  }
  return c
}

const thrown = (err: unknown): CloudError =>
  classifySupabaseError({ message: err instanceof Error ? err.message : String(err) }, 0)

/** Adaptador del motor de sincronizacion para la fila de UNA banda compartida. */
export function createBandCloudAdapter(client: SupabaseClient, bandId: string): CloudAdapter<WorkspaceStore> {
  return {
    async fetchRow(): Promise<FetchResult<WorkspaceStore>> {
      try {
        const { data, error, status } = await client.from(BANDS_TABLE).select('content, updated_at').eq('id', bandId).maybeSingle()
        if (error) return { ok: false, error: schemaAwareError(error, status) }
        if (!data) return { ok: true, row: null }
        return { ok: true, row: toBandCloudRow(bandId, data as { content: unknown; updated_at: unknown }) }
      } catch (err) {
        return { ok: false, error: thrown(err) }
      }
    },

    // La fila se crea al compartir (createSharedBand). Si el motor llega aqui la banda se borro o
    // se perdio el acceso: recrearla dejaria a este usuario como dueno de una banda ajena.
    async insertRow(): Promise<WriteResult> {
      return {
        ok: false,
        conflict: false,
        error: { kind: 'permission', message: 'La banda compartida ya no existe o perdiste el acceso.', retryable: false },
      }
    },

    async updateRow(ws, updatedAt, clientWriteId, expectedUpdatedAt): Promise<WriteResult> {
      try {
        const { data, error, status } = await client
          .from(BANDS_TABLE)
          .update({ content: wrapWorkspace(ws, updatedAt, clientWriteId), updated_at: updatedAt })
          .eq('id', bandId)
          .eq('updated_at', expectedUpdatedAt)
          .select('updated_at')
        if (error) return { ok: false, conflict: false, error: schemaAwareError(error, status) }
        const rows = (data ?? []) as Array<{ updated_at: unknown }>
        // 0 filas: otra escritura en medio o RLS (rol sin permiso de edicion). El motor relee y decide.
        if (rows.length === 0) return { ok: false, conflict: true }
        return { ok: true, updatedAt: String(rows[0].updated_at) }
      } catch (err) {
        return { ok: false, conflict: false, error: thrown(err) }
      }
    },

    subscribe(onHint: (hint: RemoteHint) => void): () => void {
      const channel = client
        .channel(`bandait-band-${bandId}-${TAB_CLIENT_ID.slice(0, 8)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: BANDS_TABLE, filter: `id=eq.${bandId}` }, (payload) => {
          const rec = (payload.new ?? {}) as Record<string, unknown>
          onHint({
            updatedAt: typeof rec.updated_at === 'string' ? rec.updated_at : null,
            clientWriteId: readSyncField(rec.content, 'client_write_id'),
          })
        })
        .subscribe()
      return () => {
        void client.removeChannel(channel)
      }
    },
  }
}

export interface SharedBandRow {
  id: string
  owner_id: string
  updated_at: string
  content: unknown
}

export type SharedListResult =
  | { ok: true; bands: SharedBandRow[]; members: MemberRow[] }
  | { ok: false; error: CloudError }

/** Bandas compartidas visibles para la sesion (RLS filtra) y sus integrantes. */
export async function listSharedBands(client: SupabaseClient): Promise<SharedListResult> {
  try {
    const bandsRes = await client.from(BANDS_TABLE).select('id, owner_id, updated_at, content')
    if (bandsRes.error) return { ok: false, error: schemaAwareError(bandsRes.error, bandsRes.status) }
    const bands = (bandsRes.data ?? []) as SharedBandRow[]
    if (bands.length === 0) return { ok: true, bands, members: [] }
    const membersRes = await client
      .from(MEMBERS_TABLE)
      .select('band_id, email, role, name, instrument, created_at')
      .in(
        'band_id',
        bands.map((b) => b.id)
      )
    if (membersRes.error) return { ok: false, error: schemaAwareError(membersRes.error, membersRes.status) }
    return { ok: true, bands, members: (membersRes.data ?? []) as MemberRow[] }
  } catch (err) {
    return { ok: false, error: thrown(err) }
  }
}

export type CloudOpResult = { ok: true } | { ok: false; error: CloudError }

/** Crea la fila de una banda compartida (quien llama queda como owner_id por RLS/default). */
export async function createSharedBand(
  client: SupabaseClient,
  bandId: string,
  content: WorkspaceStore,
  updatedAt: string
): Promise<CloudOpResult> {
  try {
    const { error, status } = await client
      .from(BANDS_TABLE)
      .insert({ id: bandId, content: wrapWorkspace(content, updatedAt, uuidv4()), updated_at: updatedAt })
      .select('id')
    if (error) return { ok: false, error: schemaAwareError(error, status) }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: thrown(err) }
  }
}

export async function insertBandMembers(
  client: SupabaseClient,
  bandId: string,
  rows: ReadonlyArray<{ email: string; role: string; name: string; instrument: string }>
): Promise<CloudOpResult> {
  if (rows.length === 0) return { ok: true }
  try {
    const { error, status } = await client.from(MEMBERS_TABLE).insert(rows.map((r) => ({ band_id: bandId, ...r })))
    if (error) {
      if (error.code === '23505' || status === 409) {
        return { ok: false, error: { kind: 'unknown', message: 'Ese correo ya está invitado a esta banda.', retryable: false } }
      }
      return { ok: false, error: schemaAwareError(error, status) }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: thrown(err) }
  }
}

/** Cambia el rol de una invitacion. 0 filas = RLS lo impidio (solo un Owner cambia roles). */
export async function updateBandMemberRole(client: SupabaseClient, bandId: string, email: string, role: string): Promise<CloudOpResult> {
  try {
    const { data, error, status } = await client
      .from(MEMBERS_TABLE)
      .update({ role })
      .eq('band_id', bandId)
      .eq('email', email)
      .select('email')
    if (error) return { ok: false, error: schemaAwareError(error, status) }
    if ((data ?? []).length === 0) {
      return { ok: false, error: { kind: 'permission', message: 'Solo un Owner de la banda puede cambiar roles.', retryable: false } }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: thrown(err) }
  }
}

/** Quita una invitacion (un Owner a cualquiera; cada quien a si mismo para salirse). */
export async function deleteBandMember(client: SupabaseClient, bandId: string, email: string): Promise<CloudOpResult> {
  try {
    const { data, error, status } = await client.from(MEMBERS_TABLE).delete().eq('band_id', bandId).eq('email', email).select('email')
    if (error) return { ok: false, error: schemaAwareError(error, status) }
    if ((data ?? []).length === 0) {
      return { ok: false, error: { kind: 'permission', message: 'No tienes permiso para quitar a ese integrante.', retryable: false } }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: thrown(err) }
  }
}

/** Avisos de cambios en la pertenencia (invitaciones nuevas, roles, salidas) y en bandas creadas o borradas. */
export function subscribeSharedBands(client: SupabaseClient, onChange: () => void): () => void {
  const channel = client
    .channel(`bandait-shared-${TAB_CLIENT_ID.slice(0, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: MEMBERS_TABLE }, () => onChange())
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: BANDS_TABLE }, () => onChange())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: BANDS_TABLE }, () => onChange())
    .subscribe()
  return () => {
    void client.removeChannel(channel)
  }
}

// ---------------------------------------------------------------------------
// Diagnostico
// ---------------------------------------------------------------------------

export interface HealthResult {
  ok: boolean
  level: 'ok' | 'warn' | 'error'
  message: string
}

/**
 * Comprueba si la tabla es legible SIN sesion (solo con la anon key), que es lo que
 * permitia la politica permisiva antigua. Usa un cliente aparte sin sesion persistida.
 */
export async function checkAnonExposure(): Promise<HealthResult> {
  const config = getSupabaseConfig()
  if (!config.isConfigured) {
    return { ok: false, level: 'error', message: config.error ?? 'Supabase no está configurado.' }
  }
  try {
    const probe = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'bandait-anon-probe' },
    })
    const { data, error, status } = await probe.from(WORKSPACE_TABLE).select('user_id').limit(1)
    if (error) {
      const c = classifySupabaseError(error, status)
      if (c.kind === 'permission' || c.kind === 'auth') {
        return { ok: true, level: 'ok', message: 'Correcto: sin sesión la tabla no es legible (anon sin permisos).' }
      }
      return { ok: false, level: 'error', message: c.message }
    }
    if ((data ?? []).length > 0) {
      return {
        ok: false,
        level: 'error',
        message:
          'INSEGURO: la tabla es legible sin sesión, cualquiera con la anon key puede leer y sobrescribir workspaces. Ejecuta YA el SQL de docs/DEPLOY.md, sección 3.',
      }
    }
    return {
      ok: false,
      level: 'warn',
      message:
        'Sin sesión no se devolvieron filas, pero anon conserva permisos sobre la tabla (o la tabla está vacía). No se puede confirmar: ejecuta el revoke de docs/DEPLOY.md, sección 3.',
    }
  } catch (err) {
    return { ok: false, level: 'error', message: `No se pudo contactar el servidor: ${err instanceof Error ? err.message : String(err)}` }
  }
}
