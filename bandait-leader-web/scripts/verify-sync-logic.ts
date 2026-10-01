/**
 * Verificacion de la logica pura del Hub, sin framework de pruebas.
 *   node scripts/verify-sync-logic.ts      (Node >= 22.18; en 22.6-22.17 agregar --experimental-strip-types)
 *
 * Cubre: motor de sincronizacion (descarga inicial antes de escribir, reconciliacion por
 * updated_at con respaldo acotado, debounce, ecos de realtime, escritura condicional,
 * reintentos con backoff), guardia de roles, rechazo de service_role, ids legacy y la
 * URL de retorno del login. Usa un adaptador de nube y temporizadores falsos.
 */
import assert from 'node:assert/strict'
import {
  WorkspaceSyncEngine,
  backoffDelay,
  decideReconcile,
  pushBackup,
  stableStringify,
  type CloudAdapter,
  type CloudError,
  type EngineStatus,
  type KeyValueStore,
  type RemoteHint,
  type SyncBackup,
  type SyncNotice,
  type WriteResult,
} from '../src/services/workspaceSync.ts'
import { checkRoleChange, roleEditBlockReason } from '../src/services/roles.ts'
import { checkSupabasePublicKey, checkSupabaseUrl, decodeJwtPayload } from '../src/services/jwt.ts'
import { computeAuthRedirectUrl, legacyEmailProfileId, localProfileId } from '../src/services/identity.ts'

