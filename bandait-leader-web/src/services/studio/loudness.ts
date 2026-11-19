/**
 * Sonoridad del Estudio Bandait segun ITU-R BS.1770-4: LUFS integrado con ponderacion K y doble
 * compuerta, pico real por sobremuestreo x4, y energia por bandas para el asistente de mezcla.
 *
 * - Ponderacion K: dos biquads (realce de agudos y pasa altos). La norma publica los
 *   coeficientes solo para 48 kHz; aqui se recalculan para cualquier frecuencia desde los
 *   parametros analogicos del filtro (los mismos que usan libebur128 y pyloudnorm), y a 48 kHz
 *   dan los de la norma.
 * - Bloques de 400 ms con solape del 75 % (paso de 100 ms), compuerta absoluta en -70 LUFS y
 *   relativa 10 LU por debajo de la media de los bloques que pasan la absoluta.
 * - Canales: 1 (mono) o 2 (izquierda, derecha), todos con peso 1. Un seno de 997 Hz a -23 dBFS
 *   en los dos canales mide -23,0 LUFS; el mismo seno en un solo canal mide -26,0.
 * - Pico real: interpolador polifasico de 4 fases y 12 muestras por fase (seno cardinal con
 *   ventana de Hann). Es exacto hasta cerca de un tercio de la frecuencia de muestreo.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import type { BandEnergies, LoudnessApi } from './types.ts'

export const LOUDNESS_BLOCK_SECONDS = 0.4
export const LOUDNESS_STEP_SECONDS = 0.1
export const LOUDNESS_ABSOLUTE_GATE_LUFS = -70
export const LOUDNESS_RELATIVE_GATE_LU = -10
/** Volumen objetivo que el Hub propone para una mezcla. */
export const LOUDNESS_DEFAULT_TARGET_LUFS = -14
/** Techo de pico real por defecto al normalizar. */
export const LOUDNESS_DEFAULT_CEILING_DB = -1
/** Piso de la energia por banda. */
export const BAND_FLOOR_DB = -120
/** Limites de las bandas del asistente, en Hz (STUDIO_V1.md 6.3). */
export const BAND_EDGES_HZ: readonly [number, number, number] = [200, 2000, 6000]

const LUFS_OFFSET = -0.691
const SUBBLOCKS_PER_BLOCK = 4

// ---------------------------------------------------------------------------
// Ponderacion K
// ---------------------------------------------------------------------------

/** Biquad en forma directa, con a0 normalizado a 1. */
export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface KWeighting {
  /** Etapa 1: realce de agudos (modela la cabeza). */
  shelf: Biquad
  /** Etapa 2: pasa altos (curva RLB). */
  highpass: Biquad
}

/** Coeficientes de la ponderacion K de BS.1770 para `sampleRate`. */
export function kWeightingCoefficients(sampleRate: number): KWeighting {
  if (!(sampleRate > 0)) throw new Error('sampleRate invalido')
  // Etapa 1.
  const f0 = 1681.974450955533
  const gainDb = 3.999843853973347
  const q = 0.7071752369554196
  const k = Math.tan((Math.PI * f0) / sampleRate)
  const vh = Math.pow(10, gainDb / 20)
  const vb = Math.pow(vh, 0.4996667741545416)
  const a0 = 1 + k / q + k * k
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  }
  // Etapa 2.
  const f1 = 38.13547087602444
  const q1 = 0.5003270373238773
  const k1 = Math.tan((Math.PI * f1) / sampleRate)
  const d = 1 + k1 / q1 + k1 * k1
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k1 * k1 - 1)) / d, a2: (1 - k1 / q1 + k1 * k1) / d }
  return { shelf, highpass }
}

function energyToLufs(meanSquare: number): number {
  return meanSquare > 0 ? LUFS_OFFSET + 10 * Math.log10(meanSquare) : -Infinity
}

/** Medidor incremental: recibe audio por bloques y da el LUFS momentaneo y el integrado. */
export interface LoudnessMeter {
  /**
   * Agrega audio. `channels` trae un Float32Array por canal (los que el medidor declaro al
   * crearse); `length` limita cuantas muestras se leen (por defecto, el canal mas corto).
   * No asigna memoria salvo al crecer la lista de bloques (una vez cada varios minutos).
   */
  push(channels: readonly Float32Array[], length?: number): void
  /** LUFS de los ultimos 400 ms completos, sin compuerta. -Infinity si aun no hay 400 ms. */
  momentaryLufs(): number
  /** LUFS integrado con doble compuerta de todo lo recibido. -Infinity si es silencio. */
  integratedLufs(): number
  reset(): void
}

