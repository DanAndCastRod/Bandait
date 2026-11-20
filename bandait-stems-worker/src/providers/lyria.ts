// Lyria por URiT IA (`urit-ai`), como consumidor `bandait`: POST {URIT_AI_URL}/v1/music, con el
// mismo secreto URIT_AI_TOKEN y las mismas cabeceras que el texto (providers/urit.ts). Desde el
// 2026-11-19 (decision de Daniel Castaneda): el Worker ya no llama a la Gemini API directa para
// generar audio y no necesita GEMINI_API_KEY. URiT lleva la clave, los topes por consumidor y el
// registro de uso.
//
// Contrato: URiT/workers/ai/CONTRACT_V1.md, seccion 4A (codigo 0.3.0).
//   cuerpo:    task, model, prompt, time_budget_ms. Un campo desconocido es 400: Lyria no recibe
//              duracion, BPM ni tonalidad como parametros; van como indicaciones en el texto.
//   200:       output.audio {mime_type, data (base64), bytes}, output.text, usage.estimated_usd
//   errores:   401/403/503 configuracion; 422 model_not_allowed (consumidor sin ese modelo);
//              429 provider_quota o tope del consumidor; 502 blocked; 502 provider_error (con
//              detail NO_AUDIO si Google no entrego audio); 504 time_budget_exhausted, que URiT
//              anota como cobrado (Google pudo terminar la cancion).
//   modelos:   lyria-3-clip-preview da clips de 30 s (0.04 USD por clip); lyria-3.5 da canciones
//              de un par de minutos (0.08 USD por cancion), con la duracion pedida en el texto.
//
// LIMITE CONOCIDO: la llamada es sincrona y el audio llega en base64 dentro del JSON (un MP3 de 3
// minutos son unos 5 MB). Si el plan de Workers corta por CPU al decodificarlo, el camino es
// Cloudflare Queues (ver la nota historica en STUDIO_V1.md); no se agrego todavia.

import { ProviderError } from './types.ts';
import type { GenerateProvider, GenerateRequest, GenerateResult } from './types.ts';
import { readEstimatedUsd, uritAiUrl, uritHeaders } from './urit.ts';
import type { Env, FetchLike } from '../types.ts';

const DEFAULT_CLIP_MODEL = 'lyria-3-clip-preview';
const DEFAULT_SONG_MODEL = 'lyria-3.5';
/** Duracion fija de los clips del modelo corto. Un pedido mas largo va al modelo de canciones. */
export const CLIP_SECONDS = 30;
/** Espera que se pide a URiT (su maximo, CONTRACT_V1.md 4A). */
const TIME_BUDGET_MS = 85000;
/** Espera propia del Worker: el presupuesto de URiT mas un margen para que su 504 llegue primero. */
const WORKER_TIMEOUT_MS = 90000;
const TASK = 'studio_generate';

export const FAILURE_LYRIA_BLOCKED = 'Lyria no aceptó este pedido (filtro de seguridad de Google). Cambia la descripción: no pidas voces de artistas ni letras con derechos.';
export const FAILURE_LYRIA_NO_AUDIO = 'Lyria no devolvió audio. Intenta de nuevo o cambia la descripción.';
export const FAILURE_LYRIA_QUOTA = 'La cuota de Lyria está agotada por ahora. Intenta en unos minutos.';
export const FAILURE_LYRIA_TIMEOUT = 'Lyria tardó demasiado y no entregó el audio. El intento cuenta en el gasto. Prueba con un pedido más corto.';
export const FAILURE_LYRIA_UNREADABLE = 'El audio de Lyria no se pudo leer. Intenta de nuevo.';

export function lyriaModel(env: Env, durationS: number): string {
  return durationS <= CLIP_SECONDS
    ? (env.LYRIA_CLIP_MODEL || '').trim() || DEFAULT_CLIP_MODEL
    : (env.LYRIA_SONG_MODEL || '').trim() || DEFAULT_SONG_MODEL;
}

/** "about 2 minutes" / "about 45 seconds": la duracion como la entiende el texto de Lyria. */
function durationText(seconds: number): string {
  const s = Math.round(seconds);
  if (s >= 90 && s % 30 === 0) return `about ${s / 60} minutes`;
  return `about ${s} seconds`;
}

/**
 * Texto que recibe Lyria: lo que escribio el usuario mas el tempo, la tonalidad y, solo en el modelo
 * de canciones, la duracion. El clip corto dura 30 s siempre: pedirle otra duracion no sirve.
 */
export function lyriaPrompt(request: GenerateRequest): string {
  const lines = [request.prompt.trim(), `Tempo: ${Number(request.bpm.toFixed(2))} BPM.`];
  if (request.key) lines.push(`Key: ${request.key}.`);
  if (request.duration_s > CLIP_SECONDS) lines.push(`Duration: ${durationText(request.duration_s)}.`);
  if (request.instrumental) lines.push('Instrumental only, no vocals.');
  return lines.join('\n');
}

