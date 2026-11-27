// Limpieza de audios huerfanos del Estudio en R2 (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 5;
// contrato en bandait-protocol/STUDIO_V2.md, seccion 3.1).
//
// Un audio `studio/<session>/assets/<file>` de una banda (o del workspace personal `users/<uuid>`)
// es HUERFANO si se cumplen las tres condiciones:
//   1. el `session.json` de su sesion no lo nombra: ni en `assets[]` (por `file` o por `id`) ni en
//      un clip, una zona del sampler o un `frozen_asset_id`. Una carpeta sin `session.json`
//      (sesion a medio crear) no protege ninguno de sus audios;
//   2. ningun trabajo de su sesion esta en curso (registro en `jobs/` con estado que no es
//      SUCCEEDED ni FAILED; eso cubre el fragmento `audio.asset_id` de un chat que aun corre y las
//      salidas que un trabajo esta copiando). Un trabajo en curso protege la sesion entera;
//   3. tiene mas de 2 horas: la fecha de subida de R2 (`uploaded`) o, si existe y es posterior,
//      `customMetadata.created_at`.
//
// Seguridad primero:
//   - Nada se borra de una banda hasta haber leido TODAS sus sesiones. Si una lectura falla (R2
//     lanza, o un `session.json` no es JSON o no tiene `assets` y `tracks` como listas), no se
//     borra nada de esa banda y queda un evento FAILED (`session_unreadable`).
//   - Si el tope de operaciones no alcanza para leer la banda entera, no se borra nada de ella.
//   - Antes de borrar se vuelve a pedir el etag de cada `session.json` con candidatos: si cambio
//     (alguien guardo mientras tanto), esa sesion se salta.
//   - Un registro de trabajo ilegible protege su sesion.
//   - Si un audio que el Hub tenia en su equipo se borro y vuelve a usarse (deshacer), el
//     siguiente guardado recibe 409 `missing_asset` y el Hub vuelve a subir todos los audios de la
//     sesion desde el equipo (studioState.saveToCloud): se recupera solo.
//
// Tres caminos, todos con tope de operaciones de R2 por invocacion (OpBudget):
//   - cron diario (`sweepOrphans`): todas las bandas y workspaces, con cursor en
//     `studio/_cleanup/cursor.json` (raiz del bucket) para seguir al dia siguiente;
//   - despues de guardar una sesion (`opportunisticCleanup`, en waitUntil): solo esa sesion, como
//     mucho una vez cada 2 horas por banda (marca en `<banda>/studio/_cleanup/last.json`);
//   - a pedido (`cleanupScope`): `GET` inspecciona y `POST` borra (src/studio.ts), y el MCP de
//     operador inspecciona (`bandait_huerfanos`, src/mcp.ts).
//
// Este modulo no importa studio.ts ni index.ts (que se importan entre si).

import { OpBudget, recordEvent } from './events.ts';
import { ID_RE } from './studioSession.ts';
import type { Env, R2Object, StudioDeps } from './types.ts';

export const ORPHAN_MIN_AGE_MS = 2 * 60 * 60 * 1000;
export const OPPORTUNISTIC_INTERVAL_MS = 2 * 60 * 60 * 1000;
/**
 * Operaciones de R2 del barrido del cron. Con las 40 de la retencion de eventos (purgeEvents), el
 * cron entero queda en 900, por debajo del limite de 1000 operaciones por invocacion.
 */
export const CLEANUP_CRON_MAX_OPS = 860;
/** Operaciones de R2 de `GET`/`POST .../studio/_cleanup` (una peticion). */
export const CLEANUP_REQUEST_MAX_OPS = 900;
/**
 * Operaciones de R2 de la limpieza tras guardar. Corre en la misma invocacion del `PUT .../session`
 * (que hace hasta 258: un head por audio mas el put), asi que va muy por debajo del resto.
 */
