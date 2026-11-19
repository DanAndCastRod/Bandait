/**
 * Worklet de captura del Estudio Bandait (docs/PLAN_ESTUDIO_BANDAIT.md, seccion 5.1). Corre en el
 * hilo de audio: junta la entrada en bloques Float32 por canal y los entrega por un MessagePort
 * (el "sumidero") al escritor de OPFS o al hilo principal, sin pasar por React.
 *
 * Este archivo se carga con `audioWorklet.addModule`, no se importa como modulo normal: recorder.ts
 * solo le importa TIPOS (`import type`). Importar un valor ejecutaria `registerProcessor` en la
 * pagina.
 *
 * Camino de tiempo real:
 *   - Los bufers de los bloques se reciclan: el sumidero los devuelve con `recycle` y el worklet los
 *     reutiliza. Solo se asigna memoria cuando la reserva esta vacia (al arrancar, o si el escritor
 *     se atrasa).
 *   - Sin registros ni excepciones en `process`.
 *
 * Bloques perdidos: cada llamada a `process` debe empezar donde termino la anterior. Si
 * `currentFrame` salta, el hilo de audio se salto cuantos de render y se cuentan en
 * `droppedQuanta`; el bloque siguiente lleva su `frame` real, asi el escritor rellena el hueco con
 * silencio y la toma no se corre. Un corte del dispositivo que el navegador tapa con silencio NO
 * se ve desde aqui: eso lo informan las estadisticas del track (recorder.ts, readInputTrackStats).
 */

// Globales de AudioWorkletGlobalScope; lib.dom no los declara.
declare const currentFrame: number
declare const currentTime: number
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

/** Nombre con que se registra el procesador. recorder.ts lo repite (no puede importar valores). */
const PROCESSOR_NAME = 'bandait-studio-capture'
/** Muestras por bloque entregado: 16 cuantos de 128 (unos 43 ms a 48 kHz). */
const BLOCK_FRAMES = 2048
/** Bufers libres que se guardan como maximo (canal 1 + canal 2 de 32 bloques). */
const POOL_LIMIT = 64

/** Hilo principal -> worklet. */
export type CaptureCommand =
  /** Empieza a capturar en el proximo cuanto. `sink` recibe los bloques. */
  | { type: 'start'; takeId: string; sink: MessagePort }
  /** Entrega el bloque parcial, avisa `end` al sumidero y `stopped` al hilo principal. */
  | { type: 'stop'; takeId: string }

/** Worklet -> hilo principal. */
export type CaptureEvent =
  | {
      type: 'started'
      takeId: string
      /** `currentFrame` del primer cuanto capturado. */
      firstFrame: number
      /** Tiempo del AudioContext de ese cuanto (firstFrame / sampleRate). */
      firstTime: number
      sampleRate: number
    }
  | {
      type: 'stopped'
      takeId: string
      /** Muestras capturadas por canal, sin contar los huecos. */
      frames: number
      /** Bloques entregados al sumidero. */
      blocks: number
      /** Cuantos de render que el hilo de audio se salto (saltos de currentFrame). */
      droppedQuanta: number
      /** Cuantos en que la entrada no trajo ningun canal (fuente desconectada). */
      emptyQuanta: number
      /** Maximo de canales que trajo la entrada: 2 con una interfaz estereo bien abierta. */
      inputChannels: number
    }

/** Worklet -> sumidero. Los dos bufers van transferidos y miden siempre BLOCK_FRAMES muestras. */
export type CaptureSinkMessage =
  | {
      type: 'block'
      /** Consecutivo desde 0: el sumidero detecta bloques que no llegaron. */
      seq: number
      /** `currentFrame` de la primera muestra del bloque. */
      frame: number
      /** Muestras validas (el ultimo bloque puede traer menos). */
      frames: number
      ch0: ArrayBuffer
      ch1: ArrayBuffer
    }
  | { type: 'end'; frames: number; blocks: number }

/** Sumidero -> worklet: bufers ya escritos, para reutilizar. */
export interface CaptureRecycleMessage {
  type: 'recycle'
  buffers: ArrayBuffer[]
}

