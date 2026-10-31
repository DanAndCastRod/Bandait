/**
 * Verificacion de la logica pura del estudio de stems:
 *   node --experimental-strip-types scripts/verify-stems-logic.ts   (parte de npm run verify:logic)
 *
 * Cubre: src/services/stemNames.ts contra TODOS los casos de bandait-protocol/fixtures/stem_names.json
 * (y que su copia de roles, etiquetas, palabras clave y extensiones sea identica al fixture), y
 * src/services/stemTiming.ts (inicio y fin de secciones, offset, recorte de la region de repeticion), y
 * src/services/stemCloud.ts contra un Worker simulado (orden de subida, errores, nombres validos).
 */
import assert from 'node:assert/strict'
import fixture from '../../bandait-protocol/fixtures/stem_names.json' with { type: 'json' }
import {
  KNOWN_STEM_ROLES,
  STEM_EXTENSIONS,
  STEM_ROLES,
  isStemAudioPath,
  normalizeStemName,
  recognizeStem,
} from '../src/services/stemNames.ts'
import { barStartSeconds, clampLoop, dbToGain, formatClock, sectionSpans } from '../src/services/stemTiming.ts'
import type { SongSection } from '../src/types/hub.ts'
import {
  CLOUD_MAX_STEMS,
  StemCloudError,
  cloudBandKey,
  cloudErrorMessage,
  cloudFileNames,
  deleteCloudStems,
  downloadStemFiles,
  getManifest,
  leaderCanPlay,
  manifestMatchesRecord,
  parseManifest,
  uploadStems,
  type CloudTarget,
} from '../src/services/stemCloud.ts'
import type { StemSongRecord } from '../src/services/stemStore.ts'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FALLA ${name}\n        ${err instanceof Error ? err.message : String(err)}`)
  }
}

function close(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `esperaba ${expected}, obtuve ${actual}`)
}

function section(id: string, bars: number, label = id): SongSection {
  return { id, kind: 'custom', label, bars, chordpro: '' }
}

async function main() {
  console.log('stemNames.ts contra bandait-protocol/fixtures/stem_names.json')

  await check('las extensiones son las del fixture', () => {
    assert.deepEqual([...STEM_EXTENSIONS], fixture.extensions)
  })

  await check('roles, etiquetas y palabras clave son las del fixture (mismo orden)', () => {
    assert.deepEqual(KNOWN_STEM_ROLES, Object.keys(fixture.roles))
    for (const role of KNOWN_STEM_ROLES) {
      const expected = (fixture.roles as Record<string, { label: string; keywords: string[] }>)[role]
      assert.equal(STEM_ROLES[role].label, expected.label, role)
      assert.deepEqual([...STEM_ROLES[role].keywords], expected.keywords, role)
    }
  })

  for (const c of fixture.cases) {
    await check(`caso ${JSON.stringify(c.file)} -> ${c.role === null ? 'null' : c.role}`, () => {
      assert.equal(recognizeStem(c.file), c.role)
    })
  }

  await check('normaliza tildes, separadores y espacios', () => {
    assert.equal(normalizeStemName('Moises/Guitarra  Eléctrica_(Take-2).[final].wav'), 'guitarra electrica take 2 final')
    assert.equal(normalizeStemName('C:\\stems\\Batería.WAV'), 'bateria')
  })

  await check('palabras completas: "basslines" no es "bass", "overdrums" no es "drums"', () => {
    assert.equal(recognizeStem('Basslines.mp3'), 'unknown')
    assert.equal(recognizeStem('overdrums.wav'), 'unknown')
  })

  await check('extension en mayusculas cuenta; sin extension o con otra, no', () => {
    assert.equal(isStemAudioPath('DRUMS.FLAC'), true)
    assert.equal(recognizeStem('drums'), null)
    assert.equal(recognizeStem('drums.mid'), null)
    assert.equal(recognizeStem('carpeta/'), null)
  })

  await check('un nombre vacio tras normalizar es unknown', () => {
    assert.equal(recognizeStem('___.mp3'), 'unknown')
  })

  console.log('\nstemTiming.ts')

  await check('inicio de compas: (bar-1) * beatsPerBar * 60 / bpm', () => {
    close(barStartSeconds(1, 120, 4), 0)
    close(barStartSeconds(5, 120, 4), 8)
    close(barStartSeconds(3, 90, 3), 4)
  })

  await check('secciones consecutivas: cada una empieza donde termina la anterior', () => {
    const spans = sectionSpans({ bpm: 120, beatsPerBar: 4, sections: [section('intro', 4), section('verso', 8), section('coro', 8)] })
    assert.deepEqual(
      spans.map((s) => [s.id, s.startBar, s.bars]),
      [
        ['intro', 1, 4],
        ['verso', 5, 8],
        ['coro', 13, 8],
      ]
    )
    close(spans[0].startSec, 0)
    close(spans[0].endSec, 8)
    close(spans[1].startSec, 8)
    close(spans[1].endSec, 24)
    close(spans[2].startSec, 24)
    close(spans[2].endSec, 40)
  })

  await check('el offset de alineacion (ms) se suma a inicio y fin', () => {
    const [intro, verso] = sectionSpans({ bpm: 100, beatsPerBar: 4, sections: [section('intro', 2), section('verso', 4)] }, 1500)
    close(intro.startSec, 1.5)
    close(intro.endSec, 1.5 + 4.8)
    close(verso.startSec, 6.3)
    close(verso.endSec, 6.3 + 9.6)
    const [neg] = sectionSpans({ bpm: 100, beatsPerBar: 4, sections: [section('intro', 2)] }, -250)
    close(neg.startSec, -0.25)
  })

  await check('sin secciones o con tempo invalido no inventa tiempos', () => {
    assert.deepEqual(sectionSpans({ bpm: 120, beatsPerBar: 4, sections: [] }), [])
    assert.deepEqual(sectionSpans({ bpm: 0, beatsPerBar: 4, sections: [section('a', 4)] }), [])
    assert.deepEqual(sectionSpans({ bpm: 120, beatsPerBar: Number.NaN, sections: [section('a', 4)] }), [])
  })

  await check('una seccion con compases invalidos corta la lista ahi', () => {
    const spans = sectionSpans({ bpm: 120, beatsPerBar: 4, sections: [section('a', 4), section('b', 0), section('c', 4)] })
    assert.deepEqual(
      spans.map((s) => s.id),
      ['a']
    )
  })

  await check('clampLoop recorta a la duracion y descarta regiones vacias', () => {
    assert.deepEqual(clampLoop({ start: -1, end: 5 }, 10), { start: 0, end: 5 })
    assert.deepEqual(clampLoop({ start: 8, end: 20 }, 10), { start: 8, end: 10 })
    assert.equal(clampLoop({ start: 12, end: 20 }, 10), null)
    assert.equal(clampLoop({ start: 5, end: 5.01 }, 10), null)
    assert.equal(clampLoop({ start: 5, end: 3 }, 10), null)
    assert.equal(clampLoop({ start: 0, end: 1 }, 0), null)
  })

  await check('formatClock y dbToGain', () => {
    assert.equal(formatClock(0), '0:00.0')
    assert.equal(formatClock(65.37), '1:05.3')
    assert.equal(formatClock(-3), '0:00.0')
    close(dbToGain(0), 1)
    close(dbToGain(-6), 0.501187233627, 1e-9)
    assert.equal(dbToGain(-60), 0)
  })

  console.log('\nstemCloud.ts (Worker simulado)')

  await check('cloudBandKey: uuid de banda compartida o me', () => {
    const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e'
    assert.equal(cloudBandKey(uuid, true), uuid)
    assert.equal(cloudBandKey(uuid, false), 'me')
    assert.equal(cloudBandKey('band_01', true), 'me')
    assert.equal(cloudBandKey(null, true), 'me')
  })

  await check('cloudFileNames: nombres validos para el Worker, sin tildes y unicos', () => {
    const names = cloudFileNames(['Guitarra Eléctrica.FLAC', 'Voz #1 & coro.mp3', '..raro..wav', 'voz #1 & coro.MP3', 'a'.repeat(200) + '.ogg'])
    assert.equal(names[0], 'Guitarra Electrica.flac')
    assert.equal(names[1], 'Voz _1 _ coro.mp3')
    assert.equal(names[2], 'raro.wav')
    assert.equal(names[3], 'voz _1 _ coro (2).mp3')
    for (const n of names) {
      assert.match(n, /^[A-Za-z0-9 ._()-]{1,120}$/)
      assert.ok(!n.startsWith('.') && !n.includes('..'), n)
    }
  })

  await check('leaderCanPlay: mp3/wav/flac/ogg si, m4a/aac no', () => {
    assert.deepEqual(['a.mp3', 'b.WAV', 'c.flac', 'd.ogg', 'e.m4a', 'f.aac'].map(leaderCanPlay), [true, true, true, true, false, false])
  })

  await check('mensajes en espanol para los codigos del Worker', () => {
    assert.match(cloudErrorMessage('not_an_editor', 403), /Owner o el Director musical/)
    assert.match(cloudErrorMessage('invalid_token', 401), /sesión de nube venció/)
    assert.match(cloudErrorMessage('', 401), /sesión de nube venció/)
    assert.match(cloudErrorMessage('file_too_large', 413), /200 MB/)
    assert.match(cloudErrorMessage('raro', 500), /HTTP 500/)
  })

  await check('parseManifest valida y conserva roles conocidos', () => {
    const m = parseManifest(
      { version: 1, song_id: 's1', offset_ms: 120, stems: [{ file: 'Bass.mp3', role: 'bass', label: 'Bajo', size: 10 }, { file: 'x.wav', role: 'futuro', label: '', size: 3 }] },
      's1'
    )
    assert.equal(m.stems[0].role, 'bass')
    assert.equal(m.stems[1].role, 'unknown')
    assert.equal(m.stems[1].label, 'x.wav')
    assert.throws(() => parseManifest({ version: 1, song_id: 'otra', stems: [] }, 's1'))
    assert.throws(() => parseManifest({ version: 1, song_id: 's1', stems: [{ file: '../x.mp3', size: 1 }] }, 's1'))
  })

  const worker = new FakeWorker()
  const target: CloudTarget = { baseUrl: 'https://stems.test/', band: 'me', getToken: async () => 'token-de-prueba-123456789', fetchFn: worker.fetch }
  const record: StemSongRecord = {
    songId: 'song_1',
    offsetMs: 250,
    updatedAt: '',
    tracks: [
      { id: 't1', role: 'vocals', label: 'Voz', fileName: 'Canción - Vocals.mp3', size: 5, mimeType: 'audio/mpeg' },
      { id: 't2', role: 'drums', label: 'Bateria', fileName: 'drums.m4a', size: 7, mimeType: 'audio/mp4' },
    ],
  }
  const blobs = new Map([
    ['t1', new Blob([new Uint8Array(5)], { type: 'audio/mpeg' })],
    ['t2', new Blob([new Uint8Array(7)], { type: 'audio/mp4' })],
  ])

  await check('getManifest: 404 no_stems es null', async () => {
    assert.equal(await getManifest(target, 'song_1'), null)
  })

  await check('uploadStems: archivos primero, manifiesto al final, con token y progreso', async () => {
    worker.calls.length = 0
    const progress: string[] = []
    const m = await uploadStems(target, 'song_1', { record, blobs }, (d, t) => progress.push(`${d}/${t}`))
    assert.deepEqual(
      worker.calls.map((c) => `${c.method} ${c.path}`),
      ['PUT /v1/bands/me/songs/song_1/files/Cancion%20-%20Vocals.mp3', 'PUT /v1/bands/me/songs/song_1/files/drums.m4a', 'PUT /v1/bands/me/songs/song_1/manifest']
    )
    assert.ok(worker.calls.every((c) => c.auth === 'Bearer token-de-prueba-123456789'))
    assert.equal(worker.calls[0].type, 'audio/mpeg')
    assert.equal(worker.calls[1].type, 'audio/mp4')
    assert.deepEqual(progress, ['0/2', '1/2', '2/2'])
    assert.equal(m.offset_ms, 250)
    assert.deepEqual(m.stems.map((s) => [s.file, s.role, s.label, s.size]), [
      ['Cancion - Vocals.mp3', 'vocals', 'Voz', 5],
      ['drums.m4a', 'drums', 'Bateria', 7],
    ])
    assert.equal(manifestMatchesRecord(m, record), true)
    assert.equal(manifestMatchesRecord(m, { ...record, offsetMs: 300 }), false)
  })

  await check('uploadStems: con el manifiesto actual solo sube lo que cambio', async () => {
    const existing = await getManifest(target, 'song_1')
    worker.calls.length = 0
    await uploadStems(target, 'song_1', { record: { ...record, offsetMs: 0 }, blobs, existing })
    assert.deepEqual(worker.calls.map((c) => `${c.method} ${c.path}`), ['PUT /v1/bands/me/songs/song_1/manifest'])
  })

  await check('downloadStemFiles: manifiesto y luego cada archivo, con sus tamanos', async () => {
    worker.calls.length = 0
    const { manifest, tracks } = await downloadStemFiles(target, 'song_1')
    assert.equal(manifest.stems.length, 2)
    assert.deepEqual(worker.calls.map((c) => `${c.method} ${c.path}`), [
      'GET /v1/bands/me/songs/song_1/manifest',
      'GET /v1/bands/me/songs/song_1/files/Cancion%20-%20Vocals.mp3',
      'GET /v1/bands/me/songs/song_1/files/drums.m4a',
    ])
    assert.deepEqual(tracks.map((t) => [t.fileName, t.role, t.label, t.blob.size]), [
      ['Cancion - Vocals.mp3', 'vocals', 'Voz', 5],
      ['drums.m4a', 'drums', 'Bateria', 7],
    ])
  })

  await check('deleteCloudStems devuelve lo borrado y deja la cancion sin manifiesto', async () => {
    assert.equal(await deleteCloudStems(target, 'song_1'), 3)
    assert.equal(await getManifest(target, 'song_1'), null)
  })

  await check('errores: 403 not_an_editor, 401, red caida y sin sesion', async () => {
    worker.failWith = { status: 403, error: 'not_an_editor' }
    await assert.rejects(uploadStems(target, 'song_1', { record, blobs }), (e: unknown) => e instanceof StemCloudError && e.code === 'not_an_editor' && /Director musical/.test(e.message))
    worker.failWith = { status: 401, error: 'invalid_token' }
    await assert.rejects(getManifest(target, 'song_1'), (e: unknown) => e instanceof StemCloudError && e.status === 401 && /venció/.test(e.message))
    worker.failWith = null
    const offline: CloudTarget = { ...target, fetchFn: async () => Promise.reject(new TypeError('Failed to fetch')) }
    await assert.rejects(getManifest(offline, 'song_1'), (e: unknown) => e instanceof StemCloudError && e.code === 'network')
    const noSession: CloudTarget = { ...target, getToken: async () => null }
    await assert.rejects(getManifest(noSession, 'song_1'), (e: unknown) => e instanceof StemCloudError && e.code === 'no_session')
  })

  await check(`uploadStems rechaza mas de ${CLOUD_MAX_STEMS} stems sin llamar al Worker`, async () => {
    worker.calls.length = 0
    const many = { ...record, tracks: Array.from({ length: CLOUD_MAX_STEMS + 1 }, (_, i) => ({ ...record.tracks[0], id: `m${i}` })) }
    await assert.rejects(uploadStems(target, 'song_1', { record: many, blobs }), (e: unknown) => e instanceof StemCloudError && e.code === 'too_many_stems')
    assert.equal(worker.calls.length, 0)
  })

  console.log(`\n${passed} ok, ${failures.length} fallas`)
  if (failures.length > 0) process.exit(1)
}

interface WorkerCall {
  method: string
  path: string
  auth: string | null
  type: string | null
}

/** Worker bandait-stems en memoria: mismas rutas, codigos y reglas de commit del manifiesto. */
class FakeWorker {
  files = new Map<string, Uint8Array>()
  manifests = new Map<string, unknown>()
  calls: WorkerCall[] = []
  failWith: { status: number; error: string } | null = null

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    this.calls.push({ method, path: url.pathname, auth: headers.get('Authorization'), type: headers.get('Content-Type') })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (this.failWith) return json(this.failWith.status, { error: this.failWith.error })
    const m = /^\/v1\/bands\/([^/]+)\/songs\/([^/]+)(?:\/(manifest|files\/([^/]+)))?$/.exec(url.pathname)
    if (!m) return json(404, { error: 'not_found' })
    const song = `${m[1]}/${m[2]}`
    if (method === 'DELETE') {
      let n = 0
      for (const k of [...this.files.keys()]) {
        if (!k.startsWith(`${song}/`)) continue
        this.files.delete(k)
        n++
      }
      if (this.manifests.delete(song)) n++
      return json(200, { deleted: n })
    }
    if (m[3] === 'manifest') {
      if (method === 'GET') return this.manifests.has(song) ? json(200, this.manifests.get(song)) : json(404, { error: 'no_stems' })
      const body = JSON.parse(String(init?.body)) as { stems: Array<{ file: string; size: number }> }
      for (const s of body.stems) if (this.files.get(`${song}/${s.file}`)?.length !== s.size) return json(409, { error: 'missing_file' })
      const saved = { ...body, updated_at: '2026-10-31T00:00:00.000Z' }
      this.manifests.set(song, saved)
      return json(200, saved)
    }
    const file = decodeURIComponent(m[4] as string)
    if (!/^[A-Za-z0-9 ._()-]{1,120}$/.test(file)) return json(400, { error: 'bad_file' })
    const key = `${song}/${file}`
    if (method === 'GET') {
      const data = this.files.get(key)
      return data ? new Response(data, { status: 200 }) : json(404, { error: 'no_file' })
    }
    const bytes = new Uint8Array(await (init?.body as Blob).arrayBuffer())
    this.files.set(key, bytes)
    return json(200, { file, size: bytes.length })
  }
}

main()
