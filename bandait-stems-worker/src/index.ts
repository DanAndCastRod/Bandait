// BANDAIT STEMS WORKER v1. Stems of a band's songs in R2, shared between the hub
// (home study) and the leader (PA). Bandait has no backend: the Worker checks the
// caller's Supabase session itself, with the caller's own JWT and the anon key (no
// service_role anywhere), through the RPC bandait_band_role(band) that the shared
// bands SQL already grants to authenticated users. RLS stays the source of truth.
//
//   GET    /v1/health
//   GET    /v1/bands/{band}/songs/{song}/manifest        any member
//   PUT    /v1/bands/{band}/songs/{song}/manifest        Owner / MusicDirector
//   GET    /v1/bands/{band}/songs/{song}/files/{name}    any member
//   PUT    /v1/bands/{band}/songs/{song}/files/{name}    Owner / MusicDirector
//   DELETE /v1/bands/{band}/songs/{song}                 Owner / MusicDirector
//   POST   /v1/bands/{band}/songs/{song}/analysis        Owner / MusicDirector (Music AI)
//          ?separate=1: the body is the whole song; the workflow also separates stems
//   GET    /v1/bands/{band}/songs/{song}/analysis        any member: state and draft; for a
//          separation, each call copies one stem to R2 (IMPORTING) and then writes the manifest
//
// {band} is a shared band uuid, or "me" for the caller's personal workspace (only the
// caller can read or write it). Upload the files first, then the manifest: the
// manifest is the commit (every file it lists must exist with that size) and files
// it no longer lists are deleted.

import { ASSEMBLER_VERSION, assemble } from './analysis.ts';
import type { MusicAiResult } from './analysis.ts';
import type { Env, FetchLike, R2Bucket } from './types.ts';

export const VERSION = '1.0.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SONG = /^[A-Za-z0-9_-]{1,80}$/;
const FILE = /^[A-Za-z0-9 ._()-]{1,120}$/;
const AUDIO_EXT = /\.(mp3|m4a|wav|flac|ogg|aac)$/i;
const ROLE = /^[a-z_]{1,32}$/;
const EDITORS = new Set(['Owner', 'MusicDirector']);
const MANIFEST_LIMIT = 64 * 1024;
const MAX_STEMS = 16;
const DEFAULT_MAX_FILE_MB = 200;

