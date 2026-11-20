/**
 * `sampler`: zonas con audios de la sesion (STUDIO_V2.md 2.3.3). Una nota suena en todas las
 * zonas que la contienen (capas), cada una con su AudioBufferSourceNode leyendo su ventana a
 * 2^((pitch - root) / 12 + tune / 1200). El sonido termina al acabar la ventana aunque la nota
 * siga (con una rampa de 5 ms para no hacer clic). `sustain`: el note-off inicia la relajacion;
 * `one_shot`: el note-off se ignora y la relajacion cae al final de la ventana.
 *
 * Los audios se buscan en `buffers` al tocar cada nota: el motor pasa su mapa vivo, asi un audio
 * que se resuelve despues ya suena en las notas siguientes. Un audio que falta deja muda su zona.
 */
import { STUDIO_VOICE_STEAL_RAMP_S, type SamplerParams, type StudioInstrument, type StudioSamplerInstrument, type StudioSamplerZone } from '../session.ts'
import type { StudioBuffers } from '../types.ts'
import { dbToGain } from '../../stemTiming.ts'
import { adsrFromMs, envelopeTau, ENVELOPE_TAIL_FACTOR, samplerPlaybackRate, samplerZonesFor, velocityGain } from './core.ts'
import type { Voice, VoiceEngine } from './voices.ts'

export class SamplerEngine implements VoiceEngine {
  readonly type = 'sampler' as const
  private readonly ctx: BaseAudioContext
  private readonly buffers: StudioBuffers
  private params: SamplerParams
  private zones: readonly StudioSamplerZone[]

  constructor(ctx: BaseAudioContext, instrument: StudioSamplerInstrument, buffers: StudioBuffers) {
    this.ctx = ctx
    this.buffers = buffers
    this.params = instrument.params
    this.zones = instrument.zones
  }

  gainDb(): number {
    return this.params.gainDb
  }

  update(instrument: StudioInstrument): boolean {
    if (instrument.type !== 'sampler') return false
    this.params = instrument.params
    this.zones = instrument.zones
    return true
  }

  build(voice: Voice, start: number): boolean {
    const ctx = this.ctx
    const p = this.params
    const layers: Array<{ zone: StudioSamplerZone; buffer: AudioBuffer; rate: number }> = []
    for (const zone of samplerZonesFor(this.zones, voice.pitch, voice.velocity)) {
      const buffer = this.buffers.get(zone.assetId)
      const rate = samplerPlaybackRate(zone, voice.pitch)
      if (buffer && zone.offsetS < buffer.duration && rate > 0 && Number.isFinite(rate)) layers.push({ zone, buffer, rate })
    }
    if (layers.length === 0) return false
    const amp = adsrFromMs(p.ampAttackMs, p.ampDecayMs, p.ampSustain, p.ampReleaseMs)
    const peak = velocityGain(voice.velocity, p.velocitySens)

    const env = ctx.createGain()
    env.gain.value = 0
    env.gain.setValueAtTime(0, start)
    env.gain.linearRampToValueAtTime(peak, start + amp.attackS)
    env.gain.setTargetAtTime(peak * amp.sustain, start + amp.attackS, envelopeTau(amp.decayS))
    const release = ctx.createGain()
    release.gain.value = 1
    env.connect(release)
    release.connect(voice.killGain)
    voice.addNode(env)
    voice.addNode(release)

    let windowEnd = start
    for (const { zone, buffer, rate } of layers) {
      const contentS = Math.min(zone.lengthS, buffer.duration - zone.offsetS)
      const realS = contentS / rate
      const end = start + realS
      windowEnd = Math.max(windowEnd, end)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.playbackRate.value = rate
      const gain = ctx.createGain()
      const level = dbToGain(zone.gainDb)
      gain.gain.value = level
      // Rampa al final de la ventana: cortar una muestra a la mitad hace clic.
      const ramp = Math.min(STUDIO_VOICE_STEAL_RAMP_S, realS / 2)
      gain.gain.setValueAtTime(level, end - ramp)
      gain.gain.linearRampToValueAtTime(0, end)
      source.connect(gain)
      gain.connect(env)
      voice.addNode(gain)
      // `duration` de start() va en segundos del audio (contenido), no del reloj.
      source.start(start, zone.offsetS, contentS)
      voice.addSource(source)
    }

    const tau = envelopeTau(amp.releaseS)
    if (p.mode === 'one_shot') {
      const releaseAt = Math.max(start, windowEnd - amp.releaseS)
      release.gain.setTargetAtTime(0, releaseAt, tau)
      voice.onRelease = () => windowEnd
    } else {
      voice.onRelease = (when) => {
        const at = Math.min(when, windowEnd)
        release.gain.setTargetAtTime(0, at, tau)
        return Math.min(windowEnd, at + amp.releaseS * ENVELOPE_TAIL_FACTOR)
      }
    }
    voice.kill(windowEnd)
    return true
  }
}
