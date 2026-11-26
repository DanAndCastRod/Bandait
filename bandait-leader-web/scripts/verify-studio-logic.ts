/**
 * Verificacion de la logica pura del Estudio Bandait:
 *   node --experimental-strip-types scripts/verify-studio-logic.ts   (parte de npm run verify:logic)
 *
 * Cubre: src/services/studio/session.ts contra bandait-protocol/fixtures/studio_session.json (ida
 * y vuelta, cada codigo de error con su ruta), sessionOps.ts (cada operacion de edicion y sus
 * bordes), history.ts (deshacer y rehacer), latency.ts (alineacion de toma, correlacion con un
 * retardo conocido y con ruido), loudness.ts (LUFS contra senales de referencia, compuertas,
 * pico real, bandas), peaks.ts, el WAV de 24 bits de src/services/wav.ts, y studioCloud.ts y
 * jobs.ts contra un Worker simulado (If-Match, 412, 409, sondeo de trabajos).
 *
 * Nada de esto toca la red ni datos reales: el Worker es una clase en memoria.
 */
import assert from 'node:assert/strict'
import fixture from '../../bandait-protocol/fixtures/studio_session.json' with { type: 'json' }
import fixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import chatToolsFixture from '../../bandait-protocol/fixtures/studio_chat_tools_v2.json' with { type: 'json' }
import {
  STUDIO_COMMAND_SPECS,
  BROWSER_RESERVED_SHORTCUTS,
  KEYMAP_STORAGE_KEY,
  buildStudioCommands,
  createCommandRegistry,
  createStudioRegistry,
  defaultKeymap,
  displayShortcut,
  findConflicts,
  formatShortcut,
  loadKeymap,
  matchEvent,
  parseShortcut,
  resetKeymap,
  saveKeymap,
  shortcutFromEvent,
  type StudioCommandId,
} from '../src/services/studio/commands.ts'
import { computerKeyPitch, createComputerKeyboard, isComputerKeyboardCode } from '../src/services/studio/computerKeyboard.ts'
import {
  addNotes,
  duplicateNotes,
  gridBeats,
  legato,
  moveNotes,
  normalizeNotes,
  notesInRange,
  quantize,
  removeNotes,
  resizeNotes,
  setVelocity,
  splitNotesAt,
  transpose,
  invertSelection,
} from '../src/services/studio/midiOps.ts'
import { SMF_TICKS_PER_BEAT, midiClipExportNotes, parseSmf, writeSmf } from '../src/services/studio/smf.ts'
import { StemCloudError, type CloudTarget } from '../src/services/stemCloud.ts'
import { encodeWav16, encodeWav24, encodeWavPcm, buildWavHeader, floatTo24, parseWavHeader, WAV_HEADER_BYTES } from '../src/services/wav.ts'
import { bounceRange, bounceTrackIds, soloTrackSession } from '../src/services/studio/bounce.ts'
import { beatsInRange, clickEventsInWindow, countInSeconds } from '../src/services/studio/click.ts'
import { MIN_LOOP_S, audibleCtxTime, audiblePositionAt, clampPosition, normalizeLoop, positionAt } from '../src/services/studio/engine.ts'
import { buildReverbImpulse, compressorLatencySeconds, limiterLatencySeconds, reverbDecayKey } from '../src/services/studio/fx.ts'
import { DECLICK_S, clipEnvelope, clipFadeFactor, clipsEqual, graphLatency, planClips, topologySignature } from '../src/services/studio/graph.ts'
import { STUDIO_HISTORY_LIMIT, createHistory } from '../src/services/studio/history.ts'
import { LookaheadLimiter, limiterLookaheadFrames, limiterReleaseCoef } from '../src/services/studio/limiterCore.ts'
import {
  MAX_TAKE_LAPS,
  MIN_TAKE_LAP_S,
  TAKE_LANE_H,
  TRACK_ROW_H,
  barBeatAt,
  cloudHasOtherVersion,
  layoutTracks,
  maxTakeSeconds,
  referencedAssetFiles,
  takeClipWindows,
  adjacentMarkerBeat,
  tapTempo,
} from '../src/services/studio/timelineMath.ts'
import {
  JOB_DEFAULT_TARGET_LUFS,
  barsToSeconds,
  buildMixMetrics,
  estimate,
  estimateText,
  formatUsd,
  generateRequestForSession,
  jobAssetToSessionAsset,
  jobErrorMessage,
  jobKindLabel,
  jobRequestProblem,
  jobStatusText,
  measureTrack,
  clearPendingJob,
  pendingJobKey,
  readPendingJob,
  resumeJob,
  runJob,
  writePendingJob,
  suggestionTitle,
  suggestionsForSession,
} from '../src/services/studio/jobs.ts'
import {
  LATENCY_MIN_CONFIDENCE,
  browserLatencySeconds,
  calibrationKey,
  calibrationSignal,
  clearCalibration,
  estimateDelaySamples,
  loadCalibration,
  saveCalibration,
  takeStartSeconds,
} from '../src/services/studio/latency.ts'
import { bandEnergiesDb, createLoudnessMeter, gainToTargetLufs, integratedLufs, kWeightingCoefficients, truePeakDb } from '../src/services/studio/loudness.ts'
import { PEAKS_BASE_BUCKET, computePeaks, peaksForRange } from '../src/services/studio/peaks.ts'
import {
  STUDIO_MAX_ASSET_BYTES,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACKS,
  STUDIO_MAX_NOTES_PER_CLIP,
  StudioSessionError,
  countSessionNotes,
  defaultFx,
  defaultInstrument,
  defaultInstrumentTrack,
  defaultMidiClip,
  defaultTrack,
  findAsset,
  findClip,
  findMidiClip,
  findTrack,
  migrateSessionV1,
  newSession,
  parseSession,
  parseSessionJson,
  partialFxParamsFromWire,
  serializeSession,
  sessionEndSeconds,
  sessionToJson,
  validateSession,
  type StudioAsset,
  type StudioClip,
  type StudioMidiClip,
  type StudioMidiNote,
  type StudioSession,
} from '../src/services/studio/session.ts'
import {
  addAsset,
  addClip,
  addInstrumentTrack,
  addMidiClip,
  addTrack,
  applyMixSuggestion,
  deleteClip,
  duplicateClip,
  duplicateMidiClip,
  expandMidiClipNotes,
  moveClip,
  moveMidiClip,
  removeMidiClip,
  removeTrack,
  removeUnusedAssets,
  resizeMidiClip,
  setActiveTake,
  setClipFades,
  setClipGain,
  setFrozenAsset,
  setInstrument,
  setMarkers,
  setTrackFx,
  snapTime,
  splitClip,
  splitMidiClip,
  trimClip,
  updateMaster,
  updateMidiClip,
  updateSessionMeta,
  updateTrack,
  clipsRangeS,
  copyClips,
  deleteClips,
  duplicateTrack,
  fadeClipsAt,
  joinClips,
  moveClipsBy,
  moveTrack,
  pasteClips,
  pasteCursorAfterCopy,
  pastePosition,
  toggleClipsActive,
  trimClipsAt,
} from '../src/services/studio/sessionOps.ts'
import {
  STUDIO_JOB_MAX_RETRIES,
  cleanOrphans,
  deleteSession,
  estimateJob,
  getAsset,
  getJob,
  getSession,
  inspectOrphans,
  jobRequestToWire,
  listSessions,
  parseCleanupReport,
  parseJobState,
  parseMixSuggestions,
  putAsset,
  putSession,
  startJob,
  studioCloudErrorMessage,
  studioUrl,
  watchJob,
} from '../src/services/studio/studioCloud.ts'
import type { KeyEventLike, KeyValueStorage, MixSuggestion, StudioCommand, StudioJobRequest, StudioJobState } from '../src/services/studio/types.ts'

/** Documento JSON suelto: las pruebas lo rompen a proposito para comprobar cada rechazo. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

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

/** La sesion del fixture, recien leida (cada prueba parte de una copia propia). */
function base(): StudioSession {
  return parseSession(structuredClone(fixture))
}

function sessionError(fn: () => unknown, code: string, path?: string) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof StudioSessionError, `se esperaba StudioSessionError, llego ${String(err)}`)
    assert.equal(err.code, code, `${err.code} ${err.path} ${err.message}`)
    if (path !== undefined) assert.equal(err.path, path, `${err.code} ${err.path}`)
    return
  }
  assert.fail(`se esperaba ${code}${path ? ` en ${path}` : ''}`)
}

async function cloudError(promise: Promise<unknown>, code: string, status?: number): Promise<StemCloudError> {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof StemCloudError, `se esperaba StemCloudError, llego ${String(err)}`)
    assert.equal(err.code, code, `${err.code} ${err.status} ${err.message}`)
    if (status !== undefined) assert.equal(err.status, status)
    return err
  }
  assert.fail(`se esperaba el error ${code}`)
}

function clip(session: StudioSession, id: string): StudioClip {
  const loc = findClip(session, id)
  assert.ok(loc, `falta el clip ${id}`)
  return loc.clip
}

