/**
 * Operaciones sobre las notas de UN clip MIDI del Estudio Bandait (piano roll, asistente,
 * grabacion y archivos .mid). Contrato: types.ts, seccion "v2 · midiOps.ts", y STUDIO_V2.md 2.4.
 *
 * Reglas:
 *   - Tiempos en beats relativos al clip. Nunca mutan la entrada: devuelven un arreglo nuevo.
 *   - El resultado siempre sale normalizado (normalizeNotes): ordenado por start y pitch, sin
 *     solapes del mismo pitch (la anterior se acorta hasta el inicio de la siguiente y, si queda
 *     con menos de STUDIO_MIDI_MIN_NOTE_BEATS, se quita), start en [0, largo del clip), pitch
 *     0..127, velocity 1..127 y tiempos redondeados con roundBeat.
 *   - La seleccion son indices en el arreglo que se recibe (el del clip, que ya esta ordenado).
 *     Un indice fuera de rango o repetido se ignora. Cada operacion devuelve la seleccion nueva.
 *   - Un argumento numerico no finito (NaN) lanza StudioSessionError `bad_type`, como sessionOps.
 *
 * Decisiones de borde que el contrato no fija:
 *   - Una nota de entrada con largo menor que el minimo sube al minimo; con start no finito, o en
 *     o despues del final del clip, se descarta. Las notas pueden pasar del final del clip (el
 *     contrato las recorta al sonar), asi que su largo no se recorta aqui.
 *   - Dos notas del mismo pitch y el mismo start: gana la que viene despues en la entrada (al
 *     agregar o duplicar, la nueva reemplaza a la vieja).
 *   - moveNotes mueve el grupo entero: el desplazamiento se acota para que ninguna nota salga del
 *     clip ni de 0..127, asi el acorde conserva su forma. transpose, en cambio, acota cada nota
 *     por separado (lo que pide el contrato), y dos notas que caen en el mismo pitch se resuelven
 *     con la regla de solape.
 *   - quantize: si la linea de rejilla mas cercana cae en o despues del final del clip se usa la
 *     anterior (la nota no se pierde por cuantizar).
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import {
  STUDIO_MAX_BEAT,
  STUDIO_MIDI_MIN_NOTE_BEATS,
  STUDIO_NOTE_EPSILON_BEATS,
  StudioSessionError,
  compareNotes,
  roundBeat,
  type StudioMidiNote,
} from './session.ts'
import type { MidiEditResult, MidiOpsApi, NoteRange, NoteSelection, QuantizeGrid, QuantizeOptions, VelocityMode } from './types.ts'

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

function finite(value: number, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new StudioSessionError('bad_type', path, 'Se esperaba un número')
  return value
}

function clampInt(value: number, min: number, max: number): number {
  const r = Math.round(value)
  return r < min ? min : r > max ? max : r
}

/** Largo del clip valido para normalizar (Infinity se admite: lo usa smf para leer un archivo). */
function clipLength(clipLengthBeats: number): number {
  if (typeof clipLengthBeats !== 'number' || Number.isNaN(clipLengthBeats)) throw new StudioSessionError('bad_type', 'length_beats', 'Se esperaba un número')
  return clipLengthBeats
}

/** Conjunto de indices validos de la seleccion; null = todos. */
function selectedSet(count: number, selection: NoteSelection | null): Set<number> {
  const set = new Set<number>()
  if (selection === null) {
    for (let i = 0; i < count; i++) set.add(i)
    return set
  }
  for (const i of selection) if (Number.isInteger(i) && i >= 0 && i < count) set.add(i)
  return set
}

interface Tagged {
  note: StudioMidiNote
  /** true = la nota se informa en la seleccion del resultado. */
  tag: boolean
}

/** Nota acotada y redondeada, o null si se descarta. */
function cleanNote(n: StudioMidiNote, clipLen: number): StudioMidiNote | null {
  if (!n || !Number.isFinite(n.start) || !Number.isFinite(n.length) || !Number.isFinite(n.pitch) || !Number.isFinite(n.velocity)) return null
  const start = Math.max(0, roundBeat(n.start))
  if (start >= clipLen) return null
  let length = roundBeat(n.length)
  if (length < STUDIO_MIDI_MIN_NOTE_BEATS) length = STUDIO_MIDI_MIN_NOTE_BEATS
  if (length > STUDIO_MAX_BEAT) length = STUDIO_MAX_BEAT
  return { pitch: clampInt(n.pitch, 0, 127), start, length, velocity: clampInt(n.velocity, 1, 127) }
}

