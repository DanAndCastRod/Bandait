import React, { useEffect, useLayoutEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useHub } from '../../context/hubContextCore'
import { WaveformSettings } from '../WaveformSettings'

interface Props {
  /** Boton que lo abrio: un clic ahi no cuenta como "afuera" y el foco vuelve a el al cerrar. */
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
}

/**
 * Acceso rapido a la forma de onda desde la barra de la linea de tiempo. Escribe el mismo
 * `uiPreferences.waveform` que APARIENCIA (se guarda en la cuenta del musico). Esc o un clic
 * afuera lo cierran; los atajos del Estudio no se disparan adentro (es un dialogo).
 */
export const StudioWaveformPopover: React.FC<Props> = ({ anchorRef, onClose }) => {
  const { uiPreferences, setUiPreferences } = useHub()
  const rootRef = useRef<HTMLDivElement>(null)
  // La vista pasa una funcion nueva en cada render: el efecto de abajo corre una sola vez.
  const closeRef = useRef(onClose)
  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  // Fijo bajo el boton (la linea de tiempo recorta lo que sobresale): se recoloca al cambiar el
  // tamano de la ventana o al desplazar la pagina, sin estado de React.
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current
      const root = rootRef.current
      if (!anchor || !root) return
      const box = anchor.getBoundingClientRect()
      const width = Math.min(380, window.innerWidth - 16)
      const left = Math.min(Math.max(8, box.right - width), window.innerWidth - width - 8)
      root.style.width = `${width}px`
      root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(box.bottom + 6)}px, 0)`
      root.style.maxHeight = `${Math.max(240, window.innerHeight - box.bottom - 16)}px`
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchorRef])

  useEffect(() => {
    const anchor = anchorRef.current
    const root = rootRef.current
    root?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true })
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (root?.contains(target) || anchor?.contains(target)) return
      closeRef.current()
    }
    document.addEventListener('pointerdown', onPointer, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      // Si el foco estaba adentro, al desmontarse queda en el body: vuelve al boton.
      const active = document.activeElement
      if (anchor?.isConnected && (!active || active === document.body || root?.contains(active))) anchor.focus({ preventScroll: true })
    }
  }, [anchorRef])

  return (
    <div
      ref={rootRef}
      className="stu-pop"
      role="dialog"
      aria-label="Forma de onda"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
      data-testid="studio-waveform-popover"
    >
      <div className="stu-pop-head">
        <span className="stu-label">Forma de onda</span>
        <button type="button" className="stu-btn" data-size="mini" data-tone="ghost" onClick={onClose} aria-label="Cerrar la forma de onda" data-testid="studio-waveform-close">
          <X size={12} />
        </button>
      </div>
      <WaveformSettings value={uiPreferences.waveform} onChange={(waveform) => setUiPreferences({ ...uiPreferences, waveform })} testIdPrefix="studio-waveform" compact />
    </div>
  )
}
