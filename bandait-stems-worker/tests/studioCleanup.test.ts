// Limpieza de audios huerfanos del Estudio (src/studioCleanup.ts y GET/POST .../studio/_cleanup),
// con R2 y Supabase simulados. Ninguna prueba sale a la red ni toca datos reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, scheduled } from '../src/index.ts';
import { EVENTS_PREFIX, OpBudget } from '../src/events.ts';
import {
  CLEANUP_CURSOR_KEY, ORPHAN_MIN_AGE_MS, cleanupScope, opportunisticCleanup, referencedAssets, sweepOrphans,
} from '../src/studioCleanup.ts';
import type { Env, R2Body, R2Conditional, R2GetOptions, R2Object, R2ObjectBody, R2PutOptions } from '../src/types.ts';

const BAND = '11111111-2222-4333-8444-555555555555';
const BAND_2 = '22222222-2222-4333-8444-555555555555';
const BAND_3 = '33333333-2222-4333-8444-555555555555';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - 3 * 3600_000);
const RECENT = new Date(NOW.getTime() - 3600_000);
const P = `bands/${BAND}/studio/`;

const b64url = (text: string) => Buffer.from(text).toString('base64url');
const jwt = (role: string) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: USER, role }))}.firma-${role}`;
const OWNER = jwt('owner');
const DIRECTOR = jwt('director');
const MUSICIAN = jwt('musician');
const STRANGER = jwt('stranger');
const ROLES_BY_TOKEN: Record<string, string | null> = { [OWNER]: 'Owner', [DIRECTOR]: 'MusicDirector', [MUSICIAN]: 'Musician', [STRANGER]: null };

type Stored = { bytes: Uint8Array; version: number; custom?: Record<string, string>; uploaded: Date };

/** R2 simulado: fechas de subida, customMetadata con `include`, paginas con `limit`, `startAfter` y fallos a pedido. */
class FakeR2 {
  objects = new Map<string, Stored>();
  versions = 0;
  ops = 0;
  clock: () => Date = () => NOW;
  /** Claves cuyo get lanza (lectura fallida de R2). */
  failGet = new Set<string>();
  /** Gancho antes de cada head: lo que escriba aqui es "otra peticion que gano la carrera". */
  beforeHead?: (key: string) => void;
  deletes: string[][] = [];

  write(key: string, value: unknown, options: { uploaded?: Date; custom?: Record<string, string> } = {}) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.objects.set(key, { bytes: new TextEncoder().encode(text), version: ++this.versions, custom: options.custom, uploaded: options.uploaded ?? this.clock() });
  }

  /** Audio de `size` bytes subido en `uploaded`. */
  audio(key: string, size: number, uploaded: Date) {
    this.objects.set(key, { bytes: new Uint8Array(size), version: ++this.versions, uploaded });
  }

  describe(key: string, withCustom = true): R2Object {
    const o = this.objects.get(key)!;
    return {
      key, size: o.bytes.byteLength, etag: `v${o.version}`, httpEtag: `"v${o.version}"`, uploaded: o.uploaded,
      ...(withCustom && o.custom ? { customMetadata: o.custom } : {}),
    };
  }

  async head(key: string) {
    this.ops++;
    this.beforeHead?.(key);
    return this.objects.has(key) ? this.describe(key) : null;
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    this.ops++;
    if (this.failGet.has(key)) throw new Error('R2 no responde');
    if (!this.objects.has(key)) return null;
    let bytes = this.objects.get(key)!.bytes;
    if (options?.range) bytes = bytes.subarray(options.range.offset, options.range.offset + options.range.length);
    return { ...this.describe(key), body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes) };
  }

  async put(key: string, value: R2Body, options?: R2PutOptions) {
    this.ops++;
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
    this.objects.set(key, { bytes, version: ++this.versions, custom: options?.customMetadata, uploaded: this.clock() });
    return this.describe(key);
  }

  async delete(keys: string | string[]) {
    this.ops++;
    const list = Array.isArray(keys) ? keys : [keys];
    this.deletes.push(list);
    for (const k of list) this.objects.delete(k);
  }

  async list(options?: { prefix?: string; delimiter?: string; limit?: number; cursor?: string; startAfter?: string; include?: string[] }) {
    this.ops++;
    const prefix = options?.prefix || '';
    const withCustom = options?.include?.includes('customMetadata') ?? false;
    let keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    const after = options?.cursor ?? options?.startAfter;
    if (after) keys = keys.filter((k) => k > after);
    const limit = options?.limit ?? 1000;
    if (!options?.delimiter) {
      const page = keys.slice(0, limit);
      const truncated = keys.length > limit;
      return { objects: page.map((k) => this.describe(k, withCustom)), truncated, cursor: truncated ? page.at(-1) : undefined };
    }
    const folders: string[] = [];
    const direct: string[] = [];
    let last: string | undefined;
    let truncated = false;
    for (const k of keys) {
      const cut = k.indexOf(options.delimiter, prefix.length);
      const folder = cut < 0 ? null : k.slice(0, cut + 1);
      if (folder && folders.includes(folder)) {
        last = k;
        continue;
      }
      if (folders.length + direct.length >= limit) {
        truncated = true;
        break;
      }
      if (folder) folders.push(folder);
      else direct.push(k);
      last = k;
    }
    return { objects: direct.map((k) => this.describe(k, withCustom)), truncated, cursor: truncated ? last : undefined, delimitedPrefixes: folders };
  }

  has(key: string) {
    return this.objects.has(key);
  }

  json(key: string) {
    return JSON.parse(new TextDecoder().decode(this.objects.get(key)!.bytes));
  }

  events() {
    return [...this.objects.keys()].filter((k) => k.startsWith(EVENTS_PREFIX)).sort().map((k) => this.json(k));
  }
}

function setup() {
  const bucket = new FakeR2();
  const clock = { now: NOW };
  bucket.clock = () => clock.now;
  const env: Env = { STEMS: bucket, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', ALLOWED_ORIGINS: 'https://bandait.releven.cc' };
  const waited: Promise<unknown>[] = [];
  let ids = 0;
  const deps = { now: () => clock.now, newId: (prefix: string) => `${prefix}_t${++ids}`, waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const token = (new Headers(init?.headers).get('Authorization') || '').replace('Bearer ', '');
    if (!(token in ROLES_BY_TOKEN)) return new Response('{}', { status: 401 });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: USER });
    if (url.endsWith('/rest/v1/rpc/bandait_band_role')) return Response.json(ROLES_BY_TOKEN[token]);
    throw new Error(`llamada inesperada: ${url}`);
  };
  const call = (method: string, path: string, token: string | null = OWNER, opts: { body?: string; headers?: Record<string, string>; band?: string } = {}) => {
    const headers = new Headers(opts.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (opts.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      headers.set('Content-Length', String(new TextEncoder().encode(opts.body).byteLength));
    }
    return handle(new Request(`https://stems.test/v1/bands/${opts.band ?? BAND}/studio${path}`, { method, headers, body: opts.body }), env, fetchFn, deps);
  };
  const flush = async () => {
    while (waited.length) await Promise.all(waited.splice(0));
  };
  return { bucket, env, deps, clock, call, flush, waited };
}

