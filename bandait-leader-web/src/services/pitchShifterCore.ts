/**
 * Nucleo del cambio de tono granular con alineacion WSOLA (GranularPitchShifter). Modulo puro
 * (sin DOM): lo usa el AudioWorkletProcessor de pitchShifter.worklet.ts y se prueba con
 * node --experimental-strip-types (scripts/verify-stem-practice.ts).
 *
 * Como se logran velocidad y tono independientes en el reproductor de stems:
 *   1. VELOCIDAD: cada AudioBufferSourceNode suena con playbackRate = velocidad. Eso cambia el
 *      tiempo Y el tono a la vez (como una cinta), pero deja todas las pistas alineadas a la
 *      muestra: arrancan con el mismo `when` y avanzan al mismo ritmo.
 *   2. TONO: este procesador, UNO solo y estereo sobre el master, corrige el tono por
 *      ratio = 2^(semitonos / 12) / velocidad. A 0,5x el ratio es 2 (sube la octava que bajo la
 *      cinta); con +6 st a 0,5x llega a 2,83. Como todas las pistas pasan por el mismo nodo, la
 *      latencia es la misma para todas y no se desalinean.
 *
 * Algoritmo (por que este y no otro):
 *   - Granos de ~40 ms con ventana de Hann periodica al 50 % de solape: dos granos activos por
 *     muestra y w(j) + w(j + H) = 1, asi que con ratio 1 la salida es la entrada retrasada, exacta.
 *   - Cada grano lee la entrada remuestreada a `ratio` (interpolacion Hermite de 4 puntos).
 *   - WSOLA: el inicio de cada grano nuevo se busca en +-8 ms alrededor de su posicion nominal,
 *     eligiendo el desplazamiento que mejor continua la forma de onda del grano anterior
 *     (correlacion cruzada normalizada sobre la suma mono L+R). Eso evita las cancelaciones de
 *     fase del granular ingenuo (el "flanger"/"robot" en voz) y mantiene el periodo en notas
 *     sostenidas. La misma posicion se usa en ambos canales: la imagen estereo no se corre.
 *   - La posicion nominal de cada grano se ancla al reloj de entrada (entrada - D): el error
 *     nunca pasa de +-8 ms y no se acumula deriva. La latencia D es fija.
 *   - En bateria, granos de 40 ms reparten un poco los transitorios al estirar mucho (0,5x): es
 *     el limite conocido del dominio del tiempo. Un vocoder de fase suena peor en voz (fase
 *     "lavada") y cuesta mucho mas; WSOLA es el compromiso usual para practicar.
 *
 * Los parametros (ratio) se guardan por muestra de ENTRADA: cada grano usa el ratio que tenia la
 * entrada en su posicion de lectura. Asi un cambio de velocidad programado en el AudioContext a la
 * vez que el playbackRate de las fuentes se corrige justo donde ocurre en el audio, no D antes.
 *
 * Nada de esto asigna memoria despues del constructor: es seguro en el hilo de audio.
 */

/** Nombre con el que se registra el procesador en el AudioWorkletGlobalScope. */
export const PITCH_SHIFTER_PROCESSOR_NAME = 'bandait-granular-pitch-shifter'

/** Rango de practica: 0,50x a 1,25x y +-6 semitonos (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 5). */
export const SHIFTER_SPEED_MIN = 0.5
export const SHIFTER_SPEED_MAX = 1.25
export const SHIFTER_SEMITONES_MAX = 6

/** Ratio de lectura de los granos para una velocidad y un tono. */
export function shiftRatio(speed: number, semitones: number): number {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1
  const st = Number.isFinite(semitones) ? semitones : 0
  return Math.pow(2, st / 12) / s
}

/** Ratio maximo y minimo del rango de practica (2,83 y 0,56). */
export const SHIFTER_MAX_RATIO = shiftRatio(SHIFTER_SPEED_MIN, SHIFTER_SEMITONES_MAX)
export const SHIFTER_MIN_RATIO = shiftRatio(SHIFTER_SPEED_MAX, -SHIFTER_SEMITONES_MAX)

