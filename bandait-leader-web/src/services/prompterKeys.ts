/**
 * Atajos de teclado y navegacion del prompter de ENSAYO. Modulo puro (se prueba en
 * scripts/verify-stems-logic.ts): traduce una tecla a una accion y calcula a que segundo saltar;
 * la vista solo ejecuta.
 */
import { barAtTime, barStartSeconds, sectionIndexAtBar, type SectionSpan } from './stemTiming.ts'

export type PrompterAction =
  | { type: 'togglePlay' }
  | { type: 'bars'; delta: number }
  | { type: 'section'; dir: -1 | 1 }
  | { type: 'gotoSection'; index: number }
  | { type: 'toggleLoop' }
  | { type: 'start' }
  | { type: 'mode'; mode: 'chords' | 'lyrics' }
  | { type: 'fontSize'; delta: 1 | -1 }
  | { type: 'transpose'; delta: 1 | -1 }
  | { type: 'transposeReset' }
  | { type: 'focus' }
  | { type: 'exit' }
  | { type: 'mixer' }
  | { type: 'help' }

/**
 * Donde esta el foco: 'text' (input de texto, select, textarea, contenteditable: los atajos se
 * ignoran), 'range' (un deslizador: se ignoran las teclas que el deslizador usa) u 'other'.
 */
export type KeyTarget = 'text' | 'range' | 'other'

export interface KeyLike {
  key: string
  code?: string
  shiftKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  /** La tecla se repite por mantenerla pulsada. */
  repeat?: boolean
}

/** Teclas que mueve un deslizador por si mismo. */
const RANGE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

/** Tipo de foco de un elemento del DOM (o de nada). */
export function keyTargetOf(el: { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined): KeyTarget {
  if (!el || !el.tagName) return 'other'
  if (el.isContentEditable) return 'text'
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return 'text'
  if (tag === 'INPUT') {
    const type = (el.type ?? 'text').toLowerCase()
    if (type === 'range') return 'range'
    if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit') return 'other'
    return 'text'
  }
  return 'other'
}

/**
 * Tecla -> accion del prompter, o null si no es un atajo. Ctrl, Alt o Meta nunca son atajos (no
 * se pisan los del navegador). Las letras valen en mayuscula o minuscula; Shift cambia el sentido
 * de T y el salto de las flechas (4 compases).
 */
export function keyToAction(e: KeyLike, target: KeyTarget = 'other'): PrompterAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if (target === 'text') return null
  if (target === 'range' && RANGE_KEYS.has(e.key)) return null
  const shift = !!e.shiftKey
  const code = e.code ?? ''
  // Shift+0 por codigo fisico: en un teclado espanol escribe "=", en uno ingles ")".
  if (code === 'Digit0' && shift) return { type: 'transposeReset' }

  switch (e.key) {
    case ' ':
    case 'Spacebar':
      return { type: 'togglePlay' }
    case 'ArrowRight':
      return { type: 'bars', delta: shift ? 4 : 1 }
    case 'ArrowLeft':
      return { type: 'bars', delta: shift ? -4 : -1 }
    case 'ArrowUp':
    case 'PageUp':
      return { type: 'section', dir: -1 }
    case 'ArrowDown':
    case 'PageDown':
      return { type: 'section', dir: 1 }
    case 'Home':
      return { type: 'start' }
    case 'Escape':
      return { type: 'exit' }
    case '?':
      return { type: 'help' }
    case '+':
    case '=':
      return { type: 'fontSize', delta: 1 }
    case '-':
    case '_':
      return { type: 'fontSize', delta: -1 }
  }
  if (code === 'NumpadAdd') return { type: 'fontSize', delta: 1 }
  if (code === 'NumpadSubtract') return { type: 'fontSize', delta: -1 }
  if (!shift && /^[0-9]$/.test(e.key)) {
    const n = Number(e.key)
    return n === 0 ? { type: 'start' } : { type: 'gotoSection', index: n - 1 }
  }
  switch (e.key.toLowerCase()) {
    case 'r':
      return { type: 'toggleLoop' }
    case 'c':
      return { type: 'mode', mode: 'chords' }
    case 'l':
      return { type: 'mode', mode: 'lyrics' }
    case 't':
      return { type: 'transpose', delta: shift ? -1 : 1 }
    case 'f':
      return { type: 'focus' }
    case 'm':
      return { type: 'mixer' }
  }
  return null
}

