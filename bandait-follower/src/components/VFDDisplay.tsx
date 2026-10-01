import { Ref } from 'react'
import { FlywheelIcon, WifiIcon } from './Icons'
import { TransportStatus } from '../types/protocol'
import { LINK_STATE_LABEL, LinkState } from '../services/linkState'

interface Props {
  bpm: number | null
  status: TransportStatus | null
  linkState: LinkState
  /** bar and beat text are written by useBeatVisuals (rAF), not by React. */
  barRef: Ref<HTMLSpanElement>
  beatRef: Ref<HTMLSpanElement>
}

const STATUS_LABEL: Record<TransportStatus, string> = {
  IDLE: 'DETENIDO',
  COUNTING: 'CONTEO',
  PLAYING: 'EN VIVO',
  PAUSED: 'PAUSA',
}

export default function VFDDisplay({ bpm, status, linkState, barRef, beatRef }: Props) {
  const playing = status === 'PLAYING' || status === 'COUNTING'
  const flywheel = linkState === 'FLYWHEEL'
  const linkColor =
    linkState === 'LOCKED'
      ? 'var(--accent-success)'
      : linkState === 'LOST'
        ? 'var(--accent-danger)'
        : 'var(--accent-warning)'

  return (
    <div className="vfd-display">
      {/* BAR : BEAT DISPLAY */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <span className="vfd-caption">COMPÁS // PULSO</span>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '6px',
            fontFamily: 'var(--font-mono)',
            marginTop: '2px',
          }}
        >
          <span ref={barRef} className="vfd-digits" />
          <span style={{ fontSize: '26px', color: 'var(--text-disabled)', fontWeight: 300 }}>:</span>
          <span ref={beatRef} className="vfd-digits vfd-beat" />
        </div>
      </div>

      {/* BPM DISPLAY */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span className="vfd-caption">TEMPO</span>
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
          {bpm === null ? '---' : Number.isInteger(bpm) ? bpm : bpm.toFixed(1)}{' '}
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 600 }}>BPM</span>
        </div>
      </div>

      {/* STATUS & LINK BADGES */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 800,
            padding: '4px 10px',
            borderRadius: 'var(--theme-radius)',
            border: playing ? '1px solid var(--accent-active)' : '1px solid var(--text-disabled)',
            color: playing ? 'var(--accent-active)' : 'var(--text-disabled)',
            background: playing ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
            letterSpacing: '1px',
          }}
        >
          [{status ? STATUS_LABEL[status] : 'SIN ESTADO'}]
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            fontWeight: 700,
            color: linkColor,
          }}
        >
          {flywheel ? <FlywheelIcon size={12} /> : <WifiIcon size={12} />}
          <span>[{LINK_STATE_LABEL[linkState]}]</span>
        </div>
      </div>
    </div>
  )
}
