import React from 'react'
import { AudioLines, Pause, Play } from 'lucide-react'

export interface MiniPlayerNowPlaying {
  title: string
  subtitle?: string
  playing: boolean
  /** Avance de 0 a 1. */
  progress: number
}

interface Props {
  nowPlaying: MiniPlayerNowPlaying | null
  onToggle: () => void
  onOpenStudio?: () => void
}

/**
 * Mini reproductor flotante del shell (Web 3.0, seccion 2). Solo presentacion: el motor de audio
 * global lo alimenta con `nowPlaying`. En escritorio flota al pie del contenido, a la derecha del
 * rail; en movil, encima de la barra de pildoras (posicion en global.css, `.hub-mini`). Sin nada
 * sonando no ocupa lugar.
 */
export const MiniPlayer: React.FC<Props> = ({ nowPlaying, onToggle, onOpenStudio }) => {
  if (!nowPlaying) return null
  const progress = Number.isFinite(nowPlaying.progress) ? Math.min(1, Math.max(0, nowPlaying.progress)) : 0
  const percent = Math.round(progress * 100)
  return (
    <div role="region" aria-label="Reproductor" className="hub-mini" data-testid="mini-player">
      <button
        type="button"
        className="b-transport hub-mini-play hub-press"
        data-testid="mini-player-toggle"
        onClick={onToggle}
        aria-label={nowPlaying.playing ? `Pausar ${nowPlaying.title}` : `Reproducir ${nowPlaying.title}`}
      >
        {nowPlaying.playing ? <Pause size={18} fill="currentColor" aria-hidden /> : <Play size={18} fill="currentColor" aria-hidden />}
      </button>
      <span className="hub-mini-meta">
        <span className="hub-mini-title">{nowPlaying.title}</span>
        {nowPlaying.subtitle && <span className="hub-mini-subtitle">{nowPlaying.subtitle}</span>}
      </span>
      <span
        className="hub-mini-track"
        role="progressbar"
        aria-label="Avance"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className="hub-mini-fill" style={{ transform: `scaleX(${progress})` }} />
      </span>
      {onOpenStudio && (
        <button type="button" className="hub-mini-studio hub-press" data-testid="mini-player-studio" onClick={onOpenStudio}>
          <AudioLines size={14} aria-hidden />
          Estudio
        </button>
      )}
    </div>
  )
}
