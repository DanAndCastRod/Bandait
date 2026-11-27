import React, { useEffect, useRef, useState } from 'react'
import { Activity, Grid, Radio, Waves } from 'lucide-react'
import {
  barkBandEnergiesDb,
  downmixMono,
  fftRadix2,
  hannWindow,
  lissajousPoints,
  pearsonPhaseCorrelation,
} from '../../services/studio/dspMath'
import { STUDIO_MASTER_ID, findTrack } from '../../services/studio/session'
import type { StudioCanvasPalette } from '../../services/studioCanvasPalette'
import { useStudio, type StudioPanelProps } from './studioState'
import { useStudioCanvasPalette } from './useStudioCanvasPalette'

type AnalyzerMode = 'fft' | 'waterfall' | 'lissajous' | 'bark'

const FFT_N = 1024
const WATERFALL_COLS = 64
const WATERFALL_ROWS = 40

function drawFftView(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  peakHoldDb: Float32Array,
  pal: StudioCanvasPalette,
): void {
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, w, h)

  // Rejilla logaritmica (100 Hz, 1 kHz, 10 kHz) y niveles (-12, -24, -48 dB).
  const minHz = 25
  const maxHz = Math.min(20000, sampleRate * 0.48)
  const xOfHz = (hz: number) => (Math.log(hz / minHz) / Math.log(maxHz / minHz)) * w
  const yOfDb = (db: number) => {
    const clamped = Math.max(-72, Math.min(0, db))
    return ((0 - clamped) / 72) * (h - 14 * dpr) + 4 * dpr
  }

  ctx.strokeStyle = pal.eqGrid
  ctx.lineWidth = Math.max(1, dpr)
  ctx.beginPath()
  for (const hz of [100, 1000, 10000]) {
    const x = Math.round(xOfHz(hz)) + 0.5
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
  }
  for (const db of [-12, -36, -60]) {
    const y = Math.round(yOfDb(db)) + 0.5
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()

  if (left.length >= 64) {
    const mono = downmixMono([left, right])
    const win = hannWindow(FFT_N)
    const re = new Float64Array(FFT_N)
    const im = new Float64Array(FFT_N)
    const copy = Math.min(FFT_N, mono.length)
    const offset = mono.length - copy
    for (let i = 0; i < copy; i++) re[i] = mono[offset + i] * win[i]
    fftRadix2(re, im, false)

    const bins = FFT_N >> 1
    const norm = 2 / FFT_N
    ctx.beginPath()
    let started = false
    for (let k = 1; k < bins; k++) {
      const hz = (k * sampleRate) / FFT_N
      if (hz < minHz || hz > maxHz) continue
      const mag = Math.hypot(re[k], im[k]) * norm
      const db = mag > 1e-6 ? 20 * Math.log10(mag) : -72
      if (db > peakHoldDb[k]) peakHoldDb[k] = db
      else peakHoldDb[k] = Math.max(-72, peakHoldDb[k] - 0.35)
      const x = xOfHz(hz)
      const y = yOfDb(db)
      if (!started) {
        ctx.moveTo(x, y)
        started = true
      } else {
        ctx.lineTo(x, y)
      }
    }
    if (started) {
      ctx.strokeStyle = pal.accent
      ctx.lineWidth = Math.max(1.5, 1.5 * dpr)
      ctx.stroke()
      ctx.lineTo(w, h)
      ctx.lineTo(0, h)
      ctx.closePath()
      ctx.fillStyle = pal.eqCurveFill
      ctx.fill()
    }

    // Trazo de retencion de picos (peak hold).
    ctx.beginPath()
    let holdStarted = false
    for (let k = 1; k < bins; k++) {
      const hz = (k * sampleRate) / FFT_N
      if (hz < minHz || hz > maxHz) continue
      const x = xOfHz(hz)
      const y = yOfDb(peakHoldDb[k])
      if (!holdStarted) {
        ctx.moveTo(x, y)
        holdStarted = true
      } else {
        ctx.lineTo(x, y)
      }
    }
    if (holdStarted) {
      ctx.strokeStyle = pal.meterHold
      ctx.lineWidth = Math.max(1, dpr)
      ctx.stroke()
    }
  }

  ctx.fillStyle = pal.eqLabel
  ctx.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`
  ctx.textBaseline = 'bottom'
  ctx.fillText('100', xOfHz(100) + 2 * dpr, h - 2 * dpr)
  ctx.fillText('1k', xOfHz(1000) + 2 * dpr, h - 2 * dpr)
  ctx.fillText('10k', xOfHz(10000) + 2 * dpr, h - 2 * dpr)
}

function drawWaterfallView(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  history: Float32Array[],
  pal: StudioCanvasPalette,
): void {
  if (left.length >= 64) {
    const mono = downmixMono([left, right])
    const win = hannWindow(FFT_N)
    const re = new Float64Array(FFT_N)
    const im = new Float64Array(FFT_N)
    const copy = Math.min(FFT_N, mono.length)
    const offset = mono.length - copy
    for (let i = 0; i < copy; i++) re[i] = mono[offset + i] * win[i]
    fftRadix2(re, im, false)

    const row = new Float32Array(WATERFALL_COLS)
    const minHz = 30
    const maxHz = Math.min(18000, sampleRate * 0.48)
    const norm = 2 / FFT_N
    for (let c = 0; c < WATERFALL_COLS; c++) {
      const f0 = minHz * Math.pow(maxHz / minHz, c / WATERFALL_COLS)
      const f1 = minHz * Math.pow(maxHz / minHz, (c + 1) / WATERFALL_COLS)
      const k0 = Math.max(1, Math.floor((f0 * FFT_N) / sampleRate))
      const k1 = Math.max(k0, Math.min((FFT_N >> 1) - 1, Math.ceil((f1 * FFT_N) / sampleRate)))
      let peak = 0
      for (let k = k0; k <= k1; k++) {
        const mag = Math.hypot(re[k], im[k]) * norm
        if (mag > peak) peak = mag
      }
      const db = peak > 1e-6 ? 20 * Math.log10(peak) : -72
      row[c] = Math.max(0, Math.min(1, (db + 72) / 72))
    }
    history.unshift(row)
    if (history.length > WATERFALL_ROWS) history.pop()
  }

  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, w, h)
  const cellW = w / WATERFALL_COLS
  const cellH = h / WATERFALL_ROWS

  for (let r = 0; r < history.length; r++) {
    const row = history[r]
    const y = r * cellH
    for (let c = 0; c < WATERFALL_COLS; c++) {
      const u = row[c]
      if (u < 0.08) continue
      if (u > 0.85) ctx.fillStyle = pal.meterOver
      else if (u > 0.65) ctx.fillStyle = pal.meterHot
      else if (u > 0.35) ctx.fillStyle = pal.meterOk
      else ctx.fillStyle = pal.meterOkDim
      ctx.fillRect(c * cellW, y, Math.ceil(cellW), Math.ceil(cellH))
    }
  }
}

function drawLissajousView(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  left: Float32Array,
  right: Float32Array,
  pal: StudioCanvasPalette,
): void {
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, w, h)

  const cx = w / 2
  const cy = h / 2
  const radius = Math.min(w, h) * 0.43

  ctx.strokeStyle = pal.eqGrid
  ctx.lineWidth = Math.max(1, dpr)
  ctx.beginPath()
  ctx.arc(cx, cy, radius, 0, Math.PI * 2)
  ctx.moveTo(cx, cy - radius)
  ctx.lineTo(cx, cy + radius)
  ctx.moveTo(cx - radius, cy)
  ctx.lineTo(cx + radius, cy)
  // Diagonales L y R
  const diag = radius * Math.SQRT1_2
  ctx.moveTo(cx - diag, cy - diag)
  ctx.lineTo(cx + diag, cy + diag)
  ctx.moveTo(cx + diag, cy - diag)
  ctx.lineTo(cx - diag, cy + diag)
  ctx.stroke()

  if (left.length > 0 && right.length > 0) {
    const pts = lissajousPoints(left, right, 256)
    ctx.fillStyle = pal.accent
    const dot = Math.max(1.5, 1.5 * dpr)
    for (const pt of pts) {
      const x = cx + pt.x * radius
      const y = cy - pt.y * radius
      ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot)
    }
  }

  ctx.fillStyle = pal.eqLabel
  ctx.font = `${Math.round(9 * dpr)}px ui-monospace, monospace`
  ctx.textBaseline = 'top'
  ctx.fillText('M', cx + 3 * dpr, 3 * dpr)
  ctx.fillText('L', cx - diag - 10 * dpr, cy - diag)
  ctx.fillText('R', cx + diag + 3 * dpr, cy - diag)
}

function drawBarkView(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  dpr: number,
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  matrix: number[][] | null,
  labels: readonly string[],
  pal: StudioCanvasPalette,
): void {
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, w, h)

  if (matrix && matrix.length >= 2) {
    const n = matrix.length
    const padL = 44 * dpr
    const padT = 6 * dpr
    const gridW = Math.max(20, w - padL - 6 * dpr)
    const gridH = Math.max(20, h - padT - 6 * dpr)
    const cw = gridW / n
    const ch = gridH / n
    let maxV = 1e-6
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j && matrix[i][j] > maxV) maxV = matrix[i][j]
      }
    }

    ctx.font = `${Math.round(8.5 * dpr)}px ui-monospace, monospace`
    ctx.textBaseline = 'middle'
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = pal.eqLabel
      ctx.fillText((labels[i] ?? `P${i + 1}`).slice(0, 6), 3 * dpr, padT + (i + 0.5) * ch)
      for (let j = 0; j < n; j++) {
        const u = i === j ? 0 : matrix[i][j] / maxV
        if (i === j) ctx.fillStyle = pal.lane
        else if (u > 0.7) ctx.fillStyle = pal.meterOver
        else if (u > 0.4) ctx.fillStyle = pal.meterHot
        else if (u > 0.15) ctx.fillStyle = pal.meterOkDim
        else ctx.fillStyle = pal.laneAlt
        ctx.fillRect(padL + j * cw + 1, padT + i * ch + 1, Math.max(1, cw - 2), Math.max(1, ch - 2))
      }
    }
    return
  }

  // Sin matriz NxN calculada aun: mostrar las 24 bandas criticas Bark en tiempo real.
  const mono = downmixMono([left, right])
  const barkDb = mono.length >= 128 ? barkBandEnergiesDb(mono, sampleRate, 1024) : new Float32Array(24).fill(-90)
  const barW = w / 24
  for (let b = 0; b < 24; b++) {
    const norm = Math.max(0, Math.min(1, (barkDb[b] + 72) / 72))
    const bh = norm * (h - 14 * dpr)
    ctx.fillStyle = norm > 0.8 ? pal.meterHot : pal.meterOk
    ctx.fillRect(b * barW + 1, h - 12 * dpr - bh, Math.max(1, barW - 2), bh)
  }
  ctx.fillStyle = pal.eqLabel
  ctx.font = `${Math.round(8.5 * dpr)}px ui-monospace, monospace`
  ctx.textBaseline = 'bottom'
  ctx.fillText('24 Bandas Críticas Bark (1..24)', 4 * dpr, h - 2 * dpr)
}

/**
 * Laboratorio Cientifico de Audio (`LAB`):
 *   - Espectro FFT Radix-2 con retencion de picos
 *   - Cascada espectral (una FFT por cuadro de pantalla apilada en el tiempo; el salto depende de
 *     la tasa de cuadros, por eso no se anuncia como STFT)
 *   - Goniometro Lissajous Mid/Side + Correlador de Fase de Pearson r in [-1, +1]
 *   - Matriz psicoacustica de colision en 24 bandas Bark
 *
 * Cumple regla estricta de apariencia: 0 literales hexadecimales, todo via `useStudioCanvasPalette`.
 */
export const StudioAnalyzer: React.FC<StudioPanelProps> = ({ controller }) => {
  const snap = useStudio(controller)
  const palette = useStudioCanvasPalette()
  const [mode, setMode] = useState<AnalyzerMode>('fft')
  const [target, setTarget] = useState<'master' | 'track'>('master')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const corrRef = useRef<HTMLSpanElement>(null)
  const peakHoldRef = useRef<Float32Array>(new Float32Array(FFT_N >> 1).fill(-72))
  const waterfallRef = useRef<Float32Array[]>([])

  const selectedTrack = snap.selectedTrackId ? findTrack(snap.session, snap.selectedTrackId) : null

  useEffect(() => {
    if (!snap.labMode) return
    return controller.onFrame(() => {
      const canvas = canvasRef.current
      if (!canvas) return
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

      const stereo =
        target === 'track' && snap.selectedTrackId && snap.selectedTrackId !== STUDIO_MASTER_ID
          ? controller.engine.readTrackStereo(snap.selectedTrackId)
          : controller.engine.readMasterStereo()

      const left = stereo?.left ?? new Float32Array(0)
      const right = stereo?.right ?? new Float32Array(0)
      const sr = stereo?.sampleRate ?? snap.session.sampleRate

      if (corrRef.current) {
        const corr = left.length > 0 ? pearsonPhaseCorrelation(left, right) : 1
        const txt = `${corr >= 0 ? '+' : ''}${corr.toFixed(2)}`
        if (corrRef.current.textContent !== txt) {
          corrRef.current.textContent = txt
          corrRef.current.dataset.phaseWarn = corr < 0 ? 'true' : 'false'
        }
      }

      if (mode === 'fft') {
        drawFftView(ctx, w, h, dpr, left, right, sr, peakHoldRef.current, palette)
      } else if (mode === 'waterfall') {
        drawWaterfallView(ctx, w, h, left, right, sr, waterfallRef.current, palette)
      } else if (mode === 'lissajous') {
        drawLissajousView(ctx, w, h, dpr, left, right, palette)
      } else {
        const unmask = snap.lastUnmaskResult
        drawBarkView(
          ctx,
          w,
          h,
          dpr,
          left,
          right,
          sr,
          unmask && unmask.matrixAfter.length >= 2 ? unmask.matrixAfter : null,
          unmask?.trackLabels ?? [],
          palette,
        )
      }
    })
  }, [controller, mode, palette, snap.labMode, snap.lastUnmaskResult, snap.selectedTrackId, snap.session.sampleRate, target])

  if (!snap.labMode) return null

  return (
    <section className="stu-section stu-lab-panel" aria-label="Analizador espectral y de fase LAB" data-testid="studio-analyzer-lab">
      <div className="stu-param-head">
        <span className="stu-label">Telemetría DSP (LAB)</span>
        <span className="stu-lab-phase" title="Correlación de fase estéreo de Pearson (-1 cancelación en mono, +1 fase coherente)">
          Fase r: <strong ref={corrRef}>+1.00</strong>
        </span>
      </div>

      <div className="stu-fx-pick">
        <div className="stu-seg" role="group" aria-label="Vista del analizador">
          <button type="button" className="stu-btn" data-size="small" data-on={mode === 'fft'} onClick={() => setMode('fft')} title="Espectro FFT Radix-2">
            <Activity size={12} />
            FFT
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="small"
            data-on={mode === 'waterfall'}
            onClick={() => setMode('waterfall')}
            title="Cascada espectral: una FFT por cuadro de pantalla, apiladas en el tiempo (no es un STFT con salto fijo)"
          >
            <Waves size={12} />
            CASCADA
          </button>
          <button type="button" className="stu-btn" data-size="small" data-on={mode === 'lissajous'} onClick={() => setMode('lissajous')} title="Goniómetro Mid/Side Lissajous">
            <Radio size={12} />
            M/S
          </button>
          <button type="button" className="stu-btn" data-size="small" data-on={mode === 'bark'} onClick={() => setMode('bark')} title="Bandas críticas Bark y matriz de enmascaramiento">
            <Grid size={12} />
            BARK
          </button>
        </div>

        <select
          className="stu-field"
          value={target === 'track' && selectedTrack ? 'track' : 'master'}
          onChange={(e) => setTarget(e.target.value === 'track' ? 'track' : 'master')}
          aria-label="Fuente del analizador"
        >
          <option value="master">Bus Master</option>
          {selectedTrack && <option value="track">Pista: {selectedTrack.name}</option>}
        </select>
      </div>

      <canvas ref={canvasRef} className="stu-analyzer-canvas" aria-hidden="true" />

      {mode === 'bark' && snap.lastUnmaskResult && snap.lastUnmaskResult.topPairs.length > 0 && (
        <div className="stu-lab-pairs">
          <span className="stu-label">
            Reducción de solapamiento estimada por el modelo: -{snap.lastUnmaskResult.reductionPct}%
          </span>
          {snap.lastUnmaskResult.topPairs.slice(0, 3).map((pair) => (
            <div key={`${pair.trackAId}-${pair.trackBId}`} className="stu-help">
              {pair.trackAName} vs {pair.trackBName}: Bark {pair.dominantBarkBand} ({pair.dominantHz} Hz)
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
