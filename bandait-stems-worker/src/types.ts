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
}

export interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(key: string, value: R2Body, options?: R2PutOptions): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2Objects>;
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
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