/** Generador determinista (mulberry32): las pruebas con ruido dan siempre lo mismo. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sine(freq: number, amplitude: number, seconds: number, sampleRate: number, phase = 0): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase)
  return out
}

function dbToAmp(db: number): number {
  return Math.pow(10, db / 20)
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function delayed(signal: Float32Array, delay: number, gain: number, total: number): Float32Array {
  const out = new Float32Array(total)
  for (let i = 0; i < signal.length && i + delay < total; i++) out[i + delay] = signal[i] * gain
  return out
}

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value)
    },
    removeItem: (key) => {
      data.delete(key)
    },
  }
}

async function main() {
  // =========================================================================
  console.log('session.ts contra bandait-protocol/fixtures/studio_session.json')

  await check('ida y vuelta: el fixture v1 sale migrado a v2 (STUDIO_V2.md 1), con las claves en el mismo orden', () => {
    const session = base()
    // v2: el Hub escribe siempre version 2; la migracion solo agrega kind y markers.
    const migrated = migratedV1Fixture()
    assert.deepStrictEqual(serializeSession(session), migrated)
    assert.equal(JSON.stringify(serializeSession(session)), JSON.stringify(migrated))
    assert.deepStrictEqual(parseSession(serializeSession(session)), session)
    assert.deepStrictEqual(parseSessionJson(sessionToJson(session)), session)
  })

  await check('el fixture trae tomas, un audio generado con origen y el limitador de ultimo', () => {
    const session = base()
    const takes = session.tracks[0].clips.filter((c) => c.takeGroup === 'tk_1')
    assert.equal(takes.length, 2)
    assert.equal(takes.filter((c) => c.active).length, 1)
    const generated = session.assets.find((a) => a.kind === 'generated')
    assert.equal(generated?.source?.provider, 'lyria')
    assert.equal(generated?.source?.jobId, 'job_7c21')
    assert.equal(session.master.fx.at(-1)?.type, 'limiter')
    assert.equal(findClip(session, 'clp_3')?.track.id, 'trk_2')
    assert.equal(sessionEndSeconds(session), 212.4)
  })

  // Cada mutacion del fixture debe dar su codigo y su ruta.
  const mutations: Array<[string, (d: Json) => void, string, string]> = [
    ['version distinta de 1 y de 2', (d) => (d.version = 3), 'unsupported_version', 'version'],
    ['campo obligatorio ausente', (d) => delete d.bpm, 'missing_field', 'bpm'],
    ['campo desconocido en la raiz', (d) => (d.extra = 1), 'unknown_field', 'extra'],
    ['campo en camelCase', (d) => (d.tracks[0].volumeDb = 0), 'unknown_field', 'tracks[0].volumeDb'],
    ['texto donde va numero', (d) => (d.bpm = '128'), 'bad_type', 'bpm'],
    ['bpm fuera de rango', (d) => (d.bpm = 300), 'out_of_range', 'bpm'],
    ['frecuencia de sesion no admitida', (d) => (d.sample_rate = 22050), 'bad_value', 'sample_rate'],
    ['id con espacio', (d) => (d.id = 'con espacio'), 'bad_id', 'id'],
    ['pista llamada master', (d) => (d.tracks[1].id = 'master'), 'bad_id', 'tracks[1].id'],
    ['id de pista repetido', (d) => (d.tracks[1].id = 'trk_1'), 'duplicate_id', 'tracks[1].id'],
    ['id de clip repetido en otra pista', (d) => (d.tracks[1].clips[0].id = 'clp_1'), 'duplicate_id', 'tracks[1].clips[0].id'],
    ['archivo que no coincide con el id', (d) => (d.assets[0].file = 'otro.wav'), 'bad_value', 'assets[0].file'],
    ['extension no admitida', (d) => (d.assets[0].file = 'ast_a1.ogg'), 'bad_value', 'assets[0].file'],
    ['audio de mas de 200 MB', (d) => (d.assets[0].size = 300 * 1024 * 1024), 'out_of_range', 'assets[0].size'],
    ['audio generado sin origen', (d) => (d.assets[3].source = null), 'missing_source', 'assets[3].source'],
    ['rol desconocido', (d) => (d.tracks[0].role = 'kazoo'), 'bad_value', 'tracks[0].role'],
    ['clip con audio inexistente', (d) => (d.tracks[0].clips[0].asset_id = 'ast_zz'), 'unknown_asset', 'tracks[0].clips[0].asset_id'],
    ['ventana que se sale del audio', (d) => (d.tracks[0].clips[0].length_s = 40), 'clip_out_of_asset', 'tracks[0].clips[0].length_s'],
    ['clip que pasa los 20 minutos', (d) => (d.tracks[2].clips[0].start_s = 1190), 'session_too_long', 'tracks[2].clips[0].start_s'],
    ['fades que no caben', (d) => (d.tracks[2].clips[0].fade_in_s = 29.5), 'bad_fades', 'tracks[2].clips[0].fade_in_s'],
    ['efecto repetido', (d) => (d.tracks[0].fx[1] = d.tracks[0].fx[0]), 'bad_fx', 'tracks[0].fx[1]'],
    ['limitador en una pista', (d) => (d.tracks[1].fx = [d.master.fx[0]]), 'bad_fx', 'tracks[1].fx[0]'],
    ['limitador que no va de ultimo', (d) => d.master.fx.push(d.tracks[0].fx[0]), 'bad_fx', 'master.fx[0]'],
    ['parametro de efecto desconocido', (d) => (d.master.fx[0].params.lookahead_ms = 5), 'unknown_field', 'master.fx[0].params.lookahead_ms'],
    ['parametro de efecto fuera de rango', (d) => (d.master.fx[0].params.ceiling_db = 3), 'out_of_range', 'master.fx[0].params.ceiling_db'],
    ['17 pistas', (d) => (d.tracks = Array.from({ length: 17 }, (_, i) => ({ ...d.tracks[1], id: `t${i}`, clips: [] }))), 'too_many', 'tracks'],
    ['master que no es un objeto', (d) => (d.master = []), 'not_an_object', 'master'],
  ]
  for (const [name, mutate, code, path] of mutations) {
    await check(`rechaza: ${name} -> ${code} en ${path}`, () => {
      const doc = structuredClone(fixture) as Json
      mutate(doc)
      sessionError(() => parseSession(doc), code, path)
    })
  }

  await check('un parametro de efecto ausente toma su valor por defecto', () => {
    const doc = structuredClone(fixture) as Json
    delete doc.master.fx[0].params.release_ms
    const limiter = parseSession(doc).master.fx[0]
    assert.equal(limiter.type, 'limiter')
    assert.deepStrictEqual(limiter.params, { ceilingDb: -1, releaseMs: 100 })
    assert.deepStrictEqual(partialFxParamsFromWire('eq', { hpf_hz: 80, low_db: -2 }), { hpfHz: 80, lowDb: -2 })
  })

  await check('sesion nueva: valida, con el titulo recortado y el limitador en el master', () => {
    const fresh = newSession({ title: '  Maqueta  ', sampleRate: 48000, now: new Date('2026-11-19T12:00:00Z') })
    assert.equal(fresh.title, 'Maqueta')
    assert.match(fresh.id, /^ses_[0-9a-f]{8}$/)
    assert.equal(fresh.updatedAt, '2026-11-19T12:00:00.000Z')
    assert.equal(fresh.master.fx[0].type, 'limiter')
    assert.deepStrictEqual(parseSession(serializeSession(fresh)), fresh)
    sessionError(() => newSession({ title: 'x', sampleRate: 22050 }), 'bad_value', 'sample_rate')
    sessionError(() => newSession({ title: '   ', sampleRate: 48000 }), 'out_of_range', 'title')
  })

  await check('el documento de mas de 1 MiB (STUDIO_V2.md 2.5) se rechaza al leer y al escribir', () => {
    sessionError(() => parseSessionJson(' '.repeat(1024 * 1024 + 1)), 'document_too_large')
    sessionError(() => parseSessionJson('{no es json'), 'not_an_object')
    let big = newSession({ title: 'Grande', sampleRate: 48000 })
    const assets: StudioAsset[] = Array.from({ length: 256 }, (_, i) => ({
      id: `ast_${i}`,
      file: `ast_${i}.wav`,
      kind: 'import',
      label: 'x'.repeat(120),
      channels: 2,
      sampleRate: 48000,
      durationS: 60,
      size: 1000,
      source: null,
    }))
    big = { ...big, assets }
    const track = defaultTrack({ id: 'trk_a', name: 'Pista' })
    const clips: StudioClip[] = Array.from({ length: 256 }, (_, i) => ({
      id: `clip_con_un_id_largo_para_ocupar_espacio_en_el_documento_${i}`,
      assetId: `ast_${i}`,
      startS: i,
      offsetS: 0,
      lengthS: 1,
      gainDb: 0,
      fadeInS: 0,
      fadeOutS: 0,
      takeGroup: null,
      active: true,
    }))
    big = { ...big, tracks: Array.from({ length: 8 }, (_, t) => ({ ...track, id: `trk_${t}`, clips: clips.map((c) => ({ ...c, id: `${c.id}_${t}` })) })) }
    // v2: con 1 MiB los clips de audio solos ya no alcanzan; se suman 16384 notas en 4 pistas.
    const notes = Array.from({ length: 1024 }, (_, i) => ({ pitch: i % 128, start: i * 0.0625, length: 0.0625, velocity: 100 }))
    const instrumentTracks = Array.from({ length: 4 }, (_, t) =>
      defaultInstrumentTrack({
        id: `trk_i${t}`,
        name: 'Instrumento',
        instrument: defaultInstrument('synth'),
      }),
    ).map((t, ti) => ({ ...t, midiClips: Array.from({ length: 4 }, (_, c) => defaultMidiClip({ id: `mid_${ti}_${c}`, startBeat: c * 64, lengthBeats: 64, notes })) }))
    big = { ...big, tracks: [...big.tracks, ...instrumentTracks] }
    sessionError(() => sessionToJson(big), 'document_too_large')
  })

  // =========================================================================
  console.log('\nsessionOps.ts')

  await check('moveClip: cambia solo ese clip y conserva la referencia de lo demas', () => {
    const s = base()
    const snapshot = structuredClone(s)
    const moved = moveClip(s, { clipId: 'clp_1', startS: 12 })
    assert.equal(clip(moved, 'clp_1').startS, 12)
    assert.notEqual(moved, s)
    assert.equal(moved.tracks[1], s.tracks[1])
    assert.equal(moved.tracks[0].clips[1], s.tracks[0].clips[1])
    assert.equal(moved.assets, s.assets)
    assert.equal(moved.updatedAt, s.updatedAt)
    assert.deepStrictEqual(s, snapshot, 'la entrada no se muta')
    validateSession(moved)
  })

  await check('moveClip: misma posicion devuelve la misma sesion; fuera de rango se acota', () => {
    const s = base()
    assert.equal(moveClip(s, { clipId: 'clp_1', startS: 7.5 }), s)
    assert.equal(clip(moveClip(s, { clipId: 'clp_1', startS: -3 }), 'clp_1').startS, 0)
    const late = moveClip(s, { clipId: 'clp_1', startS: 5000 })
    assert.equal(clip(late, 'clp_1').startS, 1170)
    validateSession(late)
  })

  await check('moveClip: a otra pista queda al final de su lista', () => {
    const s = base()
    const moved = moveClip(s, { clipId: 'clp_4', startS: 40, trackId: 'trk_2' })
    assert.deepStrictEqual(moved.tracks[1].clips.map((c) => c.id), ['clp_3', 'clp_4'])
    assert.deepStrictEqual(moved.tracks[2].clips, [])
    assert.equal(moved.tracks[0], s.tracks[0])
    validateSession(moved)
    sessionError(() => moveClip(s, { clipId: 'clp_4', startS: 0, trackId: 'trk_9' }), 'bad_id', 'track_id')
  })

  await check('un clip inexistente lanza bad_id; un numero no finito lanza bad_type', () => {
    const s = base()
    sessionError(() => moveClip(s, { clipId: 'clp_zz', startS: 0 }), 'bad_id', 'clip_id')
    sessionError(() => deleteClip(s, { clipId: 'clp_zz' }), 'bad_id', 'clip_id')
    sessionError(() => moveClip(s, { clipId: 'clp_1', startS: Number.NaN }), 'bad_type', 'start_s')
    sessionError(() => setClipGain(s, { clipId: 'clp_1', gainDb: Number.POSITIVE_INFINITY }), 'bad_type', 'gain_db')
  })

  await check('trimClip por el inicio: mueve inicio, ventana y largo; el final no se mueve', () => {
    const s = base()
    const t = trimClip(s, { clipId: 'clp_3', edge: 'start', toS: 10 })
    const c = clip(t, 'clp_3')
    assert.equal(c.startS, 10)
    assert.equal(c.offsetS, 10)
    close(c.lengthS, 202.4)
    close(c.startS + c.lengthS, 212.4)
    validateSession(t)
    assert.equal(trimClip(s, { clipId: 'clp_3', edge: 'start', toS: 0 }), s)
  })

  await check('trimClip por el inicio mas alla del audio: se detiene donde empieza el audio', () => {
    const s = trimClip(base(), { clipId: 'clp_1', edge: 'start', toS: 17.5 })
    assert.equal(clip(s, 'clp_1').offsetS, 10)
    const back = trimClip(s, { clipId: 'clp_1', edge: 'start', toS: -50 })
    const c = clip(back, 'clp_1')
    assert.equal(c.startS, 7.5)
    assert.equal(c.offsetS, 0)
    close(c.lengthS, 30)
    validateSession(back)
    // Un clip cuya ventana empieza en el segundo 0 del audio y de la sesion no puede crecer a la izquierda.
    assert.equal(clip(trimClip(base(), { clipId: 'clp_3', edge: 'start', toS: -1 }), 'clp_3').startS, 0)
  })

  await check('trimClip por el final mas alla del audio: se acota a la duracion del audio', () => {
    const s = base()
    const t = trimClip(s, { clipId: 'clp_1', edge: 'end', toS: 500 })
    close(clip(t, 'clp_1').lengthS, 32.5)
    validateSession(t)
    // clp_3 ya usa todo su audio: estirarlo no cambia nada.
    assert.equal(trimClip(s, { clipId: 'clp_3', edge: 'end', toS: 900 }), s)
  })

  await check('trimClip: respeta el largo minimo y escala los fades que ya no caben', () => {
    const s = base()
    const tiny = trimClip(s, { clipId: 'clp_1', edge: 'end', toS: 0 })
    close(clip(tiny, 'clp_1').lengthS, 0.01)
    validateSession(tiny)
    const tinyStart = trimClip(s, { clipId: 'clp_1', edge: 'start', toS: 999 })
    close(clip(tinyStart, 'clp_1').lengthS, 0.01, 1e-9)
    validateSession(tinyStart)
    const short = trimClip(s, { clipId: 'clp_4', edge: 'end', toS: 1.2 })
    const c = clip(short, 'clp_4')
    close(c.lengthS, 1.2)
    close(c.fadeInS, 0.4)
    close(c.fadeOutS, 0.8)
    validateSession(short)
  })

  await check('splitClip: dos mitades contiguas que suman el clip original', () => {
    const s = base()
    const split = splitClip(s, { clipId: 'clp_3', atS: 100, newClipId: 'clp_new' })
    assert.deepStrictEqual(split.tracks[1].clips.map((c) => c.id), ['clp_3', 'clp_new'])
    const left = clip(split, 'clp_3')
    const right = clip(split, 'clp_new')
    assert.deepStrictEqual([left.startS, left.offsetS, left.lengthS], [0, 0, 100])
    assert.equal(right.startS, 100)
    assert.equal(right.offsetS, 100)
    close(right.lengthS, 112.4)
    assert.equal(left.fadeOutS, 0)
    assert.equal(right.fadeInS, 0)
    assert.equal(right.fadeOutS, 2)
    assert.equal(right.gainDb, left.gainDb)
    assert.equal(right.assetId, left.assetId)
    validateSession(split)
  })

  await check('splitClip en el borde o fuera del clip no hace nada', () => {
    const s = base()
    assert.equal(splitClip(s, { clipId: 'clp_1', atS: 7.5, newClipId: 'clp_new' }), s)
    assert.equal(splitClip(s, { clipId: 'clp_1', atS: 37.5, newClipId: 'clp_new' }), s)
    assert.equal(splitClip(s, { clipId: 'clp_1', atS: 7.505, newClipId: 'clp_new' }), s)
    assert.equal(splitClip(s, { clipId: 'clp_1', atS: 2, newClipId: 'clp_new' }), s)
    assert.equal(splitClip(s, { clipId: 'clp_1', atS: 400, newClipId: 'clp_new' }), s)
    // 7.51 - 7.5 da 0.00999... en binario: queda por debajo del minimo y tampoco divide.
    assert.equal(splitClip(s, { clipId: 'clp_1', atS: 7.51, newClipId: 'clp_new' }), s)
    const ok = splitClip(s, { clipId: 'clp_1', atS: 7.52, newClipId: 'clp_new' })
    close(clip(ok, 'clp_1').lengthS, 0.02, 1e-9)
    close(clip(ok, 'clp_new').offsetS, 0.02, 1e-9)
    validateSession(ok)
    const nearEnd = splitClip(s, { clipId: 'clp_1', atS: 37.48, newClipId: 'clp_new' })
    close(clip(nearEnd, 'clp_new').lengthS, 0.02, 1e-9)
    validateSession(nearEnd)
  })

  await check('splitClip: conserva el grupo de tomas y rechaza un id repetido', () => {
    const s = base()
    const split = splitClip(s, { clipId: 'clp_2', atS: 20, newClipId: 'clp_new' })
    assert.equal(clip(split, 'clp_new').takeGroup, 'tk_1')
    assert.equal(clip(split, 'clp_new').active, true)
    sessionError(() => splitClip(s, { clipId: 'clp_2', atS: 20, newClipId: 'clp_3' }), 'duplicate_id', 'new_clip_id')
    sessionError(() => splitClip(s, { clipId: 'clp_2', atS: 20, newClipId: 'con espacio' }), 'bad_id', 'new_clip_id')
  })

  await check('duplicateClip: por defecto justo donde termina el original', () => {
    const s = base()
    const d = duplicateClip(s, { clipId: 'clp_4', newClipId: 'clp_new' })
    assert.deepStrictEqual(d.tracks[2].clips.map((c) => c.id), ['clp_4', 'clp_new'])
    assert.equal(clip(d, 'clp_new').startS, 30)
    assert.equal(clip(d, 'clp_new').fadeOutS, 1)
    validateSession(d)
    assert.equal(clip(duplicateClip(s, { clipId: 'clp_4', newClipId: 'clp_new', startS: 9999 }), 'clp_new').startS, 1170)
    sessionError(() => duplicateClip(s, { clipId: 'clp_4', newClipId: 'clp_1' }), 'duplicate_id')
  })

  await check('deleteClip quita el clip y deja el audio en la sesion', () => {
    const s = base()
    const d = deleteClip(s, { clipId: 'clp_4' })
    assert.deepStrictEqual(d.tracks[2].clips, [])
    assert.ok(findAsset(d, 'ast_p1'))
    validateSession(d)
  })

  await check('setClipFades: fades mas largos que el clip se acotan', () => {
    const s = base()
    const a = setClipFades(s, { clipId: 'clp_4', fadeInS: 100 })
    assert.equal(clip(a, 'clp_4').fadeInS, 29)
    assert.equal(clip(a, 'clp_4').fadeOutS, 1)
    const b = setClipFades(s, { clipId: 'clp_4', fadeOutS: 100 })
    assert.equal(clip(b, 'clp_4').fadeOutS, 29.5)
    const both = setClipFades(s, { clipId: 'clp_4', fadeInS: 100, fadeOutS: 100 })
    assert.deepStrictEqual([clip(both, 'clp_4').fadeInS, clip(both, 'clp_4').fadeOutS], [30, 0])
    assert.equal(clip(setClipFades(s, { clipId: 'clp_4', fadeInS: -2 }), 'clp_4').fadeInS, 0)
    for (const r of [a, b, both]) validateSession(r)
    assert.equal(setClipFades(s, { clipId: 'clp_4' }), s)
    assert.equal(setClipFades(s, { clipId: 'clp_4', fadeInS: 0.5, fadeOutS: 1 }), s)
  })

  await check('setClipGain se acota a -60..24', () => {
    const s = base()
    assert.equal(clip(setClipGain(s, { clipId: 'clp_1', gainDb: 99 }), 'clp_1').gainDb, 24)
    assert.equal(clip(setClipGain(s, { clipId: 'clp_1', gainDb: -99 }), 'clp_1').gainDb, -60)
    assert.equal(setClipGain(s, { clipId: 'clp_1', gainDb: 0 }), s)
  })

  await check('setActiveTake: activa la toma y desactiva las del grupo que se solapan', () => {
    const s = base()
    const t = setActiveTake(s, { clipId: 'clp_1' })
    assert.equal(clip(t, 'clp_1').active, true)
    assert.equal(clip(t, 'clp_2').active, false)
    assert.equal(t.tracks[1], s.tracks[1])
    assert.equal(setActiveTake(t, { clipId: 'clp_1' }), t)
    assert.equal(setActiveTake(s, { clipId: 'clp_2' }), s)
    validateSession(t)
  })

  await check('setActiveTake: una toma del grupo que no se solapa sigue activa', () => {
    // clp_2 se mueve despues de clp_1: mismo grupo, sin solape (37.5 es el borde de clp_1).
    const apart = moveClip(base(), { clipId: 'clp_2', startS: 37.5 })
    const t = setActiveTake(apart, { clipId: 'clp_1' })
    assert.equal(clip(t, 'clp_1').active, true)
    assert.equal(clip(t, 'clp_2').active, true)
  })

  await check('setActiveTake: el grupo es local a la pista y un clip sin grupo solo se activa', () => {
    let s = base()
    // Mismo texto de grupo en otra pista, solapado con clp_1.
    s = addClip(s, {
      trackId: 'trk_3',
      clip: { id: 'clp_x', assetId: 'ast_p1', startS: 8, offsetS: 0, lengthS: 10, gainDb: 0, fadeInS: 0, fadeOutS: 0, takeGroup: 'tk_1', active: true },
    })
    s = addClip(s, {
      trackId: 'trk_1',
      clip: { id: 'clp_y', assetId: 'ast_a1', startS: 8, offsetS: 0, lengthS: 10, gainDb: 0, fadeInS: 0, fadeOutS: 0, takeGroup: null, active: false },
    })
    const t = setActiveTake(s, { clipId: 'clp_1' })
    assert.equal(clip(t, 'clp_x').active, true)
    const u = setActiveTake(t, { clipId: 'clp_y' })
    assert.equal(clip(u, 'clp_y').active, true)
    assert.equal(clip(u, 'clp_1').active, true)
  })

  await check('addTrack: posicion, id repetido, id reservado y tope de 16', () => {
    const s = base()
    const added = addTrack(s, { track: defaultTrack({ id: 'trk_n', name: 'Bajo', role: 'bass' }), index: 1 })
    assert.deepStrictEqual(added.tracks.map((t) => t.id), ['trk_1', 'trk_n', 'trk_2', 'trk_3'])
    assert.equal(addTrack(s, { track: defaultTrack({ id: 'trk_n', name: 'Bajo' }) }).tracks.at(-1)?.id, 'trk_n')
    sessionError(() => addTrack(s, { track: defaultTrack({ id: 'trk_1', name: 'Otra' }) }), 'duplicate_id')
    sessionError(() => addTrack(s, { track: defaultTrack({ id: 'master', name: 'Master' }) }), 'bad_id')
    let full = s
    for (let i = full.tracks.length; i < STUDIO_MAX_TRACKS; i++) full = addTrack(full, { track: defaultTrack({ id: `trk_f${i}`, name: `Pista ${i}` }) })
    assert.equal(full.tracks.length, 16)
    sessionError(() => addTrack(full, { track: defaultTrack({ id: 'trk_17', name: 'De mas' }) }), 'too_many', 'tracks')
  })

  await check('removeTrack quita la pista con sus clips y deja los audios', () => {
    const s = base()
    const r = removeTrack(s, { trackId: 'trk_2' })
    assert.deepStrictEqual(r.tracks.map((t) => t.id), ['trk_1', 'trk_3'])
    assert.equal(r.assets, s.assets)
    assert.equal(findClip(r, 'clp_3'), null)
    sessionError(() => removeTrack(s, { trackId: 'trk_9' }), 'bad_id', 'track_id')
  })

  await check('updateTrack: acota los niveles, recorta el nombre y no cambia nada si todo es igual', () => {
    const s = base()
    const u = updateTrack(s, { trackId: 'trk_2', patch: { volumeDb: 50, pan: -4, reverbSendDb: 6, mute: true, name: '  Guitarra L  ' } })
    const t = findTrack(u, 'trk_2')
    assert.deepStrictEqual([t?.volumeDb, t?.pan, t?.reverbSendDb, t?.mute, t?.name], [12, -1, 0, true, 'Guitarra L'])
    assert.equal(t?.clips, s.tracks[1].clips)
    assert.equal(updateTrack(s, { trackId: 'trk_2', patch: { volumeDb: -3, solo: false } }), s)
    assert.equal(updateTrack(s, { trackId: 'trk_2', patch: {} }), s)
    sessionError(() => updateTrack(s, { trackId: 'trk_2', patch: { name: '   ' } }), 'out_of_range', 'tracks[1].name')
  })

  await check('setTrackFx: acota parametros y respeta las reglas de la cadena', () => {
    const s = base()
    const eq = defaultFx('eq')
    const set = setTrackFx(s, { trackId: 'trk_2', fx: [{ ...eq, params: { ...eq.params, lowDb: 40, midHz: 5 } }] })
    const fx = findTrack(set, 'trk_2')?.fx[0]
    assert.equal(fx?.type, 'eq')
    assert.deepStrictEqual(fx?.params, { hpfHz: 0, lowDb: 18, midHz: 200, midDb: 0, midQ: 1, highDb: 0 })
    sessionError(() => setTrackFx(s, { trackId: 'trk_2', fx: [defaultFx('limiter')] }), 'bad_fx')
    sessionError(() => setTrackFx(s, { trackId: 'trk_2', fx: [defaultFx('eq'), defaultFx('eq')] }), 'bad_fx')
    const master = setTrackFx(s, { trackId: 'master', fx: [defaultFx('eq'), defaultFx('compressor'), defaultFx('limiter')] })
    assert.deepStrictEqual(master.master.fx.map((f) => f.type), ['eq', 'compressor', 'limiter'])
    assert.equal(master.tracks, s.tracks)
    sessionError(() => setTrackFx(s, { trackId: 'master', fx: [defaultFx('limiter'), defaultFx('eq')] }), 'bad_fx')
    assert.equal(setTrackFx(s, { trackId: 'master', fx: [defaultFx('limiter')] }), s)
    assert.equal(setTrackFx(s, { trackId: 'trk_1', fx: structuredClone(s.tracks[0].fx) }), s)
  })

  await check('updateMaster y updateSessionMeta acotan y validan', () => {
    const s = base()
    const m = updateMaster(s, { patch: { volumeDb: 40, reverb: { decayS: 99, returnDb: -100 } } })
    assert.deepStrictEqual([m.master.volumeDb, m.master.reverb.decayS, m.master.reverb.returnDb], [12, 10, -60])
    assert.equal(m.master.fx, s.master.fx)
    assert.equal(updateMaster(s, { patch: { volumeDb: 0, reverb: { decayS: 1.8, returnDb: 0 } } }), s)
    const meta = updateSessionMeta(s, { patch: { title: '  Otra  ', bpm: 999, beatsPerBar: 3.4, key: '', latencyOffsetMs: -9999 } })
    assert.deepStrictEqual([meta.title, meta.bpm, meta.beatsPerBar, meta.key, meta.latencyOffsetMs], ['Otra', 260, 3, null, -500])
    assert.equal(meta.tracks, s.tracks)
    assert.equal(updateSessionMeta(s, { patch: { bpm: 128 } }), s)
    sessionError(() => updateSessionMeta(s, { patch: { title: '  ' } }), 'out_of_range', 'title')
  })

  await check('addAsset y addClip: audio repetido, audio desconocido y ventana fuera del audio', () => {
    const s = base()
    const asset: StudioAsset = { id: 'ast_n', file: 'ast_n.wav', kind: 'recording', label: 'Toma 3', channels: 1, sampleRate: 48000, durationS: 5, size: 720044, source: null }
    const withAsset = addAsset(s, { asset })
    assert.equal(withAsset.assets.length, 5)
    assert.equal(addAsset(withAsset, { asset: { ...asset } }), withAsset)
    sessionError(() => addAsset(withAsset, { asset: { ...asset, size: 1 } }), 'duplicate_id')
    sessionError(() => addAsset(s, { asset: { ...asset, file: 'otro.wav' } }), 'bad_value')
    const newClip: StudioClip = { id: 'clp_n', assetId: 'ast_n', startS: 40, offsetS: 0, lengthS: 5, gainDb: 0, fadeInS: 0, fadeOutS: 0, takeGroup: null, active: true }
    const withClip = addClip(withAsset, { trackId: 'trk_1', clip: newClip })
    assert.equal(withClip.tracks[0].clips.at(-1)?.id, 'clp_n')
    sessionError(() => addClip(s, { trackId: 'trk_1', clip: newClip }), 'unknown_asset')
    sessionError(() => addClip(withAsset, { trackId: 'trk_1', clip: { ...newClip, lengthS: 6 } }), 'clip_out_of_asset')
    sessionError(() => addClip(withAsset, { trackId: 'trk_1', clip: { ...newClip, id: 'clp_1' } }), 'duplicate_id')
    sessionError(() => addClip(withAsset, { trackId: 'trk_9', clip: newClip }), 'bad_id', 'track_id')
  })

  await check('removeUnusedAssets quita solo los audios que ningun clip usa', () => {
    const s = base()
    assert.equal(removeUnusedAssets(s), s)
    const cleaned = removeUnusedAssets(deleteClip(s, { clipId: 'clp_4' }))
    // ast_a1 lo usa una toma inactiva: se queda.
    assert.deepStrictEqual(cleaned.assets.map((a) => a.id), ['ast_a1', 'ast_a2', 'ast_g1'])
    validateSession(cleaned)
  })

  await check('applyMixSuggestion: fader, paneo y efectos (mezcla, agrega, limitador de ultimo)', () => {
    const s = base()
    const vol = applyMixSuggestion(s, { suggestion: { trackId: 'trk_1', target: 'volume_db', value: -3, reason: 'r' } })
    assert.equal(findTrack(vol, 'trk_1')?.volumeDb, -3)
    assert.equal(applyMixSuggestion(s, { suggestion: { trackId: 'master', target: 'volume_db', value: -2, reason: 'r' } }).master.volumeDb, -2)
    sessionError(() => applyMixSuggestion(s, { suggestion: { trackId: 'master', target: 'pan', value: 0.2, reason: 'r' } }), 'bad_value')
    assert.equal(findTrack(applyMixSuggestion(s, { suggestion: { trackId: 'trk_2', target: 'pan', value: 0.4, reason: 'r' } }), 'trk_2')?.pan, 0.4)

    // La pista ya tiene EQ: se reemplazan solo los parametros listados y se quita el bypass.
    const bypassed = setTrackFx(s, { trackId: 'trk_1', fx: [{ ...s.tracks[0].fx[0], bypass: true }, s.tracks[0].fx[1]] })
    const merged = applyMixSuggestion(bypassed, { suggestion: { trackId: 'trk_1', target: 'fx', fxType: 'eq', params: { hpfHz: 80, lowDb: -2 }, reason: 'r' } })
    const eq = findTrack(merged, 'trk_1')?.fx[0]
    assert.equal(eq?.bypass, false)
    assert.deepStrictEqual(eq?.params, { hpfHz: 80, lowDb: -2, midHz: 2500, midDb: 2, midQ: 1, highDb: 1.5 })
    assert.equal(findTrack(merged, 'trk_1')?.fx[1].type, 'compressor')

    // La pista no lo tiene: se agrega con los valores por defecto mas los propuestos.
    const added = applyMixSuggestion(s, { suggestion: { trackId: 'trk_2', target: 'fx', fxType: 'compressor', params: { ratio: 4 }, reason: 'r' } })
    assert.deepStrictEqual(findTrack(added, 'trk_2')?.fx[0].params, { thresholdDb: -18, ratio: 4, attackMs: 10, releaseMs: 150, kneeDb: 6, makeupDb: 0 })

    // En el master el EQ nuevo entra antes del limitador.
    const master = applyMixSuggestion(s, { suggestion: { trackId: 'master', target: 'fx', fxType: 'eq', params: { highDb: 1 }, reason: 'r' } })
    assert.deepStrictEqual(master.master.fx.map((f) => f.type), ['eq', 'limiter'])
    const limited = applyMixSuggestion(master, { suggestion: { trackId: 'master', target: 'fx', fxType: 'limiter', params: { ceilingDb: -2 }, reason: 'r' } })
    assert.deepStrictEqual(limited.master.fx.at(-1)?.params, { ceilingDb: -2, releaseMs: 100 })
    sessionError(() => applyMixSuggestion(s, { suggestion: { trackId: 'trk_2', target: 'fx', fxType: 'limiter', params: {}, reason: 'r' } }), 'bad_fx')
    sessionError(() => applyMixSuggestion(s, { suggestion: { trackId: 'trk_9', target: 'volume_db', value: 0, reason: 'r' } }), 'bad_id')
    for (const r of [vol, merged, added, master, limited]) validateSession(r)
  })

  await check('snapTime: rejilla de compas y de tiempo a 128 BPM en 4/4', () => {
    const s = base()
    close(snapTime(s, { timeS: 2.0, mode: 'bar' }), 1.875)
    close(snapTime(s, { timeS: 2.9, mode: 'bar' }), 3.75)
    close(snapTime(s, { timeS: 2.2, mode: 'beat' }), 2.34375)
    close(snapTime(s, { timeS: 0.2, mode: 'beat' }), 0)
    assert.equal(snapTime(s, { timeS: 2.2, mode: 'off' }), 2.2)
    assert.equal(snapTime(s, { timeS: -5, mode: 'off' }), 0)
    assert.equal(snapTime(s, { timeS: -5, mode: 'bar' }), 0)
    assert.ok(snapTime(s, { timeS: 5000, mode: 'bar' }) <= 1200)
  })

  // =========================================================================
  console.log('\nhistory.ts')

  await check('deshacer y rehacer recorren los estados con sus etiquetas', () => {
    const h = createHistory<string>(STUDIO_HISTORY_LIMIT)
    assert.equal(h.current(), null)
    assert.equal(h.undo(), null)
    assert.equal(h.canUndo(), false)
    h.push('a')
    assert.equal(h.canUndo(), false, 'la linea base no se deshace')
    assert.equal(h.undoLabel(), null)
    h.push('b', 'Mover clip')
    h.push('c', 'Dividir clip')
    assert.equal(h.undoLabel(), 'Dividir clip')
    assert.equal(h.undo(), 'b')
    assert.equal(h.undoLabel(), 'Mover clip')
    assert.equal(h.redoLabel(), 'Dividir clip')
    assert.equal(h.undo(), 'a')
    assert.equal(h.undo(), null)
    assert.equal(h.current(), 'a')
    assert.equal(h.redo(), 'b')
    assert.equal(h.redo(), 'c')
    assert.equal(h.redo(), null)
    assert.equal(h.canRedo(), false)
  })

  await check('un push despues de deshacer descarta lo que se podia rehacer; el mismo estado no cuenta', () => {
    const h = createHistory<{ n: number }>(10)
    const a = { n: 1 }
    const b = { n: 2 }
    const c = { n: 3 }
    h.push(a)
    h.push(b, 'B')
    h.push(b, 'repetido')
    assert.equal(h.undoLabel(), 'B')
    h.undo()
    h.push(c, 'C')
    assert.equal(h.canRedo(), false)
    assert.equal(h.redo(), null)
    assert.equal(h.undo(), a)
    h.clear()
    assert.equal(h.current(), null)
    assert.equal(h.canUndo(), false)
  })

  await check('al pasar el limite olvida el paso mas viejo', () => {
    const h = createHistory<number>(3)
    for (let i = 0; i <= 10; i++) h.push(i, `paso ${i}`)
    const undone: number[] = []
    for (let v = h.undo(); v !== null; v = h.undo()) undone.push(v)
    assert.deepStrictEqual(undone, [9, 8, 7])
    assert.equal(h.current(), 7)
  })

  await check('la sesion editada se deshace por referencia', () => {
    const h = createHistory<StudioSession>(STUDIO_HISTORY_LIMIT)
    const s0 = base()
    const s1 = moveClip(s0, { clipId: 'clp_1', startS: 20 })
    const s2 = splitClip(s1, { clipId: 'clp_1', atS: 30, newClipId: 'clp_new' })
    h.push(s0)
    h.push(s1, 'Mover clip')
    h.push(s2, 'Dividir clip')
    h.push(moveClip(s2, { clipId: 'clp_1', startS: 20 }), 'Mover clip')
    assert.equal(h.current(), s2, 'una operacion sin cambio no crea un paso')
    assert.equal(h.undo(), s1)
    assert.equal(h.undo(), s0)
    assert.equal(h.redo(), s1)
  })

  // =========================================================================
  console.log('\nlatency.ts')

  await check('alineacion de toma: posicion + (primer bloque - arranque) - ida y vuelta', () => {
    close(takeStartSeconds({ positionAtStart: 8, firstBlockCtxTime: 10.02, playStartCtxTime: 10, roundTripSeconds: 0.012 }), 8.008, 1e-12)
    // Grabacion armada antes del arranque: el primer bloque llega antes que la reproduccion.
    close(takeStartSeconds({ positionAtStart: 0, firstBlockCtxTime: 4.9, playStartCtxTime: 5, roundTripSeconds: 0.02 }), -0.12, 1e-12)
    close(browserLatencySeconds({ baseLatency: 0.005, outputLatency: 0.012, inputLatency: 0.003 }), 0.02, 1e-12)
    assert.equal(browserLatencySeconds({ baseLatency: Number.NaN, outputLatency: -1, inputLatency: 0 }), 0)
  })

  for (const rate of [44100, 48000, 96000]) {
    await check(`correlacion: retardo conocido de 1234 muestras a ${rate} Hz`, () => {
      const signal = calibrationSignal(rate)
      close(signal.length, 0.6 * rate, 1)
      const recorded = delayed(signal, 1234, 0.5, signal.length + rate)
      const est = estimateDelaySamples(signal, recorded, rate, 500)
      assert.equal(est.delaySamples, 1234)
      assert.ok(est.confidence > 0.95, `confianza ${est.confidence}`)
    })
  }

  await check('correlacion: mismo retardo con ruido de fondo y con la polaridad invertida', () => {
    const rate = 48000
    const signal = calibrationSignal(rate)
    const random = prng(7)
    const noisy = delayed(signal, 911, 0.5, signal.length + rate)
    for (let i = 0; i < noisy.length; i++) noisy[i] += (random() * 2 - 1) * 0.03
    const est = estimateDelaySamples(signal, noisy, rate, 500)
    assert.equal(est.delaySamples, 911)
    assert.ok(est.confidence > LATENCY_MIN_CONFIDENCE, `confianza ${est.confidence}`)
    const inverted = estimateDelaySamples(signal, delayed(signal, 911, -0.5, signal.length + rate), rate, 500)
    assert.equal(inverted.delaySamples, 911)
    assert.ok(inverted.confidence > 0.95)
    assert.equal(estimateDelaySamples(signal, delayed(signal, 0, 1, signal.length), rate, 500).delaySamples, 0)
  })

  await check('correlacion: una referencia densa (ruido) tambien se alinea', () => {
    const rate = 48000
    const random = prng(11)
    const reference = new Float32Array(4800)
    for (let i = 0; i < reference.length; i++) reference[i] = random() * 2 - 1
    const recorded = delayed(reference, 480, 0.7, 12000)
    for (let i = 0; i < recorded.length; i++) recorded[i] += (random() * 2 - 1) * 0.2
    const est = estimateDelaySamples(reference, recorded, rate, 50)
    assert.equal(est.delaySamples, 480)
    assert.ok(est.confidence > 0.8, `confianza ${est.confidence}`)
  })

  await check('correlacion: sin la senal (solo ruido, o silencio) la confianza no alcanza', () => {
    const rate = 48000
    const signal = calibrationSignal(rate)
    const random = prng(3)
    const noise = new Float32Array(signal.length + rate)
    for (let i = 0; i < noise.length; i++) noise[i] = (random() * 2 - 1) * 0.1
    assert.ok(estimateDelaySamples(signal, noise, rate, 500).confidence < LATENCY_MIN_CONFIDENCE)
    assert.deepStrictEqual(estimateDelaySamples(signal, new Float32Array(48000), rate, 500), { delaySamples: 0, confidence: 0 })
    assert.equal(estimateDelaySamples(new Float32Array(100), noise, rate, 500).confidence, 0)
    assert.equal(estimateDelaySamples(signal, new Float32Array(0), rate, 500).confidence, 0)
  })

  await check('la calibracion se guarda por interfaz y frecuencia', () => {
    const storage = memoryStorage()
    assert.equal(calibrationKey('  UMC202HD 192k  ', 48000), 'bandait_studio_latency:umc202hd_192k:48000')
    assert.equal(calibrationKey('', 44100), 'bandait_studio_latency:default:44100')
    assert.equal(loadCalibration(storage, 'UMC202HD 192k', 48000), null)
    const calibration = { deviceLabel: 'UMC202HD 192k', sampleRate: 48000, roundTripSeconds: 0.0183, confidence: 0.97, spreadSeconds: 0.0002, measuredAt: '2026-11-19T15:00:00.000Z' }
    saveCalibration(storage, calibration)
    assert.deepStrictEqual(loadCalibration(storage, 'UMC202HD 192k', 48000), calibration)
    assert.equal(loadCalibration(storage, 'UMC202HD 192k', 44100), null, 'otra frecuencia es otra calibracion')
    assert.equal(loadCalibration(storage, 'Otra interfaz', 48000), null)
    storage.data.set(calibrationKey('Rota', 48000), '{no es json')
    assert.equal(loadCalibration(storage, 'Rota', 48000), null)
    storage.data.set(calibrationKey('Rara', 48000), JSON.stringify({ sampleRate: 48000, roundTripSeconds: -1, confidence: 1 }))
    assert.equal(loadCalibration(storage, 'Rara', 48000), null)
    clearCalibration(storage, 'UMC202HD 192k', 48000)
    assert.equal(loadCalibration(storage, 'UMC202HD 192k', 48000), null)
  })

  // =========================================================================
  console.log('\nloudness.ts (ITU-R BS.1770-4)')

  await check('la ponderacion K a 48 kHz da los coeficientes de la norma', () => {
    const k = kWeightingCoefficients(48000)
    close(k.shelf.b0, 1.53512485958697, 1e-6)
    close(k.shelf.b1, -2.69169618940638, 1e-6)
    close(k.shelf.b2, 1.19839281085285, 1e-6)
    close(k.shelf.a1, -1.69065929318241, 1e-6)
    close(k.shelf.a2, 0.73248077421585, 1e-6)
    close(k.highpass.a1, -1.99004745483398, 1e-6)
    close(k.highpass.a2, 0.99007225036621, 1e-6)
    assert.deepStrictEqual([k.highpass.b0, k.highpass.b1, k.highpass.b2], [1, -2, 1])
  })

  for (const rate of [44100, 48000, 88200, 96000]) {
    await check(`seno de 997 Hz a -23 dBFS en estereo, ${rate} Hz: -23,0 LUFS`, () => {
      const tone = sine(997, dbToAmp(-23), 20, rate)
      close(integratedLufs([tone, tone], rate), -23, 0.1)
    })
  }

  await check('el mismo seno en un solo canal mide 3 dB menos; a 0 dBFS, -3,01', () => {
    close(integratedLufs([sine(997, dbToAmp(-23), 10, 48000)], 48000), -26.01, 0.1)
    close(integratedLufs([sine(997, 1, 10, 48000)], 48000), -3.01, 0.1)
    const tone = sine(997, dbToAmp(-23), 10, 48000)
    close(integratedLufs([tone, new Float32Array(tone.length)], 48000), -26.01, 0.1)
  })

  await check('silencio y audio de menos de 400 ms: -Infinity', () => {
    assert.equal(integratedLufs([new Float32Array(96000), new Float32Array(96000)], 48000), -Infinity)
    assert.equal(integratedLufs([sine(997, 0.5, 0.3, 48000)], 48000), -Infinity)
    assert.equal(integratedLufs([], 48000), -Infinity)
    // Por debajo de la compuerta absoluta de -70 LUFS tambien es silencio.
    assert.equal(integratedLufs([sine(997, dbToAmp(-80), 5, 48000)], 48000), -Infinity)
  })

  await check('compuerta absoluta: el silencio alrededor de la musica no baja la medida', () => {
    const rate = 48000
    const tone = sine(997, dbToAmp(-23), 10, rate)
    const padded = concat(new Float32Array(10 * rate), tone, new Float32Array(10 * rate))
    close(integratedLufs([padded, padded], rate), -23, 0.2)
  })

  await check('compuerta relativa: un pasaje 30 dB mas bajo no cuenta', () => {
    const rate = 48000
    // 10 s a -23 dBFS y 10 s a -53 dBFS. Sin compuerta relativa la media daria -26,0.
    const signal = concat(sine(997, dbToAmp(-23), 10, rate), sine(997, dbToAmp(-53), 10, rate))
    const lufs = integratedLufs([signal, signal], rate)
    close(lufs, -23.07, 0.1)
    // Un pasaje solo 6 dB mas bajo SI cuenta: queda por encima de la compuerta relativa.
    const soft = concat(sine(997, dbToAmp(-23), 10, rate), sine(997, dbToAmp(-29), 10, rate))
    close(integratedLufs([soft, soft], rate), -23 + 10 * Math.log10((1 + Math.pow(10, -0.6)) / 2), 0.1)
  })

  await check('el medidor incremental da lo mismo por bloques de 128 que de una vez', () => {
    const rate = 48000
    const random = prng(5)
    const left = new Float32Array(rate * 6)
    const right = new Float32Array(rate * 6)
    for (let i = 0; i < left.length; i++) {
      const env = i < rate * 3 ? 0.3 : 0.05
      left[i] = (random() * 2 - 1) * env
      right[i] = (random() * 2 - 1) * env
    }
    const whole = integratedLufs([left, right], rate)
    const meter = createLoudnessMeter(rate, 2)
    assert.equal(meter.momentaryLufs(), -Infinity)
    for (let o = 0; o < left.length; o += 128) meter.push([left.subarray(o, o + 128), right.subarray(o, o + 128)])
    close(meter.integratedLufs(), whole, 1e-9)
    assert.ok(Number.isFinite(meter.momentaryLufs()))
    assert.ok(meter.momentaryLufs() < whole, 'los ultimos 400 ms son el pasaje bajo')
    meter.reset()
    assert.equal(meter.integratedLufs(), -Infinity)
  })

  await check('pico real: un seno en fs/4 desfasado 45 grados llega a 0 dBTP aunque sus muestras marquen -3', () => {
    const rate = 48000
    const tone = sine(rate / 4, 1, 1, rate, Math.PI / 4)
    let samplePeak = 0
    for (const v of tone) samplePeak = Math.max(samplePeak, Math.abs(v))
    close(20 * Math.log10(samplePeak), -3.01, 0.01)
    close(truePeakDb([tone], rate), 0, 0.1)
  })

  await check('pico real: seno grave, estereo (gana el canal mas alto) y silencio', () => {
    close(truePeakDb([sine(100, 0.5, 1, 48000)], 48000), -6.02, 0.05)
    close(truePeakDb([sine(440, 0.25, 1, 44100), sine(440, 0.8, 1, 44100)], 44100), 20 * Math.log10(0.8), 0.05)
    assert.equal(truePeakDb([new Float32Array(4800)], 48000), -Infinity)
    assert.equal(truePeakDb([], 48000), -Infinity)
    // Una muestra suelta a fondo de escala: el pico real no puede ser menor que el de muestra.
    const click = new Float32Array(1000)
    click[500] = 1
    assert.ok(truePeakDb([click], 48000) >= 0)
  })

  await check('ganancia hacia un LUFS objetivo, limitada por el techo de pico real', () => {
    assert.equal(gainToTargetLufs(-20, -14), 6)
    assert.equal(gainToTargetLufs(-10, -14), -4)
    assert.equal(gainToTargetLufs(-20, -14, -3), 2, 'techo por defecto de -1 dBTP')
    assert.equal(gainToTargetLufs(-20, -14, -3, -0.5), 2.5)
    assert.equal(gainToTargetLufs(-20, -14, -12), 6)
    assert.equal(gainToTargetLufs(-Infinity, -14), 0)
  })

  await check('energia por bandas: cada seno cae en su banda', () => {
    const rate = 48000
    const cases: Array<[number, 'lowDb' | 'lowMidDb' | 'highMidDb' | 'highDb']> = [
      [100, 'lowDb'],
      [1000, 'lowMidDb'],
      [4000, 'highMidDb'],
      [10000, 'highDb'],
    ]
    for (const [hz, band] of cases) {
      const bands = bandEnergiesDb([sine(hz, 0.5, 2, rate)], rate)
      assert.ok(bands, `${hz} Hz`)
      for (const key of ['lowDb', 'lowMidDb', 'highMidDb', 'highDb'] as const) {
        if (key === band) assert.ok(bands[key] > -0.1 && bands[key] <= 0, `${hz} Hz en ${key}: ${bands[key]}`)
        else assert.ok(bands[key] < -40 && bands[key] >= -120, `${hz} Hz fuera de ${key}: ${bands[key]}`)
      }
    }
    const two = bandEnergiesDb([concat(sine(100, 0.5, 2, rate)).map((v, i) => v + 0.5 * Math.sin((2 * Math.PI * 10000 * i) / rate))], rate)
    assert.ok(two)
    close(two.lowDb, -3.01, 0.2)
    close(two.highDb, -3.01, 0.2)
    assert.equal(bandEnergiesDb([new Float32Array(48000)], rate), null)
    assert.equal(bandEnergiesDb([], rate), null)
    assert.ok(bandEnergiesDb([sine(1000, 0.5, 1, 96000)], 96000)!.lowMidDb > -0.1)
  })

  // =========================================================================
  console.log('\npeaks.ts')

  await check('computePeaks: minimo y maximo por cubeta en Int8; la ultima cubeta puede ser parcial', () => {
    const samples = new Float32Array([0, 0.5, -0.25, 1, -1, 0.1, 2, -3, 0.3])
    const p = computePeaks(samples, 4)
    assert.equal(p.samplesPerBucket, 4)
    assert.ok(p.min instanceof Int8Array && p.max instanceof Int8Array)
    assert.deepStrictEqual([...p.max], [127, 127, 38])
    assert.deepStrictEqual([...p.min], [-32, -127, 38])
    assert.equal(computePeaks(new Float32Array(0), 256).min.length, 0)
    assert.equal(computePeaks(new Float32Array(PEAKS_BASE_BUCKET * 3 + 1), PEAKS_BASE_BUCKET).max.length, 4)
    assert.throws(() => computePeaks(samples, 0))
  })

  await check('peaksForRange: reagrupa cubetas en columnas y devuelve 0 fuera del audio', () => {
    const rate = 1000
    const samples = new Float32Array(1000)
    for (let i = 0; i < samples.length; i++) samples[i] = i < 500 ? 0.5 : -1
    samples[100] = 1
    const p = computePeaks(samples, 10)
    const cols = peaksForRange(p, { sampleRate: rate, startS: 0, endS: 1, columns: 4 })
    assert.equal(cols.max.length, 4)
    close(cols.max[0], 1, 1e-6)
    close(cols.min[0], 64 / 127, 1e-6)
    close(cols.max[1], 64 / 127, 1e-6)
    close(cols.min[2], -1, 1e-6)
    close(cols.max[3], -1, 1e-6)
    // Ventana dentro del audio: solo la segunda mitad.
    const tail = peaksForRange(p, { sampleRate: rate, startS: 0.5, endS: 1, columns: 5 })
    for (let c = 0; c < 5; c++) close(tail.max[c], -1, 1e-6)
    // Mas columnas que cubetas: cada columna toma la cubeta que la contiene.
    const zoom = peaksForRange(p, { sampleRate: rate, startS: 0.1, endS: 0.11, columns: 8 })
    for (let c = 0; c < 8; c++) close(zoom.max[c], 1, 1e-6)
    // Fuera del audio.
    const beyond = peaksForRange(p, { sampleRate: rate, startS: 0.9, endS: 1.1, columns: 2 })
    close(beyond.min[0], -1, 1e-6)
    assert.deepStrictEqual([beyond.min[1], beyond.max[1]], [0, 0])
  })

  await check('peaksForRange reutiliza el arreglo de salida si tiene el tamano correcto', () => {
    const p = computePeaks(sine(5, 1, 1, 1000), 10)
    const out = { min: new Float32Array(50), max: new Float32Array(50) }
    assert.equal(peaksForRange(p, { sampleRate: 1000, startS: 0, endS: 1, columns: 50 }, out), out)
    assert.ok(out.max.some((v) => v > 0.9))
    assert.notEqual(peaksForRange(p, { sampleRate: 1000, startS: 0, endS: 1, columns: 20 }, out), out)
  })

  // =========================================================================
  console.log('\nwav.ts (24 bits)')

  function decodePcm(buffer: ArrayBuffer): { header: NonNullable<ReturnType<typeof parseWavHeader>>; channels: Float32Array[] } {
    const header = parseWavHeader(buffer)
    assert.ok(header, 'la cabecera se debe poder leer')
    const view = new DataView(buffer)
    const bytes = header.bitsPerSample / 8
    const channels = Array.from({ length: header.channels }, () => new Float32Array(header.frames))
    let o = header.dataOffset
    for (let i = 0; i < header.frames; i++) {
      for (let c = 0; c < header.channels; c++) {
        if (bytes === 3) {
          const v = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16)
          channels[c][i] = v / 0x800000
        } else {
          channels[c][i] = view.getInt16(o, true) / 0x8000
        }
        o += bytes
      }
    }
    return { header, channels }
  }

  await check('WAV de 24 bits estereo: ida y vuelta con error menor a un paso de cuantizacion', () => {
    const random = prng(21)
    const left = new Float32Array(4801)
    const right = new Float32Array(4801)
    for (let i = 0; i < left.length; i++) {
      left[i] = random() * 2 - 1
      right[i] = (random() * 2 - 1) * 0.001
    }
    const wav = encodeWav24([left, right], 48000)
    assert.equal(wav.byteLength, WAV_HEADER_BYTES + 4801 * 2 * 3)
    const { header, channels } = decodePcm(wav)
    assert.deepStrictEqual(
      { format: header.format, channels: header.channels, sampleRate: header.sampleRate, bits: header.bitsPerSample, offset: header.dataOffset, bytes: header.dataBytes, frames: header.frames },
      { format: 1, channels: 2, sampleRate: 48000, bits: 24, offset: 44, bytes: 4801 * 6, frames: 4801 }
    )
    close(header.durationS, 4801 / 48000, 1e-12)
    const step = 1 / 0x7fffff
    for (let i = 0; i < left.length; i++) {
      assert.ok(Math.abs(channels[0][i] - left[i]) <= step, `izquierda ${i}`)
      assert.ok(Math.abs(channels[1][i] - right[i]) <= step, `derecha ${i}`)
    }
    const view = new DataView(wav)
    assert.equal(view.getUint32(4, true), wav.byteLength - 8)
    assert.equal(view.getUint32(28, true), 48000 * 6)
    assert.equal(view.getUint16(32, true), 6)
  })

  await check('WAV de 24 bits: satura fuera de [-1, 1] y conserva los extremos', () => {
    const wav = encodeWav24([new Float32Array([1, -1, 2, -2, 0, Number.NaN])], 44100)
    const view = new DataView(wav)
    const at = (i: number) => view.getUint8(44 + i * 3) | (view.getUint8(45 + i * 3) << 8) | (view.getInt8(46 + i * 3) << 16)
    assert.deepStrictEqual([at(0), at(1), at(2), at(3), at(4), at(5)], [0x7fffff, -0x800000, 0x7fffff, -0x800000, 0, 0])
    assert.equal(parseWavHeader(wav)?.channels, 1)
  })

  await check('floatTo24 escribe los mismos bytes que encodeWav24 y devuelve el siguiente offset', () => {
    const samples = new Float32Array([0.5, -0.5, 0.123456, -0.999999, 1.5])
    const out = new Uint8Array(4 + samples.length * 3)
    assert.equal(floatTo24(samples, out, 4), 4 + samples.length * 3)
    const reference = new Uint8Array(encodeWav24([samples], 48000)).subarray(44)
    assert.deepStrictEqual([...out.subarray(4)], [...reference])
    assert.deepStrictEqual([...out.subarray(0, 4)], [0, 0, 0, 0])
  })

  await check('cabecera provisional (toma sin cerrar), bloques extra, formato extensible y basura', () => {
    const open = parseWavHeader(buildWavHeader({ channels: 1, sampleRate: 48000, bitDepth: 24, dataBytes: 0 }))
    assert.deepStrictEqual([open?.dataBytes, open?.frames, open?.dataOffset, open?.bitsPerSample], [0, 0, 44, 24])
    // Un bloque LIST de largo impar (con su byte de relleno) antes de `data`.
    const plain = new Uint8Array(encodeWavPcm([new Float32Array(10), new Float32Array(10)], 44100, 16))
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0])
    const withList = new Uint8Array(plain.length + list.length)
    withList.set(plain.subarray(0, 36), 0)
    withList.set(list, 36)
    withList.set(plain.subarray(36), 36 + list.length)
    const parsed = parseWavHeader(withList)
    assert.deepStrictEqual([parsed?.dataOffset, parsed?.frames, parsed?.channels, parsed?.bitsPerSample], [56, 10, 2, 16])
    // Solo los primeros bytes del archivo: basta con que incluyan el bloque data.
    assert.equal(parseWavHeader(plain.subarray(0, 44))?.frames, 10)
    assert.equal(parseWavHeader(plain.subarray(0, 40)), null)
    // WAVE_FORMAT_EXTENSIBLE con subformato de coma flotante.
    const ext = new Uint8Array(12 + 8 + 40 + 8)
    const view = new DataView(ext.buffer)
    ext.set([0x52, 0x49, 0x46, 0x46], 0)
    ext.set([0x57, 0x41, 0x56, 0x45], 8)
    ext.set([0x66, 0x6d, 0x74, 0x20], 12)
    view.setUint32(16, 40, true)
    view.setUint16(20, 0xfffe, true)
    view.setUint16(22, 2, true)
    view.setUint32(24, 96000, true)
    view.setUint32(28, 96000 * 8, true)
    view.setUint16(32, 8, true)
    view.setUint16(34, 32, true)
    view.setUint16(36, 22, true)
    view.setUint16(44, 3, true)
    ext.set([0x64, 0x61, 0x74, 0x61], 60)
    view.setUint32(64, 800, true)
    const float = parseWavHeader(ext)
    assert.deepStrictEqual([float?.format, float?.channels, float?.sampleRate, float?.frames, float?.dataOffset], [3, 2, 96000, 100, 68])
    assert.equal(parseWavHeader(new Uint8Array(100)), null)
    assert.equal(parseWavHeader(new TextEncoder().encode('ID3 esto no es un wav, es otra cosa')), null)
  })

  await check('el WAV de 16 bits mono de la mezcla (encodeWav16) no cambio y se lee con parseWavHeader', () => {
    const mono = encodeWav16(new Float32Array([0, 0.5, -0.5, 1]), 22050)
    const header = parseWavHeader(mono)
    assert.deepStrictEqual([header?.channels, header?.bitsPerSample, header?.frames, header?.sampleRate], [1, 16, 4, 22050])
    assert.deepStrictEqual([...new Uint8Array(mono)], [...new Uint8Array(encodeWavPcm([new Float32Array([0, 0.5, -0.5, 1])], 22050, 16))])
    assert.throws(() => encodeWavPcm([], 48000, 24))
    assert.throws(() => buildWavHeader({ channels: 1, sampleRate: 0, bitDepth: 24, dataBytes: 0 }))
  })

  // =========================================================================
  console.log('\nstudioCloud.ts (Worker simulado)')

  const band = '11111111-2222-4333-8444-555555555555'
  function newCloud(): { worker: FakeStudioWorker; target: CloudTarget } {
    const worker = new FakeStudioWorker()
    return { worker, target: { baseUrl: 'https://stems.example.test/', band, getToken: async () => 'tok-ok', fetchFn: worker.fetch } }
  }
  /** Sesion pequena con un audio de 1 KB (el fixture declara audios de varios megas). */
  function smallSession(): { session: StudioSession; blob: Blob } {
    let session = newSession({ id: 'ses_nube', title: 'Prueba de nube', sampleRate: 48000, bpm: 100, now: new Date('2026-11-19T10:00:00Z') })
    session = addAsset(session, { asset: { id: 'ast_c1', file: 'ast_c1.wav', kind: 'recording', label: 'Toma', channels: 1, sampleRate: 48000, durationS: 2, size: 1024, source: null } })
    session = addTrack(session, { track: defaultTrack({ id: 'trk_c1', name: 'Voz', role: 'vocals' }) })
    session = addClip(session, {
      trackId: 'trk_c1',
      clip: { id: 'clp_c1', assetId: 'ast_c1', startS: 0, offsetS: 0, lengthS: 2, gainDb: 0, fadeInS: 0, fadeOutS: 0, takeGroup: null, active: true },
    })
    return { session, blob: new Blob([new Uint8Array(1024).fill(7)]) }
  }

  await check('studioUrl arma la ruta de la banda sin barra doble', () => {
    const { target } = newCloud()
    assert.equal(studioUrl(target), `https://stems.example.test/v1/bands/${band}/studio`)
    assert.equal(studioUrl({ ...target, baseUrl: 'http://x', band: 'me' }), 'http://x/v1/bands/me/studio')
  })

  await check('limpieza de audios sin usar: GET inspecciona, POST borra; 403 para un musico; respuesta rara es bad_response', async () => {
    const seen: { method: string; url: string; auth: string | null }[] = []
    const answers: Record<string, () => Response> = {
      GET: () => Response.json({ orphans: 3, bytes: 3072, sample: ['ses_a/ast_1.wav', 7], sessions: 2, protected_sessions: 1, complete: true, blocked: null, deleted: 0, deleted_bytes: 0 }),
      POST: () => Response.json({ orphans: 3, bytes: 3072, sample: [], sessions: 2, protected_sessions: 1, complete: true, blocked: null, deleted: 3, deleted_bytes: 3072 }),
    }
    const target: CloudTarget = {
      baseUrl: 'https://stems.example.test/',
      band,
      getToken: async () => 'tok-ok',
      fetchFn: async (input, init) => {
        const headers = new Headers(init?.headers)
        seen.push({ method: init?.method ?? 'GET', url: String(input), auth: headers.get('Authorization') })
        return answers[init?.method ?? 'GET']()
      },
    }
    assert.deepStrictEqual(await inspectOrphans(target), {
      orphans: 3, bytes: 3072, sample: ['ses_a/ast_1.wav'], sessions: 2, protectedSessions: 1, complete: true, blocked: null, deleted: 0, deletedBytes: 0,
    })
    assert.deepStrictEqual(seen[0], { method: 'GET', url: `https://stems.example.test/v1/bands/${band}/studio/_cleanup`, auth: 'Bearer tok-ok' })
    const cleaned = await cleanOrphans(target)
    assert.deepStrictEqual([cleaned.deleted, cleaned.deletedBytes, seen[1].method], [3, 3072, 'POST'])

    answers.GET = () => Response.json({ orphans: 0, bytes: 0, sample: [], sessions: 1, protected_sessions: 0, complete: false, blocked: 'session_unreadable', deleted: 0, deleted_bytes: 0 })
    const blocked = await inspectOrphans(target)
    assert.deepStrictEqual([blocked.complete, blocked.blocked], [false, 'session_unreadable'])
    answers.POST = () => Response.json({ error: 'not_an_editor' }, { status: 403 })
    await cloudError(cleanOrphans(target), 'not_an_editor', 403)
    answers.GET = () => Response.json({ huerfanos: 1 })
    await cloudError(inspectOrphans(target), 'bad_response')
    assert.deepStrictEqual(parseCleanupReport({ orphans: -2, bytes: 1.5, blocked: 'otra cosa', complete: true }, 200), {
      orphans: 0, bytes: 1, sample: [], sessions: 0, protectedSessions: 0, complete: true, blocked: null, deleted: 0, deletedBytes: 0,
    })
  })

  await check('sin token no sale a la red: no_session 401 con mensaje de sesion de nube', async () => {
    const { worker, target } = newCloud()
    const err = await cloudError(getSession({ ...target, getToken: async () => null }, 'ses_nube'), 'no_session', 401)
    assert.match(err.message, /sesión de nube activa/)
    assert.equal(worker.calls.length, 0)
  })

  await check('getSession: 404 no_session es null; una sesion sin subir no existe', async () => {
    const { worker, target } = newCloud()
    assert.equal(await getSession(target, 'ses_nube'), null)
    assert.equal(worker.calls[0].auth, 'Bearer tok-ok')
    assert.equal(worker.calls[0].path, `/v1/bands/${band}/studio/ses_nube/session`)
    assert.deepStrictEqual(await listSessions(target), [])
  })

  await check('putSession sin el audio subido: 409 missing_asset; la nube no guarda nada', async () => {
    const { target } = newCloud()
    const { session } = smallSession()
    const err = await cloudError(putSession(target, session, { ifMatch: null }), 'missing_asset', 409)
    assert.match(err.message, /Falta subir un audio/)
    assert.equal(await getSession(target, session.id), null)
  })

  await check('crear con If-None-Match: *, leer con ETag y reemplazar con If-Match', async () => {
    const { worker, target } = newCloud()
    const { session, blob } = smallSession()
    assert.deepStrictEqual(await putAsset(target, session.id, 'ast_c1.wav', blob), { file: 'ast_c1.wav', size: 1024 })
    assert.equal(worker.calls.at(-1)?.type, 'audio/wav')

    const created = await putSession(target, session, { ifMatch: null })
    const createCall = worker.calls.at(-1)
    assert.equal(createCall?.ifNoneMatch, '*')
    assert.equal(createCall?.ifMatch, null)
    assert.equal(createCall?.type, 'application/json')
    assert.equal(created.etag, '"v1"')
    assert.equal(created.session.updatedBy, 'user-fake', 'updated_by lo pone el Worker')
    assert.notEqual(created.session.updatedAt, session.updatedAt)
    // El cuerpo viaja en snake_case, tal como lo define el contrato.
    assert.deepStrictEqual(createCall?.body, serializeSession(session))

    const read = await getSession(target, session.id)
    assert.equal(read?.etag, '"v1"')
    assert.deepStrictEqual(read?.session, created.session)

    const edited = moveClip(created.session, { clipId: 'clp_c1', startS: 1 })
    const saved = await putSession(target, edited, { ifMatch: created.etag })
    assert.equal(worker.calls.at(-1)?.ifMatch, '"v1"')
    assert.equal(worker.calls.at(-1)?.ifNoneMatch, null)
    assert.equal(saved.etag, '"v2"')
    assert.equal(clip(saved.session, 'clp_c1').startS, 1)

    assert.deepStrictEqual(await listSessions(target), [{ id: 'ses_nube', title: 'Prueba de nube', songId: null, updatedAt: saved.session.updatedAt }])
  })

  await check('412 session_conflict: ETag viejo, o crear una sesion que ya existe; la nube conserva lo guardado', async () => {
    const { target } = newCloud()
    const { session, blob } = smallSession()
    await putAsset(target, session.id, 'ast_c1.wav', blob)
    const v1 = await putSession(target, session, { ifMatch: null })
    const v2 = await putSession(target, updateSessionMeta(v1.session, { patch: { title: 'De otra persona' } }), { ifMatch: v1.etag })
    const stale = await cloudError(putSession(target, updateSessionMeta(v1.session, { patch: { title: 'La mia' } }), { ifMatch: v1.etag }), 'session_conflict', 412)
    assert.match(stale.message, /Otra persona guardó/)
    await cloudError(putSession(target, session, { ifMatch: null }), 'session_conflict', 412)
    const now = await getSession(target, session.id)
    assert.equal(now?.session.title, 'De otra persona')
    assert.equal(now?.etag, v2.etag)
  })

  await check('un documento invalido no sale a la red: StudioSessionError antes del PUT', async () => {
    const { worker, target } = newCloud()
    const { session } = smallSession()
    const broken = { ...session, bpm: 999 }
    await assert.rejects(putSession(target, broken, { ifMatch: null }), (e: unknown) => e instanceof StudioSessionError && e.code === 'out_of_range')
    assert.equal(worker.calls.length, 0)
    await cloudError(getSession(target, '_usage'), 'bad_session_id', 400)
    await cloudError(getSession(target, 'con espacio'), 'bad_session_id', 400)
    assert.equal(worker.calls.length, 0)
  })

  await check('un audio es inmutable: repetir con el mismo tamano es seguro; con otro, 409 asset_exists', async () => {
    const { worker, target } = newCloud()
    const blob = new Blob([new Uint8Array(1024)])
    await putAsset(target, 'ses_nube', 'ast_c1.wav', blob)
    assert.deepStrictEqual(await putAsset(target, 'ses_nube', 'ast_c1.wav', blob), { file: 'ast_c1.wav', size: 1024 })
    const err = await cloudError(putAsset(target, 'ses_nube', 'ast_c1.wav', new Blob([new Uint8Array(2048)])), 'asset_exists', 409)
    assert.match(err.message, /no se puede reemplazar/)
    const before = worker.calls.length
    await cloudError(putAsset(target, 'ses_nube', 'ast_c1.ogg', blob), 'bad_asset', 400)
    await cloudError(putAsset(target, 'ses_nube', '../x.wav', blob), 'bad_asset', 400)
    await cloudError(putAsset(target, 'ses_nube', 'ast_c2.wav', new Blob([])), 'empty_body', 400)
    assert.equal(worker.calls.length, before, 'los nombres invalidos y los vacios no salen a la red')
    await putAsset(target, 'ses_nube', 'ast_m1.mp3', blob)
    assert.equal(worker.calls.at(-1)?.type, 'audio/mpeg')
  })

  await check('getAsset devuelve los bytes; 404 no_asset si falta', async () => {
    const { target } = newCloud()
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    await putAsset(target, 'ses_nube', 'ast_c1.flac', new Blob([bytes]))
    const blob = await getAsset(target, 'ses_nube', 'ast_c1.flac')
    assert.deepStrictEqual([...new Uint8Array(await blob.arrayBuffer())], [...bytes])
    assert.equal(blob.type, 'audio/flac')
    await cloudError(getAsset(target, 'ses_nube', 'ast_zz.wav'), 'no_asset', 404)
  })

  await check('deleteSession devuelve cuantos objetos borro y es idempotente', async () => {
    const { target } = newCloud()
    const { session, blob } = smallSession()
    await putAsset(target, session.id, 'ast_c1.wav', blob)
    await putSession(target, session, { ifMatch: null })
    assert.equal(await deleteSession(target, session.id), 2)
    assert.equal(await deleteSession(target, session.id), 0)
    assert.equal(await getSession(target, session.id), null)
  })

  await check('errores del Worker y de la red llegan como StemCloudError con mensaje del Estudio', async () => {
    const { worker, target } = newCloud()
    worker.failWith = { status: 403, error: 'not_an_editor' }
    const err = await cloudError(putAsset(target, 'ses_nube', 'ast_c1.wav', new Blob([new Uint8Array(8)])), 'not_an_editor', 403)
    assert.match(err.message, /Owner o el Director musical/)
    worker.failWith = { status: 428, error: 'precondition_required' }
    await cloudError(listSessions(target), 'precondition_required', 428)
    worker.failWith = null
    const offline: CloudTarget = { ...target, fetchFn: async () => Promise.reject(new TypeError('fetch failed')) }
    const net = await cloudError(listSessions(offline), 'network', 0)
    assert.match(net.message, /nube del Estudio/)
    assert.match(studioCloudErrorMessage('no_session', 404), /no existe en la nube/)
    assert.match(studioCloudErrorMessage('no_session', 401), /sesión de nube activa/)
    assert.match(studioCloudErrorMessage('provider_unavailable', 501), /todavía no tiene acceso/)
    assert.match(studioCloudErrorMessage('provider_unavailable', 503), /no está configurado/)
    assert.match(studioCloudErrorMessage('quota_exceeded', 429), /tope de gasto/)
    assert.match(studioCloudErrorMessage('algo_nuevo', 500), /HTTP 500/)
  })

  await check('una sesion de la nube que no cumple el contrato, o sin ETag, es bad_response', async () => {
    const { worker, target } = newCloud()
    worker.sessions.set(`${band}/ses_rota`, { doc: { version: 1, id: 'ses_rota' }, etag: '"v1"' })
    const err = await cloudError(getSession(target, 'ses_rota'), 'bad_response')
    assert.match(err.message, /Falta un campo obligatorio/)
    const { session } = smallSession()
    worker.sessions.set(`${band}/${session.id}`, { doc: serializeSession(session), etag: '' })
    await cloudError(getSession(target, session.id), 'bad_response')
  })

  // =========================================================================
  console.log('\nstudioCloud.ts y jobs.ts (trabajos de IA)')

  const jobAsset = {
    id: 'ast_j1',
    file: 'ast_j1.wav',
    kind: 'master',
    label: 'Master -14 LUFS',
    role: null,
    size: 5000,
    channels: null,
    sample_rate: null,
    duration_s: null,
    source: { provider: 'musicai', job_id: 'job_1' },
  }

  await check('el cuerpo de cada trabajo viaja en snake_case (STUDIO_V1.md 6.1)', () => {
    assert.deepStrictEqual(jobRequestToWire({ kind: 'master', assetId: 'ast_mix', durationS: 240, targetLufs: -14 }), {
      kind: 'master',
      asset_id: 'ast_mix',
      duration_s: 240,
      target_lufs: -14,
    })
    assert.deepStrictEqual(jobRequestToWire({ kind: 'separate', assetId: 'ast_mix', durationS: 240 }), { kind: 'separate', asset_id: 'ast_mix', duration_s: 240 })
    assert.deepStrictEqual(jobRequestToWire({ kind: 'generate', provider: 'lyria', prompt: 'Pad', durationS: 30, bpm: 128, key: 'C#m', instrumental: true }), {
      kind: 'generate',
      provider: 'lyria',
      prompt: 'Pad',
      duration_s: 30,
      bpm: 128,
      key: 'C#m',
      instrumental: true,
    })
    const s = base()
    const wire = jobRequestToWire({
      kind: 'assist',
      metrics: {
        targetLufs: -14,
        master: { lufs: -16.2, truePeakDb: -0.4 },
        tracks: [
          { trackId: 'trk_1', name: 'Voz', role: 'vocals', lufs: -18, truePeakDb: -3, bands: { lowDb: -20, lowMidDb: -1, highMidDb: -9, highDb: -30 }, volumeDb: 0, pan: 0, fx: s.tracks[0].fx },
          { trackId: 'trk_2', name: 'Guitarra', role: 'guitar', lufs: null, truePeakDb: -Infinity, bands: null, volumeDb: -3, pan: -0.25, fx: [] },
        ],
      },
    })
    assert.deepStrictEqual(wire, {
      kind: 'assist',
      metrics: {
        target_lufs: -14,
        master: { lufs: -16.2, true_peak_db: -0.4 },
        tracks: [
          {
            track_id: 'trk_1',
            name: 'Voz',
            role: 'vocals',
            lufs: -18,
            true_peak_db: -3,
            bands: { low_db: -20, low_mid_db: -1, high_mid_db: -9, high_db: -30 },
            volume_db: 0,
            pan: 0,
            fx: (fixture as Json).tracks[0].fx,
          },
          { track_id: 'trk_2', name: 'Guitarra', role: 'guitar', lufs: null, true_peak_db: null, bands: null, volume_db: -3, pan: -0.25, fx: [] },
        ],
      },
    })
    // Nada no finito llega al JSON.
    assert.doesNotMatch(JSON.stringify(wire), /Infinity|NaN/)
  })

  await check('startJob: 202 con el id; estimateJob: costo sin lanzar nada', async () => {
    const { worker, target } = newCloud()
    const req: StudioJobRequest = { kind: 'master', assetId: 'ast_mix', durationS: 240, targetLufs: -14 }
    const est = await estimateJob(target, 'ses_nube', req)
    assert.equal(worker.calls.at(-1)?.search, '?estimate=1')
    assert.deepStrictEqual(est, { kind: 'master', estimatedCostUsd: 0.8, spentUsd: 1.84, budgetUsd: 10, allowed: true })
    assert.equal(worker.jobs.size, 0, 'estimar no lanza el trabajo')
    const started = await startJob(target, 'ses_nube', req)
    assert.deepStrictEqual(started, { status: 'STARTED', jobId: 'job_1', kind: 'master' })
    assert.equal(worker.calls.at(-1)?.method, 'POST')
    assert.equal(worker.calls.at(-1)?.search, '')
    assert.deepStrictEqual(worker.calls.at(-1)?.body, { kind: 'master', asset_id: 'ast_mix', duration_s: 240, target_lufs: -14 })
    worker.jobError = { status: 429, error: 'quota_exceeded' }
    const quota = await cloudError(startJob(target, 'ses_nube', req), 'quota_exceeded', 429)
    assert.match(quota.message, /tope de gasto/)
    worker.jobError = { status: 501, error: 'provider_unavailable' }
    const suno = await cloudError(startJob(target, 'ses_nube', { kind: 'generate', provider: 'suno', prompt: 'x', durationS: 30, bpm: 120, key: null, instrumental: true }), 'provider_unavailable', 501)
    assert.match(suno.message, /todavía no tiene acceso/)
  })

  await check('getJob traduce cada estado; 404 no_job', async () => {
    const { worker, target } = newCloud()
    worker.script('job_1', [
      { status: 200, body: { job_id: 'job_1', kind: 'separate', status: 'QUEUED' } },
      { status: 200, body: { job_id: 'job_1', kind: 'separate', status: 'IMPORTING', done: 9, total: 4 } },
      { status: 200, body: { job_id: 'job_1', kind: 'separate', status: 'FAILED', error: '  ' } },
      { status: 200, body: { job_id: 'job_1', kind: 'master', status: 'SUCCEEDED', assets: [jobAsset], cost_usd: 0.8 } },
    ])
    assert.deepStrictEqual(await getJob(target, 'ses_nube', 'job_1'), { status: 'STARTED', jobId: 'job_1', kind: 'separate' })
    assert.deepStrictEqual(await getJob(target, 'ses_nube', 'job_1'), { status: 'IMPORTING', jobId: 'job_1', kind: 'separate', done: 4, total: 4 })
    assert.deepStrictEqual(await getJob(target, 'ses_nube', 'job_1'), { status: 'FAILED', jobId: 'job_1', kind: 'separate', error: 'El proveedor no pudo terminar el trabajo.' })
    const done = await getJob(target, 'ses_nube', 'job_1')
    assert.deepStrictEqual(done, {
      status: 'SUCCEEDED',
      jobId: 'job_1',
      kind: 'master',
      costUsd: 0.8,
      assets: [{ id: 'ast_j1', file: 'ast_j1.wav', kind: 'master', label: 'Master -14 LUFS', role: null, size: 5000, channels: null, sampleRate: null, durationS: null, source: { provider: 'musicai', jobId: 'job_1' } }],
    })
    await cloudError(getJob(target, 'ses_nube', 'job_zz'), 'no_job', 404)
    assert.throws(() => parseJobState({ job_id: 'j', kind: 'master', status: 'SUCCEEDED', assets: [{ ...jobAsset, file: 'otro.wav' }] }, 'j'), (e: unknown) => e instanceof StemCloudError && e.code === 'bad_response')
    assert.throws(() => parseJobState({ job_id: 'j', kind: 'karaoke', status: 'STARTED' }, 'j'), (e: unknown) => e instanceof StemCloudError && e.code === 'bad_response')
  })

  const noSleep = { sleeps: [] as number[], sleep: async (ms: number) => void noSleep.sleeps.push(ms) }

  await check('sondeo: STARTED, IMPORTING, reintenta 502 asset_copy_failed y un corte de red, y termina', async () => {
    const { worker, target } = newCloud()
    worker.script('job_1', [
      { status: 200, body: { job_id: 'job_1', kind: 'separate', status: 'STARTED' } },
      { status: 200, body: { job_id: 'job_1', kind: 'separate', status: 'IMPORTING', done: 1, total: 2 } },
      { status: 502, body: { error: 'asset_copy_failed' } },
      { network: true },
      { status: 200, body: { job_id: 'job_1', kind: 'separate', status: 'IMPORTING', done: 2, total: 2 } },
      { status: 200, body: { job_id: 'job_1', kind: 'separate', status: 'SUCCEEDED', cost_usd: 0.28, assets: [{ ...jobAsset, kind: 'stem', role: 'vocals', label: 'Voz' }] } },
    ])
    noSleep.sleeps = []
    const states: StudioJobState[] = []
    const final = await watchJob(target, 'ses_nube', 'job_1', { sleep: noSleep.sleep, onState: (s) => states.push(s) })
    assert.deepStrictEqual(states.map((s) => s.status), ['STARTED', 'IMPORTING', 'IMPORTING', 'SUCCEEDED'])
    assert.equal(final?.status, 'SUCCEEDED')
    assert.ok(final?.status === 'SUCCEEDED' && final.kind !== 'assist' && final.assets[0].role === 'vocals')
    assert.deepStrictEqual(noSleep.sleeps, [3000, 3000, 3000, 3000, 3000], 'intervalo de 3 s entre consultas')
    assert.equal(worker.jobGets, 6)
    assert.deepStrictEqual(states.map(jobStatusText), ['SEPARANDO EN MUSIC AI...', 'COPIANDO AUDIOS 1/2...', 'COPIANDO AUDIOS 2/2...', 'LISTO: 1 AUDIO NUEVO'])
  })

  await check('sondeo: se rinde tras 8 reintentos seguidos; un error que no se reintenta se lanza de inmediato', async () => {
    const { worker, target } = newCloud()
    worker.script('job_1', Array.from({ length: 20 }, () => ({ status: 502, body: { error: 'asset_copy_failed' } })))
    await cloudError(watchJob(target, 'ses_nube', 'job_1', { sleep: noSleep.sleep }), 'asset_copy_failed', 502)
    assert.equal(worker.jobGets, STUDIO_JOB_MAX_RETRIES + 1)
    const other = newCloud()
    other.worker.script('job_1', [{ status: 403, body: { error: 'not_a_member' } }])
    await cloudError(watchJob(other.target, 'ses_nube', 'job_1', { sleep: noSleep.sleep }), 'not_a_member', 403)
    assert.equal(other.worker.jobGets, 1)
    // Los reintentos se cuentan SEGUIDOS: una respuesta buena reinicia la cuenta.
    const mixed = newCloud()
    const flaky = [{ network: true }, { network: true }, { network: true }, { network: true }, { network: true }, { status: 200, body: { job_id: 'job_1', kind: 'generate', status: 'STARTED' } }]
    mixed.worker.script('job_1', [...flaky, ...flaky, { status: 200, body: { job_id: 'job_1', kind: 'generate', status: 'FAILED', error: 'Sin resultado' } }])
    const final = await watchJob(mixed.target, 'ses_nube', 'job_1', { sleep: noSleep.sleep })
    assert.deepStrictEqual(final, { status: 'FAILED', jobId: 'job_1', kind: 'generate', error: 'Sin resultado' })
  })

  await check('sondeo: al pasar el tiempo limite resuelve FAILED con mensaje de espera; abortar resuelve null', async () => {
    const { worker, target } = newCloud()
    worker.script('job_1', Array.from({ length: 50 }, () => ({ status: 200, body: { job_id: 'job_1', kind: 'master', status: 'STARTED' } })))
    let clock = 0
    const states: StudioJobState[] = []
    const final = await watchJob(target, 'ses_nube', 'job_1', {
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
      timeoutMs: 10000,
      onState: (s) => states.push(s),
    })
    assert.equal(final?.status, 'FAILED')
    assert.ok(final?.status === 'FAILED' && /tarda más de lo normal/.test(final.error))
    assert.equal(final?.kind, 'master')
    assert.equal(states.at(-1), final)
    assert.equal(worker.jobGets, 5, 'consultas en 0, 3, 6, 9 y 12 s')

    const aborting = newCloud()
    aborting.worker.script('job_1', Array.from({ length: 50 }, () => ({ status: 200, body: { job_id: 'job_1', kind: 'master', status: 'STARTED' } })))
    const controller = new AbortController()
    let polls = 0
    const aborted = await watchJob(aborting.target, 'ses_nube', 'job_1', {
      signal: controller.signal,
      sleep: async () => {
        if (++polls === 2) controller.abort()
      },
    })
    assert.equal(aborted, null)
    assert.equal(aborting.worker.jobGets, 2)
  })

  await check('sugerencias del asistente: se descartan las que no cumplen el contrato', () => {
    const raw = [
      { track_id: 'trk_1', target: 'volume_db', value: -3, fx_type: null, params: null, reason: 'La voz queda por encima.' },
      { track_id: 'trk_2', target: 'fx', value: null, fx_type: 'eq', params: { hpf_hz: 80, low_db: -2 }, reason: 'Graves que compiten con el bajo.' },
      { track_id: 'master', target: 'fx', value: null, fx_type: 'limiter', params: { ceiling_db: -2 }, reason: 'Pico real alto.' },
      { track_id: 'trk_2', target: 'pan', value: 0.3, fx_type: null, params: null, reason: 'Abrir la guitarra.' },
      // Invalidas:
      { track_id: 'master', target: 'pan', value: 0.3, fx_type: null, params: null, reason: 'El master no tiene paneo.' },
      { track_id: 'trk_2', target: 'fx', value: null, fx_type: 'limiter', params: {}, reason: 'Limitador en una pista.' },
      { track_id: 'trk_1', target: 'volume_db', value: 40, fx_type: null, params: null, reason: 'Fuera de rango.' },
      { track_id: 'trk_1', target: 'fx', value: null, fx_type: 'eq', params: { mid_db: 99 }, reason: 'Parametro fuera de rango.' },
      { track_id: 'trk_1', target: 'fx', value: null, fx_type: 'eq', params: { volumen: 1 }, reason: 'Parametro desconocido.' },
      { track_id: 'trk_1', target: 'volume_db', value: -1, fx_type: null, params: null, reason: '' },
      { track_id: 'trk_1', target: 'volume_db', value: -1, fx_type: null, params: null, reason: 'x'.repeat(281) },
      { track_id: 'trk_1', target: 'tempo', value: 1, fx_type: null, params: null, reason: 'Destino desconocido.' },
      'no es un objeto',
    ]
    const parsed = parseMixSuggestions(raw)
    assert.deepStrictEqual(parsed, [
      { trackId: 'trk_1', reason: 'La voz queda por encima.', target: 'volume_db', value: -3 },
      { trackId: 'trk_2', reason: 'Graves que compiten con el bajo.', target: 'fx', fxType: 'eq', params: { hpfHz: 80, lowDb: -2 } },
      { trackId: 'master', reason: 'Pico real alto.', target: 'fx', fxType: 'limiter', params: { ceilingDb: -2 } },
      { trackId: 'trk_2', reason: 'Abrir la guitarra.', target: 'pan', value: 0.3 },
    ])
    assert.deepStrictEqual(parseMixSuggestions(null), [])
    assert.equal(parseMixSuggestions(Array.from({ length: 50 }, () => raw[0])).length, 32)

    // Cada sugerencia valida se aplica como un paso de deshacer.
    const s = base()
    const history = createHistory<StudioSession>(STUDIO_HISTORY_LIMIT)
    history.push(s)
    let current = s
    for (const suggestion of suggestionsForSession(s, parsed)) {
      current = applyMixSuggestion(current, { suggestion })
      history.push(current, suggestionTitle(s, suggestion))
      validateSession(current)
    }
    assert.equal(findTrack(current, 'trk_1')?.volumeDb, -3)
    assert.equal(findTrack(current, 'trk_2')?.fx[0].type, 'eq')
    assert.equal(findTrack(current, 'trk_2')?.pan, 0.3)
    assert.equal(history.undoLabel(), 'Guitarra: paneo 30 % a la derecha')
    history.undo()
    assert.equal(history.undoLabel(), 'Master: ajustar limitador')
    assert.equal(suggestionTitle(s, parsed[0]), 'Voz: fader a -3,0 dB')

    const ghost: MixSuggestion = { trackId: 'trk_borrada', target: 'volume_db', value: 0, reason: 'La pista ya no existe.' }
    assert.deepStrictEqual(suggestionsForSession(s, [ghost, parsed[2]]), [parsed[2]])
  })

  await check('runJob: revisa la peticion sin gastar, lanza, avisa el id y sondea hasta el final', async () => {
    const { worker, target } = newCloud()
    const bad = await cloudError(runJob(target, 'ses_nube', { kind: 'master', assetId: 'ast_mix', durationS: 240, targetLufs: -40 }, { sleep: noSleep.sleep }), 'bad_job', 400)
    assert.match(bad.message, /entre -24 y -6 LUFS/)
    await cloudError(estimate(target, 'ses_nube', { kind: 'generate', provider: 'lyria', prompt: '   ', durationS: 30, bpm: 120, key: null, instrumental: true }), 'bad_job', 400)
    assert.equal(worker.calls.length, 0, 'una peticion invalida no sale a la red')

    worker.script('job_1', [
      { status: 200, body: { job_id: 'job_1', kind: 'assist', status: 'STARTED' } },
      {
        status: 200,
        body: {
          job_id: 'job_1',
          kind: 'assist',
          status: 'SUCCEEDED',
          cost_usd: 0.01,
          suggestions: [{ track_id: 'trk_1', target: 'volume_db', value: -2, fx_type: null, params: null, reason: 'Bajar la voz.' }],
        },
      },
    ])
    const started: string[] = []
    const states: StudioJobState[] = []
    const metrics = { targetLufs: -14, master: { lufs: -16, truePeakDb: -1 }, tracks: [{ trackId: 'trk_1', name: 'Voz', role: 'vocals' as const, lufs: -18, truePeakDb: -3, bands: null, volumeDb: 0, pan: 0, fx: [] }] }
    const final = await runJob(target, 'ses_nube', { kind: 'assist', metrics }, { sleep: noSleep.sleep, newJobId: () => 'job_1', onStarted: (id) => started.push(id), onState: (s) => states.push(s) })
    assert.deepStrictEqual(started, ['job_1'])
    assert.equal(worker.calls.find((c) => c.method === 'POST')?.search, '?job_id=job_1', 'el id lo elige el Hub y viaja en el POST')
    assert.deepStrictEqual(states.map((s) => s.status), ['STARTED', 'STARTED', 'SUCCEEDED'])
    assert.ok(final?.status === 'SUCCEEDED' && final.kind === 'assist' && final.suggestions.length === 1 && final.costUsd === 0.01)
    assert.equal(jobStatusText(final as StudioJobState), 'LISTO: 1 SUGERENCIA')

    const controller = new AbortController()
    controller.abort()
    assert.equal(await runJob(target, 'ses_nube', { kind: 'assist', metrics }, { signal: controller.signal, sleep: noSleep.sleep }), null)
    assert.equal(worker.jobs.size, 1, 'abortado antes de lanzar: no gasta')
  })

  await check('runJob: si se pierde la respuesta del POST no relanza: consulta el id; sin trabajo en la nube, el error de red', async () => {
    const metrics = { targetLufs: -14, master: { lufs: -16, truePeakDb: -1 }, tracks: [{ trackId: 'trk_1', name: 'Voz', role: 'vocals' as const, lufs: -18, truePeakDb: -3, bands: null, volumeDb: 0, pan: 0, fx: [] }] }
    // El Worker acepto el trabajo (y cobro), pero la respuesta no llego.
    const { worker, target } = newCloud()
    worker.dropJobResponse = true
    worker.script('job_mio', [{ status: 200, body: { job_id: 'job_mio', kind: 'assist', status: 'SUCCEEDED', cost_usd: 0.05, suggestions: [] } }])
    const started: string[] = []
    const final = await runJob(target, 'ses_nube', { kind: 'assist', metrics }, { sleep: noSleep.sleep, newJobId: () => 'job_mio', onStarted: (id) => started.push(id) })
    assert.deepStrictEqual(started, ['job_mio'], 'el id se avisa antes de enviar: se puede guardar para retomar')
    assert.equal(final?.status, 'SUCCEEDED')
    assert.equal(worker.jobs.size, 1, 'un solo trabajo: no se relanzo')
    assert.equal(worker.calls.filter((c) => c.method === 'POST').length, 1)

    // La peticion ni llego: la nube no conoce el id, y entonces si es un error de red reintentable.
    const offline = newCloud()
    let first = true
    const flaky: CloudTarget = {
      ...offline.target,
      fetchFn: async (input, init) => {
        if (first && init?.method === 'POST') {
          first = false
          throw new TypeError('fetch failed')
        }
        return offline.worker.fetch(input as string, init)
      },
    }
    await cloudError(runJob(flaky, 'ses_nube', { kind: 'assist', metrics }, { sleep: noSleep.sleep, newJobId: () => 'job_nunca' }), 'network')
    assert.equal(offline.worker.jobs.size, 0)

    // resumeJob consulta sin lanzar; el tiempo limite deja el trabajo retomable, no fallido de verdad.
    const again = newCloud()
    again.worker.script('job_mio', Array.from({ length: 50 }, () => ({ status: 200, body: { job_id: 'job_mio', kind: 'master', status: 'STARTED' } })))
    let clock = 0
    const waited = await resumeJob(again.target, 'ses_nube', 'job_mio', { sleep: async (ms) => void (clock += ms), now: () => clock, timeoutMs: 5000 })
    assert.ok(waited?.status === 'FAILED' && waited.resumable === true)
    assert.equal(again.worker.calls.filter((c) => c.method === 'POST').length, 0)
  })

  await check('trabajo pendiente: se guarda por sesion y tipo, y lo danado se ignora', () => {
    const storage = memoryStorage()
    const request: StudioJobRequest = { kind: 'generate', provider: 'lyria', prompt: 'Pad', durationS: 30, bpm: 120, key: null, instrumental: true }
    assert.equal(readPendingJob(storage, 'ses_a', 'generate'), null)
    writePendingJob(storage, 'ses_a', { jobId: 'job_abc', kind: 'generate', request, context: { prompt: 'Pad', lengthS: 30 }, at: 5 })
    assert.equal(pendingJobKey('ses_a', 'generate'), 'bandait_studio_job:ses_a:generate')
    assert.deepStrictEqual(readPendingJob(storage, 'ses_a', 'generate'), { jobId: 'job_abc', kind: 'generate', request, context: { prompt: 'Pad', lengthS: 30 }, at: 5 })
    assert.equal(readPendingJob(storage, 'ses_a', 'master'), null, 'otro tipo de trabajo no lo ve')
    assert.equal(readPendingJob(storage, 'ses_b', 'generate'), null, 'otra sesion tampoco')
    storage.setItem(pendingJobKey('ses_a', 'master'), '{no json')
    assert.equal(readPendingJob(storage, 'ses_a', 'master'), null)
    storage.setItem(pendingJobKey('ses_a', 'master'), JSON.stringify({ jobId: '../x', kind: 'master', request: {} }))
    assert.equal(readPendingJob(storage, 'ses_a', 'master'), null, 'un id que no es de trabajo no se consulta')
    clearPendingJob(storage, 'ses_a', 'generate')
    assert.equal(readPendingJob(storage, 'ses_a', 'generate'), null)
    assert.equal(readPendingJob(null, 'ses_a', 'generate'), null)
  })

  await check('textos y ayudas de trabajos', () => {
    assert.equal(jobKindLabel('separate'), 'Separar en stems')
    assert.equal(jobStatusText({ status: 'STARTED', jobId: 'j', kind: 'generate' }), 'GENERANDO AUDIO...')
    assert.equal(jobStatusText({ status: 'IMPORTING', jobId: 'j', kind: 'separate', done: 0, total: 0 }), 'COPIANDO AUDIOS...')
    assert.equal(jobStatusText({ status: 'FAILED', jobId: 'j', kind: 'master', error: 'x' }), 'LA MASTERIZACIÓN FALLÓ')
    assert.equal(jobStatusText({ status: 'SUCCEEDED', jobId: 'j', kind: 'assist', suggestions: [], costUsd: null }), 'LISTO: SIN CAMBIOS PROPUESTOS')
    assert.equal(formatUsd(0.2), 'USD 0,20')
    assert.equal(estimateText({ kind: 'master', estimatedCostUsd: 0.8, spentUsd: 1.84, budgetUsd: 10, allowed: true }), 'Costo estimado: USD 0,80. Gasto del mes: USD 1,84 de USD 10,00.')
    assert.match(estimateText({ kind: 'master', estimatedCostUsd: 0.8, spentUsd: 9.9, budgetUsd: 10, allowed: false }), /pasaría el tope mensual/)
    assert.equal(estimateText({ kind: 'assist', estimatedCostUsd: 0.01, spentUsd: 0, budgetUsd: null, allowed: true }), 'Costo estimado: USD 0,01. Gasto del mes: USD 0,00.')
    assert.match(jobErrorMessage(new StemCloudError('quota_exceeded', 429, studioCloudErrorMessage('quota_exceeded', 429))), /tope de gasto/)
    assert.equal(jobErrorMessage(new Error('algo')), 'algo')
    assert.equal(jobErrorMessage(42), 'El trabajo falló por un motivo desconocido.')
    assert.equal(jobRequestProblem({ kind: 'separate', assetId: 'ast_mix', durationS: 200 }), null)
    assert.match(jobRequestProblem({ kind: 'separate', assetId: 'ast_mix', durationS: 0 }) ?? '', /20 minutos/)
    assert.match(jobRequestProblem({ kind: 'generate', provider: 'lyria', prompt: 'Pad', durationS: 2, bpm: 120, key: null, instrumental: true }) ?? '', /entre 5 y 240/)
    assert.match(jobRequestProblem({ kind: 'assist', metrics: { targetLufs: -14, master: { lufs: null, truePeakDb: null }, tracks: [] } }) ?? '', /al menos una pista/)
  })

  await check('generar desde la sesion: 16 compases a 128 BPM son 30 s, con el tempo y la tonalidad de la sesion', () => {
    const s = base()
    close(barsToSeconds(s, 16), 30)
    const req = generateRequestForSession(s, { provider: 'lyria', prompt: '  Pad de 16 compases  ', bars: 16, instrumental: true })
    assert.deepStrictEqual(req, { kind: 'generate', provider: 'lyria', prompt: 'Pad de 16 compases', durationS: 30, bpm: 128, key: 'C#m', instrumental: true })
    assert.equal(jobRequestProblem(req), null)
    assert.equal(generateRequestForSession(s, { provider: 'lyria', prompt: 'x', bars: 1, instrumental: true }).durationS, 5)
    assert.equal(generateRequestForSession(s, { provider: 'lyria', prompt: 'x', durationS: 999, instrumental: false }).durationS, 240)
  })

  await check('el audio de un trabajo entra a la sesion con los datos del decodificador', () => {
    const state = parseJobState({ job_id: 'job_9', kind: 'generate', status: 'SUCCEEDED', cost_usd: 0.06, assets: [{ ...jobAsset, id: 'ast_gen', file: 'ast_gen.mp3', kind: 'generated', label: 'Pad', source: { provider: 'lyria', job_id: 'job_9', prompt: 'Pad calido' } }] }, 'job_9')
    assert.ok(state.status === 'SUCCEEDED' && state.kind !== 'assist')
    const asset = jobAssetToSessionAsset(state.assets[0], { channels: 2, sampleRate: 44100, durationS: 30.02 })
    assert.deepStrictEqual(asset, { id: 'ast_gen', file: 'ast_gen.mp3', kind: 'generated', label: 'Pad', channels: 2, sampleRate: 44100, durationS: 30.02, size: 5000, source: { provider: 'lyria', jobId: 'job_9', prompt: 'Pad calido' } })
    const s = addAsset(base(), { asset })
    assert.equal(findAsset(s, 'ast_gen')?.source?.provider, 'lyria', 'queda marcado como generado por IA')
    validateSession(s)
  })

  await check('medidas para el asistente: LUFS, pico y bandas por pista; el silencio va en null', () => {
    const rate = 48000
    const s = base()
    const voice = sine(997, dbToAmp(-23), 5, rate)
    const bass = sine(80, dbToAmp(-12), 5, rate)
    const silence = new Float32Array(rate * 5)
    const voiceMetrics = measureTrack(s.tracks[0], [voice, voice], rate)
    close(voiceMetrics.lufs ?? 0, -23, 0.1)
    close(voiceMetrics.truePeakDb ?? 0, -23, 0.1)
    assert.ok((voiceMetrics.bands?.lowMidDb ?? -99) > -0.1)
    assert.deepStrictEqual([voiceMetrics.trackId, voiceMetrics.name, voiceMetrics.role, voiceMetrics.volumeDb, voiceMetrics.pan], ['trk_1', 'Voz', 'vocals', 0, 0])
    assert.equal(voiceMetrics.fx, s.tracks[0].fx)
    const mix = voice.map((v, i) => v + bass[i])
    const metrics = buildMixMetrics({
      master: { channels: [mix, mix], sampleRate: rate },
      tracks: [
        { track: s.tracks[0], audio: { channels: [voice, voice], sampleRate: rate } },
        { track: s.tracks[1], audio: { channels: [bass, bass], sampleRate: rate } },
        { track: s.tracks[2], audio: { channels: [silence, silence], sampleRate: rate } },
      ],
    })
    assert.equal(metrics.targetLufs, JOB_DEFAULT_TARGET_LUFS)
    assert.ok(metrics.master.lufs !== null && metrics.master.lufs > -23 && metrics.master.lufs < -10)
    assert.ok((metrics.tracks[1].bands?.lowDb ?? -99) > -0.1)
    assert.deepStrictEqual([metrics.tracks[2].lufs, metrics.tracks[2].truePeakDb, metrics.tracks[2].bands], [null, null, null])
    assert.equal(buildMixMetrics({ targetLufs: -40, master: { channels: [silence], sampleRate: rate }, tracks: [] }).targetLufs, -24)
    assert.equal(jobRequestProblem({ kind: 'assist', metrics }), null)
    assert.doesNotMatch(JSON.stringify(jobRequestToWire({ kind: 'assist', metrics })), /Infinity|NaN/)
  })

  // =========================================================================
  console.log('\ngraph.ts, engine.ts, click.ts, bounce.ts, fx.ts y limiterCore.ts (motor, sin navegador)')

  const RATE = 48000
  /** Sesion con un audio de 10 s y un clip que arranca en 2 s, entra 1 s dentro del audio y dura 4 s. */
  function engineSession(): StudioSession {
    let session = newSession({ id: 'ses_motor', title: 'Motor', sampleRate: RATE, bpm: 120, now: new Date('2026-11-19T10:00:00Z') })
    session = addAsset(session, { asset: { id: 'ast_e1', file: 'ast_e1.wav', kind: 'recording', label: 'Toma', channels: 1, sampleRate: RATE, durationS: 10, size: 1024, source: null } })
    session = addTrack(session, { track: defaultTrack({ id: 'trk_e1', name: 'Voz', role: 'vocals' }) })
    return addClip(session, {
      trackId: 'trk_e1',
      clip: { id: 'clp_e1', assetId: 'ast_e1', startS: 2, offsetS: 1, lengthS: 4, gainDb: 0, fadeInS: 0.5, fadeOutS: 1, takeGroup: null, active: true },
    })
  }
  const envelopeOf = (points: { tS: number; gain: number }[]) => points.map((p) => [Number(p.tS.toFixed(6)), Number(p.gain.toFixed(6))])

  await check('planClips desde el inicio: arranque, ventana del audio y largo, cuantizados a muestras', () => {
    const [plan, ...rest] = planClips(engineSession(), { fromS: 0, sampleRate: RATE })
    assert.equal(rest.length, 0)
    assert.deepStrictEqual([plan.trackId, plan.clipId, plan.assetId], ['trk_e1', 'clp_e1', 'ast_e1'])
    assert.deepStrictEqual([plan.startFrame, plan.offsetFrame, plan.frames], [96000, 48000, 192000])
    assert.deepStrictEqual([plan.delayS, plan.bufferOffsetS, plan.durationS], [2, 1, 4])
    // Clip entero: la curva es solo la de sus fades.
    assert.deepStrictEqual(envelopeOf(plan.envelope), [[0, 0], [0.5, 1], [3, 1], [4, 0]])
    assert.deepStrictEqual(planClips(engineSession(), { fromS: 0, sampleRate: 0 }), [])
    assert.deepStrictEqual(planClips(engineSession(), { fromS: Number.NaN, sampleRate: RATE }), [])
  })

  await check('planClips desde la mitad de un clip y hasta antes de su final: tramo recortado con micro-fade en los cortes', () => {
    const s = engineSession()
    // Arrancar en 3 s: el clip ya lleva 1 s sonando. Suena de inmediato, desde 2 s dentro del audio.
    const [mid] = planClips(s, { fromS: 3, sampleRate: RATE })
    assert.deepStrictEqual([mid.startFrame, mid.offsetFrame, mid.frames], [0, 96000, 144000])
    assert.deepStrictEqual(envelopeOf(mid.envelope), [[0, 0], [DECLICK_S, 1], [2, 1], [3, 0]], 'entra con micro-fade; el fade de entrada ya paso')
    // Hasta 4 s (fin de una region de repeticion): se corta a 2 s del clip, con micro-fade de salida.
    const [cut] = planClips(s, { fromS: 0, untilS: 4, sampleRate: RATE })
    assert.deepStrictEqual([cut.startFrame, cut.offsetFrame, cut.frames], [96000, 48000, 96000])
    assert.deepStrictEqual(envelopeOf(cut.envelope), [[0, 0], [0.5, 1], [2 - DECLICK_S, 1], [2, 0]])
    // Fuera del rango no suena nada.
    assert.deepStrictEqual(planClips(s, { fromS: 6, sampleRate: RATE }), [])
    assert.deepStrictEqual(planClips(s, { fromS: 0, untilS: 2, sampleRate: RATE }), [])
    // Una toma inactiva no suena; el filtro de pistas deja fuera las demas.
    const inactive = { ...s, tracks: [{ ...s.tracks[0], clips: [{ ...s.tracks[0].clips[0], active: false }] }] }
    assert.deepStrictEqual(planClips(inactive, { fromS: 0, sampleRate: RATE }), [])
    assert.deepStrictEqual(planClips(s, { fromS: 0, sampleRate: RATE, trackIds: new Set(['trk_otra']) }), [])
    assert.equal(planClips(s, { fromS: 0, sampleRate: RATE, trackIds: new Set(['trk_e1']) }).length, 1)
  })

  await check('planClips: las dos mitades de un clip dividido quedan contiguas a la muestra, arranque donde arranque', () => {
    const random = prng(7)
    for (let i = 0; i < 200; i++) {
      // Un corte que no cae en una muestra exacta, y un arranque cualquiera antes del clip.
      const atS = 2 + 0.01 + random() * 3.98
      const fromS = random() * 2
      const split = splitClip(engineSession(), { clipId: 'clp_e1', atS, newClipId: 'clp_e2' })
      const plans = planClips(split, { fromS, sampleRate: RATE })
      assert.equal(plans.length, 2)
      const [a, b] = plans
      assert.equal(b.startFrame, a.startFrame + a.frames, `corte en ${atS}, desde ${fromS}: ni hueco ni solape en la sesion`)
      assert.equal(b.offsetFrame, a.offsetFrame + a.frames, 'ni muestra repetida ni saltada en el audio')
      assert.ok(a.startFrame >= 0 && a.frames >= 1 && b.frames >= 1)
      // La suma es el clip entero, igual que sin dividir.
      const [whole] = planClips(engineSession(), { fromS, sampleRate: RATE })
      assert.equal(a.frames + b.frames, whole.frames)
      assert.equal(a.startFrame, whole.startFrame)
    }
    // Arrancar dentro del clip nunca da un arranque negativo (dos redondeos podian dejarlo en -1).
    for (let i = 0; i < 200; i++) {
      const fromS = 2 + random() * 3.9
      const [plan] = planClips(engineSession(), { fromS, sampleRate: 44100 })
      assert.ok(plan.startFrame >= 0 && plan.frames >= 1 && plan.offsetFrame + plan.frames <= Math.round(5 * 44100) + 1)
    }
  })

  await check('curvas de fade: lineales, acotadas al clip, con la ganancia del clip', () => {
    const c = { lengthS: 4, fadeInS: 0.5, fadeOutS: 1, gainDb: -6 }
    assert.deepStrictEqual([0, 0.25, 0.5, 2, 3, 3.5, 4].map((t) => clipFadeFactor(c, t)), [0, 0.5, 1, 1, 1, 0.5, 0])
    assert.equal(clipFadeFactor(c, -1), 0, 'antes del clip vale lo que en su inicio')
    assert.equal(clipFadeFactor(c, 99), 0)
    assert.equal(clipFadeFactor({ lengthS: 4, fadeInS: 0, fadeOutS: 0 }, 0), 1, 'sin fades el clip entra y sale a nivel completo')
    const gain = Math.pow(10, -6 / 20)
    const full = clipEnvelope(c, 0, 4)
    assert.deepStrictEqual(full.map((p) => p.tS), [0, 0.5, 3, 4])
    close(full[1].gain, gain, 1e-12)
    close(full[2].gain, gain, 1e-12)
    assert.deepStrictEqual([full[0].gain, full[3].gain], [0, 0])
    // Un tramo que empieza dentro del fade de entrada parte del nivel que el fade lleva ahi... por el micro-fade, de 0.
    const inside = clipEnvelope(c, 0.25, 1)
    assert.equal(inside[0].gain, 0)
    close(inside[1].gain, gain * ((0.25 + DECLICK_S) / 0.5), 1e-9)
    // Sin duracion no hay curva que programar.
    assert.deepStrictEqual(clipEnvelope(c, 4, 1), [{ tS: 0, gain: 0 }])
    assert.deepStrictEqual(clipEnvelope(c, 1, 0), [{ tS: 0, gain: 0 }])
    // Los puntos van en orden creciente y nunca pasan de la ganancia del clip.
    const points = clipEnvelope({ lengthS: 0.004, fadeInS: 0.002, fadeOutS: 0.002, gainDb: 0 }, 0.001, 0.002)
    for (let i = 1; i < points.length; i++) assert.ok(points[i].tS > points[i - 1].tS)
    for (const p of points) assert.ok(p.gain >= 0 && p.gain <= 1)
  })

  await check('clipsEqual y topologia: un fader no reprograma; mover un clip o cambiar su ganancia si', () => {
    const s = engineSession()
    assert.equal(clipsEqual(s, s), true)
    assert.equal(clipsEqual(s, updateTrack(s, { trackId: 'trk_e1', patch: { volumeDb: -6, pan: 0.3 } })), true)
    assert.equal(clipsEqual(s, moveClip(s, { clipId: 'clp_e1', startS: 3 })), false)
    assert.equal(clipsEqual(s, setClipGain(s, { clipId: 'clp_e1', gainDb: -3 })), false)
    assert.equal(clipsEqual(s, setClipFades(s, { clipId: 'clp_e1', fadeInS: 0.1, fadeOutS: 1 })), false)
    assert.equal(clipsEqual(s, splitClip(s, { clipId: 'clp_e1', atS: 3, newClipId: 'clp_e2' })), false)
    const withComp = setTrackFx(s, { trackId: 'trk_e1', fx: [defaultFx('compressor')] })
    assert.notEqual(topologySignature(withComp), topologySignature(s), 'un efecto nuevo cambia la topologia: grafo nuevo')
    assert.equal(topologySignature(updateTrack(s, { trackId: 'trk_e1', patch: { volumeDb: -6 } })), topologySignature(s))
  })

  await check('retardo del grafo: 5 ms del limitador, 6 ms por compresor; el cabezal y la toma van por lo que se oye', () => {
    const s = engineSession()
    // Una sesion nueva trae limitador en el master.
    close(graphLatency(s, RATE, true).totalS, 240 / RATE, 1e-12)
    close(limiterLatencySeconds(RATE), 0.005, 1e-12)
    close(compressorLatencySeconds(RATE), 0.006, 1e-12)
    close(compressorLatencySeconds(44100), 264 / 44100, 1e-12)
    const withComp = setTrackFx(s, { trackId: 'trk_e1', fx: [defaultFx('compressor')] })
    const latency = graphLatency(withComp, RATE, true)
    close(latency.trackBusS, 0.006, 1e-12)
    close(latency.masterS, 0.005, 1e-12)
    close(latency.totalS, 0.011, 1e-12)
    close(graphLatency(withComp, RATE, false).totalS, 0.012, 1e-12)

    const segments = [
      { ctxStart: 10, offsetS: 5, lengthS: 4 },
      { ctxStart: 14, offsetS: 5, lengthS: 4 },
    ]
    assert.equal(positionAt(segments, 9, 0), 5, 'durante el conteo previo: la posicion de arranque')
    assert.equal(positionAt(segments, 11, 0), 6)
    assert.equal(positionAt(segments, 14.5, 0), 5.5, 'segunda vuelta de la repeticion')
    assert.equal(positionAt(segments, 100, 0), 9, 'acotada al largo del tramo')
    assert.equal(positionAt([], 11, 3.2), 3.2)
    // Lo que se OYE en `now` es lo programado hace `retardo` segundos.
    close(audiblePositionAt(segments, 11, 0.005, 0), 5.995, 1e-12)
    assert.equal(audiblePositionAt(segments, 10.002, 0.005, 0), 5, 'los primeros 5 ms todavia no sale nada del grafo')
    assert.equal(audiblePositionAt(segments, 11, Number.NaN, 0), 6)
    close(audibleCtxTime(10, 0.005), 10.005, 1e-12)
    assert.equal(audibleCtxTime(10, -1), 10)
    // Quien toca exactamente sobre lo que oye, 1 s despues del arranque, queda en la posicion 6:
    // con el instante programado (10) quedaba en 6,005 y el corrimiento se sumaba en cada sobregrabacion.
    const heardAt = audibleCtxTime(10, 0.005) + 1
    close(takeStartSeconds({ positionAtStart: 5, firstBlockCtxTime: heardAt, playStartCtxTime: audibleCtxTime(10, 0.005), roundTripSeconds: 0 }), 6, 1e-12)
    close(takeStartSeconds({ positionAtStart: 5, firstBlockCtxTime: heardAt, playStartCtxTime: 10, roundTripSeconds: 0 }), 6.005, 1e-12)
  })

  await check('transporte: region de repeticion y posicion acotadas a la sesion', () => {
    assert.deepStrictEqual(normalizeLoop({ startS: 4, endS: 8 }), { startS: 4, endS: 8 })
    assert.equal(normalizeLoop({ startS: 4, endS: 4 + MIN_LOOP_S / 2 }), null, 'una region mas corta que el minimo no sirve')
    assert.equal(normalizeLoop({ startS: 8, endS: 4 }), null)
    assert.equal(normalizeLoop({ startS: Number.NaN, endS: 4 }), null)
    assert.equal(normalizeLoop(null), null)
    assert.deepStrictEqual(normalizeLoop({ startS: -5, endS: 5000 }), { startS: 0, endS: STUDIO_MAX_SESSION_SECONDS })
    assert.deepStrictEqual([clampPosition(-1), clampPosition(Number.NaN), clampPosition(12.5), clampPosition(1e9)], [0, 0, 12.5, STUDIO_MAX_SESSION_SECONDS])
  })

  await check('clic: golpes de una ventana, conteo previo con acento y ventanas contiguas sin repetir ni saltar', () => {
    assert.equal(countInSeconds(120, 4, 1), 2)
    assert.equal(countInSeconds(120, 4, 9), 8, 'el conteo se acota a 4 compases')
    assert.equal(countInSeconds(120, 3, 2), 3)
    assert.equal(countInSeconds(0, 4, 1), 0)
    assert.deepStrictEqual(beatsInRange(120, 4, 0, 2.5), [
      { timeS: 0, index: 0, accent: true },
      { timeS: 0.5, index: 1, accent: false },
      { timeS: 1, index: 2, accent: false },
      { timeS: 1.5, index: 3, accent: false },
      { timeS: 2, index: 4, accent: true },
    ])
    assert.deepStrictEqual(beatsInRange(120, 4, 2, 2), [])
    // Conteo previo de un compas que termina en 10: suena aunque el clic este apagado.
    const countIn = { endCtx: 10, bars: 1 }
    const segments = [{ ctxStart: 10, offsetS: 0, lengthS: 100 }]
    const off = clickEventsInWindow({ windowStart: 7, windowEnd: 12, bpm: 120, beatsPerBar: 4, enabled: false, segments, countIn })
    assert.deepStrictEqual(off, [
      { ctxTime: 8, accent: true },
      { ctxTime: 8.5, accent: false },
      { ctxTime: 9, accent: false },
      { ctxTime: 9.5, accent: false },
    ])
    const on = clickEventsInWindow({ windowStart: 7, windowEnd: 12, bpm: 120, beatsPerBar: 4, enabled: true, segments, countIn })
    assert.deepStrictEqual(on.map((e) => e.ctxTime), [8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5])
    assert.deepStrictEqual(on.filter((e) => e.accent).map((e) => e.ctxTime), [8, 10])
    // Arrancar a mitad de un tiempo: el primer golpe cae donde cae el siguiente tiempo de la sesion.
    const offBeat = clickEventsInWindow({ windowStart: 10, windowEnd: 11, bpm: 120, beatsPerBar: 4, enabled: true, segments: [{ ctxStart: 10, offsetS: 0.25, lengthS: 100 }], countIn: null })
    assert.deepStrictEqual(offBeat.map((e) => Number(e.ctxTime.toFixed(9))), [10.25, 10.75])
    // El motor pide ventanas contiguas de tamano irregular: cada golpe sale exactamente una vez.
    const random = prng(11)
    const whole = clickEventsInWindow({ windowStart: 7, windowEnd: 40, bpm: 97.3, beatsPerBar: 3, enabled: true, segments, countIn })
    const pieces: number[] = []
    let cursor = 7
    while (cursor < 40) {
      const next = Math.min(40, cursor + 0.01 + random() * 1.2)
      for (const e of clickEventsInWindow({ windowStart: cursor, windowEnd: next, bpm: 97.3, beatsPerBar: 3, enabled: true, segments, countIn })) pieces.push(e.ctxTime)
      cursor = next
    }
    assert.deepStrictEqual(pieces, whole.map((e) => e.ctxTime))
    // Repeticion: en cada vuelta el clic vuelve a contar desde el inicio de la region.
    const laps = clickEventsInWindow({
      windowStart: 10, windowEnd: 14, bpm: 120, beatsPerBar: 4, enabled: true, countIn: null,
      segments: [{ ctxStart: 10, offsetS: 4, lengthS: 2 }, { ctxStart: 12, offsetS: 4, lengthS: 2 }],
    })
    assert.deepStrictEqual(laps.map((e) => [e.ctxTime, e.accent]), [[10, true], [10.5, false], [11, false], [11.5, false], [12, true], [12.5, false], [13, false], [13.5, false]])
  })

  await check('limitador con anticipacion: nunca pasa del techo, retrasa lo justo y se recupera', () => {
    const L = limiterLookaheadFrames(RATE, 5)
    assert.equal(L, 240)
    const release = limiterReleaseCoef(100, RATE)
    assert.ok(release > 0 && release < 1)
    const frames = 9600
    const loud = sine(1000, 2, frames / RATE, RATE)
    // Por bloques de 128, como en el hilo de audio.
    const run = (input: Float32Array, ceiling: number, bypass: boolean, block: number) => {
      const limiter = new LookaheadLimiter(1, L)
      const out = new Float32Array(input.length)
      for (let at = 0; at < input.length; at += block) {
        const n = Math.min(block, input.length - at)
        limiter.process([input.subarray(at, at + n)], [out.subarray(at, at + n)], n, ceiling, release, bypass)
      }
      return out
    }
    const limited = run(loud, 0.5, false, 128)
    let peak = 0
    for (const v of limited) peak = Math.max(peak, Math.abs(v))
    assert.ok(peak <= 0.5 + 1e-6, `pico ${peak}`)
    assert.ok(peak > 0.45, 'limita al techo, no mas abajo de lo necesario')
    // Lo mismo en un solo bloque: el resultado no depende del tamano de bloque.
    assert.deepStrictEqual(Array.from(run(loud, 0.5, false, frames)), Array.from(limited))
    // Por debajo del techo no toca la senal: solo la retrasa `L` muestras.
    const quiet = sine(440, 0.1, frames / RATE, RATE)
    const through = run(quiet, 0.5, false, 128)
    for (let i = 0; i < L; i++) assert.equal(through[i], 0)
    for (let i = L; i < frames; i += 97) assert.equal(through[i], quiet[i - L])
    // En bypass pasa con ganancia 1 y el mismo retardo: activar y desactivar no mueve la mezcla.
    const bypassed = run(loud, 0.5, true, 128)
    for (let i = L; i < frames; i += 97) assert.equal(bypassed[i], loud[i - L])
    // Despues de un golpe fuerte la ganancia vuelve a 1.
    const burst = concat(sine(1000, 2, 0.05, RATE), sine(1000, 0.1, 1.5, RATE))
    const recovered = run(burst, 0.5, false, 128)
    const tail = burst.length - 1 - 12
    close(recovered[tail], burst[tail - L], 0.002)
    // Un NaN de entrada no envenena la salida.
    const dirty = sine(440, 0.1, 0.1, RATE)
    dirty[100] = Number.NaN
    assert.ok(run(dirty, 0.5, false, 128).every((v) => Number.isFinite(v)))
  })

  await check('reverb: respuesta determinista, con energia 1 por canal y del largo del decaimiento', () => {
    assert.deepStrictEqual([reverbDecayKey(1.234), reverbDecayKey(0), reverbDecayKey(1.8)], [1.23, 0.05, 1.8])
    const [left, right] = buildReverbImpulse(RATE, 0.5)
    assert.equal(left.length, 24000)
    const energy = (data: Float32Array) => data.reduce((sum, v) => sum + v * v, 0)
    close(energy(left), 1, 1e-4)
    close(energy(right), 1, 1e-4)
    assert.notDeepStrictEqual(Array.from(left.subarray(0, 64)), Array.from(right.subarray(0, 64)), 'los dos canales no son iguales')
    assert.deepStrictEqual(Array.from(buildReverbImpulse(RATE, 0.5)[0].subarray(0, 256)), Array.from(left.subarray(0, 256)), 'la misma al escuchar y al exportar')
    // La cola cae: el ultimo decimo tiene mucha menos energia que el primero.
    assert.ok(energy(left.subarray(21600)) < energy(left.subarray(0, 2400)) / 1000)
  })

  await check('exportar: tramo, pistas y sesion de una sola pista', () => {
    const s = engineSession()
    assert.deepStrictEqual(bounceRange(s, undefined, false), { startS: 0, endS: 6 })
    assert.deepStrictEqual(bounceRange(s, { startS: 2, endS: 4 }, true), { startS: 2, endS: 4 })
    assert.deepStrictEqual(bounceRange(s, { startS: -3, endS: 5000 }, false), { startS: 0, endS: STUDIO_MAX_SESSION_SECONDS })
    assert.equal(bounceRange(s, { startS: 4, endS: 2 }, false), null)
    assert.equal(bounceRange(s, { startS: Number.NaN, endS: 2 }, false), null)
    const empty = newSession({ id: 'ses_vacia', title: 'Vacia', sampleRate: RATE, bpm: 120, now: new Date('2026-11-19T10:00:00Z') })
    assert.equal(bounceRange(empty, undefined, true), null, 'sin clips no hay nada que exportar')
    // Con envio a la reverb se deja sonar la cola.
    const wet = updateTrack(s, { trackId: 'trk_e1', patch: { reverbSendDb: -12 } })
    assert.deepStrictEqual(bounceRange(wet, undefined, true), { startS: 0, endS: 6 + wet.master.reverb.decayS })
    assert.deepStrictEqual(bounceRange(wet, undefined, false), { startS: 0, endS: 6 })
    assert.deepStrictEqual(bounceTrackIds(s), ['trk_e1'])
    assert.deepStrictEqual(bounceTrackIds(s, ['trk_zz', 'trk_e1']), ['trk_e1'])
    assert.equal(soloTrackSession(s, 'trk_zz'), null)
    const solo = soloTrackSession(updateTrack(s, { trackId: 'trk_e1', patch: { mute: true } }), 'trk_e1')
    assert.ok(solo && solo.tracks.length === 1 && solo.tracks[0].mute === false, 'la pista sola se exporta aunque este en mute')
  })

  // =========================================================================
  console.log('\ntimelineMath.ts (tomas, compases, carriles) y decisiones del controlador')

  await check('ventanas de una toma: recorta el conteo previo y lo que cae antes del segundo 0', () => {
    // La captura arranca 2,1 s antes de la posicion de arranque (conteo previo de un compas).
    assert.deepStrictEqual(takeClipWindows({ startSeconds: 1.9, durationSeconds: 5, positionAtStart: 4, loop: null }).map((w) => [w.startS, Number(w.offsetS.toFixed(9)), Number(w.lengthS.toFixed(9))]), [[4, 2.1, 2.9]])
    // Una toma que empieza antes del segundo 0 entra desde 0.
    assert.deepStrictEqual(takeClipWindows({ startSeconds: -0.5, durationSeconds: 3, positionAtStart: 0, loop: null }), [{ startS: 0, offsetS: 0.5, lengthS: 2.5 }])
    // Detenida durante el conteo: no deja nada.
    assert.deepStrictEqual(takeClipWindows({ startSeconds: 1.9, durationSeconds: 2, positionAtStart: 4, loop: null }), [])
    assert.deepStrictEqual(takeClipWindows({ startSeconds: Number.NaN, durationSeconds: 2, positionAtStart: 0, loop: null }), [])
    assert.deepStrictEqual(takeClipWindows({ startSeconds: 0, durationSeconds: 0, positionAtStart: 0, loop: null }), [])
    // No pasa del fin de la sesion.
    const late = takeClipWindows({ startSeconds: STUDIO_MAX_SESSION_SECONDS - 1, durationSeconds: 5, positionAtStart: STUDIO_MAX_SESSION_SECONDS - 1, loop: null })
    assert.deepStrictEqual(late, [{ startS: STUDIO_MAX_SESSION_SECONDS - 1, offsetS: 0, lengthS: 1 }])
  })

  await check('ventanas de una toma en repeticion: una por vuelta, todas sobre el mismo audio', () => {
    const loop = { startS: 4, endS: 8 }
    const round = (windows: { startS: number; offsetS: number; lengthS: number }[]) => windows.map((w) => [Number(w.startS.toFixed(6)), Number(w.offsetS.toFixed(6)), Number(w.lengthS.toFixed(6))])
    // 9,3 s de audio desde 3,9: una vuelta completa, otra completa y 1,2 s de la tercera.
    assert.deepStrictEqual(round(takeClipWindows({ startSeconds: 3.9, durationSeconds: 9.3, positionAtStart: 4, loop })), [[4, 0.1, 4], [4, 4.1, 4], [4, 8.1, 1.2]])
    // Un resto mas corto que el minimo de vuelta no se guarda como toma.
    assert.deepStrictEqual(round(takeClipWindows({ startSeconds: 3.9, durationSeconds: 8.2, positionAtStart: 4, loop })), [[4, 0.1, 4], [4, 4.1, 4]])
    assert.ok(8.2 - 8.1 < MIN_TAKE_LAP_S)
    // Arrancar a mitad de la region: la primera vuelta va de ahi al fin; las demas, la region entera.
    assert.deepStrictEqual(round(takeClipWindows({ startSeconds: 6, durationSeconds: 5, positionAtStart: 6, loop })), [[6, 0, 2], [4, 2, 3]])
    // Las ventanas no se solapan dentro del audio y lo recorren en orden.
    const many = takeClipWindows({ startSeconds: 4, durationSeconds: 4 * 30, positionAtStart: 4, loop })
    assert.equal(many.length, MAX_TAKE_LAPS, 'se conservan las ultimas vueltas')
    for (let i = 1; i < many.length; i++) close(many[i].offsetS, many[i - 1].offsetS + many[i - 1].lengthS, 1e-9)
    close(many[many.length - 1].offsetS + many[many.length - 1].lengthS, 120, 1e-9)
    // Arrancar despues de la region: no hay vueltas, es una toma normal.
    assert.deepStrictEqual(takeClipWindows({ startSeconds: 9, durationSeconds: 2, positionAtStart: 9, loop }), [{ startS: 9, offsetS: 0, lengthS: 2 }])
  })

  await check('compas y tiempo: 1-based, y un tiempo exacto no se muestra como el anterior', () => {
    assert.deepStrictEqual(barBeatAt(0, 120, 4), { bar: 1, beat: 1 })
    assert.deepStrictEqual(barBeatAt(0.4999, 120, 4), { bar: 1, beat: 1 })
    assert.deepStrictEqual(barBeatAt(0.5, 120, 4), { bar: 1, beat: 2 })
    assert.deepStrictEqual(barBeatAt(2, 120, 4), { bar: 2, beat: 1 })
    assert.deepStrictEqual(barBeatAt(-3, 120, 4), { bar: 1, beat: 1 })
    assert.deepStrictEqual(barBeatAt(1.5, 120, 3), { bar: 2, beat: 1 })
    // 0,1 * 3 no da 0,3 exacto en coma flotante: 3 tiempos a 600 BPM deben ser el tiempo 4.
    assert.deepStrictEqual(barBeatAt(0.1 * 3, 600, 4), { bar: 1, beat: 4 })
  })

  await check('carriles de tomas: dos tomas que se solapan nunca comparten carril', () => {
    const take = (id: string, startS: number, lengthS: number, active: boolean) => ({ id, assetId: 'ast_e1', startS, offsetS: 0, lengthS, gainDb: 0, fadeInS: 0, fadeOutS: 0, takeGroup: 'tk_1', active })
    const s = engineSession()
    const stacked = { tracks: [{ ...s.tracks[0], clips: [take('a', 0, 4, true), take('b', 0, 4, false), take('c', 2, 4, false), take('d', 4, 2, false)] }, { ...s.tracks[0], id: 'trk_e2', clips: [] }] }
    const rows = layoutTracks(stacked)
    assert.deepStrictEqual([...rows[0].lanes.entries()], [['b', 0], ['c', 1], ['d', 0]], 'la toma activa no ocupa carril; d cabe despues de b')
    assert.equal(rows[0].laneCount, 2)
    assert.equal(rows[0].height, TRACK_ROW_H + 2 * TAKE_LANE_H)
    assert.deepStrictEqual([rows[0].top, rows[1].top, rows[1].height, rows[1].laneCount], [0, rows[0].height, TRACK_ROW_H, 0])
    assert.deepStrictEqual(layoutTracks({ tracks: [] }), [])
  })

  await check('audios referenciados: lo que el historial puede deshacer o rehacer no es una toma huerfana', () => {
    const empty = newSession({ id: 'ses_h', title: 'Historial', sampleRate: RATE, bpm: 120, now: new Date('2026-11-19T10:00:00Z') })
    const recorded = engineSession()
    const history = createHistory<StudioSession>(STUDIO_HISTORY_LIMIT)
    history.push(empty)
    history.push(recorded, 'Grabar toma')
    // Ctrl+Z: la sesion vigente ya no lista el audio, pero rehacer lo trae de vuelta.
    const current = history.undo() as StudioSession
    assert.equal(current.assets.length, 0)
    assert.deepStrictEqual(history.states(), [empty, recorded])
    assert.ok(referencedAssetFiles([current, ...history.states()]).has('ast_e1.wav'), 'no se ofrece para DESCARTAR')
    // Una edicion nueva descarta lo que se podia rehacer: ahora si nadie lo referencia.
    history.push(updateSessionMeta(empty, { patch: { title: 'Otra' } }), 'Renombrar')
    assert.equal(referencedAssetFiles([history.current() as StudioSession, ...history.states()]).has('ast_e1.wav'), false)
    // Audios ya guardados que todavia no entraron a la sesion (resultado de un trabajo sin aceptar).
    assert.deepStrictEqual([...referencedAssetFiles([], ['ast_p'])].sort(), ['ast_p.flac', 'ast_p.mp3', 'ast_p.wav'])
    history.clear()
    assert.deepStrictEqual(history.states(), [])
  })

  await check('abrir una sesion ya subida: la nube solo gana si tiene otra version que la que este equipo subio', () => {
    // Tras GUARDAR, el Worker pone su hora; este equipo conserva la suya. Nunca coinciden.
    const local = { updatedAt: '2026-11-19T15:00:00.412Z', cloudUpdatedAt: '2026-11-19T15:00:01.000Z' }
    assert.equal(cloudHasOtherVersion('2026-11-19T15:00:01.000Z', local), false, 'es la version que este equipo subio: no se vuelve a bajar')
    assert.equal(cloudHasOtherVersion('2026-11-19T18:30:00.000Z', local), true, 'otra persona guardo despues')
    // Sesiones guardadas antes de anotar la hora del Worker: se compara como antes.
    assert.equal(cloudHasOtherVersion('2026-11-19T15:00:00.412Z', { updatedAt: '2026-11-19T15:00:00.412Z', cloudUpdatedAt: null }), false)
    assert.equal(cloudHasOtherVersion('2026-11-19T15:00:01.000Z', { updatedAt: '2026-11-19T15:00:00.412Z' }), true)
  })

  await check('tope de una toma: 200 MB son 12 minutos en estereo a 48 kHz y 24 bits', () => {
    const stereo = maxTakeSeconds({ channels: 2, sampleRate: 48000, bitDepth: 24, maxBytes: STUDIO_MAX_ASSET_BYTES })
    assert.equal(Math.floor(stereo / 60), 12)
    close(maxTakeSeconds({ channels: 1, sampleRate: 48000, bitDepth: 24, maxBytes: STUDIO_MAX_ASSET_BYTES }), stereo * 2, 1e-6)
    assert.equal(Math.floor(maxTakeSeconds({ channels: 2, sampleRate: 96000, bitDepth: 24, maxBytes: STUDIO_MAX_ASSET_BYTES }) / 60), 6)
    assert.ok(stereo < STUDIO_MAX_SESSION_SECONDS, 'una toma estereo no alcanza los 20 minutos de la sesion: por eso se avisa')
    assert.equal(maxTakeSeconds({ channels: 2, sampleRate: 0, bitDepth: 24, maxBytes: STUDIO_MAX_ASSET_BYTES }), 0)
  })

  await verifyStudioV2()

  console.log(`\n${passed} ok, ${failures.length} fallas`)
  if (failures.length > 0) process.exit(1)
}

