/**
 * Humanizacion MIDI, groove de la banda y deriva analogica del Estudio (2026-11-27):
 *   node --experimental-strip-types --no-warnings scripts/verify-studio-humanize.ts
 *
 * Cubre:
 *   - midiOps.humanize: escala exacta del swing (66 % tresillo, 75 % puntillo), presets que suenan
 *     igual que antes del reescalado, fase relativa a la sesion (clipStartBeat), swing idempotente,
 *     micro-timing en ms (mismos ms a cualquier tempo), intensidad que escala swing/strum/acento,
 *     humanizacion de bateria por pieza (laid back, acento de hi-hat, sin rasgueo).
 *   - groove.ts: plantilla desde audio sintetico con swing conocido y su aplicacion a notas.
 *   - instruments/analogDrift.ts, synth.ts, drums.ts y schedule.ts: la deriva de una nota de clip
 *     depende de su posicion musical, no de la hora del AudioContext (en vivo = export), y el
 *     vagabundeo lento es continuo y determinista.
 *
 * Nada toca la red, el navegador ni datos reales. Web Audio se reemplaza por un contexto falso que
 * solo registra los eventos de los AudioParam.
 */
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import { applyGrooveTemplate, extractGrooveTemplate, grooveFromAudio } from '../src/services/studio/groove.ts'
import { STUDIO_HUMANIZE_PRESETS, humanize, humanizeClipContext, resolveHumanize, swingTargetBeat } from '../src/services/studio/midiOps.ts'
import { parseSession, type StudioMidiNote, type StudioSession } from '../src/services/studio/session.ts'
import { analogWander, trackDriftSalt } from '../src/services/studio/instruments/analogDrift.ts'
import { DrumsEngine } from '../src/services/studio/instruments/drums.ts'
import { scheduleMidiClips } from '../src/services/studio/instruments/schedule.ts'
import { SynthEngine } from '../src/services/studio/instruments/synth.ts'
import { PolyInstrument } from '../src/services/studio/instruments/voices.ts'
import type { StudioGraph } from '../src/services/studio/types.ts'

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err instanceof Error ? err.message : String(err)}`)
  }
}

const note = (pitch: number, start: number, length = 0.2, velocity = 90): StudioMidiNote => ({ pitch, start, length, velocity })
/** Solo swing: sin micro-timing, velocidad, duracion ni acento. */
const SWING_ONLY = { timingMs: 0, velocityRange: 0, lengthRatio: 0, accentStrength: 0, strumMs: 0, seed: 1 } as const
const near = (a: number, b: number, eps: number, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} != ${b} (+/- ${eps})`)

console.log('\n1. Swing, fase, ms e intensidad')

check('swing: 0.33 en 1/8 deja la corchea impar en el 66 % del par; 0.5 en el 75 %; 0.5 en 1/16 tambien 75 %', () => {
  const pair = [note(60, 0), note(60, 0.5)]
  const triplet = humanize(pair, null, { ...SWING_ONLY, swing: 1 / 3, swingGrid: '1/8' }, 4).notes
  near(triplet[1].start / 1, 2 / 3, 1e-5, 'tresillo')
  const dotted = humanize(pair, null, { ...SWING_ONLY, swing: 0.5, swingGrid: '1/8' }, 4).notes
  near(dotted[1].start / 1, 0.75, 1e-6, 'puntillo')
  const sixteenth = humanize([note(60, 0), note(60, 0.25)], null, { ...SWING_ONLY, swing: 0.5, swingGrid: '1/16' }, 4).notes
  near(sixteenth[1].start / 0.5, 0.75, 1e-6, 'puntillo en semicorcheas')
  assert.equal(triplet[0].start, 0, 'la nota par no se mueve')
  // El tope es 0.5: 0.75 (el maximo viejo) se acota.
  assert.equal(resolveHumanize({ swing: 0.75 }).swing, 0.5)
})

check('presets reescalados x2/3: el desplazamiento del swing es el de antes (swing_viejo * paso * 2/3)', () => {
  const old: Record<string, number> = { pocket: 0.14, keys: 0.06, strum: 0.08, analog: 0.18 }
  for (const p of STUDIO_HUMANIZE_PRESETS) {
    const step = p.swingGrid === '1/8' ? 0.5 : 0.25
    near(p.swing * step, old[p.id] * step * (2 / 3), 0.0005, p.id)
  }
})