export const CLEANUP_SAVE_MAX_OPS = 300;
/** Ids de muestra que devuelve la inspeccion. */
export const CLEANUP_SAMPLE_MAX = 20;
/** Cursor del barrido diario, en la raiz del bucket (como studio/_events/ y studio/_usage/). */
export const CLEANUP_CURSOR_KEY = 'studio/_cleanup/cursor.json';
const DELETE_BATCH = 1000;
const ROOTS = ['bands/', 'users/'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED']);

export type CleanupTrigger = 'cron' | 'save' | 'manual' | 'mcp';

export interface CleanupReport {
  /** `done`: se leyo todo; `budget`: no alcanzo el tope (nada se borro); `error`: una lectura fallo. */
  status: 'done' | 'budget' | 'error';
  /** Carpetas de sesion revisadas. */
  sessions: number;
  /** Sesiones saltadas por un trabajo en curso (o un registro ilegible). */
  protected_sessions: number;
  orphans: number;
  bytes: number;
  /** Hasta CLEANUP_SAMPLE_MAX `<session>/<file>`. */
  sample: string[];
  deleted: number;
  deleted_bytes: number;
  /** Sesion cuya lectura fallo (status `error`). */
  error_session: string | null;
}

interface SessionScan {
  session: string;
  folder: string;
  /** etag del session.json leido; null si la carpeta no tiene documento. */
  etag: string | null;
  candidates: R2Object[];
  protected: boolean;
}

class NoBudget extends Error {}
class Unreadable extends Error {}

/** Una operacion de R2 con cupo; sin cupo lanza NoBudget. */
async function op<T>(budget: OpBudget, fn: () => Promise<T>): Promise<T> {
  if (!budget.take()) throw new NoBudget();
  return fn();
}

function emptyReport(): CleanupReport {
  return { status: 'done', sessions: 0, protected_sessions: 0, orphans: 0, bytes: 0, sample: [], deleted: 0, deleted_bytes: 0, error_session: null };
}

/** `bands/<uuid>/studio/` -> `bands/<uuid>` (el campo `band` de los eventos). */
function eventBand(studioPrefix: string): string {
  return studioPrefix.replace(/\/studio\/$/, '');
}

/** Ids y archivos que un documento nombra. Lanza Unreadable si no tiene la forma minima. */
export function referencedAssets(raw: unknown): { files: Set<string>; ids: Set<string> } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Unreadable();
  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.assets) || !Array.isArray(doc.tracks)) throw new Unreadable();
  const files = new Set<string>();
  const ids = new Set<string>();
  const addId = (v: unknown) => {
    if (typeof v === 'string' && v) ids.add(v);
  };
  for (const a of doc.assets) {
    if (typeof a !== 'object' || a === null) continue;
    const asset = a as Record<string, unknown>;
    if (typeof asset.file === 'string' && asset.file) files.add(asset.file);
    addId(asset.id);
  }
  for (const t of doc.tracks) {
    if (typeof t !== 'object' || t === null) continue;
    const track = t as Record<string, unknown>;
    if (Array.isArray(track.clips)) for (const c of track.clips) addId((c as Record<string, unknown> | null)?.asset_id);
    addId(track.frozen_asset_id);
    const instrument = track.instrument as Record<string, unknown> | null | undefined;
    if (instrument && Array.isArray(instrument.zones)) for (const z of instrument.zones) addId((z as Record<string, unknown> | null)?.asset_id);
  }
  return { files, ids };
}

/** Momento de subida mas tardio que se conoce del objeto; NaN si no se sabe (no es candidato). */
function uploadedMs(o: R2Object): number {
  const uploaded = o.uploaded instanceof Date ? o.uploaded.getTime() : Number.NaN;
  const meta = o.customMetadata?.created_at ? Date.parse(o.customMetadata.created_at) : Number.NaN;
  if (Number.isFinite(meta)) return Number.isFinite(uploaded) ? Math.max(uploaded, meta) : meta;
  return uploaded;
}

async function listEvery(env: Env, budget: OpBudget, prefix: string, withCustom: boolean): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await op(budget, () => env.STEMS.list({ prefix, cursor, limit: 1000, ...(withCustom ? { include: ['customMetadata' as const] } : {}) }));
    out.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