interface StudioCall {
  method: string
  path: string
  search: string
  auth: string | null
  type: string | null
  ifMatch: string | null
  ifNoneMatch: string | null
  body: unknown
}

type JobStep = { status: number; body: unknown } | { network: true }

/**
 * Worker bandait-stems en memoria, solo con las rutas /studio de STUDIO_V1.md: ETag y
 * precondiciones del documento, audios inmutables, y trabajos con un guion de respuestas.
 */
class FakeStudioWorker {
  sessions = new Map<string, { doc: Json; etag: string }>()
  assets = new Map<string, Uint8Array>()
  jobs = new Map<string, unknown>()
  calls: StudioCall[] = []
  failWith: { status: number; error: string } | null = null
  jobError: { status: number; error: string } | null = null
  /** El proximo POST de trabajo se acepta, pero su respuesta se pierde (corte de red). */
  dropJobResponse = false
  jobGets = 0
  private scripts = new Map<string, JobStep[]>()
  private versions = 0

  /** Respuestas sucesivas de GET .../jobs/{job}; la ultima se repite. */
  script(jobId: string, steps: JobStep[]) {
    this.scripts.set(jobId, [...steps])
  }

  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    let body: unknown = null
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    this.calls.push({
      method,
      path: url.pathname,
      search: url.search,
      auth: headers.get('Authorization'),
      type: headers.get('Content-Type'),
      ifMatch: headers.get('If-Match'),
      ifNoneMatch: headers.get('If-None-Match'),
      body,
    })
    const json = (status: number, payload: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...extra } })
    if (this.failWith) return json(this.failWith.status, { error: this.failWith.error })

    const root = /^\/v1\/bands\/([^/]+)\/studio$/.exec(url.pathname)
    if (root) {
      const sessions = [...this.sessions.entries()]
        .filter(([key]) => key.startsWith(`${root[1]}/`))
        .map(([, s]) => ({ id: s.doc.id, title: s.doc.title, song_id: s.doc.song_id, updated_at: s.doc.updated_at }))
      return json(200, { sessions })
    }
    const m = /^\/v1\/bands\/([^/]+)\/studio\/([^/]+)(?:\/(session|assets\/([^/]+)|jobs(?:\/([^/]+))?))?$/.exec(url.pathname)
    if (!m) return json(404, { error: 'not_found' })
    const key = `${m[1]}/${m[2]}`

    if (m[3] === undefined) {
      if (method !== 'DELETE') return json(405, { error: 'method_not_allowed' })
      let n = 0
      for (const k of [...this.assets.keys()]) {
        if (!k.startsWith(`${key}/`)) continue
        this.assets.delete(k)
        n++
      }
      if (this.sessions.delete(key)) n++
      return json(200, { deleted: n })
    }

    if (m[3] === 'session') {
      const saved = this.sessions.get(key)
      if (method === 'GET') {
        if (!saved) return json(404, { error: 'no_session' })
        return json(200, saved.doc, saved.etag ? { ETag: saved.etag } : {})
      }
      const ifMatch = headers.get('If-Match')
      const ifNoneMatch = headers.get('If-None-Match')
      if (ifMatch === null && ifNoneMatch !== '*') return json(428, { error: 'precondition_required' })
      if (ifNoneMatch === '*' && saved) return json(412, { error: 'session_conflict' })
      if (ifMatch !== null && (!saved || saved.etag !== ifMatch)) return json(412, { error: 'session_conflict' })
      const doc = body as Json
      if (doc.id !== m[2]) return json(400, { error: 'bad_session' })
      for (const asset of doc.assets) {
        if (this.assets.get(`${key}/${asset.file}`)?.length !== asset.size) return json(409, { error: 'missing_asset' })
      }
      const stored = { ...doc, updated_at: `2026-11-19T12:00:0${this.versions}.000Z`, updated_by: 'user-fake' }
      const etag = `"v${++this.versions}"`
      this.sessions.set(key, { doc: stored, etag })
      return json(200, stored, { ETag: etag })
    }

    if (m[4] !== undefined) {
      const file = decodeURIComponent(m[4])
      if (!/^[A-Za-z0-9_-]{1,80}\.(wav|flac|mp3)$/.test(file)) return json(400, { error: 'bad_asset' })
      const assetKey = `${key}/${file}`
      if (method === 'GET') {
        const data = this.assets.get(assetKey)
        return data ? new Response(data, { status: 200 }) : json(404, { error: 'no_asset' })
      }
      const bytes = new Uint8Array(await (init?.body as Blob).arrayBuffer())
      const existing = this.assets.get(assetKey)
      if (existing && existing.length !== bytes.length) return json(409, { error: 'asset_exists' })
      if (!existing) this.assets.set(assetKey, bytes)
      return json(200, { file, size: bytes.length })
    }

    // Trabajos.
    if (m[5] === undefined) {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' })
      if (this.jobError) return json(this.jobError.status, { error: this.jobError.error })
      const kind = (body as Json).kind
      if (url.searchParams.get('estimate') === '1') {
        return json(200, { kind, estimated_cost_usd: 0.8, spent_usd: 1.84, budget_usd: 10, allowed: true })
      }
      // Con ?job_id= el POST es idempotente (STUDIO_V1.md 6.1): repetirlo no crea otro trabajo.
      const jobId = url.searchParams.get('job_id') ?? `job_${this.jobs.size + 1}`
      if (!this.jobs.has(jobId)) this.jobs.set(jobId, body)
      if (this.dropJobResponse) {
        this.dropJobResponse = false
        throw new TypeError('fetch failed')
      }
      return json(202, { job_id: jobId, status: 'STARTED', kind })
    }
    this.jobGets++
    const steps = this.scripts.get(m[5])
    if (!steps || steps.length === 0) return json(404, { error: 'no_job' })
    const step = steps.length > 1 ? (steps.shift() as JobStep) : steps[0]
    if ('network' in step) throw new TypeError('fetch failed')
    return json(step.status, step.body)
  }
}

