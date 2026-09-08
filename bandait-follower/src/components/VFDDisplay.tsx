import { FlywheelIcon, WifiIcon } from './Icons'

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
        background: 'var(--theme-card-bg)',
        border: '1px solid var(--theme-border)',
        borderRadius: 'var(--theme-radius)',
        padding: '12px 18px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '12px',
        boxShadow: isDownbeat ? '0 0 20px var(--theme-glow)' : 'inset 0 0 15px rgba(0, 0, 0, 0.4)',
        transition: 'box-shadow 0.08s ease',
        position: 'relative',
      }}
    >
      {/* BAR : BEAT DISPLAY */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: 'var(--text-disabled)',
            letterSpacing: '1.5px',
            fontWeight: 700,
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
              fontSize: '34px',
              fontWeight: 800,
              color: 'var(--text-primary)',
              letterSpacing: '-1px',
              lineHeight: 1,
            }}
          >
            {String(bar).padStart(3, '0')}
          </span>
          <span style={{ fontSize: '26px', color: 'var(--text-disabled)', fontWeight: 300 }}>:</span>
          <span
            style={{
              fontSize: '34px',
              fontWeight: 800,
              color: isDownbeat ? 'var(--accent-active)' : 'var(--text-primary)',
              textShadow: isDownbeat ? '0 0 16px var(--accent-active)' : 'none',
              transition: 'color 0.05s ease',
              lineHeight: 1,
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
            letterSpacing: '1.5px',
            fontWeight: 700,
          }}
        >
          TEMPO
        </span>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '34px',
            fontWeight: 800,
            color: 'var(--accent-active)',
            letterSpacing: '-1px',
            marginTop: '2px',
            lineHeight: 1,
          }}
        >
          {bpm}{' '}
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>
            BPM
          </span>
        </div>
      </div>

      {/* STATUS & SYNC MODE BADGES */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 800,
            padding: '4px 10px',
            borderRadius: 'var(--theme-radius)',
            border:
              status === 'PLAYING'
                ? '1px solid var(--accent-active)'
                : '1px solid var(--text-disabled)',
            color:
              status === 'PLAYING' ? 'var(--accent-active)' : 'var(--text-disabled)',
            background: status === 'PLAYING' ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
            letterSpacing: '1px',
          }}
        >
          [{status}]
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            fontWeight: 700,
            color: isFlywheel ? 'var(--accent-warning)' : 'var(--accent-success)',
          }}
        >
          {isFlywheel ? (
            <>
              <FlywheelIcon size={12} />
              <span>[FLYWHEEL INERCIA]</span>
            </>
          ) : (
            <>
              <WifiIcon size={12} />
              <span>[NTP CLOCK SINCRONIZADO]</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
