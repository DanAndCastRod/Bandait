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
import type {
  HumanizeOptions,
  HumanizePresetId,
  MidiEditResult,
  MidiOpsApi,
  NoteRange,
  NoteSelection,
  QuantizeGrid,
  QuantizeOptions,
  VelocityMode,
} from './types.ts'

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

/** PRNG determinista Mulberry32 para que las pruebas y semillas sean reproducibles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Distribucion triangular en [-1, 1] centrada en 0 (mas organica que ruido uniforme). */
function triRandom(rng: () => number): number {
  return rng() + rng() - 1
}

export interface HumanizePresetSpec {
  id: HumanizePresetId
  label: string
  description: string
  amount: number
  timingBeats: number
  velocityRange: number
  lengthRatio: number
  swing: number
  swingGrid: '1/8' | '1/16'
  strumBeats: number
  accentStrength: number
}

export const STUDIO_HUMANIZE_PRESETS: readonly HumanizePresetSpec[] = [
  {
    id: 'pocket',
    label: 'Pocket Batería',
    description: 'Groove ajustado con acento métrico y swing de semicorchea.',
    amount: 0.45,
    timingBeats: 0.022,
    velocityRange: 18,
    lengthRatio: 0.04,
    swing: 0.14,
    swingGrid: '1/16',
    strumBeats: 0,
    accentStrength: 0.45,
  },
  {
    id: 'keys',
    label: 'Teclista Vivo',
    description: 'Micro-apertura en acordes, respiración de frase y dinámica natural.',
    amount: 0.5,
    timingBeats: 0.032,
    velocityRange: 20,
    lengthRatio: 0.1,
    swing: 0.06,
    swingGrid: '1/16',
    strumBeats: 0.018,
    accentStrength: 0.3,
  },
  {
    id: 'strum',
    label: 'Rasgueo Guitarra',
    description: 'Desplazamiento progresivo grave-a-agudo en acordes simultáneos.',
    amount: 0.55,
    timingBeats: 0.028,
    velocityRange: 16,
    lengthRatio: 0.08,
    swing: 0.08,
    swingGrid: '1/8',
    strumBeats: 0.045,
    accentStrength: 0.35,
  },
  {
    id: 'analog',
    label: 'Secuenciador Analógico',
    description: 'Pulso cálido con micro-deriva de reloj y acento sutil.',
    amount: 0.4,
    timingBeats: 0.015,
    velocityRange: 12,
    lengthRatio: 0.06,
    swing: 0.18,
    swingGrid: '1/16',
    strumBeats: 0,
    accentStrength: 0.25,
  },
]

export function findHumanizePreset(id: unknown): HumanizePresetSpec | null {
  return typeof id === 'string' ? (STUDIO_HUMANIZE_PRESETS.find((p) => p.id === id) ?? null) : null
}

