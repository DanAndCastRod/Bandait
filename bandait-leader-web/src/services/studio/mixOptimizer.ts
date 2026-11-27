/**
 * Optimizador Matematico Anti-Enmascaramiento Espectral en 24 Bandas Bark (Cero Cuota IA).
 *
 * Calcula la matriz simetrica de colision psicoacustica M_ij entre las pistas audibles y resuelve
 * por descenso coordenado acotado (Bounded Coordinate Descent) los ajustes optimos de:
 *   1. Paneo estereo complementario (separando guitarras/teclas/coros sin descentrar voz principal,
 *      bombo ni bajo).
 *   2. Pasa-altos (`hpfHz`) en pistas no graves, SOLO si su espectro medido tiene energia
 *      apreciable bajo el corte (sin muestras medidas no se pone a ciegas).
 *   3. Recortes quirurgicos de `EQ` parametrico (`midHz`, `midDb`, `midQ`) sobre la banda Bark de
 *      mayor solapamiento, respetando jerarquia de roles (`vocals` > `bass`/`drums` > acompanamiento).
 *
 * La "reduccion" que informa es una ESTIMACION del propio modelo de colision (espectro Bark de
 * cada pista x respuesta exacta de su EQ x solapamiento de paneo), no una medicion de la mezcla
 * resultante: la interfaz la presenta como estimada. Nunca agrega un EQ a una cadena llena (el
 * maximo de efectos por pista del contrato), asi la sesion sigue siendo valida al guardar.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import { dbToGain } from '../stemTiming.ts'
import type { StemRole } from '../stemNames.ts'
import { BARK_BAND_EDGES_HZ, barkBandPowers } from './dspMath.ts'
import { eqPowerGainAt } from './fx.ts'
import { trackAudible } from './graph.ts'
import { defaultFx, type EqParams, type StudioFx, type StudioSession, type StudioTrack } from './session.ts'

/** Efectos que admite una pista en `version: 2` (STUDIO_V2.md 7.3; el Hub siempre escribe v2). */
export const TRACK_MAX_FX = 5

/** Fraccion minima de energia bajo el corte para que valga la pena un pasa altos. */
const HPF_MIN_LOW_ENERGY = 0.02

export interface TrackSpectralInput {
  trackId: string
  /** Muestras mono o estereo representativas de la pista (opcional; si falta se estima por rol). */
  samples?: Float32Array | null
  sampleRate?: number
}

export interface MixCollisionPair {
  trackAId: string
  trackAName: string
  trackBId: string
  trackBName: string
  dominantBarkBand: number
  dominantHz: number
  beforeScore: number
  afterScore: number
}

export interface MixUnmaskAction {
  trackId: string
  trackName: string
  summary: string
}

export interface MixUnmaskResult {
  session: StudioSession
  actions: MixUnmaskAction[]
  beforeTotalCollision: number
  afterTotalCollision: number
  reductionPct: number
  /** Matriz NxN de colisiones antes de optimizar (para vista termica LAB). */
  matrixBefore: number[][]
  /** Matriz NxN de colisiones despues de optimizar. */
  matrixAfter: number[][]
  trackLabels: string[]
  topPairs: MixCollisionPair[]
}

const ROLE_PRIORITY: Readonly<Record<StemRole, number>> = {
  vocals: 10,
  drums: 8,
  bass: 8,
  backing_vocals: 6,
  guitar: 5,
  keys: 5,
  strings: 4,
  wind: 5,
  instrumental: 4,
  other: 4,
  guide: 2,
  click: 1,
  unknown: 4,
}

function rolePriority(role: StemRole): number {
  return ROLE_PRIORITY[role] ?? 4
}

function isCenterAnchoredRole(role: StemRole, name: string | undefined): boolean {
  if (role === 'vocals' || role === 'bass' || role === 'drums' || role === 'click' || role === 'guide') return true
  const lower = (name ?? '').toLowerCase()
  return /\b(kick|bombo|bass|bajo|voz|lead vocal)\b/.test(lower)
}

function isLowEndRole(role: StemRole, name: string | undefined): boolean {
  if (role === 'bass' || role === 'drums') return true
  return /\b(kick|bombo|bass|bajo|sub|808)\b/i.test(name ?? '')
}

