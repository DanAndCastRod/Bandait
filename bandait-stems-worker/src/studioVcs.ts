// Control de versiones ligero del Estudio en R2 (STUDIO_V2.md 7.2).
//
// Cada sesion puede tener:
//   - `studio/<session>/vcs.json`: indice compacto con ramas (`branches`), historial (`commits`),
//     `protected_assets` (NOMBRES de archivo en `assets/` que el limpiador de huerfanos no debe
//     borrar; `studioCleanup.ts` deduce el id quitando la extension) y `retired_assets` (audios de
//     commits expulsados o de ramas borradas, protegidos durante un periodo de gracia).
//   - `studio/<session>/commits/<commit_id>.json`: documento `SessionDocument` inmutable de ese
//     snapshot. Como los archivos WAV/FLAC/MP3 en `assets/` ya son inmutables por id, guardar
//     snapshots y ramas no duplica bytes de audio.
//
// Topes (el indice nunca crece sin limite):
//   - MAX_VCS_COMMITS commits mas, como mucho, una cabeza por rama fuera de esa ventana;
//   - MAX_VCS_BRANCHES ramas: crear una mas es 409 `too_many_branches` (hay que borrar una);
//   - VCS_INDEX_MAX_BYTES de indice: si se pasa, se expulsan commits viejos que no son cabeza;
//   - MAX_RETIRED_ASSETS audios en periodo de gracia (los que vencen antes salen primero).

import { ApiError, json } from './index.ts';
import { createOnly, readLimited, type StudioContext } from './studio.ts';
import { ID_RE, SESSION_MAX_BYTES, SessionError, validateSession, type SessionDocument } from './studioSession.ts';
import type { R2ObjectBody } from './types.ts';

export const MAX_VCS_COMMITS = 128;
export const MAX_VCS_BRANCHES = 16;
export const VCS_BODY_LIMIT = SESSION_MAX_BYTES + 65536;
export const VCS_INDEX_MAX_BYTES = 1024 * 1024;
/** Un audio que deja de estar en algun commit retenido sigue protegido 30 dias. */
export const RETIRED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_RETIRED_ASSETS = 4096;
/** Reintentos ante una carrera sobre vcs.json (dos commits a la vez en ramas distintas). */
const VCS_WRITE_ATTEMPTS = 3;
const BRANCH_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** La rama principal no se borra. */
export const PROTECTED_BRANCH = 'main';

export function isBranchName(value: unknown): value is string {
  return typeof value === 'string' && BRANCH_RE.test(value);
}

export interface VcsCommitMeta {
  id: string;
  branch: string;
  parent_id: string | null;
  message: string;
  author_id: string | null;
  author_name: string;
  created_at: string;
  track_count: number;
  bpm: number;
  key: string | null;
  asset_files: string[];
}

export interface RetiredAsset {
  file: string;
  /** ISO 8601: hasta cuando sigue protegido. */
  until: string;
}

export interface VcsIndex {
  version: 1;
  branches: Record<string, string>;
  commits: VcsCommitMeta[];
  protected_assets: string[];
  retired_assets: RetiredAsset[];
}

export function emptyVcsIndex(): VcsIndex {
  return { version: 1, branches: {}, commits: [], protected_assets: [], retired_assets: [] };
}

