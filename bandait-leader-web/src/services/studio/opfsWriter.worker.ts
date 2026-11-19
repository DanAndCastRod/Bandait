/**
 * Escritor de tomas del Estudio Bandait (docs/PLAN_ESTUDIO_BANDAIT.md, seccion 5.1). Web Worker
 * que recibe los bloques del worklet de captura por un MessagePort y escribe cada canal armado en
 * un WAV de 24 bits en OPFS, a medida que llega, con `createSyncAccessHandle`.
 *
 * Ruta: <root>/<sessionId>/<file>, la misma que lee studioStore.ts (bandait_studio/<sesion>/<id>.wav).
 *
 * Recuperacion: al abrir se escribe una cabecera provisional (dataBytes 0) y los datos se vuelcan
 * a disco cada FLUSH_SECONDS. Si la pestana se cierra, el archivo queda con la cabecera en 0 y
 * los datos escritos: studioStore.recoverOrphanTake corrige la cabecera segun el tamano en disco.
 * Al cerrar bien, la cabecera se corrige aqui.
 *
 * Un bloque que llega con `frame` mayor al esperado deja un hueco (el hilo de audio se salto
 * cuantos): se rellena con silencio para que la toma no se corra en el tiempo.
 */
import { buildWavHeader } from '../wav.ts'
import type { CaptureRecycleMessage, CaptureSinkMessage } from './recorder.worklet.ts'

/** Bytes de la cabecera canonica que escribe buildWavHeader. */
const HEADER_BYTES = 44
const BYTES_PER_SAMPLE = 3
/** Cada cuanto se vuelca a disco: lo que se pierde como maximo si la pestana muere. */
const FLUSH_SECONDS = 2
/** Hueco maximo que se rellena con silencio. Uno mayor se cuenta pero no se escribe. */
const MAX_GAP_SECONDS = 30

/** Canales de la interfaz que van a un archivo: [0], [1] o [0, 1] (estereo intercalado). */
export interface WriterFileSpec {
  file: string
  channels: Array<0 | 1>
}

/** Hilo principal -> escritor. */
export type WriterCommand =
  | {
      type: 'open'
      takeId: string
      /** Carpeta raiz en OPFS (STUDIO_OPFS_ROOT de studioStore.ts). */
      root: string
      sessionId: string
      sampleRate: number
      files: WriterFileSpec[]
      /** Tope de bytes por archivo (STUDIO_MAX_ASSET_BYTES): al llegar, deja de escribir. */
      maxBytes: number
      /** Extremo por el que llegan los bloques del worklet. Va transferido. */
      port: MessagePort
    }
  /** Cierra la toma aunque el worklet no haya avisado `end` (worklet colgado). */
  | { type: 'finish'; takeId: string }

export interface WriterFileResult {
  file: string
  channels: 1 | 2
  /** Muestras por canal escritas, huecos incluidos. */
  frames: number
  /** Tamano final del archivo, cabecera incluida. */
  bytes: number
}

/** Escritor -> hilo principal. */
export type WriterEvent =
  | { type: 'opened'; takeId: string }
  | {
      type: 'closed'
      takeId: string
      files: WriterFileResult[]
      /** Bloques recibidos del worklet. */
      blocks: number
      /** Bloques que no llegaron (saltos en el consecutivo). Lo normal es 0. */
      missingBlocks: number
      /** Muestras de silencio agregadas para tapar huecos. */
      gapFrames: number
      /** Bloques que no se pudieron escribir (disco lleno, tope de tamano). */
      failedBlocks: number
      /** true si se alcanzo `maxBytes` y la toma quedo cortada. */
      truncated: boolean
      /** Primer error de escritura, en espanol; null si todo salio bien. */
      error: string | null
    }
  | { type: 'error'; takeId: string; message: string }

/** FileSystemSyncAccessHandle: solo existe en workers y lib.dom no lo declara. */
interface SyncAccessHandle {
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  truncate(size: number): void
  flush(): void
  close(): void
}
type SyncCapableFileHandle = FileSystemFileHandle & { createSyncAccessHandle?: () => Promise<SyncAccessHandle> }

interface OpenFile {
  spec: WriterFileSpec
  handle: SyncAccessHandle
}

