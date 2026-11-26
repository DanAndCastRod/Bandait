/**
 * Verificacion de la logica pura del audio global y de la cola Drop & Split:
 *   node --experimental-strip-types --no-warnings scripts/verify-global-audio.ts
 *
 * Cubre src/services/globalAudioCore.ts (propiedad del reproductor por cancion, reuso al volver,
 * liberacion por ambito, exclusion mutua stems/Estudio, foto del mini reproductor a ritmo bajo) y
 * src/services/splitQueue.ts (transiciones de estado, un trabajo a la vez, cancelar, reintentar,
 * historial persistido e interrumpidos al recargar).
 *
 * Nada de esto toca la red, el navegador ni datos reales: las fuentes de audio y la red son falsas.
 */
import assert from 'node:assert/strict'
import { audioScope, GlobalAudioCore, NOW_PLAYING_TICK_MS, stemSessionKey, type AudioView, type PlayableHandle, type TimerApi } from '../src/services/globalAudioCore.ts'
import {
  reduceSplitJob,
  restoreSplitJobs,
  serializeSplitJobs,
  SPLIT_BUSY_MESSAGE,
  SPLIT_CANCELED_REMOTE_NOTE,
  SPLIT_HISTORY_LIMIT,
  SPLIT_INTERRUPTED_MESSAGE,
  SPLIT_NEEDS_FILE_MESSAGE,
  SPLIT_STORAGE_KEY,
  SplitQueue,
  type RemoteState,
  type SplitJob,
  type SplitQueueDeps,
  type SplitStorage,
} from '../src/services/splitQueue.ts'

let passed = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

// ---------------------------------------------------------------------------
// Fuentes de audio falsas
// ---------------------------------------------------------------------------

class FakeSource implements PlayableHandle {
  playing = false
  recording = false
  pos = 0
  dur = 100
  disposed = 0
  plays = 0
  pauses = 0
  stops = 0
  name: string
  where: AudioView
  private listeners = new Set<() => void>()

  constructor(name: string, where: AudioView) {
    this.name = name
    this.where = where
  }

