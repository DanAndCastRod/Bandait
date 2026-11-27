/**
 * Motor DSP matematico 100 % local del Estudio Bandait (Cero Cuota de IA).
 *
 * Incluye:
 *   - Transformada Rapida de Fourier Cooley-Tukey radix-2 en sitio (FFT / IFFT) + STFT
 *   - 24 bandas criticas psicoacusticas de Zwicker (escala Bark)
 *   - Deteccion de frecuencia fundamental f0 por algoritmo YIN con interpolacion parabolica (< 0,5 cents)
 *   - Alineacion automatica de fase y retardo inter-pista por Correlacion Cruzada Generalizada (GCC-PHAT)
 *   - Deteccion musical local: BPM por autocorrelacion de envolvente de onsets, Tonalidad/Camelot por
 *     perfiles de Krumhansl-Schmuckler y secuencia de Acordes por decodificacion Viterbi sobre HMM
 *   - Deteccion de transientes por Flujo Espectral con umbral adaptativo de mediana movil
 *   - Telemetria estereo y dinamica: correlacion de fase de Pearson, goniometro Lissajous Mid/Side,
 *     rango de sonoridad EBU R128 (LRA) y factor de cresta (PLR).
 *
 * Modulo puro: sin DOM, sin Web Audio y sin import.meta.env. Se prueba directamente en Node.
 */
import { integratedLufs, kWeightingCoefficients, truePeakDb } from './loudness.ts'
import { STUDIO_MAX_BEAT, compareChords, roundBeat, type StudioChord } from './session.ts'

const TWO_PI = 2 * Math.PI
const EPS = 1e-12

/** Limites superiores (Hz) de las 24 bandas criticas de Bark (Zwicker, 20 Hz .. 15,5+ kHz). */
export const BARK_BAND_EDGES_HZ: readonly number[] = [
  100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270, 1480, 1720,
  2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500, 12000, 15500,
]

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

const CAMELOT_MAJOR: readonly string[] = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B']
const CAMELOT_MINOR: readonly string[] = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A']

// Perfiles cognitivos de Krumhansl-Schmuckler para las 12 clases de altura.
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

// ---------------------------------------------------------------------------
// 1. FFT / IFFT Cooley-Tukey radix-2 + STFT + Bandas Bark
// ---------------------------------------------------------------------------

export function nextPow2(n: number): number {
  let p = 1
  const target = Math.max(1, Math.ceil(n))
  while (p < target) p <<= 1
  return p
}

const hannCache = new Map<number, Float32Array>()

export function hannWindow(size: number): Float32Array {
  const cached = hannCache.get(size)
  if (cached) return cached
  const win = new Float32Array(size)
  if (size === 1) {
    win[0] = 1
  } else {
    for (let i = 0; i < size; i++) {
      win[i] = 0.5 * (1 - Math.cos((TWO_PI * i) / (size - 1)))
    }
  }
  hannCache.set(size, win)
  return win
}

/**
 * FFT / IFFT compleja radix-2 en sitio (`re.length === im.length === 2^k`).
 * Con `inverse = true` divide por `N`.
 */
export function fftRadix2(re: Float64Array | Float32Array, im: Float64Array | Float32Array, inverse = false): void {
  const n = re.length
  if (n <= 1) return
  if ((n & (n - 1)) !== 0) throw new Error(`fftRadix2 exige potencia de 2 (recibido ${n})`)

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = (sign * TWO_PI) / len
    const wLenRe = Math.cos(ang)
    const wLenIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]
        const uIm = im[i + j]
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe
        re[i + j] = uRe + vRe
        im[i + j] = uIm + vIm
        re[i + j + half] = uRe - vRe
        im[i + j + half] = uIm - vIm
        const nextWRe = wRe * wLenRe - wIm * wLenIm
        wIm = wRe * wLenIm + wIm * wLenRe
        wRe = nextWRe
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

