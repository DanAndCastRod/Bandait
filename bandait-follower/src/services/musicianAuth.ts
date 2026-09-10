import { createClient, SupabaseClient } from '@supabase/supabase-js'

export interface InEarMixPreferences {
  masterVolume: number
  clickVolume: number
  guideVolume: number
  pan: number // -1 (left) to 1 (right)
  channels: Record<string, { volume: number; mute: boolean; solo: boolean }>
}

export interface MusicianProfile {
  alias: string
  role: string
  email?: string
  avatarUrl?: string
  inEarMix: InEarMixPreferences
  lastSync?: string
}

interface CustomMetaEnv {
  VITE_SUPABASE_URL?: string
  VITE_SUPABASE_ANON_KEY?: string
}

const STORAGE_PROFILE_KEY = 'bandait_musician_profile'
const STORAGE_SUPABASE_URL = 'bandait_supabase_url'
const STORAGE_SUPABASE_KEY = 'bandait_supabase_anon_key'

export const STAGE_ROLES = [
  { id: 'drums', label: 'Bateria / Percusion' },
  { id: 'bass', label: 'Bajo Electrico' },
  { id: 'guitar_lead', label: 'Guitarra Lider' },
  { id: 'guitar_rhythm', label: 'Guitarra Ritmica' },
  { id: 'keys', label: 'Teclados / Sintetizador' },
  { id: 'lead_vox', label: 'Voz Principal' },
  { id: 'backing_vox', label: 'Coros / Segundas' },
  { id: 'brass', label: 'Metales / Vientos' },
  { id: 'director', label: 'Director Musical' },
  { id: 'stage_tech', label: 'Tecnico de Escenario' },
]

export const DEFAULT_MIX: InEarMixPreferences = {
  masterVolume: 0.85,
  clickVolume: 0.9,
  guideVolume: 0.75,
  pan: 0,
  channels: {
    click: { volume: 0.9, mute: false, solo: false },
    guide: { volume: 0.75, mute: false, solo: false },
    drums: { volume: 0.7, mute: false, solo: false },
    bass: { volume: 0.7, mute: false, solo: false },
    guitars: { volume: 0.7, mute: false, solo: false },
    keys: { volume: 0.7, mute: false, solo: false },
  },
}

export const DEFAULT_PROFILE: MusicianProfile = {
  alias: 'Musico de Tarima',
  role: 'drums',
  inEarMix: DEFAULT_MIX,
}

let clientInstance: SupabaseClient | null = null

function getMetaEnv(): CustomMetaEnv {
  try {
    return (import.meta as unknown as { env?: CustomMetaEnv }).env || {}
  } catch {
    return {}
  }
}

export function getSupabaseFollowerClient(): SupabaseClient | null {
  if (clientInstance) return clientInstance
  const env = getMetaEnv()
  const url = localStorage.getItem(STORAGE_SUPABASE_URL) || env.VITE_SUPABASE_URL || ''
  const anonKey = localStorage.getItem(STORAGE_SUPABASE_KEY) || env.VITE_SUPABASE_ANON_KEY || ''

  if (!url || !anonKey) return null

  try {
    clientInstance = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
    return clientInstance
  } catch {
    return null
  }
}

export function getMusicianProfile(): MusicianProfile {
  try {
    const raw = localStorage.getItem(STORAGE_PROFILE_KEY)
    if (!raw) return DEFAULT_PROFILE
    const parsed = JSON.parse(raw) as Partial<MusicianProfile>
    return {
      ...DEFAULT_PROFILE,
      ...parsed,
      inEarMix: {
        ...DEFAULT_MIX,
        ...(parsed.inEarMix || {}),
      },
    }
  } catch {
    return DEFAULT_PROFILE
  }
}

export function saveMusicianProfile(profile: MusicianProfile): void {
  try {
    localStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(profile))
  } catch {
    // LocalStorage quota or restricted mode fallback
  }
}

export async function signInMusicianWithGoogle(): Promise<{ error: Error | null }> {
  const client = getSupabaseFollowerClient()
  if (!client) {
    return { error: new Error('Supabase no configurado en este terminal. Usa el perfil local offline.') }
  }

  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
      },
    })
    return { error: error || null }
  } catch (err: unknown) {
    return { error: err instanceof Error ? err : new Error(String(err)) }
  }
}

export async function signOutMusician(): Promise<void> {
  const client = getSupabaseFollowerClient()
  if (client) {
    try {
      await client.auth.signOut()
    } catch {
      // Ignore network signout errors offline
    }
  }
}
