/**
 * Motor de sincronizacion local-first del workspace (una fila por usuario en Supabase).
 *
 * Modulo puro: no importa supabase-js ni toca window/localStorage directamente; todo
 * llega inyectado (adaptador de nube, almacen clave-valor, temporizadores, reloj).
 * Se prueba con `node scripts/verify-sync-logic.ts` usando adaptadores falsos.
 *
 * Garantias:
 * 1. Nunca escribe en la nube antes de que termine la descarga inicial.
 * 2. Reconcilia por updated_at: gana el lado mas reciente. Si el lado perdedor tenia
 *    cambios que el otro no vio, se guarda como respaldo local (los 3 ultimos) y se
 *    avisa al usuario.
 * 3. Escrituras con debounce (1500 ms) y condicionales: update ... where updated_at =
 *    <base conocida>. Si otro dispositivo escribio en medio, la escritura no afecta filas,
 *    se detecta el conflicto y se vuelve a reconciliar en lugar de pisar datos.
 * 4. Ignora los ecos de realtime de sus propias escrituras (client_write_id).
 * 5. Reintenta con backoff exponencial ante errores de red.
 */

export interface SyncMeta {
  /** Instante (ISO) de la ultima edicion local; null si el workspace nunca se edito aqui. */
  updatedAt: string | null
  /** updated_at de la fila en la nube (texto tal cual lo devolvio el servidor) en la ultima sincronizacion confirmada. */
  lastSyncedAt: string | null
  /** Hay ediciones locales que la nube aun no confirmo. */
  dirty: boolean
}

export interface CloudRow<T> {
  /** Datos validados; null si el contenido de la nube no tiene una forma valida. */
  data: T | null
  /** Contenido crudo, para respaldarlo aunque sea invalido. */
  raw: unknown
  /** updated_at tal cual lo devuelve el servidor. */
  updatedAt: string
  clientWriteId: string | null
}

export type CloudErrorKind = 'network' | 'auth' | 'permission' | 'schema' | 'unknown'

export interface CloudError {
  kind: CloudErrorKind
  message: string
  retryable: boolean
}

export type FetchResult<T> = { ok: true; row: CloudRow<T> | null } | { ok: false; error: CloudError }

export type WriteResult =
  | { ok: true; updatedAt: string }
  | { ok: false; conflict: true }
  | { ok: false; conflict: false; error: CloudError }

export interface RemoteHint {
  updatedAt: string | null
  clientWriteId: string | null
}

export interface CloudAdapter<T> {
  fetchRow(): Promise<FetchResult<T>>
  /** Crea la fila. Si ya existe debe devolver { ok: false, conflict: true }. */
  insertRow(data: T, updatedAt: string, clientWriteId: string): Promise<WriteResult>
  /** Actualiza solo si la fila sigue teniendo updated_at = expectedUpdatedAt; si no, conflict. */
  updateRow(data: T, updatedAt: string, clientWriteId: string, expectedUpdatedAt: string): Promise<WriteResult>
  /** Avisos de cambios remotos (realtime). Devuelve la funcion para cancelar. */
  subscribe(onHint: (hint: RemoteHint) => void): () => void
}

export interface KeyValueStore {
  get(key: string): string | null
  /** Devuelve false si no se pudo guardar (cuota llena, almacenamiento bloqueado). */
  set(key: string, value: string): boolean
}

export interface SyncBackup {
  id: string
  savedAt: string
  side: 'local' | 'cloud'
  reason: string
  data: unknown
}

export type SyncPhase = 'initial' | 'ready' | 'stopped'

export type EngineStatus =
  | { state: 'syncing'; phase: SyncPhase; detail: string }
  | { state: 'synced'; phase: SyncPhase; at: string }
  | { state: 'error'; phase: SyncPhase; detail: string; retryInMs: number | null }

export interface SyncNotice {
  id: string
  message: string
  backupId: string | null
}

export const DEFAULT_DEBOUNCE_MS = 1500
export const MAX_BACKUPS = 3
export const MAX_CONSECUTIVE_CONFLICTS = 3
const OWN_WRITE_IDS_KEPT = 20

export const syncMetaKey = (userId: string) => `bandait_sync_meta_${userId}`
export const syncBackupsKey = (userId: string) => `bandait_sync_backups_${userId}`

export function toMillis(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** JSON con claves ordenadas: jsonb reordena claves, asi que JSON.stringify directo daria falsos "distintos". */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = 1000 * 2 ** Math.max(0, Math.min(attempt, 10))
  return Math.min(30000, Math.round(base * (1 + 0.2 * random())))
}

