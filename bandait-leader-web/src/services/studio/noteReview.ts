/**
 * Revision local de las notas que propone el asistente, ANTES de aplicarlas: avisos en espanol
 * para el musico (y para el modelo en el resultado). No bloquea nada: el musico decide.
 *
 *   - notas fuera de la tonalidad de la sesion (cuenta y porcentaje);
 *   - choque de registro con otra pista MIDI que suena en el mismo tramo;
 *   - notas fuera del rango util del instrumento (en bateria y sampler: notas que no suenan).
 *
 * Herramientas revisadas: add_midi_clip, replace_midi_notes y transpose_midi_clip. Los argumentos
 * llegan ya validados por assistantTools.checkToolArguments (snake_case, numeros acotados).
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-chat-context.ts).
 */
import { isDrumTrack, keyScale, pitchName, PITCH_CLASS_NAMES } from './chatContext.ts'
import { soundingClipNotes } from './jobs.ts'
import { STUDIO_DRUM_GM_MAP, findMidiClip, findTrack, type StudioMidiNote, type StudioSession, type StudioTrack } from './session.ts'

/** Herramientas que escriben notas. */
export const NOTE_WRITING_TOOLS: ReadonlySet<string> = new Set(['add_midi_clip', 'replace_midi_notes', 'transpose_midi_clip'])

/** Rango util por rol de pista (notas MIDI, inclusive) y como nombrarlo. */
const ROLE_RANGES: Readonly<Record<string, { low: number; high: number; label: string }>> = {
  bass: { low: 28, high: 67, label: 'un bajo' },
  guitar: { low: 40, high: 88, label: 'una guitarra' },
  vocals: { low: 48, high: 84, label: 'una voz' },
  backing_vocals: { low: 48, high: 84, label: 'una voz' },
  wind: { low: 46, high: 91, label: 'un instrumento de viento' },
  strings: { low: 28, high: 103, label: 'las cuerdas' },
}
/** Lo que suena bien en casi cualquier sintetizador: el rango del piano. */
const DEFAULT_RANGE = { low: 21, high: 108, label: 'un teclado (rango del piano)' }
const BASS_PRESETS = new Set(['bajo_sub', 'bajo_sintetico'])

/** Superposicion minima de registro, en semitonos, para avisar de un choque. */
const CLASH_MIN_SEMITONES = 5

interface ReviewTarget {
  track: StudioTrack
  /** Tramo de la sesion donde sonaran las notas. */
  fromBeat: number
  toBeat: number
  notes: Array<Pick<StudioMidiNote, 'pitch' | 'start' | 'length'>>
}

function isNoteLike(n: unknown): n is Pick<StudioMidiNote, 'pitch' | 'start' | 'length'> {
  const o = n as Record<string, unknown> | null
  return !!o && typeof o.pitch === 'number' && typeof o.start === 'number' && typeof o.length === 'number'
}

/** Pista, tramo y notas que dejaria la llamada; null si no escribe notas o no aplica. */
function targetOf(name: string, args: Readonly<Record<string, unknown>>, session: StudioSession): ReviewTarget | null {
  if (name === 'add_midi_clip') {
    const track = typeof args.track_id === 'string' ? findTrack(session, args.track_id) : null
    const start = Number(args.start_beat)
    const length = Number(args.length_beats)
    if (!track || track.kind !== 'instrument' || !Number.isFinite(start) || !(length > 0)) return null
    const notes = (Array.isArray(args.notes) ? args.notes : []).filter(isNoteLike).filter((n) => n.start < length)
    return { track, fromBeat: start, toBeat: start + length, notes }
  }
  if (name === 'replace_midi_notes' || name === 'transpose_midi_clip') {
    const loc = typeof args.clip_id === 'string' ? findMidiClip(session, args.clip_id) : null
    if (!loc) return null
    const { clip, track } = loc
    let notes: ReviewTarget['notes']
    if (name === 'replace_midi_notes') {
      notes = (Array.isArray(args.notes) ? args.notes : []).filter(isNoteLike).filter((n) => n.start < clip.lengthBeats)
    } else {
      const shift = Math.round(Number(args.semitones) || 0)
      notes = clip.notes.map((n) => ({ ...n, pitch: Math.min(127, Math.max(0, n.pitch + shift)) }))
    }
    return { track, fromBeat: clip.startBeat, toBeat: clip.startBeat + clip.lengthBeats, notes }
  }
  return null
}

