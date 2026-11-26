import React, { useEffect, useId, useRef } from 'react'
import { RotateCcw } from 'lucide-react'
import {
  WAVEFORM_BAR_GAP_MAX,
  WAVEFORM_BAR_GAP_MIN,
  WAVEFORM_BAR_WIDTH_MAX,
  WAVEFORM_BAR_WIDTH_MIN,
  WAVEFORM_COLORS,
  WAVEFORM_COLOR_LABELS,
  WAVEFORM_DATA,
  WAVEFORM_DATA_LABELS,
  WAVEFORM_GAIN_MAX,
  WAVEFORM_GAIN_MIN,
  WAVEFORM_GAIN_STEP,
  WAVEFORM_LAYOUTS,
  WAVEFORM_LAYOUT_LABELS,
  WAVEFORM_SCALES,
  WAVEFORM_SCALE_LABELS,
  WAVEFORM_STYLES,
  WAVEFORM_STYLE_LABELS,
  clampBarGap,
  clampBarWidth,
  clampWaveformGain,
  defaultWaveformPreferences,
  normalizeWaveformPreferences,
  waveformPreferencesEqual,
  type WaveformPreferences,
} from '../services/waveform'
import { drawWaveform, resolveWaveformColors, waveformAlpha } from '../services/waveformRender'
import { studioTrackColor } from '../services/studioCanvasPalette'
import { useStudioCanvasPalette } from './studio/useStudioCanvasPalette'
import '../styles/waveform.css'

// ---------------------------------------------------------------------------
// Vista previa: una frase sintetica (ataques y caidas), igual en cada render
// ---------------------------------------------------------------------------

interface PreviewColumns {
  min: Float32Array
  max: Float32Array
  rms: Float32Array
}

const previewCache = new Map<number, PreviewColumns>()

/** Columnas de una forma de onda de ejemplo: golpes con caida, cuerpo sostenido y algo de ruido determinista. */
function previewColumns(count: number): PreviewColumns {
  const cached = previewCache.get(count)
  if (cached) return cached
  const min = new Float32Array(count)
  const max = new Float32Array(count)
  const rms = new Float32Array(count)
  let seed = 7
  for (let i = 0; i < count; i++) {
    seed = (seed * 9301 + 49297) % 233280
    const noise = seed / 233280
    const t = i / Math.max(1, count - 1)
    const beat = (t * 8) % 1
    const envelope = 0.22 + 0.7 * Math.exp(-beat * 5.5) * (0.65 + 0.35 * Math.sin(t * Math.PI))
    const body = envelope * (0.82 + 0.18 * noise)
    max[i] = Math.min(1, body * (0.92 + 0.08 * Math.sin(i * 0.9)))
    min[i] = -Math.min(1, body * (0.88 + 0.1 * Math.cos(i * 0.7)))
    rms[i] = body * 0.48
  }
  const out = { min, max, rms }
  if (previewCache.size > 8) previewCache.clear()
  previewCache.set(count, out)
  return out
}

const WaveformPreview: React.FC<{ prefs: WaveformPreferences; testId: string; height: number }> = ({ prefs, testId, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const palette = useStudioCanvasPalette()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const paint = () => {
      const dpr = window.devicePixelRatio || 1
      const width = Math.round(canvas.clientWidth)
      if (width === 0) return
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = palette.lane
      ctx.fillRect(0, 0, width, height)
      // Un clip de ejemplo con el color de la pista de voz, como en la linea de tiempo.
      const track = studioTrackColor(palette, '#E06C9F')
      const inset = 10
      const boxW = width - 2 * inset
      const boxTop = 6
      const boxH = height - 12
      ctx.fillStyle = waveformAlpha(track, 0.18)
      ctx.fillRect(inset, boxTop, boxW, boxH)
      const cols = previewColumns(boxW)
      const colors = resolveWaveformColors(prefs.color, { track, accent: palette.accent, neutral: palette.text }, 0.9)
      drawWaveform(ctx, { min: cols.min, max: cols.max, rms: cols.rms, count: boxW, x: inset, top: boxTop, height: boxH, barOrigin: inset }, prefs, colors)
    }
    paint()
    const observer = new ResizeObserver(paint)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [prefs, palette, height])

  return <canvas ref={canvasRef} className="wf-preview" style={{ height: `${height}px` }} aria-hidden="true" data-testid={testId} />
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

interface SegProps<T extends string> {
  label: string
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onChange: (value: T) => void
  testId: string
}

function Segmented<T extends string>({ label, options, labels, value, onChange, testId }: SegProps<T>) {
  const id = useId()
  return (
    <div className="wf-row">
      <span className="wf-label" id={id}>
        {label}
      </span>
      <div className="wf-seg" role="radiogroup" aria-labelledby={id} data-testid={testId}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className="wf-seg-btn"
            onClick={() => onChange(option)}
            data-testid={`${testId}-${option}`}
          >
            {labels[option]}
          </button>
        ))}
      </div>
    </div>
  )
}

