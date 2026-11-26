/**
 * Verificacion de la logica pura de practica del ENSAYO:
 *   node --experimental-strip-types --no-warnings scripts/verify-stem-practice.ts
 *
 * Cubre: src/services/pitchShifterCore.ts (GranularPitchShifter con WSOLA: identidad a ratio 1,
 * tono medido sobre senoidales, duracion al estirar, uniones sin clics, latencia sin lecturas
 * adelantadas, vaciado), src/services/stemPractice.ts (velocidad, Speed Ramp, sincronia entre el
 * tono del audio y la transposicion de acordes) y su encaje con chordpro.ts.
 *
 * Nada de esto toca la red, el navegador ni datos reales.
 */
import assert from 'node:assert/strict'
import {
  GranularPitchShifter,
  SHIFTER_MAX_RATIO,
  SHIFTER_MIN_RATIO,
  pitchShifterLatencyFrames,
  renderSpeedPitchOffline,
  resampleLinear,
  shiftRatio,
} from '../src/services/pitchShifterCore.ts'
import {
  DEFAULT_SPEED_RAMP,
  INITIAL_TONE,
  applyLinked,
  applyPitch,
  applyTranspose,
  clampPitch,
  clampSpeed,
  formatPitch,
  formatRampStep,
  formatSpeed,
  normalizeRamp,
  parseRampStep,
  parseSpeed,
  pitchForTranspose,
  rampLabel,
  rampLapsToTop,
  rampSpeedForLap,
  stepSpeed,
  toneOctaveFolded,
  transposeForPitch,
  type ToneState,
} from '../src/services/stemPractice.ts'
import { transposeChordPro, transposeKey } from '../src/services/chordpro.ts'
import { StemPlayer } from '../src/services/stemPlayer.ts'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FALLA ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}

function close(actual: number, expected: number, eps: number, what = '') {
  assert.ok(Math.abs(actual - expected) <= eps, `${what} esperaba ${expected} (+-${eps}), obtuve ${actual}`)
}

const SR = 48000

function sine(freq: number, seconds: number, amp = 0.5, sr = SR): Float32Array {
  const n = Math.round(seconds * sr)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr)
  return x
}

/** Frecuencia por cruces por cero ascendentes con interpolacion lineal, sobre [from, to). */
function zeroCrossingFreq(x: Float32Array, from: number, to: number, sr = SR): number {
  let first = -1
  let last = -1
  let count = 0
  for (let i = Math.max(1, from); i < Math.min(to, x.length); i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + x[i - 1] / (x[i - 1] - x[i])
      if (first < 0) first = t
      last = t
      count++
    }
  }
  assert.ok(count >= 3, 'muy pocos cruces por cero')
  return ((count - 1) * sr) / (last - first)
}

/** Frecuencia por autocorrelacion (pico mas alto entre minLag y maxLag). */
function autocorrFreq(x: Float32Array, from: number, len: number, minHz: number, maxHz: number, sr = SR): number {
  const minLag = Math.floor(sr / maxHz)
  const maxLag = Math.ceil(sr / minHz)
  let best = minLag
  let bestV = -Infinity
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i < len; i++) s += x[from + i] * x[from + i + lag]
    if (s > bestV) {
      bestV = s
      best = lag
    }
  }
  return sr / best
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, to - from))
}

function maxStep(x: Float32Array, from: number, to: number): number {
  let m = 0
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]))
  return m
}

/** Pasa `x` por el procesador con un ratio fijo, en bloques de 128 (estereo identico). */
function runShifter(x: Float32Array, ratio: number, shifter = new GranularPitchShifter(SR)): { y: Float32Array; shifter: GranularPitchShifter } {
  const y = new Float32Array(x.length)
  const inL = new Float32Array(128)
  const outL = new Float32Array(128)
  const outR = new Float32Array(128)
  for (let start = 0; start < x.length; start += 128) {
    const frames = Math.min(128, x.length - start)
    inL.fill(0)
    inL.set(x.subarray(start, start + frames))
    shifter.process([inL, inL], [outL, outR], frames, ratio)
    y.set(outL.subarray(0, frames), start)
  }
  return { y, shifter }
}

