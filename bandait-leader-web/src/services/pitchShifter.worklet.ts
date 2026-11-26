/**
 * AudioWorkletProcessor del cambio de tono del reproductor de stems (GranularPitchShifter). Corre
 * en el AudioWorkletGlobalScope, no en la pagina: Vite lo compila como archivo aparte (ver
 * pitchShifterModule.ts). Toda la matematica esta en pitchShifterCore.ts; aqui solo se leen los
 * parametros y se pasan los bloques. Mismo patron que services/studio/limiter.worklet.ts.
 *
 * Parametros (k-rate, automatizables en el reloj del AudioContext):
 *   speed     velocidad de las fuentes (su playbackRate); el procesador compensa su efecto en el tono.
 *   semitones tono pedido (+-6).
 * Mensajes por el puerto: 'flush' (desvanece y vacia la linea de retardo), 'dispose' (termina).
 */
import { GranularPitchShifter, PITCH_SHIFTER_PROCESSOR_NAME, SHIFTER_SEMITONES_MAX, SHIFTER_SPEED_MAX, SHIFTER_SPEED_MIN } from './pitchShifterCore.ts'

// Globales del AudioWorkletGlobalScope: no estan en la libreria DOM de TypeScript.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

const CHANNELS = 2

class GranularPitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'speed', defaultValue: 1, minValue: SHIFTER_SPEED_MIN, maxValue: SHIFTER_SPEED_MAX, automationRate: 'k-rate' },
      { name: 'semitones', defaultValue: 0, minValue: -SHIFTER_SEMITONES_MAX, maxValue: SHIFTER_SEMITONES_MAX, automationRate: 'k-rate' },
    ]
  }

  private readonly shifter = new GranularPitchShifter(sampleRate, { channels: CHANNELS })
  private alive = true
  private speed = 1
  private semitones = 0
  private ratio = 1

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === 'dispose') this.alive = false
      else if (event.data === 'flush') this.shifter.flush()
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    if (!this.alive) return false
    const output = outputs[0]
    if (!output || output.length === 0) return true
    const speed = parameters.speed[0]
    const semitones = parameters.semitones[0]
    // Math.pow solo cuando cambia un parametro: nada se asigna en el hilo de audio.
    if (speed !== this.speed || semitones !== this.semitones) {
      this.speed = speed
      this.semitones = semitones
      this.ratio = Math.pow(2, semitones / 12) / (speed > 0 ? speed : 1)
    }
    // Sin entrada conectada `inputs[0]` llega vacio: el nucleo lo trata como silencio.
    this.shifter.process(inputs[0] ?? [], output, output[0].length, this.ratio)
    return true
  }
}

registerProcessor(PITCH_SHIFTER_PROCESSOR_NAME, GranularPitchShifterProcessor)
