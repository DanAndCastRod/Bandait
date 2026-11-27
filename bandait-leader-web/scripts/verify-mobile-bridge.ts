/**
 * Verificacion de la ola movil: metronomo de bolsillo (programador con anticipacion), tap tempo,
 * pad X/Y relativo, puente Estudio -> Cancion (diff completo, letras en riesgo) y la clave de
 * metadatos de MediaSession.
 *   node --experimental-strip-types --no-warnings scripts/verify-mobile-bridge.ts
 */
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import type { Song } from '../src/types/hub.ts'
import {
  POCKET_LOOKAHEAD_S,
  POCKET_START_DELAY_S,
  linearRegressionTapBpm,
  schedulePocketWindow,
  startPocketCursor,
  type PocketClick,
  type PocketCursor,
} from '../src/services/pocketMetronome.ts'
import { mediaMetadataKey } from '../src/services/mediaSessionSync.ts'
import { parseSession, STUDIO_MASTER_ID, type StudioFx, type StudioSession } from '../src/services/studio/session.ts'
import { setTrackFx } from '../src/services/studio/sessionOps.ts'
import { chordNamesOf, formatDurationSec, lyricTextOf, songToStudioSeed, studioToSongPatch } from '../src/services/studio/songStudioBridge.ts'
import { applyXyMacro, XY_RANGE, type PutFx } from '../src/services/studio/xyMacro.ts'

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err instanceof Error ? err.message : String(err)}`)
  }
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

/** Corre el programador como lo haria el temporizador (cada `stepS`) hasta `untilS`. */
function runScheduler(
  startNow: number,
  untilS: number,
  stepS: number,
  bpmAt: (now: number) => number,
  beatsPerBar = 4,
): PocketClick[] {
  let cursor: PocketCursor = startPocketCursor(startNow)
  const out: PocketClick[] = []
  for (let now = startNow; now < untilS; now += stepS) {
    const r = schedulePocketWindow(cursor, now, bpmAt(now), beatsPerBar)
    out.push(...r.clicks)
    cursor = r.cursor
  }
  return out
}

console.log('verify-mobile-bridge')

check('metronomo: golpes equiespaciados en el reloj del AudioContext, sin repetir ni saltar', () => {
  const clicks = runScheduler(10, 14, 0.025, () => 120)
  assert.ok(clicks.length >= 7, `pocos golpes: ${clicks.length}`)
  assert.ok(near(clicks[0].time, 10 + POCKET_START_DELAY_S), 'el primero cae tras el margen de arranque')
  for (let i = 1; i < clicks.length; i++) {
    assert.ok(near(clicks[i].time - clicks[i - 1].time, 0.5), `periodo ${clicks[i].time - clicks[i - 1].time}`)
    assert.equal(clicks[i].beat, i % 4)
  }
  assert.deepEqual(
    clicks.map((c) => c.accent),
    clicks.map((_, i) => i % 4 === 0),
    'acento en el 1 de cada compas',
  )
})

check('metronomo: un temporizador irregular (llega tarde) no mueve los golpes', () => {
  // Despertares a 25 ms y a 90 ms (menos que la ventana de 100 ms): mismos tiempos.
  const regular = runScheduler(0, 3, 0.025, () => 100)
  const irregular = runScheduler(0, 3, 0.09, () => 100)
  const common = Math.min(regular.length, irregular.length) - 1
  assert.ok(common > 3)
  for (let i = 0; i < common; i++) assert.ok(near(regular[i].time, irregular[i].time), `golpe ${i}`)
})

check('metronomo: nunca programa en el pasado y la ventana es de ~100 ms', () => {
  const r = schedulePocketWindow({ nextTime: 5, beat: 0 }, 5, 240, 4)
  for (const c of r.clicks) assert.ok(c.time >= 5 && c.time < 5 + POCKET_LOOKAHEAD_S)
  assert.equal(r.clicks.length, 1, '240 BPM = 250 ms: un golpe por ventana')
})

check('metronomo: cambiar el tempo sonando no reinicia ni desfasa', () => {
  const clicks = runScheduler(0, 4, 0.025, (now) => (now < 2 ? 120 : 60))
  const gaps = clicks.slice(1).map((c, i) => Math.round((c.time - clicks[i].time) * 1000))
  assert.ok(gaps.includes(500) && gaps.includes(1000), `periodos: ${gaps.join(',')}`)
  assert.ok(gaps.every((g) => g === 500 || g === 1000), 'ningun periodo raro en el cambio')
  for (let i = 1; i < clicks.length; i++) assert.equal(clicks[i].beat, i % 4, 'la cuenta del compas sigue')
})

check('metronomo: pestana congelada -> se saltan los golpes perdidos, sin rafaga', () => {
  const r = schedulePocketWindow({ nextTime: 1, beat: 1 }, 6.02, 120, 4)
  assert.ok(r.clicks.length <= 1, `rafaga de ${r.clicks.length}`)
  for (const c of r.clicks) assert.ok(c.time >= 6.02)
  // 10 golpes perdidos (1.0 .. 5.5) + el del 6.0: la cuenta sigue en fase.
  assert.ok(near(r.cursor.nextTime % 0.5, 0, 1e-9) || near(r.cursor.nextTime % 0.5, 0.5, 1e-9))
})

check('metronomo: cambiar el compas sonando reacomoda la cuenta', () => {
  const r = schedulePocketWindow({ nextTime: 2, beat: 5 }, 2, 120, 3)
  assert.equal(r.clicks[0].beat, 2, '5 mod 3')
})

check('tap tempo: regresion lineal estable y rechazo de toques absurdos', () => {
  assert.equal(linearRegressionTapBpm([0, 500, 1000, 1500, 2000]), 120)
  const jitter = linearRegressionTapBpm([0, 498, 1003, 1499, 2001])
  assert.ok(jitter !== null && near(jitter, 120, 0.5), `con +-3 ms de error: ${jitter}`)
  assert.equal(linearRegressionTapBpm([0]), null)
  assert.equal(linearRegressionTapBpm([0, 50, 100]), null)
})

// ---- pad X/Y ----

const FX_ORDER = ['eq', 'compressor', 'de_esser', 'saturator', 'stereo_imager', 'limiter']
const putFx: PutFx = (session, targetId, fx) => {
  const chain = targetId === STUDIO_MASTER_ID ? session.master.fx : session.tracks.find((t) => t.id === targetId)?.fx ?? []
  const next: StudioFx[] = chain.slice()
  const at = next.findIndex((f) => f.type === fx.type)
  if (at >= 0) next[at] = fx
  else {
    const before = next.findIndex((f) => FX_ORDER.indexOf(f.type) > FX_ORDER.indexOf(fx.type))
    next.splice(before >= 0 ? before : next.length, 0, fx)
  }
  return setTrackFx(session, { trackId: targetId, fx: next })
}

function baseSession(): StudioSession {
  return parseSession(structuredClone(sessionFixtureV2))
}

check('pad X/Y: tocar sin mover no cambia nada (no inserta efectos)', () => {
  const base = baseSession()
  for (const mode of ['warmth_air', 'dry_space', 'vox_band'] as const) {
    assert.equal(applyXyMacro(base, mode, 0, 0, putFx), base, mode)
  }
})

check('pad X/Y calidez: solo drive y agudos, en relativo; el resto de la cadena intacto', () => {
  let base = baseSession()
  base = putFx(base, STUDIO_MASTER_ID, {
    type: 'eq',
    bypass: false,
    params: { lowDb: 3, midDb: -2, midHz: 900, midQ: 1, highDb: 1.5 },
  } as unknown as StudioFx)
  const before = JSON.stringify(base)
  const next = applyXyMacro(base, 'warmth_air', 0.25, 0.5, putFx)
  assert.equal(JSON.stringify(base), before, 'la base no se muta')
  const eq = next.master.fx.find((f) => f.type === 'eq') as unknown as { params: Record<string, number> }
  assert.equal(eq.params.lowDb, 3, 'graves del usuario intactos')
  assert.equal(eq.params.midDb, -2)
  assert.ok(near(eq.params.highDb, Math.round((1.5 + 0.5 * XY_RANGE.highDb) * 10) / 10))
  const sat = next.master.fx.find((f) => f.type === 'saturator') as unknown as { params: Record<string, number> }
  assert.ok(sat, 'inserta el saturador porque el gesto lo movio')
  assert.ok(near(sat.params.driveDb, Math.round(0.25 * XY_RANGE.driveDb * 10) / 10))
  assert.ok(next.master.fx.some((f) => f.type === 'limiter'), 'el limitador sigue')
  assert.equal(next.master.fx[next.master.fx.length - 1].type, 'limiter', 'y de ultimo')
  // Volver al punto de partida devuelve los mismos valores (sin error acumulado).
  const back = applyXyMacro(base, 'warmth_air', 0, 0, putFx)
  assert.equal(back, base)
})

check('pad X/Y reverb: deltas sobre la reverb actual, con limites', () => {
  const base = baseSession()
  const next = applyXyMacro(base, 'dry_space', 0.5, -0.25, putFx)
  assert.ok(near(next.master.reverb.decayS, Math.round((1.8 + 0.5 * XY_RANGE.decayS) * 100) / 100))
  assert.ok(near(next.master.reverb.returnDb, -8))
  const extreme = applyXyMacro(base, 'dry_space', -1, -1, putFx)
  assert.ok(extreme.master.reverb.decayS >= 0.2)
})

check('pad X/Y banda/voz: cada pista desde su volumen (mezcla relativa conservada)', () => {
  const base = baseSession()
  const next = applyXyMacro(base, 'vox_band', 0.25, 0.5, putFx)
  const vol = (s: StudioSession, id: string) => s.tracks.find((t) => t.id === id)!.volumeDb
  assert.equal(vol(next, 'trk_1'), 0 + 4, 'voz +4 dB')
  assert.equal(vol(next, 'trk_2'), -6 + 2, 'teclado -6 -> -4')
  assert.equal(vol(next, 'trk_3'), -3 + 2)
  assert.equal(vol(next, 'trk_2') - vol(next, 'trk_3'), vol(base, 'trk_2') - vol(base, 'trk_3'), 'diferencia relativa intacta')
})

// ---- puente Estudio -> Cancion ----

const song: Song = {
  id: 'song_bridge',
  title: 'Horizonte',
  artist: 'Bandait',
  bpm: 110,
  beatsPerBar: 4,
  beatUnit: 4,
  key: 'G',
  durationSec: 200,
  sections: [
    { id: 'sec_i', kind: 'intro', label: 'Intro', bars: 4, chordpro: '[G] [D] [Em] [C]' },
    { id: 'sec_c', kind: 'chorus', label: 'Coro', bars: 8, chordpro: '[C]Canta [G]fuerte [D]hoy' },
    { id: 'sec_p', kind: 'bridge', label: 'Puente', bars: 4, chordpro: 'Solo letra del puente' },
  ],
  updatedAt: '2026-11-26T00:00:00.000Z',
}

check('lyricTextOf / chordNamesOf separan letra y acordes', () => {
  assert.equal(lyricTextOf('[G] [D] [%] | [Em]'), '')
  assert.equal(lyricTextOf('[C]Canta [G]fuerte'), 'Canta  fuerte')
  assert.deepEqual(chordNamesOf('{c: x}\n[C]Canta [G]fuerte [%]'), ['C', 'G'])
  assert.equal(formatDurationSec(200), '3:20')
  assert.equal(formatDurationSec(null), '—')
})

check('puente: acordes nuevos en seccion solo-acordes se aplican; en letra con acordes se conservan y se avisa', () => {
  const base = baseSession()
  const seed = songToStudioSeed(song)
  // Se cambian todos los acordes del Estudio por Am (intro y coro).
  const chords = seed.chords.map((c) => ({ ...c, name: 'Am' }))
  const session = { ...base, songId: song.id, markers: seed.markers, chords }
  const preview = studioToSongPatch(song, session)
  const intro = preview.updatedSong.sections.find((s) => s.id === 'sec_i')!
  assert.deepEqual(chordNamesOf(intro.chordpro).every((n) => n === 'Am'), true, 'intro reescrita')
  assert.ok(preview.chordsUpdated.includes('Intro'))
  const coro = preview.updatedSong.sections.find((s) => s.id === 'sec_c')!
  assert.equal(coro.chordpro, '[C]Canta [G]fuerte [D]hoy', 'la letra con acordes no se toca')
  assert.ok(preview.chordsKept.includes('Coro'))
  assert.ok(preview.summary.some((l) => l.startsWith('Acordes NO aplicados')), 'el diff lo dice')
})

check('puente: secciones sin marcador con letra se listan; la duracion sale en el diff', () => {
  const base = baseSession()
  const seed = songToStudioSeed(song)
  const session = { ...base, songId: song.id, markers: seed.markers.slice(0, 2), chords: seed.chords }
  const preview = studioToSongPatch(song, session)
  assert.deepEqual(
    preview.lyricsRemoved.map((s) => s.id),
    ['sec_p'],
    'el puente (solo letra) se iria con su letra',
  )
  assert.ok(preview.summary.some((l) => l.includes('CON SU LETRA') && l.includes('Puente')))
  if (preview.durationChanged) {
    assert.ok(preview.summary.some((l) => l.startsWith('Duración: 3:20 -> ')), 'duracion en el diff')
    assert.equal(preview.changed, true)
  }
})

check('puente: dos marcadores con la misma etiqueta no comparten id de seccion', () => {
  const base = baseSession()
  const two: Song = { ...song, sections: [{ id: 'sec_x', kind: 'chorus', label: 'Coro', bars: 4, chordpro: '[C]' }] }
  const markers = [
    { id: 'm1', beat: 0, label: 'Coro', kind: 'chorus' as const },
    { id: 'm2', beat: 16, label: 'Coro', kind: 'chorus' as const },
  ]
  const preview = studioToSongPatch(two, { ...base, songId: two.id, markers, chords: [] })
  const ids = preview.updatedSong.sections.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, `ids repetidos: ${ids.join(',')}`)
  assert.equal(ids[0], 'sec_x')
})

check('mediaMetadataKey: el progreso a 4 Hz no recrea los metadatos', () => {
  const a = mediaMetadataKey({ title: 'Tema', subtitle: 'Ensayo', playing: true, progress: 0.1, source: 'stems', view: 'rehearsal' })
  const b = mediaMetadataKey({ title: 'Tema', subtitle: 'Ensayo', playing: false, progress: 0.7, source: 'stems', view: 'rehearsal' })
  const c = mediaMetadataKey({ title: 'Otro', subtitle: 'Ensayo', playing: true, progress: 0.1, source: 'stems', view: 'rehearsal' })
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(mediaMetadataKey(null), null)
})

console.log(`\n${passed} ok, ${failures.length} fallas`)
if (failures.length > 0) process.exit(1)
