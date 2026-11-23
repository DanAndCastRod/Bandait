// Trabajos de IA del Estudio (STUDIO_V1.md, seccion 6, y STUDIO_V2.md, seccion 4): master y
// separate con Music AI, generate con Lyria (Suno responde 501), assist con un modelo de lenguaje
// y, desde v2, compose y chat por el adaptador de texto (URiT IA o Gemini directo) y analyze con
// Music AI. Un trabajo nunca modifica la sesion: deja audios en assets/ o devuelve propuestas
// (sugerencias, notas, un analisis o llamadas a herramientas) que el Hub muestra al usuario.
//
// master, separate y analyze son asincronos: `POST` sube el audio a Music AI y lanza el workflow;
// cada `GET` consulta el trabajo y, cuando termina, copia UN audio a R2 (patron de copyNextStem en
// index.ts) o, en analyze, lee las salidas JSON y arma el analisis, para que ninguna peticion dure
// mas de unos segundos.
// generate, assist, compose y chat son sincronos: `POST` espera al proveedor y deja el trabajo ya
// terminado; el primer `GET` devuelve SUCCEEDED o FAILED. La espera maxima de ese camino esta en
// providers/lyria.ts (90 s) y providers/urit.ts (75 s).
//
// generate con Lyria pasa por URiT IA (POST /v1/music) desde el 2026-11-19: ya no usa la clave de
// la Gemini API directa.
//
// Proveedor de texto de compose y chat: la misma variable ASSIST_PROVIDER que assist (decision de
// STUDIO_V2.md 4, que no agrega una variable nueva): `urit` por defecto, `gemini` directo como
// alternativa; con `anthropic` responden 503 provider_unavailable.
//
//
// Gasto: el costo se RESERVA antes de llamar al proveedor (registro del trabajo en STARTED y
// entrada en los contadores de la banda y global, con escritura condicional). Si el proveedor
// rechaza la peticion (502) la reserva se revierte. Asi un trabajo cobrado nunca queda sin
// registro, y dos trabajos simultaneos no pasan los dos el tope. Cuando el proveedor informa el
// costo real (URiT IA: usage.estimated_usd), la entrada se ajusta a ese valor (settle).

import { ApiError, STEM_OUTPUTS, TransientOutputError, json, musicAi, readMusicAiOutputs } from './index.ts';
import type { MusicAiResult } from './analysis.ts';
import { anthropic } from './providers/anthropic.ts';
import { gemini, geminiText } from './providers/gemini.ts';
import { urit, uritText } from './providers/urit.ts';
import { CLIP_SECONDS, detectAudioExt, lyria, lyriaModel } from './providers/lyria.ts';
import { suno } from './providers/suno.ts';
import { ProviderError } from './providers/types.ts';
import type { AssistProvider, GenerateProvider, GenerateRequest, ProviderMeta, TextProvider } from './providers/types.ts';
import { recordEvent } from './events.ts';
import type { EventStatus } from './events.ts';
import { ASSET_CONTENT_TYPES, assertSpender, createOnly, readLimited } from './studio.ts';
import type { StudioContext } from './studio.ts';
import {
  ASSET_EXTENSIONS, ASSET_MAX_BYTES, FX_TYPES, ID_RE, MASTER_ID, MAX_PROMPT, MAX_SESSION_SECONDS, MAX_TRACKS,
  MAX_TRACK_NAME, ROLES, VOLUME_DB_MAX, VOLUME_DB_MIN, validateFxChain, validateFxParams,
} from './studioSession.ts';
import type { AssetExtension, FxType, SessionFx, SessionNote } from './studioSession.ts';
import {
  CHAT_BODY_LIMIT, COMPOSE_EMPTY, MAX_LISTEN_BYTES, buildAnalysis, bytesToBase64, chatCall, chatHasListen, classifyToolCall,
  composeCall, composeDescription, finishChat, lastUserListen, normalizeComposeNotes, validateV2JobRequest,
} from './studioV2.ts';
import type { ListenAudio } from './studioV2.ts';
import type { ChatToolCall, StudioAnalysis, V2JobRequest } from './studioV2.ts';
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
 *   lyria:    por cancion, como cobra URiT IA (CONTRACT_V1.md 4A): USD 0,04 el clip de 30 s
 *             (lyria-3-clip-preview) y USD 0,08 la cancion (lyria-3.5), sea cual sea su largo.
 *   assist:   USD 0,05 por consulta (unos 3 000 tokens de entrada y 4 000 de salida en un modelo
 *             de USD 2 / USD 10 por millon).
 *   compose:  USD 0,05 por consulta.
 *   chat:     USD 0,03 por vuelta mas USD 0,015 por cada 32 KB completos del cuerpo (conversacion y
 *             estado): una conversacion larga cuesta mas tokens de entrada (STUDIO_V2.md 4.4).
 *   analyze:  USD 0,80 por minuto: el workflow por defecto (stems-workflow-releven-bandait) tambien
 *             separa stems, asi que se cobra como separate (0,50) mas el analisis (0,30). Con un
 *             workflow solo de analisis (MUSICAI_ANALYZE_WORKFLOW) conviene bajar la tarifa.
 */
