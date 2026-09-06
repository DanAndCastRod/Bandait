import React, { useState, useRef, useEffect, useCallback } from 'react'

interface Props {
  label: string
  value: number // 0 to 1 (linear gain)
  onChange: (value: number) => void
  minDb?: number // default -60 dB
  maxDb?: number // default +6 dB
  limiterThresholdDb?: number // -0.5 dBFS
  disabled?: boolean
}

export default function HardwareKnob({
  label,
  value,
  onChange,
  minDb = -60,
  maxDb = 6,
  limiterThresholdDb = -0.5,
  disabled = false,
}: Props) {
  const [isDragging, setIsDragging] = useState(false)
  const dragStartY = useRef(0)
  const dragStartVal = useRef(0)

  // Convert linear 0..1 gain to dB: dB = 20 * log10(gain)
  const currentDb = value <= 0.001 ? minDb : Math.min(maxDb, Math.max(minDb, 20 * Math.log10(value)))
  const isLimiterActive = currentDb >= limiterThresholdDb

  // 270 degree rotation: from -135deg (min) to +135deg (max)
  const rotationDeg = -135 + value * 270

  const handlePointerDown = (e: React.PointerEvent) => {
    if (disabled) return
    setIsDragging(true)
    dragStartY.current = e.clientY
    dragStartVal.current = value
    const targetEl = e.target as HTMLElement
    targetEl.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging || disabled) return
    const deltaY = dragStartY.current - e.clientY // dragging UP increases value
    const sensitivity = 0.005
    const newVal = Math.max(0, Math.min(1, dragStartVal.current + deltaY * sensitivity))
    onChange(newVal)
  }, [isDragging, disabled, onChange])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (isDragging) {
      setIsDragging(false)
      try {
        const targetEl = e.target as HTMLElement
        targetEl.releasePointerCapture(e.pointerId)
      } catch {
        // Safe fallback
      }
    }
  }, [isDragging])

  useEffect(() => {
    const handleGlobalUp = () => setIsDragging(false)
    window.addEventListener('pointerup', handleGlobalUp)
    return () => window.removeEventListener('pointerup', handleGlobalUp)
  }, [])

  const formattedDb = currentDb <= minDb ? '-INF' : `${currentDb >= 0 ? '+' : ''}${currentDb.toFixed(1)} dB`

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        userSelect: 'none',
      }}
    >
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{
          width: '56px',
          height: '56px',
          borderRadius: '50%',
          background: 'var(--bg-elevated)',
          border: isLimiterActive
            ? '2px solid var(--accent-warning)'
            : '2px solid var(--theme-border)',
          position: 'relative',
          cursor: disabled ? 'not-allowed' : 'ns-resize',
          boxShadow: isDragging ? '0 0 10px rgba(0, 255, 200, 0.4)' : 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          touchAction: 'none',
        }}
      >
        {/* ROTATING INDICATOR NOTCH */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            transform: `rotate(${rotationDeg}deg)`,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: '3px',
              height: '10px',
              background: isLimiterActive ? 'var(--accent-warning)' : 'var(--accent-active)',
              borderRadius: '2px',
              margin: '4px auto 0 auto',
            }}
          />
        </div>

        {/* CENTER CAP */}
        <div
          style={{
            width: '30px',
            height: '30px',
            borderRadius: '50%',
            background: 'var(--bg-surface)',
            border: '1px solid var(--theme-border)',
            pointerEvents: 'none',
          }}
        />
      </div>

      {/* LABEL AND VALUE DISPLAY */}
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '10px',
            color: 'var(--text-secondary)',
            letterSpacing: '0.5px',
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            fontWeight: 700,
            color: isLimiterActive ? 'var(--accent-warning)' : 'var(--text-primary)',
            marginTop: '1px',
          }}
        >
          {formattedDb}
        </div>
      </div>
    </div>
  )
}
