import { useRef } from 'react'

export interface RibbonSong {
  id: string
  title: string
  bpm: number
  key?: string
}

interface Props {
  songs: RibbonSong[]
  currentSongId: string | null
  onSelectSong: (song: RibbonSong, index: number) => void
  disabled?: boolean
}

export default function SongRibbon({
  songs,
  currentSongId,
  onSelectSong,
  disabled = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  if (!songs || songs.length === 0) return null

  return (
    <div
      style={{
        width: '100%',
        background: 'var(--bg-surface)',
        borderTop: '1px solid var(--theme-border)',
        borderBottom: '1px solid var(--theme-border)',
        borderRadius: 'var(--theme-radius)',
        padding: '8px 10px',
        overflowX: 'auto',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        scrollbarWidth: 'thin',
        userSelect: 'none',
      }}
      ref={containerRef}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '9px',
          fontWeight: 800,
          color: 'var(--text-disabled)',
          letterSpacing: '1.5px',
          padding: '4px 6px',
          borderRight: '1px solid var(--theme-border)',
          whiteSpace: 'nowrap',
        }}
      >
        SETLIST //
      </div>

      {songs.map((song, idx) => {
        const isCurrent = song.id === currentSongId
        const trackNum = String(idx + 1).padStart(2, '0')

        return (
          <button
            key={song.id}
            onClick={() => !disabled && onSelectSong(song, idx)}
            disabled={disabled}
            style={{
              background: isCurrent ? 'var(--accent-active)' : 'var(--theme-card-bg)',
              color: isCurrent ? 'var(--bg-primary)' : 'var(--text-primary)',
              border: isCurrent
                ? '1px solid var(--accent-active)'
                : '1px solid var(--theme-border)',
              borderRadius: 'var(--theme-radius)',
              padding: '6px 14px',
              cursor: disabled ? 'not-allowed' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              minWidth: '140px',
              flexShrink: 0,
              textAlign: 'left',
              transition: 'all 0.15s ease',
              boxShadow: isCurrent ? '0 0 14px var(--theme-glow)' : 'none',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                fontWeight: 800,
                opacity: isCurrent ? 0.9 : 0.6,
                letterSpacing: '0.5px',
              }}
            >
              #{trackNum} {isCurrent ? '[EN VIVO]' : ''}
            </div>

            <div
              style={{
                fontFamily: 'var(--font-ui)',
                fontSize: '13px',
                fontWeight: isCurrent ? 800 : 600,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                width: '100%',
                marginTop: '2px',
              }}
            >
              {song.title}
            </div>

            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                opacity: isCurrent ? 0.85 : 0.6,
                marginTop: '3px',
                display: 'flex',
                gap: '6px',
              }}
            >
              <span>{song.bpm} BPM</span>
              {song.key && <span>• {song.key}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}
