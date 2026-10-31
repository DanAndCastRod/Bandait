/**
 * WAV PCM de 16 bits, mono (la mezcla que el hub manda a analizar). Modulo puro: se prueba en
 * scripts/verify-stems-logic.ts.
 */

export const WAV_HEADER_BYTES = 44

/** Tamano del WAV en bytes para `samples` muestras mono de 16 bits. */
export function wavByteLength(samples: number): number {
  return WAV_HEADER_BYTES + samples * 2
}

/**
 * Escala la senal para que su pico quede en `target` (solo baja: nunca sube una mezcla floja,
 * para no amplificar ruido). Devuelve la ganancia aplicada. Modifica el arreglo.
 */
export function limitPeak(samples: Float32Array, target = 0.89): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i])
    if (v > peak) peak = v
  }
  if (!(peak > target)) return 1
  const gain = target / peak
  for (let i = 0; i < samples.length; i++) samples[i] *= gain
  return gain
}

/** Codifica muestras en [-1, 1] como WAV PCM 16 bits mono (little endian). Satura lo que se pase. */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const rate = Math.round(sampleRate)
  if (!(rate > 0)) throw new Error('sampleRate invalido')
  const buffer = new ArrayBuffer(wavByteLength(samples.length))
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  const dataBytes = samples.length * 2
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // tamano del bloque fmt
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true) // bytes por segundo
  view.setUint16(32, 2, true) // bytes por muestra
  view.setUint16(34, 16, true) // bits
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  let offset = WAV_HEADER_BYTES
  for (let i = 0; i < samples.length; i++) {
    const s = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0
    view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
    offset += 2
  }
  return buffer
}
