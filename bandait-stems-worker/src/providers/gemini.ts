// Asistente de mezcla con Gemini por la Gemini API (no Vertex AI).
//
// Clave: ASSIST_API_KEY si existe; si no, GEMINI_API_KEY. Es solo la alternativa del asistente de
// texto (ASSIST_PROVIDER=gemini): desde el 2026-11-19 Lyria pasa por URiT IA y no usa esta clave.
//
//   POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent
//   cabeceras: x-goog-api-key, Content-Type: application/json
//   cuerpo:    systemInstruction, contents, generationConfig { responseMimeType, responseJsonSchema }
//   respuesta: candidates[0].content.parts[].text, candidates[0].finishReason,
//              promptFeedback.blockReason
//
// NO VERIFICADO contra la documentacion viva (la red de este equipo bloqueo la lectura literal):
//   - que `responseJsonSchema` acepte `anyOf` con null y `additionalProperties`. Si la API responde
//     400 por el esquema, se repite UNA vez sin el esquema (solo JSON): un 400 no se cobra y el
//     contenido lo valida igual studioJobs.ts (sanitizeSuggestions).
//   - el nombre del modelo por defecto. `gemini-flash-latest` es un alias que Google cambia de
//     version por su cuenta; para fijar una version, ASSIST_MODEL.

import { FAILURE_BLOCKED, FAILURE_TRUNCATED, FAILURE_UNREADABLE, ProviderError } from './types.ts';
import type {
  AssistProvider, AssistResult, ChatCall, ChatOutput, JsonCall, ProviderToolCall, TextMessage, TextPart, TextProvider, TextResult,
} from './types.ts';
import { ASSIST_SYSTEM_PROMPT, SUGGESTIONS_SCHEMA } from './anthropic.ts';
import type { Env, FetchLike } from '../types.ts';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_GEMINI_ASSIST_MODEL = 'gemini-flash-latest';
const MAX_OUTPUT_TOKENS = 8192;

function geminiKey(env: Env): string {
  return (env.ASSIST_API_KEY || '').trim() || (env.GEMINI_API_KEY || '').trim();
}

/** Nombre de modelo seguro para ir en la ruta: letras, numeros, punto, guion y guion bajo. */
export function geminiAssistModel(env: Env): string {
  const model = (env.ASSIST_MODEL || '').trim();
  // El valor por defecto del Worker fue 'claude-*' mientras el proveedor era anthropic.
  if (!model || model.startsWith('claude-') || !/^[A-Za-z0-9._-]{1,80}$/.test(model)) return DEFAULT_GEMINI_ASSIST_MODEL;
  return model;
}

function textOf(body: GeminiResponse): string {
  const parts = body.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: unknown }[] }; finishReason?: unknown }[];
  promptFeedback?: { blockReason?: unknown };
}

/** Espera maxima de una llamada a la Gemini API directa, como la de URiT (70 s + 5 s). */
const GEMINI_TIMEOUT_MS = 75000;

/**
 * Un 400 de la Gemini API: con una clave invalida (API_KEY_INVALID, 'API key not valid') es
 * configuracion y se lanza 503 provider_unavailable; solo un 400 que habla del esquema se repite sin
 * el esquema (true). Cualquier otro 400 es 502 provider_failed, sin segundo intento.
 */
export function gemini400(detail: string): true {
  if (/API_KEY_INVALID|API key not valid|API_KEY/i.test(detail)) {
    throw new ProviderError(503, 'provider_unavailable', 'gemini: clave rechazada');
  }
  if (/schema/i.test(detail)) return true;
  throw new ProviderError(502, 'provider_failed', `gemini: HTTP 400 ${detail}`);
}

