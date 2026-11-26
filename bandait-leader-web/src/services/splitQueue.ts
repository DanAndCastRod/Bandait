/**
 * Cola global "Drop & Split" (docs/REQUERIMIENTOS_WEB_3.0.md, seccion 5): subir el audio completo
 * de una cancion, separarlo con Music AI a traves del Worker (que copia los stems a R2) y, si se
 * pide, bajarlos e importarlos a este equipo. La cola vive fuera de las vistas: cambiar de vista
 * no aborta nada.
 *
 * Modulo sin React ni red: la red llega inyectada (SplitQueueDeps) y se prueba con node
 * (scripts/verify-global-audio.ts).
 *
 * - Un trabajo a la vez (el Worker separa por cancion y Music AI cobra por trabajo): el resto
 *   espera 'queued'. No se encolan dos trabajos activos para la misma cancion.
 * - Estados: queued -> uploading -> separating -> importing -> done, o error / canceled /
 *   interrupted. Un estado terminal no revive con avisos tardios.
 * - Cancelar en cola o subiendo no gasta nada (la subida se aborta). Despues de subir, cancelar
 *   solo deja de consultar: Music AI y el Worker pueden terminar igual y reemplazar la nube.
 * - Persistencia minima (localStorage, sin el archivo ni tokens): al recargar, lo que estaba en
 *   curso queda 'interrupted'. Si ya se habia subido, REINTENTAR vuelve a consultar sin archivo.
 */

export type SplitJobStatus = 'queued' | 'uploading' | 'separating' | 'importing' | 'done' | 'error' | 'canceled' | 'interrupted'

export type SplitLocalStatus = 'none' | 'downloading' | 'saved' | 'failed'

export interface SplitJob {
  id: string
  /** 'me' o uuid de la banda compartida (CloudTarget.band). */
  band: string
  songId: string
  songTitle: string
  fileName: string
  fileSize: number
  status: SplitJobStatus
  /** 0..1, o null si no se sabe (subida sin progreso, Music AI separando). */
  progress: number | null
  /** Texto corto de la fase (SUBIENDO 40 %..., COPIANDO STEMS 2/3...). */
  detail: string | null
  error: string | null
  /** La subida termino: el Worker tiene el audio (reintentar puede solo volver a consultar). */
  uploaded: boolean
  /** Music AI o el Worker dijeron FAILED: reintentar exige volver a subir. */
  remoteFailed: boolean
  /** Bajar e importar los stems a este equipo al terminar. */
  importLocal: boolean
  local: SplitLocalStatus
  localError: string | null
  /** Stems en la nube al terminar. */
  stemCount: number | null
  /** Stems guardados en este equipo. */
  localCount: number | null
  createdAt: number
  updatedAt: number
}

export const SPLIT_ACTIVE: readonly SplitJobStatus[] = ['queued', 'uploading', 'separating', 'importing']
export const SPLIT_TERMINAL: readonly SplitJobStatus[] = ['done', 'error', 'canceled', 'interrupted']
export const SPLIT_STORAGE_KEY = 'bandait_split_queue_v1'
/** Historial guardado (los mas recientes). */
export const SPLIT_HISTORY_LIMIT = 20

export const SPLIT_INTERRUPTED_MESSAGE = 'Se interrumpió al recargar o cerrar la página.'
export const SPLIT_CANCELED_REMOTE_NOTE = 'Se dejó de seguir. Music AI puede terminar igual y reemplazar los stems de la nube.'

export function isActive(status: SplitJobStatus): boolean {
  return SPLIT_ACTIVE.includes(status)
}

export function isTerminal(status: SplitJobStatus): boolean {
  return SPLIT_TERMINAL.includes(status)
}

/** Lo que se sabe del estado del Worker (subconjunto de AnalysisState de stemAnalysis.ts). */
export interface RemoteState {
  status: string
  done?: number
  total?: number
  error?: string
  stems?: { stems: readonly unknown[] } | null
}

export type SplitEvent =
  | { type: 'start' }
  | { type: 'upload'; fraction: number | null }
  | { type: 'uploaded' }
  | { type: 'remote'; state: RemoteState; detail: string }
  | { type: 'local-progress'; done: number; total: number }
  | { type: 'local-saved'; count: number }
  | { type: 'local-failed'; message: string }
  | { type: 'done'; stemCount: number | null }
  | { type: 'fail'; message: string; remote?: boolean }
  | { type: 'cancel' }
  | { type: 'retry'; reupload: boolean }