  private emit() {
    for (const l of [...this.listeners]) l()
  }
  isPlaying() {
    return this.playing
  }
  play() {
    this.plays++
    if (this.playing) return
    this.playing = true
    this.emit()
  }
  pause() {
    this.pauses++
    if (!this.playing) return
    this.playing = false
    this.emit()
  }
  stop() {
    this.stops++
    this.pos = 0
    if (this.playing) {
      this.playing = false
      this.emit()
    }
  }
  progress() {
    return this.pos / this.dur
  }
  title() {
    return this.name
  }
  subtitle() {
    return this.where === 'studio' ? 'Estudio' : 'Stems'
  }
  view() {
    return this.where
  }
  busy() {
    return this.recording
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  listenerCount() {
    return this.listeners.size
  }
  dispose() {
    this.disposed++
    this.playing = false
  }
}

class FakeTimers implements TimerApi {
  active = new Map<number, { fn: () => void; ms: number }>()
  private next = 1
  setInterval = (fn: () => void, ms: number) => {
    const id = this.next++
    this.active.set(id, { fn, ms })
    return id
  }
  clearInterval = (id: unknown) => {
    this.active.delete(id as number)
  }
  tick() {
    for (const t of [...this.active.values()]) t.fn()
  }
}

console.log('\nAudio global (globalAudioCore.ts)')

await check('clave por cancion y pistas; ambito usuario + banda', () => {
  assert.equal(stemSessionKey('s1', ['a', 'b']), 's1:a,b')
  assert.notEqual(stemSessionKey('s1', ['a', 'b']), stemSessionKey('s1', ['a']))
  assert.equal(audioScope('u1', 'b1'), 'u1|b1')
  assert.equal(audioScope(null, undefined), 'anon|none')
})

await check('volver a la misma cancion reusa el reproductor; otra cancion libera el anterior', () => {
  const core = new GlobalAudioCore<FakeSource, FakeSource>(new FakeTimers())
  let created = 0
  const make = (name: string) => () => {
    created++
    return new FakeSource(name, 'tracks')
  }
  const first = core.acquireStem('s1:a,b', 'u|b', make('Uno'))
  assert.equal(first.reused, false)
  first.handle.play()
  first.handle.pos = 30
  // Cambiar de vista y volver: misma clave, mismo objeto, sigue sonando y en su posicion.
  const again = core.acquireStem('s1:a,b', 'u|b', make('Uno'))
  assert.equal(again.reused, true)
  assert.equal(again.handle, first.handle)
  assert.equal(again.handle.playing, true)
  assert.equal(again.handle.pos, 30)
  assert.equal(created, 1)
  // Otra cancion: el reproductor anterior se libera (una sola vez) y deja de escucharse.
  const other = core.acquireStem('s2:c', 'u|b', make('Dos'))
  assert.equal(other.reused, false)
  assert.equal(first.handle.disposed, 1)
  assert.equal(first.handle.listenerCount(), 0)
  assert.equal(core.stemHandle(), other.handle)
  // Mismas pistas pero otro ambito (otra banda o usuario): reproductor nuevo.
  const scoped = core.acquireStem('s2:c', 'u|otra', make('Dos'))
  assert.equal(scoped.reused, false)
  assert.equal(other.handle.disposed, 1)
})

await check('liberar por ambito, por clave y todo', async () => {
  const core = new GlobalAudioCore<FakeSource, FakeSource>(new FakeTimers())
  const stem = core.acquireStem('s1:a', 'u|b1', () => new FakeSource('Uno', 'tracks')).handle
  const studio = new FakeSource('Maqueta', 'studio')
  core.openStudio('t#ses1', 'u|b1', studio)
  // Una clave que no es la cargada no libera nada.
  core.releaseStem('otra:clave')
  assert.equal(stem.disposed, 0)
  // Mismo ambito: nada que liberar.
  core.releaseOutside('u|b1')
  assert.equal(stem.disposed + studio.disposed, 0)
  // Cambio de banda: se liberan los dos.
  core.releaseOutside('u|b2')
  assert.equal(stem.disposed, 1)
  assert.equal(studio.disposed, 1)
  assert.equal(core.stemHandle(), null)
  assert.equal(core.studioHandle(), null)
  assert.equal(core.nowPlaying(), null)
  // closeStudio resuelve aunque no haya sesion; releaseAll deja todo vacio.
  await core.closeStudio()
  const s2 = core.acquireStem('s1:a', 'u|b2', () => new FakeSource('Uno', 'tracks')).handle
  core.releaseAll()
  assert.equal(s2.disposed, 1)
})

await check('abrir otra sesion del Estudio cierra la anterior; cerrar explicitamente la libera', async () => {
  const core = new GlobalAudioCore<FakeSource, FakeSource>(new FakeTimers())
  const a = new FakeSource('A', 'studio')
  const b = new FakeSource('B', 'studio')
  core.openStudio('t#a', 'u|b', a)
  core.openStudio('t#a', 'u|b', a)
  assert.equal(a.disposed, 0, 'adoptar la misma sesion no la cierra')
  core.openStudio('t#b', 'u|b', b)
  assert.equal(a.disposed, 1)
  assert.equal(core.studioKey(), 't#b')
  await core.closeStudio('t#otra')
  assert.equal(b.disposed, 0, 'otra clave no cierra la abierta')
  await core.closeStudio()
  assert.equal(b.disposed, 1)
  assert.equal(core.studioHandle(), null)
})

await check('exclusion mutua: si arranca una fuente, la otra se pausa', () => {
  const core = new GlobalAudioCore<FakeSource, FakeSource>(new FakeTimers())
  const stem = core.acquireStem('s1:a', 'u|b', () => new FakeSource('Uno', 'tracks')).handle
  const studio = new FakeSource('Maqueta', 'studio')
  core.openStudio('t#1', 'u|b', studio)
  stem.play()
  assert.equal(stem.playing, true)
  studio.play()
  assert.equal(studio.playing, true)
  assert.equal(stem.playing, false, 'el Estudio pausa los stems')
  stem.play()
  assert.equal(stem.playing, true)
  assert.equal(studio.playing, false, 'los stems pausan el Estudio')
  assert.equal(core.nowPlaying()?.source, 'stems')
})

await check('exclusion mutua con el Estudio grabando: la toma no se corta', () => {
  const core = new GlobalAudioCore<FakeSource, FakeSource>(new FakeTimers())
  const stem = core.acquireStem('s1:a', 'u|b', () => new FakeSource('Uno', 'tracks')).handle
  const studio = new FakeSource('Maqueta', 'studio')
  core.openStudio('t#1', 'u|b', studio)
  studio.play()
  studio.recording = true
  stem.play()
  assert.equal(studio.playing, true, 'la toma sigue')
  assert.equal(stem.playing, false, 'los stems no arrancan sobre una toma')
  assert.equal(core.nowPlaying()?.source, 'studio')
})

await check('nowPlaying: foto estable, progreso a 4 Hz solo mientras suena', () => {
  const timers = new FakeTimers()
  const core = new GlobalAudioCore<FakeSource, FakeSource>(timers)
  let notified = 0
  core.subscribe(() => notified++)
  assert.equal(core.nowPlaying(), null)
  const stem = core.acquireStem('s1:a', 'u|b', () => new FakeSource('Luz de madrugada', 'rehearsal')).handle
  const idle = core.nowPlaying()
  assert.deepEqual(idle, { title: 'Luz de madrugada', subtitle: 'Stems', playing: false, progress: 0, source: 'stems', view: 'rehearsal' })
  assert.equal(timers.active.size, 0, 'sin sonar no hay temporizador')
  const before = notified
  core.refresh()
  assert.equal(notified, before, 'sin cambios no avisa')
  assert.equal(core.nowPlaying(), idle, 'sin cambios la foto es el mismo objeto')
  stem.play()
  assert.equal(core.nowPlaying()?.playing, true)
  assert.equal(timers.active.size, 1)
  assert.equal([...timers.active.values()][0].ms, NOW_PLAYING_TICK_MS)
  assert.ok(NOW_PLAYING_TICK_MS >= 200, 'nunca por cuadro')
  stem.pos = 25
  timers.tick()
  assert.equal(core.nowPlaying()?.progress, 0.25)
  const snap = core.nowPlaying()
  timers.tick()
  assert.equal(core.nowPlaying(), snap, 'sin avance no hay foto nueva')
  stem.pos = 25.01
  timers.tick()
  assert.equal(core.nowPlaying(), snap, 'avances menores al umbral no re-renderizan')
  stem.pause()
  assert.equal(core.nowPlaying()?.playing, false)
  assert.equal(timers.active.size, 0, 'en pausa se apaga el temporizador')
  // Progreso fuera de rango o no finito se recorta a 0..1.
  stem.pos = 500
  core.refresh()
  assert.equal(core.nowPlaying()?.progress, 1)
  stem.pos = Number.NaN
  core.refresh()
  assert.equal(core.nowPlaying()?.progress, 0)
})

await check('toggle y stop actuan sobre lo que muestra el mini reproductor, sin liberar', () => {
  const core = new GlobalAudioCore<FakeSource, FakeSource>(new FakeTimers())
  core.toggle()
  core.stop()
  const stem = core.acquireStem('s1:a', 'u|b', () => new FakeSource('Uno', 'tracks')).handle
  const studio = new FakeSource('Maqueta', 'studio')
  core.openStudio('t#1', 'u|b', studio)
  // Lo ultimo que se cargo (el Estudio) es lo que muestra si nada suena.
  assert.equal(core.nowPlaying()?.source, 'studio')
  core.toggle()
  assert.equal(studio.playing, true)
  core.toggle()
  assert.equal(studio.playing, false)
  stem.play()
  assert.equal(core.nowPlaying()?.source, 'stems')
  core.stop()
  assert.equal(stem.playing, false)
  assert.equal(stem.stops, 1)
  assert.equal(stem.disposed, 0, 'stop no libera')
  assert.equal(core.nowPlaying()?.title, 'Uno', 'sigue cargada para reanudar')
})

// ---------------------------------------------------------------------------
// Cola Drop & Split
// ---------------------------------------------------------------------------

console.log('\nCola Drop & Split (splitQueue.ts)')

function baseJob(patch: Partial<SplitJob> = {}): SplitJob {
  return {
    id: 'j1',
    band: 'me',
    songId: 'song-1',
    songTitle: 'Tema A',
    fileName: 'tema.mp3',
    fileSize: 1000,
    status: 'queued',
    progress: null,
    detail: null,
    error: null,
    uploaded: false,
    remoteFailed: false,
    importLocal: false,
    local: 'none',
    localError: null,
    stemCount: null,
    localCount: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

await check('transiciones: en cola, subiendo, separando, importando y listo', () => {
  let j = baseJob()
  j = reduceSplitJob(j, { type: 'start' }, 2)
  assert.equal(j.status, 'uploading')
  j = reduceSplitJob(j, { type: 'upload', fraction: 0.5 }, 3)
  assert.equal(j.detail, 'SUBIENDO 50 %...')
  assert.ok(j.progress !== null && Math.abs(j.progress - 0.175) < 1e-9)
  j = reduceSplitJob(j, { type: 'uploaded' }, 4)
  assert.equal(j.status, 'separating')
  assert.equal(j.uploaded, true)
  j = reduceSplitJob(j, { type: 'remote', state: { status: 'STARTED' }, detail: 'SEPARANDO EN MUSIC AI...' }, 5)
  assert.equal(j.status, 'separating')
  j = reduceSplitJob(j, { type: 'remote', state: { status: 'IMPORTING', done: 1, total: 3 }, detail: 'COPIANDO STEMS 1/3...' }, 6)
  assert.equal(j.status, 'importing')
  assert.equal(j.detail, 'COPIANDO STEMS 1/3...')
  j = reduceSplitJob(j, { type: 'done', stemCount: 3 }, 7)
  assert.equal(j.status, 'done')
  assert.equal(j.stemCount, 3)
  assert.equal(j.progress, 1)
  assert.equal(j.updatedAt, 7)
})

await check('un estado terminal no revive con avisos tardios', () => {
  const canceled = reduceSplitJob(reduceSplitJob(baseJob(), { type: 'start' }, 2), { type: 'cancel' }, 3)
  assert.equal(canceled.status, 'canceled')
  assert.equal(canceled.error, null, 'cancelar antes de subir no gasta nada')
  for (const late of [
    { type: 'upload', fraction: 0.9 },
    { type: 'uploaded' },
    { type: 'remote', state: { status: 'IMPORTING', done: 2, total: 3 }, detail: 'x' },
    { type: 'done', stemCount: 3 },
    { type: 'fail', message: 'tarde' },
    { type: 'cancel' },
  ] as const) {
    assert.equal(reduceSplitJob(canceled, late, 9), canceled, `ignora ${late.type}`)
  }
  const sep = baseJob({ status: 'separating', uploaded: true })
  assert.equal(reduceSplitJob(sep, { type: 'cancel' }, 2).error, SPLIT_CANCELED_REMOTE_NOTE, 'despues de subir avisa que Music AI puede terminar igual')
  const failed = reduceSplitJob(sep, { type: 'fail', message: 'FAILED', remote: true }, 2)
  assert.equal(failed.status, 'error')
  assert.equal(failed.remoteFailed, true)
})

await check('reintentar: vuelve a la cola, retoma la consulta o vuelve a subir', () => {
  const failedWatch = baseJob({ status: 'error', uploaded: true, error: 'red' })
  const resume = reduceSplitJob(failedWatch, { type: 'retry', reupload: false }, 2)
  assert.equal(resume.status, 'queued')
  assert.equal(resume.uploaded, true)
  assert.equal(resume.error, null)
  assert.equal(reduceSplitJob(resume, { type: 'start' }, 3).status, 'separating', 'sin volver a subir')
  const reupload = reduceSplitJob(failedWatch, { type: 'retry', reupload: true }, 2)
  assert.equal(reupload.uploaded, false)
  assert.equal(reduceSplitJob(reupload, { type: 'start' }, 3).status, 'uploading')
  assert.equal(reduceSplitJob(baseJob({ status: 'done' }), { type: 'retry', reupload: false }, 2).status, 'done', 'lo terminado bien no se reintenta')
})

await check('al recargar, lo que estaba en curso queda interrumpido; lo raro se descarta', () => {
  const saved = serializeSplitJobs([
    baseJob({ id: 'a', status: 'uploading', progress: 0.2, detail: 'SUBIENDO 20 %...' }),
    baseJob({ id: 'b', status: 'separating', uploaded: true }),
    baseJob({ id: 'c', status: 'done', stemCount: 4, local: 'downloading' }),
    baseJob({ id: 'd', status: 'error', error: 'Music AI fallo', remoteFailed: true }),
  ])
  assert.ok(!saved.includes('SUBIENDO'), 'no se guardan textos de fase')
  const restored = restoreSplitJobs(saved, 50)
  assert.deepEqual(
    restored.map((j) => [j.id, j.status]),
    [
      ['a', 'interrupted'],
      ['b', 'interrupted'],
      ['c', 'done'],
      ['d', 'error'],
    ]
  )
  assert.equal(restored[0].error, SPLIT_INTERRUPTED_MESSAGE)
  assert.equal(restored[0].progress, null)
  assert.equal(restored[1].uploaded, true, 'recuerda que el Worker ya tenia el audio')
  assert.equal(restored[2].local, 'failed', 'una descarga a medias queda fallida')
  assert.equal(restored[3].remoteFailed, true)
  assert.deepEqual(restoreSplitJobs('no es json', 1), [])
  assert.deepEqual(restoreSplitJobs('{"a":1}', 1), [])
  assert.deepEqual(restoreSplitJobs(JSON.stringify([null, 3, { id: 'x' }, { id: 'y', band: 'me', songId: 's', status: 'raro' }]), 1), [])
  const many = Array.from({ length: SPLIT_HISTORY_LIMIT + 5 }, (_, i) => baseJob({ id: `j${i}`, status: 'done' }))
  assert.equal(restoreSplitJobs(serializeSplitJobs(many), 1).length, SPLIT_HISTORY_LIMIT)
})

// ---- cola con red falsa ----

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0))
}

