/**
 * Programacion de los clips MIDI contra los instrumentos del grafo (STUDIO_V2.md 2.4), con la
 * misma alineacion que graph.scheduleClips: la posicion `fromS` de la sesion suena en
 * `atCtxTime`, y cada nota cae en la rejilla de muestras de esa tanda.
 *
 * - Tiempo real (AudioContext): las notas se programan por ventanas, MIDI_LOOKAHEAD_S por delante
 *   del reloj, desde un intervalo. El intervalo solo agenda con anticipacion: el audio nunca
 *   depende de su puntualidad. Asi no se crean de golpe los nodos de 16384 notas, y un cambio de
 *   parametros del instrumento se oye en menos de un segundo.
 * - Offline (bounce): por tramos de OFFLINE_CHUNK_S con OfflineAudioContext.suspend(), para no
 *   tener todos los nodos vivos a la vez; si el navegador no tiene suspend en offline, todas las
 *   notas de una vez. El orden de las notas es el mismo en los dos casos, asi que el robo de voces
 *   tambien: lo que suena es lo que se exporta.
 * - Pistas de instrumento sin instrumento disponible: suena su congelado, como un clip de audio
 *   desde el segundo 0 con su duracion completa (graph.scheduleClips).
 */
import { scheduleClips } from '../graph.ts'
import type { StudioClip, StudioSession, StudioTrack } from '../session.ts'
import type { ScheduleMidiOptions, ScheduledClips, StudioBuffers, StudioGraph, StudioInstrumentNode } from '../types.ts'
import { midiEndSeconds, planMidiNotes } from './core.ts'
import { PolyInstrument } from './voices.ts'

/** Con cuanta anticipacion se programan las notas en tiempo real. */
export const MIDI_LOOKAHEAD_S = 1
/** Cada cuanto se agenda la ventana siguiente en tiempo real. */
export const MIDI_TICK_MS = 100
/** Tramo de notas que se programa en cada pausa del render offline. */
export const OFFLINE_CHUNK_S = 10
/** Cuanto antes del tramo se pausa el render offline para programarlo. */
export const OFFLINE_SUSPEND_LEAD_S = 0.5
/** Una nota mas corta que esto (despues de recortarla) no se programa. */
const MIN_NOTE_S = 0.0005

/**
 * La sesion reducida a los congelados que deben sonar: pistas de instrumento con
 * `frozenAssetId` cuyo instrumento NO esta en `availableTrackIds`, cada una con un clip de audio
 * desde el segundo 0 con la duracion completa del audio. null si no hay ninguno. Puro.
 */
export function frozenPlaybackSession(session: StudioSession, availableTrackIds: ReadonlySet<string>, trackIds?: ReadonlySet<string>): StudioSession | null {
  const tracks: StudioTrack[] = []
  for (const track of session.tracks) {
    if (track.kind !== 'instrument' || !track.frozenAssetId || availableTrackIds.has(track.id)) continue
    if (trackIds && !trackIds.has(track.id)) continue
    const asset = session.assets.find((a) => a.id === track.frozenAssetId)
    if (!asset || !(asset.durationS > 0)) continue
    const clip: StudioClip = {
      id: `frozen_${track.id}`,
      assetId: asset.id,
      startS: 0,
      offsetS: 0,
      lengthS: asset.durationS,
      gainDb: 0,
      fadeInS: 0,
      fadeOutS: 0,
      takeGroup: null,
      active: true,
    }
    tracks.push({ ...track, clips: [clip] })
  }
  return tracks.length > 0 ? { ...session, tracks } : null
}

function isOffline(ctx: BaseAudioContext): ctx is OfflineAudioContext {
  return typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext
}