/** Lista acotada, el mas reciente primero. */
export function pushBackup(list: SyncBackup[], backup: SyncBackup, max = MAX_BACKUPS): SyncBackup[] {
  return [backup, ...list].slice(0, max)
}

export type ReconcileDecision =
  | { action: 'in_sync' }
  | { action: 'adopt_cloud'; backupLocal: boolean; reason: 'local_clean' | 'conflict_cloud_newer' }
  | { action: 'push_local'; backupCloud: boolean; reason: 'no_cloud_row' | 'cloud_invalid' | 'cloud_unchanged' | 'conflict_local_newer' }

/**
 * Decide que hacer con la copia local frente a la fila de la nube.
 * - Sin fila en la nube: se sube la local.
 * - Fila con contenido invalido: se respalda y se sube la local.
 * - Mismo contenido: en sincronia.
 * - Local sin cambios pendientes: se adopta la nube (no hay nada local que perder).
 * - Local con cambios y la nube no cambio desde la ultima sincronizacion: se sube la local.
 * - Ambos cambiaron: gana el updated_at mas reciente (empate: gana la nube) y el
 *   perdedor se respalda.
 */
export function decideReconcile<T>(local: { data: T; meta: SyncMeta }, cloud: CloudRow<T> | null): ReconcileDecision {
  if (!cloud) return { action: 'push_local', backupCloud: false, reason: 'no_cloud_row' }
  if (cloud.data === null) return { action: 'push_local', backupCloud: true, reason: 'cloud_invalid' }
  if (stableStringify(local.data) === stableStringify(cloud.data)) return { action: 'in_sync' }
  if (!local.meta.dirty) return { action: 'adopt_cloud', backupLocal: false, reason: 'local_clean' }
  const cloudMs = toMillis(cloud.updatedAt)
  const syncedMs = toMillis(local.meta.lastSyncedAt)
  const cloudChanged = syncedMs === null || cloudMs === null || cloudMs !== syncedMs
  if (!cloudChanged) return { action: 'push_local', backupCloud: false, reason: 'cloud_unchanged' }
  const localMs = toMillis(local.meta.updatedAt) ?? 0
  if (cloudMs === null || localMs > cloudMs) {
    return { action: 'push_local', backupCloud: true, reason: 'conflict_local_newer' }
  }
  return { action: 'adopt_cloud', backupLocal: true, reason: 'conflict_cloud_newer' }
}

export function parseSyncMeta(raw: string | null): SyncMeta {
  const empty: SyncMeta = { updatedAt: null, lastSyncedAt: null, dirty: false }
  if (!raw) return empty
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return empty
    const o = v as Record<string, unknown>
    return {
      updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
      lastSyncedAt: typeof o.lastSyncedAt === 'string' ? o.lastSyncedAt : null,
      dirty: o.dirty === true,
    }
  } catch {
    return empty
  }
}

export function parseBackups(raw: string | null): SyncBackup[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter(
      (b): b is SyncBackup =>
        !!b && typeof b === 'object' && typeof (b as SyncBackup).id === 'string' && typeof (b as SyncBackup).savedAt === 'string'
    )
  } catch {
    return []
  }
}

const NOTICE_TEXT: Record<string, string> = {
  conflict_cloud_newer:
    'Conflicto resuelto: la versión de la nube era más reciente y reemplazó los cambios de este navegador que no se habían subido. Esos cambios quedaron en un respaldo local (se guardan los 3 últimos).',
  conflict_local_newer:
    'Conflicto resuelto: los cambios de este navegador eran más recientes y reemplazaron la versión de la nube. La versión anterior de la nube quedó en un respaldo local (se guardan los 3 últimos).',
  cloud_invalid:
    'La copia de la nube tenía un formato inválido: se guardó en un respaldo local y se reemplazó por la de este navegador.',
}

