/**
 * Documento de sesion del Estudio Bandait. Contrato normativo: bandait-protocol/STUDIO_V2.md
 * (lo que cambia) sobre bandait-protocol/STUDIO_V1.md (lo demas); ejemplos canonicos:
 * bandait-protocol/fixtures/studio_session_v2.json y, para la migracion,
 * bandait-protocol/fixtures/studio_session.json (v1).
 *
 * Este modulo es la UNICA frontera snake_case <-> camelCase del Estudio: en el cable (Worker,
 * R2, IndexedDB) el documento va en snake_case; dentro del Hub se usa `StudioSession` en
 * camelCase. `parseSession` valida y traduce lo que llega (version 1 o 2; la 1 se migra a 2);
 * `serializeSession` valida y traduce lo que sale, siempre en version 2. La validacion es
 * estricta: un campo desconocido, ausente o fuera de rango lanza `StudioSessionError` con
 * `code`, `path` y un mensaje en espanol.
 *
 * Forma de las pistas en el Hub: TODA pista tiene `kind`, `clips`, `instrument`, `midiClips` y
 * `frozenAssetId`, para que el codigo de v1 (que recorre `track.clips`) siga funcionando sin
 * cambios. Una pista 'audio' lleva `instrument: null`, `midiClips: []` y `frozenAssetId: null`;
 * una pista 'instrument' lleva `clips: []`. `serializeSession` rechaza una pista que no cumple
 * esa regla (no la corrige en silencio).
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env (se prueba con
 * node --experimental-strip-types en scripts/verify-studio-logic.ts).
 */
import { isStemRole, type StemRole } from '../stemNames.ts'

// ---------------------------------------------------------------------------
// Limites y constantes (STUDIO_V1.md secciones 1 y 2; STUDIO_V2.md seccion 2)
// ---------------------------------------------------------------------------

/** Version que escribe este Hub. */
export const STUDIO_SESSION_VERSION = 2
/** Versiones que este Hub sabe leer. La 1 se migra al leer (STUDIO_V2.md 1). */
export const STUDIO_SESSION_VERSIONS: readonly number[] = [1, 2]

export const STUDIO_MAX_TRACKS = 16
export const STUDIO_MAX_SESSION_SECONDS = 1200
/** Tope del documento serializado (UTF-8): 1 MiB desde v2 (STUDIO_V2.md 2.5). En v1 era 256 KB. */
export const STUDIO_MAX_DOCUMENT_BYTES = 1024 * 1024
export const STUDIO_MAX_ASSET_BYTES = 200 * 1024 * 1024
export const STUDIO_MAX_ASSETS = 256
export const STUDIO_MAX_CLIPS_PER_TRACK = 256
export const STUDIO_MAX_TITLE = 120
export const STUDIO_MAX_TRACK_NAME = 60
export const STUDIO_MAX_ASSET_LABEL = 120
export const STUDIO_MAX_KEY = 12
export const STUDIO_MAX_PROMPT = 1000

export const STUDIO_BPM_MIN = 40
export const STUDIO_BPM_MAX = 260
export const STUDIO_BEATS_PER_BAR_MIN = 1
export const STUDIO_BEATS_PER_BAR_MAX = 12
export const STUDIO_LATENCY_OFFSET_MS_MIN = -500
export const STUDIO_LATENCY_OFFSET_MS_MAX = 500

/** Fader de pista y de master. -60 o menos es silencio (igual que stemTiming.dbToGain). */
export const STUDIO_VOLUME_DB_MIN = -60
export const STUDIO_VOLUME_DB_MAX = 12
export const STUDIO_CLIP_GAIN_DB_MIN = -60
export const STUDIO_CLIP_GAIN_DB_MAX = 24
/** Envio a la reverb compartida. -60 es sin envio. */
export const STUDIO_REVERB_SEND_DB_MIN = -60
export const STUDIO_REVERB_SEND_DB_MAX = 0
export const STUDIO_REVERB_DECAY_S_MIN = 0.2
export const STUDIO_REVERB_DECAY_S_MAX = 10
export const STUDIO_REVERB_RETURN_DB_MIN = -60
export const STUDIO_REVERB_RETURN_DB_MAX = 12

export const STUDIO_MIN_CLIP_SECONDS = 0.01
/** Tolerancia al comparar la ventana de un clip con su audio y con el fin de la sesion. */
export const STUDIO_TIME_EPSILON_S = 0.001
/** Tolerancia al comparar los fades con el largo del clip. */
export const STUDIO_FADE_EPSILON_S = 0.000001

/** Frecuencias de muestreo admitidas para una sesion (la del AudioContext al crearla). */
export const STUDIO_SAMPLE_RATES: readonly number[] = [44100, 48000, 88200, 96000]
export const STUDIO_ASSET_SAMPLE_RATE_MIN = 8000
export const STUDIO_ASSET_SAMPLE_RATE_MAX = 192000

/** Patron de todo id del Estudio (sesion, audio, pista, clip, take_group, marca, trabajo). */
export const STUDIO_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
/** Id reservado para el bus master (sugerencias del asistente, setTrackFx). No es una pista. */
export const STUDIO_MASTER_ID = 'master'

export const STUDIO_ASSET_EXTENSIONS = ['wav', 'flac', 'mp3'] as const
export const STUDIO_ASSET_KINDS = ['recording', 'import', 'stem', 'generated', 'bounce', 'master'] as const
export const STUDIO_PROVIDERS = ['musicai', 'lyria', 'suno'] as const
export const STUDIO_FX_TYPES_V1 = ['eq', 'compressor', 'limiter'] as const
export const STUDIO_FX_TYPES = ['eq', 'compressor', 'de_esser', 'saturator', 'stereo_imager', 'limiter'] as const
export const STUDIO_CLIP_FADE_SHAPES = ['linear', 'exp', 'scurve'] as const
export type StudioClipFadeShape = (typeof STUDIO_CLIP_FADE_SHAPES)[number]

/** Frecuencias fijas del EQ (STUDIO_V1.md 2.6). */
export const STUDIO_EQ_LOW_SHELF_HZ = 120
export const STUDIO_EQ_HIGH_SHELF_HZ = 8000
export const STUDIO_EQ_HPF_Q = 0.707
/** Anticipacion fija del limitador, en milisegundos. */
export const STUDIO_LIMITER_LOOKAHEAD_MS = 5

// --- v2: pistas de instrumento, MIDI y marcas (STUDIO_V2.md 2) ---

export const STUDIO_TRACK_KINDS = ['audio', 'instrument'] as const
export const STUDIO_INSTRUMENT_TYPES = ['synth', 'drums', 'sampler', 'wam'] as const

export const STUDIO_MAX_MIDI_CLIPS_PER_TRACK = 256
export const STUDIO_MAX_NOTES_PER_CLIP = 4096
export const STUDIO_MAX_NOTES_PER_SESSION = 16384
export const STUDIO_MAX_SAMPLER_ZONES = 64
export const STUDIO_MAX_WAM_STATE_BYTES = 16384
export const STUDIO_MAX_MARKERS = 256
export const STUDIO_MAX_MARKER_LABEL = 60
/** Acordes de referencia del documento (STUDIO_V2.md 2.9). */
export const STUDIO_MAX_SESSION_CHORDS = 2048
export const STUDIO_MAX_SESSION_CHORD_NAME = 16
/** Beat maximo de cualquier valor en beats: 1200 s a 260 BPM. */
export const STUDIO_MAX_BEAT = 5200
/** Largo minimo de un clip MIDI y de su patron de repeticion. */
export const STUDIO_MIDI_MIN_CLIP_BEATS = 0.0625
/** Largo minimo de una nota (1/64 de beat). */
export const STUDIO_MIDI_MIN_NOTE_BEATS = 0.015625
/** Tolerancia al comparar el fin de una nota con el inicio de la siguiente del mismo pitch. */
export const STUDIO_NOTE_EPSILON_BEATS = 0.000001
/** Voces por pista de instrumento antes de robar (STUDIO_V2.md 2.3). */
export const STUDIO_INSTRUMENT_POLYPHONY = 32
/** Rampa con la que se apaga una voz robada o un hi-hat abierto cortado, en segundos. */
export const STUDIO_VOICE_STEAL_RAMP_S = 0.005
/** Patron del id de un plugin WAM (STUDIO_V2.md 2.3.4). */
export const STUDIO_WAM_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/

export const STUDIO_MARKER_KINDS = ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'solo', 'interlude', 'break', 'outro', 'marker'] as const

// ---------------------------------------------------------------------------
// Tipos del Hub (camelCase)
// ---------------------------------------------------------------------------

export type StudioAssetExtension = (typeof STUDIO_ASSET_EXTENSIONS)[number]
export type StudioAssetKind = (typeof STUDIO_ASSET_KINDS)[number]
export type StudioProvider = (typeof STUDIO_PROVIDERS)[number]
export type StudioFxType = (typeof STUDIO_FX_TYPES)[number]
export type StudioTrackKind = (typeof STUDIO_TRACK_KINDS)[number]
export type StudioInstrumentType = (typeof STUDIO_INSTRUMENT_TYPES)[number]
export type StudioMarkerKind = (typeof STUDIO_MARKER_KINDS)[number]

/** Origen de un audio generado o procesado por un proveedor. */
export interface StudioAssetSource {
  provider: StudioProvider
  jobId: string
  /** Solo en generacion. */
  prompt?: string
}

/** Audio inmutable de la sesion. `file` es su nombre en OPFS, en R2 y en las rutas del Worker. */
export interface StudioAsset {
  id: string
  /** Exactamente `${id}.${ext}`, con ext wav | flac | mp3. */
  file: string
  kind: StudioAssetKind
  /** Nombre para mostrar (archivo original, "Toma 3"). Puede ser ''. */
  label: string
  channels: 1 | 2
  /** Frecuencia real del archivo; puede diferir de la de la sesion. */
  sampleRate: number
  durationS: number
  /** Bytes del archivo. */
  size: number
  /** Obligatorio cuando kind es 'generated'. */
  source: StudioAssetSource | null
}

export interface EqParams {
  /** Pasa altos; 0 = apagado. */
  hpfHz: number
  lowDb: number
  midHz: number
  midDb: number
  midQ: number
  highDb: number
}

export interface CompressorParams {
  thresholdDb: number
  ratio: number
  attackMs: number
  releaseMs: number
  kneeDb: number
  makeupDb: number
}

export interface DeEsserParams {
  freqHz: number
  thresholdDb: number
  reductionDb: number
}

export interface SaturatorParams {
  driveDb: number
  toneDb: number
  mix: number
  outputDb: number
}

export interface StereoImagerParams {
  width: number
  monoBassHz: number
}

export interface LimiterParams {
  ceilingDb: number
  releaseMs: number
}

export interface StudioFxParamsByType {
  eq: EqParams
  compressor: CompressorParams
  de_esser: DeEsserParams
  saturator: SaturatorParams
  stereo_imager: StereoImagerParams
  limiter: LimiterParams
}

export interface EqFx {
  type: 'eq'
  bypass: boolean
  params: EqParams
}

export interface CompressorFx {
  type: 'compressor'
  bypass: boolean
  params: CompressorParams
}

export interface DeEsserFx {
  type: 'de_esser'
  bypass: boolean
  params: DeEsserParams
}

export interface SaturatorFx {
  type: 'saturator'
  bypass: boolean
  params: SaturatorParams
}

export interface StereoImagerFx {
  type: 'stereo_imager'
  bypass: boolean
  params: StereoImagerParams
}

/** Solo valido en el master, y de ultimo. */
export interface LimiterFx {
  type: 'limiter'
  bypass: boolean
  params: LimiterParams
}

export type StudioFx = EqFx | CompressorFx | DeEsserFx | SaturatorFx | StereoImagerFx | LimiterFx

export interface StudioClip {
  id: string
  assetId: string
  /** Posicion del clip en la sesion, en segundos. */
  startS: number
  /** Donde empieza la ventana dentro del audio. */
  offsetS: number
  /** Largo de la ventana. */
  lengthS: number
  gainDb: number
  fadeInS: number
  fadeOutS: number
  /** Tomas alternativas del mismo pasaje comparten grupo (local a la pista). */
  takeGroup: string | null
  /** Un clip inactivo no suena ni se exporta. */
  active: boolean
  /** Inversion de polaridad (180 grados). Ausente o false = fase normal. */
  phaseInvert?: boolean
  /** Forma matematica de los fundidos de entrada y salida. Por defecto 'linear'. */
  fadeShape?: StudioClipFadeShape
}

// --- Instrumentos (STUDIO_V2.md 2.3) ---

