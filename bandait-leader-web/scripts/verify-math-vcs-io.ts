/**
 * Suite de verificacion matematica, DSP local, Investigacion de Operaciones (Metaheuristicas),
 * Control de Versiones Musical, Colaboracion 3-way y Puente Cancion-Estudio:
 *   node --experimental-strip-types --no-warnings scripts/verify-math-vcs-io.ts
 */
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import type { Playlist, PlaylistSong, Song } from '../src/types/hub.ts'
import { optimizeSetlistOrder } from '../src/services/setlistOptimizer.ts'
import {
  branchHeadSnapshot,
  commitEntitySnapshot,
  createEntityBranch,
  diffPlaylists,
  diffSongs,
} from '../src/services/versionControl.ts'
import {
  alignPhaseCrossCorrelation,
  barkBandEnergiesDb,
  computeStft,
  detectBpmLocal,
  detectChordsViterbi,
  detectKeyLocal,
  detectPitchYin,
  detectTransients,
  fftRadix2,
  lissajousPoints,
  loudnessRangeLu,
  magnitudeSpectrumDb,
  pearsonPhaseCorrelation,
} from '../src/services/studio/dspMath.ts'
import { applyAutoMasterToSession } from '../src/services/studio/mastering.ts'
import { humanize } from '../src/services/studio/midiOps.ts'
import { optimizeBarkMixUnmasking } from '../src/services/studio/mixOptimizer.ts'
import { generateChordProgressionNotes, synthesizeClickGuideMono } from '../src/services/studio/productionTools.ts'
import { defaultTrack, parseSession, serializeSession, type StudioClip, type StudioMidiNote } from '../src/services/studio/session.ts'
import { setClipFades, setClipPhaseInvert, updateTrack } from '../src/services/studio/sessionOps.ts'
import { sessionToNewSong, songToStudioSeed, studioToSongPatch } from '../src/services/studio/songStudioBridge.ts'
import { mergeCollaborativeSession } from '../src/services/studio/studioCollab.ts'
import {
  commitStudioLocal,
  diffStudioSessions,
  emptyStudioVcsBundle,
  mergeStudioVcsIndices,
  resolveLocalCommitSession,
} from '../src/services/studio/studioVcs.ts'
import { classifyAudioRole, quantizeNotesToKey } from '../src/services/studio/trackClassifier.ts'
import {
  computeNormalizedClipGainDb,
  detectStripSilenceRegions,
  evaluateFadeCurve,
  reverseChannels,
  splitClipByStripSilence,
} from '../src/services/studio/waveOps.ts'

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

const SR = 48000

function synthTone(freqHz: number, durationS: number, harmonics: readonly [number, number][] = [[1, 0.8]]): Float32Array {
  const n = Math.round(durationS * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (const [mult, amp] of harmonics) {
      s += amp * Math.sin((2 * Math.PI * freqHz * mult * i) / SR)
    }
    out[i] = s
  }
  return out
}

console.log('1. DSP Matematico Local (FFT, STFT, Bark, YIN f0, GCC-PHAT)')

check('FFT / IFFT radix-2 es invertible (< 1e-9) y ubica picos exactos en 100 Hz, 1 kHz y 8 kHz', () => {
  const n = 2048
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  const orig = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    orig[i] = Math.sin((2 * Math.PI * 17 * i) / n) + 0.4 * Math.cos((2 * Math.PI * 131 * i) / n)
    re[i] = orig[i]
  }
  fftRadix2(re, im, false)
  fftRadix2(re, im, true)
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9)

  for (const hz of [100, 1000, 8000]) {
    const sig = synthTone(hz, 0.2, [[1, 0.9]])
    const spec = magnitudeSpectrumDb(sig, 4096)
    let maxBin = 0
    let maxDb = -999
    for (let k = 1; k < spec.length; k++) {
      if (spec[k] > maxDb) {
        maxDb = spec[k]
        maxBin = k
      }
    }
    const detectedHz = (maxBin * SR) / 4096
    assert.ok(Math.abs(detectedHz - hz) <= SR / 4096, `esperado ~${hz} Hz, obtenido ${detectedHz} Hz`)
  }

  const bark1k = barkBandEnergiesDb(synthTone(1000, 0.25), SR)
  assert.ok(bark1k[8] > bark1k[0] + 25, '1 kHz cae en la banda Bark 9 (indice 8)')
  const stft = computeStft(synthTone(1000, 0.2), SR, 1024, 512)
  assert.ok(stft.frames.length >= 10)
})

