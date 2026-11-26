/**
 * Contexto y hooks del audio global (el proveedor vive en GlobalAudioContext.tsx; este archivo no
 * exporta componentes para que la recarga en caliente de Vite funcione).
 *
 * Uso:
 * - `useGlobalAudio()`: lo que necesita un mini reproductor. `nowPlaying` se actualiza al
 *   reproducir, pausar o cambiar de fuente y, mientras suena, a 4 Hz (no por cuadro). Para pintar
 *   el progreso con rAF, `progress()` lo da exacto sin re-render.
 * - `useGlobalAudioEngine()`: el objeto estable que usan StemStudio y el Estudio para pedir,
 *   reusar y liberar el reproductor. No se suscribe a nada: no provoca re-renders.
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import type { AudioSource, AudioView, NowPlaying } from '../services/globalAudioCore'
import type { StemSession } from '../services/stemSession'
import type { StemSongRecord } from '../services/stemStore'
import type { StudioController } from '../components/studio/studioState'
import type { Song } from '../types/hub'

export type { AudioSource, AudioView, NowPlaying }

export interface AcquireStemInput {
  song: Song
  record: StemSongRecord
  /** Vista que lo pide (subtitulo del mini reproductor y a donde volver). */
  view: 'tracks' | 'rehearsal'
}

export interface GlobalAudioEngine {
  /** Usuario + banda activa. Lo de otro ambito se libera solo. */
  readonly scope: string
  /**
   * Reproductor de la cancion: el mismo si ya estaba cargada con esas pistas (con su posicion,
   * velocidad, tono y mezcla), o uno nuevo que libera el de la cancion anterior.
   */
  acquireStem(input: AcquireStemInput): StemSession
  /** Libera el reproductor de stems (todo, o solo si es de `songId`). */
  releaseStem(songId?: string): void
  /** Cancion cargada en el reproductor global (para elegirla por defecto al volver a la vista). */
  currentStemSongId(): string | null
  /** Estado propio de una vista guardado junto al reproductor de `key` (p. ej. el tono de ENSAYO). */
  readStemView<T>(key: string, slot: string): T | undefined
  writeStemView(key: string, slot: string, value: unknown): void
  /** El Estudio abrio una sesion: el audio global pasa a ser su dueno. `tag` = banda de la vista. */
  openStudio(controller: StudioController, tag: string): void
  /** Sesion del Estudio abierta para `tag` en este ambito, o null. */
  adoptStudio(tag: string): StudioController | null
  /** Cierra la sesion del Estudio (guarda y libera el motor). */
  closeStudio(): Promise<void>
  toggle(): void
  stop(): void
  /** Progreso exacto 0..1 de lo que muestra el mini reproductor. */
  progress(): number
  subscribeNowPlaying(listener: () => void): () => void
  getNowPlaying(): NowPlaying | null
}

export interface GlobalAudioApi {
  /** null si no hay nada cargado. */
  nowPlaying: NowPlaying | null
  /** Reproduce o pausa lo que muestra `nowPlaying`. */
  toggle: () => void
  /** Detiene (sin liberar) lo que muestra `nowPlaying`. */
  stop: () => void
  /** Progreso exacto, para pintarlo con rAF sin re-render. */
  progress: () => number
}

export const GlobalAudioContext = createContext<GlobalAudioEngine | null>(null)

export function useGlobalAudioEngine(): GlobalAudioEngine {
  const engine = useContext(GlobalAudioContext)
  if (!engine) throw new Error('useGlobalAudioEngine must be used within a GlobalAudioProvider')
  return engine
}

const serverSnapshot = (): NowPlaying | null => null

export function useGlobalAudio(): GlobalAudioApi {
  const engine = useGlobalAudioEngine()
  const nowPlaying = useSyncExternalStore(engine.subscribeNowPlaying, engine.getNowPlaying, serverSnapshot)
  return useMemo(() => ({ nowPlaying, toggle: engine.toggle, stop: engine.stop, progress: engine.progress }), [nowPlaying, engine])
}
