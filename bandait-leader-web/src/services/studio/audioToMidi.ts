/**
 * Audio a MIDI en el navegador, sin costo por uso (docs/PLAN_ESTUDIO_V2.md seccion 7), con
 * Basic Pitch de Spotify (`@spotify/basic-pitch` 1.0.1, licencia Apache-2.0, modelo incluido en el
 * paquete bajo la misma licencia). Depende de TensorFlow.js 3 (`@tensorflow/tfjs` 3.21.0,
 * Apache-2.0), fijado tambien en package.json porque este modulo lo importa directamente.
 *
 * Todo se carga de forma PEREZOSA (import dinamico): ni TensorFlow.js ni el modelo entran al
 * bundle principal del Hub; se descargan la primera vez que alguien transcribe. El modelo
 * (model.json y su archivo de pesos) se importa con `?url` de Vite y se carga con un IOHandler
 * propio, porque el nombre con hash que Vite le pone al .bin no coincide con el que model.json
 * declara (tf.loadGraphModel(url) lo buscaria junto al .json y no lo encontraria).
 *
 * Basic Pitch espera audio mono a 22 050 Hz: el buffer se remuestrea con un OfflineAudioContext
 * (remuestreo del propio navegador) antes de evaluarlo.
 *
 * Las conversiones puras (eventos de Basic Pitch -> notas en beats) se prueban en
 * scripts/verify-studio-v2-input.ts; la transcripcion necesita el navegador.
 */
import {
  STUDIO_MAX_BEAT,
  STUDIO_MAX_NOTES_PER_CLIP,
  STUDIO_MIDI_MIN_CLIP_BEATS,
  STUDIO_MIDI_MIN_NOTE_BEATS,
  roundBeat,
  secondsToBeats,
  type StudioMidiNote,
} from './session.ts'
import { normalizeNotes } from './midiOps.ts'
import type { AudioToMidiApi, AudioToMidiAvailability, AudioToMidiOptions } from './types.ts'

/** Frecuencia que espera el modelo (AUDIO_SAMPLE_RATE de Basic Pitch). */
export const BASIC_PITCH_SAMPLE_RATE = 22050
/**
 * Cuadros del modelo por segundo: 22050 / 256 (FFT_HOP de Basic Pitch en Python). NO VERIFICADO
 * en la documentacion del paquete de TypeScript: se usa solo para pasar `minNoteMs` a cuadros;
 * el largo minimo se vuelve a aplicar en segundos sobre el resultado.
 */
export const BASIC_PITCH_FRAMES_PER_SECOND = 22050 / 256
export const AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_MS = 60
/** Umbrales del ejemplo del README de basic-pitch-ts (onset 0.25, frame 0.25). */
export const AUDIO_TO_MIDI_DEFAULT_ONSET = 0.25
export const AUDIO_TO_MIDI_DEFAULT_FRAME = 0.25
/** Tope de audio que se transcribe de una vez: 10 minutos. */
export const AUDIO_TO_MIDI_MAX_SECONDS = 600

const MODEL_NAME = 'Basic Pitch (Spotify) 1.0.1'
const MODEL_LICENSE = 'Apache-2.0'

/** Evento de nota como lo devuelve noteFramesToTime de Basic Pitch. */
export interface BasicPitchNoteEvent {
  startTimeSeconds: number
  durationSeconds: number
  pitchMidi: number
  /** 0..1 */
  amplitude: number
}

export interface NoteEventsToStudioOptions {
  bpm: number
  /** Duracion del audio transcrito: las notas no pasan de ahi. */
  durationS: number
  minNoteMs?: number
  lowPitch?: number
  highPitch?: number
}

/** Velocidad MIDI desde la amplitud del modelo (0..1): 1 + amplitud * 126, acotada a 1..127. */
export function amplitudeToVelocity(amplitude: number): number {
  const a = Number.isFinite(amplitude) ? Math.min(1, Math.max(0, amplitude)) : 0
  return Math.min(127, Math.max(1, Math.round(1 + a * 126)))
}

/**
 * Eventos de Basic Pitch -> notas del Estudio (puro). Tiempos en beats relativos al inicio del
 * audio, con el tempo de la sesion. Descarta notas mas cortas que `minNoteMs`, fuera del rango de
 * pitch o con datos invalidos; normaliza (orden y solapes del mismo pitch, midiOps) y corta en
 * STUDIO_MAX_NOTES_PER_CLIP.
 */
