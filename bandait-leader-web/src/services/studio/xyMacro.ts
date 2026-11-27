/**
 * Pad X/Y de la bandeja de widgets: cada modo mueve SOLO sus parametros, en relativo a lo que
 * habia al poner el dedo. La interfaz captura la sesion en `pointerdown` y en cada movimiento
 * aplica `applyXyMacro(base, modo, dx, dy)` sobre esa base (nunca sobre la sesion ya movida), asi
 * que el gesto no acumula error y deshacer lo devuelve entero en un solo paso.
 *
 *   - warmth_air: X = drive del saturador del master, Y = agudos (highDb) del EQ del master. El
 *     resto de parametros de esos efectos, su bypass y los demas efectos no se tocan. Si el efecto
 *     no estaba, solo se inserta cuando el gesto lo mueve de verdad.
 *   - dry_space: X = cola (decayS) de la reverb compartida, Y = su retorno (returnDb).
 *   - vox_band: Y = volumen de las voces, X = volumen del resto (menos clic y guia), cada pista
 *     desde su propio volumen: se conserva la mezcla relativa.
 *
 * Modulo puro: sin DOM ni React. `putFx` es `withFx` de studioState (se inyecta para no importar
 * el controlador desde aqui).
 */
import {
  STUDIO_MASTER_ID,
  STUDIO_REVERB_DECAY_S_MAX,
  STUDIO_REVERB_DECAY_S_MIN,
  STUDIO_REVERB_RETURN_DB_MAX,
  STUDIO_REVERB_RETURN_DB_MIN,
  STUDIO_VOLUME_DB_MAX,
  STUDIO_VOLUME_DB_MIN,
  defaultFx,
  type StudioFx,
  type StudioSession,
} from './session.ts'
import { updateMaster, updateTrack } from './sessionOps.ts'

export type XYMode = 'warmth_air' | 'dry_space' | 'vox_band'

/** Recorrido de cada eje de lado a lado del pad (en unidades del parametro). */
export const XY_RANGE = {
  driveDb: 14,
  highDb: 9,
  decayS: 3.4,
  returnDb: 32,
  volumeDb: 8,
} as const

const DRIVE_MIN = 0
const DRIVE_MAX = 24
const HIGH_MIN = -18
const HIGH_MAX = 18
/** Por debajo de esto el gesto no inserta un efecto que no estaba. */
const INSERT_EPSILON = 0.05

export type PutFx = (session: StudioSession, targetId: string, fx: StudioFx) => StudioSession

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/**
 * Sesion resultante de mover el pad `dx`, `dy` (fracciones del pad, -1..1) desde `base`. Devuelve
 * `base` tal cual si el gesto no cambia nada.
 */
export function applyXyMacro(base: StudioSession, mode: XYMode, dx: number, dy: number, putFx: PutFx): StudioSession {
  const ddx = Number.isFinite(dx) ? clamp(dx, -1, 1) : 0
  const ddy = Number.isFinite(dy) ? clamp(dy, -1, 1) : 0

  if (mode === 'dry_space') {
    const reverb = base.master.reverb
    const decayS = round2(clamp(reverb.decayS + ddx * XY_RANGE.decayS, STUDIO_REVERB_DECAY_S_MIN, STUDIO_REVERB_DECAY_S_MAX))
    const returnDb = round1(clamp(reverb.returnDb + ddy * XY_RANGE.returnDb, STUDIO_REVERB_RETURN_DB_MIN, STUDIO_REVERB_RETURN_DB_MAX))
    if (decayS === reverb.decayS && returnDb === reverb.returnDb) return base
    return updateMaster(base, { patch: { reverb: { decayS, returnDb } } })
  }

  if (mode === 'warmth_air') {
    let next = base
    const sat = base.master.fx.find((fx) => fx.type === 'saturator')
    const baseDrive = sat && sat.type === 'saturator' ? sat.params.driveDb : 0
    const driveDb = round1(clamp(baseDrive + ddx * XY_RANGE.driveDb, DRIVE_MIN, DRIVE_MAX))
    if (sat && sat.type === 'saturator') {
      if (driveDb !== sat.params.driveDb) next = putFx(next, STUDIO_MASTER_ID, { ...sat, params: { ...sat.params, driveDb } })
    } else if (driveDb > INSERT_EPSILON) {
      const fresh = defaultFx('saturator')
      next = putFx(next, STUDIO_MASTER_ID, { ...fresh, params: { ...fresh.params, driveDb, mix: 0.65 } })
    }
    const eq = base.master.fx.find((fx) => fx.type === 'eq')
    const baseHigh = eq && eq.type === 'eq' ? eq.params.highDb : 0
    const highDb = round1(clamp(baseHigh + ddy * XY_RANGE.highDb, HIGH_MIN, HIGH_MAX))
    if (eq && eq.type === 'eq') {
      if (highDb !== eq.params.highDb) next = putFx(next, STUDIO_MASTER_ID, { ...eq, params: { ...eq.params, highDb } })
    } else if (Math.abs(highDb) > INSERT_EPSILON) {
      const fresh = defaultFx('eq')
      next = putFx(next, STUDIO_MASTER_ID, { ...fresh, params: { ...fresh.params, highDb } })
    }
    return next
  }

  // vox_band
  let next = base
  for (const track of base.tracks) {
    if (track.role === 'click' || track.role === 'guide') continue
    const delta = track.role === 'vocals' ? ddy : ddx
    const volumeDb = round1(clamp(track.volumeDb + delta * XY_RANGE.volumeDb, STUDIO_VOLUME_DB_MIN, STUDIO_VOLUME_DB_MAX))
    if (volumeDb !== track.volumeDb) next = updateTrack(next, { trackId: track.id, patch: { volumeDb } })
  }
  return next
}
