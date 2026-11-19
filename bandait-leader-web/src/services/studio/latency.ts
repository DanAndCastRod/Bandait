/**
 * Alineacion de tomas y calibracion de latencia del Estudio Bandait (plan 5.2, STUDIO_V1.md 2.7).
 *
 * La calibracion emite `calibrationSignal` por la salida, la graba por la entrada y mide el
 * retardo con `estimateDelaySamples` (correlacion cruzada normalizada). La senal es una rafaga de
 * seis barridos cortos con separaciones todas distintas: en un retardo equivocado coincide a lo
 * sumo uno de los seis, asi que el pico falso mas alto queda cerca de 1/6 del verdadero.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts). El
 * almacen de calibraciones llega por parametro (`localStorage` en el navegador).
 */
import type { BrowserLatencyInput, DelayEstimate, KeyValueStorage, LatencyApi, LatencyCalibration, TakeStartInput } from './types.ts'

/** Por debajo de esta confianza la calibracion se descarta (falta el cable de Salida 1 a Entrada 1). */
export const LATENCY_MIN_CONFIDENCE = 0.5
/** Retardo maximo que busca la calibracion. Una ida y vuelta por USB ronda los 10 a 40 ms. */
export const LATENCY_MAX_DELAY_MS = 500
/** Prefijo de las claves de calibracion en el almacen. */
export const LATENCY_STORAGE_PREFIX = 'bandait_studio_latency'

/** Inicio de cada barrido de la senal de calibracion, en ms. Todas las diferencias son distintas. */
const CALIBRATION_CLICKS_MS: readonly number[] = [0, 60, 150, 290, 370, 530]
const CALIBRATION_CLICK_MS = 3
const CALIBRATION_TOTAL_MS = 600
const CALIBRATION_F0_HZ = 1000
const CALIBRATION_F1_HZ = 6000
const CALIBRATION_AMPLITUDE = 0.8
/** Vecindad del pico que no cuenta como "segundo pico" (los lobulos del propio barrido). */
const PEAK_NEIGHBORHOOD_MS = 4
/** Desde que proporcion del pico principal un segundo pico empieza a restar confianza. */
const SECOND_PEAK_RATIO = 0.6

const NO_ESTIMATE: DelayEstimate = { delaySamples: 0, confidence: 0 }

export function estimateDelaySamples(reference: Float32Array, recorded: Float32Array, sampleRate: number, maxDelayMs: number): DelayEstimate {
  if (!(sampleRate > 0) || !Number.isFinite(maxDelayMs) || reference.length === 0 || recorded.length === 0) return { ...NO_ESTIMATE }
  const maxDelay = Math.max(0, Math.min(Math.round((maxDelayMs * sampleRate) / 1000), recorded.length - 1))

  // Referencia compacta: solo las muestras distintas de cero (la senal de calibracion es casi
  // toda silencio, y asi cada retardo cuesta unos cientos de productos en vez de decenas de miles).
  let count = 0
  let first = -1
  let last = -1
  let refEnergy = 0
  for (let i = 0; i < reference.length; i++) {
    const v = reference[i]
    if (v === 0 || !Number.isFinite(v)) continue
    count++
    if (first < 0) first = i
    last = i
    refEnergy += v * v
  }
  if (count === 0 || refEnergy < 1e-9) return { ...NO_ESTIMATE }
  const refIndex = new Int32Array(count)
  const refValue = new Float64Array(count)
  let n = 0
  for (let i = first; i <= last; i++) {
    const v = reference[i]
    if (v === 0 || !Number.isFinite(v)) continue
    refIndex[n] = i
    refValue[n] = v
    n++
  }

  // Energia acumulada de lo grabado: la energia de cualquier ventana sale en O(1).
  const total = recorded.length
  const prefix = new Float64Array(total + 1)
  for (let i = 0; i < total; i++) {
    const v = Number.isFinite(recorded[i]) ? recorded[i] : 0
    prefix[i + 1] = prefix[i] + v * v
  }
  const recEnergy = prefix[total]
  if (recEnergy < 1e-9) return { ...NO_ESTIMATE }
  // Una ventana con menos energia que esto es silencio: no puede ser el pico.
  const minWindowEnergy = recEnergy * 1e-6

  const corr = new Float32Array(maxDelay + 1)
  let best = 0
  let bestValue = 0
  for (let d = 0; d <= maxDelay; d++) {
    let sum = 0
    for (let j = 0; j < count; j++) {
      const p = refIndex[j] + d
      if (p >= total) break
      sum += refValue[j] * recorded[p]
    }
    const from = Math.min(first + d, total)
    const to = Math.min(last + d + 1, total)
    const windowEnergy = prefix[to] - prefix[from]
    // Valor absoluto: una interfaz o un cable que invierten la polaridad no cambian el retardo.
    const value = windowEnergy > minWindowEnergy ? Math.abs(sum) / Math.sqrt(refEnergy * windowEnergy) : 0
    corr[d] = value
    if (value > bestValue) {
      bestValue = value
      best = d
    }
  }
  if (!(bestValue > 0)) return { ...NO_ESTIMATE }

  const neighborhood = Math.max(1, Math.round((PEAK_NEIGHBORHOOD_MS * sampleRate) / 1000))
  let second = 0
  for (let d = 0; d <= maxDelay; d++) {
    if (Math.abs(d - best) <= neighborhood) continue
    if (corr[d] > second) second = corr[d]
  }
  const ratio = second / bestValue
  const penalty = ratio <= SECOND_PEAK_RATIO ? 1 : Math.max(0, 1 - (ratio - SECOND_PEAK_RATIO) / (1 - SECOND_PEAK_RATIO))
  return { delaySamples: best, confidence: Math.max(0, Math.min(1, bestValue * penalty)) }
}

