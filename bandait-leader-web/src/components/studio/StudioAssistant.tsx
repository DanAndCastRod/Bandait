import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Minus, Sparkles } from 'lucide-react'
import { ASSISTANT_NARROW_PX, clampFloatRect, withAssistantMode, type AssistantLayout, type AssistantMode, type AssistantRect } from '../../services/studio/assistantWindow'
import { formatUsd } from '../../services/studio/jobs'
import type { CommandContext } from '../../services/studio/types'
import { StudioChatPanel, type StudioChatStatus } from './StudioChatPanel'
import type { StudioRegistry } from './studioCommandHandlers'
import type { StudioController } from './studioState'

const NARROW_QUERY = `(max-width: ${ASSISTANT_NARROW_PX - 1}px)`

function subscribeNarrow(listener: () => void): () => void {
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

/** Pantalla angosta: la ventana flotante se muestra como hoja inferior. */
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW_QUERY).matches,
    () => false
  )
}

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** Posicion y tamano de la ventana flotante, directo en el elemento (sin render por cada movimiento). */
function placeFloating(el: HTMLElement, rect: AssistantRect): void {
  el.style.width = `${rect.w}px`
  el.style.height = `${rect.h}px`
  el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`
}

function clearPlacement(el: HTMLElement): void {
  el.style.width = ''
  el.style.height = ''
  el.style.transform = ''
}

const IDLE_STATUS: StudioChatStatus = { thinking: false, pending: 0, auditioning: false, spentUsd: 0 }

type Gesture =
  | { kind: 'move'; pointerId: number; startX: number; startY: number; from: AssistantRect; rect: AssistantRect }
  | { kind: 'resize'; pointerId: number; startX: number; startY: number; from: AssistantRect; rect: AssistantRect }

interface Props {
  controller: StudioController
  registry: StudioRegistry | null
  commandContext: () => CommandContext
  layout: AssistantLayout
  onLayout: (layout: AssistantLayout) => void
  /** Atajo vigente de view.toggle_assistant, para los titulos ("Alt+A"). */
  shortcut: string
}

/**
 * Ventana del asistente del Estudio con dos modos: FLOTANTE (se arrastra por su barra y se
 * redimensiona por la esquina, sin salir de la ventana del navegador; en pantallas angostas es una
 * hoja inferior) y MINIMIZADO (pildora con el estado). El modo acoplado se retiro en la ola 2 de
 * Web 3.0: la linea de tiempo y el piano roll ocupan el area central. El chat queda montado en
 * los dos modos: una respuesta en camino no se pierde. Solo se animan transform y opacity; el
 * modo, la posicion y el tamano los guarda la vista.
 */
export const StudioAssistant: React.FC<Props> = ({ controller, registry, commandContext, layout, onLayout, shortcut }) => {
  const narrow = useNarrow()
  const rootRef = useRef<HTMLElement>(null)
  const pillRef = useRef<HTMLButtonElement>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const [status, setStatus] = useState<StudioChatStatus>(IDLE_STATUS)
  const [dragging, setDragging] = useState(false)
  const { mode } = layout
  const floating = mode === 'floating' && !narrow
  const prevModeRef = useRef<AssistantMode>(mode)

  const onStatus = useCallback((next: StudioChatStatus) => setStatus(next), [])

  // Posicion y tamano aplicados al elemento cuando cambia el modo o el layout guardado.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    if (floating) placeFloating(el, layout.float)
    else clearPlacement(el)
  }, [floating, layout.float])

  // Al cambiar el tamano del navegador la ventana se acota para seguir entera a la vista.
  useEffect(() => {
    const onResize = () => {
      const float = clampFloatRect(layout.float, viewport())
      const f = layout.float
      if (float.x !== f.x || float.y !== f.y || float.w !== f.w || float.h !== f.h) onLayout({ ...layout, float })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [layout, onLayout])

  // Foco: al abrirse va al campo del mensaje; al minimizarse con el foco adentro, a la pildora.
  useEffect(() => {
    const prev = prevModeRef.current
    prevModeRef.current = mode
    if (prev === mode) return
    if (mode === 'minimized') {
      const active = document.activeElement
      if (!active || active === document.body || rootRef.current?.contains(active)) pillRef.current?.focus({ preventScroll: true })
      return
    }
    const root = rootRef.current
    const input = root?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)')
    if (input) input.focus({ preventScroll: true })
    else root?.querySelector<HTMLElement>('.stu-assist-title')?.focus({ preventScroll: true })
  }, [mode])

  const setMode = (next: AssistantMode) => onLayout(withAssistantMode(layout, next))

  // ---- arrastre (pointer events con captura) ----

  const endGesture = (event: React.PointerEvent<HTMLElement>) => {
    const g = gestureRef.current
    if (!g || g.pointerId !== event.pointerId) return
    gestureRef.current = null
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onLayout({ ...layout, float: g.rect })
  }

  const startMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!floating || event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button, input, textarea, select, a')) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = { kind: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, from: layout.float, rect: layout.float }
    setDragging(true)
  }

  const startResize = (event: React.PointerEvent<HTMLElement>) => {
    if (!floating || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = { kind: 'resize', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, from: layout.float, rect: layout.float }
    setDragging(true)
  }

  const onGestureMove = (event: React.PointerEvent<HTMLElement>) => {
    const g = gestureRef.current
    const el = rootRef.current
    if (!g || !el || g.pointerId !== event.pointerId) return
    const vp = viewport()
    const dx = event.clientX - g.startX
    const dy = event.clientY - g.startY
    g.rect = g.kind === 'move' ? clampFloatRect({ ...g.from, x: g.from.x + dx, y: g.from.y + dy }, vp) : clampFloatRect({ ...g.from, w: g.from.w + dx, h: g.from.h + dy }, vp)
    placeFloating(el, g.rect)
  }

  const gestureHandlers = { onPointerMove: onGestureMove, onPointerUp: endGesture, onPointerCancel: endGesture }

  /** Esc minimiza la ventana, pero nunca mientras hay texto escrito en el mensaje. */
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || mode !== 'floating') return
    const target = event.target
    if (target instanceof HTMLTextAreaElement && target.value.trim() !== '') return
    if (target instanceof Element && target.closest('[role="alertdialog"]')) return
    event.preventDefault()
    setMode('minimized')
  }

  const pillState = status.auditioning ? 'listening' : status.thinking ? 'thinking' : status.pending > 0 ? 'pending' : 'idle'
  const pillText = status.auditioning ? 'ESCUCHANDO' : status.thinking ? 'PENSANDO' : status.pending > 0 ? `${status.pending} POR DECIDIR` : null

  return (
    <>
      <section
        ref={rootRef}
        className="stu-assist"
        data-mode={mode}
        data-sheet={mode === 'floating' && narrow}
        data-dragging={dragging}
        hidden={mode === 'minimized'}
        aria-label="Asistente del Estudio"
        data-studio-assistant="true"
        onKeyDown={onKeyDown}
        data-testid="studio-assistant"
      >
        <header className="stu-assist-bar" data-movable={floating} onPointerDown={startMove} {...gestureHandlers} data-testid="studio-assistant-bar">
          <span className="stu-assist-mark" aria-hidden="true">
            <Sparkles size={13} />
          </span>
          <h2 className="stu-assist-title" tabIndex={-1}>
            ASISTENTE
          </h2>
          {status.spentUsd > 0 && <span className="stu-label">{formatUsd(status.spentUsd)}</span>}
          <span className="stu-bar-spacer" />
          <button type="button" className="stu-btn" data-size="icon" data-tone="ghost" onClick={() => setMode('minimized')} aria-label={`Minimizar el asistente (${shortcut})`} title={`Minimizar a la píldora (${shortcut} o Esc)`} data-testid="studio-assistant-minimize">
            <Minus size={14} />
          </button>
        </header>
        <div className="stu-assist-body">
          <StudioChatPanel controller={controller} registry={registry} commandContext={commandContext} onStatus={onStatus} />
        </div>
        {floating && <div className="stu-assist-grip" aria-hidden="true" onPointerDown={startResize} {...gestureHandlers} data-testid="studio-assistant-resize" />}
      </section>

      {mode === 'minimized' && (
        <button
          ref={pillRef}
          type="button"
          className="stu-assist-pill"
          data-state={pillState}
          onClick={() => setMode('floating')}
          aria-label={`Mostrar el asistente (${shortcut})${pillText ? `. ${pillText}` : ''}`}
          title={`Mostrar el asistente (${shortcut})`}
          data-testid="studio-assistant-pill"
        >
          <span className="stu-assist-mark" aria-hidden="true">
            <Sparkles size={13} />
          </span>
          <span>Asistente</span>
          {pillText ? (
            <span className="stu-assist-pill-state" aria-live="polite" data-testid="studio-assistant-pill-state">
              {pillState === 'thinking' && <span className="stu-assist-dot" aria-hidden="true" />}
              {pillText}
            </span>
          ) : (
            <kbd className="stu-assist-kbd">{shortcut}</kbd>
          )}
        </button>
      )}
    </>
  )
}
