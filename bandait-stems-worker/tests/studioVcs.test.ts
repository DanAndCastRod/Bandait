// Control de versiones del Estudio (STUDIO_V2.md 7.2): cabeza esperada, carreras sobre vcs.json,
// expulsion pasados 128 commits con periodo de gracia, tope de ramas, borrado de rama, autor
// verificado y limpieza conservadora. R2 y Supabase simulados; nada sale a la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.ts';
import { opportunisticCleanup } from '../src/studioCleanup.ts';
import { MAX_VCS_BRANCHES, MAX_VCS_COMMITS, RETIRED_GRACE_MS, VCS_BODY_LIMIT } from '../src/studioVcs.ts';
import type { Env, R2Body, R2Bucket, R2Conditional, R2GetOptions, R2Object, R2ObjectBody, R2PutOptions } from '../src/types.ts';

const BAND = '11111111-2222-4333-8444-555555555555';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const b64url = (text: string) => Buffer.from(text).toString('base64url');
const jwt = (tag: string, claims: Record<string, unknown> = {}) =>
  `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: USER, ...claims }))}.firma-${tag}`;
const OWNER = jwt('owner', { email: 'daniel@example.com', user_metadata: { full_name: 'Daniel Castaneda' } });
const MUSICIAN = jwt('musician', { email: 'guitarra@example.com' });
const ROLES_BY_TOKEN: Record<string, string> = { [OWNER]: 'Owner', [MUSICIAN]: 'Musician' };
const P = `bands/${BAND}/studio/`;

class FakeR2 implements R2Bucket {
  objects = new Map<string, { bytes: Uint8Array; version: number; size?: number; uploaded: Date }>();
  versions = 0;
  beforePut?: (key: string) => void;
  onHead?: (key: string) => void;
  seed(key: string, size: number, uploaded = new Date(0)) {
    this.objects.set(key, { bytes: new Uint8Array(0), version: ++this.versions, size, uploaded });
  }
  write(key: string, value: unknown) {
    this.objects.set(key, { bytes: new TextEncoder().encode(JSON.stringify(value)), version: ++this.versions, uploaded: new Date(0) });
  }
  describe(key: string): R2Object {
    const o = this.objects.get(key)!;
    return { key, size: o.size ?? o.bytes.byteLength, etag: `v${o.version}`, httpEtag: `"v${o.version}"`, uploaded: o.uploaded };
  }
  async head(key: string) {
    this.onHead?.(key);
    return this.objects.has(key) ? this.describe(key) : null;
  }
  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    if (!this.objects.has(key)) return null;
    let bytes = this.objects.get(key)!.bytes;
    if (options?.range) bytes = bytes.subarray(options.range.offset, options.range.offset + options.range.length);
    return { ...this.describe(key), body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes) };
  }
  async put(key: string, value: R2Body, options?: R2PutOptions) {
    this.beforePut?.(key);
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
    this.objects.set(key, { bytes, version: ++this.versions, uploaded: new Date('2026-11-19T15:00:00.000Z') });
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

function setup() {
  const bucket = new FakeR2();
  const env: Env = { STEMS: bucket, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', ALLOWED_ORIGINS: '' };
  const clock = { now: new Date('2026-11-19T15:00:00.000Z') };
  let ids = 0;
  const waited: Promise<unknown>[] = [];
  const deps = { now: () => clock.now, newId: (p: string) => `${p}_t${++ids}`, waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!url.startsWith('https://x.supabase.co/')) throw new Error(`llamada inesperada: ${url}`);
    const token = (headers.get('Authorization') || '').replace('Bearer ', '');
    if (!(token in ROLES_BY_TOKEN)) return new Response('{}', { status: 401 });
    return Response.json(ROLES_BY_TOKEN[token]);
  };
  const call = (method: string, path: string, opts: { token?: string; body?: string; headers?: Record<string, string>; length?: number } = {}) => {
    const headers = new Headers(opts.headers);
    headers.set('Authorization', `Bearer ${opts.token ?? OWNER}`);
    if (opts.body !== undefined) headers.set('Content-Length', String(opts.length ?? new TextEncoder().encode(opts.body).byteLength));
    return handle(new Request(`https://stems.test/v1/bands/${BAND}/studio${path}`, { method, headers, body: opts.body }), env, fetchFn, deps);
  };
  return { bucket, env, deps, clock, call, waited };
}

function session(assets: Array<{ id: string; size: number }> = []) {
  return {
    version: 1, id: 'ses_a', title: 'Maqueta', song_id: null, bpm: 120, beats_per_bar: 4, key: null, sample_rate: 48000,
    latency_offset_ms: 0, updated_at: '2026-01-01T00:00:00Z', updated_by: null,
    assets: assets.map((a) => ({ id: a.id, file: `${a.id}.wav`, kind: 'recording', label: a.id, channels: 1, sample_rate: 48000, duration_s: 1, size: a.size, source: null })),
    tracks: [], master: { volume_db: 0, fx: [], reverb: { decay_s: 1.8, return_db: 0 } },
  };
}

type VcsBody = { commit: { id: string; parent_id: string | null; author_name: string }; vcs: { branches: Record<string, string>; commits: Array<{ id: string }>; protected_assets: string[]; retired_assets: Array<{ file: string; until: string }> } };

async function commit(call: ReturnType<typeof setup>['call'], body: Record<string, unknown>, token = OWNER) {
  return call('POST', '/ses_a/vcs', { token, body: JSON.stringify({ branch: 'main', message: 'Mezcla', session: session(), ...body }) });
}

const errorOf = async (r: Response) => [r.status, ((await r.json()) as { error?: string }).error];

test('vcs: author_name sale del token verificado, no del cuerpo', async () => {
  const { call } = setup();
  const first = await commit(call, { author_name: 'Suplantador' });
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as VcsBody).commit.author_name, 'Daniel Castaneda');
  const second = await commit(call, { author_name: 'Otro' }, MUSICIAN);
  assert.equal(((await second.json()) as VcsBody).commit.author_name, 'guitarra', 'sin nombre en el token: la parte local del correo');
});

