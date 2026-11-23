// Pruebas puras de lo que el asistente del chat sabe de la musica (STUDIO_V2.md 4.3.2 y 4.3.5):
// resumen de notas MIDI, acordes guardados en la sesion (2.9), progresion de la cancion sin letra,
// medicion de mezcla, tope de 32 KB con su degradacion, revision local de notas y fragmento para
// escuchar. Sin red ni navegador.
//
//   node --experimental-strip-types scripts/verify-studio-chat-context.ts
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import {
  CHAT_SUMMARY_LITERAL_NOTES,
  dominantGrid,
  keyScale,
  midiClipDigest,
  mixForSummary,
  pitchName,
  sectionChordLine,
  sessionChordsForSummary,
  songChordChart,
} from '../src/services/studio/chatContext.ts'
import { reviewNoteCall } from '../src/services/studio/noteReview.ts'
import { prepareToolCalls, applyPendingCommand } from '../src/services/studio/assistantTools.ts'
import { STUDIO_COMMAND_SPECS, createCommandRegistry } from '../src/services/studio/commands.ts'
import {
  CHAT_SUMMARY_MAX_BYTES,
  analysisToChords,
  appendUserMessage,
  buildSessionSummary,
  chatRequestProblem,
  fitSessionSummary,
  sessionSummaryBytes,
  type ChatView,
} from '../src/services/studio/jobs.ts'
import { jobRequestV2ToWire, sessionSummaryToWire } from '../src/services/studio/studioCloud.ts'
import { StudioSessionError, parseSession, serializeSession, type StudioMidiClip, type StudioMidiNote, type StudioSession, type StudioTrack } from '../src/services/studio/session.ts'
import { setChords } from '../src/services/studio/sessionOps.ts'
import type { MixMetrics, StudioAnalysis, StudioChatToolCall } from '../src/services/studio/types.ts'
import type { Song } from '../src/types/hub.ts'

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

function fixtureSession(): StudioSession {
  return parseSession(structuredClone(sessionFixtureV2))
}

const VIEW: ChatView = { playheadBeat: 16, selection: { trackId: 'trk_2', clipIds: [], context: 'timeline' } }

function clip(id: string, startBeat: number, lengthBeats: number, notes: StudioMidiNote[], loop = false, loopBeats = lengthBeats): StudioMidiClip {
  return { id, startBeat, lengthBeats, loop, loopBeats, notes }
}

function note(pitch: number, start: number, length = 1, velocity = 100): StudioMidiNote {
  return { pitch, start, length, velocity }
}

function trackById(session: StudioSession, id: string): StudioTrack {
  const t = session.tracks.find((x) => x.id === id)
  assert.ok(t, id)
  return t
}

const SONG: Song = {
  id: 'song_1',
  title: 'Cancion de prueba',
  artist: 'Banda',
  bpm: 120,
  beatsPerBar: 4,
  beatUnit: 4,
  key: 'C#m',
  updatedAt: '2026-11-22T00:00:00Z',
  sections: [
    { id: 's1', kind: 'intro', label: 'Intro', bars: 4, chordpro: '[C#m] [A] [E] [B]' },
    { id: 's2', kind: 'verse', label: 'Estrofa 1', bars: 8, chordpro: '[C#m]Hoy vuelvo a [A]casa\n[A]tarde de [E]noche\n{c: suave}\n[B]sigo [B]igual' },
    { id: 's3', kind: 'custom', label: 'Hablado', bars: 2, chordpro: 'Solo letra, sin acordes' },
    { id: 's4', kind: 'chorus', label: 'Coro', bars: 8, chordpro: '[Coro]\n[E]Canta [B/D#]fuerte [C#m7]ya' },
  ],
}

const METRICS: MixMetrics = {
  targetLufs: -14,
  master: { lufs: -15.2, truePeakDb: -1.1 },
  tracks: [
    { trackId: 'trk_1', name: 'Voz', role: 'vocals', lufs: -18.4, truePeakDb: -3.2, bands: { lowDb: -14, lowMidDb: -3, highMidDb: -6, highDb: -15 }, volumeDb: 0, pan: 0, fx: [] },
  ],
}

