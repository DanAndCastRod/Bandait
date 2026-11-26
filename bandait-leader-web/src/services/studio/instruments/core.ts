/**
 * Logica pura de los instrumentos del Estudio v2 (STUDIO_V2.md 2.3 y 2.4). Sin DOM ni Web Audio:
 * se prueba con node --experimental-strip-types. Los modulos de sonido (synth, drums, sampler,
 * voices, schedule) programan exactamente lo que aqui se calcula.
 *
 * Contenido:
 *   - frecuencias y ganancias: noteFrequency, oscillatorFrequency, velocityGain, biquadQ,
 *     filterEnvelopeCents;
 *   - envolventes: adsrFromMs, envelopeTau, envelopeLevelAt, envelopeSilentAfterS;
 *   - robo de voz: pickVoiceToSteal (STUDIO_V2.md 2.3, "Polifonia");
 *   - ruido con semilla: mulberry32, fillNoise, noiseOffsetS;
 *   - notas que suenan en un tramo: clipNoteSpans, planMidiNotes, midiEndSeconds;
 *   - caja de ritmos: DRUM_VOICE_SPECS, drumParam, drumHitGain, drumDecayS, drumTuneRatio,
 *     drumChokes, drumLanes;
 *   - sampler: samplerZonesFor, samplerPlaybackRate;
 *   - sesion: instrumentKey, midiClipsEqual, instrumentTailSeconds.
 */
import { dbToGain } from '../../stemTiming.ts'
import {
  STUDIO_DRUM_VOICES,
  STUDIO_DRUM_VOICE_LABELS,
  STUDIO_DRUM_VOICE_NOTES,
  STUDIO_NOTE_EPSILON_BEATS,
  beatsToSeconds,
  drumVoiceForPitch,
  secondsToBeats,
  type DrumVoice,
  type DrumsParams,
  type StudioInstrument,
  type StudioMidiClip,
  type StudioSamplerZone,
  type StudioSession,
  type StudioTrack,
  type SynthFilterType,
} from '../session.ts'
import type { DrumLane, VoiceInfo } from '../types.ts'

// ---------------------------------------------------------------------------
// Frecuencias y ganancias
// ---------------------------------------------------------------------------

/** 440 * 2^((pitch - 69) / 12). */
export function noteFrequency(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

/** Frecuencia de un oscilador del synth: nota * 2^octava * 2^(cents / 1200) (STUDIO_V2.md 2.3.1). */
export function oscillatorFrequency(pitch: number, octave: number, detuneCents: number): number {
  return noteFrequency(pitch) * Math.pow(2, octave) * Math.pow(2, detuneCents / 1200)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))
}

/** Ganancia por velocidad: 1 - sens * (1 - velocity / 127). Velocidad 1..127, sens 0..1. */
export function velocityGain(velocity: number, sensitivity: number): number {
  const v = clamp(velocity, 1, 127)
  const s = clamp(sensitivity, 0, 1)
  return 1 - s * (1 - v / 127)
}

/**
 * Valor del AudioParam `Q` de un BiquadFilterNode para un factor de calidad del contrato. En
 * pasa bajos y pasa altos Web Audio lo interpreta en dB (altura del pico de resonancia): Q 0.707
 * es -3 dB (Butterworth) y Q 1 es 0 dB. En pasa banda es el factor de calidad tal cual.
 */
export function biquadQ(type: SynthFilterType, q: number): number {
  const safe = clamp(q, 0.0001, 1000)
  return type === 'bandpass' ? safe : 20 * Math.log10(safe)
}

/** Corte minimo y maximo del filtro (STUDIO_V2.md 2.3.1). */
export const FILTER_MIN_HZ = 20
export const FILTER_MAX_HZ = 20000

/**
 * Cents que la envolvente del filtro mueve el corte en su punto maximo: `octaves * 1200`, acotado
 * para que `cutoffHz * 2^(cents / 1200)` quede en 20..20000 Hz. El LFO se suma en el nodo y no
 * pasa por este tope (NO acotado: el nodo solo limita a la frecuencia de Nyquist).
 */
