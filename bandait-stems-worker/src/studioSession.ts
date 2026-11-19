// Validacion del documento de sesion del Estudio en el Worker. Replica la seccion 2 de
// bandait-protocol/STUDIO_V1.md. El Hub tiene su propia implementacion
// (bandait-leader-web/src/services/studio/session.ts): el Worker es otro paquete y no puede
// importarla, asi que las dos se prueban contra el mismo ejemplo canonico
// (bandait-protocol/fixtures/studio_session.json). Si el contrato cambia, cambian las dos.
//
// El documento viaja y se guarda en snake_case. `validateSession` devuelve una copia normalizada:
// claves en el orden del contrato, titulo recortado y parametros de efecto completos.

export const SESSION_MAX_BYTES = 256 * 1024;
export const ASSET_MAX_BYTES = 200 * 1024 * 1024;
export const MAX_SESSION_SECONDS = 1200;
export const MAX_TRACKS = 16;
export const MAX_ASSETS = 256;
export const MAX_CLIPS_PER_TRACK = 256;
export const MAX_PROMPT = 1000;
export const MAX_TRACK_NAME = 60;
export const VOLUME_DB_MIN = -60;
export const VOLUME_DB_MAX = 12;
const TIME_EPSILON_S = 0.001;
const FADE_EPSILON_S = 0.000001;

export const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const MASTER_ID = 'master';
export const ASSET_EXTENSIONS = ['wav', 'flac', 'mp3'] as const;
export type AssetExtension = (typeof ASSET_EXTENSIONS)[number];
const ASSET_KINDS = ['recording', 'import', 'stem', 'generated', 'bounce', 'master'] as const;
const PROVIDERS = ['musicai', 'lyria', 'suno'] as const;
const SAMPLE_RATES = [44100, 48000, 88200, 96000];
export const FX_TYPES = ['eq', 'compressor', 'limiter'] as const;
export type FxType = (typeof FX_TYPES)[number];

/** Roles de bandait-protocol/fixtures/stem_names.json, mas `unknown`. */
export const ROLES: readonly string[] = [
  'vocals', 'backing_vocals', 'drums', 'bass', 'guitar', 'keys', 'strings', 'wind', 'other',
  'instrumental', 'click', 'guide', 'unknown',
];

export interface FxParamSpec { key: string; min: number; max: number; def: number }

/** Tabla de STUDIO_V1.md 2.6. */
export const FX_PARAM_SPECS: Readonly<Record<FxType, readonly FxParamSpec[]>> = {
  eq: [
    { key: 'hpf_hz', min: 0, max: 1000, def: 0 },
    { key: 'low_db', min: -18, max: 18, def: 0 },
    { key: 'mid_hz', min: 200, max: 8000, def: 1000 },
    { key: 'mid_db', min: -18, max: 18, def: 0 },
    { key: 'mid_q', min: 0.1, max: 10, def: 1 },
    { key: 'high_db', min: -18, max: 18, def: 0 },
  ],
  compressor: [
    { key: 'threshold_db', min: -60, max: 0, def: -18 },
    { key: 'ratio', min: 1, max: 20, def: 3 },
    { key: 'attack_ms', min: 0, max: 1000, def: 10 },
    { key: 'release_ms', min: 10, max: 1000, def: 150 },
    { key: 'knee_db', min: 0, max: 40, def: 6 },
    { key: 'makeup_db', min: 0, max: 24, def: 0 },
  ],
  limiter: [
    { key: 'ceiling_db', min: -12, max: 0, def: -1 },
    { key: 'release_ms', min: 10, max: 1000, def: 100 },
  ],
};

export interface SessionFx { type: FxType; bypass: boolean; params: Record<string, number> }

export interface SessionAssetSource { provider: string; job_id: string; prompt?: string }

export interface SessionAsset {
  id: string; file: string; kind: string; label: string; channels: number; sample_rate: number;
  duration_s: number; size: number; source: SessionAssetSource | null;
}

export interface SessionClip {
  id: string; asset_id: string; start_s: number; offset_s: number; length_s: number; gain_db: number;
  fade_in_s: number; fade_out_s: number; take_group: string | null; active: boolean;
}

export interface SessionTrack {
  id: string; name: string; role: string; volume_db: number; pan: number; mute: boolean; solo: boolean;
  reverb_send_db: number; fx: SessionFx[]; clips: SessionClip[];
}