export function createLoudnessMeter(sampleRate: number, channelCount: number): LoudnessMeter {
  const count = Math.max(1, Math.floor(channelCount))
  const { shelf, highpass } = kWeightingCoefficients(sampleRate)
  const step = Math.max(1, Math.round(LOUDNESS_STEP_SECONDS * sampleRate))
  // Estado de los dos biquads por canal (forma directa II transpuesta): s1, s2 de cada etapa.
  const state = new Float64Array(count * 4)
  /** Suma de cuadrados (todos los canales) de cada tramo de 100 ms ya completo. */
  let sub = new Float64Array(1024)
  let subCount = 0
  let acc = 0
  let accSamples = 0

  function pushSub(value: number): void {
    if (subCount === sub.length) {
      const grown = new Float64Array(sub.length * 2)
      grown.set(sub)
      sub = grown
    }
    sub[subCount++] = value
  }

  function blockMeanSquare(lastSub: number): number {
    return (sub[lastSub] + sub[lastSub - 1] + sub[lastSub - 2] + sub[lastSub - 3]) / (SUBBLOCKS_PER_BLOCK * step)
  }

  return {
    push(channels: readonly Float32Array[], length?: number): void {
      let total = Infinity
      for (let c = 0; c < count; c++) {
        const data = channels[c]
        if (!data) return
        if (data.length < total) total = data.length
      }
      if (length !== undefined && length < total) total = Math.max(0, Math.floor(length))
      if (!Number.isFinite(total)) return
      let done = 0
      while (done < total) {
        const take = Math.min(step - accSamples, total - done)
        for (let c = 0; c < count; c++) {
          const data = channels[c]
          const o = c * 4
          let s1 = state[o]
          let s2 = state[o + 1]
          let t1 = state[o + 2]
          let t2 = state[o + 3]
          let sum = 0
          for (let i = done; i < done + take; i++) {
            const raw = data[i]
            const x = raw === raw ? raw : 0
            const y = shelf.b0 * x + s1
            s1 = shelf.b1 * x - shelf.a1 * y + s2
            s2 = shelf.b2 * x - shelf.a2 * y
            const z = highpass.b0 * y + t1
            t1 = highpass.b1 * y - highpass.a1 * z + t2
            t2 = highpass.b2 * y - highpass.a2 * z
            sum += z * z
          }
          // Un infinito en la entrada envenenaria el filtro para siempre: se reinicia el canal.
          if (!Number.isFinite(sum)) {
            s1 = s2 = t1 = t2 = 0
            sum = 0
          }
          state[o] = s1
          state[o + 1] = s2
          state[o + 2] = t1
          state[o + 3] = t2
          acc += sum
        }
        accSamples += take
        done += take
        if (accSamples === step) {
          pushSub(acc)
          acc = 0
          accSamples = 0
        }
      }
    },
    momentaryLufs(): number {
      if (subCount < SUBBLOCKS_PER_BLOCK) return -Infinity
      return energyToLufs(blockMeanSquare(subCount - 1))
    },
    integratedLufs(): number {
      if (subCount < SUBBLOCKS_PER_BLOCK) return -Infinity
      // Primera pasada: compuerta absoluta.
      let sum = 0
      let n = 0
      for (let i = SUBBLOCKS_PER_BLOCK - 1; i < subCount; i++) {
        const z = blockMeanSquare(i)
        if (energyToLufs(z) > LOUDNESS_ABSOLUTE_GATE_LUFS) {
          sum += z
          n++
        }
      }
      if (n === 0) return -Infinity
      const relativeGate = energyToLufs(sum / n) + LOUDNESS_RELATIVE_GATE_LU
      // Segunda pasada: compuerta absoluta y relativa.
      sum = 0
      n = 0
      for (let i = SUBBLOCKS_PER_BLOCK - 1; i < subCount; i++) {
        const z = blockMeanSquare(i)
        const l = energyToLufs(z)
        if (l > LOUDNESS_ABSOLUTE_GATE_LUFS && l > relativeGate) {
          sum += z
          n++
        }
      }
      return n === 0 ? -Infinity : energyToLufs(sum / n)
    },
    reset(): void {
      state.fill(0)
      subCount = 0
      acc = 0
      accSamples = 0
    },
  }
}

