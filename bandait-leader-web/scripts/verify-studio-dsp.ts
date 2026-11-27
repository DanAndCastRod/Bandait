/**
 * Verificacion de los arreglos DSP de la revision de la ola 3 (2026-11-27):
 *   node --experimental-strip-types --no-warnings scripts/verify-studio-dsp.ts
 *
 * Senales realistas: bateria sintetica con bombo en 1 y 3 y caja en 2 y 4 mas ruido, ruido blanco
 * y rosa, progresiones con armonicos, notas con ruido a SNR 10 y 20 dB, NaN sueltos, bloques
 * perdidos. Cubre:
 *   - de-esser (bandas complementarias, makeup automatico del compresor), saturador (nivel,
 *     continua, mezcla dentro de la curva, latencia declarada), stereo_imager (transparente con
 *     width 1), respuesta exacta del EQ;
 *   - BPM (octava y confianza), tonalidad (confianza), YIN (confianza con ruido, borde tauMax,
 *     27,5 Hz), entrada saneada, downmix de mas de 2 canales;
 *   - analisis musical con politica de confianza y rejilla de acordes;
 *   - alinear fase idempotente con la referencia invertida;
 *   - Auto-Master calibrado midiendo (+-0,5 LU, pico real bajo el techo, idempotente) con un render
 *     simulado (compresor, saturador, limitador de recorte con picos entre muestras);
 *   - medidor de sonoridad por trozos igual al de una pasada;
 *   - toma en memoria (seq, huecos, mono real, fin, memoria);
 *   - optimizador Bark (sin HPF a ciegas, sesion valida).
 *
 * Nada toca la red, el navegador, Web Audio ni datos reales.
 */
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import {
  BPM_APPLY_MIN_CONFIDENCE,
  KEY_APPLY_MIN_CONFIDENCE,
  YIN_RELIABLE_CONFIDENCE,
  alignPhaseCrossCorrelation,
  analyzeMusical,
  createLoudnessSummaryMeter,
  detectBpmLocal,
  detectChordsViterbi,
  detectKeyLocal,
  detectPitchYin,
  downmixMono,
  measureLoudnessSummary,
  planPhaseAlignment,
} from '../src/services/studio/dspMath.ts'
import { measureLoudnessInChunks } from '../src/services/studio/dspAnalysisClient.ts'
import {
  BUTTERWORTH_Q_DB,
  DE_ESSER_KNEE_DB,
  biquadCoefficients,
  buildTapeSaturatorCurve,
  deEsserRatio,
  deEsserSumResponse,
  dynamicsCompressorMakeupDb,
  eqPowerGainAt,
  fxLatencySeconds,
  saturatorMakeupGain,
  setWaveShaperLatencyFrames,
  stereoImagerResponse,
  SATURATOR_DC_BLOCK_HZ,
} from '../src/services/studio/fx.ts'
import { graphLatency } from '../src/services/studio/graph.ts'
import { LookaheadLimiter, limiterLookaheadFrames, limiterReleaseCoef } from '../src/services/studio/limiterCore.ts'
import { AUTO_MASTER_PROFILES, calibrateAutoMaster, type AutoMasterMeasurement, type AutoMasterProfile } from '../src/services/studio/mastering.ts'
import { MemoryTakeAccumulator } from '../src/services/studio/memoryTake.ts'
import { optimizeBarkMixUnmasking } from '../src/services/studio/mixOptimizer.ts'
import { synthesizeClickGuideMono } from '../src/services/studio/productionTools.ts'
import {
  STUDIO_LIMITER_LOOKAHEAD_MS,
  defaultFx,
  defaultTrack,
  parseSession,
  serializeSession,
  type StudioMaster,
  type StudioSession,
} from '../src/services/studio/session.ts'
import { encodeWav24, parseWavHeader } from '../src/services/wav.ts'

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err instanceof Error ? err.message : String(err)}`)
  }
}

const SR = 48000

let seed = 20261127
function rand(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 4294967296
}
function gauss(): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand())
}
const db = (x: number) => 20 * Math.log10(Math.max(1e-12, x))
const cents = (a: number, b: number) => 1200 * Math.log2(a / b)

function addNoise(x: Float32Array, snrDb: number): Float32Array {
  let p = 0
  for (let i = 0; i < x.length; i++) p += x[i] * x[i]
  const sigma = Math.sqrt(p / x.length / Math.pow(10, snrDb / 10))
  const out = new Float32Array(x)
  for (let i = 0; i < out.length; i++) out[i] += sigma * gauss()
  return out
}

function harmonicTone(f0: number, n: number, snrDb?: number): Float32Array {
  const harm = [1, 0.5, 0.3, 0.2]
  const ph = harm.map(() => rand() * 2 * Math.PI)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let h = 0; h < harm.length; h++) s += harm[h] * Math.sin((2 * Math.PI * f0 * (h + 1) * i) / SR + ph[h])
    out[i] = s * 0.3
  }
  return snrDb === undefined ? out : addNoise(out, snrDb)
}

/** Bateria: bombo en 1 y 3, caja en 2 y 4, hat en negras y corcheas, con `jitterMs` de humanizacion. */
function drums(bpm: number, seconds: number, snrDb: number, jitterMs = 0): Float32Array {
  const n = Math.round(SR * seconds)
  const out = new Float32Array(n)
  const beat = (60 / bpm) * SR
  const hit = (pos: number, f: number, dec: number, amp: number, noisy: boolean) => {
    const p = Math.round(pos + (jitterMs > 0 ? (rand() - 0.5) * 2 * jitterMs * SR * 0.001 : 0))
    for (let i = 0; i < SR * 0.25 && p + i < n; i++) {
      if (p + i < 0) continue
      const env = Math.exp(-i / (dec * SR))
      out[p + i] += amp * env * (noisy ? gauss() * 0.5 : Math.sin((2 * Math.PI * f * i) / SR))
    }
  }
  for (let b = 0; b * beat < n; b++) {
    const t = b * beat
    if (b % 2 === 0) hit(t, 60, 0.08, 0.9, false)
    else hit(t, 0, 0.05, 0.6, true)
    hit(t, 0, 0.01, 0.15, true)
    hit(t + beat / 2, 0, 0.01, 0.12, true)
  }
  return addNoise(out, snrDb)
}

function whiteNoise(seconds: number, amp = 0.1): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds))
  for (let i = 0; i < out.length; i++) out[i] = amp * gauss()
  return out
}

function pinkNoise(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds))
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < out.length; i++) {
    const w = gauss()
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    out[i] = 0.05 * (b0 + b1 + b2 + w * 0.1848)
  }
  return out
}

function chordAudio(list: number[][], secEach: number): Float32Array {
  const seg = Math.round(SR * secEach)
  const out = new Float32Array(seg * list.length)
  list.forEach((fs, idx) => {
    for (let i = 0; i < seg; i++) {
      let s = 0
      for (const f of fs) s += 0.2 * Math.sin((2 * Math.PI * f * i) / SR) + 0.08 * Math.sin((4 * Math.PI * f * i) / SR)
      out[idx * seg + i] = s
    }
  })
  return out
}
const PROGRESSION = [
  [261.63, 329.63, 392.0],
  [196.0, 246.94, 293.66],
  [220.0, 261.63, 329.63],
  [174.61, 220.0, 261.63],
]

/** Biquad en forma directa I (coeficientes de fx.biquadCoefficients, como Web Audio). */
function runBiquad(x: Float32Array, c: ReturnType<typeof biquadCoefficients>): Float32Array {
  const y = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1
    x1 = x[i]
    y2 = y1
    y1 = v
    y[i] = v
  }
  return y
}

function curveLookup(curve: Float32Array, x: number): number {
  const idx = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (curve.length - 1)
  const i0 = Math.floor(idx)
  const fr = idx - i0
  return curve[i0] * (1 - fr) + curve[Math.min(curve.length - 1, i0 + 1)] * fr
}

const rms = (x: Float32Array) => {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length))
}

const baseSession = (): StudioSession => parseSession(structuredClone(sessionFixtureV2))

console.log('1. Efectos: de-esser, saturador, stereo_imager, EQ')

await check('De-esser: con reduccion 0 la suma de bandas es plana (+-0,5 dB); la topologia anterior tenia un hueco de -180 dB', () => {
  let worstNew = 0
  let worstOld = 0
  for (const crossover of [2000, 6500, 10000]) {
    for (let f = 20; f <= 20000; f *= 1.05) {
      const n = deEsserSumResponse(f, crossover, SR)
      worstNew = Math.max(worstNew, Math.abs(db(Math.hypot(n[0], n[1]))))
      const o = deEsserSumResponse(f, crossover, SR, true)
      worstOld = Math.max(worstOld, Math.abs(db(Math.hypot(o[0], o[1]))))
    }
  }
  assert.ok(worstNew <= 0.5, `respuesta nueva fuera de +-0,5 dB: ${worstNew.toFixed(3)} dB`)
  const notch = deEsserSumResponse(6500, 6500, SR, true)
  assert.ok(db(Math.hypot(notch[0], notch[1])) < -60, 'la topologia anterior debia mostrar el hueco en el corte')
  assert.ok(worstOld > 10, `la topologia anterior se desviaba ${worstOld.toFixed(1)} dB`)
  // En el tiempo, con voz sintetica + sibilancia + ruido: grave + (x - grave) reconstruye x.
  const voice = addNoise(harmonicTone(180, SR), 25)
  for (let i = 0; i < voice.length; i += 9000) for (let k = 0; k < 2400 && i + k < voice.length; k++) voice[i + k] += 0.2 * gauss()
  const low = runBiquad(voice, biquadCoefficients('lowpass', 6500, BUTTERWORTH_Q_DB, 0, SR))
  let maxErr = 0
  for (let i = 0; i < voice.length; i++) maxErr = Math.max(maxErr, Math.abs(low[i] + (voice[i] - low[i]) - voice[i]))
  assert.ok(maxErr < 1e-6, `reconstruccion en el tiempo: error ${maxErr}`)
})

await check('De-esser: el makeup automatico del compresor (~+9 dB con los valores por defecto) se resta; con relacion 1 es ~0 dB', () => {
  const r0 = dynamicsCompressorMakeupDb(-24, DE_ESSER_KNEE_DB, deEsserRatio(0))
  assert.ok(Math.abs(r0) < 0.1, `makeup con relacion 1: ${r0.toFixed(3)} dB`)
  const def = dynamicsCompressorMakeupDb(-24, DE_ESSER_KNEE_DB, deEsserRatio(6))
  assert.ok(def > 5 && def < 14, `makeup con los valores por defecto: ${def.toFixed(2)} dB`)
  // Rodilla 0: coincide con la formula cerrada 0,6 * -(thr + (0 - thr) / ratio).
  const hard = dynamicsCompressorMakeupDb(-24, 0, 6)
  assert.ok(Math.abs(hard - 0.6 * 20) < 0.3, `rodilla dura: ${hard.toFixed(2)} dB (esperado ~12)`)
  // El makeup crece con la relacion: sin el trim, mas reduccion pedida = MAS sibilancia bajo el umbral.
  let prev = -1
  for (const red of [0, 6, 12, 18]) {
    const m = dynamicsCompressorMakeupDb(-24, DE_ESSER_KNEE_DB, deEsserRatio(red))
    assert.ok(m > prev, `makeup no crece con la reduccion (${red} dB -> ${m.toFixed(2)})`)
    prev = m
  }
  assert.ok(dynamicsCompressorMakeupDb(-16, 6, 2) > 2, 'el glue del master tambien tiene makeup automatico')
})

await check('Saturador: unidad con drive 0, misma sonoridad de referencia con cualquier drive, sin continua tras el filtro de 10 Hz', () => {
  const smallGainDb = (curve: Float32Array) => {
    const mid = (curve.length - 1) / 2
    const step = 2 / (curve.length - 1)
    return db((curve[mid + 1] - curve[mid - 1]) / (2 * step))
  }
  const c0 = buildTapeSaturatorCurve(0)
  assert.ok(Math.abs(smallGainDb(c0)) < 0.05, `ganancia de pequena senal con drive 0: ${smallGainDb(c0).toFixed(3)} dB`)
  assert.equal(c0[(c0.length - 1) / 2], 0, 'silencio a la entrada: 0 a la salida')
  assert.equal(saturatorMakeupGain(0), 1)
  const sine = new Float32Array(4800)
  for (let i = 0; i < sine.length; i++) sine[i] = 0.3 * Math.sin((2 * Math.PI * 100 * i) / SR)
  for (const drive of [0, 2.4, 6, 12, 24]) {
    const curve = buildTapeSaturatorCurve(drive)
    const out = sine.map((x) => curveLookup(curve, x))
    let mean = 0
    for (const v of out) mean += v
    mean /= out.length
    const centered = out.map((v) => v - mean)
    const deltaDb = db(rms(centered) / rms(sine))
    assert.ok(Math.abs(deltaDb) <= 0.5, `drive ${drive}: el nivel de referencia cambio ${deltaDb.toFixed(2)} dB`)
  }
  // Programa real (bateria a ~-18 dBFS RMS) con el drive por defecto (6 dB): cerca de la unidad.
  const drum = drums(120, 4, 30)
  const scale = 0.125 / rms(drum)
  const prog = drum.map((x) => x * scale)
  const satProg = prog.map((x) => curveLookup(buildTapeSaturatorCurve(6), x))
  const progDelta = db(rms(satProg) / rms(prog))
  assert.ok(Math.abs(progDelta) <= 1.5, `bateria con drive 6: ${progDelta.toFixed(2)} dB`)
  // Continua: la asimetria la genera; el pasa altos de 10 Hz la quita.
  const long = new Float32Array(SR * 3)
  for (let i = 0; i < long.length; i++) long[i] = curveLookup(buildTapeSaturatorCurve(12), 0.5 * Math.sin((2 * Math.PI * 110 * i) / SR))
  let rawDc = 0
  for (const v of long) rawDc += v
  rawDc /= long.length
  assert.ok(Math.abs(rawDc) > 1e-3, 'la curva asimetrica deberia generar continua')
  const blocked = runBiquad(long, biquadCoefficients('highpass', SATURATOR_DC_BLOCK_HZ, BUTTERWORTH_Q_DB, 0, SR))
  let dc = 0
  const tail = blocked.subarray(SR * 2)
  for (const v of tail) dc += v
  dc /= tail.length
  assert.ok(Math.abs(dc) < 1e-4, `continua tras el filtro: ${dc}`)
})

await check('Saturador: la mezcla seca va dentro de la curva (sin peine) y su latencia entra en la compensacion del grafo', () => {
  const half = buildTapeSaturatorCurve(6, 0.5)
  const wet = buildTapeSaturatorCurve(6, 1)
  const dry = buildTapeSaturatorCurve(6, 0)
  for (let i = 0; i < half.length; i += 97) {
    const x = (i / (half.length - 1)) * 2 - 1
    assert.ok(Math.abs(dry[i] - x) < 1e-6, 'mix 0 = identidad')
    assert.ok(Math.abs(half[i] - Math.max(-1, Math.min(1, 0.5 * wet[i] + 0.5 * x))) < 1e-5, 'mix 0,5 = mitad y mitad')
  }
  setWaveShaperLatencyFrames(SR, 3)
  assert.equal(fxLatencySeconds('saturator', SR, true), 3 / SR)
  const s = baseSession()
  const t = { ...defaultTrack({ id: 'trk_sat', name: 'Sat', role: 'guitar' }), fx: [defaultFx('saturator')] }
  const lat = graphLatency({ ...s, tracks: [t], master: { ...s.master, fx: [] } }, SR, true)
  assert.equal(lat.trackBusS, 3 / SR)
  setWaveShaperLatencyFrames(SR, 0)
})

await check('stereo_imager: identidad con width 1 sin graves mono; con graves mono la imagen queda intacta sobre el corte', () => {
  for (const f of [20, 100, 1000, 10000]) {
    const r = stereoImagerResponse(f, 1, 0, SR)
    assert.deepEqual(r, { mid: [1, 0], side: [1, 0] })
  }
  for (let f = 20; f <= 20000; f *= 1.1) {
    const r = stereoImagerResponse(f, 1, 120, SR)
    const mMag = Math.hypot(r.mid[0], r.mid[1])
    assert.ok(Math.abs(db(mMag)) < 0.01, `medio no plano en ${f.toFixed(0)} Hz: ${db(mMag).toFixed(3)} dB`)
    if (f >= 480) {
      const sMag = Math.hypot(r.side[0], r.side[1])
      const dPhase = Math.abs(Math.atan2(r.side[1], r.side[0]) - Math.atan2(r.mid[1], r.mid[0])) * (180 / Math.PI)
      assert.ok(Math.abs(db(sMag / mMag)) < 0.2, `lado vs medio en ${f.toFixed(0)} Hz: ${db(sMag / mMag).toFixed(3)} dB`)
      assert.ok(Math.min(dPhase, 360 - dPhase) < 3, `fase lado-medio en ${f.toFixed(0)} Hz: ${dPhase.toFixed(2)} grados`)
    }
  }
  const low = stereoImagerResponse(30, 1, 120, SR)
  assert.ok(db(Math.hypot(low.side[0], low.side[1])) < -20, 'el lado bajo el corte se quita (graves en mono)')
  const wide = stereoImagerResponse(2000, 1.5, 120, SR)
  assert.ok(Math.abs(db(Math.hypot(wide.side[0], wide.side[1])) - db(1.5)) < 0.1, 'width 1,5 sube el lado 3,5 dB')
})

await check('EQ: la ganancia que usa el optimizador es la respuesta exacta de los biquads del motor', () => {
  const eq = { hpfHz: 100, lowDb: 0, midHz: 1000, midDb: -6, midQ: 2, highDb: 0 }
  assert.ok(Math.abs(10 * Math.log10(eqPowerGainAt(eq, 1000, SR)) + 6) < 0.05, 'campana de -6 dB en su centro')
  assert.ok(Math.abs(10 * Math.log10(eqPowerGainAt(eq, 100, SR)) + 3.01) < 0.1, 'pasa altos Butterworth: -3 dB en el corte')
  assert.ok(Math.abs(10 * Math.log10(eqPowerGainAt(eq, 8000, SR))) < 0.1, 'plano lejos de las bandas')
})

console.log('\n2. Deteccion: BPM, tonalidad, YIN')

await check('BPM: bateria real (bombo 1 y 3, caja 2 y 4, SNR 15 dB) da el pulso de negra, no la mitad, de 62 a 190 BPM', () => {
  const misses: string[] = []
  for (const bpm of [62, 72, 85, 92, 100, 120, 128, 140, 150, 165, 174, 190]) {
    const r = detectBpmLocal(drums(bpm, 20, 15), SR)
    if (!r || Math.abs(r.bpm - bpm) > 1 || r.confidence < BPM_APPLY_MIN_CONFIDENCE) misses.push(`${bpm}->${r?.bpm}/${r?.confidence.toFixed(2)}`)
    const c = detectBpmLocal(synthesizeClickGuideMono({ bpm, beatsPerBar: 4, bars: 12, sampleRate: SR }).samples, SR)
    if (!c || Math.abs(c.bpm - bpm) > 1) misses.push(`clic ${bpm}->${c?.bpm}`)
  }
  assert.deepEqual(misses, [])
})

await check('BPM: humanizacion de +-8 ms, un NaN suelto y SNR 6 dB no lo rompen; ruido blanco y continua no dan confianza', () => {
  const human = detectBpmLocal(drums(128, 20, 15, 8), SR)
  assert.ok(human && Math.abs(human.bpm - 128) <= 1, `humanizado: ${human?.bpm}`)
  const withNan = drums(140, 15, 15)
  withNan[12345] = NaN
  const nanRes = detectBpmLocal(withNan, SR)
  assert.ok(nanRes && Math.abs(nanRes.bpm - 140) <= 1, `con NaN: ${nanRes?.bpm}`)
  const noisy = detectBpmLocal(drums(120, 20, 6), SR)
  assert.ok(noisy && Math.abs(noisy.bpm - 120) <= 1, `SNR 6 dB: ${noisy?.bpm}`)
  const noise = detectBpmLocal(whiteNoise(8), SR)
  assert.ok(!noise || noise.confidence < 0.2, `ruido blanco con confianza ${noise?.confidence}`)
  assert.equal(detectBpmLocal(new Float32Array(SR * 3).fill(0.5), SR), null)
})

await check('Tonalidad: confianza alta con una progresion (aun con ruido y un NaN), ~0 con ruido blanco o rosa', () => {
  const prog = chordAudio(PROGRESSION, 2)
  const k = detectKeyLocal(prog, SR)
  assert.ok(k && (k.key === 'C' || k.key === 'Am') && k.confidence >= 0.7, `progresion: ${k?.key} ${k?.confidence}`)
  const dirty = addNoise(prog, 15)
  dirty[5000] = NaN
  const kd = detectKeyLocal(dirty, SR)
  assert.ok(kd && kd.key === 'C' && kd.confidence >= KEY_APPLY_MIN_CONFIDENCE, `con ruido y NaN: ${kd?.key} ${kd?.confidence}`)
  assert.deepEqual(
    detectChordsViterbi(dirty, SR, 120, { stepBeats: 4 }).map((c) => c.name),
    ['C', 'G', 'Am', 'F'],
  )
  for (const [name, x] of [['blanco', whiteNoise(8)], ['rosa', pinkNoise(8)]] as const) {
    const kn = detectKeyLocal(x, SR)
    assert.ok(!kn || kn.confidence < 0.2, `ruido ${name} con confianza ${kn?.confidence}`)
  }
})

await check('YIN: < 0,5 cents con senal limpia de 27,5 Hz a 1,3 kHz; con ruido la confianza baja y lo confiable sigue afinado', () => {
  for (const f of [27.5, 30.87, 41.2, 55, 82.41, 110, 196, 329.63, 440, 880, 1318.5]) {
    const r = detectPitchYin(harmonicTone(f, 4096), SR, { threshold: 0.14, minHz: 27.5 })
    assert.ok(r, `limpio ${f} Hz: null`)
    assert.ok(Math.abs(cents(r.hz, f)) < 0.5, `limpio ${f} Hz: ${cents(r.hz, f).toFixed(2)} cents`)
    assert.ok(r.confidence > 0.8, `limpio ${f} Hz: confianza ${r.confidence.toFixed(2)}`)
  }
  for (const snr of [20, 10]) {
    for (const f of [27.5, 41.2, 55, 82.41, 110, 196, 440, 880]) {
      const r = detectPitchYin(harmonicTone(f, 4096, snr), SR, { threshold: 0.14, minHz: 27.5 })
      if (!r) continue
      if (snr === 10) assert.ok(r.confidence < YIN_RELIABLE_CONFIDENCE, `SNR 10 dB ${f} Hz: confianza ${r.confidence.toFixed(2)} (error ${cents(r.hz, f).toFixed(1)} c)`)
      if (r.confidence >= YIN_RELIABLE_CONFIDENCE) assert.ok(Math.abs(cents(r.hz, f)) < 12, `SNR ${snr} dB ${f} Hz confiable con ${cents(r.hz, f).toFixed(1)} cents`)
    }
  }
})

await check('YIN: un minimo pegado a tauMax devuelve null (antes: F#1 a 152 cents); NaN y silencio tambien', () => {
  assert.equal(detectPitchYin(harmonicTone(41.2, 4096), SR, { threshold: 0.14 }), null)
  const withNan = harmonicTone(220, 4096)
  withNan[100] = NaN
  const r = detectPitchYin(withNan, SR)
  assert.ok(r && Math.abs(cents(r.hz, 220)) < 5, `con un NaN: ${r?.hz}`)
  assert.equal(detectPitchYin(new Float32Array(4096), SR), null)
  assert.equal(detectPitchYin(new Float32Array(4096).fill(NaN), SR), null)
})

await check('downmixMono con 3 canales de distinto largo usa el mas corto', () => {
  const m = downmixMono([new Float32Array(10).fill(3), new Float32Array(8).fill(3), new Float32Array(5).fill(3)])
  assert.equal(m.length, 5)
  assert.ok(m.every((v) => Math.abs(v - 3) < 1e-6))
})

console.log('\n3. Politica de confianza y alinear fase')

await check('analyzeMusical: con ruido no aplica BPM ni tonalidad y la rejilla de acordes es la de la sesion', () => {
  const noise = analyzeMusical(whiteNoise(10), SR, { sessionBpm: 97, startS: 4 })
  assert.equal(noise.bpmReliable, false)
  assert.equal(noise.keyReliable, false)
  assert.equal(noise.gridBpm, 97)
  if (noise.chords.length > 0) assert.ok(Math.abs(noise.chords[0].beat - 4 * (97 / 60)) < 0.01, 'el desfase del clip se convierte con la rejilla vigente')
  const song = drums(140, 16, 20)
  const prog = chordAudio([...PROGRESSION, ...PROGRESSION], 16 / 8)
  for (let i = 0; i < song.length; i++) song[i] = 0.6 * song[i] + prog[i]
  const good = analyzeMusical(song, SR, { sessionBpm: 97, startS: 0 })
  assert.equal(good.bpmReliable, true)
  assert.equal(good.gridBpm, good.bpm?.bpm)
  assert.ok(good.bpm && Math.abs(good.bpm.bpm - 140) <= 1, `bateria + acordes: ${good.bpm?.bpm}`)
})

await check('Alinear fase: dos pulsaciones dejan lo mismo (tambien con la referencia invertida)', () => {
  const len = SR * 2
  const source = drums(120, 3, 30)
  for (const refInverted of [false, true]) {
    // Audio crudo: el objetivo es la referencia invertida y retrasada 37 muestras.
    const refRaw = source.subarray(1000, 1000 + len)
    const tgtRaw = new Float32Array(len + 200)
    for (let i = 0; i < tgtRaw.length; i++) tgtRaw[i] = -(source[1000 + i - 37] ?? 0)
    let clip = { startS: 1, phaseInvert: false }
    const refStartS = 1
    const step = () => {
      const tFrom = Math.max(0, Math.floor((Math.max(clip.startS, refStartS) - clip.startS) * SR))
      const rFrom = Math.max(0, Math.floor((Math.max(clip.startS, refStartS) - refStartS) * SR))
      const count = Math.min(SR, tgtRaw.length - tFrom, refRaw.length - rFrom)
      const res = alignPhaseCrossCorrelation(refRaw.subarray(rFrom, rFrom + count), tgtRaw.subarray(tFrom, tFrom + count), SR, 40)
      return planPhaseAlignment({ targetStartS: clip.startS, targetLengthS: 2, referencePhaseInvert: refInverted, lagSeconds: res.lagSeconds, polarity: res.polarity, maxSessionS: 1200 })
    }
    const first = step()
    clip = { startS: first.startS, phaseInvert: first.phaseInvert }
    const second = step()
    assert.ok(Math.abs(first.startS - (1 - 37 / SR)) < 1e-9, `primer paso: ${first.startS}`)
    assert.equal(first.phaseInvert, !refInverted, 'el objetivo queda con la polaridad de como suena la referencia')
    assert.ok(Math.abs(second.startS - first.startS) < 1e-9, 'la segunda pulsacion no mueve el clip')
    assert.equal(second.phaseInvert, first.phaseInvert, 'la segunda pulsacion no deshace la polaridad')
  }
})

console.log('\n4. Auto-Master calibrado midiendo')

/** Mezcla estereo de prueba: bateria + bajo + acordes, a `lufsTarget` aproximado. */
function preMix(seconds: number, gain: number): [Float32Array, Float32Array] {
  const d = drums(118, seconds, 35)
  const prog = chordAudio([...PROGRESSION, ...PROGRESSION, ...PROGRESSION], seconds / 12)
  const L = new Float32Array(d.length)
  const R = new Float32Array(d.length)
  for (let i = 0; i < d.length; i++) {
    const bass = 0.25 * Math.sin((2 * Math.PI * 55 * i) / SR)
    const p = prog[i] ?? 0
    L[i] = gain * (d[i] + bass + 0.8 * p)
    R[i] = gain * (d[i] + bass + 0.6 * p)
  }
  return [L, R]
}

/**
 * Render simulado de la cadena del master: compresor (envolvente + curva + makeup automatico),
 * saturador (la misma curva), volumen y el nucleo real del limitador (pico de MUESTRA: deja picos
 * entre muestras, que obligan a la calibracion a bajar el techo para el pico real).
 */
function simulateRender(source: [Float32Array, Float32Array], master: StudioMaster): [Float32Array, Float32Array] {
  const out: [Float32Array, Float32Array] = [new Float32Array(source[0]), new Float32Array(source[1])]
  const comp = master.fx.find((f) => f.type === 'compressor')
  const sat = master.fx.find((f) => f.type === 'saturator')
  const lim = master.fx.find((f) => f.type === 'limiter')
  if (comp && comp.type === 'compressor' && !comp.bypass) {
    const p = comp.params
    const makeup = Math.pow(10, (dynamicsCompressorMakeupDb(p.thresholdDb, p.kneeDb, p.ratio) + p.makeupDb) / 20)
    const att = Math.exp(-1 / (SR * p.attackMs * 0.001))
    const rel = Math.exp(-1 / (SR * p.releaseMs * 0.001))
    let env = 0
    for (let i = 0; i < out[0].length; i++) {
      const lvl = Math.max(Math.abs(out[0][i]), Math.abs(out[1][i]))
      env = lvl > env ? att * env + (1 - att) * lvl : rel * env + (1 - rel) * lvl
      const envDb = db(env)
      const over = envDb - p.thresholdDb
      const grDb = over > 0 ? over - over / p.ratio : 0
      const g = Math.pow(10, -grDb / 20) * makeup
      out[0][i] *= g
      out[1][i] *= g
    }
  }
  if (sat && sat.type === 'saturator' && !sat.bypass) {
    const curve = buildTapeSaturatorCurve(sat.params.driveDb, sat.params.mix)
    const post = Math.pow(10, sat.params.outputDb / 20)
    for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] = curveLookup(curve, ch[i]) * post
  }
  const vol = Math.pow(10, master.volumeDb / 20)
  for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= vol
  if (lim && lim.type === 'limiter' && !lim.bypass) {
    // El MISMO nucleo del worklet del master (pico de muestra, anticipacion de 5 ms).
    const limiter = new LookaheadLimiter(2, limiterLookaheadFrames(SR, STUDIO_LIMITER_LOOKAHEAD_MS))
    const limited: [Float32Array, Float32Array] = [new Float32Array(out[0].length), new Float32Array(out[1].length)]
    limiter.process(out, limited, out[0].length, Math.pow(10, lim.params.ceilingDb / 20), limiterReleaseCoef(lim.params.releaseMs, SR), false)
    return limited
  }
  return out
}

function measureFor(source: [Float32Array, Float32Array]) {
  let renders = 0
  const measure = async (session: StudioSession): Promise<AutoMasterMeasurement> => {
    renders++
    const rendered = session.master.fx.length === 0 && session.master.volumeDb === 0 ? source : simulateRender(source, session.master)
    return measureLoudnessSummary(rendered, SR)
  }
  return { measure, count: () => renders }
}

await check('Auto-Master: queda a +-0,5 LU del objetivo y con el pico real bajo el techo, desde mezclas a -30, -20 y -12 LUFS', async () => {
  const report: string[] = []
  const cases: Array<[AutoMasterProfile, number]> = [
    ['streaming', 0.05],
    ['streaming', 0.18],
    ['streaming', 0.5],
    ['club', 0.18],
    ['live_stage', 0.18],
    ['dynamic', 0.18],
  ]
  for (const [profile, gain] of cases) {
    const src = preMix(12, gain)
    const { measure, count } = measureFor(src)
    const cal = await calibrateAutoMaster(baseSession(), { profile, tone: 'balanced' }, measure)
    const spec = AUTO_MASTER_PROFILES[profile]
    report.push(`${profile} pre ${cal.preMasterLufs.toFixed(1)} -> ${cal.measured.lufs.toFixed(2)} LUFS, TP ${cal.measured.truePeakDb.toFixed(2)} (techo lim ${cal.limiterCeilingDb}), ${count()} renders`)
    assert.ok(cal.converged, `no convergio: ${report[report.length - 1]} :: ${cal.summary}`)
    assert.ok(Math.abs(cal.measured.lufs - spec.targetLufs) <= 0.5, report[report.length - 1])
    assert.ok(cal.measured.truePeakDb <= spec.ceilingDb + 0.05, report[report.length - 1])
    assert.ok(count() <= 4, 'como maximo 1 render sin master + 3 con la cadena')
  }
  console.log(`       ${report.join('\n       ')}`)
})

await check('Auto-Master: idempotente (aplicarlo dos veces da la misma cadena) y no confunde una medicion con master', async () => {
  const src = preMix(12, 0.18)
  const first = await calibrateAutoMaster(baseSession(), { profile: 'streaming', tone: 'warm' }, measureFor(src).measure)
  const again = await calibrateAutoMaster({ ...baseSession(), master: first.master }, { profile: 'streaming', tone: 'warm' }, measureFor(src).measure)
  assert.deepEqual(again.master, first.master)
  assert.equal(again.preMasterLufs, first.preMasterLufs, 'la medicion de partida es siempre sin la cadena del master')
  await assert.rejects(calibrateAutoMaster(baseSession(), { profile: 'club' }, async () => ({ lufs: -Infinity, truePeakDb: -Infinity })), /silencio/)
})

console.log('\n5. Medidor por trozos, toma en memoria y optimizador Bark')

await check('Medidor por trozos (trozos de largo variable) = medicion de una pasada: LUFS, pico real, LRA', async () => {
  const [L, R] = preMix(20, 0.2)
  for (let i = SR * 8; i < SR * 12; i++) {
    L[i] *= 0.2
    R[i] *= 0.2
  }
  const whole = measureLoudnessSummary([L, R], SR)
  const meter = createLoudnessSummaryMeter(SR, 2)
  let pos = 0
  while (pos < L.length) {
    const len = Math.min(L.length - pos, 1000 + Math.floor(rand() * 60000))
    meter.push([L.subarray(pos, pos + len), R.subarray(pos, pos + len)])
    pos += len
  }
  const chunked = meter.summary()
  assert.ok(Math.abs(chunked.lufs - whole.lufs) < 0.01, `LUFS ${chunked.lufs} vs ${whole.lufs}`)
  assert.ok(Math.abs(chunked.truePeakDb - whole.truePeakDb) < 0.05, `TP ${chunked.truePeakDb} vs ${whole.truePeakDb}`)
  assert.ok(Math.abs(chunked.lraLu - whole.lraLu) < 0.15, `LRA ${chunked.lraLu} vs ${whole.lraLu}`)
  assert.ok(whole.lraLu > 3, `la mezcla con un tramo bajo tiene LRA: ${whole.lraLu}`)
  const viaAsync = await measureLoudnessInChunks({ numberOfChannels: 2, sampleRate: SR, length: L.length, getChannelData: (c) => (c === 0 ? L : R) })
  assert.ok(Math.abs(viaAsync.lufs - whole.lufs) < 0.01)
})

await check('Toma en memoria: cuenta bloques perdidos por seq, rellena huecos, mono real, espera el fin y ocupa ~50 MB en 180 s estereo', () => {
  const block = (seq: number, frame: number, frames: number, v0: number, v1: number) => {
    const a = new Float32Array(2048).fill(v0)
    const b = new Float32Array(2048).fill(v1)
    return { seq, frame, frames, ch0: a.buffer, ch1: b.buffer }
  }
  const mono = new MemoryTakeAccumulator([1], SR, SR * 10)
  mono.push(block(0, 1000, 2048, 0.1, -0.5))
  mono.push(block(2, 1000 + 2048 * 2, 2048, 0.1, -0.5)) // seq 1 perdido: hueco de 2048
  mono.push(block(3, 1000 + 2048 * 3, 700, 0.1, -0.5)) // ultimo bloque parcial
  mono.end(5) // el worklet entrego 5: el 4 tampoco llego
  const res = mono.finish()
  assert.equal(res.channels, 1)
  assert.equal(res.missingBlocks, 2)
  assert.equal(res.gapFrames, 2048)
  assert.equal(res.frames, 2048 * 3 + 700)
  const bytes = new Uint8Array(res.bytes)
  let o = 0
  for (const part of res.parts) {
    bytes.set(part, o)
    o += part.byteLength
  }
  const header = parseWavHeader(bytes)
  assert.ok(header && header.channels === 1 && header.sampleRate === SR, 'cabecera WAV mono')
  // Contenido: canal 1 (-0,5), silencio en el hueco, igual byte a byte a encodeWav24.
  const ref = new Float32Array(res.frames).fill(-0.5)
  ref.fill(0, 2048, 4096)
  const expected = new Uint8Array(encodeWav24([ref], SR))
  assert.deepEqual(bytes, expected)

  const stereo = new MemoryTakeAccumulator([0, 1], SR, 3000)
  stereo.push(block(0, 0, 2048, 0.25, -0.25))
  stereo.push(block(1, 2048, 2048, 0.25, -0.25))
  const st = stereo.finish()
  assert.equal(st.channels, 2)
  assert.equal(st.frames, 3000)
  assert.equal(st.truncated, true)
  const perSecondStereo = SR * 2 * 3
  const takeMb = (perSecondStereo * 180) / 1e6
  assert.ok(takeMb < 55, `180 s estereo: ${takeMb.toFixed(1)} MB de PCM (antes ~190 MB de pico)`)
})

await check('Optimizador Bark: sin muestras no pone HPF a ciegas; con muestras solo si hay graves; la sesion sigue siendo valida', () => {
  let s = baseSession()
  const g1 = defaultTrack({ id: 'trk_g1', name: 'Guitarra 1', role: 'guitar' })
  const g2 = { ...defaultTrack({ id: 'trk_g2', name: 'Teclado 2', role: 'keys' }), fx: [defaultFx('compressor'), defaultFx('de_esser'), defaultFx('saturator'), defaultFx('stereo_imager')] }
  s = { ...s, tracks: [s.tracks[0], g1, g2] }
  const blind = optimizeBarkMixUnmasking(s, [], { strength: 0.85 })
  for (const t of blind.session.tracks) {
    const eq = t.fx.find((f) => f.type === 'eq')
    if (eq && eq.type === 'eq') assert.ok(eq.params.hpfHz < 75, `HPF a ciegas en ${t.name}: ${eq.params.hpfHz} Hz`)
  }
  assert.ok(blind.afterTotalCollision < blind.beforeTotalCollision, 'el paneo complementario reduce la colision estimada')
  // Muestras: guitarra sin graves (ruido sobre 400 Hz) y teclado con retumbe de 50 Hz.
  const bright = runBiquad(whiteNoise(4), biquadCoefficients('highpass', 400, BUTTERWORTH_Q_DB, 0, SR))
  const rumble = whiteNoise(4, 0.02)
  for (let i = 0; i < rumble.length; i++) rumble[i] += 0.3 * Math.sin((2 * Math.PI * 50 * i) / SR)
  const res = optimizeBarkMixUnmasking(s, [
    { trackId: 'trk_g1', samples: bright, sampleRate: SR },
    { trackId: 'trk_g2', samples: rumble, sampleRate: SR },
  ])
  const eqOf = (id: string) => res.session.tracks.find((t) => t.id === id)?.fx.find((f) => f.type === 'eq')
  const eq1 = eqOf('trk_g1')
  const eq2 = eqOf('trk_g2')
  assert.ok(!eq1 || (eq1.type === 'eq' && eq1.params.hpfHz < 75), 'sin graves medidos no hay HPF')
  assert.ok(eq2 && eq2.type === 'eq' && eq2.params.hpfHz >= 75, 'con retumbe medido si hay HPF')
  const t2 = res.session.tracks.find((t) => t.id === 'trk_g2')
  assert.ok(t2 && t2.fx.length <= 5, 'la cadena no pasa del maximo')
  const roundTrip = parseSession(JSON.parse(JSON.stringify(serializeSession(res.session))))
  assert.equal(roundTrip.tracks.length, res.session.tracks.length, 'la sesion optimizada se guarda y se vuelve a leer')
})

console.log(`\n${passed} ok, ${failures.length} fallas`)
if (failures.length > 0) process.exit(1)