/** Espectro unilateral de magnitud en dBFS (`fftSize / 2 + 1` bins) con ventana de Hann compensada. */
export function magnitudeSpectrumDb(samples: Float32Array, fftSize = 2048): Float32Array {
  const n = nextPow2(fftSize)
  const bins = (n >> 1) + 1
  const out = new Float32Array(bins)
  if (samples.length === 0) {
    out.fill(-120)
    return out
  }
  const win = hannWindow(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const copyLen = Math.min(samples.length, n)
  for (let i = 0; i < copyLen; i++) re[i] = samples[i] * win[i]
  fftRadix2(re, im, false)
  // Factor 2 / (sum(win)) = 4 / n para que una senoide de amplitud 1 marque 0 dBFS.
  const norm = 4 / n
  for (let k = 0; k < bins; k++) {
    const mag = Math.hypot(re[k], im[k]) * (k === 0 || k === bins - 1 ? norm * 0.5 : norm)
    out[k] = mag > EPS ? Math.max(-120, 20 * Math.log10(mag)) : -120
  }
  return out
}

export interface StftResult {
  frames: Float32Array[]
  fftSize: number
  hopSize: number
  binHz: number
}

/** Calcula espectrograma STFT en dBFS (hasta `maxFrames` ventanas espaciadas o consecutivas). */
export function computeStft(
  samples: Float32Array,
  sampleRate: number,
  fftSize = 1024,
  hopSize = 512,
  maxFrames = 256,
): StftResult {
  const n = nextPow2(fftSize)
  const bins = (n >> 1) + 1
  const frames: Float32Array[] = []
  if (samples.length < n || !(sampleRate > 0)) {
    return { frames, fftSize: n, hopSize, binHz: sampleRate > 0 ? sampleRate / n : 0 }
  }
  const totalPossible = Math.floor((samples.length - n) / Math.max(1, hopSize)) + 1
  const stride = totalPossible > maxFrames ? Math.ceil(totalPossible / maxFrames) * hopSize : hopSize
  const win = hannWindow(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const norm = 4 / n

  for (let pos = 0; pos + n <= samples.length && frames.length < maxFrames; pos += stride) {
    for (let i = 0; i < n; i++) {
      re[i] = samples[pos + i] * win[i]
      im[i] = 0
    }
    fftRadix2(re, im, false)
    const spec = new Float32Array(bins)
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]) * norm
      spec[k] = mag > EPS ? Math.max(-120, 20 * Math.log10(mag)) : -120
    }
    frames.push(spec)
  }

  return { frames, fftSize: n, hopSize: stride, binHz: sampleRate / n }
}

/** Convierte frecuencia en Hz al indice de banda Bark (0..23). */
export function hzToBarkBand(hz: number): number {
  for (let b = 0; b < BARK_BAND_EDGES_HZ.length; b++) {
    if (hz < BARK_BAND_EDGES_HZ[b]) return b
  }
  return BARK_BAND_EDGES_HZ.length - 1
}

/** Energia media lineal en las 24 bandas criticas de Bark sobre una senal mono. */
export function barkBandPowers(samples: Float32Array, sampleRate: number, fftSize = 2048): Float64Array {
  const powers = new Float64Array(24)
  if (samples.length === 0 || !(sampleRate > 0)) return powers
  const n = nextPow2(fftSize)
  const bins = (n >> 1) + 1
  const win = hannWindow(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const hop = n >> 1
  const maxWindows = 64
  const totalPossible = samples.length >= n ? Math.floor((samples.length - n) / hop) + 1 : 1
  const step = totalPossible > maxWindows ? Math.ceil(totalPossible / maxWindows) * hop : hop

  const binToBand = new Int32Array(bins)
  for (let k = 0; k < bins; k++) binToBand[k] = hzToBarkBand((k * sampleRate) / n)

  let count = 0
  const scale = (2 / n) * (2 / n)
  for (let pos = 0; pos < samples.length && count < maxWindows; pos += step) {
    re.fill(0)
    im.fill(0)
    const len = Math.min(n, samples.length - pos)
    for (let i = 0; i < len; i++) re[i] = samples[pos + i] * win[i]
    fftRadix2(re, im, false)
    for (let k = 1; k < bins; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) * scale
      powers[binToBand[k]] += p
    }
    count++
    if (samples.length < n) break
  }
  if (count > 0) {
    for (let b = 0; b < 24; b++) powers[b] /= count
  }
  return powers
}

/** Energia media en dBFS para cada una de las 24 bandas de Bark. */
export function barkBandEnergiesDb(samples: Float32Array, sampleRate: number, fftSize = 2048): Float32Array {
  const powers = barkBandPowers(samples, sampleRate, fftSize)
  const out = new Float32Array(24)
  for (let b = 0; b < 24; b++) {
    out[b] = powers[b] > EPS ? Math.max(-120, 10 * Math.log10(powers[b])) : -120
  }
  return out
}

export function downmixMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const len = Math.min(channels[0].length, channels[1].length)
  const mono = new Float32Array(len)
  const inv = 1 / channels.length
  for (let c = 0; c < channels.length; c++) {
    const ch = channels[c]
    for (let i = 0; i < len; i++) mono[i] += ch[i] * inv
  }
  return mono
}