export interface SessionDocument {
  version: 1; id: string; title: string; song_id: string | null; bpm: number; beats_per_bar: number;
  key: string | null; sample_rate: number; latency_offset_ms: number; updated_at: string;
  updated_by: string | null; assets: SessionAsset[]; tracks: SessionTrack[];
  master: { volume_db: number; fx: SessionFx[]; reverb: { decay_s: number; return_db: number } };
}

/** Documento invalido. `code` y `path` siguen STUDIO_V1.md 2.9 (sirven en las pruebas y en los logs). */
export class SessionError extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

type Raw = Record<string, unknown>;

function fail(code: string, path: string): never {
  throw new SessionError(code, path);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function asObject(raw: unknown, path: string): Raw {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('not_an_object', path);
  return raw as Raw;
}

function checkKeys(o: Raw, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (o[key] === undefined) fail('missing_field', join(path, key));
  for (const key of Object.keys(o)) {
    if (!required.includes(key) && !optional.includes(key)) fail('unknown_field', join(path, key));
  }
}

function num(o: Raw, key: string, path: string, min: number, max: number): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) fail('bad_type', join(path, key));
  if (v < min || v > max) fail('out_of_range', join(path, key));
  return v;
}

function int(o: Raw, key: string, path: string, min: number, max: number): number {
  const v = num(o, key, path, min, max);
  if (!Number.isInteger(v)) fail('bad_type', join(path, key));
  return v;
}

function bool(o: Raw, key: string, path: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') fail('bad_type', join(path, key));
  return v;
}

function text(o: Raw, key: string, path: string, minLen: number, maxLen: number): string {
  const v = o[key];
  if (typeof v !== 'string') fail('bad_type', join(path, key));
  if (v.length < minLen || v.length > maxLen) fail('out_of_range', join(path, key));
  return v;
}

function id(o: Raw, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string') fail('bad_type', join(path, key));
  if (!ID_RE.test(v)) fail('bad_id', join(path, key));
  return v;
}

function nullableId(o: Raw, key: string, path: string): string | null {
  return o[key] === null ? null : id(o, key, path);
}

function oneOf(o: Raw, key: string, path: string, allowed: readonly string[]): string {
  const v = o[key];
  if (typeof v !== 'string') fail('bad_type', join(path, key));
  if (!allowed.includes(v)) fail('bad_value', join(path, key));
  return v;
}

function list(o: Raw, key: string, path: string, max: number): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) fail('bad_type', join(path, key));
  if (v.length > max) fail('too_many', join(path, key));
  return v;
}

/**
 * Parametros de un efecto. Con `partial` devuelve solo los que vienen (sugerencias del asistente,
 * STUDIO_V1.md 6.4); sin el, completa los ausentes con su valor por defecto.
 */
export function validateFxParams(type: FxType, raw: unknown, path: string, partial: boolean): Record<string, number> {
  const o = asObject(raw, path);
  const specs = FX_PARAM_SPECS[type];
  checkKeys(o, path, [], specs.map((s) => s.key));
  const out: Record<string, number> = {};
  for (const spec of specs) {
    if (o[spec.key] === undefined) {
      if (!partial) out[spec.key] = spec.def;
      continue;
    }
    out[spec.key] = num(o, spec.key, path, spec.min, spec.max);
  }
  return out;
}

/** Cadena de efectos de una pista (`track`: eq y compressor) o del master (ademas limiter, de ultimo). */
export function validateFxChain(raw: unknown[], path: string, where: 'track' | 'master'): SessionFx[] {
  const chain = raw.map((item, i): SessionFx => {
    const p = `${path}[${i}]`;
    const o = asObject(item, p);
    checkKeys(o, p, ['type', 'bypass', 'params']);
    const type = oneOf(o, 'type', p, FX_TYPES) as FxType;
    return { type, bypass: bool(o, 'bypass', p), params: validateFxParams(type, o.params, join(p, 'params'), false) };
  });
  const seen = new Set<string>();
  chain.forEach((fx, i) => {
    const p = `${path}[${i}]`;
    if (seen.has(fx.type)) fail('bad_fx', p);
    seen.add(fx.type);
    if (fx.type === 'limiter' && (where === 'track' || i !== chain.length - 1)) fail('bad_fx', p);
  });
  return chain;
}