const asset = (id: string, size: number) => ({
  id, file: `${id}.wav`, kind: 'recording', label: '', channels: 2, sample_rate: 48000, duration_s: 10, size, source: null,
});

/** Documento v2 valido: un clip, una zona de sampler y un congelado, cada uno con su audio. */
function doc(id: string, assets: { id: string; size: number }[] = [{ id: 'ast_ref', size: 100 }, { id: 'ast_zone', size: 50 }, { id: 'ast_frozen', size: 70 }]) {
  const has = (x: string) => assets.some((a) => a.id === x);
  return {
    version: 2, id, title: 'Maqueta', song_id: null, bpm: 120, beats_per_bar: 4, key: null, sample_rate: 48000, latency_offset_ms: 0,
    updated_at: '2026-11-20T10:00:00.000Z', updated_by: null,
    assets: assets.map((a) => asset(a.id, a.size)),
    tracks: [
      ...(has('ast_ref') ? [{
        id: 'trk_1', kind: 'audio', name: 'Voz', role: 'vocals', volume_db: 0, pan: 0, mute: false, solo: false, reverb_send_db: -60, fx: [],
        clips: [{ id: 'clp_1', asset_id: 'ast_ref', start_s: 0, offset_s: 0, length_s: 5, gain_db: 0, fade_in_s: 0, fade_out_s: 0, take_group: null, active: true }],
      }] : []),
      ...(has('ast_zone') && has('ast_frozen') ? [{
        id: 'trk_2', kind: 'instrument', name: 'Sampler', role: 'keys', volume_db: 0, pan: 0, mute: false, solo: false, reverb_send_db: -60, fx: [],
        instrument: {
          type: 'sampler', params: {},
          zones: [{ asset_id: 'ast_zone', root_pitch: 60, low_pitch: 0, high_pitch: 127, low_velocity: 1, high_velocity: 127, offset_s: 0, length_s: 1, gain_db: 0, tune_cents: 0 }],
        },
        midi_clips: [], frozen_asset_id: 'ast_frozen',
      }] : []),
    ],
    markers: [], master: { volume_db: 0, fx: [], reverb: { decay_s: 1.8, return_db: 0 } },
  };
}

