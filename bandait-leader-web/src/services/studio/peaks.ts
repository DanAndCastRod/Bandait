/**
 * Picos para dibujar formas de onda en el Estudio Bandait. Cada cubeta resume
 * `samplesPerBucket` muestras como minimo y maximo en Int8 (round(muestra * 127)) y su valor
 * eficaz (RMS) en Uint8 (round(rms * 255)): un audio de 20 minutos a 48 kHz ocupa unos 675 KB por
 * canal con la cubeta base.
 *
 * RMS y picos ya guardados (decision del 2026-11-26, forma de onda configurable): el RMS es un
 * campo OPCIONAL de PeakData. Los picos que studioStore guardo antes no lo traen: se leen igual
 * (la forma de onda de pico no cambia) y studioState.ensurePeaks los recalcula en segundo plano
 * desde el audio ya decodificado y los vuelve a guardar, una sola vez por audio. Mientras tanto,
 * pedir RMS a peaksForRange no escribe nada y el dibujo usa el pico (waveformRender).
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts y
 * scripts/verify-waveform-logic.ts).
 */
import type { PeakColumns, PeakData, PeakRangeRequest, PeaksApi } from './types.ts'

/** Muestras por cubeta de los picos que guarda studioStore.savePeaks. */
export const PEAKS_BASE_BUCKET = 256

function quantize(value: number): number {
  const q = Math.round(value * 127)
  return q > 127 ? 127 : q < -127 ? -127 : q
}

function quantizeRms(value: number): number {
  const q = Math.round(value * 255)
  return q > 255 ? 255 : q < 0 ? 0 : q
}

export function computePeaks(samples: Float32Array, samplesPerBucket: number): PeakData {
  const size = Math.floor(samplesPerBucket)
  if (!(size >= 1)) throw new Error('samplesPerBucket debe ser un entero mayor o igual a 1')
  const buckets = Math.ceil(samples.length / size)
  const min = new Int8Array(buckets)
  const max = new Int8Array(buckets)
  const rms = new Uint8Array(buckets)
  for (let b = 0; b < buckets; b++) {
    const from = b * size
    const to = Math.min(from + size, samples.length)
    let lo = Infinity
    let hi = -Infinity
    let squares = 0
    for (let i = from; i < to; i++) {
      const v = samples[i]
      // Una muestra no finita (NaN de un decodificador) cuenta como silencio.
      const s = Number.isFinite(v) ? v : 0
      if (s < lo) lo = s
      if (s > hi) hi = s
      squares += s * s
    }
    min[b] = quantize(lo)
    max[b] = quantize(hi)
    rms[b] = quantizeRms(Math.sqrt(squares / Math.max(1, to - from)))
  }
  return { min, max, samplesPerBucket: size, rms }
}

/** true si los picos de todos los canales traen RMS valido (los guardados antes no lo traen). */
export function peaksHaveRms(channels: readonly PeakData[]): boolean {
  return channels.length > 0 && channels.every((c) => c.rms instanceof Uint8Array && c.rms.length === c.min.length)
}

export function peaksForRange(peaks: PeakData, request: PeakRangeRequest, out?: PeakColumns): PeakColumns {
  const columns = Math.max(1, Math.floor(request.columns))
  const reuse = out && out.min.length === columns && out.max.length === columns
  const result: PeakColumns = reuse ? out : { min: new Float32Array(columns), max: new Float32Array(columns) }
  const buckets = Math.min(peaks.min.length, peaks.max.length)
  const rmsSource = peaks.rms instanceof Uint8Array && peaks.rms.length >= buckets ? peaks.rms : null
  // RMS: en el `out` que trae donde escribirlo, o en uno nuevo si no se paso `out`.
  let rmsOut: Float32Array | null = null
  if (rmsSource) {
    if (reuse) rmsOut = out.rms && out.rms.length === columns ? out.rms : null
    else {
      rmsOut = new Float32Array(columns)
      result.rms = rmsOut
    }
  }
  const size = peaks.samplesPerBucket
  const startSample = request.startS * request.sampleRate
  const samplesPerColumn = ((request.endS - request.startS) * request.sampleRate) / columns
  const valid = Number.isFinite(startSample) && Number.isFinite(samplesPerColumn) && samplesPerColumn > 0 && size >= 1
  for (let c = 0; c < columns; c++) {
    let lo = 0
    let hi = 0
    let power = 0
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
        let squares = 0
        for (let b = first; b <= last; b++) {
          if (peaks.min[b] < lo) lo = peaks.min[b]
          if (peaks.max[b] > hi) hi = peaks.max[b]
          if (rmsOut && rmsSource) {
            const r = rmsSource[b] / 255
            squares += r * r
          }
        }
        if (rmsOut) power = Math.sqrt(squares / (last - first + 1))
      }
    }
    result.min[c] = lo / 127
    result.max[c] = hi / 127
    if (rmsOut) rmsOut[c] = power
  }
  return result
}

void ({ computePeaks, peaksForRange } satisfies PeaksApi)