check('YIN f0 detecta La4 (440 Hz) y Mi2 (82.407 Hz) con error < 0.5 cents bajo armonicos', () => {
  const la4 = synthTone(440, 0.15, [[1, 0.6], [2, 0.25], [3, 0.1]])
  const resLa = detectPitchYin(la4, SR)
  assert.ok(resLa)
  assert.equal(resLa.noteName, 'A')
  assert.equal(resLa.octave, 4)
  assert.ok(Math.abs(resLa.cents) < 0.5, `error en La4: ${resLa.cents} cents (${resLa.hz} Hz)`)

  const mi2 = synthTone(82.40689, 0.25, [[1, 0.55], [2, 0.3], [3, 0.15]])
  const resMi = detectPitchYin(mi2, SR)
  assert.ok(resMi)
  assert.equal(resMi.noteName, 'E')
  assert.equal(resMi.octave, 2)
  assert.ok(Math.abs(resMi.cents) < 0.5, `error en Mi2: ${resMi.cents} cents (${resMi.hz} Hz)`)
})

check('GCC-PHAT R_xy(tau) recupera retardo exacto (+37 muestras) e inversion de polaridad (-1) con ruido', () => {
  const len = 16384
  const ref = new Float32Array(len)
  const tgt = new Float32Array(len)
  // Senal de pulsos banda ancha determinista + ruido.
  let s = 1234567
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296 - 0.5
  }
  for (let i = 200; i < len - 200; i++) {
    const env = Math.exp(-((i % 2400) / 180))
    ref[i] = rand() * env
  }
  const knownLag = 37
  for (let i = knownLag; i < len; i++) {
    tgt[i] = -ref[i - knownLag] + rand() * 0.02
  }
  const aligned = alignPhaseCrossCorrelation(ref, tgt, SR, 25)
  assert.equal(aligned.lagSamples, knownLag)
  assert.equal(aligned.polarity, -1)
  assert.ok(aligned.correlation > 0.9)
})

check('Deteccion musical local: BPM 120, Tonalidad Do Mayor, Acordes Viterbi (C - G - Am - F) y Transientes', () => {
  const click = synthesizeClickGuideMono({ bpm: 120, beatsPerBar: 4, bars: 6, sampleRate: SR })
  const bpmRes = detectBpmLocal(click.samples, SR)
  assert.ok(bpmRes)
  assert.ok(Math.abs(bpmRes.bpm - 120) <= 1, `BPM detectado: ${bpmRes.bpm}`)

  const onsets = detectTransients(click.samples, SR)
  assert.ok(onsets.length >= 16, `transientes detectados: ${onsets.length}`)

  // Construir secuencia sintetica de 4 acordes (2 s cada uno = 4 beats a 120 BPM): C -> G -> Am -> F
  const chordFreqs: Array<[string, number[]]> = [
    ['C', [261.63, 329.63, 392.0]],
    ['G', [196.0, 246.94, 293.66]],
    ['Am', [220.0, 261.63, 329.63]],
    ['F', [174.61, 220.0, 261.63]],
  ]
  const segLen = SR * 2
  const progAudio = new Float32Array(segLen * chordFreqs.length)
  chordFreqs.forEach(([, freqs], idx) => {
    for (let i = 0; i < segLen; i++) {
      let sample = 0
      for (const f of freqs) sample += 0.28 * Math.sin((2 * Math.PI * f * i) / SR)
      progAudio[idx * segLen + i] = sample
    }
  })

  const keyRes = detectKeyLocal(progAudio, SR)
  assert.ok(keyRes)
  assert.ok(keyRes.key === 'C' || keyRes.key === 'Am', `tonalidad relativa esperada C/Am, obtenida ${keyRes.key}`)

  const chords = detectChordsViterbi(progAudio, SR, 120, { stepBeats: 4 })
  assert.deepEqual(chords.map((c) => c.name), ['C', 'G', 'Am', 'F'])
})

check('Estereo y Dinamica: correlacion de Pearson (+1 mono, -1 contrafase), Lissajous y LRA', () => {
  const tone = synthTone(440, 2.0, [[1, 0.5]])
  const inv = tone.map((x) => -x)
  assert.ok(pearsonPhaseCorrelation(tone, tone) > 0.999)
  assert.ok(pearsonPhaseCorrelation(tone, inv) < -0.999)
  assert.ok(lissajousPoints(tone, inv, 64).length === 64)
  assert.ok(loudnessRangeLu([tone, tone], SR) >= 0)
})

