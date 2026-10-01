import { useCallback, useEffect, useRef } from 'react'

interface Props {
  onTrigger: () => void
  label: string
  /** Hold time needed to fire (ms). */
  holdMs?: number
}

/**
 * Hold-to-fire emergency control. Progress is animated with rAF and written
 * straight to the DOM, so holding it never re-renders the stage.
 */
export default function EmergencySlide({ onTrigger, label, holdMs = 800 }: Props) {
  const handleRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef<number | null>(null)
  const onTriggerRef = useRef(onTrigger)
  onTriggerRef.current = onTrigger

  const paint = useCallback((progress: number) => {
    const p = Math.max(0, Math.min(1, progress))
    if (handleRef.current) handleRef.current.style.left = `calc(4px + (100% - 52px) * ${p.toFixed(4)})`
    if (fillRef.current) fillRef.current.style.width = `${(p * 100).toFixed(2)}%`
  }, [])

  const cancel = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    startRef.current = null
    paint(0)
  }, [paint])

  const start = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (startRef.current !== null) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // Pointer capture is optional.
      }
      startRef.current = performance.now()
      const loop = () => {
        if (startRef.current === null) return
        const progress = (performance.now() - startRef.current) / holdMs
        if (progress >= 1) {
          cancel()
          onTriggerRef.current()
          return
        }
        paint(progress)
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    },
    [cancel, holdMs, paint],
  )

  useEffect(() => cancel, [cancel])

  return (
    <div className="emergency-container">
      <div
        className="emergency-track"
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
        role="button"
        aria-label={label}
      >
        <div ref={handleRef} className="emergency-handle">
          ■
        </div>
        <div className="emergency-label">{label}</div>
        <div ref={fillRef} className="emergency-fill" style={{ width: '0%' }} />
      </div>
    </div>
  )
}