/** Normaliza conservando la marca de cada nota (para calcular la seleccion del resultado). */
function normalizeTagged(items: readonly Tagged[], clipLen: number): MidiEditResult {
  const cleaned: Tagged[] = []
  for (const item of items) {
    const note = cleanNote(item.note, clipLen)
    if (note) cleaned.push({ note, tag: item.tag })
  }
  // sort es estable: a igual start y pitch queda primero la que venia antes.
  cleaned.sort((a, b) => compareNotes(a.note, b.note))
  const kept: (Tagged | null)[] = []
  const lastByPitch = new Map<number, number>()
  for (const item of cleaned) {
    const prevIndex = lastByPitch.get(item.note.pitch)
    if (prevIndex !== undefined) {
      const prev = kept[prevIndex]
      if (prev && item.note.start < prev.note.start + prev.note.length - STUDIO_NOTE_EPSILON_BEATS) {
        const shortened = roundBeat(item.note.start - prev.note.start)
        if (shortened < STUDIO_MIDI_MIN_NOTE_BEATS - STUDIO_NOTE_EPSILON_BEATS) kept[prevIndex] = null
        else kept[prevIndex] = { note: { ...prev.note, length: shortened }, tag: prev.tag }
      }
    }
    lastByPitch.set(item.note.pitch, kept.length)
    kept.push(item)
  }
  const notes: StudioMidiNote[] = []
  const selection: number[] = []
  for (const item of kept) {
    if (!item) continue
    if (item.tag) selection.push(notes.length)
    notes.push(item.note)
  }
  return { notes, selection }
}

/** Aplica `edit` a las notas seleccionadas y normaliza; la seleccion son las mismas notas. */
function editSelected(
  notes: readonly StudioMidiNote[],
  selection: NoteSelection | null,
  clipLen: number,
  edit: (note: StudioMidiNote) => StudioMidiNote,
): MidiEditResult {
  const set = selectedSet(notes.length, selection)
  return normalizeTagged(
    notes.map((note, i) => (set.has(i) ? { note: edit(note), tag: true } : { note, tag: false })),
    clipLen,
  )
}

// ---------------------------------------------------------------------------
// Rejilla y normalizacion
// ---------------------------------------------------------------------------

const GRID_BEATS: Readonly<Record<QuantizeGrid, number>> = {
  '1/1': 4,
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125,
}

/** Rejillas del piano roll, de la mas gruesa a la mas fina. */
export const STUDIO_QUANTIZE_GRIDS: readonly QuantizeGrid[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32']

export function gridBeats(grid: QuantizeGrid, triplets: boolean): number {
  const beats = GRID_BEATS[grid]
  if (beats === undefined) throw new StudioSessionError('bad_value', 'grid', `Rejilla no admitida: "${String(grid)}"`)
  return triplets ? (beats * 2) / 3 : beats
}

export function normalizeNotes(notes: readonly StudioMidiNote[], clipLengthBeats: number): StudioMidiNote[] {
  const clipLen = clipLength(clipLengthBeats)
  return normalizeTagged(
    notes.map((note) => ({ note, tag: false })),
    clipLen,
  ).notes
}

// ---------------------------------------------------------------------------
// Edicion
// ---------------------------------------------------------------------------

export function addNotes(notes: readonly StudioMidiNote[], added: readonly StudioMidiNote[], clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  return normalizeTagged([...notes.map((note) => ({ note, tag: false })), ...added.map((note) => ({ note, tag: true }))], clipLen)
}

export function removeNotes(notes: readonly StudioMidiNote[], selection: NoteSelection): StudioMidiNote[] {
  const set = selectedSet(notes.length, selection)
  return notes.filter((_, i) => !set.has(i)).sort(compareNotes)
}

export function moveNotes(
  notes: readonly StudioMidiNote[],
  selection: NoteSelection,
  deltaBeats: number,
  deltaPitch: number,
  clipLengthBeats: number,
): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  let dBeats = finite(deltaBeats, 'delta_beats')
  let dPitch = Math.round(finite(deltaPitch, 'delta_pitch'))
  const set = selectedSet(notes.length, selection)
  if (set.size === 0) return normalizeTagged(notes.map((note) => ({ note, tag: false })), clipLen)
  let minStart = Infinity
  let maxStart = -Infinity
  let minPitch = 127
  let maxPitch = 0
  for (const i of set) {
    const n = notes[i]
    minStart = Math.min(minStart, n.start)
    maxStart = Math.max(maxStart, n.start)
    minPitch = Math.min(minPitch, n.pitch)
    maxPitch = Math.max(maxPitch, n.pitch)
  }
  // El grupo no sale del clip: la ultima nota conserva al menos el largo minimo dentro de el.
  const lastStart = Math.max(0, clipLen - STUDIO_MIDI_MIN_NOTE_BEATS)
  dBeats = Math.min(Math.max(dBeats, -minStart), Math.max(-minStart, lastStart - maxStart))
  dPitch = Math.min(Math.max(dPitch, -minPitch), 127 - maxPitch)
  return editSelected(notes, selection, clipLen, (n) => ({ ...n, start: n.start + dBeats, pitch: n.pitch + dPitch }))
}

