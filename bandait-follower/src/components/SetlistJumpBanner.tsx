import { useEffect, useState } from 'react'
import { SetlistJumpAlert } from '../types/protocol'

interface Props {
  alert: SetlistJumpAlert | null
  onDismiss: () => void
  autoDismissMs?: number
}

export default function SetlistJumpBanner({
  alert,
  onDismiss,
  autoDismissMs = 6000,
}: Props) {
  const [progress, setProgress] = useState(100)

  useEffect(() => {
    if (!alert) return

    setProgress(100)
    const startTime = Date.now()
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime
      const remaining = Math.max(0, 100 - (elapsed / autoDismissMs) * 100)
      setProgress(remaining)
      if (remaining <= 0) {
        clearInterval(interval)
        onDismiss()
      }
    }, 50)

    return () => clearInterval(interval)
  }, [alert, autoDismissMs, onDismiss])

  if (!alert) return null

  const originLabel =
    alert.triggered_by === 'laptop'
      ? 'LAPTOP FOH'
      : alert.triggered_by === 'director_mobile'
        ? 'DIRECTOR MOVIL'
        : alert.triggered_by.toUpperCase()

  return (
    <div
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
            ORIGEN: [{originLabel}]
          </span>
        </div>

        <button
          onClick={onDismiss}
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
          TEMA #{String(alert.order_index).padStart(2, '0')}:
        </span>
        <span
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '20px',
            fontWeight: 700,
            color: 'var(--text-primary)',
            letterSpacing: '-0.5px',
          }}
        >
          {alert.title}
        </span>
      </div>

      {/* AUTO DISMISS PROGRESS BAR */}
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
          style={{
            width: `${progress}%`,
            height: '100%',
            background: 'var(--accent-warning)',
            transition: 'width 0.05s linear',
          }}
        />
      </div>
    </div>
  )
}
