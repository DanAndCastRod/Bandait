// Registro de eventos del Estudio (docs/PLAN_MCP_BANDAIT_URIT.md, seccion 2.2). Cada trabajo de IA
// que termina (SUCCEEDED o FAILED) y cada fallo de proveedor (rechazo al lanzar, error HTTP al
// sondear o al copiar) deja un JSON en R2. Tambien cada limpieza de audios huerfanos que borra algo
// o que se bloquea por una sesion ilegible (`kind` `cleanup`, `provider` `r2`, src/studioCleanup.ts):
//
//   studio/_events/AAAA-MM-DD/<HHMMSSmmm>-<8 hex>.json
//
// en la raiz del bucket (no bajo la banda), para que el MCP (src/mcp.ts) lea los de todas las bandas
// sin recorrer prefijos. El nombre empieza por la hora UTC: dentro de un dia, el orden alfabetico es
// el orden en el tiempo. Los campos de filtro van tambien en customMetadata, para filtrar al listar
// sin leer cada objeto.
//
// NUNCA se guarda el prompt, la letra, el audio, las metricas, la respuesta del modelo, tokens ni
// claves: solo ids, codigos, tiempos y costos. `provider_detail` se limpia de cualquier cosa con
// forma de clave o token y se recorta a 80 caracteres.
//
// La escritura va a waitUntil y nunca lanza: un fallo al anotar no retrasa ni rompe la respuesta.
// Retencion: 30 dias, con el handler `scheduled` del Worker (purgeEvents, cron diario).

import type { Env, R2Bucket, StudioDeps } from './types.ts';

export const EVENTS_PREFIX = 'studio/_events/';
export const EVENT_RETENTION_DAYS = 30;
export const MAX_PROVIDER_DETAIL = 80;

/**
 * SUCCEEDED / FAILED: el trabajo termino. REJECTED: el proveedor no acepto el trabajo al lanzarlo
 * (no queda registro ni costo). TRANSIENT: un sondeo o una copia fallo y el trabajo sigue en curso.
 */
export type EventStatus = 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'TRANSIENT';

export interface StudioEvent {
  at: string;
  /** Prefijo de quien gasto, sin barra final: `bands/<uuid>` o `users/<uuid>` (workspace "me"). */
  band: string;
  session: string | null;
  job: string | null;
  kind: string;
  provider: string;
  status: EventStatus;
  /** Estado HTTP del proveedor; null si no hubo respuesta o no se conoce. */
  http: number | null;
  provider_code: string | null;
  provider_detail: string | null;
  urit_request_id: string | null;
  model: string | null;
  duration_ms: number | null;
  cost_usd: number | null;
  /**
   * Solo en los eventos de limpieza de huerfanos (`kind` `cleanup`, src/studioCleanup.ts): audios
   * borrados, sus bytes y quien la disparo (`cron`, `save` o `manual`). Nunca ids de audios.
   */
  objects?: number;
  bytes?: number;
  trigger?: string;
}

export type EventInput = Omit<StudioEvent, 'at' | 'provider_detail'> & { provider_detail?: unknown };

const SECRET_WORDS = /\b(authorization|bearer|api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|pwd|signature|sig|key)\b\s*[:=]?\s*\S+/gi;

/**
 * Detalle del proveedor apto para guardar: sin caracteres de control, sin nada con forma de clave o
 * token (cabeceras Bearer, `key=...`, prefijos conocidos, JWT, cadenas largas con digitos) y
 * recortado a 80 caracteres. null si no queda nada.
 */
export function sanitizeDetail(raw: unknown): string | null {
  return cleanText(raw, MAX_PROVIDER_DETAIL);
}