// ---------------------------------------------------------------------------
// AudioContext simulado: solo lo que usa StemPlayer. Sin AudioWorkletNode, el reproductor queda
// en 'unavailable' (velocidad tipo cinta, latencia 0), que es lo que se puede probar en node.
// ---------------------------------------------------------------------------

class FakeParam {
  value: number
  events: [number, number][] = []
  constructor(value: number) {
    this.value = value
  }
  setValueAtTime(v: number, t: number) {
    this.events.push([v, t])
    return this
  }
  setTargetAtTime(v: number) {
    this.value = v
    return this
  }
  cancelScheduledValues() {
    return this
  }
}

class FakeNode {
  connect() {}
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1)
}

class FakeSource extends FakeNode {
  buffer: unknown = null
  playbackRate = new FakeParam(1)
  onended: (() => void) | null = null
  startArgs: number[] | null = null
  stopped = false
  start(...args: number[]) {
    this.startArgs = args
  }
  stop() {
    this.stopped = true
  }
}

class FakeCtx {
  static last: FakeCtx | null = null
  currentTime = 0
  sampleRate = 48000
  state = 'running'
  destination = new FakeNode()
  sources: FakeSource[] = []
  constructor() {
    FakeCtx.last = this
  }
  createGain() {
    return new FakeGain()
  }
  createBufferSource() {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  async decodeAudioData(data: ArrayBuffer) {
    return { duration: data.byteLength / 1000 }
  }
  async resume() {}
  async close() {
    this.state = 'closed'
  }
}

;(globalThis as unknown as { window: unknown }).window = { AudioContext: FakeCtx }

async function loadedPlayer(): Promise<{ player: StemPlayer; ctx: FakeCtx }> {
  const player = new StemPlayer()
  // 10 s y 8 s de "audio" (el decodificador simulado da 1 s por 1000 bytes).
  await player.load([
    { id: 'drums', blob: new Blob([new Uint8Array(10000)]) },
    { id: 'bass', blob: new Blob([new Uint8Array(8000)]) },
  ])
  return { player, ctx: FakeCtx.last as FakeCtx }
}

async function main() {
  console.log('GranularPitchShifter (pitchShifterCore.ts)')

  await check('ratio = 2^(st/12) / velocidad; rango de practica 0,56..2,83', () => {
    close(shiftRatio(1, 12), 2, 1e-12)
    close(shiftRatio(0.5, 0), 2, 1e-12)
    close(shiftRatio(1, -12), 0.5, 1e-12)
    close(shiftRatio(1.25, 0), 0.8, 1e-12)
    close(SHIFTER_MAX_RATIO, 2 * Math.SQRT2, 1e-12)
    close(SHIFTER_MIN_RATIO, Math.pow(2, -0.5) / 1.25, 1e-12)
    assert.equal(shiftRatio(0, 0), 1, 'velocidad 0 no rompe')
    assert.equal(shiftRatio(Number.NaN, Number.NaN), 1)
  })

  await check('geometria: grano 40 ms al 50 %, latencia fija que cubre el ratio maximo', () => {
    const s = new GranularPitchShifter(SR)
    assert.equal(s.grainFrames, 1920)
    assert.equal(s.hopFrames, 960)
    assert.equal(s.searchFrames, 384)
    assert.equal(s.latencyFrames, pitchShifterLatencyFrames(SR))
    assert.ok(s.latencyFrames >= s.searchFrames + s.grainFrames * (SHIFTER_MAX_RATIO - 1) + 3)
    assert.ok(s.latencyFrames / SR < 0.1, `latencia ${((s.latencyFrames / SR) * 1000).toFixed(1)} ms`)
    assert.equal(new GranularPitchShifter(44100).grainFrames % 2, 0)
  })

  await check('ratio 1: la salida es la entrada retrasada la latencia, exacta', () => {
    const x = new Float32Array(SR)
    for (let i = 0; i < x.length; i++) x[i] = 0.4 * Math.sin(i * 0.031) + 0.3 * Math.sin(i * 0.17 + 1) + 0.1 * ((i * 7919) % 13) / 13
    const { y, shifter } = runShifter(x, 1)
    const D = shifter.latencyFrames
    let maxErr = 0
    for (let i = D + 2000; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i - D]))
    assert.ok(maxErr < 1e-5, `error maximo ${maxErr}`)
  })

  for (const [st, freqIn] of [
    [12, 440],
    [7, 330],
    [6, 440],
    [-6, 440],
    [-9, 440],
    [3, 220],
  ] as const) {
    await check(`tono ${st > 0 ? '+' : ''}${st} st sobre ${freqIn} Hz: frecuencia x 2^(st/12) (cruces por cero y autocorrelacion, +-1 %)`, () => {
      const x = sine(freqIn, 1.5)
      const { y, shifter } = runShifter(x, shiftRatio(1, st))
      const from = shifter.latencyFrames + 4800
      const expected = freqIn * Math.pow(2, st / 12)
      const zc = zeroCrossingFreq(y, from, x.length)
      close(zc, expected, expected * 0.01, 'cruces por cero:')
      const ac = autocorrFreq(y, from, 4800, expected * 0.7, expected * 1.4)
      close(ac, expected, expected * 0.015, 'autocorrelacion:')
      assert.equal(shifter.overreads, 0)
    })
  }

  await check('un ratio fuera del rango se acota (0,5 pedido -> 0,566, el minimo de 1,25x -6 st)', () => {
    const x = sine(440, 1.5)
    const { y, shifter } = runShifter(x, 0.5)
    const expected = 440 * SHIFTER_MIN_RATIO
    close(zeroCrossingFreq(y, shifter.latencyFrames + 4800, x.length), expected, expected * 0.01)
  })

  await check('+12 st: amplitud estable (WSOLA alinea las fases) y uniones sin clics', () => {
    const x = sine(440, 1.5, 0.5)
    const { y, shifter } = runShifter(x, 2)
    const from = shifter.latencyFrames + 4800
    const ideal = 0.5 * Math.SQRT1_2
    // RMS por tramos de 10 ms: sin huecos de cancelacion entre granos.
    let minRms = Infinity
    for (let i = from; i + 480 <= x.length; i += 480) minRms = Math.min(minRms, rms(y, i, i + 480))
    assert.ok(minRms > ideal * 0.85, `RMS minimo ${minRms.toFixed(3)} (ideal ${ideal.toFixed(3)})`)
    // Salto maximo entre muestras: el de una senoidal de 880 Hz de la misma amplitud, con margen.
    const idealStep = 0.5 * 2 * Math.PI * (880 / SR)
    const step = maxStep(y, from, x.length)
    assert.ok(step < idealStep * 1.35, `salto maximo ${step.toFixed(4)} (senoidal ideal ${idealStep.toFixed(4)})`)
  })

  await check('granular sin alineacion (searchMs 0) se cancela mas que con WSOLA: la busqueda sirve', () => {
    const x = sine(523.25, 1.5, 0.5)
    const ratio = shiftRatio(1, 5)
    const aligned = runShifter(x, ratio).y
    const naive = runShifter(x, ratio, new GranularPitchShifter(SR, { searchMs: 0 })).y
    const from = pitchShifterLatencyFrames(SR) + 4800
    const minOf = (y: Float32Array) => {
      let m = Infinity
      for (let i = from; i + 480 <= y.length; i += 480) m = Math.min(m, rms(y, i, i + 480))
      return m
    }
    assert.ok(minOf(aligned) > minOf(naive), `WSOLA ${minOf(aligned).toFixed(3)} vs ingenuo ${minOf(naive).toFixed(3)}`)
  })

  await check('ratio maximo y minimo (0,5x +6 st; 1,25x -6 st): sin lecturas por delante de la entrada', () => {
    for (const ratio of [SHIFTER_MAX_RATIO, SHIFTER_MIN_RATIO, 5, 0.01]) {
      const { shifter } = runShifter(sine(200, 1), ratio)
      assert.equal(shifter.overreads, 0, `ratio ${ratio}`)
    }
  })

  await check('cambio de ratio en marcha: sin clics en la union', () => {
    const x = sine(440, 2, 0.5)
    const s = new GranularPitchShifter(SR)
    const y = new Float32Array(x.length)
    const inB = new Float32Array(128)
    const oL = new Float32Array(128)
    const oR = new Float32Array(128)
    for (let start = 0; start < x.length; start += 128) {
      const frames = Math.min(128, x.length - start)
      inB.fill(0)
      inB.set(x.subarray(start, start + frames))
      const ratio = start < SR ? 1 : shiftRatio(1, 4)
      s.process([inB], [oL, oR], frames, ratio)
      y.set(oL.subarray(0, frames), start)
    }
    const idealStep = 0.5 * 2 * Math.PI * ((440 * Math.pow(2, 4 / 12)) / SR)
    const step = maxStep(y, s.latencyFrames + 4800, x.length)
    assert.ok(step < idealStep * 1.4, `salto maximo ${step.toFixed(4)} vs ${idealStep.toFixed(4)}`)
    assert.equal(s.overreads, 0)
  })

  await check('flush: desvanece en 5 ms y vacia la linea de retardo (no queda audio viejo)', () => {
    const s = new GranularPitchShifter(SR)
    const x = sine(440, 0.5)
    runShifter(x, 1.3, s)
    s.flush()
    const silence = new Float32Array(SR)
    const { y } = runShifter(silence, 1.3, s)
    assert.ok(maxStep(y, 1, 240) < 0.2, 'el desvanecido no es un escalon')
    assert.ok(rms(y, 300, y.length) === 0, 'tras el desvanecido sale silencio')
  })

  await check('entrada mono se duplica en estereo; sin entrada sale silencio', () => {
    const s = new GranularPitchShifter(SR)
    const inB = sine(300, 128 / SR)
    const oL = new Float32Array(128)
    const oR = new Float32Array(128)
    for (let k = 0; k < 200; k++) s.process([inB], [oL, oR], 128, 1)
    assert.deepEqual(Array.from(oL), Array.from(oR))
    s.reset()
    s.process([], [oL, oR], 128, 1)
    assert.equal(rms(oL, 0, 128), 0)
  })

  console.log('\nVelocidad + tono fuera de linea (playbackRate + GranularPitchShifter)')

  await check('remuestreo lineal como playbackRate: dura len / velocidad y cambia el tono', () => {
    const x = sine(440, 1)
    const y = resampleLinear(x, 0.5)
    assert.equal(y.length, 2 * x.length)
    close(zeroCrossingFreq(y, 0, y.length), 220, 2.2)
    assert.equal(resampleLinear(x, 1.25).length, Math.floor(x.length / 1.25))
  })

  for (const speed of [0.5, 0.7, 1.25]) {
    await check(`velocidad ${formatSpeed(speed)}, tono 0: dura 1/${speed} y la frecuencia queda en 440 Hz (+-1 %)`, () => {
      const x = sine(440, 1.2)
      const { output, shifter } = renderSpeedPitchOffline([x, x], SR, speed, 0)
      assert.equal(output.length, 2)
      assert.equal(output[0].length, Math.floor(x.length / speed))
      close(output[0].length / SR, 1.2 / speed, 0.001, 'duracion:')
      const f = zeroCrossingFreq(output[0], 4800, output[0].length - 4800)
      close(f, 440, 4.4, 'frecuencia:')
      assert.equal(shifter.overreads, 0)
    })
  }

  await check('velocidad 0,5x y +6 st (ratio maximo): dura el doble y suena 440 x 2^(1/2)', () => {
    const x = sine(440, 1)
    const { output } = renderSpeedPitchOffline([x], SR, 0.5, 6)
    assert.equal(output[0].length, 2 * x.length)
    const expected = 440 * Math.SQRT2
    close(zeroCrossingFreq(output[0], 4800, output[0].length - 4800), expected, expected * 0.01)
  })

  await check('velocidad 0,75x y -3 st: tono y duracion independientes', () => {
    const x = sine(392, 1)
    const { output } = renderSpeedPitchOffline([x], SR, 0.75, -3)
    assert.equal(output[0].length, Math.floor(x.length / 0.75))
    const expected = 392 * Math.pow(2, -3 / 12)
    close(zeroCrossingFreq(output[0], 4800, output[0].length - 4800), expected, expected * 0.01)
  })

  console.log('\nVelocidad, tono y Speed Ramp (stemPractice.ts)')

  await check('clampSpeed / clampPitch / formatos', () => {
    assert.equal(clampSpeed(0.3), 0.5)
    assert.equal(clampSpeed(2), 1.25)
    assert.equal(clampSpeed(Number.NaN), 1)
    assert.equal(clampSpeed(0.7499999), 0.75)
    assert.equal(clampPitch(7), 6)
    assert.equal(clampPitch(-6.4), -6)
    assert.equal(clampPitch(Number.NaN), 0)
    assert.equal(formatSpeed(0.75), '0,75x')
    assert.equal(formatSpeed(1), '1,00x')
    assert.equal(formatPitch(2), '+2 st')
    assert.equal(formatPitch(-3), '-3 st')
    assert.equal(formatPitch(0), '0 st')
  })

  await check('parseSpeed: coma o punto, "x", porcentaje; fuera de rango = null', () => {
    assert.equal(parseSpeed('0,75'), 0.75)
    assert.equal(parseSpeed(' 0.8x '), 0.8)
    assert.equal(parseSpeed('85%'), 0.85)
    assert.equal(parseSpeed('110'), 1.1)
    assert.equal(parseSpeed('1'), 1)
    assert.equal(parseSpeed('0,733'), 0.733)
    assert.equal(parseSpeed('0,4'), null)
    assert.equal(parseSpeed('1,3'), null)
    assert.equal(parseSpeed('abc'), null)
    assert.equal(parseSpeed(''), null)
  })

  await check('stepSpeed: pasos de 0,05 desde cualquier valor, sin salir del rango', () => {
    assert.equal(stepSpeed(1, 1), 1.05)
    assert.equal(stepSpeed(1, -1), 0.95)
    assert.equal(stepSpeed(0.73, 1), 0.75)
    assert.equal(stepSpeed(0.73, -1), 0.7)
    assert.equal(stepSpeed(1.25, 1), 1.25)
    assert.equal(stepSpeed(0.5, -1), 0.5)
    let v = 0.5
    for (let i = 0; i < 15; i++) v = stepSpeed(v, 1)
    assert.equal(v, 1.25, 'sin error acumulado de coma flotante')
  })

  await check('Speed Ramp 0,70x +0,05 hasta 1,00x: vueltas 0..6 y se queda en el tope', () => {
    const ramp = { enabled: true, start: 0.7, step: 0.05, top: 1 }
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 20].map((lap) => rampSpeedForLap(ramp, lap)), [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1, 1])
    assert.equal(rampLapsToTop(ramp), 6)
    assert.equal(rampLabel(ramp, 0), 'VUELTA 1 · 0,70x')
    assert.equal(rampLabel(ramp, 2), 'VUELTA 3 · 0,80x')
    assert.equal(rampLabel(ramp, 6), 'VUELTA 7 · 1,00x · TOPE')
  })

  await check('Speed Ramp: paso escrito "+0,05", "0.1", "5%"; fuera de 0,01..0,25 = null', () => {
    assert.equal(parseRampStep('+0,05'), 0.05)
    assert.equal(parseRampStep('0.1'), 0.1)
    assert.equal(parseRampStep('+0,05x'), 0.05)
    assert.equal(parseRampStep('5%'), 0.05)
    assert.equal(parseRampStep('5'), 0.05)
    assert.equal(parseRampStep('0'), null)
    assert.equal(parseRampStep('0,5'), null)
    assert.equal(parseRampStep('x'), null)
    assert.equal(formatRampStep(0.05), '+0,05x')
  })

  await check('Speed Ramp: normaliza valores fuera de rango y un tope bajo el inicio', () => {
    assert.deepEqual(normalizeRamp({ enabled: true, start: 0.2, step: 0, top: 3 }), { enabled: true, start: 0.5, step: 0.01, top: 1.25 })
    assert.deepEqual(normalizeRamp({ enabled: false, start: 0.9, step: 0.1, top: 0.6 }), { enabled: false, start: 0.9, step: 0.1, top: 0.9 })
    assert.equal(rampLapsToTop({ enabled: true, start: 0.9, step: 0.1, top: 0.6 }), 0)
    assert.equal(rampSpeedForLap({ enabled: true, start: 0.5, step: 0.25, top: 1.25 }, 2), 1)
    assert.equal(rampSpeedForLap({ enabled: true, start: 0.5, step: 0.25, top: 1.25 }, 3), 1.25)
    assert.equal(rampSpeedForLap(DEFAULT_SPEED_RAMP, -3), 0.7)
    assert.equal(rampSpeedForLap(DEFAULT_SPEED_RAMP, Number.NaN), 0.7)
    // Sin deriva por sumar 0,05 muchas veces.
    assert.equal(rampSpeedForLap({ enabled: true, start: 0.5, step: 0.05, top: 1.25 }, 15), 1.25)
    assert.equal(rampSpeedForLap({ enabled: true, start: 0.5, step: 0.05, top: 1.25 }, 9), 0.95)
  })

  console.log('\nTono del audio <-> transposicion de acordes')

  await check('vinculados: mover el tono +2 transpone los acordes +2, y transponer mueve el tono', () => {
    let s: ToneState = INITIAL_TONE
    s = applyPitch(s, 2)
    assert.deepEqual(s, { transpose: 2, pitch: 2, linked: true })
    s = applyTranspose(s, -3)
    assert.deepEqual(s, { transpose: -3, pitch: -3, linked: true })
    s = applyPitch(s, 9)
    assert.deepEqual(s, { transpose: 6, pitch: 6, linked: true }, 'el audio se acota a +-6')
    // Paso a paso, como el deslizador: los acordes siguen 1 a 1 en todo el rango del audio.
    let t: ToneState = INITIAL_TONE
    for (let p = 0; p >= -6; p--) {
      t = applyPitch(t, p)
      assert.equal(t.transpose, p)
    }
  })

  await check('fuera de +-6: el audio va a la octava equivalente (+7 suena -5) y se avisa', () => {
    assert.deepEqual([7, 8, 11, -7, -11, 6, -6, 0].map(pitchForTranspose), [-5, -4, -1, 5, 1, 6, -6, 0])
    let s = applyTranspose(INITIAL_TONE, 7)
    assert.deepEqual(s, { transpose: 7, pitch: -5, linked: true })
    assert.equal(toneOctaveFolded(s), true)
    assert.equal(toneOctaveFolded(applyTranspose(INITIAL_TONE, 4)), false)
    // Desde +7, mover el audio elige la equivalencia mas cercana a los acordes que habia.
    s = applyPitch(s, -4)
    assert.deepEqual(s, { transpose: 8, pitch: -4, linked: true })
    s = applyPitch(s, -6)
    assert.equal(s.transpose, 6)
    assert.equal(transposeForPitch(-1, 11), 11)
    assert.equal(transposeForPitch(1, -11), -11)
    assert.equal(transposeForPitch(3, 0), 3)
    // Los acordes mostrados suenan igual que el audio (misma clase de altura).
    for (let t = -11; t <= 11; t++) assert.equal((((t - pitchForTranspose(t)) % 12) + 12) % 12, 0)
  })

  await check('sueltos: cada uno se mueve solo; al volver a vincular el audio sigue a los acordes', () => {
    let s = applyLinked(INITIAL_TONE, false)
    s = applyPitch(s, 3)
    assert.deepEqual(s, { transpose: 0, pitch: 3, linked: false })
    s = applyTranspose(s, 5)
    assert.deepEqual(s, { transpose: 5, pitch: 3, linked: false })
    assert.equal(toneOctaveFolded(s), false)
    s = applyLinked(s, true)
    assert.deepEqual(s, { transpose: 5, pitch: 5, linked: true })
  })

  await check('encaje con chordpro.ts: tono +2 deja Am -> Bm y la tonalidad G -> A', () => {
    const s = applyPitch(INITIAL_TONE, 2)
    assert.equal(transposeChordPro('[Am]Medianoche [F]en [C/E]Pereira', s.transpose, transposeKey('Am', s.transpose)), '[Bm]Medianoche [G]en [D/F#]Pereira')
    assert.equal(transposeKey('G', s.transpose), 'A')
    const back = applyTranspose(s, 0)
    assert.equal(back.pitch, 0)
  })

  console.log('\nStemPlayer con un AudioContext simulado (sin worklet: latencia 0)')

  await check('velocidad 0,5x: todas las pistas arrancan con el mismo when y playbackRate; la posicion es la de la cancion', async () => {
    const { player, ctx } = await loadedPlayer()
    player.setSpeed(0.5)
    await player.play()
    const starts = ctx.sources.map((s) => s.startArgs)
    assert.equal(starts.length, 2)
    assert.equal(starts[0]?.[0], starts[1]?.[0], 'mismo when')
    assert.deepEqual(ctx.sources.map((s) => s.playbackRate.value), [0.5, 0.5])
    const when = starts[0]?.[0] ?? 0
    ctx.currentTime = when + 4
    close(player.position(), 2, 1e-9, 'a 0,5x, 4 s de reloj son 2 s de cancion:')
    assert.deepEqual(player.practiceStatus(), { rate: 0.5, lap: null })
    player.dispose()
  })

  await check('cambiar la velocidad sonando: mismo instante en todas las fuentes, posicion continua', async () => {
    const { player, ctx } = await loadedPlayer()
    await player.play()
    const when = ctx.sources[0].startArgs?.[0] ?? 0
    ctx.currentTime = when + 2
    const before = player.position()
    player.setSpeed(0.75)
    const tc = ctx.currentTime + 0.03
    for (const s of ctx.sources) assert.deepEqual(s.playbackRate.events, [[0.75, tc]])
    assert.equal(ctx.sources.length, 2, 'no crea fuentes nuevas: no hay corte')
    ctx.currentTime = tc + 2
    close(player.position(), before + 0.03 + 2 * 0.75, 1e-9, 'posicion:')
    // Dos cambios en el mismo instante (arrastrar el deslizador): sigue sonando.
    player.setSpeed(1.2)
    player.setSpeed(0.6)
    assert.equal(ctx.sources.filter((s) => !s.stopped).length, 2)
    ctx.currentTime += 1
    assert.ok(player.position() > before, 'la posicion sigue avanzando')
    player.dispose()
  })

  await check('Speed Ramp en un bucle: cada vuelta es un tramo con su velocidad (0,70 -> 0,80 -> 0,90 -> 0,90)', async () => {
    const { player, ctx } = await loadedPlayer()
    player.setLoop({ start: 2, end: 4 })
    player.setSpeedRamp({ enabled: true, start: 0.7, step: 0.1, top: 0.9 })
    assert.equal(player.rampActive(), true)
    assert.deepEqual(player.practiceStatus(), { rate: 0.7, lap: 0 })
    await player.play()
    const tick = () => (player as unknown as { tick(): void }).tick()
    const when = ctx.sources[0].startArgs?.[0] ?? 0
    const laps = [0.7, 0.8, 0.9, 0.9]
    let t = when
    for (let k = 0; k < laps.length; k++) {
      if (k > 0) {
        // El intervalo agenda la vuelta siguiente con anticipacion.
        ctx.currentTime = t - 0.5
        tick()
      }
      ctx.currentTime = t + 0.01
      tick()
      const st = player.practiceStatus()
      assert.deepEqual(st, { rate: laps[k], lap: k }, `vuelta ${k}`)
      close(player.position(), 2 + 0.01 * laps[k], 1e-6, `inicio de la vuelta ${k}:`)
      // Las dos pistas de esta vuelta arrancan juntas, con la velocidad de la vuelta.
      const lapSources = ctx.sources.filter((s) => Math.abs((s.startArgs?.[0] ?? -1) - t) < 1e-9)
      assert.equal(lapSources.length, 2, `fuentes de la vuelta ${k}`)
      assert.ok(lapSources.every((s) => s.playbackRate.value === laps[k] && s.startArgs?.[1] === 2 && s.startArgs?.[2] === 2))
      t += 2 / laps[k]
    }
    // Pausa: se conserva la vuelta; stop vuelve a la primera.
    player.pause()
    assert.deepEqual(player.practiceStatus(), { rate: 0.9, lap: 3 })
    player.stop()
    assert.deepEqual(player.practiceStatus(), { rate: 0.7, lap: 0 })
    // Sin bucle la rampa no aplica: manda la velocidad base.
    player.setLoop(null)
    assert.deepEqual(player.practiceStatus(), { rate: 1, lap: null })
    player.dispose()
  })

  await check('audio global: la misma repeticion otra vez (la vista se vuelve a montar) no reinicia la vuelta ni salta', async () => {
    const { player, ctx } = await loadedPlayer()
    player.setLoop({ start: 2, end: 4 })
    player.setSpeedRamp({ enabled: true, start: 0.7, step: 0.1, top: 0.9 })
    await player.play()
    const tick = () => (player as unknown as { tick(): void }).tick()
    const when = ctx.sources[0].startArgs?.[0] ?? 0
    // Segunda vuelta sonando.
    const second = when + 2 / 0.7
    ctx.currentTime = second - 0.5
    tick()
    ctx.currentTime = second + 0.01
    tick()
    assert.deepEqual(player.practiceStatus(), { rate: 0.8, lap: 1 })
    const created = ctx.sources.length
    const pos = player.position()
    // StemStudio vuelve a montarse y aplica la misma region y la misma rampa.
    player.setLoop({ start: 2, end: 4 })
    player.setSpeedRamp({ enabled: true, start: 0.7, step: 0.1, top: 0.9 })
    assert.equal(ctx.sources.length, created, 'no se reprograma nada')
    assert.deepEqual(player.practiceStatus(), { rate: 0.8, lap: 1 })
    close(player.position(), pos, 1e-9, 'la posicion sigue igual:')
    // Una region distinta si reinicia en la primera vuelta.
    player.setLoop({ start: 1, end: 4 })
    assert.equal(player.practiceStatus().lap, 0)
    player.dispose()
  })

  await check('tono sin worklet: se guarda acotado a +-6 y el estado lo dice (unavailable)', async () => {
    const { player } = await loadedPlayer()
    player.setPitch(9)
    assert.equal(player.getPitch(), 6)
    assert.equal(await player.whenShifterSettled(), 'unavailable')
    player.dispose()
  })

  console.log(`\n${passed} ok, ${failures.length} con falla`)
  if (failures.length > 0) process.exit(1)
}

void main()