export function filterEnvelopeCents(cutoffHz: number, octaves: number): number {
  const base = clamp(cutoffHz, FILTER_MIN_HZ, FILTER_MAX_HZ)
  const cents = (Number.isFinite(octaves) ? octaves : 0) * 1200
  const up = 1200 * Math.log2(FILTER_MAX_HZ / base)
  const down = 1200 * Math.log2(FILTER_MIN_HZ / base)
  return Math.min(up, Math.max(down, cents))
}

// ---------------------------------------------------------------------------
// Envolventes
// ---------------------------------------------------------------------------

/** Ataque minimo: un ataque de 0 ms haria clic. */
export const ENVELOPE_MIN_ATTACK_S = 0.001
/**
 * Decaimiento y relajacion son exponenciales (setTargetAtTime) con constante de tiempo
 * `tiempo / ENVELOPE_TIME_DIVISOR`: al tiempo nominal el nivel recorrio el 99.3 %.
 */
export const ENVELOPE_TIME_DIVISOR = 5
/**
 * Multiplo del tiempo nominal en que una relajacion (o un decaimiento a sustain 0) se da por
 * terminado: e^-7, unos -61 dB. Ahi la voz se apaga con la rampa de robo y libera su lugar.
 */
export const ENVELOPE_TAIL_FACTOR = 1.4

export interface AdsrSeconds {
  attackS: number
  decayS: number
  /** 0..1. */
  sustain: number
  releaseS: number
}

/** Envolvente en segundos desde los parametros en ms del contrato (con el ataque minimo). */
export function adsrFromMs(attackMs: number, decayMs: number, sustain: number, releaseMs: number): AdsrSeconds {
  return {
    attackS: Math.max(ENVELOPE_MIN_ATTACK_S, clamp(attackMs, 0, 10000) / 1000),
    decayS: clamp(decayMs, 0, 10000) / 1000,
    sustain: clamp(sustain, 0, 1),
    releaseS: clamp(releaseMs, 0, 10000) / 1000,
  }
}

/** Constante de tiempo de setTargetAtTime para un tramo de `seconds` (nunca 0). */
export function envelopeTau(seconds: number): number {
  return Math.max(seconds / ENVELOPE_TIME_DIVISOR, 0.0001)
}

/**
 * Nivel 0..1 de la envolvente `t` segundos despues del inicio de la nota. `releaseAfterS` son los
 * segundos desde el inicio hasta el note-off (null = sigue sostenida). Es la curva que programan
 * las voces: ataque lineal 0 -> 1; decaimiento exponencial hacia `sustain`; y al note-off una
 * etapa aparte que multiplica por una exponencial hacia 0 (la relajacion parte del nivel que haya
 * en ese instante, sin cancelar automatizaciones).
 */
export function envelopeLevelAt(env: AdsrSeconds, t: number, releaseAfterS: number | null): number {
  if (!(t >= 0)) return 0
  let level: number
  if (t < env.attackS) level = t / env.attackS
  else level = env.sustain + (1 - env.sustain) * Math.exp(-(t - env.attackS) / envelopeTau(env.decayS))
  if (releaseAfterS !== null && t > releaseAfterS) level *= Math.exp(-(t - releaseAfterS) / envelopeTau(env.releaseS))
  return level
}

/**
 * Segundos desde el inicio de la nota hasta que la voz queda en silencio (-61 dB): el fin de la
 * relajacion, o antes si el sustain es 0 y el decaimiento ya la apago. `releaseAfterS` null =
 * sostenida: Infinity salvo con sustain 0.
 */
export function envelopeSilentAfterS(env: AdsrSeconds, releaseAfterS: number | null): number {
  const released = releaseAfterS === null ? Number.POSITIVE_INFINITY : Math.max(0, releaseAfterS) + env.releaseS * ENVELOPE_TAIL_FACTOR
  const decayed = env.sustain === 0 && env.decayS > 0 ? env.attackS + env.decayS * ENVELOPE_TAIL_FACTOR : Number.POSITIVE_INFINITY
  return Math.min(released, decayed)
}

