/**
 * Picos para dibujar formas de onda en el Estudio Bandait. Cada cubeta resume
 * `samplesPerBucket` muestras como minimo y maximo en Int8 (round(muestra * 127)): un audio de
 * 20 minutos a 48 kHz ocupa unos 450 KB por canal con la cubeta base.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import type { PeakColumns, PeakData, PeakRangeRequest, PeaksApi } from './types.ts'

/** Muestras por cubeta de los picos que guarda studioStore.savePeaks. */
export const PEAKS_BASE_BUCKET = 256

function quantize(value: number): number {
  const q = Math.round(value * 127)
  return q > 127 ? 127 : q < -127 ? -127 : q
}

export function computePeaks(samples: Float32Array, samplesPerBucket: number): PeakData {
  const size = Math.floor(samplesPerBucket)
  if (!(size >= 1)) throw new Error('samplesPerBucket debe ser un entero mayor o igual a 1')
  const buckets = Math.ceil(samples.length / size)
  const min = new Int8Array(buckets)
  const max = new Int8Array(buckets)
  for (let b = 0; b < buckets; b++) {
    const from = b * size
    const to = Math.min(from + size, samples.length)
    let lo = Infinity
    let hi = -Infinity
    for (let i = from; i < to; i++) {
      const v = samples[i]
      // Una muestra no finita (NaN de un decodificador) cuenta como silencio.
      const s = Number.isFinite(v) ? v : 0
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
    min[b] = quantize(lo)
    max[b] = quantize(hi)
  }
  return { min, max, samplesPerBucket: size }
}

export function peaksForRange(peaks: PeakData, request: PeakRangeRequest, out?: PeakColumns): PeakColumns {
  const columns = Math.max(1, Math.floor(request.columns))
  const result: PeakColumns =
    out && out.min.length === columns && out.max.length === columns ? out : { min: new Float32Array(columns), max: new Float32Array(columns) }
  const buckets = Math.min(peaks.min.length, peaks.max.length)
  const size = peaks.samplesPerBucket
  const startSample = request.startS * request.sampleRate
  const samplesPerColumn = ((request.endS - request.startS) * request.sampleRate) / columns
  const valid = Number.isFinite(startSample) && Number.isFinite(samplesPerColumn) && samplesPerColumn > 0 && size >= 1
  for (let c = 0; c < columns; c++) {
    let lo = 0
    let hi = 0
    if (valid) {
      const from = startSample + c * samplesPerColumn
      const to = from + samplesPerColumn
      // Cubetas que tocan [from, to); al menos la que contiene `from`.
      let first = Math.floor(from / size)
      let last = Math.ceil(to / size) - 1
      if (last < first) last = first
      if (first < 0) first = 0
      if (last > buckets - 1) last = buckets - 1
      if (first <= last) {
        lo = 127
        hi = -127
        for (let b = first; b <= last; b++) {
          if (peaks.min[b] < lo) lo = peaks.min[b]
          if (peaks.max[b] > hi) hi = peaks.max[b]
        }
      }
    }
    result.min[c] = lo / 127
    result.max[c] = hi / 127
  }
  return result
}

void ({ computePeaks, peaksForRange } satisfies PeaksApi)
