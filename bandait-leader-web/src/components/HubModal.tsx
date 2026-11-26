import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { colors, mono } from './hubStyles'

interface Props {
  title: string
  onClose: () => void
  maxWidth?: string
  testId?: string
  /** false en editores con borrador: Escape no debe descartar cambios. */
  closeOnEscape?: boolean
  /** Nombre accesible del boton de cerrar (por defecto "Cerrar"). */
  closeLabel?: string
  children: React.ReactNode
}

/** Modal del Hub: fondo OLED, cabecera fija y cuerpo con scroll propio (sin scroll horizontal). */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

export const HubModal: React.FC<Props> = ({ title, onClose, maxWidth = '520px', testId, closeOnEscape = true, closeLabel = 'Cerrar', children }) => {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!closeOnEscape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, closeOnEscape])

  // Foco atrapado: entra al abrir (si un campo con autoFocus no lo tomo ya), Tab da la vuelta
  // dentro del modal y al cerrar vuelve a donde estaba.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous && previous.isConnected) previous.focus()
    }
  }, [])

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--b-overlay)',
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
          borderRadius: 'var(--b-radius-card)',
          width: '100%',
          maxWidth,
          maxHeight: '94dvh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--b-shadow)',
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
            padding: '16px clamp(14px, 3vw, 22px) 6px',
          }}
        >
          <h3 style={{ margin: 0, fontFamily: mono, fontSize: '15px', letterSpacing: '0.5px', color: colors.text, minWidth: 0 }}>
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="hub-icon-btn hub-press"
          >
            <X size={18} />
          </button>
        </div>
        <div style={{ overflowY: 'auto', overflowX: 'hidden', padding: '10px clamp(14px, 3vw, 22px) clamp(14px, 3vw, 22px)', minWidth: 0 }}>{children}</div>
      </div>
    </div>
  )
}