check('fase de sesion: un clip en un contratiempo swinguea y acentua segun el compas, no segun el clip', () => {
  // Clip que empieza en el beat 0.5: su nota en 0 es la corchea impar de la sesion.
  const offbeat = humanize([note(60, 0), note(60, 0.5)], null, { ...SWING_ONLY, swing: 1 / 3, swingGrid: '1/8', clipStartBeat: 0.5 }, 4).notes
  near(offbeat[0].start, 2 / 3 - 0.5, 1e-5, 'nota en el contratiempo swingueada')
  assert.equal(offbeat[1].start, 0.5, 'la nota en el beat 1 de la sesion no se mueve')
  // Clip que empieza a mitad de compas (beat 2 en 4/4): su beat 2 es el tiempo 1 del compas siguiente.
  const opts = { timingMs: 0, velocityRange: 0, lengthRatio: 0, swing: 0, accentStrength: 1, seed: 3, beatsPerBar: 4 }
  const mid = humanize([note(60, 0, 0.2, 80), note(62, 2, 0.2, 80)], null, { ...opts, clipStartBeat: 2 }, 4).notes
  assert.equal(mid.find((n) => n.pitch === 62)!.velocity, 80 + 14, 'clip beat 2 = tiempo fuerte de la sesion')
  assert.equal(mid.find((n) => n.pitch === 60)!.velocity, 80 + 7, 'clip beat 0 = medio compas de la sesion')
  // Contexto de clip: posicion, tempo, compas y bateria.
  assert.deepEqual(humanizeClipContext({ bpm: 90, beatsPerBar: 3 }, { clip: { startBeat: 6 }, track: { instrument: { type: 'drums' } as never } }), {
    clipStartBeat: 6,
    bpm: 90,
    beatsPerBar: 3,
    drumKit: true,
  })
})

check('swing idempotente: aplicarlo dos veces no lo suma', () => {
  const groove = [note(36, 0), note(42, 0.25), note(42, 0.5), note(42, 0.75), note(38, 1), note(42, 1.25)]
  const once = humanize(groove, null, { ...SWING_ONLY, swing: 0.3, swingGrid: '1/16' }, 4).notes
  const twice = humanize(once, null, { ...SWING_ONLY, swing: 0.3, swingGrid: '1/16' }, 4).notes
  assert.deepEqual(twice, once)
  // Y con otro swing, la nota va al nuevo sitio (no al viejo + nuevo).
  const changed = humanize(once, null, { ...SWING_ONLY, swing: 0.1, swingGrid: '1/16' }, 4).notes
  near(changed.find((n) => n.pitch === 42 && n.start > 0.2 && n.start < 0.4)!.start, 0.25 + 0.1 * 0.25, 1e-6)
  // swingTargetBeat: una nota par o fuera de la zona impar no tiene destino de swing.
  assert.equal(swingTargetBeat(0.5, 0.3, '1/16'), null)
  assert.equal(swingTargetBeat(0.3, 0, '1/16'), null)
})

check('micro-timing en ms: los mismos ms a 60 y a 120 BPM (la mitad de beats a 60)', () => {
  const notes = [note(60, 1), note(62, 2), note(64, 3)]
  const at120 = humanize(notes, null, { timingMs: 10, velocityRange: 0, lengthRatio: 0, seed: 77, bpm: 120 }, 8).notes
  const at60 = humanize(notes, null, { timingMs: 10, velocityRange: 0, lengthRatio: 0, seed: 77, bpm: 60 }, 8).notes
  for (let i = 0; i < notes.length; i++) {
    const d120 = at120[i].start - notes[i].start
    const d60 = at60[i].start - notes[i].start
    assert.ok(Math.abs(d120) <= 0.02 + 1e-9, `a 120 BPM 10 ms = 0.02 beats (${d120})`)
    near(d60, d120 / 2, 2e-6, 'mismo desvio en ms')
  }
  assert.equal(resolveHumanize({ preset: 'pocket', bpm: 60 }).timingMs, 11)
  near(resolveHumanize({ preset: 'pocket', bpm: 60 }).timingBeats, 0.011, 1e-12)
  // Compatibilidad del asistente: timing_beats sigue siendo absoluto en beats.
  const legacy = resolveHumanize({ timingBeats: 0.022, bpm: 120 })
  near(legacy.timingMs, 11, 1e-9)
  assert.equal(legacy.timingBeats, 0.022)
  near(resolveHumanize({ strumMs: 30, bpm: 120 }).strumBeats, 0.06, 1e-12)
})

