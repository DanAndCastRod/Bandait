/**
 * Bufer de ruido blanco con semilla fija (core.NOISE_SEED), uno por contexto de audio. Lo usan el
 * synth (`noise_level`) y la caja de ritmos. Mismo contexto a la misma frecuencia = mismas
 * muestras: el ruido suena igual al escuchar y al exportar (STUDIO_V2.md 2.3, "Determinismo").
 */
import { NOISE_SECONDS, fillNoise } from './core.ts'

const cache = new WeakMap<BaseAudioContext, AudioBuffer>()

export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let buffer = cache.get(ctx)
  if (!buffer) {
    buffer = ctx.createBuffer(1, Math.max(1, Math.round(NOISE_SECONDS * ctx.sampleRate)), ctx.sampleRate)
    fillNoise(buffer.getChannelData(0))
    cache.set(ctx, buffer)
  }
  return buffer
}