export function resizeNotes(
  notes: readonly StudioMidiNote[],
  selection: NoteSelection,
  edge: 'start' | 'end',
  deltaBeats: number,
  clipLengthBeats: number,
): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const d = finite(deltaBeats, 'delta_beats')
  if (edge !== 'start' && edge !== 'end') throw new StudioSessionError('bad_value', 'edge', 'El borde debe ser "start" o "end"')
  return editSelected(notes, selection, clipLen, (n) => {
    if (edge === 'end') {
      const length = Math.min(STUDIO_MAX_BEAT, Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, n.length + d))
      return { ...n, length }
    }
    const end = n.start + n.length
    const latest = Math.min(end - STUDIO_MIDI_MIN_NOTE_BEATS, clipLen - STUDIO_MIDI_MIN_NOTE_BEATS)
    const start = Math.max(0, Math.min(n.start + d, Math.max(0, latest)))
    return { ...n, start, length: end - start }
  })
}

export function transpose(notes: readonly StudioMidiNote[], selection: NoteSelection | null, semitones: number, clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const st = Math.round(finite(semitones, 'semitones'))
  return editSelected(notes, selection, clipLen, (n) => ({ ...n, pitch: clampInt(n.pitch + st, 0, 127) }))
}

export function setVelocity(notes: readonly StudioMidiNote[], selection: NoteSelection | null, value: number, mode: VelocityMode): MidiEditResult {
  const v = finite(value, 'velocity')
  if (mode !== 'set' && mode !== 'add' && mode !== 'scale') throw new StudioSessionError('bad_value', 'mode', 'Modo de velocidad no admitido')
  const set = selectedSet(notes.length, selection)
  // No cambia tiempos: se normaliza con un largo de clip que no recorta nada.
  return normalizeTagged(
    notes.map((n, i) => {
      if (!set.has(i)) return { note: n, tag: false }
      const next = mode === 'set' ? v : mode === 'add' ? n.velocity + v : n.velocity * v
      return { note: { ...n, velocity: clampInt(next, 1, 127) }, tag: true }
    }),
    Infinity,
  )
}

export function quantize(notes: readonly StudioMidiNote[], selection: NoteSelection | null, options: QuantizeOptions, clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const g = gridBeats(options.grid, options.triplets === true)
  const strength = Math.min(1, Math.max(0, finite(options.strength, 'strength')))
  const ends = options.ends === true
  /** Linea de rejilla mas cercana a `beat` que quede dentro del clip. */
  const nearest = (beat: number): number => {
    const line = Math.round(beat / g) * g
    return line >= clipLen - STUDIO_NOTE_EPSILON_BEATS ? Math.floor(beat / g) * g : line
  }
  return editSelected(notes, selection, clipLen, (n) => {
    const targetStart = nearest(n.start)
    const start = n.start + (targetStart - n.start) * strength
    if (!ends) return { ...n, start }
    const end = n.start + n.length
    let targetEnd = Math.round(end / g) * g
    if (targetEnd <= targetStart + STUDIO_NOTE_EPSILON_BEATS) targetEnd = targetStart + g
    const newEnd = end + (targetEnd - end) * strength
    return { ...n, start, length: Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, newEnd - start) }
  })
}

