/**
 * Efectos del Estudio con nodos nativos de Web Audio: EQ de cuatro bandas, compresor, limitador
 * del master y reverb compartida. Los usa graph.ts, igual en AudioContext y OfflineAudioContext.
 *
 * Cada efecto es una "unidad" con entrada y salida fijas y un cruce humedo/seco por dentro, para
 * que el bypass y los parametros cambien en caliente sin tocar la topologia del grafo.
 *
 * La primera parte del archivo es matematica pura (se prueba con node); la segunda crea nodos y
 * solo se ejecuta en un navegador. El modulo no toca el DOM al importarse.
 */
import { dbToGain } from '../stemTiming.ts'
import {
  STUDIO_EQ_HIGH_SHELF_HZ,
  STUDIO_EQ_HPF_Q,
  STUDIO_EQ_LOW_SHELF_HZ,
  STUDIO_LIMITER_LOOKAHEAD_MS,
  type CompressorParams,
  type DeEsserParams,
  type EqParams,
  type LimiterParams,
  type SaturatorParams,
  type StereoImagerParams,
  type StudioFx,
  type StudioFxType,
} from './session.ts'
import { LIMITER_PROCESSOR_NAME, limiterLookaheadFrames } from './limiterCore.ts'

// ---------------------------------------------------------------------------
// Matematica pura
// ---------------------------------------------------------------------------

/** Constante de tiempo de las rampas de parametros (misma que stemPlayer): evita clics. */
export const PARAM_SMOOTH_S = 0.015

/**
 * Anticipacion del DynamicsCompressorNode. La especificacion de Web Audio fija 6 ms; Chromium la
 * trunca a muestras enteras. NO VERIFICADO en Firefox ni Safari ni medido en este equipo: de
 * este numero dependen la compensacion de retardo entre pistas y el recorte de bounce.
 */
export const COMPRESSOR_LOOKAHEAD_S = 0.006

/** Retardo que agrega una unidad de compresor (activa o en bypass), en segundos. */
export function compressorLatencySeconds(sampleRate: number): number {
  return Math.floor(COMPRESSOR_LOOKAHEAD_S * sampleRate) / sampleRate
}

/** Retardo del limitador del worklet, en segundos. */
export function limiterLatencySeconds(sampleRate: number): number {
  return limiterLookaheadFrames(sampleRate, STUDIO_LIMITER_LOOKAHEAD_MS) / sampleRate
}

/**
 * Retardo del sobremuestreo x4 del WaveShaperNode (saturador), en muestras, por frecuencia de
 * muestreo. Cada navegador usa su propio filtro de remuestreo, asi que no se supone: lo mide
 * measureWaveShaperLatency con un impulso en un OfflineAudioContext. 0 mientras no se mida.
 */
const shaperLatencyFrames = new Map<number, number>()
const shaperLatencyPending = new Map<number, Promise<number>>()

/** Retardo medido del saturador (muestras) a `sampleRate`, o 0 si aun no se midio. */
export function waveShaperLatencyFrames(sampleRate: number): number {
  return shaperLatencyFrames.get(Math.round(sampleRate)) ?? 0
}

/** Fija el retardo del saturador a mano (pruebas en node, donde no hay OfflineAudioContext). */
export function setWaveShaperLatencyFrames(sampleRate: number, frames: number): void {
  shaperLatencyFrames.set(Math.round(sampleRate), Math.max(0, Math.round(frames)))
}

/** Retardo de una unidad de efecto. El EQ y el stereo_imager no retrasan; de_esser usa compresor de banda; el saturador, su sobremuestreo. */
export function fxLatencySeconds(type: StudioFxType, sampleRate: number, limiterWorklet: boolean): number {
  if (type === 'compressor' || type === 'de_esser') return compressorLatencySeconds(sampleRate)
  if (type === 'limiter') return limiterWorklet ? limiterLatencySeconds(sampleRate) : compressorLatencySeconds(sampleRate)
  if (type === 'saturator') return waveShaperLatencyFrames(sampleRate) / sampleRate
  return 0
}

/** Amplitud de pico del seno de referencia con que el saturador iguala sonoridad (unos -10 dBFS). */
export const SATURATOR_REFERENCE_PEAK = 0.3
/** Asimetria de la curva (segundo armonico): genera continua, que filtra el pasa altos de 10 Hz. */
const SATURATOR_ASYMMETRY = 0.08
/** Corte del pasa altos que quita la continua que deja la asimetria. */
export const SATURATOR_DC_BLOCK_HZ = 10

function saturatorRaw(x: number, drive: number): number {
  // Pendiente 1 en el origen y salida 0 con entrada 0: sin continua en silencio.
  return Math.tanh(drive * (x + SATURATOR_ASYMMETRY * x * x)) / drive
}

/** RMS (sin continua) de la curva cruda sobre un seno de amplitud SATURATOR_REFERENCE_PEAK. */
function saturatorReferenceRms(drive: number): number {
  const n = 512
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    const y = saturatorRaw(SATURATOR_REFERENCE_PEAK * Math.sin((2 * Math.PI * i) / n), drive)
    sum += y
    sumSq += y * y
  }
  const mean = sum / n
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean))
}

/**
 * Compensacion de nivel del saturador (lineal): iguala el RMS de un seno de referencia (~-10 dBFS
 * de pico) entre `driveDb` y drive 0. Con drive 0 vale exactamente 1.
 */
export function saturatorMakeupGain(driveDb: number): number {
  const drive = dbToGain(Math.max(0, Math.min(24, driveDb)))
  return saturatorReferenceRms(1) / saturatorReferenceRms(drive)
}

