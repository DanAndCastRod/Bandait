/**
 * Documento de sesion del Estudio Bandait. Contrato normativo: bandait-protocol/STUDIO_V1.md
 * (seccion 2); ejemplo canonico: bandait-protocol/fixtures/studio_session.json.
 *
 * Este modulo es la UNICA frontera snake_case <-> camelCase del Estudio: en el cable (Worker,
 * R2, IndexedDB) el documento va en snake_case; dentro del Hub se usa `StudioSession` en
 * camelCase. `parseSession` valida y traduce lo que llega; `serializeSession` valida y traduce
 * lo que sale. La validacion es estricta: un campo desconocido, ausente o fuera de rango lanza
 * `StudioSessionError` con `code`, `path` y un mensaje en espanol.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env (se prueba con
 * node --experimental-strip-types en scripts/verify-studio-logic.ts).
 */
import { isStemRole, type StemRole } from '../stemNames.ts'

// ---------------------------------------------------------------------------
// Limites y constantes (STUDIO_V1.md, secciones 1 y 2)
// ---------------------------------------------------------------------------

export const STUDIO_SESSION_VERSION = 1

export const STUDIO_MAX_TRACKS = 16
export const STUDIO_MAX_SESSION_SECONDS = 1200
export const STUDIO_MAX_DOCUMENT_BYTES = 256 * 1024
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

/** Patron de todo id del Estudio (sesion, audio, pista, clip, take_group, trabajo). */
export const STUDIO_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
/** Id reservado para el bus master (sugerencias del asistente, setTrackFx). No es una pista. */
export const STUDIO_MASTER_ID = 'master'

export const STUDIO_ASSET_EXTENSIONS = ['wav', 'flac', 'mp3'] as const
export const STUDIO_ASSET_KINDS = ['recording', 'import', 'stem', 'generated', 'bounce', 'master'] as const
export const STUDIO_PROVIDERS = ['musicai', 'lyria', 'suno'] as const
export const STUDIO_FX_TYPES = ['eq', 'compressor', 'limiter'] as const

/** Frecuencias fijas del EQ (STUDIO_V1.md 2.6). */
export const STUDIO_EQ_LOW_SHELF_HZ = 120
export const STUDIO_EQ_HIGH_SHELF_HZ = 8000
export const STUDIO_EQ_HPF_Q = 0.707
/** Anticipacion fija del limitador, en milisegundos. */
export const STUDIO_LIMITER_LOOKAHEAD_MS = 5

// ---------------------------------------------------------------------------
// Tipos del Hub (camelCase)
// ---------------------------------------------------------------------------

export type StudioAssetExtension = (typeof STUDIO_ASSET_EXTENSIONS)[number]
export type StudioAssetKind = (typeof STUDIO_ASSET_KINDS)[number]
export type StudioProvider = (typeof STUDIO_PROVIDERS)[number]
export type StudioFxType = (typeof STUDIO_FX_TYPES)[number]

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

export interface LimiterParams {
  ceilingDb: number
  releaseMs: number
}

export interface StudioFxParamsByType {
  eq: EqParams
  compressor: CompressorParams
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

/** Solo valido en el master, y de ultimo. */
export interface LimiterFx {
  type: 'limiter'
  bypass: boolean
  params: LimiterParams
}

export type StudioFx = EqFx | CompressorFx | LimiterFx

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
}

export interface StudioTrack {
  id: string
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
  clips: StudioClip[]
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
  version: 1
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
  master: StudioMaster
}

// ---------------------------------------------------------------------------
// Tipos del cable (snake_case), tal como estan en STUDIO_V1.md
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
}

export interface WireStudioTrack {
  id: string
  name: string
  role: StemRole
  volume_db: number
  pan: number
  mute: boolean
  solo: boolean
  reverb_send_db: number
  fx: WireStudioFx[]
  clips: WireStudioClip[]
}

export interface WireStudioMaster {
  volume_db: number
  fx: WireStudioFx[]
  reverb: { decay_s: number; return_db: number }
}