export function spectralCentroidHz(samples: Float32Array, sampleRate: number, fftSize = 2048): number {
  if (samples.length === 0 || !(sampleRate > 0)) return 0
  const n = nextPow2(fftSize)
  const bins = (n >> 1) + 1
  const win = hannWindow(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const copy = Math.min(samples.length, n)
  for (let i = 0; i < copy; i++) re[i] = samples[i] * win[i]
  fftRadix2(re, im, false)
  let weighted = 0
  let sum = 0
  for (let k = 1; k < bins; k++) {
    const mag = Math.hypot(re[k], im[k])
    weighted += ((k * sampleRate) / n) * mag
    sum += mag
  }
  return sum > EPS ? weighted / sum : 0
}

// ---------------------------------------------------------------------------
// 2. Algoritmo YIN para deteccion fundamental f0 (< 0,5 cents)
// ---------------------------------------------------------------------------

export interface PitchDetectionResult {
  hz: number
  midi: number
  noteName: string
  octave: number
  cents: number
  targetHz: number
  confidence: number
}

export function frequencyToNoteInfo(hz: number, referenceA4Hz = 440): Omit<PitchDetectionResult, 'hz' | 'confidence'> {
  const safeRef = referenceA4Hz > 0 ? referenceA4Hz : 440
  const exactMidi = 69 + 12 * Math.log2(Math.max(1e-6, hz) / safeRef)
  const midi = Math.max(0, Math.min(127, Math.round(exactMidi)))
  const cents = Math.round((exactMidi - midi) * 1000) / 10
  const noteName = NOTE_NAMES_SHARP[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  const targetHz = safeRef * Math.pow(2, (midi - 69) / 12)
  return { midi, noteName, octave, cents, targetHz }
}

/**
 * Detector monofonico YIN (De Cheveigne & Kawahara, 2002) con funcion de diferencia media
 * acumulada normalizada d'(tau) e interpolacion parabolica sub-muestra.
 */
export function detectPitchYin(
  samples: Float32Array,
  sampleRate: number,
  options: { minHz?: number; maxHz?: number; threshold?: number; referenceA4Hz?: number } = {},
): PitchDetectionResult | null {
  if (!(sampleRate > 0) || samples.length < 128) return null
  const minHz = options.minHz ?? 45
  const maxHz = options.maxHz ?? 1600
  const threshold = options.threshold ?? 0.12
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz))
  const tauMax = Math.min(Math.floor(samples.length / 2), Math.ceil(sampleRate / minHz))
  if (tauMax <= tauMin + 2) return null

  const windowLen = tauMax
  // Comprobar nivel minimo para ignorar silencio.
  let energy = 0
  for (let i = 0; i < windowLen * 2 && i < samples.length; i++) energy += samples[i] * samples[i]
  if (energy / Math.min(samples.length, windowLen * 2) < 1e-7) return null

  const diff = new Float64Array(tauMax + 1)
  const cmnd = new Float64Array(tauMax + 1)
  cmnd[0] = 1
  let runningSum = 0

  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0
    for (let i = 0; i < windowLen; i++) {
      const delta = samples[i] - samples[i + tau]
      d += delta * delta
    }
    diff[tau] = d
    runningSum += d
    cmnd[tau] = runningSum > EPS ? (d * tau) / runningSum : 1
  }

  let bestTau = -1
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++
      bestTau = tau
      break
    }
  }
  if (bestTau < 0) {
    let minVal = Infinity
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < minVal) {
        minVal = cmnd[tau]
        bestTau = tau
      }
    }
    if (bestTau < 0 || minVal > 0.38) return null
  }

  // Interpolacion parabolica sobre diff (mas fiel en el minimo verdadero que sobre cmnd).
  let refinedTau = bestTau
  if (bestTau > 1 && bestTau < tauMax) {
    const y0 = diff[bestTau - 1]
    const y1 = diff[bestTau]
    const y2 = diff[bestTau + 1]
    const denom = 2 * (2 * y1 - y2 - y0)
    if (Math.abs(denom) > EPS) {
      const shift = (y2 - y0) / denom
      if (Math.abs(shift) < 1) refinedTau = bestTau + shift
    }
  }

  const hz = sampleRate / refinedTau
  if (!(hz >= minHz * 0.9 && hz <= maxHz * 1.1)) return null
  const confidence = Math.max(0, Math.min(1, 1 - cmnd[bestTau]))
  const info = frequencyToNoteInfo(hz, options.referenceA4Hz ?? 440)
  return { hz, ...info, confidence }
}

// ---------------------------------------------------------------------------
// 3. Alineacion inter-pista por Correlacion Cruzada Generalizada (GCC-PHAT)
// ---------------------------------------------------------------------------

export interface PhaseAlignmentResult {
  /** Muestras que `target` esta retrasada respecto a `reference` (>0 = mover `target` a la izquierda). */
  lagSamples: number
  lagMs: number
  lagSeconds: number
  /** Polaridad optima para `target`: +1 normal, -1 requiere invertir fase (180 grados). */
  polarity: 1 | -1
  /** Coeficiente normalizado de correlacion tras alinear [0..1]. */
  correlation: number
}

/**
 * Estima el retardo exacto y la polaridad entre `reference` y `target` combinando GCC-PHAT-beta
 * en el dominio de la frecuencia con verificacion normalizada de energia en el dominio del tiempo.
 *
 * Convencion: si `target[n] = polarity * reference[n - lagSamples]`, devuelve `lagSamples` y `polarity`.
 * Por tanto, para alinear `target` con `reference`, hay que adelantar `target` en `lagSeconds`
 * (`clip.startS - lagSeconds`) y aplicar `phaseInvert` si `polarity === -1`.
 */