export interface ShifterOptions {
  channels?: number
  /** Duracion del grano en ms (por defecto 40). */
  grainMs?: number
  /** Radio de busqueda WSOLA en ms (por defecto 8). 0 = granular sin alineacion. */
  searchMs?: number
  /** Ratio maximo que se va a pedir; fija la latencia. */
  maxRatio?: number
  minRatio?: number
}

interface Geometry {
  grain: number
  hop: number
  search: number
  corr: number
  latency: number
  ring: number
}

function geometry(sampleRate: number, options: ShifterOptions): Geometry {
  const grainMs = options.grainMs ?? 40
  const searchMs = options.searchMs ?? 8
  const maxRatio = Math.max(1, options.maxRatio ?? SHIFTER_MAX_RATIO)
  // Grano par (el solape es la mitad exacta).
  const grain = Math.max(64, 2 * Math.round((grainMs / 1000) * sampleRate * 0.5))
  const hop = grain / 2
  const search = Math.max(0, Math.round((searchMs / 1000) * sampleRate))
  const corr = Math.max(16, Math.min(hop, Math.round(0.012 * sampleRate)))
  // Latencia: el grano que mas rapido lee (maxRatio) no debe alcanzar la muestra recien escrita
  // (Hermite mira 2 muestras adelante), y la continuacion natural del grano anterior tiene que
  // estar escrita entera para la correlacion.
  const latency = Math.ceil(Math.max(search + grain * (maxRatio - 1) + 4, search + hop * (maxRatio - 1) + corr + 4, search + 4))
  let ring = 1
  while (ring < 2 * (latency + hop + search + grain + 8)) ring *= 2
  return { grain, hop, search, corr, latency, ring }
}

/** Latencia fija del procesador, en muestras (la misma que usa el reproductor para la posicion). */
export function pitchShifterLatencyFrames(sampleRate: number, options: ShifterOptions = {}): number {
  return geometry(sampleRate, options).latency
}

export class GranularPitchShifter {
  readonly sampleRate: number
  readonly channels: number
  readonly grainFrames: number
  readonly hopFrames: number
  readonly searchFrames: number
  readonly latencyFrames: number
  /** Lecturas que habrian pasado la ultima muestra escrita (debe quedar en 0; lo miran las pruebas). */
  overreads = 0
  private readonly corrFrames: number
  private readonly minRatio: number
  private readonly maxRatio: number
  private readonly mask: number
  private readonly rings: Float32Array[]
  private readonly mono: Float32Array
  private readonly ratios: Float32Array
  private readonly window: Float32Array
  /** Indice absoluto de la proxima muestra a escribir. */
  private written = 0
  /** Muestras de salida desde el inicio del grano mas nuevo (A). */
  private phase = 0
  private aPos = 0
  private aRatio = 1
  private aLive = false
  private bPos = 0
  private bRatio = 1
  private bLive = false
  private fadeLen: number
  private fadeLeft = 0

  constructor(sampleRate: number, options: ShifterOptions = {}) {
    this.sampleRate = sampleRate
    this.channels = Math.max(1, options.channels ?? 2)
    const g = geometry(sampleRate, options)
    this.grainFrames = g.grain
    this.hopFrames = g.hop
    this.searchFrames = g.search
    this.corrFrames = g.corr
    this.latencyFrames = g.latency
    this.maxRatio = Math.max(1, options.maxRatio ?? SHIFTER_MAX_RATIO)
    this.minRatio = Math.min(1, Math.max(0.05, options.minRatio ?? SHIFTER_MIN_RATIO))
    this.mask = g.ring - 1
    this.rings = []
    for (let c = 0; c < this.channels; c++) this.rings.push(new Float32Array(g.ring))
    this.mono = new Float32Array(g.ring)
    this.ratios = new Float32Array(g.ring).fill(1)
    this.window = new Float32Array(g.grain)
    for (let j = 0; j < g.grain; j++) this.window[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / g.grain)
    this.fadeLen = Math.max(1, Math.round(0.005 * sampleRate))
    // El primer grano arranca en el primer process().
    this.phase = this.hopFrames
  }

