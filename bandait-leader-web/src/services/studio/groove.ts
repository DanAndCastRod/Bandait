/**
 * "Groove de tu banda": plantilla de groove tomada de un clip de audio (p. ej. la bateria real) y
 * aplicada a notas MIDI, para que la parte generada toque con el mismo pulso que la banda.
 *
 * 1. Ataques: dspMath.detectTransients (flujo espectral, resolucion de un salto de 256 muestras y
 *    sesgo de hasta una ventana FFT) y despues `refineOnsets`, que busca en la senal el inicio real
 *    de cada golpe y su pico (la fuerza del golpe).
 * 2. Plantilla: cada ataque, en beats de la sesion, se asigna al paso mas cercano de la rejilla
 *    (1/16 o 1/8) dentro del compas. Por paso: mediana del desplazamiento en ms (robusta a un golpe
 *    suelto) y velocidad relativa (fuerza media del paso / fuerza media de todos los golpes).
 * 3. Aplicar: cada nota cercana a un paso con datos se cuantiza hacia `paso + desplazamiento` con
 *    una intensidad, y su velocidad se escala hacia la velocidad relativa del paso.
 *
 * La plantilla vive en memoria del controlador (no viaja ni se guarda en la sesion): es una
 * herramienta de edicion, y lo que queda en la sesion son las notas ya movidas.
 *
 * Supuestos: compas constante desde el beat 0 de la sesion (como el resto del Estudio) y tempo fijo.
 * Modulo puro: sin DOM (se prueba en scripts/verify-studio-humanize.ts).
 */
import { detectTransients } from './dspMath.ts'
import { STUDIO_MIDI_MIN_NOTE_BEATS, StudioSessionError, type StudioMidiNote } from './session.ts'
import { mapSelectedNotes } from './midiOps.ts'
import type { MidiEditResult, NoteSelection } from './types.ts'

export type GrooveGrid = '1/8' | '1/16'

export interface StudioGrooveTemplate {
  grid: GrooveGrid
  /** Largo del paso en beats (0.25 o 0.5). */
  stepBeats: number
  beatsPerBar: number
  stepsPerBar: number
  /** Desplazamiento mediano de cada paso respecto de la rejilla recta, en ms (+ = atras). */
  offsetMs: number[]
  /** Velocidad relativa de cada paso (1 = la media de todos los golpes). */
  velocityScale: number[]
  /** Golpes que aportaron a cada paso (0 = sin datos: ese paso no se toca al aplicar). */
  hits: number[]
  /** Compases distintos con golpes. */
  bars: number
  /** Golpes usados en total. */
  onsets: number
  /** Swing estimado (0..0.5, misma escala que humanize): atraso medio de los pasos impares menos el de los pares, en pasos. */
  swing: number
  /** Tempo de la sesion al tomarla (informativo: al aplicar se usa el tempo actual). */
  bpm: number
  /** Nombre para mostrar (pista y clip de origen). */
  label: string
  sourceClipId: string | null
}

export interface GrooveOnset {
  /** Beat de la sesion del ataque. */
  beat: number
  /** Fuerza del golpe (pico de amplitud o velocidad), cualquier escala positiva. */
  strength: number
}

export interface RefinedOnset {
  timeS: number
  strength: number
}

const STEP_BEATS: Readonly<Record<GrooveGrid, number>> = { '1/8': 0.5, '1/16': 0.25 }
/** Golpes minimos para que la plantilla signifique algo. */
export const GROOVE_MIN_ONSETS = 8
/** Una nota se mueve solo si esta a menos de esta fraccion de paso de un paso de la plantilla. */
const APPLY_TOLERANCE_STEPS = 0.4
/** Tope de la velocidad relativa de un paso. */
const VELOCITY_SCALE_MIN = 0.3
const VELOCITY_SCALE_MAX = 1.8

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * Ubica el inicio real de cada ataque cerca de lo que dio detectTransients. Ventana: desde 10 ms
 * antes del instante detectado hasta una ventana FFT (1024 muestras) y 15 ms despues, sin pasar
 * del siguiente ataque. Dentro, el pico de amplitud es la fuerza del golpe; desde el pico se
 * retrocede por bloques de 32 muestras mientras el bloque supere el 20 % del pico (como mucho
 * 25 ms): ese punto es el inicio.
 */
