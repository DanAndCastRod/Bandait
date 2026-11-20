// Validacion del documento de sesion del Estudio en el Worker. Replica la seccion 2 de
// bandait-protocol/STUDIO_V1.md y la seccion 2 de STUDIO_V2.md. El Hub tiene su propia
// implementacion (bandait-leader-web/src/services/studio/session.ts): el Worker es otro paquete y
// no puede importarla, asi que las dos se prueban contra los mismos ejemplos canonicos
// (bandait-protocol/fixtures/studio_session.json y studio_session_v2.json). Si el contrato
// cambia, cambian las dos.
//
// El documento viaja y se guarda en snake_case. `validateSession` acepta las versiones 1 y 2 y
// devuelve una copia normalizada EN SU MISMA VERSION (el Worker no migra; STUDIO_V2.md 1): claves
// en el orden del contrato, titulo recortado, parametros de efecto y de instrumento completos,
// notas y marcas ordenadas.

/** Tope del documento guardado: 1 MiB para v1 y v2 (STUDIO_V2.md 2.5). */
export const SESSION_MAX_BYTES = 1024 * 1024;
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

export type TrackKind = 'audio' | 'instrument';

/** STUDIO_V2.md 2.3. `params` siempre completo, en el orden de su tabla. */
export type SessionInstrument =
  | { type: 'synth' | 'drums'; preset: string | null; params: Record<string, number | string> }
  | { type: 'sampler'; params: Record<string, number | string>; zones: SessionZone[] }
  | { type: 'wam'; plugin_id: string; state: Record<string, unknown> };

export interface SessionZone {
  asset_id: string; root_pitch: number; low_pitch: number; high_pitch: number; low_velocity: number;
  high_velocity: number; offset_s: number; length_s: number; gain_db: number; tune_cents: number;
}

export interface SessionNote { pitch: number; start: number; length: number; velocity: number }

export interface SessionMidiClip {
  id: string; start_beat: number; length_beats: number; loop: boolean; loop_beats: number; notes: SessionNote[];
}

export interface SessionMarker { id: string; beat: number; label: string; kind: string }

/**
 * Pista. En v1 no hay `kind` y siempre hay `clips`. En v2, `kind` va despues de `id`; una pista de
 * audio lleva `clips` y una de instrumento `instrument`, `midi_clips` y `frozen_asset_id`.
 */
export interface SessionTrack {
  id: string; kind?: TrackKind; name: string; role: string; volume_db: number; pan: number; mute: boolean; solo: boolean;
  reverb_send_db: number; fx: SessionFx[]; clips?: SessionClip[];
  instrument?: SessionInstrument; midi_clips?: SessionMidiClip[]; frozen_asset_id?: string | null;
}

export interface SessionDocument {
  version: 1 | 2; id: string; title: string; song_id: string | null; bpm: number; beats_per_bar: number;
  key: string | null; sample_rate: number; latency_offset_ms: number; updated_at: string;
  updated_by: string | null; assets: SessionAsset[]; tracks: SessionTrack[];
  /** Solo en v2 (siempre presente en lo que devuelve validateSession para un v2). */
  markers?: SessionMarker[];
  master: { volume_db: number; fx: SessionFx[]; reverb: { decay_s: number; return_db: number } };
}

// ---------------------------------------------------------------------------- STUDIO_V2.md 2

export const TRACK_KINDS = ['audio', 'instrument'] as const;
export const INSTRUMENT_TYPES = ['synth', 'drums', 'sampler', 'wam'] as const;
export const MARKER_KINDS = ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'solo', 'interlude', 'break', 'outro', 'marker'] as const;
export const MAX_MIDI_CLIPS_PER_TRACK = 256;
export const MAX_NOTES_PER_CLIP = 4096;
export const MAX_NOTES_PER_SESSION = 16384;
export const MAX_SAMPLER_ZONES = 64;
export const MAX_WAM_STATE_BYTES = 16384;
export const MAX_MARKERS = 256;
export const MAX_MARKER_LABEL = 60;
/** 1200 s a 260 BPM. */
export const MAX_BEAT = 5200;
export const MIDI_MIN_CLIP_BEATS = 0.0625;
export const MIDI_MIN_NOTE_BEATS = 0.015625;
export const NOTE_EPSILON_BEATS = 0.000001;
const WAM_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,79}$/;