console.log('\n2. Transformaciones de Onda y Humanizacion MIDI Avanzada')

check('waveOps: curvas de fade, normalizacion LUFS/Peak, Strip Silence con histeresis y reversa', () => {
  assert.equal(evaluateFadeCurve(0.5, 'linear'), 0.5)
  assert.ok(Math.abs(evaluateFadeCurve(0.5, 'scurve') - 0.5) < 1e-6)
  assert.ok(evaluateFadeCurve(0.25, 'exp') < 0.25)

  const quiet = synthTone(1000, 1.2, [[1, 0.1]])
  const norm = computeNormalizedClipGainDb([quiet, quiet], SR, { mode: 'lufs', targetDb: -14, ceilingDbTp: -1 })
  assert.ok(norm.gainDb > 3 && norm.gainDb <= 24)

  // Dos frases de voz separadas por 0.6 s de silencio.
  const phrase = new Float32Array(SR * 2)
  for (let i = Math.round(0.2 * SR); i < Math.round(0.6 * SR); i++) phrase[i] = 0.35 * Math.sin((2 * Math.PI * 300 * i) / SR)
  for (let i = Math.round(1.3 * SR); i < Math.round(1.8 * SR); i++) phrase[i] = 0.35 * Math.sin((2 * Math.PI * 400 * i) / SR)
  const regions = detectStripSilenceRegions([phrase], SR, { openThresholdDb: -25, closeThresholdDb: -35, minSilenceMs: 250 })
  assert.equal(regions.length, 2)

  const baseClip: StudioClip = {
    id: 'clp_test',
    assetId: 'ast_1',
    startS: 4,
    offsetS: 0,
    lengthS: 2,
    gainDb: 0,
    fadeInS: 0,
    fadeOutS: 0,
    takeGroup: null,
    active: true,
  }
  const splitClips = splitClipByStripSilence(baseClip, [phrase], SR, { openThresholdDb: -25, closeThresholdDb: -35, minSilenceMs: 250 })
  assert.equal(splitClips.length, 2)
  assert.equal(splitClips[0].fadeShape, 'scurve')

  const rev = reverseChannels([new Float32Array([1, 2, 3, 4])])[0]
  assert.deepEqual([...rev], [4, 3, 2, 1])
})

check('midiOps.humanize: swing en 1/16, micro-strum direccional en acordes y acento metrico', () => {
  const chordAndGroove: StudioMidiNote[] = [
    { pitch: 48, start: 0, length: 0.5, velocity: 80 },
    { pitch: 52, start: 0, length: 0.5, velocity: 80 },
    { pitch: 55, start: 0, length: 0.5, velocity: 80 },
    { pitch: 60, start: 0.25, length: 0.2, velocity: 80 }, // segunda semicorchea (impar)
  ]
  const strummed = humanize(
    chordAndGroove,
    null,
    { preset: 'strum', timingBeats: 0, velocityRange: 0, strumBeats: 0.04, swing: 0.3, swingGrid: '1/16', accentStrength: 0.6, seed: 42 },
    4,
  )
  const c0 = strummed.notes.find((n) => n.pitch === 48)!
  const c1 = strummed.notes.find((n) => n.pitch === 52)!
  const c2 = strummed.notes.find((n) => n.pitch === 55)!
  const off = strummed.notes.find((n) => n.pitch === 60)!
  assert.ok(c0.start < c1.start && c1.start < c2.start, 'strum grave a agudo progresivo')
  assert.ok(off.start > 0.28, `swing retraso la segunda semicorchea a ${off.start}`)
  assert.ok(c0.velocity > off.velocity, 'acento metrico refuerza tiempo 1 frente a subdivision debil')
})

check('session.ts round-trip conserva phaseInvert, fadeShape y analogDrift solo cuando difieren del default', () => {
  const base = parseSession(structuredClone(sessionFixtureV2))
  assert.deepEqual(serializeSession(base), sessionFixtureV2, 'identidad intacta en fixture v2')

  const audioClipId = base.tracks.find((t) => t.kind === 'audio')!.clips[0].id
  const withPhaseAndFade = setClipFades(setClipPhaseInvert(base, { clipId: audioClipId, phaseInvert: true }), {
    clipId: audioClipId,
    fadeShape: 'scurve',
  })
  const parsedAgain = parseSession(serializeSession(withPhaseAndFade))
  const reClip = parsedAgain.tracks.find((t) => t.kind === 'audio')!.clips[0]
  assert.equal(reClip.phaseInvert, true)
  assert.equal(reClip.fadeShape, 'scurve')
})