/**
 * Formato de un audio por sus primeros bytes: RIFF/WAVE, fLaC, o MP3 (etiqueta ID3 o sincronia de
 * trama MPEG). null si no es ninguno de los tres: no se asume un formato que no se reconoce.
 */
export function detectAudioExt(bytes: Uint8Array): 'wav' | 'flac' | 'mp3' | null {
  if (bytes.byteLength < 4) return null;
  const tag = String.fromCharCode(...bytes.subarray(0, 4));
  if (tag === 'RIFF') {
    return bytes.byteLength < 12 || String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE' ? 'wav' : null;
  }
  if (tag === 'fLaC') return 'flac';
  if (tag.startsWith('ID3')) return 'mp3';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

const MIME_EXT: Record<string, 'wav' | 'flac' | 'mp3'> = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac',
};

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface MusicResponse {
  output?: { audio?: { mime_type?: unknown; data?: unknown; bytes?: unknown }; text?: unknown };
  usage?: { estimated_usd?: unknown };
  error?: unknown;
  detail?: unknown;
}

/** Audio de una respuesta 200 de /v1/music: bytes y extension, o null si no se puede leer. */
export function audioFromMusic(body: MusicResponse | null): { bytes: Uint8Array; ext: 'wav' | 'flac' | 'mp3' } | null {
  const audio = body?.output?.audio;
  if (!audio || typeof audio.data !== 'string' || !audio.data) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(audio.data);
  } catch {
    return null;
  }
  if (bytes.byteLength < 1) return null;
  // Los primeros bytes mandan; el mime declarado solo decide si no se reconocen.
  const mime = typeof audio.mime_type === 'string' ? audio.mime_type.toLowerCase().split(';')[0].trim() : '';
  const ext = detectAudioExt(bytes) ?? MIME_EXT[mime] ?? null;
  return ext ? { bytes, ext } : null;
}

export const lyria: GenerateProvider = {
  assertAvailable(env: Env): void {
    if (!(env.URIT_AI_TOKEN || '').trim()) throw new ProviderError(503, 'provider_unavailable', 'falta URIT_AI_TOKEN');
  },

  async generate(env: Env, fetchFn: FetchLike, request: GenerateRequest): Promise<GenerateResult> {
    const token = (env.URIT_AI_TOKEN || '').trim();
    if (!token) throw new ProviderError(503, 'provider_unavailable', 'falta URIT_AI_TOKEN');
    let res: Response;
    let body: MusicResponse | null;
    try {
      res = await fetchFn(`${uritAiUrl(env)}/v1/music`, {
        method: 'POST',
        headers: uritHeaders(env, token),
        body: JSON.stringify({ task: TASK, model: lyriaModel(env, request.duration_s), prompt: lyriaPrompt(request), time_budget_ms: TIME_BUDGET_MS }),
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      });
      // El cuerpo entero (varios MB en base64) se lee dentro del mismo limite de tiempo.
      body = (await res.json().catch(() => null)) as MusicResponse | null;
    } catch (err) {
      // Pasado el limite propio, URiT ya debio cortar con 504: Google pudo cobrar, igual que alli.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { audio: null, failure: FAILURE_LYRIA_TIMEOUT, costUsd: null };
      }
      throw new ProviderError(502, 'provider_failed', 'urit-ai music: sin respuesta');
    }
    const code = typeof body?.error === 'string' ? body.error.slice(0, 60) : '';
    const detail = typeof body?.detail === 'string' ? body.detail.slice(0, 60) : '';
    if (!res.ok) {
      // Configuracion (token, consumidor apagado o sin modelos de musica, URiT sin llave): no disponible.
      if (res.status === 401 || res.status === 403 || res.status === 503 || (res.status === 422 && code === 'model_not_allowed')) {
        throw new ProviderError(503, 'provider_unavailable', `urit-ai music: HTTP ${res.status} ${code}`);
      }
      // Sin costo segun URiT (4A.2): el trabajo falla con un motivo y la reserva vuelve a 0.
      if (res.status === 429) return { audio: null, failure: FAILURE_LYRIA_QUOTA, costUsd: 0 };
      if (res.status === 502 && code === 'blocked') return { audio: null, failure: FAILURE_LYRIA_BLOCKED, costUsd: 0 };
      if (res.status === 502 && detail === 'NO_AUDIO') return { audio: null, failure: FAILURE_LYRIA_NO_AUDIO, costUsd: 0 };
      // URiT lo cuenta como cobrado: el gasto queda (usage.estimated_usd si vino, si no la estimacion).
      if (res.status === 504) return { audio: null, failure: FAILURE_LYRIA_TIMEOUT, costUsd: readEstimatedUsd(body) };
      throw new ProviderError(502, 'provider_failed', `urit-ai music: HTTP ${res.status} ${code} ${detail}`.trim());
    }
    const costUsd = readEstimatedUsd(body);
    const audio = audioFromMusic(body);
    // La cancion ya se genero y se cobro: un audio ilegible es un trabajo FAILED con el costo.
    if (!audio) return { audio: null, failure: FAILURE_LYRIA_UNREADABLE, costUsd };
    return { audio, failure: null, costUsd };
  },
};
