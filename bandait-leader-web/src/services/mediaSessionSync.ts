import type { NowPlaying } from './globalAudioCore'

/**
 * Sincroniza el estado del transporte global (`GlobalAudioProvider`) con `navigator.mediaSession`
 * para que el musico pueda pausar, reanudar o detener Stems, Ensayo o Estudio DAW desde la
 * pantalla de bloqueo del movil, auriculares Bluetooth o teclas multimedia del sistema operativo.
 *
 * `nowPlaying` cambia a 4 Hz mientras algo suena (el progreso). Por eso:
 *   - `MediaMetadata` solo se crea cuando cambian titulo o subtitulo (`mediaMetadataKey`);
 *   - los manejadores se instalan una vez y leen el estado vigente de este modulo, en vez de
 *     registrarse de nuevo con cada foto;
 *   - `playbackState` solo se escribe cuando cambia.
 * La posicion (`setPositionState`) no se publica: `NowPlaying` no trae la duracion en segundos.
 */

type Actions = { toggle: () => void; stop: () => void }

let latest: { nowPlaying: NowPlaying | null; actions: Actions | null } = { nowPlaying: null, actions: null }
let handlersInstalled = false
let lastMetaKey: string | null = null
let lastPlayback: MediaSessionPlaybackState | null = null

/** Clave de los metadatos: cambia solo si cambia lo que muestra la pantalla de bloqueo. */
export function mediaMetadataKey(nowPlaying: NowPlaying | null): string | null {
  if (!nowPlaying) return null
  return `${nowPlaying.title || ''}\u0000${nowPlaying.subtitle || ''}`
}

function installHandlers(ms: MediaSession): void {
  if (handlersInstalled) return
  handlersInstalled = true
  const safe = (action: MediaSessionAction, handler: () => void) => {
    try {
      ms.setActionHandler(action, handler)
    } catch {
      // Accion no soportada por este navegador.
    }
  }
  safe('play', () => {
    if (latest.nowPlaying && !latest.nowPlaying.playing) latest.actions?.toggle()
  })
  safe('pause', () => {
    if (latest.nowPlaying?.playing) latest.actions?.toggle()
  })
  safe('stop', () => {
    if (latest.nowPlaying) latest.actions?.stop()
  })
}

export function syncMediaSession(nowPlaying: NowPlaying | null, actions: Actions): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !navigator.mediaSession) {
    return
  }
  const ms = navigator.mediaSession
  latest = { nowPlaying, actions }

  try {
    const key = mediaMetadataKey(nowPlaying)
    if (key !== lastMetaKey) {
      lastMetaKey = key
      if (!nowPlaying) ms.metadata = null
      else if (typeof MediaMetadata !== 'undefined') {
        ms.metadata = new MediaMetadata({
          title: nowPlaying.title || 'Bandait Audio',
          artist: nowPlaying.subtitle || 'Bandait Web 3.0',
          album: 'Bandait Studio & Ensayo',
        })
      }
    }
    const playback: MediaSessionPlaybackState = !nowPlaying ? 'none' : nowPlaying.playing ? 'playing' : 'paused'
    if (playback !== lastPlayback) {
      lastPlayback = playback
      ms.playbackState = playback
    }
    if (nowPlaying) installHandlers(ms)
  } catch {
    // Algunos navegadores moviles limitan ciertas acciones de MediaSession: ignorar sin fallar.
  }
}
