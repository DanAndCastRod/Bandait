import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useHub } from './hubContextCore'
import { GlobalAudioContext, type GlobalAudioEngine } from './globalAudioContextCore'
import { SplitQueueProvider } from './SplitQueueContext'
import { audioScope, GlobalAudioCore, stemSessionKey, type AudioView, type PlayableHandle } from '../services/globalAudioCore'
import { StemSession } from '../services/stemSession'
// Solo el tipo: el codigo del Estudio sigue cargandose aparte (App.tsx lo importa con lazy()).
import type { StudioController } from '../components/studio/studioState'

/** Adaptador del StudioController al nucleo (sin importar su codigo). */
class StudioHandle implements PlayableHandle {
  readonly controller: StudioController

  constructor(controller: StudioController) {
    this.controller = controller
  }

  isPlaying(): boolean {
    const status = this.controller.snapshot().engine.status
    return status === 'playing' || status === 'count_in'
  }

  play(): void {
    this.controller.play()
  }

  pause(): void {
    this.controller.pause()
  }

  stop(): void {
    this.controller.stop()
  }

  progress(): number {
    const duration = this.controller.snapshot().engine.durationS
    return duration > 0 ? this.controller.engine.position() / duration : 0
  }

  title(): string {
    return this.controller.snapshot().session.title || 'Sesión del Estudio'
  }

  subtitle(): string | undefined {
    return 'Estudio'
  }

  view(): AudioView {
    return 'studio'
  }

  busy(): boolean {
    return this.controller.snapshot().recording
  }

  subscribe(listener: () => void): () => void {
    return this.controller.subscribe(listener)
  }

  dispose(): Promise<void> {
    return this.controller.dispose()
  }
}

/**
 * Audio global del Hub (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 3). Es dueno del reproductor de
 * stems de la cancion cargada (PISTAS / ENSAYO) y del controlador de la sesion abierta del
 * Estudio, asi que cambiar de vista no detiene ni cierra ningun AudioContext. Se libera al cargar
 * otra cancion, al cerrar la sesion del Estudio, al cambiar de banda y al cerrar sesion de
 * usuario. Monta tambien la cola "Drop & Split". Va dentro de HubProvider.
 */
export const GlobalAudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, activeBand } = useHub()
  const userId = user?.id ?? null
  const scope = audioScope(userId, activeBand?.id)
  const [core] = useState(() => new GlobalAudioCore<StemSession, StudioHandle>())

  // Cambio de banda o de usuario: se libera lo que pertenecia al ambito anterior.
  useEffect(() => {
    core.releaseOutside(scope)
  }, [core, scope])

  // Desmontaje: liberar todo. En un temporizador que el siguiente montaje cancela, por la recarga
  // en caliente de Vite (desmonta y vuelve a montar sin que la app se vaya).
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (releaseTimer.current !== null) clearTimeout(releaseTimer.current)
    releaseTimer.current = null
    return () => {
      releaseTimer.current = setTimeout(() => core.releaseAll(), 0)
    }
  }, [core])

  // La sesion del Estudio sigue abierta aunque su pestana no este montada: si se cierra o recarga
  // la pagina con una toma en curso o un guardado pendiente, se guarda ya y el navegador pregunta.
  useEffect(() => {
    const controller = () => core.studioHandle()?.controller ?? null
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const c = controller()
      if (c && (c.snapshot().recording || c.hasUnsavedWork())) {
        c.flushLocalSave()
        event.preventDefault()
      }
    }
    const flush = () => controller()?.flushLocalSave()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [core])

  const engine = useMemo<GlobalAudioEngine>(
    () => ({
      scope,
      acquireStem: ({ song, record, view }) => {
        const key = stemSessionKey(song.id, record.tracks.map((t) => t.id))
        const { handle } = core.acquireStem(key, scope, () => new StemSession({ key, song, record, view }))
        handle.touch(view, song)
        return handle
      },
      releaseStem: (songId) => {
        const current = core.stemHandle()
        if (!current || (songId !== undefined && current.songId !== songId)) return
        core.releaseStem()
      },
      currentStemSongId: () => core.stemHandle()?.songId ?? null,
      readStemView: <T,>(key: string, slot: string) => {
        const current = core.stemHandle()
        return current && current.key === key ? current.readView<T>(slot) : undefined
      },
      writeStemView: (key, slot, value) => {
        const current = core.stemHandle()
        if (current && current.key === key && !current.isDisposed()) current.writeView(slot, value)
      },
      openStudio: (controller, tag) => {
        const existing = core.studioHandle()
        if (existing && existing.controller === controller) return
        core.openStudio(`${tag}#${controller.sessionId}`, scope, new StudioHandle(controller))
      },
      adoptStudio: (tag) => {
        const handle = core.studioHandle()
        const key = core.studioKey()
        if (!handle || !key || core.studioScope() !== scope || !key.startsWith(`${tag}#`)) return null
        return handle.controller
      },
      closeStudio: () => core.closeStudio(),
      toggle: () => core.toggle(),
      stop: () => core.stop(),
      progress: () => core.progress(),
      subscribeNowPlaying: (listener) => core.subscribe(listener),
      getNowPlaying: () => core.nowPlaying(),
    }),
    [core, scope]
  )

  return (
    <GlobalAudioContext.Provider value={engine}>
      <SplitQueueProvider userId={userId}>{children}</SplitQueueProvider>
    </GlobalAudioContext.Provider>
  )
}