check('intensidad: escala swing, strum y acento del preset (no solo el micro-timing)', () => {
  const full = resolveHumanize({ preset: 'strum' })
  const half = resolveHumanize({ preset: 'strum', amount: full.amount / 2 })
  near(half.swing, full.swing / 2, 1e-9, 'swing')
  near(half.strumMs, full.strumMs / 2, 1e-9, 'strum')
  near(half.accentStrength, full.accentStrength / 2, 1e-9, 'acento')
  near(half.timingMs, full.timingMs / 2, 1e-9, 'timing')
  // Un valor explicito es absoluto.
  assert.equal(resolveHumanize({ preset: 'strum', amount: 0.1, swing: 0.33 }).swing, 0.33)
})

check('bateria: bombo y caja mas ajustados que el hi-hat, caja laid back, acento de hi-hat en corcheas, sin strum', () => {
  const hits: StudioMidiNote[] = []
  for (let b = 0; b < 64; b += 0.5) {
    hits.push(note(36, b, 0.1, 90))
    hits.push(note(42, b + 0.25, 0.1, 90))
  }
  const res = humanize(hits, null, { drumKit: true, timingMs: 20, velocityRange: 20, lengthRatio: 0, accentStrength: 0, swing: 0, seed: 5, bpm: 120 }, 70).notes
  const spread = (pitch: number, key: 'velocity' | 'start') => {
    const own = res.filter((n) => n.pitch === pitch)
    const dev = own.map((n) => (key === 'velocity' ? n.velocity - 90 : n.start - Math.round(n.start * 4) / 4))
    return Math.sqrt(dev.reduce((a, d) => a + d * d, 0) / dev.length)
  }
  assert.ok(spread(42, 'velocity') > spread(36, 'velocity') * 1.8, `velocidad hi-hat ${spread(42, 'velocity')} vs bombo ${spread(36, 'velocity')}`)
  assert.ok(spread(42, 'start') > spread(36, 'start') * 1.5, `tiempo hi-hat ${spread(42, 'start')} vs bombo ${spread(36, 'start')}`)

  const kit = [note(36, 1, 0.1, 90), note(38, 1, 0.1, 90), note(42, 1, 0.1, 90)]
  const laid = humanize(kit, null, { drumKit: true, timingMs: 0, velocityRange: 0, lengthRatio: 0, accentStrength: 0, strumMs: 40, laidBackMs: 20, seed: 1, bpm: 120 }, 4).notes
  near(laid.find((n) => n.pitch === 38)!.start, 1 + 0.04, 1e-6, 'caja 20 ms atras a 120 BPM')
  assert.equal(laid.find((n) => n.pitch === 36)!.start, 1, 'sin strum en bateria')
  assert.equal(laid.find((n) => n.pitch === 42)!.start, 1, 'sin strum en bateria')

  const hats = [note(42, 0, 0.1, 80), note(42, 0.25, 0.1, 80), note(42, 0.5, 0.1, 80), note(42, 0.75, 0.1, 80)]
  const acc = humanize(hats, null, { drumKit: true, timingMs: 0, velocityRange: 0, lengthRatio: 0, accentStrength: 1, swing: 0, seed: 1 }, 4).notes
  assert.ok(acc[0].velocity > acc[2].velocity && acc[2].velocity > acc[1].velocity, `tiempo > corchea > semicorchea: ${acc.map((n) => n.velocity)}`)
  assert.equal(acc[1].velocity, acc[3].velocity)
})

console.log('\n2. Groove de la banda')

