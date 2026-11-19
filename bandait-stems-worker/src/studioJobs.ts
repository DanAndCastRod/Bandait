// Trabajos de IA del Estudio (STUDIO_V1.md, seccion 6): master y separate con Music AI, generate
// con Lyria (Suno responde 501) y assist con un modelo de lenguaje. Un trabajo nunca modifica la
// sesion: deja audios en assets/ o devuelve sugerencias.
//
// master y separate son asincronos: `POST` sube el audio a Music AI y lanza el workflow; cada
// `GET` consulta el trabajo y, cuando termina, copia UN audio a R2 (patron de copyNextStem en
// index.ts), para que ninguna peticion dure mas de unos segundos.
// generate y assist son sincronos: `POST` espera al proveedor y deja el trabajo ya terminado; el
// primer `GET` devuelve SUCCEEDED o FAILED. El limite de ese camino esta en providers/lyria.ts.
//
//
// Gasto: el costo se RESERVA antes de llamar al proveedor (registro del trabajo en STARTED y
// entrada en los contadores de la banda y global, con escritura condicional). Si el proveedor
// rechaza la peticion (502) la reserva se revierte. Asi un trabajo cobrado nunca queda sin
// registro, y dos trabajos simultaneos no pasan los dos el tope.

import { ApiError, STEM_OUTPUTS, json, musicAi } from './index.ts';
import { anthropic } from './providers/anthropic.ts';
import { detectAudioExt, lyria } from './providers/lyria.ts';
import { suno } from './providers/suno.ts';
import { ProviderError } from './providers/types.ts';
import type { AssistProvider, GenerateProvider, GenerateRequest } from './providers/types.ts';
import { ASSET_CONTENT_TYPES, assertSpender, createOnly, readLimited } from './studio.ts';
import type { StudioContext } from './studio.ts';
import {
  ASSET_EXTENSIONS, ASSET_MAX_BYTES, FX_TYPES, ID_RE, MASTER_ID, MAX_PROMPT, MAX_SESSION_SECONDS, MAX_TRACKS,
  MAX_TRACK_NAME, ROLES, VOLUME_DB_MAX, VOLUME_DB_MIN, validateFxChain, validateFxParams,
} from './studioSession.ts';
import type { AssetExtension, FxType, SessionFx } from './studioSession.ts';
import type { Env } from './types.ts';

const JOB_BODY_LIMIT = 64 * 1024;
const MAX_SUGGESTIONS = 32;
const MAX_REASON = 280;
const MAX_USAGE_ENTRIES = 2000;
/** Reintentos de una escritura condicional (contador de gasto) antes de responder 503 `usage_busy`. */
const USAGE_ATTEMPTS = 6;
/** Contador de gasto de todo el Worker (todas las bandas y workspaces personales). */
const GLOBAL_USAGE_PREFIX = 'studio/_usage/';
/**
 * Un trabajo sin id del proveedor sigue "en curso" durante este tiempo (el POST aun espera a
 * Lyria o sube la mezcla a Music AI); pasado, se da por interrumpido.
 */
const PENDING_GRACE_MS = 10 * 60 * 1000;
const MUSICAI_BASE = 'https://api.music.ai/v1';
/** Cabecera que se lee de un audio para conocer su duracion real. */
const HEADER_PROBE_BYTES = 64 * 1024;

/**
 * Tarifas por defecto para ESTIMAR el costo. NO VERIFICADO: son las cifras de referencia del plan
 * (docs/PLAN_ESTUDIO_BANDAIT.md, seccion 10), sin confirmar con las paginas de precios oficiales.
 * Se cambian con las variables STUDIO_RATE_* sin tocar el codigo.
 *   master:   USD 0,20 por minuto.
 *   separate: USD 0,07 por minuto y stem, con 7 stems: USD 0,49, redondeado a 0,50 por minuto.
 *   lyria:    USD 0,06 por cada 30 segundos pedidos.
 *   assist:   USD 0,05 por consulta (unos 3 000 tokens de entrada y 4 000 de salida en un modelo
 *             de USD 2 / USD 10 por millon).
 */
export const DEFAULT_RATES = { masterPerMin: 0.2, separatePerMin: 0.5, lyriaPer30s: 0.06, assist: 0.05 };

export type JobKind = 'master' | 'separate' | 'generate' | 'assist';

export interface JobAsset {
  id: string; file: string; kind: 'master' | 'stem' | 'generated'; label: string; role: string | null; size: number;
  channels: number | null; sample_rate: number | null; duration_s: number | null;
  source: { provider: string; job_id: string; prompt?: string };
}

export interface Suggestion {
  track_id: string; target: 'volume_db' | 'pan' | 'fx'; value: number | null; fx_type: FxType | null;
  params: Record<string, number> | null; reason: string;
}

/** studio/<session>/jobs/<job>.json. Estado interno: no es parte del contrato. */
interface JobRecord {
  job_id: string; kind: JobKind; provider: string; status: 'STARTED' | 'SUCCEEDED' | 'FAILED'; created_at: string;
  user: string | null; cost_usd: number;
  /** Id del trabajo en Music AI (master, separate). */
  external_id?: string;
  /** Nombre para mostrar del audio de un master. */
  label?: string;
  /** Salida de Music AI -> id de audio reservado. Fijo desde el primer GET: reintentar pisa el mismo objeto. */
  planned?: Record<string, string>;
  /** Salidas ya copiadas a assets/. */
  copied?: Record<string, JobAsset>;
  assets?: JobAsset[]; suggestions?: Suggestion[]; error?: string;
}

interface UsageEntry {
  at: string; job_id: string; kind: JobKind; provider: string; seconds: number; cost_usd: number; user: string;
  /** Solo en el contador global: prefijo de la banda o del workspace personal que gasto. */
  scope?: string;
}
interface UsageFile { month: string; total_usd: number; entries: UsageEntry[] }

