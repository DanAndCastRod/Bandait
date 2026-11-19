/**
 * Nucleo del limitador con anticipacion del master del Estudio. Modulo puro (sin DOM): lo usa el
 * AudioWorkletProcessor de limiter.worklet.ts y se prueba con node --experimental-strip-types.
 *
 * Algoritmo, por muestra:
 *   1. ganancia pedida = techo / pico (pico = mayor valor absoluto entre canales), tope 1;
 *   2. relajacion exponencial hacia 1 (la envolvente nunca supera la ganancia pedida);
 *   3. minimo deslizante de las ultimas L + 1 envolventes (L = anticipacion en muestras);
 *   4. promedio de los ultimos L minimos: suaviza el ataque sin romper la garantia;
 *   5. la salida es la entrada retrasada L muestras por esa ganancia.
 * Garantia: cada ventana del paso 3 que entra al promedio contiene la muestra que sale, asi que
 * la ganancia aplicada nunca supera techo / pico de esa muestra: el pico de MUESTRA de la salida
 * no pasa el techo. No es un limitador de pico real (entre muestras puede haber sobrepaso).
 *
 * Nada de esto asigna memoria despues del constructor: es seguro en el hilo de audio.
 */

/** Nombre con el que se registra el procesador en el AudioWorkletGlobalScope. */
export const LIMITER_PROCESSOR_NAME = 'bandait-studio-limiter'

/** Anticipacion en muestras para una frecuencia (STUDIO_LIMITER_LOOKAHEAD_MS = 5 ms). */
export function limiterLookaheadFrames(sampleRate: number, lookaheadMs: number): number {
  return Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate))
}

/** Coeficiente de relajacion por muestra: fraccion del camino hacia 1 que recupera cada muestra. */
export function limiterReleaseCoef(releaseMs: number, sampleRate: number): number {
  const seconds = Math.max(0.001, releaseMs / 1000)
  return 1 - Math.exp(-1 / (seconds * sampleRate))
}

export class LookaheadLimiter {
  readonly lookaheadFrames: number
  private readonly channels: number
  private readonly delay: Float32Array[]
  private delayPos = 0
  /** Cola monotona del minimo deslizante (anillo): valores e indices absolutos. */
  private readonly dequeValue: Float64Array
  private readonly dequeIndex: Float64Array
  private readonly dequeCap: number
  private dequeHead = 0
  private dequeSize = 0
  /** Anillo del promedio movil de los minimos. */
  private readonly box: Float64Array
  private boxPos = 0
  private boxSum: number
  private envelope = 1
  private counter = 0

  constructor(channels: number, lookaheadFrames: number) {
    const frames = Math.max(1, Math.floor(lookaheadFrames))
    this.lookaheadFrames = frames
    this.channels = Math.max(1, Math.floor(channels))
    this.delay = []
    for (let c = 0; c < this.channels; c++) this.delay.push(new Float32Array(frames))
    this.dequeCap = frames + 2
    this.dequeValue = new Float64Array(this.dequeCap)
    this.dequeIndex = new Float64Array(this.dequeCap)
    this.box = new Float64Array(frames).fill(1)
    this.boxSum = frames
  }

  /**
   * Procesa `frames` muestras. `input` puede traer menos canales que el limitador (los que
   * faltan son silencio); `output` debe traer al menos los del limitador. `ceiling` es lineal.
   * Con `bypass` la senal pasa con ganancia 1 pero conserva el retardo, para que activar y
   * desactivar no mueva la mezcla en el tiempo.
   */
  process(input: readonly Float32Array[], output: readonly Float32Array[], frames: number, ceiling: number, releaseCoef: number, bypass: boolean): void {
    const L = this.lookaheadFrames
    const window = L + 1
    const cap = this.dequeCap
    const values = this.dequeValue
    const indexes = this.dequeIndex
    const box = this.box
    const channels = this.channels
    const limit = ceiling > 0 ? ceiling : 0
    for (let n = 0; n < frames; n++) {
      let peak = 0
      for (let c = 0; c < channels; c++) {
        const source = input[c]
        const v = source ? source[n] : 0
        const a = v < 0 ? -v : v
        // Un NaN no supera ninguna comparacion: se trata como silencio mas abajo.
        if (a > peak) peak = a
      }
      const wanted = bypass || peak <= limit ? 1 : limit / peak
      const released = this.envelope + (1 - this.envelope) * releaseCoef
      const env = wanted < released ? wanted : released
      this.envelope = env

      // Minimo deslizante: se descartan por detras los valores que ya no pueden ser el minimo.
      while (this.dequeSize > 0) {
        const back = (this.dequeHead + this.dequeSize - 1) % cap
        if (values[back] >= env) this.dequeSize--
        else break
      }
      const tail = (this.dequeHead + this.dequeSize) % cap
      values[tail] = env
      indexes[tail] = this.counter
      this.dequeSize++
      if (indexes[this.dequeHead] <= this.counter - window) {
        this.dequeHead = (this.dequeHead + 1) % cap
        this.dequeSize--
      }
      const minimum = values[this.dequeHead]

      // Promedio movil; la suma se recalcula una vez por vuelta para que no acumule error.
      this.boxSum += minimum - box[this.boxPos]
      box[this.boxPos] = minimum
      this.boxPos++
      if (this.boxPos === L) {
        this.boxPos = 0
        let exact = 0
        for (let i = 0; i < L; i++) exact += box[i]
        this.boxSum = exact
      }
      let gain = this.boxSum / L
      if (gain > 1) gain = 1

      const pos = this.delayPos
      for (let c = 0; c < channels; c++) {
        const line = this.delay[c]
        const out = output[c]
        const source = input[c]
        const fresh = source ? source[n] : 0
        if (out) out[n] = line[pos] * gain
        line[pos] = fresh === fresh ? fresh : 0
      }
      this.delayPos = pos + 1 === L ? 0 : pos + 1
      this.counter++
    }
  }
}
