/**
 * Motor DSP matematico 100 % local del Estudio Bandait (Cero Cuota de IA).
 *
 * Incluye:
 *   - Transformada Rapida de Fourier Cooley-Tukey radix-2 en sitio (FFT / IFFT) + STFT
 *   - 24 bandas criticas psicoacusticas de Zwicker (escala Bark)
 *   - Deteccion de frecuencia fundamental f0 por algoritmo YIN (funcion de diferencia por FFT e
 *     interpolacion parabolica). Error < 0,5 cents SOLO con senal limpia y armonica; con ruido el
 *     error crece (SNR 10 dB: decenas de cents en graves) y la confianza baja en proporcion.
 *   - Alineacion automatica de fase y retardo inter-pista por Correlacion Cruzada Generalizada (GCC-PHAT)
 *   - Deteccion musical local: BPM por autocorrelacion de una envolvente de inicios en dos bandas con
 *     correccion de octava (T, 2T, T/2), Tonalidad/Camelot por perfiles de Krumhansl-Schmuckler y
 *     secuencia de Acordes por decodificacion Viterbi sobre HMM. Cada resultado trae una confianza
 *     real (0 con ruido o silencio): quien escribe en la sesion debe respetar los umbrales exportados.
 *   - Deteccion de transientes por Flujo Espectral con umbral adaptativo de mediana movil
 *   - Telemetria estereo y dinamica: correlacion de fase de Pearson, goniometro Lissajous Mid/Side,
 *     rango de sonoridad EBU R128 (LRA) y factor de cresta (PLR).
 *
 * Modulo puro: sin DOM, sin Web Audio y sin import.meta.env. Se prueba directamente en Node.
 */
import { createLoudnessMeter, integratedLufs, kWeightingCoefficients, truePeakDb } from './loudness.ts'
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

/**
 * Devuelve `samples` tal cual si todas sus muestras son finitas; si alguna es NaN o infinita,
 * una copia con esas muestras en 0. Un solo NaN contamina una FFT entera (y con ella la
 * tonalidad o el Viterbi), asi que los detectores sanean su entrada con esto.
 */
export function sanitizeSamples(samples: Float32Array): Float32Array {
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]
    if (v - v !== 0) {
      const copy = new Float32Array(samples)
      for (let j = i; j < copy.length; j++) {
        const w = copy[j]
        if (w - w !== 0) copy[j] = 0
      }
      return copy
    }
  }
  return samples
}

/** Promedio de los canales, con el largo del canal mas corto (sea cual sea el numero de canales). */
export function downmixMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  let len = channels[0].length
  for (let c = 1; c < channels.length; c++) len = Math.min(len, channels[c].length)
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
// 2. Algoritmo YIN para deteccion fundamental f0 (< 0,5 cents solo con senal limpia)
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

/** Frecuencia minima que admite YIN: La0 (27,5 Hz), la cuerda mas grave del piano y del bajo de 5. */
export const YIN_MIN_HZ = 27.5

/**
 * Confianza minima para tratar una lectura de YIN como afinacion fiable. Con senal limpia la
 * confianza ronda 0,98; con SNR 20 dB baja a ~0,85 y con SNR 10 dB a ~0,5 (donde el error en
 * graves ya llega a decenas de cents). Un afinador deberia ocultar la aguja por debajo de esto.
 */
export const YIN_RELIABLE_CONFIDENCE = 0.7

interface YinScratch {
  n: number
  aRe: Float64Array
  aIm: Float64Array
  bRe: Float64Array
  bIm: Float64Array
}
let yinScratch: YinScratch | null = null

function yinBuffers(n: number): YinScratch {
  if (!yinScratch || yinScratch.n !== n) {
    yinScratch = { n, aRe: new Float64Array(n), aIm: new Float64Array(n), bRe: new Float64Array(n), bIm: new Float64Array(n) }
  }
  return yinScratch
}

