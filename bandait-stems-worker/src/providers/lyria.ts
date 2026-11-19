// Lyria por la Gemini API (clave simple, secreto GEMINI_API_KEY). No es Vertex AI.
//
// Consultado el 2026-11-19 en https://aistudio.google.com/docs/music-generation (a donde redirige
// ai.google.dev/gemini-api/docs/music-generation), leido a traves de un resumen automatico de la
// pagina, no de su texto literal:
//   POST https://generativelanguage.googleapis.com/v1beta/interactions
//   cabeceras: x-goog-api-key, Api-Revision: 2026-05-20, Content-Type: application/json
//   cuerpo:    {"model": "lyria-3-clip-preview" | "lyria-3.5", "input": "<texto>"}
//   respuesta: steps[] con type "model_output"; dentro, content[] con type "audio" y `data` en base64
//   modelos:   lyria-3-clip-preview da clips de 30 s; lyria-3.5 da canciones de un par de minutos
//              y la duracion se pide en el texto. Salida MP3 por defecto, 44.1 kHz estereo.
//   sin voz:   se pide en el texto ("Instrumental only, no vocals"); no hay parametro.
//
// NO VERIFICADO (la pagina no lo dice o no se pudo leer literal):
//   - el formato exacto de un error y de un pedido bloqueado por los filtros de seguridad;
//   - cuanto tarda la llamada y si existe un modo asincrono;
//   - el campo que declara el tipo del audio en la respuesta: por eso el formato se detecta por
//     los primeros bytes (detectAudioExt) y no por un campo;
//   - precio (la pagina remite a otra). La tarifa de costo es configuracion del Worker.
//
// LIMITE CONOCIDO: la llamada es sincrona. `POST .../jobs` con `generate` no responde hasta que
// Lyria entrega el audio, y el audio llega en base64 dentro de un JSON que el Worker carga entero
// en memoria (un MP3 de 3 minutos son unos 5 MB en base64; el Worker tiene 128 MB). Decodificarlo
// gasta CPU: en el plan gratuito de Workers (10 ms de CPU por peticion) puede no alcanzar. Si la
// llamada empieza a cortarse (el cliente cierra la conexion, o Cloudflare corta por CPU), el
// camino es Cloudflare Queues: `POST` deja el trabajo en STARTED y encola un mensaje; un consumidor
// (hasta 15 minutos por lote) llama a `generate` y escribe el resultado en jobs/<job>.json. El
// resto del flujo (`GET .../jobs/{job}`) no cambia. No se agrego Queues todavia.

import { ProviderError } from './types.ts';
import type { GenerateProvider, GenerateRequest, GeneratedAudio } from './types.ts';
import type { Env, FetchLike } from '../types.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const API_REVISION = '2026-05-20';
const DEFAULT_CLIP_MODEL = 'lyria-3-clip-preview';
const DEFAULT_SONG_MODEL = 'lyria-3.5';
/** Duracion de los clips del modelo corto. Un pedido mas largo va al modelo de canciones. */
const CLIP_SECONDS = 30;

export function lyriaModel(env: Env, durationS: number): string {
  return durationS <= CLIP_SECONDS
    ? (env.LYRIA_CLIP_MODEL || '').trim() || DEFAULT_CLIP_MODEL
    : (env.LYRIA_SONG_MODEL || '').trim() || DEFAULT_SONG_MODEL;
}

/** Texto que recibe Lyria: lo que escribio el usuario mas el tempo, la tonalidad y la duracion de la sesion. */
export function lyriaPrompt(request: GenerateRequest): string {
  const lines = [request.prompt.trim(), `Tempo: ${Number(request.bpm.toFixed(2))} BPM.`];
  if (request.key) lines.push(`Key: ${request.key}.`);
  lines.push(`Duration: about ${Math.round(request.duration_s)} seconds.`);
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

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** El primer bloque de audio de una respuesta de `interactions`, o null si no trae ninguno. */
export function audioFromInteraction(body: unknown): string | null {
  const steps = (body as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    const s = step as { type?: unknown; content?: unknown } | null;
    if (s?.type !== 'model_output' || !Array.isArray(s.content)) continue;
    for (const block of s.content) {
      const b = block as { type?: unknown; data?: unknown } | null;
      if (b?.type === 'audio' && typeof b.data === 'string' && b.data.length > 0) return b.data;
    }
  }
  return null;
}

export const lyria: GenerateProvider = {
  assertAvailable(env: Env): void {
    if (!(env.GEMINI_API_KEY || '').trim()) throw new ProviderError(503, 'provider_unavailable', 'falta GEMINI_API_KEY');
  },

  async generate(env: Env, fetchFn: FetchLike, request: GenerateRequest): Promise<GeneratedAudio> {
    const key = (env.GEMINI_API_KEY || '').trim();
    if (!key) throw new ProviderError(503, 'provider_unavailable', 'falta GEMINI_API_KEY');
    let res: Response;
    try {
      res = await fetchFn(ENDPOINT, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Api-Revision': API_REVISION, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: lyriaModel(env, request.duration_s), input: lyriaPrompt(request) }),
      });
    } catch {
      throw new ProviderError(502, 'provider_failed', 'lyria: sin respuesta');
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new ProviderError(502, 'provider_failed', `lyria: HTTP ${res.status} ${detail}`);
    }
    const data = audioFromInteraction(await res.json().catch(() => null));
    if (!data) throw new ProviderError(502, 'provider_failed', 'lyria: la respuesta no trae audio');
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(data);
    } catch {
      throw new ProviderError(502, 'provider_failed', 'lyria: audio ilegible');
    }
    if (bytes.byteLength < 1) throw new ProviderError(502, 'provider_failed', 'lyria: audio vacio');
    const ext = detectAudioExt(bytes);
    // NO VERIFICADO que Lyria solo entregue MP3 o WAV: otro contenedor (ogg, m4a) cae aqui.
    if (!ext) throw new ProviderError(502, 'provider_failed', 'lyria: el audio no es WAV, FLAC ni MP3');
    return { bytes, ext };
  },
};