export const SYNTH_PRESETS = ['pad_calido', 'bajo_sub', 'bajo_sintetico', 'lead_brillante', 'pluck', 'cuerdas', 'organo', 'campanas', 'teclas_suaves'] as const;
export const DRUMS_PRESETS = ['basico', 'seco', 'amplio', 'lofi'] as const;
export const DRUM_VOICES = ['kick', 'snare', 'clap', 'hat_closed', 'hat_open', 'tom_low', 'tom_mid', 'tom_high', 'cymbal'] as const;

/** Mapa General MIDI de percusion de STUDIO_V2.md 2.3.2: nota -> voz. Otra nota no suena. */
export const DRUM_GM_MAP: Readonly<Record<number, string>> = {
  35: 'kick', 36: 'kick', 37: 'snare', 38: 'snare', 40: 'snare', 39: 'clap', 42: 'hat_closed', 44: 'hat_closed',
  46: 'hat_open', 41: 'tom_low', 43: 'tom_low', 45: 'tom_mid', 47: 'tom_mid', 48: 'tom_high', 50: 'tom_high',
  49: 'cymbal', 51: 'cymbal', 52: 'cymbal', 53: 'cymbal', 55: 'cymbal', 57: 'cymbal', 59: 'cymbal',
};

export type InstrumentParamSpec =
  | { kind: 'number'; key: string; min: number; max: number; def: number; integer: boolean }
  | { kind: 'enum'; key: string; values: readonly string[]; def: string };

const numSpec = (key: string, min: number, max: number, def: number, integer = false): InstrumentParamSpec => ({ kind: 'number', key, min, max, def, integer });
const enumSpec = (key: string, values: readonly string[], def: string): InstrumentParamSpec => ({ kind: 'enum', key, values, def });
const WAVES = ['sine', 'triangle', 'sawtooth', 'square'] as const;

/** Tablas de STUDIO_V2.md 2.3.1 a 2.3.3, en el orden en que se serializan. */
export const INSTRUMENT_PARAM_SPECS: Readonly<Record<'synth' | 'drums' | 'sampler', readonly InstrumentParamSpec[]>> = {
  synth: [
    enumSpec('osc1_wave', WAVES, 'sawtooth'), numSpec('osc1_octave', -2, 2, 0, true), numSpec('osc1_detune_cents', -100, 100, 0),
    numSpec('osc1_level', 0, 1, 0.8), enumSpec('osc2_wave', WAVES, 'square'), numSpec('osc2_octave', -2, 2, 0, true),
    numSpec('osc2_detune_cents', -100, 100, 7), numSpec('osc2_level', 0, 1, 0.4), numSpec('noise_level', 0, 1, 0),
    enumSpec('filter_type', ['lowpass', 'highpass', 'bandpass'], 'lowpass'), numSpec('filter_cutoff_hz', 20, 20000, 2400),
    numSpec('filter_resonance', 0.1, 20, 1), numSpec('filter_env_octaves', -8, 8, 2), numSpec('filter_attack_ms', 0, 10000, 5),
    numSpec('filter_decay_ms', 0, 10000, 400), numSpec('filter_sustain', 0, 1, 0.3), numSpec('filter_release_ms', 0, 10000, 300),
    numSpec('amp_attack_ms', 0, 10000, 5), numSpec('amp_decay_ms', 0, 10000, 200), numSpec('amp_sustain', 0, 1, 0.7),
    numSpec('amp_release_ms', 0, 10000, 250), enumSpec('lfo_wave', WAVES, 'sine'), numSpec('lfo_rate_hz', 0.01, 20, 5),
    enumSpec('lfo_target', ['off', 'pitch', 'filter', 'amp'], 'off'), numSpec('lfo_depth', 0, 1, 0), numSpec('velocity_sens', 0, 1, 0.7),
    numSpec('gain_db', -24, 12, -6),
  ],
  drums: [
    ...DRUM_VOICES.flatMap((voice) => [numSpec(`${voice}_level_db`, -60, 6, 0), numSpec(`${voice}_tune`, -12, 12, 0), numSpec(`${voice}_decay`, 0.25, 4, 1)]),
    numSpec('gain_db', -24, 12, -6),
  ],
  sampler: [
    numSpec('amp_attack_ms', 0, 10000, 2), numSpec('amp_decay_ms', 0, 10000, 0), numSpec('amp_sustain', 0, 1, 1),
    numSpec('amp_release_ms', 0, 10000, 150), numSpec('velocity_sens', 0, 1, 0.7), enumSpec('mode', ['sustain', 'one_shot'], 'sustain'),
    numSpec('gain_db', -24, 12, 0),
  ],
};

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