export const gemini: AssistProvider = {
  assertAvailable(env: Env): void {
    if (!geminiKey(env)) throw new ProviderError(503, 'provider_unavailable', 'falta GEMINI_API_KEY (o ASSIST_API_KEY)');
  },

  async suggest(env: Env, fetchFn: FetchLike, metrics: unknown): Promise<AssistResult> {
    const key = geminiKey(env);
    if (!key) throw new ProviderError(503, 'provider_unavailable', 'falta GEMINI_API_KEY (o ASSIST_API_KEY)');
    const model = geminiAssistModel(env);
    const url = `${BASE}/${model}:generateContent`;
    const request = (withSchema: boolean) =>
      fetchFn(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: ASSIST_SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: `Mediciones de la mezcla:\n${JSON.stringify(metrics)}` }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            ...(withSchema ? { responseJsonSchema: SUGGESTIONS_SCHEMA } : {}),
          },
        }),
      });

    let res: Response;
    try {
      res = await request(true);
    } catch {
      throw new ProviderError(502, 'provider_failed', 'gemini: sin respuesta');
    }
    if (res.status === 400) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      gemini400(detail);
      console.warn(`studio provider: gemini rechazo el esquema, se repite sin el: ${detail}`);
      try {
        res = await request(false);
      } catch {
        throw new ProviderError(502, 'provider_failed', 'gemini: sin respuesta');
      }
    }
    if (!res.ok) {
      // Nunca se registra la URL con la clave: va en la cabecera, no en la ruta.
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(502, 'provider_failed', `gemini: HTTP ${res.status} ${detail}`);
    }
    const body = (await res.json().catch(() => null)) as GeminiResponse | null;
    if (!body) throw new ProviderError(502, 'provider_failed', 'gemini: respuesta ilegible');
    // La peticion ya se cobro: desde aqui un problema es un trabajo FAILED, no un error HTTP.
    if (body.promptFeedback?.blockReason) return { suggestions: [], failure: 'El asistente no pudo responder a este pedido.' };
    const finish = body.candidates?.[0]?.finishReason;
    if (finish === 'MAX_TOKENS') return { suggestions: [], failure: 'La respuesta del asistente quedó incompleta. Intenta de nuevo.' }
    if (finish === 'SAFETY' || finish === 'RECITATION' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
      return { suggestions: [], failure: 'El asistente no pudo responder a este pedido.' };
    }
    try {
      const parsed = JSON.parse(textOf(body)) as { suggestions?: unknown };
      if (!Array.isArray(parsed.suggestions)) throw new Error('sin lista');
      return { suggestions: parsed.suggestions, failure: null };
    } catch {
      return { suggestions: [], failure: 'El asistente devolvió una respuesta que no se pudo leer. Intenta de nuevo.' };
    }
  },
};

// ---------------------------------------------------------------------------- compose y chat (STUDIO_V2.md 4)
//
// Alternativa a URiT IA (ASSIST_PROVIDER=gemini), que la sesion de URiT desaconseja: compite por la
// cuota de la misma clave. La traduccion del formato neutro es la de URiT IA
// (URiT/workers/ai/src/providers/gemini.ts, escrita contra https://ai.google.dev/api/generate-content
// el 2026-11-08), que ya corre en produccion:
//   role tool -> role user con partes functionResponse; {tool_call} -> {functionCall: {name, args}}
//   con thoughtSignature al lado; tools -> functionDeclarations con parametersJsonSchema;
//   tool_mode none -> toolConfig.functionCallingConfig.mode NONE.
// NO VERIFICADO por este Worker contra la documentacion viva (la red del equipo corta la lectura).

const BLOCKED_FINISH = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

interface GeminiPart {
  text?: unknown; thought?: unknown; functionCall?: { name?: unknown; args?: unknown }; thoughtSignature?: unknown;
}

function toGeminiPart(part: TextPart): Record<string, unknown> {
  if ('text' in part) return { text: part.text };
  if ('tool_call' in part) {
    const out: Record<string, unknown> = { functionCall: { name: part.tool_call.name, args: part.tool_call.arguments } };
    if (part.tool_call.signature) out.thoughtSignature = part.tool_call.signature;
    return out;
  }
  return { functionResponse: { name: part.tool_result.name, response: part.tool_result.response } };
}