/** Lee una sesion y devuelve sus candidatos a huerfano. Lanza NoBudget o Unreadable. */
async function scanSession(env: Env, budget: OpBudget, studioPrefix: string, session: string, nowMs: number): Promise<SessionScan> {
  const folder = `${studioPrefix}${session}/`;
  let etag: string | null = null;
  let refs = { files: new Set<string>(), ids: new Set<string>() };
  try {
    const doc = await op(budget, () => env.STEMS.get(`${folder}session.json`));
    if (doc) {
      etag = doc.etag;
      refs = referencedAssets(JSON.parse(await doc.text()));
    }
  } catch (err) {
    if (err instanceof NoBudget) throw err;
    throw new Unreadable();
  }
  let assets: R2Object[];
  try {
    assets = await listEvery(env, budget, `${folder}assets/`, true);
  } catch (err) {
    if (err instanceof NoBudget) throw err;
    throw new Unreadable();
  }
  let candidates = assets.filter((o) => {
    const file = o.key.slice(`${folder}assets/`.length);
    if (!file || file.includes('/')) return false;
    const dot = file.lastIndexOf('.');
    const id = dot > 0 ? file.slice(0, dot) : file;
    if (refs.files.has(file) || refs.ids.has(id)) return false;
    const at = uploadedMs(o);
    return Number.isFinite(at) && nowMs - at > ORPHAN_MIN_AGE_MS;
  });
  if (!candidates.length) return { session, folder, etag, candidates, protected: false };

  // Control de versiones (`vcs.json`): solo se consulta si hay candidatos, protegiendo los audios
  // referenciados por snapshots y ramas sin gastar operaciones en sesiones sin candidatos.
  try {
    const vcsObj = await op(budget, () => env.STEMS.get(`${folder}vcs.json`));
    if (vcsObj) {
      const vcsRaw = JSON.parse(await vcsObj.text()) as Record<string, unknown>;
      if (!vcsRaw || typeof vcsRaw !== 'object' || !Array.isArray(vcsRaw.protected_assets)) throw new Unreadable();
      const vcsFiles = new Set<string>();
      const vcsIds = new Set<string>();
      for (const item of vcsRaw.protected_assets) {
        if (typeof item !== 'string' || !item) continue;
        vcsFiles.add(item);
        const dot = item.lastIndexOf('.');
        vcsIds.add(dot > 0 ? item.slice(0, dot) : item);
      }
      candidates = candidates.filter((o) => {
        const file = o.key.slice(`${folder}assets/`.length);
        const dot = file.lastIndexOf('.');
        const id = dot > 0 ? file.slice(0, dot) : file;
        return !vcsFiles.has(file) && !vcsIds.has(id);
      });
      if (!candidates.length) return { session, folder, etag, candidates, protected: false };
    }
  } catch (err) {
    if (err instanceof NoBudget) throw err;
    throw new Unreadable();
  }

  // Trabajos: solo hace falta mirarlos si hay algo que borrar.
  let busy = false;
  try {
    const jobs = await listEvery(env, budget, `${folder}jobs/`, true);
    for (const job of jobs) {
      if (TERMINAL.has(job.customMetadata?.status ?? '')) continue;
      // Sin customMetadata (registro anterior al Worker 1.4.0) o en curso: se lee el registro.
      const stored = await op(budget, () => env.STEMS.get(job.key));
      if (!stored) continue;
      let status: unknown = null;
      try {
        status = (JSON.parse(await stored.text()) as { status?: unknown }).status;
      } catch {
        status = null;
      }
      if (typeof status !== 'string' || !TERMINAL.has(status)) {
        busy = true;
        break;
      }
    }
  } catch (err) {
    if (err instanceof NoBudget) throw err;
    busy = true; // no se pudo saber: la sesion queda protegida
  }
  return busy ? { session, folder, etag, candidates: [], protected: true } : { session, folder, etag, candidates, protected: false };
}

