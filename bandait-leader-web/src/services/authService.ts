import type { AuthProvider, UserProfile } from '../types/hub'
import { decodeJwtPayload } from './jwt'
import { localProfileId } from './identity'

/**
 * Perfiles del Hub que NO son la nube: perfil local (nombre + correo), perfil local con
 * Google Identity Services y perfiles de demostracion. Ninguno de ellos prueba identidad
 * ante un servidor ni habilita la sincronizacion con Supabase. La identidad de nube vive
 * en supabaseClient.ts (sesion de Supabase Auth).
 */

const STORAGE_USER_KEY = 'bandait_hub_user'
const LEGACY_TOKEN_KEY = 'bandait_hub_token'
const STORAGE_CLIENT_ID_KEY = 'bandait_google_client_id'

const BUILD_GOOGLE_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim()

export const GOOGLE_CLIENT_ID_PATTERN = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/

export const DEMO_PROFILES: UserProfile[] = [
  {
    id: 'usr_director_01',
    name: 'Carlos Mendoza',
    email: 'carlos.director@bandait.live',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    authProvider: 'demo',
    createdAt: '2026-01-15T10:00:00Z',
  },
  {
    id: 'usr_foh_02',
    name: 'Alejandro Vélez',
    email: 'alejandro.foh@soundcraft.live',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    authProvider: 'demo',
    createdAt: '2026-02-10T14:30:00Z',
  },
  {
    id: 'usr_drummer_03',
    name: 'Mateo Gómez',
    email: 'mateo.drums@bandait.live',
    avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    authProvider: 'demo',
    createdAt: '2026-03-01T09:15:00Z',
  },
]

const DEMO_IDS = new Set(DEMO_PROFILES.map((p) => p.id))

export function isDemoProfileId(id: string): boolean {
  return DEMO_IDS.has(id)
}

export const PROVIDER_LABELS: Record<AuthProvider, string> = {
  supabase: 'CUENTA DE NUBE (GOOGLE VIA SUPABASE)',
  google_local: 'GOOGLE // PERFIL LOCAL (TOKEN NO VERIFICADO)',
  local: 'PERFIL LOCAL (SIN VERIFICAR)',
  demo: 'MODO DEMO (DATOS FICTICIOS)',
}

export interface GoogleJwtPayload {
  sub: string
  name?: string
  email: string
  picture?: string
  aud?: string
  iss?: string
  exp?: number
}

