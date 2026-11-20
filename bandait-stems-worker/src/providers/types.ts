// Adaptadores de proveedores de IA del Estudio. Cada proveedor vive en un archivo: si cambia su
// API o su precio, el cambio queda aqui y no toca las rutas (src/studioJobs.ts).

import type { Env, FetchLike } from '../types.ts';

/**
 * Metadatos de la respuesta del proveedor para el registro de eventos (src/events.ts) y para
 * correlacionar con URiT IA. Nunca llevan contenido: ni prompt, ni salida del modelo, ni claves.
 */
export interface ProviderMeta {
  /** Estado HTTP que respondio el proveedor; null si no hubo respuesta (red, espera agotada). */
  http?: number | null;
  /** Codigo de error del proveedor (`provider_error`, `blocked`...). */
  code?: string | null;
  /** Detalle corto del proveedor (`NO_AUDIO`). Se limpia y recorta antes de guardarlo. */
  detail?: string | null;
  /** Id de la llamada en URiT IA (`ai_...`): campo `id` del cuerpo o cabecera X-Request-Id. */
  requestId?: string | null;
  /** Modelo que respondio, si el proveedor lo informa. */
  model?: string | null;
}

/** Fallo de un proveedor, ya con el estado HTTP y el codigo de STUDIO_V1.md seccion 7. */
export class ProviderError extends Error {
  status: number;
  code: string;
  /** Texto para los logs del Worker. Nunca lleva la clave. */
  detail: string;
  /** Lo que se sabe de la respuesta del proveedor, para el registro de eventos. */
  meta: ProviderMeta;
  constructor(status: number, code: string, detail = '', meta: ProviderMeta = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.meta = meta;
  }
}

const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/**
 * Id de la llamada en URiT IA: el campo `id` de la respuesta o, si falta, la cabecera
 * X-Request-Id. null si no viene o no tiene forma de id.
 */
export function readRequestId(res: Response | null, body: unknown): string | null {
  const fromBody = (body as { id?: unknown } | null)?.id;
  if (typeof fromBody === 'string' && REQUEST_ID.test(fromBody)) return fromBody;
  const fromHeader = res?.headers.get('X-Request-Id') ?? null;
  return fromHeader !== null && REQUEST_ID.test(fromHeader) ? fromHeader : null;
}

/** Modelo informado por el proveedor (`model` del cuerpo), corto y sin caracteres raros. */
export function readModel(body: unknown): string | null {
  const raw = (body as { model?: unknown } | null)?.model;
  return typeof raw === 'string' && /^[A-Za-z0-9_.:\/-]{1,80}$/.test(raw) ? raw : null;
}

export interface GenerateRequest {
  prompt: string;
  duration_s: number;
  bpm: number;
  key: string | null;
  instrumental: boolean;
}

export interface GeneratedAudio {
  bytes: Uint8Array;
  ext: 'wav' | 'flac' | 'mp3';
}

/**
 * Resultado de una generacion que llego al proveedor. `failure` es el texto en espanol del trabajo
 * FAILED (bloqueo, sin audio, cuota, espera agotada). `costUsd`: costo real informado por el
 * proveedor; 0 si no cobro; null si no se sabe y queda la estimacion.
 */
export type GenerateResult = (
  | { audio: GeneratedAudio; failure: null; costUsd: number | null }
  | { audio: null; failure: string; costUsd: number | null }
) & { meta?: ProviderMeta };

export interface GenerateProvider {
  /** Lanza ProviderError (503 o 501 `provider_unavailable`) si no se puede usar con esta configuracion. */
  assertAvailable(env: Env): void;
  /**
   * Genera el audio y lo devuelve entero, o el motivo del trabajo FAILED. Lanza ProviderError
   * (502 `provider_failed`, 503 `provider_unavailable`) si el proveedor no acepto el pedido.
   */
  generate(env: Env, fetchFn: FetchLike, request: GenerateRequest): Promise<GenerateResult>;
}

export interface AssistResult {
  /** Sugerencias tal como las devolvio el modelo, sin validar (lo hace studioJobs.ts). */
  suggestions: unknown[];
  /** Motivo por el que el modelo no entrego sugerencias (rechazo, respuesta cortada); null si las entrego. */
  failure: string | null;
  /** Metadatos de la respuesta (URiT IA: id de la llamada y modelo). */
  meta?: ProviderMeta;
}

export interface AssistProvider {
  assertAvailable(env: Env): void;
  /** `metrics` ya esta validado contra STUDIO_V1.md 6.3: solo numeros y nombres de pista. */
  suggest(env: Env, fetchFn: FetchLike, metrics: unknown): Promise<AssistResult>;
}

