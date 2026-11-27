// Rutas del Estudio Bandait. Contrato normativo: bandait-protocol/STUDIO_V1.md, con los cambios de
// STUDIO_V2.md (documento v2 de hasta 1 MiB; trabajos compose, analyze y chat).
//
//   GET    /v1/bands/{band}/studio                              integrante
//   GET    /v1/bands/{band}/studio/{session}/session            integrante
//   PUT    /v1/bands/{band}/studio/{session}/session            Owner / MusicDirector (If-Match o If-None-Match: *)
//   DELETE /v1/bands/{band}/studio/{session}                    Owner / MusicDirector
//   PUT    /v1/bands/{band}/studio/{session}/assets/{asset}     Owner / MusicDirector (audio inmutable)
//   GET    /v1/bands/{band}/studio/{session}/assets/{asset}     integrante (admite Range)
//   POST   /v1/bands/{band}/studio/{session}/jobs[?estimate=1]  Owner / MusicDirector (src/studioJobs.ts)
//   GET    /v1/bands/{band}/studio/{session}/jobs/{job}         integrante
//   GET    /v1/bands/{band}/studio/{session}/vcs                integrante (src/studioVcs.ts)
//   POST   /v1/bands/{band}/studio/{session}/vcs                colaboradores (STUDIO_COLLABORATORS)
//   DELETE /v1/bands/{band}/studio/{session}/vcs/branches/{b}   Owner / MusicDirector
//   GET    /v1/bands/{band}/studio/{session}/commits/{commit}   integrante
//   GET    /v1/bands/{band}/studio/_cleanup                     integrante: audios huerfanos, sin borrar
//   POST   /v1/bands/{band}/studio/_cleanup                     Owner / MusicDirector: los borra (src/studioCleanup.ts)
//
// En R2, bajo el prefijo de la banda: studio/<session>/session.json, studio/<session>/assets/<file>,
// studio/<session>/jobs/<job>.json, studio/_usage/AAAA-MM.json y studio/_cleanup/last.json.
//
// Este modulo e index.ts se importan entre si: aqui no se usa nada de index.ts al cargar el modulo,
// solo dentro de funciones.

import { ApiError, authorize, authorizeWithRole, isEditorRole, json, listAll, type AccessLevel } from './index.ts';
import { OpBudget } from './events.ts';
import { CLEANUP_REQUEST_MAX_OPS, cleanupScope, opportunisticCleanup } from './studioCleanup.ts';
import type { CleanupReport } from './studioCleanup.ts';
import { jobStatus, startJob } from './studioJobs.ts';
import {
  ASSET_MAX_BYTES, ID_RE, SESSION_MAX_BYTES, SessionError, assetExtension, isAssetFile, validateSession,
} from './studioSession.ts';
import type { SessionDocument } from './studioSession.ts';
import { deleteVcsBranch, getCommit, getVcs, isBranchName, postVcs } from './studioVcs.ts';
import type { Env, FetchLike, R2Object, StudioDeps } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `/v1/bands/{band}/studio/_cleanup`: no choca con una sesion (los ids con `_` estan reservados). */
const CLEANUP_SEGMENT = '_cleanup';
const MAX_LISTED_SESSIONS = 500;
const LIST_CONCURRENCY = 16;
/** Tope de audios en `assets/` de una sesion: el de un documento (256) mas margen para mezclas y trabajos. */
export const MAX_SESSION_ASSET_FILES = 320;

export const ASSET_CONTENT_TYPES: Record<string, string> = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' };

export function defaultStudioDeps(): StudioDeps {
  return {
    now: () => new Date(),
    newId: (prefix) => {
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      let hex = '';
      for (const b of bytes) hex += b.toString(16).padStart(2, '0');
      return `${prefix}_${hex}`;
    },
  };
}

/** Lo que cada ruta del Estudio necesita saber de quien llama. */
export interface StudioContext {
  env: Env;
  fetchFn: FetchLike;
  deps: StudioDeps;
  /** Prefijo de la banda en R2 mas "studio/". */
  studioPrefix: string;
  /** Prefijo de la sesion: `${studioPrefix}${session}/`. */
  sessionPrefix: string;
  session: string;
  /** uuid del usuario (el `sub` del token), o null si el token no lo trae. */
  user: string | null;
  /** Rol verificado por Supabase en la banda (`Owner` en el workspace personal). */
  role: string;
  /** Nombre visible sacado del token verificado (STUDIO_V2.md 7.2: `author_name`). */
  userName: string;
}

