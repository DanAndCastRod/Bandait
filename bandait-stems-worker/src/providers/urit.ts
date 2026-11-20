// Asistente de mezcla y, desde el Estudio v2, `compose` y `chat` (STUDIO_V2.md 4) por URiT IA
// (`urit-ai`), como consumidor `bandait`. Proveedor por defecto. compose pide JSON con esquema
// (task `studio_compose`); chat manda `tools` y `tool_mode` (CONTRACT_V1.md 3.2, desde 0.2.0) y
// devuelve las llamadas con su `signature` (task `studio_chat`).
//
// Recomendacion de la sesion de URiT (2026-11-19), aceptada por Daniel Castaneda: el texto no usa
// la clave de Gemini directa, para no competir por la cuota de los mismos modelos con Releven y
// accntant; pasa por urit-ai, que lleva cadena de modelos con reintento, topes por consumidor y
// registro de uso. Desde el 2026-11-19 Lyria tambien pasa por urit-ai (POST /v1/music, seccion 4A
// de su contrato): providers/lyria.ts, con estas mismas cabeceras.
//
// Contrato: URiT/workers/ai/CONTRACT_V1.md (v1, codigo 0.2.0).
//   POST {URIT_AI_URL}/v1/text
//   cabeceras: Authorization: Bearer <URIT_AI_TOKEN>, X-URiT-Consumer: <URIT_AI_CONSUMER>,
//              User-Agent propio, Content-Type: application/json
//   cuerpo:    task, system, messages[{role, parts[{text}]}], output {format: json, schema},
//              max_output_tokens (incluye el razonamiento), thinking, time_budget_ms
//   200:       output.json (ya parseado), finish_reason, usage.estimated_usd
//   errores:   {"error": codigo}; 401/403/503 configuracion, 429 cuota o tope, 502 invalid_output,
//              blocked o provider_error, 504 time_budget_exhausted.
// No se fija modelo: queda la cadena por defecto de URiT (recomendacion de esa sesion).

import { FAILURE_BLOCKED, FAILURE_TRUNCATED, FAILURE_UNREADABLE, ProviderError } from './types.ts';
import type {
  AssistProvider, AssistResult, ChatCall, ChatOutput, JsonCall, ProviderToolCall, TextProvider, TextResult,
} from './types.ts';
import { ASSIST_SYSTEM_PROMPT, SUGGESTIONS_SCHEMA } from './anthropic.ts';
import type { Env, FetchLike } from '../types.ts';

export const DEFAULT_URIT_AI_URL = 'https://ai.urit.services';
export const DEFAULT_URIT_AI_CONSUMER = 'bandait';
const USER_AGENT = 'bandait-stems/1.0';
const TASK = 'mix_assist';
const MAX_OUTPUT_TOKENS = 8192;
/** Bajo el corte de 100 s de Cloudflare, con margen para el resto de la peticion del Hub. */
const TIME_BUDGET_MS = 70000;
/**
 * Espera maxima del lado del Worker: time_budget_ms + 5 s (CONTRACT_V1.md 3.3). Pasada, la llamada
 * se aborta y se trata como 'sin respuesta' (502 provider_failed, la reserva se revierte).
 */
const WORKER_TIMEOUT_MS = TIME_BUDGET_MS + 5000;

export function uritAiUrl(env: Env): string {
  const raw = (env.URIT_AI_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[A-Za-z0-9.-]+$/.test(raw) ? raw : DEFAULT_URIT_AI_URL;
}

export function uritAiConsumer(env: Env): string {
  const raw = (env.URIT_AI_CONSUMER || '').trim();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(raw) ? raw : DEFAULT_URIT_AI_CONSUMER;
}

interface UritResponse {
  output?: { json?: unknown; text?: unknown; tool_calls?: unknown };
  finish_reason?: unknown;
  usage?: { estimated_usd?: unknown };
  error?: unknown;
}

/** Cabeceras de toda llamada a URiT IA (CONTRACT_V1.md 2): texto y musica. */
export function uritHeaders(env: Env, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-URiT-Consumer': uritAiConsumer(env),
    'User-Agent': USER_AGENT,
    'Content-Type': 'application/json',
  };
}

