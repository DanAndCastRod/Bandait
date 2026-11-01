import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ASSEMBLER_VERSION, assemble, barGrid, keyName } from '../src/analysis.ts';
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
  // Same-label phrases merge up to 16 bars; a verse in two passes keeps its number.
  assert.deepEqual(d.sections.map((s) => s.label),
    ['Intro', 'Estrofa 1', 'Estrofa 1', 'Coro', 'Coro', 'Estrofa 2', 'Estrofa 2', 'Coro', 'Puente', 'Coro', 'Final']);
  assert.ok(d.sections.every((s) => s.bars <= 16), 'no section over 16 bars');
  assert.equal(d.sections[0].start_bar, 1);
  for (let i = 1; i < d.sections.length; i++) {
    assert.equal(d.sections[i].start_bar, d.sections[i - 1].start_bar + d.sections[i - 1].bars, 'cumulative start_bar');
  }
  const total = d.sections.reduce((a, s) => a + s.bars, 0);
  assert.ok(total > 110 && total < 130, `total bars ${total}`);
  assert.match(d.sections[3].chordpro, /^\[A\]\s+\[E\]\s+\[B\]\s+\[C#m\]/);
  assert.ok(!/\[C#m\] \[C#m7\]/.test(d.sections.map((s) => s.chordpro).join('\n')), 'same harmony collapsed in a bar');
  assert.equal(d.lyrics_unplaced.length, 4);
  assert.ok(d.notes.some((n) => n.includes('sin tiempos')));
});

// 120 BPM, 4/4: one bar = 2 s. Synthetic words (no real lyrics in fixtures).
const SYNTH = {
  Bpm: 120, 'Root Key': 'E major',
  Sections: [{ start: 0, end: 4, label: 'Intro' }, { start: 4, end: 16, label: 'Verse' }],
  ChordsMap: [
    { start: 0, end: 4, start_bar: 0, start_beat: 1, chord_simple_pop: 'A' },
    { start: 4, end: 8, start_bar: 2, start_beat: 1, chord_simple_pop: 'E' },
    { start: 8, end: 11, start_bar: 4, start_beat: 1, chord_simple_pop: 'B' },
    { start: 11, end: 14, start_bar: 5, start_beat: 3, chord_simple_pop: 'C#m' },
    { start: 14, end: 16, start_bar: 7, start_beat: 1, chord_simple_pop: 'A' },
  ],
  Lyrics: [
    { text: 'uno dos tres', start: 4, end: 6.8, words: [
      { word: 'uno', start: 4, end: 4.8 }, { word: 'dos', start: 5, end: 5.8 }, { word: 'tres', start: 6, end: 6.8 }] },
    { text: 'cuatro cinco seis', start: 8, end: 11.6, words: [
      { word: 'cuatro', start: 8, end: 8.9 }, { word: 'cinco', start: 9, end: 10.9 }, { word: 'seis', start: 11, end: 11.6 }] },
  ],
};

test('timed lyrics: chords on the word where they change, chord-only lines for unsung bars', () => {
  const d = assemble(structuredClone(SYNTH));
  assert.deepEqual(d.sections.map((s) => [s.label, s.start_bar, s.bars]), [['Intro', 1, 2], ['Estrofa 1', 3, 6]]);
  assert.equal(d.sections[0].chordpro, '[A]    [A]');
  assert.equal(d.sections[1].chordpro, '[E]uno dos tres\n[B]cuatro cinco [C#m]seis\n[C#m]    [A]');
  assert.equal(d.lyrics_unplaced.length, 0);
  assert.ok(!d.notes.some((n) => n.includes('sin tiempos')));
});

test('timed lyrics: pickup joins the next section, breath splits the phrase, chord after the last word trails', () => {
  const r = structuredClone(SYNTH);
  r.Lyrics = [
    // Sung on beat 4 of the intro's last bar: belongs to the verse.
    { text: 'ya uno', start: 3.5, end: 4.8, words: [{ word: 'ya', start: 3.5, end: 3.9 }, { word: 'uno', start: 4, end: 4.8 }] },
    // Two-beat breath after "dos" (5.8 -> 7.0): two phrases. "tres" ends before B arrives at 8 s.
    { text: 'dos tres', start: 5, end: 7.4, words: [{ word: 'dos', start: 5, end: 5.8 }, { word: 'tres', start: 7, end: 7.4 }] },
    // Short word on bar 5; C#m arrives on beat 3 of that bar, after the word.
    { text: 'seis', start: 10, end: 10.4, words: [{ word: 'seis', start: 10, end: 10.4 }] },
  ];
  const d = assemble(r);
  assert.equal(d.sections[0].chordpro, '[A]    [A]');
  const lines = d.sections[1].chordpro.split('\n');
  assert.equal(lines[0], '[A]ya [E]uno');
  assert.equal(lines[1], '[E]dos');
  assert.equal(lines[2], '[E]tres');
  assert.equal(lines[3], '[B]', 'unsung bar 4 brings a new chord: chord-only line');
  assert.equal(lines[4], '[B]seis [C#m]');
  assert.equal(lines[5], '[C#m]    [A]');
});

test('lyrics without timestamps stay unplaced', () => {
  const d = assemble({ ...structuredClone(SYNTH), Lyrics: [{ text: 'sin tiempos' }] });
  assert.deepEqual(d.lyrics_unplaced, ['sin tiempos']);
  assert.ok(d.notes.some((n) => n.includes('sin tiempos')));
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
  assert.equal(done.draft.sections.length, 11);
  const before = calls.length;
  const again = await (await call('GET', OWNER)).json();
  assert.equal(again.draft.sections.length, 11);
  assert.ok(calls.slice(before).every((c) => !c.includes('music.ai')), 'cached draft: Music AI is not called again');

  // A draft from an older assembler is rebuilt from the stored raw result, still without Music AI.
  const recKey = `bands/${BAND}/songs/song_01/analysis.json`;
  const rec = JSON.parse(new TextDecoder().decode(bucket.objects.get(recKey)!));
  assert.equal(rec.assembler, ASSEMBLER_VERSION);
  bucket.objects.set(recKey, new TextEncoder().encode(JSON.stringify({ ...rec, assembler: 1, draft: { sections: [] } })));
  const rebuilt = await (await call('GET', MUSICIAN)).json();
  assert.equal(rebuilt.draft.sections.length, 11);
  assert.ok(calls.slice(before).every((c) => !c.includes('music.ai')), 'rebuilt from the stored result');

  // A record from before the raw result was stored asks Music AI for the job again.
  bucket.objects.set(recKey, new TextEncoder().encode(JSON.stringify({ job_id: 'job-1', created_at: rec.created_at, draft: { sections: [] } })));
  assert.equal((await (await call('GET', MUSICIAN)).json()).draft.sections.length, 11);
  assert.ok(calls.some((c) => c === 'GET https://api.music.ai/v1/job/job-1'));
  assert.equal((await call('POST', OWNER, mix, 'text/plain')).status, 415);

  const noKey = setup(false);
  assert.equal((await noKey.call('POST', OWNER, mix)).status, 503);
  assert.equal((await noKey.call('GET', OWNER)).status, 404);
});