/** Perfil Bark sintetico de respaldo cuando una pista (p. ej. MIDI sin congelar) no pasa muestras PCM. */
function fallbackBarkProfileForRole(role: StemRole): Float64Array {
  const p = new Float64Array(24)
  const fillRange = (from: number, to: number, val: number) => {
    for (let b = from; b <= to && b < 24; b++) p[b] = val
  }
  switch (role) {
    case 'bass':
      fillRange(0, 3, 0.9)
      fillRange(4, 7, 0.3)
      break
    case 'drums':
      fillRange(0, 2, 0.85)
      fillRange(8, 14, 0.45)
      fillRange(18, 22, 0.5)
      break
    case 'vocals':
    case 'backing_vocals':
      fillRange(3, 16, 0.85)
      fillRange(17, 20, 0.35)
      break
    case 'guitar':
    case 'keys':
    case 'strings':
    case 'wind':
    default:
      fillRange(2, 15, 0.75)
      fillRange(16, 19, 0.25)
      break
  }
  return p
}

function barkCenterHz(band: number): number {
  const hi = BARK_BAND_EDGES_HZ[Math.max(0, Math.min(23, band))]
  const lo = band > 0 ? BARK_BAND_EDGES_HZ[band - 1] : 20
  return Math.round(Math.sqrt(lo * hi))
}

/** Ganancia de potencia del EQ en `hz`: la respuesta exacta de los mismos biquads que suenan. */
function eqPowerGain(eq: EqParams, hz: number, sampleRate: number): number {
  return eqPowerGainAt(eq, hz, sampleRate)
}

/** Solapamiento espacial estereo entre dos posiciones de paneo [-1..1]: 1 en mismo punto, ~0.15 opuestos. */
function stereoOverlapFactor(panA: number, panB: number): number {
  const dist = Math.min(2, Math.abs(panA - panB))
  return 1 - 0.425 * dist
}

function getOrBuildTrackEq(fxChain: readonly StudioFx[]): EqParams {
  const found = fxChain.find((fx) => fx.type === 'eq' && !fx.bypass)
  if (found && found.type === 'eq') return { ...found.params }
  return { ...defaultFx('eq').params }
}

function replaceOrInsertEq(fxChain: readonly StudioFx[], eqParams: EqParams): StudioFx[] {
  const idx = fxChain.findIndex((fx) => fx.type === 'eq')
  const eqFx: StudioFx = { type: 'eq', bypass: false, params: eqParams }
  if (idx >= 0) {
    const copy = fxChain.slice()
    copy[idx] = eqFx
    return copy
  }
  return [eqFx, ...fxChain]
}

function computeCollisionPairScore(
  barkA: Float64Array,
  eqA: EqParams,
  volDbA: number,
  panA: number,
  barkB: Float64Array,
  eqB: EqParams,
  volDbB: number,
  panB: number,
  sampleRate: number,
): { total: number; dominantBand: number } {
  const spatial = stereoOverlapFactor(panA, panB)
  const gA = Math.pow(dbToGain(volDbA), 2)
  const gB = Math.pow(dbToGain(volDbB), 2)
  let total = 0
  let maxBandVal = -1
  let dominantBand = 8

  for (let b = 0; b < 24; b++) {
    const hz = barkCenterHz(b)
    const eA = barkA[b] * gA * eqPowerGain(eqA, hz, sampleRate)
    const eB = barkB[b] * gB * eqPowerGain(eqB, hz, sampleRate)
    // Peso perceptual mayor en zona vocal/presencia (300..4000 Hz, Bark 3..17) y subgrave (Bark 0..2).
    const perceptualWeight = b <= 2 ? 1.25 : b >= 3 && b <= 17 ? 1.35 : 0.75
    const overlap = Math.sqrt(Math.max(0, eA * eB)) * spatial * perceptualWeight
    total += overlap
    if (overlap > maxBandVal) {
      maxBandVal = overlap
      dominantBand = b
    }
  }
  return { total, dominantBand }
}