/** usage.estimated_usd (texto decimal o numero) como numero, o null si no viene o no es valido. */
export function readEstimatedUsd(body: unknown): number | null {
  const raw = (body as { usage?: { estimated_usd?: unknown } } | null)?.usage?.estimated_usd;
  const n = typeof raw === 'string' ? Number(raw.trim()) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1000 ? n : null;
}

export const urit: AssistProvider = {
  assertAvailable(env: Env): void {
    if (!(env.URIT_AI_TOKEN || '').trim()) throw new ProviderError(503, 'provider_unavailable', 'falta URIT_AI_TOKEN');
  },

  async suggest(env: Env, fetchFn: FetchLike, metrics: unknown): Promise<AssistResult> {
    const token = (env.URIT_AI_TOKEN || '').trim();
    if (!token) throw new ProviderError(503, 'provider_unavailable', 'falta URIT_AI_TOKEN');
    let res: Response;
    try {
      res = await fetchFn(`${uritAiUrl(env)}/v1/text`, {
        method: 'POST',
        headers: uritHeaders(env, token),
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
        body: JSON.stringify({
          task: TASK,
          system: ASSIST_SYSTEM_PROMPT,
          messages: [{ role: 'user', parts: [{ text: `Mediciones de la mezcla:\n${JSON.stringify(metrics)}` }] }],
          output: { format: 'json', schema: SUGGESTIONS_SCHEMA },
          max_output_tokens: MAX_OUTPUT_TOKENS,
          thinking: 'low',
          time_budget_ms: TIME_BUDGET_MS,
        }),
      });
    } catch {
      throw new ProviderError(502, 'provider_failed', 'urit-ai: sin respuesta');
    }
    const body = (await res.json().catch(() => null)) as UritResponse | null;
    const code = typeof body?.error === 'string' ? body.error.slice(0, 60) : '';
    if (!res.ok) {
      // Configuracion (token, consumidor apagado, proveedor sin llave): el boton queda como no disponible.
      if (res.status === 401 || res.status === 403 || res.status === 503) {
        throw new ProviderError(503, 'provider_unavailable', `urit-ai: HTTP ${res.status} ${code}`);
      }
      // Bloqueo o JSON invalido tras toda la cadena: la consulta llego al modelo; se informa como fallo.
      if (res.status === 502 && (code === 'blocked' || code === 'invalid_output')) {
        return {
          suggestions: [],
          failure: code === 'blocked' ? 'El asistente no pudo responder a este pedido.' : 'El asistente devolvió una respuesta que no se pudo leer. Intenta de nuevo.',
        };
      }
      throw new ProviderError(502, 'provider_failed', `urit-ai: HTTP ${res.status} ${code}`);
    }
    if (!body) throw new ProviderError(502, 'provider_failed', 'urit-ai: respuesta ilegible');
    if (body.finish_reason === 'max_tokens') return { suggestions: [], failure: 'La respuesta del asistente quedó incompleta. Intenta de nuevo.' };
    const parsed = body.output?.json as { suggestions?: unknown } | null | undefined;
    if (!parsed || !Array.isArray(parsed.suggestions)) {
      return { suggestions: [], failure: 'El asistente devolvió una respuesta que no se pudo leer. Intenta de nuevo.' };
    }
    return { suggestions: parsed.suggestions, failure: null };
  },
};

// ---------------------------------------------------------------------------- compose y chat (STUDIO_V2.md 4)

/**
 * POST /v1/text con el cuerpo dado. Devuelve la respuesta 200 ya leida, o el texto del trabajo
 * FAILED si la consulta llego al modelo pero no sirve (bloqueo, JSON invalido tras toda la cadena,
 * respuesta cortada). Lo que no se cobra (token, red, cuota, 5xx) se lanza como ProviderError.
 */