/**
 * Transicion pura de un trabajo. Devuelve el mismo objeto si el evento no aplica (estado terminal,
 * evento fuera de orden), asi la cola sabe que no hay nada que guardar ni avisar.
 */
export function reduceSplitJob(job: SplitJob, event: SplitEvent, now: number): SplitJob {
  const terminal = isTerminal(job.status)
  const next = (patch: Partial<SplitJob>): SplitJob => ({ ...job, ...patch, updatedAt: now })
  switch (event.type) {
    case 'start':
      if (job.status !== 'queued') return job
      return job.uploaded ? next({ status: 'separating', progress: null, detail: 'CONSULTANDO A MUSIC AI...', error: null }) : next({ status: 'uploading', progress: null, detail: `SUBIENDO...`, error: null })
    case 'upload': {
      if (job.status !== 'uploading') return job
      const fraction = event.fraction === null ? null : Math.min(1, Math.max(0, event.fraction))
      return next({ progress: fraction === null ? null : 0.35 * fraction, detail: fraction === null ? 'SUBIENDO...' : `SUBIENDO ${Math.round(fraction * 100)} %...` })
    }
    case 'uploaded':
      if (job.status !== 'uploading') return job
      return next({ status: 'separating', uploaded: true, progress: 0.4, detail: 'SEPARANDO EN MUSIC AI...' })
    case 'remote': {
      if (job.status !== 'separating' && job.status !== 'importing') return job
      const s = event.state
      if (s.status === 'IMPORTING') {
        const total = s.total ?? 0
        const done = s.done ?? 0
        return next({ status: 'importing', progress: total > 0 ? 0.45 + 0.4 * (done / total) : 0.45, detail: event.detail })
      }
      if (s.status === 'SUCCEEDED' || s.status === 'FAILED') return job
      return next({ detail: event.detail, progress: job.progress ?? 0.4 })
    }
    case 'local-progress':
      if (job.status !== 'importing' && job.status !== 'done') return job
      return next({
        local: 'downloading',
        localError: null,
        progress: job.status === 'done' ? job.progress : event.total > 0 ? 0.85 + 0.15 * (event.done / event.total) : 0.85,
        detail: `DESCARGANDO STEMS ${event.done}/${event.total}...`,
      })
    case 'local-saved':
      if (job.status !== 'importing' && job.status !== 'done') return job
      return next({ local: 'saved', localCount: event.count, localError: null })
    case 'local-failed':
      if (job.status !== 'importing' && job.status !== 'done') return job
      return next({ local: 'failed', localError: event.message })
    case 'done':
      if (job.status !== 'separating' && job.status !== 'importing') return job
      return next({ status: 'done', progress: 1, detail: null, error: null, stemCount: event.stemCount })
    case 'fail':
      if (terminal) return job
      return next({ status: 'error', error: event.message, detail: null, remoteFailed: !!event.remote })
    case 'cancel':
      if (terminal) return job
      return next({ status: 'canceled', detail: null, error: job.uploaded ? SPLIT_CANCELED_REMOTE_NOTE : null })
    case 'retry':
      if (job.status !== 'error' && job.status !== 'canceled' && job.status !== 'interrupted') return job
      return next({
        status: 'queued',
        error: null,
        detail: null,
        progress: null,
        remoteFailed: false,
        uploaded: event.reupload ? false : job.uploaded,
        local: 'none',
        localError: null,
        stemCount: null,
        localCount: null,
      })
  }
}

/**
 * Lee el historial guardado. Defensivo: cualquier cosa rara se descarta. Lo que estaba en curso
 * queda 'interrupted' (el archivo no se guarda y la pagina que lo seguia ya no existe).
 */
