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

/** Retardo de una unidad de efecto. El EQ, el saturador y el stereo_imager no retrasan; de_esser usa compresor de banda. */
export function fxLatencySeconds(type: StudioFxType, sampleRate: number, limiterWorklet: boolean): number {
  if (type === 'compressor' || type === 'de_esser') return compressorLatencySeconds(sampleRate)
  if (type === 'limiter') return limiterWorklet ? limiterLatencySeconds(sampleRate) : compressorLatencySeconds(sampleRate)
  return 0
}

/**
 * Curva sigmoide tipo cinta analogica (con ligera asimetria de segundo armonico par + tanh de tercer
 * armonico impar) para `WaveShaperNode` con `oversample = '4x'`.
 */
export function buildTapeSaturatorCurve(driveDb: number, points = 2049): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points)
  const drive = dbToGain(Math.max(0, Math.min(24, driveDb)))
  const norm = Math.tanh(drive) || 1
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1
    // Ligera polarizacion asimetrica para generar calidez par sin desplazamiento DC notable.
    const asym = x + 0.06 * x * x - 0.03
    const shaped = (Math.tanh(asym * drive) - Math.tanh(-0.03 * drive)) / norm
    curve[i] = Math.max(-1, Math.min(1, shaped))
  }
  return curve
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
  // Topologia split-band coherente en fase:
  //   - Banda grave/media: lowpass en freqHz + retardo igual a la anticipacion del compresor
  //   - Banda sibilante: highpass en freqHz -> DynamicsCompressorNode rapido
  const splitIn = ctx.createGain()
  const sumOut = ctx.createGain()
  const lowFilter = ctx.createBiquadFilter()
  lowFilter.type = 'lowpass'
  lowFilter.Q.value = 0.707
  const highFilter = ctx.createBiquadFilter()
  highFilter.type = 'highpass'
  highFilter.Q.value = 0.707
  const sibilantComp = ctx.createDynamicsCompressor()
  sibilantComp.attack.value = 0.001
  sibilantComp.release.value = 0.045
  sibilantComp.knee.value = 6

  const latencyS = compressorLatencySeconds(ctx.sampleRate)
  const nodes: AudioNode[] = [splitIn, sumOut, lowFilter, highFilter, sibilantComp]
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
  splitIn.connect(highFilter)
  highFilter.connect(sibilantComp)
  sibilantComp.connect(sumOut)

  const path = wetDry(ctx, splitIn, sumOut, latencyS)
  const nyquist = ctx.sampleRate / 2 - 10
  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'de_esser') return
    const p = next.params as DeEsserParams
    const freq = Math.max(2000, Math.min(nyquist, p.freqHz))
    setParam(ctx, lowFilter.frequency, freq, immediate)
    setParam(ctx, highFilter.frequency, freq, immediate)
    setParam(ctx, sibilantComp.threshold, p.thresholdDb, immediate)
    // reductionDb 0..18 dB mapea la relacion de compresion de 1 (apagado) hasta 16:1.
    const ratio = 1 + (Math.max(0, Math.min(18, p.reductionDb)) / 18) * 15
    setParam(ctx, sibilantComp.ratio, ratio, immediate)
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return { type: 'de_esser', input: path.input, output: path.output, latencyS, update, dispose: () => disconnectAll([...nodes, ...path.nodes]) }
}

function createSaturatorUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  const splitIn = ctx.createGain()
  const sumMix = ctx.createGain()
  const wetGain = ctx.createGain()
  const dryMixGain = ctx.createGain()
  const shaper = ctx.createWaveShaper()
  shaper.oversample = '4x'
  const toneFilter = ctx.createBiquadFilter()
  toneFilter.type = 'highshelf'
  toneFilter.frequency.value = Math.min(4500, ctx.sampleRate / 2 - 10)
  const postGain = ctx.createGain()

  splitIn.connect(shaper)
  shaper.connect(toneFilter)
  toneFilter.connect(postGain)
  postGain.connect(wetGain)
  wetGain.connect(sumMix)

  splitIn.connect(dryMixGain)
  dryMixGain.connect(sumMix)

  const path = wetDry(ctx, splitIn, sumMix, 0)
  let currentDriveKey = Number.NaN

  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'saturator') return
    const p = next.params as SaturatorParams
    const driveKey = Math.round(p.driveDb * 10) / 10
    if (driveKey !== currentDriveKey) {
      shaper.curve = buildTapeSaturatorCurve(driveKey)
      currentDriveKey = driveKey
    }
    const mix = Math.max(0, Math.min(1, p.mix))
    setParam(ctx, toneFilter.gain, p.toneDb, immediate)
    setParam(ctx, postGain.gain, dbToGain(p.outputDb), immediate)
    setParam(ctx, wetGain.gain, mix, immediate)
    setParam(ctx, dryMixGain.gain, 1 - mix, immediate)
    setBypass(ctx, path, next.bypass, immediate)
  }
  update(fx, true)
  return {
    type: 'saturator',
    input: path.input,
    output: path.output,
    latencyS: 0,
    update,
    dispose: () => disconnectAll([splitIn, sumMix, wetGain, dryMixGain, shaper, toneFilter, postGain, ...path.nodes]),
  }
}

function createStereoImagerUnit(ctx: BaseAudioContext, fx: StudioFx): FxUnit {
  // Matriz Mid/Side exacta:
  //   M = 0.5 * (L + R)
  //   S = 0.5 * (L - R) -> Pasa-altos (monoBassHz) -> ganancia width
  //   L' = M + S', R' = M - S'
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

  const sideL = ctx.createGain()
  sideL.gain.value = 0.5
  const sideR = ctx.createGain()
  sideR.gain.value = -0.5
  const sideSum = ctx.createGain()
  const sideHpf = ctx.createBiquadFilter()
  sideHpf.type = 'highpass'
  sideHpf.Q.value = 20 * Math.log10(STUDIO_EQ_HPF_Q)
  const sideWidth = ctx.createGain()
  const sideInv = ctx.createGain()
  sideInv.gain.value = -1

  stereoIn.connect(splitter)
  splitter.connect(midL, 0)
  splitter.connect(midR, 1)
  midL.connect(midSum)
  midR.connect(midSum)

  splitter.connect(sideL, 0)
  splitter.connect(sideR, 1)
  sideL.connect(sideSum)
  sideR.connect(sideSum)
  sideSum.connect(sideHpf)
  sideHpf.connect(sideWidth)
  sideWidth.connect(sideInv)

  // L' = M + S', R' = M - S'
  midSum.connect(merger, 0, 0)
  sideWidth.connect(merger, 0, 0)
  midSum.connect(merger, 0, 1)
  sideInv.connect(merger, 0, 1)

  const path = wetDry(ctx, stereoIn, merger, 0)
  const nyquist = ctx.sampleRate / 2 - 10
  const update = (next: StudioFx, immediate: boolean) => {
    if (next.type !== 'stereo_imager') return
    const p = next.params as StereoImagerParams
    setParam(ctx, sideWidth.gain, Math.max(0, Math.min(2, p.width)), immediate)
    setParam(ctx, sideHpf.frequency, Math.max(0, Math.min(nyquist, p.monoBassHz)), immediate)
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
      disconnectAll([stereoIn, splitter, merger, midL, midR, midSum, sideL, sideR, sideSum, sideHpf, sideWidth, sideInv, ...path.nodes]),
  }
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