/** Sesion guardada con sus tres audios referenciados (viejos) mas los huerfanos que se pidan. */
function seedSession(bucket: FakeR2, prefix: string, id: string, orphans: Record<string, Date> = {}) {
  bucket.write(`${prefix}${id}/session.json`, doc(id), { uploaded: OLD });
  bucket.audio(`${prefix}${id}/assets/ast_ref.wav`, 100, OLD);
  bucket.audio(`${prefix}${id}/assets/ast_zone.wav`, 50, OLD);
  bucket.audio(`${prefix}${id}/assets/ast_frozen.wav`, 70, OLD);
  for (const [name, at] of Object.entries(orphans)) bucket.audio(`${prefix}${id}/assets/${name}`, 1000, at);
}

// --------------------------------------------------------------------------- reglas

test('referenciado no se borra; huerfano viejo si; huerfano reciente no; GET inspecciona sin borrar', async () => {
  const { bucket, call, flush } = setup();
  seedSession(bucket, P, 'ses_a', { 'ast_old.wav': OLD, 'ast_new.mp3': RECENT });
  // Carpeta sin documento (sesion a medio crear): sus audios viejos son huerfanos.
  bucket.audio(`${P}ses_nodoc/assets/ast_lost.flac`, 500, OLD);
  // Lo de studio/_usage y _cleanup no es una sesion.
  bucket.write(`${P}_usage/2026-11.json`, { month: '2026-11', total_usd: 0, entries: [] }, { uploaded: OLD });
  // Otra banda no se toca.
  seedSession(bucket, `bands/${BAND_2}/studio/`, 'ses_x', { 'ast_other.wav': OLD });

  const inspect = await call('GET', '/_cleanup', MUSICIAN);
  assert.equal(inspect.status, 200);
  const seen = await inspect.json();
  assert.deepEqual(
    [seen.orphans, seen.bytes, seen.sessions, seen.protected_sessions, seen.complete, seen.blocked, seen.deleted],
    [2, 1500, 2, 0, true, null, 0],
  );
  assert.deepEqual(seen.sample.sort(), ['ses_a/ast_old.wav', 'ses_nodoc/ast_lost.flac']);
  assert.ok(bucket.has(`${P}ses_a/assets/ast_old.wav`), 'GET no borra');

  const res = await call('POST', '/_cleanup', DIRECTOR);
  assert.equal(res.status, 200);
  const done = await res.json();
  assert.deepEqual([done.deleted, done.deleted_bytes, done.complete, done.blocked], [2, 1500, true, null]);
  for (const name of ['ast_ref.wav', 'ast_zone.wav', 'ast_frozen.wav', 'ast_new.mp3']) assert.ok(bucket.has(`${P}ses_a/assets/${name}`), `${name} se queda`);
  assert.ok(!bucket.has(`${P}ses_a/assets/ast_old.wav`));
  assert.ok(!bucket.has(`${P}ses_nodoc/assets/ast_lost.flac`));
  assert.ok(bucket.has(`${P}ses_a/session.json`) && bucket.has(`${P}_usage/2026-11.json`));
  assert.ok(bucket.has(`bands/${BAND_2}/studio/ses_x/assets/ast_other.wav`), 'otra banda no se toca');

  await flush();
  const events = bucket.events();
  assert.equal(events.length, 1, 'un evento por limpieza');
  assert.deepEqual(
    [events[0].kind, events[0].provider, events[0].status, events[0].band, events[0].objects, events[0].bytes, events[0].trigger, events[0].session],
    ['cleanup', 'r2', 'SUCCEEDED', `bands/${BAND}`, 2, 1500, 'manual', null],
  );
  assert.ok(!JSON.stringify(events[0]).includes('ast_'), 'el evento no lleva ids de audios');

  // Una segunda limpieza no encuentra nada y no anota evento.
  const again = await (await call('POST', '/_cleanup')).json();
  assert.deepEqual([again.orphans, again.deleted], [0, 0]);
  await flush();
  assert.equal(bucket.events().length, 1);
});

