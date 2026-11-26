/**
 * Preferencias de la forma de onda (bloque `uiPreferences.waveform`, bandait-protocol/WORKSPACE_V2.md
 * seccion 8). Pedido de Daniel Castaneda (2026-11-26): que el musico elija como se ve la forma de
 * onda de los clips de audio en el Estudio y en cualquier otra vista que la dibuje.
 *
 * Modulo puro: sin React, DOM ni almacenamiento. Lo prueba `scripts/verify-waveform-logic.ts`.
 * El dibujo vive en `waveformRender.ts`; la persistencia, en `appearance.ts` (uiPreferences).
 *
 * Los valores por defecto reproducen el aspecto que tenia el Estudio antes de esta opcion:
 * relleno continuo, en espejo sobre el centro, pico, escala lineal, color de la pista, sin zoom.
 */

export const WAVEFORM_PREFERENCES_VERSION = 1

/** bars: barras redondeadas; filled: relleno continuo; line: solo el contorno. */
export type WaveformStyle = 'bars' | 'filled' | 'line'
/** mirrored: en espejo sobre el centro; bottom: desde la base hacia arriba. */
export type WaveformLayout = 'mirrored' | 'bottom'
/** peak: pico; rms: valor eficaz; peak-rms: dos capas (RMS opaco sobre pico translucido). */
export type WaveformData = 'peak' | 'rms' | 'peak-rms'
/** linear: amplitud; db: logaritmica con piso de WAVEFORM_DB_FLOOR. */
export type WaveformScale = 'linear' | 'db'
/** track: color de la pista; accent: acento del musico; neutral: el texto del tema. */
export type WaveformColor = 'track' | 'accent' | 'neutral'

export interface WaveformPreferences {
  version: number
  style: WaveformStyle
  layout: WaveformLayout
  data: WaveformData
  scale: WaveformScale
  color: WaveformColor
  /** Zoom vertical solo visual (no cambia el audio), de WAVEFORM_GAIN_MIN a WAVEFORM_GAIN_MAX. */
  gain: number
  /** Ancho de cada barra en px (solo `bars`). */
  barWidth: number
  /** Separacion entre barras en px (solo `bars`). */
  barGap: number
}

export const WAVEFORM_STYLES: readonly WaveformStyle[] = ['bars', 'filled', 'line']
export const WAVEFORM_LAYOUTS: readonly WaveformLayout[] = ['mirrored', 'bottom']
export const WAVEFORM_DATA: readonly WaveformData[] = ['peak', 'rms', 'peak-rms']
export const WAVEFORM_SCALES: readonly WaveformScale[] = ['linear', 'db']
export const WAVEFORM_COLORS: readonly WaveformColor[] = ['track', 'accent', 'neutral']

export const WAVEFORM_GAIN_MIN = 0.5
export const WAVEFORM_GAIN_MAX = 3
/** Paso del zoom vertical: se guarda con dos decimales. */
export const WAVEFORM_GAIN_STEP = 0.05
export const WAVEFORM_BAR_WIDTH_MIN = 1
export const WAVEFORM_BAR_WIDTH_MAX = 6
export const WAVEFORM_BAR_GAP_MIN = 0
export const WAVEFORM_BAR_GAP_MAX = 4
/** Piso de la escala logaritmica: por debajo de -48 dBFS la forma de onda no se ve. */
export const WAVEFORM_DB_FLOOR = -48

export const WAVEFORM_STYLE_LABELS: Record<WaveformStyle, string> = { bars: 'Barras', filled: 'Relleno', line: 'Contorno' }
export const WAVEFORM_LAYOUT_LABELS: Record<WaveformLayout, string> = { mirrored: 'Espejo', bottom: 'Desde la base' }
export const WAVEFORM_DATA_LABELS: Record<WaveformData, string> = { peak: 'Pico', rms: 'RMS', 'peak-rms': 'Pico + RMS' }
export const WAVEFORM_SCALE_LABELS: Record<WaveformScale, string> = { linear: 'Lineal', db: 'dB (-48)' }
export const WAVEFORM_COLOR_LABELS: Record<WaveformColor, string> = { track: 'Pista', accent: 'Acento', neutral: 'Neutro' }

export function defaultWaveformPreferences(): WaveformPreferences {
  return {
    version: WAVEFORM_PREFERENCES_VERSION,
    style: 'filled',
    layout: 'mirrored',
    data: 'peak',
    scale: 'linear',
    color: 'track',
    gain: 1,
    barWidth: 2,
    barGap: 1,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value.trim().replace(/px$/i, ''))
  return Number.NaN
}

