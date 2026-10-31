import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.ts';
import type { Env, R2Body, R2Bucket, R2Object, R2ObjectBody, R2PutOptions } from '../src/types.ts';

const BAND = '11111111-2222-4333-8444-555555555555';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ORIGIN = 'https://bandait.releven.cc';
const TOKENS: Record<string, string | null> = {
  'tok-owner-xxxxxxxxxxxxxxxx': 'Owner',
  'tok-director-xxxxxxxxxxxxx': 'MusicDirector',
  'tok-musician-xxxxxxxxxxxxx': 'Musician',
  'tok-stranger-xxxxxxxxxxxxx': null,
};

class FakeR2 implements R2Bucket {
  objects = new Map<string, { bytes: Uint8Array; type?: string }>();

  describe(key: string): R2Object {
    const o = this.objects.get(key)!;
    return { key, size: o.bytes.byteLength, etag: 'e', httpEtag: '"e"', uploaded: new Date(0), httpMetadata: { contentType: o.type } };
  }

  async head(key: string) {
    return this.objects.has(key) ? this.describe(key) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    if (!this.objects.has(key)) return null;
    const bytes = this.objects.get(key)!.bytes;
    return { ...this.describe(key), body: new Blob([bytes]).stream(), text: async () => new TextDecoder().decode(bytes) };
  }

  async put(key: string, value: R2Body, options?: R2PutOptions) {
    const bytes = value instanceof ReadableStream
      ? new Uint8Array(await new Response(value).arrayBuffer())
      : typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer);
    this.objects.set(key, { bytes, type: options?.httpMetadata?.contentType });
    return this.describe(key);
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  async list(options?: { prefix?: string }) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(options?.prefix || '')).sort();
    return { objects: keys.map((k) => this.describe(k)), truncated: false };
  }
}

function setup() {
  const bucket = new FakeR2();
  const env: Env = {
    STEMS: bucket, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5174`,
  };
  const calls: string[] = [];
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const auth = new Headers(init?.headers).get('Authorization') || '';
    const token = auth.replace('Bearer ', '');
    if (!(token in TOKENS) && token !== 'tok-personal-xxxxxxxxxxxxx') return new Response('{}', { status: 401 });
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: USER });
    assert.equal(JSON.parse(String(init?.body)).p_band, BAND);
    return Response.json(TOKENS[token] ?? null);
  };
  const call = (method: string, path: string, opts: { token?: string; body?: BodyInit; type?: string; origin?: string; length?: number } = {}) => {
    const headers = new Headers();
    if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
    if (opts.type) headers.set('Content-Type', opts.type);
    if (opts.origin) headers.set('Origin', opts.origin);
    if (opts.body !== undefined) {
      const size = opts.length ?? (typeof opts.body === 'string' ? new TextEncoder().encode(opts.body).byteLength : (opts.body as Uint8Array).byteLength);
      headers.set('Content-Length', String(size));
    }
    return handle(new Request(`https://stems.test${path}`, { method, headers, body: opts.body }), env, fetchFn);
  };
  return { bucket, call, calls };
}

const OWNER = 'tok-owner-xxxxxxxxxxxxxxxx';
const MUSICIAN = 'tok-musician-xxxxxxxxxxxxx';
const base = `/v1/bands/${BAND}/songs/song_01`;
const audio = new Uint8Array([1, 2, 3, 4, 5]);

test('health', async () => {
  const { call } = setup();
  const res = await call('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('upload files then manifest (commit), read as a musician, orphans removed', async () => {
  const { call, bucket } = setup();
  for (const name of ['Hoy - Vocals.mp3', 'Hoy - Drums.mp3', 'viejo.mp3']) {
    const r = await call('PUT', `${base}/files/${encodeURIComponent(name)}`, { token: OWNER, body: audio, type: 'audio/mpeg' });
    assert.equal(r.status, 200, name);
  }
  const manifest = {
    version: 1, song_id: 'song_01', offset_ms: 40,
    stems: [
      { file: 'Hoy - Vocals.mp3', role: 'vocals', label: 'Voz', size: 5 },
      { file: 'Hoy - Drums.mp3', role: 'drums', label: 'Bateria', size: 5 },
    ],
  };
  const put = await call('PUT', `${base}/manifest`, { token: 'tok-director-xxxxxxxxxxxxx', body: JSON.stringify(manifest), type: 'application/json' });
  assert.equal(put.status, 200);
  assert.ok(!bucket.objects.has(`bands/${BAND}/songs/song_01/files/viejo.mp3`), 'file not in the manifest is deleted');

  const got = await call('GET', `${base}/manifest`, { token: MUSICIAN });
  assert.equal(got.status, 200);
  const body = await got.json();
  assert.equal(body.offset_ms, 40);
  assert.equal(body.stems.length, 2);
  const file = await call('GET', `${base}/files/${encodeURIComponent('Hoy - Drums.mp3')}`, { token: MUSICIAN });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('Content-Type'), 'audio/mpeg');
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio);
});