test('referencedAssets: assets por file o id, clips, zonas y congelados; forma minima obligatoria', () => {
  const refs = referencedAssets(doc('ses_a'));
  assert.deepEqual([...refs.files].sort(), ['ast_frozen.wav', 'ast_ref.wav', 'ast_zone.wav']);
  assert.ok(refs.ids.has('ast_ref') && refs.ids.has('ast_zone') && refs.ids.has('ast_frozen'));
  // Un id nombrado solo por un clip tambien protege (documento viejo o a medio validar).
  const loose = referencedAssets({ assets: [], tracks: [{ clips: [{ asset_id: 'ast_suelto' }] }] });
  assert.ok(loose.ids.has('ast_suelto'));
  for (const bad of [null, [], 'x', { assets: [] }, { tracks: [] }, { assets: {}, tracks: [] }]) {
    assert.throws(() => referencedAssets(bad), undefined, JSON.stringify(bad));
  }
});

test('un trabajo en curso protege su sesion; uno terminado no; un registro viejo sin customMetadata se lee', async () => {
  const { bucket, call } = setup();
  // ses_busy: trabajo STARTED (con customMetadata, como lo escribe el Worker 1.4.0).
  seedSession(bucket, P, 'ses_busy', { 'ast_listen.wav': OLD });
  bucket.write(`${P}ses_busy/jobs/job_1.json`, { job_id: 'job_1', status: 'STARTED' }, { custom: { status: 'STARTED' }, uploaded: OLD });
  // ses_legacy: registro anterior a 1.4.0, sin customMetadata, que sigue en curso.
  seedSession(bucket, P, 'ses_legacy', { 'ast_out.wav': OLD });
  bucket.write(`${P}ses_legacy/jobs/job_2.json`, { job_id: 'job_2', status: 'STARTED' }, { uploaded: OLD });
  // ses_broken: registro ilegible: protege.
  seedSession(bucket, P, 'ses_broken', { 'ast_b.wav': OLD });
  bucket.write(`${P}ses_broken/jobs/job_3.json`, 'no es json', { uploaded: OLD });
  // ses_done: trabajos terminados (uno con metadata, uno viejo sin ella): no protegen.
  seedSession(bucket, P, 'ses_done', { 'ast_done.wav': OLD });
  bucket.write(`${P}ses_done/jobs/job_4.json`, { job_id: 'job_4', status: 'SUCCEEDED' }, { custom: { status: 'SUCCEEDED' }, uploaded: OLD });
  bucket.write(`${P}ses_done/jobs/job_5.json`, { job_id: 'job_5', status: 'FAILED' }, { uploaded: OLD });

  const before = bucket.ops;
  const res = await (await call('POST', '/_cleanup')).json();
  assert.deepEqual([res.sessions, res.protected_sessions, res.orphans, res.deleted], [4, 3, 1, 1]);
  assert.ok(bucket.has(`${P}ses_busy/assets/ast_listen.wav`), 'el fragmento de un chat en curso se queda');
  assert.ok(bucket.has(`${P}ses_legacy/assets/ast_out.wav`));
  assert.ok(bucket.has(`${P}ses_broken/assets/ast_b.wav`));
  assert.ok(!bucket.has(`${P}ses_done/assets/ast_done.wav`));
  assert.ok(bucket.ops - before < 40, `operaciones: ${bucket.ops - before}`);
});

