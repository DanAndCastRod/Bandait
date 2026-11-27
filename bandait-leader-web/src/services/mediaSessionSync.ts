import type { NowPlaying } from './globalAudioCore'

/**
 * Sincroniza el estado del transporte global (`GlobalAudioProvider`) con `navigator.mediaSession`
 * para que el musico pueda pausar, reanudar o detener Stems, Ensayo o Estudio DAW desde la
 * pantalla de bloqueo del movil, auriculares Bluetooth o teclas multimedia del sistema operativo.
 */
export function syncMediaSession(
  nowPlaying: NowPlaying | null,
  actions: { toggle: () => void; stop: () => void },
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !navigator.mediaSession) {
    return
  }
  const ms = navigator.mediaSession

  if (!nowPlaying) {
    ms.playbackState = 'none'
    return
  }

  try {
    if (typeof MediaMetadata !== 'undefined') {
      ms.metadata = new MediaMetadata({
        title: nowPlaying.title || 'Bandait Audio',
        artist: nowPlaying.subtitle || 'Bandait Web 3.0',
        album: 'Bandait Studio & Ensayo',
      })
    }
    ms.playbackState = nowPlaying.playing ? 'playing' : 'paused'
    ms.setActionHandler('play', () => {
      if (!nowPlaying.playing) actions.toggle()
    })
    ms.setActionHandler('pause', () => {
      if (nowPlaying.playing) actions.toggle()
    })
    ms.setActionHandler('stop', () => {
      actions.stop()
    })
  } catch {
    // Algunos navegadores moviles limitan ciertas acciones de MediaSession: ignorar sin fallar.
  }
}