class MemoryStorage implements SplitStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, value)
  }
}

interface FakeNet {
  uploads: Array<{ songId: string; signal: AbortSignal; onUpload: (f: number) => void; done: Deferred<unknown> }>
  watches: Array<{ songId: string; signal: AbortSignal; onState: (s: RemoteState) => void; done: Deferred<RemoteState | null> }>
  downloads: Array<{ songId: string; onProgress: (d: number, t: number) => void; done: Deferred<{ record: { tracks: unknown[] } }> }>
  cloudChanges: Array<{ band: string; songId: string; manifest: unknown }>
  localSaved: Array<{ band: string; songId: string }>
}

function makeQueue(storage: MemoryStorage = new MemoryStorage()) {
  const net: FakeNet = { uploads: [], watches: [], downloads: [], cloudChanges: [], localSaved: [] }
  let clock = 1000
  let ids = 0
  const deps: SplitQueueDeps<{ band: string }, { stems: unknown[] }, { tracks: unknown[] }> = {
    startSeparation: (_t, songId, _file, onUpload, signal) => {
      const done = deferred<unknown>()
      signal.addEventListener('abort', () => done.reject(new Error('abortado')), { once: true })
      net.uploads.push({ songId, signal, onUpload, done })
      return done.promise
    },
    watchSeparation: (_t, songId, opts) => {
      const done = deferred<RemoteState | null>()
      opts.signal.addEventListener('abort', () => done.resolve(null), { once: true })
      net.watches.push({ songId, signal: opts.signal, onState: opts.onState, done })
      return done.promise
    },
    downloadStems: (_t, songId, onProgress) => {
      const done = deferred<{ record: { tracks: unknown[] } }>()
      net.downloads.push({ songId, onProgress, done })
      return done.promise
    },
    resolveTarget: (band) => ({ band }),
    describe: (s) => (s.status === 'IMPORTING' ? `COPIANDO STEMS ${s.done}/${s.total}...` : 'SEPARANDO EN MUSIC AI...'),
    errorMessage: (err) => (err instanceof Error ? err.message : 'fallo'),
    fileProblem: (file) => (file.size === 0 ? 'Archivo vacío.' : null),
    manifestOf: (s) => (s.status === 'SUCCEEDED' ? ((s.stems as { stems: unknown[] } | null) ?? null) : null),
    onCloudChanged: (band, songId, manifest) => net.cloudChanges.push({ band, songId, manifest }),
    onLocalSaved: (band, songId) => net.localSaved.push({ band, songId }),
    storage,
    now: () => ++clock,
    newId: () => `job-${++ids}`,
  }
  return { queue: new SplitQueue(deps), net, storage }
}

