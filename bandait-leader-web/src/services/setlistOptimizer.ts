/**
 * Optimizador Combinatorio de Setlists (Investigacion de Operaciones / Metaheuristicas).
 *
 * Modela el orden de un show en vivo como un problema de optimizacion combinatoria multi-objetivo
 * con restricciones duras de posicion fija (`pinnedIndices`), resuelto en < 30 ms en el cliente
 * mediante **Simulated Annealing + busqueda local 2-opt** con semilla determinista:
 *
 *   min_pi  w_cam * Sum d_Camelot(pi_i, pi_{i+1})
 *         + w_bpm * Sum Delta_BPM(pi_i, pi_{i+1})
 *         + w_arc * Sum (E(pi_i) - E_target(i / (N - 1)))^2
 *         + w_fat * P_vocal(pi)
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import type { PlaylistSong } from '../types/hub.ts'

export type SetlistEnergyProfile = 'standard_show' | 'in_crescendo' | 'continuous_camelot' | 'smooth_bpm'

export interface SetlistProfileSpec {
  id: SetlistEnergyProfile
  label: string
  description: string
  weights: { camelot: number; bpm: number; arc: number; fatigue: number }
}

export const SETLIST_OPTIMIZER_PROFILES: Readonly<Record<SetlistEnergyProfile, SetlistProfileSpec>> = {
  standard_show: {
    id: 'standard_show',
    label: 'Concierto Estándar',
    description: 'Apertura enérgica, respiro emocional a mitad del show y clímax ascendente al cierre.',
    weights: { camelot: 1.0, bpm: 0.9, arc: 1.4, fatigue: 1.0 },
  },
  in_crescendo: {
    id: 'in_crescendo',
    label: 'In Crescendo',
    description: 'Construcción progresiva de energía y tempo desde el inicio hasta el cierre.',
    weights: { camelot: 0.9, bpm: 1.1, arc: 1.6, fatigue: 0.8 },
  },
  continuous_camelot: {
    id: 'continuous_camelot',
    label: 'Fluidez Armónica (Camelot)',
    description: 'Minimiza choques armónicos entre temas consecutivos para transiciones gapless.',
    weights: { camelot: 2.2, bpm: 1.1, arc: 0.6, fatigue: 0.8 },
  },
  smooth_bpm: {
    id: 'smooth_bpm',
    label: 'Transición Suave de Tempo',
    description: 'Evita saltos bruscos de BPM entre canciones consecutivas.',
    weights: { camelot: 0.9, bpm: 2.2, arc: 0.7, fatigue: 0.9 },
  },
}

const KEY_TO_CAMELOT: Readonly<Record<string, { num: number; letter: 'A' | 'B'; pitchClass: number }>> = {
  Abm: { num: 1, letter: 'A', pitchClass: 8 },
  'G#m': { num: 1, letter: 'A', pitchClass: 8 },
  B: { num: 1, letter: 'B', pitchClass: 11 },
  Ebm: { num: 2, letter: 'A', pitchClass: 3 },
  'D#m': { num: 2, letter: 'A', pitchClass: 3 },
  'F#': { num: 2, letter: 'B', pitchClass: 6 },
  Gb: { num: 2, letter: 'B', pitchClass: 6 },
  Bbm: { num: 3, letter: 'A', pitchClass: 10 },
  'A#m': { num: 3, letter: 'A', pitchClass: 10 },
  Db: { num: 3, letter: 'B', pitchClass: 1 },
  'C#': { num: 3, letter: 'B', pitchClass: 1 },
  Fm: { num: 4, letter: 'A', pitchClass: 5 },
  Ab: { num: 4, letter: 'B', pitchClass: 8 },
  'G#': { num: 4, letter: 'B', pitchClass: 8 },
  Cm: { num: 5, letter: 'A', pitchClass: 0 },
  Eb: { num: 5, letter: 'B', pitchClass: 3 },
  'D#': { num: 5, letter: 'B', pitchClass: 3 },
  Gm: { num: 6, letter: 'A', pitchClass: 7 },
  Bb: { num: 6, letter: 'B', pitchClass: 10 },
  'A#': { num: 6, letter: 'B', pitchClass: 10 },
  Dm: { num: 7, letter: 'A', pitchClass: 2 },
  F: { num: 7, letter: 'B', pitchClass: 5 },
  Am: { num: 8, letter: 'A', pitchClass: 9 },
  C: { num: 8, letter: 'B', pitchClass: 0 },
  Em: { num: 9, letter: 'A', pitchClass: 4 },
  G: { num: 9, letter: 'B', pitchClass: 7 },
  Bm: { num: 10, letter: 'A', pitchClass: 11 },
  D: { num: 10, letter: 'B', pitchClass: 2 },
  'F#m': { num: 11, letter: 'A', pitchClass: 6 },
  Gbm: { num: 11, letter: 'A', pitchClass: 6 },
  A: { num: 11, letter: 'B', pitchClass: 9 },
  'C#m': { num: 12, letter: 'A', pitchClass: 1 },
  Dbm: { num: 12, letter: 'A', pitchClass: 1 },
  E: { num: 12, letter: 'B', pitchClass: 4 },
}

export function parseCamelotOrKey(camelot?: string, key?: string): { num: number; letter: 'A' | 'B'; highKey: boolean } | null {
  if (camelot) {
    const m = /^(\d{1,2})([ABab])$/.exec(camelot.trim())
    if (m) {
      const n = Number(m[1])
      if (n >= 1 && n <= 12) {
        return { num: n, letter: m[2].toUpperCase() as 'A' | 'B', highKey: n === 10 || n === 11 || n === 12 || n === 2 }
      }
    }
  }
  if (key) {
    const clean = key.trim().replace(/♯/g, '#').replace(/♭/g, 'b')
    const hit = KEY_TO_CAMELOT[clean]
    if (hit) {
      // Tonalidades tipicamente exigentes en tesitura vocal pop/rock (D, Eb, E, A, Bb, B).
      const highKey = [2, 3, 4, 9, 10, 11].includes(hit.pitchClass)
      return { num: hit.num, letter: hit.letter, highKey }
    }
  }
  return null
}

/** Distancia armonica normalizada [0..1] en la rueda de Camelot (0 = compatible perfecto). */
export function camelotDistance(a: PlaylistSong, b: PlaylistSong): number {
  const ca = parseCamelotOrKey(a.camelot, a.showKey || a.key)
  const cb = parseCamelotOrKey(b.camelot, b.showKey || b.key)
  if (!ca || !cb) return 0.25
  const wheelDiff = Math.min(Math.abs(ca.num - cb.num), 12 - Math.abs(ca.num - cb.num))
  const modeDiff = ca.letter === cb.letter ? 0 : 1
  if (wheelDiff === 0 && modeDiff === 0) return 0
  if ((wheelDiff === 1 && modeDiff === 0) || (wheelDiff === 0 && modeDiff === 1)) return 0.08
  return Math.min(1, (wheelDiff + modeDiff * 0.6) / 6)
}