/** PRNG determinista para el ruido de los golpes sinteticos. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

check('plantilla desde audio con swing de semicorchea 0.33 conocido: recupera desplazamientos, swing y dinamica; al aplicarla las notas quedan donde deben', () => {
  const SR = 44100
  const bpm = 120
  const beatS = 60 / bpm
  const swing = 1 / 3
  const leadS = 0.25
  const bars = 4
  const samples = new Float32Array(Math.round((leadS + bars * 4 * beatS + 0.5) * SR))
  const rand = rng(9)
  // Golpes de hi-hat: ruido con caida de 25 ms; tiempo fuerte 1.0, corchea 0.7, semicorchea 0.4.
  for (let k = 0; k < bars * 16; k++) {
    const odd = k % 2 === 1
    const beat = k * 0.25 + (odd ? swing * 0.25 : 0)
    const amp = k % 4 === 0 ? 1 : k % 2 === 0 ? 0.7 : 0.4
    const at = Math.round((leadS + beat * beatS) * SR)
    for (let i = 0; i < Math.round(0.09 * SR) && at + i < samples.length; i++) {
      samples[at + i] += amp * (rand() * 2 - 1) * Math.exp(-i / (0.025 * SR))
    }
  }
  // El clip empieza en la sesion en 1.75 s: su golpe 0 (a 0.25 s del audio) cae en 2.0 s = beat 4.
  const template = grooveFromAudio(samples, SR, { clipStartS: 2 - leadS, bpm, beatsPerBar: 4, grid: '1/16', label: 'Batería', sourceClipId: 'clp_x' })
  assert.ok(template, 'hay plantilla')
  assert.equal(template.stepsPerBar, 16)
  assert.ok(template.onsets >= bars * 16 - 2, `golpes detectados ${template.onsets}`)
  assert.equal(template.bars, bars)
  const swingMs = swing * 0.25 * beatS * 1000 // 41.7 ms
  for (let s = 0; s < 16; s++) {
    near(template.offsetMs[s], s % 2 === 1 ? swingMs : 0, 3, `paso ${s}`)
  }
  near(template.swing, swing, 0.03, 'swing estimado')
  assert.ok(template.velocityScale[0] > template.velocityScale[2] && template.velocityScale[2] > template.velocityScale[1], `dinamica ${template.velocityScale.slice(0, 4)}`)

  // Aplicar a semicorcheas rectas de un clip en el beat 4: las impares quedan swingueadas.
  const straight = Array.from({ length: 16 }, (_, k) => note(42, k * 0.25, 0.1, 80))
  const applied = applyGrooveTemplate(straight, null, template, { strength: 1, velocityStrength: 1, clipStartBeat: 4, bpm }, 4)
  assert.equal(applied.selection.length, 16)
  applied.notes.forEach((n, k) => near(n.start, k * 0.25 + (k % 2 === 1 ? swing * 0.25 : 0), 0.008, `nota ${k}`))
  assert.ok(applied.notes[0].velocity > applied.notes[1].velocity, 'toma la dinamica del paso')
  // Intensidad 0.5: a mitad de camino.
  const halfway = applyGrooveTemplate(straight, null, template, { strength: 0.5, clipStartBeat: 4, bpm }, 4).notes
  near(halfway[1].start, 0.25 + (swing * 0.25) / 2, 0.005, 'mitad del groove')
  assert.equal(halfway[1].velocity, 80, 'sin velocityStrength no cambia la velocidad')
})

check('plantilla: pocos golpes no alcanzan; corcheas con plantilla 1/8 y notas lejos de los pasos no se mueven', () => {
  assert.equal(extractGrooveTemplate([{ beat: 0, strength: 1 }], { bpm: 120, beatsPerBar: 4 }), null)
  const onsets = Array.from({ length: 16 }, (_, k) => ({ beat: k * 0.5 + (k % 2 === 1 ? 0.1 : 0), strength: 1 }))
  const t = extractGrooveTemplate(onsets, { bpm: 120, beatsPerBar: 4, grid: '1/8' })!
  assert.equal(t.stepsPerBar, 8)
  near(t.offsetMs[1], 50, 1e-6, '0.1 beat a 120 BPM = 50 ms')
  // Una semicorchea (0.25) esta a medio paso de la plantilla de corcheas: no se toca.
  const res = applyGrooveTemplate([note(60, 0.25), note(60, 0.5)], null, t, { strength: 1, clipStartBeat: 0, bpm: 120 }, 4).notes
  assert.equal(res[0].start, 0.25)
  near(res[1].start, 0.6, 1e-6)
})

console.log('\n3. Deriva analogica determinista (en vivo = export)')

interface ParamEvent {
  kind: string
  value: number
  time: number
}

class FakeParam {
  value: number
  readonly minValue = -1e9
  readonly maxValue = 1e9
  readonly defaultValue: number
  readonly events: ParamEvent[] = []
  constructor(value = 0) {
    this.value = value
    this.defaultValue = value
  }
  setValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'set', value, time })
    return this
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'lin', value, time })
    return this
  }
  exponentialRampToValueAtTime(value: number, time: number) {
    this.events.push({ kind: 'exp', value, time })
    return this
  }
  setTargetAtTime(value: number, time: number) {
    this.events.push({ kind: 'target', value, time })
    return this
  }
  cancelScheduledValues() {
    return this
  }
}

class FakeNode {
  connect(dest: unknown) {
    return dest
  }
  disconnect() {}
}

class FakeSource extends FakeNode {
  startedAt = Number.NaN
  onended: (() => void) | null = null
  start(when = 0) {
    this.startedAt = when
  }
  stop() {}
}

class FakeOsc extends FakeSource {
  type = 'sine'
  readonly frequency = new FakeParam(440)
  readonly detune = new FakeParam(0)
}

class FakeCtx {
  readonly sampleRate = 48000
  currentTime: number
  readonly oscillators: FakeOsc[] = []
  readonly filters: Array<{ frequency: FakeParam; detune: FakeParam }> = []
  constructor(now: number) {
    this.currentTime = now
  }
  createGain() {
    return Object.assign(new FakeNode(), { gain: new FakeParam(1) })
  }
  createOscillator() {
    const osc = new FakeOsc()
    this.oscillators.push(osc)
    return osc
  }
  createBiquadFilter() {
    const f = Object.assign(new FakeNode(), { type: 'lowpass', frequency: new FakeParam(350), Q: new FakeParam(1), detune: new FakeParam(0), gain: new FakeParam(0) })
    this.filters.push(f)
    return f
  }
  createConstantSource() {
    return Object.assign(new FakeSource(), { offset: new FakeParam(1) })
  }
  createBufferSource() {
    return Object.assign(new FakeSource(), { buffer: null as unknown, loop: false, playbackRate: new FakeParam(1) })
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return { length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: (c: number) => data[c] }
  }
}

/** Huella de un oscilador relativa a su inicio: valor de detune y eventos (tiempo relativo redondeado). */
function oscPrint(osc: FakeOsc): string {
  const t0 = osc.startedAt
  const ev = osc.detune.events.map((e) => `${e.kind}:${e.value.toFixed(6)}@${(e.time - t0).toFixed(6)}`)
  return `${osc.type}|f=${osc.frequency.value.toFixed(6)}|d=${osc.detune.value.toFixed(6)}|${ev.join(',')}`
}