export function legato(notes: readonly StudioMidiNote[], selection: NoteSelection | null, clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const set = selectedSet(notes.length, selection)
  const starts = [...new Set([...set].map((i) => notes[i].start))].sort((a, b) => a - b)
  return editSelected(notes, selection, clipLen, (n) => {
    const next = starts.find((s) => s > n.start + STUDIO_NOTE_EPSILON_BEATS)
    return next === undefined ? n : { ...n, length: next - n.start }
  })
}

export function duplicateNotes(notes: readonly StudioMidiNote[], selection: NoteSelection, offsetBeats: number, clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const offset = finite(offsetBeats, 'offset_beats')
  const set = selectedSet(notes.length, selection)
  const copies: Tagged[] = []
  for (const i of [...set].sort((a, b) => a - b)) {
    const start = notes[i].start + offset
    // Lo que cae fuera del clip se descarta (no se acota: seria otra nota).
    if (start < -STUDIO_NOTE_EPSILON_BEATS || start >= clipLen) continue
    copies.push({ note: { ...notes[i], start }, tag: true })
  }
  return normalizeTagged([...notes.map((note) => ({ note, tag: false })), ...copies], clipLen)
}

export function splitNotesAt(notes: readonly StudioMidiNote[], selection: NoteSelection | null, atBeat: number, clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const at = roundBeat(finite(atBeat, 'at_beat'))
  const set = selectedSet(notes.length, selection)
  const items: Tagged[] = []
  notes.forEach((n, i) => {
    if (!set.has(i)) {
      items.push({ note: n, tag: false })
      return
    }
    const left = roundBeat(at - n.start)
    const right = roundBeat(n.start + n.length - at)
    // Solo se corta si cada mitad queda con el largo minimo.
    if (left >= STUDIO_MIDI_MIN_NOTE_BEATS && right >= STUDIO_MIDI_MIN_NOTE_BEATS) {
      items.push({ note: { ...n, length: left }, tag: true })
      items.push({ note: { ...n, start: at, length: right }, tag: true })
    } else {
      items.push({ note: n, tag: true })
    }
  })
  return normalizeTagged(items, clipLen)
}

export function notesInRange(notes: readonly StudioMidiNote[], range: NoteRange): number[] {
  const a = finite(range.startBeat, 'start_beat')
  const b = finite(range.endBeat, 'end_beat')
  const lo = Math.min(finite(range.lowPitch, 'low_pitch'), finite(range.highPitch, 'high_pitch'))
  const hi = Math.max(range.lowPitch, range.highPitch)
  const from = Math.min(a, b)
  const to = Math.max(a, b)
  const out: number[] = []
  notes.forEach((n, i) => {
    if (n.pitch < lo || n.pitch > hi) return
    const end = n.start + n.length
    // Un rango de ancho cero es un punto (un clic): entra la nota que lo contiene.
    const hit = to > from ? n.start < to && end > from : n.start <= from && from < end
    if (hit) out.push(i)
  })
  return out
}

/** Seleccion invertida: los indices de las notas que no estaban elegidas (atajo Ctrl+I). */
export function invertSelection(noteCount: number, selection: NoteSelection): number[] {
  const set = selectedSet(Math.max(0, Math.floor(noteCount)), selection)
  const out: number[] = []
  for (let i = 0; i < noteCount; i++) if (!set.has(i)) out.push(i)
  return out
}

void ({
  gridBeats,
  normalizeNotes,
  addNotes,
  removeNotes,
  moveNotes,
  resizeNotes,
  transpose,
  setVelocity,
  quantize,
  legato,
  duplicateNotes,
  splitNotesAt,
  notesInRange,
} satisfies MidiOpsApi)