export function refineOnsets(samples: Float32Array, sampleRate: number, onsetsS: readonly number[]): RefinedOnset[] {
  const out: RefinedOnset[] = []
  const block = 32
  const maxBack = Math.round(0.025 * sampleRate)
  for (let i = 0; i < onsetsS.length; i++) {
    const t = onsetsS[i]
    const from = Math.max(0, Math.floor((t - 0.01) * sampleRate))
    let to = Math.min(samples.length, Math.ceil((t + 1024 / sampleRate + 0.015) * sampleRate))
    if (i + 1 < onsetsS.length) to = Math.min(to, Math.max(from + 1, Math.floor(onsetsS[i + 1] * sampleRate)))
    let peak = 0
    let peakAt = from
    for (let s = from; s < to; s++) {
      const a = Math.abs(samples[s])
      if (a > peak) {
        peak = a
        peakAt = s
      }
    }
    if (!(peak > 1e-5)) continue
    const thresh = peak * 0.2
    let start = peakAt
    const limit = Math.max(from, peakAt - maxBack)
    while (start - block >= limit) {
      let blockMax = 0
      for (let s = start - block; s < start; s++) blockMax = Math.max(blockMax, Math.abs(samples[s]))
      if (blockMax < thresh) break
      start -= block
    }
    // Afinar dentro del ultimo bloque: primera muestra que supera el umbral.
    let first = start
    for (let s = Math.max(limit, start - block); s <= peakAt; s++) {
      if (Math.abs(samples[s]) >= thresh) {
        first = s
        break
      }
    }
    out.push({ timeS: first / sampleRate, strength: peak })
  }
  return out
}

/** Plantilla a partir de ataques ya en beats de la sesion; null si hay menos de GROOVE_MIN_ONSETS. */
export function extractGrooveTemplate(
  onsets: readonly GrooveOnset[],
  options: { bpm: number; beatsPerBar: number; grid?: GrooveGrid; label?: string; sourceClipId?: string | null },
): StudioGrooveTemplate | null {
  const bpm = options.bpm
  if (!(bpm > 0)) throw new StudioSessionError('bad_value', 'bpm', 'Tempo no válido')
  const grid: GrooveGrid = options.grid === '1/8' ? '1/8' : '1/16'
  const step = STEP_BEATS[grid]
  const beatsPerBar = Math.max(1, Math.round(options.beatsPerBar))
  const stepsPerBar = Math.max(1, Math.round(beatsPerBar / step))
  const valid = onsets.filter((o) => Number.isFinite(o.beat) && o.beat >= 0 && Number.isFinite(o.strength) && o.strength > 0)
  if (valid.length < GROOVE_MIN_ONSETS) return null

  const offsets: number[][] = Array.from({ length: stepsPerBar }, () => [])
  const strengths: number[][] = Array.from({ length: stepsPerBar }, () => [])
  const bars = new Set<number>()
  let total = 0
  for (const o of valid) {
    const k = Math.round(o.beat / step)
    const idx = mod(k, stepsPerBar)
    offsets[idx].push(((o.beat - k * step) * 60000) / bpm)
    strengths[idx].push(o.strength)
    bars.add(Math.floor(k / stepsPerBar))
    total += o.strength
  }
  const meanStrength = total / valid.length
  const offsetMs = offsets.map((list) => (list.length > 0 ? Math.round(median(list) * 100) / 100 : 0))
  const velocityScale = strengths.map((list) => {
    if (list.length === 0) return 1
    const m = list.reduce((a, b) => a + b, 0) / list.length
    return Math.round(Math.min(VELOCITY_SCALE_MAX, Math.max(VELOCITY_SCALE_MIN, m / meanStrength)) * 1000) / 1000
  })
  const hits = offsets.map((list) => list.length)

  // Swing estimado: atraso de los pasos impares respecto de los pares, en fraccion de paso.
  let oddSum = 0
  let oddN = 0
  let evenSum = 0
  let evenN = 0
  offsetMs.forEach((ms, idx) => {
    if (hits[idx] === 0) return
    if (idx % 2 === 1) {
      oddSum += ms * hits[idx]
      oddN += hits[idx]
    } else {
      evenSum += ms * hits[idx]
      evenN += hits[idx]
    }
  })
  const stepMs = (step * 60000) / bpm
  const swingRaw = oddN > 0 && evenN > 0 ? (oddSum / oddN - evenSum / evenN) / stepMs : 0
  const swing = Math.round(Math.min(0.5, Math.max(0, swingRaw)) * 1000) / 1000

  return {
    grid,
    stepBeats: step,
    beatsPerBar,
    stepsPerBar,
    offsetMs,
    velocityScale,
    hits,
    bars: bars.size,
    onsets: valid.length,
    swing,
    bpm,
    label: options.label ?? 'Groove',
    sourceClipId: options.sourceClipId ?? null,
  }
}