class ApiError extends Error {
  status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

export interface StemEntry {
  file: string;
  role: string;
  label: string;
  size: number;
}

export interface Manifest {
  version: 1;
  song_id: string;
  offset_ms: number;
  stems: StemEntry[];
  updated_at?: string;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length, ETag',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function bearer(req: Request): string {
  const value = req.headers.get('Authorization') || '';
  const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(value);
  if (!m) throw new ApiError(401, 'missing_token');
  return m[1];
}

/** Prefix the caller may use, after checking the session (and the role for writes). */
export async function authorize(
  req: Request, env: Env, band: string, write: boolean, fetchFn: FetchLike,
): Promise<string> {
  const token = bearer(req);
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  const headers = { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` };
  let res: Response;
  try {
    res = band === 'me'
      ? await fetchFn(`${base}/auth/v1/user`, { headers })
      : await fetchFn(`${base}/rest/v1/rpc/bandait_band_role`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_band: band }),
      });
  } catch {
    throw new ApiError(502, 'auth_unavailable');
  }
  if (res.status === 401 || res.status === 403) throw new ApiError(401, 'invalid_token');
  if (!res.ok) throw new ApiError(502, 'auth_unavailable');
  const body = await res.json().catch(() => null) as unknown;
  if (band === 'me') {
    const id = body && typeof body === 'object' ? (body as { id?: unknown }).id : null;
    if (typeof id !== 'string' || !UUID.test(id)) throw new ApiError(401, 'invalid_token');
    return `users/${id}/`;
  }
  if (typeof body !== 'string') throw new ApiError(403, 'not_a_member');
  if (write && !EDITORS.has(body)) throw new ApiError(403, 'not_an_editor');
  return `bands/${band}/`;
}

function parseManifest(raw: unknown, song: string): Manifest {
  if (!raw || typeof raw !== 'object') throw new ApiError(400, 'bad_manifest');
  const m = raw as Record<string, unknown>;
  const offset = m.offset_ms === undefined ? 0 : m.offset_ms;
  if (m.version !== 1 || m.song_id !== song || typeof offset !== 'number' || !Number.isFinite(offset)
    || Math.abs(offset) > 10000 || !Array.isArray(m.stems) || m.stems.length < 1 || m.stems.length > MAX_STEMS) {
    throw new ApiError(400, 'bad_manifest');
  }
  const seen = new Set<string>();
  const stems = m.stems.map((s): StemEntry => {
    if (!s || typeof s !== 'object') throw new ApiError(400, 'bad_manifest');
    const e = s as Record<string, unknown>;
    if (typeof e.file !== 'string' || !validFile(e.file) || seen.has(e.file.toLowerCase())
      || typeof e.role !== 'string' || !ROLE.test(e.role)
      || typeof e.label !== 'string' || e.label.length < 1 || e.label.length > 60
      || typeof e.size !== 'number' || !Number.isSafeInteger(e.size) || e.size < 1) {
      throw new ApiError(400, 'bad_manifest');
    }
    seen.add(e.file.toLowerCase());
    return { file: e.file, role: e.role, label: e.label, size: e.size };
  });
  return { version: 1, song_id: song, offset_ms: Math.round(offset), stems };
}

function validFile(name: string): boolean {
  return FILE.test(name) && AUDIO_EXT.test(name) && !name.startsWith('.') && !name.includes('..');
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function route(req: Request, env: Env, fetchFn: FetchLike): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/v1/health' && req.method === 'GET') return json(200, { ok: true, version: VERSION });
  const m = /^\/v1\/bands\/([^/]+)\/songs\/([^/]+)(?:\/(manifest|analysis|files\/([^/]+)))?$/.exec(url.pathname);
  if (!m) throw new ApiError(404, 'not_found');
  const band = m[1];
  const song = m[2];
  if (band !== 'me' && !UUID.test(band)) throw new ApiError(400, 'bad_band');
  if (!SONG.test(song)) throw new ApiError(400, 'bad_song');
  const what = m[3];
  let file: string | null = null;
  if (m[4] !== undefined) {
    try {
      file = decodeURIComponent(m[4]);
    } catch {
      throw new ApiError(400, 'bad_file');
    }
    if (!validFile(file)) throw new ApiError(400, 'bad_file');
  }
  const method = req.method;
  if (what === 'analysis') {
    if (method !== 'POST' && method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    // Starting an analysis spends Music AI credits: editors only. Reading the draft is free: any
    // member can see it (read-only in the hub; only Owner / MusicDirector can accept it).
    const editorPrefix = await authorize(req, env, band, method === 'POST', fetchFn);
    return method === 'POST'
      ? startAnalysis(req, env, `${editorPrefix}songs/${song}/`, song, fetchFn, url.searchParams.get('separate') === '1')
      : analysisStatus(env, `${editorPrefix}songs/${song}/`, song, fetchFn);
  }
  const write = method === 'PUT' || method === 'DELETE';
  if (!['GET', 'PUT', 'DELETE'].includes(method) || (what === undefined) !== (method === 'DELETE')) {
    throw new ApiError(405, 'method_not_allowed');
  }
  const prefix = await authorize(req, env, band, write, fetchFn);
  const songPrefix = `${prefix}songs/${song}/`;
  const bucket = env.STEMS;

  if (method === 'DELETE') {
    const keys = await listAll(bucket, songPrefix);
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    return json(200, { deleted: keys.length });
  }

  if (what === 'manifest') {
    const key = `${songPrefix}manifest.json`;
    if (method === 'GET') {
      const obj = await bucket.get(key);
      if (!obj) throw new ApiError(404, 'no_stems');
      return new Response(obj.body, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: obj.httpEtag },
      });
    }
    const length = Number(req.headers.get('Content-Length') || '0');
    if (length > MANIFEST_LIMIT) throw new ApiError(413, 'manifest_too_large');
    const text = await req.text();
    if (text.length > MANIFEST_LIMIT) throw new ApiError(413, 'manifest_too_large');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiError(400, 'bad_manifest');
    }
    const manifest = parseManifest(raw, song);
    for (const stem of manifest.stems) {
      const head = await bucket.head(`${songPrefix}files/${stem.file}`);
      if (!head || head.size !== stem.size) throw new ApiError(409, 'missing_file');
    }
    manifest.updated_at = new Date().toISOString();
    await bucket.put(key, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
    const keep = new Set(manifest.stems.map((s) => `${songPrefix}files/${s.file}`));
    const stale = (await listAll(bucket, `${songPrefix}files/`)).filter((k) => !keep.has(k));
    if (stale.length) await bucket.delete(stale);
    return json(200, manifest);
  }

  const key = `${songPrefix}files/${file}`;
  if (method === 'GET') {
    const obj = await bucket.get(key);
    if (!obj) throw new ApiError(404, 'no_file');
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': String(obj.size),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        ETag: obj.httpEtag,
      },
    });
  }
  const lengthHeader = req.headers.get('Content-Length');
  const length = lengthHeader === null ? NaN : Number(lengthHeader);
  const maxBytes = Number(env.MAX_FILE_MB || DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  if (!Number.isSafeInteger(length) || length < 1) throw new ApiError(411, 'length_required');
  if (length > maxBytes) throw new ApiError(413, 'file_too_large');
  if (!req.body) throw new ApiError(400, 'empty_body');
  const type = (req.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('audio/') && type !== 'application/octet-stream') throw new ApiError(415, 'not_audio');
  const stored = await bucket.put(key, req.body, { httpMetadata: { contentType: type } });
  if (!stored || stored.size !== length) {
    await bucket.delete(key);
    throw new ApiError(400, 'incomplete_upload');
  }
  return json(200, { file, size: stored.size });
}

// --------------------------------------------------------------------------- Music AI
const MUSICAI = 'https://api.music.ai/v1';
const ANALYSIS_MAX_BYTES = 95 * 1024 * 1024;
const RESULT_CAP = 2 * 1024 * 1024;

function musicAiKey(env: Env): string {
  const key = (env.MUSICAI_API_KEY || '').trim();
  if (!key) throw new ApiError(503, 'analysis_unavailable');
  return key;
}

async function musicAi(env: Env, fetchFn: FetchLike, path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${MUSICAI}${path}`, {
      ...init,
      headers: { Authorization: musicAiKey(env), 'Content-Type': 'application/json', ...((init.headers as Record<string, string>) || {}) },
    });
  } catch {
    throw new ApiError(502, 'analysis_unavailable');
  }
  if (res.status === 401 || res.status === 403) throw new ApiError(502, 'analysis_auth_failed');
  if (!res.ok) throw new ApiError(502, 'analysis_failed');
  return res.json();
}

