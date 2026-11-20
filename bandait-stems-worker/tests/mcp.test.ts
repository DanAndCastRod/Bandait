// MCP de operador (src/mcp.ts) y registro de eventos (src/events.ts), con R2, Supabase y URiT IA
// simulados. La primera parte usa el cliente oficial del SDK de MCP (devDependency) contra handle(),
// sin red: si el protocolo se desvia, el SDK falla. Ninguna prueba sale a la red ni toca datos reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handle, scheduled } from '../src/index.ts';
import { EVENTS_PREFIX, purgeEvents, sanitizeDetail } from '../src/events.ts';
import type { Env, R2Body, R2Bucket, R2Conditional, R2GetOptions, R2Object, R2ObjectBody, R2PutOptions } from '../src/types.ts';

const BAND = '11111111-2222-4333-8444-555555555555';
const OTHER_BAND = '99999999-2222-4333-8444-555555555555';
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MCP_TOKEN = 'mcp-token-de-prueba-0123456789abcdef';
const URIT_TOKEN = 'urit-token-NO-DEBE-SALIR-123456';
/** Marcas que nunca deben aparecer en una respuesta del MCP. */
const PROMPT = 'PROMPT-MARCADO-7f3a letra secreta de la cancion';
const AUDIO_TEXT = 'ID3-AUDIO-MARCADO-XYZ';
const AUDIO_B64 = Buffer.from(AUDIO_TEXT).toString('base64');
const MCP_URL = 'https://stems.test/mcp';
const NOW = new Date('2026-11-20T03:10:00.000Z');