/** Energia estimada [0..1] de un tema a partir de su BPM, modo mayor/menor y tipo de entrada. */
export function estimateSongEnergy(item: PlaylistSong): number {
  const bpmNorm = Math.max(0, Math.min(1, (item.bpm - 65) / 110))
  const cam = parseCamelotOrKey(item.camelot, item.showKey || item.key)
  const modeBoost = cam?.letter === 'B' ? 0.06 : 0
  const gaplessBoost = item.transitionMode === 'gapless' ? 0.05 : 0
  return Math.max(0.05, Math.min(1, bpmNorm * 0.88 + modeBoost + gaplessBoost))
}

/** Curva objetivo de energia [0..1] segun la posicion normalizada `t` en [0, 1]. */
export function targetArcEnergy(t: number, profile: SetlistEnergyProfile): number {
  const x = Math.max(0, Math.min(1, t))
  if (profile === 'in_crescendo') return 0.25 + 0.7 * Math.pow(x, 1.15)
  if (profile === 'standard_show') {
    // Apertura alta (~0.75), valle intimo hacia t=0.45 (~0.38), climax final en t=0.9..1.0 (~0.92).
    if (x < 0.2) return 0.76 - 0.3 * (x / 0.2)
    if (x < 0.5) return 0.46 - 0.1 * Math.sin(((x - 0.2) / 0.3) * Math.PI)
    return 0.46 + 0.48 * Math.pow((x - 0.5) / 0.5, 0.85)
  }
  return 0.55 + 0.2 * x
}

