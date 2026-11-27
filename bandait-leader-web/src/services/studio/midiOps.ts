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
  type StudioMidiClip,
  type StudioMidiNote,
  type StudioSession,
  type StudioTrack,
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

/**
 * Edicion generica de las notas elegidas (null = todas) con normalizacion y seleccion del
 * resultado. La usan modulos hermanos (groove.ts) para no repetir la normalizacion.
 */
export function mapSelectedNotes(
  notes: readonly StudioMidiNote[],
  selection: NoteSelection | null,
  clipLengthBeats: number,
  edit: (note: StudioMidiNote) => StudioMidiNote,
): MidiEditResult {
  return editSelected(notes, selection, clipLength(clipLengthBeats), edit)
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

/**
 * Preset de humanizacion. Los tiempos van en milisegundos (no en beats) para que el "pulso" suene
 * igual a cualquier tempo: 11 ms son 11 ms a 60 o a 160 BPM. `swing` es la fraccion del paso de la
 * subdivision que se atrasa la nota impar (0.33 = tresillo 66 %, 0.5 = puntillo 75 %). Todos los
 * valores son los de la intensidad de referencia `amount`; otra intensidad los escala en proporcion.
 */
export interface HumanizePresetSpec {
  id: HumanizePresetId
  label: string
  description: string
  amount: number
  timingMs: number
  velocityRange: number
  lengthRatio: number
  swing: number
  swingGrid: '1/8' | '1/16'
  strumMs: number
  accentStrength: number
}

/** Tope del swing: 0.5 = la nota impar cae en el 75 % del par (corchea con puntillo + semicorchea). */
export const STUDIO_HUMANIZE_MAX_SWING = 0.5
/** Topes de los parametros en milisegundos (contrato: humanize_midi_clip en studio_chat_tools_v2.json). */
export const STUDIO_HUMANIZE_MAX_TIMING_MS = 60
export const STUDIO_HUMANIZE_MAX_STRUM_MS = 60
export const STUDIO_HUMANIZE_MAX_LAID_BACK_MS = 30
/** Tempo con que se convierten ms <-> beats si la llamada no trae el de la sesion. */
const DEFAULT_HUMANIZE_BPM = 120

// Swing de los presets reescalado x2/3 el 2026-11-27: antes el desplazamiento era swing*paso*2/3;
// ahora es swing*paso, asi que el preset suena exactamente igual que antes. Los ms salen de los
// beats viejos a 120 BPM (0.022 beats = 11 ms).
export const STUDIO_HUMANIZE_PRESETS: readonly HumanizePresetSpec[] = [
  {
    id: 'pocket',
    label: 'Pocket Batería',
    description: 'Groove ajustado con acento métrico y swing de semicorchea.',
    amount: 0.45,
    timingMs: 11,
    velocityRange: 18,
    lengthRatio: 0.04,
    swing: 0.093,
    swingGrid: '1/16',
    strumMs: 0,
    accentStrength: 0.45,
  },
  {
    id: 'keys',
    label: 'Teclista Vivo',
    description: 'Micro-apertura en acordes, respiración de frase y dinámica natural.',
    amount: 0.5,
    timingMs: 16,
    velocityRange: 20,
    lengthRatio: 0.1,
    swing: 0.04,
    swingGrid: '1/16',
    strumMs: 9,
    accentStrength: 0.3,
  },
  {
    id: 'strum',
    label: 'Rasgueo Guitarra',
    description: 'Desplazamiento progresivo grave-a-agudo en acordes simultáneos.',
    amount: 0.55,
    timingMs: 14,
    velocityRange: 16,
    lengthRatio: 0.08,
    swing: 0.053,
    swingGrid: '1/8',
    strumMs: 22.5,
    accentStrength: 0.35,
  },
  {
    id: 'analog',
    label: 'Secuenciador Analógico',
    description: 'Pulso cálido con micro-deriva de reloj y acento sutil.',
    amount: 0.4,
    timingMs: 7.5,
    velocityRange: 12,
    lengthRatio: 0.06,
    swing: 0.12,
    swingGrid: '1/16',
    strumMs: 0,
    accentStrength: 0.25,
  },
]

/** Valores sin preset (equivalen a los de antes: amount*0.04 beats a 120 BPM, amount*24, amount*0.08). */
const DEFAULT_HUMANIZE_BASE: Omit<HumanizePresetSpec, 'id' | 'label' | 'description'> = {
  amount: 0.5,
  timingMs: 10,
  velocityRange: 12,
  lengthRatio: 0.04,
  swing: 0,
  swingGrid: '1/16',
  strumMs: 0,
  accentStrength: 0,
}

export function findHumanizePreset(id: unknown): HumanizePresetSpec | null {
  return typeof id === 'string' ? (STUDIO_HUMANIZE_PRESETS.find((p) => p.id === id) ?? null) : null
}

/** Parametros efectivos de una humanizacion (lo que muestra el popover y lo que aplica humanize). */
export interface ResolvedHumanize {
  amount: number
  /** Desviacion maxima del inicio, en ms (si la llamada trajo timing_beats, su equivalente al tempo dado). */
  timingMs: number
  /** La misma desviacion en beats, la que se aplica. */
  timingBeats: number
  velocityRange: number
  lengthRatio: number
  swing: number
  swingGrid: '1/8' | '1/16'
  strumMs: number
  strumBeats: number
  accentStrength: number
  beatsPerBar: number
  bpm: number
  clipStartBeat: number
  drumKit: boolean
  laidBackMs: number
}

const msToBeats = (ms: number, bpm: number): number => (ms * bpm) / 60000
const beatsToMs = (beats: number, bpm: number): number => (beats * 60000) / bpm

/**
 * Resuelve las opciones: un valor explicito es absoluto; lo que no viene sale del preset (o de los
 * valores por defecto) escalado por `amount / amount_del_preset`. Asi la intensidad escala tambien
 * el swing, el rasgueo y el acento, no solo el micro-timing. Topes: swing 0..0.5, timing 0..60 ms
 * (o 0..0.25 beats con timing_beats), strum -60..60 ms (o -0.12..0.12 beats), laid back 0..30 ms.
 */
export function resolveHumanize(options: HumanizeOptions): ResolvedHumanize {
  const preset = findHumanizePreset(options.preset)
  const base = preset ?? DEFAULT_HUMANIZE_BASE
  const amount = options.amount !== undefined ? Math.min(1, Math.max(0, finite(options.amount, 'amount'))) : base.amount
  const k = amount / Math.max(0.01, base.amount)
  const bpm = options.bpm !== undefined && finite(options.bpm, 'bpm') > 0 ? options.bpm : DEFAULT_HUMANIZE_BPM
  const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

  let timingBeats: number
  let timingMs: number
  if (options.timingMs !== undefined) {
    timingMs = clampN(finite(options.timingMs, 'timing_ms'), 0, STUDIO_HUMANIZE_MAX_TIMING_MS)
    timingBeats = msToBeats(timingMs, bpm)
  } else if (options.timingBeats !== undefined) {
    // Compatibilidad: timing_beats del asistente sigue siendo absoluto en beats.
    timingBeats = clampN(finite(options.timingBeats, 'timing_beats'), 0, 0.25)
    timingMs = beatsToMs(timingBeats, bpm)
  } else {
    timingMs = clampN(base.timingMs * k, 0, STUDIO_HUMANIZE_MAX_TIMING_MS)
    timingBeats = msToBeats(timingMs, bpm)
  }
  let strumBeats: number
  let strumMs: number
  if (options.strumMs !== undefined) {
    strumMs = clampN(finite(options.strumMs, 'strum_ms'), -STUDIO_HUMANIZE_MAX_STRUM_MS, STUDIO_HUMANIZE_MAX_STRUM_MS)
    strumBeats = msToBeats(strumMs, bpm)
  } else if (options.strumBeats !== undefined) {
    strumBeats = clampN(finite(options.strumBeats, 'strum_beats'), -0.12, 0.12)
    strumMs = beatsToMs(strumBeats, bpm)
  } else {
    strumMs = clampN(base.strumMs * k, -STUDIO_HUMANIZE_MAX_STRUM_MS, STUDIO_HUMANIZE_MAX_STRUM_MS)
    strumBeats = msToBeats(strumMs, bpm)
  }
  const velocityRange =
    options.velocityRange !== undefined ? clampN(finite(options.velocityRange, 'velocity_range'), 0, 64) : clampN(Math.round(base.velocityRange * k), 0, 64)
  const lengthRatio = options.lengthRatio !== undefined ? clampN(finite(options.lengthRatio, 'length_ratio'), 0, 0.5) : clampN(base.lengthRatio * k, 0, 0.5)
  const swing = options.swing !== undefined ? clampN(finite(options.swing, 'swing'), 0, STUDIO_HUMANIZE_MAX_SWING) : clampN(base.swing * k, 0, STUDIO_HUMANIZE_MAX_SWING)
  const swingGrid = options.swingGrid === '1/8' ? '1/8' : options.swingGrid === '1/16' ? '1/16' : base.swingGrid
  const accentStrength =
    options.accentStrength !== undefined ? clampN(finite(options.accentStrength, 'accent_strength'), 0, 1) : clampN(base.accentStrength * k, 0, 1)
  const beatsPerBar = options.beatsPerBar !== undefined ? Math.max(1, Math.round(finite(options.beatsPerBar, 'beats_per_bar'))) : 4
  const clipStartBeat = options.clipStartBeat !== undefined ? finite(options.clipStartBeat, 'clip_start_beat') : 0
  const laidBackMs = options.laidBackMs !== undefined ? clampN(finite(options.laidBackMs, 'laid_back_ms'), 0, STUDIO_HUMANIZE_MAX_LAID_BACK_MS) : 0
  return {
    amount,
    timingMs,
    timingBeats,
    velocityRange,
    lengthRatio,
    swing,
    swingGrid,
    strumMs,
    strumBeats,
    accentStrength,
    beatsPerBar,
    bpm,
    clipStartBeat,
    drumKit: options.drumKit === true,
    laidBackMs,
  }
}

/** Papel de una nota de bateria General MIDI para la humanizacion por pieza. */
export type DrumRole = 'kick' | 'snare' | 'hat' | 'tom' | 'cymbal' | 'perc'

export function drumRoleForPitch(pitch: number): DrumRole {
  if (pitch === 35 || pitch === 36) return 'kick'
  if (pitch >= 37 && pitch <= 40) return 'snare'
  if (pitch === 42 || pitch === 44 || pitch === 46) return 'hat'
  if (pitch === 41 || pitch === 43 || pitch === 45 || pitch === 47 || pitch === 48 || pitch === 50) return 'tom'
  if (pitch === 49 || pitch === 51 || pitch === 52 || pitch === 53 || pitch === 55 || pitch === 57 || pitch === 59) return 'cymbal'
  return 'perc'
}

/**
 * Cuanto de la desviacion de tiempo y de velocidad recibe cada pieza: bombo y caja mas ajustados
 * (son el ancla del groove), hi-hat con mas variacion de velocidad (la mano derecha nunca pega
 * dos veces igual), platos y toms intermedios.
 */
const DRUM_FEEL: Readonly<Record<DrumRole, { timing: number; velocity: number }>> = {
  kick: { timing: 0.45, velocity: 0.55 },
  snare: { timing: 0.6, velocity: 0.75 },
  hat: { timing: 1, velocity: 1.6 },
  tom: { timing: 0.8, velocity: 1 },
  cymbal: { timing: 0.9, velocity: 0.8 },
  perc: { timing: 1, velocity: 1 },
}

/** Caja "laid back": golpes de caja y palmas (38, 39, 40), no el aro (37). */
const isLaidBackSnare = (pitch: number) => pitch === 38 || pitch === 39 || pitch === 40

/**
 * Posicion de swing de una nota: si cae en la subdivision impar (o donde ya la dejo un swing
 * anterior), devuelve el beat de sesion donde debe quedar (`par + paso * (1 + swing)`); si no, null.
 * Es idempotente: una nota ya movida al mismo swing vuelve al mismo sitio.
 */
export function swingTargetBeat(sessionBeat: number, swing: number, swingGrid: '1/8' | '1/16'): number | null {
  if (!(swing > 0)) return null
  const step = swingGrid === '1/8' ? 0.5 : 0.25
  const pair = 2 * step
  // La nota un poco adelantada (hasta 0.3 de paso) sigue perteneciendo a su par.
  const pairIdx = Math.floor((sessionBeat + 0.3 * step) / pair + 1e-9)
  const r = (sessionBeat - pairIdx * pair) / step
  // Zona impar: desde 0.35 de paso antes de la recta hasta 0.15 de paso despues del swing maximo.
  if (r < 0.65 || r >= 1 + STUDIO_HUMANIZE_MAX_SWING + 0.15) return null
  return pairIdx * pair + step * (1 + swing)
}

/** Contexto de humanizacion de un clip: su posicion, el tempo, el compas y si es bateria. */
export function humanizeClipContext(
  session: Pick<StudioSession, 'bpm' | 'beatsPerBar'>,
  loc: { clip: Pick<StudioMidiClip, 'startBeat'>; track: Pick<StudioTrack, 'instrument'> },
): Pick<HumanizeOptions, 'clipStartBeat' | 'bpm' | 'beatsPerBar' | 'drumKit'> {
  return {
    clipStartBeat: loc.clip.startBeat,
    bpm: session.bpm,
    beatsPerBar: session.beatsPerBar,
    drumKit: loc.track.instrument?.type === 'drums',
  }
}

export function humanize(notes: readonly StudioMidiNote[], selection: NoteSelection | null, options: HumanizeOptions, clipLengthBeats: number): MidiEditResult {
  const clipLen = clipLength(clipLengthBeats)
  const r = resolveHumanize(options)
  const { timingBeats, velocityRange, lengthRatio, swing, swingGrid, accentStrength, clipStartBeat, drumKit } = r
  // El rasgueo no tiene sentido en una bateria: bombo y hi-hat juntos no son un acorde.
  const strumBeats = drumKit ? 0 : r.strumBeats
  const laidBackBeats = drumKit ? msToBeats(r.laidBackMs, r.bpm) : 0
  const bpb = r.beatsPerBar

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

  return normalizeTagged(
    notes.map((n, i) => {
      if (!set.has(i)) return { note: n, tag: false }
      // Fase musical: beat de la sesion, no del clip (un clip que empieza a mitad de compas o en
      // un contratiempo acentua y swinguea los tiempos correctos).
      const phase = clipStartBeat + n.start
      const role: DrumRole | null = drumKit ? drumRoleForPitch(n.pitch) : null
      const feel = role ? DRUM_FEEL[role] : { timing: 1, velocity: 1 }

      // 1. Swing idempotente: la subdivision impar se coloca en rejilla + swing (no se suma).
      const swingAt = swingTargetBeat(phase, swing, swingGrid)
      const base = swingAt === null ? n.start : swingAt - clipStartBeat

      // 2. Micro-timing: deriva de frase + jitter individual (en ms convertidos) + strum + laid back.
      const drift = groupDriftByIdx.get(i) ?? 0
      const jitter = timingBeats > 0 ? (0.45 * drift + 0.55 * triRandom(rng)) * timingBeats * feel.timing : 0
      const strumDelta = strumOffsetByIdx.get(i) ?? 0
      const laidBack = laidBackBeats > 0 && isLaidBackSnare(n.pitch) ? laidBackBeats : 0
      const start = Math.min(lastStart, Math.max(0, base + strumDelta + jitter + laidBack))

      // 3. Acento metrico + variacion organica de velocidad.
      let accentVel = 0
      if (accentStrength > 0) {
        const inBar = ((phase % bpb) + bpb) % bpb
        if (role === 'hat') {
          // Hi-hat: corcheas fuertes (mas aun en el tiempo), semicorcheas intermedias suaves.
          const onEighth = Math.abs(inBar * 2 - Math.round(inBar * 2)) <= 0.16
          const onBeat = Math.abs(inBar - Math.round(inBar)) <= 0.08
          accentVel = onBeat ? Math.round(accentStrength * 12) : onEighth ? Math.round(accentStrength * 6) : -Math.round(accentStrength * 10)
        } else {
          const distDownbeat = Math.min(inBar, Math.abs(bpb - inBar))
          const distHalf = bpb >= 2 ? Math.abs(inBar - bpb / 2) : 99
          if (distDownbeat <= 0.08) accentVel = Math.round(accentStrength * 14)
          else if (distHalf <= 0.08) accentVel = Math.round(accentStrength * 7)
          else if (Math.abs(inBar - Math.round(inBar)) > 0.2) accentVel = -Math.round(accentStrength * 5)
        }
      }
      const deltaVel = (velocityRange > 0 ? triRandom(rng) * velocityRange * feel.velocity : 0) + accentVel + (strumVelByIdx.get(i) ?? 0)
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
