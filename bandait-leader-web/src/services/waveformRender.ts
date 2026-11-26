/**
 * Dibujo de formas de onda segun las preferencias del musico (`waveform.ts`). Lo usa la linea de
 * tiempo del Estudio para los clips de audio y lo puede usar cualquier otra vista (la vista
 * previa de APARIENCIA, una lista de stems): recibe columnas ya calculadas (una por pixel) y un
 * contexto 2D, sin saber de clips, sesiones ni React.
 *
 * Modulo puro: sin DOM (el contexto llega inyectado; en las pruebas es un objeto que graba las
 * llamadas). Se prueba en `scripts/verify-waveform-logic.ts`. No asigna memoria por cuadro: el
 * pintado de la linea de tiempo lo llama en cada repintado.
 */
import { waveformHeight, type WaveformColor, type WaveformPreferences } from './waveform.ts'

/** Lo que el dibujo usa de un CanvasRenderingContext2D. */
export interface WaveformContext {
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  closePath(): void
  fill(): void
  stroke(): void
  fillRect(x: number, y: number, w: number, h: number): void
  rect(x: number, y: number, w: number, h: number): void
  roundRect?: (x: number, y: number, w: number, h: number, radii?: number) => void
}

export interface WaveformInput {
  /** Minimo por columna, -1..1. */
  min: ArrayLike<number>
  /** Maximo por columna, -1..1. */
  max: ArrayLike<number>
  /** RMS por columna, 0..1, o null si los picos todavia no lo traen (se usa el pico). */
  rms: ArrayLike<number> | null
  /** Columnas a dibujar (<= largo de los arreglos). */
  count: number
  /** x en px de la columna 0. */
  x: number
  /** Banda vertical donde va la forma de onda (el alto del clip). */
  top: number
  height: number
  /**
   * Donde empieza la rejilla de barras (el borde izquierdo del clip): asi las barras se mueven
   * con el clip y no "nadan" al desplazar la vista. Por defecto, `x`.
   */
  barOrigin?: number
  /** Factor de amplitud por columna (ganancia del clip y fundidos). Por defecto 1. */
  factor?: (column: number) => number
}

export interface WaveformColors {
  /** Capa principal (pico solo, RMS solo, o el RMS en "peak-rms"). */
  solid: string
  /** Capa de fondo de "peak-rms" (el pico, translucido). */
  translucent: string
}

/** Margen que la forma de onda deja arriba y abajo dentro de su banda (el de siempre). */
export const WAVEFORM_PAD_PX = 3

const NO_FACTOR = () => 1

/** Altura con signo: el pico de una columna puede quedar del otro lado del centro. */
function signedHeight(value: number, prefs: WaveformPreferences): number {
  const h = waveformHeight(value, prefs.scale, prefs.gain)
  return value < 0 ? -h : h
}

type Layer = 'peak' | 'rms'

/** Capas en orden de pintado con su color. Sin RMS en los datos, la capa RMS cae al pico. */
export function waveformLayers(prefs: Pick<WaveformPreferences, 'data'>, hasRms: boolean, colors: WaveformColors): Array<{ layer: Layer; color: string }> {
  if (prefs.data === 'rms') return [{ layer: hasRms ? 'rms' : 'peak', color: colors.solid }]
  if (prefs.data === 'peak-rms' && hasRms) return [
    { layer: 'peak', color: colors.translucent },
    { layer: 'rms', color: colors.solid },
  ]
  return [{ layer: 'peak', color: colors.solid }]
}

/** Primera columna y fin (exclusivo) de cada barra que toca [x, x + count). */
export function barColumns(x: number, count: number, origin: number, barWidth: number, barGap: number, visit: (barX: number, c0: number, c1: number) => void): void {
  const width = Math.max(1, barWidth)
  const step = width + Math.max(0, barGap)
  let k = Math.floor((x - origin) / step)
  for (;;) {
    const barX = origin + k * step
    if (barX >= x + count) break
    const c0 = Math.max(0, Math.ceil(barX - x))
    const c1 = Math.min(count, Math.ceil(barX + width - x))
    if (c1 > c0) visit(barX, c0, c1)
    k++
  }
}