export function humanize(notes: readonly StudioMidiNote[], selection: NoteSelection | null, options: HumanizeOptions, clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const preset = findHumanizePreset(options.preset)
  const amount =
    options.amount !== undefined
      ? Math.min(1, Math.max(0, finite(options.amount, 'amount')))
      : (preset?.amount ?? 0.5)
  const timingBeats =
    options.timingBeats !== undefined
      ? Math.min(0.25, Math.max(0, finite(options.timingBeats, 'timing_beats')))
      : preset
        ? preset.timingBeats * (amount / Math.max(0.01, preset.amount))
        : amount * 0.04
  const velocityRange =
    options.velocityRange !== undefined
      ? Math.min(64, Math.max(0, finite(options.velocityRange, 'velocity_range')))
      : preset
        ? Math.round(preset.velocityRange * (amount / Math.max(0.01, preset.amount)))
        : Math.round(amount * 24)
  const lengthRatio =
    options.lengthRatio !== undefined
      ? Math.min(0.5, Math.max(0, finite(options.lengthRatio, 'length_ratio')))
      : preset
        ? preset.lengthRatio * (amount / Math.max(0.01, preset.amount))
        : amount * 0.08
  const swing =
    options.swing !== undefined
      ? Math.min(0.75, Math.max(0, finite(options.swing, 'swing')))
      : (preset?.swing ?? 0)
  const swingGrid = options.swingGrid === '1/8' ? '1/8' : options.swingGrid === '1/16' ? '1/16' : (preset?.swingGrid ?? '1/16')
  const strumBeats =
    options.strumBeats !== undefined
      ? Math.min(0.12, Math.max(-0.12, finite(options.strumBeats, 'strum_beats')))
      : (preset?.strumBeats ?? 0)
  const accentStrength =
    options.accentStrength !== undefined
      ? Math.min(1, Math.max(0, finite(options.accentStrength, 'accent_strength')))
      : (preset?.accentStrength ?? 0)
  const bpb = options.beatsPerBar !== undefined ? Math.max(1, Math.round(finite(options.beatsPerBar, 'beats_per_bar'))) : 4

  const rng = options.seed === undefined ? Math.random : mulberry32(Math.trunc(finite(options.seed, 'seed')))
  const lastStart = Math.max(0, clipLen - STUDIO_MIDI_MIN_NOTE_BEATS)
  const set = selectedSet(notes.length, selection)

  // Agrupar notas seleccionadas casi simultaneas (<= 0.025 beats) para rasgueo (strum) y misma inercia de mano.
  const selectedIndices = [...set].sort((a, b) => notes[a].start - notes[b].start || notes[a].pitch - notes[b].pitch)
  const strumOffsetByIdx = new Map<number, number>()
  const strumVelByIdx = new Map<number, number>()
  const groupDriftByIdx = new Map<number, number>()

  let phraseDrift = 0
  let ptr = 0
  while (ptr < selectedIndices.length) {
    const firstIdx = selectedIndices[ptr]
    const baseStart = notes[firstIdx].start
    const chordGroup: number[] = [firstIdx]
    ptr++
    while (ptr < selectedIndices.length && Math.abs(notes[selectedIndices[ptr]].start - baseStart) <= 0.025) {
      chordGroup.push(selectedIndices[ptr])
      ptr++
    }
    // Deriva temporal correlacionada AR(1) por ataque de mano/frase.
    phraseDrift = 0.62 * phraseDrift + 0.38 * triRandom(rng)
    for (const idx of chordGroup) groupDriftByIdx.set(idx, phraseDrift)

    if (chordGroup.length >= 2 && Math.abs(strumBeats) > 1e-6) {
      const byPitch = [...chordGroup].sort((a, b) => notes[a].pitch - notes[b].pitch)
      const count = byPitch.length
      const span = Math.abs(strumBeats)
      byPitch.forEach((idx, rank) => {
        const order = strumBeats >= 0 ? rank : count - 1 - rank
        const frac = count > 1 ? order / (count - 1) : 0
        strumOffsetByIdx.set(idx, frac * span)
        // Ligero realce en la ultima cuerda atacada del rasgueo.
        strumVelByIdx.set(idx, Math.round((frac - 0.5) * 6))
      })
    }
  }

  const swingStep = swingGrid === '1/8' ? 0.5 : 0.25

  return normalizeTagged(
    notes.map((n, i) => {
      if (!set.has(i)) return { note: n, tag: false }

      // 1. Swing sobre subdivisiones impares (segunda semicorchea o segunda corchea).
      let swingDelta = 0
      if (swing > 0) {
        const subIdx = Math.round(n.start / swingStep)
        const dist = Math.abs(n.start - subIdx * swingStep)
        if (subIdx % 2 === 1 && dist <= swingStep * 0.35) {
          swingDelta = swing * swingStep * (2 / 3)
        }
      }

      // 2. Micro-timing: combinacion de deriva de frase + jitter individual + strum.
      const drift = groupDriftByIdx.get(i) ?? 0
      const jitter = timingBeats > 0 ? (0.45 * drift + 0.55 * triRandom(rng)) * timingBeats : 0
      const strumDelta = strumOffsetByIdx.get(i) ?? 0
      const start = Math.min(lastStart, Math.max(0, n.start + swingDelta + strumDelta + jitter))

      // 3. Acento metrico + variacion organica de velocidad.
      let accentVel = 0
      if (accentStrength > 0) {
        const inBar = ((n.start % bpb) + bpb) % bpb
        const distDownbeat = Math.min(inBar, Math.abs(bpb - inBar))
        const distHalf = bpb >= 2 ? Math.abs(inBar - bpb / 2) : 99
        if (distDownbeat <= 0.08) accentVel = Math.round(accentStrength * 14)
        else if (distHalf <= 0.08) accentVel = Math.round(accentStrength * 7)
        else if (Math.abs(inBar - Math.round(inBar)) > 0.2) accentVel = -Math.round(accentStrength * 5)
      }
      const deltaVel = (velocityRange > 0 ? triRandom(rng) * velocityRange : 0) + accentVel + (strumVelByIdx.get(i) ?? 0)
      const velocity = clampInt(n.velocity + deltaVel, 1, 127)

      // 4. Duracion organica.
      const length = lengthRatio > 0 ? Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, n.length * (1 + triRandom(rng) * lengthRatio)) : n.length
      return { note: { ...n, start, length, velocity }, tag: true }
    }),
    clipLen,
  )
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
  humanize,
  legato,
  duplicateNotes,
  splitNotesAt,
  notesInRange,
} satisfies MidiOpsApi)