export interface SyncEngineOptions<T> {
  userId: string
  adapter: CloudAdapter<T>
  store: KeyValueStore
  /** Copia local actual (la del navegador o una recien creada). */
  initialLocal: T
  /** El motor adopto datos de la nube: reflejarlos en la UI SIN tratarlos como edicion local. */
  onApplyRemote: (data: T) => void
  onStatus: (status: EngineStatus) => void
  onNotice?: (notice: SyncNotice) => void
  onBackupsChanged?: (backups: SyncBackup[]) => void
  debounceMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  newId?: () => string
  random?: () => number
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export class WorkspaceSyncEngine<T> {
  private readonly userId: string
  private readonly adapter: CloudAdapter<T>
  private readonly store: KeyValueStore
  private readonly onApplyRemote: (data: T) => void
  private readonly onStatus: (status: EngineStatus) => void
  private readonly onNotice: (notice: SyncNotice) => void
  private readonly onBackupsChanged: (backups: SyncBackup[]) => void
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly newId: () => string
  private readonly random: () => number

  private phase: SyncPhase = 'initial'
  private localData: T
  private meta: SyncMeta
  private rowExists = false
  /** updated_at de la nube tal como lo vimos por ultima vez; base de la escritura condicional. */
  private cloudBase: string | null = null
  private revision = 0
  private writeInFlight: Promise<void> | null = null
  private fetchInFlight: Promise<void> | null = null
  private refetchRequested = false
  private debounceHandle: unknown = null
  private retryHandle: unknown = null
  private retryAttempt = 0
  private conflicts = 0
  private ownWriteIds: string[] = []
  private unsubscribe: (() => void) | null = null

  constructor(options: SyncEngineOptions<T>) {
    this.userId = options.userId
    this.adapter = options.adapter
    this.store = options.store
    this.onApplyRemote = options.onApplyRemote
    this.onStatus = options.onStatus
    this.onNotice = options.onNotice ?? (() => {})
    this.onBackupsChanged = options.onBackupsChanged ?? (() => {})
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.now = options.now ?? (() => Date.now())
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.newId = options.newId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
    this.random = options.random ?? Math.random
    this.localData = options.initialLocal
    this.meta = parseSyncMeta(this.store.get(syncMetaKey(this.userId)))
  }

  /** Suscribe a realtime y lanza la descarga inicial. No escribe nada hasta que termine. */
  start(): void {
    if (this.phase === 'stopped') return
    try {
      this.unsubscribe = this.adapter.subscribe((hint) => this.handleRemoteHint(hint))
    } catch {
      this.unsubscribe = null
    }
    this.emit({ state: 'syncing', phase: 'initial', detail: 'Descargando el workspace de la nube...' })
    void this.fetchAndReconcile()
  }

  stop(): void {
    this.phase = 'stopped'
    this.clearDebounce()
    this.clearRetry()
    if (this.unsubscribe) {
      try {
        this.unsubscribe()
      } catch {
        // la cancelacion de realtime no debe romper el cierre de sesion
      }
      this.unsubscribe = null
    }
  }

  getPhase(): SyncPhase {
    return this.phase
  }

  getMeta(): SyncMeta {
    return { ...this.meta }
  }

  getBackups(): SyncBackup[] {
    return parseBackups(this.store.get(syncBackupsKey(this.userId)))
  }

  /** Edicion local hecha por el usuario. Se persiste la marca y se agenda la subida con debounce. */
  notifyLocalChange(data: T): void {
    if (this.phase === 'stopped') return
    this.localData = data
    this.revision += 1
    const prevMs = toMillis(this.meta.updatedAt) ?? 0
    this.meta = { ...this.meta, updatedAt: new Date(Math.max(this.now(), prevMs + 1)).toISOString(), dirty: true }
    this.saveMeta()
    if (this.phase !== 'ready') {
      this.emit({
        state: 'syncing',
        phase: this.phase,
        detail: 'Cambios guardados en este navegador; se subirán cuando termine la descarga inicial.',
      })
      return
    }
    this.scheduleWrite()
  }

  /** Reintento manual (boton) o al recuperar la red. */
  retryNow(): void {
    if (this.phase === 'stopped') return
    this.clearRetry()
    this.retryAttempt = 0
    this.conflicts = 0
    if (this.phase === 'ready' && this.meta.dirty) {
      void this.flushNow()
    } else {
      void this.fetchAndReconcile()
    }
  }

  /** Subida inmediata de lo pendiente (antes de cerrar sesion). Devuelve true si no queda nada sin subir. */
  async flush(timeoutMs = 3000): Promise<boolean> {
    if (this.phase !== 'ready' || !this.meta.dirty) return !this.meta.dirty
    this.clearDebounce()
    await Promise.race([
      this.flushNow(),
      new Promise<void>((resolve) => {
        this.setTimer(resolve, timeoutMs)
      }),
    ])
    return !this.meta.dirty
  }

  // ---------------------------------------------------------------------------

  private emit(status: EngineStatus): void {
    try {
      this.onStatus(status)
    } catch {
      // la UI no debe poder romper el motor
    }
  }

  private emitSynced(): void {
    this.emit({ state: 'synced', phase: this.phase, at: new Date(this.now()).toISOString() })
  }

  private saveMeta(): void {
    this.store.set(syncMetaKey(this.userId), JSON.stringify(this.meta))
  }

  private clearDebounce(): void {
    if (this.debounceHandle !== null) {
      this.clearTimer(this.debounceHandle)
      this.debounceHandle = null
    }
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) {
      this.clearTimer(this.retryHandle)
      this.retryHandle = null
    }
  }