test('un error al leer una sesion no borra nada de la banda (JSON roto o R2 que falla)', async () => {
  const { bucket, call, flush } = setup();
  seedSession(bucket, P, 'ses_a', { 'ast_old.wav': OLD });
  bucket.write(`${P}ses_bad/session.json`, '{ no es json', { uploaded: OLD });
  bucket.audio(`${P}ses_bad/assets/ast_bad.wav`, 10, OLD);

  const res = await (await call('POST', '/_cleanup')).json();
  assert.deepEqual([res.deleted, res.complete, res.blocked], [0, false, 'session_unreadable']);
  assert.ok(bucket.has(`${P}ses_a/assets/ast_old.wav`), 'ni siquiera lo de las sesiones sanas');
  assert.ok(bucket.has(`${P}ses_bad/assets/ast_bad.wav`));
  await flush();
  const events = bucket.events();
  assert.deepEqual([events.length, events[0].status, events[0].provider_code, events[0].objects], [1, 'FAILED', 'session_unreadable', 0]);

  // Documento sin la forma minima (assets que no es lista): tambien bloquea.
  bucket.write(`${P}ses_bad/session.json`, { version: 2, assets: 'x', tracks: [] }, { uploaded: OLD });
  assert.equal((await (await call('POST', '/_cleanup')).json()).blocked, 'session_unreadable');

  // R2 que lanza al leer el documento.
  bucket.write(`${P}ses_bad/session.json`, doc('ses_bad', []), { uploaded: OLD });
  bucket.failGet.add(`${P}ses_bad/session.json`);
  const failing = await (await call('POST', '/_cleanup')).json();
  assert.deepEqual([failing.deleted, failing.blocked], [0, 'session_unreadable']);
  assert.ok(bucket.has(`${P}ses_a/assets/ast_old.wav`));

  // Arreglada la lectura, la limpieza sigue.
  bucket.failGet.clear();
  const ok = await (await call('POST', '/_cleanup')).json();
  assert.deepEqual([ok.deleted, ok.blocked], [2, null]);
});

test('si alguien guarda la sesion entre la lectura y el borrado, esa sesion se salta', async () => {
  const { bucket, call } = setup();
  seedSession(bucket, P, 'ses_a', { 'ast_old.wav': OLD });
  seedSession(bucket, P, 'ses_b', { 'ast_b.wav': OLD });
  bucket.beforeHead = (key) => {
    if (key === `${P}ses_a/session.json`) {
      bucket.beforeHead = undefined;
      // Otra peticion guarda ses_a y vuelve a usar ast_old.
      bucket.write(key, doc('ses_a', [{ id: 'ast_ref', size: 100 }, { id: 'ast_zone', size: 50 }, { id: 'ast_frozen', size: 70 }, { id: 'ast_old', size: 1000 }]));
    }
  };
  const res = await (await call('POST', '/_cleanup')).json();
  assert.deepEqual([res.orphans, res.deleted], [2, 1]);
  assert.ok(bucket.has(`${P}ses_a/assets/ast_old.wav`));
  assert.ok(!bucket.has(`${P}ses_b/assets/ast_b.wav`));
});

