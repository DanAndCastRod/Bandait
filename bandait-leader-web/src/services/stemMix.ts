/**
 * Mezcla de los stems guardados en este equipo para el analisis con IA: mono, 22 050 Hz,
 * WAV PCM 16 bits (unos 10 MB por 4 minutos). Se hace en el navegador con OfflineAudioContext,
 * sin sonar y sin tocar el reproductor.
 */
import { encodeWav16, limitPeak } from './wav'
import type { StemRole } from './stemNames'

export const MIX_SAMPLE_RATE = 22050
/** Mas que esto no es una cancion (y pasaria el limite de 95 MB del Worker). */
export const MIX_MAX_SECONDS = 20 * 60

/** El clic y la guia hablada confunden la deteccion de secciones y acordes: no van en la mezcla. */
const EXCLUDED_ROLES: readonly StemRole[] = ['click', 'guide']

export interface MixInput {
  role: StemRole
  blob: Blob
}

export class MixError extends Error {}

type OfflineCtor = typeof OfflineAudioContext

function offlineCtor(): OfflineCtor {
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor }
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext
  if (!Ctor) throw new MixError('Este navegador no puede mezclar audio (falta OfflineAudioContext).')
  return Ctor
}

/** Mezcla los stems y devuelve el WAV. Lanza MixError con un mensaje para la UI. */
export async function mixStemsToWav(inputs: MixInput[], onStep?: (text: string) => void): Promise<Blob> {
  const chosen = inputs.filter((i) => !EXCLUDED_ROLES.includes(i.role))
  const tracks = chosen.length > 0 ? chosen : inputs
  if (tracks.length === 0) throw new MixError('La canción no tiene stems en este equipo.')
  const Ctor = offlineCtor()

  // Decodificar a 22 050 Hz con un contexto minimo (decodeAudioData remuestrea a su frecuencia).
  const decoder = new Ctor(1, 1, MIX_SAMPLE_RATE)
  const buffers: AudioBuffer[] = []
  for (let i = 0; i < tracks.length; i++) {
    onStep?.(`DECODIFICANDO ${i + 1}/${tracks.length}...`)
    try {
      buffers.push(await decoder.decodeAudioData(await tracks[i].blob.arrayBuffer()))
    } catch {
      // Un stem que este navegador no decodifica se omite; si no queda ninguno, se avisa abajo.
    }
  }
  if (buffers.length === 0) throw new MixError('Ningún stem se pudo decodificar en este navegador.')
  const duration = Math.max(...buffers.map((b) => b.duration))
  if (duration > MIX_MAX_SECONDS) throw new MixError('La canción dura más de 20 minutos: no se puede analizar.')

  onStep?.('MEZCLANDO...')
  const length = Math.max(1, Math.ceil(duration * MIX_SAMPLE_RATE))
  const ctx = new Ctor(1, length, MIX_SAMPLE_RATE)
  for (const buffer of buffers) {
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    src.start(0)
  }
  const rendered = await ctx.startRendering()
  const samples = new Float32Array(rendered.getChannelData(0))
  // La suma de varios stems puede pasar de 1: se baja el pico en vez de saturar.
  limitPeak(samples)
  return new Blob([encodeWav16(samples, MIX_SAMPLE_RATE)], { type: 'audio/wav' })
}