export function restoreSplitJobs(raw: string | null, now: number): SplitJob[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: SplitJob[] = []
  const statuses = new Set<string>([...SPLIT_ACTIVE, ...SPLIT_TERMINAL])
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const j = item as Record<string, unknown>
    if (typeof j.id !== 'string' || typeof j.band !== 'string' || typeof j.songId !== 'string' || typeof j.status !== 'string' || !statuses.has(j.status)) continue
    const status = j.status as SplitJobStatus
    const local = j.local === 'downloading' || j.local === 'saved' || j.local === 'failed' ? j.local : 'none'
    const job: SplitJob = {
      id: j.id,
      band: j.band,
      songId: j.songId,
      songTitle: typeof j.songTitle === 'string' ? j.songTitle : 'Canción',
      fileName: typeof j.fileName === 'string' ? j.fileName : '',
      fileSize: typeof j.fileSize === 'number' && Number.isFinite(j.fileSize) ? j.fileSize : 0,
      status,
      progress: null,
      detail: null,
      error: typeof j.error === 'string' ? j.error : null,
      uploaded: j.uploaded === true,
      remoteFailed: j.remoteFailed === true,
      importLocal: j.importLocal === true,
      local: local === 'downloading' ? 'failed' : local,
      localError: local === 'downloading' ? SPLIT_INTERRUPTED_MESSAGE : typeof j.localError === 'string' ? j.localError : null,
      stemCount: typeof j.stemCount === 'number' ? j.stemCount : null,
      localCount: typeof j.localCount === 'number' ? j.localCount : null,
      createdAt: typeof j.createdAt === 'number' ? j.createdAt : now,
      updatedAt: typeof j.updatedAt === 'number' ? j.updatedAt : now,
    }
    if (isActive(status)) {
      job.status = 'interrupted'
      job.error = SPLIT_INTERRUPTED_MESSAGE
      job.updatedAt = now
    }
    out.push(job)
  }
  return out.slice(-SPLIT_HISTORY_LIMIT)
}

/** Lo que se guarda: sin progreso ni textos de fase (se recalculan) y sin archivo. */
export function serializeSplitJobs(jobs: readonly SplitJob[]): string {
  return JSON.stringify(
    jobs.slice(-SPLIT_HISTORY_LIMIT).map((j) => ({
      id: j.id,
      band: j.band,
      songId: j.songId,
      songTitle: j.songTitle,
      fileName: j.fileName,
      fileSize: j.fileSize,
      status: j.status,
      error: j.error,
      uploaded: j.uploaded,
      remoteFailed: j.remoteFailed,
      importLocal: j.importLocal,
      local: j.local,
      localError: j.localError,
      stemCount: j.stemCount,
      localCount: j.localCount,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    }))
  )
}

// ---------------------------------------------------------------------------
// Cola con la red inyectada
// ---------------------------------------------------------------------------

export interface SplitStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Dependencias de red (las reales viven en stemAnalysis.ts y stemCloud.ts). */
export interface SplitQueueDeps<Target, Manifest, Rec> {
  startSeparation(target: Target, songId: string, file: File | Blob, onUpload: (fraction: number) => void, signal: AbortSignal): Promise<unknown>
  watchSeparation(target: Target, songId: string, opts: { signal: AbortSignal; onState: (state: RemoteState) => void }): Promise<RemoteState | null>
  downloadStems(target: Target, songId: string, onProgress: (done: number, total: number) => void): Promise<{ record: Rec }>
  /** Destino de nube vigente para una banda (tras recargar no hay el de la vista). */
  resolveTarget(band: string): Target | null
  /** Texto de una fase remota (separationStatusText). */
  describe(state: RemoteState): string
  /** Mensaje para el musico a partir de un error. */
  errorMessage(err: unknown): string
  /** null si el archivo sirve; si no, el problema. */
  fileProblem(file: File | Blob & { name?: string }): string | null
  manifestOf(state: RemoteState): Manifest | null
  /** La nube de la cancion cambio (para que las vistas olviden el manifiesto viejo). */
  onCloudChanged?(band: string, songId: string, manifest: Manifest | null): void
  /** Se guardaron stems nuevos en este equipo. */
  onLocalSaved?(band: string, songId: string, record: Rec): void
  storage?: SplitStorage | null
  /** Clave del historial (por usuario); por defecto SPLIT_STORAGE_KEY. */
  storageKey?: string
  now?: () => number
  newId?: () => string
}

export interface EnqueueInput<Target> {
  band: string
  songId: string
  songTitle: string
  file: File | (Blob & { name?: string })
  target: Target
  importLocal: boolean
}

export type EnqueueResult = { ok: true; job: SplitJob } | { ok: false; message: string; job?: SplitJob }

export type RetryResult = { ok: true } | { ok: false; needsFile: boolean; message: string }

export const SPLIT_BUSY_MESSAGE = 'Ya hay una separación en curso para esta canción.'
export const SPLIT_NO_TARGET_MESSAGE = 'La nube de la banda no está disponible: inicia sesión de nube y vuelve a intentarlo.'
export const SPLIT_NEEDS_FILE_MESSAGE = 'Vuelve a elegir el audio: el archivo no se guarda al recargar la página.'

let idCounter = 0