function avatarFor(name: string): string {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=0066ff&color=fff`
}

/** Normaliza perfiles guardados por versiones anteriores (authProvider 'google' | 'guest'). */
function normalizeStoredUser(value: unknown): UserProfile | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null
  const id = v.id
  let provider: AuthProvider
  if (v.authProvider === 'supabase' || v.authProvider === 'google_local' || v.authProvider === 'local' || v.authProvider === 'demo') {
    provider = v.authProvider
  } else if (DEMO_IDS.has(id)) {
    provider = 'demo'
  } else if (id.startsWith('google_')) {
    provider = 'google_local'
  } else {
    provider = 'local'
  }
  return {
    id,
    name: v.name,
    email: typeof v.email === 'string' ? v.email : '',
    avatarUrl: typeof v.avatarUrl === 'string' ? v.avatarUrl : undefined,
    authProvider: provider,
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
  }
}

function readClientIdOverride(): string {
  try {
    return (localStorage.getItem(STORAGE_CLIENT_ID_KEY) ?? '').trim()
  } catch {
    return ''
  }
}

let gisScriptPromise: Promise<void> | null = null

/** Carga el script de Google Identity Services solo cuando hay Client ID configurado. */
export function loadGoogleIdentityScript(): Promise<void> {
  if (typeof window !== 'undefined' && window.google?.accounts?.id) return Promise.resolve()
  if (gisScriptPromise) return gisScriptPromise
  gisScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => {
      gisScriptPromise = null
      reject(new Error('No se pudo cargar Google Identity Services.'))
    }
    document.head.appendChild(script)
  })
  return gisScriptPromise
}

export const authService = {
  /** Client ID de Google para GIS: override local valido, o VITE_GOOGLE_CLIENT_ID. Vacio si no hay. */
  getGoogleClientId(): string {
    const override = readClientIdOverride()
    if (override && GOOGLE_CLIENT_ID_PATTERN.test(override)) return override
    if (BUILD_GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID_PATTERN.test(BUILD_GOOGLE_CLIENT_ID)) return BUILD_GOOGLE_CLIENT_ID
    return ''
  },

  getGoogleClientIdSource(): 'override' | 'build' | 'none' {
    const override = readClientIdOverride()
    if (override && GOOGLE_CLIENT_ID_PATTERN.test(override)) return 'override'
    if (BUILD_GOOGLE_CLIENT_ID && GOOGLE_CLIENT_ID_PATTERN.test(BUILD_GOOGLE_CLIENT_ID)) return 'build'
    return 'none'
  },

  /** Guarda o borra el override. Devuelve un mensaje de error si el formato no es valido. */
  setGoogleClientId(clientId: string): string | null {
    const clean = clientId.trim()
    try {
      if (!clean) {
        localStorage.removeItem(STORAGE_CLIENT_ID_KEY)
        return null
      }
      if (!GOOGLE_CLIENT_ID_PATTERN.test(clean)) {
        return 'El Client ID debe tener la forma <numero>-<id>.apps.googleusercontent.com'
      }
      localStorage.setItem(STORAGE_CLIENT_ID_KEY, clean)
      return null
    } catch {
      return 'No se pudo guardar en este navegador (almacenamiento bloqueado).'
    }
  },

  getCurrentUser(): UserProfile | null {
    try {
      const saved = localStorage.getItem(STORAGE_USER_KEY)
      return saved ? normalizeStoredUser(JSON.parse(saved)) : null
    } catch {
      return null
    }
  },

  storeUser(user: UserProfile): void {
    try {
      localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user))
      // Las versiones anteriores guardaban un "token" inventado; no se usa para nada.
      localStorage.removeItem(LEGACY_TOKEN_KEY)
    } catch {
      // sin persistencia el perfil dura lo que dure la pestana
    }
  },

  /**
   * Perfil local a partir del boton de Google Identity Services.
   * El JWT se decodifica en el navegador y solo se hacen controles de cordura (aud, iss, exp);
   * su firma NO se verifica en ningun servidor. Por eso es un perfil LOCAL y nunca abre la nube.
   */
  loginWithGoogleCredential(credentialJwt: string, expectedClientId: string): UserProfile {
    const payload = decodeJwtPayload(credentialJwt) as Partial<GoogleJwtPayload> | null
    if (!payload || typeof payload.email !== 'string' || typeof payload.sub !== 'string') {
      throw new Error('Credencial de Google inválida.')
    }
    if (expectedClientId && payload.aud !== expectedClientId) {
      throw new Error('La credencial de Google no fue emitida para este Client ID.')
    }
    if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
      throw new Error('La credencial no proviene de Google.')
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) {
      throw new Error('La credencial de Google expiró. Intenta de nuevo.')
    }
    const name = payload.name || payload.email.split('@')[0]
    const user: UserProfile = {
      id: `google_${payload.sub}`,
      name,
      email: payload.email,
      avatarUrl: payload.picture || avatarFor(name),
      authProvider: 'google_local',
      createdAt: new Date().toISOString(),
    }
    this.storeUser(user)
    return user
  },

  /** Perfil local: el correo es solo una etiqueta, no se verifica y no da acceso a la nube. */
  loginWithLocalProfile(name: string, email: string): UserProfile {
    const cleanEmail = email.trim().toLowerCase()
    const cleanName = name.trim() || cleanEmail.split('@')[0] || 'Músico'
    const user: UserProfile = {
      id: localProfileId(cleanEmail || cleanName),
      name: cleanName,
      email: cleanEmail,
      avatarUrl: avatarFor(cleanName),
      authProvider: 'local',
      createdAt: new Date().toISOString(),
    }
    this.storeUser(user)
    return user
  },

  loginWithDemoProfile(profile: UserProfile): UserProfile {
    const user: UserProfile = { ...profile, authProvider: 'demo' }
    this.storeUser(user)
    return user
  },

  logout(): void {
    try {
      localStorage.removeItem(STORAGE_USER_KEY)
      localStorage.removeItem(LEGACY_TOKEN_KEY)
    } catch {
      // ignorar
    }
  },
}
