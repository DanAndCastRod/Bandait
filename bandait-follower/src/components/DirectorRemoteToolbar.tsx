import { CommandType } from '../types/protocol'

interface Props {
  isPlaying: boolean
  currentBpm: number
  onCommand: (type: CommandType, payload?: Record<string, unknown>) => void
  disabled?: boolean
}

export default function DirectorRemoteToolbar({
  isPlaying,
  currentBpm,
  onCommand,
  disabled = false,
}: Props) {
  return (
    <div
      style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--theme-border)',
        borderRadius: '6px',
        padding: '12px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--accent-active)',
            fontWeight: 700,
            letterSpacing: '1px',
          }}
        >
          [MANDO DIRECTOR // {currentBpm} BPM]
        </span>
      </div>

      {/* TRANSPORT BUTTONS */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {!isPlaying ? (
          <button
            onClick={() => onCommand('PLAY')}
            disabled={disabled}
            style={{
              background: 'var(--accent-active)',
              color: '#000000',
              border: 'none',
              borderRadius: '4px',
              padding: '10px 24px',
              fontFamily: 'var(--font-mono)',
              fontSize: '13px',
              fontWeight: 800,
              cursor: disabled ? 'not-allowed' : 'pointer',
              letterSpacing: '1px',
            }}
          >
            [PLAY // INICIAR]
          </button>
        ) : (
          <button
            onClick={() => onCommand('STOP')}
            disabled={disabled}
            style={{
              background: 'transparent',
              border: '2px solid var(--accent-warning)',
              color: 'var(--accent-warning)',
              borderRadius: '4px',
              padding: '10px 24px',
              fontFamily: 'var(--font-mono)',
              fontSize: '13px',
              fontWeight: 800,
              cursor: disabled ? 'not-allowed' : 'pointer',
              letterSpacing: '1px',
            }}
          >
            [STOP // DETENER]
          </button>
        )}

        <button
          onClick={() => onCommand('CUE_PREV')}
          disabled={disabled}
          style={{
            background: 'transparent',
            border: '1px solid var(--theme-border)',
            color: 'var(--text-primary)',
            borderRadius: '4px',
            padding: '10px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          [&lt; ANTERIOR]
        </button>

        <button
          onClick={() => onCommand('CUE_NEXT')}
          disabled={disabled}
          style={{
            background: 'transparent',
            border: '1px solid var(--theme-border)',
            color: 'var(--text-primary)',
            borderRadius: '4px',
            padding: '10px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        >
          [SIGUIENTE &gt;]
        </button>

        {/* TEMPO NUDGE */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            onClick={() => onCommand('TEMPO_NUDGE', { delta_bpm: -1 })}
            disabled={disabled}
            title="Bajar 1 BPM"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--theme-border)',
              color: 'var(--text-primary)',
              borderRadius: '4px',
              padding: '10px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            -1 BPM
          </button>
          <button
            onClick={() => onCommand('TEMPO_NUDGE', { delta_bpm: 1 })}
            disabled={disabled}
            title="Subir 1 BPM"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--theme-border)',
              color: 'var(--text-primary)',
              borderRadius: '4px',
              padding: '10px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12px',
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >
            +1 BPM
          </button>
        </div>

        {/* PANIC BUTTON */}
        <button
          onClick={() => onCommand('PANIC')}
          disabled={disabled}
          style={{
            background: 'transparent',
            border: '2px solid var(--accent-danger, #FF3333)',
            color: 'var(--accent-danger, #FF3333)',
            borderRadius: '4px',
            padding: '10px 16px',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            fontWeight: 800,
            cursor: disabled ? 'not-allowed' : 'pointer',
            letterSpacing: '1px',
          }}
        >
          [PANIC]
        </button>
      </div>
    </div>
  )
}