// ---------------------------------------------------------------------------
// Robo de voz
// ---------------------------------------------------------------------------

/**
 * Indice de la voz a robar (STUDIO_V2.md 2.3): entre las voces en relajacion, la mas antigua; si
 * ninguna esta en relajacion, la mas antigua de todas; a igual antiguedad, la de menor velocidad
 * (y a igualdad total, la primera de la lista). -1 con la lista vacia.
 */
export function pickVoiceToSteal(voices: readonly VoiceInfo[]): number {
  const anyReleased = voices.some((v) => v.releasedAt !== null)
  let best = -1
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i]
    if (anyReleased && v.releasedAt === null) continue
    if (best < 0) {
      best = i
      continue
    }
    const b = voices[best]
    if (v.startedAt < b.startedAt || (v.startedAt === b.startedAt && v.velocity < b.velocity)) best = i
  }
  return best
}

// ---------------------------------------------------------------------------
// Ruido con semilla (determinista: nada de Math.random en el audio)
// ---------------------------------------------------------------------------

/** Generador mulberry32: la misma semilla da siempre la misma serie en [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Semilla fija del ruido de los instrumentos. */
export const NOISE_SEED = 0x5eed2026
/** Largo del bufer de ruido, en segundos (se reproduce en bucle). */
export const NOISE_SECONDS = 2

/** Llena `data` con ruido blanco -1..1 de la semilla dada. */
export function fillNoise(data: Float32Array, seed: number = NOISE_SEED): void {
  const next = mulberry32(seed)
  for (let i = 0; i < data.length; i++) data[i] = next() * 2 - 1
}

/**
 * Desde donde lee el bufer de ruido una voz, en segundos: fijo por `voiceSeed` (el pitch en el
 * synth, el indice de la voz en la caja). Asi dos voces no suenan con el mismo ruido y la misma
 * nota suena igual en tiempo real y al exportar.
 */
export function noiseOffsetS(voiceSeed: number): number {
  const next = mulberry32(NOISE_SEED ^ Math.imul((voiceSeed | 0) + 1, 0x9e3779b1))
  return next() * (NOISE_SECONDS - 0.1)
}

// ---------------------------------------------------------------------------
// Notas que suenan en un tramo (STUDIO_V2.md 2.4)
// ---------------------------------------------------------------------------

/** Una nota que suena, en beats de la sesion. `endBeat` ya esta recortado al final del clip. */
export interface NoteSpan {
  pitch: number
  velocity: number
  startBeat: number
  endBeat: number
}

/**
 * Notas de un clip que EMPIEZAN en [fromBeat, toBeat) (beats de la sesion), con repeticion y
 * recorte: con `loop` el patron [0, loop_beats) se repite hasta el final del clip, solo cuentan
 * las notas con start < loop_beats y una nota que cruza loop_beats suena entera en su vuelta;
 * toda nota se recorta al final del clip. Con `chase` se agregan tambien las que empezaron antes
 * de `fromBeat` y siguen sonando ahi (arrancar a mitad de una nota larga). Ordenadas por inicio y
 * pitch.
 */