const b64url = (text: string) => Buffer.from(text).toString('base64url');
const OWNER = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ sub: USER, role: 'owner' }))}.firma-owner`;

class FakeR2 implements R2Bucket {
  objects = new Map<string, { bytes: Uint8Array; version: number; custom?: Record<string, string>; uploaded: Date }>();
  versions = 0;
  ops = 0;

  write(key: string, value: unknown, custom?: Record<string, string>) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    this.objects.set(key, { bytes: new TextEncoder().encode(text), version: ++this.versions, custom, uploaded: new Date(this.versions * 1000) });
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
    return this.objects.has(key) ? this.describe(key) : null;
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    this.ops++;
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
    this.objects.set(key, { bytes, version: ++this.versions, custom: options?.customMetadata, uploaded: new Date(this.versions * 1000) });
    return this.describe(key);
  }

  async delete(keys: string | string[]) {
    this.ops++;
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  /** Como R2: customMetadata solo con `include`; `limit` corta y deja `truncated`. */
  async list(options?: { prefix?: string; delimiter?: string; limit?: number; cursor?: string; include?: string[] }) {
    this.ops++;
    const prefix = options?.prefix || '';
    const withCustom = options?.include?.includes('customMetadata') ?? false;
    let keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (options?.cursor) keys = keys.filter((k) => k > options.cursor!);
    if (!options?.delimiter) {
      const limit = options?.limit ?? 1000;
      const page = keys.slice(0, limit);
      const truncated = keys.length > limit;
      return { objects: page.map((k) => this.describe(k, withCustom)), truncated, cursor: truncated ? page.at(-1) : undefined };
    }
    const folders = new Set<string>();
    const direct: string[] = [];
    for (const k of keys) {
      const cut = k.indexOf(options.delimiter, prefix.length);
      if (cut < 0) direct.push(k);
      else folders.add(k.slice(0, cut + 1));
    }
    return { objects: direct.map((k) => this.describe(k, withCustom)), truncated: false, delimitedPrefixes: [...folders] };
  }

  json(key: string) {
    return JSON.parse(new TextDecoder().decode(this.objects.get(key)!.bytes));
  }

  eventKeys() {
    return [...this.objects.keys()].filter((k) => k.startsWith(EVENTS_PREFIX)).sort();
  }
}

function setup(vars: Partial<Env> = {}) {
  const bucket = new FakeR2();
  const env: Env = {
    STEMS: bucket, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', ALLOWED_ORIGINS: 'https://bandait.releven.cc',
    URIT_AI_TOKEN: URIT_TOKEN, MCP_TOKENS: MCP_TOKEN, STUDIO_MONTHLY_BUDGET_USD: '20', STUDIO_GLOBAL_MONTHLY_BUDGET_USD: '30', ...vars,
  };
  const clock = { now: NOW };
  let ids = 0;
  const waited: Promise<unknown>[] = [];
  const deps = { now: () => clock.now, newId: (prefix: string) => `${prefix}_t${++ids}`, waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
  const world = { music: (): Response => Response.json({}) };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (url.startsWith('https://x.supabase.co/')) {
      if (headers.get('Authorization') !== `Bearer ${OWNER}`) return new Response('{}', { status: 401 });
      if (url.endsWith('/auth/v1/user')) return Response.json({ id: USER });
      return Response.json('Owner');
    }
    if (url === 'https://ai.urit.services/v1/music') return world.music();
    throw new Error(`llamada inesperada: ${url}`);
  };
  const studio = (method: string, path: string, body?: unknown) => {
    const headers = new Headers({ Authorization: `Bearer ${OWNER}` });
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers.set('Content-Type', 'application/json');
      headers.set('Content-Length', String(new TextEncoder().encode(payload).byteLength));
    }
    return handle(new Request(`https://stems.test/v1/bands/${BAND}/studio${path}`, { method, headers, body: payload }), env, fetchFn, deps);
  };
  /** Todo lo que respondio el MCP, para buscar marcas que no deben salir. */
  const seen: string[] = [];
  const mcpFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const res = await handle(new Request(url, init), env, fetchFn, deps);
    seen.push(await res.clone().text());
    return res;
  };
  const connect = async (token = MCP_TOKEN) => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: mcpFetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'prueba-bandait', version: '0.0.0' });
    await client.connect(transport);
    return client;
  };
  /** Mensaje JSON-RPC crudo, para los casos que el SDK no deja provocar. */
  const raw = async (body: unknown, headers: Record<string, string> = {}, method = 'POST') => {
    const init: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${MCP_TOKEN}`, ...headers },
    };
    if (method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await mcpFetch(MCP_URL, init);
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const flush = () => Promise.all(waited);
  return { bucket, env, deps, clock, world, studio, connect, raw, seen, flush, waited };
}

const GENERATE = { kind: 'generate', provider: 'lyria', prompt: PROMPT, duration_s: 30, bpm: 120, key: null, instrumental: true };

function musicOk(): Response {
  return Response.json({
    id: 'ai_ok_001', model: 'lyria-3-clip-preview', output: { audio: { mime_type: 'audio/mpeg', data: AUDIO_B64, bytes: AUDIO_TEXT.length }, text: PROMPT },
    usage: { songs: 1, estimated_usd: '0.040000' }, finish_reason: 'stop',
  }, { headers: { 'X-Request-Id': 'ai_ok_001' } });
}

/** Siembra una banda con una sesion, stems y gasto; y corre tres trabajos reales (exito, FAILED, rechazo). */
async function seeded() {
  const s = setup();
  const { bucket, studio, world, flush } = s;
  const prefix = `bands/${BAND}/`;
  bucket.write(`${prefix}studio/ses_a/session.json`, {
    version: 2, id: 'ses_a', title: 'Maqueta de prueba', song_id: null, bpm: 120, beats_per_bar: 4, key: null, sample_rate: 48000,
    latency_offset_ms: 0, updated_at: '2026-11-19T10:00:00.000Z', updated_by: USER,
    assets: [{ id: 'ast_x', file: 'ast_x.mp3', kind: 'generated', label: PROMPT.slice(0, 60), channels: 2, sample_rate: 48000, duration_s: 30, size: AUDIO_TEXT.length, source: { provider: 'lyria', job_id: 'job_old', prompt: PROMPT } }],
    tracks: [
      { id: 'trk_1', kind: 'audio', name: PROMPT.slice(0, 40), role: 'keys', volume_db: 0, pan: 0, mute: false, solo: false, reverb_send_db: -60, fx: [], clips: [{ id: 'clp_1', asset_id: 'ast_x', start_s: 0, offset_s: 0, length_s: 30, gain_db: 0, fade_in_s: 0, fade_out_s: 0, take_group: null, active: true }] },
      { id: 'trk_2', kind: 'instrument', name: 'Bajo', role: 'bass', volume_db: 0, pan: 0, mute: false, solo: false, reverb_send_db: -60, fx: [], instrument: { type: 'synth', preset: 'bajo_sub', params: {} }, midi_clips: [{ id: 'mid_1', start_beat: 0, length_beats: 4, loop: false, loop_beats: 4, notes: [{ pitch: 40, start: 0, length: 1, velocity: 100 }, { pitch: 43, start: 1, length: 1, velocity: 90 }] }] },
    ],
    markers: [], master: { volume_db: 0, fx: [], reverb: { decay_s: 1.8, return_db: 0 } },
  });
  bucket.write(`${prefix}studio/ses_a/assets/ast_x.mp3`, AUDIO_TEXT);
  bucket.write(`${prefix}studio/ses_a/assets/ast_huerfano.mp3`, AUDIO_TEXT);
  bucket.write(`${prefix}studio/ses_b/session.json`, { version: 1, id: 'ses_b', title: 'Otra', updated_at: '2026-11-18T10:00:00.000Z', assets: [], tracks: [] });
  bucket.write(`${prefix}songs/song_1/manifest.json`, { version: 1, song_id: 'song_1', offset_ms: 0, stems: [] });
  bucket.write(`${prefix}songs/song_1/files/Voz.wav`, AUDIO_TEXT);
  bucket.write(`${prefix}songs/song_1/files/Bajo.wav`, `${AUDIO_TEXT}-bajo`);
  bucket.write(`${prefix}songs/song_2/analysis.json`, { job_id: 'm1', created_at: '2026-11-01T00:00:00Z' });
  // Gasto de otra banda en el contador global (el de esta banda lo escriben los trabajos de abajo).
  bucket.write('studio/_usage/2026-11.json', {
    month: '2026-11', total_usd: 1.5,
    entries: [{ at: '2026-11-02T00:00:00Z', job_id: 'job_z', kind: 'separate', provider: 'musicai', seconds: 180, cost_usd: 1.5, user: USER, scope: `bands/${OTHER_BAND}/studio/` }],
  });

  world.music = musicOk;
  assert.equal((await studio('POST', '/ses_a/jobs?job_id=job_ok', GENERATE)).status, 202);
  world.music = () => Response.json({ error: 'provider_error', detail: 'NO_AUDIO' }, { status: 502, headers: { 'X-Request-Id': 'ai_noaudio_002' } });
  assert.equal((await studio('POST', '/ses_a/jobs?job_id=job_fail', GENERATE)).status, 202);
  // Rechazo con un detalle que trae cosas con forma de clave: el evento debe guardarlo limpio.
  world.music = () => Response.json({ error: 'provider_error', detail: 'Bearer abcDEF1234567890ghijKLMN key=AIzaSyFAKEFAKE1234567890 boom' }, { status: 500 });
  const rejected = await studio('POST', '/ses_a/jobs?job_id=job_rej', GENERATE);
  assert.deepEqual([rejected.status, (await rejected.json()).error], [502, 'provider_failed']);
  await flush();
  return s;
}

function noLeaks(texts: string[]) {
  const all = texts.join('\n');
  for (const mark of [MCP_TOKEN, URIT_TOKEN, 'PROMPT-MARCADO', 'letra secreta', AUDIO_TEXT, AUDIO_B64, 'AIzaSyFAKE', 'abcDEF1234567890']) {
    assert.ok(!all.includes(mark), `una respuesta del MCP contiene "${mark.slice(0, 20)}"`);
  }
}

// --------------------------------------------------------------------------- acceso

test('acceso: sin MCP_TOKENS /mcp es 404; token malo o ausente, 401; sha256: tambien vale', async () => {
  const off = setup({ MCP_TOKENS: '' });
  for (const method of ['POST', 'GET', 'OPTIONS']) {
    const res = await handle(new Request(MCP_URL, { method, headers: { Authorization: `Bearer ${MCP_TOKEN}` } }), off.env);
    assert.equal(res.status, 404, method);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, 'sin CORS');
  }
  const { raw, env } = setup();
  const init = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await raw(init, { Authorization: 'Bearer otro-token-que-no-es-0000' })).status, 401);
  assert.equal((await raw(init, { Authorization: '' })).status, 401);
  assert.equal((await raw(init, { Authorization: `Bearer ${MCP_TOKEN}x` })).status, 401);
  const bad = await raw(init, { Authorization: 'Bearer corto' });
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('WWW-Authenticate'), 'Bearer');
  assert.deepEqual((await raw(init)).body, { jsonrpc: '2.0', id: 1, result: {} });
  // Varios tokens, uno guardado solo como SHA-256.
  const digest = createHash('sha256').update('segundo-token-solo-hash-9999').digest('hex');
  env.MCP_TOKENS = ` otro-token-cualquiera-1234 , sha256:${digest} `;
  assert.equal((await raw(init, { Authorization: 'Bearer segundo-token-solo-hash-9999' })).status, 200);
  assert.equal((await raw(init)).status, 401, 'el token anterior ya no esta en la lista');
  // CORS: una peticion con Origin del Hub no recibe cabeceras CORS en /mcp.
  env.MCP_TOKENS = MCP_TOKEN;
  const fromHub = await raw(init, { Origin: 'https://bandait.releven.cc' });
  assert.equal(fromHub.status, 403, 'un Origin ajeno se rechaza');
  assert.equal(fromHub.headers.get('Access-Control-Allow-Origin'), null);
});

test('protocolo crudo: metodo, Origin, Content-Type, version, notificaciones y errores', async () => {
  const { raw } = setup();
  assert.equal((await raw(null, {}, 'GET')).status, 405);
  assert.equal((await raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://stems.test' })).status, 200, 'el Origin propio vale');
  assert.equal((await raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);
  assert.equal((await raw('{no es json')).status, 400);
  assert.equal((await raw('x'.repeat(70 * 1024))).status, 400, 'cuerpo de mas de 64 KB');
  assert.equal((await raw({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await raw({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).body.error.code, -32601);
  assert.equal((await raw({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bandait_borrar_todo' } })).body.error.code, -32602);
  const invalid = await raw({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'bandait_sesiones', arguments: { band: BAND, extra: 1 } } });
  assert.equal(invalid.body.result.isError, true);
  assert.match(invalid.body.result.content[0].text, /argumento desconocido/);
  const badBand = await raw({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bandait_sesiones', arguments: { band: 'me' } } });
  assert.equal(badBand.body.result.isError, true);
  assert.match(badBand.body.result.content[0].text, /invalid_arguments/);
  const range = await raw({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'bandait_eventos', arguments: { limite: 500 } } });
  assert.equal(range.body.result.isError, true);
});

// --------------------------------------------------------------------------- cliente oficial

test('cliente oficial: initialize, tools/list con anotaciones de solo lectura', async () => {
  const { connect } = setup();
  const client = await connect();
  assert.equal(client.getServerVersion()?.name, 'bandait');
  assert.equal(client.getServerVersion()?.version, '1.2.0');
  assert.match(client.getInstructions() || '', /solo lectura/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), [
    'bandait_salud', 'bandait_eventos', 'bandait_trabajo_ver', 'bandait_gasto', 'bandait_sesiones',
    'bandait_sesion_resumen', 'bandait_stems', 'bandait_contrato',
  ]);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
    assert.equal(t.annotations?.destructiveHint, false, t.name);
    assert.ok(t.description && t.description.length > 20, t.name);
  }
  await client.close();
});

test('eventos: un exito y un fallo dejan su JSON en studio/_events/AAAA-MM-DD/ sin contenido; el rechazo, limpio', async () => {
  const { bucket } = await seeded();
  const keys = bucket.eventKeys();
  assert.equal(keys.length, 3);
  for (const k of keys) assert.match(k, /^studio\/_events\/2026-11-20\/031000000-[0-9a-f]{8}\.json$/);
  const events = keys.map((k) => bucket.json(k));
  const byJob = Object.fromEntries(events.map((e) => [e.job, e]));
  assert.deepEqual(byJob.job_ok, {
    at: '2026-11-20T03:10:00.000Z', band: `bands/${BAND}`, session: 'ses_a', job: 'job_ok', kind: 'generate', provider: 'lyria',
    status: 'SUCCEEDED', http: 200, provider_code: null, provider_detail: null, urit_request_id: 'ai_ok_001',
    model: 'lyria-3-clip-preview', duration_ms: 0, cost_usd: 0.04,
  });
  assert.deepEqual(
    [byJob.job_fail.status, byJob.job_fail.http, byJob.job_fail.provider_code, byJob.job_fail.provider_detail, byJob.job_fail.urit_request_id, byJob.job_fail.cost_usd],
    ['FAILED', 502, 'provider_error', 'NO_AUDIO', 'ai_noaudio_002', 0],
  );
  const rej = byJob.job_rej;
  assert.deepEqual([rej.status, rej.http, rej.provider_code, rej.cost_usd], ['REJECTED', 500, 'provider_error', null]);
  assert.ok(!/abcDEF|AIza|1234567890/.test(rej.provider_detail), rej.provider_detail);
  assert.match(rej.provider_detail, /Bearer \[oculto\]/);
  assert.ok(rej.provider_detail.length <= 80);
  // customMetadata para filtrar al listar.
  assert.deepEqual(bucket.objects.get(keys[0])!.custom!.band, `bands/${BAND}`);
  // Nada del pedido ni del audio en los eventos.
  const all = keys.map((k) => new TextDecoder().decode(bucket.objects.get(k)!.bytes)).join('\n');
  for (const mark of ['PROMPT-MARCADO', AUDIO_B64, URIT_TOKEN]) assert.ok(!all.includes(mark), mark);
  // El registro del trabajo guarda el id de URiT; la respuesta del GET (contrato) no cambia.
  assert.equal(bucket.json(`bands/${BAND}/studio/ses_a/jobs/job_ok.json`).urit_request_id, 'ai_ok_001');
  assert.equal(bucket.json(`bands/${BAND}/studio/ses_a/jobs/job_fail.json`).urit_request_id, 'ai_noaudio_002');
});

test('un fallo al escribir el evento no rompe ni retrasa el trabajo', async () => {
  const s = setup();
  const put = s.bucket.put.bind(s.bucket);
  s.bucket.put = async (key, value, options) => {
    if (key.startsWith(EVENTS_PREFIX)) throw new Error('R2 caido');
    return put(key, value, options);
  };
  s.world.music = musicOk;
  assert.equal((await s.studio('POST', '/ses_a/jobs?job_id=job_x', GENERATE)).status, 202);
  await s.flush();
  const done = await (await s.studio('GET', '/ses_a/jobs/job_x')).json();
  assert.equal(done.status, 'SUCCEEDED');
  assert.equal(s.bucket.eventKeys().length, 0);
});

test('herramientas con R2 simulado; ninguna respuesta trae tokens, prompts ni audio', async () => {
  const { connect, seen } = await seeded();
  const client = await connect();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!res.isError, `${name}: ${JSON.stringify(res.content)}`);
    return res.structuredContent as Record<string, any>;
  };

  const salud = await call('bandait_salud');
  assert.equal(salud.version, '1.2.0');
  assert.equal(salud.proveedores.urit_ai.configurado, true);
  assert.equal(salud.proveedores.musicai.configurado, false);
  assert.deepEqual(salud.topes_usd, { por_banda_mensual: 20, global_mensual: 30 });
  assert.equal(salud.lyria.modelo_clip, 'lyria-3-clip-preview');

  const eventos = await call('bandait_eventos', {});
  assert.equal(eventos.cantidad, 3);
  assert.deepEqual(new Set(eventos.events.map((e: any) => e.status)), new Set(['SUCCEEDED', 'FAILED', 'REJECTED']));
  const fallos = await call('bandait_eventos', { band: BAND, status: 'FAILED', provider: 'lyria', kind: 'generate', desde: '2026-11-20', hasta: '2026-11-20' });
  assert.deepEqual(fallos.events.map((e: any) => [e.job, e.provider_detail, e.urit_request_id]), [['job_fail', 'NO_AUDIO', 'ai_noaudio_002']]);
  assert.equal((await call('bandait_eventos', { band: OTHER_BAND })).cantidad, 0);
  assert.equal((await call('bandait_eventos', { hasta: '2026-11-19' })).cantidad, 0);
  assert.equal((await call('bandait_eventos', { limite: 1 })).cantidad, 1);

  const job = await call('bandait_trabajo_ver', { band: BAND, session: 'ses_a', job: 'job_ok' });
  assert.deepEqual([job.kind, job.provider, job.status, job.cost_usd, job.urit_request_id], ['generate', 'lyria', 'SUCCEEDED', 0.04, 'ai_ok_001']);
  assert.deepEqual(job.resultado.audios, [{ id: 'ast_t1', file: 'ast_t1.mp3', kind: 'generated', role: null, size: AUDIO_TEXT.length }]);
  assert.deepEqual(job.eventos.map((e: any) => e.status), ['SUCCEEDED']);
  const failedJob = await call('bandait_trabajo_ver', { band: `bands/${BAND}`, session: 'ses_a', job: 'job_fail' });
  assert.match(failedJob.error, /no devolvió audio/);
  const missing = await client.callTool({ name: 'bandait_trabajo_ver', arguments: { band: BAND, session: 'ses_a', job: 'job_rej' } });
  assert.equal(missing.isError, true, 'el rechazado no deja registro');

  const gasto = await call('bandait_gasto', { mes: '2026-11', band: BAND });
  assert.equal(gasto.global.total_usd, 1.54);
  assert.equal(gasto.global.tope_usd, 30);
  assert.deepEqual(gasto.bandas.map((b: any) => [b.band, b.total_usd]), [[`bands/${OTHER_BAND}`, 1.5], [`bands/${BAND}`, 0.04]]);
  assert.equal(gasto.contador_de_la_banda.total_usd, 0.04);
  assert.deepEqual(gasto.por_proveedor_usd, { musicai: 1.5, lyria: 0.04 });
  assert.equal((await call('bandait_gasto', { mes: '2026-10' })).global.existe, false);

  const sesiones = await call('bandait_sesiones', { band: BAND });
  assert.deepEqual(sesiones.sessions.map((x: any) => [x.id, x.version, x.title]), [['ses_a', 2, 'Maqueta de prueba'], ['ses_b', 1, 'Otra']]);

  const resumen = await call('bandait_sesion_resumen', { band: BAND, session: 'ses_a' });
  assert.equal(resumen.documento.version, 2);
  assert.deepEqual(resumen.pistas.map((p: any) => [p.id, p.kind, p.clips, p.clips_midi, p.notas]), [['trk_1', 'audio', 1, 0, 0], ['trk_2', 'instrument', 0, 1, 2]]);
  assert.deepEqual(resumen.audios_del_documento, [{ id: 'ast_x', kind: 'generated', size: AUDIO_TEXT.length, duration_s: 30, en_r2: true, origen: { provider: 'lyria', job_id: 'job_old' } }]);
  // ast_t1 lo dejo el generate de seeded(): esta en R2 y no en el documento.
  assert.deepEqual([resumen.audios_en_r2.cantidad, resumen.audios_en_r2.huerfanos, resumen.audios_en_r2.faltantes], [3, 2, 0]);
  assert.equal(resumen.trabajos.cantidad, 2);

  const stems = await call('bandait_stems', { band: BAND });
  assert.deepEqual(stems.songs, [
    { song: 'song_1', archivos: 2, bytes: AUDIO_TEXT.length * 2 + 5, manifiesto: true, analisis: false },
    { song: 'song_2', archivos: 0, bytes: 0, manifiesto: false, analisis: true },
  ]);

  const contrato = await call('bandait_contrato', { codigo: 'provider_failed' });
  assert.equal(contrato.http, 502);
  assert.ok(contrato.secciones.includes('STUDIO_V2.md 4.6'));
  assert.equal((await call('bandait_contrato', { codigo: 'no_audio' })).codigo, 'no_audio');
  assert.ok((await call('bandait_contrato')).codigos.length > 40);
  const unknown = await client.callTool({ name: 'bandait_contrato', arguments: { codigo: 'quota' } });
  assert.equal(unknown.isError, true);
  assert.match(JSON.stringify(unknown.content), /quota_exceeded/);

  await client.close();
  noLeaks(seen);
});

test('tope de subpeticiones: bandait_eventos corta y avisa con truncated', async () => {
  const { bucket, connect, seen } = setup();
  // 60 eventos sin customMetadata (hay que leerlos para filtrar) y un filtro que no coincide con ninguno.
  for (let i = 0; i < 60; i++) {
    bucket.write(`${EVENTS_PREFIX}2026-11-20/0300${String(i).padStart(5, '0')}-0000000${i % 10}.json`, {
      at: '2026-11-20T03:00:00.000Z', band: `bands/${OTHER_BAND}`, session: 'ses_a', job: `job_${i}`, kind: 'chat', provider: 'urit',
      status: 'FAILED', http: 502, provider_code: 'provider_error', provider_detail: null, urit_request_id: null, model: null, duration_ms: 1, cost_usd: 0,
    });
  }
  const client = await connect();
  const before = bucket.ops;
  const res = await client.callTool({ name: 'bandait_eventos', arguments: { band: BAND } });
  const data = res.structuredContent as Record<string, any>;
  assert.equal(data.truncated, true);
  assert.match(data.aviso, /tope de operaciones/);
  assert.ok(bucket.ops - before <= 45, `operaciones de R2: ${bucket.ops - before}`);
  await client.close();
  noLeaks(seen);
});

test('provider_detail: se limpia de claves y tokens y se recorta a 80 caracteres', () => {
  assert.equal(sanitizeDetail('NO_AUDIO'), 'NO_AUDIO');
  assert.equal(sanitizeDetail(null), null);
  assert.equal(sanitizeDetail('   '), null);
  assert.equal(sanitizeDetail('urit-ai: HTTP 502 provider_error NO_AUDIO'), 'urit-ai: HTTP 502 provider_error NO_AUDIO');
  assert.equal(sanitizeDetail('falta URIT_AI_TOKEN'), 'falta URIT_AI_TOKEN', 'el nombre de una variable no es un secreto');
  for (const leak of [
    'Authorization: Bearer abc.def.ghi', 'api_key=sk-proj-1234567890abcdef', 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.firma',
    'clave AIzaSyD1234567890abcdefghij rechazada', 'x-goog-api-key=ABCDEF', 'firma 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'password=hunter2', 'ghp_1234567890abcdefABCDEF',
  ]) {
    const clean = sanitizeDetail(leak)!;
    assert.ok(!/abc\.def|sk-proj|eyJ|AIza|ABCDEF$|9f86d0818|hunter2|ghp_/.test(clean), `${leak} -> ${clean}`);
  }
  const long = sanitizeDetail('a '.repeat(100))!;
  assert.equal(long.length, 80);
  assert.equal(sanitizeDetail('linea1\nlinea2\u0000'), 'linea1 linea2');
});

test('scheduled: borra los eventos de mas de 30 dias y respeta el tope de operaciones', async () => {
  const { bucket, env } = setup();
  const old = ['2026-09-30', '2026-10-01', '2026-10-20'];
  const recent = ['2026-10-21', '2026-11-19', '2026-11-20'];
  for (const day of [...old, ...recent]) {
    for (let i = 0; i < 3; i++) bucket.write(`${EVENTS_PREFIX}${day}/03000000${i}-aaaaaaaa.json`, { at: `${day}T03:00:00Z` });
  }
  bucket.write('studio/_usage/2026-09.json', { month: '2026-09', total_usd: 0, entries: [] });
  await scheduled({ scheduledTime: NOW.getTime(), cron: '17 4 * * *' }, env, { waitUntil: () => {} });
  const days = new Set(bucket.eventKeys().map((k) => k.slice(EVENTS_PREFIX.length, EVENTS_PREFIX.length + 10)));
  assert.deepEqual([...days].sort(), recent, 'el corte es hoy menos 30 dias (2026-10-21 se queda)');
  assert.ok(bucket.objects.has('studio/_usage/2026-09.json'), 'no toca nada fuera de studio/_events/');

  // Con poco cupo borra lo que alcanza y deja el resto para la proxima corrida.
  for (const day of old) for (let i = 0; i < 3; i++) bucket.write(`${EVENTS_PREFIX}${day}/03000000${i}-bbbbbbbb.json`, { at: day });
  const partial = await purgeEvents(env, NOW, 4);
  assert.equal(partial.truncated, true);
  assert.deepEqual(partial.deleted_days, ['2026-09-30']);
  const rest = await purgeEvents(env, NOW);
  assert.deepEqual([rest.truncated, rest.deleted_days], [false, ['2026-10-01', '2026-10-20']]);
});
