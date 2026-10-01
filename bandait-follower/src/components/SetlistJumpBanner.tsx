import { useEffect, useRef } from 'react'
import { SetlistJump } from '../types/protocol'

interface Props {
  alert: SetlistJump | null
  onDismiss: () => void
  autoDismissMs?: number
}

const ORIGIN_LABEL: Record<SetlistJump['triggeredBy'], string> = {
  laptop_foh: 'LAPTOP FOH',
  director_mobile: 'DIRECTOR MOVIL',
  hub: 'HUB',
}

/**
 * High-visibility banner for a non-sequential setlist jump. The auto-dismiss
 * timer depends only on the alert itself: onDismiss is read through a ref, so
 * parent re-renders during playback cannot restart it. The progress bar is a
 * CSS animation (no React state per frame).
 */
export default function SetlistJumpBanner({ alert, onDismiss, autoDismissMs = 6000 }: Props) {
  const onDismissRef = useRef(onDismiss)
  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!alert) return
    const timer = setTimeout(() => onDismissRef.current(), autoDismissMs)
    return () => clearTimeout(timer)
  }, [alert, autoDismissMs])

  if (!alert) return null

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'calc(100% - 24px)',
        maxWidth: '720px',
        background: 'var(--bg-elevated)',
        border: '2px solid var(--accent-warning)',
        borderRadius: '6px',
        padding: '14px 18px',
        zIndex: 99999,
        boxShadow: '0 10px 30px rgba(0, 0, 0, 0.9)',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      {/* HEADER BADGE */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span
            style={{
              background: 'var(--accent-warning)',
              color: '#000000',
              fontWeight: 800,
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              padding: '2px 8px',
              borderRadius: '2px',
              letterSpacing: '1px',
            }}
          >
            [SALTO DE REPERTORIO]
          </span>
          <span
            style={{
              fontSize: '11px',
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
            }}
          >
            ORIGEN: [{ORIGIN_LABEL[alert.triggeredBy]}]
          </span>
        </div>

        <button
          type="button"
          onClick={() => onDismissRef.current()}
          style={{
            background: 'transparent',
            border: '1px solid var(--text-secondary)',
            color: 'var(--text-primary)',
            fontSize: '11px',
            fontFamily: 'var(--font-mono)',
            padding: '3px 10px',
            borderRadius: '3px',
            cursor: 'pointer',
          }}
        >
          [ENTENDIDO]
        </button>
      </div>

      {/* BODY INFO */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '22px',
            fontWeight: 800,
            color: 'var(--accent-warning)',
          }}
        >
          TEMA #{String(alert.orderIndex + 1).padStart(2, '0')}:
        </span>
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '20px',
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.5px',
          }}
        >
          {alert.title}
        </span>
      </div>

      {/* AUTO DISMISS PROGRESS BAR (CSS animation, keyed per alert) */}
      <div
        style={{
          width: '100%',
          height: '3px',
          background: 'rgba(255, 255, 255, 0.1)',
          borderRadius: '2px',
          overflow: 'hidden',
          marginTop: '4px',
        }}
      >
        <div
          key={`${alert.songId}-${alert.timestampNs}`}
          className="jump-banner-progress"
          style={{ animationDuration: `${autoDismissMs}ms` }}
        />
      </div>
    </div>
  )
}
