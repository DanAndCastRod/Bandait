/**
 * `synth`: sintetizador sustractivo (STUDIO_V2.md 2.3.1) con nodos nativos.
 *
 * Por voz:  osc1 + osc2 + ruido -> filtro -> envolvente de amplitud -> relajacion -> [tremolo] -> apagado
 *           envolvente del filtro (ConstantSource en cents) -> relajacion -> filter.detune
 *           LFO (fase 0 en cada nota) -> detune de los osciladores, detune del filtro o tremolo
 *
 * El corte se mueve por `detune` del filtro (cents): sumar cents es multiplicar hertz, que es lo
 * que pide la formula del contrato (`cutoff * 2^(env * octavas + lfo)`). Los parametros nuevos
 * valen para las notas siguientes; gain_db cambia en caliente (PolyInstrument.update).
 *
 * analog_drift (analogDrift.ts): tolerancia por nota (afinacion, corte, decaimiento) y vagabundeo
 * lento continuo de afinacion y corte, ambos con semilla en la posicion musical de la nota
 * (`voice.musical`), asi el export suena igual que la reproduccion.
 */
import { type StudioInstrument, type StudioSynthInstrument, type SynthParams } from '../session.ts'
import { FILTER_MAX_HZ, FILTER_MIN_HZ, adsrFromMs, biquadQ, envelopeSilentAfterS, envelopeTau, filterEnvelopeCents, noteFrequency, noiseOffsetS, velocityGain } from './core.ts'
import { noiseBuffer } from './noise.ts'
import { noteDriftBipolar, scheduleWander, type WanderLayer } from './analogDrift.ts'
import type { Voice, VoiceEngine } from './voices.ts'

/** Con lfo_depth 1: +/-100 cents de pitch, +/-2 octavas de filtro (STUDIO_V2.md 2.3.1). */
const LFO_PITCH_CENTS = 100
const LFO_FILTER_CENTS = 2400

/** analog_drift 1: tolerancia por nota de los osciladores (+/- cents). */
const DRIFT_OSC_CENTS = 9
/** analog_drift 1: tolerancia por nota del corte del filtro (+/- cents). */
const DRIFT_FILTER_CENTS = 110
/** analog_drift 1: vagabundeo lento de afinacion de la voz (+/- cents), comun a los dos osciladores en un 70 %. */
const WANDER_PITCH_CENTS = 6
/** analog_drift 1: vagabundeo lento del corte (+/- cents). */
const WANDER_FILTER_CENTS = 80
/** Voz en vivo sin fin conocido: cuanto se sigue la curva de vagabundeo. */
const LIVE_WANDER_S = 8

export class SynthEngine implements VoiceEngine {
  readonly type = 'synth' as const
  private readonly ctx: BaseAudioContext
  private params: SynthParams

  constructor(ctx: BaseAudioContext, instrument: StudioSynthInstrument) {
    this.ctx = ctx
    this.params = instrument.params
  }

  gainDb(): number {
    return this.params.gainDb
  }

  update(instrument: StudioInstrument): boolean {
    if (instrument.type !== 'synth') return false
    this.params = instrument.params
    return true
  }