interface TrackMetrics {
  track_id: string; name: string; role: string; lufs: number | null; true_peak_db: number | null;
  bands: { low_db: number; low_mid_db: number; high_mid_db: number; high_db: number } | null;
  volume_db: number; pan: number; fx: SessionFx[];
}
interface Metrics { target_lufs: number; master: { lufs: number | null; true_peak_db: number | null }; tracks: TrackMetrics[] }

type JobRequest =
  | { kind: 'master'; asset_id: string; duration_s: number; target_lufs: number }
  | { kind: 'separate'; asset_id: string; duration_s: number }
  | ({ kind: 'generate'; provider: 'lyria' | 'suno' } & GenerateRequest)
  | { kind: 'assist'; metrics: Metrics };

const GENERATE_PROVIDERS: Record<'lyria' | 'suno', GenerateProvider> = { lyria, suno };
const ASSIST_PROVIDERS: Record<string, AssistProvider> = { anthropic };

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// --------------------------------------------------------------------------- validacion del cuerpo

type Raw = Record<string, unknown>;

function bad(): never {
  throw new ApiError(400, 'bad_job');
}

function obj(raw: unknown, keys: readonly string[]): Raw {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad();
  const o = raw as Raw;
  for (const key of keys) if (o[key] === undefined) bad();
  for (const key of Object.keys(o)) if (!keys.includes(key)) bad();
  return o;
}

function num(v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad();
  return v;
}

function numOrNull(v: unknown, min: number, max: number): number | null {
  return v === null ? null : num(v, min, max);
}

function str(v: unknown, minLen: number, maxLen: number): string {
  if (typeof v !== 'string' || v.length < minLen || v.length > maxLen) bad();
  return v;
}

function ident(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) bad();
  return v;
}

function duration(v: unknown): number {
  const d = num(v, 0, MAX_SESSION_SECONDS);
  if (!(d > 0)) bad();
  return d;
}

function validateMetrics(raw: unknown): Metrics {
  const o = obj(raw, ['target_lufs', 'master', 'tracks']);
  const master = obj(o.master, ['lufs', 'true_peak_db']);
  if (!Array.isArray(o.tracks) || o.tracks.length < 1 || o.tracks.length > MAX_TRACKS) bad();
  const seen = new Set<string>();
  const tracks = o.tracks.map((item): TrackMetrics => {
    const t = obj(item, ['track_id', 'name', 'role', 'lufs', 'true_peak_db', 'bands', 'volume_db', 'pan', 'fx']);
    const trackId = ident(t.track_id);
    if (trackId === MASTER_ID || seen.has(trackId)) bad();
    seen.add(trackId);
    if (typeof t.role !== 'string' || !ROLES.includes(t.role)) bad();
    let bands: TrackMetrics['bands'] = null;
    if (t.bands !== null) {
      const b = obj(t.bands, ['low_db', 'low_mid_db', 'high_mid_db', 'high_db']);
      // Relativo a la energia total de la pista: cada valor <= 0 (con margen de redondeo), piso -120.
      bands = { low_db: num(b.low_db, -120, 0.01), low_mid_db: num(b.low_mid_db, -120, 0.01), high_mid_db: num(b.high_mid_db, -120, 0.01), high_db: num(b.high_db, -120, 0.01) };
    }
    if (!Array.isArray(t.fx) || t.fx.length > 2) bad();
    let fx: SessionFx[];
    try {
      fx = validateFxChain(t.fx, 'fx', 'track');
    } catch {
      bad();
    }
    return {
      track_id: trackId, name: str(t.name, 1, MAX_TRACK_NAME), role: t.role,
      lufs: numOrNull(t.lufs, -200, 50), true_peak_db: numOrNull(t.true_peak_db, -200, 50), bands,
      volume_db: num(t.volume_db, VOLUME_DB_MIN, VOLUME_DB_MAX), pan: num(t.pan, -1, 1), fx,
    };
  });
  return {
    target_lufs: num(o.target_lufs, -24, -6),
    master: { lufs: numOrNull(master.lufs, -200, 50), true_peak_db: numOrNull(master.true_peak_db, -200, 50) },
    tracks,
  };
}

/** Cuerpo de `POST .../jobs` (STUDIO_V1.md 6.1). Campo desconocido, ausente o fuera de rango: 400 bad_job. */
export function validateJobRequest(raw: unknown): JobRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad();
  const kind = (raw as Raw).kind;
  if (kind === 'master') {
    const o = obj(raw, ['kind', 'asset_id', 'duration_s', 'target_lufs']);
    return { kind, asset_id: ident(o.asset_id), duration_s: duration(o.duration_s), target_lufs: num(o.target_lufs, -24, -6) };
  }
  if (kind === 'separate') {
    const o = obj(raw, ['kind', 'asset_id', 'duration_s']);
    return { kind, asset_id: ident(o.asset_id), duration_s: duration(o.duration_s) };
  }
  if (kind === 'generate') {
    const o = obj(raw, ['kind', 'provider', 'prompt', 'duration_s', 'bpm', 'key', 'instrumental']);
    if (o.provider !== 'lyria' && o.provider !== 'suno') bad();
    if (typeof o.instrumental !== 'boolean') bad();
    const prompt = str(o.prompt, 1, MAX_PROMPT);
    if (!prompt.trim()) bad();
    return {
      kind, provider: o.provider, prompt, duration_s: num(o.duration_s, 5, 240), bpm: num(o.bpm, 40, 260),
      key: o.key === null ? null : str(o.key, 1, 12), instrumental: o.instrumental,
    };
  }
  if (kind === 'assist') {
    const o = obj(raw, ['kind', 'metrics']);
    return { kind, metrics: validateMetrics(o.metrics) };
  }
  bad();
}

// --------------------------------------------------------------------------- sugerencias

