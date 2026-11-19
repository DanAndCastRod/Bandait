/**
 * Interruptor del Estudio Bandait (docs/PLAN_ESTUDIO_BANDAIT.md, regla 6).
 *
 * Desde el 2026-11-19 el Estudio esta ENCENDIDO por defecto (decision de Daniel Castaneda). El
 * interruptor queda como apagado de emergencia: `VITE_BANDAIT_STUDIO=0` en la compilacion lo
 * oculta para todos, y `localStorage['bandait_studio'] = '0'` lo oculta en ese navegador.
 *
 * Este modulo SI lee import.meta.env y localStorage: no lo importan los modulos de logica pura.
 */

export const STUDIO_FLAG_STORAGE_KEY = 'bandait_studio'

/** true si el Estudio debe mostrarse en este navegador. */
export function studioEnabled(): boolean {
  if (import.meta.env.VITE_BANDAIT_STUDIO === '0') return false
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(STUDIO_FLAG_STORAGE_KEY) !== '0'
  } catch {
    // Navegacion privada o almacenamiento bloqueado: no hay apagado local, el Estudio se muestra.
    return true
  }
}