/**
 * Curva tipo cinta para `WaveShaperNode` (`oversample = '4x'`): tanh con algo de asimetria
 * (armonicos pares), pendiente 1 en el origen (con drive 0 una senal chica pasa a 0 dB) y
 * compensacion automatica de nivel (saturatorMakeupGain): subir el drive cambia el color, no el
 * volumen, a nivel de referencia. La mezcla seca va DENTRO de la curva
 * (`mix * saturado + (1 - mix) * x`): seco y humedo comparten el retardo del sobremuestreo y no hay
 * filtro peine con `mix < 1`.
 */
export function buildTapeSaturatorCurve(driveDb: number, mix = 1, points = 2049): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points)
  const drive = dbToGain(Math.max(0, Math.min(24, driveDb)))
  const makeup = saturatorMakeupGain(driveDb)
  const wet = Math.max(0, Math.min(1, Number.isFinite(mix) ? mix : 1))
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1
    const shaped = wet * makeup * saturatorRaw(x, drive) + (1 - wet) * x
    curve[i] = Math.max(-1, Math.min(1, shaped))
  }
  // El centro exacto (entrada 0) da 0: un numero impar de puntos lo deja en la mitad.
  if (points % 2 === 1) curve[(points - 1) / 2] = 0
  return curve
}

// ---------------------------------------------------------------------------
// Respuesta de biquads (formulas del Audio EQ Cookbook tal como las usa Web Audio)
// ---------------------------------------------------------------------------

export type BiquadKind = 'lowpass' | 'highpass' | 'lowshelf' | 'peaking' | 'highshelf' | 'allpass'

/** Q de un pasa bajos o pasa altos de Butterworth (0,7071 lineal) en la unidad de Web Audio: dB. */
export const BUTTERWORTH_Q_DB = 20 * Math.log10(Math.SQRT1_2)

/**
 * Coeficientes normalizados (a0 = 1) de un BiquadFilterNode. `q` va como lo recibe el nodo: en
 * lowpass/highpass es dB (resonancia); en peaking es adimensional; en los shelves no se usa
 * (Web Audio fija S = 1).
 */
