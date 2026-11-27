// Rutas /studio del Worker (bandait-protocol/STUDIO_V1.md) con R2, Supabase, Music AI, Lyria y el
// modelo del asistente simulados. Ninguna prueba sale a la red ni toca datos reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../src/index.ts';
import { ASSIST_SYSTEM_PROMPT, SUGGESTIONS_SCHEMA } from '../src/providers/anthropic.ts';
import { providerSchema } from '../src/providers/types.ts';
import { CHAT_TOOLS, COMPOSE_SCHEMA } from '../src/studioV2.ts';
import { audioFromMusic, detectAudioExt, lyriaModel, lyriaPrompt } from '../src/providers/lyria.ts';
import { parseRange } from '../src/studio.ts';
import { audioSecondsFloor, sanitizeSuggestions } from '../src/studioJobs.ts';
import { SESSION_MAX_BYTES } from '../src/studioSession.ts';
import { FX_PARAM_SPECS, ROLES, SessionError, validateSession } from '../src/studioSession.ts';
import type { Env, R2Body, R2Bucket, R2Conditional, R2GetOptions, R2Object, R2ObjectBody, R2PutOptions } from '../src/types.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('../../bandait-protocol/fixtures/studio_session.json', import.meta.url), 'utf8'));
const STEM_NAMES = JSON.parse(readFileSync(new URL('../../bandait-protocol/fixtures/stem_names.json', import.meta.url), 'utf8'));
const BAND = '11111111-2222-4333-8444-555555555555';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ORIGIN = 'https://bandait.releven.cc';

const b64url = (text: string) => Buffer.from(text).toString('base64url');
/** Token con forma de JWT de Supabase: el Worker lee `sub` del segmento del medio. */
const jwt = (role: string) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: USER, role }))}.firma-${role}`;
const OWNER = jwt('owner');
const DIRECTOR = jwt('director');
const MUSICIAN = jwt('musician');
const SUBSTITUTE = jwt('substitute');
const STRANGER = jwt('stranger');
const ROLES_BY_TOKEN: Record<string, string | null> = {
  [OWNER]: 'Owner',
  [DIRECTOR]: 'MusicDirector',
  [MUSICIAN]: 'Musician',
  [SUBSTITUTE]: 'Substitute',
  [STRANGER]: null,
};

class FakeR2 implements R2Bucket {
  objects = new Map<string, { bytes: Uint8Array; type?: string; version: number; size?: number }>();
  versions = 0;
  puts: string[] = [];

  /**
   * Gancho de las pruebas de concurrencia: corre justo antes de cada put, despues de que la ruta
   * ya hizo su head o su get. Lo que escriba aqui es "otra peticion que gano la carrera".
   */
  beforePut?: (key: string) => void;

  /** Objeto con un tamano declarado y sin bytes (o solo la cabecera): para audios grandes. */
  seed(key: string, size: number, bytes: Uint8Array = new Uint8Array(0)) {
    this.objects.set(key, { bytes, version: ++this.versions, size });
  }

  /** Escritura directa, sin pasar por put ni por el gancho. */
  write(key: string, text: string) {
    this.objects.set(key, { bytes: new TextEncoder().encode(text), version: ++this.versions });
  }

  describe(key: string): R2Object {
    const o = this.objects.get(key)!;
    return {
      key, size: o.size ?? o.bytes.byteLength, etag: `v${o.version}`, httpEtag: `"v${o.version}"`, uploaded: new Date(0),
      httpMetadata: { contentType: o.type },
    };
  }

  async head(key: string) {
    return this.objects.has(key) ? this.describe(key) : null;
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    if (!this.objects.has(key)) return null;
    let bytes = this.objects.get(key)!.bytes;
    if (options?.range) bytes = bytes.subarray(options.range.offset, options.range.offset + options.range.length);
    return { ...this.describe(key), body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes) };
  }

  async put(key: string, value: R2Body, options?: R2PutOptions) {
    const hook = this.beforePut;
    if (hook) hook(key);
    const current = this.objects.get(key);
    const cond = options?.onlyIf;
    if (cond instanceof Headers) {
      if (cond.get('If-None-Match') === '*' && current) return null;
    } else if (cond) {
      const c = cond as R2Conditional;
      if (c.etagMatches !== undefined && (!current || `v${current.version}` !== c.etagMatches)) return null;
    }
    const bytes = value instanceof ReadableStream
      ? new Uint8Array(await new Response(value).arrayBuffer())
      : typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
    this.objects.set(key, { bytes, type: options?.httpMetadata?.contentType, version: ++this.versions });
    this.puts.push(key);
    return this.describe(key);
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  async list(options?: { prefix?: string; delimiter?: string }) {
    const prefix = options?.prefix || '';
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (!options?.delimiter) return { objects: keys.map((k) => this.describe(k)), truncated: false };
    const folders = new Set<string>();
    const direct: string[] = [];
    for (const k of keys) {
      const cut = k.indexOf(options.delimiter, prefix.length);
      if (cut < 0) direct.push(k);
      else folders.add(k.slice(0, cut + 1));
    }
    return { objects: direct.map((k) => this.describe(k)), truncated: false, delimitedPrefixes: [...folders] };
  }

  json(key: string) {
    return JSON.parse(new TextDecoder().decode(this.objects.get(key)!.bytes));
  }
}

interface Call { url: string; method: string; headers: Headers; body: unknown }
type Responder = (call: Call) => Response | Promise<Response> | undefined;

const SUGGESTIONS = [
  { track_id: 'trk_1', target: 'volume_db', value: -3, fx_type: null, params: null, reason: 'La voz queda 4 LU por encima de la guitarra.' },
  { track_id: 'trk_2', target: 'fx', value: null, fx_type: 'eq',
    params: { hpf_hz: 80, low_db: -2, mid_hz: null, mid_db: null, mid_q: null, high_db: null, threshold_db: null, ratio: null, attack_ms: null, release_ms: null, knee_db: null, makeup_db: null, ceiling_db: null },
    reason: 'La guitarra acumula energía bajo 200 Hz.' },
  { track_id: 'master', target: 'fx', value: null, fx_type: 'limiter', params: { ceiling_db: -1 }, reason: 'El pico real del master supera -1 dBTP.' },
  // Lo que sigue no cumple el contrato y el Worker lo descarta:
  { track_id: 'trk_99', target: 'volume_db', value: -3, fx_type: null, params: null, reason: 'Pista que no existe.' },
  { track_id: 'trk_1', target: 'volume_db', value: 40, fx_type: null, params: null, reason: 'Fuera de rango.' },
  { track_id: 'master', target: 'pan', value: 0.2, fx_type: null, params: null, reason: 'El master no tiene paneo.' },
  { track_id: 'trk_1', target: 'fx', value: null, fx_type: 'limiter', params: { ceiling_db: -1 }, reason: 'Limitador en una pista.' },
  { track_id: 'trk_1', target: 'fx', value: null, fx_type: 'eq', params: { low_db: 99 }, reason: 'Parámetro fuera de rango.' },
  { track_id: 'trk_1', target: 'fx', value: null, fx_type: 'eq', params: { ratio: 4 }, reason: 'Parámetro de otro efecto.' },
  { track_id: 'trk_1', target: 'fx', value: null, fx_type: 'eq', params: {}, reason: 'Sin parámetros.' },
  { track_id: 'trk_1', target: 'volume_db', value: -2, fx_type: null, params: null, reason: '   ' },
];

/** Respuesta 200 de URiT IA POST /v1/music (CONTRACT_V1.md 4A.1) con un MP3 falso de 15 bytes. */
function musicReply(estimatedUsd = '0.040000', audio: unknown = { mime_type: 'audio/mpeg', data: Buffer.from('ID3-audio-falso').toString('base64'), bytes: 15 }): Response {
  return Response.json({
    id: 'ai_m', model: 'lyria-3-clip-preview', models_tried: ['lyria-3-clip-preview'], output: { audio, text: '' },
    usage: { songs: 1, input_tokens: 12, output_tokens: 0, thinking_tokens: 0, estimated_usd: estimatedUsd }, finish_reason: 'stop',
  });
}

function setup(vars: Partial<Env> = {}) {
  const bucket = new FakeR2();
  const env: Env = {
    STEMS: bucket, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', ALLOWED_ORIGINS: ORIGIN, ...vars,
  };
  const clock = { now: new Date('2026-11-19T15:00:00.000Z') };
  let ids = 0;
  const waited: Promise<unknown>[] = [];
  const deps = { now: () => clock.now, newId: (prefix: string) => `${prefix}_t${++ids}`, waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
  const calls: Call[] = [];
  /** Estado del trabajo en Music AI y de sus descargas; cada prueba lo cambia. */
  const world = {
    musicAiJob: { status: 'QUEUED' } as Record<string, unknown>,
    downloads: {} as Record<string, { bytes: Uint8Array; type: string } | 'fail'>,
    lyria: (() => musicReply()) as () => Response,
    assist: (() => Response.json({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ suggestions: SUGGESTIONS }) }] })) as () => Response,
    extra: undefined as Responder | undefined,
  };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    let body: unknown = init?.body;
    if (body instanceof ReadableStream) body = new Uint8Array(await new Response(body).arrayBuffer());
    const call: Call = { url, method: init?.method || 'GET', headers, body };
    calls.push(call);
    const custom = await world.extra?.(call);
    if (custom) return custom;
    if (url.startsWith('https://x.supabase.co/')) {
      const token = (headers.get('Authorization') || '').replace('Bearer ', '');
      if (!(token in ROLES_BY_TOKEN)) return new Response('{}', { status: 401 });
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: USER });
      return Response.json(ROLES_BY_TOKEN[token]);
    }
    if (url === 'https://api.music.ai/v1/upload') return Response.json({ uploadUrl: 'https://up.test/in', downloadUrl: 'https://dl.test/in' });
    if (url === 'https://up.test/in') return new Response(null, { status: 200 });
    if (url === 'https://api.music.ai/v1/job') return Response.json({ id: 'mai-1' });
    if (url === 'https://api.music.ai/v1/job/mai-1') return Response.json(world.musicAiJob);
    if (url in world.downloads) {
      const d = world.downloads[url];
      if (d === 'fail') return new Response('no', { status: 500 });
      return new Response(d.bytes, { headers: { 'Content-Type': d.type, 'Content-Length': String(d.bytes.byteLength) } });
    }
    if (url === 'https://ai.urit.services/v1/music') return world.lyria();
    if (url === 'https://api.anthropic.com/v1/messages') return world.assist();
    throw new Error(`llamada inesperada: ${url}`);
  };
  interface Opts { token?: string; body?: BodyInit; type?: string; origin?: string; length?: number | null; headers?: Record<string, string> }
  const call = (method: string, path: string, opts: Opts = {}) => {
    const headers = new Headers(opts.headers);
    if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
    if (opts.type) headers.set('Content-Type', opts.type);
    if (opts.origin) headers.set('Origin', opts.origin);
    if (opts.body !== undefined && opts.length !== null) {
      const size = opts.length ?? (typeof opts.body === 'string' ? new TextEncoder().encode(opts.body).byteLength : (opts.body as Uint8Array).byteLength);
      headers.set('Content-Length', String(size));
    }
    return handle(new Request(`https://stems.test/v1/bands/${BAND}/studio${path}`, { method, headers, body: opts.body }), env, fetchFn, deps);
  };
  const post = (path: string, body: unknown, token = OWNER) => call('POST', path, { token, body: JSON.stringify(body), type: 'application/json' });
  const external = () => calls.filter((c) => !c.url.startsWith('https://x.supabase.co/'));
  return { bucket, env, call, post, calls, external, clock, world, waited };
}

