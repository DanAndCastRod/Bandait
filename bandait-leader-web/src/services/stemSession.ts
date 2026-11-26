/**
 * Sesion de stems de una cancion: el StemPlayer, su carga y el estado de la interfaz que tiene
 * que sobrevivir al cambio de vista (mezcla, repeticion, velocidad, tono, Speed Ramp). La crea y
 * la libera el audio global (context/GlobalAudioContext.tsx); StemStudio solo la usa.
 *
 * La decodificacion corre aqui, no en el componente: si el musico se va de la vista a mitad de
 * carga, la carga termina igual y al volver encuentra las pistas listas.
 */
import type { AudioView, PlayableHandle } from './globalAudioCore'
import { StemPlayer, type ShifterStatus } from './stemPlayer'
import { DEFAULT_SPEED_RAMP, type SpeedRamp } from './stemPractice'
import { loadStemSong, StemStoreError, type StemSongRecord } from './stemStore'

export interface StemMix {
  db: number
  muted: boolean
  solo: boolean
}

export type StemTrackStatus = { kind: 'loading' } | { kind: 'ok' } | { kind: 'error'; message: string }

/** Lo que StemStudio guarda al cambiar y recupera al volver. */
export interface StemUiState {
  mix: Record<string, StemMix>
  masterDb: number
  loopMode: string
  ab: { a: number; b: number }
  speed: number
  /** Tono propio (PISTAS); ENSAYO lo maneja desde su vista (ver `view`). */
  localPitch: number
  ramp: SpeedRamp
  /** Estado de la vista que monta el reproductor (p. ej. tono y transposicion de ENSAYO). */
  view: Record<string, unknown>
}

export interface StemLoadState {
  status: Record<string, StemTrackStatus>
  loadError: string | null
  duration: number
  shifter: ShifterStatus
}

export interface StemSessionSpec {
  key: string
  song: { id: string; title: string; artist?: string }
  record: StemSongRecord
  view: AudioView
}

export class StemSession implements PlayableHandle {
  readonly key: string
  readonly songId: string
  readonly player = new StemPlayer()
  ui: StemUiState
  private songTitle: string
  private songArtist: string | undefined
  private origin: AudioView
  private load: StemLoadState
  private readonly loadListeners = new Set<() => void>()
  private disposed = false

  constructor(spec: StemSessionSpec) {
    this.key = spec.key
    this.songId = spec.song.id
    this.songTitle = spec.song.title
    this.songArtist = spec.song.artist?.trim() || undefined
    this.origin = spec.view
    const tracks = spec.record.tracks
    this.ui = {
      mix: Object.fromEntries(tracks.map((t) => [t.id, { db: 0, muted: false, solo: false }])),
      masterDb: 0,
      loopMode: 'none',
      ab: { a: 0, b: 0 },
      speed: 1,
      localPitch: 0,
      ramp: DEFAULT_SPEED_RAMP,
      view: {},
    }
    this.load = {
      status: Object.fromEntries(tracks.map((t) => [t.id, { kind: 'loading' } as StemTrackStatus])),
      loadError: null,
      duration: 0,
      shifter: 'pending',
    }
    void this.start(tracks.map((t) => t.id))
  }

  private async start(trackIds: string[]): Promise<void> {
    try {
      const loaded = await loadStemSong(this.songId)
      if (this.disposed) return
      await this.player.load(
        trackIds.map((id) => ({ id, blob: loaded?.blobs.get(id) ?? null })),
        (r) => {
          if (this.disposed) return
          this.patchLoad({ status: { ...this.load.status, [r.id]: r.ok ? { kind: 'ok' } : { kind: 'error', message: r.error } } })
        }
      )
      if (this.disposed) return
      this.patchLoad({ duration: this.player.duration })
      const shifter = await this.player.whenShifterSettled()
      if (!this.disposed) this.patchLoad({ shifter })
    } catch (err) {
      if (this.disposed) return
      this.patchLoad({
        loadError: err instanceof StemStoreError ? err.message : err instanceof Error ? err.message : 'No se pudo preparar el audio.',
        status: Object.fromEntries(Object.keys(this.load.status).map((id) => [id, { kind: 'error', message: 'Sin cargar' } as StemTrackStatus])),
      })
    }
  }

  private patchLoad(patch: Partial<StemLoadState>): void {
    this.load = { ...this.load, ...patch }
    for (const l of [...this.loadListeners]) l()
  }

  /** Foto de la carga (cambia de objeto en cada avance). */
  getLoad(): StemLoadState {
    return this.load
  }

  onLoad(listener: () => void): () => void {
    this.loadListeners.add(listener)
    return () => {
      this.loadListeners.delete(listener)
    }
  }

  /** Guarda lo que cambio en la interfaz (StemStudio lo llama en cada cambio, no por cuadro). */
  saveUi(patch: Partial<Omit<StemUiState, 'view'>>): void {
    this.ui = { ...this.ui, ...patch }
  }

  readView<T>(slot: string): T | undefined {
    return this.ui.view[slot] as T | undefined
  }

  writeView(slot: string, value: unknown): void {
    this.ui = { ...this.ui, view: { ...this.ui.view, [slot]: value } }
  }

  isDisposed(): boolean {
    return this.disposed
  }

  /** La vista que la muestra ahora (PISTAS o ENSAYO) y el titulo vigente de la cancion. */
  touch(view: AudioView, song: { title: string; artist?: string }): void {
    this.origin = view
    this.songTitle = song.title
    this.songArtist = song.artist?.trim() || undefined
  }

  // ---- PlayableHandle ----

  isPlaying(): boolean {
    return this.player.getState() === 'playing'
  }

  play(): void {
    void this.player.play()
  }

  pause(): void {
    this.player.pause()
  }

  stop(): void {
    this.player.stop()
  }

  progress(): number {
    const d = this.player.duration
    return d > 0 ? this.player.position() / d : 0
  }

  title(): string {
    return this.songTitle
  }

  subtitle(): string | undefined {
    const where = this.origin === 'rehearsal' ? 'Ensayo' : 'Stems'
    return this.songArtist ? `${this.songArtist} · ${where}` : where
  }

  view(): AudioView {
    return this.origin
  }

  busy(): boolean {
    return false
  }

  subscribe(listener: () => void): () => void {
    return this.player.onStateChange(() => listener())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.loadListeners.clear()
    this.player.dispose()
  }
}