function pct(part: number, total: number): string {
  return `${Math.round((part / total) * 100)} %`
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function barText(beat: number, beatsPerBar: number): number {
  return Math.floor(beat / (beatsPerBar > 0 ? beatsPerBar : 4) + 1e-9) + 1
}

/** Aviso de tonalidad: cuantas notas (y que clases de altura) quedan fuera de la de la sesion. */
function keyWarning(target: ReviewTarget, session: StudioSession): string | null {
  const scale = keyScale(session.key)
  if (!scale || target.notes.length === 0) return null
  const outside = target.notes.filter((n) => !scale.pitchClasses.has(((n.pitch % 12) + 12) % 12))
  if (outside.length === 0) return null
  const classes = [...new Set(outside.map((n) => ((n.pitch % 12) + 12) % 12))].sort((a, b) => a - b).map((pc) => PITCH_CLASS_NAMES[pc])
  return `${outside.length} de ${plural(target.notes.length, 'nota', 'notas')} (${pct(outside.length, target.notes.length)}) quedan fuera de la tonalidad ${session.key} (${classes.join(', ')}).`
}

/** Aviso de rango: notas que no suenan (bateria, sampler) o fuera del rango util del instrumento. */
function rangeWarning(target: ReviewTarget, drums: boolean): string | null {
  const { track, notes } = target
  if (notes.length === 0) return null
  if (drums) {
    const silent = notes.filter((n) => STUDIO_DRUM_GM_MAP[n.pitch] === undefined).length
    return silent ? `${silent} de ${plural(notes.length, 'nota', 'notas')} no son golpes de la caja de ritmos (General MIDI 35 a 59): no van a sonar.` : null
  }
  const instrument = track.instrument
  if (instrument?.type === 'sampler') {
    if (instrument.zones.length === 0) return 'El sampler de esta pista no tiene muestras: las notas no van a sonar hasta que agregues zonas.'
    const silent = notes.filter((n) => !instrument.zones.some((z) => n.pitch >= z.lowPitch && n.pitch <= z.highPitch)).length
    return silent ? `${silent} de ${plural(notes.length, 'nota', 'notas')} no tienen muestra en el sampler: no van a sonar.` : null
  }
  const bassPreset = instrument?.type === 'synth' && instrument.preset !== null && BASS_PRESETS.has(instrument.preset)
  const range = bassPreset ? ROLE_RANGES.bass : ROLE_RANGES[track.role] ?? DEFAULT_RANGE
  const out = notes.filter((n) => n.pitch < range.low || n.pitch > range.high)
  if (out.length === 0) return null
  const lowest = Math.min(...out.map((n) => n.pitch))
  const highest = Math.max(...out.map((n) => n.pitch))
  const span = lowest === highest ? pitchName(lowest) : `de ${pitchName(lowest)} a ${pitchName(highest)}`
  return `${out.length} de ${plural(notes.length, 'nota', 'notas')} quedan fuera del rango útil de ${range.label} (${pitchName(range.low)} a ${pitchName(range.high)}): ${span}.`
}

/** Avisos de choque de registro con otras pistas MIDI (no bateria, sin mute) en el mismo tramo. */
function clashWarnings(target: ReviewTarget, session: StudioSession): string[] {
  if (target.notes.length === 0) return []
  const low = Math.min(...target.notes.map((n) => n.pitch))
  const high = Math.max(...target.notes.map((n) => n.pitch))
  const out: string[] = []
  for (const other of session.tracks) {
    if (other.id === target.track.id || other.kind !== 'instrument' || other.mute || isDrumTrack(other)) continue
    const sounding = other.midiClips.flatMap((clip) => soundingClipNotes(clip, target.fromBeat, target.toBeat))
    if (sounding.length === 0) continue
    const otherLow = Math.min(...sounding.map((n) => n.pitch))
    const otherHigh = Math.max(...sounding.map((n) => n.pitch))
    const overlap = Math.min(high, otherHigh) - Math.max(low, otherLow)
    const smaller = Math.min(high - low, otherHigh - otherLow)
    if (overlap < CLASH_MIN_SEMITONES && !(smaller > 0 && overlap >= smaller * 0.5 && overlap > 0)) continue
    const bpb = session.beatsPerBar
    const firstBar = barText(target.fromBeat, bpb)
    const lastBar = barText(Math.max(target.fromBeat, target.toBeat - 1e-6), bpb)
    const where = firstBar === lastBar ? `en el compás ${firstBar}` : `entre los compases ${firstBar} y ${lastBar}`
    out.push(
      `Comparte registro con "${other.name}" (${pitchName(otherLow)} a ${pitchName(otherHigh)}) ${where}: estas notas van de ${pitchName(low)} a ${pitchName(high)} y pueden taparse.`,
    )
    if (out.length >= 3) break
  }
  return out
}

/**
 * Avisos en espanol para una llamada del asistente que escribe notas; [] si no escribe notas o no
 * hay nada que avisar. Nunca lanza.
 */
export function reviewNoteCall(name: string, args: Readonly<Record<string, unknown>>, session: StudioSession): string[] {
  if (!NOTE_WRITING_TOOLS.has(name)) return []
  try {
    const target = targetOf(name, args, session)
    if (!target) return []
    const drums = isDrumTrack(target.track)
    const warnings: string[] = []
    if (!drums) {
      const key = keyWarning(target, session)
      if (key) warnings.push(key)
    }
    const range = rangeWarning(target, drums)
    if (range) warnings.push(range)
    if (!drums) warnings.push(...clashWarnings(target, session))
    return warnings
  } catch {
    return []
  }
}
