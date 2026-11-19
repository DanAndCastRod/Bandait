/**
 * Cliente de las rutas /studio del Worker `bandait-stems`. Contrato: bandait-protocol/STUDIO_V1.md
 * (secciones 3 a 7):
 *   GET    /v1/bands/{band}/studio                              integrante
 *   GET    /v1/bands/{band}/studio/{session}/session            integrante (ETag)
 *   PUT    /v1/bands/{band}/studio/{session}/session            Owner / MusicDirector (If-Match)
 *   DELETE /v1/bands/{band}/studio/{session}                    Owner / MusicDirector
 *   PUT    /v1/bands/{band}/studio/{session}/assets/{asset}     Owner / MusicDirector
 *   GET    /v1/bands/{band}/studio/{session}/assets/{asset}     integrante
 *   POST   /v1/bands/{band}/studio/{session}/jobs[?estimate=1]  Owner / MusicDirector
 *   GET    /v1/bands/{band}/studio/{session}/jobs/{job}         integrante
 *
 * Es la frontera snake_case <-> camelCase de los trabajos de IA (el documento de sesion lo
 * traduce session.ts). Mismo patron que stemCloud.ts: la URL, el token y `fetch` llegan en el
 * CloudTarget, y los errores son StemCloudError (code, status) con mensaje en espanol propio del
 * Estudio. OJO: `no_session` con estado 404 es "la sesion del Estudio no existe"; con estado 401
 * es "no hay sesion de nube".
 *
 * Modulo sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import { StemCloudError, authHeaders, failFrom, send, type CloudTarget } from '../stemCloud.ts'
import { isStemRole } from '../stemNames.ts'
import {
  STUDIO_MASTER_ID,
  STUDIO_MAX_ASSET_BYTES,
  STUDIO_PROVIDERS,
  STUDIO_VOLUME_DB_MAX,
  STUDIO_VOLUME_DB_MIN,
  StudioSessionError,
  assetExtension,
  isStudioFxType,
  isStudioId,
  parseSession,
  partialFxParamsFromWire,
  serializeFx,
  sessionToJson,
  type StudioAssetSource,
  type StudioProvider,
  type StudioSession,
} from './session.ts'
import type {
  CloudSession,
  CloudSessionSummary,
  MixMetrics,
  MixSuggestion,
  PutSessionOptions,
  StudioCloudApi,
  StudioJobAsset,
  StudioJobEstimate,
  StudioJobKind,
  StudioJobRequest,
  StudioJobState,
  WatchJobOptions,
} from './types.ts'

/** Sondeo recomendado por el contrato (STUDIO_V1.md 6.5). */
export const STUDIO_JOB_POLL_MS = 3000
export const STUDIO_JOB_TIMEOUT_MS = 15 * 60 * 1000
/** Reintentos seguidos ante 502 asset_copy_failed o errores de red antes de rendirse. */
export const STUDIO_JOB_MAX_RETRIES = 8
/** Maximo de sugerencias que trae un trabajo `assist`. */
export const STUDIO_MAX_SUGGESTIONS = 32
export const STUDIO_MAX_REASON = 280

const JOB_KINDS: readonly StudioJobKind[] = ['master', 'separate', 'generate', 'assist']
const JOB_ASSET_KINDS: readonly StudioJobAsset['kind'][] = ['master', 'stem', 'generated']

const ASSET_MIME: Record<string, string> = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg' }

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

