import React, { useEffect, useMemo, useState } from 'react'
import { SPLIT_STORAGE_KEY, SplitQueue } from '../services/splitQueue'
import { separationFileProblem, separationStatusText, startSeparation, watchSeparation, type AnalysisState } from '../services/stemAnalysis'
import { downloadStems, StemCloudError, type CloudManifest, type CloudTarget } from '../services/stemCloud'
import { stemCloudTarget } from '../services/stemCloudConfig'
import { cloudStemsChanged } from '../services/stemCloudEvents'
import { StemStoreError, type StemSongRecord } from '../services/stemStore'
import { SplitQueueContext, type AppSplitQueue, type LocalSavedEvent, type SplitQueueValue } from './splitQueueContextCore'

function browserStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function createQueue(userId: string | null, emitLocal: (event: LocalSavedEvent) => void): AppSplitQueue {
  return new SplitQueue<CloudTarget, CloudManifest, StemSongRecord>({
    startSeparation: (target, songId, file, onUpload, signal) => startSeparation(target, songId, file, onUpload, signal),
    watchSeparation: (target, songId, opts) => watchSeparation(target, songId, opts),
    downloadStems: (target, songId, onProgress) => downloadStems(target, songId, onProgress),
    resolveTarget: (band) => stemCloudTarget(band),
    describe: (state) => separationStatusText(state as AnalysisState),
    errorMessage: (err) => (err instanceof StemCloudError || err instanceof StemStoreError ? err.message : 'No se pudo completar la separación.'),
    fileProblem: (file) => separationFileProblem({ name: (file as { name?: string }).name ?? '', type: file.type, size: file.size }),
    manifestOf: (state) => (state.status === 'SUCCEEDED' ? ((state as Extract<AnalysisState, { status: 'SUCCEEDED' }>).stems ?? null) : null),
    onCloudChanged: (band, songId, manifest) => cloudStemsChanged({ band, songId, manifest }),
    onLocalSaved: (band, songId, record) => emitLocal({ band, songId, record }),
    storage: browserStorage(),
    // El historial es de cada usuario: en un equipo compartido no se ven trabajos ajenos.
    storageKey: `${SPLIT_STORAGE_KEY}:${userId ?? 'anon'}`,
  })
}

interface Props {
  /** Usuario de la sesion: al cambiar (o cerrar sesion) se abortan sus trabajos y se carga el historial del nuevo. */
  userId: string | null
  children: React.ReactNode
}

/**
 * Cola global "Drop & Split". La monta GlobalAudioProvider. Los trabajos siguen al cambiar de
 * vista; al recargar la pagina, lo que estaba en curso queda 'interrumpido' (services/splitQueue.ts).
 */
export const SplitQueueProvider: React.FC<Props> = ({ userId, children }) => {
  const [localListeners] = useState(() => new Set<(event: LocalSavedEvent) => void>())
  const queue = useMemo(
    () =>
      createQueue(userId, (event) => {
        for (const l of [...localListeners]) {
          try {
            l(event)
          } catch {
            // Una vista rota no impide avisar a las demas.
          }
        }
      }),
    [userId, localListeners]
  )
  // Cambio de usuario o desmontaje: se aborta lo que corria (queda 'interrumpido' en su historial).
  useEffect(() => () => queue.dispose(), [queue])

  const value = useMemo<SplitQueueValue>(
    () => ({
      queue,
      onLocalSaved: (listener) => {
        localListeners.add(listener)
        return () => {
          localListeners.delete(listener)
        }
      },
    }),
    [queue, localListeners]
  )
  return <SplitQueueContext.Provider value={value}>{children}</SplitQueueContext.Provider>
}