test('permisos: POST solo Owner o MusicDirector; GET cualquier integrante; workspace personal', async () => {
  const { bucket, call } = setup();
  seedSession(bucket, P, 'ses_a', { 'ast_old.wav': OLD });
  const status = async (method: string, token: string | null) => {
    const res = await call(method, '/_cleanup', token);
    return [res.status, (await res.json()).error ?? null];
  };
  assert.deepEqual(await status('POST', MUSICIAN), [403, 'not_an_editor']);
  assert.deepEqual(await status('POST', STRANGER), [403, 'not_a_member']);
  assert.deepEqual(await status('GET', STRANGER), [403, 'not_a_member']);
  assert.deepEqual(await status('POST', null), [401, 'missing_token']);
  assert.deepEqual(await status('DELETE', OWNER), [405, 'method_not_allowed']);
  assert.ok(bucket.has(`${P}ses_a/assets/ast_old.wav`), 'nada se borro sin permiso');
  assert.deepEqual(await status('GET', MUSICIAN), [200, null]);
  assert.deepEqual(await status('POST', OWNER), [200, null]);
  assert.ok(!bucket.has(`${P}ses_a/assets/ast_old.wav`));
  // `_cleanup` sigue sin ser un id de sesion valido para las otras rutas.
  assert.equal((await call('GET', '/_cleanup/session')).status, 400);

  // Workspace personal: `me` es users/<uuid>/ del que llama.
  const U = `users/${USER}/studio/`;
  seedSession(bucket, U, 'ses_me', { 'ast_mine.wav': OLD });
  const mine = await (await call('POST', '/_cleanup', MUSICIAN, { band: 'me' })).json();
  assert.equal(mine.deleted, 1);
  assert.ok(!bucket.has(`${U}ses_me/assets/ast_mine.wav`));
});

test('sin cupo para leer toda la banda no se borra nada (incomplete)', async () => {
  const { bucket, env, deps } = setup();
  for (let i = 0; i < 5; i++) seedSession(bucket, P, `ses_${i}`, { 'ast_old.wav': OLD });
  const small = await cleanupScope(env, deps, P, new OpBudget(8), { remove: true, trigger: 'manual' });
  assert.equal(small.status, 'budget');
  assert.equal(small.deleted, 0);
  assert.equal([...bucket.objects.keys()].filter((k) => k.endsWith('ast_old.wav')).length, 5);
  const enough = await cleanupScope(env, deps, P, new OpBudget(100), { remove: true, trigger: 'manual' });
  assert.deepEqual([enough.status, enough.deleted], ['done', 5]);
});

// --------------------------------------------------------------------------- cron

test('cron: tope de operaciones, cursor en R2 y continuacion al dia siguiente', async () => {
  const { bucket, env, deps } = setup();
  for (const band of [BAND, BAND_2, BAND_3]) seedSession(bucket, `bands/${band}/studio/`, 'ses_a', { 'ast_old.wav': OLD });
  seedSession(bucket, `users/${USER}/studio/`, 'ses_me', { 'ast_mine.wav': OLD });
  // Una carpeta de banda sin Estudio y una clave suelta no molestan.
  bucket.write(`bands/${BAND_2}/songs/s1/manifest.json`, { version: 1 }, { uploaded: OLD });
  const orphanKeys = () => [...bucket.objects.keys()].filter((k) => /ast_(old|mine)\.wav$/.test(k)).sort();

  // Cada banda con un huerfano cuesta 7 operaciones (lista de sesiones, documento, audios,
  // trabajos, head, borrado, evento). 14 alcanzan para la primera, no para la segunda.
  const first = await sweepOrphans(env, deps, 14);
  assert.equal(first.truncated, true);
  assert.equal(first.deleted, 1);
  assert.equal(first.cursor, `bands/${BAND}/`);
  assert.ok(first.ops <= 14, `operaciones: ${first.ops}`);
  assert.deepEqual(bucket.json(CLEANUP_CURSOR_KEY).after, `bands/${BAND}/`);
  assert.equal(orphanKeys().length, 3);

  const second = await sweepOrphans(env, deps, 14);
  assert.equal(second.cursor, `bands/${BAND_2}/`, 'sigue desde el cursor, sin repetir la primera banda');
  assert.equal(orphanKeys().length, 2);

  const third = await sweepOrphans(env, deps, 100);
  assert.deepEqual([third.truncated, third.cursor, third.deleted], [false, null, 2], 'termina la vuelta: banda 3 y el workspace personal');
  assert.equal(bucket.json(CLEANUP_CURSOR_KEY).after, null);
  assert.deepEqual(orphanKeys(), []);

  // La vuelta siguiente empieza de nuevo por el principio.
  bucket.audio(`bands/${BAND}/studio/ses_a/assets/ast_old.wav`, 1000, OLD);
  const fourth = await sweepOrphans(env, deps, 100);
  assert.deepEqual([fourth.deleted, fourth.scopes], [1, 4]);
});

