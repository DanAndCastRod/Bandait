/**
 * Interruptor del Estudio Bandait (docs/PLAN_ESTUDIO_BANDAIT.md, regla 6). Un merge a `main`
 * publica el Hub, asi que el Estudio solo se ve con `VITE_BANDAIT_STUDIO=1` en la compilacion o
 * con `localStorage['bandait_studio'] = '1'` en ese navegador.
 *
 * Este modulo SI lee import.meta.env y localStorage: no lo importan los modulos de logica pura.
 */

export const STUDIO_FLAG_STORAGE_KEY = 'bandait_studio'

/** true si el Estudio debe mostrarse en este navegador. */
export function studioEnabled(): boolean {
  if (import.meta.env.VITE_BANDAIT_STUDIO === '1') return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STUDIO_FLAG_STORAGE_KEY) === '1'
  } catch {
    // Navegacion privada o almacenamiento bloqueado: el Estudio queda oculto.
    return false
  }
}