/** Llama a generateContent. Un problema despues de la respuesta 200 es un trabajo FAILED. */
async function generate(env: Env, fetchFn: FetchLike, body: Record<string, unknown>, retryWithout?: () => Record<string, unknown>): Promise<TextResult<GeminiPart[]>> {
  const key = geminiKey(env);
  if (!key) throw new ProviderError(503, 'provider_unavailable', 'falta GEMINI_API_KEY (o ASSIST_API_KEY)');
  const url = `${BASE}/${geminiAssistModel(env)}:generateContent`;
  const send = (payload: Record<string, unknown>) => fetchFn(url, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  let res: Response;
  try {
    res = await send(body);
  } catch {
    throw new ProviderError(502, 'provider_failed', 'gemini: sin respuesta');
  }
  if (res.status === 400) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    gemini400(detail);
    if (!retryWithout) throw new ProviderError(502, 'provider_failed', `gemini: HTTP 400 ${detail}`);
    console.warn(`studio provider: gemini rechazo el esquema, se repite sin el: ${detail}`);
    try {
      res = await send(retryWithout());
    } catch {
      throw new ProviderError(502, 'provider_failed', 'gemini: sin respuesta');
    }
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new ProviderError(502, 'provider_failed', `gemini: HTTP ${res.status} ${detail}`);
  }
  const data = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: unknown }; finishReason?: unknown }[]; promptFeedback?: { blockReason?: unknown } } | null;
  if (!data) throw new ProviderError(502, 'provider_failed', 'gemini: respuesta ilegible');
  if (data.promptFeedback?.blockReason) return { value: null, failure: FAILURE_BLOCKED };
  const first = data.candidates?.[0];
  const finish = typeof first?.finishReason === 'string' ? first.finishReason : '';
  if (BLOCKED_FINISH.has(finish)) return { value: null, failure: FAILURE_BLOCKED };
  const parts = Array.isArray(first?.content?.parts) ? (first.content.parts as GeminiPart[]) : [];
  const hasCall = parts.some((p) => p && typeof p === 'object' && p.functionCall);
  if (finish === 'MAX_TOKENS' && !hasCall) return { value: null, failure: FAILURE_TRUNCATED };
  return { value: parts, failure: null };
}

export const geminiText: TextProvider = {
  assertAvailable(env: Env): void {
    gemini.assertAvailable(env);
  },

  async json(env: Env, fetchFn: FetchLike, call: JsonCall): Promise<TextResult<unknown>> {
    const payload = (withSchema: boolean) => ({
      systemInstruction: { parts: [{ text: call.system }] },
      contents: [{ role: 'user', parts: [{ text: call.user }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: MAX_OUTPUT_TOKENS, ...(withSchema ? { responseJsonSchema: call.schema } : {}) },
    });
    const result = await generate(env, fetchFn, payload(true), () => payload(false));
    if (result.failure !== null) return result;
    const text = result.value.filter((p) => p && p.thought !== true && typeof p.text === 'string').map((p) => p.text as string).join('');
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object') throw new Error('no es objeto');
      return { value: parsed, failure: null };
    } catch {
      return { value: null, failure: FAILURE_UNREADABLE };
    }
  },

  async chat(env: Env, fetchFn: FetchLike, call: ChatCall): Promise<TextResult<ChatOutput>> {
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: call.system }] },
      contents: call.messages.map((m: TextMessage) => ({ role: m.role === 'model' ? 'model' : 'user', parts: m.parts.map(toGeminiPart) })),
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      tools: [{ functionDeclarations: call.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
    };
    if (call.toolMode === 'none') body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    const result = await generate(env, fetchFn, body);
    if (result.failure !== null) return result;
    let text = '';
    const toolCalls: ProviderToolCall[] = [];
    for (const p of result.value) {
      if (!p || typeof p !== 'object' || p.thought === true) continue;
      if (typeof p.text === 'string') text += p.text;
      const fc = p.functionCall;
      if (fc && typeof fc === 'object') {
        if (typeof fc.name !== 'string') return { value: null, failure: FAILURE_UNREADABLE };
        const args = fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args) ? (fc.args as Record<string, unknown>) : {};
        toolCalls.push({ name: fc.name, arguments: args, signature: typeof p.thoughtSignature === 'string' && p.thoughtSignature ? p.thoughtSignature : null });
      }
    }
    // Como URiT con tool_mode none: si el proveedor devolviera llamadas igual, se descartan.
    if (call.toolMode === 'none') toolCalls.length = 0;
    return { value: { text, toolCalls, finish: toolCalls.length ? 'tool_calls' : 'stop' }, failure: null };
  },
};