export function optimizeBarkMixUnmasking(
  session: StudioSession,
  inputs: readonly TrackSpectralInput[] = [],
  options: { strength?: number } = {},
): MixUnmaskResult {
  const strength = Math.max(0.1, Math.min(1, options.strength ?? 0.75))
  const anySolo = session.tracks.some((t) => t.solo)
  const activeTracks = session.tracks.filter(
    (t) => trackAudible(t, anySolo) && t.role !== 'click' && t.role !== 'guide',
  )
  const n = activeTracks.length
  if (n < 2) {
    return {
      session,
      actions: [],
      beforeTotalCollision: 0,
      afterTotalCollision: 0,
      reductionPct: 0,
      matrixBefore: [],
      matrixAfter: [],
      trackLabels: activeTracks.map((t) => t.name),
      topPairs: [],
    }
  }

  const inputById = new Map(inputs.map((inp) => [inp.trackId, inp]))
  const sampleRate = session.sampleRate > 0 ? session.sampleRate : 48000
  // true si el perfil de la pista salio de sus muestras (no del perfil de respaldo por rol).
  const measured: boolean[] = []
  const baseBark = activeTracks.map((t) => {
    const inp = inputById.get(t.id)
    if (inp?.samples && inp.samples.length > 0 && (inp.sampleRate ?? 0) > 0) {
      const raw = barkBandPowers(inp.samples, inp.sampleRate!)
      let sum = 0
      for (let b = 0; b < 24; b++) sum += raw[b]
      if (sum > 1e-12) {
        const norm = new Float64Array(24)
        for (let b = 0; b < 24; b++) norm[b] = raw[b] / sum
        measured.push(true)
        return norm
      }
    }
    measured.push(false)
    return fallbackBarkProfileForRole(t.role)
  })
  // Una pista sin EQ y con la cadena llena no puede recibir uno: solo se le cambia el paneo.
  const canEq = activeTracks.map((t) => t.fx.some((fx) => fx.type === 'eq') || t.fx.length < TRACK_MAX_FX)

  const pans = activeTracks.map((t) => t.pan)
  const vols = activeTracks.map((t) => t.volumeDb)
  const eqs = activeTracks.map((t) => getOrBuildTrackEq(t.fx))

  const evalMatrix = () => {
    const mat = Array.from({ length: n }, () => Array<number>(n).fill(0))
    const dom = Array.from({ length: n }, () => Array<number>(n).fill(8))
    let sum = 0
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const { total, dominantBand } = computeCollisionPairScore(
          baseBark[i],
          eqs[i],
          vols[i],
          pans[i],
          baseBark[j],
          eqs[j],
          vols[j],
          pans[j],
          sampleRate,
        )
        mat[i][j] = Math.round(total * 1000) / 1000
        mat[j][i] = mat[i][j]
        dom[i][j] = dominantBand
        dom[j][i] = dominantBand
        sum += total
      }
    }
    return { mat, dom, sum }
  }

  const initial = evalMatrix()
  const actions: MixUnmaskAction[] = []

  // Paso 1: Limpieza de subgraves (HPF) en pistas que no son bombo/bajo, solo si su espectro
  // MEDIDO tiene energia bajo el corte (sin muestras no hay evidencia: no se pone a ciegas).
  for (let i = 0; i < n; i++) {
    const t = activeTracks[i]
    if (!canEq[i] || !measured[i] || isLowEndRole(t.role, t.name) || eqs[i].hpfHz >= 75) continue
    const targetHpf = t.role === 'vocals' || t.role === 'backing_vocals' ? Math.round(80 + 20 * strength) : Math.round(90 + 30 * strength)
    let lowShare = 0
    for (let b = 0; b < 24; b++) if (barkCenterHz(b) < targetHpf) lowShare += baseBark[i][b]
    if (lowShare >= HPF_MIN_LOW_ENERGY) eqs[i].hpfHz = targetHpf
  }

  // Paso 2: Separacion estereo complementaria en pistas no ancladas al centro que chocan entre si.
  const panCandidates = activeTracks
    .map((t, idx) => ({ t, idx }))
    .filter(({ t }) => !isCenterAnchoredRole(t.role, t.name))

  if (panCandidates.length >= 2) {
    let sideSign = -1
    for (const { idx } of panCandidates) {
      if (Math.abs(pans[idx]) < 0.18) {
        pans[idx] = Math.round(sideSign * (0.28 + 0.22 * strength) * 100) / 100
        sideSign *= -1
      }
    }
  }

  // Paso 3: Descenso coordenado quirurgico sobre los pares de mayor colision espectral.
  const currentAfterPan = evalMatrix()
  const pairs: Array<{ i: number; j: number; score: number; band: number }> = []
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      pairs.push({ i, j, score: currentAfterPan.mat[i][j], band: currentAfterPan.dom[i][j] })
    }
  }
  pairs.sort((a, b) => b.score - a.score)

  const carvedTracks = new Set<number>()
  for (const pair of pairs) {
    if (pair.score <= 0.01) break
    const prioI = rolePriority(activeTracks[pair.i].role)
    const prioJ = rolePriority(activeTracks[pair.j].role)
    // La pista de menor prioridad cede espacio mediante un recorte EQ quirurgico (Q medio-alto).
    const yieldIdx = prioI >= prioJ ? pair.j : pair.i
    const domIdx = yieldIdx === pair.i ? pair.j : pair.i
    if (carvedTracks.has(yieldIdx) || !canEq[yieldIdx]) continue

    let targetHz = Math.max(200, Math.min(8000, barkCenterHz(pair.band)))
    // Caso clasico Kick vs Bass: tallar al bajo en ~90..220 Hz y dar aire de definicion.
    if (
      (activeTracks[pair.i].role === 'drums' && activeTracks[pair.j].role === 'bass') ||
      (activeTracks[pair.j].role === 'drums' && activeTracks[pair.i].role === 'bass')
    ) {
      const bassIdx = activeTracks[pair.i].role === 'bass' ? pair.i : pair.j
      if (!carvedTracks.has(bassIdx) && canEq[bassIdx]) {
        eqs[bassIdx].midHz = 210
        eqs[bassIdx].midDb = Math.round(-3.2 * strength * 10) / 10
        eqs[bassIdx].midQ = 2.4
        carvedTracks.add(bassIdx)
        continue
      }
    }

    if (activeTracks[domIdx].role === 'vocals' && targetHz < 800) {
      targetHz = Math.max(targetHz, 1200)
    }
    const cutDb = Math.round(-(2.2 + 2.8 * strength) * 10) / 10
    eqs[yieldIdx].midHz = targetHz
    eqs[yieldIdx].midDb = cutDb
    eqs[yieldIdx].midQ = 2.2
    carvedTracks.add(yieldIdx)
  }

  const finalEval = evalMatrix()

  // Construir pistas actualizadas y resumen de acciones legibles.
  const updatedById = new Map<string, StudioTrack>()
  for (let i = 0; i < n; i++) {
    const orig = activeTracks[i]
    const origEq = getOrBuildTrackEq(orig.fx)
    const eqChanged =
      origEq.hpfHz !== eqs[i].hpfHz ||
      origEq.midHz !== eqs[i].midHz ||
      origEq.midDb !== eqs[i].midDb ||
      origEq.midQ !== eqs[i].midQ
    const panChanged = Math.abs(orig.pan - pans[i]) >= 0.01

    if (!eqChanged && !panChanged) continue
    const notes: string[] = []
    if (panChanged) {
      notes.push(`paneo ${pans[i] < 0 ? `${Math.round(Math.abs(pans[i]) * 100)}% L` : `${Math.round(pans[i] * 100)}% R`}`)
    }
    if (origEq.hpfHz !== eqs[i].hpfHz && eqs[i].hpfHz > 0) {
      notes.push(`HPF ${eqs[i].hpfHz} Hz`)
    }
    if (origEq.midDb !== eqs[i].midDb) {
      notes.push(`corte ${eqs[i].midDb} dB @ ${eqs[i].midHz} Hz`)
    }
    actions.push({
      trackId: orig.id,
      trackName: orig.name,
      summary: notes.join(' · '),
    })

    updatedById.set(orig.id, {
      ...orig,
      pan: pans[i],
      fx: eqChanged ? replaceOrInsertEq(orig.fx, eqs[i]) : orig.fx,
    })
  }

  const nextTracks = session.tracks.map((t) => updatedById.get(t.id) ?? t)
  const topPairs: MixCollisionPair[] = pairs.slice(0, 5).map((p) => ({
    trackAId: activeTracks[p.i].id,
    trackAName: activeTracks[p.i].name,
    trackBId: activeTracks[p.j].id,
    trackBName: activeTracks[p.j].name,
    dominantBarkBand: p.band + 1,
    dominantHz: barkCenterHz(p.band),
    beforeScore: initial.mat[p.i][p.j],
    afterScore: finalEval.mat[p.i][p.j],
  }))

  const reductionPct =
    initial.sum > 1e-6
      ? Math.max(0, Math.round(((initial.sum - finalEval.sum) / initial.sum) * 1000) / 10)
      : 0

  return {
    session: updatedById.size > 0 ? { ...session, tracks: nextTracks } : session,
    actions,
    beforeTotalCollision: Math.round(initial.sum * 1000) / 1000,
    afterTotalCollision: Math.round(finalEval.sum * 1000) / 1000,
    reductionPct,
    matrixBefore: initial.mat,
    matrixAfter: finalEval.mat,
    trackLabels: activeTracks.map((t) => t.name),
    topPairs,
  }
}