// ---------------------------------------------------------------------------- texto (STUDIO_V2.md 4)

/**
 * Parte de un mensaje en el formato neutro de URiT IA (CONTRACT_V1.md 3.1): exactamente una clave.
 * Es el formato con el que habla el Worker; el adaptador de Gemini directo lo traduce.
 */
export type TextPart =
  | { text: string }
  | { tool_call: { name: string; arguments: Record<string, unknown>; signature?: string } }
  | { tool_result: { name: string; response: Record<string, unknown> } };

export interface TextMessage { role: 'user' | 'model' | 'tool'; parts: TextPart[] }

export interface ToolDeclaration { name: string; description: string; parameters: Record<string, unknown> }

/** Pedido de JSON con esquema (compose). */
export interface JsonCall {
  /** Etiqueta de uso en URiT (`studio_compose`). */
  task: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

/** Una vuelta del asistente con herramientas (chat). */
export interface ChatCall {
  task: string;
  system: string;
  messages: TextMessage[];
  tools: ToolDeclaration[];
  toolMode: 'auto' | 'none';
}

export interface ProviderToolCall { name: string; arguments: Record<string, unknown>; signature: string | null }

export interface ChatOutput {
  /** Texto del modelo sin las partes de pensamiento; '' si no hubo. */
  text: string;
  toolCalls: ProviderToolCall[];
  /** `stop`, `max_tokens`, `tool_calls` u otro valor del proveedor en minusculas. */
  finish: string;
}

/**
 * Resultado de una llamada que llego al modelo. `failure` es el texto en espanol para el trabajo
 * FAILED (bloqueo, salida ilegible, respuesta cortada): la consulta ya se cobro. Los errores que
 * no se cobran (configuracion, red, 5xx) se lanzan como ProviderError.
 */
export type TextResult<T> = ({ value: T; failure: null } | { value: null; failure: string }) & {
  /** Costo real informado por el proveedor (URiT: usage.estimated_usd); ausente o null: queda la estimacion. */
  costUsd?: number | null;
  /** Metadatos de la respuesta (URiT IA: id de la llamada y modelo). */
  meta?: ProviderMeta;
};

export interface TextProvider {
  /** Lanza ProviderError 503 `provider_unavailable` si falta el secreto. */
  assertAvailable(env: Env): void;
  json(env: Env, fetchFn: FetchLike, call: JsonCall): Promise<TextResult<unknown>>;
  chat(env: Env, fetchFn: FetchLike, call: ChatCall): Promise<TextResult<ChatOutput>>;
}

/**
 * Limites de JSON Schema que Gemini rechaza en `responseJsonSchema` (y que se quitan tambien de los
 * parametros de herramientas). Verificado el 2026-11-20 contra URiT IA en produccion con
 * gemini-3.8-flash: el esquema de compose con minimum, maximum, maxItems y maxLength respondio
 * 502 provider_error / INVALID_ARGUMENT; el mismo esquema sin esos limites respondio 200.
 */
const PROVIDER_SCHEMA_DROP = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minProperties', 'maxProperties',
]);

/**
 * Copia del esquema sin los limites que el proveedor rechaza. Los rangos NO se pierden: el Worker
 * (compose, assist) y el Hub (herramientas del chat) validan y acotan lo que vuelve del modelo.
 */
export function providerSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((item) => providerSchema(item)) as T;
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (PROVIDER_SCHEMA_DROP.has(key)) continue;
    // Dentro de `properties` las claves son nombres de campos, no palabras de JSON Schema.
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, sub]) => [name, providerSchema(sub)]));
    } else {
      out[key] = providerSchema(value);
    }
  }
  return out as T;
}

export const FAILURE_BLOCKED = 'El asistente no pudo responder a este pedido.';
export const FAILURE_UNREADABLE = 'El asistente devolvió una respuesta que no se pudo leer. Intenta de nuevo.';
export const FAILURE_TRUNCATED = 'La respuesta del asistente quedó incompleta. Intenta de nuevo.';

/** Forma de las sugerencias (STUDIO_V1.md 6.4) como JSON Schema, para los modelos que lo admiten. */
export const FX_PARAM_KEYS = [
  'hpf_hz', 'low_db', 'mid_hz', 'mid_db', 'mid_q', 'high_db',
  'threshold_db', 'ratio', 'attack_ms', 'release_ms', 'knee_db', 'makeup_db', 'ceiling_db',
] as const;