/** Tabla del panel de atajos (la misma que entiende keyToAction). */
export const PROMPTER_SHORTCUTS: ReadonlyArray<{ keys: string[]; action: string }> = [
  { keys: ['Espacio'], action: 'Reproducir o pausar' },
  { keys: ['←', '→'], action: 'Un compás atrás o adelante (con Shift, 4)' },
  { keys: ['↑', '↓', 'RePág', 'AvPág'], action: 'Sección anterior o siguiente' },
  { keys: ['1', '…', '9'], action: 'Ir a la sección 1 a 9' },
  { keys: ['Inicio', '0'], action: 'Volver al principio' },
  { keys: ['R'], action: 'Repetir o soltar la sección actual' },
  { keys: ['C', 'L'], action: 'Ver acordes o solo la letra' },
  { keys: ['+', '-'], action: 'Tamaño de la letra' },
  { keys: ['T', 'Shift T'], action: 'Transponer medio tono arriba o abajo' },
  { keys: ['Shift 0'], action: 'Volver al tono original' },
  { keys: ['F'], action: 'Modo foco (pantalla completa)' },
  { keys: ['Esc'], action: 'Salir del modo foco o cerrar este panel' },
  { keys: ['M'], action: 'Plegar o abrir la mezcla' },
  { keys: ['?'], action: 'Este panel' },
]

export interface Timing {
  bpm: number
  beatsPerBar: number
  offsetMs: number
}

/** Segundo del audio en que empieza el compas `bar` (1-based) de la cancion. */
export function barSeconds(bar: number, t: Timing): number {
  return barStartSeconds(bar, t.bpm, t.beatsPerBar) + (Number.isFinite(t.offsetMs) ? t.offsetMs / 1000 : 0)
}

/**
 * Salto de `delta` compases desde la posicion: al inicio del compas actual + delta. Antes del
 * compas 1 cuenta desde el compas 1. Nunca antes del segundo 0. NaN si el tempo no es valido.
 */
export function barSeekTarget(posSec: number, delta: number, t: Timing): number {
  const bar = barAtTime(posSec, t.bpm, t.beatsPerBar, t.offsetMs)
  if (!Number.isFinite(bar)) return Number.NaN
  const from = Math.max(1, Math.floor(bar))
  return Math.max(0, barSeconds(Math.max(1, from + delta), t))
}

/**
 * Seccion anterior o siguiente, como en un reproductor: "anterior" vuelve al inicio de la seccion
 * actual si ya va mas de 1 compas dentro; si no, a la seccion anterior (o al principio del audio
 * desde la primera). "Siguiente" despues de la ultima no hace nada (null).
 */
export function sectionNavTarget(spans: readonly SectionSpan[], posSec: number, dir: -1 | 1, t: Timing): number | null {
  if (spans.length === 0) return null
  const bar = barAtTime(posSec, t.bpm, t.beatsPerBar, t.offsetMs)
  if (!Number.isFinite(bar)) return null
  const idx = sectionIndexAtBar(spans, bar)
  if (dir === 1) {
    const next = idx < 0 ? 0 : idx + 1
    return next < spans.length ? Math.max(0, spans[next].startSec) : null
  }
  if (idx < 0) return 0
  if (idx >= spans.length) return Math.max(0, spans[spans.length - 1].startSec)
  if (bar - spans[idx].startBar > 1) return Math.max(0, spans[idx].startSec)
  return idx === 0 ? 0 : Math.max(0, spans[idx - 1].startSec)
}

/** Tiempo del compas (0-based) en que esta el compas fraccionario `bar`; -1 antes del compas 1. */
export function beatInBar(bar: number, beatsPerBar: number): number {
  if (!Number.isFinite(bar) || bar < 1 || !(beatsPerBar > 0)) return -1
  return Math.min(beatsPerBar - 1, Math.floor((bar - Math.floor(bar)) * beatsPerBar))
}

/**
 * Compases que faltan para que termine la seccion `span` (contando el actual): 2 en el penultimo,
 * 1 en el ultimo. 0 fuera de la seccion.
 */
export function barsLeftInSection(span: Pick<SectionSpan, 'startBar' | 'bars'>, bar: number): number {
  if (!Number.isFinite(bar)) return 0
  const whole = Math.floor(bar)
  const end = span.startBar + span.bars
  return whole >= span.startBar && whole < end ? end - whole : 0
}

/** Escalas del prompter (A- / A+). El indice se guarda en localStorage. */
export const FONT_SCALES = [0.7, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2] as const
export const DEFAULT_FONT_STEP = 3

export function clampFontStep(step: unknown): number {
  // localStorage devuelve null si no hay nada guardado (y Number(null) seria 0).
  const n = typeof step === 'number' ? step : typeof step === 'string' && step.trim() !== '' ? Number(step) : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_FONT_STEP
  return Math.min(FONT_SCALES.length - 1, Math.max(0, Math.round(n)))
}