interface RangeProps {
  label: string
  min: number
  max: number
  step: number
  value: number
  text: string
  disabled?: boolean
  onChange: (value: number) => void
  testId: string
}

const Range: React.FC<RangeProps> = ({ label, min, max, step, value, text, disabled, onChange, testId }) => (
  <label className="wf-row" data-disabled={disabled === true}>
    <span className="wf-label">{label}</span>
    <span className="wf-range-line">
      <input type="range" className="wf-range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} aria-valuetext={text} data-testid={testId} />
      <span className="wf-value">{text}</span>
    </span>
  </label>
)

interface Props {
  value: WaveformPreferences
  onChange: (next: WaveformPreferences) => void
  /** Prefijo de los data-testid (la seccion de APARIENCIA y el popover del Estudio no chocan). */
  testIdPrefix: string
  /** Version compacta (popover): vista previa mas baja. */
  compact?: boolean
}

/**
 * Controles de la forma de onda con vista previa en vivo. Los usan la seccion FORMA DE ONDA de
 * APARIENCIA y el acceso rapido de la linea de tiempo del Estudio; los dos escriben el mismo
 * `uiPreferences.waveform`, asi que cambiar uno cambia el otro.
 */
export const WaveformSettings: React.FC<Props> = ({ value, onChange, testIdPrefix, compact = false }) => {
  const prefs = normalizeWaveformPreferences(value)
  const set = (patch: Partial<WaveformPreferences>) => onChange(normalizeWaveformPreferences({ ...prefs, ...patch }))
  const bars = prefs.style === 'bars'
  const isDefault = waveformPreferencesEqual(prefs, defaultWaveformPreferences())

  return (
    <div className="wf" data-compact={compact} data-testid={testIdPrefix}>
      <WaveformPreview prefs={prefs} height={compact ? 56 : 76} testId={`${testIdPrefix}-preview`} />
      <Segmented label="Estilo" options={WAVEFORM_STYLES} labels={WAVEFORM_STYLE_LABELS} value={prefs.style} onChange={(style) => set({ style })} testId={`${testIdPrefix}-style`} />
      <Segmented label="Armado" options={WAVEFORM_LAYOUTS} labels={WAVEFORM_LAYOUT_LABELS} value={prefs.layout} onChange={(layout) => set({ layout })} testId={`${testIdPrefix}-layout`} />
      <Segmented label="Datos" options={WAVEFORM_DATA} labels={WAVEFORM_DATA_LABELS} value={prefs.data} onChange={(data) => set({ data })} testId={`${testIdPrefix}-data`} />
      <Segmented label="Escala" options={WAVEFORM_SCALES} labels={WAVEFORM_SCALE_LABELS} value={prefs.scale} onChange={(scale) => set({ scale })} testId={`${testIdPrefix}-scale`} />
      <Segmented label="Color" options={WAVEFORM_COLORS} labels={WAVEFORM_COLOR_LABELS} value={prefs.color} onChange={(color) => set({ color })} testId={`${testIdPrefix}-color`} />
      <Range
        label="Zoom vertical"
        min={WAVEFORM_GAIN_MIN}
        max={WAVEFORM_GAIN_MAX}
        step={WAVEFORM_GAIN_STEP}
        value={prefs.gain}
        text={`${prefs.gain.toFixed(2).replace('.', ',')}x`}
        onChange={(gain) => set({ gain: clampWaveformGain(gain) })}
        testId={`${testIdPrefix}-gain`}
      />
      <Range
        label="Ancho de barra"
        min={WAVEFORM_BAR_WIDTH_MIN}
        max={WAVEFORM_BAR_WIDTH_MAX}
        step={1}
        value={prefs.barWidth}
        text={`${prefs.barWidth} px`}
        disabled={!bars}
        onChange={(barWidth) => set({ barWidth: clampBarWidth(barWidth) })}
        testId={`${testIdPrefix}-bar-width`}
      />
      <Range
        label="Separación"
        min={WAVEFORM_BAR_GAP_MIN}
        max={WAVEFORM_BAR_GAP_MAX}
        step={1}
        value={prefs.barGap}
        text={`${prefs.barGap} px`}
        disabled={!bars}
        onChange={(barGap) => set({ barGap: clampBarGap(barGap) })}
        testId={`${testIdPrefix}-bar-gap`}
      />
      <div className="wf-foot">
        <span className="wf-hint">Solo cambia cómo se ve: el audio y la mezcla no se tocan.</span>
        <button type="button" className="wf-reset" disabled={isDefault} onClick={() => onChange(defaultWaveformPreferences())} data-testid={`${testIdPrefix}-reset`}>
          <RotateCcw size={12} aria-hidden="true" />
          Por defecto
        </button>
      </div>
    </div>
  )
}
