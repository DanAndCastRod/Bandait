import React, { useEffect, useRef } from 'react'
import { Copy, Download, Piano, Power, RotateCcw, Scissors, Sparkles, Trash2 } from 'lucide-react'
import { eqBands, type EqBand } from '../../services/studio/fx'
import {
  defaultFx,
  findClip,
  findMidiClip,
  findTrack,
  STUDIO_CLIP_GAIN_DB_MAX,
  STUDIO_CLIP_GAIN_DB_MIN,
  STUDIO_FX_PARAM_SPECS,
  STUDIO_MASTER_ID,
  type EqParams,
  type StudioAssetKind,
  type StudioClip,
  type StudioFx,
  type StudioFxType,
  type StudioSession,
} from '../../services/studio/session'
import { moveClip, moveMidiClip, resizeMidiClip, setClipFades, setClipGain, updateMidiClip } from '../../services/studio/sessionOps'
import { StudioInstrumentPanel } from './StudioInstrumentPanel'
import { StudioMidiDevicePanel } from './StudioMidiDevicePanel'
import {
  barBeatAt,
  downloadBlob,
  errorText,
  formatBarBeat,
  formatDb,
  formatTimecode,
  fxChainOf,
  useStudio,
  withFx,
  withoutFx,
  type StudioController,
  type StudioFxSelection,
  type StudioPanelProps,
} from './studioState'

// ---------------------------------------------------------------------------
// Curva del EQ
// ---------------------------------------------------------------------------

interface Biquad {
  b0: number
  b1: number
  b2: number
  a0: number
  a1: number
  a2: number
}

/**
 * Coeficientes de una banda con las formulas de BiquadFilterNode (especificacion de Web Audio),
 * para dibujar la misma respuesta que suena. null = la banda no cambia nada (ganancia 0 o pasa
 * altos apagado).
 */
function bandBiquad(band: EqBand, sampleRate: number): Biquad | null {
  if (!(band.frequency > 0)) return null
  const w0 = (2 * Math.PI * band.frequency) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  if (band.type === 'highpass') {
    // En highpass el Q de BiquadFilterNode va en dB.
    const alpha = sin / (2 * Math.pow(10, band.q / 20))
    return { b0: (1 + cos) / 2, b1: -(1 + cos), b2: (1 + cos) / 2, a0: 1 + alpha, a1: -2 * cos, a2: 1 - alpha }
  }
  if (band.gainDb === 0) return null
  const A = Math.pow(10, band.gainDb / 40)
  if (band.type === 'peaking') {
    const alpha = sin / (2 * Math.max(band.q, 0.0001))
    return { b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A }
  }
  // Estantes con pendiente S = 1.
  const k = 2 * ((sin / 2) * Math.SQRT2) * Math.sqrt(A)
  if (band.type === 'lowshelf') {
    return {
      b0: A * (A + 1 - (A - 1) * cos + k),
      b1: 2 * A * (A - 1 - (A + 1) * cos),
      b2: A * (A + 1 - (A - 1) * cos - k),
      a0: A + 1 + (A - 1) * cos + k,
      a1: -2 * (A - 1 + (A + 1) * cos),
      a2: A + 1 + (A - 1) * cos - k,
    }
  }
  return {
    b0: A * (A + 1 + (A - 1) * cos + k),
    b1: -2 * A * (A - 1 + (A + 1) * cos),
    b2: A * (A + 1 + (A - 1) * cos - k),
    a0: A + 1 - (A - 1) * cos + k,
    a1: 2 * (A - 1 - (A + 1) * cos),
    a2: A + 1 - (A - 1) * cos - k,
  }
}

function biquadDb(c: Biquad, w: number): number {
  const c1 = Math.cos(w)
  const c2 = Math.cos(2 * w)
  const num = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 + 2 * (c.b0 * c.b1 + c.b1 * c.b2) * c1 + 2 * c.b0 * c.b2 * c2
  const den = c.a0 * c.a0 + c.a1 * c.a1 + c.a2 * c.a2 + 2 * (c.a0 * c.a1 + c.a1 * c.a2) * c1 + 2 * c.a0 * c.a2 * c2
  if (!(num > 0) || !(den > 0)) return -120
  return 10 * Math.log10(num / den)
}