console.log('\n3. Investigacion de Operaciones, Metaheuristicas y Edge ML')

check('Simulated Annealing (setlistOptimizer): nunca empeora costo, respeta anclas fijas y reduce saltos Camelot/BPM', () => {
  const mk = (i: number, bpm: number, key: string, camelot: string): PlaylistSong => ({
    id: `ps_${i}`,
    songId: `s_${i}`,
    orderIndex: i,
    title: `Tema ${i + 1}`,
    artist: 'Banda',
    bpm,
    key,
    showKey: key,
    camelot,
    durationSec: 210,
    transitionMode: 'manual_cue',
    countInBars: 1,
    countInVoice: true,
    gapSec: 0,
  })
  const scrambled: PlaylistSong[] = [
    mk(0, 128, 'C', '8B'), // ancla apertura
    mk(1, 72, 'F#m', '11A'),
    mk(2, 165, 'Eb', '5B'),
    mk(3, 84, 'Bm', '10A'),
    mk(4, 130, 'G', '9B'),
    mk(5, 76, 'D', '10B'),
    mk(6, 126, 'Am', '8A'),
    mk(7, 142, 'E', '12B'), // ancla cierre
  ]
  const res = optimizeSetlistOrder(scrambled, { profile: 'continuous_camelot', pinnedIndices: [0, 7], seed: 99 })
  assert.ok(res.after.totalCost <= res.before.totalCost, `${res.after.totalCost} <= ${res.before.totalCost}`)
  assert.ok(res.after.camelotCost < res.before.camelotCost, 'mejoro fluidez Camelot')
  assert.equal(res.songs[0].id, 'ps_0', 'apertura anclada intacta')
  assert.equal(res.songs[7].id, 'ps_7', 'cierre anclado intacto')
})

check('Bark Unmasking (mixOptimizer) + Auto-Master + Click/Progresiones + Clasificador Espectral', () => {
  let s = parseSession(structuredClone(sessionFixtureV2))
  const g1 = defaultTrack({ id: 'trk_g1', name: 'Guitarra 1', role: 'guitar' })
  const g2 = defaultTrack({ id: 'trk_g2', name: 'Teclado 2', role: 'keys' })
  s = { ...s, tracks: [s.tracks[0], g1, g2] }
  const unmask = optimizeBarkMixUnmasking(s, [], { strength: 0.85 })
  assert.ok(unmask.afterTotalCollision < unmask.beforeTotalCollision, 'reduccion estricta de colision Bark')
  assert.ok(unmask.actions.length >= 2)

  const mastered = applyAutoMasterToSession(s, { profile: 'live_stage', tone: 'open', measuredLufs: -18 })
  assert.equal(mastered.session.master.fx.length, 5)
  assert.equal(mastered.session.master.fx[4].type, 'limiter')

  const prog = generateChordProgressionNotes({ preset: 'pop_1564', voicing: 'sevenths', key: 'G', bars: 4 })
  assert.ok(prog.notes.length >= 16)
  const qNotes = quantizeNotesToKey([{ pitch: 61, start: 0, length: 1, velocity: 90 }], 'C', 4)
  assert.ok(qNotes[0].pitch === 60 || qNotes[0].pitch === 62)

  const subBass = synthTone(65, 0.5, [[1, 0.9]])
  assert.equal(classifyAudioRole('Audio_01.wav', subBass, SR).role, 'bass')
})

console.log('\n4. Control de Versiones Musical, Colaboracion 3-Way y Puente Cancion-Estudio')

