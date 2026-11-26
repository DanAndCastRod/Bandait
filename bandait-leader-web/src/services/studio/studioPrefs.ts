/**
 * Preferencias del Estudio que dependen del equipo (no viajan con el workspace ni con la sesion).
 *
 * `recordingOnLeave`: que hace una toma en curso cuando el musico sale de la vista del Estudio.
 *  - 'continue' (por defecto, decision de Daniel Castaneda del 2026-11-26): la toma sigue
 *    grabando en segundo plano; el audio global es dueno del motor y no se corta.
 *  - 'stop': la toma se detiene al salir y lo grabado queda como clip, igual que al pulsar REC.
 *
 * Se guarda en localStorage (con try/catch: navegacion privada o almacenamiento bloqueado dejan
 * el valor por defecto) y avisa con un evento para que las pantallas abiertas se enteren.
 */

export type RecordingOnLeave = 'continue' | 'stop'

export interface StudioPrefs {
  recordingOnLeave: RecordingOnLeave
}

export const STUDIO_PREFS_STORAGE_KEY = 'bandait_studio_prefs'
export const STUDIO_PREFS_EVENT = 'bandait:studio-prefs'

export function defaultStudioPrefs(): StudioPrefs {
  return { recordingOnLeave: 'continue' }
}

/** Lectura tolerante: cualquier valor desconocido o dañado toma el valor por defecto. */
export function parseStudioPrefs(raw: unknown): StudioPrefs {
  const prefs = defaultStudioPrefs()
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return prefs
    }
  }
  if (!value || typeof value !== 'object') return prefs
  const onLeave = (value as Record<string, unknown>).recordingOnLeave
  if (onLeave === 'continue' || onLeave === 'stop') prefs.recordingOnLeave = onLeave
  return prefs
}

export function readStudioPrefs(): StudioPrefs {
  try {
    if (typeof localStorage === 'undefined') return defaultStudioPrefs()
    return parseStudioPrefs(localStorage.getItem(STUDIO_PREFS_STORAGE_KEY))
  } catch {
    return defaultStudioPrefs()
  }
}

export function writeStudioPrefs(patch: Partial<StudioPrefs>): StudioPrefs {
  const next = parseStudioPrefs({ ...readStudioPrefs(), ...patch })
  try {
    localStorage.setItem(STUDIO_PREFS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Sin almacenamiento: dura lo que la pestana.
  }
  try {
    window.dispatchEvent(new CustomEvent(STUDIO_PREFS_EVENT, { detail: next }))
  } catch {
    // Fuera del navegador (pruebas de node): no hay a quien avisar.
  }
  return next
}

/** Decide si hay que detener la toma al salir de la vista del Estudio. */
export function shouldStopRecordingOnLeave(prefs: StudioPrefs, recording: boolean): boolean {
  return recording && prefs.recordingOnLeave === 'stop'
}