async function postText(env: Env, fetchFn: FetchLike, body: Record<string, unknown>): Promise<TextResult<UritResponse>> {
  const token = (env.URIT_AI_TOKEN || '').trim();
  if (!token) throw new ProviderError(503, 'provider_unavailable', 'falta URIT_AI_TOKEN');
  let res: Response;
  try {
    res = await fetchFn(`${uritAiUrl(env)}/v1/text`, {
      method: 'POST',
      headers: uritHeaders(env, token),
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      body: JSON.stringify({ ...body, max_output_tokens: MAX_OUTPUT_TOKENS, thinking: 'low', time_budget_ms: TIME_BUDGET_MS }),
    });
  } catch {
    throw new ProviderError(502, 'provider_failed', 'urit-ai: sin respuesta');
  }
  const parsed = (await res.json().catch(() => null)) as UritResponse | null;
  const code = typeof parsed?.error === 'string' ? parsed.error.slice(0, 60) : '';
  const costUsd = readEstimatedUsd(parsed);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403 || res.status === 503) {
      throw new ProviderError(503, 'provider_unavailable', `urit-ai: HTTP ${res.status} ${code}`);
    }
    if (res.status === 502 && code === 'blocked') return { value: null, failure: FAILURE_BLOCKED, costUsd };
    if (res.status === 502 && code === 'invalid_output') return { value: null, failure: FAILURE_UNREADABLE, costUsd };
    // 400 invalid_request con detail "tool_mode" es un URiT anterior a 0.2.0 (CONTRACT_V1.md 3.2).
    throw new ProviderError(502, 'provider_failed', `urit-ai: HTTP ${res.status} ${code}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new ProviderError(502, 'provider_failed', 'urit-ai: respuesta ilegible');
  if (parsed.finish_reason === 'max_tokens') return { value: null, failure: FAILURE_TRUNCATED, costUsd };
  return { value: parsed, failure: null, costUsd };
}

/** Texto y llamadas de `output` (CONTRACT_V1.md 3.4). Una llamada sin nombre es salida ilegible. */
export function readUritChat(body: UritResponse): ChatOutput | null {
  const out = body.output && typeof body.output === 'object' ? body.output : {};
  const raw = out.tool_calls ?? [];
  if (!Array.isArray(raw)) return null;
  const toolCalls: ProviderToolCall[] = [];
  for (const item of raw) {
    const c = item as { name?: unknown; arguments?: unknown; signature?: unknown } | null;
    if (!c || typeof c !== 'object' || typeof c.name !== 'string') return null;
    const args = c.arguments && typeof c.arguments === 'object' && !Array.isArray(c.arguments) ? (c.arguments as Record<string, unknown>) : {};
    toolCalls.push({ name: c.name, arguments: args, signature: typeof c.signature === 'string' && c.signature ? c.signature : null });
  }
  return {
    text: typeof out.text === 'string' ? out.text : '',
    toolCalls,
    finish: typeof body.finish_reason === 'string' ? body.finish_reason : 'stop',
  };
}

/** compose y chat por URiT IA. Sin `models`: manda la cadena de URiT (CONTRACT_V1.md 3.3). */
export const uritText: TextProvider = {
  assertAvailable(env: Env): void {
    urit.assertAvailable(env);
  },

  async json(env: Env, fetchFn: FetchLike, call: JsonCall): Promise<TextResult<unknown>> {
    const result = await postText(env, fetchFn, {
      task: call.task,
      system: call.system,
      messages: [{ role: 'user', parts: [{ text: call.user }] }],
      output: { format: 'json', schema: call.schema },
    });
    if (result.failure !== null) return result;
    const parsed = result.value.output?.json;
    if (parsed === null || parsed === undefined || typeof parsed !== 'object') return { value: null, failure: FAILURE_UNREADABLE, costUsd: result.costUsd };
    return { value: parsed, failure: null, costUsd: result.costUsd };
  },

  async chat(env: Env, fetchFn: FetchLike, call: ChatCall): Promise<TextResult<ChatOutput>> {
    const result = await postText(env, fetchFn, {
      task: call.task,
      system: call.system,
      messages: call.messages,
      tools: call.tools,
      tool_mode: call.toolMode,
    });
    if (result.failure !== null) return result;
    const output = readUritChat(result.value);
    return output ? { value: output, failure: null, costUsd: result.costUsd } : { value: null, failure: FAILURE_UNREADABLE, costUsd: result.costUsd };
  },
};