export interface SetlistCostBreakdown {
  totalCost: number
  camelotCost: number
  bpmCost: number
  arcCost: number
  fatigueCost: number
}

export function evaluateSetlistOrder(
  songs: readonly PlaylistSong[],
  order: readonly number[],
  profile: SetlistEnergyProfile,
): SetlistCostBreakdown {
  const n = order.length
  if (n <= 1) return { totalCost: 0, camelotCost: 0, bpmCost: 0, arcCost: 0, fatigueCost: 0 }
  const weights = (SETLIST_OPTIMIZER_PROFILES[profile] ?? SETLIST_OPTIMIZER_PROFILES.standard_show).weights

  let camelotSum = 0
  let bpmSum = 0
  let arcSum = 0
  let fatigueSum = 0
  let highStreak = 0

  for (let i = 0; i < n; i++) {
    const curr = songs[order[i]]
    const e = estimateSongEnergy(curr)
    const target = targetArcEnergy(n > 1 ? i / (n - 1) : 0, profile)
    const diffE = e - target
    arcSum += diffE * diffE

    const cam = parseCamelotOrKey(curr.camelot, curr.showKey || curr.key)
    const demanding = e > 0.72 || cam?.highKey === true
    if (demanding) {
      highStreak++
      if (highStreak >= 3) fatigueSum += 0.35 * (highStreak - 2)
    } else {
      highStreak = 0
    }

    if (i + 1 < n) {
      const next = songs[order[i + 1]]
      camelotSum += camelotDistance(curr, next)
      // Considerar compatibilidad mitad/doble tempo (ej. 70 <-> 140 BPM).
      const directBpm = Math.abs(curr.bpm - next.bpm)
      const halfDouble = Math.min(Math.abs(curr.bpm * 2 - next.bpm), Math.abs(curr.bpm - next.bpm * 2))
      const effDelta = Math.min(directBpm, halfDouble + 8)
      bpmSum += Math.min(1.5, Math.pow(effDelta / 32, 1.4))
    }
  }

  const camelotCost = camelotSum / (n - 1)
  const bpmCost = bpmSum / (n - 1)
  const arcCost = arcSum / n
  const fatigueCost = fatigueSum / n
  const totalCost =
    weights.camelot * camelotCost +
    weights.bpm * bpmCost +
    weights.arc * arcCost +
    weights.fatigue * fatigueCost

  return {
    totalCost: Math.round(totalCost * 10000) / 10000,
    camelotCost: Math.round(camelotCost * 10000) / 10000,
    bpmCost: Math.round(bpmCost * 10000) / 10000,
    arcCost: Math.round(arcCost * 10000) / 10000,
    fatigueCost: Math.round(fatigueCost * 10000) / 10000,
  }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface OptimizeSetlistOptions {
  profile: SetlistEnergyProfile
  /** Indices (0-based) cuyas canciones quedan fijas en esa posicion exacta (ej. apertura 0 y cierre N-1). */
  pinnedIndices?: ReadonlySet<number> | readonly number[]
  iterations?: number
  seed?: number
}

export interface SetlistOptimizationResult {
  songs: PlaylistSong[]
  order: number[]
  before: SetlistCostBreakdown
  after: SetlistCostBreakdown
  improvementPct: number
  energyBefore: number[]
  energyAfter: number[]
  targetCurve: number[]
  costHistory: number[]
}

/**
 * Ejecuta Simulated Annealing + pulido local 2-opt sobre las posiciones libres del setlist.
 * Garantiza matematicamente que el resultado nunca empeora el costo inicial (`after.totalCost <= before.totalCost`).
 */
export function optimizeSetlistOrder(
  songs: readonly PlaylistSong[],
  options: OptimizeSetlistOptions,
): SetlistOptimizationResult {
  const n = songs.length
  const initialOrder = Array.from({ length: n }, (_, i) => i)
  const before = evaluateSetlistOrder(songs, initialOrder, options.profile)
  const pinned = new Set<number>(options.pinnedIndices ? [...options.pinnedIndices] : [])
  const freePositions = initialOrder.filter((i) => !pinned.has(i))

  if (freePositions.length <= 1) {
    const energies = songs.map(estimateSongEnergy)
    const targets = initialOrder.map((_, i) => targetArcEnergy(n > 1 ? i / (n - 1) : 0, options.profile))
    return {
      songs: songs.map((s, idx) => ({ ...s, orderIndex: idx })),
      order: initialOrder,
      before,
      after: before,
      improvementPct: 0,
      energyBefore: energies,
      energyAfter: energies,
      targetCurve: targets,
      costHistory: [before.totalCost],
    }
  }

  const rng = mulberry32(options.seed ?? 0x5bd1e995)
  const iters = Math.max(80, Math.min(4000, options.iterations ?? 900))
  const current = initialOrder.slice()
  let currentCost = before.totalCost
  let best = current.slice()
  let bestCost = currentCost

  const costHistory: number[] = [Math.round(bestCost * 1000) / 1000]
  const histStride = Math.max(1, Math.floor(iters / 24))
  const tStart = 0.35
  const tEnd = 0.002

  for (let step = 0; step < iters; step++) {
    const temp = tStart * Math.pow(tEnd / tStart, step / iters)
    const candidate = current.slice()

    if (freePositions.length >= 4 && rng() < 0.38) {
      // Movimiento 2-opt sobre el subarreglo de posiciones libres.
      const a = Math.floor(rng() * freePositions.length)
      let b = Math.floor(rng() * freePositions.length)
      if (a === b) b = (a + 1) % freePositions.length
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      for (let l = lo, r = hi; l < r; l++, r--) {
        const posL = freePositions[l]
        const posR = freePositions[r]
        const tmp = candidate[posL]
        candidate[posL] = candidate[posR]
        candidate[posR] = tmp
      }
    } else {
      // Intercambio de dos posiciones libres.
      const a = Math.floor(rng() * freePositions.length)
      let b = Math.floor(rng() * (freePositions.length - 1))
      if (b >= a) b++
      const posA = freePositions[a]
      const posB = freePositions[b]
      const tmp = candidate[posA]
      candidate[posA] = candidate[posB]
      candidate[posB] = tmp
    }

    const candCost = evaluateSetlistOrder(songs, candidate, options.profile).totalCost
    const delta = candCost - currentCost
    if (delta <= 0 || rng() < Math.exp(-delta / Math.max(1e-6, temp))) {
      for (let i = 0; i < n; i++) current[i] = candidate[i]
      currentCost = candCost
      if (candCost < bestCost - 1e-9) {
        best = candidate.slice()
        bestCost = candCost
      }
    }
    if ((step + 1) % histStride === 0) {
      costHistory.push(Math.round(bestCost * 1000) / 1000)
    }
  }

  // Pulido determinista final por descenso local exhaustivo de pares libres (2-swap).
  let improved = true
  while (improved) {
    improved = false
    for (let i = 0; i < freePositions.length; i++) {
      for (let j = i + 1; j < freePositions.length; j++) {
        const posI = freePositions[i]
        const posJ = freePositions[j]
        const candidate = best.slice()
        const tmp = candidate[posI]
        candidate[posI] = candidate[posJ]
        candidate[posJ] = tmp
        const c = evaluateSetlistOrder(songs, candidate, options.profile).totalCost
        if (c < bestCost - 1e-7) {
          best = candidate
          bestCost = c
          improved = true
        }
      }
    }
  }

  const after = evaluateSetlistOrder(songs, best, options.profile)
  costHistory.push(Math.round(after.totalCost * 1000) / 1000)
  const improvementPct =
    before.totalCost > 1e-6
      ? Math.max(0, Math.round(((before.totalCost - after.totalCost) / before.totalCost) * 1000) / 10)
      : 0

  const optimizedSongs = best.map((origIdx, newIdx) => ({
    ...songs[origIdx],
    orderIndex: newIdx,
  }))

  return {
    songs: optimizedSongs,
    order: best,
    before,
    after,
    improvementPct,
    energyBefore: initialOrder.map((idx) => Math.round(estimateSongEnergy(songs[idx]) * 100) / 100),
    energyAfter: best.map((idx) => Math.round(estimateSongEnergy(songs[idx]) * 100) / 100),
    targetCurve: initialOrder.map((_, i) => Math.round(targetArcEnergy(n > 1 ? i / (n - 1) : 0, options.profile) * 100) / 100),
    costHistory,
  }
}