/** Primeros bytes de un audio real de cada formato: el Worker decide el formato por ellos. */
const WAV_BYTES = new TextEncoder().encode('RIFF\0\0\0\0WAVEfmt ');
const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04]);

/** Cabecera WAV PCM de 44 bytes que declara `dataBytes` de audio. */
function wavHeader(sampleRate: number, channels: number, bits: number, dataBytes: number): Uint8Array {
  const bytes = new Uint8Array(44);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 36 + dataBytes, true);
  bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bits / 8), true);
  view.setUint16(32, channels * (bits / 8), true);
  view.setUint16(34, bits, true);
  bytes.set(new TextEncoder().encode('data'), 36);
  view.setUint32(40, dataBytes, true);
  return bytes;
}

const prefix = `bands/${BAND}/studio/`;
const audio = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
const CREATE = { 'If-None-Match': '*' };

function emptySession(id: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1, id, title: 'Maqueta', song_id: null, bpm: 120, beats_per_bar: 4, key: null, sample_rate: 48000,
    latency_offset_ms: 0, updated_at: '2026-01-01T00:00:00Z', updated_by: null, assets: [], tracks: [],
    master: { volume_db: 0, fx: [], reverb: { decay_s: 1.8, return_db: 0 } }, ...extra,
  };
}

const METRICS = {
  target_lufs: -14, master: { lufs: -11.2, true_peak_db: -0.3 },
  tracks: [
    { track_id: 'trk_1', name: 'Voz', role: 'vocals', lufs: -14, true_peak_db: -3, bands: { low_db: -30, low_mid_db: -2, high_mid_db: -8, high_db: -20 }, volume_db: 0, pan: 0, fx: [] },
    { track_id: 'trk_2', name: 'Guitarra', role: 'guitar', lufs: -18, true_peak_db: -6, bands: null, volume_db: -2, pan: -0.3,
      fx: [{ type: 'eq', bypass: false, params: { hpf_hz: 60 } }] },
  ],
};

// --------------------------------------------------------------------------- documento

test('el fixture canonico valida y vuelve identico; los roles son los de stem_names.json', () => {
  assert.deepEqual(validateSession(structuredClone(FIXTURE)), FIXTURE);
  assert.deepEqual([...ROLES].sort(), [...Object.keys(STEM_NAMES.roles), 'unknown'].sort());
  assert.equal(FX_PARAM_SPECS.limiter.find((s) => s.key === 'ceiling_db')!.def, -1);
});

test('validacion estricta: cada mutacion del fixture se rechaza con su codigo y su ruta', () => {
  const cases: [string, string, (d: typeof FIXTURE) => void][] = [
    ['unsupported_version', 'version', (d) => { d.version = 3; }],
    // Un v1 se valida con las reglas de v1: un campo de v2 es desconocido (STUDIO_V2.md 1).
    ['unknown_field', 'markers', (d) => { d.markers = []; }],
    ['unknown_field', 'tracks[0].kind', (d) => { d.tracks[0].kind = 'audio'; }],
    ['unknown_field', 'extra', (d) => { d.extra = 1; }],
    ['missing_field', 'latency_offset_ms', (d) => { delete d.latency_offset_ms; }],
    ['out_of_range', 'bpm', (d) => { d.bpm = 300; }],
    ['bad_value', 'sample_rate', (d) => { d.sample_rate = 22050; }],
    ['bad_value', 'assets[0].file', (d) => { d.assets[0].file = 'otro.wav'; }],
    ['bad_value', 'assets[0].file', (d) => { d.assets[0].file = 'ast_a1.ogg'; }],
    ['missing_source', 'assets[3].source', (d) => { d.assets[3].source = null; }],
    ['duplicate_id', 'assets[1].id', (d) => { d.assets[1].id = 'ast_a1'; d.assets[1].file = 'ast_a1.wav'; }],
    ['bad_id', 'tracks[0].id', (d) => { d.tracks[0].id = 'master'; }],
    ['bad_value', 'tracks[0].role', (d) => { d.tracks[0].role = 'kazoo'; }],
    ['unknown_asset', 'tracks[0].clips[0].asset_id', (d) => { d.tracks[0].clips[0].asset_id = 'ast_nope'; }],
    ['clip_out_of_asset', 'tracks[0].clips[0].length_s', (d) => { d.tracks[0].clips[0].length_s = 60; }],
    ['bad_fades', 'tracks[0].clips[0].fade_in_s', (d) => { d.tracks[0].clips[0].fade_in_s = 29.99; }],
    ['session_too_long', 'tracks[0].clips[0].start_s', (d) => { d.tracks[0].clips[0].start_s = 1190; }],
    ['bad_fx', 'tracks[0].fx[1]', (d) => { d.tracks[0].fx[1] = { type: 'limiter', bypass: false, params: {} }; }],
    ['out_of_range', 'tracks[0].fx[0].params.low_db', (d) => { d.tracks[0].fx[0].params.low_db = 40; }],
    ['unknown_field', 'tracks[0].fx[0].params.ratio', (d) => { d.tracks[0].fx[0].params.ratio = 2; }],
    ['too_many', 'tracks', (d) => { d.tracks = Array.from({ length: 17 }, (_, i) => ({ ...d.tracks[1], id: `t${i}`, clips: [] })); }],
    ['not_an_object', 'master', (d) => { d.master = []; }],
  ];
  for (const [code, path, mutate] of cases) {
    const doc = structuredClone(FIXTURE);
    mutate(doc);
    assert.throws(() => validateSession(doc), (err: unknown) => err instanceof SessionError && err.code === code && err.path === path, `${code} ${path}`);
  }
  // Un parametro de efecto ausente toma su valor por defecto (unica tolerancia, seccion 2.6).
  const partial = structuredClone(FIXTURE);
  partial.master.fx = [{ type: 'limiter', bypass: false, params: { ceiling_db: -2 } }];
  assert.deepEqual(validateSession(partial).master.fx[0].params, { ceiling_db: -2, release_ms: 100 });
});

// --------------------------------------------------------------------------- sesiones

test('sesion: crear con If-None-Match, leer con ETag, reemplazar con If-Match, conflicto 412', async () => {
  const { call, bucket, clock } = setup();
  for (const a of FIXTURE.assets) bucket.seed(`${prefix}ses_9f2c/assets/${a.file}`, a.size);
  const body = JSON.stringify(FIXTURE);

  assert.equal((await call('GET', '/ses_9f2c/session', { token: MUSICIAN })).status, 404);
  const noPre = await call('PUT', '/ses_9f2c/session', { token: OWNER, body });
  assert.equal(noPre.status, 428);
  assert.equal((await noPre.json()).error, 'precondition_required');
  const both = await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: { ...CREATE, 'If-Match': '"v1"' } });
  assert.equal(both.status, 428);
  assert.equal((await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: { 'If-Match': '"v1"' } })).status, 412, 'If-Match sobre una sesion que no existe');

  const created = await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: CREATE });
  assert.equal(created.status, 200);
  const saved = await created.json();
  assert.equal(saved.updated_at, '2026-11-19T15:00:00.000Z', 'la hora la pone el Worker');
  assert.equal(saved.updated_by, USER, 'el sub del token');
  assert.deepEqual({ ...saved, updated_at: FIXTURE.updated_at, updated_by: FIXTURE.updated_by }, FIXTURE);
  const etag = created.headers.get('ETag')!;
  assert.match(etag, /^".+"$/);

  const again = await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: CREATE });
  assert.equal(again.status, 412);
  assert.equal((await again.json()).error, 'session_conflict');

  const got = await call('GET', '/ses_9f2c/session', { token: MUSICIAN });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('ETag'), etag);
  assert.equal(got.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await got.json(), saved);

  clock.now = new Date('2026-11-19T16:00:00.000Z');
  const replaced = await call('PUT', '/ses_9f2c/session', { token: DIRECTOR, body: JSON.stringify({ ...FIXTURE, title: '  Hoy - mezcla 2  ' }), headers: { 'If-Match': etag } });
  assert.equal(replaced.status, 200);
  assert.equal((await replaced.json()).title, 'Hoy - mezcla 2');
  const etag2 = replaced.headers.get('ETag')!;
  assert.notEqual(etag2, etag);

  const stale = await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: { 'If-Match': etag } });
  assert.equal(stale.status, 412, 'otra persona guardo: no se pisa nada');
  assert.equal(bucket.json(`${prefix}ses_9f2c/session.json`).title, 'Hoy - mezcla 2');
});

test('sesion: 409 missing_asset, 400 bad_session, 413 session_too_large; guardar no borra audios', async () => {
  const { call, bucket, waited } = setup();
  const body = JSON.stringify(FIXTURE);
  const missing = await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: CREATE });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error, 'missing_asset');
  for (const a of FIXTURE.assets) bucket.seed(`${prefix}ses_9f2c/assets/${a.file}`, a.size);
  bucket.seed(`${prefix}ses_9f2c/assets/ast_a1.wav`, 99);
  assert.equal((await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: CREATE })).status, 409, 'mismo nombre, otro tamano');
  bucket.seed(`${prefix}ses_9f2c/assets/ast_a1.wav`, FIXTURE.assets[0].size);
  bucket.seed(`${prefix}ses_9f2c/assets/ast_viejo.wav`, 5);

  const bad = async (text: string, path = '/ses_9f2c/session') => {
    const r = await call('PUT', path, { token: OWNER, body: text, headers: CREATE });
    return [r.status, (await r.json()).error];
  };
  assert.deepEqual(await bad('{no json'), [400, 'bad_session']);
  assert.deepEqual(await bad(JSON.stringify({ ...FIXTURE, extra: true })), [400, 'bad_session']);
  assert.deepEqual(await bad(body, '/otra/session'), [400, 'bad_session'], 'el id debe ser el de la ruta');
  assert.deepEqual(await bad(JSON.stringify({ ...FIXTURE, title: 'x'.repeat(1100 * 1024) })), [413, 'session_too_large']);

  assert.equal((await call('PUT', '/ses_9f2c/session', { token: OWNER, body, headers: CREATE })).status, 200);
  assert.ok(bucket.objects.has(`${prefix}ses_9f2c/assets/ast_viejo.wav`), 'un audio que el documento no lista sigue ahi');
  // Desde 1.4.0, despues de responder, la limpieza oportunista (waitUntil) borra los audios que el
  // documento no lista y tienen mas de 2 h (aqui todos: este R2 simulado los fecha en 1970). Los
  // listados se quedan. Detalle en tests/studioCleanup.test.ts.
  await Promise.all(waited);
  assert.ok(!bucket.objects.has(`${prefix}ses_9f2c/assets/ast_viejo.wav`), 'la limpieza tras guardar se lo lleva');
  for (const a of FIXTURE.assets) assert.ok(bucket.objects.has(`${prefix}ses_9f2c/assets/${a.file}`), a.file);
});