interface Take {
  takeId: string
  sampleRate: number
  maxBytes: number
  port: MessagePort
  files: OpenFile[]
  /** Muestras por canal ya escritas (igual para todos los archivos). */
  frames: number
  /** `frame` esperado del proximo bloque; -1 antes del primero. */
  nextFrame: number
  nextSeq: number
  blocks: number
  missingBlocks: number
  gapFrames: number
  failedBlocks: number
  truncated: boolean
  error: string | null
  framesSinceFlush: number
  closed: boolean
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: WriterEvent): void
}

let current: Take | null = null
/** Zona de trabajo reutilizable: un bloque estereo convertido a 24 bits. */
let scratch = new Uint8Array(2048 * 2 * BYTES_PER_SAMPLE)

function scratchFor(bytes: number): Uint8Array {
  if (scratch.length < bytes) scratch = new Uint8Array(bytes)
  return scratch
}

function errorText(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'QuotaExceededError') return 'No hay espacio suficiente en el almacenamiento del navegador para seguir grabando.'
  if (name === 'NoModificationAllowedError') return 'El archivo de la toma está en uso por otra pestaña del hub.'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'El navegador no permite escribir audio en este equipo (¿navegación privada?).'
  return 'No se pudo escribir la toma en el almacenamiento del navegador.'
}

/** Float32 [-1, 1] a PCM de 24 bits little endian, canales intercalados. Satura; NaN es 0. */
function packPcm24(sources: Float32Array[], frames: number, out: Uint8Array): number {
  const channels = sources.length
  let o = 0
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let s = sources[c][i]
      if (s !== s) s = 0
      else if (s > 1) s = 1
      else if (s < -1) s = -1
      const v = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff)
      out[o] = v & 0xff
      out[o + 1] = (v >> 8) & 0xff
      out[o + 2] = (v >> 16) & 0xff
      o += BYTES_PER_SAMPLE
    }
  }
  return o
}

function filePosition(frames: number, channels: number): number {
  return HEADER_BYTES + frames * channels * BYTES_PER_SAMPLE
}

function writeAll(handle: SyncAccessHandle, bytes: Uint8Array, at: number): void {
  let written = 0
  while (written < bytes.length) {
    const n = handle.write(bytes.subarray(written), { at: at + written })
    if (!(n > 0)) throw new DOMException('escritura incompleta', 'QuotaExceededError')
    written += n
  }
}

function fail(take: Take, err: unknown): void {
  if (take.error === null) take.error = errorText(err)
}

/** Escribe `frames` muestras de `ch0`/`ch1` (o silencio si no vienen) en todos los archivos. */
function writeFrames(take: Take, frames: number, ch0: Float32Array | null, ch1: Float32Array | null): boolean {
  if (take.error !== null || take.truncated) return false
  for (const file of take.files) {
    const channels = file.spec.channels.length
    if (filePosition(take.frames + frames, channels) > take.maxBytes) {
      take.truncated = true
      return false
    }
  }
  try {
    for (const file of take.files) {
      const channels = file.spec.channels.length
      const bytes = frames * channels * BYTES_PER_SAMPLE
      const out = scratchFor(bytes)
      if (ch0 && ch1) {
        const sources = file.spec.channels.map((index) => (index === 0 ? ch0 : ch1))
        packPcm24(sources, frames, out)
      } else {
        out.fill(0, 0, bytes)
      }
      writeAll(file.handle, out.subarray(0, bytes), filePosition(take.frames, channels))
    }
  } catch (err) {
    fail(take, err)
    return false
  }
  take.frames += frames
  take.framesSinceFlush += frames
  if (take.framesSinceFlush >= take.sampleRate * FLUSH_SECONDS) {
    take.framesSinceFlush = 0
    try {
      for (const file of take.files) file.handle.flush()
    } catch (err) {
      fail(take, err)
    }
  }
  return true
}

function onBlock(take: Take, block: Extract<CaptureSinkMessage, { type: 'block' }>): void {
  take.blocks += 1
  if (block.seq > take.nextSeq) take.missingBlocks += block.seq - take.nextSeq
  take.nextSeq = block.seq + 1

  if (take.nextFrame >= 0 && block.frame > take.nextFrame) {
    const gap = block.frame - take.nextFrame
    take.gapFrames += gap
    let pending = Math.min(gap, take.sampleRate * MAX_GAP_SECONDS)
    while (pending > 0) {
      const chunk = Math.min(pending, 2048)
      if (!writeFrames(take, chunk, null, null)) break
      pending -= chunk
    }
  }
  take.nextFrame = block.frame + block.frames

  const ch0 = new Float32Array(block.ch0, 0, block.frames)
  const ch1 = new Float32Array(block.ch1, 0, block.frames)
  if (!writeFrames(take, block.frames, ch0, ch1)) take.failedBlocks += 1

  // Los bufers vuelven al worklet para que no asigne memoria en el hilo de audio.
  const recycle: CaptureRecycleMessage = { type: 'recycle', buffers: [block.ch0, block.ch1] }
  try {
    take.port.postMessage(recycle, [block.ch0, block.ch1])
  } catch {
    // El worklet ya no esta: los bufers se sueltan.
  }
}