export const DEFAULT_RATES = {
  masterPerMin: 0.2, separatePerMin: 0.5, lyriaClip: 0.04, lyriaSong: 0.08, assist: 0.05, compose: 0.05, analyzePerMin: 0.8,
  chat: 0.03, chatPer32Kb: 0.015, chatListen: 0.002,
};

/** STUDIO_V2.md 4.3.5: el chat solo escucha fragmentos con STUDIO_CHAT_LISTEN = "1". */
export function listenEnabled(env: Env): boolean {
  return (env.STUDIO_CHAT_LISTEN || '').trim() === '1';
}

export type JobKind = 'master' | 'separate' | 'generate' | 'assist' | 'compose' | 'analyze' | 'chat';

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
  /** compose (STUDIO_V2.md 4.1). */
  notes?: SessionNote[]; length_beats?: number; description?: string;
  /** analyze (STUDIO_V2.md 4.2). */
  analysis?: StudioAnalysis;
  /** chat (STUDIO_V2.md 4.3.4). */
  reply?: string | null; tool_calls?: ChatToolCall[];
  /**
   * Id de la llamada en URiT IA (`ai_...`, campo `id` de su respuesta o cabecera X-Request-Id):
   * correlaciona este trabajo con el registro de URiT (docs/PLAN_MCP_BANDAIT_URIT.md, 1.4).
   */
  urit_request_id?: string;
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
  | { kind: 'assist'; metrics: Metrics }
  | V2JobRequest;