export function integratedLufs(channels: Float32Array[], sampleRate: number): number {
  if (!(sampleRate > 0) || channels.length === 0) return -Infinity
  const used = channels.slice(0, 2)
  const meter = createLoudnessMeter(sampleRate, used.length)
  meter.push(used)
  return meter.integratedLufs()
}

// ---------------------------------------------------------------------------
// Pico real
// ---------------------------------------------------------------------------

const TP_PHASES = 4
const TP_TAPS = 12
/** La fase p usa las muestras n - TP_BEFORE .. n + TP_AFTER. */
const TP_BEFORE = TP_TAPS / 2 - 1
const TP_AFTER = TP_TAPS / 2
const TP_BLOCK = 64

interface TruePeakFilter {
  /** Coeficientes de las fases 1..3 (la fase 0 es la muestra tal cual), TP_TAPS por fase. */
  taps: Float64Array
  /** Cota de ganancia: mayor suma de |coeficiente| de una fase. */
  maxGain: number
}

let truePeakFilter: TruePeakFilter | null = null

function getTruePeakFilter(): TruePeakFilter {
  if (truePeakFilter) return truePeakFilter
  const taps = new Float64Array((TP_PHASES - 1) * TP_TAPS)
  let maxGain = 1
  for (let p = 1; p < TP_PHASES; p++) {
    const frac = p / TP_PHASES
    let sum = 0
    const base = (p - 1) * TP_TAPS
    for (let j = 0; j < TP_TAPS; j++) {
      // x(n + frac) = suma de x[n + k] * sinc(frac - k), con k = j - TP_BEFORE.
      const x = frac - (j - TP_BEFORE)
      const sinc = Math.sin(Math.PI * x) / (Math.PI * x)
      const window = 0.5 * (1 + Math.cos((2 * Math.PI * x) / TP_TAPS))
      taps[base + j] = sinc * window
      sum += taps[base + j]
    }
    let gain = 0
    for (let j = 0; j < TP_TAPS; j++) {
      taps[base + j] /= sum
      gain += Math.abs(taps[base + j])
    }
    if (gain > maxGain) maxGain = gain
  }
  truePeakFilter = { taps, maxGain }
  return truePeakFilter
}

export function truePeakDb(channels: Float32Array[], sampleRate: number): number {
  if (!(sampleRate > 0)) return -Infinity
  const { taps, maxGain } = getTruePeakFilter()
  // Pico de muestra: el pico real nunca es menor.
  let peak = 0
  for (const data of channels) {
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i])
      if (v > peak && v !== Infinity) peak = v
    }
  }
  if (!(peak > 0)) return -Infinity

  for (const data of channels) {
    const len = data.length
    const blocks = Math.ceil(len / TP_BLOCK)
    const blockMax = new Float32Array(blocks + 2)
    for (let b = 0; b < blocks; b++) {
      const to = Math.min((b + 1) * TP_BLOCK, len)
      let m = 0
      for (let i = b * TP_BLOCK; i < to; i++) {
        const v = Math.abs(data[i])
        if (v > m && v !== Infinity) m = v
      }
      blockMax[b + 1] = m
    }
    for (let b = 0; b < blocks; b++) {
      // Lo interpolado en este bloque depende de sus muestras y de las de los dos vecinos. Si ni
      // con la ganancia maxima del filtro pueden pasar el pico actual, el bloque se salta: asi el
      // costo se concentra en los pasajes fuertes.
      const around = Math.max(blockMax[b], blockMax[b + 1], blockMax[b + 2])
      if (around * maxGain <= peak) continue
      const from = b * TP_BLOCK
      const to = Math.min(from + TP_BLOCK, len)
      for (let n = from; n < to; n++) {
        const inside = n - TP_BEFORE >= 0 && n + TP_AFTER < len
        for (let p = 0; p < TP_PHASES - 1; p++) {
          const base = p * TP_TAPS
          let y = 0
          if (inside) {
            const start = n - TP_BEFORE
            for (let j = 0; j < TP_TAPS; j++) y += taps[base + j] * data[start + j]
          } else {
            for (let j = 0; j < TP_TAPS; j++) {
              const i = n - TP_BEFORE + j
              if (i >= 0 && i < len) y += taps[base + j] * data[i]
            }
          }
          const v = Math.abs(y)
          if (v > peak && v !== Infinity) peak = v
        }
      }
    }
  }
  return 20 * Math.log10(peak)
}