async function main() {
  console.log('chatContext.ts: lo que el asistente sabe de la musica')

  await check('keyScale y pitchName: tonalidades mayores y menores (con la sensible)', () => {
    const csm = keyScale('C#m')
    assert.ok(csm && csm.minor && csm.tonic === 1)
    assert.deepEqual([...csm.pitchClasses].sort((a, b) => a - b), [0, 1, 3, 4, 6, 8, 9, 11])
    const bb = keyScale('Bb')
    assert.ok(bb && !bb.minor && bb.tonic === 10)
    assert.ok(keyScale('A minor')?.minor)
    assert.ok(keyScale('F# mayor') && !keyScale('F# mayor')!.minor)
    assert.equal(keyScale('Do mayor'), null)
    assert.equal(keyScale(null), null)
    assert.equal(pitchName(60), 'C4')
    assert.equal(pitchName(28), 'E1')
  })

  await check('dominantGrid: la rejilla mas gruesa que cubre el 90 % de los inicios', () => {
    assert.equal(dominantGrid([0, 1, 2, 3]), '1/4')
    assert.equal(dominantGrid([0, 0.5, 1, 1.5]), '1/8')
    assert.equal(dominantGrid([0, 1 / 3, 2 / 3, 1]), '1/8t')
    assert.equal(dominantGrid([0, 0.25, 0.75, 1.25]), '1/16')
    assert.equal(dominantGrid([0, 1 / 6, 0.5, 5 / 6]), '1/16t')
    assert.equal(dominantGrid([0.03, 0.41, 1.07, 2.29]), 'libre')
    // Una nota fuera de 10 sigue dejando la rejilla de las otras 9.
    assert.equal(dominantGrid([...Array.from({ length: 9 }, (_, i) => i), 9.37]), '1/4')
    assert.equal(dominantGrid([]), '1/4')
  })

  await check('midiClipDigest: clases de altura por duracion, densidad, rejilla, velocidad y notas literales', () => {
    const session = fixtureSession()
    const pad = trackById(session, 'trk_2').midiClips[0]
    const d = midiClipDigest(pad, 4, false)
    // A igual peso, en orden de clase de altura (G# antes que A).
    assert.deepEqual(d.pitchClasses, [['C#', 0.33], ['E', 0.33], ['G#', 0.17], ['A', 0.17]])
    assert.equal(d.spanBeats, 16)
    assert.equal(d.notesPerBar, 1.5)
    assert.equal(d.grid, '1/4')
    assert.equal(d.velocityMean, 90)
    assert.deepEqual(d.notes?.[3], [57, 8, 8, 90])
    assert.equal(d.hits, undefined)

    // Bateria: golpes por nota GM, sin clases de altura.
    const drums = midiClipDigest(trackById(session, 'trk_3').midiClips[0], 4, true)
    assert.deepEqual(drums.pitchClasses, [])
    assert.deepEqual(drums.hits?.[0], [42, 14])

    // Con loop se resume el patron; una nota que pasa del patron cuenta solo hasta su fin.
    const looped = clip('mid_l', 0, 16, [note(40, 0, 1), note(43, 1, 4), note(47, 6, 1)], true, 4)
    const dl = midiClipDigest(looped, 4, false)
    assert.equal(dl.spanBeats, 4)
    assert.deepEqual(dl.notes, [[40, 0, 1, 100], [43, 1, 3, 100]])
    assert.equal(dl.notesPerBar, 2)

    // Mas de 64 notas: sin literales; con 64 justas, si.
    const many = clip('mid_m', 0, 32, Array.from({ length: CHAT_SUMMARY_LITERAL_NOTES + 1 }, (_, i) => note(60 + (i % 5), i * 0.25, 0.25)))
    assert.equal(midiClipDigest(many, 4, false).notes, undefined)
    assert.equal(midiClipDigest({ ...many, notes: many.notes.slice(0, 64) }, 4, false).notes?.length, 64)
    assert.equal(midiClipDigest(many, 4, false, 0).notes, undefined, 'literalMax 0: nunca')
    const empty = midiClipDigest(clip('mid_e', 0, 4, []), 4, false)
    assert.deepEqual([empty.pitchClasses, empty.velocityMean, empty.notesPerBar, empty.notes], [[], null, 0, undefined])
  })

  await check('sectionChordLine y songChordChart: acordes por seccion, nunca la letra', () => {
    assert.equal(sectionChordLine(SONG.sections[1].chordpro), 'C#m A | E | B')
    assert.equal(sectionChordLine(SONG.sections[3].chordpro), 'E B/D# C#m7', '[Coro] no es un acorde')
    assert.equal(sectionChordLine('Solo letra'), '')
    const long = Array.from({ length: 200 }, (_, i) => `[${i % 2 ? 'Am' : 'F'}]la`).join(' ')
    const cut = sectionChordLine(long)
    assert.ok(cut.length <= 400 && cut.endsWith('...'), cut.slice(-20))
    const chart = songChordChart(SONG)
    assert.ok(chart)
    assert.deepEqual(chart.sections.map((s) => [s.label, s.startBar, s.bars, s.chords]), [
      ['Intro', 1, 4, 'C#m A E B'],
      ['Estrofa 1', 5, 8, 'C#m A | E | B'],
      ['Hablado', 13, 2, ''],
      ['Coro', 15, 8, 'E B/D# C#m7'],
    ])
    assert.equal(chart.key, 'C#m')
    const text = JSON.stringify(chart)
    for (const lyric of ['vuelvo', 'casa', 'noche', 'sigo', 'Canta', 'fuerte', 'Solo letra', 'suave']) assert.ok(!text.includes(lyric), `sin letra: ${lyric}`)
    assert.equal(songChordChart({ ...SONG, sections: [SONG.sections[2]] }), null, 'sin acordes no hay progresion')
    assert.equal(songChordChart(null), null)
  })

  await check('sessionChordsForSummary: los mas cercanos al cabezal, en orden de beat', () => {
    const chords = Array.from({ length: 10 }, (_, i) => ({ beat: i * 4, lengthBeats: 4, name: `C${i}` }))
    assert.deepEqual(sessionChordsForSummary(chords, 0, 3), [[0, 4, 'C0'], [4, 4, 'C1'], [8, 4, 'C2']])
    assert.deepEqual(sessionChordsForSummary(chords, 21, 3).map((c) => c[2]), ['C4', 'C5', 'C6'])
    assert.deepEqual(sessionChordsForSummary(undefined, 0), [])
    assert.deepEqual(sessionChordsForSummary(chords, 0, 0), [])
  })

  await check('mixForSummary: fresca con la misma version del documento; vieja si cambio', () => {
    const m = { metrics: METRICS, version: 7, measuredAt: 1 }
    const fresh = mixForSummary(m, 7)
    assert.deepEqual(fresh?.mixMeasured, { fresh: true, masterLufs: -15.2, masterTruePeakDb: -1.1 })
    assert.deepEqual(fresh?.byTrack.get('trk_1'), { lufs: -18.4, truePeakDb: -3.2, bands: METRICS.tracks[0].bands, volumeDb: 0 })
    assert.equal(mixForSummary(m, 8)?.mixMeasured.fresh, false)
    assert.equal(mixForSummary(null, 1), null)
  })

  console.log('jobs.ts: resumen enriquecido y tope de 32 KB')

  await check('buildSessionSummary: digest por clip, acordes, progresion y medicion; al cable en snake_case', () => {
    const session = fixtureSession()
    const summary = buildSessionSummary(session, VIEW, 64, { extras: { song: SONG, mix: { measurement: { metrics: METRICS, version: 3, measuredAt: 1 }, version: 4 } } })
    const wire = sessionSummaryToWire(summary) as Record<string, unknown> & { tracks: Array<Record<string, unknown>> }
    assert.deepEqual(wire.chords, [[0, 4, 'C#m'], [4, 4, 'A'], [8, 4, 'E'], [12, 4, 'B']])
    assert.deepEqual((wire.song_chart as { sections: unknown[] }).sections[0], { label: 'Intro', kind: 'intro', start_bar: 1, bars: 4, chords: 'C#m A E B' })
    assert.deepEqual(wire.mix_measured, { fresh: false, master_lufs: -15.2, master_true_peak_db: -1.1 })
    const voz = wire.tracks.find((t) => t.id === 'trk_1')!
    assert.deepEqual(voz.mix, { lufs: -18.4, true_peak_db: -3.2, bands: { low_db: -14, low_mid_db: -3, high_mid_db: -6, high_db: -15 }, volume_db: 0 })
    assert.ok(!('mix' in wire.tracks.find((t) => t.id === 'trk_2')!), 'pista sin medicion: sin mix')
    const drumClip = (wire.tracks.find((t) => t.id === 'trk_3')!.midi_clips as Array<{ digest: Record<string, unknown> }>)[0]
    assert.deepEqual(drumClip.digest.pitch_classes, [])
    assert.ok(Array.isArray(drumClip.digest.hits))
    assert.deepEqual(Object.keys(wire).slice(-4), ['chords', 'song_chart', 'mix_measured', 'master'])

    // Sin extras ni acordes, el resumen es el de siempre (mas el digest).
    const bare = sessionSummaryToWire(buildSessionSummary({ ...session, chords: undefined }, VIEW)) as Record<string, unknown>
    assert.deepEqual(Object.keys(bare), ['title', 'bpm', 'beats_per_bar', 'key', 'length_s', 'playhead_beat', 'selection', 'tracks', 'markers', 'master'])
  })

  await check('fitSessionSummary: primero quita las notas literales, despues clips lejanos, despues acordes y la progresion', () => {
    const base = fixtureSession()
    const pad = trackById(base, 'trk_2')
    // 64 clips de 60 notas cada uno en 4 pistas: con literales no cabe; sin literales, si.
    const clips = Array.from({ length: 64 }, (_, i) => clip(`mid_x${i}`, i * 4, 4, Array.from({ length: 60 }, (_, k) => note(48 + (k % 24), (k * 4) / 60, 0.05))))
    const mid = { ...base, tracks: [...base.tracks.filter((t) => t.id !== 'trk_2'), ...[1, 2, 3, 4].map((n) => ({ ...pad, id: `trk_p${n}`, midiClips: clips }))] }
    assert.ok(sessionSummaryBytes(buildSessionSummary(mid, VIEW)) > CHAT_SUMMARY_MAX_BYTES)
    const fitted = fitSessionSummary(mid, VIEW)
    assert.ok(sessionSummaryBytes(fitted) <= CHAT_SUMMARY_MAX_BYTES)
    const fittedPad = fitted.tracks.find((t) => t.id === 'trk_p1')!
    assert.ok(fittedPad.midiClips.every((c) => c.digest && c.digest.notes === undefined), 'sin notas literales')
    const keptClips = fittedPad.midiClips.length
    assert.ok(keptClips > 0, 'todavia hay clips')
    // El cabezal esta en el beat 16: el clip de ese beat queda siempre.
    assert.ok(fittedPad.midiClips.some((c) => c.id === 'mid_x4'))

    // 16 pistas con 64 clips: ni sin literales cabe con 64 clips -> baja los clips.
    const huge = { ...base, tracks: Array.from({ length: 16 }, (_, n) => ({ ...pad, id: `trk_h${n}`, midiClips: clips })) }
    const fittedHuge = fitSessionSummary(huge, VIEW)
    assert.ok(sessionSummaryBytes(fittedHuge) <= CHAT_SUMMARY_MAX_BYTES)
    assert.ok(fittedHuge.tracks[0].midiClips.length < 64)

    // 2048 acordes guardados y una progresion larga: los acordes bajan antes que la progresion.
    const chords = Array.from({ length: 2048 }, (_, i) => ({ beat: i + 0.125, lengthBeats: 0.875, name: 'C#m7(b5,add11)' }))
    const bigSong: Song = {
      ...SONG,
      sections: Array.from({ length: 48 }, (_, i) => ({ id: `s${i}`, kind: 'verse' as const, label: `Parte ${i} `.padEnd(60, 'x'), bars: 4, chordpro: Array.from({ length: 80 }, () => '[C#m7] [F#m9]').join(' ') })),
    }
    // Sin clips (todos de audio) que recortar: lo que sobra se quita de los acordes primero.
    const noMidi = { ...base, tracks: base.tracks.map((t) => ({ ...t, midiClips: [] })), chords }
    assert.ok(sessionSummaryBytes(buildSessionSummary(noMidi, VIEW, 64, { extras: { song: bigSong } })) > CHAT_SUMMARY_MAX_BYTES)
    const fc = fitSessionSummary(noMidi, VIEW, { song: bigSong })
    assert.ok(sessionSummaryBytes(fc) <= CHAT_SUMMARY_MAX_BYTES, String(sessionSummaryBytes(fc)))
    assert.ok((fc.chords?.length ?? 0) <= 64, 'los acordes bajan a 64 o a ninguno')
    assert.ok(fc.songChart || !fc.chords, 'la progresion se quita solo despues de los acordes')
    // Con clips que recortar, los clips lejanos se van antes que los acordes.
    const fcClips = fitSessionSummary({ ...huge, chords }, VIEW, { song: SONG })
    assert.equal(fcClips.chords?.length, 256)
    const plain = fitSessionSummary({ ...base, chords }, VIEW, { song: SONG })
    assert.equal(plain.chords?.length, 256, 'si cabe, van 256 acordes')
    assert.ok(plain.songChart, 'y la progresion')
  })

  await check('analysisToChords: ventana del clip, offset y tempo de la sesion', () => {
    const analysis: StudioAnalysis = {
      bpm: 120,
      key: 'C#m',
      beatsPerBar: 4,
      downbeatS: 0,
      markers: [],
      chords: [
        { startS: 0, endS: 2, name: 'C#m' },
        { startS: 2, endS: 4, name: 'A' },
        { startS: 4, endS: 6, name: 'E' },
        { startS: 6, endS: 9, name: 'B' },
      ],
    }
    // El clip empieza en el segundo 10 de la sesion, toma el audio desde el segundo 2 y dura 5 s.
    const chords = analysisToChords(analysis, { clipStartS: 10, clipOffsetS: 2, clipLengthS: 5, bpm: 120 })
    assert.deepEqual(chords, [
      { beat: 20, lengthBeats: 4, name: 'A' },
      { beat: 24, lengthBeats: 4, name: 'E' },
      { beat: 28, lengthBeats: 2, name: 'B' },
    ])
    // Con otro tempo, mismos segundos: los beats cambian.
    assert.deepEqual(analysisToChords(analysis, { clipStartS: 0, clipOffsetS: 0, clipLengthS: null, bpm: 60 })[3], { beat: 6, lengthBeats: 3, name: 'B' })
  })

  console.log('session.ts y sessionOps.ts: acordes del documento (2.9)')

  await check('chords: el fixture vuelve identico; vacio quita la clave; setChords ordena, acota y es un paso', () => {
    const session = fixtureSession()
    assert.equal(session.chords?.length, 4)
    assert.deepEqual(serializeSession(session), sessionFixtureV2)
    const cleared = setChords(session, { chords: [] })
    assert.ok(!('chords' in cleared))
    assert.ok(!('chords' in serializeSession(cleared)))
    const set = setChords(cleared, { chords: [{ beat: 8, lengthBeats: 4, name: ' E ' }, { beat: 0, lengthBeats: 4.0000001, name: 'C#m' }] })
    assert.deepEqual(set.chords, [{ beat: 0, lengthBeats: 4, name: 'C#m' }, { beat: 8, lengthBeats: 4, name: 'E' }])
    assert.equal(setChords(set, { chords: set.chords! }), set, 'sin cambios devuelve la misma sesion')
    assert.throws(() => setChords(set, { chords: [{ beat: 0, lengthBeats: 4, name: '' }] }), (e: unknown) => e instanceof StudioSessionError && e.code === 'out_of_range')
    assert.throws(() => setChords(set, { chords: [{ beat: 2399, lengthBeats: 4, name: 'C' }] }), (e: unknown) => e instanceof StudioSessionError && e.code === 'session_too_long')
    const raw = structuredClone(sessionFixtureV2) as Record<string, unknown>
    ;(raw.chords as Array<Record<string, unknown>>)[0].lyrics = 'la'
    assert.throws(() => parseSession(raw), (e: unknown) => e instanceof StudioSessionError && e.code === 'unknown_field' && e.path === 'chords[0].lyrics')
  })

  console.log('noteReview.ts: revision local antes de aplicar')

  await check('reviewNoteCall: fuera de tonalidad con cuenta y porcentaje', () => {
    const session = fixtureSession()
    // C#m: D (62) y F (65) estan fuera; C# (61) y E (64) dentro.
    const warnings = reviewNoteCall('add_midi_clip', { track_id: 'trk_2', start_beat: 64, length_beats: 4, notes: [note(61, 0), note(62, 1), note(64, 2), note(65, 3)] }, session)
    assert.equal(warnings.length, 1, warnings.join(' | '))
    assert.equal(warnings[0], '2 de 4 notas (50 %) quedan fuera de la tonalidad C#m (D, F).')
    assert.deepEqual(reviewNoteCall('add_midi_clip', { track_id: 'trk_2', start_beat: 64, length_beats: 4, notes: [note(61, 0), note(64, 1)] }, session), [])
    assert.deepEqual(reviewNoteCall('add_midi_clip', { track_id: 'trk_2', start_beat: 64, length_beats: 4, notes: [note(62, 0)] }, { ...session, key: null }), [], 'sin tonalidad no hay aviso')
    assert.deepEqual(reviewNoteCall('set_track_mix', { track_id: 'trk_2' }, session), [])
  })

  await check('reviewNoteCall: choque de registro con otra pista MIDI en el mismo tramo', () => {
    const session = fixtureSession()
    // El pad (trk_2) suena C#4, E4 y G#4 entre los beats 16 y 24. Un clip en trk_4 (sampler
    // 48..72) en el beat 16 con notas de 56 a 68 comparte registro.
    const clash = reviewNoteCall('add_midi_clip', { track_id: 'trk_4', start_beat: 16, length_beats: 8, notes: [note(56, 0), note(61, 1), note(68, 2)] }, session)
    assert.deepEqual(clash, ['Comparte registro con "Pad" (C#4 a G#4) entre los compases 5 y 6: estas notas van de G#3 a G#4 y pueden taparse.'])
    // Mas grave, sin superposicion: sin aviso de choque.
    const low = reviewNoteCall('add_midi_clip', { track_id: 'trk_4', start_beat: 16, length_beats: 8, notes: [note(49, 0), note(52, 1)] }, session)
    assert.ok(!low.some((w) => w.startsWith('Comparte')), low.join(' | '))
    // En otro tramo (el pad no suena en el beat 64): sin aviso.
    assert.ok(!reviewNoteCall('add_midi_clip', { track_id: 'trk_4', start_beat: 64, length_beats: 8, notes: [note(56, 0), note(68, 2)] }, session).some((w) => w.startsWith('Comparte')))
    // Una pista con mute no cuenta.
    const muted = { ...session, tracks: session.tracks.map((t) => (t.id === 'trk_2' ? { ...t, mute: true } : t)) }
    assert.ok(!reviewNoteCall('add_midi_clip', { track_id: 'trk_4', start_beat: 16, length_beats: 8, notes: [note(56, 0), note(68, 2)] }, muted).some((w) => w.startsWith('Comparte')))
  })

  await check('reviewNoteCall: rango util (bajo), bateria fuera del mapa GM, sampler sin muestra, transponer', () => {
    const session = fixtureSession()
    const bass = { ...session, tracks: session.tracks.map((t) => (t.id === 'trk_2' ? { ...t, role: 'bass' as const, midiClips: [] } : t)) }
    const w = reviewNoteCall('add_midi_clip', { track_id: 'trk_2', start_beat: 64, length_beats: 4, notes: [note(37, 0), note(73, 1)] }, bass)
    assert.ok(w.includes('1 de 2 notas quedan fuera del rango útil de un bajo (E1 a G4): C#5.'), w.join(' | '))
    const drums = reviewNoteCall('add_midi_clip', { track_id: 'trk_3', start_beat: 64, length_beats: 4, notes: [note(36, 0), note(60, 1)] }, session)
    assert.deepEqual(drums, ['1 de 2 notas no son golpes de la caja de ritmos (General MIDI 35 a 59): no van a sonar.'])
    const sampler = reviewNoteCall('replace_midi_notes', { clip_id: 'mid_s1', notes: [note(61, 0), note(80, 1)] }, session)
    assert.ok(sampler.includes('1 de 2 notas no tienen muestra en el sampler: no van a sonar.'), sampler.join(' | '))
    // Transponer el pad 1 semitono: D, F, A, A#, D, F; A esta en C#m, las otras 5 no.
    const up1 = reviewNoteCall('transpose_midi_clip', { clip_id: 'mid_p1', semitones: 1 }, session)
    assert.equal(up1[0], '5 de 6 notas (83 %) quedan fuera de la tonalidad C#m (D, F, A#).')
    assert.ok(!reviewNoteCall('transpose_midi_clip', { clip_id: 'mid_p1', semitones: 12 }, session).some((w2) => w2.includes('tonalidad')))
  })

  await check('prepareToolCalls agrega warnings a los pendientes; el resultado aplicado se los cuenta al modelo', async () => {
    const session = fixtureSession()
    type Ctx = { session: StudioSession }
    const registry = createCommandRegistry<Ctx>()
    for (const spec of STUDIO_COMMAND_SPECS) {
      if (!spec.assistantAllowed) continue
      registry.register({ ...spec, run: () => {} })
    }
    const calls: StudioChatToolCall[] = [
      { id: 'call_1', name: 'add_midi_clip', arguments: { track_id: 'trk_2', start_beat: 64, length_beats: 4, notes: [note(62, 0)] }, signature: null },
      { id: 'call_2', name: 'add_midi_clip', arguments: { track_id: 'trk_2', start_beat: 64, length_beats: 4, notes: [note(61, 0)] }, signature: null },
    ]
    const pend = prepareToolCalls(calls, registry, session)
    assert.deepEqual(pend[0].warnings, ['1 de 1 nota (100 %) quedan fuera de la tonalidad C#m (D).'])
    assert.equal(pend[1].warnings, undefined)
    const applied = await applyPendingCommand(pend[0], registry, { session })
    assert.match(applied.message, /Avisos de la revisión: 1 de 1 nota/)
  })

  console.log('Escuchar a pedido (4.3.5): forma del mensaje')

  await check('appendUserMessage con fragmento, chatRequestProblem y el cable', () => {
    const msgs = appendUserMessage([], ' Escucha el coro ', { assetId: 'ast_frag1', durationS: 30 })
    assert.deepEqual(msgs, [{ role: 'user', text: 'Escucha el coro', audio: { assetId: 'ast_frag1', durationS: 30 } }])
    const summary = buildSessionSummary(fixtureSession(), VIEW)
    assert.equal(chatRequestProblem({ kind: 'chat', messages: msgs, sessionSummary: summary }), null)
    assert.match(chatRequestProblem({ kind: 'chat', messages: [{ role: 'user', text: 'x', audio: { assetId: 'ast_frag1', durationS: 31 } }], sessionSummary: summary }) ?? '', /hasta 30 s/)
    assert.match(chatRequestProblem({ kind: 'chat', messages: [{ role: 'user', text: 'x', audio: { assetId: 'a b', durationS: 3 } }], sessionSummary: summary }) ?? '', /id válido/)
    const wire = jobRequestV2ToWire({ kind: 'chat', messages: msgs, sessionSummary: summary }) as { messages: unknown[] }
    assert.deepEqual(wire.messages[0], { role: 'user', text: 'Escucha el coro', audio: { asset_id: 'ast_frag1', duration_s: 30 } })
    assert.deepEqual(appendUserMessage([], 'hola'), [{ role: 'user', text: 'hola' }], 'sin fragmento no hay clave audio')
  })

  console.log(`\n${passed} ok, ${failures.length} con falla`)
  if (failures.length > 0) process.exit(1)
}

void main()
