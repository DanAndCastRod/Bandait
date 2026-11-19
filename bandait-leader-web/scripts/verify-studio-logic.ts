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
  StudioSessionError,
  defaultFx,
  defaultTrack,
  findAsset,
  findClip,
  findTrack,
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
  type StudioSession,
} from '../src/services/studio/session.ts'
import {
  addAsset,
  addClip,
  addTrack,
  applyMixSuggestion,
  deleteClip,
  duplicateClip,
  moveClip,
  removeTrack,
  removeUnusedAssets,
  setActiveTake,
  setClipFades,
  setClipGain,
  setTrackFx,
  snapTime,
  splitClip,
  trimClip,
  updateMaster,
  updateSessionMeta,
  updateTrack,
} from '../src/services/studio/sessionOps.ts'
import {
  STUDIO_JOB_MAX_RETRIES,
  deleteSession,
  estimateJob,
  getAsset,
  getJob,
  getSession,
  jobRequestToWire,
  listSessions,
  parseJobState,
  parseMixSuggestions,
  putAsset,
  putSession,
  startJob,
  studioCloudErrorMessage,
  studioUrl,
  watchJob,
} from '../src/services/studio/studioCloud.ts'
import type { KeyValueStorage, MixSuggestion, StudioJobRequest, StudioJobState } from '../src/services/studio/types.ts'

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

  await check('ida y vuelta: el fixture sale identico, con las claves en el mismo orden', () => {
    const session = base()
    assert.deepStrictEqual(serializeSession(session), fixture)
    assert.equal(JSON.stringify(serializeSession(session)), JSON.stringify(fixture))
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
    ['version distinta de 1', (d) => (d.version = 2), 'unsupported_version', 'version'],
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

  await check('el documento de mas de 256 KB se rechaza al leer y al escribir', () => {
    sessionError(() => parseSessionJson(' '.repeat(256 * 1024 + 1)), 'document_too_large')
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

main()