/** POST .../analysis with the song mix as body: upload it to Music AI and start the workflow. */
async function startAnalysis(
  req: Request, env: Env, songPrefix: string, song: string, fetchFn: FetchLike, separate = false,
): Promise<Response> {
  musicAiKey(env);
  const length = Number(req.headers.get('Content-Length') ?? NaN);
  if (!Number.isSafeInteger(length) || length < 1) throw new ApiError(411, 'length_required');
  if (length > ANALYSIS_MAX_BYTES) throw new ApiError(413, 'file_too_large');
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('audio/')) throw new ApiError(415, 'not_audio');
  if (!req.body) throw new ApiError(400, 'empty_body');
  const upload = await musicAi(env, fetchFn, '/upload', { method: 'GET' }) as { uploadUrl?: string; downloadUrl?: string };
  if (!upload.uploadUrl || !upload.downloadUrl) throw new ApiError(502, 'analysis_failed');
  // Signed storage URLs want a known length: FixedLengthStream in Workers, the body as is in tests.
  const FLS = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  let body: ReadableStream = req.body;
  if (FLS) {
    const fixed = new FLS(length);
    req.body.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  }
  let put: Response;
  try {
    put = await fetchFn(upload.uploadUrl, { method: 'PUT', body, headers: { 'Content-Type': type } });
  } catch {
    throw new ApiError(502, 'analysis_upload_failed');
  }
  if (!put.ok) throw new ApiError(502, 'analysis_upload_failed');
  const job = await musicAi(env, fetchFn, '/job', {
    method: 'POST',
    body: JSON.stringify({
      name: `bandait-${song}`,
      workflow: separate
        ? env.MUSICAI_SPLIT_WORKFLOW || 'splited_stems_bandait'
        : env.MUSICAI_WORKFLOW || 'stems-workflow-releven-bandait',
      params: { inputUrl: upload.downloadUrl },
    }),
  }) as { id?: string };
  if (!job.id) throw new ApiError(502, 'analysis_failed');
  const record = { job_id: job.id, created_at: new Date().toISOString(), ...(separate ? { separate: true } : {}) };
  await env.STEMS.put(`${songPrefix}analysis.json`, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  return json(202, { status: 'STARTED', job_id: job.id, separate });
}

