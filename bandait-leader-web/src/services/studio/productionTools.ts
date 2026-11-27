/**
 * Herramientas de produccion musical local del Estudio Bandait:
 *   1. `synthesizeClickGuideChannels` / `synthesizeClickGuideWav`: sintetiza un archivo WAV PCM de
 *      24 bits con metronomo acentuado por compas y doble pulso de aviso antes de cada marcador de
 *      seccion (cumple GEMINI.md: sintesis de onda pura, cero MP3).
 *   2. `generateChordProgressionNotes`: generador armonico de notas MIDI para progresiones comunes
 *      (`pop`, `worship`, `jazz_251`, `rock_bvii`, o directamente desde `session.chords`) con
 *      voicings `triads`, `sevenths`, `arpeggio` y `bass`.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import { encodeWavPcm } from '../wav.ts'
import { normalizeNotes } from './midiOps.ts'
import {
  STUDIO_MAX_SESSION_SECONDS,
  beatsToSeconds,
  roundBeat,
  sessionEndSeconds,
  type StudioChord,
  type StudioMarker,
  type StudioMidiNote,
  type StudioSession,
} from './session.ts'

const NOTE_SEMITONES: Readonly<Record<string, number>> = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
}

// ---------------------------------------------------------------------------
// 1. Generador de Pista de Clic + Avisos de Seccion (Sintesis de Onda)
// ---------------------------------------------------------------------------

export interface ClickGuideOptions {
  bpm: number
  beatsPerBar: number
  bars?: number
  subdivision?: 'quarter' | 'eighth'
  sampleRate?: number
  markers?: readonly StudioMarker[]
}

export function computeDefaultClickBars(session: StudioSession): number {
  const endS = sessionEndSeconds(session)
  const bpb = Math.max(1, session.beatsPerBar)
  const lastMarkerBeat = session.markers.reduce((m, mk) => Math.max(m, mk.beat + bpb * 4), 0)
  const endBeat = Math.max(bpb * 8, Math.ceil((endS * session.bpm) / 60), lastMarkerBeat)
  return Math.max(1, Math.min(512, Math.ceil(endBeat / bpb)))
}

/** Sintetiza un canal mono Float32Array con golpes de metronomo y avisos previos de seccion. */
export function synthesizeClickGuideMono(options: ClickGuideOptions): { samples: Float32Array; durationS: number } {
  const sampleRate = Math.round(options.sampleRate ?? 48000)
  const bpm = Math.max(40, Math.min(260, options.bpm))
  const bpb = Math.max(1, Math.min(12, Math.round(options.beatsPerBar)))
  const bars = Math.max(1, Math.min(512, Math.round(options.bars ?? 16)))
  const totalBeats = bars * bpb
  const rawDurationS = Math.min(STUDIO_MAX_SESSION_SECONDS, beatsToSeconds(totalBeats, bpm))
  const totalSamples = Math.max(1, Math.round(rawDurationS * sampleRate))
  const out = new Float32Array(totalSamples)

  const addToneClick = (atS: number, freqHz: number, gain: number, decayMs: number) => {
    const startIdx = Math.round(atS * sampleRate)
    if (startIdx < 0 || startIdx >= totalSamples) return
    const durSamples = Math.min(totalSamples - startIdx, Math.round((decayMs / 1000) * sampleRate))
    const tau = Math.max(1, (decayMs / 1000) * sampleRate * 0.25)
    const attack = Math.max(1, Math.round(0.0015 * sampleRate))
    for (let i = 0; i < durSamples; i++) {
      const env = (i < attack ? i / attack : 1) * Math.exp(-i / tau)
      // Fundamental + segundo parcial tipo woodblock claro en In-Ear.
      const phase = (2 * Math.PI * freqHz * i) / sampleRate
      const sample = (0.82 * Math.sin(phase) + 0.18 * Math.sin(phase * 2.42)) * gain * env
      out[startIdx + i] = Math.max(-0.98, Math.min(0.98, out[startIdx + i] + sample))
    }
  }

  const stepBeats = options.subdivision === 'eighth' ? 0.5 : 1
  for (let beat = 0; beat < totalBeats - 1e-6; beat += stepBeats) {
    const atS = beatsToSeconds(beat, bpm)
    const isIntegerBeat = Math.abs(beat - Math.round(beat)) < 1e-6
    const beatInBar = Math.round(beat) % bpb
    if (isIntegerBeat && beatInBar === 0) {
      addToneClick(atS, 1567.98, 0.78, 52) // G6 acento compas
    } else if (isIntegerBeat) {
      addToneClick(atS, 1046.5, 0.52, 40) // C6 pulso
    } else {
      addToneClick(atS, 783.99, 0.26, 28) // G5 subdivision corchea
    }
  }

  // Avisos acusticos 1 tiempo antes de cada marcador de seccion (doble pulso agudo distintivo).
  for (const marker of options.markers ?? []) {
    if (marker.beat < 1) continue
    const cueBeat = marker.beat - 1
    const cueS = beatsToSeconds(cueBeat, bpm)
    addToneClick(cueS, 2093.0, 0.45, 35)
    addToneClick(cueS + beatsToSeconds(0.25, bpm), 2349.32, 0.45, 35)
  }

  return { samples: out, durationS: totalSamples / sampleRate }
}