test('vcs: parent_id debe ser la cabeza actual (409 vcs_conflict) y un parent_id mal formado es 400', async () => {
  const { call, bucket } = setup();
  const a = (await (await commit(call, { parent_id: null })).json()) as VcsBody;
  assert.equal(a.commit.parent_id, null);
  const b = (await (await commit(call, { parent_id: a.commit.id })).json()) as VcsBody;
  assert.equal(b.commit.parent_id, a.commit.id);
  assert.equal(b.vcs.branches.main, b.commit.id);
  // Cabeza vieja: otro integrante ya movio la rama.
  const stale = await commit(call, { parent_id: a.commit.id });
  assert.deepEqual(await errorOf(stale), [409, 'vcs_conflict']);
  // null en una rama que ya existe tambien es una vista vieja.
  assert.deepEqual(await errorOf(await commit(call, { parent_id: null })), [409, 'vcs_conflict']);
  assert.deepEqual(await errorOf(await commit(call, { parent_id: 'no valido' })), [400, 'bad_vcs']);
  // Sin parent_id se encadena a la cabeza actual.
  const c = (await (await commit(call, {})).json()) as VcsBody;
  assert.equal(c.commit.parent_id, b.commit.id);
  // Los rechazos no dejan documentos de commit sueltos.
  const docs = [...bucket.objects.keys()].filter((k) => k.startsWith(`${P}ses_a/commits/`));
  assert.equal(docs.length, 3);
});

