import type { UserProfile } from '../types/hub'

const STORAGE_USER_KEY = 'bandait_hub_user'
const STORAGE_TOKEN_KEY = 'bandait_hub_token'
const STORAGE_CLIENT_ID_KEY = 'bandait_google_client_id'

export const DEMO_PROFILES: UserProfile[] = [
  {
    id: 'usr_director_01',
    name: 'Carlos Mendoza',
    email: 'carlos.director@bandait.live',
    avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150&auto=format&fit=crop&q=80',
    authProvider: 'google',
    createdAt: '2026-01-15T10:00:00Z',
  },
  {
    id: 'usr_foh_02',
    name: 'Alejandro Vélez',
    email: 'alejandro.foh@soundcraft.live',
    avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150&auto=format&fit=crop&q=80',
    authProvider: 'google',
    createdAt: '2026-02-10T14:30:00Z',
  },
  {
    id: 'usr_drummer_03',
    name: 'Mateo Gómez',
    email: 'mateo.drums@bandait.live',
    avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150&auto=format&fit=crop&q=80',
    authProvider: 'google',
    createdAt: '2026-03-01T09:15:00Z',
  },
]

export interface GoogleJwtPayload {
  sub: string
  name: string
  email: string
  picture?: string
  given_name?: string
  family_name?: string
  email_verified?: boolean
}

export function parseGoogleJwt(token: string): GoogleJwtPayload | null {
  try {
    const base64Url = token.split('.')[1]
    if (!base64Url) return null
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    )
    return JSON.parse(jsonPayload)
  } catch (err) {
    console.error('Error decoding Google JWT credential:', err)
    return null
  }
}

export const authService = {
  getGoogleClientId(): string {
    return (
      localStorage.getItem(STORAGE_CLIENT_ID_KEY) ||
      (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_CLIENT_ID) ||
      ''
    )
  },

  setGoogleClientId(clientId: string): void {
    if (clientId.trim()) {
      localStorage.setItem(STORAGE_CLIENT_ID_KEY, clientId.trim())
    } else {
      localStorage.removeItem(STORAGE_CLIENT_ID_KEY)
    }
  },

  getCurrentUser(): UserProfile | null {
    try {
      const saved = localStorage.getItem(STORAGE_USER_KEY)
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  },

  getToken(): string | null {
    return localStorage.getItem(STORAGE_TOKEN_KEY)
  },

  loginWithGoogleCredential(credentialJwt: string): UserProfile | null {
    const payload = parseGoogleJwt(credentialJwt)
    if (!payload || !payload.email) {
      throw new Error('Credencial de Google inválida o expirada')
    }

    const user: UserProfile = {
      id: `google_${payload.sub}`,
      name: payload.name || payload.email.split('@')[0],
      email: payload.email,
      avatarUrl:
        payload.picture ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(payload.name || payload.email)}&background=0066ff&color=fff`,
      authProvider: 'google',
      createdAt: new Date().toISOString(),
    }

    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user))
    localStorage.setItem(STORAGE_TOKEN_KEY, credentialJwt)
    return user
  },

  loginWithPersonalAccount(name: string, email: string): UserProfile {
    const cleanEmail = email.trim().toLowerCase()
    const cleanName = name.trim() || cleanEmail.split('@')[0]
    const userHash = btoa(cleanEmail).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)

    const user: UserProfile = {
      id: `usr_google_${userHash}`,
      name: cleanName,
      email: cleanEmail,
      avatarUrl: `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanName)}&background=0066ff&color=fff`,
      authProvider: 'google',
      createdAt: new Date().toISOString(),
    }

    const token = `g_oauth2_${userHash}_${Date.now()}`
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user))
    localStorage.setItem(STORAGE_TOKEN_KEY, token)
    return user
  },

  loginWithDemoProfile(profile: UserProfile): UserProfile {
    const token = `g_demo_${profile.id}_${Date.now()}`
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(profile))
    localStorage.setItem(STORAGE_TOKEN_KEY, token)
    return profile
  },

  logout(): void {
    localStorage.removeItem(STORAGE_USER_KEY)
    localStorage.removeItem(STORAGE_TOKEN_KEY)
  },
}
