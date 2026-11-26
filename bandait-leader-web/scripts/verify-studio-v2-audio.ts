/**
 * Verificacion de la logica pura de instrumentos y motor del Estudio v2:
 *   node --experimental-strip-types --no-warnings scripts/verify-studio-v2-audio.ts
 *
 * Cubre lo que no tenia prueba al cierre del v2 (2026-11-19):
 *   - instruments/core.ts: frecuencias, ganancia por velocidad, Q del filtro, envolventes, robo de
 *     voz, ruido con semilla, notas que suenan en un tramo (con repeticion, chase y corte), fin de
 *     los clips MIDI, caja de ritmos, sampler, igualdad de clips MIDI, pistas que cambiaron y cola
 *     de los instrumentos;
 *   - instruments/schedule.ts (frozenPlaybackSession), factory.ts y wamHost.ts (disponibilidad);
 *   - engine.ts: alcance de la reprogramacion en caliente, espera para soltar las notas de un tramo
 *     terminado, posicion de parada con la cola, clic, picos y potencia media;
 *   - smf.ts (compas de un .mid en negras), jobs.ts (marcas del analisis con un tempo nuevo),
 *     midiInput.ts (cierre del puerto y teclado musical en dialogos) y assistantTools.ts
 *     (APLICAR TODOS no toca lo destructivo).
 *
 * Nada de esto toca la red, el navegador, Web Audio ni datos reales.
 */
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import { parseSession, sessionEndSeconds, type DrumsParams, type StudioMidiClip, type StudioSession, type StudioMarker } from '../src/services/studio/session.ts'
import {
  ENVELOPE_MIN_ATTACK_S,
  ENVELOPE_TAIL_FACTOR,
  FILTER_MAX_HZ,
  FILTER_MIN_HZ,
  NOISE_SECONDS,
  WAM_TAIL_S,
  adsrFromMs,
  biquadQ,
  clipNoteSpans,
  drumChokes,
  drumDecayS,
  drumHitGain,
  drumHitSeconds,
  drumLanes,
  drumParam,
  drumTuneRatio,
  envelopeLevelAt,
  envelopeSilentAfterS,
  envelopeTau,
  fillNoise,
  filterEnvelopeCents,
  instrumentKey,
  instrumentTailSeconds,
  midiChangedTrackIds,
  midiClipsEqual,
  midiEndSeconds,
  mulberry32,
  noiseOffsetS,
  noteFrequency,
  oscillatorFrequency,
  pickVoiceToSteal,
  planMidiNotes,
  samplerPlaybackRate,
  samplerZonesFor,
  velocityGain,
} from '../src/services/studio/instruments/core.ts'
import { frozenPlaybackSession } from '../src/services/studio/instruments/schedule.ts'
import { EMPTY_PREPARATION, instrumentAvailability, needsPreparation } from '../src/services/studio/instruments/factory.ts'
import { listPlugins, pluginAvailability } from '../src/services/studio/instruments/wamHost.ts'
import {
  DEFAULT_CLICK,
  FULL_RESCHEDULE,
  assetsInUse,
  batchInScope,
  combineScheduled,
  finishedSegmentReleaseMs,
  meanSquareOf,
  mergeScope,
  normalizeClick,
  peakOf,
  playbackStopS,
  scopeIsEmpty,
} from '../src/services/studio/engine.ts'
import { beatsPerBarFromSignature, parseSmf, writeSmf } from '../src/services/studio/smf.ts'
import { rebeatMarkers, soundingClipNotes } from '../src/services/studio/jobs.ts'
import { bounceRange, bounceTrackIds } from '../src/services/studio/bounce.ts'
import { trackHasSound } from '../src/services/studio/graph.ts'
import { toggleClipsActive } from '../src/services/studio/sessionOps.ts'
import { FADER_MARKS, dbToFader, faderToDb, ledLitCount, ledSegmentCount, ledZone } from '../src/services/studio/faderScale.ts'
import { StudioMidiInput, isInsideDialog, type MidiAccessLike, type MidiInputPortLike } from '../src/services/studio/midiInput.ts'
import { DESTRUCTIVE_TOOLS, bulkApplicable, isDestructiveCommand, type PendingAssistantCommand } from '../src/services/studio/assistantTools.ts'
import type { ScheduledClips } from '../src/services/studio/types.ts'

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
  assert.ok(Math.abs(actual - expected) <= eps, `esperaba ${expected} (+-${eps}), obtuve ${actual}`)
}