test('vcs: una carrera sobre vcs.json se reintenta; si nunca se gana es 409 y el snapshot se borra', async () => {
  const { call, bucket } = setup();
  await commit(call, {});
  let races = 1;
  bucket.beforePut = (key) => {
    if (key.endsWith('/vcs.json') && races > 0) {
      races--;
      // Otra peticion reescribe el indice entre la lectura y la escritura (cambia el etag).
      bucket.write(key, bucket.json(key));
    }
  };
  const retried = await commit(call, { branch: 'vivo' });
  assert.equal(retried.status, 201, 'un solo choque se resuelve releyendo');
  races = 99;
  const lost = await commit(call, { branch: 'acustico' });
  assert.deepEqual(await errorOf(lost), [409, 'vcs_conflict']);
  bucket.beforePut = undefined;
  const vcs = bucket.json(`${P}ses_a/vcs.json`);
  assert.deepEqual(Object.keys(vcs.branches).sort(), ['main', 'vivo']);
  const docs = [...bucket.objects.keys()].filter((k) => k.startsWith(`${P}ses_a/commits/`));
  assert.equal(docs.length, 2, 'el snapshot del commit perdido no queda en R2');
});

test('vcs: pasados 128 commits se expulsan los viejos y sus audios quedan en periodo de gracia', async () => {
  const { call, bucket, clock } = setup();
  bucket.seed(`${P}ses_a/assets/ast_old.wav`, 10);
  const first = (await (await commit(call, { session: session([{ id: 'ast_old', size: 10 }]) })).json()) as VcsBody;
  let last: VcsBody | null = null;
  for (let i = 0; i < MAX_VCS_COMMITS; i++) last = (await (await commit(call, { message: `Paso ${i}` })).json()) as VcsBody;
  assert.ok(last);
  assert.equal(last.vcs.commits.length, MAX_VCS_COMMITS);
  assert.ok(!last.vcs.commits.some((c) => c.id === first.commit.id), 'el commit mas viejo sale');
  assert.ok(!bucket.objects.has(`${P}ses_a/commits/${first.commit.id}.json`), 'y su documento se borra');
  const retired = last.vcs.retired_assets.find((r) => r.file === 'ast_old.wav');
  assert.ok(retired, 'su audio pasa a retired_assets');
  assert.equal(Date.parse(retired.until), clock.now.getTime() + RETIRED_GRACE_MS);
  assert.ok(last.vcs.protected_assets.includes('ast_old.wav'), 'y sigue protegido durante la gracia');
  // Vencida la gracia, el siguiente commit lo suelta.
  clock.now = new Date(clock.now.getTime() + RETIRED_GRACE_MS + 1000);
  const after = (await (await commit(call, { message: 'Despues' })).json()) as VcsBody;
  assert.ok(!after.vcs.retired_assets.some((r) => r.file === 'ast_old.wav'));
  assert.ok(!after.vcs.protected_assets.includes('ast_old.wav'));
});

test('vcs: tope de 16 ramas; la rama 17 es 409 too_many_branches y las existentes siguen', async () => {
  const { call } = setup();
  for (let i = 0; i < MAX_VCS_BRANCHES; i++) assert.equal((await commit(call, { branch: `rama_${i}` })).status, 201);
  assert.deepEqual(await errorOf(await commit(call, { branch: 'una_mas' })), [409, 'too_many_branches']);
  assert.equal((await commit(call, { branch: 'rama_3' })).status, 201);
});

test('vcs: borrar rama (Owner/MusicDirector), main protegida, inexistente, nombre invalido', async () => {
  const { call, bucket } = setup();
  bucket.seed(`${P}ses_a/assets/ast_vivo.wav`, 10);
  await commit(call, {});
  const vivo = (await (await commit(call, { branch: 'vivo', session: session([{ id: 'ast_vivo', size: 10 }]) })).json()) as VcsBody;
  assert.deepEqual(await errorOf(await call('DELETE', '/ses_a/vcs/branches/vivo', { token: MUSICIAN })), [403, 'not_an_editor']);
  assert.deepEqual(await errorOf(await call('DELETE', '/ses_a/vcs/branches/main')), [409, 'branch_protected']);
  assert.deepEqual(await errorOf(await call('DELETE', '/ses_a/vcs/branches/fantasma')), [404, 'no_branch']);
  assert.deepEqual(await errorOf(await call('DELETE', '/ses_a/vcs/branches/a.b')), [400, 'bad_vcs']);
  assert.deepEqual(await errorOf(await call('POST', '/ses_a/vcs/branches/vivo', { body: '{}' })), [405, 'method_not_allowed']);
  const res = await call('DELETE', '/ses_a/vcs/branches/vivo');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { deleted_commits: number; vcs: VcsBody['vcs'] };
  assert.equal(body.deleted_commits, 1);
  assert.deepEqual(Object.keys(body.vcs.branches), ['main']);
  assert.ok(!bucket.objects.has(`${P}ses_a/commits/${vivo.commit.id}.json`));
  assert.ok(body.vcs.retired_assets.some((r) => r.file === 'ast_vivo.wav'), 'sus audios entran en periodo de gracia');
  assert.ok(body.vcs.protected_assets.includes('ast_vivo.wav'));
});