export const STUDIO_SYNTH_WAVES = ['sine', 'triangle', 'sawtooth', 'square'] as const
export const STUDIO_SYNTH_FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'] as const
export const STUDIO_SYNTH_LFO_TARGETS = ['off', 'pitch', 'filter', 'amp'] as const
export const STUDIO_SAMPLER_MODES = ['sustain', 'one_shot'] as const

export type SynthWave = (typeof STUDIO_SYNTH_WAVES)[number]
export type SynthFilterType = (typeof STUDIO_SYNTH_FILTER_TYPES)[number]
export type SynthLfoTarget = (typeof STUDIO_SYNTH_LFO_TARGETS)[number]
export type SamplerMode = (typeof STUDIO_SAMPLER_MODES)[number]

/** Parametros del sintetizador (STUDIO_V2.md 2.3.1). Tiempos en ms, niveles 0..1. */
export interface SynthParams {
  osc1Wave: SynthWave
  /** Entero -2..2. */
  osc1Octave: number
  osc1DetuneCents: number
  osc1Level: number
  osc2Wave: SynthWave
  osc2Octave: number
  osc2DetuneCents: number
  osc2Level: number
  noiseLevel: number
  filterType: SynthFilterType
  filterCutoffHz: number
  /** Q del filtro. */
  filterResonance: number
  /** Octavas que la envolvente mueve el corte (puede ser negativo). */
  filterEnvOctaves: number
  filterAttackMs: number
  filterDecayMs: number
  filterSustain: number
  filterReleaseMs: number
  ampAttackMs: number
  ampDecayMs: number
  ampSustain: number
  ampReleaseMs: number
  lfoWave: SynthWave
  lfoRateHz: number
  lfoTarget: SynthLfoTarget
  lfoDepth: number
  velocitySens: number
  gainDb: number
  /** Micro-deriva analogica determinista por voz, 0..1 (se omite en el cable cuando es 0). */
  analogDrift: number
}

export const STUDIO_DRUM_VOICES = ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'tom_low', 'tom_mid', 'tom_high', 'cymbal'] as const
export type DrumVoice = (typeof STUDIO_DRUM_VOICES)[number]

type SnakeToCamel<S extends string> = S extends `${infer H}_${infer T}` ? `${H}${Capitalize<SnakeToCamel<T>>}` : S
/** Nombre camelCase de una voz: 'hat_closed' -> 'hatClosed'. */
export type DrumVoiceKey = SnakeToCamel<DrumVoice>

/**
 * Parametros de la caja de ritmos (STUDIO_V2.md 2.3.2): por voz `<voz>LevelDb` (-60..6),
 * `<voz>Tune` (semitonos, -12..12) y `<voz>Decay` (multiplicador, 0.25..4); mas `gainDb` y `analogDrift`.
 */
export type DrumsParams = { [V in DrumVoiceKey as `${V}LevelDb`]: number } & { [V in DrumVoiceKey as `${V}Tune`]: number } & {
  [V in DrumVoiceKey as `${V}Decay`]: number
} & { gainDb: number; analogDrift: number }

/** Parametros del sampler (STUDIO_V2.md 2.3.3). */
export interface SamplerParams {
  ampAttackMs: number
  ampDecayMs: number
  ampSustain: number
  ampReleaseMs: number
  velocitySens: number
  mode: SamplerMode
  gainDb: number
}

export const STUDIO_SYNTH_PRESET_IDS = [
  'pad_calido',
  'bajo_sub',
  'bajo_sintetico',
  'lead_brillante',
  'pluck',
  'cuerdas',
  'organo',
  'campanas',
  'teclas_suaves',
] as const
export const STUDIO_DRUMS_PRESET_IDS = ['basico', 'seco', 'amplio', 'lofi'] as const
export type StudioSynthPresetId = (typeof STUDIO_SYNTH_PRESET_IDS)[number]
export type StudioDrumsPresetId = (typeof STUDIO_DRUMS_PRESET_IDS)[number]

export const STUDIO_DEFAULT_SYNTH_PRESET: StudioSynthPresetId = 'teclas_suaves'
export const STUDIO_DEFAULT_DRUMS_PRESET: StudioDrumsPresetId = 'basico'

export interface StudioSynthInstrument {
  type: 'synth'
  /** Origen de los parametros; null = personalizado. No define el sonido: lo definen `params`. */
  preset: StudioSynthPresetId | null
  params: SynthParams
}

export interface StudioDrumsInstrument {
  type: 'drums'
  preset: StudioDrumsPresetId | null
  params: DrumsParams
}

/** Zona del sampler: un audio de la sesion para un rango de notas y velocidades. */
export interface StudioSamplerZone {
  assetId: string
  /** Nota en la que el audio suena sin transponer, 0..127. */
  rootPitch: number
  lowPitch: number
  highPitch: number
  lowVelocity: number
  highVelocity: number
  /** Ventana dentro del audio, en segundos. */
  offsetS: number
  lengthS: number
  gainDb: number
  tuneCents: number
}

export interface StudioSamplerInstrument {
  type: 'sampler'
  params: SamplerParams
  zones: StudioSamplerZone[]
}

/** Plugin WAM 2.0 de la lista cerrada del Hub. `state` es opaco (JSON del plugin). */
export interface StudioWamInstrument {
  type: 'wam'
  pluginId: string
  state: Record<string, unknown>
}

export type StudioInstrument = StudioSynthInstrument | StudioDrumsInstrument | StudioSamplerInstrument | StudioWamInstrument

// --- MIDI y marcas ---

/** Nota MIDI. Tiempos en beats (negras), `start` relativo al inicio de su clip. */
export interface StudioMidiNote {
  /** Entero 0..127. */
  pitch: number
  start: number
  length: number
  /** Entero 1..127. */
  velocity: number
}

export interface StudioMidiClip {
  id: string
  /** Posicion en la sesion, en beats (beat 0 = segundo 0). */
  startBeat: number
  lengthBeats: number
  loop: boolean
  /** Largo del patron que se repite con `loop`; se conserva aunque `loop` sea false. */
  loopBeats: number
  /** Ordenadas por start y pitch, sin solapes del mismo pitch (STUDIO_V2.md 2.4). */
  notes: StudioMidiNote[]
  /**
   * Clip silenciado (tecla 0): se ve y se edita pero no suena al escuchar ni al exportar
   * (STUDIO_V2.md 2.4). Ausente o false = suena; en el cable solo se escribe cuando es true.
   */
  muted?: boolean
}

export interface StudioMarker {
  id: string
  beat: number
  /** 0..60 caracteres. */
  label: string
  kind: StudioMarkerKind
}

/**
 * Acorde de referencia (STUDIO_V2.md 2.9): lo que sono en el audio analizado. No suena ni se
 * exporta; lo usa el asistente del chat. Tiempos en beats de la sesion.
 */
export interface StudioChord {
  beat: number
  lengthBeats: number
  /** 1..16 caracteres ("C#m", "F#7", "C/G"). */
  name: string
}

export interface StudioTrack {
  id: string
  /** 'audio' (clips de audio) o 'instrument' (instrumento y clips MIDI). */
  kind: StudioTrackKind
  name: string
  role: StemRole
  volumeDb: number
  /** -1 izquierda .. 1 derecha. */
  pan: number
  mute: boolean
  solo: boolean
  /** Envio post-fader a la reverb compartida; -60 = sin envio. */
  reverbSendDb: number
  /** A lo sumo un 'eq' y un 'compressor', en el orden en que procesan. */
  fx: StudioFx[]
  /** Clips de audio. Siempre [] en una pista de instrumento. */
  clips: StudioClip[]
  /** Instrumento de la pista; null en una pista de audio. */
  instrument: StudioInstrument | null
  /** Clips MIDI. Siempre [] en una pista de audio. */
  midiClips: StudioMidiClip[]
  /** Audio congelado del instrumento (STUDIO_V2.md 2.2); siempre null en una pista de audio. */
  frozenAssetId: string | null
}

export interface StudioReverb {
  decayS: number
  returnDb: number
}

export interface StudioMaster {
  volumeDb: number
  /** A lo sumo un 'eq', un 'compressor' y un 'limiter'; el limitador va de ultimo. */
  fx: StudioFx[]
  reverb: StudioReverb
}

export interface StudioSession {
  /** Siempre 2 dentro del Hub: un documento v1 se migra al leerlo. */
  version: 2
  id: string
  title: string
  /** Cancion de la libreria (Song.id del workspace) o null si es una maqueta libre. */
  songId: string | null
  bpm: number
  beatsPerBar: number
  key: string | null
  sampleRate: number
  /** Ajuste manual de alineacion de tomas (STUDIO_V1.md 2.7). */
  latencyOffsetMs: number
  /** ISO 8601. En la nube lo pone el Worker. */
  updatedAt: string
  updatedBy: string | null
  assets: StudioAsset[]
  tracks: StudioTrack[]
  /** Ordenadas por beat y id. */
  markers: StudioMarker[]
  /**
   * Acordes de referencia (STUDIO_V2.md 2.9), ordenados por beat y nombre. Opcional: ausente o
   * vacio = sin acordes (el documento del cable no lleva la clave).
   */
  chords?: StudioChord[]
  master: StudioMaster
}

// ---------------------------------------------------------------------------
// Tipos del cable (snake_case), tal como estan en STUDIO_V1.md y STUDIO_V2.md
// ---------------------------------------------------------------------------

export interface WireStudioAssetSource {
  provider: StudioProvider
  job_id: string
  prompt?: string
}

export interface WireStudioAsset {
  id: string
  file: string
  kind: StudioAssetKind
  label: string
  channels: 1 | 2
  sample_rate: number
  duration_s: number
  size: number
  source: WireStudioAssetSource | null
}

export interface WireStudioFx {
  type: StudioFxType
  bypass: boolean
  params: Record<string, number>
}

export interface WireStudioClip {
  id: string
  asset_id: string
  start_s: number
  offset_s: number
  length_s: number
  gain_db: number
  fade_in_s: number
  fade_out_s: number
  take_group: string | null
  active: boolean
  phase_invert?: true
  fade_shape?: 'exp' | 'scurve'
}

export type WireInstrumentParams = Record<string, number | string>

export interface WireStudioSamplerZone {
  asset_id: string
  root_pitch: number
  low_pitch: number
  high_pitch: number
  low_velocity: number
  high_velocity: number
  offset_s: number
  length_s: number
  gain_db: number
  tune_cents: number
}

export type WireStudioInstrument =
  | { type: 'synth'; preset: string | null; params: WireInstrumentParams }
  | { type: 'drums'; preset: string | null; params: WireInstrumentParams }
  | { type: 'sampler'; params: WireInstrumentParams; zones: WireStudioSamplerZone[] }
  | { type: 'wam'; plugin_id: string; state: Record<string, unknown> }

export interface WireStudioMidiNote {
  pitch: number
  start: number
  length: number
  velocity: number
}

export interface WireStudioMidiClip {
  id: string
  start_beat: number
  length_beats: number
  loop: boolean
  loop_beats: number
  notes: WireStudioMidiNote[]
  /** Opcional, solo true (STUDIO_V2.md 2.4). */
  muted?: true
}

export interface WireStudioMarker {
  id: string
  beat: number
  label: string
  kind: StudioMarkerKind
}

export interface WireStudioChord {
  beat: number
  length_beats: number
  name: string
}

interface WireStudioTrackCommon {
  id: string
  name: string
  role: StemRole
  volume_db: number
  pan: number
  mute: boolean
  solo: boolean
  reverb_send_db: number
  fx: WireStudioFx[]
}

/** Pista de un documento v1 (sin `kind`). */
export interface WireStudioTrackV1 extends WireStudioTrackCommon {
  clips: WireStudioClip[]
}

export interface WireStudioAudioTrack extends WireStudioTrackCommon {
  kind: 'audio'
  clips: WireStudioClip[]
}

export interface WireStudioInstrumentTrack extends WireStudioTrackCommon {
  kind: 'instrument'
  instrument: WireStudioInstrument
  midi_clips: WireStudioMidiClip[]
  frozen_asset_id: string | null
}

export type WireStudioTrack = WireStudioAudioTrack | WireStudioInstrumentTrack

export interface WireStudioMaster {
  volume_db: number
  fx: WireStudioFx[]
  reverb: { decay_s: number; return_db: number }
}

interface WireStudioSessionCommon {
  id: string
  title: string
  song_id: string | null
  bpm: number
  beats_per_bar: number
  key: string | null
  sample_rate: number
  latency_offset_ms: number
  updated_at: string
  updated_by: string | null
  assets: WireStudioAsset[]
}