/**
 * Plantilla desde el audio de un clip. `samples` es el tramo que suena del clip (desde su
 * offset), mono; `clipStartS` es donde empieza el clip en la sesion.
 */
export function grooveFromAudio(
  samples: Float32Array,
  sampleRate: number,
  options: { clipStartS: number; bpm: number; beatsPerBar: number; grid?: GrooveGrid; sensitivity?: number; label?: string; sourceClipId?: string | null },
): StudioGrooveTemplate | null {
  const raw = detectTransients(samples, sampleRate, { sensitivity: options.sensitivity ?? 0.6, minIntervalMs: 50 })
  const refined = refineOnsets(samples, sampleRate, raw)
  const beatsPerSecond = options.bpm / 60
  const onsets: GrooveOnset[] = refined.map((o) => ({ beat: (options.clipStartS + o.timeS) * beatsPerSecond, strength: o.strength }))
  return extractGrooveTemplate(onsets, options)
}

/**
 * Aplica la plantilla a las notas elegidas (null = todas) de un clip que empieza en
 * `clipStartBeat`. `strength` 0..1: cuanto se acerca cada inicio a `paso + desplazamiento`
 * (1 = del todo). `velocityStrength` 0..1: cuanto toma la velocidad relativa del paso. Una nota
 * lejos de los pasos de la plantilla (p. ej. semicorcheas con plantilla de corcheas) o en un paso
 * sin datos no cambia. El tempo actual convierte los ms de la plantilla.
 */
export function applyGrooveTemplate(
  notes: readonly StudioMidiNote[],
  selection: NoteSelection | null,
  template: StudioGrooveTemplate,
  options: { strength: number; velocityStrength?: number; clipStartBeat: number; bpm: number },
  clipLengthBeats: number,
): MidiEditResult {
  const strength = Math.min(1, Math.max(0, Number.isFinite(options.strength) ? options.strength : 0))
  const velStrength = Math.min(1, Math.max(0, Number.isFinite(options.velocityStrength ?? 0) ? (options.velocityStrength ?? 0) : 0))
  const step = template.stepBeats
  const bpm = options.bpm > 0 ? options.bpm : template.bpm
  const lastStart = Math.max(0, clipLengthBeats - STUDIO_MIDI_MIN_NOTE_BEATS)
  return mapSelectedNotes(notes, selection, clipLengthBeats, (n) => {
    const phase = options.clipStartBeat + n.start
    const k = Math.round(phase / step)
    if (Math.abs(phase - k * step) > step * APPLY_TOLERANCE_STEPS) return n
    const idx = mod(k, template.stepsPerBar)
    if (!(template.hits[idx] > 0)) return n
    const target = k * step + (template.offsetMs[idx] * bpm) / 60000
    const start = Math.min(lastStart, Math.max(0, n.start + (target - phase) * strength))
    const velocity = Math.round(n.velocity * (1 + (template.velocityScale[idx] - 1) * velStrength))
    return { ...n, start, velocity }
  })
}

/** Resumen corto para la interfaz: "Batería · 32 golpes en 4 compases · swing 62 %". */
export function describeGroove(t: StudioGrooveTemplate): string {
  const pct = Math.round(50 + t.swing * 50)
  return `${t.label} · ${t.onsets} golpes en ${t.bars} ${t.bars === 1 ? 'compás' : 'compases'} · swing ${pct} % (${t.grid})`
}
