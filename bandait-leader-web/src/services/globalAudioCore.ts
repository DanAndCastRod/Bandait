/**
 * Nucleo del audio global del Hub (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 3), sin React ni Web
 * Audio: se prueba con node (scripts/verify-global-audio.ts).
 *
 * Es dueno de dos fuentes de audio que sobreviven al cambio de vista:
 * - 'stems': el reproductor de la cancion cargada en PISTAS o ENSAYO (una sola a la vez; la clave
 *   es cancion + ids de pistas, asi que volver a la misma cancion reusa el reproductor y cargar
 *   otra libera el anterior).
 * - 'studio': el controlador de la sesion abierta del Estudio (una sola a la vez).
 *
 * Reglas:
 * - Cambiar de vista no libera nada. Se libera al cargar otra cancion (acquireStem con otra
 *   clave), al cerrar la sesion del Estudio (closeStudio), al cambiar de banda o de usuario
 *   (releaseOutside con el ambito nuevo) y al desmontar el proveedor (releaseAll).
 * - Exclusion mutua: si una fuente pasa a sonar, la otra se pausa. Si la otra esta grabando
 *   (busy), no se interrumpe la toma: se pausa la que intento arrancar.
 * - `nowPlaying` es una foto que solo cambia de objeto cuando cambia algo visible; el progreso se
 *   refresca con un temporizador lento (4 Hz) mientras algo suena, nunca por cuadro.
 */

export type AudioSource = 'stems' | 'studio'

/** Vista de origen, para que el mini reproductor pueda volver a ella. */
export type AudioView = 'tracks' | 'rehearsal' | 'studio'

export interface NowPlaying {
  title: string
  subtitle?: string
  playing: boolean
  /** 0..1 */
  progress: number
  source: AudioSource
  view: AudioView
}

/** Lo que el nucleo necesita de cada fuente (StemSession y el adaptador del StudioController). */
export interface PlayableHandle {
  isPlaying(): boolean
  play(): void
  pause(): void
  stop(): void
  /** Posicion / duracion, 0..1. */
  progress(): number
  title(): string
  subtitle(): string | undefined
  view(): AudioView
  /** true si pausarla romperia algo (una toma en curso del Estudio). */
  busy(): boolean
  /** Avisa cambios de estado (play, pausa, titulo). No se llama por cuadro. */
  subscribe(listener: () => void): () => void
  dispose(): void | Promise<void>
}

interface Slot<H extends PlayableHandle> {
  key: string
  scope: string
  handle: H
  off: () => void
}

export interface TimerApi {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
}

/** Cada cuanto se refresca el progreso mientras algo suena. */
export const NOW_PLAYING_TICK_MS = 250

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function sameNowPlaying(a: NowPlaying | null, b: NowPlaying | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.playing === b.playing &&
    a.source === b.source &&
    a.view === b.view &&
    Math.abs(a.progress - b.progress) < 0.0005
  )
}

export class GlobalAudioCore<S extends PlayableHandle = PlayableHandle, T extends PlayableHandle = PlayableHandle> {
  private stem: Slot<S> | null = null
  private studio: Slot<T> | null = null
  /** Ultima fuente que sono o se cargo: la que muestra el mini reproductor si nada suena. */
  private focus: AudioSource | null = null
  private wasPlaying: Record<AudioSource, boolean> = { stems: false, studio: false }
  private readonly listeners = new Set<() => void>()
  private now: NowPlaying | null = null
  private ticker: unknown = null
  private readonly timers: TimerApi