function audioFile(name = 'tema.mp3', size = 2048): Blob & { name: string } {
  return Object.assign(new Blob([new Uint8Array(size)], { type: 'audio/mpeg' }), { name })
}

const succeeded = (n: number): RemoteState => ({ status: 'SUCCEEDED', stems: { stems: Array.from({ length: n }, (_, i) => i) } })

await check('un trabajo a la vez: el segundo espera en cola y arranca al terminar el primero', async () => {
  const { queue, net } = makeQueue()
  const a = queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  const b = queue.enqueue({ band: 'me', songId: 's2', songTitle: 'Dos', file: audioFile(), target: { band: 'me' }, importLocal: false })
  assert.ok(a.ok && b.ok)
  await flush()
  assert.equal(net.uploads.length, 1)
  assert.equal(queue.get('job-1')?.status, 'uploading')
  assert.equal(queue.get('job-2')?.status, 'queued')
  assert.equal(queue.activeCount(), 2)
  net.uploads[0].onUpload(0.5)
  assert.equal(queue.get('job-1')?.detail, 'SUBIENDO 50 %...')
  net.uploads[0].done.resolve({ jobId: 'x' })
  await flush()
  assert.equal(queue.get('job-1')?.status, 'separating')
  assert.equal(net.watches.length, 1)
  net.watches[0].onState({ status: 'IMPORTING', done: 1, total: 3 })
  assert.equal(queue.get('job-1')?.status, 'importing')
  assert.equal(queue.get('job-1')?.detail, 'COPIANDO STEMS 1/3...')
  net.watches[0].done.resolve(succeeded(3))
  await flush()
  const done = queue.get('job-1') as SplitJob
  assert.equal(done.status, 'done')
  assert.equal(done.stemCount, 3)
  assert.deepEqual(net.cloudChanges, [{ band: 'me', songId: 's1', manifest: { stems: [0, 1, 2] } }])
  assert.deepEqual(queue.manifestOf('job-1'), { stems: [0, 1, 2] })
  // Ahora si arranca el segundo.
  assert.equal(net.uploads.length, 2)
  assert.equal(queue.get('job-2')?.status, 'uploading')
})

