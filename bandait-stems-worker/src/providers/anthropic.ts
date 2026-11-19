// Asistente de mezcla con Claude por la Messages API de Anthropic (secreto ASSIST_API_KEY).
//
// HTTP directo y no el SDK oficial: este Worker no tiene dependencias de ejecucion y todas sus
// llamadas salen por el `fetchFn` inyectable, que es lo que permite probarlo sin red. La forma de
// la peticion sale de la referencia de la API vigente al 2026-11-19 (skill claude-api):
//   POST https://api.anthropic.com/v1/messages
//   cabeceras: x-api-key, anthropic-version: 2026-10-21, content-type: application/json
//   cuerpo:    model, max_tokens, system, messages, output_config { effort, format }
//   salida estructurada: output_config.format = { type: "json_schema", schema }. El esquema no
//              admite minimos, maximos ni largos: los rangos los valida studioJobs.ts.
//   En esta version de la API no se envia temperature, top_p ni top_k (responde 400).
//   Con claude-sonnet-5-5 el razonamiento va siempre activo: no se envia `thinking`.
//   Un rechazo llega como HTTP 200 con stop_reason "refusal": se revisa antes de leer el contenido.
//   `fallbacks: "default"` (beta server-side-fallback-2026-07-01) reintenta en otro modelo si el
//   clasificador de seguridad rechaza el pedido; solo se envia a los modelos que lo admiten.

import { FX_PARAM_KEYS, ProviderError } from './types.ts';
import type { AssistProvider, AssistResult } from './types.ts';
import type { Env, FetchLike } from '../types.ts';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_ASSIST_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 16000;

/** Modelos que aceptan `fallbacks`. Otro modelo en ASSIST_MODEL se llama sin ese campo. */
const FALLBACK_MODELS = /^claude-(sonnet-5-5|opus-5-5|opus-5|fable-5(-[12])?)$/;

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

/** STUDIO_V1.md 6.4. Todos los campos son obligatorios y admiten null: null es "no aplica". */
export const SUGGESTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['track_id', 'target', 'value', 'fx_type', 'params', 'reason'],
        properties: {
          track_id: { type: 'string' },
          target: { type: 'string', enum: ['volume_db', 'pan', 'fx'] },
          value: nullable({ type: 'number' }),
          fx_type: nullable({ type: 'string', enum: ['eq', 'compressor', 'limiter'] }),
          params: nullable({
            type: 'object',
            additionalProperties: false,
            required: [...FX_PARAM_KEYS],
            properties: Object.fromEntries(FX_PARAM_KEYS.map((key) => [key, nullable({ type: 'number' })])),
          }),
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

export const ASSIST_SYSTEM_PROMPT = `Eres el asistente de mezcla del Estudio Bandait, un estudio de grabación en el navegador que usa una banda para sus maquetas. Quien te consulta es un músico, no un ingeniero de mezcla: quiere que su maqueta suene equilibrada y entender por qué.

Recibes un JSON con mediciones de la mezcla. No recibes audio, así que todo lo que propongas debe poder justificarse con esos números:
- target_lufs: volumen integrado al que la banda quiere llegar con la mezcla.
- master: lufs y true_peak_db de la mezcla completa (null si es silencio).
- tracks: por cada pista, su id, nombre y rol (vocals, drums, bass, guitar, keys...), su LUFS integrado y su pico real medidos después del fader, la energía por banda relativa al total de la pista (low_db hasta 200 Hz, low_mid_db de 200 a 2000 Hz, high_mid_db de 2000 a 6000 Hz, high_db desde 6000 Hz; 0 es toda la energía, valores más negativos son menos energía), y su fader (volume_db), paneo (pan) y efectos actuales (fx).

Devuelve una lista de cambios concretos. El músico acepta o descarta cada uno por separado, así que cada cambio debe tener sentido por sí solo. Cada cambio toca una sola cosa:
- target "volume_db": fader nuevo en value, entre -60 y 12 dB. Sirve para una pista o para "master".
- target "pan": paneo nuevo en value, entre -1 (izquierda) y 1 (derecha). Solo para pistas, nunca para "master".
- target "fx": fx_type es "eq", "compressor" o "limiter", y params trae solo los parámetros que cambian; los demás van en null. "limiter" solo existe en "master".
  - eq: hpf_hz 0..1000 (0 lo apaga), low_db -18..18 (shelving en 120 Hz), mid_hz 200..8000, mid_db -18..18, mid_q 0.1..10, high_db -18..18 (shelving en 8000 Hz).
  - compressor: threshold_db -60..0, ratio 1..20, attack_ms 0..1000, release_ms 10..1000, knee_db 0..40, makeup_db 0..24.
  - limiter: ceiling_db -12..0, release_ms 10..1000.
Con target "volume_db" o "pan", fx_type y params van en null. Con target "fx", value va en null.

track_id es el id exacto de una pista de las mediciones, o "master". Los valores son absolutos (el fader nuevo, no la diferencia) y parten del estado actual que ves en las mediciones.

Criterio:
- Propón pocos cambios y que se oigan: lo habitual es entre tres y ocho. Si la mezcla ya está equilibrada, una lista vacía es la respuesta correcta.
- Prefiere movimientos moderados (faders de 1 a 4 dB, ecualización de 1 a 4 dB): el músico va a escuchar cada cambio y puede pedir otra pasada.
- Usa el rol de cada pista para decidir qué debe ir adelante. En una canción, la voz principal suele guiar el nivel de las demás.
- No propongas un cambio que deje el valor como ya está.
- Una pista con lufs en null está en silencio: no la toques.

reason explica el cambio en español, en una o dos frases de menos de 280 caracteres, citando la medición que lo motiva. Escríbela para un músico: di qué va a oír distinto.`;

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b?.type === 'text' && typeof b.text === 'string') text += b.text;
  }
  return text;
}