  /**
   * Vacia el procesador tras un desvanecido de 5 ms (pausa, salto, stop): sin el, el audio viejo
   * que queda en la linea de retardo sonaria D despues de parar.
   */
  flush(): void {
    if (this.fadeLeft === 0) this.fadeLeft = this.fadeLen
  }

  /** Vacia el procesador ya, sin desvanecido. */
  reset(): void {
    for (const r of this.rings) r.fill(0)
    this.mono.fill(0)
    this.ratios.fill(1)
    this.aLive = false
    this.bLive = false
    this.phase = this.hopFrames
    this.fadeLeft = 0
  }

  /**
   * Procesa `frames` muestras. `input` puede traer 0 canales (silencio), 1 (se duplica) o mas.
   * `ratio` es el de este bloque (k-rate); se acota al rango con el que se calculo la latencia.
   */
  process(input: ArrayLike<Float32Array>, output: Float32Array[], frames: number, ratio: number): void {
    const r = ratio > this.maxRatio ? this.maxRatio : ratio < this.minRatio ? this.minRatio : Number.isFinite(ratio) ? ratio : 1
    const mask = this.mask
    const channels = this.channels
    const inCount = input.length
    const outCount = output.length
    const hop = this.hopFrames
    const win = this.window
    for (let i = 0; i < frames; i++) {
      // 1. Escribir la muestra de entrada (y su suma mono y su ratio).
      const w = this.written & mask
      let sum = 0
      for (let c = 0; c < channels; c++) {
        const src = inCount === 0 ? null : input[c < inCount ? c : inCount - 1]
        const v = src ? src[i] : 0
        this.rings[c][w] = v
        sum += v
      }
      this.mono[w] = sum
      this.ratios[w] = r
      const now = this.written
      this.written++

      // 2. Grano nuevo cada `hop` muestras.
      if (this.phase >= hop) {
        this.startGrain(now)
        this.phase = 0
      }

      // 3. Mezcla de los dos granos activos.
      const j = this.phase
      const wA = this.aLive ? win[j] : 0
      const wB = this.bLive ? win[j + hop] : 0
      const pA = this.aPos + j * this.aRatio
      const pB = this.bPos + (j + hop) * this.bRatio
      if ((this.aLive && pA + 2 > now) || (this.bLive && pB + 2 > now)) this.overreads++
      let gain = 1
      if (this.fadeLeft > 0) {
        gain = this.fadeLeft / this.fadeLen
        this.fadeLeft--
        if (this.fadeLeft === 0) {
          for (let c = 0; c < outCount; c++) output[c][i] = 0
          this.reset()
          continue
        }
      }
      for (let c = 0; c < outCount; c++) {
        const ring = this.rings[c < channels ? c : channels - 1]
        let v = 0
        if (wA !== 0) v += wA * hermite(ring, pA, mask)
        if (wB !== 0) v += wB * hermite(ring, pB, mask)
        output[c][i] = v * gain
      }
      this.phase++
    }
  }

  private startGrain(now: number): void {
    // El grano A pasa a ser B (su segunda mitad) y nace un A nuevo.
    this.bPos = this.aPos
    this.bRatio = this.aRatio
    this.bLive = this.aLive
    const nominal = now - this.latencyFrames
    const r = this.ratios[nominal & this.mask] || 1
    let delta = 0
    if (this.bLive && this.searchFrames > 0) {
      const natural = this.bPos + this.hopFrames * this.bRatio
      delta = this.bestOffset(natural, nominal)
    }
    this.aPos = nominal + delta
    this.aRatio = r
    this.aLive = true
  }

  /**
   * Desplazamiento en [-search, search] cuyo tramo mejor continua la forma de onda en `natural`.
   * Busqueda gruesa (paso 4) y fina (+-3, paso 1). Empata hacia el desplazamiento mas chico.
   */
  private bestOffset(natural: number, nominal: number): number {
    const s = this.searchFrames
    const base = Math.floor(natural)
    let best = 0
    let bestScore = this.score(base, nominal, 4)
    for (let d = 4; d <= s; d += 4) {
      const up = this.score(base, nominal + d, 4)
      if (up > bestScore) {
        bestScore = up
        best = d
      }
      const down = this.score(base, nominal - d, 4)
      if (down > bestScore) {
        bestScore = down
        best = -d
      }
    }
    let fine = best
    let fineScore = this.score(base, nominal + best, 2)
    // Sin arreglos temporales: el hilo de audio no debe asignar memoria.
    for (let k = 1; k <= 6; k++) {
      const cand = best + (k & 1 ? (k + 1) >> 1 : -(k >> 1))
      if (cand < -s || cand > s) continue
      const sc = this.score(base, nominal + cand, 2)
      if (sc > fineScore) {
        fineScore = sc
        fine = cand
      }
    }
    return fine
  }