/**
 * Detector monofonico YIN (De Cheveigne & Kawahara, 2002) con funcion de diferencia media
 * acumulada normalizada d'(tau) e interpolacion parabolica sub-muestra.
 *
 * - La funcion de diferencia se calcula por FFT con la ventana mas larga que cabe
 *   (`muestras - tauMax`): menos varianza con ruido y costo O(N log N) (unos 3 FFT de 4096).
 * - Un minimo pegado a `tauMax` no se acepta (no se sabe si es un minimo o si la funcion sigue
 *   bajando fuera del rango): devuelve null en vez de inventar una nota.
 * - `confidence` sale de la aperiodicidad d'(T) (~ fraccion de potencia de ruido): baja con el
 *   ruido aunque la nota siga saliendo bien.
 * - `minHz` admite hasta YIN_MIN_HZ (27,5 Hz); necesita `muestras >= 2 * sampleRate / minHz`.
 */
export function detectPitchYin(
  input: Float32Array,
  sampleRate: number,
  options: { minHz?: number; maxHz?: number; threshold?: number; referenceA4Hz?: number } = {},
): PitchDetectionResult | null {
  if (!(sampleRate > 0) || input.length < 128) return null
  const samples = sanitizeSamples(input)
  const minHz = Math.max(YIN_MIN_HZ, options.minHz ?? 45)
  const maxHz = Math.min(sampleRate / 4, options.maxHz ?? 1600)
  const threshold = options.threshold ?? 0.12
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz))
  // Tres muestras de margen: una nota justo en minHz no queda con su minimo pegado al borde.
  const tauMax = Math.min(Math.floor(samples.length / 2), Math.ceil(sampleRate / minHz) + 3)
  if (tauMax <= tauMin + 2) return null

  const windowLen = samples.length - tauMax
  const total = windowLen + tauMax
  // Comprobar nivel minimo para ignorar silencio.
  let energy = 0
  for (let i = 0; i < total; i++) energy += samples[i] * samples[i]
  if (energy / total < 1e-7) return null

  // d(tau) = sum x[i]^2 + sum x[i+tau]^2 - 2 r(tau), con r(tau) por correlacion circular sin
  // solapamiento (la ventana `a` es cero desde windowLen, asi que n + tau < total <= n).
  const n = nextPow2(total)
  const { aRe, aIm, bRe, bIm } = yinBuffers(n)
  aRe.fill(0)
  aIm.fill(0)
  bRe.fill(0)
  bIm.fill(0)
  for (let i = 0; i < windowLen; i++) aRe[i] = samples[i]
  for (let i = 0; i < total; i++) bRe[i] = samples[i]
  fftRadix2(aRe, aIm, false)
  fftRadix2(bRe, bIm, false)
  for (let k = 0; k < n; k++) {
    // conj(A) * B
    const re = aRe[k] * bRe[k] + aIm[k] * bIm[k]
    const im = aRe[k] * bIm[k] - aIm[k] * bRe[k]
    bRe[k] = re
    bIm[k] = im
  }
  fftRadix2(bRe, bIm, true)

  const cum = new Float64Array(total + 1)
  for (let i = 0; i < total; i++) cum[i + 1] = cum[i] + samples[i] * samples[i]
  const e0 = cum[windowLen]

  const diff = new Float64Array(tauMax + 1)
  const cmnd = new Float64Array(tauMax + 1)
  cmnd[0] = 1
  let runningSum = 0

  for (let tau = 1; tau <= tauMax; tau++) {
    const d = Math.max(0, e0 + (cum[tau + windowLen] - cum[tau]) - 2 * bRe[tau])
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
  // Minimo en el borde del rango: la frecuencia real puede estar por debajo de minHz.
  if (bestTau >= tauMax - 1) return null

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
  // d'(T) ~ potencia aperiodica / potencia total: 0 con senal limpia, ~0,1 con SNR 10 dB.
  const confidence = Math.max(0, Math.min(1, 1 - 1.6 * Math.sqrt(Math.max(0, cmnd[bestTau]))))
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

export interface PhaseAlignmentPlanInput {
  targetStartS: number
  targetLengthS: number
  /** phaseInvert del clip de referencia: la polaridad buscada es la de como SUENA la referencia. */
  referencePhaseInvert: boolean
  /** Resultado de alignPhaseCrossCorrelation sobre el audio crudo (sin phaseInvert aplicado). */
  lagSeconds: number
  polarity: 1 | -1
  maxSessionS: number
}

/**
 * Inicio y polaridad finales del clip a alinear. El analisis compara audio crudo, asi que el clip
 * queda invertido si y solo si (polaridad cruda -1) XOR (referencia invertida). Es un valor
 * absoluto, no un "invertir lo que haya": repetir la accion sobre el resultado no cambia nada.
 */
export function planPhaseAlignment(input: PhaseAlignmentPlanInput): { startS: number; phaseInvert: boolean } {
  const lag = Number.isFinite(input.lagSeconds) ? input.lagSeconds : 0
  const startS = Math.max(0, Math.min(input.maxSessionS - input.targetLengthS, input.targetStartS - lag))
  return { startS, phaseInvert: (input.polarity === -1) !== input.referencePhaseInvert }
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

/** BPM que detecta detectBpmLocal: el rango del contrato de la sesion para un pulso de negra. */
export const BPM_DETECT_MIN = 60
export const BPM_DETECT_MAX = 200
/** Rango preferido al resolver la octava (T, 2T, T/2): fuera de aqui solo se queda con evidencia clara. */
export const BPM_PREFERRED_MIN = 70
export const BPM_PREFERRED_MAX = 180
/** Confianza minima para escribir el BPM detectado en la sesion; por debajo solo se propone. */
export const BPM_APPLY_MIN_CONFIDENCE = 0.5
/** Confianza minima para escribir la tonalidad detectada en la sesion; por debajo solo se propone. */
export const KEY_APPLY_MIN_CONFIDENCE = 0.5
/** Segundos que analiza detectBpmLocal como maximo (el pulso no cambia: el resto es costo). */
const BPM_MAX_ANALYSIS_S = 60

export interface BpmDetectionResult {
  bpm: number
  /** 0..1: autocorrelacion normalizada de la envolvente en el periodo elegido (0 con ruido). */
  confidence: number
}

/** Tasa de la envolvente de inicios (cuadros por segundo). */
const ONSET_ENV_RATE = 100

/**
 * Envolvente de inicios a 100 cuadros/s: flujo espectral positivo (FFT de ~43 ms sobre la senal
 * diezmada a ~12 kHz) en dos bandas, graves bajo ~150 Hz y el resto, cada una normalizada por su
 * propia dispersion. Asi el bombo no tapa a la caja (con bombo en 1 y 3 y caja en 2 y 4 los
 * cuatro tiempos pesan parecido), y una nota o un acorde sostenido no fabrica inicios: su
 * magnitud por bin no cambia, mientras que su energia total si ondula por los batidos entre
 * notas (con un flujo de energia, acordes sostenidos solos daban 113 BPM con confianza 1).
 */
function onsetEnvelope(samples: Float32Array, sampleRate: number): { env: Float64Array; rate: number } {
  const decim = Math.max(1, Math.round(sampleRate / 12000))
  const rate = sampleRate / decim
  // Diezmado con dos pasa bajos de un polo (~0,4 de la nueva Nyquist): lo que se cuele de agudos
  // solo suma flujo en la banda alta, que es donde ya estaba.
  const coef = 1 - Math.exp((-TWO_PI * Math.min(rate * 0.4, 5000)) / sampleRate)
  const len = Math.floor(samples.length / decim)
  const x = new Float32Array(len)
  let a = 0
  let b = 0
  for (let i = 0, j = 0; j < len; i++) {
    a += coef * (samples[i] - a)
    b += coef * (a - b)
    if (i % decim === decim - 1) x[j++] = b
  }
  const n = 512
  const hop = Math.max(1, Math.round(rate / ONSET_ENV_RATE))
  const frames = Math.max(0, Math.floor((len - n) / hop) + 1)
  const low = new Float64Array(frames)
  const high = new Float64Array(frames)
  if (frames < 2) return { env: new Float64Array(frames), rate: rate / hop }
  const bins = n >> 1
  const lowBins = Math.max(1, Math.round((150 * n) / rate))
  const win = hannWindow(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  let prev = new Float64Array(bins + 1)
  let cur = new Float64Array(bins + 1)
  for (let f = 0; f < frames; f++) {
    const base = f * hop
    for (let i = 0; i < n; i++) {
      re[i] = x[base + i] * win[i]
      im[i] = 0
    }
    fftRadix2(re, im, false)
    let fl = 0
    let fh = 0
    for (let k = 1; k <= bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      cur[k] = mag
      const d = mag - prev[k]
      if (d > 0) {
        if (k <= lowBins) fl += d
        else fh += d
      }
    }
    low[f] = f === 0 ? 0 : fl
    high[f] = f === 0 ? 0 : fh
    const swap = prev
    prev = cur
    cur = swap
  }
  const std = (x: Float64Array) => {
    let m = 0
    for (let i = 0; i < x.length; i++) m += x[i]
    m /= x.length
    let v = 0
    for (let i = 0; i < x.length; i++) v += (x[i] - m) * (x[i] - m)
    return Math.sqrt(v / x.length)
  }
  const sL = std(low)
  const sH = std(high)
  const floor = Math.max(sL, sH) * 0.05
  const env = new Float64Array(frames)
  if (!(floor > EPS)) return { env, rate: rate / hop }
  const wL = 1 / Math.max(sL, floor)
  const wH = 1 / Math.max(sH, floor)
  for (let f = 0; f < frames; f++) env[f] = low[f] * wL + high[f] * wH
  return { env, rate: rate / hop }
}

/** Autocorrelacion normalizada e insesgada (r(0) = 1) de `x` ya centrada, por FFT, lags 0..maxLag. */
function normalizedAutocorrelation(x: Float64Array, maxLag: number): Float64Array {
  const n = x.length
  const size = nextPow2(2 * n)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  re.set(x)
  fftRadix2(re, im, false)
  for (let k = 0; k < size; k++) {
    re[k] = re[k] * re[k] + im[k] * im[k]
    im[k] = 0
  }
  fftRadix2(re, im, true)
  const out = new Float64Array(maxLag + 1)
  const r0 = re[0] / n
  if (!(r0 > EPS)) return out
  for (let lag = 0; lag <= maxLag && lag < n; lag++) out[lag] = re[lag] / (n - lag) / r0
  return out
}

/** Valor de `r` en un lag fraccionario (interpolacion lineal). */
function sampleAt(r: Float64Array, lag: number): number {
  const i = Math.floor(lag)
  if (i < 0 || i + 1 >= r.length) return 0
  const fr = lag - i
  return r[i] * (1 - fr) + r[i + 1] * fr
}

/**
 * Relacion entre la energia de inicios a mitad de periodo y la del pulso, con la fase del pulso
 * que mas energia junta. Cerca de 1: la mitad del periodo tambien es un tiempo fuerte (el periodo
 * es el doble del pulso real). Cerca de 0: la mitad esta vacia o solo tiene adornos (corcheas).
 */
function halfPeriodSalience(env: Float64Array, period: number): number {
  const frames = env.length
  const steps = Math.max(1, Math.round(period))
  const beats = Math.floor((frames - 2) / period)
  if (beats < 3) return 0
  const pick = (pos: number) => {
    const i = Math.round(pos)
    if (i < 1 || i >= frames - 1) return 0
    return Math.max(env[i - 1], env[i], env[i + 1])
  }
  let bestOn = -1
  let bestPhase = 0
  for (let phase = 0; phase < steps; phase++) {
    let on = 0
    for (let k = 0; k < beats; k++) on += pick(phase + k * period)
    if (on > bestOn) {
      bestOn = on
      bestPhase = phase
    }
  }
  if (!(bestOn > EPS)) return 0
  let mid = 0
  for (let k = 0; k < beats; k++) mid += pick(bestPhase + k * period + period / 2)
  return mid / bestOn
}

/**
 * Estima el BPM del pulso de negra [60..200] por autocorrelacion de una envolvente de inicios en
 * dos bandas, con correccion de octava:
 *   1. Periodo candidato P = maximo de la autocorrelacion con un prior suave centrado en 120.
 *   2. Si la mitad de P concentra casi tanta energia de inicios como P (caja en 2 y 4 cuando P
 *      dura dos tiempos), el pulso real es P/2. Fuera del rango preferido (70..180) basta menos
 *      evidencia para volver a el.
 *   3. Si el BPM queda por encima del rango preferido y la mitad del periodo esta vacia, se toma 2P.
 * `confidence` es la autocorrelacion normalizada en el pulso (o en su doble, si es mayor): ~0
 * con ruido blanco o silencio, ~1 con un clic. Devuelve null sin pulso medible.
 */
export function detectBpmLocal(input: Float32Array, sampleRate: number): BpmDetectionResult | null {
  if (!(sampleRate > 0) || input.length < sampleRate * 1.5) return null
  const clean = sanitizeSamples(input)
  const samples = clean.length > sampleRate * BPM_MAX_ANALYSIS_S ? clean.subarray(0, Math.round(sampleRate * BPM_MAX_ANALYSIS_S)) : clean
  const { env, rate: envRate } = onsetEnvelope(samples, sampleRate)
  const frames = env.length
  if (frames < 64) return null

  let mean = 0
  for (let f = 0; f < frames; f++) mean += env[f]
  mean /= frames
  const centered = new Float64Array(frames)
  let energy = 0
  for (let f = 0; f < frames; f++) {
    centered[f] = env[f] - mean
    energy += centered[f] * centered[f]
  }
  if (!(energy > EPS)) return null

  const lagOf = (bpm: number) => (60 * envRate) / bpm
  const minLag = Math.max(2, Math.floor(lagOf(BPM_DETECT_MAX)))
  const maxLag = Math.min(frames - 2, Math.ceil(lagOf(BPM_DETECT_MIN)))
  if (maxLag <= minLag + 2) return null
  // Hasta 4 periodos del pulso mas lento: sirve para afinar el periodo y para la confianza.
  const acfMax = Math.min(frames - 2, Math.ceil(maxLag * 4) + 2)
  const r = normalizedAutocorrelation(centered, acfMax)

  // 1. Candidato inicial con prior suave (no decide la octava: eso lo hacen los pasos 2 y 3).
  let bestLag = minLag
  let bestScore = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!(r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1])) continue
    const bpm = (60 * envRate) / lag
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2))
    const score = r[lag] * (0.6 + 0.4 * prior)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (!Number.isFinite(bestScore)) return null

  // Afinado parabolico del periodo.
  const refine = (lag: number): number => {
    const i = Math.round(lag)
    if (i <= 1 || i + 1 >= r.length) return lag
    // Buscar el maximo local mas cercano (+-2) antes de interpolar.
    let peak = i
    for (let d = -2; d <= 2; d++) {
      const j = i + d
      if (j > 0 && j + 1 < r.length && r[j] > r[peak]) peak = j
    }
    const y0 = r[peak - 1]
    const y1 = r[peak]
    const y2 = r[peak + 1]
    const denom = 2 * (2 * y1 - y2 - y0)
    if (Math.abs(denom) > EPS) {
      const delta = (y2 - y0) / denom
      if (Math.abs(delta) < 1) return peak + delta
    }
    return peak
  }
  let period = refine(bestLag)

  // 2 y 3. Correccion de octava con la energia de inicios a mitad de periodo.
  for (let pass = 0; pass < 3; pass++) {
    const bpm = (60 * envRate) / period
    const faster = bpm * 2
    if (faster <= BPM_DETECT_MAX) {
      const ratio = halfPeriodSalience(env, period)
      const need = bpm < BPM_PREFERRED_MIN ? 0.35 : faster <= BPM_PREFERRED_MAX ? 0.55 : 0.6
      if (ratio >= need) {
        period = refine(period / 2)
        continue
      }
    }
    const slower = bpm / 2
    if (bpm > BPM_PREFERRED_MAX && slower >= BPM_DETECT_MIN) {
      const ratio = halfPeriodSalience(env, period * 2)
      if (ratio < 0.35) {
        period = refine(period * 2)
        continue
      }
    }
    break
  }

  // Periodo mas preciso con el multiplo mas largo que cabe (el error de un cuadro se reparte).
  for (const k of [4, 3, 2]) {
    if (period * k + 2 < r.length) {
      const longLag = refine(period * k)
      if (Math.abs(longLag / k - period) < 0.5) period = longLag / k
      break
    }
  }

  const confidenceRaw = Math.max(sampleAt(r, period), period * 2 + 1 < r.length ? sampleAt(r, period * 2) : 0)
  const rawBpm = (60 * envRate) / period
  // Si cae muy cerca de un entero (ej. 119.8..120.2), preferir el entero.
  const rounded = Math.abs(rawBpm - Math.round(rawBpm)) < 0.35 ? Math.round(rawBpm) : Math.round(rawBpm * 10) / 10
  return {
    bpm: Math.max(BPM_DETECT_MIN, Math.min(BPM_DETECT_MAX, rounded)),
    confidence: Math.max(0, Math.min(1, (confidenceRaw - 0.08) / 0.32)),
  }
}