// ###########################################################################
// Estudio v2: migracion, midiOps, sessionOps v2, smf, comandos y atajos, teclado de computadora
// ###########################################################################

/**
 * El fixture v1 migrado A MANO segun STUDIO_V2.md 1 (version 2, "kind": "audio" despues de id,
 * "markers": [] despues de tracks), para no comprobar la migracion consigo misma.
 */
function migratedV1Fixture(): Json {
  const doc = structuredClone(fixture) as Json
  const out: Json = {}
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'version') {
      out.version = 2
    } else if (k === 'tracks') {
      out.tracks = (v as Json[]).map((t) => {
        const track: Json = {}
        for (const [tk, tv] of Object.entries(t as Json)) {
          track[tk] = tv
          if (tk === 'id') track.kind = 'audio'
        }
        return track
      })
      out.markers = []
    } else {
      out[k] = v
    }
  }
  return out
}

function baseV2(): StudioSession {
  return parseSession(structuredClone(fixtureV2))
}

function note(pitch: number, start: number, length: number, velocity = 100): StudioMidiNote {
  return { pitch, start, length, velocity }
}

function midiClip(session: StudioSession, id: string): StudioMidiClip {
  const loc = findMidiClip(session, id)
  assert.ok(loc, `falta el clip MIDI ${id}`)
  return loc.clip
}

