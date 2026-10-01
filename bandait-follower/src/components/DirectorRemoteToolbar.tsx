import { TransportStatus } from '../types/protocol'
import { CommandFeedback, CommandRun } from '../hooks/useCommandRunner'
import { PlayIcon, StopIcon, PauseIcon, PrevIcon, NextIcon, PanicIcon } from './Icons'

interface Props {
  status: TransportStatus | null
  currentBpm: number | null
  run: CommandRun
  onPanic: () => void
  /** Null when the leader can receive commands; otherwise the visible reason. */
  disabledReason: string | null
  feedback: CommandFeedback | null
}

/**
 * Remote transport for the musical director. StageView only mounts it for
 * role "director". Every press shows pending and then the leader's ack
 * (accepted, or rejected with its reason).
 */
export default function DirectorRemoteToolbar({
  status,
  currentBpm,
  run,
  onPanic,
  disabledReason,
  feedback,
}: Props) {
  const offline = disabledReason !== null
  const busy = feedback?.phase === 'pending'
  const blocked = offline || busy
  const playing = status === 'PLAYING' || status === 'COUNTING'
  const paused = status === 'PAUSED'

  const feedbackColor =
    feedback?.phase === 'accepted'
      ? 'var(--accent-success)'
      : feedback?.phase === 'pending'
        ? 'var(--text-secondary)'
        : 'var(--accent-danger)'

  return (
    <div
      style={{
        background: 'var(--theme-panel-bg)',
        border: `1px solid ${offline ? 'var(--accent-danger)' : 'var(--theme-border)'}`,
        borderRadius: 'var(--theme-radius)',
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--accent-active)',
            fontWeight: 800,
            letterSpacing: '1px',
          }}
        >
          [MANDO DIRECTOR // {currentBpm ?? '---'} BPM]
        </span>

        {/* TRANSPORT CONTROLS */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {!playing && !paused && (
            <button
              type="button"
              onClick={() => run('PLAY')}
              disabled={blocked}
              className="btn-stage btn-stage-primary"
              style={{ padding: '10px 20px', fontSize: '13px' }}
            >
              <PlayIcon size={16} />
              <span>PLAY</span>
            </button>
          )}
          {playing && (
            <button
              type="button"
              onClick={() => run('PAUSE')}
              disabled={blocked}
              className="btn-stage btn-stage-secondary"
              style={{ padding: '10px 16px', fontSize: '13px' }}
            >
              <PauseIcon size={16} />
              <span>PAUSA</span>
            </button>
          )}
          {paused && (
            <button
              type="button"
              onClick={() => run('RESUME')}
              disabled={blocked}
              className="btn-stage btn-stage-primary"
              style={{ padding: '10px 16px', fontSize: '13px' }}
            >
              <PlayIcon size={16} />
              <span>REANUDAR</span>
            </button>
          )}
          {(playing || paused) && (
            <button
              type="button"
              onClick={() => run('STOP')}
              disabled={blocked}
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
            onClick={() => run('CUE_PREV')}
            disabled={blocked}
            className="btn-stage btn-stage-secondary"
            style={{ padding: '10px 14px', fontSize: '12px' }}
            title="Canción anterior"
          >
            <PrevIcon size={14} />
            <span>ANT</span>
          </button>

          <button
            type="button"
            onClick={() => run('CUE_NEXT')}
            disabled={blocked}
            className="btn-stage btn-stage-secondary"
            style={{ padding: '10px 14px', fontSize: '12px' }}
            title="Canción siguiente"
          >
            <span>SIG</span>
            <NextIcon size={14} />
          </button>

          {/* TEMPO NUDGE */}
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              type="button"
              onClick={() => run('TEMPO_NUDGE', { deltaBpm: -1 })}
              disabled={blocked}
              className="btn-stage btn-stage-secondary"
              style={{ padding: '10px 12px', fontSize: '11px' }}
              title="Ajustar -1 BPM"
            >
              -1 BPM
            </button>
            <button
              type="button"
              onClick={() => run('TEMPO_NUDGE', { deltaBpm: 1 })}
              disabled={blocked}
              className="btn-stage btn-stage-secondary"
              style={{ padding: '10px 12px', fontSize: '11px' }}
              title="Ajustar +1 BPM"
            >
              +1 BPM
            </button>
          </div>

          {/* PANIC: never blocked by a pending command, only by being offline */}
          <button
            type="button"
            onClick={onPanic}
            disabled={offline}
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

      {(offline || feedback) && (
        <div
          role="status"
          aria-live="polite"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 700,
            letterSpacing: '0.5px',
            color: offline ? 'var(--accent-danger)' : feedbackColor,
          }}
        >
          {offline ? `MANDO DESHABILITADO: ${disabledReason}` : feedback?.text}
        </div>
      )}
    </div>
  )
}