const chromaMaps = new Map<string, Int8Array>()

/** Clase de altura de cada bin (o -1 fuera de 55..4200 Hz), calculada una vez por tamano y frecuencia. */
function chromaBinMap(n: number, sampleRate: number): Int8Array {
  const key = `${n}:${sampleRate}`
  let map = chromaMaps.get(key)
  if (!map) {
    const bins = (n >> 1) + 1
    map = new Int8Array(bins).fill(-1)
    for (let k = 1; k < bins; k++) {
      const hz = (k * sampleRate) / n
      if (hz < 55 || hz > 4200) continue
      const midi = 69 + 12 * Math.log2(hz / 440)
      map[k] = ((Math.round(midi) % 12) + 12) % 12
    }
    if (chromaMaps.size > 16) chromaMaps.clear()
    chromaMaps.set(key, map)
  }
  return map
}

/**
 * Calcula un cromagrama de 12 clases de altura sobre un segmento de audio. `overlap` false usa
 * ventanas contiguas (la mitad de FFT): lo usa el Viterbi, que ya promedia por segmento.
 */
export function computeChromaVector(input: Float32Array, sampleRate: number, fftSize = 4096, overlap = true): Float64Array {
  const chroma = new Float64Array(12)
  if (input.length === 0 || !(sampleRate > 0)) return chroma
  const samples = sanitizeSamples(input)
  const n = nextPow2(Math.min(fftSize, Math.max(512, samples.length)))
  const bins = (n >> 1) + 1
  const pcOf = chromaBinMap(n, sampleRate)
  const win = hannWindow(n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const hop = overlap ? Math.max(256, n >> 1) : n
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
      const pc = pcOf[k]
      if (pc < 0) continue
      chroma[pc] += re[k] * re[k] + im[k] * im[k]
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

/**
 * Detecta tonalidad y codigo Camelot usando los perfiles de Krumhansl-Schmuckler.
 *
 * `confidence` (0..1) combina dos medidas: la correlacion con el mejor perfil (0,2 o menos no
 * dice nada: es lo que da el ruido) y lo "tonal" del cromagrama (1 - planitud espectral de las 12
 * clases: el ruido reparte la energia por igual). Ruido blanco: ~0; una progresion clara: > 0,7.
 */
export function detectKeyLocal(samples: Float32Array, sampleRate: number): KeyDetectionResult | null {
  const chroma = computeChromaVector(samples, sampleRate)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += chroma[i]
  if (!(sum > EPS)) return null
  let logSum = 0
  for (let i = 0; i < 12; i++) logSum += Math.log(Math.max(chroma[i], 1e-9))
  const flatness = Math.exp(logSum / 12) / (sum / 12)

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
    confidence: keyConfidence(bestCorr, flatness),
  }
}

/** Confianza de la tonalidad a partir de la correlacion K-S y la planitud del cromagrama. */
export function keyConfidence(bestCorr: number, chromaFlatness: number): number {
  if (!Number.isFinite(bestCorr) || !Number.isFinite(chromaFlatness)) return 0
  const corrTerm = Math.max(0, Math.min(1, (bestCorr - 0.2) / 0.5))
  // Ruido blanco o rosa: planitud ~0,97-0,99. Una progresion diatonica (7 de 12 notas): ~0,86.
  const tonalTerm = Math.max(0, Math.min(1, (0.97 - chromaFlatness) / 0.1))
  return Math.round(corrTerm * tonalTerm * 1000) / 1000
}

export interface MusicalAnalysisOptions {
  /** BPM de la sesion: rejilla de los acordes cuando el BPM detectado no es fiable. */
  sessionBpm: number
  /** Segundo de la sesion donde empieza `samples` (el inicio del clip analizado). */
  startS: number
  /** Beats por paso del Viterbi (por defecto 2). */
  stepBeats?: number
}

export interface MusicalAnalysis {
  bpm: BpmDetectionResult | null
  key: KeyDetectionResult | null
  /** true si el BPM supera BPM_APPLY_MIN_CONFIDENCE (se puede escribir en la sesion). */
  bpmReliable: boolean
  /** true si la tonalidad supera KEY_APPLY_MIN_CONFIDENCE. */
  keyReliable: boolean
  /** BPM con que se armo la rejilla de acordes: el detectado si es fiable, si no el de la sesion. */
  gridBpm: number
  chords: StudioChord[]
}

/**
 * Deteccion musical completa (BPM, tonalidad y acordes) con politica de confianza. Los acordes se
 * ubican en beats de la rejilla que quedara en la sesion (`gridBpm`), y el desfase del clip se
 * convierte con ese mismo BPM: si el BPM detectado no se aplica, los acordes caen en la rejilla
 * vigente. Puro: lo usa el Web Worker de analisis y, sin Worker, el hilo principal.
 */
export function analyzeMusical(samples: Float32Array, sampleRate: number, options: MusicalAnalysisOptions): MusicalAnalysis {
  const clean = sanitizeSamples(samples)
  const bpm = detectBpmLocal(clean, sampleRate)
  const key = detectKeyLocal(clean, sampleRate)
  const bpmReliable = bpm !== null && bpm.confidence >= BPM_APPLY_MIN_CONFIDENCE
  const keyReliable = key !== null && key.confidence >= KEY_APPLY_MIN_CONFIDENCE
  const gridBpm = bpmReliable && bpm ? bpm.bpm : options.sessionBpm
  const startBeatOffset = roundBeat(Math.max(0, options.startS) * (gridBpm / 60))
  const chords = gridBpm > 0 ? detectChordsViterbi(clean, sampleRate, gridBpm, { stepBeats: options.stepBeats ?? 2, startBeatOffset }) : []
  return { bpm, key, bpmReliable, keyReliable, gridBpm, chords }
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
    const chroma = computeChromaVector(seg, sampleRate, 4096, false)
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

  return lraFromSubBlocks(subEnergies, totalSteps)
}

/** LRA a partir de la potencia ponderada K (suma de canales) de cada tramo de 100 ms. */
function lraFromSubBlocks(subEnergies: Float64Array, totalSteps: number): number {
  if (totalSteps < 10) return 0
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
export function measureAudioTelemetry(input: Float32Array[], sampleRate: number): AudioMathTelemetry {
  const channels = input.map(sanitizeSamples)
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

export interface LoudnessSummary {
  /** LUFS integrado BS.1770 (-Infinity en silencio). */
  lufs: number
  /** Pico real (sobremuestreo x4 de loudness.ts), dBTP. */
  truePeakDb: number
  /** Rango de sonoridad EBU R128 (LU). */
  lraLu: number
  /** Pico real menos LUFS integrado (dB); 0 si alguno no es finito. */
  plrDb: number
}

/** Medicion de sonoridad del master: lo que necesitan Auto-Master y el panel del master. */
export function measureLoudnessSummary(input: Float32Array[], sampleRate: number): LoudnessSummary {
  const channels = input.slice(0, 2).map(sanitizeSamples)
  const lufs = integratedLufs(channels, sampleRate)
  const tp = truePeakDb(channels, sampleRate)
  const plrDb = Number.isFinite(lufs) && Number.isFinite(tp) ? Math.round((tp - lufs) * 10) / 10 : 0
  return { lufs, truePeakDb: tp, lraLu: loudnessRangeLu(channels, sampleRate), plrDb }
}

/** Medidor incremental de LoudnessSummary: recibe el audio por trozos (sin copiarlo entero). */
export interface LoudnessSummaryMeter {
  push(channels: readonly Float32Array[]): void
  summary(): LoudnessSummary
}

/**
 * Version por trozos de measureLoudnessSummary: LUFS integrado con el medidor de loudness.ts,
 * LRA con los mismos tramos de 100 ms que loudnessRangeLu y pico real con truePeakDb sobre cada
 * trozo mas las ultimas muestras del anterior (el interpolador ve a los dos lados del corte).
 */
export function createLoudnessSummaryMeter(sampleRate: number, channelCount: number): LoudnessSummaryMeter {
  const count = Math.max(1, Math.min(2, Math.floor(channelCount)))
  const lufsMeter = createLoudnessMeter(sampleRate, count)
  const { shelf, highpass } = kWeightingCoefficients(sampleRate)
  const step = Math.max(1, Math.round(sampleRate * 0.1))
  const filterState = new Float64Array(count * 4)
  let subs = new Float64Array(1024)
  let subCount = 0
  let acc = 0
  let accSamples = 0
  const overlap = 16
  const tails: Float32Array[] = Array.from({ length: count }, () => new Float32Array(0))
  let peakDb = Number.NEGATIVE_INFINITY

  return {
    push(input: readonly Float32Array[]): void {
      if (!(sampleRate > 0) || input.length < count) return
      const used = input.slice(0, count).map(sanitizeSamples)
      let total = Infinity
      for (const ch of used) total = Math.min(total, ch.length)
      if (!(total > 0) || !Number.isFinite(total)) return
      lufsMeter.push(used, total)

      let done = 0
      while (done < total) {
        const take = Math.min(step - accSamples, total - done)
        for (let c = 0; c < count; c++) {
          const data = used[c]
          const o = c * 4
          let s1 = filterState[o]
          let s2 = filterState[o + 1]
          let t1 = filterState[o + 2]
          let t2 = filterState[o + 3]
          let sum = 0
          for (let i = done; i < done + take; i++) {
            const x = data[i]
            const y = shelf.b0 * x + s1
            s1 = shelf.b1 * x - shelf.a1 * y + s2
            s2 = shelf.b2 * x - shelf.a2 * y
            const z = highpass.b0 * y + t1
            t1 = highpass.b1 * y - highpass.a1 * z + t2
            t2 = highpass.b2 * y - highpass.a2 * z
            sum += z * z
          }
          filterState[o] = s1
          filterState[o + 1] = s2
          filterState[o + 2] = t1
          filterState[o + 3] = t2
          acc += sum / step
        }
        accSamples += take
        done += take
        if (accSamples === step) {
          if (subCount === subs.length) {
            const grown = new Float64Array(subs.length * 2)
            grown.set(subs)
            subs = grown
          }
          subs[subCount++] = acc
          acc = 0
          accSamples = 0
        }
      }

      for (let c = 0; c < count; c++) {
        const tail = tails[c]
        const data = used[c].subarray(0, total)
        const joined = new Float32Array(tail.length + data.length)
        joined.set(tail)
        joined.set(data, tail.length)
        const tp = truePeakDb([joined], sampleRate)
        if (tp > peakDb) peakDb = tp
        tails[c] = joined.slice(Math.max(0, joined.length - overlap))
      }
    },
    summary(): LoudnessSummary {
      const lufs = lufsMeter.integratedLufs()
      const plrDb = Number.isFinite(lufs) && Number.isFinite(peakDb) ? Math.round((peakDb - lufs) * 10) / 10 : 0
      return { lufs, truePeakDb: peakDb, lraLu: lraFromSubBlocks(subs, subCount), plrDb }
    },
  }
}