function keyEvent(code: string, key: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }
}

/** Fragmento SMF: id de 4 letras, largo de 32 bits y cuerpo. */
function smfChunk(id: string, body: number[]): number[] {
  const n = body.length
  return [...[...id].map((c) => c.charCodeAt(0)), (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body]
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0))
}

function smfError(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (err: unknown) => err instanceof Error && pattern.test(err.message))
}

function containsBytes(haystack: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

async function verifyStudioV2() {
  // =========================================================================
  console.log('\nsession.ts v2: fixture v2 y migracion de v1')

  await check('ida y vuelta: el fixture v2 sale identico, con las claves en el mismo orden', () => {
    const session = baseV2()
    assert.deepStrictEqual(serializeSession(session), fixtureV2)
    assert.equal(JSON.stringify(serializeSession(session)), JSON.stringify(fixtureV2))
    assert.deepStrictEqual(parseSession(serializeSession(session)), session)
    assert.deepStrictEqual(parseSessionJson(sessionToJson(session)), session)
  })

  await check('migracion v1 a v2: igual a la migracion a mano, idempotente y sin perdida', () => {
    const expected = migratedV1Fixture()
    const migrated = migrateSessionV1(structuredClone(fixture))
    assert.deepStrictEqual(migrated, expected)
    assert.equal(JSON.stringify(migrated), JSON.stringify(expected))
    assert.deepStrictEqual(migrateSessionV1(structuredClone(fixture)), migrated)
    const fromV1 = parseSession(structuredClone(fixture))
    assert.deepStrictEqual(parseSession(serializeSession(fromV1)), fromV1)
    assert.deepStrictEqual(parseSession(migrated), fromV1)
    assert.equal(fromV1.version, 2)
    assert.deepStrictEqual(fromV1.markers, [])
    assert.ok(fromV1.tracks.every((t) => t.kind === 'audio' && t.instrument === null && t.midiClips.length === 0))
    sessionError(() => migrateSessionV1(structuredClone(fixtureV2)), 'unsupported_version', 'version')
  })

  await check('un v1 con campos de v2 se rechaza con las reglas de v1', () => {
    const withKind = structuredClone(fixture) as Json
    withKind.tracks[0] = { id: withKind.tracks[0].id, kind: 'audio', ...withKind.tracks[0] }
    sessionError(() => parseSession(withKind), 'unknown_field', 'tracks[0].kind')
    const withMarkers = structuredClone(fixture) as Json
    withMarkers.markers = []
    sessionError(() => parseSession(withMarkers), 'unknown_field', 'markers')
  })

  // =========================================================================
  console.log('\nmidiOps.ts')

  await check('gridBeats: negras, semicorcheas y tresillos', () => {
    assert.equal(gridBeats('1/1', false), 4)
    assert.equal(gridBeats('1/4', false), 1)
    assert.equal(gridBeats('1/16', false), 0.25)
    assert.equal(gridBeats('1/32', false), 0.125)
    close(gridBeats('1/8', true), 1 / 3)
    close(gridBeats('1/4', true), 2 / 3)
    sessionError(() => gridBeats('1/64' as never, false), 'bad_value', 'grid')
  })

  await check('normalizeNotes: ordena, acorta solapes del mismo tono, acota y descarta lo que sale del clip', () => {
    const input = [note(60, 1, 1), note(60, 0, 2), note(62, 0, 1, 0), note(130, 0.5, 0.5, 200), note(64, 4, 1), note(65, -1, 1)]
    const out = normalizeNotes(input, 4)
    assert.deepStrictEqual(out, [note(60, 0, 1), note(62, 0, 1, 1), note(65, 0, 1), note(127, 0.5, 0.5, 127), note(60, 1, 1)])
    // No muta la entrada.
    assert.deepStrictEqual(input[1], note(60, 0, 2))
    // Igual tono y mismo inicio: gana la que viene despues.
    assert.deepStrictEqual(normalizeNotes([note(60, 0, 1, 50), note(60, 0, 2, 90)], 4), [note(60, 0, 2, 90)])
    // Si al acortar queda con menos del largo minimo, se quita.
    assert.deepStrictEqual(normalizeNotes([note(60, 0, 1), note(60, 0.01, 1)], 4), [note(60, 0.01, 1)])
    // Una nota puede pasar del final del clip (suena recortada); un largo menor que el minimo sube al minimo.
    assert.deepStrictEqual(normalizeNotes([note(60, 3, 4), note(61, 0, 0.001)], 4), [note(61, 0, 0.015625), note(60, 3, 4)])
    // Tiempos redondeados a 6 decimales.
    assert.deepStrictEqual(normalizeNotes([note(60, 1 / 3, 1 / 3)], 4), [note(60, 0.333333, 0.333333)])
  })

  await check('addNotes y removeNotes: la seleccion son las notas agregadas que sobreviven', () => {
    const r = addNotes([note(60, 0, 1)], [note(64, 0, 1), note(60, 0.5, 1)], 4)
    assert.deepStrictEqual(r.notes, [note(60, 0, 0.5), note(64, 0, 1), note(60, 0.5, 1)])
    assert.deepStrictEqual(r.selection, [1, 2])
    // Una nota agregada sobre otra igual la reemplaza.
    const same = addNotes([note(60, 0, 1, 40)], [note(60, 0, 1, 90)], 4)
    assert.deepStrictEqual(same.notes, [note(60, 0, 1, 90)])
    assert.deepStrictEqual(same.selection, [0])
    assert.deepStrictEqual(removeNotes(r.notes, [1, 9, -1]), [note(60, 0, 0.5), note(60, 0.5, 1)])
  })

  await check('moveNotes: el grupo se mueve entero y no sale del clip ni de 0..127', () => {
    const notes = [note(60, 0, 1), note(64, 1, 1)]
    const up = moveNotes(notes, [0, 1], -2, 100, 4)
    assert.deepStrictEqual(up.notes, [note(123, 0, 1), note(127, 1, 1)])
    assert.deepStrictEqual(up.selection, [0, 1])
    const right = moveNotes(notes, [0, 1], 10, 0, 4)
    assert.deepStrictEqual(right.notes, [note(60, 2.984375, 1), note(64, 3.984375, 1)])
    const one = moveNotes(notes, [1], -0.5, -2, 4)
    assert.deepStrictEqual(one.notes, [note(60, 0, 1), note(62, 0.5, 1)])
    assert.deepStrictEqual(one.selection, [1])
    sessionError(() => moveNotes(notes, [0], Number.NaN, 0, 4), 'bad_type', 'delta_beats')
  })

  await check('resizeNotes: final y principio con el largo minimo', () => {
    const notes = [note(60, 1, 1)]
    assert.deepStrictEqual(resizeNotes(notes, [0], 'end', -5, 4).notes, [note(60, 1, 0.015625)])
    assert.deepStrictEqual(resizeNotes(notes, [0], 'end', 0.5, 4).notes, [note(60, 1, 1.5)])
    assert.deepStrictEqual(resizeNotes(notes, [0], 'start', -0.5, 4).notes, [note(60, 0.5, 1.5)])
    assert.deepStrictEqual(resizeNotes(notes, [0], 'start', 2, 4).notes, [note(60, 1.984375, 0.015625)])
    assert.deepStrictEqual(resizeNotes(notes, [0], 'start', -3, 4).notes, [note(60, 0, 2)])
  })

  await check('transpose: lo que saldria de 0..127 se acota nota por nota', () => {
    assert.deepStrictEqual(transpose([note(120, 0, 1), note(126, 1, 1)], null, 5, 4).notes, [note(125, 0, 1), note(127, 1, 1)])
    assert.deepStrictEqual(transpose([note(2, 0, 1), note(40, 1, 1)], null, -200, 4).notes, [note(0, 0, 1), note(0, 1, 1)])
    // Dos notas que caen en el mismo tono y el mismo inicio se resuelven con la regla de solape.
    const collide = transpose([note(125, 0, 1, 60), note(127, 0, 1, 90)], null, 5, 4)
    assert.deepStrictEqual(collide.notes, [note(127, 0, 1, 90)])
    assert.deepStrictEqual(collide.selection, [0])
    // Solo la seleccion; Shift = octava.
    const octave = transpose([note(60, 0, 1), note(64, 0, 1)], [1], 12, 4)
    assert.deepStrictEqual(octave.notes, [note(60, 0, 1), note(76, 0, 1)])
    assert.deepStrictEqual(octave.selection, [1])
  })

  await check('setVelocity: fijar, sumar y escalar, acotado a 1..127', () => {
    const notes = [note(60, 0, 1, 101), note(62, 1, 1, 20)]
    assert.deepStrictEqual(setVelocity(notes, null, 200, 'set').notes.map((n) => n.velocity), [127, 127])
    assert.deepStrictEqual(setVelocity(notes, [1], -150, 'add').notes.map((n) => n.velocity), [101, 1])
    assert.deepStrictEqual(setVelocity(notes, null, 0.5, 'scale').notes.map((n) => n.velocity), [51, 10])
    sessionError(() => setVelocity(notes, null, 1, 'mul' as never), 'bad_value', 'mode')
  })

  await check('quantize: fuerza del 50 %, tresillos, finales y el borde del clip', () => {
    const notes = [note(60, 0.3, 0.5)]
    const grid16 = { grid: '1/16' as const, triplets: false }
    assert.deepStrictEqual(quantize(notes, null, { ...grid16, strength: 0.5 }, 4).notes, [note(60, 0.275, 0.5)])
    assert.deepStrictEqual(quantize(notes, null, { ...grid16, strength: 1 }, 4).notes, [note(60, 0.25, 0.5)])
    assert.deepStrictEqual(quantize(notes, null, { ...grid16, strength: 0 }, 4).notes, [note(60, 0.3, 0.5)])
    // Fuerza fuera de 0..1 se acota.
    assert.deepStrictEqual(quantize(notes, null, { ...grid16, strength: 7 }, 4).notes, [note(60, 0.25, 0.5)])
    // Tresillos de corchea: la rejilla vale 1/3 de beat.
    const triplet = { grid: '1/8' as const, triplets: true }
    assert.deepStrictEqual(quantize(notes, null, { ...triplet, strength: 1 }, 4).notes, [note(60, 0.333333, 0.5)])
    assert.deepStrictEqual(quantize(notes, null, { ...triplet, strength: 0.5 }, 4).notes, [note(60, 0.316667, 0.5)])
    // Con `ends` tambien se ajusta el final.
    assert.deepStrictEqual(quantize([note(60, 0.1, 0.8)], null, { grid: '1/4', triplets: false, strength: 1, ends: true }, 4).notes, [note(60, 0, 1)])
    // La linea mas cercana es el final del clip: se usa la anterior y la nota no se pierde.
    assert.deepStrictEqual(quantize([note(60, 3.9, 0.1)], null, { grid: '1/4', triplets: false, strength: 1 }, 4).notes, [note(60, 3, 0.1)])
    // Solo la seleccion.
    const sel = quantize([note(60, 0.1, 0.5), note(62, 0.3, 0.5)], [1], { grid: '1/4', triplets: false, strength: 1 }, 4)
    assert.deepStrictEqual(sel.notes, [note(62, 0, 0.5), note(60, 0.1, 0.5)])
    assert.deepStrictEqual(sel.selection, [0])
  })

  await check('legato: cada nota llega al inicio de la siguiente de la seleccion; la ultima no cambia', () => {
    const notes = [note(60, 0, 0.5), note(64, 0, 0.25), note(67, 1, 0.5), note(72, 3, 0.5)]
    assert.deepStrictEqual(legato(notes, null, 4).notes, [note(60, 0, 1), note(64, 0, 1), note(67, 1, 2), note(72, 3, 0.5)])
    assert.deepStrictEqual(legato(notes, [0, 2], 4).notes, [note(60, 0, 1), note(64, 0, 0.25), note(67, 1, 0.5), note(72, 3, 0.5)])
  })

  await check('duplicateNotes: la copia corrida queda seleccionada y lo que cae fuera del clip se descarta', () => {
    const notes = [note(60, 0, 1), note(62, 1, 1)]
    const twice = duplicateNotes(notes, [0, 1], 2, 4)
    assert.deepStrictEqual(twice.notes, [note(60, 0, 1), note(62, 1, 1), note(60, 2, 1), note(62, 3, 1)])
    assert.deepStrictEqual(twice.selection, [2, 3])
    const partial = duplicateNotes(notes, [0, 1], 3, 4)
    assert.deepStrictEqual(partial.notes, [note(60, 0, 1), note(62, 1, 1), note(60, 3, 1)])
    assert.deepStrictEqual(partial.selection, [2])
  })

  await check('splitNotesAt: corta las notas que cruzan el punto; cerca del borde no corta', () => {
    const r = splitNotesAt([note(60, 0, 2), note(64, 1, 0.25)], null, 0.5, 4)
    assert.deepStrictEqual(r.notes, [note(60, 0, 0.5), note(60, 0.5, 1.5), note(64, 1, 0.25)])
    assert.deepStrictEqual(r.selection, [0, 1, 2])
    assert.deepStrictEqual(splitNotesAt([note(60, 0, 2)], null, 0.01, 4).notes, [note(60, 0, 2)])
    assert.deepStrictEqual(splitNotesAt([note(60, 0, 2), note(62, 0, 2)], [1], 1, 4).notes, [note(60, 0, 2), note(62, 0, 1), note(62, 1, 1)])
  })

  await check('notesInRange: rectangulo en tiempo y tono, y un clic como punto', () => {
    const notes = [note(60, 0, 1), note(64, 1, 1), note(67, 2, 1), note(72, 3, 0.5)]
    assert.deepStrictEqual(notesInRange(notes, { startBeat: 0.5, endBeat: 2.5, lowPitch: 60, highPitch: 66 }), [0, 1])
    assert.deepStrictEqual(notesInRange(notes, { startBeat: 2.5, endBeat: 0.5, lowPitch: 70, highPitch: 60 }), [0, 1, 2])
    assert.deepStrictEqual(notesInRange(notes, { startBeat: 1, endBeat: 1, lowPitch: 64, highPitch: 64 }), [1])
    assert.deepStrictEqual(notesInRange(notes, { startBeat: 1, endBeat: 2, lowPitch: 60, highPitch: 60 }), [])
  })

  // =========================================================================
  console.log('\nsessionOps.ts v2 (pistas de instrumento, clips MIDI, congelado y marcas)')

  await check('addInstrumentTrack: agrega la pista y rechaza audio, ids repetidos y la pista 17', () => {
    const s = baseV2()
    const track = defaultInstrumentTrack({ id: 'trk_5', name: 'Bajo', instrument: defaultInstrument('synth', 'bajo_sub') })
    const next = addInstrumentTrack(s, { track, index: 1 })
    assert.equal(next.tracks.length, 5)
    assert.equal(next.tracks[1].id, 'trk_5')
    assert.equal(next.tracks[1].kind, 'instrument')
    assert.equal(next.tracks[1].role, 'keys')
    assert.equal(next.tracks[0], s.tracks[0])
    sessionError(() => addInstrumentTrack(s, { track: defaultTrack({ id: 'trk_9', name: 'Audio' }) }), 'bad_value', 'kind')
    sessionError(() => addInstrumentTrack(s, { track: { ...track, id: 'trk_2' } }), 'duplicate_id', 'id')
    let full = s
    for (let i = s.tracks.length; i < STUDIO_MAX_TRACKS; i++) full = addInstrumentTrack(full, { track: { ...track, id: `trk_x${i}` } })
    sessionError(() => addInstrumentTrack(full, { track }), 'too_many', 'tracks')
  })

  await check('addMidiClip: normaliza las notas y respeta pista, ids unicos con los de audio y topes', () => {
    const s = baseV2()
    const clip = defaultMidiClip({ id: 'mid_new', startBeat: 40, lengthBeats: 4, notes: [note(60, 1, 1), note(60, 0, 2), note(64, 9, 1)] })
    const next = addMidiClip(s, { trackId: 'trk_4', clip })
    assert.deepStrictEqual(midiClip(next, 'mid_new').notes, [note(60, 0, 1), note(60, 1, 1)])
    assert.equal(next.tracks[0], s.tracks[0])
    assert.equal(next.tracks[3].midiClips[0], s.tracks[3].midiClips[0])
    sessionError(() => addMidiClip(s, { trackId: 'trk_1', clip }), 'bad_value', 'track_id')
    sessionError(() => addMidiClip(s, { trackId: 'trk_4', clip: { ...clip, id: 'clp_1' } }), 'duplicate_id', 'id')
    sessionError(() => addMidiClip(s, { trackId: 'trk_4', clip: { ...clip, id: 'mid_d1' } }), 'duplicate_id', 'id')
    sessionError(() => addMidiClip(s, { trackId: 'trk_zz', clip }), 'bad_id', 'track_id')
    const many = Array.from({ length: STUDIO_MAX_NOTES_PER_CLIP + 1 }, (_, i) => note(i % 128, Math.floor(i / 128) * 0.25, 0.25))
    sessionError(() => addMidiClip(s, { trackId: 'trk_4', clip: { ...clip, lengthBeats: 64, notes: many } }), 'too_many', 'notes')
    // Un inicio despues del fin de la sesion se acota (120 BPM: 2400 beats).
    const late = addMidiClip(s, { trackId: 'trk_4', clip: { ...clip, startBeat: 99999 } })
    assert.equal(midiClip(late, 'mid_new').startBeat, 2396)
  })

  await check('v1 en una sesion v2: un clip de audio no va a una pista de instrumento', () => {
    const s = baseV2()
    const audio = { ...clip(s, 'clp_1'), id: 'clp_9' }
    sessionError(() => addClip(s, { trackId: 'trk_2', clip: audio }), 'bad_value', 'track_id')
    sessionError(() => moveClip(s, { clipId: 'clp_1', startS: 0, trackId: 'trk_3' }), 'bad_value', 'track_id')
    sessionError(() => addClip(s, { trackId: 'trk_1', clip: { ...audio, id: 'mid_p1' } }), 'duplicate_id', 'id')
    sessionError(() => splitClip(s, { clipId: 'clp_1', atS: 10, newClipId: 'mid_d1' }), 'duplicate_id', 'new_clip_id')
  })

  await check('updateMidiClip: normaliza, acota y devuelve la misma sesion si nada cambia', () => {
    const s = baseV2()
    const next = updateMidiClip(s, { clipId: 'mid_s1', patch: { notes: [note(72, 3, 1), note(60, 0, 2), note(60, 1, 1), note(50, 8, 1)] } })
    assert.deepStrictEqual(midiClip(next, 'mid_s1').notes, [note(60, 0, 1), note(60, 1, 1), note(72, 3, 1)])
    assert.equal(updateMidiClip(s, { clipId: 'mid_s1', patch: { notes: structuredClone(midiClip(s, 'mid_s1').notes) } }), s)
    const looped = updateMidiClip(s, { clipId: 'mid_d1', patch: { loop: true, loopBeats: 0.001 } })
    assert.equal(midiClip(looped, 'mid_d1').loop, true)
    assert.equal(midiClip(looped, 'mid_d1').loopBeats, 0.0625)
    sessionError(() => updateMidiClip(s, { clipId: 'clp_1', patch: { loop: true } }), 'bad_id', 'clip_id')
  })

  await check('moveMidiClip y removeMidiClip: acota al inicio y al fin, y solo entre pistas de instrumento', () => {
    const s = baseV2()
    assert.equal(midiClip(moveMidiClip(s, { clipId: 'mid_p1', startBeat: -5 }), 'mid_p1').startBeat, 0)
    assert.equal(midiClip(moveMidiClip(s, { clipId: 'mid_p1', startBeat: 1e9 }), 'mid_p1').startBeat, 2384)
    assert.equal(moveMidiClip(s, { clipId: 'mid_p1', startBeat: 16 }), s)
    const moved = moveMidiClip(s, { clipId: 'mid_p1', startBeat: 8, trackId: 'trk_4' })
    assert.equal(findMidiClip(moved, 'mid_p1')?.track.id, 'trk_4')
    assert.equal(moved.tracks[1].midiClips.length, 0)
    sessionError(() => moveMidiClip(s, { clipId: 'mid_p1', startBeat: 0, trackId: 'trk_1' }), 'bad_value', 'track_id')
    const removed = removeMidiClip(s, { clipId: 'mid_d1' })
    assert.equal(findMidiClip(removed, 'mid_d1'), null)
    assert.equal(countSessionNotes(removed), countSessionNotes(s) - 24)
  })

  await check('resizeMidiClip: el final quita las notas de afuera; el principio conserva la posicion absoluta', () => {
    const s = baseV2()
    const shorter = midiClip(resizeMidiClip(s, { clipId: 'mid_d1', edge: 'end', toBeat: 4 }), 'mid_d1')
    assert.equal(shorter.lengthBeats, 4)
    assert.equal(shorter.notes.length, 12)
    assert.ok(shorter.notes.every((n) => n.start < 4))
    const longer = midiClip(resizeMidiClip(s, { clipId: 'mid_d1', edge: 'end', toBeat: 12 }), 'mid_d1')
    assert.equal(longer.lengthBeats, 12)
    assert.equal(longer.notes, midiClip(s, 'mid_d1').notes)
    const front = midiClip(resizeMidiClip(s, { clipId: 'mid_s1', edge: 'start', toBeat: 33.5 }), 'mid_s1')
    assert.equal(front.startBeat, 33.5)
    assert.equal(front.lengthBeats, 2.5)
    assert.deepStrictEqual(front.notes, [note(67, 0.5, 1, 92), note(72, 1.5, 1, 100)])
    const minimum = midiClip(resizeMidiClip(s, { clipId: 'mid_s1', edge: 'end', toBeat: 0 }), 'mid_s1')
    assert.equal(minimum.lengthBeats, 0.0625)
    assert.equal(resizeMidiClip(s, { clipId: 'mid_s1', edge: 'end', toBeat: 36 }), s)
  })

  await check('duplicateMidiClip: por defecto justo despues; el id nuevo no puede repetir uno de audio', () => {
    const s = baseV2()
    const next = duplicateMidiClip(s, { clipId: 'mid_s1', newClipId: 'mid_s2' })
    const copy = midiClip(next, 'mid_s2')
    assert.equal(copy.startBeat, 36)
    assert.deepStrictEqual(copy.notes, midiClip(s, 'mid_s1').notes)
    assert.equal(next.tracks[3].midiClips[1].id, 'mid_s2')
    sessionError(() => duplicateMidiClip(s, { clipId: 'mid_s1', newClipId: 'clp_1' }), 'duplicate_id', 'new_clip_id')
  })

  await check('splitMidiClip: divide las notas que cruzan el corte y despliega la repeticion', () => {
    const s = baseV2()
    const next = splitMidiClip(s, { clipId: 'mid_p1', atBeat: 20, newClipId: 'mid_p2' })
    const left = midiClip(next, 'mid_p1')
    const right = midiClip(next, 'mid_p2')
    assert.equal(left.lengthBeats, 4)
    assert.deepStrictEqual(left.notes, [note(61, 0, 4, 90), note(64, 0, 4, 90), note(68, 0, 4, 90)])
    assert.equal(right.startBeat, 20)
    assert.equal(right.lengthBeats, 12)
    assert.deepStrictEqual(right.notes, [note(61, 0, 4, 90), note(64, 0, 4, 90), note(68, 0, 4, 90), note(57, 4, 8, 90), note(61, 4, 8, 90), note(64, 4, 8, 90)])
    assert.equal(countSessionNotes(next), countSessionNotes(s) + 3)
    // En el borde no hay nada que dividir.
    assert.equal(splitMidiClip(s, { clipId: 'mid_p1', atBeat: 16, newClipId: 'mid_p2' }), s)
    assert.equal(splitMidiClip(s, { clipId: 'mid_p1', atBeat: 31.99, newClipId: 'mid_p2' }), s)
    // Un clip con repeticion: las dos mitades suenan igual y quedan sin repeticion.
    const loopClip: StudioMidiClip = { id: 'mid_l', startBeat: 40, lengthBeats: 8, loop: true, loopBeats: 2, notes: [note(60, 0, 1)] }
    const withLoop = addMidiClip(s, { trackId: 'trk_4', clip: loopClip })
    assert.deepStrictEqual(expandMidiClipNotes(midiClip(withLoop, 'mid_l')), [note(60, 0, 1), note(60, 2, 1), note(60, 4, 1), note(60, 6, 1)])
    const cut = splitMidiClip(withLoop, { clipId: 'mid_l', atBeat: 43, newClipId: 'mid_l2' })
    assert.deepStrictEqual(midiClip(cut, 'mid_l').notes, [note(60, 0, 1), note(60, 2, 1)])
    assert.deepStrictEqual(midiClip(cut, 'mid_l2').notes, [note(60, 1, 1), note(60, 3, 1)])
    assert.equal(midiClip(cut, 'mid_l').loop, false)
    assert.equal(midiClip(cut, 'mid_l2').loopBeats, 5)
  })

  await check('setFrozenAsset y setInstrument: pista de instrumento, audios de la sesion y misma referencia', () => {
    const s = baseV2()
    assert.equal(setFrozenAsset(s, { trackId: 'trk_3', assetId: 'ast_s1' }).tracks[2].frozenAssetId, 'ast_s1')
    assert.equal(setFrozenAsset(s, { trackId: 'trk_2', assetId: 'ast_f1' }), s)
    assert.equal(setFrozenAsset(s, { trackId: 'trk_2', assetId: null }).tracks[1].frozenAssetId, null)
    sessionError(() => setFrozenAsset(s, { trackId: 'trk_3', assetId: 'ast_zz' }), 'unknown_asset', 'asset_id')
    sessionError(() => setFrozenAsset(s, { trackId: 'trk_1', assetId: null }), 'bad_value', 'track_id')
    const drums = setInstrument(s, { trackId: 'trk_2', instrument: defaultInstrument('drums', 'seco') })
    assert.equal(drums.tracks[1].instrument?.type, 'drums')
    assert.deepStrictEqual(drums.tracks[1].midiClips, s.tracks[1].midiClips)
    assert.equal(setInstrument(s, { trackId: 'trk_2', instrument: structuredClone(s.tracks[1].instrument) as never }), s)
    const sampler = structuredClone(s.tracks[3].instrument) as Json
    sampler.zones[0].assetId = 'ast_zz'
    sessionError(() => setInstrument(s, { trackId: 'trk_4', instrument: sampler }), 'unknown_asset', 'instrument.zones[0].asset_id')
    sessionError(() => setInstrument(s, { trackId: 'trk_1', instrument: defaultInstrument('synth') }), 'bad_value', 'track_id')
  })

  await check('setMarkers: ordena por beat e id, y rechaza repetidos, el exceso y las marcas despues de 20 minutos', () => {
    const s = baseV2()
    const next = setMarkers(s, {
      markers: [
        { id: 'mk_b', beat: 32, label: ' Puente ', kind: 'bridge' },
        { id: 'mk_a', beat: 32, label: 'Solo', kind: 'solo' },
        { id: 'mk_0', beat: -4, label: '', kind: 'marker' },
      ],
    })
    assert.deepStrictEqual(
      next.markers.map((m) => [m.id, m.beat, m.label]),
      [
        ['mk_0', 0, ''],
        ['mk_a', 32, 'Solo'],
        ['mk_b', 32, 'Puente'],
      ],
    )
    assert.equal(setMarkers(s, { markers: structuredClone(s.markers).reverse() }), s)
    sessionError(() => setMarkers(s, { markers: [s.markers[0], s.markers[0]] }), 'duplicate_id', 'markers[1].id')
    sessionError(() => setMarkers(s, { markers: [{ id: 'mk_x', beat: 2401, label: '', kind: 'marker' }] }), 'session_too_long', 'markers[0].beat')
    const tooMany = Array.from({ length: 257 }, (_, i) => ({ id: `mk_${i}`, beat: i, label: '', kind: 'marker' as const }))
    sessionError(() => setMarkers(s, { markers: tooMany }), 'too_many', 'markers')
  })

  await check('removeUnusedAssets conserva zonas del sampler y congelados; bajar el bpm comprueba los clips MIDI', () => {
    const s = baseV2()
    assert.equal(removeUnusedAssets(s), s)
    const noVoice = removeUnusedAssets(deleteClip(s, { clipId: 'clp_1' }))
    assert.deepStrictEqual(
      noVoice.assets.map((a) => a.id),
      ['ast_s1', 'ast_f1'],
    )
    const late = addMidiClip(s, { trackId: 'trk_4', clip: defaultMidiClip({ id: 'mid_late', startBeat: 2380, lengthBeats: 16 }) })
    sessionError(() => updateSessionMeta(late, { patch: { bpm: 100 } }), 'session_too_long')
    assert.equal(updateSessionMeta(late, { patch: { bpm: 140 } }).bpm, 140)
  })

  // =========================================================================
  console.log('\nsmf.ts (archivos MIDI estandar)')

  // Tipo 0 a mano: 96 ticks por negra, nombre, tempo 120, compas 3/4, running status, note-on con
  // velocidad 0 como note-off y una nota en el canal 10.
  const type0 = Uint8Array.from([
    ...smfChunk('MThd', [0x00, 0x00, 0x00, 0x01, 0x00, 0x60]),
    ...smfChunk('MTrk', [
      0x00, 0xff, 0x03, 0x04, ...ascii('Bajo'),
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08,
      0x00, 0x90, 0x3c, 0x64,
      0x60, 0x3e, 0x50,
      0x00, 0x3c, 0x00,
      0x60, 0x80, 0x3e, 0x40,
      0x00, 0x99, 0x24, 0x7f,
      0x30, 0x24, 0x00,
      0x81, 0x00, 0xff, 0x2f, 0x00,
    ]),
  ])

  await check('parseSmf tipo 0: running status, velocidad 0, tempo, compas y canales separados', () => {
    const file = parseSmf(type0)
    assert.equal(file.format, 0)
    assert.equal(file.ticksPerBeat, 96)
    assert.equal(file.bpm, 120)
    assert.equal(file.beatsPerBar, 3)
    assert.equal(file.tempoChanges, false)
    assert.equal(file.tracks.length, 2)
    assert.deepStrictEqual(file.tracks[0], { name: 'Bajo (canal 1)', channel: 0, isDrums: false, notes: [note(60, 0, 1, 100), note(62, 1, 1, 80)] })
    assert.deepStrictEqual(file.tracks[1], { name: 'Bajo (canal 10)', channel: 9, isDrums: true, notes: [note(36, 2, 0.5, 127)] })
    // Tambien desde un ArrayBuffer.
    assert.deepStrictEqual(parseSmf(type0.slice().buffer), file)
  })

  await check('parseSmf tipo 1: cambios de tempo, sysex, fragmento desconocido y nota sin note-off', () => {
    const type1 = Uint8Array.from([
      ...smfChunk('MThd', [0x00, 0x01, 0x00, 0x03, 0x01, 0xe0]),
      ...smfChunk('MTrk', [0x00, 0xff, 0x51, 0x03, 0x09, 0x27, 0xc0, 0x83, 0x60, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0xff, 0x2f, 0x00]),
      ...smfChunk('XFIL', [0x00, 0x00]),
      ...smfChunk('MTrk', [
        0x00, 0xff, 0x03, 0x05, ...ascii('Piano'),
        0x00, 0xf0, 0x03, 0x7e, 0x7f, 0xf7,
        0x00, 0x91, 0x40, 0x50,
        0x83, 0x60, 0x40, 0x00,
        0x00, 0x43, 0x60,
        0x83, 0x60, 0xff, 0x2f, 0x00,
      ]),
      ...smfChunk('MTrk', [0x00, 0xff, 0x03, 0x05, ...ascii('Vacia'), 0x00, 0xb0, 0x07, 0x64, 0x00, 0xff, 0x2f, 0x00]),
    ])
    const file = parseSmf(type1)
    assert.equal(file.format, 1)
    assert.equal(file.ticksPerBeat, 480)
    assert.equal(file.bpm, 100)
    assert.equal(file.tempoChanges, true)
    assert.equal(file.beatsPerBar, null)
    assert.deepStrictEqual(file.tracks, [{ name: 'Piano', channel: 1, isDrums: false, notes: [note(64, 0, 1, 80), note(67, 1, 1, 96)] }])
  })

  await check('parseSmf rechaza lo que no es un SMF tipo 0 o 1 con ticks por negra, y lo truncado', () => {
    smfError(() => parseSmf(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 6, 0, 0, 0, 1, 0, 96])), /MThd/)
    smfError(() => parseSmf(Uint8Array.from(smfChunk('MThd', [0x00, 0x02, 0x00, 0x01, 0x00, 0x60]))), /tipo 2/)
    smfError(() => parseSmf(Uint8Array.from(smfChunk('MThd', [0x00, 0x00, 0x00, 0x01, 0xe7, 0x28]))), /SMPTE/)
    smfError(() => parseSmf(type0.slice(0, type0.length - 6)), /incompleto/)
    smfError(() => parseSmf(Uint8Array.from(smfChunk('MThd', [0x00, 0x01, 0x00, 0x02, 0x00, 0x60]))), /declara 2 pistas/)
    // Un meta cancela el running status: un byte de datos despues de un meta no tiene estado.
    const afterMeta = Uint8Array.from([
      ...smfChunk('MThd', [0x00, 0x00, 0x00, 0x01, 0x00, 0x60]),
      ...smfChunk('MTrk', [0x00, 0x90, 0x3c, 0x40, 0x00, 0xff, 0x01, 0x00, 0x00, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00]),
    ])
    smfError(() => parseSmf(afterMeta), /running status/)
  })

  await check('writeSmf: tipo 1 de 480 ticks, ida y vuelta, canal 10 para la bateria y bytes deterministas', () => {
    const clips = [
      { name: 'Pad', notes: [note(60, 0, 1, 90), note(64, 0.5, 1.5, 80), note(60, 1, 1, 70)] },
      { name: 'Batería', channel: 9, notes: [note(36, 0, 0.25, 110)] },
    ]
    const bytes = writeSmf(clips, 128, 3)
    assert.deepStrictEqual([...bytes.slice(0, 14)], [...ascii('MThd'), 0, 0, 0, 6, 0, 1, 0, 3, 0x01, 0xe0])
    assert.equal(SMF_TICKS_PER_BEAT, 480)
    assert.deepStrictEqual([...writeSmf(clips, 128, 3)], [...bytes])
    // Bateria: note-on en el canal 10, note-off 120 ticks despues, fin de pista.
    assert.ok(containsBytes(bytes, [0x00, 0x99, 0x24, 0x6e, 0x78, 0x89, 0x24, 0x40, 0x00, 0xff, 0x2f, 0x00]))
    const file = parseSmf(bytes)
    assert.equal(file.format, 1)
    assert.equal(file.bpm, 128)
    assert.equal(file.beatsPerBar, 3)
    assert.equal(file.tempoChanges, false)
    assert.deepStrictEqual(file.tracks, [
      { name: 'Pad', channel: 0, isDrums: false, notes: [note(60, 0, 1, 90), note(64, 0.5, 1.5, 80), note(60, 1, 1, 70)] },
      { name: 'Batería', channel: 9, isDrums: true, notes: [note(36, 0, 0.25, 110)] },
    ])
    assert.throws(() => writeSmf(clips, 0, 4))
    // Un solo clip tambien va como tipo 1, con su pista de tempo.
    assert.equal(parseSmf(writeSmf([clips[0]], 90, 4)).format, 1)
  })

  await check('midiClipExportNotes: despliega la repeticion y recorta al final del clip', () => {
    const looped: StudioMidiClip = { id: 'mid_e', startBeat: 8, lengthBeats: 5, loop: true, loopBeats: 2, notes: [note(60, 0, 1), note(62, 1.5, 1)] }
    assert.deepStrictEqual(midiClipExportNotes(looped), [note(60, 8, 1), note(62, 9.5, 1), note(60, 10, 1), note(62, 11.5, 1), note(60, 12, 1)])
    const plain: StudioMidiClip = { id: 'mid_f', startBeat: 4, lengthBeats: 2, loop: false, loopBeats: 2, notes: [note(60, 1, 4)] }
    assert.deepStrictEqual(midiClipExportNotes(plain), [note(60, 5, 1)])
  })

  // =========================================================================
  console.log('\nsessionOps.ts: atajos de DAW (portapapeles, seleccion multiple, unir, recortar)')

  const idMaker = () => {
    let n = 0
    return (kind: 'audio' | 'midi') => `${kind === 'audio' ? 'clp' : 'mid'}_t${++n}`
  }

  await check('copiar y pegar un clip de audio: misma pista, justo despues del original, y Ctrl+V repetido encadena', () => {
    const s = baseV2()
    const board = copyClips(s, ['clp_1'])
    assert.ok(board)
    assert.equal(board.startS, 8)
    assert.equal(board.spanS, 20)
    // El cabezal no se movio desde que se copio: el pegado va detras del original.
    const first = pastePosition(board, pasteCursorAfterCopy(board, 0), 0)
    assert.equal(first.atS, 28)
    const newId = idMaker()
    const r1 = pasteClips(s, board, { atS: first.atS, trackId: 'trk_1', newClipId: newId })
    assert.deepStrictEqual(r1.clipIds, ['clp_t1'])
    const pasted = clip(r1.session, 'clp_t1')
    assert.equal(findClip(r1.session, 'clp_t1')?.track.id, 'trk_1')
    assert.equal(pasted.startS, 28)
    assert.equal(pasted.lengthS, 20)
    assert.equal(pasted.assetId, 'ast_v1')
    assert.equal(pasted.active, true)
    assert.equal(pasted.takeGroup, null)
    // El original no cambia.
    assert.equal(clip(r1.session, 'clp_1').startS, 8)
    // Segundo Ctrl+V sin mover el cabezal: detras de la copia anterior.
    const second = pastePosition(board, first.cursor, 0)
    assert.equal(second.atS, 48)
    const r2 = pasteClips(r1.session, board, { atS: second.atS, trackId: 'trk_1', newClipId: newId })
    assert.deepStrictEqual(findTrack(r2.session, 'trk_1')?.clips.map((c) => c.startS), [8, 28, 48])
    // Con el cabezal movido, el pegado va al cabezal.
    assert.equal(pastePosition(board, second.cursor, 100).atS, 100)
    assert.equal(pastePosition(board, pastePosition(board, second.cursor, 100).cursor, 100).atS, 120)
  })

  await check('pegar: en la pista elegida si es compatible; si no, en la de origen; pista borrada pide otra', () => {
    const s = baseV2()
    const newId = idMaker()
    const board = copyClips(s, ['mid_p1'])
    assert.ok(board)
    // trk_3 es de instrumento: se pega ahi, en beats (8 s = beat 16 a 120 BPM).
    const inOther = pasteClips(s, board, { atS: 40, trackId: 'trk_3', newClipId: newId })
    assert.equal(findMidiClip(inOther.session, inOther.clipIds[0])?.track.id, 'trk_3')
    assert.equal(midiClip(inOther.session, inOther.clipIds[0]).startBeat, 80)
    assert.deepStrictEqual(midiClip(inOther.session, inOther.clipIds[0]).notes, midiClip(s, 'mid_p1').notes)
    // trk_1 es de audio: no admite MIDI, el clip va a su pista de origen.
    const inAudio = pasteClips(s, board, { atS: 40, trackId: 'trk_1', newClipId: newId })
    assert.equal(findMidiClip(inAudio.session, inAudio.clipIds[0])?.track.id, 'trk_2')
    // De dos pistas: cada clip a la suya aunque haya pista elegida, conservando la distancia.
    const mixed = copyClips(s, ['clp_1', 'mid_d1'])
    assert.ok(mixed)
    assert.equal(mixed.startS, 0)
    assert.equal(mixed.spanS, 28)
    const both = pasteClips(s, mixed, { atS: 100, trackId: 'trk_3', newClipId: newId })
    assert.equal(both.clipIds.length, 2)
    const audioId = both.clipIds.find((id) => findClip(both.session, id))
    const midiId = both.clipIds.find((id) => findMidiClip(both.session, id))
    assert.ok(audioId && midiId)
    assert.equal(findClip(both.session, audioId)?.track.id, 'trk_1')
    assert.equal(clip(both.session, audioId).startS, 108)
    assert.equal(findMidiClip(both.session, midiId)?.track.id, 'trk_3')
    assert.equal(midiClip(both.session, midiId).startBeat, 200)
    // La pista de origen ya no existe: con una pista compatible elegida va ahi; sin ella, error.
    const gone = removeTrack(s, { trackId: 'trk_2' })
    const rescued = pasteClips(gone, board, { atS: 0, trackId: 'trk_4', newClipId: newId })
    assert.equal(findMidiClip(rescued.session, rescued.clipIds[0])?.track.id, 'trk_4')
    sessionError(() => pasteClips(gone, board, { atS: 0, trackId: 'trk_1', newClipId: newId }), 'bad_id', 'track_id')
  })

  await check('cortar y pegar sin mover el cabezal devuelve el clip a su lugar', () => {
    const s = baseV2()
    const board = copyClips(s, ['clp_1'])
    assert.ok(board)
    const cut = deleteClips(s, ['clp_1'])
    assert.equal(findClip(cut, 'clp_1'), null)
    const at = pastePosition(board, { playheadS: 3, nextS: board.startS }, 3)
    assert.equal(at.atS, 8)
    const back = pasteClips(cut, board, { atS: at.atS, trackId: 'trk_1', newClipId: idMaker() })
    assert.equal(clip(back.session, back.clipIds[0]).startS, 8)
  })

  await check('seleccion multiple: borrar, mover juntos (acotado al inicio) y rango de la seleccion', () => {
    const s = baseV2()
    const both = ['clp_1', 'mid_p1', 'no_existe']
    assert.deepStrictEqual(clipsRangeS(s, ['clp_1', 'mid_d1']), { startS: 0, endS: 28 })
    assert.equal(clipsRangeS(s, ['no_existe']), null)
    const gone = deleteClips(s, both)
    assert.equal(findClip(gone, 'clp_1'), null)
    assert.equal(findMidiClip(gone, 'mid_p1'), null)
    assert.ok(findMidiClip(gone, 'mid_d1'))
    assert.equal(deleteClips(s, ['no_existe']), s)
    // clp_1 empieza en 8 s y mid_p1 en el beat 16 (8 s): -10 s se acota a -8 s para los dos.
    const left = moveClipsBy(s, both, -10)
    assert.equal(clip(left, 'clp_1').startS, 0)
    assert.equal(midiClip(left, 'mid_p1').startBeat, 0)
    const right = moveClipsBy(s, both, 2)
    assert.equal(clip(right, 'clp_1').startS, 10)
    assert.equal(midiClip(right, 'mid_p1').startBeat, 20)
    assert.equal(moveClipsBy(s, both, 0), s)
    // Mover deja a cada clip en su pista.
    assert.equal(findClip(right, 'clp_1')?.track.id, 'trk_1')
  })

  await check('unir clips MIDI: dividir y unir deja el clip como estaba; con hueco, el hueco queda en silencio', () => {
    const s = baseV2()
    const split = splitMidiClip(s, { clipId: 'mid_d1', atBeat: 4, newClipId: 'mid_half' })
    assert.equal(findTrack(split, 'trk_3')?.midiClips.length, 2)
    const joined = joinClips(split, ['mid_d1', 'mid_half'])
    assert.deepStrictEqual(joined.clipIds, ['mid_d1'])
    const back = midiClip(joined.session, 'mid_d1')
    assert.equal(back.startBeat, 0)
    assert.equal(back.lengthBeats, 8)
    assert.deepStrictEqual(back.notes, midiClip(s, 'mid_d1').notes)
    assert.equal(findTrack(joined.session, 'trk_3')?.midiClips.length, 1)
    // Con un clip mas adelante: el unido va del primero al ultimo.
    const later = addMidiClip(s, { trackId: 'trk_3', clip: { id: 'mid_late', startBeat: 12, lengthBeats: 4, loop: false, loopBeats: 4, notes: [note(40, 1, 1)] } })
    const gap = joinClips(later, ['mid_d1', 'mid_late'])
    const merged = midiClip(gap.session, 'mid_d1')
    assert.equal(merged.lengthBeats, 16)
    assert.equal(merged.notes.length, midiClip(s, 'mid_d1').notes.length + 1)
    assert.ok(merged.notes.some((n) => n.pitch === 40 && n.start === 13))
    // Un solo clip, o clips de pistas distintas: nada que unir.
    assert.equal(joinClips(s, ['mid_d1']).session, s)
    assert.equal(joinClips(s, ['mid_d1', 'mid_p1']).session, s)
  })

  await check('unir clips de audio: solo trozos seguidos del mismo audio (deshace una division)', () => {
    const s = baseV2()
    const split = splitClip(s, { clipId: 'clp_1', atS: 18, newClipId: 'clp_half' })
    const joined = joinClips(split, ['clp_1', 'clp_half'])
    assert.deepStrictEqual(joined.clipIds, ['clp_1'])
    const back = clip(joined.session, 'clp_1')
    assert.equal(back.startS, 8)
    assert.equal(back.offsetS, 0)
    assert.equal(back.lengthS, 20)
    assert.equal(back.fadeOutS, 0.05)
    assert.equal(findTrack(joined.session, 'trk_1')?.clips.length, 1)
    // Separados por un hueco ya no son seguidos: no se unen.
    const apart = moveClip(split, { clipId: 'clp_half', startS: 19 })
    assert.equal(joinClips(apart, ['clp_1', 'clp_half']).session, apart)
  })

  await check('recortar inicio y final al cabezal; fundidos al cabezal; fuera del clip no cambia nada', () => {
    const s = baseV2()
    const start = trimClipsAt(s, ['clp_1', 'mid_p1'], 'start', 10)
    assert.equal(clip(start, 'clp_1').startS, 10)
    assert.equal(clip(start, 'clp_1').offsetS, 2)
    assert.equal(clip(start, 'clp_1').lengthS, 18)
    assert.equal(midiClip(start, 'mid_p1').startBeat, 20)
    assert.equal(midiClip(start, 'mid_p1').lengthBeats, 12)
    const end = trimClipsAt(s, ['clp_1'], 'end', 20)
    assert.equal(clip(end, 'clp_1').startS, 8)
    assert.equal(clip(end, 'clp_1').lengthS, 12)
    assert.equal(trimClipsAt(s, ['clp_1'], 'start', 5), s)
    assert.equal(trimClipsAt(s, ['clp_1'], 'end', 30), s)
    assert.equal(clip(fadeClipsAt(s, ['clp_1'], 'in', 9), 'clp_1').fadeInS, 1)
    close(clip(fadeClipsAt(s, ['clp_1'], 'out', 26), 'clp_1').fadeOutS, 2)
    assert.equal(fadeClipsAt(s, ['mid_p1'], 'in', 10), s)
  })

  await check('silenciar clips de audio (active false) y volver a hacerlos sonar; los MIDI se ignoran', () => {
    const s = baseV2()
    const muted = toggleClipsActive(s, ['clp_1', 'mid_p1'])
    assert.equal(clip(muted, 'clp_1').active, false)
    assert.equal(midiClip(muted, 'mid_p1'), midiClip(s, 'mid_p1'))
    const back = toggleClipsActive(muted, ['clp_1'])
    assert.equal(clip(back, 'clp_1').active, true)
    assert.equal(toggleClipsActive(s, ['mid_p1']), s)
  })

  await check('duplicar y mover pistas', () => {
    const s = baseV2()
    const dup = duplicateTrack(s, { trackId: 'trk_2', newTrackId: 'trk_dup', newClipId: idMaker() })
    assert.deepStrictEqual(dup.tracks.map((t) => t.id), ['trk_1', 'trk_2', 'trk_dup', 'trk_3', 'trk_4'])
    const copy = findTrack(dup, 'trk_dup')
    const original = findTrack(s, 'trk_2')
    assert.ok(copy && original)
    assert.equal(copy.name, `${original.name} copia`)
    assert.deepStrictEqual(copy.instrument, original.instrument)
    assert.equal(copy.midiClips.length, original.midiClips.length)
    assert.notEqual(copy.midiClips[0].id, original.midiClips[0].id)
    assert.deepStrictEqual(copy.midiClips[0].notes, original.midiClips[0].notes)
    sessionError(() => duplicateTrack(s, { trackId: 'trk_2', newTrackId: 'trk_1', newClipId: idMaker() }), 'duplicate_id')
    assert.deepStrictEqual(moveTrack(s, { trackId: 'trk_1', toIndex: 2 }).tracks.map((t) => t.id), ['trk_2', 'trk_3', 'trk_1', 'trk_4'])
    assert.deepStrictEqual(moveTrack(s, { trackId: 'trk_4', toIndex: 99 }).tracks.map((t) => t.id), ['trk_1', 'trk_2', 'trk_3', 'trk_4'])
    assert.equal(moveTrack(s, { trackId: 'trk_1', toIndex: -1 }), s)
  })

  await check('piano roll: invertir la seleccion de notas', () => {
    assert.deepStrictEqual(invertSelection(5, [0, 2]), [1, 3, 4])
    assert.deepStrictEqual(invertSelection(3, []), [0, 1, 2])
    assert.deepStrictEqual(invertSelection(3, [0, 1, 2, 7]), [])
  })

  await check('tap tempo y marca anterior o siguiente', () => {
    let state = tapTempo([], 0, 40, 260)
    assert.equal(state.bpm, null)
    state = tapTempo(state.taps, 500, 40, 260)
    assert.equal(state.bpm, null)
    state = tapTempo(state.taps, 1000, 40, 260)
    assert.equal(state.bpm, 120)
    state = tapTempo(state.taps, 1480, 40, 260)
    close(state.bpm ?? 0, 121.6, 0.05)
    // Una pausa larga empieza de nuevo.
    assert.deepStrictEqual(tapTempo(state.taps, 9000, 40, 260).taps, [9000])
    // Acotado al rango de tempo de la sesion.
    assert.equal(tapTempo([0, 100], 200, 40, 260).bpm, 260)
    const marks = [{ beat: 0 }, { beat: 16 }, { beat: 48 }]
    assert.equal(adjacentMarkerBeat(marks, 10, 1), 16)
    assert.equal(adjacentMarkerBeat(marks, 16, 1), 48)
    assert.equal(adjacentMarkerBeat(marks, 16, -1), 0)
    assert.equal(adjacentMarkerBeat(marks, 48, 1), null)
    assert.equal(adjacentMarkerBeat(marks, 0, -1), null)
  })

  // =========================================================================
  console.log('\ncommands.ts y keymap.ts (atajos y paleta)')

  const specs = STUDIO_COMMAND_SPECS
  const memoryKeys = () => memoryStorage()

  await check('registro por defecto: ids unicos, atajos canonicos y el mapa de la seccion 6 sin choques', () => {
    assert.equal(new Set(specs.map((c) => c.id)).size, specs.length)
    for (const c of specs) for (const s of c.defaultShortcuts) assert.equal(formatShortcut(parseShortcut(s) as never), s, `${c.id}: ${s}`)
    const map = defaultKeymap(specs)
    assert.deepStrictEqual(findConflicts(specs, map), [])
    const expected: Array<[string, string, 'global' | 'timeline' | 'piano_roll']> = [
      ['Space', 'transport.play_pause', 'timeline'],
      ['R', 'transport.record', 'timeline'],
      ['Enter', 'transport.go_to_start', 'timeline'],
      ['Home', 'transport.go_to_start', 'piano_roll'],
      ['L', 'transport.toggle_loop', 'timeline'],
      ['C', 'transport.toggle_click', 'timeline'],
      ['Ctrl+Z', 'edit.undo', 'timeline'],
      ['Ctrl+Y', 'edit.redo', 'timeline'],
      ['Ctrl+Shift+Z', 'edit.redo', 'piano_roll'],
      ['Ctrl+C', 'edit.copy', 'piano_roll'],
      ['Ctrl+X', 'edit.cut', 'piano_roll'],
      ['Ctrl+V', 'edit.paste', 'timeline'],
      ['Ctrl+D', 'edit.duplicate', 'timeline'],
      ['Delete', 'edit.delete', 'timeline'],
      ['Backspace', 'edit.delete', 'piano_roll'],
      ['S', 'edit.split', 'timeline'],
      ['Q', 'edit.quantize', 'piano_roll'],
      ['M', 'track.toggle_mute', 'timeline'],
      ['Shift+S', 'track.toggle_solo', 'timeline'],
      ['Ctrl+A', 'edit.select_all', 'piano_roll'],
      ['ArrowLeft', 'clip.nudge_left', 'timeline'],
      ['ArrowUp', 'notes.transpose_up', 'piano_roll'],
      ['Shift+ArrowDown', 'notes.octave_down', 'piano_roll'],
      ['Plus', 'view.zoom_in', 'timeline'],
      ['Minus', 'view.zoom_out', 'timeline'],
      ['1', 'tool.select', 'piano_roll'],
      ['5', 'tool.velocity', 'piano_roll'],
      ['E', 'view.toggle_editor', 'timeline'],
      ['Ctrl+K', 'view.command_palette', 'timeline'],
      ['Ctrl+S', 'file.save_cloud', 'timeline'],
      ['Ctrl+E', 'file.export', 'timeline'],
      ['Alt+N', 'track.add_audio', 'timeline'],
      ['Alt+I', 'track.add_instrument', 'timeline'],
      ['?', 'view.shortcuts', 'timeline'],
    ]
    for (const [shortcut, id, context] of expected) {
      const p = parseShortcut(shortcut)
      assert.ok(p, shortcut)
      const event = keyEvent(/^[A-Z]$/.test(p.key) ? `Key${p.key}` : /^[0-9]$/.test(p.key) ? `Digit${p.key}` : '', p.key === 'Plus' ? '+' : p.key === 'Minus' ? '-' : p.key === 'Space' ? ' ' : p.key, {
        ctrlKey: p.ctrl,
        altKey: p.alt,
        shiftKey: p.shift || p.key === '?',
      })
      assert.equal(matchEvent(event, context, false, specs, map, 'other'), id, `${shortcut} en ${context}`)
    }
  })

  await check('atajos de DAW: cada atajo nuevo llega a su comando en su contexto, sin Tab ni Ctrl+J', () => {
    const map = defaultKeymap(specs)
    assert.deepStrictEqual(findConflicts(specs, map), [])
    const cases: Array<[KeyEventLike, 'timeline' | 'piano_roll', string]> = [
      [keyEvent('KeyC', 'c', { ctrlKey: true }), 'timeline', 'edit.copy'],
      [keyEvent('KeyV', 'v', { ctrlKey: true }), 'timeline', 'edit.paste'],
      [keyEvent('KeyX', 'x', { ctrlKey: true }), 'timeline', 'edit.cut'],
      [keyEvent('KeyD', 'd', { ctrlKey: true }), 'timeline', 'edit.duplicate'],
      [keyEvent('KeyA', 'a', { ctrlKey: true }), 'timeline', 'edit.select_all'],
      [keyEvent('KeyJ', 'J', { shiftKey: true }), 'timeline', 'edit.join'],
      [keyEvent('Digit0', '0'), 'timeline', 'clip.toggle_mute'],
      [keyEvent('BracketLeft', '[', { altKey: true }), 'timeline', 'clip.trim_start'],
      [keyEvent('BracketRight', ']', { altKey: true }), 'timeline', 'clip.trim_end'],
      [keyEvent('End', 'End'), 'timeline', 'transport.go_to_end'],
      [keyEvent('Comma', ','), 'timeline', 'transport.bar_back'],
      [keyEvent('Period', '.'), 'piano_roll', 'transport.bar_forward'],
      [keyEvent('ArrowLeft', 'ArrowLeft', { ctrlKey: true }), 'timeline', 'transport.prev_marker'],
      [keyEvent('ArrowRight', 'ArrowRight', { ctrlKey: true }), 'piano_roll', 'transport.next_marker'],
      [keyEvent('KeyL', 'l', { ctrlKey: true }), 'timeline', 'transport.loop_selection'],
      [keyEvent('KeyT', 'T', { shiftKey: true }), 'timeline', 'transport.tap_tempo'],
      [keyEvent('KeyK', 'K', { shiftKey: true }), 'timeline', 'transport.toggle_count_in'],
      [keyEvent('KeyZ', 'Z', { shiftKey: true }), 'timeline', 'view.zoom_fit'],
      [keyEvent('KeyC', 'C', { shiftKey: true }), 'timeline', 'view.center_playhead'],
      [keyEvent('KeyM', 'M', { shiftKey: true }), 'timeline', 'marker.add_here'],
      [keyEvent('KeyR', 'R', { shiftKey: true }), 'timeline', 'track.toggle_arm'],
      [keyEvent('F2', 'F2'), 'timeline', 'track.rename'],
      [keyEvent('KeyD', 'D', { ctrlKey: true, shiftKey: true }), 'timeline', 'track.duplicate'],
      [keyEvent('ArrowUp', 'ArrowUp', { altKey: true }), 'timeline', 'track.move_up'],
      [keyEvent('ArrowDown', 'ArrowDown', { altKey: true }), 'timeline', 'track.move_down'],
      [keyEvent('Digit9', '9'), 'timeline', 'track.select_9'],
      [keyEvent('ArrowUp', 'ArrowUp', { altKey: true }), 'piano_roll', 'notes.velocity_up'],
      [keyEvent('ArrowDown', 'ArrowDown', { altKey: true }), 'piano_roll', 'notes.velocity_down'],
      [keyEvent('ArrowRight', 'ArrowRight', { shiftKey: true }), 'piano_roll', 'notes.lengthen'],
      [keyEvent('ArrowLeft', 'ArrowLeft', { shiftKey: true }), 'piano_roll', 'notes.shorten'],
      [keyEvent('KeyI', 'i', { ctrlKey: true }), 'piano_roll', 'notes.invert_selection'],
      [keyEvent('KeyL', 'L', { shiftKey: true }), 'piano_roll', 'notes.legato'],
      [keyEvent('KeyD', 'd', { ctrlKey: true }), 'piano_roll', 'edit.duplicate'],
      [keyEvent('KeyA', 'a', { ctrlKey: true }), 'piano_roll', 'edit.select_all'],
    ]
    for (const [event, context, id] of cases) assert.equal(matchEvent(event, context, false, specs, map, 'other'), id, `${id} en ${context}`)
    // Los atajos de la linea de tiempo no se cuelan en el piano roll ni al reves.
    assert.equal(matchEvent(keyEvent('Digit0', '0'), 'piano_roll', false, specs, map, 'other'), null)
    assert.equal(matchEvent(keyEvent('ArrowRight', 'ArrowRight', { shiftKey: true }), 'timeline', false, specs, map, 'other'), null)
    // Nunca Tab ni una tecla que el navegador se queda (Ctrl+J abria las descargas de Chrome).
    for (const c of specs) {
      assert.ok(!c.defaultShortcuts.some((s) => /(^|\+)Tab$/.test(s)), `${c.id} usa Tab`)
      for (const s of c.defaultShortcuts) assert.ok(!BROWSER_RESERVED_SHORTCUTS.has(s), `${c.id} usa ${s}, reservado por el navegador`)
    }
    // Ningun atajo nuevo es una letra sola de la fila del teclado musical (A..K, Z, X): serian notas.
    const newIds = cases.map(([, , id]) => id).filter((id) => !id.startsWith('edit.'))
    for (const id of newIds) {
      const c = specs.find((s) => s.id === id)
      assert.ok(c, id)
      for (const s of c.defaultShortcuts) assert.ok(!/^[ASDFGHJKWETYUZX]$/.test(s), `${id}: ${s}`)
    }
  })

  await check('herramientas del asistente: las 19 del fixture tienen su comando con el mismo command_id', () => {
    const tools = chatToolsFixture.tools as Array<{ name: string; command_id: string }>
    assert.equal(tools.length, 19)
    for (const tool of tools) {
      const c = specs.find((s) => s.id === tool.command_id)
      assert.ok(c, `falta el comando ${tool.command_id}`)
      assert.equal(c.assistantTool, tool.name)
      assert.equal(c.assistantAllowed, true)
    }
    const allowed = specs.filter((s) => s.assistantAllowed)
    assert.equal(allowed.length, tools.length)
    assert.ok(specs.filter((s) => !s.assistantAllowed).every((s) => s.assistantTool === null))
  })

  await check('parseShortcut, formatShortcut y displayShortcut: forma canonica, alias y Mac', () => {
    const canon = (t: string) => {
      const p = parseShortcut(t)
      return p ? formatShortcut(p) : null
    }
    assert.equal(canon('ctrl+shift+z'), 'Ctrl+Shift+Z')
    assert.equal(canon(' Ctrl + K '), 'Ctrl+K')
    assert.equal(canon('shift+ctrl+t'), 'Ctrl+Shift+T')
    assert.equal(canon('alt+shift+ctrl+arrowup'), 'Ctrl+Alt+Shift+ArrowUp')
    assert.equal(canon('Ctrl++'), 'Ctrl+Plus')
    assert.equal(canon('-'), 'Minus')
    assert.equal(canon('Shift+?'), '?')
    assert.equal(canon('cmd+s'), 'Ctrl+S')
    assert.equal(canon('Supr'), 'Delete')
    assert.equal(canon('espacio'), 'Space')
    assert.equal(canon('f2'), 'F2')
    for (const bad of ['', 'Ctrl+', 'Ctrl+Ctrl+K', 'Hyper+K', 'Ctrl+Shift', 'Ctrl+F13', 'Tecla']) assert.equal(parseShortcut(bad), null, bad)
    assert.equal(displayShortcut('Ctrl+Shift+Z', 'mac'), 'Cmd+Shift+Z')
    assert.equal(displayShortcut('Ctrl+Shift+Z', 'other'), 'Ctrl+Shift+Z')
    assert.equal(displayShortcut('Space', 'other'), 'Espacio')
    assert.equal(displayShortcut('Alt+Delete', 'mac'), 'Option+Supr')
    assert.equal(displayShortcut('Ctrl+Plus', 'other'), 'Ctrl++')
    assert.equal(displayShortcut('no es atajo', 'other'), 'no es atajo')
  })

  await check('shortcutFromEvent: letras por code, simbolos por key y Cmd en Mac', () => {
    assert.equal(shortcutFromEvent(keyEvent('KeyZ', 'Z', { ctrlKey: true, shiftKey: true }), 'other'), 'Ctrl+Shift+Z')
    assert.equal(shortcutFromEvent(keyEvent('KeyZ', 'z', { metaKey: true, shiftKey: true }), 'mac'), 'Ctrl+Shift+Z')
    assert.equal(shortcutFromEvent(keyEvent('KeyZ', 'z', { ctrlKey: true }), 'mac'), null)
    assert.equal(shortcutFromEvent(keyEvent('KeyZ', 'z', { metaKey: true }), 'other'), null)
    assert.equal(shortcutFromEvent(keyEvent('ShiftLeft', 'Shift', { shiftKey: true }), 'other'), null)
    assert.equal(shortcutFromEvent(keyEvent('Slash', '?', { shiftKey: true }), 'other'), '?')
    assert.equal(shortcutFromEvent(keyEvent('Minus', '?', { shiftKey: true }), 'other'), '?')
    assert.equal(shortcutFromEvent(keyEvent('Space', ' '), 'other'), 'Space')
    // AZERTY: la tecla de la Q fisica escribe "a"; el atajo sigue siendo por posicion.
    assert.equal(shortcutFromEvent(keyEvent('KeyQ', 'a'), 'other'), 'Q')
    assert.equal(shortcutFromEvent(keyEvent('NumpadAdd', '+'), 'other'), 'Plus')
    assert.equal(shortcutFromEvent(keyEvent('Numpad3', '3'), 'other'), '3')
    assert.equal(shortcutFromEvent(keyEvent('ArrowUp', 'ArrowUp', { shiftKey: true }), 'other'), 'Shift+ArrowUp')
  })

  await check('matchEvent: nunca en un campo de texto, contexto activo, teclas sostenidas y Mac', () => {
    const map = defaultKeymap(specs)
    const space = keyEvent('Space', ' ')
    assert.equal(matchEvent(space, 'timeline', false, specs, map, 'other'), 'transport.play_pause')
    assert.equal(matchEvent(space, 'timeline', true, specs, map, 'other'), null)
    assert.equal(matchEvent(keyEvent('KeyZ', 'z', { ctrlKey: true }), 'piano_roll', true, specs, map, 'other'), null)
    const up = keyEvent('ArrowUp', 'ArrowUp')
    assert.equal(matchEvent(up, 'piano_roll', false, specs, map, 'other'), 'notes.transpose_up')
    assert.equal(matchEvent(up, 'timeline', false, specs, map, 'other'), 'track.select_prev')
    assert.equal(matchEvent(up, 'mixer', false, specs, map, 'other'), null)
    // 1..9 eligen pista en la linea de tiempo y son herramientas (1..5) en el piano roll.
    assert.equal(matchEvent(keyEvent('Digit2', '2'), 'timeline', false, specs, map, 'other'), 'track.select_2')
    assert.equal(matchEvent(keyEvent('Digit2', '2'), 'piano_roll', false, specs, map, 'other'), 'tool.draw')
    assert.equal(matchEvent(keyEvent('Digit2', '2'), 'mixer', false, specs, map, 'other'), null)
    assert.equal(matchEvent({ ...space, repeat: true }, 'timeline', false, specs, map, 'other'), null)
    assert.equal(matchEvent({ ...keyEvent('ArrowLeft', 'ArrowLeft'), repeat: true }, 'piano_roll', false, specs, map, 'other'), 'notes.nudge_left')
    assert.equal(matchEvent(keyEvent('KeyZ', 'z', { metaKey: true }), 'timeline', false, specs, map, 'mac'), 'edit.undo')
    assert.equal(matchEvent(keyEvent('KeyZ', 'z', { metaKey: true, shiftKey: true }), 'timeline', false, specs, map, 'mac'), 'edit.redo')
    assert.equal(matchEvent(keyEvent('KeyP', 'p'), 'timeline', false, specs, map, 'other'), null)
    // Un comando del contexto activo gana sobre uno global, y el choque se informa.
    const custom = { ...map, 'notes.legato': ['S'] }
    assert.equal(matchEvent(keyEvent('KeyS', 's'), 'piano_roll', false, specs, custom, 'other'), 'notes.legato')
    assert.equal(matchEvent(keyEvent('KeyS', 's'), 'timeline', false, specs, custom, 'other'), 'edit.split')
    assert.deepStrictEqual(findConflicts(specs, custom), [{ shortcut: 'S', commandIds: ['edit.split', 'notes.legato'] }])
    // El mismo atajo en contextos que no se pisan no es choque.
    assert.deepStrictEqual(findConflicts(specs, { ...map, 'notes.legato': ['ArrowLeft'] }), [{ shortcut: 'ArrowLeft', commandIds: ['notes.nudge_left', 'notes.legato'] }])
  })

  await check('keymap guardado: solo las diferencias, choques rechazados, restaurar y lectura tolerante', () => {
    const storage = memoryKeys()
    assert.deepStrictEqual(loadKeymap(storage, specs), defaultKeymap(specs))
    const changed = { ...loadKeymap(storage, specs), 'transport.toggle_click': ['k'] }
    saveKeymap(storage, specs, changed)
    assert.deepStrictEqual(JSON.parse(storage.data.get(KEYMAP_STORAGE_KEY) ?? 'null'), { 'transport.toggle_click': ['K'] })
    const loaded = loadKeymap(storage, specs)
    assert.deepStrictEqual(loaded['transport.toggle_click'], ['K'])
    assert.deepStrictEqual(loaded['transport.play_pause'], ['Space'])
    assert.equal(matchEvent(keyEvent('KeyK', 'k'), 'timeline', false, specs, loaded, 'other'), 'transport.toggle_click')
    assert.equal(matchEvent(keyEvent('KeyC', 'c'), 'timeline', false, specs, loaded, 'other'), null)
    // Un choque o un atajo no valido no se guardan: lo guardado queda como estaba.
    const before = storage.data.get(KEYMAP_STORAGE_KEY)
    assert.throws(() => saveKeymap(storage, specs, { ...loaded, 'edit.split': ['Space'] }), /repetido/)
    assert.throws(() => saveKeymap(storage, specs, { ...loaded, 'edit.split': ['Ctrl+'] }), /no es válido/)
    // Las teclas del navegador (Ctrl+J abre las descargas, Ctrl+T una pestana) no se guardan.
    assert.throws(() => saveKeymap(storage, specs, { ...loaded, 'edit.split': ['ctrl+j'] }), /lo usa el navegador/)
    assert.throws(() => saveKeymap(storage, specs, { ...loaded, 'track.add_audio': ['Ctrl+T'] }), /lo usa el navegador/)
    assert.equal(storage.data.get(KEYMAP_STORAGE_KEY), before)
    // Un mapa guardado antes con una de ellas la pierde al leerse.
    storage.data.set(KEYMAP_STORAGE_KEY, JSON.stringify({ 'view.toggle_assistant': ['Ctrl+J', 'Shift+A'] }))
    assert.deepStrictEqual(loadKeymap(storage, specs)['view.toggle_assistant'], ['Shift+A'])
    storage.data.set(KEYMAP_STORAGE_KEY, before ?? '')
    // Volver a los valores por defecto borra la clave; restaurar tambien.
    saveKeymap(storage, specs, defaultKeymap(specs))
    assert.equal(storage.data.has(KEYMAP_STORAGE_KEY), false)
    saveKeymap(storage, specs, { 'view.shortcuts': [] })
    assert.deepStrictEqual(loadKeymap(storage, specs)['view.shortcuts'], [])
    resetKeymap(storage)
    assert.equal(storage.data.has(KEYMAP_STORAGE_KEY), false)
    // Lectura tolerante.
    for (const garbage of ['{nope', '[]', 'null', '"texto"']) {
      storage.data.set(KEYMAP_STORAGE_KEY, garbage)
      assert.deepStrictEqual(loadKeymap(storage, specs), defaultKeymap(specs), garbage)
    }
    storage.data.set(KEYMAP_STORAGE_KEY, JSON.stringify({ desconocido: ['X'], 'transport.record': 'R', 'transport.play_pause': ['ctrl+p', '???mal', 'Ctrl+P'] }))
    const tolerant = loadKeymap(storage, specs)
    assert.equal('desconocido' in tolerant, false)
    assert.deepStrictEqual(tolerant['transport.record'], ['R'])
    assert.deepStrictEqual(tolerant['transport.play_pause'], ['Ctrl+P'])
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('almacen bloqueado')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    assert.deepStrictEqual(loadKeymap(broken, specs), defaultKeymap(specs))
  })

  await check('createCommandRegistry: duplicados, atajos no canonicos, contextos, asistente y ejecucion', async () => {
    interface Ctx {
      log: string[]
      enabled: boolean
    }
    const registry = createCommandRegistry<Ctx>()
    const base: StudioCommand<Ctx> = {
      id: 'clip.split',
      label: 'Dividir un clip',
      category: 'edicion',
      defaultShortcuts: [],
      context: 'timeline',
      assistantAllowed: true,
      assistantTool: 'split_clip',
      isEnabled: (ctx) => ctx.enabled,
      run: (ctx, args) => {
        ctx.log.push(`split ${String(args?.clip_id)}`)
      },
    }
    registry.register(base)
    registry.register({ ...base, id: 'transport.play_pause', label: 'Reproducir', category: 'transporte', context: 'global', defaultShortcuts: ['Space'], assistantAllowed: false, assistantTool: null, isEnabled: undefined })
    registry.register({ ...base, id: 'notes.legato', label: 'Legato', category: 'midi', context: 'piano_roll', assistantAllowed: false, assistantTool: null })
    assert.throws(() => registry.register(base), /ya está registrado/)
    assert.throws(() => registry.register({ ...base, id: 'x.y', defaultShortcuts: ['ctrl+z'] }), /canónica/)
    assert.throws(() => registry.register({ ...base, id: 'x.z', assistantAllowed: false }), /herramienta/)
    assert.deepStrictEqual(
      registry.forContext('piano_roll').map((c) => c.id),
      ['transport.play_pause', 'notes.legato'],
    )
    assert.equal(registry.forAssistantTool('split_clip')?.id, 'clip.split')
    assert.equal(registry.forAssistantTool('desconocida'), null)
    assert.equal(registry.list().length, 3)
    const ctx: Ctx = { log: [], enabled: true }
    await registry.run('clip.split', ctx, { clip_id: 'clp_1' })
    assert.deepStrictEqual(ctx.log, ['split clp_1'])
    await assert.rejects(registry.run('clip.split', { log: [], enabled: false }), /no está disponible/)
    await assert.rejects(registry.run('no.existe', ctx), /desconocido/)
  })

  await check('buildStudioCommands y createStudioRegistry: solo los comandos con accion', async () => {
    let played = 0
    const handlers: Partial<Record<StudioCommandId, { run: () => void }>> = {
      'transport.play_pause': {
        run: () => {
          played++
        },
      },
      'clip.split': { run: () => {} },
    }
    const commands = buildStudioCommands(handlers)
    assert.deepStrictEqual(
      commands.map((c) => c.id),
      ['transport.play_pause', 'clip.split'],
    )
    const registry = createStudioRegistry(handlers)
    await registry.run('transport.play_pause', null)
    assert.equal(played, 1)
    assert.equal(registry.forAssistantTool('split_clip')?.id, 'clip.split')
    assert.equal(registry.forAssistantTool('delete_clip'), null)
    assert.equal(matchEvent(keyEvent('Space', ' '), 'timeline', false, commands, defaultKeymap(commands), 'other'), 'transport.play_pause')
  })

  // =========================================================================
  console.log('\ncomputerKeyboard.ts (teclado de la computadora como teclado musical)')

  await check('computerKeyPitch: fila A..K con sostenidos y octava base', () => {
    assert.equal(computerKeyPitch('KeyA', 4), 60)
    assert.equal(computerKeyPitch('KeyW', 4), 61)
    assert.equal(computerKeyPitch('KeyJ', 4), 71)
    assert.equal(computerKeyPitch('KeyK', 4), 72)
    assert.equal(computerKeyPitch('KeyA', 3), 48)
    assert.equal(computerKeyPitch('KeyK', 8), 120)
    assert.equal(computerKeyPitch('KeyK', 9), null)
    assert.equal(computerKeyPitch('KeyA', -1), 0)
    assert.equal(computerKeyPitch('KeyQ', 4), null)
    assert.equal(isComputerKeyboardCode('KeyZ'), true)
    assert.equal(isComputerKeyboardCode('KeyS'), true)
    assert.equal(isComputerKeyboardCode('KeyR'), false)
  })

  await check('createComputerKeyboard: octavas con Z y X, teclas sostenidas y modificadores', () => {
    const kb = createComputerKeyboard()
    assert.equal(kb.octave, 4)
    assert.deepStrictEqual(kb.keyDown({ code: 'KeyA' }), { type: 'note_on', pitch: 60, velocity: 100 })
    assert.equal(kb.keyDown({ code: 'KeyA', repeat: true }), null)
    assert.deepStrictEqual(kb.keyDown({ code: 'KeyX' }), { type: 'octave', octave: 5 })
    // La tecla suelta el pitch con el que sono, aunque la octava haya cambiado.
    assert.deepStrictEqual(kb.keyUp({ code: 'KeyA' }), { type: 'note_off', pitch: 60 })
    assert.equal(kb.keyUp({ code: 'KeyA' }), null)
    assert.deepStrictEqual(kb.keyDown({ code: 'KeyA' }), { type: 'note_on', pitch: 72, velocity: 100 })
    assert.equal(kb.keyDown({ code: 'KeyD', ctrlKey: true }), null)
    assert.equal(kb.keyDown({ code: 'KeyS', shiftKey: true }), null)
    assert.deepStrictEqual(kb.keyDown({ code: 'KeyE' }), { type: 'note_on', pitch: 75, velocity: 100 })
    assert.deepStrictEqual(kb.releaseAll(), [
      { type: 'note_off', pitch: 72 },
      { type: 'note_off', pitch: 75 },
    ])
    for (let i = 0; i < 10; i++) kb.keyDown({ code: 'KeyX' })
    assert.equal(kb.octave, 8)
    assert.equal(kb.keyDown({ code: 'KeyX' }), null)
    kb.setOctave(-7)
    assert.equal(kb.octave, -1)
    assert.equal(kb.keyDown({ code: 'KeyZ' }), null)
  })
}

main()
