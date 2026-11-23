/**
 * Audio para el asistente del chat, hecho en este equipo (usa OfflineAudioContext: no es puro).
 *
 *   - measureMix: mide la mezcla y cada pista sola (LUFS, pico real, energia por banda). Es la
 *     misma medicion del ASISTENTE DE MEZCLA (trabajo `assist`); el chat la reusa como dato del
 *     resumen (STUDIO_V2.md 4.3.2, `mix_measured`). Solo numeros: nunca sale audio.
 *   - renderListenExcerpt: un fragmento de la mezcla, mono, 16 kHz, 16 bit, hasta 30 s, para
 *     ESCUCHAR FRAGMENTO (STUDIO_V2.md 4.3.5).
 */
import { encodeWav16 } from '../wav'
import { bounceTrackIds, renderMix, soloTrackSession } from './bounce'
import { buildMixMetrics, CHAT_LISTEN_MAX_SECONDS, CHAT_LISTEN_SAMPLE_RATE, measureTrack } from './jobs'
import { STUDIO_REVERB_SEND_DB_MIN, findTrack, sessionEndSeconds, type StudioSession } from './session'
import type { MixMetrics, StudioBuffers, TrackMetrics } from './types'

function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const channels = [buffer.getChannelData(0)]
  if (buffer.numberOfChannels > 1) channels.push(buffer.getChannelData(1))
  return channels
}

export interface MeasureMixOptions {
  /** Volumen objetivo (-24..-6); por defecto el del asistente (-14). */
  targetLufs?: number
  signal?: AbortSignal
  /** Texto y fraccion 0..1 del avance. */
  progress?: (text: string, fraction: number) => void
}

/**
 * Mide la mezcla completa y cada pista sola, despues de su fader y su paneo, sin reverb ni el
 * volumen del master. Nunca hay mas de un render en memoria.
 */
export async function measureMix(session: StudioSession, buffers: StudioBuffers, options: MeasureMixOptions = {}): Promise<MixMetrics> {
  const { signal, progress } = options
  const ids = bounceTrackIds(session)
  const steps = ids.length + 1
  progress?.('MIDIENDO LA MEZCLA...', 0)
  const mix = await renderMix(session, buffers, { sampleRate: session.sampleRate, signal })
  const metrics = buildMixMetrics({ targetLufs: options.targetLufs, master: { channels: channelsOf(mix), sampleRate: mix.sampleRate }, tracks: [] })
  const range = { startS: 0, endS: sessionEndSeconds(session) }
  const tracks: TrackMetrics[] = []
  for (let i = 0; i < ids.length; i++) {
    const track = findTrack(session, ids[i])
    const solo = soloTrackSession(session, ids[i])
    if (!track || !solo) continue
    progress?.(`MIDIENDO PISTA ${i + 1}/${ids.length}...`, (i + 1) / steps)
    const alone: StudioSession = { ...solo, tracks: [{ ...solo.tracks[0], reverbSendDb: STUDIO_REVERB_SEND_DB_MIN }], master: { ...solo.master, volumeDb: 0 } }
    const rendered = await renderMix(alone, buffers, { sampleRate: session.sampleRate, range, signal })
    tracks.push(measureTrack(track, channelsOf(rendered), rendered.sampleRate))
  }
  return { ...metrics, tracks }
}

export interface ListenExcerpt {
  /** WAV PCM 16 bit mono de 16 kHz. */
  blob: Blob
  durationS: number
}

/**
 * Fragmento de la mezcla desde `startS`, hasta 30 s, mono, 16 kHz, 16 bit (unos 960 KB los 30 s).
 * Lanza si no hay audio en ese tramo.
 */
export async function renderListenExcerpt(session: StudioSession, buffers: StudioBuffers, startS: number, options: { signal?: AbortSignal; seconds?: number } = {}): Promise<ListenExcerpt> {
  const end = sessionEndSeconds(session)
  const seconds = Math.min(CHAT_LISTEN_MAX_SECONDS, Math.max(1, options.seconds ?? CHAT_LISTEN_MAX_SECONDS))
  // Si el cabezal quedo al final, se toman los ultimos segundos de la sesion.
  const from = Math.max(0, Math.min(Number.isFinite(startS) ? startS : 0, end - seconds))
  const to = Math.min(end, from + seconds)
  if (!(to > from)) throw new Error('No hay audio para escuchar en ese tramo de la sesión.')
  const rendered = await renderMix(session, buffers, { sampleRate: CHAT_LISTEN_SAMPLE_RATE, range: { startS: from, endS: to }, signal: options.signal })
  const channels = channelsOf(rendered)
  const frames = Math.min(rendered.length, Math.floor(CHAT_LISTEN_MAX_SECONDS * rendered.sampleRate))
  const mono = new Float32Array(frames)
  for (const ch of channels) for (let i = 0; i < frames; i++) mono[i] += ch[i] / channels.length
  const wav = encodeWav16(mono, rendered.sampleRate)
  return { blob: new Blob([wav], { type: 'audio/wav' }), durationS: Math.round((frames / rendered.sampleRate) * 1000) / 1000 }
}