test('cron: una banda que no cabe ni con el cupo entero se salta y queda anotada', async () => {
  const { bucket, env, deps } = setup();
  for (let i = 0; i < 6; i++) seedSession(bucket, `bands/${BAND}/studio/`, `ses_${i}`, { 'ast_old.wav': OLD });
  seedSession(bucket, `bands/${BAND_2}/studio/`, 'ses_a', { 'ast_old.wav': OLD });
  // 12 operaciones: la banda grande (6 sesiones, 3 lecturas cada una) no cabe; la chica (9 con el
  // evento, mas cursor y lista de bandas) si cabe en una corrida propia.
  const run = await sweepOrphans(env, deps, 12);
  assert.equal(run.blocked, 1);
  assert.equal(run.cursor, `bands/${BAND}/`, 'el cursor pasa la banda grande');
  assert.ok(run.ops <= 12, `operaciones: ${run.ops}`);
  const events = bucket.events();
  assert.deepEqual(events.map((e) => [e.status, e.provider_code, e.trigger]), [['FAILED', 'budget', 'cron']]);
  assert.equal([...bucket.objects.keys()].filter((k) => k.endsWith('ast_old.wav')).length, 7, 'no se borro nada de la banda grande');
  const next = await sweepOrphans(env, deps, 12);
  assert.equal(next.deleted, 1, 'la banda siguiente se limpia en la otra corrida');
  assert.ok(!bucket.has(`bands/${BAND_2}/studio/ses_a/assets/ast_old.wav`));
});

test('scheduled: borra eventos viejos y barre huerfanos en la misma corrida', async () => {
  const { bucket, env } = setup();
  seedSession(bucket, P, 'ses_a', { 'ast_old.wav': OLD, 'ast_new.wav': RECENT });
  bucket.write(`${EVENTS_PREFIX}2026-09-01/030000000-aaaaaaaa.json`, { at: '2026-09-01T03:00:00Z' });
  const waited: Promise<unknown>[] = [];
  await scheduled({ scheduledTime: NOW.getTime(), cron: '17 4 * * *' }, env, { waitUntil: (p) => { waited.push(p); } });
  await Promise.all(waited);
  assert.ok(!bucket.has(`${EVENTS_PREFIX}2026-09-01/030000000-aaaaaaaa.json`));
  assert.ok(!bucket.has(`${P}ses_a/assets/ast_old.wav`));
  assert.ok(bucket.has(`${P}ses_a/assets/ast_new.wav`));
  assert.equal(bucket.json(CLEANUP_CURSOR_KEY).after, null);
  const cleanup = bucket.events().filter((e) => e.kind === 'cleanup');
  assert.deepEqual(cleanup.map((e) => [e.trigger, e.objects]), [['cron', 1]]);
});

// --------------------------------------------------------------------------- tras guardar

