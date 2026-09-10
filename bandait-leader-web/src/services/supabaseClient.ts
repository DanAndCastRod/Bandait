import { createClient, SupabaseClient } from '@supabase/supabase-js'

export const STORAGE_SUPABASE_URL = 'bandait_supabase_url'
export const STORAGE_SUPABASE_KEY = 'bandait_supabase_anon_key'

// Default environment values if bundled with Vite, otherwise configured dynamically by user
const DEFAULT_URL = (import.meta as any).env?.VITE_SUPABASE_URL || ''
const DEFAULT_KEY = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || ''

let clientInstance: SupabaseClient | null = null

export function getSupabaseConfig(): { url: string; anonKey: string; isConfigured: boolean } {
  const url = localStorage.getItem(STORAGE_SUPABASE_URL) || DEFAULT_URL || ''
  const anonKey = localStorage.getItem(STORAGE_SUPABASE_KEY) || DEFAULT_KEY || ''
  return {
    url,
    anonKey,
    isConfigured: Boolean(url && anonKey),
  }
}

export function saveSupabaseConfig(url: string, anonKey: string): boolean {
  try {
    const cleanUrl = url.trim()
    const cleanKey = anonKey.trim()
    if (!cleanUrl || !cleanKey) return false
    localStorage.setItem(STORAGE_SUPABASE_URL, cleanUrl)
    localStorage.setItem(STORAGE_SUPABASE_KEY, cleanKey)
    clientInstance = null // Invalidate singleton
    return true
  } catch {
    return false
  }
}

export function clearSupabaseConfig(): void {
  localStorage.removeItem(STORAGE_SUPABASE_URL)
  localStorage.removeItem(STORAGE_SUPABASE_KEY)
  clientInstance = null
}

export function getSupabaseClient(): SupabaseClient | null {
  if (clientInstance) return clientInstance
  const { url, anonKey, isConfigured } = getSupabaseConfig()
  if (!isConfigured) return null

  try {
    clientInstance = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
    return clientInstance
  } catch (error) {
    console.error('[Supabase] Failed to initialize client:', error)
    return null
  }
}

export async function checkSupabaseHealth(): Promise<{ ok: boolean; message: string }> {
  const client = getSupabaseClient()
  if (!client) {
    return { ok: false, message: 'Supabase no esta configurado. Usando modo Local-First.' }
  }

  try {
    const { error } = await client.from('bandait_workspaces').select('count', { count: 'exact', head: true })
    if (error && error.code !== 'PGRST116') {
      return { ok: false, message: `Error de conexion: ${error.message}` }
    }
    return { ok: true, message: 'Conexion a PostgreSQL en la nube activa y verificada.' }
  } catch (err: any) {
    return { ok: false, message: `No se pudo contactar el servidor: ${err?.message || 'Error desconocido'}` }
  }
}

export async function signInWithSupabaseGoogle(): Promise<{ error: Error | null }> {
  const client = getSupabaseClient()
  if (!client) {
    return { error: new Error('Supabase no configurado. Ingresa la URL y Anon Key.') }
  }

  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
      },
    })
    return { error: error || null }
  } catch (err: any) {
    return { error: err }
  }
}

export async function signOutSupabase(): Promise<void> {
  const client = getSupabaseClient()
  if (client) {
    await client.auth.signOut()
  }
}

export async function syncWorkspaceToCloud(userId: string, workspaceData: any): Promise<boolean> {
  const client = getSupabaseClient()
  if (!client || !userId) return false

  try {
    const payload = {
      user_id: userId,
      workspace: workspaceData,
      updated_at: new Date().toISOString(),
    }

    const { error } = await client
      .from('bandait_workspaces')
      .upsert(payload, { onConflict: 'user_id' })

    if (error) {
      console.warn('[Supabase] Sync error (falling back to LocalStorage):', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[Supabase] Sync exception (local-first active):', err)
    return false
  }
}

export async function fetchWorkspaceFromCloud(userId: string): Promise<any | null> {
  const client = getSupabaseClient()
  if (!client || !userId) return null

  try {
    const { data, error } = await client
      .from('bandait_workspaces')
      .select('workspace, updated_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (error || !data) return null
    return data.workspace
  } catch (err) {
    console.warn('[Supabase] Fetch exception:', err)
    return null
  }
}

export function subscribeToWorkspaceChanges(
  userId: string,
  onRemoteUpdate: (workspace: any) => void
): (() => void) | null {
  const client = getSupabaseClient()
  if (!client || !userId) return null

  try {
    const channel = client
      .channel(`workspace-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'bandait_workspaces',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.new && (payload.new as any).workspace) {
            onRemoteUpdate((payload.new as any).workspace)
          }
        }
      )
      .subscribe()

    return () => {
      client.removeChannel(channel)
    }
  } catch (err) {
    console.warn('[Supabase] Realtime subscription failed:', err)
    return null
  }
}
