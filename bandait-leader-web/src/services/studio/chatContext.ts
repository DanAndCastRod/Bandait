/**
 * Lo que el asistente del chat sabe de la musica (STUDIO_V2.md 4.3.2): resumen de las notas de
 * cada clip MIDI, acordes guardados en la sesion, progresion de la cancion del repertorio (sin
 * letra) y la ultima medicion de mezcla. Antes el resumen solo llevaba la estructura y el modelo
 * sugeria a ciegas.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-chat-context.ts).
 * No importa jobs.ts (jobs.ts lo importa a el).
 */
import { transposeChord } from '../chordpro.ts'
import type { Song } from '../../types/hub.ts'
import type { StudioChord, StudioMidiClip, StudioMidiNote, StudioTrack } from './session.ts'
import type { MidiClipDigest, MidiGridName, MixMetrics, SongChartSummary, TrackMixSummary } from './types.ts'

/** Notas literales por clip en el resumen: solo patrones cortos (STUDIO_V2.md 4.3.2). */
export const CHAT_SUMMARY_LITERAL_NOTES = 64
/** Acordes de la sesion en el resumen (los mas cercanos al cabezal). */
export const CHAT_SUMMARY_MAX_CHORDS = 256
export const SONG_CHART_MAX_SECTIONS = 48
export const SONG_CHART_MAX_CHORDS_TEXT = 400
const SONG_CHART_MAX_LABEL = 60

export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** "C4" para 60 (convencion del piano roll del Estudio). */
export function pitchName(pitch: number): string {
  const p = Math.round(pitch)
  return `${PITCH_CLASS_NAMES[((p % 12) + 12) % 12]}${Math.floor(p / 12) - 1}`
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

// ---------------------------------------------------------------------------
// Tonalidad
// ---------------------------------------------------------------------------

const NATURAL_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]
/** Menor natural mas la sensible (7a mayor): el V mayor es lo normal en una cancion en menor. */
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10, 11]

export interface KeyScale {
  tonic: number
  minor: boolean
  /** Clases de altura que pertenecen a la tonalidad. */
  pitchClasses: ReadonlySet<number>
}