const CURVE_MIN_HZ = 20
const CURVE_MAX_HZ = 20000
const CURVE_RANGE_DB = 20
const CURVE_GRID_HZ: readonly number[] = [100, 1000, 10000]

function drawEqCurve(canvas: HTMLCanvasElement, params: EqParams, sampleRate: number, bypass: boolean, detailed: boolean): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(canvas.clientWidth * dpr)
  const h = Math.round(canvas.clientHeight * dpr)
  if (w === 0 || h === 0) return
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx.clearRect(0, 0, w, h)
  const top = Math.min(CURVE_MAX_HZ, sampleRate / 2 - 1)
  const xOf = (hz: number) => (Math.log(hz / CURVE_MIN_HZ) / Math.log(top / CURVE_MIN_HZ)) * w
  const yOf = (db: number) => h / 2 - (Math.max(-CURVE_RANGE_DB, Math.min(CURVE_RANGE_DB, db)) / CURVE_RANGE_DB) * (h / 2 - dpr)

  ctx.lineWidth = Math.max(1, dpr)
  ctx.strokeStyle = '#232830'
  ctx.beginPath()
  for (const hz of CURVE_GRID_HZ) {
    const x = Math.round(xOf(hz)) + 0.5
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  if (detailed) {
    for (const db of [-12, 12]) {
      const y = Math.round(yOf(db)) + 0.5
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
    }
  }
  ctx.stroke()
  ctx.strokeStyle = '#2E343D'
  ctx.beginPath()
  ctx.moveTo(0, Math.round(h / 2) + 0.5)
  ctx.lineTo(w, Math.round(h / 2) + 0.5)
  ctx.stroke()

  const biquads = eqBands(params, sampleRate)
    .map((band) => bandBiquad(band, sampleRate))
    .filter((item): item is Biquad => item !== null)
  const steps = Math.max(24, Math.round(w / (2 * dpr)))
  ctx.beginPath()
  for (let i = 0; i <= steps; i++) {
    const hz = CURVE_MIN_HZ * Math.pow(top / CURVE_MIN_HZ, i / steps)
    const omega = (2 * Math.PI * hz) / sampleRate
    let db = 0
    for (const item of biquads) db += biquadDb(item, omega)
    const x = (i / steps) * w
    if (i === 0) ctx.moveTo(x, yOf(db))
    else ctx.lineTo(x, yOf(db))
  }
  ctx.strokeStyle = bypass ? '#4A525D' : '#5CC8C2'
  ctx.lineWidth = Math.max(1.5, 1.5 * dpr)
  ctx.lineJoin = 'round'
  ctx.stroke()
  if (!bypass) {
    ctx.lineTo(w, h / 2)
    ctx.lineTo(0, h / 2)
    ctx.closePath()
    ctx.fillStyle = 'rgba(92, 200, 194, 0.14)'
    ctx.fill()
  }
  if (detailed) {
    ctx.fillStyle = '#8E97A3'
    ctx.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`
    ctx.textBaseline = 'bottom'
    for (const [hz, text] of [
      [100, '100'],
      [1000, '1k'],
      [10000, '10k'],
    ] as const) {
      ctx.fillText(text, xOf(hz) + 3 * dpr, h - 2 * dpr)
    }
    ctx.textBaseline = 'top'
    ctx.fillText('+12', 3 * dpr, yOf(12) + 2 * dpr)
    ctx.fillText('-12', 3 * dpr, yOf(-12) + 2 * dpr)
  }
}

interface EqCurveProps {
  params: EqParams
  sampleRate: number
  bypass: boolean
  /** Con rejilla de dB y rotulos de frecuencia (inspector); sin ellos es la miniatura del mezclador. */
  detailed?: boolean
  className?: string
}

/**
 * Respuesta en frecuencia del EQ de cuatro bandas, de 20 Hz a 20 kHz y +-20 dB. Se repinta solo
 * cuando cambian los parametros o el tamano: no hay nada por fotograma.
 */
export const StudioEqCurve: React.FC<EqCurveProps> = ({ params, sampleRate, bypass, detailed = false, className = 'stu-eq-curve' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { hpfHz, lowDb, midHz, midDb, midQ, highDb } = params

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => drawEqCurve(canvas, { hpfHz, lowDb, midHz, midDb, midQ, highDb }, sampleRate, bypass, detailed)
    draw()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [hpfHz, lowDb, midHz, midDb, midQ, highDb, sampleRate, bypass, detailed])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// Control deslizante con valor
// ---------------------------------------------------------------------------

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  /** Recorrido logaritmico (frecuencias). Requiere min > 0. */
  log?: boolean
  format: (value: number) => string
  /** Valor al que vuelve con doble clic. */
  resetTo?: number
  disabled?: boolean
  /** Cambio en caliente, sin paso de deshacer. */
  onLive: (value: number) => void
  /** Al soltar: cierra el paso de deshacer. */
  onCommit: () => void
  testId?: string
}

const LOG_STEPS = 1000

const ParamSlider: React.FC<SliderProps> = ({ label, value, min, max, step, log = false, format, resetTo, disabled, onLive, onCommit, testId }) => {
  const toPosition = (v: number) => Math.round((Math.log(Math.max(v, min) / min) / Math.log(max / min)) * LOG_STEPS)
  const fromPosition = (p: number) => {
    const raw = min * Math.pow(max / min, p / LOG_STEPS)
    return Math.min(max, Math.max(min, Math.round(raw / step) * step))
  }
  return (
    <label className="stu-param">
      <span className="stu-param-head">
        <span className="stu-label">{label}</span>
        <span className="stu-param-val">{format(value)}</span>
      </span>
      <input
        type="range"
        className="stu-range"
        min={log ? 0 : min}
        max={log ? LOG_STEPS : max}
        step={log ? 1 : step}
        value={log ? toPosition(value) : value}
        disabled={disabled}
        onChange={(event) => onLive(log ? fromPosition(Number(event.target.value)) : Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        onDoubleClick={() => {
          if (resetTo === undefined || disabled) return
          onLive(resetTo)
          onCommit()
        }}
        aria-valuetext={format(value)}
        title={resetTo === undefined ? undefined : `Doble clic: ${format(resetTo)}`}
        data-testid={testId}
      />
    </label>
  )
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

const signedDb = (value: number) => `${formatDb(value)} dB`
const hertz = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)} kHz` : `${Math.round(value)} Hz`)
const millis = (value: number) => `${Math.round(value)} ms`

function seconds(value: number): string {
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`
}

interface ParamUi {
  label: string
  step: number
  log?: boolean
  format: (value: number) => string
}

const PARAM_UI: Readonly<Record<StudioFxType, Readonly<Record<string, ParamUi>>>> = {
  eq: {
    hpfHz: { label: 'Pasa altos', step: 5, format: (v) => (v <= 0 ? 'apagado' : hertz(v)) },
    lowDb: { label: 'Graves (120 Hz)', step: 0.5, format: signedDb },
    midHz: { label: 'Medios: frecuencia', step: 10, log: true, format: hertz },
    midDb: { label: 'Medios: ganancia', step: 0.5, format: signedDb },
    midQ: { label: 'Medios: ancho (Q)', step: 0.1, format: (v) => v.toFixed(1) },
    highDb: { label: 'Agudos (8 kHz)', step: 0.5, format: signedDb },
  },
  compressor: {
    thresholdDb: { label: 'Umbral', step: 0.5, format: signedDb },
    ratio: { label: 'Relación', step: 0.1, format: (v) => `${v.toFixed(1)}:1` },
    attackMs: { label: 'Ataque', step: 1, format: millis },
    releaseMs: { label: 'Relajación', step: 5, format: millis },
    kneeDb: { label: 'Rodilla', step: 1, format: (v) => `${v.toFixed(0)} dB` },
    makeupDb: { label: 'Ganancia de salida', step: 0.5, format: signedDb },
  },
  limiter: {
    ceilingDb: { label: 'Techo', step: 0.1, format: signedDb },
    releaseMs: { label: 'Relajación', step: 5, format: millis },
  },
}

const FX_LABELS: Readonly<Record<StudioFxType, string>> = { eq: 'EQ', compressor: 'COMPRESOR', limiter: 'LIMITADOR' }
const FX_NAMES: Readonly<Record<StudioFxType, string>> = { eq: 'EQ', compressor: 'compresor', limiter: 'limitador' }
const FX_TYPES_UI: readonly StudioFxType[] = ['eq', 'compressor', 'limiter']

const KIND_LABELS: Readonly<Record<StudioAssetKind, string>> = {
  recording: 'GRABACIÓN',
  import: 'IMPORTADO',
  stem: 'STEM',
  generated: 'GENERADO POR IA',
  bounce: 'MEZCLA',
  master: 'MASTER',
}

/** Cambio en caliente con una operacion que puede lanzar: el error se muestra, no se propaga. */
function live(controller: StudioController, operation: (session: StudioSession) => StudioSession): void {
  try {
    controller.applyLive(operation(controller.snapshot().session))
  } catch (err) {
    controller.notify('error', errorText(err))
  }
}

// ---------------------------------------------------------------------------
// Clip elegido
// ---------------------------------------------------------------------------

const ClipSection: React.FC<{ controller: StudioController; session: StudioSession; clipId: string | null; recording: boolean }> = ({ controller, session, clipId, recording }) => {
  const loc = clipId ? findClip(session, clipId) : null
  if (!loc) {
    return (
      <section className="stu-section" aria-label="Clip elegido" data-testid="studio-inspector-clip">
        <span className="stu-label">Clip</span>
        <p className="stu-help">Elige un clip en la línea de tiempo para ajustar su ganancia, sus fades, su posición y su toma; o un clip MIDI para su largo, su repetición y el piano roll.</p>
      </section>
    )
  }
  const { clip, track } = loc
  const asset = session.assets.find((item) => item.id === clip.assetId)
  const position = barBeatAt(clip.startS, session.bpm, session.beatsPerBar)
  const maxFade = Math.max(0.01, Math.min(clip.lengthS, 10))
  const takes: StudioClip[] = clip.takeGroup === null ? [] : track.clips.filter((item) => item.takeGroup === clip.takeGroup).sort((a, b) => a.startS - b.startS || a.id.localeCompare(b.id))

  const commitStart = (raw: string, input: HTMLInputElement) => {
    const startS = Number(raw.replace(',', '.'))
    if (!Number.isFinite(startS) || startS < 0) {
      input.value = clip.startS.toFixed(3)
      return
    }
    if (Math.abs(startS - clip.startS) < 0.0005) return
    controller.run('Mover clip', (current) => moveClip(current, { clipId: clip.id, startS }))
  }

  return (
    <section className="stu-section" aria-label="Clip elegido" data-testid="studio-inspector-clip">
      <div className="stu-param-head">
        <span className="stu-label">Clip</span>
        <span className="stu-badge" data-tone={asset?.kind === 'generated' ? 'warn' : undefined}>
          {asset ? KIND_LABELS[asset.kind] : 'SIN AUDIO'}
        </span>
      </div>
      <strong className="stu-inspector-title">{asset?.label || 'Audio'}</strong>
      {asset?.kind === 'generated' && (
        <p className="stu-ai-note" data-testid="studio-inspector-ai">
          <Sparkles size={13} aria-hidden="true" />
          <span>
            Audio generado por IA{asset.source ? ` (${asset.source.provider.toUpperCase()})` : ''}.{asset.source?.prompt ? ` Descripción: "${asset.source.prompt}"` : ''} Revisa los términos del proveedor antes de publicar
            música con él.
          </span>
        </p>
      )}
      <dl className="stu-kv">
        <dt>Pista</dt>
        <dd>{track.name}</dd>
        <dt>Compás</dt>
        <dd>
          {position.bar}.{position.beat}
        </dd>
        <dt>Largo</dt>
        <dd>{formatTimecode(clip.lengthS)}</dd>
        <dt>Desde el audio</dt>
        <dd>{formatTimecode(clip.offsetS)}</dd>
      </dl>
      <label className="stu-param">
        <span className="stu-param-head">
          <span className="stu-label">Posición (segundos)</span>
          <span className="stu-param-val">{formatTimecode(clip.startS)}</span>
        </span>
        <input
          key={`start-${clip.id}-${clip.startS}`}
          type="number"
          className="stu-field"
          min={0}
          step={0.01}
          defaultValue={clip.startS.toFixed(3)}
          disabled={recording}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = clip.startS.toFixed(3)
              event.currentTarget.blur()
            }
          }}
          onBlur={(event) => commitStart(event.target.value, event.target)}
          data-testid="studio-clip-start"
        />
      </label>
      <ParamSlider
        label="Ganancia"
        value={clip.gainDb}
        min={STUDIO_CLIP_GAIN_DB_MIN}
        max={STUDIO_CLIP_GAIN_DB_MAX}
        step={0.5}
        format={signedDb}
        resetTo={0}
        onLive={(gainDb) => live(controller, (current) => setClipGain(current, { clipId: clip.id, gainDb }))}
        onCommit={() => controller.commitLive('Ganancia de clip')}
        testId="studio-clip-gain"
      />
      <ParamSlider
        label="Fade de entrada"
        value={Math.min(clip.fadeInS, maxFade)}
        min={0}
        max={maxFade}
        step={0.005}
        format={seconds}
        resetTo={0}
        onLive={(fadeInS) => live(controller, (current) => setClipFades(current, { clipId: clip.id, fadeInS }))}
        onCommit={() => controller.commitLive('Fade de entrada')}
        testId="studio-clip-fade-in"
      />
      <ParamSlider
        label="Fade de salida"
        value={Math.min(clip.fadeOutS, maxFade)}
        min={0}
        max={maxFade}
        step={0.005}
        format={seconds}
        resetTo={0}
        onLive={(fadeOutS) => live(controller, (current) => setClipFades(current, { clipId: clip.id, fadeOutS }))}
        onCommit={() => controller.commitLive('Fade de salida')}
        testId="studio-clip-fade-out"
      />

      <div className="stu-param">
        <span className="stu-label">Toma</span>
        {takes.length < 2 ? (
          <p className="stu-help">{clip.active ? 'Este clip no tiene tomas alternativas.' : 'Este clip está apagado.'}</p>
        ) : (
          <ul className="stu-takes" data-testid="studio-inspector-takes">
            {takes.map((take, index) => (
              <li key={take.id} data-current={take.id === clip.id}>
                <button type="button" className="stu-take-name" onClick={() => controller.select(take.id)} aria-label={`Ver la toma ${index + 1}`}>
                  TOMA {index + 1}
                  <span>{formatTimecode(take.startS)}</span>
                </button>
                {take.active ? (
                  <span className="stu-badge" data-tone="ok">
                    SUENA
                  </span>
                ) : (
                  <button type="button" className="stu-btn" data-size="small" disabled={recording} onClick={() => controller.activateTake(take.id)}>
                    USAR
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!clip.active && takes.length < 2 && (
          <button type="button" className="stu-btn" disabled={recording} onClick={() => controller.activateTake(clip.id)}>
            ENCENDER ESTE CLIP
          </button>
        )}
      </div>

      <div className="stu-actions">
        <button type="button" className="stu-btn" disabled={recording} onClick={() => controller.splitAtPlayhead()} title="Dividir en el cabezal (S)">
          <Scissors size={13} />
          DIVIDIR
        </button>
        <button type="button" className="stu-btn" disabled={recording} onClick={() => controller.duplicateSelected()} title="Duplicar (Ctrl+D)">
          <Copy size={13} />
          DUPLICAR
        </button>
        <button type="button" className="stu-btn" data-tone="danger" disabled={recording} onClick={() => controller.deleteSelected()} title="Borrar el clip (Supr). Se puede deshacer.">
          <Trash2 size={13} />
          BORRAR
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Clip MIDI elegido
// ---------------------------------------------------------------------------

const LOOP_BAR_OPTIONS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8, 16]

const MidiClipSection: React.FC<{ controller: StudioController; session: StudioSession; clipId: string; recording: boolean }> = ({ controller, session, clipId, recording }) => {
  const loc = findMidiClip(session, clipId)
  if (!loc) return null
  const { clip, track } = loc
  const bpb = session.beatsPerBar
  const bars = (beats: number) => {
    const value = beats / bpb
    return Number.isInteger(value) ? String(value) : value.toFixed(2)
  }
  const loopOptions = LOOP_BAR_OPTIONS.map((b) => b * bpb).filter((beats) => beats <= clip.lengthBeats + 1e-9)
  if (!loopOptions.some((beats) => Math.abs(beats - clip.loopBeats) < 1e-6)) loopOptions.push(clip.loopBeats)
  loopOptions.sort((a, b) => a - b)

  const commitNumber = (raw: string, input: HTMLInputElement, current: number, apply: (value: number) => void) => {
    const value = Number(raw.replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) {
      input.value = bars(current)
      return
    }
    apply(value)
  }

  const exportClip = () => {
    const file = controller.exportMidiClip(clip.id)
    if (file) downloadBlob(file.blob, file.name)
  }

  return (
    <section className="stu-section" aria-label="Clip MIDI elegido" data-testid="studio-inspector-midi-clip">
      <div className="stu-param-head">
        <span className="stu-label">Clip MIDI</span>
        <span className="stu-badge" data-tone="sel">
          {clip.notes.length} NOTAS
        </span>
      </div>
      <strong className="stu-inspector-title">{track.name}</strong>
      <dl className="stu-kv">
        <dt>Compás</dt>
        <dd>{formatBarBeat(clip.startBeat, bpb)}</dd>
        <dt>Largo</dt>
        <dd>
          {bars(clip.lengthBeats)} compases ({clip.lengthBeats} tiempos)
        </dd>
        <dt>Repetición</dt>
        <dd>{clip.loop ? `cada ${bars(clip.loopBeats)} compases` : 'no'}</dd>
      </dl>
      <div className="stu-inst-pick">
        <label className="stu-param">
          <span className="stu-label">Compás de inicio</span>
          <input
            key={`midi-start-${clip.id}-${clip.startBeat}`}
            type="number"
            className="stu-field"
            min={1}
            step={1}
            defaultValue={bars(clip.startBeat + bpb)}
            disabled={recording}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            onBlur={(event) =>
              commitNumber(event.target.value, event.target, clip.startBeat + bpb, (bar) => {
                const startBeat = Math.max(0, (bar - 1) * bpb)
                if (Math.abs(startBeat - clip.startBeat) > 1e-6) controller.run('Mover clip MIDI', (current) => moveMidiClip(current, { clipId: clip.id, startBeat }))
              })
            }
            data-testid="studio-midi-clip-start"
          />
        </label>
        <label className="stu-param">
          <span className="stu-label">Largo (compases)</span>
          <input
            key={`midi-len-${clip.id}-${clip.lengthBeats}`}
            type="number"
            className="stu-field"
            min={0.25}
            step={0.25}
            defaultValue={bars(clip.lengthBeats)}
            disabled={recording}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            onBlur={(event) =>
              commitNumber(event.target.value, event.target, clip.lengthBeats, (value) => {
                const toBeat = clip.startBeat + value * bpb
                if (Math.abs(value * bpb - clip.lengthBeats) > 1e-6) controller.run('Recortar clip MIDI', (current) => resizeMidiClip(current, { clipId: clip.id, edge: 'end', toBeat }))
              })
            }
            data-testid="studio-midi-clip-length"
          />
        </label>
      </div>
      <div className="stu-inst-pick">
        <label className="stu-check">
          <input
            type="checkbox"
            checked={clip.loop}
            disabled={recording}
            onChange={(event) => controller.run(event.target.checked ? 'Repetir clip MIDI' : 'Quitar repetición', (current) => updateMidiClip(current, { clipId: clip.id, patch: { loop: event.target.checked } }))}
            data-testid="studio-midi-clip-loop"
          />
          <span>Repetir el patrón</span>
        </label>
        <label className="stu-param">
          <span className="stu-label">Patrón (compases)</span>
          <select
            className="stu-field"
            value={String(clip.loopBeats)}
            disabled={recording || !clip.loop}
            onChange={(event) => controller.run('Largo del patrón', (current) => updateMidiClip(current, { clipId: clip.id, patch: { loopBeats: Number(event.target.value) } }))}
            data-testid="studio-midi-clip-loop-beats"
          >
            {loopOptions.map((beats) => (
              <option key={beats} value={String(beats)}>
                {bars(beats)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="stu-actions">
        <button type="button" className="stu-btn" data-tone="primary" onClick={() => controller.openPianoRoll(clip.id)} title="Abrir en el piano roll (doble clic en el clip o E)" data-testid="studio-midi-clip-open">
          <Piano size={13} />
          PIANO ROLL
        </button>
        <button type="button" className="stu-btn" disabled={recording} onClick={() => controller.splitAtPlayhead()} title="Dividir en el cabezal (S)">
          <Scissors size={13} />
          DIVIDIR
        </button>
        <button type="button" className="stu-btn" disabled={recording} onClick={() => controller.duplicateSelected()} title="Duplicar (Ctrl+D)">
          <Copy size={13} />
          DUPLICAR
        </button>
        <button type="button" className="stu-btn" data-size="icon" disabled={clip.notes.length === 0} onClick={exportClip} aria-label="Exportar el clip a un archivo MIDI" title="Exportar a .mid">
          <Download size={13} />
        </button>
        <button type="button" className="stu-btn" data-tone="danger" data-size="icon" disabled={recording} onClick={() => controller.deleteSelected()} aria-label="Borrar el clip MIDI" title="Borrar el clip (Supr). Se puede deshacer.">
          <Trash2 size={13} />
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Efecto elegido
// ---------------------------------------------------------------------------

const FxSection: React.FC<{ controller: StudioController; session: StudioSession; selection: StudioFxSelection }> = ({ controller, session, selection }) => {
  const { targetId, type } = selection
  const onMaster = targetId === STUDIO_MASTER_ID
  const targetName = onMaster ? 'Master' : (findTrack(session, targetId)?.name ?? 'Pista')
  const fx = fxChainOf(session, targetId).find((item) => item.type === type) ?? null
  const specs = STUDIO_FX_PARAM_SPECS[type]
  const values = fx ? (fx.params as unknown as Record<string, number>) : null

  const setParam = (key: string, value: number) =>
    live(controller, (current) => {
      const present = fxChainOf(current, targetId).find((item) => item.type === type)
      if (!present) return current
      return withFx(current, targetId, { ...present, params: { ...present.params, [key]: value } } as StudioFx)
    })

  return (
    <section className="stu-section" aria-label="Efecto elegido" data-testid="studio-inspector-fx">
      <span className="stu-label">Efecto</span>
      <div className="stu-fx-pick">
        <select
          className="stu-field"
          value={targetId}
          onChange={(event) => {
            const next = event.target.value
            controller.selectFx({ targetId: next, type: next !== STUDIO_MASTER_ID && type === 'limiter' ? 'eq' : type })
          }}
          aria-label="Pista del efecto"
          data-testid="studio-fx-target"
        >
          {session.tracks.map((track) => (
            <option key={track.id} value={track.id}>
              {track.name}
            </option>
          ))}
          <option value={STUDIO_MASTER_ID}>Master</option>
        </select>
        <div className="stu-seg" role="group" aria-label="Tipo de efecto">
          {FX_TYPES_UI.map((item) => {
            const blocked = item === 'limiter' && !onMaster
            return (
              <button
                key={item}
                type="button"
                className="stu-btn"
                data-on={item === type}
                aria-pressed={item === type}
                disabled={blocked}
                title={blocked ? 'El limitador solo va en el master' : undefined}
                onClick={() => controller.selectFx({ targetId, type: item })}
                data-testid={`studio-fx-type-${item}`}
              >
                {item === 'eq' ? 'EQ' : item === 'compressor' ? 'COMP' : 'LIM'}
              </button>
            )
          })}
        </div>
      </div>

      {!fx || !values ? (
        <>
          <p className="stu-help">
            {targetName} no tiene {FX_NAMES[type]}.{type === 'limiter' ? ' Sin limitador, la mezcla puede pasar de 0 dB al exportar.' : ''}
          </p>
          <button type="button" className="stu-btn" onClick={() => controller.run(`Agregar ${FX_NAMES[type]}`, (current) => withFx(current, targetId, defaultFx(type)))} data-testid="studio-fx-add">
            AGREGAR {FX_LABELS[type]}
          </button>
        </>
      ) : (
        <>
          <div className="stu-actions">
            <button
              type="button"
              className="stu-btn"
              data-on={!fx.bypass}
              data-accent="play"
              aria-pressed={!fx.bypass}
              onClick={() => controller.run(fx.bypass ? `Activar ${FX_NAMES[type]}` : `Bypass de ${FX_NAMES[type]}`, (current) => withFx(current, targetId, { ...fx, bypass: !fx.bypass } as StudioFx))}
              title="Bypass: deja pasar el audio sin procesar, conservando los ajustes"
              data-testid="studio-fx-bypass"
            >
              <Power size={13} />
              {fx.bypass ? 'EN BYPASS' : 'ACTIVO'}
            </button>
            <button
              type="button"
              className="stu-btn"
              data-tone="ghost"
              onClick={() => controller.run(`Restablecer ${FX_NAMES[type]}`, (current) => withFx(current, targetId, { ...defaultFx(type), bypass: fx.bypass } as StudioFx))}
              title="Volver a los valores por defecto"
            >
              <RotateCcw size={13} />
              RESTABLECER
            </button>
            <button type="button" className="stu-btn" data-tone="danger" data-size="icon" onClick={() => controller.run(`Quitar ${FX_NAMES[type]}`, (current) => withoutFx(current, targetId, type))} aria-label={`Quitar ${FX_NAMES[type]} de ${targetName}`} title="Quitar el efecto">
              <Trash2 size={13} />
            </button>
          </div>
          {fx.type === 'eq' && <StudioEqCurve params={fx.params} sampleRate={session.sampleRate} bypass={fx.bypass} detailed />}
          {type === 'limiter' && <p className="stu-help">Va de último en el master, después del volumen. Con anticipación de 5 ms: el pico real no pasa del techo.</p>}
          {specs.map((spec) => {
            const ui = PARAM_UI[type][spec.key]
            if (!ui) return null
            return (
              <ParamSlider
                key={spec.key}
                label={ui.label}
                value={values[spec.key] ?? spec.def}
                min={spec.min}
                max={spec.max}
                step={ui.step}
                log={ui.log}
                format={ui.format}
                resetTo={spec.def}
                onLive={(value) => setParam(spec.key, value)}
                onCommit={() => controller.commitLive(`${ui.label} (${FX_NAMES[type]})`)}
                testId={`studio-fx-${spec.key}`}
              />
            )
          })}
        </>
      )}
    </section>
  )
}

/**
 * Inspector del Estudio: el clip elegido (audio: ganancia, fades, posicion, toma; MIDI: posicion,
 * largo, repeticion y piano roll), el instrumento de la pista de instrumento elegida, la entrada
 * MIDI (si la sesion tiene pistas de instrumento) y el efecto elegido de una pista o del master
 * (parametros y bypass). Los arrastres cambian el motor en caliente y dejan un solo paso de
 * deshacer al soltar.
 */
export const StudioInspector: React.FC<StudioPanelProps> = ({ controller }) => {
  const snap = useStudio(controller)
  const { session } = snap
  const picked = snap.selectedFx
  const pickedValid = picked !== null && (picked.targetId === STUDIO_MASTER_ID || findTrack(session, picked.targetId) !== null)
  const midiLoc = snap.selectedClipId ? findMidiClip(session, snap.selectedClipId) : null
  const clipTrackId = snap.selectedClipId ? (findClip(session, snap.selectedClipId)?.track.id ?? midiLoc?.track.id ?? null) : null
  const selection: StudioFxSelection = pickedValid && picked ? picked : { targetId: clipTrackId ?? snap.selectedTrackId ?? session.tracks[0]?.id ?? STUDIO_MASTER_ID, type: 'eq' }
  const instrumentTrackId = (() => {
    const id = midiLoc?.track.id ?? snap.selectedTrackId
    return id && findTrack(session, id)?.kind === 'instrument' ? id : null
  })()
  const hasInstrumentTracks = session.tracks.some((track) => track.kind === 'instrument')

  return (
    <>
      {midiLoc ? (
        <MidiClipSection controller={controller} session={session} clipId={midiLoc.clip.id} recording={snap.recording} />
      ) : (
        <ClipSection controller={controller} session={session} clipId={snap.selectedClipId} recording={snap.recording} />
      )}
      {instrumentTrackId && <StudioInstrumentPanel controller={controller} trackId={instrumentTrackId} />}
      {hasInstrumentTracks && <StudioMidiDevicePanel controller={controller} />}
      <FxSection controller={controller} session={session} selection={selection} />
    </>
  )
}
