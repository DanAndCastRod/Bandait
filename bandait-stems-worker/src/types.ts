// Minimal Workers / R2 types used by this Worker (no @cloudflare/workers-types dependency).

export type R2Body = ReadableStream | ArrayBuffer | Uint8Array | string | null;

export interface R2HTTPMetadata {
  contentType?: string;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  text(): Promise<string>;
}

export interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
  /** With `delimiter`: the "folders" directly under the prefix (each ends with the delimiter). */
  delimitedPrefixes?: string[];
}

/** Conditional write: `put` returns null when the condition fails (nothing is stored). */
export interface R2Conditional {
  /** Store only if the current object has this etag (R2Object.etag, without quotes). */
  etagMatches?: string;
  /** Store only if the current object does not have this etag. */
  etagDoesNotMatch?: string;
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
  onlyIf?: R2Conditional | Headers;
}

export interface R2Range {
  offset: number;
  length: number;
}

export interface R2GetOptions {
  range?: R2Range;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>;
  put(key: string, value: R2Body, options?: R2PutOptions): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; delimiter?: string }): Promise<R2Objects>;
}

/** Lo que el Worker usa del ExecutionContext de Cloudflare. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Env {
  STEMS: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ALLOWED_ORIGINS: string;
  MAX_FILE_MB?: string;
  /** Secret (wrangler secret put): Music AI API key. Without it, analysis answers 503. */
  MUSICAI_API_KEY?: string;
  MUSICAI_WORKFLOW?: string;
  /** Workflow that also separates stems (POST .../analysis?separate=1). */
  MUSICAI_SPLIT_WORKFLOW?: string;
  /** Workflow del trabajo `analyze` del Estudio v2. Vacio: MUSICAI_WORKFLOW (que tambien separa stems). */
  MUSICAI_ANALYZE_WORKFLOW?: string;

  // ---- Estudio (bandait-protocol/STUDIO_V1.md, seccion 8) ----
  /** Workflow de mastering de Music AI (trabajo `master`). Sin el, 503 provider_unavailable. */
  MUSICAI_MASTER_WORKFLOW?: string;
  /**
   * Nombre del parametro del workflow de mastering que recibe el volumen objetivo en LUFS. Depende
   * de como se arme el workflow en el panel de Music AI; sin el, `target_lufs` no se envia.
   */
  MUSICAI_MASTER_LUFS_PARAM?: string;
  /**
   * Secreto opcional: clave de la Gemini API directa, solo para el asistente de texto con
   * ASSIST_PROVIDER=gemini. Desde el 2026-11-19 Lyria pasa por URiT IA y no la usa.
   */
  GEMINI_API_KEY?: string;
  /** Modelo de Lyria para pedidos de hasta 30 s. Por defecto `lyria-3-clip-preview`. */
  LYRIA_CLIP_MODEL?: string;
  /** Modelo de Lyria para pedidos de mas de 30 s. Por defecto `lyria-3.5`. */
  LYRIA_SONG_MODEL?: string;
  /** Secreto (futuro): clave de Suno. Hoy `generate` con `suno` responde 501 aunque exista. */
  SUNO_API_KEY?: string;
  /** Secreto opcional: clave del asistente de mezcla. Con gemini, si falta se usa GEMINI_API_KEY. */
  ASSIST_API_KEY?: string;
  /**
   * Proveedor de texto: `urit` (por defecto, URiT IA), `gemini` (directo) o `anthropic`. Lo usan
   * `assist`, `compose` y `chat` (STUDIO_V2.md 4); `compose` y `chat` no admiten `anthropic` (503).
   */
  ASSIST_PROVIDER?: string;
  /** Modelo del asistente con gemini o anthropic. Con urit no se usa: manda la cadena de URiT. */
  ASSIST_MODEL?: string;
  /** Secreto: token del consumidor en URiT IA (texto con ASSIST_PROVIDER `urit`, y Lyria). Sin el, 503. */
  URIT_AI_TOKEN?: string;
  /** Base de URiT IA. Por defecto `https://ai.urit.services`. */
  URIT_AI_URL?: string;
  /** Consumidor en URiT IA. Por defecto `bandait`. */
  URIT_AI_CONSUMER?: string;
  /** Tope mensual de gasto de IA por banda, en USD. Vacio o ausente: sin tope. */
  STUDIO_MONTHLY_BUDGET_USD?: string;
  /**
   * Tope mensual de gasto de IA de TODO el Worker (todas las bandas y workspaces personales), en
   * USD. Vacio o ausente: sin tope global. El contador vive en `studio/_usage/AAAA-MM.json`.
   */
  STUDIO_GLOBAL_MONTHLY_BUDGET_USD?: string;
  /**
   * Lista de uuid de usuario (separados por coma) que pueden lanzar trabajos de IA. Vacia o
   * ausente: cualquier editor. Con valor, el resto recibe 403 `not_a_spender`.
   */
  STUDIO_SPENDER_UIDS?: string;
  /** Tarifas para estimar el costo (USD). Ver DEFAULT_RATES en src/studioJobs.ts. */
  STUDIO_RATE_MASTER_USD_PER_MIN?: string;
  STUDIO_RATE_SEPARATE_USD_PER_MIN?: string;
  /** Lyria por cancion (URiT IA 4A): clip de 30 s y cancion larga. */
  STUDIO_RATE_LYRIA_CLIP_USD?: string;
  STUDIO_RATE_LYRIA_SONG_USD?: string;
  STUDIO_RATE_ASSIST_USD?: string;
  /** Tarifas de los trabajos de STUDIO_V2.md 4.4 (compose y chat por consulta, analyze por minuto). */
  STUDIO_RATE_COMPOSE_USD?: string;
  STUDIO_RATE_ANALYZE_USD_PER_MIN?: string;
  STUDIO_RATE_CHAT_USD?: string;
  /** Recargo del chat por cada 32 KB completos de cuerpo. */
  STUDIO_RATE_CHAT_USD_PER_32KB?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Dependencias inyectables para las pruebas del Estudio: reloj e ids. */
export interface StudioDeps {
  now: () => Date;
  /** Id nuevo con prefijo ("job", "ast"): `${prefix}_<12 hexadecimales>`. */
  newId: (prefix: string) => string;
  /**
   * `ctx.waitUntil` del Worker: mantiene viva una promesa aunque el cliente corte la conexion.
   * Ausente en las pruebas que no lo necesitan.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}