await check('no se encolan dos trabajos activos para la misma cancion; un archivo malo no entra', () => {
  const { queue } = makeQueue()
  const first = queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  assert.ok(first.ok)
  const dup = queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  assert.equal(dup.ok, false)
  assert.equal(!dup.ok && dup.message, SPLIT_BUSY_MESSAGE)
  // Misma cancion en otra banda si se puede.
  assert.ok(queue.enqueue({ band: 'otra', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'otra' }, importLocal: false }).ok)
  const bad = queue.enqueue({ band: 'me', songId: 's9', songTitle: 'Nueve', file: audioFile('x.mp3', 0), target: { band: 'me' }, importLocal: false })
  assert.equal(bad.ok, false)
  assert.equal(queue.list().length, 2)
})

await check('cancelar subiendo aborta la subida y pasa al siguiente; un aviso tardio no lo revive', async () => {
  const { queue, net } = makeQueue()
  queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  queue.enqueue({ band: 'me', songId: 's2', songTitle: 'Dos', file: audioFile(), target: { band: 'me' }, importLocal: false })
  await flush()
  const upload = net.uploads[0]
  queue.cancel('job-1')
  assert.equal(upload.signal.aborted, true, 'la subida se aborta')
  assert.equal(queue.get('job-1')?.status, 'canceled')
  upload.onUpload(0.9)
  await flush()
  assert.equal(queue.get('job-1')?.status, 'canceled')
  assert.equal(net.watches.filter((w) => w.songId === 's1').length, 0, 'no se llega a consultar a Music AI')
  assert.equal(queue.get('job-2')?.status, 'uploading', 'el siguiente arranca')
  // Cancelar en cola: nunca sube.
  queue.enqueue({ band: 'me', songId: 's3', songTitle: 'Tres', file: audioFile(), target: { band: 'me' }, importLocal: false })
  queue.cancel('job-3')
  assert.equal(queue.get('job-3')?.status, 'canceled')
  assert.equal(queue.canRetry('job-3'), false, 'cancelado en cola: el archivo se suelta')
})

