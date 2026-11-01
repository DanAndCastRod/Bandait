/**
 * Aviso de "los stems de esta cancion cambiaron en la nube" entre vistas del hub. Cada vista
 * guarda los manifiestos que ya consulto (PISTAS, ENSAYO, el panel de analisis); al separar una
 * cancion con Music AI la nube cambia sin que esas vistas lo sepan, y este aviso les dice que
 * olviden ese manifiesto y lo vuelvan a pedir. Modulo puro (se prueba en verify-stems-logic.ts).
 */
import type { CloudManifest } from './stemCloud.ts'

export interface CloudStemsChange {
  /** 'me' o el uuid de la banda compartida (CloudTarget.band). */
  band: string
  songId: string
  /** Manifiesto nuevo si se conoce (la separacion lo devuelve); null si hay que pedirlo. */
  manifest: CloudManifest | null
}

type Listener = (change: CloudStemsChange) => void

const listeners = new Set<Listener>()

/** Avisa a las vistas montadas. Un oyente que falla no impide avisar a los demas. */
export function cloudStemsChanged(change: CloudStemsChange): void {
  for (const l of [...listeners]) {
    try {
      l(change)
    } catch {
      // Un oyente roto no debe dejar a las demas vistas con el manifiesto viejo.
    }
  }
}

/** Suscribe un oyente; devuelve la funcion para quitarlo (para el cleanup de un useEffect). */
export function onCloudStemsChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