/** Corrige la cabecera, vuelca, cierra los archivos y avisa al hilo principal. */
function closeTake(take: Take): void {
  if (take.closed) return
  take.closed = true
  if (current === take) current = null
  take.port.onmessage = null
  take.port.close()
  const results: WriterFileResult[] = []
  for (const file of take.files) {
    const channels = file.spec.channels.length as 1 | 2
    const dataBytes = take.frames * channels * BYTES_PER_SAMPLE
    try {
      const header = buildWavHeader({ channels, sampleRate: take.sampleRate, bitDepth: 24, dataBytes })
      writeAll(file.handle, new Uint8Array(header), 0)
      file.handle.flush()
    } catch (err) {
      fail(take, err)
    }
    try {
      file.handle.close()
    } catch {
      // Ya estaba cerrado.
    }
    results.push({ file: file.spec.file, channels, frames: take.frames, bytes: HEADER_BYTES + dataBytes })
  }
  scope.postMessage({
    type: 'closed',
    takeId: take.takeId,
    files: results,
    blocks: take.blocks,
    missingBlocks: take.missingBlocks,
    gapFrames: take.gapFrames,
    failedBlocks: take.failedBlocks,
    truncated: take.truncated,
    error: take.error,
  })
}

async function openTake(command: Extract<WriterCommand, { type: 'open' }>): Promise<void> {
  if (current) closeTake(current)
  const opened: OpenFile[] = []
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
      throw new DOMException('sin OPFS', 'SecurityError')
    }
    const root = await navigator.storage.getDirectory()
    const studio = await root.getDirectoryHandle(command.root, { create: true })
    const dir = await studio.getDirectoryHandle(command.sessionId, { create: true })
    for (const spec of command.files) {
      const fileHandle = (await dir.getFileHandle(spec.file, { create: true })) as SyncCapableFileHandle
      if (typeof fileHandle.createSyncAccessHandle !== 'function') throw new DOMException('sin acceso sincrono', 'SecurityError')
      const handle = await fileHandle.createSyncAccessHandle()
      opened.push({ spec, handle })
      const channels = spec.channels.length as 1 | 2
      handle.truncate(0)
      // Cabecera provisional: dataBytes 0 marca una toma sin cerrar.
      writeAll(handle, new Uint8Array(buildWavHeader({ channels, sampleRate: command.sampleRate, bitDepth: 24, dataBytes: 0 })), 0)
      handle.flush()
    }
  } catch (err) {
    for (const file of opened) {
      try {
        file.handle.close()
      } catch {
        // Ya estaba cerrado.
      }
    }
    command.port.close()
    scope.postMessage({ type: 'error', takeId: command.takeId, message: errorText(err) })
    return
  }

  const take: Take = {
    takeId: command.takeId,
    sampleRate: command.sampleRate,
    maxBytes: command.maxBytes,
    port: command.port,
    files: opened,
    frames: 0,
    nextFrame: -1,
    nextSeq: 0,
    blocks: 0,
    missingBlocks: 0,
    gapFrames: 0,
    failedBlocks: 0,
    truncated: false,
    error: null,
    framesSinceFlush: 0,
    closed: false,
  }
  current = take
  // Asignar onmessage abre el puerto: los bloques que llegaron antes quedan en cola hasta aqui.
  command.port.onmessage = (event: MessageEvent) => {
    const message = event.data as CaptureSinkMessage
    if (take.closed || !message) return
    if (message.type === 'block') onBlock(take, message)
    else if (message.type === 'end') {
      if (message.blocks > take.nextSeq) take.missingBlocks += message.blocks - take.nextSeq
      closeTake(take)
    }
  }
  scope.postMessage({ type: 'opened', takeId: command.takeId })
}

scope.onmessage = (event: MessageEvent) => {
  const command = event.data as WriterCommand
  if (!command) return
  if (command.type === 'open') void openTake(command)
  else if (command.type === 'finish' && current && current.takeId === command.takeId) closeTake(current)
}