export function scheduleMidiClips(ctx: BaseAudioContext, graph: StudioGraph, session: StudioSession, buffers: StudioBuffers, options: ScheduleMidiOptions): ScheduledClips {
  const sampleRate = ctx.sampleRate
  const baseFrame = Math.round(Math.max(0, options.atCtxTime) * sampleRate)
  const fromS = options.fromS
  const untilS = options.untilS ?? Number.POSITIVE_INFINITY
  const instruments: ReadonlyMap<string, StudioInstrumentNode> = graph.instruments ?? new Map()

  const nodes = new Map<string, StudioInstrumentNode>()
  const playing = new Set<string>()
  for (const track of session.tracks) {
    if (track.kind !== 'instrument') continue
    if (options.trackIds && !options.trackIds.has(track.id)) continue
    const node = instruments.get(track.id)
    if (!node) continue
    nodes.set(track.id, node)
    if ((track.midiClips ?? []).length > 0) playing.add(track.id)
  }
  const frozen = frozenPlaybackSession(session, new Set(instruments.keys()), options.trackIds)
  const frozenBatch = frozen ? scheduleClips(ctx, graph, frozen, buffers, options) : null

  /** Marca de esta tanda en las voces: detenerla no toca las notas de otras tandas. */
  const owner = {}
  const offline = isOffline(ctx)
  const notBefore = options.nowCtxTime ?? (offline ? 0 : ctx.currentTime)
  const endS = Math.min(untilS, midiEndSeconds(session, playing))
  const toCtx = (s: number) => (baseFrame + Math.round((s - fromS) * sampleRate)) / sampleRate
  let cursor = fromS
  let chase = true
  let stopped = false
  let disposed = false
  let timer: ReturnType<typeof setInterval> | null = null

  const clearTimer = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  /** Programa las notas que empiezan entre el cursor y `toS` (la primera vez, tambien las que ya sonaban). */
  const pump = (toS: number) => {
    if (stopped || disposed || playing.size === 0) return
    const limit = Math.max(cursor, Math.min(toS, endS))
    if (!(limit > cursor) && !chase) return
    const notes = planMidiNotes(session, { fromS: cursor, toS: limit, untilS, trackIds: playing, chase })
    chase = false
    cursor = limit
    for (const note of notes) {
      const node = nodes.get(note.trackId)
      if (!node) continue
      const start = Math.max(toCtx(Math.max(note.startS, fromS)), notBefore)
      const end = toCtx(note.endS)
      if (!(end - start > MIN_NOTE_S)) continue
      if (node instanceof PolyInstrument) node.playNoteOwned(note.pitch, note.velocity, start, end, owner)
      else node.playNote(note.pitch, note.velocity, start, end)
    }
  }

  if (playing.size > 0) {
    if (offline) {
      const chunked = typeof ctx.suspend === 'function' && Number.isFinite(endS) && endS - fromS > OFFLINE_CHUNK_S
      if (!chunked) {
        pump(endS)
      } else {
        pump(fromS + OFFLINE_CHUNK_S)
        for (let boundary = fromS + OFFLINE_CHUNK_S; boundary < endS; boundary += OFFLINE_CHUNK_S) {
          const chunkEnd = boundary + OFFLINE_CHUNK_S
          let pause: Promise<void>
          try {
            pause = ctx.suspend(toCtx(boundary) - OFFLINE_SUSPEND_LEAD_S)
          } catch {
            pump(endS)
            break
          }
          pause
            .then(() => {
              try {
                pump(chunkEnd)
              } catch {
                // Una nota que no se pudo programar no debe dejar el render en pausa para siempre.
              }
              return ctx.resume()
            })
            // Rechazo = esa pausa cae despues del final del render: sus notas no se oirian igual.
            .catch(() => undefined)
        }
      }
    } else {
      const horizon = () => Math.max(fromS, fromS + (ctx.currentTime + MIDI_LOOKAHEAD_S - options.atCtxTime))
      pump(horizon())
      if (cursor < endS) {
        timer = setInterval(() => {
          if (stopped || disposed) return clearTimer()
          pump(horizon())
          if (cursor >= endS) clearTimer()
        }, MIDI_TICK_MS)
      }
    }
  }

  return {
    stop(atCtxTime?: number) {
      if (disposed) return
      stopped = true
      clearTimer()
      const at = Math.max(atCtxTime ?? ctx.currentTime, ctx.currentTime)
      for (const node of nodes.values()) {
        if (node instanceof PolyInstrument) node.stopOwner(owner, at)
        else node.allNotesOff(at)
      }
      frozenBatch?.stop(atCtxTime)
    },
    dispose() {
      if (disposed) return
      disposed = true
      stopped = true
      clearTimer()
      for (const node of nodes.values()) {
        if (node instanceof PolyInstrument) node.disposeOwner(owner)
        else node.allNotesOff()
      }
      frozenBatch?.dispose()
    },
  }
}
