// Asistente de mezcla con Gemini por la Gemini API (no Vertex AI).
//
// Clave: ASSIST_API_KEY si existe; si no, GEMINI_API_KEY (la misma que usa Lyria). Asi basta un
// solo secreto para todo lo de Google (decision de Daniel Castaneda, 2026-11-19).
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

import { ProviderError } from './types.ts';
import type { AssistProvider, AssistResult } from './types.ts';
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
      if (res.status === 400) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        console.warn(`studio provider: gemini rechazo el esquema, se repite sin el: ${detail}`);
        res = await request(false);
      }
    } catch {
      throw new ProviderError(502, 'provider_failed', 'gemini: sin respuesta');
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