export function biquadCoefficients(kind: BiquadKind, frequency: number, q: number, gainDb: number, sampleRate: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const f = Math.max(0, Math.min(frequency, sampleRate / 2))
  const w0 = (2 * Math.PI * f) / sampleRate
  const cw = Math.cos(w0)
  const sw = Math.sin(w0)
  const A = Math.pow(10, gainDb / 40)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  if (kind === 'lowpass' || kind === 'highpass') {
    const alpha = sw / (2 * Math.pow(10, q / 20))
    if (kind === 'lowpass') {
      b0 = (1 - cw) / 2
      b1 = 1 - cw
      b2 = (1 - cw) / 2
    } else {
      b0 = (1 + cw) / 2
      b1 = -(1 + cw)
      b2 = (1 + cw) / 2
    }
    a0 = 1 + alpha
    a1 = -2 * cw
    a2 = 1 - alpha
  } else if (kind === 'allpass') {
    const alpha = sw / (2 * Math.max(1e-4, q))
    b0 = 1 - alpha
    b1 = -2 * cw
    b2 = 1 + alpha
    a0 = 1 + alpha
    a1 = -2 * cw
    a2 = 1 - alpha
  } else if (kind === 'peaking') {
    const alpha = sw / (2 * Math.max(1e-4, q))
    b0 = 1 + alpha * A
    b1 = -2 * cw
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cw
    a2 = 1 - alpha / A
  } else {
    // S = 1 en ambos estantes.
    const alpha = (sw / 2) * Math.SQRT2
    const k = 2 * Math.sqrt(A) * alpha
    if (kind === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cw + k)
      b1 = 2 * A * (A - 1 - (A + 1) * cw)
      b2 = A * (A + 1 - (A - 1) * cw - k)
      a0 = A + 1 + (A - 1) * cw + k
      a1 = -2 * (A - 1 + (A + 1) * cw)
      a2 = A + 1 + (A - 1) * cw - k
    } else {
      b0 = A * (A + 1 + (A - 1) * cw + k)
      b1 = -2 * A * (A - 1 + (A + 1) * cw)
      b2 = A * (A + 1 + (A - 1) * cw - k)
      a0 = A + 1 - (A - 1) * cw + k
      a1 = 2 * (A - 1 - (A + 1) * cw)
      a2 = A + 1 - (A - 1) * cw - k
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Respuesta compleja [re, im] de un biquad en `hz`. */
export function biquadResponse(kind: BiquadKind, frequency: number, q: number, gainDb: number, sampleRate: number, hz: number): [number, number] {
  const { b0, b1, b2, a1, a2 } = biquadCoefficients(kind, frequency, q, gainDb, sampleRate)
  const w = (2 * Math.PI * hz) / sampleRate
  const c1 = Math.cos(w)
  const s1 = -Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = -Math.sin(2 * w)
  const nr = b0 + b1 * c1 + b2 * c2
  const ni = b1 * s1 + b2 * s2
  const dr = 1 + a1 * c1 + a2 * c2
  const di = a1 * s1 + a2 * s2
  const den = dr * dr + di * di
  return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den]
}

/** Ganancia de potencia (|H|^2) del EQ de cuatro bandas en `hz`, con los mismos filtros que suena. */
export function eqPowerGainAt(params: EqParams, hz: number, sampleRate: number): number {
  let power = 1
  for (const band of eqBands(params, sampleRate)) {
    if (band.type === 'highpass' && band.frequency <= 0) continue
    if (band.type !== 'highpass' && band.gainDb === 0) continue
    const [re, im] = biquadResponse(band.type, band.frequency, band.q, band.gainDb, sampleRate, hz)
    power *= re * re + im * im
  }
  return power
}

// ---------------------------------------------------------------------------
// Ganancia automatica del DynamicsCompressorNode
// ---------------------------------------------------------------------------

/**
 * Ganancia automatica de compensacion (makeup) que el DynamicsCompressorNode aplica SIEMPRE a su
 * salida, en dB. Es la curva estatica normativa de la especificacion de Web Audio (la misma de
 * Chromium, Firefox y WebKit, que vienen del mismo codigo): curva lineal hasta el umbral, rodilla
 * exponencial de ancho `kneeDb` y relacion constante despues; makeup = (1 / curva(1))^0,6.
 * Con relacion 1 vale ~0 dB. Sirve para restarla donde no se quiere (el de-esser).
 */
export function dynamicsCompressorMakeupDb(thresholdDb: number, kneeDb: number, ratio: number): number {
  const thr = Math.max(-100, Math.min(0, thresholdDb))
  const knee = Math.max(0, Math.min(40, kneeDb))
  const r = Math.max(1, Math.min(20, ratio))
  const linearThreshold = Math.pow(10, thr / 20)
  const toDb = (x: number) => (x > 0 ? 20 * Math.log10(x) : -1000)
  const kneeCurve = (x: number, k: number) => (x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k)
  const slopeAt = (x: number, k: number) => {
    if (x < linearThreshold) return 1
    const x2 = x * 1.001
    return (toDb(kneeCurve(x2, k)) - toDb(kneeCurve(x, k))) / (toDb(x2) - toDb(x))
  }
  // k tal que la pendiente al final de la rodilla sea 1 / ratio (busqueda geometrica, 15 pasos).
  const kneeEndLinear = Math.pow(10, (thr + knee) / 20)
  let minK = 0.1
  let maxK = 10000
  let k = 5
  for (let i = 0; i < 15; i++) {
    if (slopeAt(kneeEndLinear, k) < 1 / r) maxK = k
    else minK = k
    k = Math.sqrt(minK * maxK)
  }
  const kneeThresholdDb = thr + knee
  const yKneeDb = toDb(kneeCurve(kneeEndLinear, k))
  const saturate = (x: number) => (x < kneeEndLinear ? kneeCurve(x, k) : Math.pow(10, (yKneeDb + (toDb(x) - kneeThresholdDb) / r) / 20))
  const fullRangeGain = saturate(1)
  if (!(fullRangeGain > 0)) return 0
  return 0.6 * -toDb(fullRangeGain)
}

/** Q (en dB, unidad de Web Audio) del pasa bajos que separa las bandas del de-esser: Butterworth. */
export const DE_ESSER_CROSSOVER_Q_DB = BUTTERWORTH_Q_DB

/** Relacion de compresion del de-esser para `reductionDb` 0..18: de 1 (apagado) a 16:1. */
export function deEsserRatio(reductionDb: number): number {
  return 1 + (Math.max(0, Math.min(18, Number.isFinite(reductionDb) ? reductionDb : 0)) / 18) * 15
}

/** Rodilla del compresor de la banda sibilante del de-esser (dB). */
export const DE_ESSER_KNEE_DB = 6

/**
 * Respuesta en `hz` de la suma de bandas del de-esser con la banda aguda sin reducir:
 * grave = LP(x), agudo = x - LP(x) (complementaria). Con reduccion 0 la suma es x exacto: plana.
 * `legacy` devuelve la topologia anterior (LP + HP de 2o orden en la misma frecuencia), que deja
 * un hueco de -180 dB en el corte; se conserva solo para documentar la regresion en las pruebas.
 */
export function deEsserSumResponse(hz: number, crossoverHz: number, sampleRate: number, legacy = false): [number, number] {
  if (legacy) {
    const lp = biquadResponse('lowpass', crossoverHz, 0.707, 0, sampleRate, hz)
    const hp = biquadResponse('highpass', crossoverHz, 0.707, 0, sampleRate, hz)
    return [lp[0] + hp[0], lp[1] + hp[1]]
  }
  const lp = biquadResponse('lowpass', crossoverHz, DE_ESSER_CROSSOVER_Q_DB, 0, sampleRate, hz)
  const high: [number, number] = [1 - lp[0], -lp[1]]
  return [lp[0] + high[0], lp[1] + high[1]]
}

/** Q lineal del pasa todo del medio en el stereo_imager (el de la suma Linkwitz-Riley de 4o orden). */
export const IMAGER_ALLPASS_Q = Math.SQRT1_2

function complexMul(a: [number, number], b: [number, number]): [number, number] {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
}

/**
 * Respuesta del stereo_imager en `hz` para el medio y el lado. Graves en mono por cruce
 * Linkwitz-Riley de 4o orden en `monoBassHz`: el lado pasa por un pasa altos LR4 (dos Butterworth
 * en cascada) y el medio por el pasa todo de 2o orden que iguala su fase (LP_LR4 + HP_LR4 = AP2).
 * Por encima del corte medio y lado quedan con la misma fase: con width 1 la imagen no se mueve y
 * la magnitud es plana; solo se quita el lado bajo el corte. Con `monoBassHz` 0 es la identidad.
 */
export function stereoImagerResponse(hz: number, width: number, monoBassHz: number, sampleRate: number): { mid: [number, number]; side: [number, number] } {
  const w = Math.max(0, Math.min(2, width))
  if (!(monoBassHz > 0)) return { mid: [1, 0], side: [w, 0] }
  const fc = Math.min(monoBassHz, sampleRate / 2 - 10)
  const ap = biquadResponse('allpass', fc, IMAGER_ALLPASS_Q, 0, sampleRate, hz)
  const hp = biquadResponse('highpass', fc, BUTTERWORTH_Q_DB, 0, sampleRate, hz)
  const hp4 = complexMul(hp, hp)
  return { mid: ap, side: [hp4[0] * w, hp4[1] * w] }
}

export interface EqBand {
  type: 'highpass' | 'lowshelf' | 'peaking' | 'highshelf'
  frequency: number
  /** En highpass el Q de BiquadFilterNode va en dB; en peaking es adimensional. */
  q: number
  gainDb: number
}

/**
 * Las cuatro bandas del EQ (STUDIO_V1.md 2.6), en el orden en que procesan. Con `hpfHz` 0 el pasa
 * altos queda en 0 Hz, que en BiquadFilterNode deja pasar todo. Las frecuencias se acotan por
 * debajo de Nyquist.
 */
export function eqBands(params: EqParams, sampleRate: number): EqBand[] {
  const top = sampleRate / 2 - 1
  const clampHz = (hz: number) => Math.max(0, Math.min(hz, top))
  return [
    { type: 'highpass', frequency: clampHz(params.hpfHz), q: 20 * Math.log10(STUDIO_EQ_HPF_Q), gainDb: 0 },
    { type: 'lowshelf', frequency: clampHz(STUDIO_EQ_LOW_SHELF_HZ), q: 1, gainDb: params.lowDb },
    { type: 'peaking', frequency: clampHz(params.midHz), q: params.midQ, gainDb: params.midDb },
    { type: 'highshelf', frequency: clampHz(STUDIO_EQ_HIGH_SHELF_HZ), q: 1, gainDb: params.highDb },
  ]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Decaimiento de la reverb redondeado a centesimas: la clave con la que se reutiliza la respuesta. */
export function reverbDecayKey(decayS: number): number {
  return Math.round(Math.max(0.05, decayS) * 100) / 100
}

/**
 * Respuesta al impulso de la reverb compartida: ruido con semilla fija (determinista: la misma en
 * cada equipo, al escuchar y al exportar), caida exponencial de 60 dB en `decayS` y agudos que se
 * apagan antes que los graves. Cada canal queda con energia 1, asi el retorno a 0 dB suena al
 * nivel del envio. Devuelve [izquierda, derecha].
 */
export function buildReverbImpulse(sampleRate: number, decayS: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const length = Math.max(64, Math.round(reverbDecayKey(decayS) * sampleRate))
  const slope = Math.log(1000) / length
  const make = (seed: number): Float32Array<ArrayBuffer> => {
    const random = mulberry32(seed)
    const out = new Float32Array(length)
    let low = 0
    let energy = 0
    for (let i = 0; i < length; i++) {
      const progress = i / length
      // Pasa bajos de un polo que se cierra con el tiempo: la cola pierde brillo.
      const open = 0.85 - 0.7 * progress
      low += open * (random() * 2 - 1 - low)
      const v = low * Math.exp(-slope * i)
      out[i] = v
      energy += v * v
    }
    const scale = energy > 0 ? 1 / Math.sqrt(energy) : 0
    for (let i = 0; i < length; i++) out[i] *= scale
    return out
  }
  return [make(0x1b873593), make(0x85ebca6b)]
}

/** LUFS de una potencia media ya ponderada K (suma de los canales). Silencio: -Infinity. */
export function lufsFromMeanSquare(meanSquare: number): number {
  return meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : Number.NEGATIVE_INFINITY
}

/**
 * LUFS integrado de `count` bloques de 400 ms (potencia media ponderada K de cada uno), con la
 * doble compuerta de BS.1770: absoluta en -70 LUFS y relativa 10 LU por debajo de la media de
 * los que pasan la primera.
 */
export function gatedLufs(blocks: ArrayLike<number>, count: number): number {
  const absolute = Math.pow(10, (-70 + 0.691) / 10)
  let sum = 0
  let n = 0
  for (let i = 0; i < count; i++) {
    if (blocks[i] > absolute) {
      sum += blocks[i]
      n++
    }
  }
  if (n === 0) return Number.NEGATIVE_INFINITY
  const relative = (sum / n) * 0.1
  let gatedSum = 0
  let gatedCount = 0
  for (let i = 0; i < count; i++) {
    if (blocks[i] > absolute && blocks[i] > relative) {
      gatedSum += blocks[i]
      gatedCount++
    }
  }
  return gatedCount > 0 ? lufsFromMeanSquare(gatedSum / gatedCount) : Number.NEGATIVE_INFINITY
}

/** Ganancia lineal a dBFS. Silencio: -Infinity. */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY
}

// ---------------------------------------------------------------------------
// Nodos
// ---------------------------------------------------------------------------

/** Fija un AudioParam: de golpe al construir (y en offline), con rampa corta en caliente. */
export function setParam(ctx: BaseAudioContext, param: AudioParam, value: number, immediate: boolean): void {
  const safe = Number.isFinite(value) ? Math.max(param.minValue, Math.min(param.maxValue, value)) : param.defaultValue
  if (immediate) param.value = safe
  else param.setTargetAtTime(safe, ctx.currentTime, PARAM_SMOOTH_S)
}

function disconnectAll(nodes: readonly AudioNode[]): void {
  for (const node of nodes) {
    try {
      node.disconnect()
    } catch {
      // ya desconectado
    }
  }
}

export interface FxUnit {
  readonly type: StudioFxType
  readonly input: AudioNode
  readonly output: AudioNode
  /** Retardo que la unidad agrega a la senal, este o no en bypass. */
  readonly latencyS: number
  /** Aplica parametros y bypass. `fx.type` debe ser el de la unidad. */
  update(fx: StudioFx, immediate: boolean): void
  dispose(): void
}

interface WetDry {
  input: GainNode
  output: GainNode
  wet: GainNode
  dry: GainNode
  nodes: AudioNode[]
}

/** Entrada y salida con cruce humedo/seco. El camino seco lleva el mismo retardo que el humedo. */
function wetDry(ctx: BaseAudioContext, first: AudioNode, last: AudioNode, latencyS: number): WetDry {
  const input = ctx.createGain()
  const output = ctx.createGain()
  const wet = ctx.createGain()
  const dry = ctx.createGain()
  const nodes: AudioNode[] = [input, output, wet, dry]
  input.connect(first)
  last.connect(wet)
  wet.connect(output)
  if (latencyS > 0) {
    const delay = ctx.createDelay(Math.max(0.05, latencyS * 2))
    delay.delayTime.value = latencyS
    input.connect(delay)
    delay.connect(dry)
    nodes.push(delay)
  } else {
    input.connect(dry)
  }
  dry.connect(output)
  return { input, output, wet, dry, nodes }
}

function setBypass(ctx: BaseAudioContext, path: WetDry, bypass: boolean, immediate: boolean): void {
  setParam(ctx, path.wet.gain, bypass ? 0 : 1, immediate)
  setParam(ctx, path.dry.gain, bypass ? 1 : 0, immediate)
}

function createEqUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  const filters = [ctx.createBiquadFilter(), ctx.createBiquadFilter(), ctx.createBiquadFilter(), ctx.createBiquadFilter()]
  for (let i = 1; i < filters.length; i++) filters[i - 1].connect(filters[i])
  const path = wetDry(ctx, filters[0], filters[filters.length - 1], 0)
  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'eq') return
    const bands = eqBands(next.params as EqParams, ctx.sampleRate)
    bands.forEach((band, i) => {
      const filter = filters[i]
      if (filter.type !== band.type) filter.type = band.type
      setParam(ctx, filter.frequency, band.frequency, immediate)
      setParam(ctx, filter.Q, band.q, immediate)
      setParam(ctx, filter.gain, band.gainDb, immediate)
    })
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return { type: 'eq', input: path.input, output: path.output, latencyS: 0, update, dispose: () => disconnectAll([...filters, ...path.nodes]) }
}

function createCompressorUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  const compressor = ctx.createDynamicsCompressor()
  const makeup = ctx.createGain()
  compressor.connect(makeup)
  const latencyS = compressorLatencySeconds(ctx.sampleRate)
  const path = wetDry(ctx, compressor, makeup, latencyS)
  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'compressor') return
    const p = next.params as CompressorParams
    setParam(ctx, compressor.threshold, p.thresholdDb, immediate)
    setParam(ctx, compressor.ratio, p.ratio, immediate)
    setParam(ctx, compressor.attack, p.attackMs / 1000, immediate)
    setParam(ctx, compressor.release, p.releaseMs / 1000, immediate)
    setParam(ctx, compressor.knee, p.kneeDb, immediate)
    setParam(ctx, makeup.gain, dbToGain(p.makeupDb), immediate)
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return { type: 'compressor', input: path.input, output: path.output, latencyS, update, dispose: () => disconnectAll([compressor, makeup, ...path.nodes]) }
}

/** Limitador con anticipacion en AudioWorklet. Lanza si el procesador no esta registrado en `ctx`. */
function createWorkletLimiterUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  const node = new AudioWorkletNode(ctx, LIMITER_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  })
  const ceiling = node.parameters.get('ceilingDb')
  const release = node.parameters.get('releaseMs')
  const bypass = node.parameters.get('bypass')
  if (!ceiling || !release || !bypass) {
    node.disconnect()
    throw new Error('El worklet del limitador no expone sus parámetros.')
  }
  // Parametros k-rate que el procesador ya suaviza: se fijan sin rampa.
  const update = (next: StudioFx) => {
    if (next.type !== 'limiter') return
    const p = next.params as LimiterParams
    const now = ctx.currentTime
    ceiling.setValueAtTime(p.ceilingDb, now)
    release.setValueAtTime(p.releaseMs, now)
    bypass.setValueAtTime(next.bypass ? 1 : 0, now)
  }
  update(fx)
  return {
    type: 'limiter',
    input: node,
    output: node,
    latencyS: limiterLatencySeconds(ctx.sampleRate),
    update,
    dispose: () => {
      try {
        node.port.postMessage('dispose')
      } catch {
        // el contexto ya esta cerrado
      }
      disconnectAll([node])
    },
  }
}