export function parseVcsIndex(raw: unknown): VcsIndex {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('bad_vcs');
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || typeof o.branches !== 'object' || o.branches === null || Array.isArray(o.branches) || !Array.isArray(o.commits) || !Array.isArray(o.protected_assets)) {
    throw new Error('bad_vcs');
  }
  const branches: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.branches as Record<string, unknown>)) {
    if (BRANCH_RE.test(k) && typeof v === 'string' && ID_RE.test(v)) branches[k] = v;
  }
  const commits: VcsCommitMeta[] = [];
  for (const item of o.commits) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('bad_vcs');
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !ID_RE.test(c.id) || typeof c.branch !== 'string' || typeof c.message !== 'string' || typeof c.created_at !== 'string' || !Array.isArray(c.asset_files)) {
      throw new Error('bad_vcs');
    }
    commits.push({
      id: c.id,
      branch: c.branch,
      parent_id: typeof c.parent_id === 'string' && ID_RE.test(c.parent_id) ? c.parent_id : null,
      message: c.message,
      author_id: typeof c.author_id === 'string' ? c.author_id : null,
      author_name: typeof c.author_name === 'string' ? c.author_name : '',
      created_at: c.created_at,
      track_count: typeof c.track_count === 'number' ? c.track_count : 0,
      bpm: typeof c.bpm === 'number' ? c.bpm : 120,
      key: typeof c.key === 'string' ? c.key : null,
      asset_files: c.asset_files.filter((f): f is string => typeof f === 'string' && f.length > 0),
    });
  }
  const protectedAssets = o.protected_assets.filter((f): f is string => typeof f === 'string' && f.length > 0);
  // `retired_assets` llego en el Worker 1.5.1: un indice anterior no lo trae (lista vacia).
  const retired: RetiredAsset[] = [];
  if (Array.isArray(o.retired_assets)) {
    for (const item of o.retired_assets) {
      if (typeof item !== 'object' || item === null) continue;
      const r = item as Record<string, unknown>;
      if (typeof r.file === 'string' && r.file && typeof r.until === 'string' && Number.isFinite(Date.parse(r.until))) {
        retired.push({ file: r.file, until: r.until });
      }
    }
  }
  return { version: 1, branches, commits, protected_assets: protectedAssets, retired_assets: retired };
}

/**
 * Indice siguiente: aplica los topes, pasa a `retired_assets` los audios que dejan de estar en
 * algun commit retenido (los expulsados por tope y los `removed` que quita quien llama, como los
 * de una rama borrada) y recalcula `protected_assets`. Devuelve tambien los commits expulsados
 * (para borrar sus documentos despues de escribir el indice).
 */
export function finalizeVcsIndex(
  previous: VcsIndex, branches: Record<string, string>, candidates: VcsCommitMeta[], now: Date, removed: VcsCommitMeta[] = [],
): { index: VcsIndex; evicted: VcsCommitMeta[] } {
  const headIds = new Set(Object.values(branches));
  const kept: VcsCommitMeta[] = [];
  const evicted: VcsCommitMeta[] = [];
  for (const c of candidates) {
    if (kept.length < MAX_VCS_COMMITS || headIds.has(c.id)) kept.push(c);
    else evicted.push(c);
  }
  const nowMs = now.getTime();
  const build = (commits: VcsCommitMeta[], gone: VcsCommitMeta[]): VcsIndex => {
    const live = new Set<string>();
    for (const c of commits) for (const f of c.asset_files) live.add(f);
    const until = new Date(nowMs + RETIRED_GRACE_MS).toISOString();
    const retiredMap = new Map<string, string>();
    for (const r of previous.retired_assets) {
      if (Date.parse(r.until) > nowMs && !live.has(r.file)) retiredMap.set(r.file, r.until);
    }
    // Los audios de los commits que salen ahora quedan protegidos durante el periodo de gracia.
    for (const c of gone) for (const f of c.asset_files) if (!live.has(f)) retiredMap.set(f, until);
    let retired = [...retiredMap].map(([file, u]) => ({ file, until: u }));
    if (retired.length > MAX_RETIRED_ASSETS) {
      retired.sort((a, b) => (a.until < b.until ? 1 : a.until > b.until ? -1 : 0));
      retired = retired.slice(0, MAX_RETIRED_ASSETS);
    }
    retired.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const protectedSet = new Set(live);
    for (const r of retired) protectedSet.add(r.file);
    return { version: 1, branches, commits, protected_assets: [...protectedSet].sort(), retired_assets: retired };
  };
  let index = build(kept, [...removed, ...evicted]);
  // Tope en bytes: expulsar el commit mas viejo que no sea cabeza hasta que quepa.
  while (new TextEncoder().encode(JSON.stringify(index)).byteLength > VCS_INDEX_MAX_BYTES) {
    let victim = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!headIds.has(kept[i].id)) {
        victim = i;
        break;
      }
    }
    if (victim < 0) break;
    evicted.push(...kept.splice(victim, 1));
    index = build(kept, [...removed, ...evicted]);
  }
  return { index, evicted };
}

