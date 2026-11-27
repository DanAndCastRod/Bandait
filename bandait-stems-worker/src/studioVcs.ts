// Control de versiones ligero del Estudio en R2 (STUDIO_V2.md 7.2).
//
// Cada sesion puede tener:
//   - `studio/<session>/vcs.json`: indice compacto con ramas (`branches`), historial (`commits`) y
//     `protected_assets` (archivos en `assets/` referenciados por al menos un commit retenido,
//     leido en una sola operacion por `studioCleanup.ts`).
//   - `studio/<session>/commits/<commit_id>.json`: documento `SessionDocument` inmutable de ese
//     snapshot. Como los archivos WAV/FLAC/MP3 en `assets/` ya son inmutables por id, guardar
//     snapshots y ramas no duplica bytes de audio.

import { ApiError, json } from './index.ts';
import { createOnly, readLimited, type StudioContext } from './studio.ts';
import { ID_RE, SESSION_MAX_BYTES, SessionError, validateSession, type SessionDocument } from './studioSession.ts';

export const MAX_VCS_COMMITS = 128;
export const VCS_BODY_LIMIT = SESSION_MAX_BYTES + 65536;
const BRANCH_RE = /^[A-Za-z0-9_-]{1,40}$/;

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

export interface VcsIndex {
  version: 1;
  branches: Record<string, string>;
  commits: VcsCommitMeta[];
  protected_assets: string[];
}

export function emptyVcsIndex(): VcsIndex {
  return { version: 1, branches: {}, commits: [], protected_assets: [] };
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
  return { version: 1, branches, commits, protected_assets: protectedAssets };
}

function recomputeProtectedAssets(commits: readonly VcsCommitMeta[]): string[] {
  const set = new Set<string>();
  for (const c of commits) {
    for (const file of c.asset_files) set.add(file);
  }
  return [...set].sort();
}

export async function getVcs(ctx: StudioContext): Promise<Response> {
  const obj = await ctx.env.STEMS.get(`${ctx.sessionPrefix}vcs.json`);
  if (!obj) return json(200, emptyVcsIndex());
  let parsed: VcsIndex;
  try {
    parsed = parseVcsIndex(JSON.parse(await obj.text()));
  } catch {
    throw new ApiError(500, 'vcs_corrupt');
  }
  return json(200, parsed, { ETag: obj.httpEtag });
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
  const authorName = typeof raw.author_name === 'string' ? raw.author_name.trim().slice(0, 80) : '';
  const explicitParent = raw.parent_id === null || raw.parent_id === undefined
    ? undefined
    : typeof raw.parent_id === 'string' && ID_RE.test(raw.parent_id)
      ? raw.parent_id
      : '__invalid__';
  if (explicitParent === '__invalid__') throw new ApiError(400, 'bad_vcs');

  let doc: SessionDocument;
  try {
    doc = validateSession(raw.session);
  } catch (err) {
    if (err instanceof SessionError) throw new ApiError(400, 'bad_session');
    throw err;
  }
  if (doc.id !== ctx.session) throw new ApiError(400, 'bad_session');

  const nowIso = ctx.deps.now().toISOString();
  doc.updated_at = nowIso;
  doc.updated_by = ctx.user;
  const docJson = JSON.stringify(doc);
  if (new TextEncoder().encode(docJson).byteLength > SESSION_MAX_BYTES) throw new ApiError(413, 'session_too_large');

  const bucket = ctx.env.STEMS;
  for (const asset of doc.assets) {
    const head = await bucket.head(`${ctx.sessionPrefix}assets/${asset.file}`);
    if (!head || head.size !== asset.size) throw new ApiError(409, 'missing_asset');
  }

  const vcsKey = `${ctx.sessionPrefix}vcs.json`;
  const existingObj = await bucket.get(vcsKey);
  let index = emptyVcsIndex();
  if (existingObj) {
    try {
      index = parseVcsIndex(JSON.parse(await existingObj.text()));
    } catch {
      throw new ApiError(500, 'vcs_corrupt');
    }
  }

  const commitId = ctx.deps.newId('cmt');
  const commitKey = `${ctx.sessionPrefix}commits/${commitId}.json`;
  const commitStored = await bucket.put(commitKey, docJson, {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: createOnly(),
  });
  if (!commitStored) throw new ApiError(409, 'commit_conflict');

  const parentId = explicitParent !== undefined ? explicitParent : (index.branches[branch] ?? null);
  const meta: VcsCommitMeta = {
    id: commitId,
    branch,
    parent_id: parentId,
    message,
    author_id: ctx.user,
    author_name: authorName,
    created_at: nowIso,
    track_count: doc.tracks.length,
    bpm: doc.bpm,
    key: doc.key,
    asset_files: doc.assets.map((a) => a.file),
  };

  const nextBranches: Record<string, string> = { ...index.branches, [branch]: commitId };
  const headIds = new Set(Object.values(nextBranches));
  let nextCommits = [meta, ...index.commits];
  let evicted: VcsCommitMeta[] = [];
  if (nextCommits.length > MAX_VCS_COMMITS) {
    const kept: VcsCommitMeta[] = [];
    for (const c of nextCommits) {
      if (kept.length < MAX_VCS_COMMITS || headIds.has(c.id)) kept.push(c);
      else evicted.push(c);
    }
    nextCommits = kept;
  }

  const nextIndex: VcsIndex = {
    version: 1,
    branches: nextBranches,
    commits: nextCommits,
    protected_assets: recomputeProtectedAssets(nextCommits),
  };

  const storedIndex = await bucket.put(vcsKey, JSON.stringify(nextIndex), {
    httpMetadata: { contentType: 'application/json' },
    ...(existingObj ? { onlyIf: { etagMatches: existingObj.etag } } : { onlyIf: createOnly() }),
  });
  if (!storedIndex) {
    await bucket.delete(commitKey).catch(() => {});
    throw new ApiError(412, 'vcs_conflict');
  }
  if (evicted.length > 0) {
    await bucket.delete(evicted.map((c) => `${ctx.sessionPrefix}commits/${c.id}.json`)).catch(() => {});
  }

  return json(201, { commit: meta, vcs: nextIndex }, { ETag: storedIndex.httpEtag });
}