check('Studio VCS + Ecosystem VCS: ramas, commits, resolucion A/B y diffs musicales', () => {
  const s1 = parseSession(structuredClone(sessionFixtureV2))
  const c1 = commitStudioLocal({ bundle: emptyStudioVcsBundle('main'), session: s1, message: 'Mezcla base', authorName: 'Daniel', commitId: 'cmt_1' })
  const s2 = updateTrack({ ...s1, bpm: 132 }, { trackId: s1.tracks[0].id, patch: { volumeDb: -2.5 } })
  const c2 = commitStudioLocal({ bundle: c1.bundle, session: s2, branch: 'vivo', message: 'Ajuste show vivo', authorName: 'Ana', commitId: 'cmt_2' })

  assert.equal(c2.bundle.activeBranch, 'vivo')
  assert.equal(c2.bundle.index.branches.main, 'cmt_1')
  assert.equal(c2.bundle.index.branches.vivo, 'cmt_2')
  assert.equal(resolveLocalCommitSession(c2.bundle, 'cmt_1')?.bpm, s1.bpm)

  const mergedIdx = mergeStudioVcsIndices(c1.bundle.index, c2.bundle.index)
  assert.equal(mergedIdx.commits.length, 2)

  const diff = diffStudioSessions(s1, s2)
  assert.equal(diff.changed, true)
  assert.equal(diff.bpmDelta, 132 - s1.bpm)
  assert.ok(diff.tracks.length >= 1)

  const songA: Song = {
    id: 'song_1',
    title: 'Fuego Norte',
    artist: 'Bandait',
    bpm: 120,
    beatsPerBar: 4,
    beatUnit: 4,
    key: 'Am',
    sections: [{ id: 'sec_1', kind: 'verse', label: 'Estrofa 1', bars: 8, chordpro: '[Am]Luz [F]en el [C]mar [G]' }],
    updatedAt: '2026-11-26T00:00:00.000Z',
  }
  const songB: Song = { ...songA, bpm: 126, key: 'Bm' }
  const h1 = commitEntitySnapshot({ history: undefined, snapshot: songA, message: 'Original', authorName: 'Director' })
  const h2 = createEntityBranch(h1.history, 'acustico', songB, 'Director')
  assert.equal(branchHeadSnapshot(h2, 'acustico')?.key, 'Bm')
  assert.equal(diffSongs(songA, songB).changed, true)

  const plA: Playlist = { id: 'pl_1', bandId: 'b_1', name: 'Show Viernes', songs: [], createdAt: '', updatedAt: '' }
  const plB: Playlist = { ...plA, name: 'Show Sabado' }
  assert.equal(diffPlaylists(plA, plB).changed, true)
})

check('mergeCollaborativeSession (3-way) y songStudioBridge (bidireccional + promocion a Song)', () => {
  const base = parseSession(structuredClone(sessionFixtureV2))
  const trackA = base.tracks[0].id
  const trackB = base.tracks[1].id
  const local = updateTrack(base, { trackId: trackA, patch: { volumeDb: -4.5, pan: -0.35 } })
  const remote = updateTrack({ ...base, bpm: 128 }, { trackId: trackB, patch: { volumeDb: -1.5, pan: 0.4 } })
  const merged = mergeCollaborativeSession(base, local, remote)

  assert.equal(merged.bpm, 128, 'tomo el cambio remoto de BPM')
  assert.equal(merged.tracks.find((t) => t.id === trackA)?.pan, -0.35, 'conservo edicion local en pista A')
  assert.equal(merged.tracks.find((t) => t.id === trackB)?.pan, 0.4, 'conservo edicion remota en pista B')

  const song: Song = {
    id: 'song_bridge',
    title: 'Horizonte',
    artist: 'Bandait',
    bpm: 110,
    beatsPerBar: 4,
    beatUnit: 4,
    key: 'G',
    sections: [
      { id: 'sec_i', kind: 'intro', label: 'Intro', bars: 4, chordpro: '[G] [D] [Em] [C]' },
      { id: 'sec_c', kind: 'chorus', label: 'Coro', bars: 8, chordpro: '[C]Canta [G]fuerte [D]hoy' },
    ],
    updatedAt: '2026-11-26T00:00:00.000Z',
  }
  const seed = songToStudioSeed(song)
  assert.equal(seed.markers.length, 2)
  assert.equal(seed.markers[0].beat, 0)
  assert.equal(seed.markers[1].beat, 16)
  assert.ok(seed.chords.length >= 4)

  const modifiedSession = { ...base, songId: song.id, bpm: 116, key: 'A', markers: seed.markers, chords: seed.chords }
  const preview = studioToSongPatch(song, modifiedSession)
  assert.equal(preview.updatedSong.bpm, 116)
  assert.equal(preview.updatedSong.key, 'A')
  assert.ok(preview.updatedSong.sections[1].chordpro.includes('Canta'), 'nunca destruye la letra vocal')
  assert.equal(preview.diff.changed, true)

  const promoted = sessionToNewSong({ ...modifiedSession, songId: null, title: 'Maqueta Nueva' })
  assert.equal(promoted.title, 'Maqueta Nueva')
  assert.equal(promoted.sections.length, 2)
})

console.log(`\n${passed} ok, ${failures.length} fallas`)
if (failures.length > 0) process.exit(1)