function sanitizeSuggestion(raw: unknown, trackIds: ReadonlySet<string>): Suggestion | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const s = raw as Raw;
  if (typeof s.track_id !== 'string' || typeof s.reason !== 'string') return null;
  const isMaster = s.track_id === MASTER_ID;
  if (!isMaster && !trackIds.has(s.track_id)) return null;
  const reason = s.reason.trim().slice(0, MAX_REASON);
  if (!reason) return null;
  const base = { track_id: s.track_id, reason };
  const finite = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (s.target === 'volume_db') {
    if (!finite(s.value, VOLUME_DB_MIN, VOLUME_DB_MAX)) return null;
    return { ...base, target: 'volume_db', value: s.value, fx_type: null, params: null };
  }
  if (s.target === 'pan') {
    if (isMaster || !finite(s.value, -1, 1)) return null;
    return { ...base, target: 'pan', value: s.value, fx_type: null, params: null };
  }
  if (s.target === 'fx') {
    const type = s.fx_type;
    if (typeof type !== 'string' || !(FX_TYPES as readonly string[]).includes(type)) return null;
    if (type === 'limiter' && !isMaster) return null;
    if (typeof s.params !== 'object' || s.params === null || Array.isArray(s.params)) return null;
    // El esquema que recibe el modelo obliga a listar todos los parametros: null es "no cambia".
    const listed = Object.fromEntries(Object.entries(s.params as Raw).filter(([, v]) => v !== null && v !== undefined));
    let params: Record<string, number>;
    try {
      params = validateFxParams(type as FxType, listed, 'params', true);
    } catch {
      return null;
    }
    if (!Object.keys(params).length) return null;
    return { ...base, target: 'fx', value: null, fx_type: type as FxType, params };
  }
  return null;
}

/** Valida la salida del modelo contra STUDIO_V1.md 6.4 y descarta lo que no cumple. */
export function sanitizeSuggestions(raw: unknown[], trackIds: ReadonlySet<string>): Suggestion[] {
  const out: Suggestion[] = [];
  for (const item of raw) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const s = sanitizeSuggestion(item, trackIds);
    if (s) out.push(s);
  }
  return out;
}

// --------------------------------------------------------------------------- costo y tope

