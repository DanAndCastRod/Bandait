/**
 * AudioWorkletProcessor del limitador del master. Corre en el AudioWorkletGlobalScope, no en la
 * pagina: Vite lo compila como archivo aparte (ver limiterModule.ts). Toda la matematica esta en
 * limiterCore.ts; aqui solo se leen los parametros y se pasan los bloques.
 *
 * Parametros (k-rate): ceilingDb, releaseMs, bypass (>= 0.5 = sin limitar, con el mismo retardo).
 * Un mensaje 'dispose' por el puerto termina el procesador.
 */
import { LIMITER_PROCESSOR_NAME, LookaheadLimiter, limiterLookaheadFrames, limiterReleaseCoef } from './limiterCore.ts'

// Globales del AudioWorkletGlobalScope: no estan en la libreria DOM de TypeScript.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

/** Igual que STUDIO_LIMITER_LOOKAHEAD_MS de session.ts (no se importa para no arrastrar ese modulo al worklet). */
const LOOKAHEAD_MS = 5
const CHANNELS = 2

class StudioLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceilingDb', defaultValue: -1, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 100, minValue: 1, maxValue: 5000, automationRate: 'k-rate' },
      { name: 'bypass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ]
  }

  private readonly limiter = new LookaheadLimiter(CHANNELS, limiterLookaheadFrames(sampleRate, LOOKAHEAD_MS))
  private alive = true
  private releaseMs = -1
  private releaseCoef = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === 'dispose') this.alive = false
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    if (!this.alive) return false
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const releaseMs = parameters.releaseMs[0]
    if (releaseMs !== this.releaseMs) {
      this.releaseMs = releaseMs
      this.releaseCoef = limiterReleaseCoef(releaseMs, sampleRate)
    }
    const ceiling = Math.pow(10, parameters.ceilingDb[0] / 20)
    // Sin entrada conectada `inputs[0]` llega vacio: el nucleo lo trata como silencio y vacia el retardo.
    this.limiter.process(inputs[0] ?? [], output, output[0].length, ceiling, this.releaseCoef, parameters.bypass[0] >= 0.5)
    return true
  }
}

registerProcessor(LIMITER_PROCESSOR_NAME, StudioLimiterProcessor)