export function noteEventsToStudioNotes(events: readonly BasicPitchNoteEvent[], options: NoteEventsToStudioOptions): StudioMidiNote[] {
  const { bpm } = options
  if (!Number.isFinite(bpm) || bpm <= 0) return []
  const minS = Math.max(0, options.minNoteMs ?? AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_MS) / 1000
  const low = Math.max(0, Math.min(127, Math.round(options.lowPitch ?? 0)))
  const high = Math.max(low, Math.min(127, Math.round(options.highPitch ?? 127)))
  const clipLength = Math.min(STUDIO_MAX_BEAT, Math.max(STUDIO_MIDI_MIN_CLIP_BEATS, roundBeat(secondsToBeats(options.durationS, bpm))))
  const notes: StudioMidiNote[] = []
  for (const e of events) {
    if (!Number.isFinite(e.startTimeSeconds) || !Number.isFinite(e.durationSeconds) || !Number.isFinite(e.pitchMidi)) continue
    const pitch = Math.round(e.pitchMidi)
    if (pitch < low || pitch > high) continue
    if (e.durationSeconds < minS || e.startTimeSeconds < 0) continue
    const start = roundBeat(secondsToBeats(e.startTimeSeconds, bpm))
    if (start >= clipLength) continue
    const length = Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, roundBeat(secondsToBeats(e.durationSeconds, bpm)))
    notes.push({ pitch, start, length, velocity: amplitudeToVelocity(e.amplitude) })
  }
  const normalized = normalizeNotes(notes, clipLength)
  return normalized.length > STUDIO_MAX_NOTES_PER_CLIP ? normalized.slice(0, STUDIO_MAX_NOTES_PER_CLIP) : normalized
}

/** Largo minimo de nota en cuadros del modelo (lo que espera outputToNotesPoly). */
export function minNoteFrames(minNoteMs: number): number {
  const ms = Number.isFinite(minNoteMs) && minNoteMs > 0 ? minNoteMs : AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_MS
  return Math.max(1, Math.round((ms / 1000) * BASIC_PITCH_FRAMES_PER_SECOND))
}

// ---------------------------------------------------------------------------
// Carga perezosa del modelo
// ---------------------------------------------------------------------------

/** Lo que se usa del modulo @spotify/basic-pitch (firmas de su types/index.d.ts 1.0.1). */
interface BasicPitchModule {
  BasicPitch: new (model: string | Promise<unknown>) => {
    evaluateModel(
      buffer: AudioBuffer | Float32Array,
      onComplete: (frames: number[][], onsets: number[][], contours: number[][]) => void,
      percentCallback: (percent: number) => void,
    ): Promise<void>
  }
  outputToNotesPoly(
    frames: number[][],
    onsets: number[][],
    onsetThresh?: number,
    frameThresh?: number,
    minNoteLen?: number,
  ): unknown[]
  addPitchBendsToNoteEvents(contours: number[][], notes: unknown[]): unknown[]
  noteFramesToTime(notes: unknown[]): BasicPitchNoteEvent[]
}

interface LoadedModel {
  mod: BasicPitchModule
  basicPitch: InstanceType<BasicPitchModule['BasicPitch']>
}

let modelPromise: Promise<LoadedModel> | null = null

/**
 * Carga TensorFlow.js, Basic Pitch y su modelo una sola vez por pestana. Si falla, se olvida el
 * intento para poder reintentar.
 */
function loadModel(): Promise<LoadedModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const [mod, tf, jsonUrl, weightsUrl] = await Promise.all([
        import('@spotify/basic-pitch') as Promise<unknown> as Promise<BasicPitchModule>,
        import('@tensorflow/tfjs'),
        import('@spotify/basic-pitch/model/model.json?url').then((m) => m.default),
        import('@spotify/basic-pitch/model/group1-shard1of1.bin?url').then((m) => m.default),
      ])
      const graph = tf.loadGraphModel({
        // IOHandler propio (interfaz tf.io.IOHandler de tfjs 3): model.json y pesos por separado.
        load: async () => {
          const [jsonRes, weightsRes] = await Promise.all([fetch(jsonUrl), fetch(weightsUrl)])
          if (!jsonRes.ok || !weightsRes.ok) throw new Error('No se pudo descargar el modelo de audio a MIDI.')
          const json = (await jsonRes.json()) as {
            modelTopology: unknown
            format?: string
            generatedBy?: string
            convertedBy?: string | null
            signature?: unknown
            userDefinedMetadata?: Record<string, unknown>
            weightsManifest: Array<{ weights: unknown[] }>
          }
          const weightSpecs = json.weightsManifest.flatMap((group) => group.weights)
          return {
            modelTopology: json.modelTopology as never,
            format: json.format,
            generatedBy: json.generatedBy,
            convertedBy: json.convertedBy,
            signature: json.signature as never,
            userDefinedMetadata: json.userDefinedMetadata as never,
            weightSpecs: weightSpecs as never,
            weightData: await weightsRes.arrayBuffer(),
          }
        },
      })
      return { mod, basicPitch: new mod.BasicPitch(graph) }
    })()
    modelPromise.catch(() => {
      modelPromise = null
    })
  }
  return modelPromise
}