/** Documento v1 (solo lectura: el Hub ya no lo escribe). */
export interface WireStudioSessionV1 extends WireStudioSessionCommon {
  version: 1
  tracks: WireStudioTrackV1[]
  master: WireStudioMaster
}

/** Documento v2: lo que escribe serializeSession. */
export interface WireStudioSession extends WireStudioSessionCommon {
  version: 2
  tracks: WireStudioTrack[]
  markers: WireStudioMarker[]
  /** Solo si hay acordes (STUDIO_V2.md 2.9). */
  chords?: WireStudioChord[]
  master: WireStudioMaster
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Codigos de STUDIO_V1.md 2.9 mas los de STUDIO_V2.md 2.8. */
export type StudioSessionErrorCode =
  | 'not_an_object'
  | 'unsupported_version'
  | 'missing_field'
  | 'unknown_field'
  | 'bad_type'
  | 'out_of_range'
  | 'bad_id'
  | 'bad_value'
  | 'duplicate_id'
  | 'unknown_asset'
  | 'clip_out_of_asset'
  | 'bad_fades'
  | 'session_too_long'
  | 'too_many'
  | 'bad_fx'
  | 'missing_source'
  | 'document_too_large'
  | 'note_out_of_clip'
  | 'note_overlap'
  | 'bad_zone'

/**
 * Documento de sesion invalido. `path` es la ruta del campo en el documento del cable
 * (snake_case), por ejemplo `tracks[0].clips[2].length_s`; '' si es la raiz.
 */
export class StudioSessionError extends Error {
  readonly code: StudioSessionErrorCode
  readonly path: string
  constructor(code: StudioSessionErrorCode, path: string, message: string) {
    super(path ? `${message} (${path})` : message)
    this.name = 'StudioSessionError'
    this.code = code
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// Efectos: especificacion de parametros (rangos y valores por defecto)
// ---------------------------------------------------------------------------

export interface StudioFxParamSpec {
  /** Nombre en el Hub (camelCase), clave de EqParams / CompressorParams / LimiterParams. */
  key: string
  /** Nombre en el cable (snake_case). */
  wire: string
  min: number
  max: number
  /** Valor por defecto. */
  def: number
}

/** Tabla de STUDIO_V1.md 2.6 + STUDIO_V2.md 7.3. La interfaz arma sus controles desde aqui. */
export const STUDIO_FX_PARAM_SPECS: Readonly<Record<StudioFxType, readonly StudioFxParamSpec[]>> = {
  eq: [
    { key: 'hpfHz', wire: 'hpf_hz', min: 0, max: 1000, def: 0 },
    { key: 'lowDb', wire: 'low_db', min: -18, max: 18, def: 0 },
    { key: 'midHz', wire: 'mid_hz', min: 200, max: 8000, def: 1000 },
    { key: 'midDb', wire: 'mid_db', min: -18, max: 18, def: 0 },
    { key: 'midQ', wire: 'mid_q', min: 0.1, max: 10, def: 1 },
    { key: 'highDb', wire: 'high_db', min: -18, max: 18, def: 0 },
  ],
  compressor: [
    { key: 'thresholdDb', wire: 'threshold_db', min: -60, max: 0, def: -18 },
    { key: 'ratio', wire: 'ratio', min: 1, max: 20, def: 3 },
    { key: 'attackMs', wire: 'attack_ms', min: 0, max: 1000, def: 10 },
    { key: 'releaseMs', wire: 'release_ms', min: 10, max: 1000, def: 150 },
    { key: 'kneeDb', wire: 'knee_db', min: 0, max: 40, def: 6 },
    { key: 'makeupDb', wire: 'makeup_db', min: 0, max: 24, def: 0 },
  ],
  de_esser: [
    { key: 'freqHz', wire: 'freq_hz', min: 2000, max: 10000, def: 6500 },
    { key: 'thresholdDb', wire: 'threshold_db', min: -48, max: 0, def: -24 },
    { key: 'reductionDb', wire: 'reduction_db', min: 0, max: 18, def: 6 },
  ],
  saturator: [
    { key: 'driveDb', wire: 'drive_db', min: 0, max: 24, def: 6 },
    { key: 'toneDb', wire: 'tone_db', min: -12, max: 12, def: 0 },
    { key: 'mix', wire: 'mix', min: 0, max: 1, def: 1 },
    { key: 'outputDb', wire: 'output_db', min: -12, max: 12, def: 0 },
  ],
  stereo_imager: [
    { key: 'width', wire: 'width', min: 0, max: 2, def: 1 },
    { key: 'monoBassHz', wire: 'mono_bass_hz', min: 0, max: 300, def: 120 },
  ],
  limiter: [
    { key: 'ceilingDb', wire: 'ceiling_db', min: -12, max: 0, def: -1 },
    { key: 'releaseMs', wire: 'release_ms', min: 10, max: 1000, def: 100 },
  ],
}

export const STUDIO_REVERB_DEFAULT: Readonly<StudioReverb> = { decayS: 1.8, returnDb: 0 }

export function isStudioId(value: unknown): value is string {
  return typeof value === 'string' && STUDIO_ID_RE.test(value)
}

export function isStudioFxType(value: unknown): value is StudioFxType {
  return typeof value === 'string' && (STUDIO_FX_TYPES as readonly string[]).includes(value)
}

export function isStudioTrackKind(value: unknown): value is StudioTrackKind {
  return typeof value === 'string' && (STUDIO_TRACK_KINDS as readonly string[]).includes(value)
}

export function isStudioInstrumentType(value: unknown): value is StudioInstrumentType {
  return typeof value === 'string' && (STUDIO_INSTRUMENT_TYPES as readonly string[]).includes(value)
}

export function isStudioMarkerKind(value: unknown): value is StudioMarkerKind {
  return typeof value === 'string' && (STUDIO_MARKER_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Instrumentos: especificacion de parametros, presets y mapa de percusion
// ---------------------------------------------------------------------------

export interface StudioNumberParamSpec {
  kind: 'number'
  /** Nombre en el Hub (camelCase). */
  key: string
  /** Nombre en el cable (snake_case). */
  wire: string
  min: number
  max: number
  def: number
  /** true = debe ser entero. */
  integer: boolean
  /** true = se omite en el cable cuando vale `def` (identidad con documentos previos). */
  omitDefault?: boolean
}

export interface StudioEnumParamSpec {
  kind: 'enum'
  key: string
  wire: string
  values: readonly string[]
  def: string
}

export type StudioInstrumentParamSpec = StudioNumberParamSpec | StudioEnumParamSpec

/** Tipos con parametros (wam no tiene: su estado es opaco). */
export type StudioParamInstrumentType = 'synth' | 'drums' | 'sampler'

export interface StudioInstrumentParamsByType {
  synth: SynthParams
  drums: DrumsParams
  sampler: SamplerParams
}

/** 'filter_cutoff_hz' -> 'filterCutoffHz'. */
function camelOf(wire: string): string {
  return wire.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

function numSpec(wire: string, min: number, max: number, def: number, integer = false, omitDefault = false): StudioNumberParamSpec {
  return omitDefault ? { kind: 'number', key: camelOf(wire), wire, min, max, def, integer, omitDefault: true } : { kind: 'number', key: camelOf(wire), wire, min, max, def, integer }
}

function enumSpec(wire: string, values: readonly string[], def: string): StudioEnumParamSpec {
  return { kind: 'enum', key: camelOf(wire), wire, values, def }
}

/** STUDIO_V2.md 2.3.1, en el orden en que se serializan. */
export const STUDIO_SYNTH_PARAM_SPECS: readonly StudioInstrumentParamSpec[] = [
  enumSpec('osc1_wave', STUDIO_SYNTH_WAVES, 'sawtooth'),
  numSpec('osc1_octave', -2, 2, 0, true),
  numSpec('osc1_detune_cents', -100, 100, 0),
  numSpec('osc1_level', 0, 1, 0.8),
  enumSpec('osc2_wave', STUDIO_SYNTH_WAVES, 'square'),
  numSpec('osc2_octave', -2, 2, 0, true),
  numSpec('osc2_detune_cents', -100, 100, 7),
  numSpec('osc2_level', 0, 1, 0.4),
  numSpec('noise_level', 0, 1, 0),
  enumSpec('filter_type', STUDIO_SYNTH_FILTER_TYPES, 'lowpass'),
  numSpec('filter_cutoff_hz', 20, 20000, 2400),
  numSpec('filter_resonance', 0.1, 20, 1),
  numSpec('filter_env_octaves', -8, 8, 2),
  numSpec('filter_attack_ms', 0, 10000, 5),
  numSpec('filter_decay_ms', 0, 10000, 400),
  numSpec('filter_sustain', 0, 1, 0.3),
  numSpec('filter_release_ms', 0, 10000, 300),
  numSpec('amp_attack_ms', 0, 10000, 5),
  numSpec('amp_decay_ms', 0, 10000, 200),
  numSpec('amp_sustain', 0, 1, 0.7),
  numSpec('amp_release_ms', 0, 10000, 250),
  enumSpec('lfo_wave', STUDIO_SYNTH_WAVES, 'sine'),
  numSpec('lfo_rate_hz', 0.01, 20, 5),
  enumSpec('lfo_target', STUDIO_SYNTH_LFO_TARGETS, 'off'),
  numSpec('lfo_depth', 0, 1, 0),
  numSpec('velocity_sens', 0, 1, 0.7),
  numSpec('gain_db', -24, 12, -6),
  numSpec('analog_drift', 0, 1, 0, false, true),
]

/** STUDIO_V2.md 2.3.2: por voz level_db, tune y decay, en el orden de las voces; al final gain_db y analog_drift. */
export const STUDIO_DRUMS_PARAM_SPECS: readonly StudioInstrumentParamSpec[] = [
  ...STUDIO_DRUM_VOICES.flatMap((voice) => [
    numSpec(`${voice}_level_db`, -60, 6, 0),
    numSpec(`${voice}_tune`, -12, 12, 0),
    numSpec(`${voice}_decay`, 0.25, 4, 1),
  ]),
  numSpec('gain_db', -24, 12, -6),
  numSpec('analog_drift', 0, 1, 0, false, true),
]

/** STUDIO_V2.md 2.3.3. */
export const STUDIO_SAMPLER_PARAM_SPECS: readonly StudioInstrumentParamSpec[] = [
  numSpec('amp_attack_ms', 0, 10000, 2),
  numSpec('amp_decay_ms', 0, 10000, 0),
  numSpec('amp_sustain', 0, 1, 1),
  numSpec('amp_release_ms', 0, 10000, 150),
  numSpec('velocity_sens', 0, 1, 0.7),
  enumSpec('mode', STUDIO_SAMPLER_MODES, 'sustain'),
  numSpec('gain_db', -24, 12, 0),
]

export const STUDIO_INSTRUMENT_PARAM_SPECS: Readonly<Record<StudioParamInstrumentType, readonly StudioInstrumentParamSpec[]>> = {
  synth: STUDIO_SYNTH_PARAM_SPECS,
  drums: STUDIO_DRUMS_PARAM_SPECS,
  sampler: STUDIO_SAMPLER_PARAM_SPECS,
}

function defaultsOf(specs: readonly StudioInstrumentParamSpec[]): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const spec of specs) out[spec.key] = spec.def
  return out
}

/** Aplica cambios en nombres del cable (como estan en las tablas de presets del contrato). */
function withWireOverrides(specs: readonly StudioInstrumentParamSpec[], overrides: Readonly<Record<string, number | string>>): Record<string, number | string> {
  const out = defaultsOf(specs)
  for (const [wire, value] of Object.entries(overrides)) {
    const spec = specs.find((s) => s.wire === wire)
    if (!spec) throw new Error(`Preset con un parametro desconocido: ${wire}`)
    out[spec.key] = value
  }
  return out
}

export interface StudioInstrumentPreset<Id extends string, P> {
  id: Id
  /** Nombre para mostrar, en espanol. */
  label: string
  /** Todos los parametros del preset. */
  params: Readonly<P>
}

const SYNTH_PRESET_TABLE: ReadonlyArray<{ id: StudioSynthPresetId; label: string; set: Record<string, number | string> }> = [
  {
    id: 'pad_calido',
    label: 'Pad cálido',
    set: {
      osc2_wave: 'sawtooth', osc2_detune_cents: 9, osc2_level: 0.6, filter_cutoff_hz: 1200, filter_resonance: 0.8, filter_env_octaves: 1,
      filter_attack_ms: 800, filter_decay_ms: 1500, filter_sustain: 0.5, filter_release_ms: 1500, amp_attack_ms: 600, amp_decay_ms: 1000,
      amp_sustain: 0.8, amp_release_ms: 1800, lfo_rate_hz: 0.3, lfo_target: 'filter', lfo_depth: 0.2, velocity_sens: 0.3, gain_db: -10,
    },
  },
  {
    id: 'bajo_sub',
    label: 'Bajo sub',
    set: {
      osc1_wave: 'sine', osc1_octave: -1, osc2_wave: 'triangle', osc2_octave: -1, osc2_detune_cents: 0, osc2_level: 0.3, filter_cutoff_hz: 400,
      filter_env_octaves: 0.5, amp_attack_ms: 3, amp_decay_ms: 300, amp_sustain: 0.9, amp_release_ms: 120, velocity_sens: 0.5, gain_db: -4,
    },
  },
  {
    id: 'bajo_sintetico',
    label: 'Bajo sintético',
    set: {
      osc1_octave: -1, osc2_octave: -1, osc2_detune_cents: 5, osc2_level: 0.5, filter_cutoff_hz: 500, filter_resonance: 4, filter_env_octaves: 3,
      filter_decay_ms: 250, filter_sustain: 0.2, amp_attack_ms: 2, amp_decay_ms: 300, amp_sustain: 0.8, amp_release_ms: 100,
    },
  },
  {
    id: 'lead_brillante',
    label: 'Lead brillante',
    set: {
      osc2_wave: 'sawtooth', osc2_detune_cents: 14, osc2_level: 0.6, filter_cutoff_hz: 3500, filter_resonance: 2, filter_env_octaves: 1.5,
      amp_attack_ms: 8, amp_sustain: 0.85, amp_release_ms: 200, lfo_rate_hz: 5.5, lfo_target: 'pitch', lfo_depth: 0.15, gain_db: -8,
    },
  },
  {
    id: 'pluck',
    label: 'Pluck',
    set: {
      osc2_wave: 'triangle', osc2_octave: 1, osc2_detune_cents: 0, osc2_level: 0.3, filter_cutoff_hz: 600, filter_resonance: 1.5,
      filter_env_octaves: 4, filter_attack_ms: 0, filter_decay_ms: 180, filter_sustain: 0, filter_release_ms: 180, amp_attack_ms: 1,
      amp_decay_ms: 350, amp_sustain: 0,
    },
  },
  {
    id: 'cuerdas',
    label: 'Cuerdas',
    set: {
      osc2_wave: 'sawtooth', osc2_detune_cents: -8, osc2_level: 0.7, filter_cutoff_hz: 2800, filter_resonance: 0.7, filter_env_octaves: 0.5,
      amp_attack_ms: 350, amp_decay_ms: 500, amp_sustain: 0.85, amp_release_ms: 900, lfo_rate_hz: 4.5, lfo_target: 'pitch', lfo_depth: 0.06,
      velocity_sens: 0.5, gain_db: -10,
    },
  },
  {
    id: 'organo',
    label: 'Órgano',
    set: {
      osc1_wave: 'sine', osc2_wave: 'sine', osc2_octave: 1, osc2_detune_cents: 0, osc2_level: 0.6, filter_cutoff_hz: 8000, filter_env_octaves: 0,
      amp_attack_ms: 4, amp_decay_ms: 10, amp_sustain: 1, amp_release_ms: 60, lfo_rate_hz: 6, lfo_target: 'amp', lfo_depth: 0.1,
      velocity_sens: 0, gain_db: -8,
    },
  },
  {
    id: 'campanas',
    label: 'Campanas',
    set: {
      osc1_wave: 'sine', osc2_wave: 'triangle', osc2_octave: 2, osc2_detune_cents: 3, osc2_level: 0.35, filter_cutoff_hz: 6000,
      filter_env_octaves: 0, amp_attack_ms: 1, amp_decay_ms: 1800, amp_sustain: 0, amp_release_ms: 1500, gain_db: -8,
    },
  },
  {
    id: 'teclas_suaves',
    label: 'Teclas suaves',
    set: {
      osc1_wave: 'triangle', osc2_wave: 'sine', osc2_octave: 1, osc2_detune_cents: 0, osc2_level: 0.25, filter_cutoff_hz: 1800,
      filter_env_octaves: 1.5, filter_decay_ms: 600, filter_sustain: 0.2, amp_attack_ms: 3, amp_decay_ms: 1200, amp_sustain: 0.3,
      amp_release_ms: 400, velocity_sens: 0.8,
    },
  },
]

function everyDrumVoice(suffix: 'level_db' | 'tune' | 'decay', value: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const voice of STUDIO_DRUM_VOICES) out[`${voice}_${suffix}`] = value
  return out
}

const DRUMS_PRESET_TABLE: ReadonlyArray<{ id: StudioDrumsPresetId; label: string; set: Record<string, number> }> = [
  { id: 'basico', label: 'Básico', set: {} },
  { id: 'seco', label: 'Seco', set: { ...everyDrumVoice('decay', 0.6), cymbal_decay: 0.5 } },
  { id: 'amplio', label: 'Amplio', set: { ...everyDrumVoice('decay', 1.5), kick_tune: -2, snare_level_db: -2 } },
  {
    id: 'lofi',
    label: 'Lo-fi',
    set: { ...everyDrumVoice('tune', -3), ...everyDrumVoice('decay', 0.8), hat_closed_level_db: -6, hat_open_level_db: -6, cymbal_level_db: -6 },
  },
]

/** Presets del sintetizador (STUDIO_V2.md 2.3.1), con todos sus parametros. */
export const STUDIO_SYNTH_PRESETS: readonly StudioInstrumentPreset<StudioSynthPresetId, SynthParams>[] = SYNTH_PRESET_TABLE.map((p) => ({
  id: p.id,
  label: p.label,
  params: Object.freeze(withWireOverrides(STUDIO_SYNTH_PARAM_SPECS, p.set)) as unknown as SynthParams,
}))

/** Presets de la caja de ritmos (STUDIO_V2.md 2.3.2), con todos sus parametros. */
export const STUDIO_DRUMS_PRESETS: readonly StudioInstrumentPreset<StudioDrumsPresetId, DrumsParams>[] = DRUMS_PRESET_TABLE.map((p) => ({
  id: p.id,
  label: p.label,
  params: Object.freeze(withWireOverrides(STUDIO_DRUMS_PARAM_SPECS, p.set)) as unknown as DrumsParams,
}))

export function defaultSynthParams(): SynthParams {
  return defaultsOf(STUDIO_SYNTH_PARAM_SPECS) as unknown as SynthParams
}

export function defaultDrumsParams(): DrumsParams {
  return defaultsOf(STUDIO_DRUMS_PARAM_SPECS) as unknown as DrumsParams
}

export function defaultSamplerParams(): SamplerParams {
  return defaultsOf(STUDIO_SAMPLER_PARAM_SPECS) as unknown as SamplerParams
}

/** Copia de los parametros completos de un preset del sintetizador. */
export function synthPresetParams(id: StudioSynthPresetId): SynthParams {
  const preset = STUDIO_SYNTH_PRESETS.find((p) => p.id === id)
  if (!preset) throw new StudioSessionError('bad_value', 'preset', `Preset de sintetizador desconocido: "${id}"`)
  return { ...preset.params }
}

/** Copia de los parametros completos de un preset de la caja de ritmos. */
export function drumsPresetParams(id: StudioDrumsPresetId): DrumsParams {
  const preset = STUDIO_DRUMS_PRESETS.find((p) => p.id === id)
  if (!preset) throw new StudioSessionError('bad_value', 'preset', `Preset de caja de ritmos desconocido: "${id}"`)
  return { ...preset.params }
}

export function isSynthPresetId(value: unknown): value is StudioSynthPresetId {
  return typeof value === 'string' && (STUDIO_SYNTH_PRESET_IDS as readonly string[]).includes(value)
}

export function isDrumsPresetId(value: unknown): value is StudioDrumsPresetId {
  return typeof value === 'string' && (STUDIO_DRUMS_PRESET_IDS as readonly string[]).includes(value)
}

/** Nombre para mostrar de cada voz de la caja de ritmos. */
export const STUDIO_DRUM_VOICE_LABELS: Readonly<Record<DrumVoice, string>> = {
  kick: 'Bombo',
  snare: 'Caja',
  clap: 'Palmas',
  hat_closed: 'Hi-hat cerrado',
  hat_open: 'Hi-hat abierto',
  tom_low: 'Tom grave',
  tom_mid: 'Tom medio',
  tom_high: 'Tom agudo',
  cymbal: 'Platillo',
}

/** Nota canonica de cada voz (General MIDI): la que escriben el piano roll, compose y el .mid. */
export const STUDIO_DRUM_VOICE_NOTES: Readonly<Record<DrumVoice, number>> = {
  kick: 36,
  snare: 38,
  clap: 39,
  hat_closed: 42,
  hat_open: 46,
  tom_low: 41,
  tom_mid: 45,
  tom_high: 48,
  cymbal: 49,
}

/** Mapa General MIDI de percusion -> voz (STUDIO_V2.md 2.3.2). Otra nota no suena. */
export const STUDIO_DRUM_GM_MAP: Readonly<Record<number, DrumVoice>> = {
  35: 'kick',
  36: 'kick',
  37: 'snare',
  38: 'snare',
  40: 'snare',
  39: 'clap',
  42: 'hat_closed',
  44: 'hat_closed',
  46: 'hat_open',
  41: 'tom_low',
  43: 'tom_low',
  45: 'tom_mid',
  47: 'tom_mid',
  48: 'tom_high',
  50: 'tom_high',
  49: 'cymbal',
  51: 'cymbal',
  52: 'cymbal',
  53: 'cymbal',
  55: 'cymbal',
  57: 'cymbal',
  59: 'cymbal',
}

/** Voz de la caja de ritmos que dispara una nota, o null si esa nota no suena. */
export function drumVoiceForPitch(pitch: number): DrumVoice | null {
  return STUDIO_DRUM_GM_MAP[pitch] ?? null
}

/** Nombre para mostrar de cada tipo de marca. */
export const STUDIO_MARKER_KIND_LABELS: Readonly<Record<StudioMarkerKind, string>> = {
  intro: 'Intro',
  verse: 'Estrofa',
  pre_chorus: 'Pre coro',
  chorus: 'Coro',
  bridge: 'Puente',
  solo: 'Solo',
  interlude: 'Interludio',
  break: 'Corte',
  outro: 'Final',
  marker: 'Marca',
}

export const STUDIO_INSTRUMENT_TYPE_LABELS: Readonly<Record<StudioInstrumentType, string>> = {
  synth: 'Sintetizador',
  drums: 'Caja de ritmos',
  sampler: 'Sampler',
  wam: 'Plugin web',
}

// ---------------------------------------------------------------------------
// Beats y segundos
// ---------------------------------------------------------------------------

/** segundos = beats * 60 / bpm (tempo unico por sesion; beat 0 = segundo 0). */
export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm
}

export function secondsToBeats(seconds: number, bpm: number): number {
  return (seconds * bpm) / 60
}

/** Redondea un valor en beats a 6 decimales (lo que hacen los editores antes de guardar). */
export function roundBeat(beats: number): number {
  return Math.round(beats * 1e6) / 1e6
}

/** Orden canonico de las notas: por start y, a igual start, por pitch. */
export function compareNotes(a: StudioMidiNote, b: StudioMidiNote): number {
  return a.start - b.start || a.pitch - b.pitch
}

/** Copia ordenada (compareNotes). */
export function sortNotes(notes: readonly StudioMidiNote[]): StudioMidiNote[] {
  return [...notes].sort(compareNotes)
}

export function compareMarkers(a: { beat: number; id: string }, b: { beat: number; id: string }): number {
  return a.beat - b.beat || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Lectura defensiva
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>

function fail(code: StudioSessionErrorCode, path: string, message: string): never {
  throw new StudioSessionError(code, path, message)
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

function asObject(raw: unknown, path: string): Raw {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('not_an_object', path, 'Se esperaba un objeto')
  return raw as Raw
}

/** Comprueba que no falten campos obligatorios ni sobren campos desconocidos. */
function checkKeys(o: Raw, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) {
    if (o[key] === undefined) fail('missing_field', join(path, key), 'Falta un campo obligatorio')
  }
  for (const key of Object.keys(o)) {
    if (o[key] === undefined) continue
    if (!required.includes(key) && !optional.includes(key)) fail('unknown_field', join(path, key), 'Campo desconocido para esta versión del documento')
  }
}

function num(o: Raw, key: string, path: string, min: number, max: number): number {
  const v = o[key]
  const p = join(path, key)
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('bad_type', p, 'Se esperaba un número')
  if (v < min || v > max) fail('out_of_range', p, `El valor ${v} está fuera del rango ${min}..${max}`)
  return v
}

function int(o: Raw, key: string, path: string, min: number, max: number): number {
  const v = num(o, key, path, min, max)
  if (!Number.isInteger(v)) fail('bad_type', join(path, key), 'Se esperaba un número entero')
  return v
}

function bool(o: Raw, key: string, path: string): boolean {
  const v = o[key]
  if (typeof v !== 'boolean') fail('bad_type', join(path, key), 'Se esperaba verdadero o falso')
  return v
}

function text(o: Raw, key: string, path: string, minLen: number, maxLen: number): string {
  const v = o[key]
  const p = join(path, key)
  if (typeof v !== 'string') fail('bad_type', p, 'Se esperaba un texto')
  if (v.length < minLen || v.length > maxLen) fail('out_of_range', p, `El texto debe tener entre ${minLen} y ${maxLen} caracteres`)
  return v
}

function id(o: Raw, key: string, path: string): string {
  const v = o[key]
  const p = join(path, key)
  if (typeof v !== 'string') fail('bad_type', p, 'Se esperaba un id de texto')
  if (!STUDIO_ID_RE.test(v)) fail('bad_id', p, 'El id solo admite letras, números, guion y guion bajo (1 a 80)')
  return v
}

function nullableId(o: Raw, key: string, path: string): string | null {
  return o[key] === null ? null : id(o, key, path)
}

function oneOf<T extends string>(o: Raw, key: string, path: string, allowed: readonly T[]): T {
  const v = o[key]
  const p = join(path, key)
  if (typeof v !== 'string') fail('bad_type', p, 'Se esperaba un texto')
  if (!(allowed as readonly string[]).includes(v)) fail('bad_value', p, `Valor no admitido: "${v}"`)
  return v as T
}

function list(o: Raw, key: string, path: string, max: number): unknown[] {
  const v = o[key]
  const p = join(path, key)
  if (!Array.isArray(v)) fail('bad_type', p, 'Se esperaba una lista')
  if (v.length > max) fail('too_many', p, `Hay ${v.length} elementos y el máximo es ${max}`)
  return v
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

function readFxParams(type: StudioFxType, raw: unknown, path: string, partial: boolean): Record<string, number> {
  const o = asObject(raw, path)
  const specs = STUDIO_FX_PARAM_SPECS[type]
  checkKeys(o, path, [], specs.map((s) => s.wire))
  const out: Record<string, number> = {}
  for (const spec of specs) {
    if (o[spec.wire] === undefined) {
      if (!partial) out[spec.key] = spec.def
      continue
    }
    out[spec.key] = num(o, spec.wire, path, spec.min, spec.max)
  }
  return out
}

/**
 * Parametros de un efecto desde el cable (snake_case) al Hub (camelCase). Los ausentes toman su
 * valor por defecto; uno desconocido o fuera de rango lanza StudioSessionError.
 */
export function fxParamsFromWire<T extends StudioFxType>(type: T, raw: unknown, path = 'params'): StudioFxParamsByType[T] {
  return readFxParams(type, raw, path, false) as unknown as StudioFxParamsByType[T]
}

/**
 * Igual que fxParamsFromWire, pero sin completar los ausentes: devuelve solo los que vienen.
 * Es lo que traen las sugerencias del asistente (STUDIO_V1.md 6.4).
 */
export function partialFxParamsFromWire<T extends StudioFxType>(type: T, raw: unknown, path = 'params'): Partial<StudioFxParamsByType[T]> {
  return readFxParams(type, raw, path, true) as unknown as Partial<StudioFxParamsByType[T]>
}

/** Parametros de un efecto del Hub al cable. Solo escribe los que estan definidos. */
export function fxParamsToWire<T extends StudioFxType>(type: T, params: Partial<StudioFxParamsByType[T]>): Record<string, number> {
  const source = params as unknown as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const spec of STUDIO_FX_PARAM_SPECS[type]) {
    const v = source[spec.key]
    if (v !== undefined) out[spec.wire] = v as number
  }
  return out
}

/** Un efecto con todos sus parametros por defecto y `bypass: false`. */
export function defaultFx<T extends StudioFxType>(type: T): Extract<StudioFx, { type: T }> {
  const params: Record<string, number> = {}
  for (const spec of STUDIO_FX_PARAM_SPECS[type]) params[spec.key] = spec.def
  return { type, bypass: false, params } as unknown as Extract<StudioFx, { type: T }>
}

/** Valida y traduce un efecto del cable. No comprueba en que cadena va (eso lo hace parseSession). */
export function parseFx(raw: unknown, path = 'fx', version: 1 | 2 = 2): StudioFx {
  const o = asObject(raw, path)
  checkKeys(o, path, ['type', 'bypass', 'params'])
  const type = oneOf(o, 'type', path, version === 1 ? STUDIO_FX_TYPES_V1 : STUDIO_FX_TYPES)
  const bypass = bool(o, 'bypass', path)
  const params = readFxParams(type, o.params, join(path, 'params'), false)
  return { type, bypass, params } as unknown as StudioFx
}

export function serializeFx(fx: StudioFx): WireStudioFx {
  return { type: fx.type, bypass: fx.bypass, params: fxParamsToWire(fx.type, fx.params as Partial<StudioFxParamsByType[typeof fx.type]>) }
}

function parseFxChain(raw: unknown[], path: string, where: 'track' | 'master', version: 1 | 2 = 2): StudioFx[] {
  const chain = raw.map((item, i) => parseFx(item, `${path}[${i}]`, version))
  const seen = new Set<StudioFxType>()
  chain.forEach((fx, i) => {
    const p = `${path}[${i}]`
    if (seen.has(fx.type)) fail('bad_fx', p, `El efecto "${fx.type}" está repetido en la cadena`)
    seen.add(fx.type)
    if (fx.type === 'limiter') {
      if (where === 'track') fail('bad_fx', p, 'El limitador solo va en el master')
      if (i !== chain.length - 1) fail('bad_fx', p, 'El limitador debe ser el último efecto del master')
    }
  })
  return chain
}

// ---------------------------------------------------------------------------
// Parametros de instrumentos
// ---------------------------------------------------------------------------

function readInstrumentParams(specs: readonly StudioInstrumentParamSpec[], raw: unknown, path: string, partial: boolean): Record<string, number | string> {
  const o = asObject(raw, path)
  checkKeys(o, path, [], specs.map((s) => s.wire))
  const out: Record<string, number | string> = {}
  for (const spec of specs) {
    if (o[spec.wire] === undefined) {
      if (!partial) out[spec.key] = spec.def
      continue
    }
    if (spec.kind === 'enum') out[spec.key] = oneOf(o, spec.wire, path, spec.values)
    else out[spec.key] = spec.integer ? int(o, spec.wire, path, spec.min, spec.max) : num(o, spec.wire, path, spec.min, spec.max)
  }
  return out
}

/**
 * Parametros de un instrumento desde el cable (snake_case) al Hub (camelCase). Los ausentes
 * toman su valor por defecto de la tabla (no el del preset); uno desconocido, fuera de rango o
 * fuera de su lista lanza StudioSessionError.
 */
export function instrumentParamsFromWire<T extends StudioParamInstrumentType>(type: T, raw: unknown, path = 'params'): StudioInstrumentParamsByType[T] {
  return readInstrumentParams(STUDIO_INSTRUMENT_PARAM_SPECS[type], raw, path, false) as unknown as StudioInstrumentParamsByType[T]
}

/** Igual que instrumentParamsFromWire, sin completar los ausentes (herramienta set_instrument del asistente). */
export function partialInstrumentParamsFromWire<T extends StudioParamInstrumentType>(
  type: T,
  raw: unknown,
  path = 'params',
): Partial<StudioInstrumentParamsByType[T]> {
  return readInstrumentParams(STUDIO_INSTRUMENT_PARAM_SPECS[type], raw, path, true) as unknown as Partial<StudioInstrumentParamsByType[T]>
}

/** Parametros de un instrumento del Hub al cable, en el orden de la tabla. Solo los definidos (y omitDefault cuando vale def). */
export function instrumentParamsToWire<T extends StudioParamInstrumentType>(type: T, params: Partial<StudioInstrumentParamsByType[T]>): WireInstrumentParams {
  const source = params as unknown as Record<string, unknown>
  const out: WireInstrumentParams = {}
  for (const spec of STUDIO_INSTRUMENT_PARAM_SPECS[type]) {
    const v = source[spec.key]
    if (v === undefined) continue
    if (spec.kind === 'number' && spec.omitDefault && v === spec.def) continue
    out[spec.wire] = v as number | string
  }
  return out
}

// ---------------------------------------------------------------------------
// parseSession: partes
// ---------------------------------------------------------------------------

/** Nombre de archivo de un audio: `${id}.${ext}`. */
export function assetFileName(assetId: string, ext: StudioAssetExtension): string {
  return `${assetId}.${ext}`
}

/** Extension de un `file` de audio del Estudio, o null si no es wav | flac | mp3. */
export function assetExtension(file: string): StudioAssetExtension | null {
  const dot = file.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = file.slice(dot + 1)
  return (STUDIO_ASSET_EXTENSIONS as readonly string[]).includes(ext) ? (ext as StudioAssetExtension) : null
}

function parseSource(raw: unknown, path: string): StudioAssetSource | null {
  if (raw === null) return null
  const o = asObject(raw, path)
  checkKeys(o, path, ['provider', 'job_id'], ['prompt'])
  const source: StudioAssetSource = { provider: oneOf(o, 'provider', path, STUDIO_PROVIDERS), jobId: id(o, 'job_id', path) }
  if (o.prompt !== undefined) source.prompt = text(o, 'prompt', path, 1, STUDIO_MAX_PROMPT)
  return source
}

function parseAsset(raw: unknown, path: string): StudioAsset {
  const o = asObject(raw, path)
  checkKeys(o, path, ['id', 'file', 'kind', 'label', 'channels', 'sample_rate', 'duration_s', 'size', 'source'])
  const assetId = id(o, 'id', path)
  const file = text(o, 'file', path, 1, 90)
  const ext = assetExtension(file)
  if (ext === null || file !== assetFileName(assetId, ext)) {
    fail('bad_value', join(path, 'file'), `El archivo debe llamarse "${assetId}.wav", ".flac" o ".mp3"`)
  }
  const kind = oneOf(o, 'kind', path, STUDIO_ASSET_KINDS)
  const channels = int(o, 'channels', path, 1, 2) as 1 | 2
  const duration = num(o, 'duration_s', path, 0, STUDIO_MAX_SESSION_SECONDS)
  if (!(duration > 0)) fail('out_of_range', join(path, 'duration_s'), 'La duración debe ser mayor que cero')
  const source = parseSource(o.source, join(path, 'source'))
  if (kind === 'generated' && source === null) fail('missing_source', join(path, 'source'), 'Un audio generado debe traer su origen')
  return {
    id: assetId,
    file,
    kind,
    label: text(o, 'label', path, 0, STUDIO_MAX_ASSET_LABEL),
    channels,
    sampleRate: int(o, 'sample_rate', path, STUDIO_ASSET_SAMPLE_RATE_MIN, STUDIO_ASSET_SAMPLE_RATE_MAX),
    durationS: duration,
    size: int(o, 'size', path, 1, STUDIO_MAX_ASSET_BYTES),
    source,
  }
}

function parseClip(raw: unknown, path: string, assets: ReadonlyMap<string, StudioAsset>, version: 1 | 2 = 2): StudioClip {
  const o = asObject(raw, path)
  checkKeys(
    o,
    path,
    ['id', 'asset_id', 'start_s', 'offset_s', 'length_s', 'gain_db', 'fade_in_s', 'fade_out_s', 'take_group', 'active'],
    version === 2 ? ['phase_invert', 'fade_shape'] : [],
  )
  const phaseInvert = version === 2 && o.phase_invert !== undefined ? bool(o, 'phase_invert', path) : false
  const fadeShape = version === 2 && o.fade_shape !== undefined ? oneOf(o, 'fade_shape', path, STUDIO_CLIP_FADE_SHAPES) : 'linear'
  const clip: StudioClip = {
    id: id(o, 'id', path),
    assetId: id(o, 'asset_id', path),
    startS: num(o, 'start_s', path, 0, STUDIO_MAX_SESSION_SECONDS),
    offsetS: num(o, 'offset_s', path, 0, STUDIO_MAX_SESSION_SECONDS),
    lengthS: num(o, 'length_s', path, STUDIO_MIN_CLIP_SECONDS, STUDIO_MAX_SESSION_SECONDS),
    gainDb: num(o, 'gain_db', path, STUDIO_CLIP_GAIN_DB_MIN, STUDIO_CLIP_GAIN_DB_MAX),
    fadeInS: num(o, 'fade_in_s', path, 0, STUDIO_MAX_SESSION_SECONDS),
    fadeOutS: num(o, 'fade_out_s', path, 0, STUDIO_MAX_SESSION_SECONDS),
    takeGroup: nullableId(o, 'take_group', path),
    active: bool(o, 'active', path),
  }
  if (phaseInvert) clip.phaseInvert = true
  if (fadeShape !== 'linear') clip.fadeShape = fadeShape
  const asset = assets.get(clip.assetId)
  if (!asset) fail('unknown_asset', join(path, 'asset_id'), `El clip usa el audio "${clip.assetId}", que no está en la sesión`)
  if (clip.offsetS + clip.lengthS > asset.durationS + STUDIO_TIME_EPSILON_S) {
    fail('clip_out_of_asset', join(path, 'length_s'), 'La ventana del clip se sale de su audio')
  }
  if (clip.startS + clip.lengthS > STUDIO_MAX_SESSION_SECONDS + STUDIO_TIME_EPSILON_S) {
    fail('session_too_long', join(path, 'start_s'), 'El clip termina después de los 20 minutos que admite una sesión')
  }
  if (clip.fadeInS + clip.fadeOutS > clip.lengthS + STUDIO_FADE_EPSILON_S) {
    fail('bad_fades', join(path, 'fade_in_s'), 'Los fades no caben en el largo del clip')
  }
  return clip
}

function parseZone(raw: unknown, path: string, assets: ReadonlyMap<string, StudioAsset>): StudioSamplerZone {
  const o = asObject(raw, path)
  checkKeys(o, path, ['asset_id', 'root_pitch', 'low_pitch', 'high_pitch', 'low_velocity', 'high_velocity', 'offset_s', 'length_s', 'gain_db', 'tune_cents'])
  const zone: StudioSamplerZone = {
    assetId: id(o, 'asset_id', path),
    rootPitch: int(o, 'root_pitch', path, 0, 127),
    lowPitch: int(o, 'low_pitch', path, 0, 127),
    highPitch: int(o, 'high_pitch', path, 0, 127),
    lowVelocity: int(o, 'low_velocity', path, 1, 127),
    highVelocity: int(o, 'high_velocity', path, 1, 127),
    offsetS: num(o, 'offset_s', path, 0, STUDIO_MAX_SESSION_SECONDS),
    lengthS: num(o, 'length_s', path, STUDIO_MIN_CLIP_SECONDS, STUDIO_MAX_SESSION_SECONDS),
    gainDb: num(o, 'gain_db', path, STUDIO_CLIP_GAIN_DB_MIN, STUDIO_CLIP_GAIN_DB_MAX),
    tuneCents: num(o, 'tune_cents', path, -100, 100),
  }
  if (zone.lowPitch > zone.highPitch) fail('bad_zone', join(path, 'high_pitch'), 'La nota más alta de la zona es menor que la más baja')
  if (zone.lowVelocity > zone.highVelocity) fail('bad_zone', join(path, 'high_velocity'), 'La velocidad más alta de la zona es menor que la más baja')
  const asset = assets.get(zone.assetId)
  if (!asset) fail('unknown_asset', join(path, 'asset_id'), `La zona usa el audio "${zone.assetId}", que no está en la sesión`)
  if (zone.offsetS + zone.lengthS > asset.durationS + STUDIO_TIME_EPSILON_S) {
    fail('clip_out_of_asset', join(path, 'length_s'), 'La ventana de la zona se sale de su audio')
  }
  return zone
}

/** Copia profunda de un valor JSON (el estado opaco de un plugin WAM). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function parseInstrument(raw: unknown, path: string, assets: ReadonlyMap<string, StudioAsset>): StudioInstrument {
  const o = asObject(raw, path)
  if (o.type === undefined) fail('missing_field', join(path, 'type'), 'Falta un campo obligatorio')
  const type = oneOf(o, 'type', path, STUDIO_INSTRUMENT_TYPES)
  if (type === 'synth') {
    checkKeys(o, path, ['type', 'preset', 'params'])
    let preset: StudioSynthPresetId | null = null
    if (o.preset !== null) preset = oneOf(o, 'preset', path, STUDIO_SYNTH_PRESET_IDS)
    return { type, preset, params: instrumentParamsFromWire('synth', o.params, join(path, 'params')) }
  }
  if (type === 'drums') {
    checkKeys(o, path, ['type', 'preset', 'params'])
    let preset: StudioDrumsPresetId | null = null
    if (o.preset !== null) preset = oneOf(o, 'preset', path, STUDIO_DRUMS_PRESET_IDS)
    return { type, preset, params: instrumentParamsFromWire('drums', o.params, join(path, 'params')) }
  }
  if (type === 'sampler') {
    checkKeys(o, path, ['type', 'params', 'zones'])
    const params = instrumentParamsFromWire('sampler', o.params, join(path, 'params'))
    const zonesPath = join(path, 'zones')
    const zones = list(o, 'zones', path, STUDIO_MAX_SAMPLER_ZONES).map((item, i) => parseZone(item, `${zonesPath}[${i}]`, assets))
    return { type, params, zones }
  }
  checkKeys(o, path, ['type', 'plugin_id', 'state'])
  const pluginId = text(o, 'plugin_id', path, 1, 80)
  if (!STUDIO_WAM_PLUGIN_ID_RE.test(pluginId)) fail('bad_value', join(path, 'plugin_id'), 'El id del plugin solo admite minúsculas, números, punto, guion y guion bajo')
  const statePath = join(path, 'state')
  const state = asObject(o.state, statePath)
  let json: string
  try {
    json = JSON.stringify(state)
  } catch {
    fail('bad_type', statePath, 'El estado del plugin no es JSON')
  }
  if (utf8Bytes(json) > STUDIO_MAX_WAM_STATE_BYTES) fail('out_of_range', statePath, `El estado del plugin supera los ${STUDIO_MAX_WAM_STATE_BYTES} bytes`)
  return { type, pluginId, state: JSON.parse(json) as Record<string, unknown> }
}

function parseNote(raw: unknown, path: string, clipLengthBeats: number): StudioMidiNote {
  const o = asObject(raw, path)
  checkKeys(o, path, ['pitch', 'start', 'length', 'velocity'])
  const note: StudioMidiNote = {
    pitch: int(o, 'pitch', path, 0, 127),
    start: num(o, 'start', path, 0, STUDIO_MAX_BEAT),
    length: num(o, 'length', path, STUDIO_MIDI_MIN_NOTE_BEATS, STUDIO_MAX_BEAT),
    velocity: int(o, 'velocity', path, 1, 127),
  }
  if (note.start >= clipLengthBeats) fail('note_out_of_clip', join(path, 'start'), 'La nota empieza en o después del final de su clip')
  return note
}

interface ParseCounters {
  clipIds: Set<string>
  notes: number
}

function parseMidiClip(raw: unknown, path: string, bpm: number, counters: ParseCounters): StudioMidiClip {
  const o = asObject(raw, path)
  checkKeys(o, path, ['id', 'start_beat', 'length_beats', 'loop', 'loop_beats', 'notes'], ['muted'])
  const clipId = id(o, 'id', path)
  const muted = o.muted !== undefined && bool(o, 'muted', path)
  const startBeat = num(o, 'start_beat', path, 0, STUDIO_MAX_BEAT)
  const lengthBeats = num(o, 'length_beats', path, STUDIO_MIDI_MIN_CLIP_BEATS, STUDIO_MAX_BEAT)
  const loop = bool(o, 'loop', path)
  const loopBeats = num(o, 'loop_beats', path, STUDIO_MIDI_MIN_CLIP_BEATS, STUDIO_MAX_BEAT)
  if (beatsToSeconds(startBeat + lengthBeats, bpm) > STUDIO_MAX_SESSION_SECONDS + STUDIO_TIME_EPSILON_S) {
    fail('session_too_long', join(path, 'start_beat'), 'El clip termina después de los 20 minutos que admite una sesión')
  }
  const notesPath = join(path, 'notes')
  const rawNotes = list(o, 'notes', path, STUDIO_MAX_NOTES_PER_CLIP)
  counters.notes += rawNotes.length
  if (counters.notes > STUDIO_MAX_NOTES_PER_SESSION) fail('too_many', notesPath, `La sesión admite hasta ${STUDIO_MAX_NOTES_PER_SESSION} notas`)
  const indexed = rawNotes.map((item, i) => ({ note: parseNote(item, `${notesPath}[${i}]`, lengthBeats), index: i }))
  indexed.sort((a, b) => compareNotes(a.note, b.note))
  const lastEnd = new Map<number, number>()
  for (const { note, index } of indexed) {
    const end = lastEnd.get(note.pitch)
    if (end !== undefined && note.start < end - STUDIO_NOTE_EPSILON_BEATS) {
      fail('note_overlap', `${notesPath}[${index}].start`, `La nota se solapa con otra del mismo tono (${note.pitch})`)
    }
    lastEnd.set(note.pitch, note.start + note.length)
  }
  const clip: StudioMidiClip = { id: clipId, startBeat, lengthBeats, loop, loopBeats, notes: indexed.map((x) => x.note) }
  if (muted) clip.muted = true
  return clip
}

const TRACK_COMMON_KEYS = ['id', 'name', 'role', 'volume_db', 'pan', 'mute', 'solo', 'reverb_send_db', 'fx'] as const

function parseTrack(
  raw: unknown,
  path: string,
  version: 1 | 2,
  bpm: number,
  assets: ReadonlyMap<string, StudioAsset>,
  counters: ParseCounters,
): StudioTrack {
  const o = asObject(raw, path)
  let kind: StudioTrackKind = 'audio'
  if (version === 1) {
    checkKeys(o, path, [...TRACK_COMMON_KEYS, 'clips'])
  } else {
    if (o.kind === undefined) fail('missing_field', join(path, 'kind'), 'Falta un campo obligatorio')
    kind = oneOf(o, 'kind', path, STUDIO_TRACK_KINDS)
    checkKeys(o, path, kind === 'audio' ? ['id', 'kind', ...TRACK_COMMON_KEYS.slice(1), 'clips'] : ['id', 'kind', ...TRACK_COMMON_KEYS.slice(1), 'instrument', 'midi_clips', 'frozen_asset_id'])
  }
  const trackId = id(o, 'id', path)
  if (trackId === STUDIO_MASTER_ID) fail('bad_id', join(path, 'id'), 'El id "master" está reservado para el bus master')
  if (!isStemRole(o.role)) {
    fail(typeof o.role === 'string' ? 'bad_value' : 'bad_type', join(path, 'role'), 'Rol de pista no admitido')
  }
  const role = o.role

  let clips: StudioClip[] = []
  let instrument: StudioInstrument | null = null
  let midiClips: StudioMidiClip[] = []
  let frozenAssetId: string | null = null

  if (kind === 'audio') {
    const clipsPath = join(path, 'clips')
    clips = list(o, 'clips', path, STUDIO_MAX_CLIPS_PER_TRACK).map((item, i) => {
      const clip = parseClip(item, `${clipsPath}[${i}]`, assets, version)
      if (counters.clipIds.has(clip.id)) fail('duplicate_id', `${clipsPath}[${i}].id`, `El id de clip "${clip.id}" está repetido`)
      counters.clipIds.add(clip.id)
      return clip
    })
  } else {
    instrument = parseInstrument(o.instrument, join(path, 'instrument'), assets)
    const midiPath = join(path, 'midi_clips')
    midiClips = list(o, 'midi_clips', path, STUDIO_MAX_MIDI_CLIPS_PER_TRACK).map((item, i) => {
      const clip = parseMidiClip(item, `${midiPath}[${i}]`, bpm, counters)
      if (counters.clipIds.has(clip.id)) fail('duplicate_id', `${midiPath}[${i}].id`, `El id de clip "${clip.id}" está repetido`)
      counters.clipIds.add(clip.id)
      return clip
    })
    frozenAssetId = nullableId(o, 'frozen_asset_id', path)
    if (frozenAssetId !== null && !assets.has(frozenAssetId)) {
      fail('unknown_asset', join(path, 'frozen_asset_id'), `El congelado usa el audio "${frozenAssetId}", que no está en la sesión`)
    }
  }

  return {
    id: trackId,
    kind,
    name: text(o, 'name', path, 1, STUDIO_MAX_TRACK_NAME),
    role,
    volumeDb: num(o, 'volume_db', path, STUDIO_VOLUME_DB_MIN, STUDIO_VOLUME_DB_MAX),
    pan: num(o, 'pan', path, -1, 1),
    mute: bool(o, 'mute', path),
    solo: bool(o, 'solo', path),
    reverbSendDb: num(o, 'reverb_send_db', path, STUDIO_REVERB_SEND_DB_MIN, STUDIO_REVERB_SEND_DB_MAX),
    fx: parseFxChain(list(o, 'fx', path, version === 1 ? 2 : 5), join(path, 'fx'), 'track', version),
    clips,
    instrument,
    midiClips,
    frozenAssetId,
  }
}

function parseMarkers(raw: unknown, bpm: number): StudioMarker[] {
  const container: Raw = { markers: raw }
  const ids = new Set<string>()
  const markers = list(container, 'markers', '', STUDIO_MAX_MARKERS).map((item, i) => {
    const path = `markers[${i}]`
    const o = asObject(item, path)
    checkKeys(o, path, ['id', 'beat', 'label', 'kind'])
    const marker: StudioMarker = {
      id: id(o, 'id', path),
      beat: num(o, 'beat', path, 0, STUDIO_MAX_BEAT),
      label: text(o, 'label', path, 0, STUDIO_MAX_MARKER_LABEL),
      kind: oneOf(o, 'kind', path, STUDIO_MARKER_KINDS),
    }
    if (ids.has(marker.id)) fail('duplicate_id', join(path, 'id'), `El id de marca "${marker.id}" está repetido`)
    ids.add(marker.id)
    if (beatsToSeconds(marker.beat, bpm) > STUDIO_MAX_SESSION_SECONDS + STUDIO_TIME_EPSILON_S) {
      fail('session_too_long', join(path, 'beat'), 'La marca queda después de los 20 minutos que admite una sesión')
    }
    return marker
  })
  return markers.sort(compareMarkers)
}

export function compareChords(a: { beat: number; name: string }, b: { beat: number; name: string }): number {
  return a.beat - b.beat || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

/** Acordes de referencia (STUDIO_V2.md 2.9), ordenados por beat y nombre. */
function parseChords(raw: unknown, bpm: number): StudioChord[] {
  const container: Raw = { chords: raw }
  const chords = list(container, 'chords', '', STUDIO_MAX_SESSION_CHORDS).map((item, i) => {
    const path = `chords[${i}]`
    const o = asObject(item, path)
    checkKeys(o, path, ['beat', 'length_beats', 'name'])
    const beat = num(o, 'beat', path, 0, STUDIO_MAX_BEAT)
    const lengthBeats = num(o, 'length_beats', path, 0, STUDIO_MAX_BEAT)
    if (!(lengthBeats > 0)) fail('out_of_range', join(path, 'length_beats'), 'El acorde debe durar más de 0 beats')
    const name = text(o, 'name', path, 1, STUDIO_MAX_SESSION_CHORD_NAME)
    if (beatsToSeconds(beat + lengthBeats, bpm) > STUDIO_MAX_SESSION_SECONDS + STUDIO_TIME_EPSILON_S) {
      fail('session_too_long', join(path, 'length_beats'), 'El acorde termina después de los 20 minutos que admite una sesión')
    }
    return { beat, lengthBeats, name }
  })
  return chords.sort(compareChords)
}

function parseMaster(raw: unknown, path: string, version: 1 | 2 = 2): StudioMaster {
  const o = asObject(raw, path)
  checkKeys(o, path, ['volume_db', 'fx', 'reverb'])
  const reverbPath = join(path, 'reverb')
  const r = asObject(o.reverb, reverbPath)
  checkKeys(r, reverbPath, ['decay_s', 'return_db'])
  return {
    volumeDb: num(o, 'volume_db', path, STUDIO_VOLUME_DB_MIN, STUDIO_VOLUME_DB_MAX),
    fx: parseFxChain(list(o, 'fx', path, version === 1 ? 3 : 6), join(path, 'fx'), 'master', version),
    reverb: {
      decayS: num(r, 'decay_s', reverbPath, STUDIO_REVERB_DECAY_S_MIN, STUDIO_REVERB_DECAY_S_MAX),
      returnDb: num(r, 'return_db', reverbPath, STUDIO_REVERB_RETURN_DB_MIN, STUDIO_REVERB_RETURN_DB_MAX),
    },
  }
}

// ---------------------------------------------------------------------------
// parseSession
// ---------------------------------------------------------------------------

const ROOT_KEYS_V1 = [
  'version',
  'id',
  'title',
  'song_id',
  'bpm',
  'beats_per_bar',
  'key',
  'sample_rate',
  'latency_offset_ms',
  'updated_at',
  'updated_by',
  'assets',
  'tracks',
  'master',
] as const

/**
 * Valida un documento de sesion del cable (objeto ya decodificado de JSON, snake_case), version
 * 1 o 2, y lo devuelve en camelCase y en version 2 (un v1 se migra: STUDIO_V2.md 1). Un v1 se
 * valida con las reglas de v1 (un campo de v2 en un v1 es `unknown_field`). Lanza
 * StudioSessionError ante el primer problema. No comprueba el tamano del documento: eso lo hacen
 * parseSessionJson y sessionToJson, que ven el texto.
 */
export function parseSession(raw: unknown): StudioSession {
  const o = asObject(raw, '')
  if (o.version === undefined) fail('missing_field', 'version', 'Falta un campo obligatorio')
  if (o.version !== 1 && o.version !== 2) fail('unsupported_version', 'version', 'Este Hub solo entiende sesiones de las versiones 1 y 2')
  const version = o.version
  if (version === 1) checkKeys(o, '', ROOT_KEYS_V1)
  else checkKeys(o, '', ROOT_KEYS_V1, ['markers', 'chords'])

  const title = text(o, 'title', '', 1, 400).trim()
  if (title.length < 1 || title.length > STUDIO_MAX_TITLE) fail('out_of_range', 'title', `El título debe tener entre 1 y ${STUDIO_MAX_TITLE} caracteres`)

  const sampleRate = int(o, 'sample_rate', '', STUDIO_ASSET_SAMPLE_RATE_MIN, STUDIO_ASSET_SAMPLE_RATE_MAX)
  if (!STUDIO_SAMPLE_RATES.includes(sampleRate)) fail('bad_value', 'sample_rate', `Frecuencia de sesión no admitida: ${sampleRate}`)

  const updatedAt = text(o, 'updated_at', '', 1, 40)
  if (Number.isNaN(Date.parse(updatedAt))) fail('bad_value', 'updated_at', 'La fecha no es ISO 8601')

  // El tempo se lee antes que las pistas: los clips MIDI y las marcas se acotan en segundos.
  const bpm = num(o, 'bpm', '', STUDIO_BPM_MIN, STUDIO_BPM_MAX)

  const assets = new Map<string, StudioAsset>()
  list(o, 'assets', '', STUDIO_MAX_ASSETS).forEach((item, i) => {
    const asset = parseAsset(item, `assets[${i}]`)
    if (assets.has(asset.id)) fail('duplicate_id', `assets[${i}].id`, `El id de audio "${asset.id}" está repetido`)
    assets.set(asset.id, asset)
  })

  const trackIds = new Set<string>()
  const counters: ParseCounters = { clipIds: new Set<string>(), notes: 0 }
  const tracks = list(o, 'tracks', '', STUDIO_MAX_TRACKS).map((item, i) => {
    const track = parseTrack(item, `tracks[${i}]`, version, bpm, assets, counters)
    if (trackIds.has(track.id)) fail('duplicate_id', `tracks[${i}].id`, `El id de pista "${track.id}" está repetido`)
    trackIds.add(track.id)
    return track
  })

  const markers = version === 2 && o.markers !== undefined ? parseMarkers(o.markers, bpm) : []
  // Sin acordes la sesion no lleva la clave: un documento sin acordes vuelve identico.
  const chords = version === 2 && o.chords !== undefined ? parseChords(o.chords, bpm) : []

  return {
    version: 2,
    id: id(o, 'id', ''),
    title,
    songId: nullableId(o, 'song_id', ''),
    bpm,
    beatsPerBar: int(o, 'beats_per_bar', '', STUDIO_BEATS_PER_BAR_MIN, STUDIO_BEATS_PER_BAR_MAX),
    key: o.key === null ? null : text(o, 'key', '', 1, STUDIO_MAX_KEY),
    sampleRate,
    latencyOffsetMs: num(o, 'latency_offset_ms', '', STUDIO_LATENCY_OFFSET_MS_MIN, STUDIO_LATENCY_OFFSET_MS_MAX),
    updatedAt,
    updatedBy: o.updated_by === null ? null : text(o, 'updated_by', '', 1, 80),
    assets: [...assets.values()],
    tracks,
    markers,
    ...(chords.length > 0 ? { chords } : {}),
    master: parseMaster(o.master, 'master', version),
  }
}

/**
 * Migra un documento v1 del cable a v2 del cable (STUDIO_V2.md 1): lo valida con las reglas de
 * v1 y devuelve el v2 que escribiria serializeSession. Lanza `unsupported_version` si no es v1.
 */
export function migrateSessionV1(raw: unknown): WireStudioSession {
  const o = asObject(raw, '')
  if (o.version !== 1) fail('unsupported_version', 'version', 'Solo se migran documentos de la versión 1')
  return serializeSession(parseSession(o))
}

// ---------------------------------------------------------------------------
// serializeSession
// ---------------------------------------------------------------------------

function instrumentToWire(instrument: StudioInstrument): WireStudioInstrument {
  switch (instrument.type) {
    case 'synth':
      return { type: 'synth', preset: instrument.preset, params: instrumentParamsToWire('synth', instrument.params) }
    case 'drums':
      return { type: 'drums', preset: instrument.preset, params: instrumentParamsToWire('drums', instrument.params) }
    case 'sampler':
      return {
        type: 'sampler',
        params: instrumentParamsToWire('sampler', instrument.params),
        zones: (instrument.zones ?? []).map((z) => ({
          asset_id: z.assetId,
          root_pitch: z.rootPitch,
          low_pitch: z.lowPitch,
          high_pitch: z.highPitch,
          low_velocity: z.lowVelocity,
          high_velocity: z.highVelocity,
          offset_s: z.offsetS,
          length_s: z.lengthS,
          gain_db: z.gainDb,
          tune_cents: z.tuneCents,
        })),
      }
    case 'wam':
      return { type: 'wam', plugin_id: instrument.pluginId, state: instrument.state === undefined ? instrument.state : cloneJson(instrument.state) }
  }
}

function midiClipToWire(c: StudioMidiClip): WireStudioMidiClip {
  const wire: WireStudioMidiClip = {
    id: c.id,
    start_beat: c.startBeat,
    length_beats: c.lengthBeats,
    loop: c.loop,
    loop_beats: c.loopBeats,
    notes: sortNotes(c.notes ?? []).map((n) => ({ pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity })),
  }
  if (c.muted === true) wire.muted = true
  return wire
}

function clipToWire(c: StudioClip): WireStudioClip {
  const wire: WireStudioClip = {
    id: c.id,
    asset_id: c.assetId,
    start_s: c.startS,
    offset_s: c.offsetS,
    length_s: c.lengthS,
    gain_db: c.gainDb,
    fade_in_s: c.fadeInS,
    fade_out_s: c.fadeOutS,
    take_group: c.takeGroup,
    active: c.active,
  }
  if (c.phaseInvert === true) wire.phase_invert = true
  if (c.fadeShape === 'exp' || c.fadeShape === 'scurve') wire.fade_shape = c.fadeShape
  return wire
}

function trackToWire(t: StudioTrack): WireStudioTrack {
  const common = {
    id: t.id,
    kind: t.kind,
    name: t.name,
    role: t.role,
    volume_db: t.volumeDb,
    pan: t.pan,
    mute: t.mute,
    solo: t.solo,
    reverb_send_db: t.reverbSendDb,
    fx: (t.fx ?? []).map(serializeFx),
  }
  // Una pista que no cumple la regla de su kind se escribe con el campo sobrante, para que la
  // validacion la rechace (unknown_field) en vez de perder datos en silencio.
  if (t.kind === 'instrument') {
    const wire: Record<string, unknown> = {
      ...common,
      instrument: t.instrument ? instrumentToWire(t.instrument) : t.instrument,
      midi_clips: (t.midiClips ?? []).map(midiClipToWire),
      frozen_asset_id: t.frozenAssetId,
    }
    if (t.clips && t.clips.length > 0) wire.clips = t.clips.map(clipToWire)
    return wire as unknown as WireStudioInstrumentTrack
  }
  const wire: Record<string, unknown> = { ...common, clips: (t.clips ?? []).map(clipToWire) }
  if (t.instrument) wire.instrument = instrumentToWire(t.instrument)
  if (t.midiClips && t.midiClips.length > 0) wire.midi_clips = t.midiClips.map(midiClipToWire)
  if (t.frozenAssetId) wire.frozen_asset_id = t.frozenAssetId
  return wire as unknown as WireStudioAudioTrack
}

function toWire(s: StudioSession): WireStudioSession {
  return {
    version: 2,
    id: s.id,
    title: s.title,
    song_id: s.songId,
    bpm: s.bpm,
    beats_per_bar: s.beatsPerBar,
    key: s.key,
    sample_rate: s.sampleRate,
    latency_offset_ms: s.latencyOffsetMs,
    updated_at: s.updatedAt,
    updated_by: s.updatedBy,
    assets: (s.assets ?? []).map((a) => {
      let source: WireStudioAssetSource | null = null
      if (a.source) {
        source = { provider: a.source.provider, job_id: a.source.jobId }
        if (a.source.prompt !== undefined) source.prompt = a.source.prompt
      }
      return {
        id: a.id,
        file: a.file,
        kind: a.kind,
        label: a.label,
        channels: a.channels,
        sample_rate: a.sampleRate,
        duration_s: a.durationS,
        size: a.size,
        source,
      }
    }),
    tracks: (s.tracks ?? []).map(trackToWire),
    markers: [...(s.markers ?? [])].sort(compareMarkers).map((m) => ({ id: m.id, beat: m.beat, label: m.label, kind: m.kind })),
    ...(s.chords && s.chords.length > 0
      ? { chords: [...s.chords].sort(compareChords).map((c) => ({ beat: c.beat, length_beats: c.lengthBeats, name: c.name })) }
      : {}),
    master: {
      volume_db: s.master?.volumeDb,
      fx: (s.master?.fx ?? []).map(serializeFx),
      reverb: { decay_s: s.master?.reverb?.decayS, return_db: s.master?.reverb?.returnDb },
    },
  }
}

/**
 * Traduce una sesion del Hub al documento del cable v2 (snake_case, claves en el orden del
 * contrato, notas y marcas en su orden canonico). Valida antes de devolver: una sesion invalida
 * lanza StudioSessionError, asi el Hub nunca guarda ni sube un documento que despues no podria
 * leer.
 */
export function serializeSession(s: StudioSession): WireStudioSession {
  const wire = toWire(s)
  parseSession(wire)
  return wire
}

/** Valida una sesion del Hub y devuelve una copia normalizada (titulo recortado, notas y marcas ordenadas). */
export function validateSession(s: StudioSession): StudioSession {
  return parseSession(toWire(s))
}

/** Texto JSON listo para guardar o subir. Lanza `document_too_large` si pasa de 1 MiB. */
export function sessionToJson(s: StudioSession): string {
  const json = JSON.stringify(serializeSession(s))
  if (utf8Bytes(json) > STUDIO_MAX_DOCUMENT_BYTES) fail('document_too_large', '', 'La sesión supera 1 MB, el tamaño que admite el documento')
  return json
}

/** Lee una sesion (v1 o v2) desde su texto JSON, con el limite de tamano del documento. */
export function parseSessionJson(json: string): StudioSession {
  if (utf8Bytes(json) > STUDIO_MAX_DOCUMENT_BYTES) fail('document_too_large', '', 'La sesión supera 1 MB, el tamaño que admite el documento')
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    fail('not_an_object', '', 'El documento no es JSON válido')
  }
  return parseSession(raw)
}

// ---------------------------------------------------------------------------
// Sesiones nuevas y ayudas
// ---------------------------------------------------------------------------

export type StudioIdPrefix = 'ses' | 'ast' | 'trk' | 'clp' | 'tk' | 'job' | 'mid' | 'mk' | 'cmt' | 'sec' | 'song'

/** Id nuevo con prefijo: "trk_3fa9c2d1" (8 hexadecimales al azar). */
export function newStudioId(prefix: StudioIdPrefix): string {
  const bytes = new Uint8Array(4)
  const source = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto
  if (source?.getRandomValues) source.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `${prefix}_${hex}`
}

export interface NewSessionInput {
  /** Por defecto, uno nuevo con prefijo "ses". */
  id?: string
  title: string
  /** Frecuencia del AudioContext; debe estar en STUDIO_SAMPLE_RATES. */
  sampleRate: number
  /** 120 por defecto. */
  bpm?: number
  /** 4 por defecto. */
  beatsPerBar?: number
  key?: string | null
  songId?: string | null
  updatedBy?: string | null
  /** Fecha de creacion (inyectable en pruebas). Por defecto, ahora. */
  now?: Date
}

/** El master de una sesion nueva: sin EQ ni compresor, con limitador a -1 dB. */
export function defaultMaster(): StudioMaster {
  return { volumeDb: 0, fx: [defaultFx('limiter')], reverb: { ...STUDIO_REVERB_DEFAULT } }
}

export interface NewTrackInput {
  id: string
  name: string
  /** 'unknown' por defecto. */
  role?: StemRole
}

/** Una pista de AUDIO vacia con los valores neutros: 0 dB, centro, sin envio, sin efectos. */
export function defaultTrack(input: NewTrackInput): StudioTrack {
  return {
    id: input.id,
    kind: 'audio',
    name: input.name,
    role: input.role ?? 'unknown',
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    reverbSendDb: STUDIO_REVERB_SEND_DB_MIN,
    fx: [],
    clips: [],
    instrument: null,
    midiClips: [],
    frozenAssetId: null,
  }
}

/**
 * Un instrumento nuevo de un tipo con parametros. synth y drums toman el preset pedido (o el
 * del tipo por defecto); el sampler empieza sin zonas. Un preset de otro tipo lanza `bad_value`.
 */
export function defaultInstrument(type: StudioParamInstrumentType, preset?: string | null): StudioInstrument {
  if (type === 'synth') {
    const id = preset ?? STUDIO_DEFAULT_SYNTH_PRESET
    if (!isSynthPresetId(id)) fail('bad_value', 'preset', `Preset de sintetizador desconocido: "${id}"`)
    return { type, preset: id, params: synthPresetParams(id) }
  }
  if (type === 'drums') {
    const id = preset ?? STUDIO_DEFAULT_DRUMS_PRESET
    if (!isDrumsPresetId(id)) fail('bad_value', 'preset', `Preset de caja de ritmos desconocido: "${id}"`)
    return { type, preset: id, params: drumsPresetParams(id) }
  }
  if (preset !== undefined && preset !== null) fail('bad_value', 'preset', 'El sampler no tiene presets')
  return { type, params: defaultSamplerParams(), zones: [] }
}

/** Rol que el Hub propone para una pista de instrumento nueva (STUDIO_V2.md 2.2). */
export function defaultRoleForInstrument(type: StudioInstrumentType): StemRole {
  if (type === 'drums') return 'drums'
  if (type === 'synth') return 'keys'
  return 'other'
}

export interface NewInstrumentTrackInput {
  id: string
  name: string
  instrument: StudioInstrument
  /** Por defecto, defaultRoleForInstrument del tipo. */
  role?: StemRole
}

/** Una pista de INSTRUMENTO vacia (sin clips MIDI ni congelado), con los valores neutros. */
export function defaultInstrumentTrack(input: NewInstrumentTrackInput): StudioTrack {
  return {
    ...defaultTrack({ id: input.id, name: input.name, role: input.role ?? defaultRoleForInstrument(input.instrument.type) }),
    kind: 'instrument',
    instrument: input.instrument,
  }
}

export interface NewMidiClipInput {
  id: string
  startBeat: number
  lengthBeats: number
  notes?: StudioMidiNote[]
}

/** Un clip MIDI sin repeticion (`loopBeats` = `lengthBeats`). No valida: lo hace sessionOps. */
export function defaultMidiClip(input: NewMidiClipInput): StudioMidiClip {
  return {
    id: input.id,
    startBeat: input.startBeat,
    lengthBeats: input.lengthBeats,
    loop: false,
    loopBeats: input.lengthBeats,
    notes: sortNotes(input.notes ?? []),
  }
}

/** Sesion vacia y valida (version 2). Lanza StudioSessionError si algun dato no cumple el contrato. */
export function newSession(input: NewSessionInput): StudioSession {
  return validateSession({
    version: 2,
    id: input.id ?? newStudioId('ses'),
    title: input.title,
    songId: input.songId ?? null,
    bpm: input.bpm ?? 120,
    beatsPerBar: input.beatsPerBar ?? 4,
    key: input.key ?? null,
    sampleRate: input.sampleRate,
    latencyOffsetMs: 0,
    updatedAt: (input.now ?? new Date()).toISOString(),
    updatedBy: input.updatedBy ?? null,
    assets: [],
    tracks: [],
    markers: [],
    master: defaultMaster(),
  })
}

export interface ClipLocation {
  track: StudioTrack
  trackIndex: number
  clip: StudioClip
  clipIndex: number
}

/** Donde esta un clip de AUDIO, o null si no existe (los ids de clip son unicos en la sesion). */
export function findClip(session: StudioSession, clipId: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < session.tracks.length; trackIndex++) {
    const track = session.tracks[trackIndex]
    const clipIndex = track.clips.findIndex((c) => c.id === clipId)
    if (clipIndex >= 0) return { track, trackIndex, clip: track.clips[clipIndex], clipIndex }
  }
  return null
}

export interface MidiClipLocation {
  track: StudioTrack
  trackIndex: number
  clip: StudioMidiClip
  clipIndex: number
}

/** Donde esta un clip MIDI, o null si no existe. */
export function findMidiClip(session: StudioSession, clipId: string): MidiClipLocation | null {
  for (let trackIndex = 0; trackIndex < session.tracks.length; trackIndex++) {
    const track = session.tracks[trackIndex]
    const clipIndex = (track.midiClips ?? []).findIndex((c) => c.id === clipId)
    if (clipIndex >= 0) return { track, trackIndex, clip: track.midiClips[clipIndex], clipIndex }
  }
  return null
}

/** true si algun clip de audio o MIDI de la sesion ya usa ese id. */
export function isClipIdTaken(session: StudioSession, clipId: string): boolean {
  return findClip(session, clipId) !== null || findMidiClip(session, clipId) !== null
}

export function findTrack(session: StudioSession, trackId: string): StudioTrack | null {
  return session.tracks.find((t) => t.id === trackId) ?? null
}

export function findAsset(session: StudioSession, assetId: string): StudioAsset | null {
  return session.assets.find((a) => a.id === assetId) ?? null
}

export function findMarker(session: StudioSession, markerId: string): StudioMarker | null {
  return (session.markers ?? []).find((m) => m.id === markerId) ?? null
}

/** Notas de toda la sesion (para el tope STUDIO_MAX_NOTES_PER_SESSION). */
export function countSessionNotes(session: StudioSession): number {
  let total = 0
  for (const track of session.tracks) for (const clip of track.midiClips ?? []) total += clip.notes.length
  return total
}

/** Ids de los audios que usa la sesion: clips, zonas del sampler y congelados. */
export function usedAssetIds(session: StudioSession): Set<string> {
  const used = new Set<string>()
  for (const track of session.tracks) {
    for (const clip of track.clips) used.add(clip.assetId)
    if (track.frozenAssetId) used.add(track.frozenAssetId)
    if (track.instrument?.type === 'sampler') for (const zone of track.instrument.zones) used.add(zone.assetId)
  }
  return used
}

/**
 * Segundo en que termina el ultimo clip activo de la sesion (audio o MIDI); 0 si no hay
 * ninguno. Los clips MIDI se convierten con el bpm de la sesion. El congelado no cuenta.
 */
export function sessionEndSeconds(session: StudioSession): number {
  let end = 0
  for (const track of session.tracks) {
    for (const clip of track.clips) {
      if (clip.active && clip.startS + clip.lengthS > end) end = clip.startS + clip.lengthS
    }
    for (const clip of track.midiClips ?? []) {
      // Igual que un clip de audio inactivo, un clip MIDI silenciado no alarga lo que suena.
      if (clip.muted) continue
      const clipEnd = beatsToSeconds(clip.startBeat + clip.lengthBeats, session.bpm)
      if (clipEnd > end) end = clipEnd
    }
  }
  return end
}
