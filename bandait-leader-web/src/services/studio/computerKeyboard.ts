/**
 * Teclado de la computadora como teclado musical (docs/PLAN_ESTUDIO_V2.md, seccion 4), para
 * tocar y grabar MIDI cuando no hay un teclado USB. Contrato: types.ts, seccion
 * "v2 · midiInput.ts" (computerKeyPitch).
 *
 * Por `event.code` (no depende de la distribucion): fila A..K = Do..Do (W, E, T, Y, U = los
 * sostenidos), Z baja y X sube la octava. Velocidad fija 100. Octava base 4 = Do central (60).
 *
 * Decisiones que el contrato no fija:
 *   - Con Ctrl, Alt, Cmd o Shift apretado la tecla no es una nota: los atajos (Ctrl+D, Shift+S)
 *     siguen funcionando con el teclado musical encendido.
 *   - La tecla sostenida (`repeat`) no repite la nota.
 *   - Cambiar de octava con notas apretadas no las corta: cada tecla suelta el pitch con el que
 *     sono al apretarla.
 *   - Con el teclado musical encendido, las letras de la fila (A, S, D...) son notas y no atajos:
 *     la interfaz consulta isComputerKeyboardCode antes de matchEvent.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */

/** Semitonos sobre el Do de la octava base, por `event.code`. */
export const COMPUTER_KEYBOARD_NOTES: Readonly<Record<string, number>> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
}

export const COMPUTER_KEYBOARD_OCTAVE_DOWN = 'KeyZ'
export const COMPUTER_KEYBOARD_OCTAVE_UP = 'KeyX'
export const COMPUTER_KEYBOARD_VELOCITY = 100
export const COMPUTER_KEYBOARD_DEFAULT_OCTAVE = 4
/** Octavas en las que toda la fila cabe en 0..127 (Do de -1 = 0; Do de 9 = 120). */
export const COMPUTER_KEYBOARD_MIN_OCTAVE = -1
export const COMPUTER_KEYBOARD_MAX_OCTAVE = 8

/** Pitch de una tecla con la octava base (4 = Do central 60), o null si no es una nota. */
export function computerKeyPitch(code: string, baseOctave: number): number | null {
  const semis = Object.prototype.hasOwnProperty.call(COMPUTER_KEYBOARD_NOTES, code) ? COMPUTER_KEYBOARD_NOTES[code] : undefined
  if (semis === undefined || !Number.isFinite(baseOctave)) return null
  const pitch = (Math.round(baseOctave) + 1) * 12 + semis
  return pitch >= 0 && pitch <= 127 ? pitch : null
}

/** true si la tecla es del teclado musical (nota o cambio de octava). */
export function isComputerKeyboardCode(code: string): boolean {
  return code === COMPUTER_KEYBOARD_OCTAVE_DOWN || code === COMPUTER_KEYBOARD_OCTAVE_UP || Object.prototype.hasOwnProperty.call(COMPUTER_KEYBOARD_NOTES, code)
}

export function clampOctave(octave: number): number {
  if (!Number.isFinite(octave)) return COMPUTER_KEYBOARD_DEFAULT_OCTAVE
  return Math.min(COMPUTER_KEYBOARD_MAX_OCTAVE, Math.max(COMPUTER_KEYBOARD_MIN_OCTAVE, Math.round(octave)))
}

/** Lo que se usa de un KeyboardEvent. */
export interface ComputerKeyEvent {
  code: string
  repeat?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export type ComputerKeyAction =
  | { type: 'note_on'; pitch: number; velocity: number }
  | { type: 'note_off'; pitch: number }
  | { type: 'octave'; octave: number }

export interface ComputerKeyboard {
  readonly octave: number
  /** Accion de una tecla apretada, o null si no hace nada (la interfaz no la consume). */
  keyDown(event: ComputerKeyEvent): ComputerKeyAction | null
  /** note_off de una tecla soltada que estaba sonando, o null. */
  keyUp(event: ComputerKeyEvent): ComputerKeyAction | null
  setOctave(octave: number): void
  /** Suelta todo lo que sigue apretado (al perder el foco o apagar el teclado musical). */
  releaseAll(): ComputerKeyAction[]
}

export function createComputerKeyboard(initialOctave = COMPUTER_KEYBOARD_DEFAULT_OCTAVE): ComputerKeyboard {
  let octave = clampOctave(initialOctave)
  /** code -> pitch con el que sono. */
  const held = new Map<string, number>()

  return {
    get octave() {
      return octave
    },
    keyDown(event: ComputerKeyEvent): ComputerKeyAction | null {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
      if (event.code === COMPUTER_KEYBOARD_OCTAVE_DOWN || event.code === COMPUTER_KEYBOARD_OCTAVE_UP) {
        if (event.repeat) return null
        const next = clampOctave(octave + (event.code === COMPUTER_KEYBOARD_OCTAVE_UP ? 1 : -1))
        if (next === octave) return null
        octave = next
        return { type: 'octave', octave }
      }
      const pitch = computerKeyPitch(event.code, octave)
      if (pitch === null || event.repeat || held.has(event.code)) return null
      held.set(event.code, pitch)
      return { type: 'note_on', pitch, velocity: COMPUTER_KEYBOARD_VELOCITY }
    },
    keyUp(event: ComputerKeyEvent): ComputerKeyAction | null {
      const pitch = held.get(event.code)
      if (pitch === undefined) return null
      held.delete(event.code)
      return { type: 'note_off', pitch }
    },
    setOctave(next: number): void {
      octave = clampOctave(next)
    },
    releaseAll(): ComputerKeyAction[] {
      const out: ComputerKeyAction[] = [...held.values()].map((pitch) => ({ type: 'note_off', pitch }))
      held.clear()
      return out
    },
  }
}