test('lista de sesiones por fecha descendente y borrado idempotente', async () => {
  const { call, bucket, clock } = setup();
  assert.deepEqual(await (await call('GET', '', { token: MUSICIAN })).json(), { sessions: [] });
  await call('PUT', '/ses_a/session', { token: OWNER, body: JSON.stringify(emptySession('ses_a', { title: 'Primera', song_id: 'sng_1' })), headers: CREATE });
  clock.now = new Date('2026-11-20T10:00:00.000Z');
  await call('PUT', '/ses_b/session', { token: OWNER, body: JSON.stringify(emptySession('ses_b', { title: 'Segunda' })), headers: CREATE });
  // Audios subidos antes del documento y el contador de gasto no son sesiones listables.
  await call('PUT', '/ses_c/assets/ast_1.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  bucket.seed(`${prefix}_usage/2026-11.json`, 10);

  const list = await (await call('GET', '', { token: MUSICIAN })).json();
  assert.deepEqual(list.sessions, [
    { id: 'ses_b', title: 'Segunda', song_id: null, updated_at: '2026-11-20T10:00:00.000Z' },
    { id: 'ses_a', title: 'Primera', song_id: 'sng_1', updated_at: '2026-11-19T15:00:00.000Z' },
  ]);

  await call('PUT', '/ses_a/assets/ast_1.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  assert.deepEqual(await (await call('DELETE', '/ses_a', { token: DIRECTOR })).json(), { deleted: 2 });
  assert.deepEqual(await (await call('DELETE', '/ses_a', { token: DIRECTOR })).json(), { deleted: 0 });
  assert.ok(bucket.objects.has(`${prefix}ses_b/session.json`), 'las demas sesiones no se tocan');
  assert.ok(bucket.objects.has(`${prefix}_usage/2026-11.json`));
});

test('permisos por rol y validacion de la ruta', async () => {
  const { call, post } = setup();
  const doc = JSON.stringify(emptySession('ses_a'));
  // Un Musician colabora en sesiones, audios y VCS; NO borra sesiones ni gasta creditos en jobs.
  assert.equal((await call('GET', '', { token: MUSICIAN })).status, 200);
  assert.equal((await call('PUT', '/ses_a/assets/ast_1.wav', { token: MUSICIAN, body: audio, type: 'audio/wav' })).status, 200);
  assert.equal((await call('PUT', '/ses_a/session', { token: MUSICIAN, body: doc, headers: CREATE })).status, 200);
  const vcsPost = await call('POST', '/ses_a/vcs', {
    token: MUSICIAN,
    body: JSON.stringify({ branch: 'main', message: 'Maqueta inicial', author_name: 'Guitarrista', session: emptySession('ses_a') }),
  });
  assert.equal(vcsPost.status, 201);
  const vcsBody = await vcsPost.json() as { commit: { id: string; branch: string }; vcs: { branches: Record<string, string> } };
  assert.equal(vcsBody.vcs.branches.main, vcsBody.commit.id);
  assert.equal((await call('GET', '/ses_a/vcs', { token: SUBSTITUTE })).status, 200);
  assert.equal((await call('GET', `/ses_a/commits/${vcsBody.commit.id}`, { token: SUBSTITUTE })).status, 200);
  // Substitute es solo lectura en el Estudio.
  assert.equal((await call('PUT', '/ses_b/session', { token: SUBSTITUTE, body: JSON.stringify(emptySession('ses_b')), headers: CREATE })).status, 403);
  assert.equal((await call('PUT', '/ses_a/assets/ast_2.wav', { token: SUBSTITUTE, body: audio, type: 'audio/wav' })).status, 403);
  assert.equal((await call('POST', '/ses_a/vcs', { token: SUBSTITUTE, body: JSON.stringify({ branch: 'main', message: 'Intento', session: emptySession('ses_a') }) })).status, 403);
  // Borrar sesion y lanzar trabajos IA siguen exclusivos de Owner y MusicDirector.
  assert.equal((await call('DELETE', '/ses_a', { token: MUSICIAN })).status, 403);
  const job = await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS }, MUSICIAN);
  assert.equal(job.status, 403);
  assert.equal((await job.json()).error, 'not_an_editor');
  assert.equal((await post('/ses_a/jobs?estimate=1', { kind: 'assist', metrics: METRICS }, MUSICIAN)).status, 403);
  // Quien no es de la banda, o no trae token valido, no entra.
  assert.equal((await call('GET', '', { token: STRANGER })).status, 403);
  assert.equal((await call('GET', '/ses_a/session', { token: STRANGER })).status, 403);
  assert.equal((await call('GET', '/ses_a/assets/ast_1.wav', { token: STRANGER })).status, 403);
  assert.equal((await call('GET', '/ses_a/jobs/job_1', { token: STRANGER })).status, 403);
  assert.equal((await call('GET', '/ses_a/session', { token: jwt('desconocido') })).status, 401);
  assert.equal((await call('GET', '/ses_a/session')).status, 401);

  const code = async (method: string, path: string) => {
    const r = await call(method, path, { token: OWNER });
    return [r.status, (await r.json()).error];
  };
  assert.deepEqual(await code('GET', '/_usage/session'), [400, 'bad_session_id']);
  assert.deepEqual(await code('GET', '/a%20b/session'), [400, 'bad_session_id']);
  assert.deepEqual(await code('GET', '/ses_a/assets/ast_1.ogg'), [400, 'bad_asset']);
  assert.deepEqual(await code('GET', '/ses_a/assets/.wav'), [400, 'bad_asset']);
  assert.deepEqual(await code('GET', '/ses_a/jobs/a.b'), [400, 'bad_job']);
  assert.deepEqual(await code('GET', '/ses_a/otra'), [404, 'not_found']);
  assert.deepEqual(await code('POST', ''), [405, 'method_not_allowed']);
  assert.deepEqual(await code('GET', '/ses_a'), [405, 'method_not_allowed']);
  assert.deepEqual(await code('DELETE', '/ses_a/session'), [405, 'method_not_allowed']);
  assert.deepEqual(await code('GET', '/ses_a/jobs'), [405, 'method_not_allowed']);
  assert.deepEqual(await code('GET', '/ses_a/jobs/job_nope'), [404, 'no_job']);
});

test('workspace personal "me": la sesion queda bajo el id de quien llama', async () => {
  const bucket = new FakeR2();
  const env: Env = { STEMS: bucket, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', ALLOWED_ORIGINS: '' };
  const res = await handle(new Request('https://stems.test/v1/bands/me/studio/ses_a/session', {
    method: 'PUT', headers: { Authorization: `Bearer ${OWNER}`, ...CREATE }, body: JSON.stringify(emptySession('ses_a')),
  }), env, async () => Response.json({ id: USER }));
  assert.equal(res.status, 200);
  assert.ok(bucket.objects.has(`users/${USER}/studio/ses_a/session.json`));
});

// --------------------------------------------------------------------------- audios

test('audios inmutables: reintentar con el mismo tamano es 200 sin reescribir; otro tamano, 409', async () => {
  const { call, bucket } = setup();
  const first = await call('PUT', '/ses_a/assets/ast_1.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  assert.equal(first.status, 200, 'se puede subir antes de que exista el documento');
  assert.deepEqual(await first.json(), { file: 'ast_1.wav', size: 10 });
  const retry = await call('PUT', '/ses_a/assets/ast_1.wav', { token: DIRECTOR, body: new Uint8Array(10).fill(9), type: 'application/octet-stream' });
  assert.equal(retry.status, 200);
  assert.equal(bucket.puts.length, 1, 'no se volvio a escribir');
  assert.deepEqual(bucket.objects.get(`${prefix}ses_a/assets/ast_1.wav`)!.bytes, audio);
  const other = await call('PUT', '/ses_a/assets/ast_1.wav', { token: OWNER, body: new Uint8Array(4), type: 'audio/wav' });
  assert.equal(other.status, 409);
  assert.equal((await other.json()).error, 'asset_exists');

  const code = async (opts: Parameters<typeof call>[2]) => {
    const r = await call('PUT', '/ses_a/assets/ast_2.flac', { token: OWNER, ...opts });
    return [r.status, (await r.json()).error];
  };
  assert.deepEqual(await code({}), [411, 'length_required']);
  assert.deepEqual(await code({ body: new Uint8Array(0), type: 'audio/flac' }), [400, 'empty_body']);
  assert.deepEqual(await code({ body: audio, type: 'audio/flac', length: 201 * 1024 * 1024 }), [413, 'file_too_large']);
  assert.deepEqual(await code({ body: audio, type: 'text/html' }), [415, 'not_audio']);
  assert.deepEqual(await code({ body: audio, type: 'audio/flac', length: 999 }), [400, 'incomplete_upload']);
  assert.ok(!bucket.objects.has(`${prefix}ses_a/assets/ast_2.flac`), 'una subida incompleta no deja objeto');
});

test('audios: GET completo y con Range (206, sufijo, 416)', async () => {
  const { call } = setup();
  await call('PUT', '/ses_a/assets/ast_1.mp3', { token: OWNER, body: audio, type: 'application/octet-stream' });
  const full = await call('GET', '/ses_a/assets/ast_1.mp3', { token: MUSICIAN });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Content-Type'), 'audio/mpeg', 'el tipo sale de la extension');
  assert.equal(full.headers.get('Content-Length'), '10');
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes');
  assert.ok(full.headers.get('ETag'));
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), audio);

  const range = async (value: string) => {
    const r = await call('GET', '/ses_a/assets/ast_1.mp3', { token: MUSICIAN, headers: { Range: value } });
    return [r.status, r.headers.get('Content-Range'), r.status === 206 ? [...new Uint8Array(await r.arrayBuffer())] : (await r.json()).error];
  };
  assert.deepEqual(await range('bytes=2-5'), [206, 'bytes 2-5/10', [12, 13, 14, 15]]);
  assert.deepEqual(await range('bytes=7-'), [206, 'bytes 7-9/10', [17, 18, 19]]);
  assert.deepEqual(await range('bytes=-3'), [206, 'bytes 7-9/10', [17, 18, 19]]);
  assert.deepEqual(await range('bytes=8-400'), [206, 'bytes 8-9/10', [18, 19]]);
  assert.deepEqual(await range('bytes=10-12'), [416, 'bytes */10', 'bad_range']);
  assert.deepEqual(await range('bytes=0-1,4-5'), [416, 'bytes */10', 'bad_range']);
  assert.deepEqual(await range('items=0-1'), [416, 'bytes */10', 'bad_range']);
  assert.equal((await call('GET', '/ses_a/assets/ast_nope.mp3', { token: MUSICIAN, headers: { Range: 'bytes=0-1' } })).status, 404);
  const missing = await call('GET', '/ses_a/assets/ast_nope.mp3', { token: MUSICIAN });
  assert.deepEqual([missing.status, (await missing.json()).error], [404, 'no_asset']);

  assert.deepEqual(parseRange('bytes=0-0', 10), { offset: 0, length: 1 });
  assert.equal(parseRange('bytes=5-2', 10), null);
  assert.equal(parseRange('bytes=-0', 10), null);
  assert.equal(parseRange('bytes=-', 10), null);
});

