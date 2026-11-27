/**
 * Mezcla final sin tiempo real: OfflineAudioContext + el MISMO buildGraph y scheduleClips que usa
 * el motor al escuchar. El clic del Estudio no entra: no es parte del grafo.
 *
 * - Modo 'mix': una mezcla estereo por el master, respetando mute y solo.
 * - Modo 'tracks': un archivo estereo por pista, tomado despues del fader y el paneo y sin el
 *   master ni la reverb. Cada pista se renderiza sola (una a la vez, para no tener todas en
 *   memoria) con mute y solo ignorados; todas cubren el mismo tramo, asi quedan alineadas.
 *
 * El compresor y el limitador retrasan la senal unos milisegundos (graph.graphLatency). Aqui se
 * renderiza ese sobrante y se descarta del principio, para que el archivo empiece exactamente en
 * el inicio del tramo: un stem exportado cae alineado con los demas stems de la cancion.
 *
 * Memoria: 20 minutos estereo a 48 kHz son unos 460 MB en coma flotante mas el WAV. Es el limite
 * de la sesion (STUDIO_V1.md 2.8), no el caso normal.
 *
 * v2: las pistas de instrumento se renderizan con los mismos instrumentos que al escuchar
 * (prepareInstruments + buildGraph en el OfflineAudioContext) y sus notas las programa
 * scheduleMidiClips; los instrumentos son deterministas, asi que el archivo suena igual que la
 * escucha. El tramo por defecto suma la cola de los instrumentos (relajaciones y caidas).
 *
 * Funciones puras exportadas (se prueban con node): bounceRange, bounceTrackIds, soloTrackSession.
 */
import { encodeWavPcm } from '../wav.ts'
import { measureWaveShaperLatency } from './fx.ts'
import { buildGraph, graphLatency, prepareGraphContext, reverbTailSeconds, scheduleClips, trackHasSound } from './graph.ts'
import { instrumentTailSeconds } from './instruments/core.ts'
import { prepareInstruments, releaseInstruments } from './instruments/factory.ts'
import { scheduleMidiClips } from './instruments/schedule.ts'
import { integratedLufs, truePeakDb } from './loudness.ts'
import { STUDIO_MAX_SESSION_SECONDS, sessionEndSeconds, type StudioSession } from './session.ts'
import type { BounceApi, BounceFile, BounceOptions, BounceResult, BouncedTrack, LoopRegionS, StudioBuffers } from './types.ts'

// ---------------------------------------------------------------------------
// Logica pura
// ---------------------------------------------------------------------------

/**
 * Tramo a exportar. Si viene `range` se acota a la sesion; si no, va de 0 al fin del ultimo clip
 * activo (audio o MIDI), mas la cola de los instrumentos (siempre: cortar una relajacion hace
 * clic) y la de reverb cuando `withTail` es true. null si no queda nada que exportar.
 */
export function bounceRange(session: StudioSession, range: LoopRegionS | undefined, withTail: boolean): LoopRegionS | null {
  if (range) {
    if (!Number.isFinite(range.startS) || !Number.isFinite(range.endS)) return null
    const startS = Math.max(0, Math.min(range.startS, STUDIO_MAX_SESSION_SECONDS))
    const endS = Math.max(0, Math.min(range.endS, STUDIO_MAX_SESSION_SECONDS))
    return endS > startS ? { startS, endS } : null
  }
  const end = sessionEndSeconds(session)
  if (!(end > 0)) return null
  const tail = instrumentTailSeconds(session) + (withTail ? reverbTailSeconds(session) : 0)
  return { startS: 0, endS: Math.min(STUDIO_MAX_SESSION_SECONDS, end + tail) }
}

/**
 * Pistas que exporta el modo 'tracks': las pedidas que existan, o todas las que tienen algo que
 * suene (clips de audio activos, clips MIDI o congelado).
 */
export function bounceTrackIds(session: StudioSession, trackIds?: readonly string[]): string[] {
  if (trackIds) {
    const wanted = new Set(trackIds)
    return session.tracks.filter((track) => wanted.has(track.id)).map((track) => track.id)
  }
  return session.tracks.filter((track) => trackHasSound(track)).map((track) => track.id)
}

/**
 * La sesion reducida a una sola pista, sin mute ni solo y sin efectos de master: lo que se
 * renderiza para exportar esa pista. null si la pista no existe.
 */