/** Extension de un `file` de audio del Estudio, o null si no es wav | flac | mp3. */
export function assetExtension(file: string): AssetExtension | null {
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = file.slice(dot + 1);
  return (ASSET_EXTENSIONS as readonly string[]).includes(ext) ? (ext as AssetExtension) : null;
}

/** `{asset}` de las rutas: "<id>.<wav|flac|mp3>". */
export function isAssetFile(file: string): boolean {
  const ext = assetExtension(file);
  return ext !== null && ID_RE.test(file.slice(0, file.length - ext.length - 1));
}

function validateSource(raw: unknown, path: string): SessionAssetSource | null {
  if (raw === null) return null;
  const o = asObject(raw, path);
  checkKeys(o, path, ['provider', 'job_id'], ['prompt']);
  const source: SessionAssetSource = { provider: oneOf(o, 'provider', path, PROVIDERS), job_id: id(o, 'job_id', path) };
  if (o.prompt !== undefined) source.prompt = text(o, 'prompt', path, 1, MAX_PROMPT);
  return source;
}

function validateAsset(raw: unknown, path: string): SessionAsset {
  const o = asObject(raw, path);
  checkKeys(o, path, ['id', 'file', 'kind', 'label', 'channels', 'sample_rate', 'duration_s', 'size', 'source']);
  const assetId = id(o, 'id', path);
  const file = text(o, 'file', path, 1, 90);
  const ext = assetExtension(file);
  if (ext === null || file !== `${assetId}.${ext}`) fail('bad_value', join(path, 'file'));
  const kind = oneOf(o, 'kind', path, ASSET_KINDS);
  const label = text(o, 'label', path, 0, 120);
  const channels = int(o, 'channels', path, 1, 2);
  const sampleRate = int(o, 'sample_rate', path, 8000, 192000);
  const duration = num(o, 'duration_s', path, 0, MAX_SESSION_SECONDS);
  if (!(duration > 0)) fail('out_of_range', join(path, 'duration_s'));
  const size = int(o, 'size', path, 1, ASSET_MAX_BYTES);
  const source = validateSource(o.source, join(path, 'source'));
  if (kind === 'generated' && source === null) fail('missing_source', join(path, 'source'));
  return { id: assetId, file, kind, label, channels, sample_rate: sampleRate, duration_s: duration, size, source };
}

function validateClip(raw: unknown, path: string, assets: ReadonlyMap<string, SessionAsset>): SessionClip {
  const o = asObject(raw, path);
  checkKeys(o, path, ['id', 'asset_id', 'start_s', 'offset_s', 'length_s', 'gain_db', 'fade_in_s', 'fade_out_s', 'take_group', 'active']);
  const clip: SessionClip = {
    id: id(o, 'id', path),
    asset_id: id(o, 'asset_id', path),
    start_s: num(o, 'start_s', path, 0, MAX_SESSION_SECONDS),
    offset_s: num(o, 'offset_s', path, 0, MAX_SESSION_SECONDS),
    length_s: num(o, 'length_s', path, 0.01, MAX_SESSION_SECONDS),
    gain_db: num(o, 'gain_db', path, -60, 24),
    fade_in_s: num(o, 'fade_in_s', path, 0, MAX_SESSION_SECONDS),
    fade_out_s: num(o, 'fade_out_s', path, 0, MAX_SESSION_SECONDS),
    take_group: nullableId(o, 'take_group', path),
    active: bool(o, 'active', path),
  };
  const asset = assets.get(clip.asset_id);
  if (!asset) fail('unknown_asset', join(path, 'asset_id'));
  if (clip.offset_s + clip.length_s > asset.duration_s + TIME_EPSILON_S) fail('clip_out_of_asset', join(path, 'length_s'));
  if (clip.start_s + clip.length_s > MAX_SESSION_SECONDS + TIME_EPSILON_S) fail('session_too_long', join(path, 'start_s'));
  if (clip.fade_in_s + clip.fade_out_s > clip.length_s + FADE_EPSILON_S) fail('bad_fades', join(path, 'fade_in_s'));
  return clip;
}