/**
 * Respaldo del limitador cuando el worklet no carga: la senal se normaliza al techo, pasa por un
 * DynamicsCompressorNode de relacion 20 con umbral en 0 dB (su ganancia automatica de
 * compensacion es 1 con ese umbral) y por un recortador duro que garantiza el techo. Suena mas
 * tosco que el worklet; `GraphCapabilities.limiterWorklet` avisa cual de los dos esta en uso.
 */
function createFallbackLimiterUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  const pre = ctx.createGain()
  const compressor = ctx.createDynamicsCompressor()
  compressor.threshold.value = 0
  compressor.knee.value = 0
  compressor.ratio.value = 20
  compressor.attack.value = 0.001
  const clip = ctx.createWaveShaper()
  // Dos puntos: identidad dentro de [-1, 1]; lo que se sale queda en el extremo.
  clip.curve = new Float32Array([-1, 1])
  const post = ctx.createGain()
  pre.connect(compressor)
  compressor.connect(clip)
  clip.connect(post)
  const latencyS = compressorLatencySeconds(ctx.sampleRate)
  const path = wetDry(ctx, pre, post, latencyS)
  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'limiter') return
    const p = next.params as LimiterParams
    const ceiling = Math.max(dbToGain(p.ceilingDb), 0.001)
    setParam(ctx, pre.gain, 1 / ceiling, immediate)
    setParam(ctx, post.gain, ceiling, immediate)
    setParam(ctx, compressor.release, p.releaseMs / 1000, immediate)
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return { type: 'limiter', input: path.input, output: path.output, latencyS, update, dispose: () => disconnectAll([pre, compressor, clip, post, ...path.nodes]) }
}

function createDeEsserUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  // Bandas complementarias (suma exacta con la banda aguda sin reducir):
  //   - grave/media: LP(x) en freqHz + retardo igual a la anticipacion del compresor
  //   - sibilante:  x - LP(x) -> DynamicsCompressorNode rapido -> trim que resta su makeup automatico
  // Con reduccion 0 (relacion 1) la salida es x retrasada: respuesta plana. El trim evita que el
  // makeup automatico del compresor (hasta +12 dB con los valores por defecto) realce la sibilancia
  // que queda bajo el umbral.
  const splitIn = ctx.createGain()
  const sumOut = ctx.createGain()
  const lowFilter = ctx.createBiquadFilter()
  lowFilter.type = 'lowpass'
  lowFilter.Q.value = DE_ESSER_CROSSOVER_Q_DB
  const lowInvert = ctx.createGain()
  lowInvert.gain.value = -1
  const highSum = ctx.createGain()
  const sibilantComp = ctx.createDynamicsCompressor()
  sibilantComp.attack.value = 0.001
  sibilantComp.release.value = 0.045
  sibilantComp.knee.value = DE_ESSER_KNEE_DB
  const makeupTrim = ctx.createGain()

  const latencyS = compressorLatencySeconds(ctx.sampleRate)
  const nodes: AudioNode[] = [splitIn, sumOut, lowFilter, lowInvert, highSum, sibilantComp, makeupTrim]
  splitIn.connect(lowFilter)
  if (latencyS > 0) {
    const lowDelay = ctx.createDelay(Math.max(0.05, latencyS * 2))
    lowDelay.delayTime.value = latencyS
    lowFilter.connect(lowDelay)
    lowDelay.connect(sumOut)
    nodes.push(lowDelay)
  } else {
    lowFilter.connect(sumOut)
  }
  splitIn.connect(highSum)
  lowFilter.connect(lowInvert)
  lowInvert.connect(highSum)
  highSum.connect(sibilantComp)
  sibilantComp.connect(makeupTrim)
  makeupTrim.connect(sumOut)

  const path = wetDry(ctx, splitIn, sumOut, latencyS)
  const nyquist = ctx.sampleRate / 2 - 10
  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'de_esser') return
    const p = next.params as DeEsserParams
    const freq = Math.max(2000, Math.min(nyquist, p.freqHz))
    const ratio = deEsserRatio(p.reductionDb)
    setParam(ctx, lowFilter.frequency, freq, immediate)
    setParam(ctx, sibilantComp.threshold, p.thresholdDb, immediate)
    setParam(ctx, sibilantComp.ratio, ratio, immediate)
    setParam(ctx, makeupTrim.gain, dbToGain(-dynamicsCompressorMakeupDb(p.thresholdDb, DE_ESSER_KNEE_DB, ratio)), immediate)
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return { type: 'de_esser', input: path.input, output: path.output, latencyS, update, dispose: () => disconnectAll([...nodes, ...path.nodes]) }
}

function createSaturatorUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  // shaper (curva con la mezcla seca dentro, x4) -> pasa altos de continua -> tono -> salida.
  // La rama seca del bypass lleva el retardo medido del sobremuestreo.
  const shaper = ctx.createWaveShaper()
  shaper.oversample = '4x'
  const dcBlock = ctx.createBiquadFilter()
  dcBlock.type = 'highpass'
  dcBlock.frequency.value = SATURATOR_DC_BLOCK_HZ
  dcBlock.Q.value = BUTTERWORTH_Q_DB
  const toneFilter = ctx.createBiquadFilter()
  toneFilter.type = 'highshelf'
  toneFilter.frequency.value = Math.min(4500, ctx.sampleRate / 2 - 10)
  const postGain = ctx.createGain()

  shaper.connect(dcBlock)
  dcBlock.connect(toneFilter)
  toneFilter.connect(postGain)

  const latencyS = waveShaperLatencyFrames(ctx.sampleRate) / ctx.sampleRate
  const path = wetDry(ctx, shaper, postGain, latencyS)
  let currentCurveKey = ''

  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'saturator') return
    const p = next.params as SaturatorParams
    const driveKey = Math.round(p.driveDb * 10) / 10
    const mixKey = Math.round(Math.max(0, Math.min(1, p.mix)) * 100) / 100
    const curveKey = `${driveKey}:${mixKey}`
    if (curveKey !== currentCurveKey) {
      shaper.curve = buildTapeSaturatorCurve(driveKey, mixKey)
      currentCurveKey = curveKey
    }
    setParam(ctx, toneFilter.gain, p.toneDb, immediate)
    setParam(ctx, postGain.gain, dbToGain(p.outputDb), immediate)
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return {
    type: 'saturator',
    input: path.input,
    output: path.output,
    latencyS,
    update,
    dispose: () => disconnectAll([shaper, dcBlock, toneFilter, postGain, ...path.nodes]),
  }
}

function createStereoImagerUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  // Matriz Mid/Side con graves en mono por cruce Linkwitz-Riley de 4o orden (stereoImagerResponse):
  //   M = 0.5 * (L + R) -> pasa todo de 2o orden en monoBassHz (misma fase que el lado)
  //   S = 0.5 * (L - R) -> dos pasa altos Butterworth (LR4) -> ganancia width
  //   L' = M + S', R' = M - S'
  // Con monoBassHz 0 los filtros quedan en identidad (BiquadFilterNode a 0 Hz).
  const stereoIn = ctx.createGain()
  stereoIn.channelCount = 2
  stereoIn.channelCountMode = 'explicit'
  const splitter = ctx.createChannelSplitter(2)
  const merger = ctx.createChannelMerger(2)

  const midL = ctx.createGain()
  midL.gain.value = 0.5
  const midR = ctx.createGain()
  midR.gain.value = 0.5
  const midSum = ctx.createGain()
  const midAllpass = ctx.createBiquadFilter()
  midAllpass.type = 'allpass'
  midAllpass.Q.value = IMAGER_ALLPASS_Q

  const sideL = ctx.createGain()
  sideL.gain.value = 0.5
  const sideR = ctx.createGain()
  sideR.gain.value = -0.5
  const sideSum = ctx.createGain()
  const sideHp1 = ctx.createBiquadFilter()
  sideHp1.type = 'highpass'
  sideHp1.Q.value = BUTTERWORTH_Q_DB
  const sideHp2 = ctx.createBiquadFilter()
  sideHp2.type = 'highpass'
  sideHp2.Q.value = BUTTERWORTH_Q_DB
  const sideWidth = ctx.createGain()
  const sideInv = ctx.createGain()
  sideInv.gain.value = -1

  stereoIn.connect(splitter)
  splitter.connect(midL, 0)
  splitter.connect(midR, 1)
  midL.connect(midSum)
  midR.connect(midSum)
  midSum.connect(midAllpass)

  splitter.connect(sideL, 0)
  splitter.connect(sideR, 1)
  sideL.connect(sideSum)
  sideR.connect(sideSum)
  sideSum.connect(sideHp1)
  sideHp1.connect(sideHp2)
  sideHp2.connect(sideWidth)
  sideWidth.connect(sideInv)

  // L' = M + S', R' = M - S'
  midAllpass.connect(merger, 0, 0)
  sideWidth.connect(merger, 0, 0)
  midAllpass.connect(merger, 0, 1)
  sideInv.connect(merger, 0, 1)

  const path = wetDry(ctx, stereoIn, merger, 0)
  const nyquist = ctx.sampleRate / 2 - 10
  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'stereo_imager') return
    const p = next.params as StereoImagerParams
    const cut = Math.max(0, Math.min(nyquist, p.monoBassHz))
    setParam(ctx, sideWidth.gain, Math.max(0, Math.min(2, p.width)), immediate)
    setParam(ctx, midAllpass.frequency, cut, immediate)
    setParam(ctx, sideHp1.frequency, cut, immediate)
    setParam(ctx, sideHp2.frequency, cut, immediate)
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return {
    type: 'stereo_imager',
    input: path.input,
    output: path.output,
    latencyS: 0,
    update,
    dispose: () =>
      disconnectAll([stereoIn, splitter, merger, midL, midR, midSum, midAllpass, sideL, sideR, sideSum, sideHp1, sideHp2, sideWidth, sideInv, ...path.nodes]),
  }
}

/**
 * Mide el retardo del sobremuestreo x4 del WaveShaperNode con un impulso en un
 * OfflineAudioContext (una vez por frecuencia de muestreo) y lo deja en waveShaperLatencyFrames.
 * prepareGraphContext y bounce lo esperan antes de construir el grafo. Sin OfflineAudioContext
 * (node) queda en 0.
 */
export function measureWaveShaperLatency(sampleRate: number): Promise<number> {
  const rate = Math.round(sampleRate)
  const known = shaperLatencyFrames.get(rate)
  if (known !== undefined) return Promise.resolve(known)
  const pending = shaperLatencyPending.get(rate)
  if (pending) return pending
  const run = (async () => {
    let frames = 0
    try {
      if (typeof OfflineAudioContext !== 'undefined' && rate > 0) {
        const length = 2048
        const at = 256
        const offline = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate: rate })
        const impulse = offline.createBuffer(1, length, rate)
        impulse.getChannelData(0)[at] = 0.5
        const source = offline.createBufferSource()
        source.buffer = impulse
        const shaper = offline.createWaveShaper()
        // Dos puntos: identidad en [-1, 1].
        shaper.curve = new Float32Array([-1, 1])
        shaper.oversample = '4x'
        source.connect(shaper)
        shaper.connect(offline.destination)
        source.start(0)
        const rendered = await offline.startRendering()
        const data = rendered.getChannelData(0)
        let peak = 0
        let peakAt = at
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i])
          if (v > peak) {
            peak = v
            peakAt = i
          }
        }
        if (peak > 0.1 && peakAt >= at && peakAt - at < 512) frames = peakAt - at
      }
    } catch {
      frames = 0
    }
    shaperLatencyFrames.set(rate, frames)
    shaperLatencyPending.delete(rate)
    return frames
  })()
  shaperLatencyPending.set(rate, run)
  return run
}

