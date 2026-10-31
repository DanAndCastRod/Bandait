/**
 * Configuracion de la nube de stems en el navegador: URL del Worker (VITE_BANDAIT_STEMS_URL,
 * publica, ver docs/DEPLOY.md seccion 3.6) y token de la sesion vigente de supabase-js.
 * Sin la variable o sin sesion de nube, el estudio de stems queda solo local.
 */
import { getSupabaseClient } from './supabaseClient'
import type { CloudTarget } from './stemCloud'

function parseStemsUrl(raw: string | undefined): string | null {
  const value = (raw ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

/** URL base del Worker, o null si la compilacion no la trae (o no es https). */
export const STEMS_CLOUD_URL: string | null = parseStemsUrl(import.meta.env.VITE_BANDAIT_STEMS_URL)

/** access_token de la sesion vigente; supabase-js lo renueva si esta por vencer. */
async function currentAccessToken(): Promise<string | null> {
  const client = getSupabaseClient()
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) return null
  return data.session?.access_token ?? null
}

export function stemCloudTarget(band: string): CloudTarget | null {
  if (!STEMS_CLOUD_URL) return null
  return { baseUrl: STEMS_CLOUD_URL, band, getToken: currentAccessToken }
}
