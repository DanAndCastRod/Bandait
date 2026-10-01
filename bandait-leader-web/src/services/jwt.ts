/**
 * Utilidades puras sobre JWT y claves de Supabase. Sin dependencias de navegador
 * (atob y TextDecoder existen en navegadores y en Node 18+), para poder probarlas
 * con `node scripts/verify-sync-logic.ts`.
 *
 * Ojo: decodificar un JWT NO es verificarlo. Nada de lo que sale de aqui prueba
 * identidad; solo sirve para rechazar claves peligrosas o para controles de cordura.
 */

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.trim().split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (base64.length % 4 !== 0) base64 += '='
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const json = new TextDecoder().decode(bytes)
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

export type SupabaseKeyCheck =
  | { ok: true; kind: 'anon_jwt' | 'publishable' }
  | { ok: false; secret: boolean; reason: string }

/**
 * Acepta solo claves publicas: la anon key clasica (JWT con role "anon") o una
 * publishable key (sb_publishable_...). Rechaza service_role y sb_secret_..., que
 * ignoran RLS y jamas deben llegar a un navegador.
 */
export function checkSupabasePublicKey(rawKey: string): SupabaseKeyCheck {
  const key = rawKey.trim()
  if (!key) {
    return { ok: false, secret: false, reason: 'Falta la anon key de Supabase.' }
  }
  if (key.startsWith('sb_secret_')) {
    return {
      ok: false,
      secret: true,
      reason:
        'Clave secreta (sb_secret_...) rechazada: da acceso total ignorando RLS y nunca debe ir en un navegador. Usa la publishable key o la anon key. Si ya la publicaste, rótala en Supabase.',
    }
  }
  if (key.startsWith('sb_publishable_')) {
    return { ok: true, kind: 'publishable' }
  }
  const payload = decodeJwtPayload(key)
  if (!payload) {
    return {
      ok: false,
      secret: false,
      reason: 'Formato de clave no reconocido. Se espera la anon key (JWT) o una publishable key (sb_publishable_...).',
    }
  }
  const role = payload.role
  if (role === 'service_role') {
    return {
      ok: false,
      secret: true,
      reason:
        'Clave service_role rechazada: da acceso total ignorando RLS y nunca debe ir en un navegador. Usa la anon key. Si ya la publicaste, rótala en Supabase (Project Settings -> API).',
    }
  }
  if (role !== 'anon') {
    return {
      ok: false,
      secret: false,
      reason: `La clave tiene rol "${String(role)}"; se espera una anon key (rol "anon").`,
    }
  }
  return { ok: true, kind: 'anon_jwt' }
}

export type SupabaseUrlCheck = { ok: true; url: string } | { ok: false; reason: string }

export function checkSupabaseUrl(rawUrl: string): SupabaseUrlCheck {
  const value = rawUrl.trim().replace(/\/+$/, '')
  if (!value) return { ok: false, reason: 'Falta la URL del proyecto Supabase.' }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, reason: 'La URL de Supabase no es válida.' }
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    return { ok: false, reason: 'La URL de Supabase debe usar https:// (http solo para localhost).' }
  }
  return { ok: true, url: value }
}