test('CORS: el navegador puede mandar If-Match y Range y leer ETag y Content-Range', async () => {
  const { call } = setup();
  const pre = await call('OPTIONS', '/ses_a/session', { origin: ORIGIN });
  assert.equal(pre.status, 204);
  for (const h of ['If-Match', 'If-None-Match', 'Range']) assert.ok(pre.headers.get('Access-Control-Allow-Headers')!.includes(h), h);
  for (const h of ['ETag', 'Content-Range']) assert.ok(pre.headers.get('Access-Control-Expose-Headers')!.includes(h), h);
});

// --------------------------------------------------------------------------- trabajos

const MASTER = { kind: 'master', asset_id: 'ast_mix', duration_s: 240, target_lufs: -14 };

test('master: sin secreto o sin workflow es 503; lanza en Music AI, copia el audio y es idempotente', async () => {
  const noKey = setup({ MUSICAI_MASTER_WORKFLOW: 'mastering-bandait' });
  assert.deepEqual([(await noKey.post('/ses_a/jobs', MASTER)).status], [503]);
  const noFlow = setup({ MUSICAI_API_KEY: 'k' });
  const r503 = await noFlow.post('/ses_a/jobs', MASTER);
  assert.deepEqual([r503.status, (await r503.json()).error], [503, 'provider_unavailable']);
  assert.equal(noFlow.external().length, 0);

  const { call, post, bucket, external, world } = setup({ MUSICAI_API_KEY: 'musicai-key', MUSICAI_MASTER_WORKFLOW: 'mastering-bandait', MUSICAI_MASTER_LUFS_PARAM: 'loudness' });
  const noAsset = await post('/ses_a/jobs', MASTER);
  assert.deepEqual([noAsset.status, (await noAsset.json()).error], [404, 'no_asset']);
  await call('PUT', '/ses_a/assets/ast_mix.flac', { token: OWNER, body: audio, type: 'audio/flac' });

  const started = await post('/ses_a/jobs', MASTER, DIRECTOR);
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), { job_id: 'job_t1', status: 'STARTED', kind: 'master' });
  const [upload, put, job] = external();
  assert.equal(upload.headers.get('Authorization'), 'musicai-key');
  assert.deepEqual(put.body, audio, 'la mezcla de assets/ viaja a Music AI');
  assert.equal(put.headers.get('Content-Type'), 'audio/flac');
  assert.deepEqual(JSON.parse(String(job.body)), {
    name: 'bandait-studio-ses_a-master', workflow: 'mastering-bandait', params: { inputUrl: 'https://dl.test/in', loudness: -14 },
  });
  const usage = bucket.json(`${prefix}_usage/2026-11.json`);
  assert.equal(usage.total_usd, 0.8, '4 minutos a USD 0,20');
  assert.deepEqual(usage.entries, [{ at: '2026-11-19T15:00:00.000Z', job_id: 'job_t1', kind: 'master', provider: 'musicai', seconds: 240, cost_usd: 0.8, user: USER }]);

  const poll = async (token = MUSICIAN) => {
    const r = await call('GET', '/ses_a/jobs/job_t1', { token });
    return [r.status, await r.json()];
  };
  assert.deepEqual(await poll(), [200, { job_id: 'job_t1', kind: 'master', status: 'STARTED' }], 'en cola se informa como STARTED');
  world.musicAiJob = { status: 'SUCCEEDED', result: { Report: { lufs: -14 }, 'Master Output': 'https://out.test/master.wav?sig=1' } };
  world.downloads['https://out.test/master.wav?sig=1'] = 'fail';
  assert.deepEqual(await poll(), [502, { error: 'asset_copy_failed' }]);
  world.downloads['https://out.test/master.wav?sig=1'] = { bytes: WAV_BYTES, type: 'application/octet-stream' };
  const asset = {
    id: 'ast_t2', file: 'ast_t2.wav', kind: 'master', label: 'Master -14 LUFS', role: null, size: 16, channels: null, sample_rate: null,
    duration_s: null, source: { provider: 'musicai', job_id: 'job_t1' },
  };
  const done = [200, { job_id: 'job_t1', kind: 'master', status: 'SUCCEEDED', assets: [asset], cost_usd: 0.8 }];
  assert.deepEqual(await poll(), done, 'el reintento usa el id reservado');
  assert.equal(bucket.objects.get(`${prefix}ses_a/assets/ast_t2.wav`)!.type, 'audio/wav');
  const before = external().length;
  assert.deepEqual(await poll(), done, 'un estado final se repite');
  assert.equal(external().length, before, 'sin volver a Music AI');
  assert.equal(bucket.json(`${prefix}_usage/2026-11.json`).total_usd, 0.8, 'consultar no gasta');
});

test('master: Music AI falla o rechaza', async () => {
  const { call, post, bucket, world } = setup({ MUSICAI_API_KEY: 'k', MUSICAI_MASTER_WORKFLOW: 'm' });
  await call('PUT', '/ses_a/assets/ast_mix.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  world.extra = (c) => (c.url === 'https://api.music.ai/v1/job' ? new Response('{}', { status: 500 }) : undefined);
  const rejected = await post('/ses_a/jobs', MASTER);
  assert.deepEqual([rejected.status, (await rejected.json()).error], [502, 'provider_failed']);
  // El costo se reserva antes de llamar al proveedor y se revierte si este rechaza.
  assert.deepEqual(bucket.json(`${prefix}_usage/2026-11.json`), { month: '2026-11', total_usd: 0, entries: [] }, 'un trabajo que no se lanzo no se cobra');
  assert.equal(bucket.json('studio/_usage/2026-11.json').total_usd, 0, 'tampoco en el contador global');
  assert.ok(!bucket.objects.has(`${prefix}ses_a/jobs/job_t1.json`), 'ni deja registro');
  world.extra = undefined; // el intento rechazado ya consumio el id job_t1

  assert.equal((await post('/ses_a/jobs', MASTER)).status, 202);
  assert.equal(bucket.json(`${prefix}ses_a/jobs/job_t2.json`).label, 'Master', 'sin MUSICAI_MASTER_LUFS_PARAM la etiqueta no promete un LUFS');
  world.musicAiJob = { status: 'FAILED', error: { message: 'Input too short' } };
  const failed = { job_id: 'job_t2', kind: 'master', status: 'FAILED', error: 'Input too short' };
  assert.deepEqual(await (await call('GET', '/ses_a/jobs/job_t2', { token: OWNER })).json(), failed);
  world.musicAiJob = { status: 'SUCCEEDED', result: {} };
  assert.deepEqual(await (await call('GET', '/ses_a/jobs/job_t2', { token: OWNER })).json(), failed, 'FAILED es final');

  assert.equal((await post('/ses_a/jobs', MASTER)).status, 202);
  const noOutput = await (await call('GET', '/ses_a/jobs/job_t3', { token: OWNER })).json();
  assert.equal(noOutput.status, 'FAILED');
  assert.match(noOutput.error, /workflow de mastering/);
});

test('separate: un stem por GET (IMPORTING) y al final SUCCEEDED con rol y etiqueta', async () => {
  const { call, post, bucket, external, world } = setup({ MUSICAI_API_KEY: 'k' });
  await call('PUT', '/ses_a/assets/ast_song.mp3', { token: OWNER, body: audio, type: 'audio/mpeg' });
  assert.equal((await post('/ses_a/jobs', { kind: 'separate', asset_id: 'ast_song', duration_s: 120 })).status, 202);
  assert.equal(JSON.parse(String(external()[2].body)).workflow, 'splited_stems_bandait', 'el mismo workflow por defecto que el analisis');
  assert.equal(bucket.json(`${prefix}_usage/2026-11.json`).total_usd, 1, '2 minutos a USD 0,50');

  world.musicAiJob = { status: 'SUCCEEDED', result: { Bpm: 120, Vocals: 'https://out.test/v.wav', Drums: 'https://out.test/d', Chords: 'https://out.test/chords.json' } };
  world.downloads['https://out.test/v.wav'] = { bytes: WAV_BYTES, type: 'audio/wav' };
  world.downloads['https://out.test/d'] = { bytes: MP3_BYTES, type: 'audio/mpeg' };
  const poll = async () => (await call('GET', '/ses_a/jobs/job_t1', { token: MUSICIAN })).json();
  assert.deepEqual(await poll(), { job_id: 'job_t1', kind: 'separate', status: 'IMPORTING', done: 1, total: 2 });
  assert.equal(bucket.puts.filter((k) => k.includes('/assets/ast_t')).length, 1, 'una copia por peticion');
  const done = await poll();
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.cost_usd, 1);
  assert.deepEqual(done.assets.map((a: Record<string, unknown>) => [a.file, a.kind, a.role, a.label, a.size]), [
    ['ast_t2.wav', 'stem', 'vocals', 'Voz', 16], ['ast_t3.mp3', 'stem', 'drums', 'Batería', 4],
  ]);
  assert.deepEqual(done.assets[0].source, { provider: 'musicai', job_id: 'job_t1' });
  assert.ok(bucket.objects.has(`${prefix}ses_a/assets/ast_t3.mp3`));
  assert.ok(!bucket.objects.has(`${prefix}ses_a/session.json`), 'un trabajo nunca escribe la sesion');
});

const GENERATE = { kind: 'generate', provider: 'lyria', prompt: 'Pad cálido de 16 compases', duration_s: 30, bpm: 128, key: 'C#m', instrumental: true };