export interface WireStudioSession {
  version: 1
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
  tracks: WireStudioTrack[]
  master: WireStudioMaster
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

/** Codigos de STUDIO_V1.md 2.9. */
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

/** Tabla de STUDIO_V1.md 2.6. La interfaz arma sus controles desde aqui. */
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
    if (!required.includes(key) && !optional.includes(key)) fail('unknown_field', join(path, key), 'Campo desconocido para la versión 1')
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
export function parseFx(raw: unknown, path = 'fx'): StudioFx {
  const o = asObject(raw, path)
  checkKeys(o, path, ['type', 'bypass', 'params'])
  const type = oneOf(o, 'type', path, STUDIO_FX_TYPES)
  const bypass = bool(o, 'bypass', path)
  const params = readFxParams(type, o.params, join(path, 'params'), false)
  return { type, bypass, params } as unknown as StudioFx
}

export function serializeFx(fx: StudioFx): WireStudioFx {
  return { type: fx.type, bypass: fx.bypass, params: fxParamsToWire(fx.type, fx.params as Partial<StudioFxParamsByType[typeof fx.type]>) }
}

function parseFxChain(raw: unknown[], path: string, where: 'track' | 'master'): StudioFx[] {
  const chain = raw.map((item, i) => parseFx(item, `${path}[${i}]`))
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
// parseSession
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

function parseClip(raw: unknown, path: string, assets: ReadonlyMap<string, StudioAsset>): StudioClip {
  const o = asObject(raw, path)
  checkKeys(o, path, ['id', 'asset_id', 'start_s', 'offset_s', 'length_s', 'gain_db', 'fade_in_s', 'fade_out_s', 'take_group', 'active'])
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

function parseTrack(raw: unknown, path: string, assets: ReadonlyMap<string, StudioAsset>, clipIds: Set<string>): StudioTrack {
  const o = asObject(raw, path)
  checkKeys(o, path, ['id', 'name', 'role', 'volume_db', 'pan', 'mute', 'solo', 'reverb_send_db', 'fx', 'clips'])
  const trackId = id(o, 'id', path)
  if (trackId === STUDIO_MASTER_ID) fail('bad_id', join(path, 'id'), 'El id "master" está reservado para el bus master')
  if (!isStemRole(o.role)) {
    fail(typeof o.role === 'string' ? 'bad_value' : 'bad_type', join(path, 'role'), 'Rol de pista no admitido')
  }
  const clipsPath = join(path, 'clips')
  const clips = list(o, 'clips', path, STUDIO_MAX_CLIPS_PER_TRACK).map((item, i) => {
    const clip = parseClip(item, `${clipsPath}[${i}]`, assets)
    if (clipIds.has(clip.id)) fail('duplicate_id', `${clipsPath}[${i}].id`, `El id de clip "${clip.id}" está repetido`)
    clipIds.add(clip.id)
    return clip
  })
  return {
    id: trackId,
    name: text(o, 'name', path, 1, STUDIO_MAX_TRACK_NAME),
    role: o.role,
    volumeDb: num(o, 'volume_db', path, STUDIO_VOLUME_DB_MIN, STUDIO_VOLUME_DB_MAX),
    pan: num(o, 'pan', path, -1, 1),
    mute: bool(o, 'mute', path),
    solo: bool(o, 'solo', path),
    reverbSendDb: num(o, 'reverb_send_db', path, STUDIO_REVERB_SEND_DB_MIN, STUDIO_REVERB_SEND_DB_MAX),
    fx: parseFxChain(list(o, 'fx', path, 2), join(path, 'fx'), 'track'),
    clips,
  }
}

function parseMaster(raw: unknown, path: string): StudioMaster {
  const o = asObject(raw, path)
  checkKeys(o, path, ['volume_db', 'fx', 'reverb'])
  const reverbPath = join(path, 'reverb')
  const r = asObject(o.reverb, reverbPath)
  checkKeys(r, reverbPath, ['decay_s', 'return_db'])
  return {
    volumeDb: num(o, 'volume_db', path, STUDIO_VOLUME_DB_MIN, STUDIO_VOLUME_DB_MAX),
    fx: parseFxChain(list(o, 'fx', path, 3), join(path, 'fx'), 'master'),
    reverb: {
      decayS: num(r, 'decay_s', reverbPath, STUDIO_REVERB_DECAY_S_MIN, STUDIO_REVERB_DECAY_S_MAX),
      returnDb: num(r, 'return_db', reverbPath, STUDIO_REVERB_RETURN_DB_MIN, STUDIO_REVERB_RETURN_DB_MAX),
    },
  }
}

/**
 * Valida un documento de sesion del cable (objeto ya decodificado de JSON, snake_case) y lo
 * devuelve en camelCase. Lanza StudioSessionError ante el primer problema. No comprueba el
 * tamano del documento: eso lo hacen parseSessionJson y sessionToJson, que ven el texto.
 */
export function parseSession(raw: unknown): StudioSession {
  const o = asObject(raw, '')
  if (o.version === undefined) fail('missing_field', 'version', 'Falta un campo obligatorio')
  if (o.version !== STUDIO_SESSION_VERSION) fail('unsupported_version', 'version', 'Este Hub solo entiende sesiones de la versión 1')
  checkKeys(o, '', [
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
  ])

  const title = text(o, 'title', '', 1, 400).trim()
  if (title.length < 1 || title.length > STUDIO_MAX_TITLE) fail('out_of_range', 'title', `El título debe tener entre 1 y ${STUDIO_MAX_TITLE} caracteres`)

  const sampleRate = int(o, 'sample_rate', '', STUDIO_ASSET_SAMPLE_RATE_MIN, STUDIO_ASSET_SAMPLE_RATE_MAX)
  if (!STUDIO_SAMPLE_RATES.includes(sampleRate)) fail('bad_value', 'sample_rate', `Frecuencia de sesión no admitida: ${sampleRate}`)

  const updatedAt = text(o, 'updated_at', '', 1, 40)
  if (Number.isNaN(Date.parse(updatedAt))) fail('bad_value', 'updated_at', 'La fecha no es ISO 8601')

  const assets = new Map<string, StudioAsset>()
  list(o, 'assets', '', STUDIO_MAX_ASSETS).forEach((item, i) => {
    const asset = parseAsset(item, `assets[${i}]`)
    if (assets.has(asset.id)) fail('duplicate_id', `assets[${i}].id`, `El id de audio "${asset.id}" está repetido`)
    assets.set(asset.id, asset)
  })

  const trackIds = new Set<string>()
  const clipIds = new Set<string>()
  const tracks = list(o, 'tracks', '', STUDIO_MAX_TRACKS).map((item, i) => {
    const track = parseTrack(item, `tracks[${i}]`, assets, clipIds)
    if (trackIds.has(track.id)) fail('duplicate_id', `tracks[${i}].id`, `El id de pista "${track.id}" está repetido`)
    trackIds.add(track.id)
    return track
  })

  return {
    version: 1,
    id: id(o, 'id', ''),
    title,
    songId: nullableId(o, 'song_id', ''),
    bpm: num(o, 'bpm', '', STUDIO_BPM_MIN, STUDIO_BPM_MAX),
    beatsPerBar: int(o, 'beats_per_bar', '', STUDIO_BEATS_PER_BAR_MIN, STUDIO_BEATS_PER_BAR_MAX),
    key: o.key === null ? null : text(o, 'key', '', 1, STUDIO_MAX_KEY),
    sampleRate,
    latencyOffsetMs: num(o, 'latency_offset_ms', '', STUDIO_LATENCY_OFFSET_MS_MIN, STUDIO_LATENCY_OFFSET_MS_MAX),
    updatedAt,
    updatedBy: o.updated_by === null ? null : text(o, 'updated_by', '', 1, 80),
    assets: [...assets.values()],
    tracks,
    master: parseMaster(o.master, 'master'),
  }
}

// ---------------------------------------------------------------------------
// serializeSession
// ---------------------------------------------------------------------------

function toWire(s: StudioSession): WireStudioSession {
  return {
    version: s.version,
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
    tracks: (s.tracks ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      volume_db: t.volumeDb,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      reverb_send_db: t.reverbSendDb,
      fx: (t.fx ?? []).map(serializeFx),
      clips: (t.clips ?? []).map((c) => ({
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
      })),
    })),
    master: {
      volume_db: s.master?.volumeDb,
      fx: (s.master?.fx ?? []).map(serializeFx),
      reverb: { decay_s: s.master?.reverb?.decayS, return_db: s.master?.reverb?.returnDb },
    },
  }
}

/**
 * Traduce una sesion del Hub al documento del cable (snake_case, claves en el orden del
 * contrato). Valida antes de devolver: una sesion invalida lanza StudioSessionError, asi el Hub
 * nunca guarda ni sube un documento que despues no podria leer.
 */
export function serializeSession(s: StudioSession): WireStudioSession {
  const wire = toWire(s)
  parseSession(wire)
  return wire
}

/** Valida una sesion del Hub y devuelve una copia normalizada (titulo recortado). */
export function validateSession(s: StudioSession): StudioSession {
  return parseSession(toWire(s))
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Texto JSON listo para guardar o subir. Lanza `document_too_large` si pasa de 256 KB. */
export function sessionToJson(s: StudioSession): string {
  const json = JSON.stringify(serializeSession(s))
  if (utf8Bytes(json) > STUDIO_MAX_DOCUMENT_BYTES) fail('document_too_large', '', 'La sesión supera los 256 KB que admite el documento')
  return json
}

/** Lee una sesion desde su texto JSON, con el limite de tamano del documento. */
export function parseSessionJson(json: string): StudioSession {
  if (utf8Bytes(json) > STUDIO_MAX_DOCUMENT_BYTES) fail('document_too_large', '', 'La sesión supera los 256 KB que admite el documento')
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

export type StudioIdPrefix = 'ses' | 'ast' | 'trk' | 'clp' | 'tk' | 'job'

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

/** Una pista vacia con los valores neutros: 0 dB, centro, sin envio, sin efectos. */
export function defaultTrack(input: NewTrackInput): StudioTrack {
  return {
    id: input.id,
    name: input.name,
    role: input.role ?? 'unknown',
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    reverbSendDb: STUDIO_REVERB_SEND_DB_MIN,
    fx: [],
    clips: [],
  }
}

/** Sesion vacia y valida. Lanza StudioSessionError si algun dato no cumple el contrato. */
export function newSession(input: NewSessionInput): StudioSession {
  return validateSession({
    version: 1,
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
    master: defaultMaster(),
  })
}

export interface ClipLocation {
  track: StudioTrack
  trackIndex: number
  clip: StudioClip
  clipIndex: number
}

/** Donde esta un clip, o null si no existe (los ids de clip son unicos en la sesion). */
export function findClip(session: StudioSession, clipId: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < session.tracks.length; trackIndex++) {
    const track = session.tracks[trackIndex]
    const clipIndex = track.clips.findIndex((c) => c.id === clipId)
    if (clipIndex >= 0) return { track, trackIndex, clip: track.clips[clipIndex], clipIndex }
  }
  return null
}

export function findTrack(session: StudioSession, trackId: string): StudioTrack | null {
  return session.tracks.find((t) => t.id === trackId) ?? null
}

export function findAsset(session: StudioSession, assetId: string): StudioAsset | null {
  return session.assets.find((a) => a.id === assetId) ?? null
}

/** Segundo en que termina el ultimo clip activo de la sesion; 0 si no hay ninguno. */
export function sessionEndSeconds(session: StudioSession): number {
  let end = 0
  for (const track of session.tracks) {
    for (const clip of track.clips) {
      if (clip.active && clip.startS + clip.lengthS > end) end = clip.startS + clip.lengthS
    }
  }
  return end
}
