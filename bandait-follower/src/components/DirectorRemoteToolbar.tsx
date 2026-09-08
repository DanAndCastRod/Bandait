import { CommandType } from '../types/protocol'
import { PlayIcon, StopIcon, PrevIcon, NextIcon, PanicIcon } from './Icons'

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
        background: 'var(--theme-panel-bg)',
        border: '1px solid var(--theme-border)',
        borderRadius: 'var(--theme-radius)',
        padding: '10px 14px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px',
        alignItems: 'center',
        justifyContent: 'space-between',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--accent-active)',
            fontWeight: 800,
            letterSpacing: '1px',
          }}
        >
          [MANDO DIRECTOR // {currentBpm} BPM]
        </span>
      </div>

      {/* TRANSPORT CONTROLS */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {!isPlaying ? (
          <button
            type="button"
            onClick={() => onCommand('PLAY')}
            disabled={disabled}
            className="btn-stage btn-stage-primary"
            style={{ padding: '10px 20px', fontSize: '13px' }}
          >
            <PlayIcon size={16} />
            <span>PLAY</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onCommand('STOP')}
            disabled={disabled}
            className="btn-stage"
            style={{
              padding: '10px 20px',
              fontSize: '13px',
              background: 'rgba(239, 68, 68, 0.15)',
              color: 'var(--accent-danger)',
              border: '1px solid var(--accent-danger)',
            }}
          >
            <StopIcon size={16} />
            <span>STOP</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onCommand('CUE_PREV')}
          disabled={disabled}
          className="btn-stage btn-stage-secondary"
          style={{ padding: '10px 14px', fontSize: '12px' }}
          title="Canción Anterior"
        >
          <PrevIcon size={14} />
          <span>ANT</span>
        </button>

        <button
          type="button"
          onClick={() => onCommand('CUE_NEXT')}
          disabled={disabled}
          className="btn-stage btn-stage-secondary"
          style={{ padding: '10px 14px', fontSize: '12px' }}
          title="Canción Siguiente"
        >
          <span>SIG</span>
          <NextIcon size={14} />
        </button>

        {/* TEMPO NUDGE */}
        <div style={{ display: 'flex', gap: '4px' }}>
          <button
            type="button"
            onClick={() => onCommand('TEMPO_NUDGE', { delta_bpm: -1 })}
            disabled={disabled}
            className="btn-stage btn-stage-secondary"
            style={{ padding: '10px 12px', fontSize: '11px' }}
            title="Ajustar -1 BPM"
          >
            -1 BPM
          </button>
          <button
            type="button"
            onClick={() => onCommand('TEMPO_NUDGE', { delta_bpm: 1 })}
            disabled={disabled}
            className="btn-stage btn-stage-secondary"
            style={{ padding: '10px 12px', fontSize: '11px' }}
            title="Ajustar +1 BPM"
          >
            +1 BPM
          </button>
        </div>

        {/* PANIC BUTTON */}
        <button
          type="button"
          onClick={() => onCommand('PANIC')}
          disabled={disabled}
          className="btn-stage"
          style={{
            padding: '10px 16px',
            fontSize: '12px',
            background: 'transparent',
            border: '2px solid var(--accent-danger)',
            color: 'var(--accent-danger)',
            boxShadow: '0 0 10px rgba(239, 68, 68, 0.2)',
          }}
        >
          <PanicIcon size={16} />
          <span>PANIC</span>
        </button>
      </div>
    </div>
  )
}
