/**
 * Identificadores de perfiles y URLs de autenticacion. Modulo puro (probado con
 * `node scripts/verify-sync-logic.ts`).
 *
 * Regla: la UNICA clave que se usa en la nube es `session.user.id` de Supabase Auth.
 * Los ids de este archivo son claves de localStorage de este navegador y nunca se
 * envian a Supabase.
 */

/**
 * Reproduce EXACTAMENTE el id que generaba el formulario "cuenta personal" hasta
 * 2026-09-30 (`usr_google_` + btoa(email).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)),
 * que ademas era la clave de la fila en Supabase. Solo se usa para encontrar el
 * workspace local antiguo de este navegador y migrarlo; la migracion SQL opcional de
 * docs/DEPLOY.md replica la misma formula.
 *
 * Limites de esa formula (por eso se retiro):
 * - btoa trabaja sobre Latin-1: un correo con caracteres por encima de U+00FF lanzaba
 *   error y nunca obtuvo id.
 * - 16 caracteres base64 equivalen a ~12 bytes: dos correos que comparten los primeros
 *   ~12 caracteres colisionan en el mismo id.
 */
export function legacyEmailProfileId(email: string): string | null {
  const clean = email.trim().toLowerCase()
  if (!clean) return null
  try {
    return `usr_google_${btoa(clean).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`
  } catch {
    return null
  }
}

/** Hash no criptografico de 53 bits (cyrb53); solo para separar perfiles locales. */
function cyrb53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** Id de un perfil local (sin nube). Depende del correo completo, sin colisiones por prefijo. */
export function localProfileId(email: string): string {
  return `local_${cyrb53(email.trim().toLowerCase())}`
}

/**
 * URL a la que Supabase devuelve al usuario tras el login con Google:
 * origen + directorio real de la app. En produccion `/hub/` (o `/hub/index.html`),
 * en desarrollo `/`. La base de Vite es `./`, asi que no se puede usar BASE_URL.
 */
export function computeAuthRedirectUrl(origin: string, pathname: string): string {
  const dir = pathname.replace(/[^/]*$/, '') || '/'
  return `${origin}${dir.startsWith('/') ? dir : `/${dir}`}`
}