function rate(value: string | undefined, fallback: number): number {
  const text = (value ?? '').trim();
  if (!text) return fallback;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function estimateCost(env: Env, request: JobRequest): { cost: number; seconds: number } {
  if (request.kind === 'master') {
    return { cost: round4((request.duration_s / 60) * rate(env.STUDIO_RATE_MASTER_USD_PER_MIN, DEFAULT_RATES.masterPerMin)), seconds: request.duration_s };
  }
  if (request.kind === 'separate') {
    return { cost: round4((request.duration_s / 60) * rate(env.STUDIO_RATE_SEPARATE_USD_PER_MIN, DEFAULT_RATES.separatePerMin)), seconds: request.duration_s };
  }
  if (request.kind === 'generate') {
    return { cost: round4(Math.ceil(request.duration_s / 30) * rate(env.STUDIO_RATE_LYRIA_USD_PER_30S, DEFAULT_RATES.lyriaPer30s)), seconds: request.duration_s };
  }
  return { cost: round4(rate(env.STUDIO_RATE_ASSIST_USD, DEFAULT_RATES.assist)), seconds: 0 };
}

/**
 * Tope mensual por banda, o null si no hay. Un valor que no es un numero valido cuenta como 0:
 * un error de tipeo en la variable bloquea los trabajos en vez de dejar el gasto sin tope.
 */
export function monthlyBudget(env: Env): number | null {
  const text = (env.STUDIO_MONTHLY_BUDGET_USD ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Tope mensual de todo el Worker, o null si no hay. Mismo criterio que monthlyBudget. */
export function globalBudget(env: Env): number | null {
  const text = (env.STUDIO_GLOBAL_MONTHLY_BUDGET_USD ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Un contador de gasto: su objeto en R2 y su tope. */
interface UsageSlot { key: string; month: string; budget: number | null }

function usageSlots(ctx: StudioContext): { band: UsageSlot; global: UsageSlot } {
  const month = ctx.deps.now().toISOString().slice(0, 7);
  return {
    band: { key: `${ctx.studioPrefix}_usage/${month}.json`, month, budget: monthlyBudget(ctx.env) },
    global: { key: `${GLOBAL_USAGE_PREFIX}${month}.json`, month, budget: globalBudget(ctx.env) },
  };
}

async function readUsage(ctx: StudioContext, slot: UsageSlot): Promise<{ file: UsageFile; etag: string | null }> {
  const stored = await ctx.env.STEMS.get(slot.key);
  if (stored) {
    try {
      const file = JSON.parse(await stored.text()) as UsageFile;
      if (typeof file.total_usd === 'number' && Number.isFinite(file.total_usd) && Array.isArray(file.entries)) {
        return { file: { month: slot.month, total_usd: file.total_usd, entries: file.entries }, etag: stored.etag };
      }
    } catch {
      // contador ilegible: se trata abajo
    }
    // Un contador que existe pero no se entiende no puede contar como "cero gastado".
    throw new ApiError(500, 'internal');
  }
  return { file: { month: slot.month, total_usd: 0, entries: [] }, etag: null };
}

function fits(total: number, cost: number, budget: number | null): boolean {
  return budget === null || total + cost <= budget + 1e-9;
}

/**
 * Leer, modificar y escribir un contador con escritura condicional: si otro trabajo escribio
 * entre la lectura y el put, R2 devuelve null y se repite con el contador nuevo. Sin esto dos
 * trabajos simultaneos perdian una entrada y el total quedaba por debajo de lo gastado.
 * `mutate` devuelve false para no escribir (por ejemplo, si el trabajo pasaria el tope).
 */
async function updateUsage(ctx: StudioContext, slot: UsageSlot, mutate: (file: UsageFile) => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < USAGE_ATTEMPTS; attempt++) {
    const { file, etag } = await readUsage(ctx, slot);
    if (!mutate(file)) return false;
    const stored = await ctx.env.STEMS.put(slot.key, JSON.stringify(file), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: etag === null ? createOnly() : { etagMatches: etag },
    });
    if (stored) return true;
  }
  throw new ApiError(503, 'usage_busy');
}

/** Anota el costo en un contador si cabe en su tope. false: el trabajo pasaria el tope. */
function reserveUsage(ctx: StudioContext, slot: UsageSlot, entry: UsageEntry): Promise<boolean> {
  return updateUsage(ctx, slot, (file) => {
    if (!fits(file.total_usd, entry.cost_usd, slot.budget)) return false;
    file.entries.push(entry);
    if (file.entries.length > MAX_USAGE_ENTRIES) file.entries = file.entries.slice(-MAX_USAGE_ENTRIES);
    file.total_usd = round4(file.total_usd + entry.cost_usd);
    return true;
  });
}

/** Revierte la reserva de un trabajo que el proveedor no acepto. */
async function releaseUsage(ctx: StudioContext, slot: UsageSlot, jobId: string): Promise<void> {
  await updateUsage(ctx, slot, (file) => {
    const index = file.entries.findIndex((e) => e.job_id === jobId);
    if (index < 0) return false;
    const [entry] = file.entries.splice(index, 1);
    file.total_usd = Math.max(0, round4(file.total_usd - entry.cost_usd));
    return true;
  });
}

// --------------------------------------------------------------------------- duracion real del audio

/**
 * Duracion minima de un audio a partir de su cabecera y su tamano, en segundos. El costo de
 * `master` y `separate` no puede salir solo de lo que declara el cliente: aqui se calcula un piso.
 *   WAV:  bytes de datos / byte_rate del bloque `fmt `.
 *   FLAC: muestras totales / frecuencia de STREAMINFO.
 *   MP3 (o cabecera que no se entiende): tamano / la tasa mas alta razonable del formato, que da
 *   una duracion menor o igual a la real.
 */
export function audioSecondsFloor(head: Uint8Array, size: number, ext: AssetExtension): number {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (at: number) => (at + 4 <= head.byteLength ? String.fromCharCode(...head.subarray(at, at + 4)) : '');
  if (ext === 'wav' && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let byteRate = 0;
    let at = 12;
    while (at + 8 <= head.byteLength) {
      const id = tag(at);
      const length = view.getUint32(at + 4, true);
      if (id === 'fmt ' && at + 20 <= head.byteLength) byteRate = view.getUint32(at + 16, true);
      if (id === 'data') {
        const rest = Math.max(0, size - (at + 8));
        // Un tamano 0 o 0xFFFFFFFF es de un WAV escrito en vivo: vale lo que queda del archivo.
        const bytes = length === 0 || length === 0xffffffff ? rest : Math.min(length, rest);
        if (byteRate > 0) return bytes / byteRate;
        break;
      }
      at += 8 + length + (length % 2);
    }
    if (byteRate > 0) return Math.max(0, size - 44) / byteRate;
  }
  if (ext === 'flac' && tag(0) === 'fLaC' && head.byteLength >= 26 && (head[4] & 0x7f) === 0) {
    const sampleRate = (head[18] << 12) | (head[19] << 4) | (head[20] >> 4);
    const totalSamples = (head[21] & 0x0f) * 2 ** 32 + view.getUint32(22, false);
    if (sampleRate > 0 && totalSamples > 0) return totalSamples / sampleRate;
  }
  // 320 kbit/s para MP3; PCM de 192 kHz, estereo y 32 bits para lo demas.
  return size / (ext === 'mp3' ? 40_000 : 1_536_000);
}

async function assetSeconds(ctx: StudioContext, input: { file: string; size: number }): Promise<number> {
  const length = Math.min(input.size, HEADER_PROBE_BYTES);
  const ext = input.file.slice(input.file.lastIndexOf('.') + 1) as AssetExtension;
  let head = new Uint8Array(0);
  if (length > 0) {
    const obj = await ctx.env.STEMS.get(`${ctx.sessionPrefix}assets/${input.file}`, { range: { offset: 0, length } });
    if (obj) head = new Uint8Array(await new Response(obj.body).arrayBuffer());
  }
  return audioSecondsFloor(head, input.size, ext);
}

// --------------------------------------------------------------------------- proveedores

function providerFailure(err: unknown): never {
  if (err instanceof ProviderError) {
    if (err.detail) console.warn(`studio provider: ${err.detail}`);
    throw new ApiError(err.status, err.code);
  }
  // musicAi() de index.ts habla con los codigos del analisis: aqui todo fallo suyo es del proveedor.
  if (err instanceof ApiError) throw new ApiError(502, 'provider_failed');
  throw err;
}

function assistProvider(env: Env): AssistProvider {
  const name = (env.ASSIST_PROVIDER || '').trim().toLowerCase() || 'anthropic';
  const provider = ASSIST_PROVIDERS[name];
  if (!provider) throw new ProviderError(503, 'provider_unavailable', `ASSIST_PROVIDER desconocido: ${name.slice(0, 40)}`);
  return provider;
}

function musicAiWorkflow(env: Env, kind: 'master' | 'separate'): string {
  if (!(env.MUSICAI_API_KEY || '').trim()) throw new ProviderError(503, 'provider_unavailable', 'falta MUSICAI_API_KEY');
  // separate usa el mismo workflow y el mismo valor por defecto que `POST .../analysis?separate=1`.
  const workflow = kind === 'master' ? (env.MUSICAI_MASTER_WORKFLOW || '').trim() : (env.MUSICAI_SPLIT_WORKFLOW || '').trim() || 'splited_stems_bandait';
  if (!workflow) throw new ProviderError(503, 'provider_unavailable', 'falta MUSICAI_MASTER_WORKFLOW');
  return workflow;
}

/** Lanza ProviderError si el trabajo no se puede lanzar con la configuracion actual. */
function assertAvailable(env: Env, request: JobRequest): void {
  if (request.kind === 'master' || request.kind === 'separate') musicAiWorkflow(env, request.kind);
  else if (request.kind === 'generate') GENERATE_PROVIDERS[request.provider].assertAvailable(env);
  else assistProvider(env).assertAvailable(env);
}

function providerName(env: Env, request: JobRequest): string {
  if (request.kind === 'generate') return request.provider;
  if (request.kind === 'assist') return (env.ASSIST_PROVIDER || '').trim().toLowerCase() || 'anthropic';
  return 'musicai';
}

async function findAsset(ctx: StudioContext, assetId: string): Promise<{ file: string; size: number }> {
  for (const ext of ASSET_EXTENSIONS) {
    const head = await ctx.env.STEMS.head(`${ctx.sessionPrefix}assets/${assetId}.${ext}`);
    if (head) return { file: `${assetId}.${ext}`, size: head.size };
  }
  throw new ApiError(404, 'no_asset');
}

type FixedLength = new (n: number) => TransformStream;

/** Las URL firmadas piden un largo conocido: FixedLengthStream en Workers, el cuerpo tal cual en las pruebas. */
function fixedLength(body: ReadableStream, length: number): ReadableStream {
  const FLS = (globalThis as unknown as { FixedLengthStream?: FixedLength }).FixedLengthStream;
  if (!FLS) return body;
  const fixed = new FLS(length);
  body.pipeTo(fixed.writable).catch(() => {});
  return fixed.readable;
}

/** Sube un audio de assets/ a Music AI y lanza el workflow. Devuelve el id del trabajo en Music AI. */
async function launchMusicAi(
  ctx: StudioContext, kind: 'master' | 'separate', file: string, workflow: string, params: Record<string, unknown>,
): Promise<string> {
  const { env, fetchFn } = ctx;
  const upload = await musicAi(env, fetchFn, '/upload', { method: 'GET' }) as { uploadUrl?: string; downloadUrl?: string };
  if (!upload.uploadUrl || !upload.downloadUrl) throw new ProviderError(502, 'provider_failed', 'musicai: /upload sin URL');
  const source = await env.STEMS.get(`${ctx.sessionPrefix}assets/${file}`);
  if (!source) throw new ApiError(404, 'no_asset');
  const type = ASSET_CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1)];
  let put: Response;
  try {
    put = await fetchFn(upload.uploadUrl, { method: 'PUT', body: fixedLength(source.body, source.size), headers: { 'Content-Type': type } });
  } catch {
    throw new ProviderError(502, 'provider_failed', 'musicai: fallo la subida');
  }
  if (!put.ok) throw new ProviderError(502, 'provider_failed', `musicai: subida HTTP ${put.status}`);
  const job = await musicAi(env, fetchFn, '/job', {
    method: 'POST',
    body: JSON.stringify({ name: `bandait-studio-${ctx.session}-${kind}`, workflow, params: { inputUrl: upload.downloadUrl, ...params } }),
  }) as { id?: string };
  if (!job.id || typeof job.id !== 'string') throw new ProviderError(502, 'provider_failed', 'musicai: /job sin id');
  return job.id;
}

// --------------------------------------------------------------------------- POST .../jobs

function jobKey(ctx: StudioContext, jobId: string): string {
  return `${ctx.sessionPrefix}jobs/${jobId}.json`;
}

/** Guarda el registro sin condicion, con dos reintentos: perderlo dejaria un trabajo pagado sin resultado. */
async function saveJob(ctx: StudioContext, record: JobRecord): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.env.STEMS.put(jobKey(ctx, record.job_id), JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
      return;
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

/**
 * `POST .../jobs[?estimate=1][&job_id=<id>]`.
 * `job_id` es opcional y lo elige el cliente (`job_` mas el patron de id): hace el POST
 * idempotente. Si ya hay un trabajo con ese id no se lanza otro: se responde el mismo 202, y el
 * cliente lo consulta con GET. Sirve para retomar un trabajo cuando la respuesta del POST se
 * perdio (corte de red en un `generate` de decenas de segundos) sin pagar dos veces.
 */
export async function startJob(req: Request, ctx: StudioContext, estimate: boolean, clientJobId: string | null = null): Promise<Response> {
  if (clientJobId !== null && (!ID_RE.test(clientJobId) || !clientJobId.startsWith('job_'))) bad();
  const text = await readLimited(req, JOB_BODY_LIMIT);
  if (text === null) bad();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad();
  }
  const parsed = validateJobRequest(raw);
  const { env } = ctx;
  assertSpender(env, ctx.user);
  try {
    assertAvailable(env, parsed);
  } catch (err) {
    providerFailure(err);
  }
  const input = parsed.kind === 'master' || parsed.kind === 'separate' ? await findAsset(ctx, parsed.asset_id) : null;
  // master y separate se cobran por la duracion real del audio en R2, no por la que declara el
  // cliente: se toma la mayor de las dos (un cliente que declara de menos no baja el costo).
  const request: JobRequest = input && (parsed.kind === 'master' || parsed.kind === 'separate')
    ? { ...parsed, duration_s: Math.max(parsed.duration_s, await assetSeconds(ctx, input)) }
    : parsed;

  const { cost, seconds } = estimateCost(env, request);
  const slots = usageSlots(ctx);
  if (estimate) {
    const [band, global] = await Promise.all([readUsage(ctx, slots.band), readUsage(ctx, slots.global)]);
    const allowed = fits(band.file.total_usd, cost, slots.band.budget) && fits(global.file.total_usd, cost, slots.global.budget);
    return json(200, { kind: request.kind, estimated_cost_usd: cost, spent_usd: band.file.total_usd, budget_usd: slots.band.budget, allowed });
  }

  const jobId = clientJobId ?? ctx.deps.newId('job');
  const now = ctx.deps.now().toISOString();
  const record: JobRecord = {
    job_id: jobId, kind: request.kind, provider: providerName(env, request), status: 'STARTED', created_at: now,
    user: ctx.user, cost_usd: cost,
  };
  const started = () => json(202, { job_id: jobId, status: 'STARTED', kind: record.kind });

  // 1. Reserva: registro del trabajo (solo si no existe) y costo en los dos contadores, ANTES de
  //    llamar al proveedor. Un trabajo pagado nunca queda sin registro ni sin anotar.
  const reserved = await ctx.env.STEMS.put(jobKey(ctx, jobId), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json' }, onlyIf: createOnly(),
  });
  if (!reserved) {
    const existing = await ctx.env.STEMS.get(jobKey(ctx, jobId));
    if (existing) record.kind = (JSON.parse(await existing.text()) as JobRecord).kind;
    return started();
  }
  const entry: UsageEntry = {
    at: now, job_id: jobId, kind: request.kind, provider: record.provider, seconds, cost_usd: cost, user: ctx.user ?? 'unknown',
  };
  const dropJob = () => ctx.env.STEMS.delete(jobKey(ctx, jobId));
  let globalOk: boolean;
  try {
    globalOk = await reserveUsage(ctx, slots.global, { ...entry, scope: ctx.studioPrefix });
  } catch (err) {
    await dropJob();
    throw err;
  }
  if (!globalOk) {
    await dropJob();
    throw new ApiError(429, 'quota_exceeded');
  }
  const release = async () => {
    await releaseUsage(ctx, slots.band, jobId).catch(() => {});
    await releaseUsage(ctx, slots.global, jobId).catch(() => {});
    await dropJob().catch(() => {});
  };
  let bandOk = false;
  try {
    bandOk = await reserveUsage(ctx, slots.band, entry);
  } finally {
    if (!bandOk) await release();
  }
  if (!bandOk) throw new ApiError(429, 'quota_exceeded');

  // 2. Proveedor. La promesa va tambien a waitUntil: si el cliente corta la conexion mientras
  //    Lyria o el modelo responden, el trabajo termina y deja su resultado igual.
  //    NO VERIFICADO: cuanto tiempo sostiene Cloudflare una promesa de waitUntil despues de que el
  //    cliente se va (la referencia de memoria es 30 s). Si no alcanza, el registro queda en
  //    STARTED y el GET lo da por interrumpido pasado PENDING_GRACE_MS, con el costo anotado.
  const work = runProvider(ctx, request, record, input, release);
  ctx.deps.waitUntil?.(work.catch(() => {}));
  await work;
  // El contrato responde siempre STARTED: el estado real (tambien el de generate y assist, que ya
  // terminaron) se lee con GET .../jobs/{job}.
  return started();
}