class CaptureProcessor extends AudioWorkletProcessor {
  private sink: MessagePort | null = null
  private takeId = ''
  private capturing = false
  private announced = false
  private readonly pool: ArrayBuffer[] = []
  private ch0 = new Float32Array(BLOCK_FRAMES)
  private ch1 = new Float32Array(BLOCK_FRAMES)
  private fill = 0
  private blockFrame = 0
  private seq = 0
  private frames = 0
  private expectedFrame = -1
  private droppedQuanta = 0
  private emptyQuanta = 0
  private inputChannels = 0

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent) => this.onCommand(event.data as CaptureCommand)
  }

  private onCommand(command: CaptureCommand): void {
    if (command.type === 'start') {
      // Una captura anterior sin cerrar se cierra antes de empezar la nueva.
      if (this.capturing) this.finish()
      this.sink = command.sink
      this.sink.onmessage = (event: MessageEvent) => this.onRecycle(event.data as CaptureRecycleMessage)
      this.takeId = command.takeId
      this.fill = 0
      this.seq = 0
      this.frames = 0
      this.expectedFrame = -1
      this.droppedQuanta = 0
      this.emptyQuanta = 0
      this.inputChannels = 0
      this.announced = false
      this.capturing = true
    } else if (command.type === 'stop') {
      // El manejador corre en el hilo de audio, entre dos cuantos: es seguro cerrar aqui, y asi la
      // captura se cierra aunque el contexto este suspendido y `process` no vuelva a correr.
      if (this.capturing && command.takeId === this.takeId) this.finish()
    }
  }

  private onRecycle(message: CaptureRecycleMessage): void {
    if (!message || message.type !== 'recycle' || !Array.isArray(message.buffers)) return
    for (const buffer of message.buffers) {
      if (this.pool.length >= POOL_LIMIT) return
      if (buffer instanceof ArrayBuffer && buffer.byteLength === BLOCK_FRAMES * 4) this.pool.push(buffer)
    }
  }

  private nextBuffer(): Float32Array<ArrayBuffer> {
    const reused = this.pool.pop()
    return reused ? new Float32Array(reused) : new Float32Array(BLOCK_FRAMES)
  }

  private flush(): void {
    if (this.fill === 0 || !this.sink) return
    const a = this.ch0.buffer as ArrayBuffer
    const b = this.ch1.buffer as ArrayBuffer
    const message: CaptureSinkMessage = { type: 'block', seq: this.seq, frame: this.blockFrame, frames: this.fill, ch0: a, ch1: b }
    this.sink.postMessage(message, [a, b])
    this.seq += 1
    this.ch0 = this.nextBuffer()
    this.ch1 = this.nextBuffer()
    this.fill = 0
  }

  private finish(): void {
    this.flush()
    this.capturing = false
    if (this.sink) {
      const end: CaptureSinkMessage = { type: 'end', frames: this.frames, blocks: this.seq }
      this.sink.postMessage(end)
      // El sumidero cierra su extremo al recibir `end`; cerrar aqui podria descartar lo pendiente.
      this.sink.onmessage = null
      this.sink = null
    }
    const stopped: CaptureEvent = {
      type: 'stopped',
      takeId: this.takeId,
      frames: this.frames,
      blocks: this.seq,
      droppedQuanta: this.droppedQuanta,
      emptyQuanta: this.emptyQuanta,
      inputChannels: this.inputChannels,
    }
    this.port.postMessage(stopped)
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.capturing) return true
    const input = inputs[0]
    const channels = input ? input.length : 0
    const quantum = channels > 0 ? input[0].length : 128
    const frame = currentFrame

    if (!this.announced) {
      this.announced = true
      this.blockFrame = frame
      const started: CaptureEvent = { type: 'started', takeId: this.takeId, firstFrame: frame, firstTime: currentTime, sampleRate }
      this.port.postMessage(started)
    } else if (frame !== this.expectedFrame) {
      const gap = frame - this.expectedFrame
      if (gap > 0) {
        this.droppedQuanta += Math.max(1, Math.round(gap / quantum))
        // El bloque en curso se entrega tal cual y el siguiente arranca en el frame real.
        this.flush()
      }
    }
    this.expectedFrame = frame + quantum

    if (this.fill + quantum > BLOCK_FRAMES) this.flush()
    if (this.fill === 0) this.blockFrame = frame

    if (channels > this.inputChannels) this.inputChannels = channels
    if (channels === 0) {
      this.emptyQuanta += 1
      this.ch0.fill(0, this.fill, this.fill + quantum)
      this.ch1.fill(0, this.fill, this.fill + quantum)
    } else {
      this.ch0.set(input[0], this.fill)
      if (channels > 1) this.ch1.set(input[1], this.fill)
      else this.ch1.fill(0, this.fill, this.fill + quantum)
    }
    this.fill += quantum
    this.frames += quantum
    if (this.fill >= BLOCK_FRAMES) this.flush()
    return true
  }
}

registerProcessor(PROCESSOR_NAME, CaptureProcessor)