  build(voice: Voice, start: number, end: number | null): boolean {
    const ctx = this.ctx
    const p = this.params
    if (!(p.osc1Level > 0) && !(p.osc2Level > 0) && !(p.noiseLevel > 0)) return false
    const drift = Math.max(0, Math.min(1, p.analogDrift ?? 0))
    // Semilla de la deriva: la posicion musical de la nota (igual en vivo y en el export); en
    // vivo, la hora del contexto. `wanderS` es el segundo de sesion (o de contexto) del inicio.
    const seedS = voice.musical ? voice.musical.seedS : start
    const wanderS = voice.musical ? voice.musical.sessionS : start
    const trackSalt = voice.musical ? voice.musical.salt : 0
    const nd = (salt: number) => noteDriftBipolar(voice.pitch, seedS, salt ^ trackSalt)
    const decayScale = drift > 0 ? 1 + nd(7) * drift * 0.12 : 1
    const amp = adsrFromMs(p.ampAttackMs, p.ampDecayMs * decayScale, p.ampSustain, p.ampReleaseMs)
    const fenv = adsrFromMs(p.filterAttackMs, p.filterDecayMs * decayScale, p.filterSustain, p.filterReleaseMs)
    const peak = velocityGain(voice.velocity, p.velocitySens)

    // --- filtro ---
    const filter = ctx.createBiquadFilter()
    filter.type = p.filterType
    const filterDriftRatio = drift > 0 ? Math.pow(2, (nd(3) * drift * DRIFT_FILTER_CENTS) / 1200) : 1
    const cutoff = Math.min(FILTER_MAX_HZ, Math.max(FILTER_MIN_HZ, p.filterCutoffHz * filterDriftRatio))
    filter.frequency.value = Math.min(cutoff, ctx.sampleRate / 2)
    filter.Q.value = biquadQ(p.filterType, p.filterResonance)
    voice.addNode(filter)
    // Duracion que recorre la curva de vagabundeo: la nota y su relajacion.
    const wanderDurS = (end === null ? LIVE_WANDER_S : Math.max(0, end - start)) + amp.releaseS * 4 + 0.1
    if (drift > 0) scheduleWander(filter.detune, 0, [[drift * WANDER_FILTER_CENTS, trackSalt ^ 0x3f]], start, wanderS, wanderDurS)

    // --- amplitud: envolvente (ataque, decaimiento, sustain) y relajacion en etapas separadas ---
    const ampEnv = ctx.createGain()
    ampEnv.gain.value = 0
    ampEnv.gain.setValueAtTime(0, start)
    ampEnv.gain.linearRampToValueAtTime(peak, start + amp.attackS)
    ampEnv.gain.setTargetAtTime(peak * amp.sustain, start + amp.attackS, envelopeTau(amp.decayS))
    const ampRelease = ctx.createGain()
    ampRelease.gain.value = 1
    filter.connect(ampEnv)
    ampEnv.connect(ampRelease)
    voice.addNode(ampEnv)
    voice.addNode(ampRelease)
    let tail: AudioNode = ampRelease

    // --- LFO ---
    const lfoOn = p.lfoTarget !== 'off' && p.lfoDepth > 0 && p.lfoRateHz > 0
    let lfoGain: GainNode | null = null
    if (lfoOn) {
      const lfo = ctx.createOscillator()
      lfo.type = p.lfoWave
      lfo.frequency.value = p.lfoRateHz
      lfoGain = ctx.createGain()
      lfo.connect(lfoGain)
      voice.addNode(lfoGain)
      if (p.lfoTarget === 'amp') {
        // Tremolo de profundidad d: la ganancia oscila entre 1 - d y 1 (con d = 1, entre 0 y 1).
        const tremolo = ctx.createGain()
        tremolo.gain.value = 1 - p.lfoDepth / 2
        lfoGain.gain.value = p.lfoDepth / 2
        lfoGain.connect(tremolo.gain)
        tail.connect(tremolo)
        tail = tremolo
        voice.addNode(tremolo)
      } else if (p.lfoTarget === 'filter') {
        lfoGain.gain.value = p.lfoDepth * LFO_FILTER_CENTS
        lfoGain.connect(filter.detune)
      } else {
        lfoGain.gain.value = p.lfoDepth * LFO_PITCH_CENTS
      }
      lfo.start(start)
      voice.addSource(lfo)
    }
    tail.connect(voice.killGain)

    // --- osciladores y ruido ---
    const oscillators: Array<[SynthParams['osc1Wave'], number, number, number, number]> = [
      [p.osc1Wave, p.osc1Octave, p.osc1DetuneCents, p.osc1Level, 11],
      [p.osc2Wave, p.osc2Octave, p.osc2DetuneCents, p.osc2Level, 29],
    ]
    for (const [wave, octave, detune, level, salt] of oscillators) {
      if (!(level > 0)) continue
      const osc = ctx.createOscillator()
      osc.type = wave
      osc.frequency.value = noteFrequency(voice.pitch) * Math.pow(2, octave)
      const driftCents = drift > 0 ? nd(salt) * drift * DRIFT_OSC_CENTS : 0
      osc.detune.value = detune + driftCents
      if (drift > 0) {
        // Vagabundeo lento: 70 % comun a la voz (la "temperatura" del sinte) y 30 % propio del oscilador.
        const layers: WanderLayer[] = [
          [drift * WANDER_PITCH_CENTS * 0.7, trackSalt],
          [drift * WANDER_PITCH_CENTS * 0.3, trackSalt ^ (salt * 0x9e37)],
        ]
        scheduleWander(osc.detune, detune + driftCents, layers, start, wanderS, wanderDurS)
      }
      if (lfoGain && p.lfoTarget === 'pitch') lfoGain.connect(osc.detune)
      const gain = ctx.createGain()
      gain.gain.value = level
      osc.connect(gain)
      gain.connect(filter)
      voice.addNode(gain)
      osc.start(start)
      voice.addSource(osc)
    }
    if (p.noiseLevel > 0) {
      const noise = ctx.createBufferSource()
      noise.buffer = noiseBuffer(ctx)
      noise.loop = true
      const gain = ctx.createGain()
      gain.gain.value = p.noiseLevel
      noise.connect(gain)
      gain.connect(filter)
      voice.addNode(gain)
      noise.start(start, noiseOffsetS(voice.pitch))
      voice.addSource(noise)
    }

    // --- envolvente del filtro, en cents sobre filter.detune ---
    let filterRelease: GainNode | null = null
    const envCents = filterEnvelopeCents(cutoff, p.filterEnvOctaves)
    if (envCents !== 0 && typeof ctx.createConstantSource === 'function') {
      const env = ctx.createConstantSource()
      env.offset.value = 0
      env.offset.setValueAtTime(0, start)
      env.offset.linearRampToValueAtTime(envCents, start + fenv.attackS)
      env.offset.setTargetAtTime(envCents * fenv.sustain, start + fenv.attackS, envelopeTau(fenv.decayS))
      filterRelease = ctx.createGain()
      filterRelease.gain.value = 1
      env.connect(filterRelease)
      filterRelease.connect(filter.detune)
      voice.addNode(filterRelease)
      env.start(start)
      voice.addSource(env)
    }

    voice.onRelease = (when) => {
      ampRelease.gain.setTargetAtTime(0, when, envelopeTau(amp.releaseS))
      filterRelease?.gain.setTargetAtTime(0, when, envelopeTau(fenv.releaseS))
      return start + envelopeSilentAfterS(amp, when - start)
    }
    // Sustain 0: la voz queda en silencio al terminar el decaimiento, aunque la nota siga.
    const silent = envelopeSilentAfterS(amp, null)
    if (Number.isFinite(silent) && end === null) voice.kill(start + silent)
    return true
  }
}