test('vcs: id de commit invalido es 400 bad_commit; inexistente 404 no_commit; cuerpo grande 413', async () => {
  const { call } = setup();
  assert.deepEqual(await errorOf(await call('GET', '/ses_a/commits/no.valido')), [400, 'bad_commit']);
  assert.deepEqual(await errorOf(await call('GET', '/ses_a/commits/cmt_nada')), [404, 'no_commit']);
  const big = await call('POST', '/ses_a/vcs', { body: '{}', length: VCS_BODY_LIMIT + 1 });
  assert.deepEqual(await errorOf(big), [413, 'session_too_large']);
  assert.deepEqual(await errorOf(await call('POST', '/ses_a/vcs', { body: '[1]' })), [400, 'bad_vcs']);
});

test('limpieza: el guardado de un Musician no borra audios retirados; el de un Owner si, vencida la gracia', async () => {
  const { call, bucket, clock, waited } = setup();
  bucket.seed(`${P}ses_a/assets/ast_ret.wav`, 10);
  bucket.write(`${P}ses_a/vcs.json`, {
    version: 1, branches: {}, commits: [], protected_assets: [],
    retired_assets: [{ file: 'ast_ret.wav', until: '2026-01-01T00:00:00.000Z' }],
  });
  const put = await call('PUT', '/ses_a/session', { token: MUSICIAN, body: JSON.stringify(session()), headers: { 'If-None-Match': '*' } });
  assert.equal(put.status, 200);
  await Promise.all(waited.splice(0));
  assert.ok(bucket.objects.has(`${P}ses_a/assets/ast_ret.wav`), 'limpieza conservadora: no lo borra');
  // La marca de 2 h ya se puso; pasado el intervalo guarda un Owner.
  clock.now = new Date(clock.now.getTime() + 3 * 3600_000);
  const etag = (put.headers.get('ETag') || '').replace(/"/g, '');
  const put2 = await call('PUT', '/ses_a/session', { body: JSON.stringify(session()), headers: { 'If-Match': etag } });
  assert.equal(put2.status, 200);
  await Promise.all(waited.splice(0));
  assert.ok(!bucket.objects.has(`${P}ses_a/assets/ast_ret.wav`), 'la gracia vencio y no esta en protected_assets');
});

test('limpieza: si vcs.json cambia entre la lectura y el borrado, esa sesion se salta', async () => {
  const { env, deps, bucket } = setup();
  bucket.write(`${P}ses_a/session.json`, session());
  bucket.seed(`${P}ses_a/assets/ast_x.wav`, 10);
  bucket.write(`${P}ses_a/vcs.json`, { version: 1, branches: {}, commits: [], protected_assets: [] });
  bucket.onHead = (key) => {
    if (key.endsWith('/session.json')) {
      // Alguien crea una version (que nombra ast_x) justo antes del borrado.
      bucket.write(`${P}ses_a/vcs.json`, { version: 1, branches: {}, commits: [], protected_assets: ['ast_x.wav'] });
      bucket.onHead = undefined;
    }
  };
  const report = await opportunisticCleanup(env, deps, P, 'ses_a');
  assert.ok(report !== 'skipped');
  assert.equal(report.deleted, 0);
  assert.ok(bucket.objects.has(`${P}ses_a/assets/ast_x.wav`));
});