export function clipNoteSpans(clip: StudioMidiClip, fromBeat: number, toBeat: number, chase: boolean): NoteSpan[] {
  const spans: NoteSpan[] = []
  const length = clip.lengthBeats
  if (!(length > 0) || clip.notes.length === 0) return spans
  const r0 = fromBeat - clip.startBeat
  const r1 = Math.min(toBeat - clip.startBeat, length)
  const chaseFrom = chase && r0 > 0 && r0 < length
  if (!(r1 > Math.max(0, r0)) && !chaseFrom) return spans
  const eps = STUDIO_NOTE_EPSILON_BEATS
  const push = (pitch: number, velocity: number, s: number, noteLength: number) => {
    if (s >= length - eps) return
    const e = Math.min(s + noteLength, length)
    const starts = s >= r0 && s < r1
    const sounding = chaseFrom && s < r0 && e > r0
    if (starts || sounding) spans.push({ pitch, velocity, startBeat: clip.startBeat + s, endBeat: clip.startBeat + e })
  }
  const pattern = clip.loop && clip.loopBeats > 0 && clip.loopBeats < length ? clip.loopBeats : 0
  if (pattern === 0) {
    for (const note of clip.notes) push(note.pitch, note.velocity, note.start, note.length)
  } else {
    const notes = clip.notes.filter((n) => n.start < pattern)
    let maxLength = 0
    for (const n of notes) maxLength = Math.max(maxLength, n.length)
    const lowest = chaseFrom ? Math.max(0, r0 - maxLength) : Math.max(0, r0)
    const firstK = Math.max(0, Math.floor(lowest / pattern) - 1)
    const upper = Math.min(length, Math.max(r1, chaseFrom ? r0 : r1))
    for (let k = firstK; k * pattern < upper; k++) {
      const base = k * pattern
      for (const n of notes) push(n.pitch, n.velocity, base + n.start, n.length)
    }
  }
  spans.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  return spans
}

/** Una nota lista para programar, en segundos de la sesion. */
export interface PlannedNote {
  trackId: string
  clipId: string
  pitch: number
  velocity: number
  /** Inicio real de la nota; si es menor que `fromS` la nota viene de un `chase`. */
  startS: number
  /** Note-off, recortado al final del clip y a `untilS`. */
  endS: number
}

export interface PlanMidiOptions {
  /** Tramo de inicios: notas que empiezan en [fromS, toS). */
  fromS: number
  toS: number
  /** Nada suena despues de este segundo (fin de una repeticion): las notas se cortan aqui. */
  untilS?: number
  /** Solo estas pistas. */
  trackIds?: ReadonlySet<string>
  /** Agrega las notas que empezaron antes de `fromS` y siguen sonando (no en la caja de ritmos). */
  chase: boolean
}

/**
 * Notas de los clips MIDI de las pistas de instrumento que empiezan en [fromS, toS), convertidas a
 * segundos con el bpm de la sesion. Ventanas contiguas (el `toS` de una es el `fromS` de la
 * siguiente) no repiten ni se saltan ninguna nota. La caja de ritmos no hace `chase`: un golpe a
 * medias no tiene sentido. Ordenadas por inicio, pitch y pista.
 */
export function planMidiNotes(session: StudioSession, options: PlanMidiOptions): PlannedNote[] {
  const planned: PlannedNote[] = []
  const bpm = session.bpm
  if (!(bpm > 0) || !Number.isFinite(options.fromS)) return planned
  const untilS = options.untilS ?? Number.POSITIVE_INFINITY
  const toS = Math.min(options.toS, untilS)
  const fromBeat = secondsToBeats(options.fromS, bpm)
  const toBeat = Number.isFinite(toS) ? secondsToBeats(toS, bpm) : Number.POSITIVE_INFINITY
  if (!(toBeat > fromBeat) && !options.chase) return planned
  for (const track of session.tracks) {
    if (track.kind !== 'instrument' || !track.instrument) continue
    if (options.trackIds && !options.trackIds.has(track.id)) continue
    const chase = options.chase && track.instrument.type !== 'drums'
    for (const clip of track.midiClips ?? []) {
      // Clip silenciado (STUDIO_V2.md 2.4): no suena ni al escuchar ni al exportar, que pasan por aqui.
      if (clip.muted) continue
      for (const span of clipNoteSpans(clip, fromBeat, toBeat, chase)) {
        const startS = beatsToSeconds(span.startBeat, bpm)
        if (startS >= untilS) continue
        const endS = Math.min(beatsToSeconds(span.endBeat, bpm), untilS)
        if (!(endS > startS) || endS <= options.fromS) continue
        planned.push({ trackId: track.id, clipId: clip.id, pitch: span.pitch, velocity: span.velocity, startS, endS })
      }
    }
  }
  planned.sort((a, b) => a.startS - b.startS || a.pitch - b.pitch || (a.trackId < b.trackId ? -1 : a.trackId > b.trackId ? 1 : 0))
  return planned
}

