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
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--theme-border)',
        borderBottom: '1px solid var(--theme-border)',
        padding: '8px 12px',
        overflowX: 'auto',
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        scrollbarWidth: 'thin',
        userSelect: 'none',
      }}
      ref={containerRef}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          color: 'var(--text-disabled)',
          writingMode: 'vertical-rl',
          transform: 'rotate(180deg)',
          letterSpacing: '1px',
          padding: '2px',
        }}
      >
        RIBBON
      </span>

      {songs.map((song, idx) => {
        const isCurrent = song.id === currentSongId
        const trackNum = String(idx + 1).padStart(2, '0')

        return (
          <button
            key={song.id}
            onClick={() => !disabled && onSelectSong(song, idx)}
            disabled={disabled}
            style={{
              background: isCurrent ? 'var(--accent-active)' : 'var(--bg-surface)',
              color: isCurrent ? '#000000' : 'var(--text-primary)',
              border: isCurrent
                ? '2px solid var(--accent-active)'
                : '1px solid var(--theme-border)',
              borderRadius: '4px',
              padding: '6px 12px',
              cursor: disabled ? 'not-allowed' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              minWidth: '130px',
              flexShrink: 0,
              textAlign: 'left',
              transition: 'all 0.15s ease',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '10px',
                fontWeight: 700,
                opacity: isCurrent ? 0.9 : 0.6,
                letterSpacing: '0.5px',
              }}
            >
              #{trackNum} {isCurrent ? '[EN VIVO]' : ''}
            </div>

            <div
              style={{
                fontFamily: 'var(--font-sans)',
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
                opacity: isCurrent ? 0.85 : 0.5,
                marginTop: '3px',
              }}
            >
              {song.bpm} BPM {song.key ? `• ${song.key}` : ''}
            </div>
          </button>
        )
      })}
    </div>
  )
}
