/**
 * Contexto y hooks de la cola global "Drop & Split" (proveedor en SplitQueueContext.tsx, que
 * monta GlobalAudioProvider). La cola corre fuera de las vistas: cambiar de vista no aborta nada.
 */
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'
import type { SplitJob, SplitQueue } from '../services/splitQueue'
import type { CloudManifest, CloudTarget } from '../services/stemCloud'
import type { StemSongRecord } from '../services/stemStore'

export type AppSplitQueue = SplitQueue<CloudTarget, CloudManifest, StemSongRecord>

export interface LocalSavedEvent {
  band: string
  songId: string
  record: StemSongRecord
}

export interface SplitQueueValue {
  queue: AppSplitQueue
  /** Avisa cuando la cola guardo stems nuevos en este equipo (para refrescar PISTAS y ENSAYO). */
  onLocalSaved(listener: (event: LocalSavedEvent) => void): () => void
}

export const SplitQueueContext = createContext<SplitQueueValue | null>(null)

export function useSplitQueue(): SplitQueueValue {
  const value = useContext(SplitQueueContext)
  if (!value) throw new Error('useSplitQueue must be used within a SplitQueueProvider')
  return value
}

/** Trabajos de la cola (se re-renderiza en cada cambio de la cola, no por cuadro). */
export function useSplitJobs(): readonly SplitJob[] {
  const { queue } = useSplitQueue()
  return useSyncExternalStore(queue.subscribe.bind(queue), queue.list.bind(queue), queue.list.bind(queue))
}

/** Llama a `listener` cuando la cola guarda stems de esta banda en este equipo. */
export function useSplitLocalSaved(band: string | null, listener: (event: LocalSavedEvent) => void): void {
  const { onLocalSaved } = useSplitQueue()
  const ref = useRef(listener)
  useEffect(() => {
    ref.current = listener
  }, [listener])
  useEffect(
    () =>
      onLocalSaved((event) => {
        if (band !== null && event.band !== band) return
        ref.current(event)
      }),
    [onLocalSaved, band]
  )
}