function fixtureSession(): StudioSession {
  return parseSession(structuredClone(sessionFixtureV2))
}

function midiClip(partial: Partial<StudioMidiClip>): StudioMidiClip {
  return { id: 'mid_t', startBeat: 0, lengthBeats: 8, loop: false, loopBeats: 8, notes: [], ...partial }
}

async function main() {
  console.log('instruments/core.ts: frecuencias, ganancias y envolventes')

  await check('noteFrequency y oscillatorFrequency: La 440, octavas y cents', () => {
    close(noteFrequency(69), 440)
    close(noteFrequency(81), 880)
    close(noteFrequency(60), 261.6255653005986, 1e-9)
    close(oscillatorFrequency(69, -1, 0), 220)
    close(oscillatorFrequency(69, 0, 1200), 880)
    close(oscillatorFrequency(69, 1, -1200), 440)
  })

  await check('velocityGain: sensibilidad 0 da 1; 1 da velocity/127; valores fuera de rango se acotan', () => {
    assert.equal(velocityGain(1, 0), 1)
    close(velocityGain(127, 1), 1)
    close(velocityGain(64, 1), 64 / 127)
    close(velocityGain(64, 0.5), 1 - 0.5 * (1 - 64 / 127))
    close(velocityGain(500, 1), 1)
    close(velocityGain(Number.NaN, 1), 1 / 127)
  })

  await check('biquadQ: pasa bajos en dB (0.707 es -3 dB, 1 es 0 dB); pasa banda tal cual', () => {
    close(biquadQ('lowpass', 1), 0)
    close(biquadQ('highpass', Math.SQRT1_2), -3.0103, 1e-4)
    assert.equal(biquadQ('bandpass', 4), 4)
    assert.ok(Number.isFinite(biquadQ('lowpass', 0)), 'Q 0 no da -Infinity')
  })

  await check('filterEnvelopeCents: acota el barrido para que el corte quede en 20..20000 Hz', () => {
    assert.equal(filterEnvelopeCents(1000, 1), 1200)
    close(filterEnvelopeCents(10000, 4), 1200 * Math.log2(FILTER_MAX_HZ / 10000))
    close(filterEnvelopeCents(100, -8), 1200 * Math.log2(FILTER_MIN_HZ / 100))
    assert.equal(filterEnvelopeCents(1000, Number.NaN), 0)
  })

  await check('adsrFromMs, envelopeTau, envelopeLevelAt y envelopeSilentAfterS', () => {
    const env = adsrFromMs(0, 500, 0.5, 1000)
    assert.deepEqual(env, { attackS: ENVELOPE_MIN_ATTACK_S, decayS: 0.5, sustain: 0.5, releaseS: 1 }, 'ataque minimo de 1 ms')
    assert.deepEqual(adsrFromMs(-5, 99999, 2, -1), { attackS: ENVELOPE_MIN_ATTACK_S, decayS: 10, sustain: 1, releaseS: 0 })
    close(envelopeTau(1), 0.2)
    assert.equal(envelopeTau(0), 0.0001)
    const pad = adsrFromMs(100, 200, 0.5, 400)
    assert.equal(envelopeLevelAt(pad, -1, null), 0)
    close(envelopeLevelAt(pad, 0.05, null), 0.5, 1e-12)
    close(envelopeLevelAt(pad, 0.1, null), 1, 1e-12)
    close(envelopeLevelAt(pad, 10, null), 0.5, 1e-9)
    const releasing = envelopeLevelAt(pad, 1.4, 1)
    close(releasing, 0.5 * Math.exp(-0.4 / envelopeTau(0.4)), 1e-9)
    assert.ok(releasing < 0.01, 'al tiempo nominal de relajacion queda menos del 1 %')
    assert.equal(envelopeSilentAfterS(pad, null), Number.POSITIVE_INFINITY)
    close(envelopeSilentAfterS(pad, 2), 2 + 0.4 * ENVELOPE_TAIL_FACTOR)
    const pluck = adsrFromMs(1, 350, 0, 100)
    close(envelopeSilentAfterS(pluck, null), 0.001 + 0.35 * ENVELOPE_TAIL_FACTOR, 1e-12)
  })

  await check('pickVoiceToSteal: primero las voces en relajacion; despues la mas antigua; a igualdad, la mas suave', () => {
    assert.equal(pickVoiceToSteal([]), -1)
    const voices = [
      { startedAt: 1, releasedAt: null, velocity: 100 },
      { startedAt: 0.5, releasedAt: null, velocity: 80 },
      { startedAt: 2, releasedAt: 2.5, velocity: 50 },
    ]
    assert.equal(pickVoiceToSteal(voices), 2)
    assert.equal(pickVoiceToSteal(voices.slice(0, 2)), 1)
    assert.equal(pickVoiceToSteal([{ startedAt: 0, releasedAt: null, velocity: 100 }, { startedAt: 0, releasedAt: null, velocity: 90 }]), 1)
    assert.equal(pickVoiceToSteal([{ startedAt: 0, releasedAt: null, velocity: 90 }, { startedAt: 0, releasedAt: null, velocity: 90 }]), 0)
  })

  await check('ruido con semilla: misma semilla, misma serie; -1..1; desfase por voz dentro del bufer', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const seqA = [a(), a(), a()]
    assert.deepEqual(seqA, [b(), b(), b()])
    assert.ok(seqA.every((v) => v >= 0 && v < 1))
    assert.notEqual(mulberry32(43)(), seqA[0], 'otra semilla, otra serie')
    const x = new Float32Array(1000)
    const y = new Float32Array(1000)
    fillNoise(x)
    fillNoise(y)
    assert.deepEqual(x, y, 'determinista: tiempo real y exportacion suenan igual')
    assert.ok(x.every((v) => v >= -1 && v <= 1))
    assert.ok(x.some((v) => v < 0) && x.some((v) => v > 0))
    assert.equal(noiseOffsetS(60), noiseOffsetS(60))
    assert.notEqual(noiseOffsetS(60), noiseOffsetS(61))
    for (const seed of [0, 1, 60, 127, -3]) {
      const off = noiseOffsetS(seed)
      assert.ok(off >= 0 && off < NOISE_SECONDS - 0.1, `desfase ${off}`)
    }
  })

  console.log('instruments/core.ts: notas que suenan en un tramo')

  await check('clipNoteSpans: tramo, recorte al final del clip y chase', () => {
    const clip = midiClip({ startBeat: 4, lengthBeats: 4, notes: [
      { pitch: 60, start: 0, length: 2, velocity: 100 },
      { pitch: 64, start: 3, length: 4, velocity: 90 },
    ] })
    assert.deepEqual(clipNoteSpans(clip, 0, 16, false), [
      { pitch: 60, velocity: 100, startBeat: 4, endBeat: 6 },
      { pitch: 64, velocity: 90, startBeat: 7, endBeat: 8 },
    ], 'la nota que pasa el final del clip se recorta')
    assert.deepEqual(clipNoteSpans(clip, 5, 6, false), [], 'nada empieza en [5, 6)')
    assert.deepEqual(clipNoteSpans(clip, 5, 6, true), [{ pitch: 60, velocity: 100, startBeat: 4, endBeat: 6 }], 'con chase, la que ya sonaba')
    assert.deepEqual(clipNoteSpans(midiClip({ notes: [] }), 0, 8, true), [])
  })

  await check('clipNoteSpans con repeticion: el patron se repite, solo cuentan las notas dentro del patron', () => {
    const clip = midiClip({ lengthBeats: 8, loop: true, loopBeats: 2, notes: [
      { pitch: 60, start: 0, length: 1, velocity: 100 },
      { pitch: 62, start: 1.5, length: 1, velocity: 100 },
      { pitch: 64, start: 3, length: 1, velocity: 100 },
    ] })
    const spans = clipNoteSpans(clip, 0, 8, false)
    assert.deepEqual(spans.map((s) => [s.pitch, s.startBeat]), [[60, 0], [62, 1.5], [60, 2], [62, 3.5], [60, 4], [62, 5.5], [60, 6], [62, 7.5]])
    assert.equal(spans[spans.length - 1].endBeat, 8, 'recortada al final del clip')
    assert.equal(spans[1].endBeat, 2.5, 'una nota que cruza el patron suena entera')
    assert.deepEqual(clipNoteSpans(clip, 2.5, 3, true).map((s) => [s.pitch, s.startBeat, s.endBeat]), [[60, 2, 3]])
  })

  await check('planMidiNotes: ventanas contiguas sin repetir, chase (no en batería), corte en untilS y filtro de pistas', () => {
    const s = fixtureSession()
    const first = planMidiNotes(s, { fromS: 0, toS: 4, chase: false })
    assert.equal(first.length, 24, 'las 24 notas de la caja en sus 8 beats (4 s a 120 BPM)')
    assert.ok(first.every((n) => n.trackId === 'trk_3'))
    const halves = [...planMidiNotes(s, { fromS: 0, toS: 2, chase: false }), ...planMidiNotes(s, { fromS: 2, toS: 4, chase: false })]
    assert.equal(halves.length, 24, 'dos ventanas contiguas suman lo mismo')
    const synth = new Set(['trk_2'])
    assert.equal(planMidiNotes(s, { fromS: 10, toS: 10.5, chase: false, trackIds: synth }).length, 0)
    const chased = planMidiNotes(s, { fromS: 10, toS: 10.5, chase: true, trackIds: synth })
    assert.deepEqual(chased.map((n) => [n.pitch, n.startS, n.endS]), [[61, 8, 12], [64, 8, 12], [68, 8, 12]])
    assert.equal(planMidiNotes(s, { fromS: 1.01, toS: 1.02, chase: true, trackIds: new Set(['trk_3']) }).length, 0, 'la caja no hace chase')
    const cut = planMidiNotes(s, { fromS: 8, toS: 9, untilS: 9.5, chase: false, trackIds: synth })
    assert.deepEqual(cut.map((n) => n.endS), [9.5, 9.5, 9.5])
    assert.deepEqual(planMidiNotes({ ...s, bpm: 0 }, { fromS: 0, toS: 4, chase: false }), [])
  })

  await check('midiEndSeconds: fin del ultimo clip MIDI, por pista', () => {
    const s = fixtureSession()
    assert.equal(midiEndSeconds(s), 18)
    assert.equal(midiEndSeconds(s, new Set(['trk_3'])), 4)
    assert.equal(midiEndSeconds(s, new Set(['trk_1'])), 0)
  })

  await check('silencio MIDI (STUDIO_V2.md 2.4): un clip con muted no suena al escuchar ni al exportar ni para el asistente', () => {
    const s = fixtureSession()
    const sampler = new Set(['trk_4'])
    // mid_s9 (beats 40..44 = 20..22 s a 120 BPM) viene silenciado en el fixture.
    assert.equal(planMidiNotes(s, { fromS: 20, toS: 22, chase: true, trackIds: sampler }).length, 0, 'el programador de notas lo salta (escucha y bounce pasan por aqui)')
    const unmuted = toggleClipsActive(s, ['mid_s9'])
    assert.deepEqual(planMidiNotes(unmuted, { fromS: 20, toS: 22, chase: false, trackIds: sampler }).map((n) => [n.pitch, n.startS]), [[60, 20], [67, 21]])
    // El motor reprograma solo la pista cuyo clip cambio de silencio.
    assert.equal(midiClipsEqual(s, unmuted), false)
    assert.deepEqual([...(midiChangedTrackIds(s, unmuted) as Set<string>)], ['trk_4'])
    // Fin de lo que suena: el clip silenciado no alarga ni la escucha ni el archivo exportado.
    assert.equal(midiEndSeconds(s), 18)
    assert.equal(midiEndSeconds(unmuted), 22)
    assert.equal(sessionEndSeconds(s), sessionEndSeconds(toggleClipsActive(unmuted, ['mid_s9'])))
    // Una pista cuyos clips estan todos en silencio no tiene sonido: no se exporta como pista.
    const onlyMuted = { ...s, tracks: s.tracks.map((t) => (t.id === 'trk_4' ? { ...t, midiClips: t.midiClips.filter((c) => c.id === 'mid_s9') } : t)) }
    assert.equal(trackHasSound(onlyMuted.tracks[3]), false)
    assert.ok(!bounceTrackIds(onlyMuted).includes('trk_4'))
    assert.ok(bounceTrackIds(toggleClipsActive(onlyMuted, ['mid_s9'])).includes('trk_4'))
    const silentOnly = { ...onlyMuted, tracks: [onlyMuted.tracks[3]] }
    assert.equal(bounceRange(silentOnly, undefined, false), null, 'nada que exportar')
    // El asistente: las notas que suenan de un clip silenciado son ninguna.
    const muted = s.tracks[3].midiClips.find((c) => c.id === 'mid_s9')
    assert.ok(muted)
    assert.deepEqual(soundingClipNotes(muted, 0, 100), [])
    assert.equal(soundingClipNotes({ ...muted, muted: undefined }, 0, 100).length, 2)
  })

  await check('escala del fader de +12 a -60 dB: 0 dB a tres cuartos, ida y vuelta, marcas y LEDs del vumetro', () => {
    assert.equal(dbToFader(-60), 0)
    assert.equal(dbToFader(-200), 0)
    assert.equal(dbToFader(Number.NEGATIVE_INFINITY), 0)
    assert.equal(dbToFader(Number.NaN), 0)
    assert.equal(dbToFader(12), 1)
    assert.equal(dbToFader(30), 1)
    assert.equal(dbToFader(0), 0.75)
    assert.equal(dbToFader(-12), 0.45)
    for (const db of [-60, -40, -30, -24, -18, -12, -9, -6, -3, 0, 3, 6, 9, 12]) close(faderToDb(dbToFader(db)), db, 0.01)
    assert.equal(faderToDb(-1), -60)
    assert.equal(faderToDb(2), 12)
    // La curva sube siempre: mas recorrido, mas dB.
    let last = -Infinity
    for (let p = 0; p <= 1.0001; p += 0.01) {
      const db = faderToDb(p)
      assert.ok(db >= last, `no monotona en ${p}`)
      last = db
    }
    assert.deepEqual([FADER_MARKS[0], FADER_MARKS[FADER_MARKS.length - 1]], [12, -60], 'la escala impresa cubre el recorrido entero')
    // LEDs: 35 en 140 px; el de arriba es rojo (por encima de 0 dB), ambar desde -6, el resto verde.
    const count = ledSegmentCount(140)
    assert.equal(count, 35)
    assert.equal(ledSegmentCount(0), 0)
    assert.equal(ledZone(count - 1, count), 'over')
    assert.equal(ledZone(0, count), 'ok')
    const zones = Array.from({ length: count }, (_, i) => ledZone(i, count))
    assert.ok(zones.indexOf('hot') > zones.lastIndexOf('ok') && zones.indexOf('over') > zones.lastIndexOf('hot'), 'verde, ambar y rojo, en ese orden')
    assert.equal(ledLitCount(0, count), 0)
    assert.equal(ledLitCount(1, count), count)
    assert.equal(ledLitCount(dbToFader(0), count), Math.round(0.75 * count))
  })

  console.log('instruments/core.ts: caja de ritmos, sampler y sesion')

  await check('caja de ritmos: parametros por voz, ganancia, caida, afinacion, cortes y carriles', () => {
    const params = fixtureSession().tracks[2].instrument!.params as DrumsParams
    assert.equal(drumParam(params, 'hat_closed', 'LevelDb'), 0)
    assert.equal(drumParam({} as DrumsParams, 'kick', 'Decay'), 1, 'sin valor: decay 1')
    assert.equal(drumParam({} as DrumsParams, 'kick', 'Tune'), 0)
    close(drumHitGain(params, 'kick', 127), 1)
    close(drumHitGain({ ...params, kickLevelDb: -6 }, 'kick', 127), Math.pow(10, -6 / 20), 1e-9)
    close(drumDecayS(params, 'cymbal'), 1.5)
    close(drumDecayS({ ...params, cymbalDecay: 99 }, 'cymbal'), 6, 1e-12)
    close(drumTuneRatio({ ...params, snareTune: 12 }, 'snare'), 2)
    close(drumTuneRatio({ ...params, snareTune: -40 }, 'snare'), 0.5)
    close(drumHitSeconds(params, 'clap'), 2 * 0.01 + 0.001 + 0.2, 1e-12)
    assert.equal(drumChokes(42, 46), true, 'el hi-hat cerrado corta al abierto')
    assert.equal(drumChokes(46, 42), false)
    assert.equal(drumChokes(36, 36), true)
    assert.equal(drumChokes(36, 38), false)
    assert.equal(drumChokes(0, 36), false)
    const lanes = drumLanes()
    assert.equal(lanes.length, 9)
    assert.deepEqual(lanes[0], { voice: 'kick', pitch: 36, label: lanes[0].label })
  })

  await check('sampler: zonas por pitch y velocidad, y velocidad de lectura', () => {
    const zones = fixtureSession().tracks[3].instrument!.type === 'sampler' ? (fixtureSession().tracks[3].instrument as { zones: never[] }).zones : []
    assert.equal(samplerZonesFor(zones, 60, 100).length, 1)
    assert.equal(samplerZonesFor(zones, 47, 100).length, 0)
    assert.equal(samplerZonesFor(zones, 73, 100).length, 0)
    close(samplerPlaybackRate({ rootPitch: 60, tuneCents: 0 }, 72), 2)
    close(samplerPlaybackRate({ rootPitch: 60, tuneCents: 1200 }, 60), 2)
    close(samplerPlaybackRate({ rootPitch: 60, tuneCents: 0 }, 48), 0.5)
  })

  await check('instrumentKey, midiClipsEqual, midiChangedTrackIds e instrumentTailSeconds', () => {
    const s = fixtureSession()
    assert.equal(instrumentKey(null), '')
    assert.equal(instrumentKey(s.tracks[1].instrument), 'synth')
    assert.equal(instrumentKey({ type: 'wam', pluginId: 'obxd', state: {} }), 'wam=obxd')
    assert.equal(midiClipsEqual(s, s), true)
    const same = { ...s, tracks: s.tracks.map((t) => ({ ...t })) }
    assert.equal(midiClipsEqual(s, same), true, 'mismas notas por identidad')
    assert.deepEqual([...(midiChangedTrackIds(s, same) as Set<string>)], [])
    // Mover una nota de la caja: solo cambia trk_3.
    const moved = { ...s, tracks: s.tracks.map((t) => (t.id !== 'trk_3' ? t : { ...t, midiClips: t.midiClips!.map((c) => ({ ...c, notes: c.notes.map((n, i) => (i === 0 ? { ...n, velocity: 50 } : n)) })) })) }
    assert.equal(midiClipsEqual(s, moved), false)
    assert.deepEqual([...(midiChangedTrackIds(s, moved) as Set<string>)], ['trk_3'])
    assert.equal(midiChangedTrackIds(s, { ...s, bpm: 90 }), 'all', 'el tempo mueve todas las notas')
    assert.equal(midiChangedTrackIds(s, { ...s, tracks: s.tracks.slice(1) }), 'all')
    const unfrozen = { ...s, tracks: s.tracks.map((t) => (t.id === 'trk_2' ? { ...t, frozenAssetId: null } : t)) }
    assert.deepEqual([...(midiChangedTrackIds(s, unfrozen) as Set<string>)], ['trk_2'], 'quitar el congelado cambia lo que suena')
    // Cola: synth 1800 ms de relajacion * 1.4; caja hasta 1.501 s (platillo); sampler 0.21 s.
    close(instrumentTailSeconds(s), 1.8 * ENVELOPE_TAIL_FACTOR, 1e-12)
    const drumsOnly = { ...s, tracks: s.tracks.filter((t) => t.id === 'trk_3') }
    close(instrumentTailSeconds(drumsOnly), 0.001 + 1.5, 1e-12)
    assert.equal(instrumentTailSeconds({ ...s, tracks: s.tracks.filter((t) => t.kind === 'audio') }), 0)
    const wam = { ...s, tracks: [{ ...s.tracks[1], instrument: { type: 'wam' as const, pluginId: 'obxd', state: {} } }] }
    assert.equal(instrumentTailSeconds(wam), WAM_TAIL_S)
  })

  await check('frozenPlaybackSession, disponibilidad de instrumentos y plugins WAM (lista vacia)', () => {
    const s = fixtureSession()
    const frozen = frozenPlaybackSession(s, new Set())
    assert.ok(frozen)
    assert.deepEqual(frozen.tracks.map((t) => [t.id, t.clips[0].assetId, t.clips[0].lengthS]), [['trk_2', 'ast_f1', 40]])
    assert.equal(frozenPlaybackSession(s, new Set(['trk_2'])), null, 'con el instrumento disponible no suena el congelado')
    assert.equal(frozenPlaybackSession(s, new Set(), new Set(['trk_3'])), null)
    assert.deepEqual(instrumentAvailability(s.tracks[1].instrument!), { available: true, reason: null })
    assert.equal(listPlugins().length, 0)
    assert.equal(pluginAvailability('obxd').available, false)
    assert.match(pluginAvailability('Con Mayusculas').reason ?? '', /no es válido/)
    assert.equal(instrumentAvailability({ type: 'wam', pluginId: 'obxd', state: {} }).available, false)
    assert.equal(needsPreparation(s, null), false, 'sin WAM no hay nada que preparar')
    const wam = { ...s, tracks: [{ ...s.tracks[1], instrument: { type: 'wam' as const, pluginId: 'obxd', state: {} } }] }
    assert.equal(needsPreparation(wam, EMPTY_PREPARATION), true)
    assert.equal(needsPreparation(wam, { ...EMPTY_PREPARATION, unavailable: new Map([['trk_2', 'no']]) }), false)
  })

  console.log('engine.ts: reprogramacion en caliente, colas y medidores')

  await check('alcance de la reprogramacion: unir, vacio y que tanda entra', () => {
    const audioOnly = { audio: true, midi: new Set<string>() }
    const oneTrack = { audio: false, midi: new Set(['trk_2']) }
    assert.equal(scopeIsEmpty({ audio: false, midi: new Set() }), true)
    assert.equal(scopeIsEmpty(audioOnly), false)
    assert.equal(scopeIsEmpty({ audio: false, midi: 'all' }), false)
    const merged = mergeScope(audioOnly, oneTrack)
    assert.equal(merged.audio, true)
    assert.deepEqual([...(merged.midi as Set<string>)], ['trk_2'])
    assert.equal(mergeScope(oneTrack, FULL_RESCHEDULE).midi, 'all')
    assert.equal(mergeScope(null, oneTrack), oneTrack)
    assert.equal(batchInScope({ kind: 'audio', trackId: null }, oneTrack), false, 'una nota movida no corta los clips de audio')
    assert.equal(batchInScope({ kind: 'midi', trackId: 'trk_3' }, oneTrack), false, 'ni las notas de otra pista')
    assert.equal(batchInScope({ kind: 'midi', trackId: 'trk_2' }, oneTrack), true)
    assert.equal(batchInScope({ kind: 'midi', trackId: 'trk_3' }, audioOnly), false, 'un clip de audio no vuelve a atacar las notas')
    assert.equal(batchInScope({ kind: 'midi', trackId: 'trk_9' }, FULL_RESCHEDULE), true)
  })

  await check('colas: soltar un tramo terminado despues de la cola, y parar la escucha tras la ultima nota', () => {
    assert.equal(finishedSegmentReleaseMs(0), 100)
    close(finishedSegmentReleaseMs(2.52), 2620, 1e-9)
    assert.equal(finishedSegmentReleaseMs(Number.NaN), 100)
    assert.equal(playbackStopS(30, 0), 30.4, 'sin instrumentos, el margen de siempre')
    close(playbackStopS(30, 2), 32.1, 1e-12)
    assert.equal(playbackStopS(30, 0.1), 30.4)
  })

  await check('clic, picos, potencia media, audios en uso y tandas combinadas', () => {
    assert.deepEqual(normalizeClick({ enabled: true, volumeDb: 99, countInBars: 9.7 }), { enabled: true, volumeDb: normalizeClick({ ...DEFAULT_CLICK, volumeDb: 99 }).volumeDb, countInBars: 4 })
    assert.equal(normalizeClick({ enabled: 'si' as unknown as boolean, volumeDb: Number.NaN, countInBars: -2 }).enabled, false)
    assert.equal(normalizeClick({ enabled: false, volumeDb: Number.NaN, countInBars: Number.NaN }).volumeDb, DEFAULT_CLICK.volumeDb)
    const data = new Float32Array([0.1, -0.9, 0.5, -0.2])
    close(peakOf(data), 0.9, 1e-6)
    close(peakOf(data, 2), 0.5, 1e-6)
    close(meanSquareOf(new Float32Array([1, -1, 1, -1])), 1)
    assert.equal(meanSquareOf(new Float32Array(2), 5), 0)
    const s = fixtureSession()
    assert.ok(assetsInUse(s).some((a) => a.id === 'ast_f1'), 'el congelado esta en uso')
    assert.ok(assetsInUse(s).some((a) => a.id === 'ast_s1'), 'la zona del sampler esta en uso')
    const log: string[] = []
    const batch = (name: string): ScheduledClips => ({ stop: (at) => void log.push(`stop ${name} ${at}`), dispose: () => void log.push(`dispose ${name}`) })
    const both = combineScheduled([batch('a'), batch('b')])
    both.stop(3)
    both.dispose()
    assert.deepEqual(log, ['stop a 3', 'stop b 3', 'dispose a', 'dispose b'])
  })

  console.log('smf.ts, jobs.ts, midiInput.ts y assistantTools.ts: correcciones del cierre')

  await check('compas de un .mid: negras por compas (6/8 son 3, 12/8 son 6, 7/8 no se usa)', () => {
    assert.equal(beatsPerBarFromSignature(4, 2), 4)
    assert.equal(beatsPerBarFromSignature(3, 2), 3)
    assert.equal(beatsPerBarFromSignature(6, 3), 3)
    assert.equal(beatsPerBarFromSignature(12, 3), 6)
    assert.equal(beatsPerBarFromSignature(2, 1), 4, '2/2: 4 negras')
    assert.equal(beatsPerBarFromSignature(7, 3), null)
    assert.equal(beatsPerBarFromSignature(5, null), 5, 'sin denominador, negra')
    assert.equal(beatsPerBarFromSignature(0, 2), null)
    // Ida y vuelta: writeSmf escribe x/4; un 6/8 armado a mano se lee como 3 negras.
    const written = writeSmf([{ name: 'P', notes: [{ pitch: 60, start: 0, length: 1, velocity: 100 }], channel: 0 }], 120, 3)
    assert.equal(parseSmf(written).beatsPerBar, 3)
    assert.equal(parseSmf(written).timeSignature, '3/4')
    const bytes = Array.from(written)
    const at = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0x58)
    bytes[at + 3] = 6
    bytes[at + 4] = 3
    const sixEight = parseSmf(new Uint8Array(bytes))
    assert.equal(sixEight.beatsPerBar, 3)
    assert.equal(sixEight.timeSignature, '6/8')
    bytes[at + 3] = 7
    const sevenEight = parseSmf(new Uint8Array(bytes))
    assert.deepEqual([sevenEight.beatsPerBar, sevenEight.timeSignature], [null, '7/8'])
  })

  await check('rebeatMarkers: las marcas del analisis siguen al audio cuando el tempo cambia despues', () => {
    // Coro a los 24 s: beat 48 a 120 BPM; a 128 BPM debe quedar en el beat 51.2.
    const markers: StudioMarker[] = [
      { id: 'mk_a', beat: 48, label: 'Coro', kind: 'chorus' },
      { id: 'mk_b', beat: 8, label: 'Mia', kind: 'marker' },
    ]
    const seconds = new Map([['mk_a', 24]])
    const out = rebeatMarkers(markers, seconds, 128)
    close(out[0].beat, 51.2, 1e-9)
    assert.equal(out[1], markers[1], 'una marca del usuario no se toca')
  })

  await check('midiInput: el puerto se cierra al soltarlo; el teclado musical no actua dentro de un dialogo', async () => {
    let closed = 0
    const listeners = new Set<unknown>()
    const port: MidiInputPortLike = {
      id: 'in-1', name: 'Teclado', state: 'connected', type: 'input',
      addEventListener: (_t, l) => void listeners.add(l),
      removeEventListener: (_t, l) => void listeners.delete(l),
      close: async () => {
        closed++
      },
    }
    const access: MidiAccessLike = {
      inputs: { values: () => [port].values(), get: (id: string) => (id === 'in-1' ? port : undefined) },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    const ctx = { currentTime: 1, getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 1000 }) }
    const input = new StudioMidiInput({ getContext: () => ctx, navigator: { requestMIDIAccess: async () => access }, now: () => 1000, keyboardTarget: new EventTarget() })
    await input.requestAccess()
    input.open('in-1', 'all')
    assert.equal(listeners.size, 1)
    input.open('in-1', 'all')
    assert.equal(closed, 1, 'cambiar de dispositivo (o reabrir) cierra el anterior')
    input.close()
    assert.equal(closed, 2, 'cerrar el Estudio cierra el puerto')
    assert.equal(listeners.size, 0)
    assert.equal(isInsideDialog({ closest: (sel: string) => (sel.includes('role="dialog"') ? {} : null) }), true)
    assert.equal(isInsideDialog({ closest: () => null }), false)
    assert.equal(isInsideDialog(null), false)
    assert.equal(isInsideDialog(new EventTarget()), false)
  })

  await check('APLICAR TODOS: no aplica lo que quita o borra', () => {
    const pending = (name: string, status: PendingAssistantCommand['status'] = 'pending'): PendingAssistantCommand => ({
      callId: `call_${name}`, name, commandId: null, args: {}, description: name, status, message: '', adjusted: [],
    })
    assert.deepEqual([...DESTRUCTIVE_TOOLS].sort(), ['delete_clip', 'remove_marker', 'remove_track', 'replace_midi_notes'])
    assert.equal(isDestructiveCommand(pending('remove_track')), true)
    assert.equal(isDestructiveCommand(pending('set_track_mix')), false)
    assert.deepEqual(bulkApplicable([pending('set_track_mix'), pending('remove_track'), pending('add_marker', 'applied'), pending('delete_clip')]), [true, false, false, false])
  })

  console.log(`\n${passed} ok, ${failures.length} con falla`)
  if (failures.length > 0) process.exit(1)
}

void main()
