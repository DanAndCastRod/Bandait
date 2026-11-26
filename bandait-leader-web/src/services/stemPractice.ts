/**
 * Logica pura de practica del reproductor de stems (ENSAYO): velocidad, tono, Speed Ramp y la
 * sincronia entre el tono del audio y la transposicion de acordes ChordPro. Sin DOM ni Web Audio:
 * se prueba con node (scripts/verify-stem-practice.ts).
 */
import { SHIFTER_SEMITONES_MAX, SHIFTER_SPEED_MAX, SHIFTER_SPEED_MIN } from './pitchShifterCore.ts'

export const SPEED_MIN = SHIFTER_SPEED_MIN
export const SPEED_MAX = SHIFTER_SPEED_MAX
export const SPEED_STEP = 0.05
export const PITCH_MIN = -SHIFTER_SEMITONES_MAX
export const PITCH_MAX = SHIFTER_SEMITONES_MAX
/** Rango de la transposicion de acordes del prompter (ya existia: +-11). */
export const TRANSPOSE_MIN = -11
export const TRANSPOSE_MAX = 11

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** Velocidad dentro de 0,50x..1,25x, redondeada a milesimas. No finita = 1. */
export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1
  return round3(Math.min(SPEED_MAX, Math.max(SPEED_MIN, speed)))
}

/** Semitonos enteros dentro de +-6. */
export function clampPitch(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0
  return Math.min(PITCH_MAX, Math.max(PITCH_MIN, Math.round(semitones)))
}

export function clampTranspose(semitones: number): number {
  if (!Number.isFinite(semitones)) return 0
  return Math.min(TRANSPOSE_MAX, Math.max(TRANSPOSE_MIN, Math.round(semitones)))
}

/**
 * Lee una velocidad escrita: "0,75", "0.75", "0,75x", "75%" o "75" (porcentaje si pasa de 2).
 * Null si no es un numero o si cae fuera de 0,50x..1,25x (el campo marca el error, no la recorta).
 */
export function parseSpeed(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '').replace(',', '.')
  const m = /^(\d+(?:\.\d+)?|\.\d+)(x|%)?$/.exec(t)
  if (!m) return null
  let v = Number(m[1])
  if (m[2] === '%' || (!m[2] && v > 2)) v /= 100
  if (!Number.isFinite(v)) return null
  v = round3(v)
  if (v < SPEED_MIN - 1e-9 || v > SPEED_MAX + 1e-9) return null
  return v
}

/** "0,75x" (coma decimal, dos decimales). */
export function formatSpeed(speed: number): string {
  return `${clampSpeed(speed).toFixed(2).replace('.', ',')}x`
}

/** "+2 st", "-3 st", "0 st". */
export function formatPitch(semitones: number): string {
  const s = Math.round(semitones)
  return `${s > 0 ? '+' : ''}${s} st`
}

/** Un paso de 0,05 hacia arriba o abajo desde cualquier valor (0,73 + paso = 0,75). */
export function stepSpeed(speed: number, dir: -1 | 1): number {
  const k = speed / SPEED_STEP
  const next = dir > 0 ? Math.floor(k + 1e-6) + 1 : Math.ceil(k - 1e-6) - 1
  return clampSpeed(next * SPEED_STEP)
}

// ---------------------------------------------------------------------------
// Speed Ramp
// ---------------------------------------------------------------------------

/**
 * Speed Ramp: en un bucle (A-B o seccion) la velocidad empieza en `start` y sube `step` en cada
 * vuelta hasta `top`, donde se queda. La vuelta 0 es la primera pasada por el bucle.
 */
export interface SpeedRamp {
  enabled: boolean
  start: number
  step: number
  top: number
}

export const RAMP_STEP_MIN = 0.01
export const RAMP_STEP_MAX = 0.25
export const DEFAULT_SPEED_RAMP: SpeedRamp = { enabled: false, start: 0.7, step: 0.05, top: 1 }

/** Acota inicio y tope a 0,50x..1,25x, el paso a 0,01..0,25 y, si el tope queda bajo el inicio, lo sube al inicio. */
export function normalizeRamp(ramp: SpeedRamp): SpeedRamp {
  const start = clampSpeed(ramp.start)
  const step = Number.isFinite(ramp.step) ? round3(Math.min(RAMP_STEP_MAX, Math.max(RAMP_STEP_MIN, ramp.step))) : DEFAULT_SPEED_RAMP.step
  const top = Math.max(start, clampSpeed(ramp.top))
  return { enabled: !!ramp.enabled, start, step, top }
}

/** Lee el paso por vuelta: "+0,05", "0.05", "0,05x" o "5%". Null fuera de 0,01..0,25. */
export function parseRampStep(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '').replace(/^\+/, '').replace(',', '.')
  const m = /^(\d+(?:\.\d+)?|\.\d+)(x|%)?$/.exec(t)
  if (!m) return null
  let v = Number(m[1])
  if (m[2] === '%' || (!m[2] && v >= 1)) v /= 100
  v = round3(v)
  if (!Number.isFinite(v) || v < RAMP_STEP_MIN - 1e-9 || v > RAMP_STEP_MAX + 1e-9) return null
  return v
}