/** Segundo en que termina el ultimo clip MIDI que suena de las pistas dadas (o de todas); 0 sin clips. */
export function midiEndSeconds(session: StudioSession, trackIds?: ReadonlySet<string>): number {
  let end = 0
  for (const track of session.tracks) {
    if (trackIds && !trackIds.has(track.id)) continue
    for (const clip of track.midiClips ?? []) if (!clip.muted) end = Math.max(end, beatsToSeconds(clip.startBeat + clip.lengthBeats, session.bpm))
  }
  return end
}

// ---------------------------------------------------------------------------
// Caja de ritmos (STUDIO_V2.md 2.3.2). El sonido de referencia orienta; no es normativo al hertz.
// ---------------------------------------------------------------------------

export interface DrumToneSpec {
  wave: 'sine' | 'triangle'
  startHz: number
  endHz: number
  /** Segundos de la caida de frecuencia (0 = fija). */
  glideS: number
  level: number
}

export interface DrumNoiseSpec {
  filter: 'bandpass' | 'highpass'
  hz: number
  /** Factor de calidad (en pasa altos se convierte con biquadQ). */
  q: number
  level: number
}

export interface DrumVoiceSpec {
  /** Caida de referencia hasta -60 dB, en segundos (se multiplica por `<voz>_decay`). */
  decayS: number
  tone: DrumToneSpec | null
  noise: DrumNoiseSpec | null
  /** Rafagas iniciales separadas `burstGapS` (palmas: 3). */
  bursts: number
  burstGapS: number
}

export const DRUM_VOICE_SPECS: Readonly<Record<DrumVoice, DrumVoiceSpec>> = {
  kick: { decayS: 0.4, tone: { wave: 'sine', startHz: 150, endHz: 50, glideS: 0.05, level: 1 }, noise: null, bursts: 1, burstGapS: 0 },
  snare: {
    decayS: 0.18,
    tone: { wave: 'triangle', startHz: 185, endHz: 185, glideS: 0, level: 0.5 },
    noise: { filter: 'bandpass', hz: 1800, q: 0.9, level: 0.9 },
    bursts: 1,
    burstGapS: 0,
  },
  clap: { decayS: 0.2, tone: null, noise: { filter: 'bandpass', hz: 1200, q: 1.4, level: 1 }, bursts: 3, burstGapS: 0.01 },
  hat_closed: { decayS: 0.05, tone: null, noise: { filter: 'highpass', hz: 7000, q: 0.707, level: 0.7 }, bursts: 1, burstGapS: 0 },
  hat_open: { decayS: 0.35, tone: null, noise: { filter: 'highpass', hz: 7000, q: 0.707, level: 0.6 }, bursts: 1, burstGapS: 0 },
  tom_low: { decayS: 0.35, tone: { wave: 'sine', startHz: 140, endHz: 100, glideS: 0.12, level: 1 }, noise: null, bursts: 1, burstGapS: 0 },
  tom_mid: { decayS: 0.3, tone: { wave: 'sine', startHz: 210, endHz: 150, glideS: 0.1, level: 1 }, noise: null, bursts: 1, burstGapS: 0 },
  tom_high: { decayS: 0.25, tone: { wave: 'sine', startHz: 300, endHz: 220, glideS: 0.08, level: 1 }, noise: null, bursts: 1, burstGapS: 0 },
  cymbal: { decayS: 1.5, tone: null, noise: { filter: 'highpass', hz: 5000, q: 0.707, level: 0.5 }, bursts: 1, burstGapS: 0 },
}

/** Rampa de subida de un golpe (sin ella el primer frente hace clic). */
export const DRUM_ATTACK_S = 0.001