test('tras guardar: limpia solo esa sesion, en waitUntil, como mucho una vez cada 2 h por banda', async () => {
  const { bucket, call, flush, clock, waited } = setup();
  seedSession(bucket, P, 'ses_a', { 'ast_old.wav': OLD, 'ast_new.wav': RECENT });
  // ses_a aun no tiene documento: el PUT de abajo la crea (If-None-Match: *).
  bucket.objects.delete(`${P}ses_a/session.json`);
  seedSession(bucket, P, 'ses_other', { 'ast_other.wav': OLD });

  const created = await call('PUT', '/ses_a/session', OWNER, { body: JSON.stringify(doc('ses_a')), headers: { 'If-None-Match': '*' } });
  assert.equal(created.status, 200);
  assert.equal(waited.length, 1, 'la limpieza va a waitUntil');
  assert.ok(bucket.has(`${P}ses_a/assets/ast_old.wav`), 'la respuesta no espera a la limpieza');
  await flush();
  assert.ok(!bucket.has(`${P}ses_a/assets/ast_old.wav`));
  assert.ok(bucket.has(`${P}ses_a/assets/ast_new.wav`), 'el reciente se queda');
  assert.ok(bucket.has(`${P}ses_other/assets/ast_other.wav`), 'solo la sesion guardada');
  assert.equal(bucket.json(`${P}_cleanup/last.json`).at, NOW.toISOString());
  const events = bucket.events();
  assert.deepEqual(events.map((e) => [e.trigger, e.objects, e.bytes]), [['save', 1, 1000]]);

  // Otro guardado antes de 2 h: no limpia aunque haya un huerfano viejo nuevo.
  bucket.audio(`${P}ses_a/assets/ast_old2.wav`, 1000, OLD);
  clock.now = new Date(NOW.getTime() + 3600_000);
  const etag = created.headers.get('ETag')!;
  const second = await call('PUT', '/ses_a/session', OWNER, { body: JSON.stringify(doc('ses_a')), headers: { 'If-Match': etag } });
  assert.equal(second.status, 200);
  await flush();
  assert.ok(bucket.has(`${P}ses_a/assets/ast_old2.wav`), 'menos de 2 h desde la ultima: no limpia');

  // Pasadas las 2 h, el siguiente guardado vuelve a limpiar.
  clock.now = new Date(NOW.getTime() + 2 * 3600_000 + 60_000);
  const third = await call('PUT', '/ses_a/session', OWNER, { body: JSON.stringify(doc('ses_a')), headers: { 'If-Match': second.headers.get('ETag')! } });
  assert.equal(third.status, 200);
  await flush();
  assert.ok(!bucket.has(`${P}ses_a/assets/ast_old2.wav`));
  // ast_new ya tiene mas de 2 h y no lo usa nadie: tambien se va.
  assert.ok(!bucket.has(`${P}ses_a/assets/ast_new.wav`));
});

test('tras guardar: dos guardados a la vez limpian una sola vez; un fallo no rompe nada', async () => {
  const { bucket, env, deps } = setup();
  seedSession(bucket, P, 'ses_a', { 'ast_old.wav': OLD });
  const [a, b] = await Promise.all([
    opportunisticCleanup(env, deps, P, 'ses_a'),
    opportunisticCleanup(env, deps, P, 'ses_a'),
  ]);
  assert.equal([a, b].filter((r) => r === 'skipped').length, 1, 'la marca condicional deja pasar a uno solo');
  assert.ok(!bucket.has(`${P}ses_a/assets/ast_old.wav`));

  // Sesion ilegible: no borra y no lanza.
  const later = { ...deps, now: () => new Date(NOW.getTime() + ORPHAN_MIN_AGE_MS + 3 * 3600_000) };
  bucket.audio(`${P}ses_a/assets/ast_x.wav`, 10, OLD);
  bucket.failGet.add(`${P}ses_a/session.json`);
  const failed = await opportunisticCleanup(env, later, P, 'ses_a');
  assert.ok(failed !== 'skipped' && failed.status === 'error');
  assert.ok(bucket.has(`${P}ses_a/assets/ast_x.wav`));
});