function synthSession(drift: number): { session: StudioSession; trackId: string } {
  const base = parseSession(structuredClone(sessionFixtureV2))
  const track = base.tracks.find((t) => t.kind === 'instrument' && t.instrument?.type === 'synth')!
  const instrument = track.instrument!
  if (instrument.type !== 'synth') throw new Error('se esperaba synth')
  const midiClip = { id: 'mid_drift', startBeat: 0, lengthBeats: 1, loop: false, loopBeats: 1, notes: [note(60, 0, 0.25, 100), note(64, 0.5, 0.25, 100)] }
  const tracks = base.tracks.map((t) =>
    t.id === track.id ? { ...t, frozenAssetId: null, instrument: { ...instrument, params: { ...instrument.params, analogDrift: drift } }, midiClips: [midiClip] } : t,
  )
  return { session: { ...base, tracks } as StudioSession, trackId: track.id }
}

function renderPrints(session: StudioSession, trackId: string, ctxNow: number, atCtxTime: number, fromS: number): string[] {
  const ctx = new FakeCtx(ctxNow)
  const track = session.tracks.find((t) => t.id === trackId)!
  const instrument = track.instrument!
  if (instrument.type !== 'synth') throw new Error('se esperaba synth')
  const poly = new PolyInstrument(ctx as unknown as BaseAudioContext, new SynthEngine(ctx as unknown as BaseAudioContext, instrument))
  const graph = { instruments: new Map([[trackId, poly]]) } as unknown as StudioGraph
  const batch = scheduleMidiClips(ctx as unknown as BaseAudioContext, graph, session, new Map(), { fromS, atCtxTime, trackIds: new Set([trackId]) })
  batch.dispose()
  return ctx.oscillators.map(oscPrint)
}