async function readIndex(ctx: StudioContext): Promise<{ obj: R2ObjectBody | null; index: VcsIndex }> {
  const obj = await ctx.env.STEMS.get(`${ctx.sessionPrefix}vcs.json`);
  if (!obj) return { obj: null, index: emptyVcsIndex() };
  try {
    return { obj, index: parseVcsIndex(JSON.parse(await obj.text())) };
  } catch {
    throw new ApiError(500, 'vcs_corrupt');
  }
}

export async function getVcs(ctx: StudioContext): Promise<Response> {
  const { obj, index } = await readIndex(ctx);
  if (!obj) return json(200, index);
  return json(200, index, { ETag: obj.httpEtag });
}

export async function getCommit(ctx: StudioContext, commitId: string): Promise<Response> {
  const obj = await ctx.env.STEMS.get(`${ctx.sessionPrefix}commits/${commitId}.json`);
  if (!obj) throw new ApiError(404, 'no_commit');
  return new Response(obj.body, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=31536000, immutable', ETag: obj.httpEtag },
  });
}

export async function postVcs(req: Request, ctx: StudioContext): Promise<Response> {
  const text = await readLimited(req, VCS_BODY_LIMIT);
  if (text === null) throw new ApiError(413, 'session_too_large');
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ApiError(400, 'bad_vcs');
    raw = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'bad_vcs');
  }

  const branch = typeof raw.branch === 'string' ? raw.branch.trim() : 'main';
  if (!BRANCH_RE.test(branch)) throw new ApiError(400, 'bad_vcs');
  const message = typeof raw.message === 'string' ? raw.message.trim().slice(0, 160) : '';
  if (!message) throw new ApiError(400, 'bad_vcs');
  // `parent_id` ausente: la cabeza actual de la rama. Presente (id o null): debe ser la cabeza
  // actual (null = la rama todavia no existe); si no, 409 vcs_conflict.
  const hasParent = Object.prototype.hasOwnProperty.call(raw, 'parent_id');
  if (hasParent && raw.parent_id !== null && !(typeof raw.parent_id === 'string' && ID_RE.test(raw.parent_id))) {
    throw new ApiError(400, 'bad_vcs');
  }
  const expectedParent = hasParent ? (raw.parent_id as string | null) : undefined;

  let doc: SessionDocument;
  try {
    doc = validateSession(raw.session);
  } catch (err) {
    if (err instanceof SessionError) throw new ApiError(400, 'bad_session');
    throw err;
  }
  if (doc.id !== ctx.session) throw new ApiError(400, 'bad_session');

  const now = ctx.deps.now();
  const nowIso = now.toISOString();
  doc.updated_at = nowIso;
  doc.updated_by = ctx.user;
  const docJson = JSON.stringify(doc);
  if (new TextEncoder().encode(docJson).byteLength > SESSION_MAX_BYTES) throw new ApiError(413, 'session_too_large');

  const bucket = ctx.env.STEMS;
  for (const asset of doc.assets) {
    const head = await bucket.head(`${ctx.sessionPrefix}assets/${asset.file}`);
    if (!head || head.size !== asset.size) throw new ApiError(409, 'missing_asset');
  }

  // Comprobaciones baratas antes de escribir nada.
  {
    const { index } = await readIndex(ctx);
    checkHead(index, branch, expectedParent);
  }

  const commitId = ctx.deps.newId('cmt');
  const commitKey = `${ctx.sessionPrefix}commits/${commitId}.json`;
  const commitStored = await bucket.put(commitKey, docJson, {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: createOnly(),
  });
  if (!commitStored) throw new ApiError(409, 'commit_conflict');

  const vcsKey = `${ctx.sessionPrefix}vcs.json`;
  try {
    for (let attempt = 0; attempt < VCS_WRITE_ATTEMPTS; attempt++) {
      const { obj, index } = await readIndex(ctx);
      checkHead(index, branch, expectedParent);
      const meta: VcsCommitMeta = {
        id: commitId,
        branch,
        parent_id: index.branches[branch] ?? null,
        message,
        author_id: ctx.user,
        // Identidad verificada (token de Supabase), nunca el `author_name` del cuerpo.
        author_name: ctx.userName,
        created_at: nowIso,
        track_count: doc.tracks.length,
        bpm: doc.bpm,
        key: doc.key,
        asset_files: doc.assets.map((a) => a.file),
      };
      const branches: Record<string, string> = { ...index.branches, [branch]: commitId };
      const { index: next, evicted } = finalizeVcsIndex(index, branches, [meta, ...index.commits], now);
      const stored = await bucket.put(vcsKey, JSON.stringify(next), {
        httpMetadata: { contentType: 'application/json' },
        onlyIf: obj ? { etagMatches: obj.etag } : createOnly(),
      });
      if (!stored) continue; // otra peticion escribio vcs.json entre la lectura y la escritura
      if (evicted.length > 0) {
        await bucket.delete(evicted.map((c) => `${ctx.sessionPrefix}commits/${c.id}.json`)).catch(() => {});
      }
      return json(201, { commit: meta, vcs: next }, { ETag: stored.httpEtag });
    }
  } catch (err) {
    await bucket.delete(commitKey).catch(() => {});
    throw err;
  }
  await bucket.delete(commitKey).catch(() => {});
  throw new ApiError(409, 'vcs_conflict');
}