const GENERATE_PROVIDERS: Record<'lyria' | 'suno', GenerateProvider> = { lyria, suno };
const ASSIST_PROVIDERS: Record<string, AssistProvider> = { anthropic, gemini, urit };
/** compose y chat: sin anthropic (STUDIO_V2.md 4). */
const TEXT_PROVIDERS: Record<string, TextProvider> = { gemini: geminiText, urit: uritText };
/** Workflow de analisis por defecto: el mismo de `POST .../songs/{song}/analysis` (index.ts). */
const DEFAULT_ANALYSIS_WORKFLOW = 'stems-workflow-releven-bandait';

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
  // compose, analyze y chat (STUDIO_V2.md 4).
  return validateV2JobRequest(raw as Raw) ?? bad();
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
    // Una cancion por pedido: el clip corto (hasta 30 s, y siempre dura 30 s) o la cancion larga.
    const perSong = request.duration_s <= CLIP_SECONDS
      ? rate(env.STUDIO_RATE_LYRIA_CLIP_USD, DEFAULT_RATES.lyriaClip)
      : rate(env.STUDIO_RATE_LYRIA_SONG_USD, DEFAULT_RATES.lyriaSong);
    return { cost: round4(perSong), seconds: request.duration_s };
  }
  if (request.kind === 'analyze') {
    return { cost: round4((request.duration_s / 60) * rate(env.STUDIO_RATE_ANALYZE_USD_PER_MIN, DEFAULT_RATES.analyzePerMin)), seconds: request.duration_s };
  }
  if (request.kind === 'compose') return { cost: round4(rate(env.STUDIO_RATE_COMPOSE_USD, DEFAULT_RATES.compose)), seconds: 0 };
  if (request.kind === 'chat') {
    const bytes = new TextEncoder().encode(JSON.stringify([request.messages, request.session_summary])).byteLength;
    const blocks = Math.floor(bytes / 32768);
    // Recargo por vuelta que escucha un fragmento (solo el del ultimo mensaje se adjunta).
    const listen = lastUserListen(request) ? rate(env.STUDIO_RATE_CHAT_LISTEN_USD, DEFAULT_RATES.chatListen) : 0;
    return {
      cost: round4(rate(env.STUDIO_RATE_CHAT_USD, DEFAULT_RATES.chat) + blocks * rate(env.STUDIO_RATE_CHAT_USD_PER_32KB, DEFAULT_RATES.chatPer32Kb) + listen),
      seconds: 0,
    };
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

/**
 * Ajusta la entrada de un trabajo al costo real que informo el proveedor (puede subir o bajar; si
 * sube, el total puede quedar por encima del tope: es gasto ya hecho). Sin entrada no escribe.
 */
async function settleUsage(ctx: StudioContext, slot: UsageSlot, jobId: string, cost: number): Promise<void> {
  await updateUsage(ctx, slot, (file) => {
    const entry = file.entries.find((e) => e.job_id === jobId);
    if (!entry || Math.abs(entry.cost_usd - cost) < 1e-9) return false;
    file.total_usd = Math.max(0, round4(file.total_usd - entry.cost_usd + cost));
    entry.cost_usd = cost;
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
    throw new ApiError(err.status, err.code, err.publicDetail);
  }
  // musicAi() de index.ts habla con los codigos del analisis: aqui todo fallo suyo es del proveedor.
  if (err instanceof ApiError) throw new ApiError(502, 'provider_failed');
  throw err;
}

function textProviderName(env: Env): string {
  return (env.ASSIST_PROVIDER || '').trim().toLowerCase() || 'urit';
}

function assistProvider(env: Env): AssistProvider {
  const name = textProviderName(env);
  const provider = ASSIST_PROVIDERS[name];
  if (!provider) throw new ProviderError(503, 'provider_unavailable', `ASSIST_PROVIDER desconocido: ${name.slice(0, 40)}`);
  return provider;
}

/** Adaptador de texto de compose y chat. Con `anthropic` (solo assist) o un nombre desconocido: 503. */
function textProvider(env: Env): TextProvider {
  const name = textProviderName(env);
  const provider = TEXT_PROVIDERS[name];
  if (!provider) throw new ProviderError(503, 'provider_unavailable', `ASSIST_PROVIDER sin compose ni chat: ${name.slice(0, 40)}`);
  return provider;
}

type MusicAiKind = 'master' | 'separate' | 'analyze';

function musicAiWorkflow(env: Env, kind: MusicAiKind): string {
  if (!(env.MUSICAI_API_KEY || '').trim()) throw new ProviderError(503, 'provider_unavailable', 'falta MUSICAI_API_KEY');
  // separate usa el mismo workflow y el mismo valor por defecto que `POST .../analysis?separate=1`;
  // analyze, el del analisis de canciones (`POST .../analysis`).
  if (kind === 'analyze') return (env.MUSICAI_ANALYZE_WORKFLOW || '').trim() || (env.MUSICAI_WORKFLOW || '').trim() || DEFAULT_ANALYSIS_WORKFLOW;
  const workflow = kind === 'master' ? (env.MUSICAI_MASTER_WORKFLOW || '').trim() : (env.MUSICAI_SPLIT_WORKFLOW || '').trim() || 'splited_stems_bandait';
  if (!workflow) throw new ProviderError(503, 'provider_unavailable', 'falta MUSICAI_MASTER_WORKFLOW');
  return workflow;
}

function isMusicAiKind(kind: JobKind): kind is MusicAiKind {
  return kind === 'master' || kind === 'separate' || kind === 'analyze';
}

/** Lanza ProviderError si el trabajo no se puede lanzar con la configuracion actual. */
function assertAvailable(env: Env, request: JobRequest): void {
  if (isMusicAiKind(request.kind)) musicAiWorkflow(env, request.kind);
  else if (request.kind === 'generate') GENERATE_PROVIDERS[request.provider].assertAvailable(env);
  else if (request.kind === 'compose' || request.kind === 'chat') {
    if (request.kind === 'chat' && chatHasListen(request) && !listenEnabled(env)) {
      const err = new ProviderError(503, 'provider_unavailable', 'chat con audio y STUDIO_CHAT_LISTEN distinto de "1"');
      err.publicDetail = 'listen_disabled';
      throw err;
    }
    textProvider(env).assertAvailable(env);
  } else assistProvider(env).assertAvailable(env);
}

/**
 * Fragmento a escuchar del ultimo mensaje `user` (STUDIO_V2.md 4.3.5): `assets/<id>.wav` o `.mp3`.
 * 404 no_asset si no esta; 400 bad_job si pesa mas de 1 MiB. null si el chat no escucha.
 */
async function findListenAsset(ctx: StudioContext, request: JobRequest): Promise<{ file: string; size: number } | null> {
  if (request.kind !== 'chat') return null;
  const listen = lastUserListen(request);
  if (!listen) return null;
  for (const ext of ['wav', 'mp3'] as const) {
    const head = await ctx.env.STEMS.head(`${ctx.sessionPrefix}assets/${listen.asset_id}.${ext}`);
    if (!head) continue;
    if (head.size > MAX_LISTEN_BYTES || head.size < 1) bad();
    return { file: `${listen.asset_id}.${ext}`, size: head.size };
  }
  throw new ApiError(404, 'no_asset');
}

/** Lee el fragmento de R2 y lo deja listo como parte `inline` (base64). */
async function readListenAudio(ctx: StudioContext, input: { file: string; size: number }): Promise<ListenAudio> {
  const obj = await ctx.env.STEMS.get(`${ctx.sessionPrefix}assets/${input.file}`);
  if (!obj) throw new ApiError(404, 'no_asset');
  const bytes = new Uint8Array(await new Response(obj.body).arrayBuffer());
  if (bytes.byteLength > MAX_LISTEN_BYTES || bytes.byteLength < 1) bad();
  return { mime_type: input.file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', data: bytesToBase64(bytes) };
}

function providerName(env: Env, request: JobRequest): string {
  if (request.kind === 'generate') return request.provider;
  if (request.kind === 'assist' || request.kind === 'compose' || request.kind === 'chat') return textProviderName(env);
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
  ctx: StudioContext, kind: MusicAiKind, file: string, workflow: string, params: Record<string, unknown>,
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

// --------------------------------------------------------------------------- registro de eventos

/** Lo que se sabe de un fallo o de un final para el evento (src/events.ts). Nunca contenido. */
interface EventExtra {
  meta?: ProviderMeta;
  http?: number | null;
  code?: string | null;
  detail?: unknown;
  model?: string | null;
  durationMs?: number | null;
  cost?: number | null;
}

/** Workflow de Music AI de un tipo de trabajo, sin lanzar si falta la configuracion. */
function workflowName(env: Env, kind: JobKind): string | null {
  try {
    return isMusicAiKind(kind) ? musicAiWorkflow(env, kind) : null;
  } catch {
    return null;
  }
}

/** Modelo que se anota cuando el proveedor no lo informa. */
function fallbackModel(env: Env, kind: JobKind, provider: string, durationS: number | null): string | null {
  if (kind === 'generate' && provider === 'lyria' && durationS !== null) return lyriaModel(env, durationS);
  if (isMusicAiKind(kind)) return workflowName(env, kind);
  if (provider === 'gemini' || provider === 'anthropic') return (env.ASSIST_MODEL || '').trim() || null;
  return null;
}

/** Estado HTTP escrito en el detalle de un ProviderError (`... HTTP 502 ...`), si no vino en meta. */
function httpFromDetail(detail: string): number | null {
  const m = /HTTP (\d{3})\b/.exec(detail);
  return m ? Number(m[1]) : null;
}

function emitJobEvent(
  ctx: StudioContext, job: { job_id: string | null; kind: JobKind; provider: string; urit_request_id?: string },
  status: EventStatus, extra: EventExtra = {},
): void {
  const meta = extra.meta ?? {};
  recordEvent(ctx.env, ctx.deps, {
    band: ctx.studioPrefix.replace(/\/studio\/$/, ''),
    session: ctx.session,
    job: job.job_id,
    kind: job.kind,
    provider: job.provider,
    status,
    http: extra.http ?? meta.http ?? null,
    provider_code: extra.code ?? meta.code ?? null,
    provider_detail: extra.detail ?? meta.detail ?? null,
    urit_request_id: meta.requestId ?? job.urit_request_id ?? null,
    model: meta.model ?? extra.model ?? null,
    duration_ms: extra.durationMs ?? null,
    cost_usd: extra.cost ?? null,
  });
}

/** Evento de un proveedor que no acepto el trabajo (ProviderError, o un fallo de musicAi()). */
function emitRejected(
  ctx: StudioContext, job: { job_id: string | null; kind: JobKind; provider: string }, err: unknown, extra: EventExtra = {},
): void {
  if (err instanceof ProviderError) {
    emitJobEvent(ctx, job, 'REJECTED', {
      ...extra,
      meta: err.meta,
      http: err.meta.http !== undefined ? err.meta.http : httpFromDetail(err.detail),
      code: err.meta.code || err.code,
      detail: err.meta.detail ?? err.detail,
    });
  } else if (err instanceof ApiError) {
    emitJobEvent(ctx, job, 'REJECTED', { ...extra, code: err.message });
  }
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
  // El cuerpo se lee hasta el tope de chat (192 KB); los demas trabajos siguen en 64 KB.
  const text = await readLimited(req, CHAT_BODY_LIMIT);
  if (text === null) bad();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    bad();
  }
  if ((raw as { kind?: unknown } | null)?.kind !== 'chat' && new TextEncoder().encode(text).byteLength > JOB_BODY_LIMIT) bad();
  const parsed = validateJobRequest(raw);
  const { env } = ctx;
  assertSpender(env, ctx.user);
  try {
    assertAvailable(env, parsed);
  } catch (err) {
    // Configuracion que falta (secreto, workflow): se anota al lanzar, no al estimar (el Hub estima
    // para habilitar los botones y llenaria el registro).
    if (!estimate) {
      const provider = providerName(env, parsed);
      const seconds = 'duration_s' in parsed && typeof parsed.duration_s === 'number' ? parsed.duration_s : null;
      emitRejected(ctx, { job_id: clientJobId, kind: parsed.kind, provider }, err, { model: fallbackModel(env, parsed.kind, provider, seconds) });
    }
    providerFailure(err);
  }
  // `input`: el audio de assets/ que usa el trabajo (Music AI) o el fragmento que escucha el chat.
  const input = isMusicAiKind(parsed.kind) ? await findAsset(ctx, (parsed as { asset_id: string }).asset_id) : await findListenAsset(ctx, parsed);
  // master, separate y analyze se cobran por la duracion real del audio en R2, no por la que
  // declara el cliente: se toma la mayor de las dos (un cliente que declara de menos no baja el costo).
  const request: JobRequest = input && (parsed.kind === 'master' || parsed.kind === 'separate' || parsed.kind === 'analyze')
    ? { ...parsed, duration_s: Math.max(parsed.duration_s, await assetSeconds(ctx, input)) }
    : parsed;

  const { cost, seconds } = estimateCost(env, request);
  const slots = usageSlots(ctx);
  if (estimate) {
    const [band, global] = await Promise.all([readUsage(ctx, slots.band), readUsage(ctx, slots.global)]);
    const allowed = fits(band.file.total_usd, cost, slots.band.budget) && fits(global.file.total_usd, cost, slots.global.budget);
    // `listen` (solo chat, STUDIO_V2.md 4.3): el Hub muestra ESCUCHAR FRAGMENTO solo si es true.
    const extra = request.kind === 'chat' ? { listen: listenEnabled(env) } : {};
    return json(200, { kind: request.kind, estimated_cost_usd: cost, spent_usd: band.file.total_usd, budget_usd: slots.band.budget, allowed, ...extra });
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
  // Costo real informado por el proveedor: ajusta los dos contadores y el registro. Un fallo al
  // ajustar no rompe el trabajo (queda la estimacion, que ya esta anotada).
  const settle = async (actual: number | null | undefined) => {
    if (actual === null || actual === undefined || !Number.isFinite(actual) || actual < 0) return;
    const real = round4(actual);
    if (Math.abs(real - record.cost_usd) < 1e-9) return;
    await settleUsage(ctx, slots.band, jobId, real).catch(() => {});
    await settleUsage(ctx, slots.global, jobId, real).catch(() => {});
    record.cost_usd = real;
  };
  const work = runProvider(ctx, request, record, input, release, settle);
  ctx.deps.waitUntil?.(work.catch(() => {}));
  await work;
  // El contrato responde siempre STARTED: el estado real (tambien el de generate y assist, que ya
  // terminaron) se lee con GET .../jobs/{job}.
  return started();
}

/** Llama al proveedor y guarda el resultado. Si el proveedor rechaza, revierte la reserva. */
async function runProvider(
  ctx: StudioContext, request: JobRequest, record: JobRecord, input: { file: string; size: number } | null,
  release: () => Promise<void>, settle: (actual: number | null | undefined) => Promise<void>,
): Promise<void> {
  const { env } = ctx;
  const jobId = record.job_id;
  const startedMs = ctx.deps.now().getTime();
  const seconds = 'duration_s' in request && typeof request.duration_s === 'number' ? request.duration_s : null;
  const model = fallbackModel(env, request.kind, record.provider, seconds);
  // Metadatos de la respuesta del proveedor (id de URiT IA, modelo, codigo): para el registro del
  // trabajo y el evento. Nunca el contenido.
  let meta: ProviderMeta | undefined;
  const keep = (m: ProviderMeta | undefined) => {
    meta = m;
    if (m?.requestId) record.urit_request_id = m.requestId;
  };
  /** Guarda el registro y, si el trabajo ya termino (sincrono), anota el evento. */
  const finish = async () => {
    await saveJob(ctx, record);
    if (record.status === 'SUCCEEDED' || record.status === 'FAILED') {
      emitJobEvent(ctx, record, record.status, {
        meta, model, durationMs: ctx.deps.now().getTime() - startedMs, cost: record.cost_usd,
        // En un FAILED sin codigo del proveedor (respuesta ilegible, sin notas) queda el motivo corto.
        code: record.status === 'FAILED' && !meta?.code ? 'job_failed' : undefined,
      });
    }
  };
  try {
    if (request.kind === 'analyze') {
      // El analisis no deja audios: el resultado se arma en el GET con las salidas JSON.
      record.external_id = await launchMusicAi(ctx, 'analyze', input!.file, musicAiWorkflow(env, 'analyze'), {});
    } else if (request.kind === 'compose') {
      const result = await textProvider(env).json(env, ctx.fetchFn, composeCall(request));
      keep(result.meta);
      await settle(result.costUsd);
      const lengthBeats = request.length_bars * request.beats_per_bar;
      // Desde aqui el modelo ya respondio: un problema es un trabajo FAILED y el costo queda.
      if (result.failure !== null) {
        record.status = 'FAILED';
        record.error = result.failure;
      } else {
        const out = result.value as { notes?: unknown; description?: unknown };
        const notes = normalizeComposeNotes(out.notes, lengthBeats, request.role);
        if (!notes.length) {
          record.status = 'FAILED';
          record.error = COMPOSE_EMPTY;
        } else {
          record.status = 'SUCCEEDED';
          record.notes = notes;
          record.length_beats = lengthBeats;
          record.description = composeDescription(out.description);
        }
      }
    } else if (request.kind === 'chat') {
      // Fragmento a escuchar (4.3.5): ya se comprobo en startJob que existe y que la variable lo permite.
      const listen = input ? await readListenAudio(ctx, input) : null;
      const result = await textProvider(env).chat(env, ctx.fetchFn, chatCall(request, listen));
      keep(result.meta);
      await settle(result.costUsd);
      const done = result.failure !== null ? { failure: result.failure } : finishChat(result.value, request.tool_mode);
      if ('failure' in done) {
        record.status = 'FAILED';
        record.error = done.failure;
      } else {
        record.status = 'SUCCEEDED';
        record.reply = done.reply;
        record.tool_calls = done.tool_calls;
        // Solo se cuentan: el Hub responde `failed` a estas llamadas (STUDIO_V2.md 4.3.4).
        const odd = done.tool_calls.filter((c) => classifyToolCall(c) !== 'ok').length;
        if (odd) console.warn(`studio chat: ${odd} llamada(s) fuera de la lista o con argumentos invalidos`);
      }
    } else if (request.kind === 'master' || request.kind === 'separate') {
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
      const generated = await GENERATE_PROVIDERS[request.provider].generate(env, ctx.fetchFn, request);
      keep(generated.meta);
      // Costo real (URiT: usage.estimated_usd; 0 si no cobro: bloqueo, sin audio, cuota).
      await settle(generated.costUsd);
      if (generated.failure !== null) {
        record.status = 'FAILED';
        record.error = generated.failure;
        await finish();
        return;
      }
      const audio = generated.audio;
      if (audio.bytes.byteLength > ASSET_MAX_BYTES) {
        record.status = 'FAILED';
        record.error = 'El audio generado pesa más de 200 MB y no se guardó.';
        await finish();
        return;
      }
      const id = ctx.deps.newId('ast');
      const file = `${id}.${audio.ext}`;
      const stored = await env.STEMS.put(`${ctx.sessionPrefix}assets/${file}`, audio.bytes, { httpMetadata: { contentType: ASSET_CONTENT_TYPES[audio.ext] } });
      if (!stored || stored.size !== audio.bytes.byteLength) {
        // Lyria ya genero (y cobro): el costo queda anotado y el trabajo, fallido.
        record.status = 'FAILED';
        record.error = 'El audio generado no se pudo guardar. Genera de nuevo.';
        await finish();
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
      keep(result.meta);
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
    emitRejected(ctx, record, err, { model, durationMs: ctx.deps.now().getTime() - startedMs });
    providerFailure(err);
  }
  // El resultado se guarda sin condicion: mientras el trabajo no tiene id del proveedor, el GET
  // no escribe el registro (ver jobStatus).
  await finish();
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
  /** `http`: estado del proveedor si respondio; `code`: que fallo (para el registro de eventos). */
  | { kind: 'transient'; http?: number | null; code?: string } | { kind: 'gone' };

async function pollMusicAi(ctx: StudioContext, externalId: string): Promise<Poll> {
  const key = (ctx.env.MUSICAI_API_KEY || '').trim();
  if (!key) return { kind: 'transient' };
  let res: Response;
  try {
    res = await ctx.fetchFn(`${MUSICAI_BASE}/job/${encodeURIComponent(externalId)}`, {
      method: 'GET', headers: { Authorization: key, 'Content-Type': 'application/json' },
    });
  } catch {
    return { kind: 'transient', http: null, code: 'poll_network' };
  }
  if (res.status === 404) return { kind: 'gone' };
  if (!res.ok) {
    console.warn(`studio: sondeo de Music AI HTTP ${res.status}`);
    return { kind: 'transient', http: res.status, code: 'poll_http' };
  }
  const job = await res.json().catch(() => null) as { status?: string } | null;
  return job && typeof job === 'object' ? { kind: 'ok', job } : { kind: 'transient', http: res.status, code: 'poll_unreadable' };
}

function finalResponse(record: JobRecord): Response {
  const base = { job_id: record.job_id, kind: record.kind, status: record.status };
  if (record.status === 'FAILED') return json(200, { ...base, error: record.error || 'El trabajo falló.' });
  if (record.kind === 'assist') return json(200, { ...base, suggestions: record.suggestions ?? [], cost_usd: record.cost_usd });
  // STUDIO_V2.md 4.5.
  if (record.kind === 'compose') {
    return json(200, { ...base, notes: record.notes ?? [], length_beats: record.length_beats, description: record.description ?? '', cost_usd: record.cost_usd });
  }
  if (record.kind === 'analyze') return json(200, { ...base, analysis: record.analysis, cost_usd: record.cost_usd });
  if (record.kind === 'chat') return json(200, { ...base, reply: record.reply ?? null, tool_calls: record.tool_calls ?? [], cost_usd: record.cost_usd });
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
  // Registro de eventos: desde la creacion del trabajo hasta este GET.
  const elapsed = () => {
    const ms = ctx.deps.now().getTime() - Date.parse(record.created_at);
    return Number.isFinite(ms) ? ms : null;
  };
  const model = fallbackModel(ctx.env, record.kind, record.provider, null);
  /** Evento del final, solo si este GET fue el que escribio el registro (el que pierde no anota). */
  const finished = (extra: EventExtra = {}) => {
    if (record.status !== 'SUCCEEDED' && record.status !== 'FAILED') return;
    emitJobEvent(ctx, record, record.status, { model, durationMs: elapsed(), cost: record.cost_usd, ...extra });
  };
  const failed = async (error: string, extra: EventExtra = {}) => {
    record.status = 'FAILED';
    record.error = error.slice(0, 300);
    if (!(await save())) return winner();
    finished({ code: 'job_failed', ...extra });
    return finalResponse(record);
  };
  const succeeded = async () => {
    record.status = 'SUCCEEDED';
    if (!(await save())) return winner();
    finished();
    return finalResponse(record);
  };

  // Sin id del proveedor: el POST sigue en curso (espera a Lyria o al modelo, o sube la mezcla a
  // Music AI), o se interrumpio. Se informa STARTED durante el margen y despues se da por fallido.
  if (!record.external_id) {
    const age = ctx.deps.now().getTime() - Date.parse(record.created_at);
    if (Number.isFinite(age) && age < PENDING_GRACE_MS) return json(200, { ...base, status: 'STARTED' });
    return failed('El trabajo quedó incompleto. Lánzalo de nuevo.', { code: 'incomplete' });
  }

  const poll = await pollMusicAi(ctx, record.external_id);
  // Un fallo al consultar (red, 5xx) no es un fallo del trabajo, que ya esta pagado: se informa
  // STARTED y el siguiente GET vuelve a consultar. Solo un 404 del proveedor es definitivo.
  if (poll.kind === 'transient') {
    if (poll.code) emitJobEvent(ctx, record, 'TRANSIENT', { model, http: poll.http ?? null, code: poll.code, durationMs: elapsed() });
    return json(200, { ...base, status: 'STARTED' });
  }
  if (poll.kind === 'gone') return failed('Music AI ya no tiene este trabajo. Lánzalo de nuevo.', { http: 404, code: 'job_gone' });
  const job = poll.job;
  if (job.status === 'FAILED') {
    return failed(String(job.error?.message || 'Music AI no pudo procesar el audio.'), { code: 'job_failed', detail: job.error?.message ?? null });
  }
  // Cualquier estado intermedio del proveedor (en cola, procesando) se informa como STARTED.
  if (job.status !== 'SUCCEEDED' || !job.result) return json(200, { ...base, status: 'STARTED' });

  if (record.kind === 'analyze') {
    // Salidas JSON del workflow (las de audio no se leen ni se copian) -> Analysis de STUDIO_V2.md 4.2.
    // strict: una salida que no se pudo descargar ahora (red o 5xx) no sella el trabajo, que ya esta
    // cobrado y cuyo resultado crudo no se guarda: se informa STARTED y el siguiente GET reintenta.
    let result: Record<string, unknown>;
    try {
      result = await readMusicAiOutputs(Object.entries(job.result), ctx.fetchFn, { strict: true });
    } catch (err) {
      if (err instanceof TransientOutputError) {
        emitJobEvent(ctx, record, 'TRANSIENT', { model, code: 'output_download', durationMs: elapsed() });
        return json(200, { ...base, status: 'STARTED' });
      }
      throw err;
    }
    let analysis: StudioAnalysis;
    try {
      analysis = buildAnalysis(result as MusicAiResult);
    } catch (err) {
      // buildAnalysis es defensivo; si aun asi una forma inesperada lo rompe, el trabajo falla con
      // un texto en vez de responder 500 en cada GET y quedar en STARTED para siempre.
      console.warn(`studio analyze: analisis ilegible (${err instanceof Error ? err.message.slice(0, 120) : 'error'})`);
      return failed('Music AI devolvió un análisis que no se pudo leer.');
    }
    record.analysis = analysis;
    return succeeded();
  }

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
      if (err instanceof UnsupportedOutput) return failed(err.message, { code: 'unsupported_output' });
      // La descarga del audio desde Music AI fallo: el trabajo sigue y el siguiente GET reintenta.
      if (err instanceof ApiError && err.message === 'asset_copy_failed') {
        emitJobEvent(ctx, record, 'TRANSIENT', { model, code: 'asset_copy_failed', durationMs: elapsed() });
      }
      throw err;
    }
  }
  const known = outputs.filter(([name]) => record.planned![name]);
  const done = known.filter(([name]) => record.copied![name]).length;
  if (done < known.length) {
    if (!(await save())) return winner();
    return json(200, { ...base, status: 'IMPORTING', done, total: known.length });
  }
  record.assets = known.map(([name]) => record.copied![name]);
  return succeeded();
}
