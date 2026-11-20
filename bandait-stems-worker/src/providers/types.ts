// Adaptadores de proveedores de IA del Estudio. Cada proveedor vive en un archivo: si cambia su
// API o su precio, el cambio queda aqui y no toca las rutas (src/studioJobs.ts).

import type { Env, FetchLike } from '../types.ts';

/** Fallo de un proveedor, ya con el estado HTTP y el codigo de STUDIO_V1.md seccion 7. */
export class ProviderError extends Error {
  status: number;
  code: string;
  /** Texto para los logs del Worker. Nunca lleva la clave. */
  detail: string;
  constructor(status: number, code: string, detail = '') {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
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
export type GenerateResult =
  | { audio: GeneratedAudio; failure: null; costUsd: number | null }
  | { audio: null; failure: string; costUsd: number | null };

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
};

export interface TextProvider {
  /** Lanza ProviderError 503 `provider_unavailable` si falta el secreto. */
  assertAvailable(env: Env): void;
  json(env: Env, fetchFn: FetchLike, call: JsonCall): Promise<TextResult<unknown>>;
  chat(env: Env, fetchFn: FetchLike, call: ChatCall): Promise<TextResult<ChatOutput>>;
}

export const FAILURE_BLOCKED = 'El asistente no pudo responder a este pedido.';
export const FAILURE_UNREADABLE = 'El asistente devolvió una respuesta que no se pudo leer. Intenta de nuevo.';
export const FAILURE_TRUNCATED = 'La respuesta del asistente quedó incompleta. Intenta de nuevo.';

/** Forma de las sugerencias (STUDIO_V1.md 6.4) como JSON Schema, para los modelos que lo admiten. */
export const FX_PARAM_KEYS = [
  'hpf_hz', 'low_db', 'mid_hz', 'mid_db', 'mid_q', 'high_db',
  'threshold_db', 'ratio', 'attack_ms', 'release_ms', 'knee_db', 'makeup_db', 'ceiling_db',
] as const;
