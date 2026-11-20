/**
 * `drums`: caja de ritmos sintetizada (STUDIO_V2.md 2.3.2) con nodos nativos. Nueve voces de
 * disparo unico mapeadas a General MIDI percusion; la duracion de la nota no corta el golpe.
 * Un golpe reinicia su misma voz y el hi-hat cerrado corta al abierto (core.drumChokes). El
 * ruido sale del bufer con semilla (noise.ts), leido desde un punto fijo por voz.
 */
import { STUDIO_DRUM_VOICES, drumVoiceForPitch, type DrumsParams, type StudioDrumsInstrument, type StudioInstrument } from '../session.ts'
import { DRUM_ATTACK_S, DRUM_VOICE_SPECS, biquadQ, drumChokes, drumDecayS, drumHitGain, drumHitSeconds, drumTuneRatio, noiseOffsetS } from './core.ts'
import { noiseBuffer } from './noise.ts'
import type { Voice, VoiceEngine } from './voices.ts'

/** ln(1000): la caida de referencia es el tiempo hasta -60 dB. */
const LN_1000 = Math.log(1000)
/** Caida de cada rafaga de las palmas antes de la siguiente. */
const BURST_TAU_S = 0.003

export class DrumsEngine implements VoiceEngine {
  readonly type = 'drums' as const
  private readonly ctx: BaseAudioContext
  private params: DrumsParams

  constructor(ctx: BaseAudioContext, instrument: StudioDrumsInstrument) {
    this.ctx = ctx
    this.params = instrument.params
  }

  gainDb(): number {
    return this.params.gainDb
  }

  update(instrument: StudioInstrument): boolean {
    if (instrument.type !== 'drums') return false
    this.params = instrument.params
    return true
  }

  chokes(pitch: number, otherPitch: number): boolean {
    return drumChokes(pitch, otherPitch)
  }

  build(voice: Voice, start: number): boolean {
    const ctx = this.ctx
    const p = this.params
    const drum = drumVoiceForPitch(voice.pitch)
    if (!drum) return false
    const gain = drumHitGain(p, drum, voice.velocity)
    if (!(gain > 0)) return false
    const spec = DRUM_VOICE_SPECS[drum]
    const decay = drumDecayS(p, drum)
    const tune = drumTuneRatio(p, drum)
    const nyquist = ctx.sampleRate / 2

    const env = ctx.createGain()
    env.gain.value = 0
    for (let i = 0; i < spec.bursts; i++) {
      const at = start + i * spec.burstGapS
      const last = i === spec.bursts - 1
      env.gain.setValueAtTime(0, at)
      env.gain.linearRampToValueAtTime(gain, at + DRUM_ATTACK_S)
      env.gain.setTargetAtTime(0, at + DRUM_ATTACK_S, last ? decay / LN_1000 : BURST_TAU_S)
    }
    env.connect(voice.killGain)
    voice.addNode(env)

    if (spec.tone) {
      const osc = ctx.createOscillator()
      osc.type = spec.tone.wave
      const from = Math.min(spec.tone.startHz * tune, nyquist)
      const to = Math.min(spec.tone.endHz * tune, nyquist)
      osc.frequency.setValueAtTime(from, start)
      if (spec.tone.glideS > 0 && to !== from) osc.frequency.exponentialRampToValueAtTime(to, start + spec.tone.glideS)
      const level = ctx.createGain()
      level.gain.value = spec.tone.level
      osc.connect(level)
      level.connect(env)
      voice.addNode(level)
      osc.start(start)
      voice.addSource(osc)
    }
    if (spec.noise) {
      const noise = ctx.createBufferSource()
      noise.buffer = noiseBuffer(ctx)
      noise.loop = true
      const filter = ctx.createBiquadFilter()
      filter.type = spec.noise.filter
      filter.frequency.value = Math.min(spec.noise.hz * tune, nyquist * 0.95)
      filter.Q.value = spec.noise.filter === 'bandpass' ? biquadQ('bandpass', spec.noise.q) : biquadQ('highpass', spec.noise.q)
      const level = ctx.createGain()
      level.gain.value = spec.noise.level
      noise.connect(filter)
      filter.connect(level)
      level.connect(env)
      voice.addNode(filter)
      voice.addNode(level)
      // Semilla fija por voz: el mismo golpe suena igual al escuchar y al exportar.
      noise.start(start, noiseOffsetS(1000 + STUDIO_DRUM_VOICES.indexOf(drum)))
      voice.addSource(noise)
    }

    const naturalEnd = start + drumHitSeconds(p, drum)
    // Disparo unico: el note-off no corta; el golpe se apaga al terminar su caida.
    voice.onRelease = () => naturalEnd
    voice.kill(naturalEnd)
    return true
  }
}