check('synth con analog_drift: la misma nota suena igual en vivo (contexto en 5 s) y en el bounce (contexto en 0)', () => {
  const { session, trackId } = synthSession(1)
  const live = renderPrints(session, trackId, 5, 5.1, 0)
  const bounce = renderPrints(session, trackId, 0, 0, 0)
  assert.ok(live.length >= 2, 'se programaron osciladores')
  assert.deepEqual(live, bounce)
  // Hay deriva de verdad: los osciladores tienen detune distinto del parametro y eventos de vagabundeo.
  assert.ok(live.some((p) => p.includes('lin:')), 'vagabundeo lento programado')
})

check('synth: la tolerancia por nota depende de la nota y de la pista, no de cuando empieza a sonar', () => {
  const instrumentOf = (s: StudioSession, id: string) => {
    const inst = s.tracks.find((t) => t.id === id)!.instrument!
    if (inst.type !== 'synth') throw new Error('synth')
    return inst
  }
  const { session, trackId } = synthSession(1)
  const play = (now: number, start: number, salt: number, seedS: number) => {
    const ctx = new FakeCtx(now)
    const poly = new PolyInstrument(ctx as unknown as BaseAudioContext, new SynthEngine(ctx as unknown as BaseAudioContext, instrumentOf(session, trackId)))
    poly.playNoteOwned(60, 100, start, start + 1, {}, { seedS, sessionS: seedS, salt })
    return ctx.oscillators.map(oscPrint)
  }
  const salt = trackDriftSalt(trackId)
  assert.deepEqual(play(0, 3, salt, 10), play(100, 117.5, salt, 10), 'misma posicion musical, otra hora de contexto')
  assert.notDeepEqual(play(0, 3, salt, 10), play(0, 3, salt, 11), 'otra posicion musical, otra tolerancia')
  assert.notDeepEqual(play(0, 3, salt, 10), play(0, 3, trackDriftSalt('trk_otra'), 10), 'otra pista, otra deriva')
})

check('drums con analog_drift: afinacion del golpe igual en vivo y en el export', () => {
  const base = parseSession(structuredClone(sessionFixtureV2))
  const track = base.tracks.find((t) => t.kind === 'instrument' && t.instrument?.type === 'drums')!
  const inst = track.instrument!
  if (inst.type !== 'drums') throw new Error('drums')
  const drifting = { ...inst, params: { ...inst.params, analogDrift: 1 } }
  const play = (now: number, start: number) => {
    const ctx = new FakeCtx(now)
    const poly = new PolyInstrument(ctx as unknown as BaseAudioContext, new DrumsEngine(ctx as unknown as BaseAudioContext, drifting))
    poly.playNoteOwned(36, 110, start, start + 0.1, {}, { seedS: 4.5, sessionS: 4.5, salt: trackDriftSalt(track.id) })
    return ctx.oscillators.map((o) => o.frequency.events.map((e) => `${e.kind}:${e.value.toFixed(6)}@${(e.time - start).toFixed(6)}`).join(','))
  }
  assert.deepEqual(play(0, 2), play(50, 61.25))
})

check('vagabundeo lento: continuo, acotado a [-1, 1], varia a lo largo de segundos y es determinista', () => {
  let min = Infinity
  let max = -Infinity
  let maxJump = 0
  let prev = analogWander(0, 7)
  for (let t = 0.01; t <= 120; t += 0.01) {
    const v = analogWander(t, 7)
    assert.ok(v >= -1 && v <= 1)
    maxJump = Math.max(maxJump, Math.abs(v - prev))
    prev = v
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  assert.ok(maxJump < 0.03, `sin saltos (max ${maxJump} en 10 ms)`)
  assert.ok(max - min > 0.8, `recorre el rango (${min}..${max})`)
  assert.equal(analogWander(12.34, 7), analogWander(12.34, 7))
  assert.notEqual(analogWander(12.34, 7), analogWander(12.34, 8))
})

console.log(`\n${passed} ok, ${failures.length} fallas`)
if (failures.length > 0) process.exit(1)