/** "+0,05x". */
export function formatRampStep(step: number): string {
  return `+${step.toFixed(2).replace('.', ',')}x`
}

/** Velocidad de la vuelta `lap` (0, 1, 2...). */
export function rampSpeedForLap(ramp: SpeedRamp, lap: number): number {
  const r = normalizeRamp(ramp)
  const n = Math.max(0, Math.floor(Number.isFinite(lap) ? lap : 0))
  return round3(Math.min(r.top, r.start + n * r.step))
}

/** Vueltas hasta llegar al tope (0 si ya empieza en el). */
export function rampLapsToTop(ramp: SpeedRamp): number {
  const r = normalizeRamp(ramp)
  return Math.max(0, Math.ceil((r.top - r.start) / r.step - 1e-9))
}

/** Texto del indicador: "VUELTA 3 · 0,80x" (vuelta contada desde 1), con "TOPE" al llegar. */
export function rampLabel(ramp: SpeedRamp, lap: number): string {
  const speed = rampSpeedForLap(ramp, lap)
  const atTop = lap >= rampLapsToTop(ramp)
  return `VUELTA ${Math.max(0, Math.floor(lap)) + 1} · ${formatSpeed(speed)}${atTop ? ' · TOPE' : ''}`
}

// ---------------------------------------------------------------------------
// Tono del audio <-> transposicion de acordes
// ---------------------------------------------------------------------------

/**
 * Estado compartido del ENSAYO: `transpose` son los semitonos de los acordes mostrados (+-11),
 * `pitch` los del audio (+-6) y `linked` si se mueven juntos.
 *
 * Con `linked`:
 *   - mover el tono del audio mueve los acordes lo mismo (+2 st -> acordes +2);
 *   - transponer los acordes mueve el tono del audio, dentro de +-6.
 * Fuera de +-6 (acordes en +7..+11 o -7..-11) el audio no puede seguir en la misma direccion, asi
 * que va a la octava equivalente: +7 suena -5, +11 suena -1, -7 suena +5. Los nombres de los
 * acordes son los mismos (la transposicion de acordes es modulo 12), solo cambia la octava del
 * audio; la interfaz lo avisa. Al volver a mover el audio, los acordes eligen la equivalencia mas
 * cercana a donde estaban (desde +7, bajar el audio de -5 a -6 deja los acordes en +6).
 */
export interface ToneState {
  transpose: number
  pitch: number
  linked: boolean
}

export const INITIAL_TONE: ToneState = { transpose: 0, pitch: 0, linked: true }

/** Semitonos del audio (+-6) que suenan como la transposicion de acordes `t`. */
export function pitchForTranspose(transpose: number): number {
  const t = clampTranspose(transpose)
  if (t > PITCH_MAX) return t - 12
  if (t < PITCH_MIN) return t + 12
  return t
}

/**
 * Transposicion de acordes que sigue a `pitch`: la misma si los acordes estaban dentro de +-6; si
 * estaban afuera (audio en la octava equivalente), la equivalencia modulo 12 mas cercana a
 * `previous`, dentro de +-11.
 */
export function transposeForPitch(pitch: number, previous: number): number {
  const p = clampPitch(pitch)
  const prev = clampTranspose(previous)
  if (Math.abs(prev) <= PITCH_MAX) return p
  let best = p
  for (const cand of [p - 12, p, p + 12]) {
    if (cand < TRANSPOSE_MIN || cand > TRANSPOSE_MAX) continue
    if (Math.abs(cand - prev) < Math.abs(best - prev)) best = cand
  }
  return best
}

/** El audio no esta en la misma octava que los acordes (acordes fuera de +-6, vinculados). */
export function toneOctaveFolded(state: ToneState): boolean {
  return state.linked && state.pitch !== state.transpose
}

/** Transponer los acordes (teclas T, botones del prompter). */
export function applyTranspose(state: ToneState, transpose: number): ToneState {
  const t = clampTranspose(transpose)
  return { ...state, transpose: t, pitch: state.linked ? pitchForTranspose(t) : state.pitch }
}

/** Mover el tono del audio (control de TONO). */
export function applyPitch(state: ToneState, pitch: number): ToneState {
  const p = clampPitch(pitch)
  return { ...state, pitch: p, transpose: state.linked ? transposeForPitch(p, state.transpose) : state.transpose }
}

/** Vincular o soltar. Al vincular, el audio pasa a sonar como los acordes mostrados. */
export function applyLinked(state: ToneState, linked: boolean): ToneState {
  return linked ? { transpose: state.transpose, pitch: pitchForTranspose(state.transpose), linked: true } : { ...state, linked: false }
}
