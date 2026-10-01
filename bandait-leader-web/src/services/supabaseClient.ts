import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { isWorkspaceStore, type UserProfile, type WorkspaceStore } from '../types/hub'
import { checkSupabasePublicKey, checkSupabaseUrl } from './jwt'
import { computeAuthRedirectUrl } from './identity'
import { uuidv4 } from './uuid'
import type { CloudAdapter, CloudError, CloudRow, FetchResult, RemoteHint, WriteResult } from './workspaceSync'

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

export function toWorkspaceCloudRow(record: { workspace: unknown; updated_at: unknown }): CloudRow<WorkspaceStore> {
  const raw = record.workspace
  let data: WorkspaceStore | null = null
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const rest: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
    delete rest._sync
    data = isWorkspaceStore(rest) ? rest : null
  }
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