/** "C#m", "Bb", "A minor", "F# mayor"... -> escala; null si no se reconoce. */
export function keyScale(key: string | null | undefined): KeyScale | null {
  const m = /^\s*([A-Ga-g])([#b]?)\s*(maj(?:or)?|mayor|m(?!aj)|min(?:or)?|menor)?\s*$/.exec(key ?? '')
  if (!m) return null
  const tonic = (NATURAL_PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12
  const quality = (m[3] ?? '').toLowerCase()
  const minor = quality === 'm' || quality.startsWith('min') || quality === 'menor'
  const steps = minor ? MINOR_STEPS : MAJOR_STEPS
  return { tonic, minor, pitchClasses: new Set(steps.map((s) => (tonic + s) % 12)) }
}

// ---------------------------------------------------------------------------
// Resumen de notas de un clip MIDI
// ---------------------------------------------------------------------------

const GRIDS: ReadonlyArray<[MidiGridName, number]> = [
  ['1/4', 1],
  ['1/8', 0.5],
  ['1/8t', 1 / 3],
  ['1/16', 0.25],
  ['1/16t', 1 / 6],
  ['1/32', 0.125],
]
/** Tolerancia de "cae en la rejilla", en beats (unos 5 ms a 120 BPM). */
const GRID_TOLERANCE_BEATS = 0.01
/** Fraccion de inicios que debe caer en la rejilla para que sea la dominante. */
const GRID_COVERAGE = 0.9

/** La rejilla mas gruesa en la que caen al menos el 90 % de los inicios; 'libre' si ninguna. */
export function dominantGrid(starts: readonly number[]): MidiGridName {
  if (starts.length === 0) return '1/4'
  for (const [name, step] of GRIDS) {
    const on = starts.filter((s) => {
      const r = s / step
      return Math.abs(r - Math.round(r)) * step <= GRID_TOLERANCE_BEATS
    }).length
    if (on / starts.length >= GRID_COVERAGE) return name
  }
  return 'libre'
}

/** Notas del patron que se resume: con loop, las que empiezan dentro de loopBeats. */
function patternOf(clip: StudioMidiClip): { span: number; notes: StudioMidiNote[] } {
  const looping = clip.loop && clip.loopBeats > 0 && clip.loopBeats < clip.lengthBeats
  const span = looping ? clip.loopBeats : clip.lengthBeats
  return { span, notes: clip.notes.filter((n) => n.start < span) }
}

/**
 * Marca de silencio de un clip MIDI para el resumen del chat (STUDIO_V2.md 4.3.2): `{ muted: true }`
 * si el clip esta silenciado (tecla 0) y `{}` si suena, igual que el contrato de la sesion (la
 * clave solo viaja en true). Asi el asistente sabe que ese clip se ve pero no suena, y no propone
 * cambios sobre notas que nadie escucha sin decirlo. El Worker acepta claves extra en `midi_clips`.
 */
export function midiClipMutedFlag(clip: Pick<StudioMidiClip, 'muted'>): { muted?: true } {
  return clip.muted === true ? { muted: true } : {}
}

/** true si la pista toca bateria (caja de ritmos o rol de bateria). */
export function isDrumTrack(track: Pick<StudioTrack, 'role' | 'instrument'>): boolean {
  return track.instrument?.type === 'drums' || track.role === 'drums'
}

/**
 * Resumen de las notas de un clip (STUDIO_V2.md 4.3.2, MidiDigest): clases de altura con su peso
 * por duracion (o golpes por nota en bateria), densidad, rejilla dominante, velocidad media y, si
 * el patron tiene hasta `literalMax` notas, las notas literales.
 */
export function midiClipDigest(clip: StudioMidiClip, beatsPerBar: number, drums: boolean, literalMax = CHAT_SUMMARY_LITERAL_NOTES): MidiClipDigest {
  const { span, notes } = patternOf(clip)
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4
  const durations = notes.map((n) => Math.max(0, Math.min(n.length, span - n.start)))
  const total = durations.reduce((a, b) => a + b, 0)

  let pitchClasses: Array<[string, number]> = []
  let hits: Array<[number, number]> | undefined
  if (drums) {
    const counts = new Map<number, number>()
    for (const n of notes) counts.set(n.pitch, (counts.get(n.pitch) ?? 0) + 1)
    hits = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 16)
  } else if (total > 0) {
    const weights = new Array<number>(12).fill(0)
    notes.forEach((n, i) => {
      weights[((n.pitch % 12) + 12) % 12] += durations[i]
    })
    pitchClasses = weights
      .map((w, pc): [string, number] => [PITCH_CLASS_NAMES[pc], round(w / total, 2)])
      .filter(([, w]) => w >= 0.01)
      .sort((a, b) => b[1] - a[1] || PITCH_CLASS_NAMES.indexOf(a[0] as (typeof PITCH_CLASS_NAMES)[number]) - PITCH_CLASS_NAMES.indexOf(b[0] as (typeof PITCH_CLASS_NAMES)[number]))
  }

  const digest: MidiClipDigest = {
    spanBeats: round(span, 3),
    pitchClasses,
    notesPerBar: span > 0 ? round(notes.length / (span / bpb), 1) : 0,
    grid: dominantGrid(notes.map((n) => n.start)),
    velocityMean: notes.length ? Math.round(notes.reduce((a, n) => a + n.velocity, 0) / notes.length) : null,
  }
  if (hits) digest.hits = hits
  if (literalMax > 0 && notes.length > 0 && notes.length <= literalMax) {
    digest.notes = notes.map((n, i) => [n.pitch, round(n.start, 3), round(durations[i], 3), n.velocity])
  }
  return digest
}

// ---------------------------------------------------------------------------
// Acordes de la sesion
// ---------------------------------------------------------------------------

/**
 * Acordes guardados en la sesion para el resumen: los `max` mas cercanos al cabezal, en orden de
 * beat, como [beat, largo, nombre] con 3 decimales. [] si no hay.
 */
export function sessionChordsForSummary(chords: readonly StudioChord[] | undefined, playheadBeat: number, max = CHAT_SUMMARY_MAX_CHORDS): Array<[number, number, string]> {
  if (!chords || chords.length === 0 || max <= 0) return []
  const distance = (c: StudioChord) => (playheadBeat < c.beat ? c.beat - playheadBeat : playheadBeat > c.beat + c.lengthBeats ? playheadBeat - c.beat - c.lengthBeats : 0)
  const picked =
    chords.length <= max
      ? [...chords]
      : chords
          .map((c, index) => ({ c, index, d: distance(c) }))
          .sort((a, b) => a.d - b.d || a.index - b.index)
          .slice(0, max)
          .sort((a, b) => a.index - b.index)
          .map((r) => r.c)
  return picked.map((c) => [round(c.beat, 3), round(c.lengthBeats, 3), c.name])
}

// ---------------------------------------------------------------------------
// Progresion de la cancion (ChordPro, sin letra)
// ---------------------------------------------------------------------------

/** true si el texto entre corchetes es un acorde (transposeChord solo cambia acordes). */
function isChordToken(token: string): boolean {
  return token.length > 0 && token.length <= 16 && transposeChord(token, 1) !== token
}

/**
 * Acordes de una seccion ChordPro en orden, separados por espacio, " | " entre renglones y sin
 * repetir el mismo acorde seguido. Nunca devuelve letra: solo lo que esta entre corchetes y es un
 * acorde. Recortado a 400 caracteres.
 */
export function sectionChordLine(chordpro: string, maxChars = SONG_CHART_MAX_CHORDS_TEXT): string {
  const lines: string[] = []
  let last = ''
  for (const raw of chordpro.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed || /^\{.*\}$/.test(trimmed)) continue
    const chords: string[] = []
    for (const m of trimmed.matchAll(/\[([^\]]*)\]/g)) {
      const token = m[1].trim()
      if (!isChordToken(token) || token === last) continue
      chords.push(token)
      last = token
    }
    if (chords.length) lines.push(chords.join(' '))
  }
  const text = lines.join(' | ')
  if (text.length <= maxChars) return text
  const cut = text.slice(0, maxChars - 4)
  const space = cut.lastIndexOf(' ')
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[\s|]+$/, '')} ...`
}

/**
 * Progresion de la cancion del repertorio (STUDIO_V2.md 4.3.2, SongChart): secciones con su
 * nombre, compas de inicio, largo y acordes. Sin letra. null si ninguna seccion tiene acordes.
 */
export function songChordChart(song: Pick<Song, 'title' | 'key' | 'bpm' | 'beatsPerBar' | 'sections'> | null | undefined): SongChartSummary | null {
  if (!song || !Array.isArray(song.sections)) return null
  let bar = 1
  let withChords = 0
  const sections: SongChartSummary['sections'] = []
  for (const s of song.sections) {
    const bars = Number.isFinite(s.bars) && s.bars >= 1 ? Math.round(s.bars) : 1
    if (sections.length < SONG_CHART_MAX_SECTIONS) {
      const chords = sectionChordLine(typeof s.chordpro === 'string' ? s.chordpro : '')
      if (chords) withChords++
      sections.push({ label: String(s.label ?? '').trim().slice(0, SONG_CHART_MAX_LABEL), kind: s.kind, startBar: bar, bars, chords })
    }
    bar += bars
  }
  if (withChords === 0) return null
  const key = typeof song.key === 'string' && song.key.trim() ? song.key.trim().slice(0, 12) : null
  return { title: String(song.title ?? '').slice(0, 120), key, bpm: song.bpm, beatsPerBar: song.beatsPerBar, sections }
}

// ---------------------------------------------------------------------------
// Medicion de mezcla
// ---------------------------------------------------------------------------

/**
 * Ultima medicion de mezcla hecha en el equipo (ASISTENTE DE MEZCLA o MEDIR MEZCLA). `version` es
 * la version del documento al medir (StudioController.docVersion).
 */
export interface ChatMixMeasurement {
  metrics: MixMetrics
  version: number
  /** Date.now() al terminar de medir. */
  measuredAt: number
}

export interface MixForSummary {
  mixMeasured: { fresh: boolean; masterLufs: number | null; masterTruePeakDb: number | null }
  byTrack: ReadonlyMap<string, TrackMixSummary>
}

/** Medicion lista para el resumen; `fresh` es false si el documento cambio despues de medir. */
export function mixForSummary(measurement: ChatMixMeasurement | null | undefined, currentVersion: number): MixForSummary | null {
  if (!measurement) return null
  const byTrack = new Map<string, TrackMixSummary>()
  for (const t of measurement.metrics.tracks) {
    byTrack.set(t.trackId, { lufs: t.lufs, truePeakDb: t.truePeakDb, bands: t.bands, volumeDb: t.volumeDb })
  }
  return {
    mixMeasured: {
      fresh: measurement.version === currentVersion,
      masterLufs: measurement.metrics.master.lufs,
      masterTruePeakDb: measurement.metrics.master.truePeakDb,
    },
    byTrack,
  }
}

/** Datos opcionales del resumen que no estan en el documento. */
export interface ChatSummaryExtras {
  /** Cancion del repertorio ligada a la sesion (session.songId), si se encontro. */
  song?: Pick<Song, 'title' | 'key' | 'bpm' | 'beatsPerBar' | 'sections'> | null
  /** Ultima medicion de mezcla y la version actual del documento. */
  mix?: { measurement: ChatMixMeasurement | null; version: number } | null
}
