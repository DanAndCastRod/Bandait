interface Props {
  bpm: number
  bar: number
  beat: number
  status: 'IDLE' | 'COUNTING' | 'PLAYING' | 'PAUSED'
  isFlywheel?: boolean
}

export default function VFDDisplay({
  bpm,
  bar,
  beat,
  status,
  isFlywheel = false,
}: Props) {
  const isDownbeat = beat === 1 && status === 'PLAYING'

  return (
    <div
      style={{
        background: '#040B09',
        border: '2px solid var(--theme-border)',
        borderRadius: '6px',
        padding: '12px 18px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px',
        boxShadow: 'inset 0 0 15px rgba(0, 255, 180, 0.05)',
      }}
    >
      {/* BAR : BEAT DISPLAY */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: 'var(--text-disabled)',
            letterSpacing: '1px',
          }}
        >
          COMPÁS // PULSO
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '6px',
            fontFamily: 'var(--font-mono)',
            marginTop: '2px',
          }}
        >
          <span
            style={{
              fontSize: '32px',
              fontWeight: 800,
              color: 'var(--text-primary)',
              letterSpacing: '-1px',
            }}
          >
            {String(bar).padStart(3, '0')}
          </span>
          <span style={{ fontSize: '24px', color: 'var(--text-disabled)' }}>:</span>
          <span
            style={{
              fontSize: '32px',
              fontWeight: 800,
              color: isDownbeat ? 'var(--accent-active)' : 'var(--text-primary)',
              textShadow: isDownbeat ? '0 0 12px var(--accent-active)' : 'none',
              transition: 'color 0.05s ease',
            }}
          >
            {String(beat).padStart(2, '0')}
          </span>
        </div>
      </div>

      {/* BPM DISPLAY */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: 'var(--text-disabled)',
            letterSpacing: '1px',
          }}
        >
          TEMPO
        </span>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '32px',
            fontWeight: 800,
            color: 'var(--accent-active)',
            letterSpacing: '-1px',
            marginTop: '2px',
          }}
        >
          {bpm}{' '}
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 400 }}>
            BPM
          </span>
        </div>
      </div>

      {/* STATUS & SYNC MODE BADGES */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: '3px',
            border:
              status === 'PLAYING'
                ? '1px solid var(--accent-active)'
                : '1px solid var(--text-disabled)',
            color:
              status === 'PLAYING' ? 'var(--accent-active)' : 'var(--text-disabled)',
            background: 'rgba(0, 0, 0, 0.4)',
          }}
        >
          [{status}]
        </div>

        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: isFlywheel ? 'var(--accent-warning)' : 'var(--text-secondary)',
          }}
        >
          {isFlywheel ? '[MODO: FLYWHEEL]' : '[MODO: NTP SYNC]'}
        </div>
      </div>
    </div>
  )
}