/** Llama al proveedor y guarda el resultado. Si el proveedor rechaza, revierte la reserva. */
async function runProvider(
  ctx: StudioContext, request: JobRequest, record: JobRecord, input: { file: string; size: number } | null,
  release: () => Promise<void>,
): Promise<void> {
  const { env } = ctx;
  const jobId = record.job_id;
  try {
    if (request.kind === 'master' || request.kind === 'separate') {
      const params: Record<string, unknown> = {};
      if (request.kind === 'master') {
        // El nombre del parametro de volumen depende del workflow armado en el panel de Music AI:
        // sin MUSICAI_MASTER_LUFS_PARAM no se envia, y la etiqueta no promete un LUFS.
        const lufsParam = (env.MUSICAI_MASTER_LUFS_PARAM || '').trim();
        if (lufsParam) params[lufsParam] = request.target_lufs;
        record.label = lufsParam ? `Master ${Number(request.target_lufs.toFixed(1))} LUFS` : 'Master';
      }
      record.external_id = await launchMusicAi(ctx, request.kind, input!.file, musicAiWorkflow(env, request.kind), params);
    } else if (request.kind === 'generate') {
      const audio = await GENERATE_PROVIDERS[request.provider].generate(env, ctx.fetchFn, request);
      if (audio.bytes.byteLength > ASSET_MAX_BYTES) throw new ProviderError(502, 'provider_failed', 'audio generado de mas de 200 MB');
      const id = ctx.deps.newId('ast');
      const file = `${id}.${audio.ext}`;
      const stored = await env.STEMS.put(`${ctx.sessionPrefix}assets/${file}`, audio.bytes, { httpMetadata: { contentType: ASSET_CONTENT_TYPES[audio.ext] } });
      if (!stored || stored.size !== audio.bytes.byteLength) {
        // Lyria ya genero (y cobro): el costo queda anotado y el trabajo, fallido.
        record.status = 'FAILED';
        record.error = 'El audio generado no se pudo guardar. Genera de nuevo.';
        await saveJob(ctx, record);
        throw new ApiError(502, 'asset_copy_failed');
      }
      record.status = 'SUCCEEDED';
      record.assets = [{
        id, file, kind: 'generated', label: request.prompt.trim().slice(0, 60), role: null, size: stored.size,
        channels: null, sample_rate: null, duration_s: null,
        source: { provider: request.provider, job_id: jobId, prompt: request.prompt },
      }];
    } else {
      const result = await assistProvider(env).suggest(env, ctx.fetchFn, request.metrics);
      if (result.failure) {
        record.status = 'FAILED';
        record.error = result.failure;
      } else {
        record.status = 'SUCCEEDED';
        record.suggestions = sanitizeSuggestions(result.suggestions, new Set(request.metrics.tracks.map((t) => t.track_id)));
      }
    }
  } catch (err) {
    if (err instanceof ApiError && err.message === 'asset_copy_failed') throw err;
    // El proveedor no acepto el trabajo: no se cobra y no queda registro.
    await release();
    if (err instanceof ApiError && err.message === 'no_asset') throw err;
    providerFailure(err);
  }
  // El resultado se guarda sin condicion: mientras el trabajo no tiene id del proveedor, el GET
  // no escribe el registro (ver jobStatus).
  await saveJob(ctx, record);
}

