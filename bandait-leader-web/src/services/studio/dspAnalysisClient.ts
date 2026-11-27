/**
 * Cliente del analisis DSP que no debe bloquear la interfaz:
 *
 *   - analyzeMusicalAsync: deteccion musical (BPM, tonalidad, acordes) en el Web Worker
 *     dspAnalysis.worker.ts. Sin Worker (o si falla al crearse) corre en el hilo principal tras
 *     ceder un turno, para que al menos se pinte el aviso de "analizando".
 *   - measureLoudnessInChunks: LUFS integrado, pico real, LRA y PLR de un render, en trozos de
 *     1 s con esperas entre trozos (sin copiar el audio: un render de 20 min no se duplica).
 *
 * Las muestras que van al Worker se COPIAN antes de transferirlas: lo que entra puede ser una
 * vista sobre un AudioBuffer decodificado, y transferirlo lo vaciaria.
 */
import { analyzeMusical, createLoudnessSummaryMeter, type LoudnessSummary, type MusicalAnalysis, type MusicalAnalysisOptions } from './dspMath.ts'
import type { DspWorkerRequest, DspWorkerResponse } from './dspAnalysis.worker.ts'

let worker: Worker | null = null
let workerBroken = false
let nextId = 1
const pending = new Map<number, { resolve: (value: MusicalAnalysis) => void; reject: (err: Error) => void }>()

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function failAll(err: Error): void {
  for (const entry of pending.values()) entry.reject(err)
  pending.clear()
}

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null
  if (worker) return worker
  try {
    const created = new Worker(new URL('./dspAnalysis.worker.ts', import.meta.url), { type: 'module' })
    created.onmessage = (event: MessageEvent) => {
      const response = event.data as DspWorkerResponse
      const entry = pending.get(response.id)
      if (!entry) return
      pending.delete(response.id)
      if (response.ok) entry.resolve(response.result)
      else entry.reject(new Error(response.error))
    }
    created.onerror = () => {
      // Worker que no carga (CSP, navegador viejo): se deja de usar y lo pendiente falla.
      workerBroken = true
      worker = null
      created.terminate()
      failAll(new Error('worker de análisis no disponible'))
    }
    worker = created
    return worker
  } catch {
    workerBroken = true
    return null
  }
}

async function analyzeOnMainThread(samples: Float32Array, sampleRate: number, options: MusicalAnalysisOptions): Promise<MusicalAnalysis> {
  await yieldToUi()
  return analyzeMusical(samples, sampleRate, options)
}

/** Deteccion musical fuera del hilo principal (o, sin Worker, tras ceder un turno). */
export async function analyzeMusicalAsync(samples: Float32Array, sampleRate: number, options: MusicalAnalysisOptions): Promise<MusicalAnalysis> {
  const target = getWorker()
  if (!target) return analyzeOnMainThread(samples, sampleRate, options)
  const copy = samples.slice()
  const id = nextId++
  try {
    return await new Promise<MusicalAnalysis>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const request: DspWorkerRequest = { id, type: 'musical', samples: copy, sampleRate, options }
      target.postMessage(request, [copy.buffer])
    })
  } catch {
    // El Worker fallo a mitad de camino: se repite aqui con las muestras originales.
    return analyzeOnMainThread(samples, sampleRate, options)
  }
}

/** Lo minimo de un AudioBuffer que hace falta para medirlo (tambien sirve un objeto de prueba). */
export interface ChannelSource {
  readonly numberOfChannels: number
  readonly sampleRate: number
  readonly length: number
  getChannelData(channel: number): Float32Array
}

/**
 * Mide sonoridad (LUFS integrado, pico real x4, LRA, PLR) en trozos de 1 s y cede la interfaz
 * cada ~12 ms de trabajo. No copia el audio.
 */
export async function measureLoudnessInChunks(source: ChannelSource, signal?: AbortSignal): Promise<LoudnessSummary> {
  const count = Math.min(2, source.numberOfChannels)
  const channels: Float32Array[] = []
  for (let c = 0; c < count; c++) channels.push(source.getChannelData(c))
  const meter = createLoudnessSummaryMeter(source.sampleRate, count)
  const chunk = Math.max(1, Math.round(source.sampleRate))
  let sliceStart = typeof performance !== 'undefined' ? performance.now() : Date.now()
  for (let pos = 0; pos < source.length; pos += chunk) {
    if (signal?.aborted) throw new DOMException('La medición se canceló.', 'AbortError')
    const end = Math.min(source.length, pos + chunk)
    meter.push(channels.map((ch) => ch.subarray(pos, end)))
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    if (now - sliceStart > 12) {
      await yieldToUi()
      sliceStart = typeof performance !== 'undefined' ? performance.now() : Date.now()
    }
  }
  return meter.summary()
}