export function alignPhaseCrossCorrelation(
  reference: Float32Array,
  target: Float32Array,
  sampleRate: number,
  maxLagMs = 50,
): PhaseAlignmentResult {
  if (!(sampleRate > 0) || reference.length === 0 || target.length === 0) {
    return { lagSamples: 0, lagMs: 0, lagSeconds: 0, polarity: 1, correlation: 0 }
  }
  // Analizar tramo con mayor energia (hasta 32768 muestras ~ 0,68 s a 48 kHz).
  const maxSlice = Math.min(32768, reference.length, target.length)
  let bestWindowStart = 0
  if (Math.min(reference.length, target.length) > maxSlice) {
    const step = maxSlice >> 1
    let maxE = -1
    const limit = Math.min(reference.length, target.length) - maxSlice
    for (let pos = 0; pos <= limit; pos += step) {
      let e = 0
      for (let i = 0; i < maxSlice; i += 8) e += reference[pos + i] * reference[pos + i]
      if (e > maxE) {
        maxE = e
        bestWindowStart = pos
      }
    }
  }

  const refSlice = reference.subarray(bestWindowStart, bestWindowStart + maxSlice)
  const tgtSlice = target.subarray(bestWindowStart, bestWindowStart + maxSlice)
  const maxLag = Math.min(maxSlice >> 2, Math.max(1, Math.round((maxLagMs / 1000) * sampleRate)))
  const fftLen = nextPow2(maxSlice * 2)

  const xRe = new Float64Array(fftLen)
  const xIm = new Float64Array(fftLen)
  const yRe = new Float64Array(fftLen)
  const yIm = new Float64Array(fftLen)

  for (let i = 0; i < maxSlice; i++) {
    xRe[i] = refSlice[i]
    yRe[i] = tgtSlice[i]
  }
  fftRadix2(xRe, xIm, false)
  fftRadix2(yRe, yIm, false)

  // Producto cruzado R_yx(k) = Y(k) * conj(X(k)) con ponderacion PHAT parcial (beta = 0.65).
  const cRe = new Float64Array(fftLen)
  const cIm = new Float64Array(fftLen)
  const pRe = new Float64Array(fftLen)
  const pIm = new Float64Array(fftLen)
  for (let k = 0; k < fftLen; k++) {
    const re = yRe[k] * xRe[k] + yIm[k] * xIm[k]
    const im = yIm[k] * xRe[k] - yRe[k] * xIm[k]
    cRe[k] = re
    cIm[k] = im
    const mag = Math.hypot(re, im)
    const w = mag > EPS ? Math.pow(mag, -0.65) : 0
    pRe[k] = re * w
    pIm[k] = im * w
  }
  fftRadix2(cRe, cIm, true)
  fftRadix2(pRe, pIm, true)

  // Recoger candidatos top de GCC-PHAT y de correlacion estandar dentro de [-maxLag, +maxLag].
  const candidates = new Set<number>([0])
  let bestPhatAbs = -1
  let bestPhatLag = 0
  let bestStdAbs = -1
  let bestStdLag = 0

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const idx = lag >= 0 ? lag : fftLen + lag
    const pAbs = Math.abs(pRe[idx])
    if (pAbs > bestPhatAbs) {
      bestPhatAbs = pAbs
      bestPhatLag = lag
    }
    const sAbs = Math.abs(cRe[idx])
    if (sAbs > bestStdAbs) {
      bestStdAbs = sAbs
      bestStdLag = lag
    }
  }
  for (let d = -2; d <= 2; d++) {
    if (Math.abs(bestPhatLag + d) <= maxLag) candidates.add(bestPhatLag + d)
    if (Math.abs(bestStdLag + d) <= maxLag) candidates.add(bestStdLag + d)
  }

  // Evaluar el coeficiente de Pearson exacto en cada candidato para obtener signo de fase y correlacion real.
  let winnerLag = 0
  let winnerCorr = 0
  for (const lag of candidates) {
    let dot = 0
    let eRef = 0
    let eTgt = 0
    const iStart = Math.max(0, -lag)
    const iEnd = Math.min(maxSlice, maxSlice - lag)
    for (let i = iStart; i < iEnd; i++) {
      const r = refSlice[i]
      const t = tgtSlice[i + lag]
      dot += r * t
      eRef += r * r
      eTgt += t * t
    }
    const denom = Math.sqrt(eRef * eTgt)
    const corr = denom > EPS ? dot / denom : 0
    if (Math.abs(corr) > Math.abs(winnerCorr)) {
      winnerCorr = corr
      winnerLag = lag
    }
  }

  const polarity: 1 | -1 = winnerCorr < 0 ? -1 : 1
  const lagSeconds = winnerLag / sampleRate
  return {
    lagSamples: winnerLag,
    lagMs: Math.round(lagSeconds * 100000) / 100,
    lagSeconds,
    polarity,
    correlation: Math.min(1, Math.abs(winnerCorr)),
  }
}

