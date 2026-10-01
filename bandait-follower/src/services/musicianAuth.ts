import type { SupabaseClient } from '@supabase/supabase-js'

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

let clientPromise: Promise<SupabaseClient | null> | null = null

function getMetaEnv(): CustomMetaEnv {
  try {
    return (import.meta as unknown as { env?: CustomMetaEnv }).env || {}
  } catch {
    return {}
  }
}

function supabaseConfig(): { url: string; anonKey: string } | null {
  const env = getMetaEnv()
  const url = (env.VITE_SUPABASE_URL || '').trim()
  const anonKey = (env.VITE_SUPABASE_ANON_KEY || '').trim()
  if (!url || !anonKey) return null
  return { url, anonKey }
}

/**
 * True only when this build has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
 * The UI hides the Google link otherwise (the profile stays local).
 */
export function isCloudAuthConfigured(): boolean {
  return supabaseConfig() !== null
}

/**
 * Lazily loads @supabase/supabase-js only when the build is configured, so
 * the stage bundle never pays for (or depends on) the cloud SDK otherwise.
 */
export function getSupabaseFollowerClient(): Promise<SupabaseClient | null> {
  const config = supabaseConfig()
  if (!config) return Promise.resolve(null)
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js')
      .then(({ createClient }) =>
        createClient(config.url, config.anonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
          },
        }),
      )
      .catch(() => {
        clientPromise = null // allow a retry (e.g. chunk not cached yet while offline)
        return null
      })
  }
  return clientPromise
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
  const client = await getSupabaseFollowerClient()
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
  const client = await getSupabaseFollowerClient()
  if (client) {
    try {
      await client.auth.signOut()
    } catch {
      // Ignore network signout errors offline
    }
  }
}