// --------------------------------------------------------------------------- GET .../jobs/{job}

/** Extension del camino de una URL, en minusculas; '' si no tiene. */
function urlExt(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // se usa el texto tal cual
  }
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(path);
  return m ? m[1].toLowerCase() : '';
}

/** Una salida puede ser audio si su URL termina en wav, flac o mp3, o no declara extension. */
function mayBeAudioUrl(url: string): boolean {
  const ext = urlExt(url);
  return ext === '' || (ASSET_EXTENSIONS as readonly string[]).includes(ext);
}

class UnsupportedOutput extends Error {}

const NOT_AUDIO = 'Music AI devolvió una salida que no es audio WAV, FLAC ni MP3: revisa las salidas del workflow.';

/**
 * Copia una salida de Music AI a assets/. Idempotente: el id esta reservado en `record.planned`.
 * El formato sale de los primeros bytes del contenido, no del tipo ni de la URL: un JSON o un
 * contenedor que el Estudio no admite nunca queda guardado como audio.
 */
async function copyOutput(ctx: StudioContext, record: JobRecord, name: string, url: string): Promise<JobAsset> {
  let res: Response;
  try {
    res = await ctx.fetchFn(url, {});
  } catch {
    throw new ApiError(502, 'asset_copy_failed');
  }
  const length = Number(res.headers.get('Content-Length') ?? NaN);
  if (!res.ok || !res.body || !Number.isSafeInteger(length) || length < 1) throw new ApiError(502, 'asset_copy_failed');
  if (length > ASSET_MAX_BYTES) throw new UnsupportedOutput('Music AI devolvió un audio de más de 200 MB.');
  const type = (res.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const reader = res.body.getReader();
  if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) {
    await reader.cancel().catch(() => {});
    throw new UnsupportedOutput(NOT_AUDIO);
  }
  // Se leen los primeros bytes (bastan 12) y despues se reenvia el cuerpo entero a R2.
  let head = new Uint8Array(0);
  let ended = false;
  try {
    while (head.byteLength < 12 && !ended) {
      const { done, value } = await reader.read();
      if (done) ended = true;
      else {
        const joined = new Uint8Array(head.byteLength + value.byteLength);
        joined.set(head);
        joined.set(value, head.byteLength);
        head = joined;
      }
    }
  } catch {
    throw new ApiError(502, 'asset_copy_failed');
  }
  const ext = detectAudioExt(head);
  if (!ext) {
    await reader.cancel().catch(() => {});
    throw new UnsupportedOutput(NOT_AUDIO);
  }
  const id = record.planned![name];
  const file = `${id}.${ext}`;
  const key = `${ctx.sessionPrefix}assets/${file}`;
  // Otro GET ya copio esta salida (mismo id reservado, mismo contenido): no se reescribe.
  const existing = await ctx.env.STEMS.head(key);
  if (existing && existing.size === length) {
    await reader.cancel().catch(() => {});
  } else {
    let sentHead = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!sentHead) {
          sentHead = true;
          if (head.byteLength) {
            controller.enqueue(head);
            return;
          }
        }
        if (ended) {
          controller.close();
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    const stored = await ctx.env.STEMS.put(key, fixedLength(body, length), { httpMetadata: { contentType: ASSET_CONTENT_TYPES[ext] } });
    if (!stored || stored.size !== length) throw new ApiError(502, 'asset_copy_failed');
  }
  const stem = STEM_OUTPUTS[name.toLowerCase()];
  const master = record.kind === 'master';
  return {
    id, file, kind: master ? 'master' : 'stem',
    label: master ? record.label || 'Master' : stem?.[1] ?? name.slice(0, 60),
    role: master ? null : stem?.[0] ?? 'other',
    size: length, channels: null, sample_rate: null, duration_s: null,
    source: { provider: 'musicai', job_id: record.job_id },
  };
}