const MESSAGES: Record<string, string> = {
  missing_token: 'Tu sesión de nube no está activa. Vuelve a entrar con Google.',
  invalid_token: 'Tu sesión de nube venció o no es válida. Vuelve a entrar con Google.',
  not_a_member: 'No eres integrante de esta banda en la nube.',
  not_an_editor: 'Solo el Owner o el Director musical de la banda pueden guardar sesiones o lanzar trabajos del Estudio.',
  bad_band: 'La banda no es válida para la nube del Estudio.',
  bad_session_id: 'El id de la sesión no es válido para la nube.',
  bad_session: 'La nube rechazó la sesión: el documento no cumple el formato del Estudio.',
  bad_asset: 'El nombre de un audio no es válido para la nube.',
  bad_job: 'La nube rechazó el trabajo: revisa los datos e intenta de nuevo.',
  empty_body: 'El audio que se intentó subir está vacío.',
  incomplete_upload: 'La subida de un audio quedó incompleta. Reintenta.',
  no_asset: 'Falta un audio de esta sesión en la nube.',
  no_job: 'Ese trabajo ya no existe en la nube.',
  missing_asset: 'Falta subir un audio antes de guardar la sesión. Reintenta el guardado.',
  asset_exists: 'Ya hay en la nube un audio distinto con ese nombre. Un audio no se puede reemplazar.',
  length_required: 'El navegador no informó el tamaño del audio. Reintenta.',
  session_conflict: 'Otra persona guardó esta sesión mientras editabas. Recarga la sesión o guarda la tuya como copia.',
  session_too_large: 'La sesión supera los 256 KB que admite la nube. Quita clips o audios sin uso.',
  document_too_large: 'La sesión supera los 256 KB que admite la nube. Quita clips o audios sin uso.',
  file_too_large: 'Un audio supera los 200 MB que admite la nube.',
  not_audio: 'La nube solo acepta archivos de audio.',
  bad_range: 'La nube no pudo entregar ese tramo del audio.',
  precondition_required: 'El guardado no indicó sobre qué versión se editó. Recarga la sesión.',
  quota_exceeded: 'La banda llegó al tope de gasto de IA de este mes. El trabajo no se lanzó.',
  not_a_spender: 'Tu cuenta no está en la lista de quienes pueden lanzar trabajos de IA en la nube de Bandait.',
  usage_busy: 'La nube no pudo anotar el gasto en este momento. El trabajo no se lanzó: reintenta.',
  too_many_assets: 'Esta sesión ya tiene en la nube el máximo de audios (320). Borra la sesión de la nube o usa una nueva.',
  provider_failed: 'El proveedor de IA rechazó el trabajo. Reintenta en unos minutos.',
  asset_copy_failed: 'No se pudo copiar un audio del proveedor a la nube. Se reintenta solo.',
  auth_unavailable: 'La nube no pudo verificar tu sesión en este momento. Reintenta en un rato.',
  network: 'No hay conexión con la nube del Estudio. Revisa tu internet y reintenta.',
  bad_response: 'La nube devolvió una respuesta que el Estudio no entiende.',
  size_mismatch: 'Un audio descargado no tiene el tamaño esperado. Reintenta.',
  aborted: 'La operación se canceló.',
  timeout: 'El trabajo tarda más de lo normal. Vuelve a consultarlo más tarde: el resultado queda guardado en la nube.',
}

export function studioCloudErrorMessage(code: string, status = 0): string {
  if (code === 'no_session') {
    return status === 404 ? 'Esta sesión del Estudio no existe en la nube.' : 'Necesitas una sesión de nube activa para usar el Estudio en la nube.'
  }
  if (code === 'provider_unavailable') {
    return status === 501
      ? 'Ese proveedor todavía no tiene acceso por API. Elige otro.'
      : 'Ese proveedor de IA no está configurado en la nube de Bandait.'
  }
  if (MESSAGES[code]) return MESSAGES[code]
  if (status === 401) return MESSAGES.invalid_token
  if (status === 403) return 'La nube no te permite hacer esto en esta banda.'
  if (status === 412) return MESSAGES.session_conflict
  if (status === 429) return MESSAGES.quota_exceeded
  if (status >= 500) return `La nube del Estudio falló (HTTP ${status}). Reintenta en un rato.`
  return `La nube del Estudio respondió con un error (${code || `HTTP ${status}`}).`
}

function studioError(code: string, status: number, detail?: string): StemCloudError {
  const message = studioCloudErrorMessage(code, status)
  return new StemCloudError(code, status, detail ? `${message} ${detail}` : message)
}

function rethrow(err: unknown): never {
  if (err instanceof StemCloudError) throw studioError(err.code, err.status)
  throw err
}

async function auth(target: CloudTarget): Promise<Record<string, string>> {
  try {
    return await authHeaders(target)
  } catch (err) {
    rethrow(err)
  }
}

async function request(target: CloudTarget, url: string, init: RequestInit): Promise<Response> {
  try {
    return await send(target, url, init)
  } catch (err) {
    if (init.signal?.aborted) throw studioError('aborted', 0)
    rethrow(err)
  }
}

async function failure(res: Response): Promise<StemCloudError> {
  const err = await failFrom(res)
  return studioError(err.code, err.status)
}