// ---------------------------------------------------------------------------
// 4. Deteccion Musical Local: Transientes, BPM, Tonalidad/Camelot y Acordes Viterbi
// ---------------------------------------------------------------------------

/** Detecta instantes de ataque (segundos) usando flujo espectral positivo + umbral de mediana movil. */
export function detectTransients(
  samples: Float32Array,
  sampleRate: number,
  options: { sensitivity?: number; minIntervalMs?: number } = {},
): number[] {
  if (!(sampleRate > 0) || samples.length < 1024) return []
  const sensitivity = Math.max(0, Math.min(1, options.sensitivity ?? 0.55))
  const minGapS = (options.minIntervalMs ?? 60) / 1000
  const fftSize = 1024
  const hop = 256
  const bins = (fftSize >> 1) + 1
  const win = hannWindow(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const prevMag = new Float64Array(bins)

  const numFrames = Math.floor((samples.length - fftSize) / hop) + 1
  if (numFrames < 3) return []
  const flux = new Float64Array(numFrames)
  let maxFlux = 0

  for (let f = 0; f < numFrames; f++) {
    const pos = f * hop
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[pos + i] * win[i]
      im[i] = 0
    }
    fftRadix2(re, im, false)
    let sum = 0
    for (let k = 1; k < bins; k++) {
      const mag = Math.log1p(10 * Math.hypot(re[k], im[k]))
      const diff = mag - prevMag[k]
      if (diff > 0) sum += diff
      prevMag[k] = mag
    }
    flux[f] = f === 0 ? 0 : sum
    if (flux[f] > maxFlux) maxFlux = flux[f]
  }
  if (!(maxFlux > EPS)) return []

  const radius = 8
  const multiplier = 1.9 - sensitivity * 1.15
  const floor = maxFlux * (0.18 - sensitivity * 0.12)
  const onsets: number[] = []
  let lastOnsetS = -Infinity

  for (let f = 1; f < numFrames - 1; f++) {
    if (!(flux[f] > flux[f - 1] && flux[f] >= flux[f + 1])) continue
    const lo = Math.max(0, f - radius)
    const hi = Math.min(numFrames - 1, f + radius)
    const local: number[] = []
    for (let j = lo; j <= hi; j++) local.push(flux[j])
    local.sort((a, b) => a - b)
    const median = local[local.length >> 1]
    const thresh = Math.max(floor, median * multiplier)
    if (flux[f] > thresh) {
      const tS = (f * hop) / sampleRate
      if (tS - lastOnsetS >= minGapS) {
        onsets.push(Math.round(tS * 1000) / 1000)
        lastOnsetS = tS
      }
    }
  }
  return onsets
}

/** Estima el BPM local [60..200] por autocorrelacion ponderada de la envolvente de inicios. */
export function detectBpmLocal(samples: Float32Array, sampleRate: number): { bpm: number; confidence: number } | null {
  if (!(sampleRate > 0) || samples.length < sampleRate * 1.5) return null
  const hop = Math.max(64, Math.round(sampleRate / 200)) // ~200 Hz de tasa de envolvente
  const envRate = sampleRate / hop
  const frames = Math.floor(samples.length / hop)
  if (frames < 64) return null

  const env = new Float64Array(frames)
  let prevE = 0
  for (let f = 0; f < frames; f++) {
    let e = 0
    const base = f * hop
    for (let i = 0; i < hop; i++) {
      const s = samples[base + i]
      e += s * s
    }
    const rms = Math.sqrt(e / hop)
    const diff = rms - prevE
    env[f] = diff > 0 ? diff : 0
    prevE = rms
  }

  let mean = 0
  for (let f = 0; f < frames; f++) mean += env[f]
  mean /= frames
  let energy = 0
  for (let f = 0; f < frames; f++) {
    env[f] = Math.max(0, env[f] - mean * 0.5)
    energy += env[f] * env[f]
  }
  if (!(energy > EPS)) return null

  const minBpm = 60
  const maxBpm = 200
  const minLag = Math.max(2, Math.floor((60 * envRate) / maxBpm))
  const maxLag = Math.min(frames - 2, Math.ceil((60 * envRate) / minBpm))
  if (maxLag <= minLag) return null

  const acf = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    if (lag < 1 || lag >= frames) continue
    let sum = 0
    for (let i = 0; i + lag < frames; i++) sum += env[i] * env[i + lag]
    const bpm = (60 * envRate) / lag
    // Prior perceptual suave centrado en 120 BPM para evitar octavas dobles/mitad espurias.
    const logPrior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.65, 2))
    acf[lag] = (sum / energy) * (0.75 + 0.25 * logPrior)
  }

  let bestLag = minLag
  let bestVal = -1
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Sumar armonico a 2x lag si cabe (refuerza el pulso de negra).
    const harmonic = lag * 2 <= maxLag ? 0.25 * acf[lag * 2] : 0
    const score = acf[lag] + harmonic
    if (score > bestVal) {
      bestVal = score
      bestLag = lag
    }
  }

  let refinedLag = bestLag
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = acf[bestLag - 1]
    const y1 = acf[bestLag]
    const y2 = acf[bestLag + 1]
    const denom = 2 * (2 * y1 - y2 - y0)
    if (Math.abs(denom) > EPS) {
      const delta = (y2 - y0) / denom
      if (Math.abs(delta) < 1) refinedLag = bestLag + delta
    }
  }

  const rawBpm = (60 * envRate) / refinedLag
  // Si cae muy cerca de un entero (ej. 119.8..120.2), preferir redondeo a 0.5 o entero.
  const rounded = Math.abs(rawBpm - Math.round(rawBpm)) < 0.35 ? Math.round(rawBpm) : Math.round(rawBpm * 10) / 10
  return {
    bpm: Math.max(minBpm, Math.min(maxBpm, rounded)),
    confidence: Math.max(0, Math.min(1, bestVal)),
  }
}