function fillBox(ctx: WaveformContext, x: number, y: number, w: number, h: number): void {
  const r = Math.min(w / 2, h / 2)
  if (typeof ctx.roundRect === 'function' && r >= 0.5) ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
}

function drawBars(ctx: WaveformContext, input: WaveformInput, prefs: WaveformPreferences, layer: Layer): void {
  const { min, max, rms, count, x, top, height } = input
  const factor = input.factor ?? NO_FACTOR
  const mirrored = prefs.layout === 'mirrored'
  const mid = top + height / 2
  const half = Math.max(1, height / 2 - WAVEFORM_PAD_PX)
  const base = top + height - WAVEFORM_PAD_PX
  const full = Math.max(1, height - 2 * WAVEFORM_PAD_PX)
  ctx.beginPath()
  barColumns(x, count, input.barOrigin ?? x, prefs.barWidth, prefs.barGap, (barX, c0, c1) => {
    let up = 0
    let down = 0
    if (layer === 'rms' && rms) {
      let squares = 0
      for (let c = c0; c < c1; c++) {
        const v = rms[c] * factor(c)
        squares += v * v
      }
      up = waveformHeight(Math.sqrt(squares / (c1 - c0)), prefs.scale, prefs.gain)
      down = up
    } else {
      for (let c = c0; c < c1; c++) {
        const f = factor(c)
        if (mirrored) {
          const u = waveformHeight(Math.max(0, max[c] * f), prefs.scale, prefs.gain)
          const d = waveformHeight(Math.max(0, -min[c] * f), prefs.scale, prefs.gain)
          if (u > up) up = u
          if (d > down) down = d
        } else {
          const a = waveformHeight(Math.max(Math.abs(max[c]), Math.abs(min[c])) * f, prefs.scale, prefs.gain)
          if (a > up) up = a
        }
      }
    }
    const w = Math.max(1, prefs.barWidth)
    if (mirrored) {
      const y0 = mid - up * half
      const h = Math.max(1, (up + down) * half)
      fillBox(ctx, barX, up + down > 0 ? y0 : mid - 0.5, w, h)
    } else {
      const h = Math.max(1, up * full)
      fillBox(ctx, barX, base - h, w, h)
    }
  })
  ctx.fill()
}

/** Borde superior (y el inferior en espejo) de una capa, como polilinea o poligono. */
function drawContinuous(ctx: WaveformContext, input: WaveformInput, prefs: WaveformPreferences, layer: Layer, filled: boolean): void {
  const { min, max, rms, count, x, top, height } = input
  const factor = input.factor ?? NO_FACTOR
  const mirrored = prefs.layout === 'mirrored'
  const mid = top + height / 2
  const half = Math.max(1, height / 2 - WAVEFORM_PAD_PX)
  const base = top + height - WAVEFORM_PAD_PX
  const full = Math.max(1, height - 2 * WAVEFORM_PAD_PX)
  const useRms = layer === 'rms' && rms !== null

  const upper = (i: number): number => {
    const f = factor(i)
    if (mirrored) return mid - (useRms ? waveformHeight(rms![i] * f, prefs.scale, prefs.gain) : signedHeight(max[i] * f, prefs)) * half
    const a = useRms ? rms![i] * f : Math.max(Math.abs(max[i]), Math.abs(min[i])) * f
    return base - waveformHeight(a, prefs.scale, prefs.gain) * full
  }
  const lower = (i: number): number => {
    const f = factor(i)
    return mid - (useRms ? -waveformHeight(rms![i] * f, prefs.scale, prefs.gain) : signedHeight(min[i] * f, prefs)) * half
  }

  ctx.beginPath()
  if (filled) {
    if (!mirrored) ctx.moveTo(x, base)
    for (let i = 0; i < count; i++) {
      if (i === 0 && mirrored) ctx.moveTo(x, upper(0))
      else ctx.lineTo(x + i, upper(i))
    }
    if (mirrored) {
      for (let i = count - 1; i >= 0; i--) ctx.lineTo(x + i, lower(i))
    } else {
      ctx.lineTo(x + count - 1, base)
    }
    ctx.closePath()
    ctx.fill()
    return
  }
  for (let i = 0; i < count; i++) {
    if (i === 0) ctx.moveTo(x, upper(0))
    else ctx.lineTo(x + i, upper(i))
  }
  if (mirrored) {
    for (let i = 0; i < count; i++) {
      if (i === 0) ctx.moveTo(x, lower(0))
      else ctx.lineTo(x + i, lower(i))
    }
  }
  ctx.stroke()
}

