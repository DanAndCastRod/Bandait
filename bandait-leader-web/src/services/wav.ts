/**
 * WAV PCM de 16 bits, mono (la mezcla que el hub manda a analizar). Modulo puro: se prueba en
 * scripts/verify-stems-logic.ts.
 */
import type { WavApi, WavBitDepth, WavHeader, WavHeaderInput } from './studio/types.ts'

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

// ---------------------------------------------------------------------------
// Estudio Bandait: WAV de 16 y 24 bits, mono o estereo, y lectura de cabeceras.
// Firmas en services/studio/types.ts (WavApi). Lo de arriba no cambia.
// ---------------------------------------------------------------------------

/** Tamano maximo del bloque `data` que cabe en una cabecera RIFF de 32 bits. */
const WAV_MAX_DATA_BYTES = 0xffffffff - 36

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** Cabecera canonica de 44 bytes (RIFF, fmt de 16 bytes, data). */
export function buildWavHeader(input: WavHeaderInput): ArrayBuffer {
  const rate = Math.round(input.sampleRate)
  if (!(rate > 0)) throw new Error('sampleRate invalido')
  if (input.channels !== 1 && input.channels !== 2) throw new Error('El WAV del Estudio admite 1 o 2 canales')
  if (input.bitDepth !== 16 && input.bitDepth !== 24) throw new Error('El WAV del Estudio es de 16 o 24 bits')
  const dataBytes = Math.floor(input.dataBytes)
  if (!(dataBytes >= 0) || dataBytes > WAV_MAX_DATA_BYTES) throw new Error('El audio no cabe en un WAV')
  const blockAlign = input.channels * (input.bitDepth / 8)
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // tamano del bloque fmt
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, input.channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * blockAlign, true) // bytes por segundo
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, input.bitDepth, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return buffer
}

/**
 * Convierte un bloque Float32 a PCM de 24 bits little endian dentro de `out`, desde
 * `byteOffset`. Devuelve el siguiente byteOffset. No asigna memoria: es lo que usa el escritor
 * de tomas por cada bloque. Satura fuera de [-1, 1]; una muestra no finita queda en 0.
 */
export function floatTo24(samples: Float32Array, out: Uint8Array, byteOffset: number): number {
  let o = byteOffset
  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i]
    const s = raw !== raw ? 0 : raw > 1 ? 1 : raw < -1 ? -1 : raw
    const v = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff)
    out[o] = v & 0xff
    out[o + 1] = (v >> 8) & 0xff
    out[o + 2] = (v >> 16) & 0xff
    o += 3
  }
  return o
}

/** WAV PCM de 16 o 24 bits, canales intercalados (1 o 2), little endian. Satura fuera de [-1, 1]. */
export function encodeWavPcm(channels: Float32Array[], sampleRate: number, bitDepth: WavBitDepth): ArrayBuffer {
  if (channels.length !== 1 && channels.length !== 2) throw new Error('El WAV del Estudio admite 1 o 2 canales')
  const count = channels.length
  let frames = channels[0].length
  if (count === 2 && channels[1].length < frames) frames = channels[1].length
  const bytesPerSample = bitDepth / 8
  const dataBytes = frames * count * bytesPerSample
  const header = buildWavHeader({ channels: count, sampleRate, bitDepth, dataBytes })
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const bytes = new Uint8Array(buffer)
  bytes.set(new Uint8Array(header), 0)
  let o = WAV_HEADER_BYTES
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < count; c++) {
      const raw = channels[c][i]
      const s = raw !== raw ? 0 : raw > 1 ? 1 : raw < -1 ? -1 : raw
      if (bitDepth === 24) {
        const v = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7fffff)
        bytes[o] = v & 0xff
        bytes[o + 1] = (v >> 8) & 0xff
        bytes[o + 2] = (v >> 16) & 0xff
        o += 3
      } else {
        const v = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
        bytes[o] = v & 0xff
        bytes[o + 1] = (v >> 8) & 0xff
        o += 2
      }
    }
  }
  return buffer
}

/** WAV PCM de 24 bits, canales intercalados (1 o 2), little endian. Satura fuera de [-1, 1]. */
export function encodeWav24(channels: Float32Array[], sampleRate: number): ArrayBuffer {
  return encodeWavPcm(channels, sampleRate, 24)
}

/**
 * Lee la cabecera RIFF/WAVE recorriendo los bloques hasta `data`. `bytes` basta con los primeros
 * kilobytes del archivo. Devuelve null si no es un WAV PCM o de coma flotante que se pueda leer,
 * o si `data` no aparece dentro de lo recibido.
 */
export function parseWavHeader(bytes: ArrayBuffer | Uint8Array): WavHeader | null {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (u8.length < 12) return null
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
  const tag = (offset: number) => String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let format: 1 | 3 | null = null
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let blockAlign = 0
  let offset = 12
  while (offset + 8 <= u8.length) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > u8.length) return null
      let code = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      blockAlign = view.getUint16(body + 12, true)
      bitsPerSample = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE: el formato real son los dos primeros bytes del subformato.
      if (code === 0xfffe) {
        if (size < 40 || body + 26 > u8.length) return null
        code = view.getUint16(body + 24, true)
      }
      if (code !== 1 && code !== 3) return null
      format = code
    } else if (id === 'data') {
      if (format === null || channels < 1 || sampleRate < 1 || bitsPerSample < 8 || bitsPerSample % 8 !== 0) return null
      const frameBytes = blockAlign > 0 ? blockAlign : channels * (bitsPerSample / 8)
      const frames = Math.floor(size / frameBytes)
      return { format, channels, sampleRate, bitsPerSample, dataOffset: body, dataBytes: size, frames, durationS: frames / sampleRate }
    }
    // Los bloques se alinean a byte par.
    offset = body + size + (size % 2)
  }
  return null
}

void ({ encodeWav24, encodeWavPcm, buildWavHeader, floatTo24, parseWavHeader } satisfies WavApi)
