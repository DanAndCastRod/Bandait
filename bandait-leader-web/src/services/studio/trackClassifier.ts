/**
 * Clasificador Espectral Acustico de Rol + Post-Procesado Armonico para Edge ML (`@spotify/basic-pitch`).
 *
 * Extrae descriptores matematicos en el dominio del tiempo y frecuencia (relacion sub-grave < 160 Hz,
 * energia en banda formante vocal 300..3400 Hz, factor de cresta transiente y tasa de cruces por cero ZCR)
 * para inferir el `StemRole` cuando el nombre del archivo importado no tiene pista semantica ("Audio_01.wav").
 *
 * Incluye tambien `quantizeNotesToScale`, que refina las notas transcritas por la red neuronal
 * convolucional Basic Pitch ajustandolas opcionalmente a la tonalidad detectada.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import { recognizeStem, type StemRole } from '../stemNames.ts'
import { barkBandPowers, spectralCentroidHz } from './dspMath.ts'
import { normalizeNotes } from './midiOps.ts'
import type { StudioMidiNote } from './session.ts'

export interface SpectralRoleFeatures {
  lowEndRatio: number
  vocalBandRatio: number
  highBandRatio: number
  crestFactorDb: number
  zeroCrossingRate: number
  centroidHz: number
}

export function extractSpectralRoleFeatures(samples: Float32Array, sampleRate: number): SpectralRoleFeatures {
  if (samples.length === 0 || !(sampleRate > 0)) {
    return { lowEndRatio: 0, vocalBandRatio: 0, highBandRatio: 0, crestFactorDb: 0, zeroCrossingRate: 0, centroidHz: 0 }
  }
  let peak = 0
  let sumSq = 0
  let crossings = 0
  const stride = Math.max(1, Math.floor(samples.length / 65536))
  let count = 0
  let prev = samples[0]

  for (let i = 0; i < samples.length; i += stride) {
    const s = samples[i]
    const abs = Math.abs(s)
    if (abs > peak) peak = abs
    sumSq += s * s
    if ((s >= 0 && prev < 0) || (s < 0 && prev >= 0)) crossings++
    prev = s
    count++
  }

  const rms = count > 0 ? Math.sqrt(sumSq / count) : 0
  const crestFactorDb = rms > 1e-8 && peak > 0 ? 20 * Math.log10(peak / rms) : 0
  const zeroCrossingRate = count > 1 ? crossings / count : 0

  const bark = barkBandPowers(samples, sampleRate)
  let totalP = 0
  for (let b = 0; b < 24; b++) totalP += bark[b]
  if (!(totalP > 1e-12)) {
    return { lowEndRatio: 0, vocalBandRatio: 0, highBandRatio: 0, crestFactorDb, zeroCrossingRate, centroidHz: 0 }
  }

  // Bark 0..1 (< 200 Hz), Bark 3..16 (300..3700 Hz), Bark 17..23 (> 3700 Hz)
  const lowP = bark[0] + bark[1]
  let vocalP = 0
  for (let b = 3; b <= 16; b++) vocalP += bark[b]
  let highP = 0
  for (let b = 17; b < 24; b++) highP += bark[b]

  return {
    lowEndRatio: lowP / totalP,
    vocalBandRatio: vocalP / totalP,
    highBandRatio: highP / totalP,
    crestFactorDb,
    zeroCrossingRate,
    centroidHz: spectralCentroidHz(samples, sampleRate),
  }
}

export interface RoleClassification {
  role: StemRole
  confidence: number
  source: 'filename' | 'spectral'
}

/** Clasifica una pista combinando heuristica de nombre y clasificador espectral multivariable. */
export function classifyAudioRole(
  filename: string,
  samples?: Float32Array | null,
  sampleRate?: number,
): RoleClassification {
  const byName: StemRole = recognizeStem(filename.includes('.') ? filename : `${filename}.wav`) ?? 'unknown'
  if (byName !== 'unknown' && byName !== 'other') {
    return { role: byName, confidence: 0.95, source: 'filename' }
  }
  if (!samples || samples.length === 0 || !(sampleRate && sampleRate > 0)) {
    return { role: byName, confidence: 0.3, source: 'filename' }
  }

  const f = extractSpectralRoleFeatures(samples, sampleRate)

  // Arbol de decision / puntuacion discriminante calibrado sobre descriptores fisicos:
  if (f.lowEndRatio > 0.58 && f.crestFactorDb < 14) {
    return { role: 'bass', confidence: 0.84, source: 'spectral' }
  }
  if (f.crestFactorDb >= 15.5 && (f.highBandRatio > 0.14 || f.lowEndRatio > 0.25)) {
    return { role: 'drums', confidence: 0.82, source: 'spectral' }
  }
  if (f.vocalBandRatio > 0.68 && f.lowEndRatio < 0.12 && f.centroidHz >= 650 && f.centroidHz <= 3200) {
    return { role: 'vocals', confidence: 0.76, source: 'spectral' }
  }
  if (f.vocalBandRatio > 0.55 && f.centroidHz >= 400 && f.centroidHz <= 2400) {
    return { role: f.crestFactorDb > 12 ? 'guitar' : 'keys', confidence: 0.68, source: 'spectral' }
  }
  return { role: 'other', confidence: 0.5, source: 'spectral' }
}

const NOTE_PC: Readonly<Record<string, number>> = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4,
  F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
}

const MAJOR_SCALE = new Set([0, 2, 4, 5, 7, 9, 11])
const MINOR_SCALE = new Set([0, 2, 3, 5, 7, 8, 10])

/** Cuantiza armonicamente las alturas MIDI a la escala mayor o menor de `key` (p. ej. tras Basic Pitch). */
export function quantizeNotesToKey(
  notes: readonly StudioMidiNote[],
  key: string | null,
  clipLengthBeats: number,
): StudioMidiNote[] {
  if (!key || !key.trim()) return normalizeNotes(notes, clipLengthBeats)
  const m = /^([A-G][#b]?)(m?)$/.exec(key.trim())
  if (!m) return normalizeNotes(notes, clipLengthBeats)
  const root = NOTE_PC[m[1]]
  if (root === undefined) return normalizeNotes(notes, clipLengthBeats)
  const scale = m[2] === 'm' ? MINOR_SCALE : MAJOR_SCALE

  const snapped = notes.map((n) => {
    const rel = (((n.pitch - root) % 12) + 12) % 12
    if (scale.has(rel)) return n
    const down = (((rel - 1) % 12) + 12) % 12
    if (scale.has(down)) return { ...n, pitch: Math.max(0, n.pitch - 1) }
    return { ...n, pitch: Math.min(127, n.pitch + 1) }
  })
  return normalizeNotes(snapped, clipLengthBeats)
}