/** Salidas de audio de un trabajo de Music AI terminado: [nombre de la salida, URL]. */
function audioOutputs(kind: JobKind, result: Record<string, unknown>): [string, string][] {
  const urls = Object.entries(result).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith('https://'));
  if (kind === 'separate') return urls.filter(([name]) => STEM_OUTPUTS[name.toLowerCase()]);
  // master: una sola salida de audio. Se descartan las URL que declaran otra cosa (un informe
  // .json); entre las que quedan vale la unica que se llame "master...", o la unica que haya.
  // Si hay varias y ninguna se distingue no se adivina: el trabajo falla con un texto claro.
  const candidates = urls.filter(([, url]) => mayBeAudioUrl(url));
  const named = candidates.filter(([name]) => /master/i.test(name));
  if (named.length === 1) return named;
  if (candidates.length === 1) return candidates;
  if (candidates.length === 0) return [];
  throw new UnsupportedOutput('Music AI devolvió varias salidas y no se sabe cuál es el master: deja una sola salida de audio en el workflow, o llámala "master".');
}

/** Estado de un trabajo en Music AI. `transient`: no se pudo consultar ahora; `gone`: ya no existe. */
type Poll =
  | { kind: 'ok'; job: { status?: string; result?: Record<string, unknown>; error?: { message?: string } } }
  | { kind: 'transient' } | { kind: 'gone' };