export const anthropic: AssistProvider = {
  assertAvailable(env: Env): void {
    if (!(env.ASSIST_API_KEY || '').trim()) throw new ProviderError(503, 'provider_unavailable', 'falta ASSIST_API_KEY');
  },

  async suggest(env: Env, fetchFn: FetchLike, metrics: unknown): Promise<AssistResult> {
    const key = (env.ASSIST_API_KEY || '').trim();
    if (!key) throw new ProviderError(503, 'provider_unavailable', 'falta ASSIST_API_KEY');
    const model = (env.ASSIST_MODEL || '').trim() || DEFAULT_ASSIST_MODEL;
    const withFallback = FALLBACK_MODELS.test(model);
    let res: Response;
    try {
      res = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
          ...(withFallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_TOKENS,
          ...(withFallback ? { fallbacks: 'default' } : {}),
          output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUGGESTIONS_SCHEMA } },
          system: ASSIST_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Mediciones de la mezcla:\n${JSON.stringify(metrics)}` }],
        }),
      });
    } catch {
      throw new ProviderError(502, 'provider_failed', 'anthropic: sin respuesta');
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(502, 'provider_failed', `anthropic: HTTP ${res.status} ${detail}`);
    }
    const body = await res.json().catch(() => null) as { stop_reason?: unknown; content?: unknown } | null;
    if (!body) throw new ProviderError(502, 'provider_failed', 'anthropic: respuesta ilegible');
    // La peticion ya se cobro: desde aqui un problema es un trabajo FAILED, no un error HTTP.
    if (body.stop_reason === 'refusal') return { suggestions: [], failure: 'El asistente no pudo responder a este pedido.' };
    if (body.stop_reason === 'max_tokens') return { suggestions: [], failure: 'La respuesta del asistente quedó incompleta. Intenta de nuevo.' };
    try {
      const parsed = JSON.parse(textOf(body.content)) as { suggestions?: unknown };
      if (!Array.isArray(parsed.suggestions)) throw new Error('sin lista');
      return { suggestions: parsed.suggestions, failure: null };
    } catch {
      return { suggestions: [], failure: 'El asistente devolvió una respuesta que no se pudo leer. Intenta de nuevo.' };
    }
  },
};