/** Genera un WAV PCM de 24 bits listo para guardarse como `StudioAsset` en una pista `click`. */
export function synthesizeClickGuideWav(options: ClickGuideOptions): { blob: Blob; durationS: number; sampleRate: number } {
  const sampleRate = Math.round(options.sampleRate ?? 48000)
  const { samples, durationS } = synthesizeClickGuideMono({ ...options, sampleRate })
  const wavBytes = encodeWavPcm([samples], sampleRate, 24)
  return {
    blob: new Blob([wavBytes], { type: 'audio/wav' }),
    durationS,
    sampleRate,
  }
}

// ---------------------------------------------------------------------------
// 2. Generador Armonico de Progresiones de Acordes MIDI
// ---------------------------------------------------------------------------

export type ChordProgressionPreset = 'pop_1564' | 'emotional_6415' | 'jazz_251' | 'rock_1b74' | 'from_session'
export type ChordVoicingStyle = 'triads' | 'sevenths' | 'arpeggio' | 'bass'

export function parseChordSymbol(symbol: string): { rootPc: number; intervals: number[] } {
  const m = /^([A-G][#b]?)(.*)$/.exec(symbol.trim())
  if (!m) return { rootPc: 0, intervals: [0, 4, 7] }
  const rootPc = NOTE_SEMITONES[m[1]] ?? 0
  const qual = m[2].trim()
  const isMinor = /^m(?!aj)/.test(qual) || qual.startsWith('-')
  const isDim = qual.includes('dim') || qual.includes('o')
  const isSus4 = qual.includes('sus4')
  const isSus2 = qual.includes('sus2')
  const hasMaj7 = qual.includes('maj7') || qual.includes('M7')
  const has7 = !hasMaj7 && qual.includes('7')

  let third = 4
  let fifth = 7
  if (isDim) {
    third = 3
    fifth = 6
  } else if (isMinor) {
    third = 3
  } else if (isSus4) {
    third = 5
  } else if (isSus2) {
    third = 2
  }

  const intervals = [0, third, fifth]
  if (hasMaj7) intervals.push(11)
  else if (has7) intervals.push(10)
  return { rootPc, intervals }
}

function parseKeyRootAndMinor(key: string | null): { rootPc: number; minor: boolean } {
  if (!key || !key.trim()) return { rootPc: 0, minor: false }
  const m = /^([A-G][#b]?)(m?)/.exec(key.trim())
  if (!m) return { rootPc: 0, minor: false }
  return { rootPc: NOTE_SEMITONES[m[1]] ?? 0, minor: m[2] === 'm' }
}

function buildPresetChords(
  preset: Exclude<ChordProgressionPreset, 'from_session'>,
  key: string | null,
  bars: number,
  beatsPerBar: number,
): StudioChord[] {
  const { rootPc, minor } = parseKeyRootAndMinor(key)
  // Convertir root menor a su relativo mayor para grados diatonicos si hace falta.
  const majorRoot = minor ? (rootPc + 3) % 12 : rootPc
  const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
  const deg = (semitones: number, suffix = '') => `${names[(majorRoot + semitones) % 12]}${suffix}`

  const cycle: string[] =
    preset === 'pop_1564'
      ? [deg(0), deg(7), deg(9, 'm'), deg(5)]
      : preset === 'emotional_6415'
        ? [deg(9, 'm'), deg(5), deg(0), deg(7)]
        : preset === 'jazz_251'
          ? [deg(2, 'm7'), deg(7, '7'), deg(0, 'maj7'), deg(0, 'maj7')]
          : [deg(0), deg(10), deg(5), deg(0)]

  const out: StudioChord[] = []
  for (let b = 0; b < bars; b++) {
    out.push({
      beat: b * beatsPerBar,
      lengthBeats: beatsPerBar,
      name: cycle[b % cycle.length],
    })
  }
  return out
}

export interface GenerateProgressionOptions {
  preset: ChordProgressionPreset
  voicing: ChordVoicingStyle
  key: string | null
  bars?: number
  beatsPerBar?: number
  octave?: number
  velocity?: number
  sessionChords?: readonly StudioChord[]
}

export function generateChordProgressionNotes(options: GenerateProgressionOptions): {
  notes: StudioMidiNote[]
  lengthBeats: number
  chordsUsed: StudioChord[]
} {
  const bpb = Math.max(1, Math.round(options.beatsPerBar ?? 4))
  const bars = Math.max(1, Math.min(64, Math.round(options.bars ?? 4)))
  const baseOctave = Math.max(1, Math.min(6, Math.round(options.octave ?? (options.voicing === 'bass' ? 2 : 4))))
  const velocity = Math.max(20, Math.min(124, Math.round(options.velocity ?? 88)))

  let chords: StudioChord[]
  if (options.preset === 'from_session' && options.sessionChords && options.sessionChords.length > 0) {
    const minBeat = options.sessionChords[0].beat
    chords = options.sessionChords.slice(0, 64).map((c) => ({
      beat: roundBeat(c.beat - minBeat),
      lengthBeats: c.lengthBeats,
      name: c.name,
    }))
  } else {
    const p = options.preset === 'from_session' ? 'pop_1564' : options.preset
    chords = buildPresetChords(p, options.key, bars, bpb)
  }

  const lengthBeats = roundBeat(
    Math.max(
      bars * bpb,
      chords.reduce((max, c) => Math.max(max, c.beat + c.lengthBeats), 0),
    ),
  )

  const rawNotes: StudioMidiNote[] = []
  const baseMidi = (baseOctave + 1) * 12

  for (const ch of chords) {
    const parsed = parseChordSymbol(ch.name)
    const intervals = [...parsed.intervals]
    if (options.voicing === 'sevenths' && intervals.length < 4) {
      intervals.push(intervals[1] === 3 ? 10 : 11)
    }
    if (options.voicing === 'bass') {
      const pitch = Math.max(24, Math.min(72, baseMidi + parsed.rootPc))
      const steps = Math.max(1, Math.round(ch.lengthBeats))
      for (let s = 0; s < steps; s++) {
        rawNotes.push({
          pitch,
          start: roundBeat(ch.beat + s),
          length: 0.85,
          velocity: s === 0 ? velocity + 8 : velocity - 6,
        })
      }
      continue
    }
    if (options.voicing === 'arpeggio') {
      const step = 0.5
      const count = Math.max(1, Math.floor(ch.lengthBeats / step))
      const arpPitches = [
        ...intervals.map((iv) => baseMidi + parsed.rootPc + iv),
        baseMidi + parsed.rootPc + 12,
      ]
      for (let k = 0; k < count; k++) {
        rawNotes.push({
          pitch: Math.max(0, Math.min(127, arpPitches[k % arpPitches.length])),
          start: roundBeat(ch.beat + k * step),
          length: step * 0.9,
          velocity: k % bpb === 0 ? velocity + 6 : velocity - 4,
        })
      }
      continue
    }
    // Bloque de acordes con bajo fundamental una octava abajo para plenitud musical.
    rawNotes.push({
      pitch: Math.max(24, baseMidi - 12 + parsed.rootPc),
      start: ch.beat,
      length: Math.max(0.25, ch.lengthBeats * 0.96),
      velocity: velocity - 4,
    })
    for (const iv of intervals) {
      // Inversion cercana alrededor de C4..C5 para conduccion de voces suave.
      let pitch = baseMidi + parsed.rootPc + iv
      while (pitch > baseMidi + 16) pitch -= 12
      rawNotes.push({
        pitch: Math.max(0, Math.min(127, pitch)),
        start: ch.beat,
        length: Math.max(0.25, ch.lengthBeats * 0.96),
        velocity,
      })
    }
  }

  return {
    notes: normalizeNotes(rawNotes, lengthBeats),
    lengthBeats,
    chordsUsed: chords,
  }
}