  private defer(fn: () => void): void {
    this.setTimer(fn, 0)
  }

  private rememberWriteId(id: string): void {
    this.ownWriteIds = [id, ...this.ownWriteIds].slice(0, OWN_WRITE_IDS_KEPT)
  }

  private scheduleWrite(): void {
    this.clearDebounce()
    this.emit({ state: 'syncing', phase: this.phase, detail: 'Cambios pendientes de subir a la nube...' })
    this.debounceHandle = this.setTimer(() => {
      this.debounceHandle = null
      void this.flushNow()
    }, this.debounceMs)
  }

  private handleError(error: CloudError, retry: () => void): void {
    if (error.retryable) {
      const delay = backoffDelay(this.retryAttempt, this.random)
      this.retryAttempt += 1
      this.emit({
        state: 'error',
        phase: this.phase,
        detail: `${error.message} Reintento automático en ${Math.ceil(delay / 1000)} s.`,
        retryInMs: delay,
      })
      this.clearRetry()
      this.retryHandle = this.setTimer(() => {
        this.retryHandle = null
        retry()
      }, delay)
    } else {
      this.emit({ state: 'error', phase: this.phase, detail: error.message, retryInMs: null })
    }
  }

  private saveBackup(side: 'local' | 'cloud', data: unknown, reason: string): string | null {
    const backup: SyncBackup = {
      id: this.newId(),
      savedAt: new Date(this.now()).toISOString(),
      side,
      reason,
      data,
    }
    const key = syncBackupsKey(this.userId)
    let list = pushBackup(this.getBackups(), backup)
    let ok = this.store.set(key, JSON.stringify(list))
    if (!ok) {
      // Cuota llena: conservar al menos el respaldo nuevo.
      list = [backup]
      ok = this.store.set(key, JSON.stringify(list))
    }
    if (!ok) return null
    this.onBackupsChanged(list)
    return backup.id
  }

  private handleRemoteHint(hint: RemoteHint): void {
    if (this.phase === 'stopped') return
    if (hint.clientWriteId && this.ownWriteIds.includes(hint.clientWriteId)) return // eco de una escritura propia
    const hintMs = toMillis(hint.updatedAt)
    const baseMs = toMillis(this.cloudBase)
    if (hintMs !== null && baseMs !== null && hintMs <= baseMs) return // ya visto
    if (this.phase === 'initial' || this.fetchInFlight || this.writeInFlight) {
      this.refetchRequested = true
      return
    }
    void this.fetchAndReconcile()
  }

  private fetchAndReconcile(): Promise<void> {
    if (this.phase === 'stopped') return Promise.resolve()
    if (this.fetchInFlight) {
      this.refetchRequested = true
      return this.fetchInFlight
    }
    if (this.writeInFlight) {
      this.refetchRequested = true
      return this.writeInFlight
    }
    this.clearRetry()
    this.fetchInFlight = this.performFetch().finally(() => {
      this.fetchInFlight = null
    })
    return this.fetchInFlight
  }

  private async performFetch(): Promise<void> {
    this.refetchRequested = false
    if (this.phase === 'ready') {
      this.emit({ state: 'syncing', phase: this.phase, detail: 'Comprobando la versión de la nube...' })
    }
    let res: FetchResult<T>
    try {
      res = await this.adapter.fetchRow()
    } catch (err) {
      res = { ok: false, error: { kind: 'unknown', message: errorMessage(err), retryable: true } }
    }
    if (this.phase === 'stopped') return
    if (!res.ok) {
      this.handleError(res.error, () => void this.fetchAndReconcile())
      return
    }
    this.retryAttempt = 0
    if (!this.applyReconcile(res.row)) return
    this.phase = 'ready'
    if (this.refetchRequested) {
      this.refetchRequested = false
      this.defer(() => void this.fetchAndReconcile())
      return
    }
    if (this.meta.dirty) {
      this.defer(() => void this.flushNow())
    } else {
      this.emitSynced()
    }
  }