export function takeStartSeconds(input: TakeStartInput): number {
  return input.positionAtStart + (input.firstBlockCtxTime - input.playStartCtxTime) - input.roundTripSeconds
}

function nonNegative(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function browserLatencySeconds(input: BrowserLatencyInput): number {
  return nonNegative(input.baseLatency) + nonNegative(input.outputLatency) + nonNegative(input.inputLatency)
}

export function calibrationSignal(sampleRate: number): Float32Array {
  const rate = Math.round(sampleRate)
  if (!(rate > 0)) throw new Error('sampleRate invalido')
  const out = new Float32Array(Math.round((CALIBRATION_TOTAL_MS * rate) / 1000))
  const clickSamples = Math.max(8, Math.round((CALIBRATION_CLICK_MS * rate) / 1000))
  const clickSeconds = clickSamples / rate
  for (const ms of CALIBRATION_CLICKS_MS) {
    const start = Math.round((ms * rate) / 1000)
    for (let i = 0; i < clickSamples && start + i < out.length; i++) {
      const t = i / rate
      // Barrido lineal de F0 a F1 con ventana de Hann: pico de correlacion angosto, sin chasquido.
      const phase = 2 * Math.PI * (CALIBRATION_F0_HZ * t + ((CALIBRATION_F1_HZ - CALIBRATION_F0_HZ) * t * t) / (2 * clickSeconds))
      const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (clickSamples - 1)))
      out[start + i] = CALIBRATION_AMPLITUDE * window * Math.sin(phase)
    }
  }
  return out
}

function normalizeLabel(deviceLabel: string): string {
  const text = String(deviceLabel ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return text === '' ? 'default' : text.slice(0, 80)
}

export function calibrationKey(deviceLabel: string, sampleRate: number): string {
  return `${LATENCY_STORAGE_PREFIX}:${normalizeLabel(deviceLabel)}:${Math.round(sampleRate)}`
}

export function loadCalibration(storage: KeyValueStorage, deviceLabel: string, sampleRate: number): LatencyCalibration | null {
  let text: string | null
  try {
    text = storage.getItem(calibrationKey(deviceLabel, sampleRate))
  } catch {
    return null
  }
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!finite(c.roundTripSeconds) || c.roundTripSeconds < 0 || c.roundTripSeconds > 2) return null
  if (!finite(c.sampleRate) || Math.round(c.sampleRate) !== Math.round(sampleRate)) return null
  if (!finite(c.confidence)) return null
  return {
    deviceLabel: typeof c.deviceLabel === 'string' ? c.deviceLabel : deviceLabel,
    sampleRate: c.sampleRate,
    roundTripSeconds: c.roundTripSeconds,
    confidence: c.confidence,
    spreadSeconds: finite(c.spreadSeconds) ? c.spreadSeconds : 0,
    measuredAt: typeof c.measuredAt === 'string' ? c.measuredAt : '',
  }
}

/** Lanza si el almacen no deja escribir (modo privado, cuota): quien llama avisa al usuario. */
export function saveCalibration(storage: KeyValueStorage, calibration: LatencyCalibration): void {
  storage.setItem(calibrationKey(calibration.deviceLabel, calibration.sampleRate), JSON.stringify(calibration))
}

export function clearCalibration(storage: KeyValueStorage, deviceLabel: string, sampleRate: number): void {
  try {
    storage.removeItem(calibrationKey(deviceLabel, sampleRate))
  } catch {
    // Sin almacen no hay nada que borrar.
  }
}

void ({
  estimateDelaySamples,
  takeStartSeconds,
  browserLatencySeconds,
  calibrationSignal,
  calibrationKey,
  loadCalibration,
  saveCalibration,
  clearCalibration,
} satisfies LatencyApi)
