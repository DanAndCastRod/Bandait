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

export interface GenerateProvider {
  /** Lanza ProviderError (503 o 501 `provider_unavailable`) si no se puede usar con esta configuracion. */
  assertAvailable(env: Env): void;
  /** Genera el audio y lo devuelve entero. Lanza ProviderError 502 `provider_failed` si falla. */
  generate(env: Env, fetchFn: FetchLike, request: GenerateRequest): Promise<GeneratedAudio>;
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

/** Forma de las sugerencias (STUDIO_V1.md 6.4) como JSON Schema, para los modelos que lo admiten. */
export const FX_PARAM_KEYS = [
  'hpf_hz', 'low_db', 'mid_hz', 'mid_db', 'mid_q', 'high_db',
  'threshold_db', 'ratio', 'attack_ms', 'release_ms', 'knee_db', 'makeup_db', 'ceiling_db',
] as const;
