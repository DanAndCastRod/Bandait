/**
 * Escala del fader y del vumetro del mezclador del Estudio (STUDIO_V1.md: volumen de pista y de
 * master de -60 a +12 dB).
 *
 * Recorrido del fader (0 abajo, 1 arriba) contra dB. No es lineal: como en una consola, la zona
 * de trabajo (de -12 a +6 dB) ocupa casi la mitad del recorrido y 0 dB queda a tres cuartos. El
 * vumetro usa la misma escala, asi el nivel y el fader se leen contra las mismas marcas.
 *
 * Modulo puro: sin DOM ni React (se prueba en scripts/verify-studio-v2-audio.ts).
 */
import { STUDIO_VOLUME_DB_MAX, STUDIO_VOLUME_DB_MIN } from './session.ts'

/** Puntos [posicion, dB] de la curva; entre dos puntos la escala es lineal. */
export const FADER_POINTS: readonly (readonly [number, number])[] = [
  [0, -60],
  [0.1, -40],
  [0.25, -24],
  [0.45, -12],
  [0.6, -6],
  [0.75, 0],
  [0.875, 6],
  [1, 12],
]

/** Marcas impresas junto al fader, de arriba abajo: el recorrido completo, de +12 a -60 dB. */
export const FADER_MARKS: readonly number[] = [12, 6, 0, -6, -12, -24, -40, -60]

/** Posicion del fader (0..1) para un valor en dB; -60 o menos (o no finito) es 0, +12 o mas es 1. */
export function dbToFader(db: number): number {
  if (!Number.isFinite(db) || db <= STUDIO_VOLUME_DB_MIN) return 0
  if (db >= STUDIO_VOLUME_DB_MAX) return 1
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p1, d1] = FADER_POINTS[i]
    if (db <= d1) {
      const [p0, d0] = FADER_POINTS[i - 1]
      return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0)
    }
  }
  return 1
}

/** dB para una posicion del fader (0..1, se acota), redondeado a centesimas. */
export function faderToDb(position: number): number {
  const p = Math.min(1, Math.max(0, Number.isFinite(position) ? position : 0))
  for (let i = 1; i < FADER_POINTS.length; i++) {
    const [p1, d1] = FADER_POINTS[i]
    if (p <= p1) {
      const [p0, d0] = FADER_POINTS[i - 1]
      return Math.round((d0 + ((p - p0) / (p1 - p0)) * (d1 - d0)) * 100) / 100
    }
  }
  return STUDIO_VOLUME_DB_MAX
}

// ---------------------------------------------------------------------------
// Vumetro LED
// ---------------------------------------------------------------------------

/** Alto de un LED y separacion entre LEDs, en px CSS. */
export const LED_SEGMENT_PX = 3
export const LED_GAP_PX = 1

/** Zona de color de un LED: verde de trabajo, ambar desde -6 dB, rojo por encima de 0 dB. */
export type LedZone = 'ok' | 'hot' | 'over'

/** Desde aqui (dB) el LED es ambar. */
export const LED_HOT_DB = -6

/** LEDs que caben en un alto (px CSS); al menos uno si hay alto. */
export function ledSegmentCount(heightPx: number): number {
  if (!(heightPx > 0)) return 0
  return Math.max(1, Math.floor((heightPx + LED_GAP_PX) / (LED_SEGMENT_PX + LED_GAP_PX)))
}

/**
 * Zona del LED `index` (0 = el de abajo) de `count`: la decide el dB de su borde de arriba sobre
 * la escala del fader.
 */
export function ledZone(index: number, count: number): LedZone {
  const db = faderToDb((index + 1) / Math.max(1, count))
  if (db > 0) return 'over'
  if (db > LED_HOT_DB) return 'hot'
  return 'ok'
}

/** LEDs encendidos para un nivel en posicion de fader (0..1): se enciende si el nivel llega a su mitad. */
export function ledLitCount(fraction: number, count: number): number {
  if (!(fraction > 0) || count <= 0) return 0
  return Math.min(count, Math.max(0, Math.floor(fraction * count + 0.5)))
}
