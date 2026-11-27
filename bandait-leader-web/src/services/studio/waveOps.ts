/**
 * Transformaciones constructivas y no-destructivas de onda del Estudio Bandait:
 *   - Curvas matematicas de fundido (`linear`, `exp`, `scurve` coseno elevado)
 *   - Normalizacion exacta por objetivo LUFS (ITU-R BS.1770) o True Peak (dBTP)
 *   - Strip Silence con Histeresis de Schmitt (`openThresholdDb`, `closeThresholdDb`,
 *     `minSoundMs`, `minSilenceMs`, `padMs`) que divide una toma en clips limpios con micro-fades
 *   - Reversa de muestras (`reverseChannels`) lista para guardar como `StudioAsset` inmutable.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import { integratedLufs, truePeakDb } from './loudness.ts'
import {
  STUDIO_CLIP_GAIN_DB_MAX,
  STUDIO_CLIP_GAIN_DB_MIN,
  STUDIO_MIN_CLIP_SECONDS,
  newStudioId,
  type StudioClip,
  type StudioClipFadeShape,
} from './session.ts'

/**
 * Evalua la forma matematica de un fundido para `u` normalizado en [0, 1]
 * (`u = 0` silencio, `u = 1` ganancia unitaria).
 */
export function evaluateFadeCurve(u: number, shape: StudioClipFadeShape = 'linear'): number {
  const x = Math.max(0, Math.min(1, u))
  if (shape === 'exp') return Math.pow(x, 2.2)
  if (shape === 'scurve') return 0.5 - 0.5 * Math.cos(Math.PI * x)
  return x
}

export interface NormalizeGainOptions {
  mode: 'lufs' | 'peak'
  /** Objetivo en LUFS (modo 'lufs', por defecto -14) o en dBTP (modo 'peak', por defecto -1). */
  targetDb: number
  /** Techo de seguridad de pico real (dBTP) para nunca clipear al normalizar por LUFS. Por defecto -1. */
  ceilingDbTp?: number
}

/**
 * Calcula la ganancia exacta (`gainDb` nueva del clip) para llevar el segmento del clip al objetivo
 * deseado respetando el techo True Peak y los limites del contrato `[-60, +24] dB`.
 */
export function computeNormalizedClipGainDb(
  channels: Float32Array[],
  sampleRate: number,
  options: NormalizeGainOptions,
): { gainDb: number; measuredLufs: number; measuredTruePeakDb: number } {
  const measuredLufs = integratedLufs(channels, sampleRate)
  const measuredTruePeakDb = truePeakDb(channels, sampleRate)
  const ceiling = options.ceilingDbTp ?? -1

  if (!Number.isFinite(measuredTruePeakDb)) {
    return { gainDb: 0, measuredLufs, measuredTruePeakDb }
  }

  let deltaDb: number
  if (options.mode === 'peak') {
    deltaDb = options.targetDb - measuredTruePeakDb
  } else {
    if (!Number.isFinite(measuredLufs)) {
      deltaDb = ceiling - measuredTruePeakDb
    } else {
      const wanted = options.targetDb - measuredLufs
      const maxAllowedByCeiling = ceiling - measuredTruePeakDb
      deltaDb = Math.min(wanted, maxAllowedByCeiling)
    }
  }

  const clamped = Math.max(
    STUDIO_CLIP_GAIN_DB_MIN,
    Math.min(STUDIO_CLIP_GAIN_DB_MAX, Math.round(deltaDb * 100) / 100),
  )
  return { gainDb: clamped, measuredLufs, measuredTruePeakDb }
}

// ---------------------------------------------------------------------------
// Strip Silence con Histeresis de Schmitt
// ---------------------------------------------------------------------------

export interface StripSilenceOptions {
  /** Umbral en dBFS que abre la compuerta (ej. -38 dB). */
  openThresholdDb?: number
  /** Umbral inferior en dBFS que cierra la compuerta (ej. -46 dB; debe ser <= openThresholdDb). */
  closeThresholdDb?: number
  /** Duracion minima de sonido util para conservar una region (ms). */
  minSoundMs?: number
  /** Silencio minimo entre frases para cortar; huecos mas cortos se unen (ms). */
  minSilenceMs?: number
  /** Margen previo antes del ataque para no cortar respiraciones/consonantes (ms). */
  prePadMs?: number
  /** Cola posterior tras caer bajo el umbral de cierre (ms). */
  postPadMs?: number
  /** Micro-fade suave aplicado en los bordes de cada region (ms). */
  fadeMs?: number
}

export interface SoundRegionS {
  startS: number
  endS: number
}

/**
 * Detecta regiones activas `[startS, endS]` dentro de `channels` usando una compuerta con
 * histeresis de Schmitt sobre bloques RMS de 10 ms.
 */