await check('falla de red al consultar: reintentar retoma la consulta sin volver a subir', async () => {
  const { queue, net } = makeQueue()
  queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  await flush()
  net.uploads[0].done.resolve({})
  await flush()
  net.watches[0].done.reject(new Error('Sin conexión con la nube.'))
  await flush()
  const failed = queue.get('job-1') as SplitJob
  assert.equal(failed.status, 'error')
  assert.equal(failed.error, 'Sin conexión con la nube.')
  assert.equal(queue.canRetry('job-1'), true)
  assert.deepEqual(queue.retry('job-1'), { ok: true })
  await flush()
  assert.equal(net.uploads.length, 1, 'no vuelve a subir')
  assert.equal(net.watches.length, 2)
  assert.equal(queue.get('job-1')?.status, 'separating')
  net.watches[1].done.resolve(succeeded(2))
  await flush()
  assert.equal(queue.get('job-1')?.status, 'done')
})

await check('Music AI falla: reintentar exige volver a elegir el audio', async () => {
  const { queue, net } = makeQueue()
  queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  await flush()
  net.uploads[0].done.resolve({})
  await flush()
  net.watches[0].done.resolve({ status: 'FAILED', error: 'Music AI no pudo separar la canción.' })
  await flush()
  const failed = queue.get('job-1') as SplitJob
  assert.equal(failed.status, 'error')
  assert.equal(failed.remoteFailed, true)
  assert.equal(queue.canRetry('job-1'), false)
  const noFile = queue.retry('job-1')
  assert.deepEqual(noFile, { ok: false, needsFile: true, message: SPLIT_NEEDS_FILE_MESSAGE })
  assert.deepEqual(queue.retry('job-1', audioFile('otra.mp3')), { ok: true })
  await flush()
  assert.equal(net.uploads.length, 2, 'vuelve a subir con el archivo nuevo')
  assert.equal(queue.get('job-1')?.status, 'uploading')
})

