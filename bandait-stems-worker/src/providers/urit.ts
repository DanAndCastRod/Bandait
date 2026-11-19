// Asistente de mezcla por URiT IA (`urit-ai`), como consumidor `bandait`. Proveedor por defecto.
//
// Recomendacion de la sesion de URiT (2026-11-19), aceptada por Daniel Castaneda: el texto no usa
// la clave de Gemini directa, para no competir por la cuota de los mismos modelos con Releven y
// accntant; pasa por urit-ai, que lleva cadena de modelos con reintento, topes por consumidor y
// registro de uso. Lyria si usa la clave directa (urit-ai solo hace texto): providers/lyria.ts.
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

import { ProviderError } from './types.ts';
import type { AssistProvider, AssistResult } from './types.ts';
import { ASSIST_SYSTEM_PROMPT, SUGGESTIONS_SCHEMA } from './anthropic.ts';
import type { Env, FetchLike } from '../types.ts';

export const DEFAULT_URIT_AI_URL = 'https://ai.urit.services';
export const DEFAULT_URIT_AI_CONSUMER = 'bandait';
const USER_AGENT = 'bandait-stems/1.0';
const TASK = 'mix_assist';
const MAX_OUTPUT_TOKENS = 8192;
/** Bajo el corte de 100 s de Cloudflare, con margen para el resto de la peticion del Hub. */
const TIME_BUDGET_MS = 70000;

export function uritAiUrl(env: Env): string {
  const raw = (env.URIT_AI_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[A-Za-z0-9.-]+$/.test(raw) ? raw : DEFAULT_URIT_AI_URL;
}

export function uritAiConsumer(env: Env): string {
  const raw = (env.URIT_AI_CONSUMER || '').trim();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(raw) ? raw : DEFAULT_URIT_AI_CONSUMER;
}

interface UritResponse {
  output?: { json?: unknown };
  finish_reason?: unknown;
  error?: unknown;
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
        headers: {
          Authorization: `Bearer ${token}`,
          'X-URiT-Consumer': uritAiConsumer(env),
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
        },
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