type Ws = { label: string; n: number }

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`)
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r))
}

class FakeClock {
  now = Date.parse('2026-09-30T12:00:00.000Z')
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }
  clearTimer = (h: unknown): void => {
    this.timers.delete(h as number)
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      await settle()
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.now = Math.max(this.now, due[1].at)
      due[1].fn()
    }
    this.now = target
    await settle()
  }
}

const netError: CloudError = { kind: 'network', message: 'Sin conexion con Supabase.', retryable: true }

class FakeCloud implements CloudAdapter<Ws> {
  row: { data: Ws; updatedAt: string; clientWriteId: string | null } | null = null
  calls: string[] = []
  gate: Promise<void> | null = null
  failures: Array<{ op: 'fetch' | 'insert' | 'update'; error: CloudError }> = []
  echoOwnWrites = true
  private listener: ((h: RemoteHint) => void) | null = null

  writes() {
    return this.calls.filter((c) => c === 'insert' || c === 'update').length
  }
  fetches() {
    return this.calls.filter((c) => c === 'fetch').length
  }
  private takeFailure(op: 'fetch' | 'insert' | 'update') {
    const i = this.failures.findIndex((f) => f.op === op)
    if (i === -1) return null
    return this.failures.splice(i, 1)[0].error
  }
  async fetchRow() {
    this.calls.push('fetch')
    if (this.gate) await this.gate
    const err = this.takeFailure('fetch')
    if (err) return { ok: false as const, error: err }
    if (!this.row) return { ok: true as const, row: null }
    return {
      ok: true as const,
      row: { data: structuredClone(this.row.data), raw: structuredClone(this.row.data), updatedAt: this.row.updatedAt, clientWriteId: this.row.clientWriteId },
    }
  }
  async insertRow(data: Ws, updatedAt: string, id: string): Promise<WriteResult> {
    this.calls.push('insert')
    const err = this.takeFailure('insert')
    if (err) return { ok: false, conflict: false, error: err }
    if (this.row) return { ok: false, conflict: true }
    this.row = { data: structuredClone(data), updatedAt, clientWriteId: id }
    this.echo(updatedAt, id)
    return { ok: true, updatedAt }
  }
  async updateRow(data: Ws, updatedAt: string, id: string, expected: string): Promise<WriteResult> {
    this.calls.push('update')
    const err = this.takeFailure('update')
    if (err) return { ok: false, conflict: false, error: err }
    if (!this.row || this.row.updatedAt !== expected) return { ok: false, conflict: true }
    this.row = { data: structuredClone(data), updatedAt, clientWriteId: id }
    this.echo(updatedAt, id)
    return { ok: true, updatedAt }
  }
  subscribe(cb: (h: RemoteHint) => void) {
    this.listener = cb
    return () => {
      this.listener = null
    }
  }
  /** El eco realtime llega ANTES que la respuesta HTTP de la escritura (caso posible en la practica). */
  private echo(updatedAt: string, id: string) {
    if (this.echoOwnWrites && this.listener) this.listener({ updatedAt, clientWriteId: id })
  }
  /** Escritura de OTRO dispositivo. notify=false simula un evento realtime perdido. */
  remoteWrite(data: Ws, updatedAt: string, notify = true) {
    this.row = { data: structuredClone(data), updatedAt, clientWriteId: 'other-device' }
    if (notify && this.listener) this.listener({ updatedAt, clientWriteId: 'other-device' })
  }
}

class MemStore implements KeyValueStore {
  map = new Map<string, string>()
  get(k: string) {
    return this.map.get(k) ?? null
  }
  set(k: string, v: string) {
    this.map.set(k, v)
    return true
  }
}

function makeEngine(opts: { cloud: FakeCloud; clock: FakeClock; local: Ws; store?: MemStore }) {
  const applied: Ws[] = []
  const statuses: EngineStatus[] = []
  const notices: SyncNotice[] = []
  let idSeq = 0
  const store = opts.store ?? new MemStore()
  const engine = new WorkspaceSyncEngine<Ws>({
    userId: 'u1',
    adapter: opts.cloud,
    store,
    initialLocal: opts.local,
    onApplyRemote: (d) => applied.push(d),
    onStatus: (s) => statuses.push(s),
    onNotice: (n) => notices.push(n),
    now: () => opts.clock.now,
    setTimer: opts.clock.setTimer,
    clearTimer: opts.clock.clearTimer,
    newId: () => `id-${++idSeq}`,
    random: () => 0,
  })
  const last = () => statuses[statuses.length - 1]
  return { engine, applied, statuses, notices, store, last }
}

async function main() {
  console.log('Motor de sincronizacion')

  await check('cuenta nueva sin ediciones: adopta la nube y NO escribe', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    cloud.row = { data: { label: 'nube', n: 7 }, updatedAt: '2026-09-29T10:00:00.000+00:00', clientWriteId: 'x' }
    const t = makeEngine({ cloud, clock, local: { label: 'semilla', n: 0 } })
    t.engine.start()
    await clock.advance(10000)
    assert.equal(cloud.writes(), 0)
    assert.deepEqual(t.applied, [{ label: 'nube', n: 7 }])
    assert.equal(t.last().state, 'synced')
    assert.equal(t.engine.getBackups().length, 0)
  })

  await check('nunca escribe antes de que termine la descarga inicial', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    cloud.row = { data: { label: 'nube', n: 1 }, updatedAt: '2026-09-29T10:00:00.000+00:00', clientWriteId: 'x' }
    let release = () => {}
    cloud.gate = new Promise<void>((r) => (release = r))
    const t = makeEngine({ cloud, clock, local: { label: 'semilla', n: 0 } })
    t.engine.start()
    t.engine.notifyLocalChange({ label: 'offline', n: 2 })
    t.engine.notifyLocalChange({ label: 'offline', n: 3 })
    await clock.advance(20000)
    assert.equal(cloud.writes(), 0, 'escribio antes de terminar el fetch')
    assert.equal(t.last().phase, 'initial')
    cloud.gate = null
    release()
    await clock.advance(100)
    // local editado despues del updated_at de la nube: gana local, la nube se respalda
    assert.equal(cloud.writes(), 1)
    assert.deepEqual(cloud.row?.data, { label: 'offline', n: 3 })
    const backups = t.engine.getBackups()
    assert.equal(backups.length, 1)
    assert.equal(backups[0].side, 'cloud')
    assert.deepEqual(backups[0].data, { label: 'nube', n: 1 })
    assert.equal(t.notices.length, 1)
  })

  await check('debounce: 5 cambios seguidos producen 1 sola escritura 1500 ms despues del ultimo', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(100)
    assert.equal(cloud.writes(), 1, 'sin fila en la nube se sube la copia local')
    for (let i = 1; i <= 5; i++) {
      t.engine.notifyLocalChange({ label: 'a', n: i })
      await clock.advance(300)
    }
    assert.equal(cloud.writes(), 1, 'escribio antes de que pasara el debounce')
    await clock.advance(1199)
    assert.equal(cloud.writes(), 1)
    await clock.advance(2)
    assert.equal(cloud.writes(), 2)
    assert.deepEqual(cloud.row?.data, { label: 'a', n: 5 })
    assert.equal(t.last().state, 'synced')
  })

  await check('ignora el eco realtime de su propia escritura (sin bucle)', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(100)
    const fetchesBefore = cloud.fetches()
    t.engine.notifyLocalChange({ label: 'a', n: 1 })
    await clock.advance(5000)
    assert.equal(cloud.writes(), 2)
    assert.equal(cloud.fetches(), fetchesBefore, 'el eco provoco una descarga')
    await clock.advance(20000)
    assert.equal(cloud.writes(), 2, 'el eco provoco otra escritura')
    assert.equal(t.applied.length, 0)
  })

  await check('cambio de otro dispositivo con copia local limpia: se adopta sin volver a escribir', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(100)
    const writes = cloud.writes()
    cloud.remoteWrite({ label: 'telefono', n: 9 }, new Date(clock.now + 1000).toISOString())
    await clock.advance(20000)
    assert.deepEqual(t.applied[t.applied.length - 1], { label: 'telefono', n: 9 })
    assert.equal(cloud.writes(), writes)
    assert.equal(t.engine.getBackups().length, 0)
  })

  await check('conflicto con la nube mas reciente: gana la nube y se respalda lo local', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(100)
    const writes = cloud.writes()
    t.engine.notifyLocalChange({ label: 'laptop', n: 1 })
    cloud.remoteWrite({ label: 'telefono', n: 2 }, new Date(clock.now + 10000).toISOString())
    await clock.advance(5000)
    assert.equal(cloud.writes(), writes, 'piso la version mas reciente de la nube')
    assert.deepEqual(t.applied[t.applied.length - 1], { label: 'telefono', n: 2 })
    const b = t.engine.getBackups()
    assert.equal(b.length, 1)
    assert.equal(b[0].side, 'local')
    assert.deepEqual(b[0].data, { label: 'laptop', n: 1 })
    assert.equal(t.notices.length, 1)
  })

  await check('escritura condicional: si otro dispositivo escribio sin aviso, no lo pisa a ciegas', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(100)
    // otro dispositivo escribe ANTES de la edicion local y el evento realtime se pierde
    cloud.remoteWrite({ label: 'telefono', n: 5 }, new Date(clock.now + 10).toISOString(), false)
    await clock.advance(50)
    t.engine.notifyLocalChange({ label: 'laptop', n: 6 })
    await clock.advance(5000)
    // update condicional -> conflicto -> descarga -> local mas reciente: sube y respalda la nube
    assert.ok(cloud.calls.filter((c) => c === 'fetch').length >= 2, 'no volvio a descargar tras el conflicto')
    assert.deepEqual(cloud.row?.data, { label: 'laptop', n: 6 })
    const b = t.engine.getBackups()
    assert.equal(b[0].side, 'cloud')
    assert.deepEqual(b[0].data, { label: 'telefono', n: 5 })
    assert.equal(t.last().state, 'synced')
  })

  await check('error de red al escribir: reintenta con backoff y termina sincronizado', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(100)
    cloud.failures.push({ op: 'update', error: netError }, { op: 'update', error: netError })
    t.engine.notifyLocalChange({ label: 'a', n: 1 })
    await clock.advance(1500)
    const errors = t.statuses.filter((s) => s.state === 'error')
    assert.equal(errors.length, 1)
    assert.equal(errors[0].state === 'error' && errors[0].retryInMs, 1000)
    await clock.advance(1000)
    const errors2 = t.statuses.filter((s) => s.state === 'error')
    assert.equal(errors2.length, 2)
    assert.equal(errors2[1].state === 'error' && errors2[1].retryInMs, 2000)
    await clock.advance(2000)
    assert.deepEqual(cloud.row?.data, { label: 'a', n: 1 })
    assert.equal(t.last().state, 'synced')
  })

  await check('error de red en la descarga inicial: reintenta y no escribe mientras falla, aunque haya ediciones', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    cloud.row = { data: { label: 'nube', n: 1 }, updatedAt: '2026-09-29T10:00:00.000+00:00', clientWriteId: 'x' }
    cloud.failures.push({ op: 'fetch', error: netError }, { op: 'fetch', error: netError }, { op: 'fetch', error: netError })
    const t = makeEngine({ cloud, clock, local: { label: 'semilla', n: 0 } })
    t.engine.start()
    await clock.advance(1500)
    // edicion mientras la descarga inicial esta fallando: debe quedar en espera
    t.engine.notifyLocalChange({ label: 'offline', n: 2 })
    await clock.advance(1500 + 3000)
    assert.equal(cloud.writes(), 0, 'escribio mientras la descarga inicial fallaba')
    assert.equal(t.last().state, 'error')
    await clock.advance(4000)
    // la edicion es posterior al updated_at de la nube: gana local y la nube se respalda
    assert.equal(cloud.writes(), 1)
    assert.deepEqual(cloud.row?.data, { label: 'offline', n: 2 })
    assert.equal(t.engine.getBackups()[0].side, 'cloud')
    assert.equal(t.last().state, 'synced')
  })

  await check('errores de permiso (RLS) no se reintentan en bucle', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    cloud.failures.push({ op: 'fetch', error: { kind: 'permission', message: 'RLS', retryable: false } })
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(120000)
    assert.equal(cloud.fetches(), 1)
    const last = t.last()
    assert.equal(last.state === 'error' && last.retryInMs, null)
  })

  await check('respaldos acotados a 3 tras varios conflictos', async () => {
    const clock = new FakeClock()
    const cloud = new FakeCloud()
    const t = makeEngine({ cloud, clock, local: { label: 'a', n: 0 } })
    t.engine.start()
    await clock.advance(100)
    for (let i = 1; i <= 4; i++) {
      t.engine.notifyLocalChange({ label: 'laptop', n: i })
      cloud.remoteWrite({ label: 'telefono', n: i * 10 }, new Date(clock.now + 60000).toISOString())
      await clock.advance(5000)
    }
    const b = t.engine.getBackups()
    assert.equal(b.length, 3)
    assert.deepEqual(b[0].data, { label: 'laptop', n: 4 }, 'el mas reciente va primero')
  })

  console.log('Reconciliacion pura')
  await check('tabla de decisiones', () => {
    const cloud = { data: { label: 'c', n: 1 }, raw: {}, updatedAt: '2026-09-30T10:00:00.000Z', clientWriteId: null }
    const local = (dirty: boolean, updatedAt: string | null, lastSyncedAt: string | null) => ({
      data: { label: 'l', n: 2 },
      meta: { dirty, updatedAt, lastSyncedAt },
    })
    assert.equal(decideReconcile(local(false, null, null), null).action, 'push_local')
    assert.deepEqual(decideReconcile(local(false, null, null), { ...cloud, data: null }), { action: 'push_local', backupCloud: true, reason: 'cloud_invalid' })
    assert.deepEqual(decideReconcile(local(false, null, null), cloud), { action: 'adopt_cloud', backupLocal: false, reason: 'local_clean' })
    assert.deepEqual(decideReconcile(local(true, '2026-09-30T11:00:00.000Z', '2026-09-30T10:00:00.000+00:00'), cloud), {
      action: 'push_local',
      backupCloud: false,
      reason: 'cloud_unchanged',
    })
    assert.deepEqual(decideReconcile(local(true, '2026-09-30T11:00:00.000Z', '2026-09-30T09:00:00.000Z'), cloud), {
      action: 'push_local',
      backupCloud: true,
      reason: 'conflict_local_newer',
    })
    assert.deepEqual(decideReconcile(local(true, '2026-09-30T09:30:00.000Z', '2026-09-30T09:00:00.000Z'), cloud), {
      action: 'adopt_cloud',
      backupLocal: true,
      reason: 'conflict_cloud_newer',
    })
    assert.deepEqual(decideReconcile({ data: { n: 1, label: 'c' }, meta: { dirty: true, updatedAt: null, lastSyncedAt: null } }, cloud), {
      action: 'in_sync',
    })
  })
  await check('stableStringify ignora el orden de claves (jsonb reordena)', () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }))
  })
  await check('pushBackup mantiene los 3 mas recientes', () => {
    let list: SyncBackup[] = []
    for (let i = 0; i < 5; i++) list = pushBackup(list, { id: `b${i}`, savedAt: '', side: 'local', reason: '', data: i })
    assert.deepEqual(
      list.map((b) => b.id),
      ['b4', 'b3', 'b2']
    )
  })
  await check('backoff exponencial acotado a 30 s', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((a) => backoffDelay(a, () => 0)), [1000, 2000, 4000, 8000, 16000, 30000, 30000])
    assert.equal(backoffDelay(2, () => 1), 4800)
  })

  console.log('Guardia de roles')
  const members = [
    { id: 'm1', bandId: 'b', userId: 'owner', name: 'O', email: '', role: 'Owner' as const, instrument: '', joinedAt: '' },
    { id: 'm2', bandId: 'b', userId: 'dir', name: 'D', email: '', role: 'MusicDirector' as const, instrument: '', joinedAt: '' },
    { id: 'm3', bandId: 'b', userId: 'mus', name: 'M', email: '', role: 'Musician' as const, instrument: '', joinedAt: '' },
  ]
  await check('solo un Owner cambia roles', () => {
    assert.equal(checkRoleChange(members, { userId: 'dir' }, 'm3', 'Substitute').ok, false)
    assert.equal(checkRoleChange(members, { userId: 'owner' }, 'm3', 'Substitute').ok, true)
    assert.equal(checkRoleChange(members, { userId: 'extrano' }, 'm3', 'Owner').ok, false)
  })
  await check('nadie cambia su propio rol (ni el Owner)', () => {
    assert.equal(checkRoleChange(members, { userId: 'owner' }, 'm1', 'Musician').reason, 'No puedes cambiar tu propio rol.')
    assert.equal(roleEditBlockReason(members, { userId: 'dir' }, 'm2'), 'Solo un Owner puede cambiar roles.')
  })
  await check('siempre queda al menos un Owner', () => {
    // Owner por ownerId de la banda sin fila de integrante, intentando degradar al unico Owner
    assert.equal(checkRoleChange(members, { userId: 'creador', bandOwnerId: 'creador' }, 'm1', 'Musician').reason, 'Debe quedar al menos un Owner en la banda.')
    const two = members.map((m) => (m.id === 'm2' ? { ...m, role: 'Owner' as const } : m))
    assert.equal(checkRoleChange(two, { userId: 'owner' }, 'm2', 'Musician').ok, true)
  })

  console.log('Claves de Supabase')
  const fakeJwt = (payload: object) =>
    `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.firma`
  await check('rechaza service_role y sb_secret_, acepta anon y publishable', () => {
    const sr = checkSupabasePublicKey(fakeJwt({ iss: 'supabase', ref: 'abc', role: 'service_role' }))
    assert.equal(sr.ok, false)
    assert.equal(!sr.ok && sr.secret, true)
    const secret = checkSupabasePublicKey('sb_secret_abc123')
    assert.equal(!secret.ok && secret.secret, true)
    assert.equal(checkSupabasePublicKey(fakeJwt({ iss: 'supabase', ref: 'abc', role: 'anon' })).ok, true)
    assert.equal(checkSupabasePublicKey('sb_publishable_abc123').ok, true)
    assert.equal(checkSupabasePublicKey(fakeJwt({ role: 'authenticated' })).ok, false)
    assert.equal(checkSupabasePublicKey('no-es-una-clave').ok, false)
    assert.equal(decodeJwtPayload(fakeJwt({ role: 'anon', nombre: 'Músico' }))?.nombre, 'Músico')
  })
  await check('URL de Supabase: https obligatorio salvo localhost', () => {
    assert.equal(checkSupabaseUrl('https://abc.supabase.co/').ok, true)
    assert.equal(checkSupabaseUrl('http://abc.supabase.co').ok, false)
    assert.equal(checkSupabaseUrl('http://localhost:54321').ok, true)
  })

  console.log('Identidad y URLs')
  await check('legacyEmailProfileId reproduce la formula antigua', () => {
    const email = '  Musico@Example.com '
    const old = `usr_google_${btoa(email.trim().toLowerCase()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}`
    assert.equal(legacyEmailProfileId(email), old)
    console.log(`       ejemplo: musico@example.com -> ${legacyEmailProfileId('musico@example.com')}`)
  })
  await check('la formula antigua colisiona por prefijo; la nueva no', () => {
    const a = 'danielcastaneda@gmail.com'
    const b = 'danielcastaneda@grupobios.co'
    assert.equal(legacyEmailProfileId(a), legacyEmailProfileId(b))
    assert.notEqual(localProfileId(a), localProfileId(b))
    assert.equal(legacyEmailProfileId('josé@ejemplo.com') !== null, true, 'Latin-1 si funcionaba')
    assert.equal(legacyEmailProfileId('用户@例子.com'), null, 'fuera de Latin-1 btoa fallaba')
  })
  await check('URL de retorno del login', () => {
    assert.equal(computeAuthRedirectUrl('https://bandait.releven.cc', '/hub/'), 'https://bandait.releven.cc/hub/')
    assert.equal(computeAuthRedirectUrl('https://bandait.releven.cc', '/hub/index.html'), 'https://bandait.releven.cc/hub/')
    assert.equal(computeAuthRedirectUrl('http://localhost:5173', '/'), 'http://localhost:5173/')
  })

  console.log(`\n${passed} ok, ${failures.length} fallas`)
  if (failures.length > 0) process.exit(1)
}

void main()
