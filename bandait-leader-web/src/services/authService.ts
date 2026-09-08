import type { UserProfile } from '../types/hub'

const STORAGE_USER_KEY = 'bandait_hub_user'
const STORAGE_TOKEN_KEY = 'bandait_hub_token'

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

export const authService = {
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

  loginWithGoogle(profile?: UserProfile): UserProfile {
    const user = profile || DEMO_PROFILES[0]
    const token = `g_jwt_${btoa(user.email)}_${Date.now()}`
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user))
    localStorage.setItem(STORAGE_TOKEN_KEY, token)
    return user
  },

  logout(): void {
    localStorage.removeItem(STORAGE_USER_KEY)
    localStorage.removeItem(STORAGE_TOKEN_KEY)
  },
}