/**
 * Nombre visible del JWT de Supabase: `user_metadata.full_name`, `user_metadata.name` o la parte
 * local del correo. Igual que tokenSubject, la firma ya la comprobo Supabase en authorize(): el
 * nombre no lo elige el cliente en el cuerpo de la peticion.
 */
export function tokenDisplayName(req: Request): string {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const payload = token.split('.')[1];
  if (!payload) return 'Integrante';
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as { email?: unknown; user_metadata?: unknown };
    const meta = claims.user_metadata && typeof claims.user_metadata === 'object' ? claims.user_metadata as Record<string, unknown> : {};
    const pick = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '');
    const name = pick(meta.full_name) || pick(meta.name);
    if (name) return name;
    const email = pick(claims.email);
    const local = email.includes('@') ? email.slice(0, email.indexOf('@')) : '';
    return local || 'Integrante';
  } catch {
    return 'Integrante';
  }
}

/**
 * `sub` del JWT de Supabase. No valida la firma: authorize() ya comprobo la sesion contra
 * Supabase con ese mismo token; aqui solo se lee quien es para `updated_by` y el registro de gasto.
 */
export function tokenSubject(req: Request): string | null {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    const sub = (JSON.parse(new TextDecoder().decode(bytes)) as { sub?: unknown }).sub;
    return typeof sub === 'string' && UUID.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Quien puede gastar creditos de IA. Con STUDIO_SPENDER_UIDS vacia, cualquier editor (y cualquier
 * cuenta sobre su workspace `me`); con valor, solo los uuid listados. Lanza 403 `not_a_spender`.
 */
export function assertSpender(env: Env, user: string | null): void {
  const allowed = (env.STUDIO_SPENDER_UIDS || '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) return;
  if (!user || !allowed.includes(user)) throw new ApiError(403, 'not_a_spender');
}

/**
 * Lee el cuerpo como texto sin pasar de `limit` bytes: corta en cuanto se supera, sin fiarse de
 * Content-Length (puede faltar o mentir). Devuelve null si el cuerpo es mas grande.
 */
export async function readLimited(req: Request, limit: number): Promise<string | null> {
  if (Number(req.headers.get('Content-Length') || '0') > limit) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** ETag sin `W/` ni comillas, para comparar lo que manda el cliente con R2Object.etag. */
function bareEtag(value: string): string {
  return value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

export async function studioRoute(
  req: Request, env: Env, url: URL, fetchFn: FetchLike, deps: StudioDeps,
): Promise<Response> {
  const parts = url.pathname.split('/').slice(3); // [band, 'studio', ...]
  const band = parts[0];
  const rest = parts.slice(2);
  if (rest.length && rest[rest.length - 1] === '') rest.pop();
  if (band !== 'me' && !UUID.test(band)) throw new ApiError(400, 'bad_band');
  const method = req.method;

  if (rest.length === 0) {
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    const prefix = await authorize(req, env, band, false, fetchFn);
    return listSessions(env, `${prefix}studio/`);
  }

  // Audios huerfanos (src/studioCleanup.ts): GET inspecciona (integrante), POST borra (Owner /
  // MusicDirector, la misma autorizacion de las escrituras).
  if (rest.length === 1 && rest[0] === CLEANUP_SEGMENT) {
    if (method !== 'GET' && method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    const remove = method === 'POST';
    const prefix = await authorize(req, env, band, remove, fetchFn);
    const report = await cleanupScope(env, deps, `${prefix}studio/`, new OpBudget(CLEANUP_REQUEST_MAX_OPS), { remove, trigger: 'manual' });
    return json(200, publicCleanupReport(report));
  }

  const session = rest[0];
  if (!ID_RE.test(session) || session.startsWith('_')) throw new ApiError(400, 'bad_session_id');
  const what = rest[1];
  const leaf = rest[2];
  let access: AccessLevel;
  if (rest.length === 1) {
    if (method !== 'DELETE') throw new ApiError(405, 'method_not_allowed');
    access = true;
  } else if (what === 'session' && rest.length === 2) {
    if (method !== 'GET' && method !== 'PUT') throw new ApiError(405, 'method_not_allowed');
    access = method === 'PUT' ? 'collab' : false;
  } else if (what === 'assets' && rest.length === 3) {
    if (!isAssetFile(leaf)) throw new ApiError(400, 'bad_asset');
    if (method !== 'GET' && method !== 'PUT') throw new ApiError(405, 'method_not_allowed');
    access = method === 'PUT' ? 'collab' : false;
  } else if (what === 'vcs' && rest.length === 2) {
    if (method !== 'GET' && method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    access = method === 'POST' ? 'collab' : false;
  } else if (what === 'vcs' && rest.length === 4 && leaf === 'branches') {
    // DELETE .../vcs/branches/{branch}: borrar una rama es de Owner y MusicDirector.
    if (!isBranchName(rest[3])) throw new ApiError(400, 'bad_vcs');
    if (method !== 'DELETE') throw new ApiError(405, 'method_not_allowed');
    access = true;
  } else if (what === 'commits' && rest.length === 3) {
    if (!ID_RE.test(leaf)) throw new ApiError(400, 'bad_commit');
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    access = false;
  } else if (what === 'jobs' && rest.length === 2) {
    if (method !== 'POST') throw new ApiError(405, 'method_not_allowed');
    access = true;
  } else if (what === 'jobs' && rest.length === 3) {
    if (!ID_RE.test(leaf)) throw new ApiError(400, 'bad_job');
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    access = false;
  } else {
    throw new ApiError(404, 'not_found');
  }

  // Colaborar en sesion/audios/VCS: STUDIO_COLLABORATORS. Borrar sesion o lanzar trabajos IA: Owner y MusicDirector. Leer: cualquier integrante.
  const { prefix, role } = await authorizeWithRole(req, env, band, access, fetchFn);
  const studioPrefix = `${prefix}studio/`;
  const ctx: StudioContext = {
    env, fetchFn, deps, studioPrefix, sessionPrefix: `${studioPrefix}${session}/`, session, user: tokenSubject(req),
    role, userName: tokenDisplayName(req),
  };

  if (rest.length === 1) return deleteSession(ctx);
  if (what === 'session') return method === 'GET' ? getSession(ctx) : putSession(req, ctx);
  if (what === 'assets') return method === 'GET' ? getAsset(req, ctx, leaf) : putAsset(req, ctx, leaf);
  if (what === 'vcs' && rest.length === 4) return deleteVcsBranch(ctx, rest[3]);
  if (what === 'vcs') return method === 'GET' ? getVcs(ctx) : postVcs(req, ctx);
  if (what === 'commits') return getCommit(ctx, leaf);
  if (rest.length === 2) return startJob(req, ctx, url.searchParams.get('estimate') === '1', url.searchParams.get('job_id'));
  return jobStatus(ctx, leaf);
}

// --------------------------------------------------------------------------- sesiones

async function listSessions(env: Env, studioPrefix: string): Promise<Response> {
  // Todas las carpetas, hasta el final: cortar la paginacion antes de ordenar dejaria fuera
  // sesiones por orden alfabetico de id, no por fecha.
  const folders: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STEMS.list({ prefix: studioPrefix, delimiter: '/', cursor, limit: 1000 });
    for (const folder of page.delimitedPrefixes ?? []) {
      const id = folder.slice(studioPrefix.length, -1);
      if (!id.startsWith('_') && ID_RE.test(id)) folders.push(folder);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  type Listed = { id: string; title: string; song_id: string | null; updated_at: string };
  const read = async (folder: string): Promise<Listed | null> => {
    // Una carpeta sin session.json es una sesion a medio crear (audios subidos antes del documento).
    const obj = await env.STEMS.get(`${folder}session.json`);
    if (!obj) return null;
    try {
      const doc = JSON.parse(await obj.text()) as Partial<SessionDocument>;
      if (typeof doc.title !== 'string' || typeof doc.updated_at !== 'string') return null;
      return { id: folder.slice(studioPrefix.length, -1), title: doc.title, song_id: typeof doc.song_id === 'string' ? doc.song_id : null, updated_at: doc.updated_at };
    } catch {
      return null; // documento ilegible: no se lista
    }
  };
  // Lecturas en tandas, no en serie. El tope protege a la peticion; si se alcanza, la respuesta lo dice.
  const scanned = folders.slice(0, MAX_LISTED_SESSIONS);
  const sessions: Listed[] = [];
  for (let i = 0; i < scanned.length; i += LIST_CONCURRENCY) {
    const batch = await Promise.all(scanned.slice(i, i + LIST_CONCURRENCY).map(read));
    for (const item of batch) if (item) sessions.push(item);
  }
  sessions.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return json(200, folders.length > scanned.length ? { sessions, truncated: true } : { sessions });
}

async function getSession(ctx: StudioContext): Promise<Response> {
  const obj = await ctx.env.STEMS.get(`${ctx.sessionPrefix}session.json`);
  if (!obj) throw new ApiError(404, 'no_session');
  return new Response(obj.body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ETag: obj.httpEtag },
  });
}

async function putSession(req: Request, ctx: StudioContext): Promise<Response> {
  const ifMatch = req.headers.get('If-Match');
  const ifNoneMatch = req.headers.get('If-None-Match');
  const create = ifNoneMatch !== null && ifNoneMatch.trim() === '*';
  // Exactamente una de las dos: `If-None-Match: *` (crear) o `If-Match: <etag>` (reemplazar).
  if ((ifMatch === null) === !create || (ifNoneMatch !== null && !create)) throw new ApiError(428, 'precondition_required');
  if (ifMatch !== null && (ifMatch.includes(',') || ifMatch.trim() === '*' || !bareEtag(ifMatch))) {
    throw new ApiError(428, 'precondition_required');
  }

  const body = await readLimited(req, SESSION_MAX_BYTES);
  if (body === null) throw new ApiError(413, 'session_too_large');
  let doc: SessionDocument;
  try {
    doc = validateSession(JSON.parse(body));
  } catch (err) {
    if (err instanceof SessionError || err instanceof SyntaxError) throw new ApiError(400, 'bad_session');
    throw err;
  }
  if (doc.id !== ctx.session) throw new ApiError(400, 'bad_session');
  doc.updated_at = ctx.deps.now().toISOString();
  doc.updated_by = ctx.user;
  // El limite es sobre lo que se GUARDA: el documento normalizado (parametros de efecto
  // completados, updated_at y updated_by reescritos) puede pesar mas que el cuerpo recibido.
  const text = JSON.stringify(doc);
  if (new TextEncoder().encode(text).byteLength > SESSION_MAX_BYTES) throw new ApiError(413, 'session_too_large');

  const bucket = ctx.env.STEMS;
  const key = `${ctx.sessionPrefix}session.json`;
  const current = await bucket.head(key);
  if (create ? current !== null : current === null || bareEtag(ifMatch!) !== current.etag) {
    throw new ApiError(412, 'session_conflict');
  }
  for (const asset of doc.assets) {
    const head = await bucket.head(`${ctx.sessionPrefix}assets/${asset.file}`);
    if (!head || head.size !== asset.size) throw new ApiError(409, 'missing_asset');
  }

  // La condicion va tambien en el put: entre el head de arriba y esta escritura otra persona pudo
  // guardar. R2 devuelve null si la condicion ya no se cumple.
  const stored = await bucket.put(key, text, {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: current ? { etagMatches: current.etag } : createOnly(),
  });
  if (!stored) throw new ApiError(412, 'session_conflict');
  // Limpieza oportunista de los huerfanos de esta sesion (como mucho cada 2 h por banda), despues
  // de responder: va a waitUntil y nunca retrasa ni rompe el guardado.
  if (ctx.deps.waitUntil) {
    // Quien no administra la banda (Musician, SoundEngineer) dispara una limpieza conservadora: no
    // borra ningun audio que el control de versiones haya protegido alguna vez (retired_assets).
    const conservative = !isEditorRole(ctx.role);
    ctx.deps.waitUntil(opportunisticCleanup(ctx.env, ctx.deps, ctx.studioPrefix, ctx.session, { conservative }).catch(() => {}));
  }
  return json(200, doc, { ETag: stored.httpEtag });
}

/**
 * Respuesta de `GET`/`POST .../studio/_cleanup` (STUDIO_V2.md 3.1). `blocked`: null si se leyo todo,
 * `session_unreadable` si una sesion no se pudo leer (no se borra nada) o `incomplete` si no
 * alcanzo el tope de operaciones (tampoco se borra nada).
 */
export function publicCleanupReport(report: CleanupReport): Record<string, unknown> {
  return {
    orphans: report.orphans,
    bytes: report.bytes,
    sample: report.sample,
    sessions: report.sessions,
    protected_sessions: report.protected_sessions,
    complete: report.status === 'done',
    blocked: report.status === 'done' ? null : report.status === 'budget' ? 'incomplete' : 'session_unreadable',
    deleted: report.deleted,
    deleted_bytes: report.deleted_bytes,
  };
}

/**
 * Condicion "solo si no existe" para R2.
 * NO VERIFICADO: que R2 interprete el comodin `*` de If-None-Match en `onlyIf`. Si lo ignorara, la
 * escritura queda protegida solo por el head previo (ventana de carrera de milisegundos). El
 * 2026-11-19 no se pudo leer la documentacion de R2 (la red del equipo corta el TLS): hay que
 * comprobarlo contra R2 real o `wrangler dev` antes de confiar en el.
 */
export function createOnly(): Headers {
  return new Headers({ 'If-None-Match': '*' });
}

async function deleteSession(ctx: StudioContext): Promise<Response> {
  const keys = await listAll(ctx.env.STEMS, ctx.sessionPrefix);
  for (let i = 0; i < keys.length; i += 1000) await ctx.env.STEMS.delete(keys.slice(i, i + 1000));
  return json(200, { deleted: keys.length });
}

// --------------------------------------------------------------------------- audios

async function putAsset(req: Request, ctx: StudioContext, file: string): Promise<Response> {
  const lengthHeader = req.headers.get('Content-Length');
  if (lengthHeader === null || !/^\d+$/.test(lengthHeader.trim())) throw new ApiError(411, 'length_required');
  const length = Number(lengthHeader);
  if (length === 0 || !req.body) throw new ApiError(400, 'empty_body');
  if (!Number.isSafeInteger(length) || length > ASSET_MAX_BYTES) throw new ApiError(413, 'file_too_large');
  const type = (req.headers.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('audio/') && type !== 'application/octet-stream') throw new ApiError(415, 'not_audio');

  const bucket = ctx.env.STEMS;
  const key = `${ctx.sessionPrefix}assets/${file}`;
  const existing = await bucket.head(key);
  if (existing) {
    // Inmutable: reintentar la misma subida es seguro; otro contenido con ese nombre, no.
    await req.body.cancel().catch(() => {});
    if (existing.size !== length) throw new ApiError(409, 'asset_exists');
    return json(200, { file, size: existing.size });
  }
  // Tope de audios por sesion: el documento admite 256, pero la subida no pasa por el documento.
  const listed = await bucket.list({ prefix: `${ctx.sessionPrefix}assets/`, limit: MAX_SESSION_ASSET_FILES + 1 });
  if (listed.objects.length >= MAX_SESSION_ASSET_FILES) {
    await req.body.cancel().catch(() => {});
    throw new ApiError(409, 'too_many_assets');
  }
  const contentType = ASSET_CONTENT_TYPES[assetExtension(file)!];
  const stored = await bucket.put(key, req.body, { httpMetadata: { contentType }, onlyIf: createOnly() });
  if (!stored) {
    // Otra subida del mismo nombre gano la carrera.
    const winner = await bucket.head(key);
    if (winner && winner.size === length) return json(200, { file, size: winner.size });
    throw new ApiError(409, 'asset_exists');
  }
  if (stored.size !== length) {
    await bucket.delete(key);
    throw new ApiError(400, 'incomplete_upload');
  }
  return json(200, { file, size: stored.size });
}

/** `Range: bytes=a-b | a- | -n` (un solo rango) sobre un objeto de `size` bytes; null si es imposible. */
export function parseRange(header: string, size: number): { offset: number; length: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

async function getAsset(req: Request, ctx: StudioContext, file: string): Promise<Response> {
  const bucket = ctx.env.STEMS;
  const key = `${ctx.sessionPrefix}assets/${file}`;
  const headers: Record<string, string> = {
    'Content-Type': ASSET_CONTENT_TYPES[assetExtension(file)!],
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  const rangeHeader = req.headers.get('Range');
  if (rangeHeader === null) {
    const obj = await bucket.get(key);
    if (!obj) throw new ApiError(404, 'no_asset');
    return new Response(obj.body, { headers: { ...headers, 'Content-Length': String(obj.size), ETag: obj.httpEtag } });
  }
  const head: R2Object | null = await bucket.head(key);
  if (!head) throw new ApiError(404, 'no_asset');
  const range = parseRange(rangeHeader, head.size);
  if (!range) return json(416, { error: 'bad_range' }, { 'Content-Range': `bytes */${head.size}` });
  const obj = await bucket.get(key, { range });
  if (!obj) throw new ApiError(404, 'no_asset');
  return new Response(obj.body, {
    status: 206,
    headers: {
      ...headers,
      'Content-Length': String(range.length),
      'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
      ETag: head.httpEtag,
    },
  });
}