/**
 * Parametros de un instrumento (STUDIO_V2.md 2.3). Con `partial` devuelve solo los que vienen; sin
 * el, completa los ausentes con el valor por defecto de la tabla (no el del preset).
 */
export function validateInstrumentParams(type: 'synth' | 'drums' | 'sampler', raw: unknown, path: string, partial = false): Record<string, number | string> {
  const o = asObject(raw, path);
  const specs = INSTRUMENT_PARAM_SPECS[type];
  checkKeys(o, path, [], specs.map((s) => s.key));
  const out: Record<string, number | string> = {};
  for (const spec of specs) {
    if (o[spec.key] === undefined) {
      if (!partial) out[spec.key] = spec.def;
      continue;
    }
    if (spec.kind === 'enum') out[spec.key] = oneOf(o, spec.key, path, spec.values);
    else out[spec.key] = spec.integer ? int(o, spec.key, path, spec.min, spec.max) : num(o, spec.key, path, spec.min, spec.max);
  }
  return out;
}

function validateZone(raw: unknown, path: string, assets: ReadonlyMap<string, SessionAsset>): SessionZone {
  const o = asObject(raw, path);
  checkKeys(o, path, ['asset_id', 'root_pitch', 'low_pitch', 'high_pitch', 'low_velocity', 'high_velocity', 'offset_s', 'length_s', 'gain_db', 'tune_cents']);
  const zone: SessionZone = {
    asset_id: id(o, 'asset_id', path),
    root_pitch: int(o, 'root_pitch', path, 0, 127),
    low_pitch: int(o, 'low_pitch', path, 0, 127),
    high_pitch: int(o, 'high_pitch', path, 0, 127),
    low_velocity: int(o, 'low_velocity', path, 1, 127),
    high_velocity: int(o, 'high_velocity', path, 1, 127),
    offset_s: num(o, 'offset_s', path, 0, MAX_SESSION_SECONDS),
    length_s: num(o, 'length_s', path, 0.01, MAX_SESSION_SECONDS),
    gain_db: num(o, 'gain_db', path, -60, 24),
    tune_cents: num(o, 'tune_cents', path, -100, 100),
  };
  if (zone.low_pitch > zone.high_pitch) fail('bad_zone', join(path, 'high_pitch'));
  if (zone.low_velocity > zone.high_velocity) fail('bad_zone', join(path, 'high_velocity'));
  const asset = assets.get(zone.asset_id);
  if (!asset) fail('unknown_asset', join(path, 'asset_id'));
  if (zone.offset_s + zone.length_s > asset.duration_s + TIME_EPSILON_S) fail('clip_out_of_asset', join(path, 'length_s'));
  return zone;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateInstrument(raw: unknown, path: string, assets: ReadonlyMap<string, SessionAsset>): SessionInstrument {
  const o = asObject(raw, path);
  if (o.type === undefined) fail('missing_field', join(path, 'type'));
  const type = oneOf(o, 'type', path, INSTRUMENT_TYPES) as SessionInstrument['type'];
  if (type === 'synth' || type === 'drums') {
    checkKeys(o, path, ['type', 'preset', 'params']);
    const preset = o.preset === null ? null : oneOf(o, 'preset', path, type === 'synth' ? SYNTH_PRESETS : DRUMS_PRESETS);
    return { type, preset, params: validateInstrumentParams(type, o.params, join(path, 'params')) };
  }
  if (type === 'sampler') {
    checkKeys(o, path, ['type', 'params', 'zones']);
    const params = validateInstrumentParams('sampler', o.params, join(path, 'params'));
    const zonesPath = join(path, 'zones');
    return { type, params, zones: list(o, 'zones', path, MAX_SAMPLER_ZONES).map((item, i) => validateZone(item, `${zonesPath}[${i}]`, assets)) };
  }
  checkKeys(o, path, ['type', 'plugin_id', 'state']);
  const pluginId = text(o, 'plugin_id', path, 1, 80);
  if (!WAM_PLUGIN_ID_RE.test(pluginId)) fail('bad_value', join(path, 'plugin_id'));
  const statePath = join(path, 'state');
  const state = asObject(o.state, statePath);
  const serialized = JSON.stringify(state);
  if (utf8Bytes(serialized) > MAX_WAM_STATE_BYTES) fail('out_of_range', statePath);
  // Opaco: no se valida su contenido; se guarda una copia.
  return { type, plugin_id: pluginId, state: JSON.parse(serialized) as Record<string, unknown> };
}

/** Orden de las notas en el documento: por `start` y, a igual `start`, por `pitch` (STUDIO_V2.md 2.4). */
export function compareNotes(a: SessionNote, b: SessionNote): number {
  return a.start - b.start || a.pitch - b.pitch;
}

function validateNote(raw: unknown, path: string, clipLength: number): SessionNote {
  const o = asObject(raw, path);
  checkKeys(o, path, ['pitch', 'start', 'length', 'velocity']);
  const note: SessionNote = {
    pitch: int(o, 'pitch', path, 0, 127),
    start: num(o, 'start', path, 0, MAX_BEAT),
    length: num(o, 'length', path, MIDI_MIN_NOTE_BEATS, MAX_BEAT),
    velocity: int(o, 'velocity', path, 1, 127),
  };
  if (note.start >= clipLength) fail('note_out_of_clip', join(path, 'start'));
  return note;
}

interface Counters { clipIds: Set<string>; notes: number }

function validateMidiClip(raw: unknown, path: string, bpm: number, counters: Counters): SessionMidiClip {
  const o = asObject(raw, path);
  checkKeys(o, path, ['id', 'start_beat', 'length_beats', 'loop', 'loop_beats', 'notes']);
  const clipId = id(o, 'id', path);
  const startBeat = num(o, 'start_beat', path, 0, MAX_BEAT);
  const lengthBeats = num(o, 'length_beats', path, MIDI_MIN_CLIP_BEATS, MAX_BEAT);
  const loop = bool(o, 'loop', path);
  const loopBeats = num(o, 'loop_beats', path, MIDI_MIN_CLIP_BEATS, MAX_BEAT);
  if (((startBeat + lengthBeats) * 60) / bpm > MAX_SESSION_SECONDS + TIME_EPSILON_S) fail('session_too_long', join(path, 'start_beat'));
  const notesPath = join(path, 'notes');
  const rawNotes = list(o, 'notes', path, MAX_NOTES_PER_CLIP);
  counters.notes += rawNotes.length;
  if (counters.notes > MAX_NOTES_PER_SESSION) fail('too_many', notesPath);
  const indexed = rawNotes.map((item, i) => ({ note: validateNote(item, `${notesPath}[${i}]`, lengthBeats), index: i }));
  indexed.sort((a, b) => compareNotes(a.note, b.note));
  const lastEnd = new Map<number, number>();
  for (const { note, index } of indexed) {
    const end = lastEnd.get(note.pitch);
    if (end !== undefined && note.start < end - NOTE_EPSILON_BEATS) fail('note_overlap', `${notesPath}[${index}].start`);
    lastEnd.set(note.pitch, note.start + note.length);
  }
  return { id: clipId, start_beat: startBeat, length_beats: lengthBeats, loop, loop_beats: loopBeats, notes: indexed.map((x) => x.note) };
}

const TRACK_COMMON_KEYS = ['name', 'role', 'volume_db', 'pan', 'mute', 'solo', 'reverb_send_db', 'fx'] as const;

function validateTrack(
  raw: unknown, path: string, version: 1 | 2, bpm: number, assets: ReadonlyMap<string, SessionAsset>, counters: Counters,
): SessionTrack {
  const o = asObject(raw, path);
  let kind: TrackKind = 'audio';
  if (version === 1) {
    checkKeys(o, path, ['id', ...TRACK_COMMON_KEYS, 'clips']);
  } else {
    if (o.kind === undefined) fail('missing_field', join(path, 'kind'));
    kind = oneOf(o, 'kind', path, TRACK_KINDS) as TrackKind;
    checkKeys(o, path, kind === 'audio'
      ? ['id', 'kind', ...TRACK_COMMON_KEYS, 'clips']
      : ['id', 'kind', ...TRACK_COMMON_KEYS, 'instrument', 'midi_clips', 'frozen_asset_id']);
  }
  const trackId = id(o, 'id', path);
  if (trackId === MASTER_ID) fail('bad_id', join(path, 'id'));
  const common = {
    name: text(o, 'name', path, 1, MAX_TRACK_NAME),
    role: oneOf(o, 'role', path, ROLES),
    volume_db: num(o, 'volume_db', path, VOLUME_DB_MIN, VOLUME_DB_MAX),
    pan: num(o, 'pan', path, -1, 1),
    mute: bool(o, 'mute', path),
    solo: bool(o, 'solo', path),
    reverb_send_db: num(o, 'reverb_send_db', path, -60, 0),
    fx: validateFxChain(list(o, 'fx', path, 2), join(path, 'fx'), 'track'),
  };
  const addClipId = (clipId: string, at: string) => {
    if (counters.clipIds.has(clipId)) fail('duplicate_id', `${at}.id`);
    counters.clipIds.add(clipId);
  };
  if (kind === 'audio') {
    const clipsPath = join(path, 'clips');
    const clips = list(o, 'clips', path, MAX_CLIPS_PER_TRACK).map((item, i) => {
      const clip = validateClip(item, `${clipsPath}[${i}]`, assets);
      addClipId(clip.id, `${clipsPath}[${i}]`);
      return clip;
    });
    return version === 1 ? { id: trackId, ...common, clips } : { id: trackId, kind, ...common, clips };
  }
  const instrument = validateInstrument(o.instrument, join(path, 'instrument'), assets);
  const midiPath = join(path, 'midi_clips');
  const midiClips = list(o, 'midi_clips', path, MAX_MIDI_CLIPS_PER_TRACK).map((item, i) => {
    const clip = validateMidiClip(item, `${midiPath}[${i}]`, bpm, counters);
    addClipId(clip.id, `${midiPath}[${i}]`);
    return clip;
  });
  const frozen = nullableId(o, 'frozen_asset_id', path);
  if (frozen !== null && !assets.has(frozen)) fail('unknown_asset', join(path, 'frozen_asset_id'));
  return { id: trackId, kind, ...common, instrument, midi_clips: midiClips, frozen_asset_id: frozen };
}

function validateMarkers(raw: unknown, bpm: number): SessionMarker[] {
  const container: Raw = { markers: raw };
  const ids = new Set<string>();
  const markers = list(container, 'markers', '', MAX_MARKERS).map((item, i): SessionMarker => {
    const path = `markers[${i}]`;
    const o = asObject(item, path);
    checkKeys(o, path, ['id', 'beat', 'label', 'kind']);
    const marker = {
      id: id(o, 'id', path),
      beat: num(o, 'beat', path, 0, MAX_BEAT),
      label: text(o, 'label', path, 0, MAX_MARKER_LABEL),
      kind: oneOf(o, 'kind', path, MARKER_KINDS),
    };
    if (ids.has(marker.id)) fail('duplicate_id', join(path, 'id'));
    ids.add(marker.id);
    if ((marker.beat * 60) / bpm > MAX_SESSION_SECONDS + TIME_EPSILON_S) fail('session_too_long', join(path, 'beat'));
    return marker;
  });
  return markers.sort((a, b) => a.beat - b.beat || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const ROOT_KEYS = ['version', 'id', 'title', 'song_id', 'bpm', 'beats_per_bar', 'key', 'sample_rate',
  'latency_offset_ms', 'updated_at', 'updated_by', 'assets', 'tracks', 'master'] as const;

/**
 * Valida un documento de sesion (objeto ya decodificado de JSON), version 1 o 2, y devuelve la
 * copia normalizada en su misma version. Un v1 se valida con las reglas de v1 (un campo de v2 es
 * `unknown_field`). Lanza SessionError ante el primer problema. El tamano del texto lo comprueba
 * quien lo lee.
 */
export function validateSession(raw: unknown): SessionDocument {
  const o = asObject(raw, '');
  if (o.version === undefined) fail('missing_field', 'version');
  if (o.version !== 1 && o.version !== 2) fail('unsupported_version', 'version');
  const version = o.version;
  checkKeys(o, '', ROOT_KEYS, version === 2 ? ['markers'] : []);

  const title = text(o, 'title', '', 1, 400).trim();
  if (title.length < 1 || title.length > 120) fail('out_of_range', 'title');
  const sampleRate = int(o, 'sample_rate', '', 8000, 192000);
  if (!SAMPLE_RATES.includes(sampleRate)) fail('bad_value', 'sample_rate');
  const updatedAt = text(o, 'updated_at', '', 1, 40);
  if (Number.isNaN(Date.parse(updatedAt))) fail('bad_value', 'updated_at');
  // El tempo va antes que las pistas: los clips MIDI y las marcas se acotan en segundos.
  const bpm = num(o, 'bpm', '', 40, 260);

  const assets = new Map<string, SessionAsset>();
  list(o, 'assets', '', MAX_ASSETS).forEach((item, i) => {
    const asset = validateAsset(item, `assets[${i}]`);
    if (assets.has(asset.id)) fail('duplicate_id', `assets[${i}].id`);
    assets.set(asset.id, asset);
  });

  const trackIds = new Set<string>();
  const counters: Counters = { clipIds: new Set<string>(), notes: 0 };
  const tracks = list(o, 'tracks', '', MAX_TRACKS).map((item, i) => {
    const track = validateTrack(item, `tracks[${i}]`, version, bpm, assets, counters);
    if (trackIds.has(track.id)) fail('duplicate_id', `tracks[${i}].id`);
    trackIds.add(track.id);
    return track;
  });
  const markers = version === 2 ? (o.markers === undefined ? [] : validateMarkers(o.markers, bpm)) : null;

  const m = asObject(o.master, 'master');
  checkKeys(m, 'master', ['volume_db', 'fx', 'reverb']);
  const r = asObject(m.reverb, 'master.reverb');
  checkKeys(r, 'master.reverb', ['decay_s', 'return_db']);

  return {
    version,
    id: id(o, 'id', ''),
    title,
    song_id: nullableId(o, 'song_id', ''),
    bpm,
    beats_per_bar: int(o, 'beats_per_bar', '', 1, 12),
    key: o.key === null ? null : text(o, 'key', '', 1, 12),
    sample_rate: sampleRate,
    latency_offset_ms: num(o, 'latency_offset_ms', '', -500, 500),
    updated_at: updatedAt,
    updated_by: o.updated_by === null ? null : text(o, 'updated_by', '', 1, 80),
    assets: [...assets.values()],
    tracks,
    ...(markers ? { markers } : {}),
    master: {
      volume_db: num(m, 'volume_db', 'master', VOLUME_DB_MIN, VOLUME_DB_MAX),
      fx: validateFxChain(list(m, 'fx', 'master', 3), 'master.fx', 'master'),
      reverb: { decay_s: num(r, 'decay_s', 'master.reverb', 0.2, 10), return_db: num(r, 'return_db', 'master.reverb', -60, 12) },
    },
  };
}