test('generate: Lyria por URiT IA (/v1/music); sin token 503; suno 501; errores y costo real', async () => {
  const noKey = setup({ GEMINI_API_KEY: 'g' });
  const r503 = await noKey.post('/ses_a/jobs', GENERATE);
  assert.deepEqual([r503.status, (await r503.json()).error], [503, 'provider_unavailable'], 'la clave directa de Gemini ya no sirve para Lyria');
  assert.equal(noKey.external().length, 0);
  const suno = setup({ URIT_AI_TOKEN: 'g', SUNO_API_KEY: 's' });
  const r501 = await suno.post('/ses_a/jobs', { ...GENERATE, provider: 'suno' });
  assert.deepEqual([r501.status, (await r501.json()).error], [501, 'provider_unavailable']);
  assert.equal((await suno.post('/ses_a/jobs?estimate=1', { ...GENERATE, provider: 'suno' })).status, 501);
  assert.equal(suno.external().length, 0);

  const { call, post, bucket, external, world } = setup({ URIT_AI_TOKEN: 'urit-token' });
  const spent = () => bucket.json(`${prefix}_usage/2026-11.json`).total_usd as number;
  const entry = (jobId: string) => (bucket.json(`${prefix}_usage/2026-11.json`).entries as { job_id: string; cost_usd: number }[]).find((e) => e.job_id === jobId);
  const get = async (jobId: string) => (await call('GET', `/ses_a/jobs/${jobId}`, { token: MUSICIAN })).json();
  const started = await post('/ses_a/jobs?job_id=job_g1', GENERATE);
  assert.deepEqual([started.status, await started.json()], [202, { job_id: 'job_g1', status: 'STARTED', kind: 'generate' }]);
  const [req] = external();
  assert.equal(req.url, 'https://ai.urit.services/v1/music');
  assert.equal(req.headers.get('Authorization'), 'Bearer urit-token');
  assert.equal(req.headers.get('X-URiT-Consumer'), 'bandait');
  assert.equal(req.headers.get('User-Agent'), 'bandait-stems/1.0');
  assert.deepEqual(JSON.parse(String(req.body)), {
    task: 'studio_generate', model: 'lyria-3-clip-preview', time_budget_ms: 85000,
    prompt: 'Pad cálido de 16 compases\nTempo: 128 BPM.\nKey: C#m.\nInstrumental only, no vocals.',
  }, 'sin duracion, bpm ni tonalidad como parametros: van en el texto');
  assert.deepEqual(await get('job_g1'), {
    job_id: 'job_g1', kind: 'generate', status: 'SUCCEEDED', cost_usd: 0.04,
    assets: [{
      id: 'ast_t1', file: 'ast_t1.mp3', kind: 'generated', label: 'Pad cálido de 16 compases', role: null, size: 15, channels: null,
      sample_rate: null, duration_s: null, source: { provider: 'lyria', job_id: 'job_g1', prompt: GENERATE.prompt },
    }],
  });
  assert.equal(new TextDecoder().decode(bucket.objects.get(`${prefix}ses_a/assets/ast_t1.mp3`)!.bytes), 'ID3-audio-falso');
  assert.equal(entry('job_g1')!.cost_usd, 0.04);
  assert.equal(spent(), 0.04);

  // Pedido largo: modelo de canciones, la duracion va en el texto; el costo real ajusta el contador.
  world.lyria = () => musicReply('0.081000');
  assert.equal((await post('/ses_a/jobs?job_id=job_g2', { ...GENERATE, duration_s: 120 })).status, 202);
  const long = JSON.parse(String(external().at(-1)!.body));
  assert.equal(long.model, 'lyria-3.5');
  assert.match(long.prompt, /Duration: about 2 minutes\./);
  assert.equal((await get('job_g2')).cost_usd, 0.081);
  assert.equal(spent(), 0.121);
  assert.equal(bucket.json('studio/_usage/2026-11.json').total_usd, 0.121, 'tambien el contador global');

  // Configuracion o error del proveedor sin cobro: el POST falla, no queda trabajo ni gasto.
  const jobs = () => [...bucket.objects.keys()].filter((k) => k.includes('/jobs/')).length;
  for (const [status, body, expected] of [
    [401, { error: 'unauthorized' }, [503, 'provider_unavailable']],
    [403, { error: 'consumer_disabled' }, [503, 'provider_unavailable']],
    [422, { error: 'model_not_allowed' }, [503, 'provider_unavailable']],
    [503, { error: 'provider_not_configured' }, [503, 'provider_unavailable']],
    [502, { error: 'provider_error' }, [502, 'provider_failed']],
    [400, { error: 'invalid_request', detail: 'duration_s' }, [502, 'provider_failed']],
  ] as [number, unknown, [number, string]][]) {
    world.lyria = () => Response.json(body, { status });
    const res = await post('/ses_a/jobs', GENERATE);
    assert.deepEqual([res.status, (await res.json()).error], expected, `HTTP ${status}`);
  }
  assert.equal(spent(), 0.121, 'los rechazos no suman gasto');
  assert.equal(jobs(), 2);

  // Llego al proveedor: el trabajo queda FAILED con el motivo; sin cobro en cuota, bloqueo y sin audio.
  const failures: [string, () => Response, RegExp, number][] = [
    ['job_q', () => Response.json({ error: 'provider_quota' }, { status: 429 }), /cuota/, 0],
    ['job_b', () => Response.json({ error: 'blocked' }, { status: 502 }), /filtro de seguridad/, 0],
    ['job_n', () => Response.json({ error: 'provider_error', detail: 'NO_AUDIO' }, { status: 502 }), /no devolvió audio/, 0],
    // 504: URiT lo anota como cobrado, y el Worker tambien.
    ['job_t', () => Response.json({ error: 'time_budget_exhausted', usage: { songs: 1, estimated_usd: '0.040000' } }, { status: 504 }), /tardó demasiado/, 0.04],
    // 200 sin audio legible: la cancion se cobro.
    ['job_u', () => musicReply('0.040000', { mime_type: 'audio/ogg', data: Buffer.from('OggS-no').toString('base64'), bytes: 7 }), /no se pudo leer/, 0.04],
    // Limite propio del Worker (90 s): se trata como el 504, con la estimacion.
    ['job_a', () => { const e = new Error('tiempo'); e.name = 'TimeoutError'; throw e; }, /tardó demasiado/, 0.04],
  ];
  let expectedSpent = 0.121;
  for (const [jobId, reply, reason, cost] of failures) {
    world.lyria = reply;
    assert.equal((await post(`/ses_a/jobs?job_id=${jobId}`, GENERATE)).status, 202, jobId);
    const done = await get(jobId);
    assert.equal(done.status, 'FAILED', jobId);
    assert.match(done.error, reason);
    assert.equal(entry(jobId)!.cost_usd, cost, jobId);
    expectedSpent = Math.round((expectedSpent + cost) * 10000) / 10000;
    assert.equal(spent(), expectedSpent, jobId);
  }

  assert.equal(lyriaModel({ LYRIA_SONG_MODEL: ' ' } as Env, 31), 'lyria-3.5');
  assert.equal(lyriaModel({ LYRIA_CLIP_MODEL: 'otro' } as Env, 30), 'otro');
  assert.equal(lyriaPrompt({ prompt: ' Riff ', duration_s: 12.4, bpm: 97.5, key: null, instrumental: false }), 'Riff\nTempo: 97.5 BPM.', 'el clip dura 30 s: no se pide duracion');
  assert.equal(lyriaPrompt({ prompt: 'Riff', duration_s: 75, bpm: 90, key: 'Dm', instrumental: true }), 'Riff\nTempo: 90 BPM.\nKey: Dm.\nDuration: about 75 seconds.\nInstrumental only, no vocals.');
  assert.deepEqual(audioFromMusic({ output: { audio: { mime_type: 'audio/wav', data: Buffer.from('????').toString('base64') } } })?.ext, 'wav', 'sin firma reconocible vale el mime');
  assert.equal(audioFromMusic({ output: { audio: { mime_type: 'audio/mpeg', data: '' } } }), null);
  assert.equal(detectAudioExt(new TextEncoder().encode('RIFF....WAVE')), 'wav');
  assert.equal(detectAudioExt(new TextEncoder().encode('fLaC....')), 'flac');
});

test('assist con anthropic: pide JSON estructurado al modelo y descarta las sugerencias que no cumplen el contrato', async () => {
  const noKey = setup();
  const r503 = await noKey.post('/ses_a/jobs', { kind: 'assist', metrics: METRICS });
  assert.deepEqual([r503.status, (await r503.json()).error], [503, 'provider_unavailable']);
  const other = setup({ ASSIST_API_KEY: 'a', ASSIST_PROVIDER: 'otro' });
  assert.equal((await other.post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 503, 'proveedor sin adaptador');

  const { call, post, bucket, external, world } = setup({ ASSIST_API_KEY: 'assist-key', ASSIST_PROVIDER: 'anthropic' });
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 202);
  const [req] = external();
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers.get('x-api-key'), 'assist-key');
  assert.equal(req.headers.get('anthropic-version'), '2026-10-21');
  const sent = JSON.parse(String(req.body));
  assert.equal(sent.model, 'claude-sonnet-5-5');
  assert.equal(sent.system, ASSIST_SYSTEM_PROMPT);
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.output_config.format.schema.additionalProperties, false);
  for (const gone of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(gone in sent), `${gone} no se envia`);
  assert.ok(sent.messages[0].content.includes('"track_id":"trk_2"'));
  // Los efectos de las metricas viajan completos (el parametro ausente toma su valor por defecto).
  assert.ok(sent.messages[0].content.includes('"hpf_hz":60,"low_db":0'));

  const result = await (await call('GET', '/ses_a/jobs/job_t1', { token: MUSICIAN })).json();
  assert.deepEqual(result, {
    job_id: 'job_t1', kind: 'assist', status: 'SUCCEEDED', cost_usd: 0.05,
    suggestions: [
      { track_id: 'trk_1', reason: 'La voz queda 4 LU por encima de la guitarra.', target: 'volume_db', value: -3, fx_type: null, params: null },
      { track_id: 'trk_2', reason: 'La guitarra acumula energía bajo 200 Hz.', target: 'fx', value: null, fx_type: 'eq', params: { hpf_hz: 80, low_db: -2 } },
      { track_id: 'master', reason: 'El pico real del master supera -1 dBTP.', target: 'fx', value: null, fx_type: 'limiter', params: { ceiling_db: -1 } },
    ],
  });
  assert.equal([...bucket.objects.keys()].filter((k) => k.includes('/assets/')).length, 0, 'assist no deja audios');

  world.assist = () => Response.json({ stop_reason: 'refusal', content: [] });
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 202);
  const refused = await (await call('GET', '/ses_a/jobs/job_t2', { token: OWNER })).json();
  assert.equal(refused.status, 'FAILED');
  assert.ok(refused.error.length > 0);
  world.assist = () => new Response('{"type":"error"}', { status: 529 });
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 502);

  const custom = setup({ ASSIST_API_KEY: 'a', ASSIST_PROVIDER: 'anthropic', ASSIST_MODEL: 'claude-haiku-5-5' });
  await custom.post('/ses_a/jobs', { kind: 'assist', metrics: METRICS });
  const body = JSON.parse(String(custom.external()[0].body));
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.ok(!('fallbacks' in body), 'fallbacks solo va a los modelos que lo admiten');

  const long = sanitizeSuggestions(Array.from({ length: 40 }, () => ({ track_id: 'a', target: 'pan', value: 0.5, fx_type: null, params: null, reason: 'x'.repeat(400) })), new Set(['a']));
  assert.equal(long.length, 32);
  assert.equal(long[0].reason.length, 280);
});