/** Stem outputs of the separation workflow: output name -> [role, label]. Anything else is analysis. */
const STEM_OUTPUTS: Record<string, [string, string]> = {
  vocals: ['vocals', 'Voz'], 'backing vocals': ['backing_vocals', 'Coros'], drums: ['drums', 'Batería'],
  bass: ['bass', 'Bajo'], guitars: ['guitar', 'Guitarras'], guitar: ['guitar', 'Guitarra'],
  keys: ['keys', 'Teclados'], piano: ['keys', 'Piano'], strings: ['strings', 'Cuerdas'],
  wind: ['wind', 'Vientos'], other: ['other', 'Otros'],
};

function stemExt(type: string, url: string): string {
  if (type.includes('flac')) return 'flac';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  const m = /\.(wav|flac|mp3|m4a|ogg|aac)(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : 'wav';
}

interface AnalysisRecord {
  job_id: string; created_at: string; draft?: unknown; status?: string; error?: string;
  assembler?: number; result?: Record<string, unknown>;
  /** Separation job: stems copied so far (output name -> file in R2 and size) and the manifest. */
  separate?: boolean; copied?: Record<string, { file: string; size: number }>; manifest?: Manifest;
}

/**
 * Copies the next stem of a separation job from Music AI to R2: one per call, so a GET never runs
 * long (a 4 min stem is ~43 MB of WAV). Returns true while stems are left to copy.
 */
async function copyNextStem(
  env: Env, songPrefix: string, record: AnalysisRecord, stems: [string, string][], fetchFn: FetchLike,
): Promise<boolean> {
  record.copied ??= {};
  const next = stems.find(([name]) => !record.copied![name]);
  if (!next) return false;
  const [name, url] = next;
  let res: Response;
  try {
    res = await fetchFn(url, {});
  } catch {
    throw new ApiError(502, 'stems_copy_failed');
  }
  const length = Number(res.headers.get('Content-Length') ?? NaN);
  if (!res.ok || !res.body || !Number.isSafeInteger(length) || length < 1) throw new ApiError(502, 'stems_copy_failed');
  const maxBytes = Number(env.MAX_FILE_MB || DEFAULT_MAX_FILE_MB) * 1024 * 1024;
  if (length > maxBytes) throw new ApiError(502, 'stems_copy_failed');
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const ext = stemExt(type, url);
  const file = `${name.replace(/[^A-Za-z0-9 ._()-]/g, '').trim() || 'Stem'}.${ext}`;
  const FLS = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  let body: ReadableStream = res.body;
  if (FLS) {
    const fixed = new FLS(length);
    res.body.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  }
  const contentType = type.startsWith('audio/') ? type : `audio/${ext === 'mp3' ? 'mpeg' : ext}`;
  const stored = await env.STEMS.put(`${songPrefix}files/${file}`, body, { httpMetadata: { contentType } });
  if (!stored || stored.size !== length) throw new ApiError(502, 'stems_copy_failed');
  record.copied[name] = { file, size: length };
  return stems.some(([n]) => !record.copied![n]);
}

/** Manifest of the separated stems: replaces whatever the song had (files it no longer lists go). */
async function commitSeparatedStems(env: Env, songPrefix: string, song: string, record: AnalysisRecord, stems: [string, string][]): Promise<Manifest> {
  const entries: StemEntry[] = stems.map(([name]) => {
    const [role, label] = STEM_OUTPUTS[name.toLowerCase()] ?? ['other', name.slice(0, 60)];
    return { file: record.copied![name].file, role, label, size: record.copied![name].size };
  });
  const manifest: Manifest = { version: 1, song_id: song, offset_ms: 0, stems: entries, updated_at: new Date().toISOString() };
  await env.STEMS.put(`${songPrefix}manifest.json`, JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
  const keep = new Set(entries.map((e) => `${songPrefix}files/${e.file}`));
  const stale = (await listAll(env.STEMS, `${songPrefix}files/`)).filter((k) => !keep.has(k));
  if (stale.length) await env.STEMS.delete(stale);
  return manifest;
}

/** GET .../analysis: state of the song's last job; when it finishes, the assembled draft. */
async function analysisStatus(env: Env, songPrefix: string, song: string, fetchFn: FetchLike): Promise<Response> {
  const key = `${songPrefix}analysis.json`;
  const stored = await env.STEMS.get(key);
  if (!stored) throw new ApiError(404, 'no_analysis');
  const record = JSON.parse(await stored.text()) as AnalysisRecord;
  const save = () => env.STEMS.put(key, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
  const succeeded = (draft: unknown) => json(200, {
    status: 'SUCCEEDED', job_id: record.job_id, created_at: record.created_at, draft,
    ...(record.manifest ? { stems: record.manifest } : {}),
  });
  const done = async (result: Record<string, unknown>) => {
    // The raw result is kept so a newer assembler re-reads it without calling Music AI again.
    const draft = assemble(result as MusicAiResult);
    Object.assign(record, { draft, result, assembler: ASSEMBLER_VERSION, status: 'SUCCEEDED' });
    await save();
    return succeeded(draft);
  };
  const separationPending = record.separate && !record.manifest;
  if (!separationPending && record.draft && record.assembler === ASSEMBLER_VERSION) return succeeded(record.draft);
  if (!separationPending && record.result) return done(record.result);
  if (record.status === 'FAILED') return json(200, { status: 'FAILED', job_id: record.job_id, error: record.error });
  const job = await musicAi(env, fetchFn, `/job/${encodeURIComponent(record.job_id)}`, { method: 'GET' }) as {
    status?: string; result?: Record<string, unknown>; error?: { message?: string };
  };
  if (job.status === 'FAILED') {
    record.status = 'FAILED';
    record.error = String(job.error?.message || 'Music AI no pudo analizar la canción').slice(0, 300);
    await save();
    return json(200, { status: 'FAILED', job_id: record.job_id, error: record.error });
  }
  if (job.status !== 'SUCCEEDED' || !job.result) return json(200, { status: job.status || 'STARTED', job_id: record.job_id });

  const stems: [string, string][] = [];
  const outputs: [string, unknown][] = [];
  for (const [name, value] of Object.entries(job.result)) {
    if (record.separate && STEM_OUTPUTS[name.toLowerCase()] && typeof value === 'string' && value.startsWith('https://')) stems.push([name, value]);
    else outputs.push([name, value]);
  }
  if (record.separate && !record.manifest) {
    if (!stems.length) {
      record.status = 'FAILED';
      record.error = 'Music AI no devolvió stems: revisa que el workflow de separación los tenga como salidas.';
      await save();
      return json(200, { status: 'FAILED', job_id: record.job_id, error: record.error });
    }
    const more = await copyNextStem(env, songPrefix, record, stems, fetchFn);
    if (more) {
      await save();
      return json(200, { status: 'IMPORTING', job_id: record.job_id, done: Object.keys(record.copied ?? {}).length, total: stems.length });
    }
    record.manifest = await commitSeparatedStems(env, songPrefix, song, record, stems);
    await save();
  }
  const result: Record<string, unknown> = {};
  for (const [name, value] of outputs) {
    if (typeof value === 'string' && value.startsWith('https://')) {
      const res = await fetchFn(value, {}).catch(() => null);
      if (!res || !res.ok) continue;
      // An audio output in the analysis workflow is not read: only JSON results matter here.
      const size = Number(res.headers.get('Content-Length') ?? 0);
      if (size > RESULT_CAP || (res.headers.get('Content-Type') || '').startsWith('audio/')) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const text = await res.text();
      if (text.length > RESULT_CAP) continue;
      try {
        result[name] = JSON.parse(text);
      } catch {
        // not JSON: ignored
      }
    } else {
      result[name] = value;
    }
  }
  return done(result);
}

export async function handle(req: Request, env: Env, fetchFn: FetchLike = fetch): Promise<Response> {
  const cors = corsHeaders(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: cors['Access-Control-Allow-Origin'] ? 204 : 403, headers: cors });
  let res: Response;
  try {
    res = await route(req, env, fetchFn);
  } catch (err) {
    res = err instanceof ApiError ? json(err.status, { error: err.message }) : json(500, { error: 'internal' });
  }
  for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, (input, init) => fetch(input, init));
  },
};