export function soloTrackSession(session: StudioSession, trackId: string): StudioSession | null {
  const track = session.tracks.find((t) => t.id === trackId)
  if (!track) return null
  return { ...session, tracks: [{ ...track, mute: false, solo: false }], master: { ...session.master, fx: [] } }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface Rendered {
  buffer: AudioBuffer
  /** Muestras del principio que son retardo del grafo y no se exportan. */
  skipFrames: number
  /** Muestras utiles despues de `skipFrames`. */
  frames: number
}

function abortError(): DOMException {
  return new DOMException('La exportación se canceló.', 'AbortError')
}

/** Renderiza `session` en [range.startS, range.endS). `tapTrackId` = salida de esa pista en vez del master. */
async function renderOffline(
  session: StudioSession,
  buffers: StudioBuffers,
  sampleRate: number,
  range: LoopRegionS,
  tapTrackId: string | null,
  signal: AbortSignal | undefined,
  onProgress: ((fraction: number) => void) | undefined,
): Promise<Rendered> {
  if (signal?.aborted) throw abortError()
  if (typeof OfflineAudioContext === 'undefined') throw new Error('Este navegador no puede exportar audio (falta OfflineAudioContext).')
  const rate = Math.round(sampleRate)
  if (!(rate > 0)) throw new Error('Frecuencia de muestreo inválida para exportar.')
  const frames = Math.max(1, Math.round((range.endS - range.startS) * rate))
  // El retardo del saturador se mide una vez por frecuencia; tiene que estar antes de la holgura.
  await measureWaveShaperLatency(rate)
  // Holgura para el retardo del grafo: el peor caso es el limitador de respaldo.
  const reserve = Math.ceil(graphLatency(session, rate, false).totalS * rate) + 8
  const offline = new OfflineAudioContext({ numberOfChannels: 2, length: frames + reserve, sampleRate: rate })
  if (tapTrackId === null) await prepareGraphContext(offline)
  const instruments = await prepareInstruments(offline, session)
  if (signal?.aborted) throw abortError()

  const graph = buildGraph(offline, session, buffers, instruments)
  const output = tapTrackId === null ? graph.master : graph.trackOutputs.get(tapTrackId)
  if (!output) {
    graph.dispose()
    throw new Error('La pista que se quiere exportar no existe en la sesión.')
  }
  output.connect(offline.destination)
  const schedule = { fromS: range.startS, atCtxTime: 0, untilS: range.endS }
  const clips = scheduleClips(offline, graph, session, buffers, schedule)
  const notes = scheduleMidiClips(offline, graph, session, buffers, { ...schedule, nowCtxTime: 0 })
  const scheduled = {
    dispose() {
      clips.dispose()
      notes.dispose()
    },
  }
  const latencyS = tapTrackId === null ? graph.latency.totalS : graph.latency.trackBusS
  const skipFrames = Math.min(reserve, Math.round(latencyS * rate))

  const totalS = (frames + reserve) / rate
  const progress = onProgress ? setInterval(() => onProgress(Math.min(1, offline.currentTime / totalS)), 100) : null
  let onAbort: (() => void) | null = null
  try {
    const rendering = offline.startRendering()
    // Un render offline no se puede interrumpir: al abortar se suelta el resultado y sigue solo.
    rendering.catch(() => undefined)
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError())
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const buffer = await Promise.race([rendering, aborted])
    return { buffer, skipFrames, frames }
  } finally {
    if (progress !== null) clearInterval(progress)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
    scheduled.dispose()
    graph.dispose()
    releaseInstruments(offline)
  }
}

/** Canales del tramo util, como vistas sobre el render (sin copiar). */
function usefulChannels(rendered: Rendered): Float32Array[] {
  const channels: Float32Array[] = []
  for (let c = 0; c < rendered.buffer.numberOfChannels; c++) {
    channels.push(rendered.buffer.getChannelData(c).subarray(rendered.skipFrames, rendered.skipFrames + rendered.frames))
  }
  return channels
}

function toFile(rendered: Rendered, sampleRate: number, bitDepth: BounceOptions['bitDepth']): BounceFile {
  const channels = usefulChannels(rendered)
  const rate = Math.round(sampleRate)
  return {
    blob: new Blob([encodeWavPcm(channels, rate, bitDepth)], { type: 'audio/wav' }),
    durationS: rendered.frames / rate,
    lufs: integratedLufs(channels, rate),
    truePeakDb: truePeakDb(channels, rate),
  }
}

export async function renderMix(session: StudioSession, buffers: StudioBuffers, options: Pick<BounceOptions, 'sampleRate' | 'range' | 'signal'>): Promise<AudioBuffer> {
  const range = bounceRange(session, options.range, true)
  if (!range) throw new Error('No hay audio para exportar: la sesión no tiene clips activos en ese tramo.')
  const rendered = await renderOffline(session, buffers, options.sampleRate, range, null, options.signal, undefined)
  if (rendered.skipFrames === 0 && rendered.buffer.length === rendered.frames) return rendered.buffer
  // Se copia solo aqui, donde hay que entregar un AudioBuffer que empiece en el tramo.
  const trimmed = new AudioBuffer({ numberOfChannels: rendered.buffer.numberOfChannels, length: rendered.frames, sampleRate: rendered.buffer.sampleRate })
  usefulChannels(rendered).forEach((channel, c) => trimmed.copyToChannel(channel as Float32Array<ArrayBuffer>, c))
  return trimmed
}

export async function bounce(session: StudioSession, buffers: StudioBuffers, options: BounceOptions): Promise<BounceResult> {
  if (options.bitDepth !== 16 && options.bitDepth !== 24) throw new Error('La exportación es de 16 o 24 bits.')
  if (options.mode === 'mix') {
    const range = bounceRange(session, options.range, true)
    if (!range) throw new Error('No hay audio para exportar: la sesión no tiene clips activos en ese tramo.')
    const rendered = await renderOffline(session, buffers, options.sampleRate, range, null, options.signal, options.onProgress)
    const mix = toFile(rendered, options.sampleRate, options.bitDepth)
    options.onProgress?.(1)
    return { mode: 'mix', mix }
  }

  const range = bounceRange(session, options.range, false)
  const ids = bounceTrackIds(session, options.trackIds)
  if (!range || ids.length === 0) throw new Error('No hay pistas con audio para exportar en ese tramo.')
  const tracks: BouncedTrack[] = []
  for (let i = 0; i < ids.length; i++) {
    const solo = soloTrackSession(session, ids[i])
    if (!solo) continue
    const track = solo.tracks[0]
    const onProgress = options.onProgress
    const rendered = await renderOffline(solo, buffers, options.sampleRate, range, track.id, options.signal, onProgress ? (fraction) => onProgress((i + fraction) / ids.length) : undefined)
    tracks.push({ ...toFile(rendered, options.sampleRate, options.bitDepth), trackId: track.id, name: track.name, role: track.role })
  }
  options.onProgress?.(1)
  return { mode: 'tracks', tracks }
}

void ({ bounce, renderMix } satisfies BounceApi)