  /** Aplica la decision de reconciliacion. Devuelve false si se detuvo por no poder respaldar. */
  private applyReconcile(row: CloudRow<T> | null): boolean {
    const decision = decideReconcile({ data: this.localData, meta: this.meta }, row)
    if (decision.action === 'in_sync') {
      if (row) {
        this.rowExists = true
        this.cloudBase = row.updatedAt
        this.meta = { ...this.meta, lastSyncedAt: row.updatedAt, dirty: false }
        this.saveMeta()
      }
      return true
    }
    if (decision.action === 'adopt_cloud') {
      if (!row || row.data === null) return true
      let backupId: string | null = null
      if (decision.backupLocal) {
        backupId = this.saveBackup('local', this.localData, decision.reason)
        if (!backupId) return this.backupFailed()
      }
      this.localData = row.data
      this.revision += 1
      this.meta = { updatedAt: row.updatedAt, lastSyncedAt: row.updatedAt, dirty: false }
      this.saveMeta()
      this.rowExists = true
      this.cloudBase = row.updatedAt
      try {
        this.onApplyRemote(row.data)
      } catch {
        // la UI no debe poder romper el motor
      }
      if (backupId) this.notify(decision.reason, backupId)
      return true
    }
    // push_local
    let backupId: string | null = null
    if (decision.backupCloud && row) {
      backupId = this.saveBackup('cloud', row.raw, decision.reason)
      if (!backupId) return this.backupFailed()
    }
    this.rowExists = row !== null
    this.cloudBase = row ? row.updatedAt : null
    this.meta = { ...this.meta, dirty: true }
    this.saveMeta()
    if (backupId) this.notify(decision.reason, backupId)
    return true
  }

  private backupFailed(): boolean {
    this.emit({
      state: 'error',
      phase: this.phase,
      detail:
        'No se pudo guardar el respaldo local (almacenamiento lleno o bloqueado). La sincronización se detuvo para no perder datos. Exporta el JSON y libera espacio.',
      retryInMs: null,
    })
    return false
  }

  private notify(reason: string, backupId: string): void {
    try {
      this.onNotice({ id: this.newId(), message: NOTICE_TEXT[reason] ?? 'Se guardó un respaldo local.', backupId })
    } catch {
      // ignorar
    }
  }

  private flushNow(): Promise<void> {
    if (this.phase !== 'ready') return Promise.resolve()
    if (this.writeInFlight) return this.writeInFlight
    if (this.fetchInFlight) return this.fetchInFlight
    if (!this.meta.dirty) {
      this.emitSynced()
      return Promise.resolve()
    }
    this.clearDebounce()
    this.clearRetry()
    this.writeInFlight = this.performWrite().finally(() => {
      this.writeInFlight = null
    })
    return this.writeInFlight
  }

  private async performWrite(): Promise<void> {
    const revisionAtStart = this.revision
    const data = this.localData
    const baseMs = toMillis(this.cloudBase)
    const editMs = toMillis(this.meta.updatedAt) ?? this.now()
    // updated_at estrictamente creciente respecto de la base, aunque el reloj local este atrasado.
    const updatedAt = new Date(Math.max(editMs, baseMs !== null ? baseMs + 1 : 0)).toISOString()
    const writeId = this.newId()
    this.rememberWriteId(writeId)
    this.emit({ state: 'syncing', phase: this.phase, detail: 'Subiendo cambios a la nube...' })

    let result: WriteResult
    try {
      result =
        this.rowExists && this.cloudBase
          ? await this.adapter.updateRow(data, updatedAt, writeId, this.cloudBase)
          : await this.adapter.insertRow(data, updatedAt, writeId)
    } catch (err) {
      result = { ok: false, conflict: false, error: { kind: 'unknown', message: errorMessage(err), retryable: true } }
    }
    if (this.phase === 'stopped') return

    if (result.ok) {
      this.retryAttempt = 0
      this.conflicts = 0
      this.rowExists = true
      this.cloudBase = result.updatedAt
      const unchangedDuringWrite = this.revision === revisionAtStart
      this.meta = { ...this.meta, lastSyncedAt: result.updatedAt, dirty: !unchangedDuringWrite }
      this.saveMeta()
      if (this.refetchRequested) {
        this.refetchRequested = false
        this.defer(() => void this.fetchAndReconcile())
      } else if (this.meta.dirty) {
        this.scheduleWrite()
      } else {
        this.emitSynced()
      }
      return
    }

    if (result.conflict) {
      this.conflicts += 1
      if (this.conflicts > MAX_CONSECUTIVE_CONFLICTS) {
        this.emit({
          state: 'error',
          phase: this.phase,
          detail: 'Conflicto persistente con escrituras de otro dispositivo. Pulsa REINTENTAR.',
          retryInMs: null,
        })
        return
      }
      this.defer(() => void this.fetchAndReconcile())
      return
    }

    this.handleError(result.error, () => void this.flushNow())
  }
}