/** Cabeza esperada y tope de ramas. Lanza 409 `vcs_conflict` o 409 `too_many_branches`. */
function checkHead(index: VcsIndex, branch: string, expectedParent: string | null | undefined): void {
  const head = index.branches[branch] ?? null;
  if (expectedParent !== undefined && expectedParent !== head) throw new ApiError(409, 'vcs_conflict');
  if (head === null && Object.keys(index.branches).length >= MAX_VCS_BRANCHES) throw new ApiError(409, 'too_many_branches');
}

/**
 * DELETE .../vcs/branches/{branch} (Owner / MusicDirector). Quita el puntero de la rama y los
 * commits de esa rama que ninguna otra cabeza alcanza por `parent_id`. Sus audios pasan a
 * `retired_assets` (periodo de gracia), asi que borrar una rama nunca deja huerfano de inmediato
 * un audio que otro integrante pudiera recuperar.
 */
export async function deleteVcsBranch(ctx: StudioContext, branch: string): Promise<Response> {
  if (!isBranchName(branch)) throw new ApiError(400, 'bad_vcs');
  if (branch === PROTECTED_BRANCH) throw new ApiError(409, 'branch_protected');
  const bucket = ctx.env.STEMS;
  const vcsKey = `${ctx.sessionPrefix}vcs.json`;
  for (let attempt = 0; attempt < VCS_WRITE_ATTEMPTS; attempt++) {
    const { obj, index } = await readIndex(ctx);
    if (!obj || !index.branches[branch]) throw new ApiError(404, 'no_branch');
    const branches: Record<string, string> = { ...index.branches };
    delete branches[branch];
    const byId = new Map(index.commits.map((c) => [c.id, c]));
    const reachable = new Set<string>();
    for (const head of Object.values(branches)) {
      let cursor: string | null = head;
      while (cursor && !reachable.has(cursor)) {
        reachable.add(cursor);
        cursor = byId.get(cursor)?.parent_id ?? null;
      }
    }
    const dropped = index.commits.filter((c) => c.branch === branch && !reachable.has(c.id));
    const droppedIds = new Set(dropped.map((c) => c.id));
    const remaining = index.commits.filter((c) => !droppedIds.has(c.id));
    // Los audios de los commits quitados entran en el periodo de gracia (retired_assets).
    const { index: next, evicted } = finalizeVcsIndex(index, branches, remaining, ctx.deps.now(), dropped);
    const stored = await bucket.put(vcsKey, JSON.stringify(next), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagMatches: obj.etag },
    });
    if (!stored) continue;
    const gone = [...dropped, ...evicted];
    if (gone.length > 0) await bucket.delete(gone.map((c) => `${ctx.sessionPrefix}commits/${c.id}.json`)).catch(() => {});
    return json(200, { deleted_commits: gone.length, vcs: next }, { ETag: stored.httpEtag });
  }
  throw new ApiError(409, 'vcs_conflict');
}
