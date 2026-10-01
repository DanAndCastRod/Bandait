import React, { useEffect } from 'react'
import { X } from 'lucide-react'
import { colors, mono } from './hubStyles'

interface Props {
  title: string
  onClose: () => void
  maxWidth?: string
  testId?: string
  /** false en editores con borrador: Escape no debe descartar cambios. */
  closeOnEscape?: boolean
  children: React.ReactNode
}

/** Modal del Hub: fondo OLED, cabecera fija y cuerpo con scroll propio (sin scroll horizontal). */
export const HubModal: React.FC<Props> = ({ title, onClose, maxWidth = '520px', testId, closeOnEscape = true, children }) => {
  useEffect(() => {
    if (!closeOnEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, closeOnEscape])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.88)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '12px',
        boxSizing: 'border-box',
      }}
    >
      <div
        data-testid={testId}
        style={{
          background: colors.modal,
          border: `1px solid ${colors.border}`,
          borderRadius: '8px',
          width: '100%',
          maxWidth,
          maxHeight: '94dvh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.7)',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            padding: '14px clamp(12px, 3vw, 20px)',
            borderBottom: `1px solid ${colors.border}`,
          }}
        >
          <h3 style={{ margin: 0, fontFamily: mono, fontSize: '15px', letterSpacing: '0.5px', color: colors.text, minWidth: 0 }}>
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            style={{ background: 'transparent', border: 'none', color: colors.muted, cursor: 'pointer', display: 'flex', padding: '4px' }}
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', overflowX: 'hidden', padding: 'clamp(12px, 3vw, 20px)', minWidth: 0 }}>{children}</div>
      </div>
    </div>
  )
}
