import React from 'react'
import { Disc3, Library, ListMusic, Mic, SlidersVertical, X } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import { useMediaQuery } from '../hooks/useMediaQuery'
import type { HubView, SongsSegment } from './shell/hubViews'
import { colors, ghostButton, mono, radius } from './hubStyles'

interface Props {
  currentView: HubView
  currentSegment: SongsSegment
  studioEnabled: boolean
  onNavigate: (view: HubView, segment?: SongsSegment) => void
}

/**
 * Barra contextual transversal del Universo de la Canción:
 * Mantiene el tema elegido en foco y permite saltar en 1 clic entre Librería, Stems, Ensayo,
 * Estudio DAW y Setlists sin volver a buscar la canción.
 */
export const SongUniverseBar: React.FC<Props> = ({ currentView, currentSegment, studioEnabled, onNavigate }) => {
  const { activeSong, setActiveSongId } = useHub()
  // Con dedo (movil o pantalla tactil) cada pildora llega a 44 px; con raton queda compacta.
  const touch = useMediaQuery('(max-width: 767px), (pointer: coarse)', false)
  if (!activeSong) return null
  const target = touch ? '44px' : '28px'

  const pill = (active: boolean): React.CSSProperties => ({
    ...ghostButton,
    padding: '4px 9px',
    fontSize: '11px',
    minHeight: target,
    borderRadius: radius.control,
    background: active ? 'var(--b-accent)' : 'var(--b-elevated)',
    color: active ? 'var(--b-on-accent)' : colors.text,
    border: active ? '1px solid var(--b-accent)' : '1px solid var(--b-border)',
    fontWeight: active ? 700 : 600,
  })

  return (
    <div
      role="region"
      aria-label="Canción activa en el universo Bandait"
      data-testid="song-universe-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
        padding: '6px 14px',
        background: 'var(--b-surface)',
        borderBottom: '1px solid var(--b-border-soft)',
        fontSize: '12px',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '6px',
          fontFamily: mono,
          fontSize: '11px',
          color: colors.muted,
          minWidth: 0,
        }}
      >
        <Disc3 size={14} style={{ color: 'var(--b-accent)', flexShrink: 0 }} />
        <strong style={{ color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}>
          {activeSong.title}
        </strong>
        <span>{activeSong.bpm} BPM</span>
        {activeSong.key && <span style={{ color: colors.cobalt, fontWeight: 700 }}>{activeSong.key}</span>}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '5px', marginLeft: 'auto' }}>
        <button
          type="button"
          onClick={() => onNavigate('songs', 'library')}
          style={pill(currentView === 'songs' && currentSegment === 'library')}
          data-testid="universe-jump-library"
        >
          <Library size={12} /> LIBRERÍA
        </button>
        <button
          type="button"
          onClick={() => onNavigate('songs', 'stems')}
          style={pill(currentView === 'songs' && currentSegment === 'stems')}
          data-testid="universe-jump-stems"
        >
          <Disc3 size={12} /> STEMS
        </button>
        <button
          type="button"
          onClick={() => onNavigate('rehearsal')}
          style={pill(currentView === 'rehearsal')}
          data-testid="universe-jump-rehearsal"
        >
          <Mic size={12} /> ENSAYO
        </button>
        {studioEnabled && (
          <button
            type="button"
            onClick={() => onNavigate('studio')}
            style={pill(currentView === 'studio')}
            data-testid="universe-jump-studio"
          >
            <SlidersVertical size={12} /> ESTUDIO
          </button>
        )}
        <button
          type="button"
          onClick={() => onNavigate('setlists')}
          style={pill(currentView === 'setlists')}
          data-testid="universe-jump-setlists"
        >
          <ListMusic size={12} /> SETLISTS
        </button>
        <button
          type="button"
          onClick={() => setActiveSongId(null)}
          aria-label="Desfijar canción activa"
          title="Ocultar barra de canción activa"
          style={{
            ...ghostButton,
            padding: '4px 6px',
            minHeight: target,
            minWidth: target,
            justifyContent: 'center',
            borderRadius: radius.control,
            background: 'transparent',
            color: colors.muted,
          }}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
