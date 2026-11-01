/**
 * Verificacion de la logica pura del estudio de stems:
 *   node --experimental-strip-types scripts/verify-stems-logic.ts   (parte de npm run verify:logic)
 *
 * Cubre: src/services/stemNames.ts contra TODOS los casos de bandait-protocol/fixtures/stem_names.json
 * (y que su copia de roles, etiquetas, palabras clave y extensiones sea identica al fixture), y
 * src/services/stemTiming.ts (inicio y fin de secciones, offset, recorte de la region de repeticion), y
 * src/services/stemCloud.ts contra un Worker simulado (orden de subida, errores, nombres validos),
 * src/services/wav.ts (cabecera y largo del WAV de la mezcla), el compas y la seccion de ENSAYO
 * (stemTiming.barAtTime / sectionIndexAtBar) y src/services/stemAnalysis.ts (borrador y errores).
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
import { barAtTime, barStartSeconds, clampLoop, dbToGain, formatClock, sectionIndexAtBar, sectionSpans } from '../src/services/stemTiming.ts'
import { WAV_HEADER_BYTES, encodeWav16, limitPeak, wavByteLength } from '../src/services/wav.ts'
import { DEFAULT_FONT_STEP, FONT_SCALES, PROMPTER_SHORTCUTS, barSeekTarget, barsLeftInSection, beatInBar, clampFontStep, keyTargetOf, keyToAction, sectionNavTarget, type KeyLike, type KeyTarget } from '../src/services/prompterKeys.ts'
import { analysisErrorMessage, draftToSongSections, getAnalysis, parseDraft, startAnalysis } from '../src/services/stemAnalysis.ts'
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

  console.log('\nwav.ts (mezcla para el analisis)')

  await check('encodeWav16: cabecera RIFF/WAVE PCM mono 16 bits y largo 44 + 2n', () => {
    const n = 22050 * 2
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = Math.sin(i / 10)
    const buf = encodeWav16(samples, 22050)
    assert.equal(buf.byteLength, WAV_HEADER_BYTES + 2 * n)
    assert.equal(wavByteLength(n), buf.byteLength)
    const v = new DataView(buf)
    const ascii = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
    assert.equal(ascii(0), 'RIFF')
    assert.equal(v.getUint32(4, true), 36 + 2 * n)
    assert.equal(ascii(8), 'WAVE')
    assert.equal(ascii(12), 'fmt ')
    assert.equal(v.getUint16(20, true), 1)
    assert.equal(v.getUint16(22, true), 1)
    assert.equal(v.getUint32(24, true), 22050)
    assert.equal(v.getUint32(28, true), 44100)
    assert.equal(v.getUint16(32, true), 2)
    assert.equal(v.getUint16(34, true), 16)
    assert.equal(ascii(36), 'data')
    assert.equal(v.getUint32(40, true), 2 * n)
  })

  await check('encodeWav16 satura fuera de [-1, 1] y 4 min a 22 050 Hz pesan ~10 MB', () => {
    const v = new DataView(encodeWav16(new Float32Array([2, -2, 0.5, Number.NaN]), 8000))
    assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)], [32767, -32768, 16384, 0])
    const mb = wavByteLength(240 * 22050) / (1024 * 1024)
    assert.ok(mb > 9.9 && mb < 10.2, String(mb))
  })

  await check('limitPeak baja el pico de una suma de stems y no toca una mezcla floja', () => {
    const loud = new Float32Array([0.5, -1.8, 1.2])
    const gain = limitPeak(loud)
    close(Math.max(...[...loud].map(Math.abs)), 0.89, 1e-6)
    close(gain, 0.89 / 1.8, 1e-6)
    const soft = new Float32Array([0.2, -0.3])
    assert.equal(limitPeak(soft), 1)
    assert.deepEqual([...soft], [new Float32Array([0.2])[0], new Float32Array([-0.3])[0]])
  })

  console.log('\nENSAYO: compas y seccion')

  await check('barAtTime: (posicion - offset) * bpm / 60 / tiempos + 1', () => {
    close(barAtTime(0, 120, 4), 1)
    close(barAtTime(2, 120, 4), 2)
    close(barAtTime(9, 124, 4), (9 * 124) / 60 / 4 + 1)
    close(barAtTime(2.5, 120, 4, 500), 2)
    assert.ok(barAtTime(0.2, 120, 4, 500) < 1)
    assert.ok(Number.isNaN(barAtTime(1, 0, 4)))
  })

  await check('sectionIndexAtBar: start_bar <= compas < start_bar + bars', () => {
    const spans = [
      { startBar: 1, bars: 4 },
      { startBar: 5, bars: 8 },
      { startBar: 13, bars: 8 },
    ]
    assert.equal(sectionIndexAtBar(spans, 0.9), -1)
    assert.equal(sectionIndexAtBar(spans, 1), 0)
    assert.equal(sectionIndexAtBar(spans, 4.99), 0)
    assert.equal(sectionIndexAtBar(spans, 5), 1)
    assert.equal(sectionIndexAtBar(spans, 12.5), 1)
    assert.equal(sectionIndexAtBar(spans, 13), 2)
    assert.equal(sectionIndexAtBar(spans, 21), 3)
    assert.equal(sectionIndexAtBar([], 3), -1)
    assert.equal(sectionIndexAtBar(spans, Number.NaN), -1)
  })

  await check('posicion -> seccion con las secciones de la cancion (offset incluido)', () => {
    const spans = sectionSpans({ bpm: 124, beatsPerBar: 4, sections: [section('intro', 4, 'Intro'), section('v1', 8, 'Estrofa 1')] })
    assert.equal(spans[sectionIndexAtBar(spans, barAtTime(3, 124, 4))].label, 'Intro')
    assert.equal(spans[sectionIndexAtBar(spans, barAtTime(9, 124, 4))].label, 'Estrofa 1')
    assert.equal(sectionIndexAtBar(spans, barAtTime(1, 124, 4, 2000)), -1)
  })

  console.log('\nstemAnalysis.ts (borrador de Music AI)')

  const rawDraft = {
    source: 'music.ai',
    bpm: 128.4,
    key: 'C#m',
    beats_per_bar: 4,
    sections: [
      { kind: 'intro', label: 'Intro', bars: 4, start_bar: 1, chordpro: '[C#m]    [A]', cue_text: null },
      { kind: 'verse', label: 'Estrofa 1', bars: 8, start_bar: 5, chordpro: '[E]  [B]\n', cue_text: null },
      { kind: 'rap', label: 'Rap', bars: 2, start_bar: 13, chordpro: '', cue_text: 'Rap' },
      { kind: 'verse', label: 'Mala', bars: 0, start_bar: 15, chordpro: '' },
    ],
    lyrics_unplaced: ['linea uno', '', 'linea dos'],
    notes: ['Music AI no ubicó la letra.'],
  }

  await check('parseDraft: tipos desconocidos a custom, descarta compases invalidos y lineas vacias', () => {
    const d = parseDraft(rawDraft)
    assert.equal(d.bpm, 128.4)
    assert.equal(d.key, 'C#m')
    assert.deepEqual(d.sections.map((s) => [s.kind, s.label, s.bars, s.start_bar]), [
      ['intro', 'Intro', 4, 1],
      ['verse', 'Estrofa 1', 8, 5],
      ['custom', 'Rap', 2, 13],
    ])
    assert.deepEqual(d.lyrics_unplaced, ['linea uno', 'linea dos'])
    assert.throws(() => parseDraft({ bpm: 120 }))
  })

  await check('draftToSongSections: ids nuevos, ChordPro sin espacios finales, aviso solo si viene texto', () => {
    let n = 0
    const secs = draftToSongSections(parseDraft(rawDraft), () => `id-${++n}`)
    assert.deepEqual(secs.map((s) => [s.id, s.kind, s.label, s.bars]), [
      ['id-1', 'intro', 'Intro', 4],
      ['id-2', 'verse', 'Estrofa 1', 8],
      ['id-3', 'custom', 'Rap', 2],
    ])
    assert.equal(secs[1].chordpro, '[E]  [B]')
    assert.equal('cueText' in secs[0], false)
    assert.equal(secs[2].cueText, 'Rap')
  })

  await check('mensajes de error del analisis en espanol', () => {
    assert.match(analysisErrorMessage('analysis_unavailable', 503), /no está disponible/)
    assert.match(analysisErrorMessage('analysis_failed', 502), /falló/)
    assert.match(analysisErrorMessage('analysis_upload_failed', 502), /enviar la mezcla/)
    assert.match(analysisErrorMessage('not_an_editor', 403), /Owner o el Director musical/)
    assert.match(analysisErrorMessage('file_too_large', 413), /95 MB/)
    assert.match(analysisErrorMessage('not_audio', 415), /solo acepta audio/)
  })

  const calls: string[] = []
  let reply: { status: number; body: unknown } = { status: 404, body: { error: 'no_analysis' } }
  const fetchAnalysis = async (input: string, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    calls.push(`${init?.method ?? 'GET'} ${new URL(input).pathname} ${h.get('Content-Type') ?? ''} ${init?.body instanceof Blob ? init.body.size : 0}`)
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } })
  }
  const aTarget: CloudTarget = { baseUrl: 'https://stems.test', band: 'me', getToken: async () => 'token-de-prueba-123456789', fetchFn: fetchAnalysis }

  await check('getAnalysis: 404 no_analysis, STARTED, SUCCEEDED con fecha y FAILED', async () => {
    assert.deepEqual(await getAnalysis(aTarget, 'song_1'), { status: 'none' })
    reply = { status: 200, body: { status: 'STARTED', job_id: 'job-1' } }
    assert.deepEqual(await getAnalysis(aTarget, 'song_1'), { status: 'STARTED', jobId: 'job-1' })
    reply = { status: 200, body: { status: 'SUCCEEDED', job_id: 'job-1', created_at: '2026-10-31T15:00:00Z', draft: rawDraft } }
    const ok = await getAnalysis(aTarget, 'song_1')
    assert.equal(ok.status, 'SUCCEEDED')
    assert.equal(ok.status === 'SUCCEEDED' && ok.createdAt, '2026-10-31T15:00:00Z')
    reply = { status: 200, body: { status: 'FAILED', error: 'audio muy corto' } }
    assert.deepEqual(await getAnalysis(aTarget, 'song_1'), { status: 'FAILED', error: 'audio muy corto' })
  })

  await check('startAnalysis: POST con el WAV como cuerpo y Content-Type audio/wav; 403 y 503 legibles', async () => {
    calls.length = 0
    reply = { status: 202, body: { status: 'STARTED', job_id: 'job-2' } }
    const wav = new Blob([encodeWav16(new Float32Array(100), 22050)], { type: 'audio/wav' })
    assert.deepEqual(await startAnalysis(aTarget, 'song_1', wav), { jobId: 'job-2' })
    assert.deepEqual(calls, [`POST /v1/bands/me/songs/song_1/analysis audio/wav ${wav.size}`])
    reply = { status: 403, body: { error: 'not_an_editor' } }
    await assert.rejects(startAnalysis(aTarget, 'song_1', wav), (e: unknown) => e instanceof StemCloudError && /Director musical de la banda pueden analizar/.test(e.message))
    reply = { status: 503, body: { error: 'analysis_unavailable' } }
    await assert.rejects(getAnalysis(aTarget, 'song_1'), (e: unknown) => e instanceof StemCloudError && /no está disponible/.test(e.message))
  })

  // ---------------------------------------------------------------- prompter de ENSAYO
  await check('atajos: cada tecla a su accion; Ctrl/Alt/Meta y campos de texto no son atajos', () => {
    const k = (key: string, extra: Partial<KeyLike> = {}, target: KeyTarget = 'other') => keyToAction({ key, ...extra }, target)
    assert.deepEqual(k(' '), { type: 'togglePlay' })
    assert.deepEqual(k('ArrowRight'), { type: 'bars', delta: 1 })
    assert.deepEqual(k('ArrowLeft', { shiftKey: true }), { type: 'bars', delta: -4 })
    assert.deepEqual(k('ArrowDown'), { type: 'section', dir: 1 })
    assert.deepEqual(k('PageUp'), { type: 'section', dir: -1 })
    assert.deepEqual(k('3', { code: 'Digit3' }), { type: 'gotoSection', index: 2 })
    assert.deepEqual(k('0', { code: 'Digit0' }), { type: 'start' })
    assert.deepEqual(k('Home'), { type: 'start' })
    assert.deepEqual(k('r'), { type: 'toggleLoop' })
    assert.deepEqual(k('R', { shiftKey: true }), { type: 'toggleLoop' })
    assert.deepEqual(k('c'), { type: 'mode', mode: 'chords' })
    assert.deepEqual(k('l'), { type: 'mode', mode: 'lyrics' })
    assert.deepEqual(k('+'), { type: 'fontSize', delta: 1 })
    assert.deepEqual(k('-'), { type: 'fontSize', delta: -1 })
    assert.deepEqual(k('t'), { type: 'transpose', delta: 1 })
    assert.deepEqual(k('T', { shiftKey: true }), { type: 'transpose', delta: -1 })
    // Shift+0 por codigo: "=" en un teclado espanol, ")" en uno ingles.
    assert.deepEqual(k('=', { code: 'Digit0', shiftKey: true }), { type: 'transposeReset' })
    assert.deepEqual(k(')', { code: 'Digit0', shiftKey: true }), { type: 'transposeReset' })
    assert.deepEqual(k('f'), { type: 'focus' })
    assert.deepEqual(k('Escape'), { type: 'exit' })
    assert.deepEqual(k('m'), { type: 'mixer' })
    assert.deepEqual(k('?', { shiftKey: true }), { type: 'help' })
    assert.equal(k('x'), null)
    assert.equal(k('r', { ctrlKey: true }), null, 'Ctrl+R recarga: no es un atajo')
    assert.equal(k(' ', { metaKey: true }), null)
    assert.equal(k('ArrowRight', { altKey: true }), null)
    assert.equal(k(' ', {}, 'text'), null, 'escribiendo en un campo')
    assert.equal(k('ArrowRight', {}, 'range'), null, 'el deslizador usa sus flechas')
    assert.deepEqual(k(' ', {}, 'range'), { type: 'togglePlay' })
    assert.equal(keyTargetOf({ tagName: 'INPUT', type: 'text' }), 'text')
    assert.equal(keyTargetOf({ tagName: 'INPUT', type: 'range' }), 'range')
    assert.equal(keyTargetOf({ tagName: 'SELECT' }), 'text')
    assert.equal(keyTargetOf({ tagName: 'DIV', isContentEditable: true }), 'text')
    assert.equal(keyTargetOf({ tagName: 'BUTTON' }), 'other')
    assert.equal(keyTargetOf(null), 'other')
    assert.ok(PROMPTER_SHORTCUTS.length >= 12)
  })

  await check('prompter: saltos de compas y de seccion (anterior como en un reproductor)', () => {
    // 120 BPM 4/4: 2 s por compas. Secciones de 4 y 8 compases desde el compas 1.
    const t = { bpm: 120, beatsPerBar: 4, offsetMs: 0 }
    const spans = sectionSpans({ bpm: 120, beatsPerBar: 4, sections: [{ id: 'a', label: 'Intro', bars: 4 }, { id: 'b', label: 'Coro', bars: 8 }] as SongSection[] }, 0)
    assert.equal(barSeekTarget(9, 1, t), 10, 'compas 5.5 -> inicio del 6')
    assert.equal(barSeekTarget(9, -1, t), 6, 'compas 5.5 -> inicio del 4')
    assert.equal(barSeekTarget(1, -4, t), 0, 'nunca antes del segundo 0')
    assert.equal(barSeekTarget(3, 4, { ...t, offsetMs: 500 }), 10.5, 'con offset: compas 2.25 -> inicio del 6 = 10 s + 0.5 s')
    assert.equal(sectionNavTarget(spans, 3, 1, t), 8, 'de Intro al Coro')
    assert.equal(sectionNavTarget(spans, 9, 1, t), null, 'despues de la ultima no hay siguiente')
    assert.equal(sectionNavTarget(spans, 12, -1, t), 8, 'mas de 1 compas dentro: al inicio de la actual')
    assert.equal(sectionNavTarget(spans, 9, -1, t), 0, 'al empezar el Coro: a la Intro')
    assert.equal(sectionNavTarget(spans, 1, -1, t), 0, 'desde la primera: al principio')
    assert.equal(sectionNavTarget([], 1, 1, t), null)
    assert.equal(beatInBar(5.0, 4), 0)
    assert.equal(beatInBar(5.76, 4), 3)
    assert.equal(beatInBar(0.5, 4), -1, 'antes del compas 1')
    assert.equal(barsLeftInSection({ startBar: 5, bars: 8 }, 11.2), 2)
    assert.equal(barsLeftInSection({ startBar: 5, bars: 8 }, 12.9), 1)
    assert.equal(barsLeftInSection({ startBar: 5, bars: 8 }, 13), 0)
    assert.equal(clampFontStep('9'), FONT_SCALES.length - 1)
    assert.equal(clampFontStep(-2), 0)
    assert.equal(clampFontStep(null), DEFAULT_FONT_STEP)
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
