import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assemble, barGrid, keyName } from '../src/analysis.ts';
import { handle } from '../src/index.ts';
import type { Env, R2Body, R2Bucket, R2Object, R2ObjectBody, R2PutOptions } from '../src/types.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('../../bandait-protocol/fixtures/musicai_result.json', import.meta.url), 'utf8'));
const BAND = '11111111-2222-4333-8444-555555555555';
const OWNER = 'tok-owner-xxxxxxxxxxxxxxxx';
const MUSICIAN = 'tok-musician-xxxxxxxxxxxxx';

test('assemble the real Music AI result: merged sections, bars, chord charts', () => {
  const d = assemble(FIXTURE.result);
  assert.equal(d.bpm, 124);
  assert.equal(d.key, 'E');
  assert.deepEqual(d.sections.map((s) => s.label), ['Intro', 'Estrofa 1', 'Coro', 'Estrofa 2', 'Coro', 'Puente', 'Coro', 'Final']);
  assert.equal(d.sections[0].start_bar, 1);
  for (let i = 1; i < d.sections.length; i++) {
    assert.equal(d.sections[i].start_bar, d.sections[i - 1].start_bar + d.sections[i - 1].bars, 'cumulative start_bar');
  }
  const total = d.sections.reduce((a, s) => a + s.bars, 0);
  assert.ok(total > 110 && total < 130, `total bars ${total}`);
  assert.match(d.sections[2].chordpro, /^\[A\]\s+\[E\]\s+\[B\]\s+\[C#m\]/);
  assert.ok(!/\[C#m\] \[C#m7\]/.test(d.sections.map((s) => s.chordpro).join('\n')), 'same harmony collapsed in a bar');
  assert.equal(d.lyrics_unplaced.length, 4);
  assert.ok(d.notes.some((n) => n.includes('sin tiempos')));
});

test('lyrics with timestamps are placed in their section', () => {
  const result = structuredClone(FIXTURE.result);
  result.Lyrics = [{ text: 'linea del coro', start: 60 }, { text: 'linea del intro', words: [{ word: 'x', start: 3 }] }];
  const d = assemble(result);
  assert.equal(d.lyrics_unplaced.length, 0);
  assert.ok(d.sections.find((s) => s.label === 'Coro')!.chordpro.endsWith('linea del coro'));
  assert.ok(d.sections[0].chordpro.endsWith('linea del intro'));
});

test('keys and grid helpers', () => {
  assert.equal(keyName('E major'), 'E');
  assert.equal(keyName('C# minor'), 'C#m');
  assert.equal(keyName(undefined), null);
  const at = barGrid([{ start: 0, end: 2, start_bar: 0, start_beat: 1 }, { start: 2, end: 4, start_bar: 1, start_beat: 1 }]);
  assert.equal(at(1), 0.5);
  const empty = assemble({});
  assert.equal(empty.sections.length, 0);
  assert.ok(empty.notes.length >= 1);
});

class MemR2 implements R2Bucket {
  objects = new Map<string, Uint8Array>();
  describe(key: string): R2Object {
    return { key, size: this.objects.get(key)!.byteLength, etag: 'e', httpEtag: '"e"', uploaded: new Date(0) };
  }
  async head(key: string) { return this.objects.has(key) ? this.describe(key) : null; }
  async get(key: string): Promise<R2ObjectBody | null> {
    const b = this.objects.get(key);
    return b ? { ...this.describe(key), body: new Blob([b]).stream(), text: async () => new TextDecoder().decode(b) } : null;
  }
  async put(key: string, value: R2Body, _o?: R2PutOptions) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
    this.objects.set(key, bytes);
    return this.describe(key);
  }
  async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k); }
  async list() { return { objects: [], truncated: false }; }
}

function setup(withKey = true) {
  const bucket = new MemR2();
  const env: Env = {
    STEMS: bucket, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', ALLOWED_ORIGINS: '',
    ...(withKey ? { MUSICAI_API_KEY: 'musicai-key' } : {}),
  };
  const calls: string[] = [];
  let jobStatus = 'STARTED';
  const fetchFn = async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${url.replace(/\?.*$/, '')}`);
    if (url.includes('supabase.co')) {
      const token = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '');
      return Response.json(token === OWNER ? 'Owner' : token === MUSICIAN ? 'Musician' : null);
    }
    if (url.startsWith('https://api.music.ai/')) assert.equal(new Headers(init?.headers).get('Authorization'), 'musicai-key');
    if (url === 'https://api.music.ai/v1/upload') return Response.json({ uploadUrl: 'https://storage.test/put', downloadUrl: 'https://storage.test/get' });
    if (url === 'https://storage.test/put') return new Response(null, { status: 200 });
    if (url === 'https://api.music.ai/v1/job') {
      assert.equal(JSON.parse(String(init?.body)).workflow, 'stems-workflow-releven-bandait');
      return Response.json({ id: 'job-1' });
    }
    if (url === 'https://api.music.ai/v1/job/job-1') {
      return Response.json(jobStatus === 'SUCCEEDED'
        ? { status: 'SUCCEEDED', result: { Bpm: 124, 'Root Key': 'E major', Sections: 'https://r.test/s', ChordsMap: 'https://r.test/c', Lyrics: 'https://r.test/l' } }
        : { status: jobStatus });
    }
    if (url === 'https://r.test/s') return Response.json(FIXTURE.result.Sections);
    if (url === 'https://r.test/c') return Response.json(FIXTURE.result.ChordsMap);
    if (url === 'https://r.test/l') return Response.json(FIXTURE.result.Lyrics);
    throw new Error(`unexpected ${url}`);
  };
  const call = (method: string, token: string, body?: Uint8Array, type = 'audio/flac') => {
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (body) { headers.set('Content-Type', type); headers.set('Content-Length', String(body.byteLength)); }
    return handle(new Request(`https://w.test/v1/bands/${BAND}/songs/song_01/analysis`, { method, headers, body }), env, fetchFn);
  };
  return { call, calls, bucket, setStatus: (s: string) => { jobStatus = s; } };
}

test('analysis: start, poll, draft cached; editors only; no key = 503', async () => {
  const { call, calls, bucket, setStatus } = setup();
  const mix = new Uint8Array([1, 2, 3, 4]);
  assert.equal((await call('POST', MUSICIAN, mix)).status, 403);
  assert.equal((await call('GET', MUSICIAN)).status, 404, 'a member can read (no analysis yet)');
  const start = await call('POST', OWNER, mix);
  assert.equal(start.status, 202);
  assert.equal((await start.json()).job_id, 'job-1');
  assert.ok(bucket.objects.has(`bands/${BAND}/songs/song_01/analysis.json`));
  assert.equal((await (await call('GET', OWNER)).json()).status, 'STARTED');
  setStatus('SUCCEEDED');
  const done = await (await call('GET', OWNER)).json();
  assert.equal((await (await call('GET', MUSICIAN)).json()).status, 'SUCCEEDED', 'members read the draft');
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(done.draft.sections.length, 8);
  const before = calls.length;
  const again = await (await call('GET', OWNER)).json();
  assert.equal(again.draft.sections.length, 8);
  assert.ok(calls.slice(before).every((c) => !c.includes('music.ai')), 'cached draft: Music AI is not called again');
  assert.equal((await call('POST', OWNER, mix, 'text/plain')).status, 415);

  const noKey = setup(false);
  assert.equal((await noKey.call('POST', OWNER, mix)).status, 503);
  assert.equal((await noKey.call('GET', OWNER)).status, 404);
});