await check('importar a este equipo es parte del trabajo: importando hasta guardar', async () => {
  const { queue, net } = makeQueue()
  queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: true })
  await flush()
  net.uploads[0].done.resolve({})
  await flush()
  net.watches[0].done.resolve(succeeded(3))
  await flush()
  assert.equal(queue.get('job-1')?.status, 'importing')
  assert.equal(net.downloads.length, 1)
  net.downloads[0].onProgress(2, 3)
  assert.equal(queue.get('job-1')?.detail, 'DESCARGANDO STEMS 2/3...')
  net.downloads[0].done.resolve({ record: { tracks: [1, 2, 3] } })
  await flush()
  const done = queue.get('job-1') as SplitJob
  assert.equal(done.status, 'done')
  assert.equal(done.local, 'saved')
  assert.equal(done.localCount, 3)
  assert.deepEqual(net.localSaved, [{ band: 'me', songId: 's1' }])
})

await check('sin importar al terminar: DESCARGAR LOS NUEVOS despues; un fallo local no tumba el trabajo', async () => {
  const { queue, net } = makeQueue()
  queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  await flush()
  net.uploads[0].done.resolve({})
  await flush()
  net.watches[0].done.resolve(succeeded(2))
  await flush()
  assert.equal(queue.get('job-1')?.local, 'none')
  void queue.downloadLocal('job-1')
  void queue.downloadLocal('job-1')
  await flush()
  assert.equal(net.downloads.length, 1, 'un doble clic no baja dos veces')
  net.downloads[0].done.reject(new Error('Sin espacio.'))
  await flush()
  const failed = queue.get('job-1') as SplitJob
  assert.equal(failed.status, 'done', 'la nube ya tiene los stems')
  assert.equal(failed.local, 'failed')
  assert.equal(failed.localError, 'Sin espacio.')
})