  /** Correlacion normalizada (sum a*b / sqrt(sum b^2)) entre el tramo en `a` y el tramo en `b`. */
  private score(a: number, b: number, step: number): number {
    const mono = this.mono
    const mask = this.mask
    const n = this.corrFrames
    let ab = 0
    let bb = 1e-9
    for (let i = 0; i < n; i += step) {
      const x = mono[(a + i) & mask]
      const y = mono[(b + i) & mask]
      ab += x * y
      bb += y * y
    }
    return ab / Math.sqrt(bb)
  }
}

/** Interpolacion Hermite de 4 puntos sobre un anillo (indices absolutos, mascara de potencia de 2). */
function hermite(ring: Float32Array, pos: number, mask: number): number {
  const i = Math.floor(pos)
  const f = pos - i
  const xm1 = ring[(i - 1) & mask]
  const x0 = ring[i & mask]
  const x1 = ring[(i + 1) & mask]
  const x2 = ring[(i + 2) & mask]
  const c1 = 0.5 * (x1 - xm1)
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
  return ((c3 * f + c2) * f + c1) * f + x0
}

// ---------------------------------------------------------------------------
// Render fuera de linea (pruebas): lo mismo que hace el navegador, sin navegador
// ---------------------------------------------------------------------------

/**
 * Remuestrea como AudioBufferSourceNode con playbackRate = speed (interpolacion lineal): la salida
 * dura len / speed y el tono cambia con la velocidad.
 */
export function resampleLinear(x: Float32Array, speed: number): Float32Array {
  const outLen = Math.max(0, Math.floor(x.length / speed))
  const y = new Float32Array(outLen)
  for (let k = 0; k < outLen; k++) {
    const p = k * speed
    const i = Math.floor(p)
    const f = p - i
    const a = x[i] ?? 0
    const b = x[i + 1] ?? a
    y[k] = a + (b - a) * f
  }
  return y
}

/**
 * Velocidad y tono fuera de linea: remuestreo (playbackRate) + GranularPitchShifter con el ratio
 * de compensacion, en bloques de 128 como el AudioWorklet, sin la latencia al inicio. Devuelve
 * len / speed muestras por canal. Asigna memoria: solo para pruebas y herramientas.
 */
export function renderSpeedPitchOffline(channels: Float32Array[], sampleRate: number, speed: number, semitones: number, options: ShifterOptions = {}): { output: Float32Array[]; shifter: GranularPitchShifter } {
  const resampled = channels.map((c) => resampleLinear(c, speed))
  const len = resampled[0]?.length ?? 0
  const shifter = new GranularPitchShifter(sampleRate, { ...options, channels: Math.max(1, channels.length) })
  const total = len + shifter.latencyFrames
  const out = resampled.map(() => new Float32Array(total))
  const ratio = shiftRatio(speed, semitones)
  const BLOCK = 128
  const inBlock = resampled.map(() => new Float32Array(BLOCK))
  const outBlock = resampled.map(() => new Float32Array(BLOCK))
  for (let start = 0; start < total; start += BLOCK) {
    const frames = Math.min(BLOCK, total - start)
    for (let c = 0; c < resampled.length; c++) {
      inBlock[c].fill(0)
      for (let i = 0; i < frames; i++) inBlock[c][i] = resampled[c][start + i] ?? 0
    }
    shifter.process(inBlock, outBlock, frames, ratio)
    for (let c = 0; c < resampled.length; c++) out[c].set(outBlock[c].subarray(0, frames), start)
  }
  return { output: out.map((c) => c.slice(shifter.latencyFrames, shifter.latencyFrames + len)), shifter }
}