/** Zoom vertical acotado y redondeado al paso (dos decimales). Lo invalido da 1. */
export function clampWaveformGain(value: unknown): number {
  const n = toNumber(value)
  if (!Number.isFinite(n)) return 1
  const clamped = Math.min(WAVEFORM_GAIN_MAX, Math.max(WAVEFORM_GAIN_MIN, n))
  return Math.round(Math.round(clamped / WAVEFORM_GAIN_STEP) * WAVEFORM_GAIN_STEP * 100) / 100
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = toNumber(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function clampBarWidth(value: unknown): number {
  return clampInt(value, WAVEFORM_BAR_WIDTH_MIN, WAVEFORM_BAR_WIDTH_MAX, defaultWaveformPreferences().barWidth)
}

export function clampBarGap(value: unknown): number {
  return clampInt(value, WAVEFORM_BAR_GAP_MIN, WAVEFORM_BAR_GAP_MAX, defaultWaveformPreferences().barGap)
}

/**
 * Lectura tolerante del bloque (de la nube, de localStorage o de un JSON importado). Un valor
 * ausente o danado toma su valor por defecto campo por campo; nunca devuelve null: sin bloque,
 * la forma de onda de siempre.
 */
export function parseWaveformPreferences(raw: unknown): WaveformPreferences {
  const d = defaultWaveformPreferences()
  if (!isPlainObject(raw)) return d
  return {
    version: WAVEFORM_PREFERENCES_VERSION,
    style: oneOf(WAVEFORM_STYLES, raw.style) ? raw.style : d.style,
    layout: oneOf(WAVEFORM_LAYOUTS, raw.layout) ? raw.layout : d.layout,
    data: oneOf(WAVEFORM_DATA, raw.data) ? raw.data : d.data,
    scale: oneOf(WAVEFORM_SCALES, raw.scale) ? raw.scale : d.scale,
    color: oneOf(WAVEFORM_COLORS, raw.color) ? raw.color : d.color,
    gain: raw.gain === undefined ? d.gain : clampWaveformGain(raw.gain),
    barWidth: raw.barWidth === undefined ? d.barWidth : clampBarWidth(raw.barWidth),
    barGap: raw.barGap === undefined ? d.barGap : clampBarGap(raw.barGap),
  }
}

/** Copia limpia (tipos y rangos garantizados). */
export function normalizeWaveformPreferences(prefs: Partial<WaveformPreferences> | null | undefined): WaveformPreferences {
  return parseWaveformPreferences(prefs ?? {})
}

/** Avisos (no errores) sobre un bloque `waveform` mal formado; vacio si esta bien o ausente. */
export function waveformPreferencesWarnings(raw: unknown, path = 'uiPreferences.waveform'): string[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [`${path}: debe ser un objeto; se usa la forma de onda por defecto.`]
  const out: string[] = []
  if (raw.version !== undefined && (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1)) {
    out.push(`${path}.version: debe ser un entero >= 1.`)
  }
  const enumWarning = (key: string, list: readonly string[]) => {
    if (raw[key] !== undefined && !oneOf(list, raw[key])) out.push(`${path}.${key}: ${JSON.stringify(raw[key])} no es ${list.join(', ')}.`)
  }
  enumWarning('style', WAVEFORM_STYLES)
  enumWarning('layout', WAVEFORM_LAYOUTS)
  enumWarning('data', WAVEFORM_DATA)
  enumWarning('scale', WAVEFORM_SCALES)
  enumWarning('color', WAVEFORM_COLORS)
  const rangeWarning = (key: string, min: number, max: number, integer: boolean, unit: string) => {
    const v = raw[key]
    if (v === undefined) return
    const ok = typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v))
    if (!ok) out.push(`${path}.${key}: debe ir de ${min} a ${max}${unit}${integer ? ' (entero)' : ''}.`)
  }
  rangeWarning('gain', WAVEFORM_GAIN_MIN, WAVEFORM_GAIN_MAX, false, '')
  rangeWarning('barWidth', WAVEFORM_BAR_WIDTH_MIN, WAVEFORM_BAR_WIDTH_MAX, true, ' px')
  rangeWarning('barGap', WAVEFORM_BAR_GAP_MIN, WAVEFORM_BAR_GAP_MAX, true, ' px')
  return out
}

export function waveformPreferencesEqual(a: WaveformPreferences, b: WaveformPreferences): boolean {
  return (
    a.version === b.version &&
    a.style === b.style &&
    a.layout === b.layout &&
    a.data === b.data &&
    a.scale === b.scale &&
    a.color === b.color &&
    a.gain === b.gain &&
    a.barWidth === b.barWidth &&
    a.barGap === b.barGap
  )
}

/** Cantidad de claves del bloque limpio: withUiPreferences la usa para no reescribir de mas. */
export const WAVEFORM_KEY_COUNT = Object.keys(defaultWaveformPreferences()).length

/**
 * Altura visible (0..1) de una amplitud (0..1) segun la escala y el zoom vertical. En `db`, 0 dBFS
 * llena la altura y WAVEFORM_DB_FLOOR la deja en 0. El zoom se aplica a la altura, en las dos
 * escalas, y se acota a 1 (la forma de onda nunca se sale de su carril).
 */
export function waveformHeight(amplitude: number, scale: WaveformScale, gain: number): number {
  const a = Number.isFinite(amplitude) ? Math.abs(amplitude) : 0
  let h: number
  if (scale === 'db') {
    if (a <= 0) return 0
    const db = 20 * Math.log10(a)
    h = (db - WAVEFORM_DB_FLOOR) / -WAVEFORM_DB_FLOOR
  } else {
    h = a
  }
  const g = Number.isFinite(gain) && gain > 0 ? gain : 1
  const out = h * g
  return out <= 0 ? 0 : out >= 1 ? 1 : out
}