function camelVoice(voice: DrumVoice): string {
  return voice.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

/** Parametro de una voz: drumParam(params, 'hat_closed', 'LevelDb') = params.hatClosedLevelDb. */
export function drumParam(params: DrumsParams, voice: DrumVoice, suffix: 'LevelDb' | 'Tune' | 'Decay'): number {
  const value = (params as unknown as Record<string, number>)[`${camelVoice(voice)}${suffix}`]
  if (Number.isFinite(value)) return value
  return suffix === 'Decay' ? 1 : 0
}

/** Ganancia de un golpe: nivel de la voz (-60 dB = silencio) por velocity / 127. */
export function drumHitGain(params: DrumsParams, voice: DrumVoice, velocity: number): number {
  return dbToGain(drumParam(params, voice, 'LevelDb')) * (clamp(velocity, 1, 127) / 127)
}

/** Caida del golpe en segundos (referencia por `<voz>_decay`, acotado a 0.25..4). */
export function drumDecayS(params: DrumsParams, voice: DrumVoice): number {
  return DRUM_VOICE_SPECS[voice].decayS * clamp(drumParam(params, voice, 'Decay'), 0.25, 4)
}

/** Multiplicador de frecuencias y filtros por `<voz>_tune` (semitonos, -12..12). */
export function drumTuneRatio(params: DrumsParams, voice: DrumVoice): number {
  return Math.pow(2, clamp(drumParam(params, voice, 'Tune'), -12, 12) / 12)
}

/** Segundos que suena un golpe desde su inicio (rafagas, caida y rampa de apagado). */
export function drumHitSeconds(params: DrumsParams, voice: DrumVoice): number {
  const spec = DRUM_VOICE_SPECS[voice]
  return (spec.bursts - 1) * spec.burstGapS + DRUM_ATTACK_S + drumDecayS(params, voice)
}

/**
 * true si un golpe nuevo de `pitch` corta a una voz que suena con `otherPitch`: la misma voz se
 * reinicia, y el hi-hat cerrado corta al abierto.
 */
export function drumChokes(pitch: number, otherPitch: number): boolean {
  const voice = drumVoiceForPitch(pitch)
  const other = drumVoiceForPitch(otherPitch)
  if (!voice || !other) return false
  return voice === other || (voice === 'hat_closed' && other === 'hat_open')
}

/** Carriles del piano roll en modo percusion: una fila por voz con su nota canonica. */
export function drumLanes(): DrumLane[] {
  return STUDIO_DRUM_VOICES.map((voice) => ({ voice, pitch: STUDIO_DRUM_VOICE_NOTES[voice], label: STUDIO_DRUM_VOICE_LABELS[voice] }))
}

// ---------------------------------------------------------------------------
// Sampler (STUDIO_V2.md 2.3.3)
// ---------------------------------------------------------------------------

/** Zonas en las que suena una nota (capas): todas las que contienen su pitch y su velocidad. */
export function samplerZonesFor(zones: readonly StudioSamplerZone[], pitch: number, velocity: number): StudioSamplerZone[] {
  return zones.filter((z) => pitch >= z.lowPitch && pitch <= z.highPitch && velocity >= z.lowVelocity && velocity <= z.highVelocity)
}

/** Velocidad de lectura: 2^((pitch - root_pitch) / 12 + tune_cents / 1200). */
export function samplerPlaybackRate(zone: Pick<StudioSamplerZone, 'rootPitch' | 'tuneCents'>, pitch: number): number {
  return Math.pow(2, (pitch - zone.rootPitch) / 12 + zone.tuneCents / 1200)
}

// ---------------------------------------------------------------------------
// Sesion
// ---------------------------------------------------------------------------

/** Lo que define la topologia de un instrumento: el tipo, y en WAM tambien el plugin. */
export function instrumentKey(instrument: StudioInstrument | null): string {
  if (!instrument) return ''
  return instrument.type === 'wam' ? `wam=${instrument.pluginId}` : instrument.type
}

/**
 * true si las dos sesiones programan las mismas notas: mismos clips MIDI (por identidad o por
 * valor), mismos congelados y, si hay clips MIDI, mismo bpm. Cambios de parametros del
 * instrumento no cuentan: se aplican en caliente. El motor lo usa para no reprogramar de mas.
 */
export function midiClipsEqual(a: StudioSession, b: StudioSession): boolean {
  if (a === b || a.tracks === b.tracks) return a.bpm === b.bpm || !hasMidi(b)
  if (a.tracks.length !== b.tracks.length) return false
  if (a.bpm !== b.bpm && (hasMidi(a) || hasMidi(b))) return false
  const byId = new Map<string, StudioTrack>()
  for (const track of a.tracks) byId.set(track.id, track)
  for (const track of b.tracks) {
    const other = byId.get(track.id)
    if (!other) return false
    if ((other.frozenAssetId ?? null) !== (track.frozenAssetId ?? null)) return false
    const x = other.midiClips ?? []
    const y = track.midiClips ?? []
    if (x === y) continue
    if (x.length !== y.length) return false
    for (let i = 0; i < y.length; i++) {
      const p = x[i]
      const q = y[i]
      if (p === q) continue
      if (
        p.id !== q.id ||
        p.startBeat !== q.startBeat ||
        p.lengthBeats !== q.lengthBeats ||
        p.loop !== q.loop ||
        p.loopBeats !== q.loopBeats ||
        p.notes !== q.notes ||
        Boolean(p.muted) !== Boolean(q.muted)
      ) {
        return false
      }
    }
  }
  return true
}

/**
 * Pistas cuyas notas programadas cambian de `a` a `b` (mismo criterio que midiClipsEqual, pista por
 * pista): el motor reprograma solo esas y deja sonar las demas sin volver a atacar sus notas.
 * 'all' si cambio algo que afecta a todas (bpm con clips MIDI, pistas agregadas o quitadas).
 */
export function midiChangedTrackIds(a: StudioSession, b: StudioSession): Set<string> | 'all' {
  if (a === b || a.tracks === b.tracks) return a.bpm === b.bpm || !hasMidi(b) ? new Set() : 'all'
  if (a.tracks.length !== b.tracks.length) return 'all'
  if (a.bpm !== b.bpm && (hasMidi(a) || hasMidi(b))) return 'all'
  const byId = new Map<string, StudioTrack>()
  for (const track of a.tracks) byId.set(track.id, track)
  const changed = new Set<string>()
  for (const track of b.tracks) {
    const other = byId.get(track.id)
    if (!other) return 'all'
    const single = (t: StudioTrack): StudioSession => ({ ...b, tracks: [t] })
    if (!midiClipsEqual({ ...single(other), bpm: b.bpm }, single(track))) changed.add(track.id)
  }
  return changed
}

function hasMidi(session: StudioSession): boolean {
  return session.tracks.some((t) => (t.midiClips ?? []).length > 0)
}

/** Cola de un plugin WAM, que no se conoce: margen fijo. */
export const WAM_TAIL_S = 2

/**
 * Lo que sigue sonando un instrumento despues del ultimo note-off: relajacion del synth y del
 * sampler, caida mas larga de la caja (o la ventana completa de un sampler `one_shot`). Maximo
 * entre las pistas de instrumento con clips MIDI; 0 si no hay ninguna. Para no cortar la cola al
 * exportar.
 */
export function instrumentTailSeconds(session: StudioSession): number {
  let tail = 0
  for (const track of session.tracks) {
    const instrument = track.instrument
    if (track.kind !== 'instrument' || !instrument || (track.midiClips ?? []).length === 0) continue
    let t = 0
    if (instrument.type === 'synth') {
      t = adsrFromMs(0, 0, 1, instrument.params.ampReleaseMs).releaseS * ENVELOPE_TAIL_FACTOR
    } else if (instrument.type === 'drums') {
      for (const voice of STUDIO_DRUM_VOICES) t = Math.max(t, drumHitSeconds(instrument.params, voice))
    } else if (instrument.type === 'sampler') {
      const release = adsrFromMs(0, 0, 1, instrument.params.ampReleaseMs).releaseS * ENVELOPE_TAIL_FACTOR
      if (instrument.params.mode === 'one_shot') {
        for (const zone of instrument.zones) t = Math.max(t, zone.lengthS / samplerPlaybackRate(zone, zone.lowPitch))
      }
      t = Math.max(t, release)
    } else {
      t = WAM_TAIL_S
    }
    tail = Math.max(tail, t)
  }
  return tail
}