async function jsonBody(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown
  } catch {
    throw studioError('bad_response', res.status)
  }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

export function studioUrl(target: CloudTarget): string {
  return `${target.baseUrl.replace(/\/+$/, '')}/v1/bands/${encodeURIComponent(target.band)}/studio`
}

function sessionUrl(target: CloudTarget, sessionId: string): string {
  // Los ids que empiezan por '_' estan reservados en R2 (studio/_usage).
  if (!isStudioId(sessionId) || sessionId.startsWith('_')) throw studioError('bad_session_id', 400)
  return `${studioUrl(target)}/${encodeURIComponent(sessionId)}`
}

function assetUrl(target: CloudTarget, sessionId: string, file: string): string {
  const base = sessionUrl(target, sessionId)
  const ext = assetExtension(file)
  if (ext === null || !isStudioId(file.slice(0, file.length - ext.length - 1))) throw studioError('bad_asset', 400)
  return `${base}/assets/${encodeURIComponent(file)}`
}

function jobUrl(target: CloudTarget, sessionId: string, jobId: string): string {
  const base = sessionUrl(target, sessionId)
  if (!isStudioId(jobId)) throw studioError('bad_job', 400)
  return `${base}/jobs/${encodeURIComponent(jobId)}`
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>

function isObject(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export async function listSessions(target: CloudTarget): Promise<CloudSessionSummary[]> {
  const headers = await auth(target)
  const res = await request(target, studioUrl(target), { method: 'GET', headers, cache: 'no-store' })
  if (!res.ok) throw await failure(res)
  const body = await jsonBody(res)
  if (!isObject(body) || !Array.isArray(body.sessions)) throw studioError('bad_response', res.status)
  const out: CloudSessionSummary[] = []
  for (const item of body.sessions) {
    // Defensivo: una entrada que no se entiende se omite, no tumba la lista.
    if (!isObject(item) || !isStudioId(item.id)) continue
    out.push({
      id: item.id,
      title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : item.id,
      songId: typeof item.song_id === 'string' && item.song_id ? item.song_id : null,
      updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    })
  }
  return out
}

function parseCloudSession(raw: unknown, status: number): StudioSession {
  try {
    return parseSession(raw)
  } catch (err) {
    if (err instanceof StudioSessionError) throw studioError('bad_response', status, `(${err.message})`)
    throw err
  }
}

export async function getSession(target: CloudTarget, sessionId: string): Promise<CloudSession | null> {
  const url = `${sessionUrl(target, sessionId)}/session`
  const headers = await auth(target)
  const res = await request(target, url, { method: 'GET', headers, cache: 'no-store' })
  if (res.status === 404) {
    const err = await failFrom(res)
    if (err.code === 'no_session' || err.code === '') return null
    throw studioError(err.code, err.status)
  }
  if (!res.ok) throw await failure(res)
  const etag = res.headers.get('ETag')
  if (!etag) throw studioError('bad_response', res.status)
  const session = parseCloudSession(await jsonBody(res), res.status)
  if (session.id !== sessionId) throw studioError('bad_response', res.status)
  return { session, etag }
}

export async function putSession(target: CloudTarget, session: StudioSession, options: PutSessionOptions): Promise<CloudSession> {
  const url = `${sessionUrl(target, session.id)}/session`
  // Valida antes de salir a la red: un documento invalido lanza StudioSessionError aqui.
  const body = sessionToJson(session)
  const headers = await auth(target)
  headers['Content-Type'] = 'application/json'
  if (options.ifMatch === null) headers['If-None-Match'] = '*'
  else headers['If-Match'] = options.ifMatch
  const res = await request(target, url, { method: 'PUT', headers, body })
  if (!res.ok) throw await failure(res)
  const etag = res.headers.get('ETag')
  if (!etag) throw studioError('bad_response', res.status)
  // El Worker devuelve el documento guardado, con su updated_at y updated_by.
  return { session: parseCloudSession(await jsonBody(res), res.status), etag }
}

export async function deleteSession(target: CloudTarget, sessionId: string): Promise<number> {
  const url = sessionUrl(target, sessionId)
  const headers = await auth(target)
  const res = await request(target, url, { method: 'DELETE', headers })
  if (!res.ok) throw await failure(res)
  try {
    const body = (await res.json()) as { deleted?: unknown }
    return finite(body.deleted) ? body.deleted : 0
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Audios
// ---------------------------------------------------------------------------

export async function putAsset(target: CloudTarget, sessionId: string, file: string, data: Blob): Promise<{ file: string; size: number }> {
  const url = assetUrl(target, sessionId, file)
  if (data.size === 0) throw studioError('empty_body', 400)
  if (data.size > STUDIO_MAX_ASSET_BYTES) throw studioError('file_too_large', 413)
  const headers = await auth(target)
  headers['Content-Type'] = ASSET_MIME[assetExtension(file) ?? ''] ?? 'application/octet-stream'
  // El navegador pone Content-Length a partir del Blob.
  const res = await request(target, url, { method: 'PUT', headers, body: data })
  if (!res.ok) throw await failure(res)
  try {
    const body = (await res.json()) as { size?: unknown }
    return { file, size: finite(body.size) ? body.size : data.size }
  } catch {
    return { file, size: data.size }
  }
}

export async function getAsset(target: CloudTarget, sessionId: string, file: string, signal?: AbortSignal): Promise<Blob> {
  const url = assetUrl(target, sessionId, file)
  const headers = await auth(target)
  const res = await request(target, url, { method: 'GET', headers, cache: 'no-store', signal })
  if (!res.ok) throw await failure(res)
  let blob: Blob
  try {
    blob = await res.blob()
  } catch {
    throw studioError(signal?.aborted ? 'aborted' : 'network', 0)
  }
  const type = ASSET_MIME[assetExtension(file) ?? '']
  return type && blob.type !== type ? new Blob([blob], { type }) : blob
}

// ---------------------------------------------------------------------------
// Trabajos: traduccion al cable
// ---------------------------------------------------------------------------

function nullableNumber(value: number | null): number | null {
  return finite(value) ? value : null
}

function metricsToWire(metrics: MixMetrics): Raw {
  return {
    target_lufs: metrics.targetLufs,
    master: { lufs: nullableNumber(metrics.master.lufs), true_peak_db: nullableNumber(metrics.master.truePeakDb) },
    tracks: metrics.tracks.map((t) => ({
      track_id: t.trackId,
      name: t.name,
      role: t.role,
      lufs: nullableNumber(t.lufs),
      true_peak_db: nullableNumber(t.truePeakDb),
      bands: t.bands
        ? { low_db: t.bands.lowDb, low_mid_db: t.bands.lowMidDb, high_mid_db: t.bands.highMidDb, high_db: t.bands.highDb }
        : null,
      volume_db: t.volumeDb,
      pan: t.pan,
      fx: t.fx.map(serializeFx),
    })),
  }
}

/** Cuerpo de POST .../jobs (STUDIO_V1.md 6.1) para una peticion del Hub. */
export function jobRequestToWire(req: StudioJobRequest): Record<string, unknown> {
  switch (req.kind) {
    case 'master':
      return { kind: 'master', asset_id: req.assetId, duration_s: req.durationS, target_lufs: req.targetLufs }
    case 'separate':
      return { kind: 'separate', asset_id: req.assetId, duration_s: req.durationS }
    case 'generate':
      return {
        kind: 'generate',
        provider: req.provider,
        prompt: req.prompt,
        duration_s: req.durationS,
        bpm: req.bpm,
        key: req.key,
        instrumental: req.instrumental,
      }
    case 'assist':
      return { kind: 'assist', metrics: metricsToWire(req.metrics) }
  }
}

function parseSource(raw: unknown): StudioAssetSource | null {
  if (!isObject(raw)) return null
  if (!(STUDIO_PROVIDERS as readonly unknown[]).includes(raw.provider) || !isStudioId(raw.job_id)) return null
  const source: StudioAssetSource = { provider: raw.provider as StudioProvider, jobId: raw.job_id }
  if (typeof raw.prompt === 'string' && raw.prompt !== '') source.prompt = raw.prompt
  return source
}

function parseJobAsset(raw: unknown): StudioJobAsset | null {
  if (!isObject(raw) || !isStudioId(raw.id) || typeof raw.file !== 'string') return null
  const ext = assetExtension(raw.file)
  if (ext === null || raw.file !== `${raw.id}.${ext}`) return null
  const kind = raw.kind as StudioJobAsset['kind']
  if (!JOB_ASSET_KINDS.includes(kind)) return null
  if (!finite(raw.size) || !Number.isInteger(raw.size) || raw.size < 1) return null
  const source = parseSource(raw.source)
  if (!source) return null
  return {
    id: raw.id,
    file: raw.file,
    kind,
    label: typeof raw.label === 'string' ? raw.label : '',
    role: isStemRole(raw.role) ? raw.role : null,
    size: raw.size,
    channels: raw.channels === 1 || raw.channels === 2 ? raw.channels : null,
    sampleRate: finite(raw.sample_rate) && raw.sample_rate > 0 ? raw.sample_rate : null,
    durationS: finite(raw.duration_s) && raw.duration_s > 0 ? raw.duration_s : null,
    source,
  }
}

function parseSuggestion(raw: unknown): MixSuggestion | null {
  if (!isObject(raw) || !isStudioId(raw.track_id)) return null
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  if (reason.length < 1 || reason.length > STUDIO_MAX_REASON) return null
  const trackId = raw.track_id
  const onMaster = trackId === STUDIO_MASTER_ID
  if (raw.target === 'volume_db') {
    if (!finite(raw.value) || raw.value < STUDIO_VOLUME_DB_MIN || raw.value > STUDIO_VOLUME_DB_MAX) return null
    return { trackId, reason, target: 'volume_db', value: raw.value }
  }
  if (raw.target === 'pan') {
    if (onMaster || !finite(raw.value) || raw.value < -1 || raw.value > 1) return null
    return { trackId, reason, target: 'pan', value: raw.value }
  }
  if (raw.target === 'fx') {
    if (!isStudioFxType(raw.fx_type)) return null
    if (raw.fx_type === 'limiter' && !onMaster) return null
    try {
      const params = partialFxParamsFromWire(raw.fx_type, raw.params ?? {})
      return { trackId, reason, target: 'fx', fxType: raw.fx_type, params } as MixSuggestion
    } catch {
      return null
    }
  }
  return null
}

/**
 * Sugerencias del asistente desde el cable (STUDIO_V1.md 6.4). Descarta las que no cumplen el
 * contrato (rango, limitador fuera del master, paneo en el master) y corta en 32. No comprueba
 * que la pista exista: eso depende de la sesion (jobs.suggestionsForSession).
 */
export function parseMixSuggestions(raw: unknown): MixSuggestion[] {
  if (!Array.isArray(raw)) return []
  const out: MixSuggestion[] = []
  for (const item of raw) {
    const suggestion = parseSuggestion(item)
    if (suggestion) out.push(suggestion)
    if (out.length >= STUDIO_MAX_SUGGESTIONS) break
  }
  return out
}

/** Estado de un trabajo desde el cable (STUDIO_V1.md 6.5). `jobId` es el que se consulto. */
export function parseJobState(raw: unknown, jobId: string, status = 200): StudioJobState {
  if (!isObject(raw)) throw studioError('bad_response', status)
  const kind = raw.kind as StudioJobKind
  if (!JOB_KINDS.includes(kind)) throw studioError('bad_response', status)
  const id = isStudioId(raw.job_id) ? raw.job_id : jobId
  const costUsd = finite(raw.cost_usd) ? raw.cost_usd : null
  if (raw.status === 'SUCCEEDED') {
    if (kind === 'assist') return { status: 'SUCCEEDED', jobId: id, kind, suggestions: parseMixSuggestions(raw.suggestions), costUsd }
    if (!Array.isArray(raw.assets)) throw studioError('bad_response', status)
    const assets: StudioJobAsset[] = []
    for (const item of raw.assets) {
      const asset = parseJobAsset(item)
      // Un audio que no se entiende no se puede agregar a la sesion: mejor fallar que perderlo en silencio.
      if (!asset) throw studioError('bad_response', status)
      assets.push(asset)
    }
    return { status: 'SUCCEEDED', jobId: id, kind, assets, costUsd }
  }
  if (raw.status === 'FAILED') {
    const error = typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : 'El proveedor no pudo terminar el trabajo.'
    return { status: 'FAILED', jobId: id, kind, error }
  }
  if (raw.status === 'IMPORTING') {
    const count = (v: unknown) => (finite(v) && Number.isInteger(v) && v >= 0 ? v : 0)
    const total = count(raw.total)
    return { status: 'IMPORTING', jobId: id, kind, done: Math.min(count(raw.done), total || count(raw.done)), total }
  }
  // STARTED o cualquier estado intermedio del proveedor: sigue en curso.
  return { status: 'STARTED', jobId: id, kind }
}

// ---------------------------------------------------------------------------
// Trabajos: HTTP
// ---------------------------------------------------------------------------

async function postJob(target: CloudTarget, sessionId: string, req: StudioJobRequest, estimate: boolean, jobId?: string): Promise<{ body: unknown; status: number }> {
  const query = estimate ? '?estimate=1' : jobId ? `?job_id=${encodeURIComponent(jobId)}` : ''
  const url = `${sessionUrl(target, sessionId)}/jobs${query}`
  const headers = await auth(target)
  headers['Content-Type'] = 'application/json'
  const res = await request(target, url, { method: 'POST', headers, body: JSON.stringify(jobRequestToWire(req)) })
  if (!res.ok) throw await failure(res)
  return { body: await jsonBody(res), status: res.status }
}

/**
 * `jobId` (opcional, `job_...`) hace el POST idempotente (STUDIO_V1.md 6.1): repetirlo con el
 * mismo id no lanza ni cobra otro trabajo. Quien lo elige puede consultar ese id aunque la
 * respuesta del POST se pierda.
 */
export async function startJob(target: CloudTarget, sessionId: string, req: StudioJobRequest, jobId?: string): Promise<StudioJobState> {
  const { body, status } = await postJob(target, sessionId, req, false, jobId)
  if (!isObject(body) || !isStudioId(body.job_id)) throw studioError('bad_response', status)
  return { status: 'STARTED', jobId: body.job_id, kind: req.kind }
}

export async function estimateJob(target: CloudTarget, sessionId: string, req: StudioJobRequest): Promise<StudioJobEstimate> {
  const { body, status } = await postJob(target, sessionId, req, true)
  if (!isObject(body) || !finite(body.estimated_cost_usd) || typeof body.allowed !== 'boolean') throw studioError('bad_response', status)
  return {
    kind: req.kind,
    estimatedCostUsd: body.estimated_cost_usd,
    spentUsd: finite(body.spent_usd) ? body.spent_usd : 0,
    budgetUsd: finite(body.budget_usd) ? body.budget_usd : null,
    allowed: body.allowed,
  }
}

export async function getJob(target: CloudTarget, sessionId: string, jobId: string): Promise<StudioJobState> {
  const url = jobUrl(target, sessionId, jobId)
  const headers = await auth(target)
  const res = await request(target, url, { method: 'GET', headers, cache: 'no-store' })
  if (!res.ok) throw await failure(res)
  return parseJobState(await jsonBody(res), jobId, res.status)
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })
}

export async function watchJob(target: CloudTarget, sessionId: string, jobId: string, options: WatchJobOptions = {}): Promise<StudioJobState | null> {
  const interval = options.intervalMs ?? STUDIO_JOB_POLL_MS
  const timeout = options.timeoutMs ?? STUDIO_JOB_TIMEOUT_MS
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const since = now()
  let retries = 0
  for (;;) {
    if (options.signal?.aborted) return null
    let state: StudioJobState
    try {
      state = await getJob(target, sessionId, jobId)
      retries = 0
    } catch (err) {
      const retryable = err instanceof StemCloudError && (err.code === 'asset_copy_failed' || err.code === 'network')
      if (!retryable || ++retries > STUDIO_JOB_MAX_RETRIES) throw err
      if (options.signal?.aborted) return null
      await sleep(interval, options.signal)
      continue
    }
    if (options.signal?.aborted) return null
    options.onState?.(state)
    if (state.status === 'SUCCEEDED' || state.status === 'FAILED') return state
    if (now() - since > timeout) {
      // No es un fallo del trabajo: sigue en la nube y se puede volver a consultar con su id.
      const failed: StudioJobState = { status: 'FAILED', jobId: state.jobId, kind: state.kind, error: MESSAGES.timeout, resumable: true }
      options.onState?.(failed)
      return failed
    }
    await sleep(interval, options.signal)
  }
}

void ({
  studioUrl,
  studioCloudErrorMessage,
  listSessions,
  getSession,
  putSession,
  deleteSession,
  putAsset,
  getAsset,
  startJob,
  estimateJob,
  getJob,
  watchJob,
} satisfies StudioCloudApi)
