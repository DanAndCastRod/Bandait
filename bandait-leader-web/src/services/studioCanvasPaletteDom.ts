import { normalizeHex } from './appearance.ts'
import { APPEARANCE_EVENT } from './appearanceDom.ts'
import { buildStudioCanvasPalette, type StudioCanvasPalette } from './studioCanvasPalette.ts'

/**
 * Paleta de los lienzos del Estudio para el tema vigente del documento, cacheada. Se recalcula
 * solo cuando applyAppearance() avisa un cambio de tema o de acento (APPEARANCE_EVENT): los
 * bucles de pintado leen el objeto guardado, nunca estilos computados por cuadro.
 */

let current: StudioCanvasPalette | null = null
const listeners = new Set<() => void>()

function readDocument(): StudioCanvasPalette {
  if (typeof document === 'undefined') return buildStudioCanvasPalette(null, null)
  const root = document.documentElement
  const theme = root.dataset.theme
  // El acento lo escriben en <html style> applyAppearance() y el script de index.html; sin el,
  // el del tema (que buildStudioCanvasPalette pone si llega null).
  let accent = normalizeHex(root.style.getPropertyValue('--b-accent'))
  if (!accent && typeof getComputedStyle === 'function') accent = normalizeHex(getComputedStyle(root).getPropertyValue('--b-accent'))
  return buildStudioCanvasPalette(theme, accent)
}

function onAppearance(): void {
  const next = readDocument()
  if (next === current) return
  current = next
  for (const listener of [...listeners]) listener()
}

/** Paleta vigente (el mismo objeto mientras no cambien tema ni acento). */
export function getStudioCanvasPalette(): StudioCanvasPalette {
  if (!current) current = readDocument()
  return current
}

/** Avisa cuando cambia la paleta. Devuelve la funcion para dejar de escuchar. */
export function subscribeStudioCanvasPalette(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener(APPEARANCE_EVENT, onAppearance)
    // Sin oyentes nadie seguia los cambios: se sincroniza al volver a escuchar.
    current = readDocument()
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener(APPEARANCE_EVENT, onAppearance)
  }
}