function validateTrack(raw: unknown, path: string, assets: ReadonlyMap<string, SessionAsset>, clipIds: Set<string>): SessionTrack {
  const o = asObject(raw, path);
  checkKeys(o, path, ['id', 'name', 'role', 'volume_db', 'pan', 'mute', 'solo', 'reverb_send_db', 'fx', 'clips']);
  const trackId = id(o, 'id', path);
  if (trackId === MASTER_ID) fail('bad_id', join(path, 'id'));
  const clipsPath = join(path, 'clips');
  return {
    id: trackId,
    name: text(o, 'name', path, 1, MAX_TRACK_NAME),
    role: oneOf(o, 'role', path, ROLES),
    volume_db: num(o, 'volume_db', path, VOLUME_DB_MIN, VOLUME_DB_MAX),
    pan: num(o, 'pan', path, -1, 1),
    mute: bool(o, 'mute', path),
    solo: bool(o, 'solo', path),
    reverb_send_db: num(o, 'reverb_send_db', path, -60, 0),
    fx: validateFxChain(list(o, 'fx', path, 2), join(path, 'fx'), 'track'),
    clips: list(o, 'clips', path, MAX_CLIPS_PER_TRACK).map((item, i) => {
      const clip = validateClip(item, `${clipsPath}[${i}]`, assets);
      if (clipIds.has(clip.id)) fail('duplicate_id', `${clipsPath}[${i}].id`);
      clipIds.add(clip.id);
      return clip;
    }),
  };
}

/**
 * Valida un documento de sesion (objeto ya decodificado de JSON) y devuelve la copia normalizada.
 * Lanza SessionError ante el primer problema. El tamano del texto lo comprueba quien lo lee.
 */
export function validateSession(raw: unknown): SessionDocument {
  const o = asObject(raw, '');
  if (o.version === undefined) fail('missing_field', 'version');
  if (o.version !== 1) fail('unsupported_version', 'version');
  checkKeys(o, '', ['version', 'id', 'title', 'song_id', 'bpm', 'beats_per_bar', 'key', 'sample_rate',
    'latency_offset_ms', 'updated_at', 'updated_by', 'assets', 'tracks', 'master']);

  const title = text(o, 'title', '', 1, 400).trim();
  if (title.length < 1 || title.length > 120) fail('out_of_range', 'title');
  const sampleRate = int(o, 'sample_rate', '', 8000, 192000);
  if (!SAMPLE_RATES.includes(sampleRate)) fail('bad_value', 'sample_rate');
  const updatedAt = text(o, 'updated_at', '', 1, 40);
  if (Number.isNaN(Date.parse(updatedAt))) fail('bad_value', 'updated_at');

  const assets = new Map<string, SessionAsset>();
  list(o, 'assets', '', MAX_ASSETS).forEach((item, i) => {
    const asset = validateAsset(item, `assets[${i}]`);
    if (assets.has(asset.id)) fail('duplicate_id', `assets[${i}].id`);
    assets.set(asset.id, asset);
  });

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  const tracks = list(o, 'tracks', '', MAX_TRACKS).map((item, i) => {
    const track = validateTrack(item, `tracks[${i}]`, assets, clipIds);
    if (trackIds.has(track.id)) fail('duplicate_id', `tracks[${i}].id`);
    trackIds.add(track.id);
    return track;
  });

  const m = asObject(o.master, 'master');
  checkKeys(m, 'master', ['volume_db', 'fx', 'reverb']);
  const r = asObject(m.reverb, 'master.reverb');
  checkKeys(r, 'master.reverb', ['decay_s', 'return_db']);

  return {
    version: 1,
    id: id(o, 'id', ''),
    title,
    song_id: nullableId(o, 'song_id', ''),
    bpm: num(o, 'bpm', '', 40, 260),
    beats_per_bar: int(o, 'beats_per_bar', '', 1, 12),
    key: o.key === null ? null : text(o, 'key', '', 1, 12),
    sample_rate: sampleRate,
    latency_offset_ms: num(o, 'latency_offset_ms', '', -500, 500),
    updated_at: updatedAt,
    updated_by: o.updated_by === null ? null : text(o, 'updated_by', '', 1, 80),
    assets: [...assets.values()],
    tracks,
    master: {
      volume_db: num(m, 'volume_db', 'master', VOLUME_DB_MIN, VOLUME_DB_MAX),
      fx: validateFxChain(list(m, 'fx', 'master', 3), 'master.fx', 'master'),
      reverb: { decay_s: num(r, 'decay_s', 'master.reverb', 0.2, 10), return_db: num(r, 'return_db', 'master.reverb', -60, 12) },
    },
  };
}