/** Mono a 22 050 Hz con el remuestreo del navegador. */
async function resampleForModel(buffer: AudioBuffer): Promise<AudioBuffer> {
  if (buffer.numberOfChannels === 1 && buffer.sampleRate === BASIC_PITCH_SAMPLE_RATE) return buffer
  const length = Math.max(1, Math.ceil(buffer.duration * BASIC_PITCH_SAMPLE_RATE))
  const offline = new OfflineAudioContext(1, length, BASIC_PITCH_SAMPLE_RATE)
  const source = offline.createBufferSource()
  source.buffer = buffer
  // Con un destino mono el navegador mezcla los canales (regla "speakers" de Web Audio).
  source.connect(offline.destination)
  source.start(0)
  return offline.startRendering()
}

function abortError(): DOMException {
  return new DOMException('Se canceló la transcripción.', 'AbortError')
}

function supported(): boolean {
  return typeof OfflineAudioContext !== 'undefined' && typeof fetch === 'function'
}

export function availability(): AudioToMidiAvailability {
  if (!supported()) {
    return { available: false, reason: 'Este navegador no tiene lo necesario para pasar audio a MIDI (Web Audio sin conexión).', model: MODEL_NAME, license: MODEL_LICENSE }
  }
  return { available: true, reason: null, model: MODEL_NAME, license: MODEL_LICENSE }
}

/**
 * Notas en beats relativos al INICIO del buffer. La primera vez descarga el modelo (unos pocos
 * MB). Abortar rechaza de inmediato con AbortError; la evaluacion en curso termina en segundo
 * plano y su resultado se descarta (Basic Pitch no admite cancelar a mitad).
 */
export async function transcribe(buffer: AudioBuffer, options: AudioToMidiOptions): Promise<StudioMidiNote[]> {
  const state = availability()
  if (!state.available) throw new Error(state.reason ?? 'Audio a MIDI no está disponible.')
  if (!Number.isFinite(options.bpm) || options.bpm <= 0) throw new Error('El tempo de la sesión no es válido.')
  if (!(buffer.duration > 0)) throw new Error('El audio está vacío.')
  if (buffer.duration > AUDIO_TO_MIDI_MAX_SECONDS) throw new Error('Para pasar a MIDI, el audio debe durar 10 minutos o menos. Recórtalo primero.')
  const signal = options.signal
  if (signal?.aborted) throw abortError()

  const work = (async () => {
    const { mod, basicPitch } = await loadModel()
    if (signal?.aborted) throw abortError()
    const resampled = await resampleForModel(buffer)
    if (signal?.aborted) throw abortError()
    const frames: number[][] = []
    const onsets: number[][] = []
    const contours: number[][] = []
    await basicPitch.evaluateModel(
      resampled,
      (f, o, c) => {
        frames.push(...f)
        onsets.push(...o)
        contours.push(...c)
      },
      (percent) => {
        if (!signal?.aborted && Number.isFinite(percent)) options.onProgress?.(Math.min(1, Math.max(0, percent)))
      },
    )
    if (signal?.aborted) throw abortError()
    const onset = options.onsetThreshold !== undefined && Number.isFinite(options.onsetThreshold) ? Math.min(1, Math.max(0, options.onsetThreshold)) : AUDIO_TO_MIDI_DEFAULT_ONSET
    const minNoteMs = options.minNoteMs ?? AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_MS
    const raw = mod.outputToNotesPoly(frames, onsets, onset, AUDIO_TO_MIDI_DEFAULT_FRAME, minNoteFrames(minNoteMs))
    const events = mod.noteFramesToTime(mod.addPitchBendsToNoteEvents(contours, raw))
    options.onProgress?.(1)
    return noteEventsToStudioNotes(events, {
      bpm: options.bpm,
      durationS: buffer.duration,
      minNoteMs,
      lowPitch: options.lowPitch,
      highPitch: options.highPitch,
    })
  })()

  if (!signal) return work
  return new Promise<StudioMidiNote[]>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (notes) => {
        signal.removeEventListener('abort', onAbort)
        resolve(notes)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

void ({ availability, transcribe } satisfies AudioToMidiApi)
