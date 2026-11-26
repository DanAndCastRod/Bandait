import { useSyncExternalStore } from 'react'
import { buildStudioCanvasPalette, type StudioCanvasPalette } from '../../services/studioCanvasPalette'
import { getStudioCanvasPalette, subscribeStudioCanvasPalette } from '../../services/studioCanvasPaletteDom'

const serverPalette = () => buildStudioCanvasPalette(null, null)

/**
 * Paleta de los lienzos del Estudio para el tema y el acento vigentes. Devuelve el mismo objeto
 * hasta que cambian (re-render solo entonces): los bucles de pintado la guardan en una ref y
 * repintan al cambiar, sin leer estilos por cuadro.
 */
export function useStudioCanvasPalette(): StudioCanvasPalette {
  return useSyncExternalStore(subscribeStudioCanvasPalette, getStudioCanvasPalette, serverPalette)
}