/** Calcula un cromagrama de 12 clases de altura sobre un segmento de audio. */
export function computeChromaVector(samples: Float32Array, sampleRate: number, fftSize = 4096): Float64Array {
  const chroma = new Float64Array(12)
  if (samples.length === 0 || !(sampleRate > 0)) return chroma
  const n = nextPow2(Math.min(fftSize, Math.max(512, samples.length)))
  const bins = (n >> 1) + 1
  const win = hannWindow(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const hop = Math.max(256, n >> 1)
  const maxFrames = 48
  const possible = samples.length >= n ? Math.floor((samples.length - n) / hop) + 1 : 1
  const stride = possible > maxFrames ? Math.ceil(possible / maxFrames) * hop : hop

  for (let pos = 0; pos < samples.length; pos += stride) {
    re.fill(0)
    im.fill(0)
    const copy = Math.min(n, samples.length - pos)
    for (let i = 0; i < copy; i++) re[i] = samples[pos + i] * win[i]
    fftRadix2(re, im, false)
    for (let k = 1; k < bins; k++) {
      const hz = (k * sampleRate) / n
      if (hz < 55 || hz > 4200) continue
      const mag = Math.hypot(re[k], im[k])
      const midi = 69 + 12 * Math.log2(hz / 440)
      const pc = ((Math.round(midi) % 12) + 12) % 12
      chroma[pc] += mag * mag
    }
    if (samples.length < n) break
  }

  let norm = 0
  for (let i = 0; i < 12; i++) norm += chroma[i] * chroma[i]
  norm = Math.sqrt(norm)
  if (norm > EPS) {
    for (let i = 0; i < 12; i++) chroma[i] /= norm
  }
  return chroma
}

function pearson12(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < 12; i++) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= 12
  meanB /= 12
  let num = 0
  let denA = 0
  let denB = 0
  for (let i = 0; i < 12; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den > EPS ? num / den : 0
}

export interface KeyDetectionResult {
  key: string
  root: string
  mode: 'major' | 'minor'
  camelot: string
  confidence: number
}

/** Detecta tonalidad y codigo Camelot usando los perfiles de Krumhansl-Schmuckler. */
export function detectKeyLocal(samples: Float32Array, sampleRate: number): KeyDetectionResult | null {
  const chroma = computeChromaVector(samples, sampleRate)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += chroma[i]
  if (!(sum > EPS)) return null

  let bestCorr = -Infinity
  let bestRoot = 0
  let bestMode: 'major' | 'minor' = 'major'

  const rotated = new Float64Array(12)
  for (let root = 0; root < 12; root++) {
    for (let i = 0; i < 12; i++) rotated[i] = chroma[(root + i) % 12]
    const corrMaj = pearson12(rotated, KS_MAJOR)
    if (corrMaj > bestCorr) {
      bestCorr = corrMaj
      bestRoot = root
      bestMode = 'major'
    }
    const corrMin = pearson12(rotated, KS_MINOR)
    if (corrMin > bestCorr) {
      bestCorr = corrMin
      bestRoot = root
      bestMode = 'minor'
    }
  }

  const rootName = NOTE_NAMES_SHARP[bestRoot]
  const key = bestMode === 'minor' ? `${rootName}m` : rootName
  const camelot = bestMode === 'minor' ? CAMELOT_MINOR[bestRoot] : CAMELOT_MAJOR[bestRoot]
  return {
    key,
    root: rootName,
    mode: bestMode,
    camelot,
    confidence: Math.max(0, Math.min(1, (bestCorr + 1) / 2)),
  }
}

/**
 * Decodificador de progresion de acordes por algoritmo de Viterbi sobre un Modelo Oculto de Markov
 * de 24 estados (12 triadas mayores + 12 menores) sincronizado a la rejilla de beats.
 */
export function detectChordsViterbi(
  samples: Float32Array,
  sampleRate: number,
  bpm: number,
  options: { stepBeats?: number; startBeatOffset?: number } = {},
): StudioChord[] {
  if (!(sampleRate > 0) || !(bpm > 0) || samples.length < 1024) return []
  const stepBeats = options.stepBeats ?? 2
  const offsetBeat = options.startBeatOffset ?? 0
  const frameSamples = Math.max(512, Math.round(((60 / bpm) * stepBeats) * sampleRate))
  const numFrames = Math.max(1, Math.floor(samples.length / frameSamples))

  // Construir plantillas para 24 estados: 0..11 Mayor, 12..23 Menor, con penalizacion fuera del acorde.
  const templates: Float64Array[] = []
  for (let state = 0; state < 24; state++) {
    const root = state % 12
    const isMinor = state >= 12
    const tpl = new Float64Array(12).fill(-0.35)
    tpl[root] = 1.0
    tpl[(root + (isMinor ? 3 : 4)) % 12] = 0.88
    tpl[(root + 7) % 12] = 0.92
    templates.push(tpl)
  }

  // Matriz de log-probabilidad de transicion suave (estabiliza ruido fugaz sin fusionar acordes reales).
  const logTrans = Array.from({ length: 24 }, (_, from) => {
    const row = new Float64Array(24)
    const rFrom = from % 12
    const minFrom = from >= 12
    for (let to = 0; to < 24; to++) {
      if (from === to) {
        row[to] = -0.12
        continue
      }
      const rTo = to % 12
      const minTo = to >= 12
      const dist = Math.min((rTo - rFrom + 12) % 12, (rFrom - rTo + 12) % 12)
      const isFifth = dist === 5 || dist === 7
      const isRelative = (minFrom && !minTo && (rFrom + 3) % 12 === rTo) || (!minFrom && minTo && (rTo + 3) % 12 === rFrom)
      row[to] = isRelative ? -0.45 : isFifth ? -0.5 : dist <= 4 ? -0.6 : -0.85
    }
    return row
  })

  const dp = Array.from({ length: numFrames }, () => new Float64Array(24))
  const back = Array.from({ length: numFrames }, () => new Int32Array(24))

  for (let f = 0; f < numFrames; f++) {
    const seg = samples.subarray(f * frameSamples, Math.min(samples.length, (f + 1) * frameSamples))
    const chroma = computeChromaVector(seg, sampleRate, 4096)
    for (let s = 0; s < 24; s++) {
      let sim = 0
      const tpl = templates[s]
      for (let i = 0; i < 12; i++) sim += chroma[i] * tpl[i]
      const logEmit = 5.5 * sim
      if (f === 0) {
        dp[0][s] = logEmit
        back[0][s] = 0
      } else {
        let bestPrev = 0
        let bestScore = -Infinity
        for (let p = 0; p < 24; p++) {
          const cand = dp[f - 1][p] + logTrans[p][s]
          if (cand > bestScore) {
            bestScore = cand
            bestPrev = p
          }
        }
        dp[f][s] = bestScore + logEmit
        back[f][s] = bestPrev
      }
    }
  }

  // Backtracking de Viterbi.
  const states = new Int32Array(numFrames)
  let lastBest = 0
  let lastScore = -Infinity
  for (let s = 0; s < 24; s++) {
    if (dp[numFrames - 1][s] > lastScore) {
      lastScore = dp[numFrames - 1][s]
      lastBest = s
    }
  }
  states[numFrames - 1] = lastBest
  for (let f = numFrames - 1; f > 0; f--) {
    states[f - 1] = back[f][states[f]]
  }

  // Fusionar cuadros consecutivos con el mismo acorde.
  const chords: StudioChord[] = []
  const stateName = (st: number) => `${NOTE_NAMES_SHARP[st % 12]}${st >= 12 ? 'm' : ''}`
  let runStart = 0
  for (let f = 1; f <= numFrames; f++) {
    if (f === numFrames || states[f] !== states[runStart]) {
      const beat = roundBeat(offsetBeat + runStart * stepBeats)
      const lengthBeats = roundBeat((f - runStart) * stepBeats)
      if (beat >= 0 && beat + lengthBeats <= STUDIO_MAX_BEAT) {
        chords.push({ beat, lengthBeats, name: stateName(states[runStart]) })
      }
      runStart = f
    }
  }
  return chords.sort(compareChords)
}

// ---------------------------------------------------------------------------
// 5. Telemetria Estereo (Pearson, Lissajous) y Dinamica (LRA, Factor de Cresta)
// ---------------------------------------------------------------------------

/** Coeficiente de correlacion de fase estereo de Pearson r en [-1, +1]. Mono = +1. */
export function pearsonPhaseCorrelation(left: Float32Array, right: Float32Array): number {
  const n = Math.min(left.length, right.length)
  if (n === 0) return 1
  let sumLR = 0
  let sumL2 = 0
  let sumR2 = 0
  for (let i = 0; i < n; i++) {
    const l = left[i]
    const r = right[i]
    sumLR += l * r
    sumL2 += l * l
    sumR2 += r * r
  }
  const den = Math.sqrt(sumL2 * sumR2)
  if (!(den > EPS)) return 1
  return Math.max(-1, Math.min(1, sumLR / den))
}

export interface LissajousPoint {
  /** Side = (L - R) / sqrt(2) en [-1, 1]. */
  x: number
  /** Mid = (L + R) / sqrt(2) en [-1, 1]. */
  y: number
}

/** Puntos submuestreados para renderizar goniometro vectorial Mid/Side (Lissajous). */
export function lissajousPoints(left: Float32Array, right: Float32Array, maxPoints = 256): LissajousPoint[] {
  const n = Math.min(left.length, right.length)
  if (n === 0) return []
  const step = Math.max(1, Math.floor(n / maxPoints))
  const invSqrt2 = Math.SQRT1_2
  const out: LissajousPoint[] = []
  for (let i = 0; i < n && out.length < maxPoints; i += step) {
    const l = left[i]
    const r = right[i]
    out.push({
      x: Math.max(-1, Math.min(1, (l - r) * invSqrt2)),
      y: Math.max(-1, Math.min(1, (l + r) * invSqrt2)),
    })
  }
  return out
}

/** Rango de sonoridad LRA (EBU R128: percentil 95 menos percentil 10 de bloques short-term de 3 s). */
export function loudnessRangeLu(channels: Float32Array[], sampleRate: number): number {
  if (!(sampleRate > 0) || channels.length === 0) return 0
  const used = channels.slice(0, 2)
  const len = Math.min(...used.map((c) => c.length))
  const stepSamples = Math.max(1, Math.round(sampleRate * 0.1)) // 100 ms
  const totalSteps = Math.floor(len / stepSamples)
  if (totalSteps < 10) return 0

  const { shelf, highpass } = kWeightingCoefficients(sampleRate)
  const subEnergies = new Float64Array(totalSteps)

  for (let c = 0; c < used.length; c++) {
    const data = used[c]
    let s1 = 0
    let s2 = 0
    let t1 = 0
    let t2 = 0
    for (let st = 0; st < totalSteps; st++) {
      let sum = 0
      const base = st * stepSamples
      for (let i = base; i < base + stepSamples; i++) {
        const x = data[i] || 0
        const y = shelf.b0 * x + s1
        s1 = shelf.b1 * x - shelf.a1 * y + s2
        s2 = shelf.b2 * x - shelf.a2 * y
        const z = highpass.b0 * y + t1
        t1 = highpass.b1 * y - highpass.a1 * z + t2
        t2 = highpass.b2 * y - highpass.a2 * z
        sum += z * z
      }
      subEnergies[st] += sum / stepSamples
    }
  }

  // Ventana short-term de 3 s (30 sub-bloques; si el audio es mas corto pero >= 1 s, ventana adaptada).
  const winSize = Math.min(30, Math.max(4, Math.floor(totalSteps / 2)))
  const stLufs: number[] = []
  for (let i = winSize - 1; i < totalSteps; i++) {
    let meanSq = 0
    for (let j = i - winSize + 1; j <= i; j++) meanSq += subEnergies[j]
    meanSq /= winSize
    const l = meanSq > EPS ? -0.691 + 10 * Math.log10(meanSq) : -Infinity
    if (l > -70) stLufs.push(l)
  }
  if (stLufs.length < 2) return 0
  const meanLin = stLufs.reduce((acc, l) => acc + Math.pow(10, l / 10), 0) / stLufs.length
  const relGate = 10 * Math.log10(meanLin) - 20
  const gated = stLufs.filter((l) => l >= relGate).sort((a, b) => a - b)
  if (gated.length < 2) return 0
  const p10 = gated[Math.floor((gated.length - 1) * 0.1)]
  const p95 = gated[Math.floor((gated.length - 1) * 0.95)]
  return Math.max(0, Math.round((p95 - p10) * 10) / 10)
}

export interface AudioMathTelemetry {
  lufs: number
  truePeakDb: number
  plrDb: number
  lraLu: number
  phaseCorrelation: number
  centroidHz: number
  barkDb: Float32Array
}

/** Calcula toda la telemetria matematica de un conjunto de canales de audio. */
export function measureAudioTelemetry(channels: Float32Array[], sampleRate: number): AudioMathTelemetry {
  const lufs = integratedLufs(channels, sampleRate)
  const tp = truePeakDb(channels, sampleRate)
  const plrDb = Number.isFinite(lufs) && Number.isFinite(tp) ? Math.round((tp - lufs) * 10) / 10 : 0
  const lraLu = loudnessRangeLu(channels, sampleRate)
  const phaseCorrelation =
    channels.length >= 2 ? Math.round(pearsonPhaseCorrelation(channels[0], channels[1]) * 100) / 100 : 1
  const mono = downmixMono(channels)
  const centroidHz = Math.round(spectralCentroidHz(mono, sampleRate))
  const barkDb = barkBandEnergiesDb(mono, sampleRate)
  return { lufs, truePeakDb: tp, plrDb, lraLu, phaseCorrelation, centroidHz, barkDb }
}