/** Carpetas de sesion validas bajo `studio/` (sin `_usage`, `_cleanup` ni ids invalidos). */
async function sessionIds(env: Env, budget: OpBudget, studioPrefix: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await op(budget, () => env.STEMS.list({ prefix: studioPrefix, delimiter: '/', cursor, limit: 1000 }));
    for (const folder of page.delimitedPrefixes ?? []) {
      const id = folder.slice(studioPrefix.length, -1);
      if (!id.startsWith('_') && ID_RE.test(id)) ids.push(id);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return ids;
}

function tally(report: CleanupReport, scans: SessionScan[]): void {
  for (const s of scans) {
    if (s.protected) report.protected_sessions++;
    for (const o of s.candidates) {
      report.orphans++;
      report.bytes += o.size;
      if (report.sample.length < CLEANUP_SAMPLE_MAX) report.sample.push(`${s.session}/${o.key.slice(`${s.folder}assets/`.length)}`);
    }
  }
}

/**
 * Borra los candidatos de las sesiones dadas. Vuelve a pedir el etag de cada session.json y salta
 * las que cambiaron. Necesita `scans.length + lotes` operaciones; quien llama ya comprobo el cupo.
 */
async function removeCandidates(env: Env, budget: OpBudget, scans: SessionScan[], report: CleanupReport): Promise<void> {
  const keep: SessionScan[] = [];
  for (const s of scans) {
    const head = await op(budget, () => env.STEMS.head(`${s.folder}session.json`));
    if ((head?.etag ?? null) === s.etag) keep.push(s);
  }
  const objects = keep.flatMap((s) => s.candidates);
  for (let i = 0; i < objects.length; i += DELETE_BATCH) {
    const batch = objects.slice(i, i + DELETE_BATCH);
    await op(budget, () => env.STEMS.delete(batch.map((o) => o.key)));
    report.deleted += batch.length;
    report.deleted_bytes += batch.reduce((n, o) => n + o.size, 0);
  }
}

function deleteOpsNeeded(scans: SessionScan[]): number {
  const withCandidates = scans.filter((s) => s.candidates.length);
  const objects = withCandidates.reduce((n, s) => n + s.candidates.length, 0);
  return withCandidates.length + Math.ceil(objects / DELETE_BATCH);
}

/** Evento de una limpieza que borro algo o que se bloqueo (nunca en una inspeccion). */
function cleanupEvent(
  env: Env, deps: Pick<StudioDeps, 'now' | 'waitUntil'>, budget: OpBudget, studioPrefix: string, report: CleanupReport,
  trigger: CleanupTrigger, startedMs: number, code: string | null = null,
): void {
  if (!code && report.deleted === 0) return;
  if (!budget.take()) return; // sin cupo no se anota (la escritura del evento tambien cuenta)
  recordEvent(env, deps, {
    band: eventBand(studioPrefix), session: report.error_session, job: null, kind: 'cleanup', provider: 'r2',
    status: code ? 'FAILED' : 'SUCCEEDED', http: null, provider_code: code, urit_request_id: null, model: null,
    duration_ms: Date.now() - startedMs, cost_usd: null, objects: report.deleted, bytes: report.deleted_bytes, trigger,
  });
}

export interface CleanupOptions {
  /** true borra; false solo inspecciona. */
  remove: boolean;
  trigger: CleanupTrigger;
  /** Operaciones que deben quedar libres al terminar (el cursor del cron). */
  reserve?: number;
}

/**
 * Inspecciona (y con `remove`, borra) los huerfanos de una banda o workspace. `studioPrefix` es
 * `bands/<uuid>/studio/` o `users/<uuid>/studio/`. Nunca lanza por R2: un fallo es status `error`.
 */
export async function cleanupScope(
  env: Env, deps: Pick<StudioDeps, 'now' | 'waitUntil'>, studioPrefix: string, budget: OpBudget, options: CleanupOptions,
): Promise<CleanupReport> {
  const report = emptyReport();
  const startedMs = Date.now();
  const nowMs = deps.now().getTime();
  const reserve = (options.reserve ?? 0) + (options.remove ? 1 : 0); // + el evento
  const scans: SessionScan[] = [];
  let current: string | null = null;
  try {
    for (const session of await sessionIds(env, budget, studioPrefix)) {
      current = session;
      if (budget.left <= reserve) throw new NoBudget();
      scans.push(await scanSession(env, budget, studioPrefix, session, nowMs));
      report.sessions++;
    }
    current = null;
  } catch (err) {
    tally(report, scans);
    if (err instanceof NoBudget) {
      report.status = 'budget';
      return report;
    }
    report.status = 'error';
    report.error_session = current;
    if (options.remove) cleanupEvent(env, deps, budget, studioPrefix, report, options.trigger, startedMs, 'session_unreadable');
    return report;
  }
  tally(report, scans);
  if (!options.remove || report.orphans === 0) return report;
  const withCandidates = scans.filter((s) => s.candidates.length);
  if (budget.left - reserve < deleteOpsNeeded(withCandidates)) {
    report.status = 'budget';
    return report;
  }
  try {
    await removeCandidates(env, budget, withCandidates, report);
  } catch {
    report.status = 'error';
    cleanupEvent(env, deps, budget, studioPrefix, report, options.trigger, startedMs, 'delete_failed');
    return report;
  }
  cleanupEvent(env, deps, budget, studioPrefix, report, options.trigger, startedMs);
  return report;
}

// --------------------------------------------------------------------------- tras guardar

/**
 * Limpieza oportunista despues de un `PUT .../session`: solo los huerfanos de esa sesion, como
 * mucho una vez cada 2 horas por banda. Va a waitUntil y nunca lanza. Devuelve lo que hizo (para
 * las pruebas): `skipped` si la banda ya se limpio hace menos de 2 horas u otra peticion gano.
 */
export async function opportunisticCleanup(
  env: Env, deps: Pick<StudioDeps, 'now' | 'waitUntil'>, studioPrefix: string, session: string,
): Promise<CleanupReport | 'skipped'> {
  const budget = new OpBudget(CLEANUP_SAVE_MAX_OPS);
  const now = deps.now();
  const markerKey = `${studioPrefix}_cleanup/last.json`;
  const report = emptyReport();
  const startedMs = Date.now();
  try {
    const marker = await op(budget, () => env.STEMS.get(markerKey));
    if (marker) {
      let at = Number.NaN;
      try {
        at = Date.parse(String((JSON.parse(await marker.text()) as { at?: unknown }).at));
      } catch {
        at = Number.NaN;
      }
      if (Number.isFinite(at) && now.getTime() - at < OPPORTUNISTIC_INTERVAL_MS) return 'skipped';
    }
    // La marca se escribe ANTES de leer, con condicion: de dos guardados simultaneos solo uno limpia.
    const claimed = await op(budget, () => env.STEMS.put(markerKey, JSON.stringify({ at: now.toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: marker ? { etagMatches: marker.etag } : new Headers({ 'If-None-Match': '*' }),
    }));
    if (!claimed) return 'skipped';
    let scan: SessionScan;
    try {
      scan = await scanSession(env, budget, studioPrefix, session, now.getTime());
    } catch (err) {
      if (err instanceof NoBudget) {
        report.status = 'budget';
        return report;
      }
      report.status = 'error';
      report.error_session = session;
      cleanupEvent(env, deps, budget, studioPrefix, report, 'save', startedMs, 'session_unreadable');
      return report;
    }
    report.sessions = 1;
    tally(report, [scan]);
    if (!scan.candidates.length) return report;
    if (budget.left - 1 < deleteOpsNeeded([scan])) {
      report.status = 'budget';
      return report;
    }
    await removeCandidates(env, budget, [scan], report);
    cleanupEvent(env, deps, budget, studioPrefix, report, 'save', startedMs);
    return report;
  } catch (err) {
    console.warn(`studio cleanup: fallo la limpieza tras guardar (${err instanceof Error ? err.name : 'error'})`);
    report.status = report.status === 'done' ? 'error' : report.status;
    return report;
  }
}

// --------------------------------------------------------------------------- cron

export interface SweepResult {
  /** Bandas y workspaces revisados en esta corrida. */
  scopes: number;
  deleted: number;
  deleted_bytes: number;
  /** Bandas que no se pudieron limpiar por una lectura fallida. */
  blocked: number;
  /** true si la corrida no termino: la siguiente sigue desde el cursor. */
  truncated: boolean;
  /** Ultima banda o workspace terminado (`bands/<uuid>/`), o null si la vuelta termino. */
  cursor: string | null;
  ops: number;
}

/** Cursor guardado: ultima banda o workspace terminado, o null para empezar desde el principio. */
async function readCursor(env: Env, budget: OpBudget): Promise<string | null> {
  const obj = await op(budget, () => env.STEMS.get(CLEANUP_CURSOR_KEY));
  if (!obj) return null;
  try {
    const after = (JSON.parse(await obj.text()) as { after?: unknown }).after;
    return typeof after === 'string' && /^(bands|users)\/[0-9a-f-]{36}\/$/.test(after) ? after : null;
  } catch {
    return null;
  }
}

/**
 * Barrido diario de huerfanos de todas las bandas (`bands/`) y workspaces personales (`users/`),
 * en orden alfabetico, con un tope de operaciones. Si no termina, guarda el cursor y la siguiente
 * corrida sigue desde ahi. Una banda que por si sola no cabe en el tope se salta (evento FAILED
 * `budget`) para no atascar el barrido.
 */
export async function sweepOrphans(
  env: Env, deps: Pick<StudioDeps, 'now' | 'waitUntil'>, maxOps = CLEANUP_CRON_MAX_OPS,
): Promise<SweepResult> {
  // Dos operaciones quedan apartadas: guardar el cursor al final y, si hace falta, el evento de
  // una banda que no cabe en el tope.
  const budget = new OpBudget(Math.max(0, maxOps - 2));
  let first = true;
  let forcedEvents = 0;
  const result: SweepResult = { scopes: 0, deleted: 0, deleted_bytes: 0, blocked: 0, truncated: false, cursor: null, ops: 0 };
  let after: string | null = null;
  try {
    after = await readCursor(env, budget);
  } catch (err) {
    if (!(err instanceof NoBudget)) throw err;
  }
  let last = after;
  const afterRoot = after ? after.slice(0, after.indexOf('/') + 1) : null;
  try {
    outer: for (const root of ROOTS) {
      if (afterRoot && root < afterRoot) continue;
      let cursor: string | undefined;
      // `startAfter` con la ultima clave posible de esa carpeta: `bands/<uuid>0` va despues de
      // todo `bands/<uuid>/...` ('0' sigue a '/') y antes de la banda siguiente.
      const startAfter = afterRoot === root && after ? `${after.slice(0, -1)}0` : undefined;
      do {
        const page = await op(budget, () => env.STEMS.list({
          prefix: root, delimiter: '/', limit: 1000, ...(cursor ? { cursor } : startAfter ? { startAfter } : {}),
        }));
        for (const folder of page.delimitedPrefixes ?? []) {
          if (!UUID.test(folder.slice(root.length, -1)) || (after && folder <= after)) continue;
          const fresh = first; // primera banda de la corrida: tuvo todo el cupo
          first = false;
          const report = await cleanupScope(env, deps, `${folder}studio/`, budget, { remove: true, trigger: 'cron' });
          if (report.status === 'budget') {
            if (!fresh) {
              result.truncated = true;
              break outer;
            }
            // No cabe ni con el cupo entero: se salta para no atascar el barrido.
            result.blocked++;
            const blocked = { ...emptyReport(), sessions: report.sessions };
            const forced = new OpBudget(forcedEvents === 0 ? 1 : 0); // a lo sumo uno por corrida
            cleanupEvent(env, deps, forced, `${folder}studio/`, blocked, 'cron', Date.now(), 'budget');
            forcedEvents += forced.used;
          }
          if (report.status === 'error') result.blocked++;
          result.scopes++;
          result.deleted += report.deleted;
          result.deleted_bytes += report.deleted_bytes;
          last = folder;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    }
  } catch (err) {
    if (!(err instanceof NoBudget)) {
      console.warn(`studio cleanup: fallo el barrido (${err instanceof Error ? err.name : 'error'})`);
    }
    result.truncated = true;
  }
  result.cursor = result.truncated ? last : null;
  try {
    await env.STEMS.put(CLEANUP_CURSOR_KEY, JSON.stringify({ after: result.cursor, at: deps.now().toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (err) {
    console.warn(`studio cleanup: no se pudo guardar el cursor (${err instanceof Error ? err.name : 'error'})`);
  }
  result.ops = budget.used + 1 + forcedEvents;
  if (result.deleted || result.truncated || result.blocked) {
    console.log(`studio cleanup: ${result.deleted} audios huerfanos borrados en ${result.scopes} bandas${result.truncated ? ' (sigue en la proxima corrida)' : ''}`);
  }
  return result;
}