test('roles: musicians read only, strangers and bad tokens are refused', async () => {
  const { call } = setup();
  assert.equal((await call('PUT', `${base}/files/a.mp3`, { token: MUSICIAN, body: audio, type: 'audio/mpeg' })).status, 403);
  assert.equal((await call('GET', `${base}/manifest`, { token: 'tok-stranger-xxxxxxxxxxxxx' })).status, 403);
  assert.equal((await call('GET', `${base}/manifest`, { token: 'tok-unknown-xxxxxxxxxxxxxx' })).status, 401);
  assert.equal((await call('GET', `${base}/manifest`)).status, 401);
  assert.equal((await call('GET', `${base}/manifest`, { token: MUSICIAN })).status, 404);
  assert.equal((await call('DELETE', `/v1/bands/${BAND}/songs/song_01`, { token: MUSICIAN })).status, 403);
});

test('manifest must match uploaded files', async () => {
  const { call } = setup();
  await call('PUT', `${base}/files/a.mp3`, { token: OWNER, body: audio, type: 'audio/mpeg' });
  const wrongSize = { version: 1, song_id: 'song_01', offset_ms: 0, stems: [{ file: 'a.mp3', role: 'bass', label: 'Bajo', size: 9 }] };
  assert.equal((await call('PUT', `${base}/manifest`, { token: OWNER, body: JSON.stringify(wrongSize) })).status, 409);
  const wrongSong = { ...wrongSize, song_id: 'otra', stems: [{ ...wrongSize.stems[0], size: 5 }] };
  assert.equal((await call('PUT', `${base}/manifest`, { token: OWNER, body: JSON.stringify(wrongSong) })).status, 400);
  assert.equal((await call('PUT', `${base}/manifest`, { token: OWNER, body: '{no json' })).status, 400);
});

test('input validation: names, ids, type, length', async () => {
  const { call } = setup();
  assert.equal((await call('PUT', `${base}/files/${encodeURIComponent('../x.mp3')}`, { token: OWNER, body: audio })).status, 400);
  assert.equal((await call('PUT', `${base}/files/notas.txt`, { token: OWNER, body: audio })).status, 400);
  assert.equal((await call('PUT', `${base}/files/a.mp3`, { token: OWNER, body: audio, type: 'text/html' })).status, 415);
  assert.equal((await call('PUT', `${base}/files/a.mp3`, { token: OWNER, body: audio, length: 999 })).status, 400);
  assert.equal((await call('GET', '/v1/bands/no-uuid/songs/song_01/manifest', { token: OWNER })).status, 400);
  assert.equal((await call('GET', `/v1/bands/${BAND}/songs/a%20b/manifest`, { token: OWNER })).status, 400);
  assert.equal((await call('POST', `${base}/manifest`, { token: OWNER, body: '{}' })).status, 405);
});

test('personal workspace "me" goes under the caller id', async () => {
  const { call, bucket } = setup();
  const r = await call('PUT', '/v1/bands/me/songs/s1/files/a.mp3', { token: 'tok-personal-xxxxxxxxxxxxx', body: audio, type: 'audio/mpeg' });
  assert.equal(r.status, 200);
  assert.ok(bucket.objects.has(`users/${USER}/songs/s1/files/a.mp3`));
});

test('delete removes every object of the song', async () => {
  const { call, bucket } = setup();
  await call('PUT', `${base}/files/a.mp3`, { token: OWNER, body: audio, type: 'audio/mpeg' });
  await call('PUT', `${base}/manifest`, {
    token: OWNER, body: JSON.stringify({ version: 1, song_id: 'song_01', stems: [{ file: 'a.mp3', role: 'bass', label: 'Bajo', size: 5 }] }),
  });
  const r = await call('DELETE', `/v1/bands/${BAND}/songs/song_01`, { token: OWNER });
  assert.equal((await r.json()).deleted, 2);
  assert.equal(bucket.objects.size, 0);
});

test('CORS only for allowed origins', async () => {
  const { call } = setup();
  const pre = await call('OPTIONS', `${base}/manifest`, { origin: ORIGIN });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const bad = await call('OPTIONS', `${base}/manifest`, { origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  const res = await call('GET', `${base}/manifest`, { token: MUSICIAN, origin: ORIGIN });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('Supabase down is a 502, not an open door', async () => {
  const bucket = new FakeR2();
  const env: Env = { STEMS: bucket, SUPABASE_URL: 'https://x', SUPABASE_ANON_KEY: 'a', ALLOWED_ORIGINS: '' };
  const res = await handle(new Request(`https://s${base}/manifest`, { headers: { Authorization: `Bearer ${OWNER}` } }), env, async () => {
    throw new Error('down');
  });
  assert.equal(res.status, 502);
});