  constructor(timers?: TimerApi) {
    this.timers = timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    }
  }

  // ---- stems ----

  stemHandle(): S | null {
    return this.stem?.handle ?? null
  }

  stemKey(): string | null {
    return this.stem?.key ?? null
  }

  /**
   * Devuelve el reproductor de `key` si ya existe en el mismo ambito; si no, libera el anterior y
   * crea uno nuevo con `create`.
   */
  acquireStem(key: string, scope: string, create: () => S): { handle: S; reused: boolean } {
    const current = this.stem
    if (current && current.key === key && current.scope === scope) return { handle: current.handle, reused: true }
    this.releaseStem()
    const handle = create()
    this.stem = { key, scope, handle, off: handle.subscribe(() => this.changed('stems')) }
    this.wasPlaying.stems = handle.isPlaying()
    this.focus = 'stems'
    this.changed('stems')
    return { handle, reused: false }
  }

  /** Libera el reproductor de stems (todo, o solo si su clave es `key`). */
  releaseStem(key?: string): void {
    const current = this.stem
    if (!current || (key !== undefined && current.key !== key)) return
    this.stem = null
    this.wasPlaying.stems = false
    current.off()
    if (this.focus === 'stems') this.focus = this.studio ? 'studio' : null
    try {
      void current.handle.dispose()
    } catch {
      // Ya estaba liberado: no hay nada mas que cerrar.
    }
    this.refresh()
  }

  // ---- estudio ----

  studioHandle(): T | null {
    return this.studio?.handle ?? null
  }

  studioKey(): string | null {
    return this.studio?.key ?? null
  }

  studioScope(): string | null {
    return this.studio?.scope ?? null
  }

  /** Abre (adopta) una sesion del Estudio; cierra la anterior si era otra. */
  openStudio(key: string, scope: string, handle: T): void {
    const current = this.studio
    if (current && current.handle === handle) return
    if (current) void this.closeStudio()
    this.studio = { key, scope, handle, off: handle.subscribe(() => this.changed('studio')) }
    this.wasPlaying.studio = handle.isPlaying()
    this.focus = 'studio'
    this.changed('studio')
  }

  /** Cierra la sesion del Estudio (toda, o solo si su clave es `key`). Resuelve al terminar de guardar. */
  closeStudio(key?: string): Promise<void> {
    const current = this.studio
    if (!current || (key !== undefined && current.key !== key)) return Promise.resolve()
    this.studio = null
    this.wasPlaying.studio = false
    current.off()
    if (this.focus === 'studio') this.focus = this.stem ? 'stems' : null
    this.refresh()
    try {
      return Promise.resolve(current.handle.dispose()).catch(() => undefined)
    } catch {
      return Promise.resolve()
    }
  }

  // ---- ambito (banda + usuario) ----

  /** Libera todo lo que no pertenece a `scope` (cambio de banda o de usuario). */
  releaseOutside(scope: string): void {
    if (this.stem && this.stem.scope !== scope) this.releaseStem()
    if (this.studio && this.studio.scope !== scope) void this.closeStudio()
  }

  releaseAll(): void {
    this.releaseStem()
    void this.closeStudio()
    this.stopTicker()
  }

  // ---- transporte del mini reproductor ----

  private current(): { source: AudioSource; handle: PlayableHandle } | null {
    const stem = this.stem?.handle ?? null
    const studio = this.studio?.handle ?? null
    if (stem && stem.isPlaying()) return { source: 'stems', handle: stem }
    if (studio && studio.isPlaying()) return { source: 'studio', handle: studio }
    if (this.focus === 'stems' && stem) return { source: 'stems', handle: stem }
    if (this.focus === 'studio' && studio) return { source: 'studio', handle: studio }
    if (stem) return { source: 'stems', handle: stem }
    if (studio) return { source: 'studio', handle: studio }
    return null
  }

  /** Reproduce o pausa la fuente que muestra el mini reproductor. */
  toggle(): void {
    const cur = this.current()
    if (!cur) return
    if (cur.handle.isPlaying()) cur.handle.pause()
    else cur.handle.play()
  }

  /** Detiene la fuente que muestra el mini reproductor (no la libera). */
  stop(): void {
    this.current()?.handle.stop()
  }

  /** Progreso exacto, para quien lo pinte con rAF. */
  progress(): number {
    const cur = this.current()
    return cur ? clamp01(cur.handle.progress()) : 0
  }

  // ---- foto y avisos ----

  nowPlaying(): NowPlaying | null {
    return this.now
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private build(): NowPlaying | null {
    const cur = this.current()
    if (!cur) return null
    const subtitle = cur.handle.subtitle()
    const out: NowPlaying = {
      title: cur.handle.title(),
      playing: cur.handle.isPlaying(),
      progress: clamp01(cur.handle.progress()),
      source: cur.source,
      view: cur.handle.view(),
    }
    if (subtitle) out.subtitle = subtitle
    return out
  }

  /** Recalcula la foto; avisa solo si cambio. Devuelve si cambio. */
  refresh(): boolean {
    const next = this.build()
    const playing = !!next?.playing
    if (playing) this.startTicker()
    else this.stopTicker()
    if (sameNowPlaying(this.now, next)) return false
    this.now = next
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch {
        // Un oyente roto no debe dejar a los demas con la foto vieja.
      }
    }
    return true
  }

  /** Una fuente aviso un cambio: exclusion mutua y foto nueva. */
  private changed(source: AudioSource): void {
    const self = source === 'stems' ? this.stem?.handle : this.studio?.handle
    const other = source === 'stems' ? this.studio?.handle : this.stem?.handle
    const otherSource: AudioSource = source === 'stems' ? 'studio' : 'stems'
    const playing = !!self && self.isPlaying()
    const started = playing && !this.wasPlaying[source]
    this.wasPlaying[source] = playing
    if (started && self) {
      if (other && other.isPlaying()) {
        if (other.busy()) {
          // La otra esta grabando: la toma manda y esta no arranca.
          self.pause()
          this.wasPlaying[source] = self.isPlaying()
        } else {
          other.pause()
          this.wasPlaying[otherSource] = other.isPlaying()
          this.focus = source
        }
      } else {
        this.focus = source
      }
    }
    this.refresh()
  }

  private startTicker(): void {
    if (this.ticker !== null) return
    this.ticker = this.timers.setInterval(() => this.refresh(), NOW_PLAYING_TICK_MS)
  }

  private stopTicker(): void {
    if (this.ticker === null) return
    this.timers.clearInterval(this.ticker)
    this.ticker = null
  }
}

/** Clave del reproductor de una cancion: cambia si cambian sus pistas. */
export function stemSessionKey(songId: string, trackIds: readonly string[]): string {
  return `${songId}:${trackIds.join(',')}`
}

/** Ambito del audio: usuario + banda activa. Cambiarlo libera lo que pertenece al anterior. */
export function audioScope(userId: string | null | undefined, bandId: string | null | undefined): string {
  return `${userId ?? 'anon'}|${bandId ?? 'none'}`
}
