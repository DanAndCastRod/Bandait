/**
 * Acumulador de una toma grabada en memoria (moviles y navegadores sin OPFS): recibe los bloques
 * del worklet de captura y los guarda YA convertidos a PCM de 24 bits intercalado, solo con los
 * canales que la pista armada usa (mono real si la pista es mono). Al cerrar arma el WAV como
 * partes de un Blob (cabecera + trozos), sin juntar todo en un Float32Array intermedio.
 *
 * Memoria de 180 s a 48 kHz: estereo ~50 MB de PCM (mas la copia que haga el Blob), mono la mitad.
 * Antes eran ~190 MB (Float32 por bloque + Float32 juntado + WAV).
 *
 * Igual que el escritor de OPFS (opfsWriter.worker.ts): cuenta los bloques que faltan por `seq` y
 * rellena con silencio los huecos de `frame` (cuantos que el hilo de audio se salto), asi la toma
 * no se corre en el tiempo.
 *
 * Modulo puro (sin DOM): se prueba con node.
 */
import { buildWavHeader } from '../wav.ts'

/** Hueco maximo que se rellena con silencio (igual que el escritor de OPFS). */
const MAX_GAP_SECONDS = 30

export interface MemoryTakeBlock {
  seq: number
  frame: number
  frames: number
  ch0: ArrayBuffer
  ch1: ArrayBuffer
}

export interface MemoryTakeResult {
  /** Cabecera WAV + PCM de 24 bits intercalado, listo para `new Blob(parts)`. */
  parts: Uint8Array[]
  frames: number
  channels: 1 | 2
  bytes: number
  blocks: number
  missingBlocks: number
  gapFrames: number
  truncated: boolean
}

function writePcm24(out: Uint8Array, offset: number, sample: number): void {
  const s = sample !== sample ? 0 : sample > 1 ? 1 : sample < -1 ? -1 : sample
  const v = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff)
  out[offset] = v & 0xff
  out[offset + 1] = (v >> 8) & 0xff
  out[offset + 2] = (v >> 16) & 0xff
}

export class MemoryTakeAccumulator {
  private readonly picks: Array<0 | 1>
  private readonly sampleRate: number
  private readonly maxFrames: number
  private readonly chunks: Uint8Array[] = []
  private frames = 0
  private nextSeq = 0
  private nextFrame = -1
  private blocks = 0
  private missingBlocks = 0
  private gapFrames = 0
  private truncated = false
  private ended = false

  /** `channels`: [0], [1] o [0, 1] (estereo intercalado), como WriterFileSpec. */
  constructor(channels: ReadonlyArray<0 | 1>, sampleRate: number, maxFrames: number) {
    this.picks = channels.length >= 2 ? [0, 1] : [channels[0] === 1 ? 1 : 0]
    this.sampleRate = sampleRate
    this.maxFrames = Math.max(0, Math.floor(maxFrames))
  }

  get channelCount(): 1 | 2 {
    return this.picks.length === 2 ? 2 : 1
  }

  get capturedFrames(): number {
    return this.frames
  }

  private appendSilence(count: number): void {
    let pending = Math.min(count, this.maxFrames - this.frames)
    if (pending < count) this.truncated = true
    const bytesPerFrame = 3 * this.picks.length
    while (pending > 0) {
      const take = Math.min(pending, 8192)
      this.chunks.push(new Uint8Array(take * bytesPerFrame))
      this.frames += take
      pending -= take
    }
  }

  /** Agrega un bloque del worklet. Los bufers no se retienen: se pueden devolver al worklet. */
  push(block: MemoryTakeBlock): void {
    if (this.ended) return
    this.blocks += 1
    if (block.seq > this.nextSeq) this.missingBlocks += block.seq - this.nextSeq
    this.nextSeq = Math.max(this.nextSeq, block.seq + 1)

    if (this.nextFrame >= 0 && block.frame > this.nextFrame) {
      const gap = block.frame - this.nextFrame
      this.gapFrames += gap
      this.appendSilence(Math.min(gap, Math.round(this.sampleRate * MAX_GAP_SECONDS)))
    }
    this.nextFrame = block.frame + block.frames

    const remaining = this.maxFrames - this.frames
    if (remaining <= 0) {
      this.truncated = true
      return
    }
    const take = Math.min(block.frames, remaining)
    if (take < block.frames) this.truncated = true
    const sources = this.picks.map((c) => new Float32Array(c === 0 ? block.ch0 : block.ch1, 0, take))
    const count = sources.length
    const out = new Uint8Array(take * count * 3)
    let o = 0
    for (let i = 0; i < take; i++) {
      for (let c = 0; c < count; c++) {
        writePcm24(out, o, sources[c][i])
        o += 3
      }
    }
    this.chunks.push(out)
    this.frames += take
  }

  /** `end` del worklet: cuantos bloques entrego en total (los que no llegaron cuentan como faltantes). */
  end(totalBlocks: number): void {
    if (this.ended) return
    if (totalBlocks > this.nextSeq) this.missingBlocks += totalBlocks - this.nextSeq
    this.ended = true
  }

  finish(): MemoryTakeResult {
    this.ended = true
    const channels = this.channelCount
    const dataBytes = this.frames * channels * 3
    const header = new Uint8Array(buildWavHeader({ channels, sampleRate: this.sampleRate, bitDepth: 24, dataBytes }))
    const parts = [header, ...this.chunks]
    this.chunks.length = 0
    return {
      parts,
      frames: this.frames,
      channels,
      bytes: header.byteLength + dataBytes,
      blocks: this.blocks,
      missingBlocks: this.missingBlocks,
      gapFrames: this.gapFrames,
      truncated: this.truncated,
    }
  }
}