await check('historial persistido: al recargar queda interrumpido y se retoma si ya se habia subido', async () => {
  const storage = new MemoryStorage()
  const first = makeQueue(storage)
  first.queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  first.queue.enqueue({ band: 'me', songId: 's2', songTitle: 'Dos', file: audioFile(), target: { band: 'me' }, importLocal: false })
  await flush()
  first.net.uploads[0].done.resolve({})
  await flush()
  const raw = storage.getItem(SPLIT_STORAGE_KEY) ?? ''
  assert.ok(raw.includes('"separating"'), 'el cambio de estado se guarda')
  assert.ok(!raw.includes('blob') && !raw.includes('target'), 'ni el archivo ni el destino se guardan')
  // "Recarga": cola nueva sobre el mismo almacenamiento.
  first.queue.dispose()
  const second = makeQueue(storage)
  const jobs = second.queue.list()
  assert.deepEqual(
    jobs.map((j) => [j.songId, j.status]),
    [
      ['s1', 'interrupted'],
      ['s2', 'interrupted'],
    ]
  )
  assert.equal(jobs[0].error, SPLIT_INTERRUPTED_MESSAGE)
  assert.equal(second.queue.canRetry(jobs[0].id), true, 'ya subido: se puede volver a consultar')
  assert.equal(second.queue.canRetry(jobs[1].id), false, 'sin subir: el archivo se perdio al recargar')
  assert.equal(second.queue.retry(jobs[1].id).ok, false)
  assert.deepEqual(second.queue.retry(jobs[0].id), { ok: true })
  await flush()
  assert.equal(second.net.uploads.length, 0)
  assert.equal(second.net.watches.length, 1)
  second.net.watches[0].done.resolve(succeeded(5))
  await flush()
  assert.equal(second.queue.get(jobs[0].id)?.status, 'done')
  // Quitar y limpiar el historial.
  second.queue.dismiss(jobs[0].id)
  assert.equal(second.queue.list().length, 1)
  second.queue.clearFinished()
  assert.equal(second.queue.list().length, 0)
  assert.equal(restoreSplitJobs(storage.getItem(SPLIT_STORAGE_KEY), 1).length, 0)
})

await check('reset (cerrar sesion) aborta y borra el historial', async () => {
  const { queue, net, storage } = makeQueue()
  queue.enqueue({ band: 'me', songId: 's1', songTitle: 'Uno', file: audioFile(), target: { band: 'me' }, importLocal: false })
  await flush()
  queue.reset()
  assert.equal(net.uploads[0].signal.aborted, true)
  assert.equal(queue.list().length, 0)
  assert.equal(storage.getItem(SPLIT_STORAGE_KEY), '[]')
})

console.log(`\n${passed} verificaciones del audio global y la cola Drop & Split: OK\n`)