test('providerSchema: quita los limites que Gemini rechaza y conserva la forma', () => {
  const DROPPED = /"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf|minItems|maxItems|minLength|maxLength|pattern|minProperties|maxProperties)"\s*:/;
  for (const schema of [COMPOSE_SCHEMA, SUGGESTIONS_SCHEMA, ...CHAT_TOOLS.map((t) => t.parameters)]) {
    const clean = providerSchema(schema);
    assert.ok(!DROPPED.test(JSON.stringify(clean)), 'sin limites');
    assert.ok(DROPPED.test(JSON.stringify(schema)) || schema === SUGGESTIONS_SCHEMA, 'el original no se modifica');
  }
  const clean = providerSchema(COMPOSE_SCHEMA) as { required: string[]; properties: { notes: { items: { required: string[] } } } };
  assert.deepEqual(clean.required, ['notes', 'description']);
  assert.deepEqual(clean.properties.notes.items.required, ['pitch', 'start', 'length', 'velocity']);
  // Un campo que se llame como una palabra de JSON Schema no se borra: solo se limpian palabras clave.
  assert.deepEqual(providerSchema({ type: 'object', properties: { maximum: { type: 'number', maximum: 3 } } }), { type: 'object', properties: { maximum: { type: 'number' } } });
});

test('compose por urit: el esquema que viaja a URiT no lleva limites', async () => {
  const { post, external, world } = setup({ URIT_AI_TOKEN: 'urit-token' });
  world.extra = (c) => (c.url === 'https://ai.urit.services/v1/text'
    ? Response.json({ id: 'ai_x', model: 'gemini-3.8-flash', output: { text: '', json: { notes: [{ pitch: 45, start: 0, length: 1, velocity: 90 }], description: 'Bajo.' }, tool_calls: [] }, finish_reason: 'stop', usage: { estimated_usd: '0.001772' } })
    : undefined);
  await post('/ses_a/jobs', { kind: 'compose', prompt: 'Bajo', bpm: 100, key: 'Am', beats_per_bar: 4, length_bars: 2, role: 'bass', context: [] });
  const req = external().find((c) => c.url === 'https://ai.urit.services/v1/text');
  assert.ok(req, 'llamo a URiT');
  const sent = JSON.parse(String(req!.body));
  assert.equal(sent.task, 'studio_compose');
  assert.ok(!/"(minimum|maximum|maxItems|maxLength)"/.test(JSON.stringify(sent.output.schema)));
});

test('assist con urit (por defecto): consumidor bandait en URiT IA, sin la clave de Gemini directa', async () => {
  const noToken = setup({ GEMINI_API_KEY: 'g' });
  const r503 = await noToken.post('/ses_a/jobs', { kind: 'assist', metrics: METRICS });
  assert.deepEqual([r503.status, (await r503.json()).error], [503, 'provider_unavailable'], 'sin URIT_AI_TOKEN no usa la clave directa');
  assert.equal(noToken.external().length, 0);

  let reply: () => Response = () => Response.json({ id: 'ai_x', model: 'gemini-3.8-flash', output: { text: '', json: { suggestions: SUGGESTIONS }, tool_calls: [] }, finish_reason: 'stop' });
  const { call, post, external, world } = setup({ URIT_AI_TOKEN: 'urit-token' });
  world.extra = (c) => (c.url === 'https://ai.urit.services/v1/text' ? reply() : undefined);
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 202);
  const [req] = external();
  assert.equal(req.url, 'https://ai.urit.services/v1/text');
  assert.equal(req.headers.get('Authorization'), 'Bearer urit-token');
  assert.equal(req.headers.get('X-URiT-Consumer'), 'bandait');
  assert.equal(req.headers.get('User-Agent'), 'bandait-stems/1.0');
  const sent = JSON.parse(String(req.body));
  assert.equal(sent.task, 'mix_assist');
  assert.equal(sent.system, ASSIST_SYSTEM_PROMPT);
  assert.equal(sent.output.format, 'json');
  assert.ok(!('models' in sent), 'no fija modelo: manda la cadena de URiT');
  assert.ok(sent.time_budget_ms <= 85000);
  assert.ok(sent.messages[0].parts[0].text.includes('"track_id":"trk_2"'));
  const done = await (await call('GET', '/ses_a/jobs/job_t1', { token: MUSICIAN })).json();
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.suggestions.length, 3, 'las sugerencias fuera de contrato se descartan igual');

  reply = () => Response.json({ error: 'invalid_output' }, { status: 502 });
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 202);
  assert.equal((await (await call('GET', '/ses_a/jobs/job_t2', { token: OWNER })).json()).status, 'FAILED');
  reply = () => Response.json({ error: 'unauthorized' }, { status: 401 });
  const unauthorized = await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS });
  assert.deepEqual([unauthorized.status, (await unauthorized.json()).error], [503, 'provider_unavailable']);
  reply = () => Response.json({ error: 'consumer_budget_exceeded' }, { status: 429 });
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 502);
});

test('assist con gemini directo: generateContent con la clave de Gemini y JSON estructurado', async () => {
  const bodies: unknown[] = [];
  let first: () => Response = () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ suggestions: SUGGESTIONS }) }] }, finishReason: 'STOP' }] });
  const { call, post, world } = setup({ GEMINI_API_KEY: 'gemini-key', ASSIST_PROVIDER: 'gemini' });
  world.extra = (c) => {
    if (!c.url.includes(':generateContent')) return undefined;
    bodies.push(JSON.parse(String(c.body)));
    assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    assert.equal(c.headers.get('x-goog-api-key'), 'gemini-key');
    const r = first();
    first = () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ suggestions: SUGGESTIONS }) }] }, finishReason: 'STOP' }] });
    return r;
  };
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 202);
  const sent = bodies[0] as { generationConfig: Record<string, unknown>; systemInstruction: { parts: { text: string }[] } };
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.ok('responseJsonSchema' in sent.generationConfig);
  assert.equal(sent.systemInstruction.parts[0].text, ASSIST_SYSTEM_PROMPT);
  assert.equal((await (await call('GET', '/ses_a/jobs/job_t1', { token: MUSICIAN })).json()).suggestions.length, 3);

  // Un 400 por el esquema se repite una vez sin el esquema.
  first = () => new Response('{"error":{"message":"schema"}}', { status: 400 });
  assert.equal((await post('/ses_a/jobs', { kind: 'assist', metrics: METRICS })).status, 202);
  assert.equal(bodies.length, 3);
  assert.ok(!('responseJsonSchema' in (bodies[2] as { generationConfig: Record<string, unknown> }).generationConfig));
});

test('tope de gasto: estimacion, 429 al pasarlo y contador nuevo cada mes', async () => {
  const { post, bucket, external, clock } = setup({ URIT_AI_TOKEN: 'g', STUDIO_MONTHLY_BUDGET_USD: '0.1', STUDIO_RATE_LYRIA_SONG_USD: '0.2' });
  const estimate = async (body: unknown) => (await post('/ses_a/jobs?estimate=1', body)).json();
  assert.deepEqual(await estimate(GENERATE), { kind: 'generate', estimated_cost_usd: 0.04, spent_usd: 0, budget_usd: 0.1, allowed: true });
  assert.equal((await estimate({ ...GENERATE, duration_s: 5 })).estimated_cost_usd, 0.04, 'por cancion: un clip corto cuesta lo mismo (dura 30 s)');
  assert.equal(external().length, 0, 'estimar no llama al proveedor');
  assert.equal(bucket.objects.size, 0, 'ni escribe nada');
  assert.deepEqual(await estimate({ ...GENERATE, duration_s: 100 }), { kind: 'generate', estimated_cost_usd: 0.2, spent_usd: 0, budget_usd: 0.1, allowed: false });

  assert.equal((await post('/ses_a/jobs', GENERATE)).status, 202);
  assert.equal((await post('/ses_b/jobs', GENERATE)).status, 202, 'el contador es por banda, no por sesion');
  assert.equal(bucket.json(`${prefix}_usage/2026-11.json`).total_usd, 0.08);
  const calls = external().length;
  const over = await post('/ses_a/jobs', GENERATE);
  assert.deepEqual([over.status, (await over.json()).error], [429, 'quota_exceeded']);
  assert.equal(external().length, calls, 'no se llama al proveedor');
  assert.deepEqual(await estimate(GENERATE), { kind: 'generate', estimated_cost_usd: 0.04, spent_usd: 0.08, budget_usd: 0.1, allowed: false });

  clock.now = new Date('2026-12-01T00:00:01.000Z');
  assert.equal((await estimate(GENERATE)).spent_usd, 0);
  assert.equal((await post('/ses_a/jobs', GENERATE)).status, 202);
  assert.equal(bucket.json(`${prefix}_usage/2026-12.json`).total_usd, 0.04);
  assert.equal(bucket.json(`${prefix}_usage/2026-11.json`).total_usd, 0.08);

  const free = setup({ URIT_AI_TOKEN: 'g' });
  assert.equal((await (await free.post('/ses_a/jobs?estimate=1', GENERATE)).json()).budget_usd, null, 'sin variable no hay tope');
  const typo = setup({ URIT_AI_TOKEN: 'g', STUDIO_MONTHLY_BUDGET_USD: 'veinte' });
  assert.equal((await typo.post('/ses_a/jobs', GENERATE)).status, 429, 'un tope ilegible bloquea en vez de dejar el gasto libre');
});

test('cuerpo de trabajo invalido: 400 bad_job', async () => {
  const { post, call, external } = setup({ MUSICAI_API_KEY: 'k', MUSICAI_MASTER_WORKFLOW: 'm', URIT_AI_TOKEN: 'g', ASSIST_API_KEY: 'a' });
  const cases: unknown[] = [
    [], 'texto', { kind: 'otro' }, {},
    { ...MASTER, target_lufs: -30 }, { ...MASTER, extra: 1 }, { ...MASTER, asset_id: 'a.wav' }, { ...MASTER, duration_s: 0 },
    { kind: 'master', asset_id: 'ast_mix', duration_s: 10 },
    { kind: 'separate', asset_id: 'ast_mix', duration_s: 1300 },
    { ...GENERATE, provider: 'udio' }, { ...GENERATE, prompt: '' }, { ...GENERATE, prompt: '   ' }, { ...GENERATE, prompt: 'x'.repeat(1001) },
    { ...GENERATE, duration_s: 4 }, { ...GENERATE, duration_s: 241 }, { ...GENERATE, bpm: 20 }, { ...GENERATE, instrumental: 'si' }, { ...GENERATE, key: '' },
    { kind: 'assist', metrics: { ...METRICS, tracks: [] } },
    { kind: 'assist', metrics: { ...METRICS, extra: 1 } },
    { kind: 'assist', metrics: { ...METRICS, tracks: [{ ...METRICS.tracks[0], role: 'kazoo' }] } },
    { kind: 'assist', metrics: { ...METRICS, tracks: [{ ...METRICS.tracks[0], track_id: 'master' }] } },
    { kind: 'assist', metrics: { ...METRICS, tracks: [METRICS.tracks[0], METRICS.tracks[0]] } },
    { kind: 'assist', metrics: { ...METRICS, tracks: [{ ...METRICS.tracks[0], fx: [{ type: 'limiter', bypass: false, params: {} }] }] } },
    { kind: 'assist', metrics: { ...METRICS, tracks: [{ ...METRICS.tracks[0], bands: { low_db: 3, low_mid_db: 0, high_mid_db: 0, high_db: 0 } }] } },
    { kind: 'assist', metrics: { ...METRICS, master: { lufs: 'alto', true_peak_db: null } } },
  ];
  for (const body of cases) {
    const r = await post('/ses_a/jobs', body);
    assert.deepEqual([r.status, (await r.json()).error], [400, 'bad_job'], JSON.stringify(body).slice(0, 80));
  }
  const notJson = await call('POST', '/ses_a/jobs', { token: OWNER, body: '{no' });
  assert.equal(notJson.status, 400);
  const big = await call('POST', '/ses_a/jobs', { token: OWNER, body: JSON.stringify({ ...GENERATE, pad: 'x'.repeat(70 * 1024) }) });
  assert.equal(big.status, 400);
  assert.equal(external().length, 0, 'nada invalido llega a un proveedor');
});

