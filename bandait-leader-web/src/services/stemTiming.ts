/**
 * Tiempos de seccion para el estudio de stems: donde empieza y termina cada seccion de una
 * cancion, en segundos del audio. Modulo puro (se prueba en scripts/verify-stems-logic.ts).
 *
 * inicio(s) = (compas_inicial - 1) * beatsPerBar * 60 / bpm + offsetMs / 1000
 *
 * El compas inicial de una seccion es 1 + la suma de compases de las secciones anteriores
 * (WORKSPACE_V2.md: las secciones se tocan en orden y cada una dura `bars` compases). El offset es
 * de alineacion por cancion: cuanto tarda el audio en llegar al compas 1 (silencio inicial, conteo).
 */
import type { Song } from '../types/hub'

export interface SectionSpan {
  id: string
  label: string
  /** Compas inicial, 1-based. */
  startBar: number
  bars: number
  startSec: number
  endSec: number
}

export interface LoopRegion {
  start: number
  end: number
}

/** Rango aceptado para el offset de alineacion (ms). */
export const OFFSET_MIN_MS = -60000
export const OFFSET_MAX_MS = 60000

/** Segundos desde el compas 1 hasta el inicio del compas `bar` (1-based), sin offset. */
export function barStartSeconds(bar: number, bpm: number, beatsPerBar: number): number {
  return ((bar - 1) * beatsPerBar * 60) / bpm
}

function validTempo(bpm: unknown, beatsPerBar: unknown): boolean {
  return (
    typeof bpm === 'number' &&
    Number.isFinite(bpm) &&
    bpm > 0 &&
    typeof beatsPerBar === 'number' &&
    Number.isFinite(beatsPerBar) &&
    beatsPerBar > 0
  )
}

/**
 * Secciones de la cancion con sus tiempos. Lista vacia si la cancion no tiene secciones o su
 * tempo no es valido: no se inventan datos. Una seccion con `bars` invalido corta la lista ahi,
 * porque las siguientes ya no tendrian un inicio confiable.
 */
export function sectionSpans(song: Pick<Song, 'bpm' | 'beatsPerBar' | 'sections'>, offsetMs = 0): SectionSpan[] {
  if (!validTempo(song.bpm, song.beatsPerBar) || !Array.isArray(song.sections)) return []
  const offset = Number.isFinite(offsetMs) ? offsetMs / 1000 : 0
  const spans: SectionSpan[] = []
  let bar = 1
  for (const section of song.sections) {
    if (!Number.isInteger(section.bars) || section.bars < 1) break
    spans.push({
      id: section.id,
      label: section.label,
      startBar: bar,
      bars: section.bars,
      startSec: barStartSeconds(bar, song.bpm, song.beatsPerBar) + offset,
      endSec: barStartSeconds(bar + section.bars, song.bpm, song.beatsPerBar) + offset,
    })
    bar += section.bars
  }
  return spans
}

/**
 * Ajusta una region de repeticion a la duracion del audio. null si no queda una region util
 * (al menos 50 ms dentro del audio).
 */
export function clampLoop(region: LoopRegion, durationSec: number): LoopRegion | null {
  if (!Number.isFinite(region.start) || !Number.isFinite(region.end) || !(durationSec > 0)) return null
  const start = Math.max(0, Math.min(region.start, durationSec))
  const end = Math.max(0, Math.min(region.end, durationSec))
  return end - start >= 0.05 ? { start, end } : null
}

/** "m:ss.d" para mostrar posiciones. Valores negativos o no finitos se muestran como 0. */
export function formatClock(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0
  const tenths = Math.floor(s * 10)
  const minutes = Math.floor(tenths / 600)
  const seconds = Math.floor((tenths % 600) / 10)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`
}

/** Decibeles a ganancia lineal; por debajo de -60 dB se considera silencio. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db) || db <= -60) return 0
  return Math.pow(10, db / 20)
}