/** Igual que sanitizeDetail con otro largo maximo (el MCP lo usa para el `error` de un trabajo). */
export function cleanText(raw: unknown, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  let text = String(raw).replace(/[\u0000-\u001f\u007f]+/g, ' ');
  // Antes de recortar: una clave partida por el corte de 80 dejaria un pedazo visible.
  text = text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [oculto]')
    .replace(SECRET_WORDS, (m, word: string) => (/^bearer$/i.test(word) ? m : `${word} [oculto]`))
    .replace(/\b(sk|pk|rk|sb|AIza|ghp|gho|github_pat|xox[abprs]|ya29)[-_][A-Za-z0-9_\-]{6,}/g, '[oculto]')
    .replace(/\bAIza[A-Za-z0-9_\-]{10,}/g, '[oculto]')
    .replace(/\beyJ[A-Za-z0-9_\-]+(\.[A-Za-z0-9_\-]+)*/g, '[oculto]')
    // Cadena larga de caracteres de clave con al menos un digito (base64, hex, ids firmados).
    .replace(/[A-Za-z0-9_\-+/=.]{20,}/g, (m) => (/\d/.test(m) || m.length >= 40 ? '[oculto]' : m))
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

function randomHex(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let out = '';
  for (const b of values) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Clave del evento: dia y hora UTC del momento en que ocurrio. */
export function eventKey(at: Date): string {
  const iso = at.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 23).replace(/[:.]/g, '');
  return `${EVENTS_PREFIX}${day}/${time}-${randomHex(4)}.json`;
}

/** Valores de customMetadata: texto corto, sin nulos. */
function meta(value: string | null): string {
  return (value ?? '').slice(0, 120);
}

/**
 * Anota un evento. Va a waitUntil (si existe) y nunca lanza ni espera: la respuesta al Hub no
 * depende de esta escritura.
 */
export function recordEvent(env: Env, deps: Pick<StudioDeps, 'now' | 'waitUntil'>, input: EventInput): void {
  try {
    const now = deps.now();
    const event: StudioEvent = {
      at: now.toISOString(),
      band: input.band,
      session: input.session,
      job: input.job,
      kind: input.kind,
      provider: input.provider,
      status: input.status,
      http: Number.isInteger(input.http) ? input.http : null,
      provider_code: input.provider_code ? String(input.provider_code).slice(0, 60) : null,
      provider_detail: sanitizeDetail(input.provider_detail),
      urit_request_id: input.urit_request_id,
      model: input.model ? String(input.model).slice(0, 80) : null,
      duration_ms: input.duration_ms !== null && Number.isFinite(input.duration_ms) ? Math.max(0, Math.round(input.duration_ms)) : null,
      cost_usd: input.cost_usd !== null && Number.isFinite(input.cost_usd) ? input.cost_usd : null,
    };
    if (input.objects !== undefined) {
      event.objects = Number.isSafeInteger(input.objects) ? Math.max(0, input.objects) : 0;
      event.bytes = Number.isSafeInteger(input.bytes) ? Math.max(0, input.bytes!) : 0;
      event.trigger = String(input.trigger ?? '').slice(0, 20);
    }
    const write = env.STEMS.put(eventKey(now), JSON.stringify(event), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        band: meta(event.band), kind: meta(event.kind), provider: meta(event.provider), status: event.status,
        session: meta(event.session), job: meta(event.job),
      },
    }).catch((err: unknown) => {
      console.warn(`studio events: no se pudo anotar (${err instanceof Error ? err.name : 'error'})`);
    });
    if (deps.waitUntil) deps.waitUntil(write);
  } catch (err) {
    console.warn(`studio events: no se pudo anotar (${err instanceof Error ? err.name : 'error'})`);
  }
}

/** Contador de operaciones de R2 de una invocacion (plan gratuito: 50 subpeticiones). */
export class OpBudget {
  used = 0;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  /** true si queda cupo (y lo consume). */
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  get left(): number {
    return this.max - this.used;
  }
}

/** Dias (AAAA-MM-DD) que tienen carpeta de eventos, en orden ascendente. */
export async function eventDays(bucket: R2Bucket, budget: OpBudget): Promise<{ days: string[]; truncated: boolean }> {
  const days: string[] = [];
  let cursor: string | undefined;
  do {
    if (!budget.take()) return { days, truncated: true };
    const page = await bucket.list({ prefix: EVENTS_PREFIX, delimiter: '/', cursor, limit: 1000 });
    for (const folder of page.delimitedPrefixes ?? []) {
      const day = folder.slice(EVENTS_PREFIX.length, -1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) days.push(day);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  days.sort();
  return { days, truncated: false };
}

/**
 * Borra las carpetas de eventos de mas de 30 dias. Respeta un tope de operaciones de R2 por
 * invocacion: si no alcanza, lo que quede se borra en la siguiente corrida del cron.
 */
export async function purgeEvents(
  env: Env, now: Date, maxOps = 40,
): Promise<{ deleted_days: string[]; deleted_objects: number; truncated: boolean }> {
  const budget = new OpBudget(maxOps);
  const cutoff = new Date(now.getTime() - EVENT_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  const listed = await eventDays(env.STEMS, budget);
  const old = listed.days.filter((d) => d < cutoff);
  const deletedDays: string[] = [];
  let deleted = 0;
  let truncated = listed.truncated;
  for (const day of old) {
    let complete = true;
    for (;;) {
      // Una lista y un borrado por pagina. Lo listado se borra: la pagina siguiente se pide otra
      // vez desde el principio, sin cursor.
      if (budget.left < 2) {
        complete = false;
        break;
      }
      budget.take();
      const page = await env.STEMS.list({ prefix: `${EVENTS_PREFIX}${day}/`, limit: 1000 });
      const keys = page.objects.map((o) => o.key);
      if (keys.length) {
        budget.take();
        await env.STEMS.delete(keys);
        deleted += keys.length;
      }
      if (!page.truncated || !keys.length) break;
    }
    if (!complete) {
      truncated = true;
      break;
    }
    deletedDays.push(day);
  }
  if (deleted || truncated) {
    console.log(`studio events: retencion, ${deleted} eventos borrados${truncated ? ' (quedan para la proxima corrida)' : ''}`);
  }
  return { deleted_days: deletedDays, deleted_objects: deleted, truncated };
}
