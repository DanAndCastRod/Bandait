/**
 * Logica pura del metronomo de bolsillo (bandeja de widgets) y del tap tempo. Igual que el clic
 * del follower y el del Estudio (services/studio/click.ts): los golpes se programan en el reloj
 * del AudioContext con anticipacion (`nextTime` + ventana de ~100 ms) y un temporizador corto solo
 * despierta al programador; el temporizador puede llegar tarde sin que el clic se mueva.
 *
 * El cursor avanza golpe a golpe con el BPM vigente en cada golpe, asi que cambiar el tempo con
 * el clic sonando no lo reinicia ni lo desfasa.
 *
 * Modulo puro: sin DOM, sin React.
 */

/** Ventana de anticipacion: se programan los golpes que caen antes de `now + LOOKAHEAD_S`. */
export const POCKET_LOOKAHEAD_S = 0.1
/** Cada cuanto despierta el programador (muy por debajo de la ventana). */
export const POCKET_SCHEDULER_MS = 25
/** Margen del primer golpe tras arrancar (deja tiempo a que el AudioContext reanude). */
export const POCKET_START_DELAY_S = 0.06
/** Si el cursor quedo mas atras que esto (pestana congelada), se salta lo perdido en vez de tocarlo de golpe. */
export const POCKET_MAX_LATE_S = 0.2

export const POCKET_BPM_MIN = 40
export const POCKET_BPM_MAX = 260

export interface PocketCursor {
  /** Tiempo del AudioContext del proximo golpe. */
  nextTime: number
  /** Golpe dentro del compas del proximo golpe (0 = acento). */
  beat: number
}

export interface PocketClick {
  time: number
  beat: number
  accent: boolean
}

export function clampPocketBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120
  return Math.max(POCKET_BPM_MIN, Math.min(POCKET_BPM_MAX, bpm))
}

export function startPocketCursor(now: number): PocketCursor {
  return { nextTime: now + POCKET_START_DELAY_S, beat: 0 }
}

/**
 * Golpes a programar en esta vuelta del programador y el cursor que sigue. Solo devuelve golpes
 * con `time >= now` (nunca programa en el pasado); los perdidos por una pestana congelada se
 * saltan conservando la cuenta del compas.
 */
export function schedulePocketWindow(
  cursor: PocketCursor,
  now: number,
  bpm: number,
  beatsPerBar: number,
  lookaheadS: number = POCKET_LOOKAHEAD_S,
): { clicks: PocketClick[]; cursor: PocketCursor } {
  const period = 60 / clampPocketBpm(bpm)
  const perBar = Math.max(1, Math.floor(Number.isFinite(beatsPerBar) ? beatsPerBar : 4))
  let { nextTime, beat } = cursor
  beat = ((beat % perBar) + perBar) % perBar
  if (nextTime < now - POCKET_MAX_LATE_S) {
    const missed = Math.ceil((now - nextTime) / period)
    nextTime += missed * period
    beat = (beat + missed) % perBar
  }
  const clicks: PocketClick[] = []
  const until = now + Math.max(0, lookaheadS)
  // Tope defensivo: con BPM acotado nunca caben mas de unos pocos golpes en la ventana.
  for (let guard = 0; nextTime < until && guard < 64; guard++) {
    if (nextTime >= now - 1e-6) clicks.push({ time: Math.max(now, nextTime), beat, accent: beat === 0 })
    nextTime += period
    beat = (beat + 1) % perBar
  }
  return { clicks, cursor: { nextTime, beat } }
}

/** Regresion lineal por minimos cuadrados t_k = a + b*k para estimar un BPM estable con hasta 8 taps. */
export function linearRegressionTapBpm(tapsMs: readonly number[]): number | null {
  if (tapsMs.length < 2) return null
  const n = tapsMs.length
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += tapsMs[i]
    sumXY += i * tapsMs[i]
    sumXX += i * i
  }
  const denom = n * sumXX - sumX * sumX
  if (denom <= 0) return null
  const slopeMs = (n * sumXY - sumX * sumY) / denom
  if (!(slopeMs > 180 && slopeMs < 2000)) return null
  return Math.max(POCKET_BPM_MIN, Math.min(POCKET_BPM_MAX, Math.round((60000 / slopeMs) * 10) / 10))
}
