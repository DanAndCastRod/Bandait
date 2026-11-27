/**
 * Web Worker de analisis DSP del Estudio: corre fuera del hilo principal lo que tarda cientos de
 * milisegundos (deteccion musical de 45 s: BPM, tonalidad y acordes Viterbi). Recibe las muestras
 * transferidas (ya copiadas por el cliente) y devuelve solo numeros y acordes.
 *
 * Lo crea dspAnalysisClient.ts con `new Worker(new URL(...), { type: 'module' })`.
 */
import { analyzeMusical, type MusicalAnalysis, type MusicalAnalysisOptions } from './dspMath.ts'

export type DspWorkerRequest = {
  id: number
  type: 'musical'
  samples: Float32Array
  sampleRate: number
  options: MusicalAnalysisOptions
}

export type DspWorkerResponse = { id: number; ok: true; result: MusicalAnalysis } | { id: number; ok: false; error: string }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null
  postMessage(message: DspWorkerResponse): void
}

scope.onmessage = (event: MessageEvent) => {
  const request = event.data as DspWorkerRequest
  if (!request || request.type !== 'musical') return
  try {
    const result = analyzeMusical(request.samples, request.sampleRate, request.options)
    scope.postMessage({ id: request.id, ok: true, result })
  } catch (err) {
    scope.postMessage({ id: request.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