// --------------------------------------------------------------------------- cierre de la revision (2026-11-19)

test('escritura condicional: una sesion o un audio escritos entre el head y el put no se pisan', async () => {
  const { call, bucket } = setup();
  const key = `${prefix}ses_a/session.json`;
  const doc = emptySession('ses_a');
  /** Otra peticion escribe `key` justo antes del put de la ruta (una sola vez). */
  const race = (target: string, write: () => void) => {
    bucket.beforePut = (k) => {
      if (k !== target) return;
      bucket.beforePut = undefined;
      write();
    };
  };

  // Crear: el head no vio nada, pero otra persona creo la sesion antes del put.
  race(key, () => bucket.write(key, JSON.stringify({ ...doc, title: 'De otra persona' })));
  const lost = await call('PUT', '/ses_a/session', { token: OWNER, body: JSON.stringify(doc), headers: CREATE });
  assert.deepEqual([lost.status, (await lost.json()).error], [412, 'session_conflict']);
  assert.equal(bucket.json(key).title, 'De otra persona', 'el put condicional no piso nada');

  // Reemplazar: el etag coincidia en el head, y otra persona guardo antes del put.
  const etag = (await call('GET', '/ses_a/session', { token: OWNER })).headers.get('ETag')!;
  race(key, () => bucket.write(key, JSON.stringify({ ...doc, title: 'Otra vez' })));
  const stale = await call('PUT', '/ses_a/session', { token: OWNER, body: JSON.stringify(doc), headers: { 'If-Match': etag } });
  assert.deepEqual([stale.status, (await stale.json()).error], [412, 'session_conflict']);
  assert.equal(bucket.json(key).title, 'Otra vez');

  // Audio: otra subida del mismo nombre gana la carrera.
  const same = `${prefix}ses_a/assets/ast_1.wav`;
  race(same, () => bucket.seed(same, 10));
  const retry = await call('PUT', '/ses_a/assets/ast_1.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  assert.deepEqual([retry.status, await retry.json()], [200, { file: 'ast_1.wav', size: 10 }], 'mismo tamano: es la misma subida');
  assert.ok(!bucket.puts.includes(same), 'no se reescribio');
  const other = `${prefix}ses_a/assets/ast_2.wav`;
  race(other, () => bucket.seed(other, 4));
  const clash = await call('PUT', '/ses_a/assets/ast_2.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  assert.deepEqual([clash.status, (await clash.json()).error], [409, 'asset_exists']);
  assert.equal(bucket.objects.get(other)!.size, 4, 'el audio que gano sigue intacto');
});

test('contador de gasto: dos trabajos simultaneos se anotan los dos y no pasan juntos el tope', async () => {
  const a = setup({ URIT_AI_TOKEN: 'g' });
  const both = await Promise.all([a.post('/ses_a/jobs', GENERATE), a.post('/ses_b/jobs', GENERATE)]);
  assert.deepEqual(both.map((r) => r.status), [202, 202]);
  const usage = a.bucket.json(`${prefix}_usage/2026-11.json`);
  assert.equal(usage.total_usd, 0.08, 'ninguna entrada se pierde');
  assert.equal(usage.entries.length, 2);
  const global = a.bucket.json('studio/_usage/2026-11.json');
  assert.equal(global.total_usd, 0.08);
  assert.deepEqual(global.entries.map((e: { scope: string }) => e.scope), [prefix, prefix], 'el contador global dice quien gasto');

  const b = setup({ URIT_AI_TOKEN: 'g', STUDIO_MONTHLY_BUDGET_USD: '0.04' });
  const raced = await Promise.all([b.post('/ses_a/jobs', GENERATE), b.post('/ses_b/jobs', GENERATE)]);
  assert.deepEqual(raced.map((r) => r.status).sort(), [202, 429], 'en el tope cabe uno solo');
  assert.equal(b.external().length, 1, 'el que no cabe no llega al proveedor');
  assert.equal(b.bucket.json(`${prefix}_usage/2026-11.json`).total_usd, 0.04);
  assert.equal(b.bucket.json('studio/_usage/2026-11.json').total_usd, 0.04, 'la reserva global del rechazado se revierte');
  assert.equal([...b.bucket.objects.keys()].filter((k) => k.includes('/jobs/')).length, 1);
});

test('costo de master y separate: se cobra la duracion real del audio, no la declarada', async () => {
  const { post, bucket } = setup({ MUSICAI_API_KEY: 'k' });
  const seconds = 1200;
  const dataBytes = seconds * 96000; // 48 kHz, mono, 16 bits
  const header = wavHeader(48000, 1, 16, dataBytes);
  bucket.seed(`${prefix}ses_a/assets/ast_song.wav`, 44 + dataBytes, header);
  const lie = { kind: 'separate', asset_id: 'ast_song', duration_s: 0.001 };
  const estimate = await (await post('/ses_a/jobs?estimate=1', lie)).json();
  assert.equal(estimate.estimated_cost_usd, 10, '20 minutos reales a USD 0,50, aunque declare un milisegundo');
  assert.equal((await post('/ses_a/jobs', lie)).status, 202);
  const entry = bucket.json(`${prefix}_usage/2026-11.json`).entries[0];
  assert.deepEqual([entry.seconds, entry.cost_usd], [1200, 10]);

  assert.equal(audioSecondsFloor(header, 44 + dataBytes, 'wav'), 1200);
  // Un WAV escrito en vivo declara 0 bytes de datos: vale lo que queda del archivo.
  assert.equal(audioSecondsFloor(wavHeader(48000, 1, 16, 0), 44 + 96000, 'wav'), 1);
  // FLAC: STREAMINFO con 44100 Hz, estereo, 16 bits y 2 646 000 muestras (60 s).
  const flac = new Uint8Array(42);
  flac.set(new TextEncoder().encode('fLaC'), 0);
  flac.set([0x00, 0x00, 0x00, 0x22], 4);
  flac.set([0x0a, 0xc4, 0x42, 0xf0, 0x00, 0x28, 0x5f, 0xf0], 18);
  assert.equal(audioSecondsFloor(flac, 5_000_000, 'flac'), 60);
  // MP3 y cabeceras que no se entienden: piso por la tasa mas alta del formato.
  assert.equal(audioSecondsFloor(MP3_BYTES, 4_000_000, 'mp3'), 100);
  assert.equal(audioSecondsFloor(new Uint8Array(0), 1_536_000, 'wav'), 1);
  // Declarar de mas no baja el costo: gana la mayor.
  bucket.seed(`${prefix}ses_a/assets/ast_corto.wav`, 44 + 96000, wavHeader(48000, 1, 16, 96000));
  assert.equal((await (await post('/ses_a/jobs?estimate=1', { kind: 'separate', asset_id: 'ast_corto', duration_s: 120 })).json()).estimated_cost_usd, 1);
});

test('sondeo: dos GET simultaneos no duplican audios; un fallo al consultar no es un fallo del trabajo', async () => {
  const { call, post, bucket, world } = setup({ MUSICAI_API_KEY: 'k' });
  await call('PUT', '/ses_a/assets/ast_song.mp3', { token: OWNER, body: audio, type: 'audio/mpeg' });
  const job = (await (await post('/ses_a/jobs', { kind: 'separate', asset_id: 'ast_song', duration_s: 120 })).json()).job_id as string;
  const poll = async () => {
    const r = await call('GET', `/ses_a/jobs/${job}`, { token: MUSICIAN });
    return [r.status, await r.json()] as [number, Record<string, unknown>];
  };
  const startedBody = { job_id: job, kind: 'separate', status: 'STARTED' };

  // Music AI no responde bien al sondeo: el trabajo (ya pagado) sigue en curso, no falla.
  world.extra = (c) => (c.url.endsWith('/job/mai-1') ? new Response('caido', { status: 503 }) : undefined);
  assert.deepEqual(await poll(), [200, startedBody]);
  world.extra = (c) => {
    if (c.url.endsWith('/job/mai-1')) throw new Error('sin red');
    return undefined;
  };
  assert.deepEqual(await poll(), [200, startedBody]);
  world.extra = undefined;

  world.musicAiJob = { status: 'SUCCEEDED', result: { Vocals: 'https://out.test/v.wav', Drums: 'https://out.test/d' } };
  world.downloads['https://out.test/v.wav'] = { bytes: WAV_BYTES, type: 'audio/wav' };
  world.downloads['https://out.test/d'] = { bytes: MP3_BYTES, type: 'audio/mpeg' };
  const pair = await Promise.all([poll(), poll()]);
  assert.deepEqual(pair.map(([status]) => status), [200, 200]);
  let last = pair[0][1];
  for (let i = 0; i < 6 && last.status !== 'SUCCEEDED'; i++) last = (await poll())[1];
  assert.equal(last.status, 'SUCCEEDED');
  const stored = [...bucket.objects.keys()].filter((k) => k.startsWith(`${prefix}ses_a/assets/ast_t`));
  assert.equal(stored.length, 2, 'un solo juego de ids: sin audios huerfanos');
  for (const a of last.assets as { file: string }[]) assert.ok(stored.includes(`${prefix}ses_a/assets/${a.file}`));

  // Solo un 404 del proveedor es definitivo.
  const gone = (await (await post('/ses_a/jobs', { kind: 'separate', asset_id: 'ast_song', duration_s: 120 })).json()).job_id as string;
  world.extra = (c) => (c.url.endsWith('/job/mai-1') ? new Response('{}', { status: 404 }) : undefined);
  const failed = await (await call('GET', `/ses_a/jobs/${gone}`, { token: MUSICIAN })).json();
  assert.equal(failed.status, 'FAILED');
  assert.match(failed.error, /ya no tiene este trabajo/);
});

test('master: solo una salida de audio reconocible; un informe o un JSON nunca quedan como master', async () => {
  const { call, post, bucket, calls, world } = setup({ MUSICAI_API_KEY: 'k', MUSICAI_MASTER_WORKFLOW: 'm' });
  await call('PUT', '/ses_a/assets/ast_mix.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  const run = async (result: Record<string, unknown>) => {
    const job = (await (await post('/ses_a/jobs', MASTER)).json()).job_id as string;
    world.musicAiJob = { status: 'SUCCEEDED', result };
    return (await call('GET', `/ses_a/jobs/${job}`, { token: OWNER })).json();
  };
  world.downloads['https://out.test/out.wav'] = { bytes: WAV_BYTES, type: 'audio/wav' };
  world.downloads['https://out.test/report.json'] = { bytes: new TextEncoder().encode('{"lufs":-14}'), type: 'application/json' };
  world.downloads['https://out.test/raro'] = { bytes: new TextEncoder().encode('{"lufs":-14} y mas texto'), type: 'application/octet-stream' };
  world.downloads['https://out.test/b.wav'] = { bytes: WAV_BYTES, type: 'audio/wav' };

  // El informe va primero en el resultado: no se toma "la primera URL".
  const ok = await run({ Report: 'https://out.test/report.json', Output: 'https://out.test/out.wav' });
  assert.equal(ok.status, 'SUCCEEDED');
  assert.match(ok.assets[0].file, /\.wav$/);
  assert.ok(!calls.some((c) => c.url === 'https://out.test/report.json'), 'el informe ni se descarga');

  const before = [...bucket.objects.keys()].filter((k) => k.includes('/assets/')).length;
  const notAudio = await run({ Output: 'https://out.test/raro' });
  assert.equal(notAudio.status, 'FAILED');
  assert.match(notAudio.error, /no es audio/);
  assert.equal([...bucket.objects.keys()].filter((k) => k.includes('/assets/')).length, before, 'un JSON no queda guardado como audio');

  const ambiguous = await run({ A: 'https://out.test/out.wav', B: 'https://out.test/b.wav' });
  assert.equal(ambiguous.status, 'FAILED');
  assert.match(ambiguous.error, /varias salidas/);
  const named = await run({ A: 'https://out.test/out.wav', 'Master Output': 'https://out.test/b.wav' });
  assert.equal(named.status, 'SUCCEEDED', 'con varias, vale la unica que se llama master');

  assert.equal(detectAudioExt(new TextEncoder().encode('{"a":1}')), null);
  assert.equal(detectAudioExt(new TextEncoder().encode('OggS....')), null);
  assert.equal(detectAudioExt(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), 'mp3');
  assert.equal(detectAudioExt(new TextEncoder().encode('RIFF....AVI ')), null);
});

test('trabajo sincrono: se reserva antes de pagar, job_id es idempotente y un registro interrumpido caduca', async () => {
  const { call, post, bucket, external, clock, world, waited } = setup({ URIT_AI_TOKEN: 'g' });
  const answer = world.lyria;
  let seen: unknown = null;
  world.lyria = () => {
    // Mientras Lyria responde ya existen el registro y el gasto: si la peticion muere aqui, queda rastro.
    seen = { job: bucket.json(`${prefix}ses_a/jobs/job_mio.json`).status, spent: bucket.json(`${prefix}_usage/2026-11.json`).total_usd };
    return answer();
  };
  const first = await post('/ses_a/jobs?job_id=job_mio', GENERATE);
  assert.deepEqual([first.status, await first.json()], [202, { job_id: 'job_mio', status: 'STARTED', kind: 'generate' }]);
  assert.deepEqual(seen, { job: 'STARTED', spent: 0.04 });
  assert.equal(waited.length, 2, 'la llamada al proveedor y el evento del trabajo van a waitUntil');

  // El cliente perdio la respuesta y repite con el mismo id: no se genera ni se cobra otra vez.
  const again = await post('/ses_a/jobs?job_id=job_mio', GENERATE);
  assert.deepEqual([again.status, await again.json()], [202, { job_id: 'job_mio', status: 'STARTED', kind: 'generate' }]);
  assert.equal(external().length, 1);
  assert.equal(bucket.json(`${prefix}_usage/2026-11.json`).total_usd, 0.04);
  assert.equal((await (await call('GET', '/ses_a/jobs/job_mio', { token: MUSICIAN })).json()).status, 'SUCCEEDED');
  assert.equal((await post('/ses_a/jobs?job_id=otro', GENERATE)).status, 400, 'el id del cliente empieza por job_');
  assert.equal((await post('/ses_a/jobs?job_id=job_a.b', GENERATE)).status, 400);

  // Un POST que se corto a mitad: el registro queda en STARTED sin id del proveedor.
  bucket.write(`${prefix}ses_a/jobs/job_roto.json`, JSON.stringify({
    job_id: 'job_roto', kind: 'generate', provider: 'lyria', status: 'STARTED', created_at: '2026-11-19T15:00:00.000Z', user: USER, cost_usd: 0.06,
  }));
  assert.equal((await (await call('GET', '/ses_a/jobs/job_roto', { token: MUSICIAN })).json()).status, 'STARTED', 'dentro del margen sigue en curso');
  clock.now = new Date('2026-11-19T15:11:00.000Z');
  const expired = await (await call('GET', '/ses_a/jobs/job_roto', { token: MUSICIAN })).json();
  assert.equal(expired.status, 'FAILED');
  assert.match(expired.error, /incompleto/);
});

test('quien puede gastar: tope global del Worker y lista de usuarios', async () => {
  const g = setup({ URIT_AI_TOKEN: 'g', STUDIO_GLOBAL_MONTHLY_BUDGET_USD: '0.04' });
  assert.equal((await g.post('/ses_a/jobs', GENERATE)).status, 202);
  const estimate = await (await g.post('/ses_a/jobs?estimate=1', GENERATE)).json();
  assert.deepEqual([estimate.allowed, estimate.spent_usd, estimate.budget_usd], [false, 0.04, null], 'la banda no tiene tope, el Worker si');
  const over = await g.post('/ses_b/jobs', GENERATE);
  assert.deepEqual([over.status, (await over.json()).error], [429, 'quota_exceeded']);
  assert.equal(g.external().length, 1);
  assert.equal(g.bucket.json(`${prefix}_usage/2026-11.json`).total_usd, 0.04);
  assert.equal([...g.bucket.objects.keys()].filter((k) => k.includes('/jobs/')).length, 1, 'el rechazado no deja registro');

  const s = setup({ URIT_AI_TOKEN: 'g', STUDIO_SPENDER_UIDS: 'ffffffff-0000-4000-8000-000000000000' });
  const denied = await s.post('/ses_a/jobs', GENERATE);
  assert.deepEqual([denied.status, (await denied.json()).error], [403, 'not_a_spender']);
  assert.equal((await s.post('/ses_a/jobs?estimate=1', GENERATE)).status, 403);
  assert.equal(s.external().length, 0);
  const ok = setup({ URIT_AI_TOKEN: 'g', STUDIO_SPENDER_UIDS: ` ${USER} , ffffffff-0000-4000-8000-000000000000` });
  assert.equal((await ok.post('/ses_a/jobs', GENERATE)).status, 202);
});

test('limites: documento normalizado, cuerpo sin Content-Length, audios por sesion y lista truncada', async () => {
  const { call, bucket } = setup();
  const size = (text: string) => new TextEncoder().encode(text).byteLength;
  // Un documento cuyo cuerpo cabe pero que, con updated_at y updated_by del Worker, ya no. Con el
  // tope de 1 MiB (STUDIO_V2.md 2.5) hace falta un v2: 16384 notas mas audios con prompts largos.
  const notes = Array.from({ length: 4096 }, (_, i) => ({ pitch: 36 + (i % 48), start: Math.floor(i / 48) * 0.25, length: 0.25, velocity: 100 }));
  const make = (lens: number[]) => JSON.stringify(validateSession(emptySession('ses_big', {
    version: 2,
    assets: lens.map((n, i) => ({ ...FIXTURE.assets[3], id: `ast_g${i}`, file: `ast_g${i}.mp3`, source: { ...FIXTURE.assets[3].source, prompt: 'x'.repeat(n) } })),
    tracks: [{
      id: 'trk_i', kind: 'instrument', name: 'Notas', role: 'keys', volume_db: 0, pan: 0, mute: false, solo: false, reverb_send_db: -60, fx: [],
      instrument: { type: 'synth', preset: null, params: {} },
      midi_clips: [0, 1, 2, 3].map((k) => ({ id: `mid_${k}`, start_beat: k * 32, length_beats: 32, loop: false, loop_beats: 32, notes })),
      frozen_asset_id: null,
    }],
    markers: [],
  })));
  const sized = (target: number) => {
    let need = target - size(make(Array(240).fill(1)));
    return make(Array.from({ length: 240 }, () => {
      const add = Math.max(0, Math.min(999, need));
      need -= add;
      return 1 + add;
    }));
  };
  const edge = sized(SESSION_MAX_BYTES - 5);
  assert.equal(size(edge), SESSION_MAX_BYTES - 5);
  const tooBig = await call('PUT', '/ses_big/session', { token: OWNER, body: edge, headers: CREATE });
  assert.deepEqual([tooBig.status, (await tooBig.json()).error], [413, 'session_too_large'], 'el limite es sobre lo que se guarda');
  const fits = await call('PUT', '/ses_big/session', { token: OWNER, body: sized(SESSION_MAX_BYTES - 200), headers: CREATE });
  assert.deepEqual([fits.status, (await fits.json()).error], [409, 'missing_asset'], 'con margen pasa el limite y sigue la validacion');

  // Sin Content-Length el cuerpo se corta al pasar el limite, no despues de leerlo entero.
  const chunked = await call('PUT', '/ses_a/session', { token: OWNER, body: 'x'.repeat(1100 * 1024), headers: CREATE, length: null });
  assert.deepEqual([chunked.status, (await chunked.json()).error], [413, 'session_too_large']);
  const bigJob = await call('POST', '/ses_a/jobs', { token: OWNER, body: 'x'.repeat(70 * 1024), length: null });
  assert.deepEqual([bigJob.status, (await bigJob.json()).error], [400, 'bad_job']);

  for (let i = 0; i < 320; i++) bucket.seed(`${prefix}ses_a/assets/ast_n${i}.wav`, 5);
  const full = await call('PUT', '/ses_a/assets/ast_nuevo.wav', { token: OWNER, body: audio, type: 'audio/wav' });
  assert.deepEqual([full.status, (await full.json()).error], [409, 'too_many_assets']);

  const many = setup();
  for (let i = 0; i < 501; i++) many.bucket.write(`${prefix}s${i}/session.json`, JSON.stringify(emptySession(`s${i}`)));
  const list = await (await many.call('GET', '', { token: MUSICIAN })).json();
  assert.equal(list.truncated, true, 'la respuesta avisa que no estan todas');
  assert.equal(list.sessions.length, 500);
});