export function gainToTargetLufs(currentLufs: number, targetLufs: number, truePeak?: number, ceilingDb: number = LOUDNESS_DEFAULT_CEILING_DB): number {
  if (!Number.isFinite(currentLufs) || !Number.isFinite(targetLufs)) return 0
  let gain = targetLufs - currentLufs
  if (truePeak !== undefined && Number.isFinite(truePeak) && Number.isFinite(ceilingDb)) {
    const headroom = ceilingDb - truePeak
    if (gain > headroom) gain = headroom
  }
  return gain
}

// ---------------------------------------------------------------------------
// Energia por bandas
// ---------------------------------------------------------------------------

/** Cuadros que se analizan como maximo: en un audio largo se toman repartidos de forma pareja. */
const BAND_MAX_FRAMES = 1024

interface FftPlan {
  size: number
  cos: Float64Array
  sin: Float64Array
  reverse: Uint32Array
  window: Float64Array
}

const fftPlans = new Map<number, FftPlan>()

function getFftPlan(size: number): FftPlan {
  const cached = fftPlans.get(size)
  if (cached) return cached
  const bits = Math.round(Math.log2(size))
  const cos = new Float64Array(size / 2)
  const sin = new Float64Array(size / 2)
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size)
    sin[i] = Math.sin((2 * Math.PI * i) / size)
  }
  const reverse = new Uint32Array(size)
  for (let i = 0; i < size; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b)
    reverse[i] = r
  }
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size))
  const plan: FftPlan = { size, cos, sin, reverse, window }
  fftPlans.set(size, plan)
  return plan
}

/** FFT radix-2 en el sitio. `re` e `im` ya vienen en orden de bits invertidos. */
function fft(plan: FftPlan, re: Float64Array, im: Float64Array): void {
  const size = plan.size
  for (let half = 1; half < size; half *= 2) {
    const stride = size / (half * 2)
    for (let start = 0; start < size; start += half * 2) {
      for (let k = 0; k < half; k++) {
        const wr = plan.cos[k * stride]
        const wi = -plan.sin[k * stride]
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

function relativeDb(part: number, total: number): number {
  if (!(part > 0)) return BAND_FLOOR_DB
  const db = 10 * Math.log10(part / total)
  return db < BAND_FLOOR_DB ? BAND_FLOOR_DB : db > 0 ? 0 : db
}

export function bandEnergiesDb(channels: Float32Array[], sampleRate: number): BandEnergies | null {
  if (!(sampleRate > 0) || channels.length === 0) return null
  let length = Infinity
  for (const data of channels) if (data.length < length) length = data.length
  if (!Number.isFinite(length) || length === 0) return null
  // Resolucion cercana a 12 Hz por linea: 4096 hasta 48 kHz, 8192 por encima.
  const size = sampleRate > 50000 ? 8192 : 4096
  const plan = getFftPlan(size)
  const frames = length <= size ? 1 : Math.min(BAND_MAX_FRAMES, Math.floor(length / size))
  const hop = frames <= 1 ? 0 : (length - size) / (frames - 1)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const bands = [0, 0, 0, 0]
  const binHz = sampleRate / size
  const edges = BAND_EDGES_HZ.map((hz) => Math.min(size / 2, Math.ceil(hz / binHz)))
  for (const data of channels) {
    for (let f = 0; f < frames; f++) {
      const start = Math.floor(f * hop)
      for (let i = 0; i < size; i++) {
        const raw = start + i < length ? data[start + i] : 0
        const r = plan.reverse[i]
        re[r] = (Number.isFinite(raw) ? raw : 0) * plan.window[i]
        im[r] = 0
      }
      fft(plan, re, im)
      // La linea 0 (continua) no es audio: no cuenta en ninguna banda.
      let band = 0
      for (let k = 1; k <= size / 2; k++) {
        while (band < 3 && k >= edges[band]) band++
        bands[band] += re[k] * re[k] + im[k] * im[k]
      }
    }
  }
  const total = bands[0] + bands[1] + bands[2] + bands[3]
  // Silencio: menos de -120 dBFS de energia media por linea.
  if (!(total > 0) || total / (frames * channels.length * size * size) < 1e-13) return null
  return {
    lowDb: relativeDb(bands[0], total),
    lowMidDb: relativeDb(bands[1], total),
    highMidDb: relativeDb(bands[2], total),
    highDb: relativeDb(bands[3], total),
  }
}

void ({ integratedLufs, truePeakDb, gainToTargetLufs, bandEnergiesDb } satisfies LoudnessApi)