export interface CreatedFxUnit {
  unit: FxUnit
  /** Solo tiene sentido en el limitador: true si quedo el worklet, false si quedo el respaldo. */
  worklet: boolean
}

/**
 * Crea la unidad de un efecto. Para el limitador intenta el worklet si `limiterWorklet` es true y
 * cae al respaldo si el nodo no se puede construir.
 */
export function createFxUnit(ctx: BaseAudioContext, fx: StudioFx, limiterWorklet: boolean): CreatedFxUnit {
  if (fx.type === 'eq') return { unit: createEqUnit(ctx, fx), worklet: false }
  if (fx.type === 'compressor') return { unit: createCompressorUnit(ctx, fx), worklet: false }
  if (fx.type === 'de_esser') return { unit: createDeEsserUnit(ctx, fx), worklet: false }
  if (fx.type === 'saturator') return { unit: createSaturatorUnit(ctx, fx), worklet: false }
  if (fx.type === 'stereo_imager') return { unit: createStereoImagerUnit(ctx, fx), worklet: false }
  if (limiterWorklet && typeof AudioWorkletNode !== 'undefined') {
    try {
      return { unit: createWorkletLimiterUnit(ctx, fx), worklet: true }
    } catch {
      // sin procesador registrado: respaldo
    }
  }
  return { unit: createFallbackLimiterUnit(ctx, fx), worklet: false }
}

export interface ReverbUnit {
  /** Suma de los envios de las pistas. */
  readonly input: AudioNode
  /** Retorno, ya con `returnDb` aplicado. */
  readonly output: AudioNode
  update(decayS: number, returnDb: number, immediate: boolean): void
  dispose(): void
}

/** Duracion del cruce entre dos respuestas cuando cambia el decaimiento en caliente. */
const REVERB_SWAP_S = 0.05
/** Tiempo que el decaimiento debe quedarse quieto antes de generar la respuesta nueva. */
export const REVERB_SETTLE_MS = 200

/**
 * Reverb compartida: entrada -> ConvolverNode (respuesta generada) -> retorno. Al cambiar el
 * decaimiento se crea otro convolver y se cruza con el anterior, sin cortar la cola de golpe.
 */
export function createReverbUnit(ctx: BaseAudioContext, decayS: number, returnDb: number): ReverbUnit {
  const input = ctx.createGain()
  const output = ctx.createGain()
  output.gain.value = dbToGain(returnDb)
  const retired = new Set<{ nodes: AudioNode[]; timer: ReturnType<typeof setTimeout> }>()
  let disposed = false
  let currentKey = Number.NaN
  let current: { convolver: ConvolverNode; level: GainNode } | null = null
  let swapTimer: ReturnType<typeof setTimeout> | null = null

  const mount =(key: number, immediate: boolean) => {
    const [left, right] = buildReverbImpulse(ctx.sampleRate, key)
    const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate)
    buffer.copyToChannel(left, 0)
    buffer.copyToChannel(right, 1)
    const convolver = ctx.createConvolver()
    // La respuesta ya viene con energia 1: sin la normalizacion propia del navegador.
    convolver.normalize = false
    convolver.buffer = buffer
    const level = ctx.createGain()
    input.connect(convolver)
    convolver.connect(level)
    level.connect(output)
    const previous = current
    current = { convolver, level }
    currentKey = key
    if (!previous || immediate) {
      if (previous) disconnectAll([previous.convolver, previous.level])
      return
    }
    const now = ctx.currentTime
    level.gain.setValueAtTime(0, now)
    level.gain.linearRampToValueAtTime(1, now + REVERB_SWAP_S)
    previous.level.gain.setValueAtTime(1, now)
    previous.level.gain.linearRampToValueAtTime(0, now + REVERB_SWAP_S)
    const entry = {
      nodes: [previous.convolver, previous.level] as AudioNode[],
      timer: setTimeout(() => {
        retired.delete(entry)
        disconnectAll(entry.nodes)
      }, REVERB_SWAP_S * 1000 + 100),
    }
    retired.add(entry)
  }

  mount(reverbDecayKey(decayS), true)

  return {
    input,
    output,
    update(nextDecayS, nextReturnDb, immediate) {
      if (disposed) return
      setParam(ctx, output.gain, dbToGain(nextReturnDb), immediate)
      const key = reverbDecayKey(nextDecayS)
      if (immediate) {
        if (swapTimer !== null) clearTimeout(swapTimer)
        swapTimer = null
        if (key !== currentKey) mount(key, true)
        return
      }
      // En caliente la respuesta nueva se genera cuando el control se queda quieto: arrastrar el
      // decaimiento ya no genera decenas de respuestas de varios segundos seguidas.
      if (swapTimer !== null) clearTimeout(swapTimer)
      swapTimer = null
      if (key === currentKey) return
      swapTimer = setTimeout(() => {
        swapTimer = null
        if (!disposed && key !== currentKey) mount(key, false)
      }, REVERB_SETTLE_MS)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (swapTimer !== null) clearTimeout(swapTimer)
      swapTimer = null
      for (const entry of retired) {
        clearTimeout(entry.timer)
        disconnectAll(entry.nodes)
      }
      retired.clear()
      if (current) disconnectAll([current.convolver, current.level])
      current = null
      disconnectAll([input, output])
    },
  }
}