export function detectStripSilenceRegions(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: StripSilenceOptions = {},
): SoundRegionS[] {
  if (!(sampleRate > 0) || channels.length === 0) return []
  const totalSamples = Math.min(...channels.map((c) => c.length))
  if (totalSamples === 0) return []
  const totalDurationS = totalSamples / sampleRate

  const openDb = options.openThresholdDb ?? -38
  const closeDb = Math.min(openDb, options.closeThresholdDb ?? openDb - 8)
  const minSoundS = Math.max(STUDIO_MIN_CLIP_SECONDS, (options.minSoundMs ?? 80) / 1000)
  const minSilenceS = Math.max(0.01, (options.minSilenceMs ?? 160) / 1000)
  const prePadS = Math.max(0, (options.prePadMs ?? 25) / 1000)
  const postPadS = Math.max(0, (options.postPadMs ?? 60) / 1000)

  const blockSamples = Math.max(16, Math.round(sampleRate * 0.01)) // 10 ms
  const numBlocks = Math.ceil(totalSamples / blockSamples)
  const rawRegions: SoundRegionS[] = []

  let gateOpen = false
  let regionStartBlock = 0

  for (let b = 0; b < numBlocks; b++) {
    const from = b * blockSamples
    const to = Math.min(totalSamples, from + blockSamples)
    const count = to - from
    let sumSq = 0
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c]
      for (let i = from; i < to; i++) sumSq += ch[i] * ch[i]
    }
    const rms = Math.sqrt(sumSq / (count * channels.length))
    const db = rms > 1e-10 ? 20 * Math.log10(rms) : -200

    if (!gateOpen && db >= openDb) {
      gateOpen = true
      regionStartBlock = b
    } else if (gateOpen && db < closeDb) {
      gateOpen = false
      rawRegions.push({
        startS: (regionStartBlock * blockSamples) / sampleRate,
        endS: (b * blockSamples) / sampleRate,
      })
    }
  }
  if (gateOpen) {
    rawRegions.push({
      startS: (regionStartBlock * blockSamples) / sampleRate,
      endS: totalDurationS,
    })
  }
  if (rawRegions.length === 0) return []

  // 1. Unir regiones separadas por menos de minSilenceS.
  const merged: SoundRegionS[] = [{ ...rawRegions[0] }]
  for (let i = 1; i < rawRegions.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = rawRegions[i]
    if (curr.startS - prev.endS < minSilenceS) {
      prev.endS = curr.endS
    } else {
      merged.push({ ...curr })
    }
  }

  // 2. Descartar ruidos fugaces menores a minSoundS y aplicar prePad / postPad sin solapar.
  const valid = merged.filter((r) => r.endS - r.startS >= minSoundS)
  const padded: SoundRegionS[] = []
  for (const r of valid) {
    const startS = Math.max(0, r.startS - prePadS)
    const endS = Math.min(totalDurationS, r.endS + postPadS)
    if (padded.length > 0 && startS <= padded[padded.length - 1].endS) {
      padded[padded.length - 1].endS = Math.max(padded[padded.length - 1].endS, endS)
    } else if (endS - startS >= STUDIO_MIN_CLIP_SECONDS) {
      padded.push({ startS, endS })
    }
  }
  return padded
}

/**
 * Convierte un `StudioClip` y las canales de su tramo activo en una lista de `StudioClip` sin
 * silencios intermedios, conservando su posicion exacta en la linea de tiempo y aplicando micro-fades.
 */
export function splitClipByStripSilence(
  clip: StudioClip,
  clipSegmentChannels: readonly Float32Array[],
  sampleRate: number,
  options: StripSilenceOptions = {},
  idGen: (prefix: 'clp') => string = newStudioId,
): StudioClip[] {
  const regions = detectStripSilenceRegions(clipSegmentChannels, sampleRate, options)
  if (regions.length === 0) return []
  const fadeS = Math.max(0.003, (options.fadeMs ?? 12) / 1000)

  return regions.map((reg, index) => {
    const lengthS = Math.max(STUDIO_MIN_CLIP_SECONDS, Math.min(clip.lengthS - reg.startS, reg.endS - reg.startS))
    const safeFade = Math.min(fadeS, lengthS * 0.25)
    const out: StudioClip = {
      ...clip,
      id: index === 0 ? clip.id : idGen('clp'),
      startS: clip.startS + reg.startS,
      offsetS: clip.offsetS + reg.startS,
      lengthS,
      fadeInS: index === 0 ? Math.max(clip.fadeInS, safeFade) : safeFade,
      fadeOutS: index === regions.length - 1 ? Math.max(clip.fadeOutS, safeFade) : safeFade,
      fadeShape: 'scurve',
    }
    return out
  })
}

/** Invierte en el tiempo cada canal de audio devolviendo copias nuevas inmutables. */
export function reverseChannels(channels: readonly Float32Array[]): Float32Array[] {
  return channels.map((ch) => {
    const len = ch.length
    const rev = new Float32Array(len)
    for (let i = 0; i < len; i++) rev[i] = ch[len - 1 - i]
    return rev
  })
}