async function pollMusicAi(ctx: StudioContext, externalId: string): Promise<Poll> {
  const key = (ctx.env.MUSICAI_API_KEY || '').trim();
  if (!key) return { kind: 'transient' };
  let res: Response;
  try {
    res = await ctx.fetchFn(`${MUSICAI_BASE}/job/${encodeURIComponent(externalId)}`, {
      method: 'GET', headers: { Authorization: key, 'Content-Type': 'application/json' },
    });
  } catch {
    return { kind: 'transient' };
  }
  if (res.status === 404) return { kind: 'gone' };
  if (!res.ok) {
    console.warn(`studio: sondeo de Music AI HTTP ${res.status}`);
    return { kind: 'transient' };
  }
  const job = await res.json().catch(() => null) as { status?: string } | null;
  return job && typeof job === 'object' ? { kind: 'ok', job } : { kind: 'transient' };
}

function finalResponse(record: JobRecord): Response {
  const base = { job_id: record.job_id, kind: record.kind, status: record.status };
  if (record.status === 'FAILED') return json(200, { ...base, error: record.error || 'El trabajo falló.' });
  if (record.kind === 'assist') return json(200, { ...base, suggestions: record.suggestions ?? [], cost_usd: record.cost_usd });
  return json(200, { ...base, assets: record.assets ?? [], cost_usd: record.cost_usd });
}

export async function jobStatus(ctx: StudioContext, jobId: string): Promise<Response> {
  const stored = await ctx.env.STEMS.get(jobKey(ctx, jobId));
  if (!stored) throw new ApiError(404, 'no_job');
  const record = JSON.parse(await stored.text()) as JobRecord;
  if (record.status === 'SUCCEEDED' || record.status === 'FAILED') return finalResponse(record);
  const base = { job_id: record.job_id, kind: record.kind };
  const key = jobKey(ctx, jobId);

  // Cada escritura del registro es condicional al etag que se leyo: dos GET simultaneos (dos
  // integrantes sondeando, o un sondeo que se solapa con una copia larga) no se pisan. El que
  // pierde no escribe ni copia nada mas: responde segun el registro del que gano.
  let etag = stored.etag;
  const save = async (): Promise<boolean> => {
    const put = await ctx.env.STEMS.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: 'application/json' }, onlyIf: { etagMatches: etag },
    });
    if (!put) return false;
    etag = put.etag;
    return true;
  };
  const winner = async (): Promise<Response> => {
    const current = await ctx.env.STEMS.get(key);
    if (!current) throw new ApiError(404, 'no_job');
    const r = JSON.parse(await current.text()) as JobRecord;
    if (r.status === 'SUCCEEDED' || r.status === 'FAILED') return finalResponse(r);
    if (!r.planned) return json(200, { ...base, status: 'STARTED' });
    return json(200, { ...base, status: 'IMPORTING', done: Object.keys(r.copied ?? {}).length, total: Object.keys(r.planned).length });
  };
  const failed = async (error: string) => {
    record.status = 'FAILED';
    record.error = error.slice(0, 300);
    return (await save()) ? finalResponse(record) : winner();
  };

  // Sin id del proveedor: el POST sigue en curso (espera a Lyria o al modelo, o sube la mezcla a
  // Music AI), o se interrumpio. Se informa STARTED durante el margen y despues se da por fallido.
  if (!record.external_id) {
    const age = ctx.deps.now().getTime() - Date.parse(record.created_at);
    if (Number.isFinite(age) && age < PENDING_GRACE_MS) return json(200, { ...base, status: 'STARTED' });
    return failed('El trabajo quedó incompleto. Lánzalo de nuevo.');
  }

  const poll = await pollMusicAi(ctx, record.external_id);
  // Un fallo al consultar (red, 5xx) no es un fallo del trabajo, que ya esta pagado: se informa
  // STARTED y el siguiente GET vuelve a consultar. Solo un 404 del proveedor es definitivo.
  if (poll.kind === 'transient') return json(200, { ...base, status: 'STARTED' });
  if (poll.kind === 'gone') return failed('Music AI ya no tiene este trabajo. Lánzalo de nuevo.');
  const job = poll.job;
  if (job.status === 'FAILED') return failed(String(job.error?.message || 'Music AI no pudo procesar el audio.'));
  // Cualquier estado intermedio del proveedor (en cola, procesando) se informa como STARTED.
  if (job.status !== 'SUCCEEDED' || !job.result) return json(200, { ...base, status: 'STARTED' });

  let outputs: [string, string][];
  try {
    outputs = audioOutputs(record.kind, job.result);
  } catch (err) {
    if (err instanceof UnsupportedOutput) return failed(err.message);
    throw err;
  }
  if (!outputs.length) {
    return failed(record.kind === 'master'
      ? 'Music AI no devolvió el audio masterizado: revisa que el workflow de mastering tenga una salida de audio.'
      : 'Music AI no devolvió stems: revisa que el workflow de separación los tenga como salidas.');
  }
  record.copied ??= {};
  if (!record.planned) {
    // Los ids se reservan con escritura condicional ANTES de copiar: dos primeros GET a la vez no
    // generan dos juegos de ids (el segundo dejaria audios huerfanos en assets/).
    record.planned = Object.fromEntries(outputs.map(([name]) => [name, ctx.deps.newId('ast')]));
    if (!(await save())) return winner();
  }
  const next = outputs.find(([name]) => record.planned![name] && !record.copied![name]);
  if (next) {
    try {
      record.copied[next[0]] = await copyOutput(ctx, record, next[0], next[1]);
    } catch (err) {
      if (err instanceof UnsupportedOutput) return failed(err.message);
      throw err;
    }
  }
  const known = outputs.filter(([name]) => record.planned![name]);
  const done = known.filter(([name]) => record.copied![name]).length;
  if (done < known.length) {
    if (!(await save())) return winner();
    return json(200, { ...base, status: 'IMPORTING', done, total: known.length });
  }
  record.status = 'SUCCEEDED';
  record.assets = known.map(([name]) => record.copied![name]);
  if (!(await save())) return winner();
  return finalResponse(record);
}