export class SplitQueue<Target = unknown, Manifest = unknown, Rec = unknown> {
  private jobs: SplitJob[] = []
  private readonly files = new Map<string, File | (Blob & { name?: string })>()
  private readonly targets = new Map<string, Target>()
  private readonly manifests = new Map<string, Manifest | null>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly listeners = new Set<() => void>()
  private running: string | null = null
  private readonly localRuns = new Set<string>()
  private readonly deps: SplitQueueDeps<Target, Manifest, Rec>
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: SplitQueueDeps<Target, Manifest, Rec>) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? (() => `split-${this.now().toString(36)}-${(++idCounter).toString(36)}`)
    let raw: string | null
    try {
      raw = deps.storage?.getItem(deps.storageKey ?? SPLIT_STORAGE_KEY) ?? null
    } catch {
      raw = null
    }
    this.jobs = restoreSplitJobs(raw, this.now())
    // Lo restaurado como interrumpido se guarda ya: si la pagina se vuelve a cerrar, sigue asi.
    if (this.jobs.length > 0) this.persist()
  }

  // ---- lectura ----

  /** Lista de trabajos (cambia de arreglo en cada cambio: sirve para useSyncExternalStore). */
  list = (): readonly SplitJob[] => this.jobs

  get(id: string): SplitJob | null {
    return this.jobs.find((j) => j.id === id) ?? null
  }

  /** Ultimo trabajo de una cancion en una banda. */
  latestFor(band: string, songId: string): SplitJob | null {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i]
      if (j.band === band && j.songId === songId) return j
    }
    return null
  }

  activeCount(): number {
    return this.jobs.filter((j) => isActive(j.status) || j.local === 'downloading').length
  }

  manifestOf(id: string): Manifest | null {
    return this.manifests.get(id) ?? null
  }

  /** Se puede reintentar sin pedir el archivo otra vez. */
  canRetry(id: string): boolean {
    const job = this.get(id)
    if (!job || !(job.status === 'error' || job.status === 'canceled' || job.status === 'interrupted')) return false
    return (job.uploaded && !job.remoteFailed) || this.files.has(id)
  }

  /** Funcion flecha: se puede pasar tal cual a useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Aborta lo que corre sin tocar el historial (el proveedor se desmonta o cambia de usuario). */
  dispose(): void {
    for (const ctrl of this.aborts.values()) ctrl.abort()
    this.listeners.clear()
  }

  // ---- acciones ----

  enqueue(input: EnqueueInput<Target>): EnqueueResult {
    const problem = this.deps.fileProblem(input.file)
    if (problem) return { ok: false, message: problem }
    const busy = this.jobs.find((j) => j.band === input.band && j.songId === input.songId && isActive(j.status))
    if (busy) return { ok: false, message: SPLIT_BUSY_MESSAGE, job: busy }
    const now = this.now()
    const job: SplitJob = {
      id: this.newId(),
      band: input.band,
      songId: input.songId,
      songTitle: input.songTitle,
      fileName: input.file.name ?? '',
      fileSize: input.file.size,
      status: 'queued',
      progress: null,
      detail: null,
      error: null,
      uploaded: false,
      remoteFailed: false,
      importLocal: input.importLocal,
      local: 'none',
      localError: null,
      stemCount: null,
      localCount: null,
      createdAt: now,
      updatedAt: now,
    }
    this.files.set(job.id, input.file)
    this.targets.set(job.id, input.target)
    this.jobs = [...this.jobs, job]
    this.trim()
    this.emit(true)
    this.pump()
    return { ok: true, job: this.get(job.id) ?? job }
  }

  cancel(id: string): void {
    const job = this.get(id)
    if (!job || isTerminal(job.status)) return
    this.apply(id, { type: 'cancel' })
    this.aborts.get(id)?.abort()
    this.files.delete(id)
    if (this.running === id) {
      this.running = null
      this.pump()
    }
  }

  /** Reintenta un trabajo fallido, cancelado o interrumpido. `file` sirve si se perdio el original. */
  retry(id: string, file?: File | (Blob & { name?: string })): RetryResult {
    const job = this.get(id)
    if (!job || !(job.status === 'error' || job.status === 'canceled' || job.status === 'interrupted')) {
      return { ok: false, needsFile: false, message: 'Ese trabajo no se puede reintentar.' }
    }
    const busy = this.jobs.find((j) => j.id !== id && j.band === job.band && j.songId === job.songId && isActive(j.status))
    if (busy) return { ok: false, needsFile: false, message: SPLIT_BUSY_MESSAGE }
    if (file) {
      const problem = this.deps.fileProblem(file)
      if (problem) return { ok: false, needsFile: true, message: problem }
      this.files.set(id, file)
    }
    const resume = job.uploaded && !job.remoteFailed && !file
    if (!resume && !this.files.has(id)) return { ok: false, needsFile: true, message: SPLIT_NEEDS_FILE_MESSAGE }
    if (!this.targets.has(id)) {
      const target = this.deps.resolveTarget(job.band)
      if (!target) return { ok: false, needsFile: false, message: SPLIT_NO_TARGET_MESSAGE }
      this.targets.set(id, target)
    }
    this.apply(id, { type: 'retry', reupload: !resume })
    this.pump()
    return { ok: true }
  }

  /** Quita del historial un trabajo terminado. */
  dismiss(id: string): void {
    const job = this.get(id)
    if (!job || isActive(job.status) || job.local === 'downloading') return
    this.forget(id)
    this.jobs = this.jobs.filter((j) => j.id !== id)
    this.emit(true)
  }

  /** Quita del historial todos los terminados. */
  clearFinished(): void {
    const keep = this.jobs.filter((j) => isActive(j.status) || j.local === 'downloading')
    if (keep.length === this.jobs.length) return
    for (const j of this.jobs) if (!keep.includes(j)) this.forget(j.id)
    this.jobs = keep
    this.emit(true)
  }

  /** Cancela todo y borra el historial (cerrar sesion de usuario). */
  reset(): void {
    for (const ctrl of this.aborts.values()) ctrl.abort()
    this.aborts.clear()
    this.files.clear()
    this.targets.clear()
    this.manifests.clear()
    this.localRuns.clear()
    this.running = null
    this.jobs = []
    this.emit(true)
  }

  /** Baja e importa a este equipo los stems de un trabajo terminado (DESCARGAR LOS NUEVOS). */
  downloadLocal(id: string): Promise<void> {
    const job = this.get(id)
    if (!job || job.status !== 'done' || this.localRuns.has(id)) return Promise.resolve()
    let target: Target | null = this.targets.get(id) ?? null
    if (!target) {
      target = this.deps.resolveTarget(job.band)
      if (!target) {
        this.apply(id, { type: 'local-failed', message: SPLIT_NO_TARGET_MESSAGE })
        return Promise.resolve()
      }
      this.targets.set(id, target)
    }
    return this.runLocal(id, target)
  }

  // ---- interno ----

  private forget(id: string): void {
    this.files.delete(id)
    this.targets.delete(id)
    this.manifests.delete(id)
    this.aborts.delete(id)
  }

  private trim(): void {
    if (this.jobs.length <= SPLIT_HISTORY_LIMIT) return
    // Se descartan los terminados mas viejos; los activos nunca.
    const drop = new Set<string>()
    for (const j of this.jobs) {
      if (this.jobs.length - drop.size <= SPLIT_HISTORY_LIMIT) break
      if (!isActive(j.status) && j.local !== 'downloading') drop.add(j.id)
    }
    for (const id of drop) this.forget(id)
    this.jobs = this.jobs.filter((j) => !drop.has(j.id))
  }

  private apply(id: string, event: SplitEvent): SplitJob | null {
    const idx = this.jobs.findIndex((j) => j.id === id)
    if (idx < 0) return null
    const prev = this.jobs[idx]
    const next = reduceSplitJob(prev, event, this.now())
    if (next === prev) return prev
    const jobs = this.jobs.slice()
    jobs[idx] = next
    this.jobs = jobs
    // Se guarda cuando cambia algo que hay que recordar; el avance de la barra no.
    const durable = next.status !== prev.status || next.local !== prev.local || next.uploaded !== prev.uploaded || next.error !== prev.error
    this.emit(durable)
    return next
  }

  private emit(persist: boolean): void {
    if (persist) this.persist()
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch {
        // Un oyente roto no frena la cola.
      }
    }
  }

  private persist(): void {
    try {
      this.deps.storage?.setItem(this.deps.storageKey ?? SPLIT_STORAGE_KEY, serializeSplitJobs(this.jobs))
    } catch {
      // Sin almacenamiento (modo privado, cuota): la cola sigue, solo no se recuerda al recargar.
    }
  }

  private pump(): void {
    if (this.running !== null) return
    const nextJob = this.jobs.find((j) => j.status === 'queued')
    if (!nextJob) return
    this.running = nextJob.id
    void this.run(nextJob.id).finally(() => {
      if (this.running === nextJob.id) this.running = null
      this.pump()
    })
  }

  private alive(id: string, ctrl: AbortController): boolean {
    return !ctrl.signal.aborted && this.get(id) !== null && !isTerminal((this.get(id) as SplitJob).status)
  }

  private async run(id: string): Promise<void> {
    const job = this.get(id)
    if (!job) return
    let target: Target | null = this.targets.get(id) ?? null
    if (!target) {
      target = this.deps.resolveTarget(job.band)
      if (target) this.targets.set(id, target)
    }
    if (!target) {
      this.apply(id, { type: 'fail', message: SPLIT_NO_TARGET_MESSAGE })
      return
    }
    const ctrl = new AbortController()
    this.aborts.set(id, ctrl)
    const started = this.apply(id, { type: 'start' })
    try {
      if (started && started.status === 'uploading') {
        const file = this.files.get(id)
        if (!file) {
          this.apply(id, { type: 'fail', message: SPLIT_NEEDS_FILE_MESSAGE })
          return
        }
        await this.deps.startSeparation(
          target,
          job.songId,
          file,
          (fraction) => {
            if (this.alive(id, ctrl)) this.apply(id, { type: 'upload', fraction })
          },
          ctrl.signal
        )
        if (!this.alive(id, ctrl)) return
        // El Worker ya tiene el audio: el archivo no hace falta para seguir.
        this.files.delete(id)
        this.apply(id, { type: 'uploaded' })
      }
      const final = await this.deps.watchSeparation(target, job.songId, {
        signal: ctrl.signal,
        onState: (state) => {
          if (this.alive(id, ctrl)) this.apply(id, { type: 'remote', state, detail: this.deps.describe(state) })
        },
      })
      if (!final || !this.alive(id, ctrl)) return
      if (final.status === 'FAILED') {
        this.apply(id, { type: 'fail', message: final.error || 'La separación falló.', remote: true })
        return
      }
      const manifest = this.deps.manifestOf(final)
      this.manifests.set(id, manifest)
      try {
        this.deps.onCloudChanged?.(job.band, job.songId, manifest)
      } catch {
        // Un aviso a las vistas que falla no tumba el trabajo.
      }
      const stemCount = final.stems ? final.stems.stems.length : null
      const current = this.get(id) as SplitJob
      if (current.importLocal) {
        // Importar a este equipo es parte del trabajo: 'importing' hasta guardar.
        if (current.status !== 'importing') this.apply(id, { type: 'remote', state: { status: 'IMPORTING', done: 0, total: 0 }, detail: 'DESCARGANDO STEMS...' })
        await this.runLocal(id, target, ctrl)
        if (!this.alive(id, ctrl)) return
      }
      this.apply(id, { type: 'done', stemCount })
    } catch (err) {
      if (this.alive(id, ctrl)) this.apply(id, { type: 'fail', message: this.deps.errorMessage(err) })
    } finally {
      this.aborts.delete(id)
    }
  }

  private async runLocal(id: string, target: Target, ctrl?: AbortController): Promise<void> {
    const job = this.get(id)
    if (!job || this.localRuns.has(id)) return
    this.localRuns.add(id)
    this.apply(id, { type: 'local-progress', done: 0, total: job.stemCount ?? 0 })
    try {
      const { record } = await this.deps.downloadStems(target, job.songId, (done, total) => {
        if (!ctrl || !ctrl.signal.aborted) this.apply(id, { type: 'local-progress', done, total })
      })
      // Aunque se haya cancelado mientras bajaba, los stems ya quedaron guardados: se avisa igual
      // para que las vistas no muestren los viejos (el reductor ignora local-saved si se cancelo).
      if (this.get(id)) this.apply(id, { type: 'local-saved', count: countTracks(record) })
      try {
        this.deps.onLocalSaved?.(job.band, job.songId, record)
      } catch {
        // Igual que arriba: el trabajo ya termino bien.
      }
    } catch (err) {
      if (!ctrl?.signal.aborted && this.get(id)) this.apply(id, { type: 'local-failed', message: this.deps.errorMessage(err) })
    } finally {
      this.localRuns.delete(id)
    }
  }
}

function countTracks(record: unknown): number {
  if (record && typeof record === 'object' && Array.isArray((record as { tracks?: unknown }).tracks)) return (record as { tracks: unknown[] }).tracks.length
  return 0
}