/**
 * Dibuja una forma de onda en `ctx` con el estilo, el armado, los datos, la escala y el zoom de
 * `prefs`, y los colores ya resueltos (`resolveWaveformColors`). Deja fillStyle, strokeStyle y
 * lineWidth cambiados: quien llama los vuelve a poner si los necesita.
 */
export function drawWaveform(ctx: WaveformContext, input: WaveformInput, prefs: WaveformPreferences, colors: WaveformColors): void {
  const count = Math.floor(Math.min(input.count, input.min.length, input.max.length))
  if (count < 1 || !(input.height > 0)) return
  const rms = input.rms && input.rms.length >= count ? input.rms : null
  const sized: WaveformInput = count === input.count && rms === input.rms ? input : { ...input, count, rms }
  for (const { layer, color } of waveformLayers(prefs, rms !== null, colors)) {
    if (prefs.style === 'bars') {
      ctx.fillStyle = color
      drawBars(ctx, sized, prefs, layer)
    } else if (prefs.style === 'line') {
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      drawContinuous(ctx, sized, prefs, layer, false)
    } else {
      ctx.fillStyle = color
      drawContinuous(ctx, sized, prefs, layer, true)
    }
  }
  // Linea del centro (la de siempre) en espejo con relleno o contorno.
  if (prefs.layout === 'mirrored' && prefs.style !== 'bars') {
    ctx.fillStyle = colors.solid
    ctx.fillRect(input.x, input.top + input.height / 2 - 0.5, count, 1)
  }
}

// ---------------------------------------------------------------------------
// Colores
// ---------------------------------------------------------------------------

const alphaCache = new Map<string, string>()

/** '#RRGGBB' + alfa -> 'rgba(...)' (cacheado). Otro formato se devuelve tal cual. */
export function waveformAlpha(color: string, alpha: number): string {
  const key = `${color}/${alpha}`
  const cached = alphaCache.get(key)
  if (cached) return cached
  const m = /^#([0-9a-f]{6})$/i.exec(color)
  if (!m) return color
  const n = Number.parseInt(m[1], 16)
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000
  const value = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  if (alphaCache.size > 512) alphaCache.clear()
  alphaCache.set(key, value)
  return value
}

/** Fraccion de la opacidad de la capa solida que lleva el pico translucido en "peak-rms". */
export const WAVEFORM_TRANSLUCENT_RATIO = 0.4

/**
 * Colores de una forma de onda: la fuente segun `color` (pista, acento o neutro) y la opacidad
 * de quien dibuja (un clip activo 0,9; una toma inactiva 0,45). En neutro se baja un poco: el
 * texto del tema es el color de mas contraste.
 */
export function resolveWaveformColors(color: WaveformColor, sources: { track: string; accent: string; neutral: string }, alpha: number): WaveformColors {
  const base = color === 'accent' ? sources.accent : color === 'neutral' ? sources.neutral : sources.track
  const a = color === 'neutral' ? alpha * 0.78 : alpha
  return { solid: waveformAlpha(base, a), translucent: waveformAlpha(base, a * WAVEFORM_TRANSLUCENT_RATIO) }
}
