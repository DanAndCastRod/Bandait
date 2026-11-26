/**
 * Calculos puros de la linea de tiempo del Estudio: ventanas de clip de una toma, compas y tiempo,
 * geometria vertical de las pistas, y dos decisiones del controlador que conviene probar sin
 * navegador (que audios siguen referenciados, y si la nube tiene otra version de la sesion).
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env (se prueba en
 * scripts/verify-studio-logic.ts). El controlador (components/studio/studioState.ts) lo reexporta.
 */
import { STUDIO_MAX_SESSION_SECONDS, STUDIO_MIN_CLIP_SECONDS, type StudioSession } from './session.ts'
import type { LoopRegionS } from './types.ts'

export interface TakeWindowInput {
  /** Posicion de la toma en la sesion (latency.takeStartSeconds); puede ser negativa. */
  startSeconds: number
  durationSeconds: number
  /** Posicion en la que arranco la reproduccion. */
  positionAtStart: number
  /** Repeticion vigente al grabar, o null. */
  loop: LoopRegionS | null
}

export interface ClipWindow {
  startS: number
  offsetS: number
  lengthS: number
}

/** Una vuelta de repeticion mas corta que esto no se guarda como toma. */
export const MIN_TAKE_LAP_S = 0.25
/** Vueltas de una grabacion en repeticion que se conservan (las ultimas). */
export const MAX_TAKE_LAPS = 24

/**
 * Ventanas de clip de una toma. La captura arranca antes del conteo previo, asi que lo que cae
 * antes de la posicion de arranque (o antes del segundo 0) se deja fuera con `offsetS`. Con
 * repeticion, la toma se parte en una ventana por vuelta (todas sobre el mismo audio): la primera
 * va de la posicion de arranque al fin de la region, las demas cubren la region entera.
 */
export function takeClipWindows(input: TakeWindowInput): ClipWindow[] {
  const u0 = input.startSeconds
  const u1 = u0 + input.durationSeconds
  if (!Number.isFinite(u0) || !Number.isFinite(u1) || !(u1 > u0)) return []
  const from = Math.max(u0, input.positionAtStart, 0)
  const loop = input.loop
  const loopLength = loop ? loop.endS - loop.startS : 0
  if (!loop || !(loopLength > 0) || input.positionAtStart >= loop.endS) {
    const end = Math.min(u1, STUDIO_MAX_SESSION_SECONDS)
    return end - from >= STUDIO_MIN_CLIP_SECONDS ? [{ startS: from, offsetS: from - u0, lengthS: end - from }] : []
  }
  const windows: ClipWindow[] = []
  // Tiempo "desenrollado": la vuelta k (k >= 1) empieza en loop.endS + (k - 1) * largo.
  let lapStart = input.positionAtStart
  let lapEnd = loop.endS
  let sessionStart = input.positionAtStart
  while (lapStart < u1) {
    const a = Math.max(lapStart, from)
    const b = Math.min(lapEnd, u1)
    if (b - a >= MIN_TAKE_LAP_S) windows.push({ startS: sessionStart + (a - lapStart), offsetS: a - u0, lengthS: b - a })
    lapStart = lapEnd
    lapEnd += loopLength
    sessionStart = loop.startS
  }
  return windows.slice(-MAX_TAKE_LAPS)
}

/** Posicion como "compas.tiempo" (1-based) segun el tempo de la sesion. */
export function barBeatAt(positionS: number, bpm: number, beatsPerBar: number): { bar: number; beat: number } {
  const beats = Math.max(0, positionS) * (bpm / 60)
  // 1e-6: una posicion que cae justo en un tiempo no debe mostrarse como el anterior.
  const whole = Math.floor(beats + 1e-6)
  return { bar: Math.floor(whole / beatsPerBar) + 1, beat: (whole % beatsPerBar) + 1 }
}

/** Alto de la regla de compases y secciones, en px. */
export const RULER_H = 46
/** Alto del carril principal de una pista (clips activos), en px. */
export const TRACK_ROW_H = 112
/** Alto de cada carril de tomas alternativas, en px. */
export const TAKE_LANE_H = 30

export interface TrackRowLayout {
  trackId: string
  /** Desde el borde inferior de la regla. */
  top: number
  height: number
  /** Carril (0-based) de cada toma inactiva, debajo del carril principal. */
  lanes: ReadonlyMap<string, number>
  laneCount: number
}

/**
 * Geometria vertical de la linea de tiempo. Las tomas inactivas de una pista se apilan en
 * carriles bajo el principal: dos tomas que se solapan en el tiempo nunca comparten carril.
 * La usan las cabeceras de pista y el canvas, para que coincidan fila a fila.
 */
export function layoutTracks(session: Pick<StudioSession, 'tracks'>): TrackRowLayout[] {
  const rows: TrackRowLayout[] = []
  let top = 0
  for (const track of session.tracks) {
    const lanes = new Map<string, number>()
    const laneEnds: number[] = []
    const takes = track.clips.filter((clip) => !clip.active).sort((a, b) => a.startS - b.startS)
    for (const clip of takes) {
      let lane = laneEnds.findIndex((end) => end <= clip.startS)
      if (lane < 0) {
        lane = laneEnds.length
        laneEnds.push(0)
      }
      laneEnds[lane] = clip.startS + clip.lengthS
      lanes.set(clip.id, lane)
    }
    const height = TRACK_ROW_H + laneEnds.length * TAKE_LANE_H
    rows.push({ trackId: track.id, top, height, lanes, laneCount: laneEnds.length })
    top += height
  }
  return rows
}

/**
 * Archivos de audio que la sesion sigue referenciando: los del estado vigente, los de CADA paso
 * del historial (deshacer y rehacer) y los de audios ya guardados que todavia no entraron a la
 * sesion (`pendingAssetIds`, sin extension). Un archivo que no esta aqui es una toma huerfana;
 * uno que si esta no se puede ofrecer para DESCARTAR: rehacer el paso lo dejaria sin audio.
 */
export function referencedAssetFiles(states: readonly Pick<StudioSession, 'assets'>[], pendingAssetIds: Iterable<string> = []): Set<string> {
  const files = new Set<string>()
  for (const state of states) for (const asset of state.assets) files.add(asset.file)
  for (const id of pendingAssetIds) for (const ext of ['wav', 'flac', 'mp3']) files.add(`${id}.${ext}`)
  return files
}

/**
 * true si la version de la nube (su `updated_at` en la lista) no es la que este equipo subio o
 * bajo por ultima vez. Se compara contra la hora que puso el Worker (`cloudUpdatedAt`), no contra
 * el `updatedAt` local: esos dos relojes nunca coinciden, y compararlos hacia que cada apertura
 * de una sesion ya subida la bajara de nuevo y pisara la copia de este equipo.
 * Sin `cloudUpdatedAt` (sesion guardada antes de anotarlo) se usa `updatedAt`, como antes.
 */
export function cloudHasOtherVersion(cloudUpdatedAt: string, local: { updatedAt: string; cloudUpdatedAt?: string | null }): boolean {
  return cloudUpdatedAt !== (local.cloudUpdatedAt ?? local.updatedAt)
}

export interface MaxTakeInput {
  /** Canales que escribe un archivo de toma (1 mono, 2 par estereo). */
  channels: number
  sampleRate: number
  /** Bits por muestra del archivo (el Estudio graba a 24). */
  bitDepth: number
  /** Tope de bytes por audio (STUDIO_MAX_ASSET_BYTES). */
  maxBytes: number
}

/** Segundos que caben en una toma antes de llegar al tope de tamano por audio. */
export function maxTakeSeconds(input: MaxTakeInput): number {
  const bytesPerSecond = input.sampleRate * Math.max(1, input.channels) * (input.bitDepth / 8)
  return bytesPerSecond > 0 && input.maxBytes > 44 ? (input.maxBytes - 44) / bytesPerSecond : 0
}

// ---------------------------------------------------------------------------
// Navegacion y tap tempo (atajos de DAW)
// ---------------------------------------------------------------------------

/** Una pausa mas larga que esto entre dos golpes empieza un tap tempo nuevo. */
export const TAP_TEMPO_RESET_MS = 2000
/** Golpes que se promedian (los ultimos). */
export const TAP_TEMPO_MAX_TAPS = 8
/** Golpes minimos para proponer un tempo. */
export const TAP_TEMPO_MIN_TAPS = 3

/**
 * Golpes vigentes tras un golpe nuevo en `nowMs` (una pausa larga reinicia la cuenta) y el tempo
 * que marcan, acotado a `minBpm`..`maxBpm` y redondeado a una decima. null mientras no haya
 * golpes suficientes.
 */
export function tapTempo(previous: readonly number[], nowMs: number, minBpm: number, maxBpm: number): { taps: number[]; bpm: number | null } {
  const last = previous[previous.length - 1]
  const kept = last !== undefined && nowMs - last > 0 && nowMs - last <= TAP_TEMPO_RESET_MS ? previous.slice(-(TAP_TEMPO_MAX_TAPS - 1)) : []
  const taps = [...kept, nowMs]
  if (taps.length < TAP_TEMPO_MIN_TAPS) return { taps, bpm: null }
  const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1)
  if (!(avg > 0)) return { taps, bpm: null }
  const bpm = Math.round((60000 / avg) * 10) / 10
  return { taps, bpm: Math.min(maxBpm, Math.max(minBpm, bpm)) }
}

/**
 * Beat de la marca anterior (`direction` -1) o siguiente (+1) respecto de `beat`, o null si no
 * hay. Una marca a menos de una centesima de beat cuenta como "aqui": se salta, para que pulsar
 * dos veces avance de marca en marca.
 */
export function adjacentMarkerBeat(markers: readonly { beat: number }[], beat: number, direction: -1 | 1): number | null {
  const EPS = 0.01
  let best: number | null = null
  for (const m of markers) {
    if (direction > 0 ? m.beat > beat + EPS : m.beat < beat - EPS) {
      if (best === null || (direction > 0 ? m.beat < best : m.beat > best)) best = m.beat
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Seleccion por rectangulo y region de repeticion arrastrable (linea de tiempo)
// ---------------------------------------------------------------------------

/**
 * Rectangulo de seleccion en coordenadas del contenido: tiempo en segundos (eje x, independiente
 * del zoom y del scroll) y px verticales desde arriba del contenido (eje y).
 */
export interface MarqueeRect {
  startS: number
  endS: number
  top: number
  bottom: number
}

/** Caja de un clip en las mismas coordenadas que MarqueeRect. */
export interface MarqueeClipBox {
  id: string
  startS: number
  endS: number
  top: number
  bottom: number
}

/** Franja junto a cada borde del carril donde el rectangulo de seleccion desplaza la vista. */
export const EDGE_SCROLL_ZONE_PX = 36
/** Desplazamiento maximo por cuadro (px) con el puntero en el borde o fuera del carril. */
export const EDGE_SCROLL_MAX_PX = 24

/**
 * Desplazamiento por cuadro mientras se arrastra cerca de un borde (autoscroll del rectangulo de
 * seleccion, auditoria de fidelidad DAW 4.1): negativo hacia el inicio, positivo hacia el final,
 * 0 en el centro. Crece con el cuadrado de lo que el puntero entra en la franja y llega al
 * maximo en el borde o fuera del carril. Con un carril angosto la franja se achica a un cuarto.
 */
export function edgeScrollSpeed(pos: number, start: number, end: number, zone = EDGE_SCROLL_ZONE_PX, maxSpeed = EDGE_SCROLL_MAX_PX): number {
  if (!Number.isFinite(pos) || !(end > start) || !(maxSpeed > 0)) return 0
  const band = Math.max(1, Math.min(zone, (end - start) / 4))
  const speed = (depth: number) => {
    const t = Math.min(1, depth / band)
    return Math.max(1, Math.round(maxSpeed * t * t))
  }
  if (pos < start + band) return -speed(start + band - pos)
  if (pos > end - band) return speed(pos - (end - band))
  return 0
}

/** Rectangulo entre el punto donde empezo el arrastre y el punto actual, en cualquier direccion. */
export function marqueeFromPoints(a: { timeS: number; y: number }, b: { timeS: number; y: number }): MarqueeRect {
  return { startS: Math.min(a.timeS, b.timeS), endS: Math.max(a.timeS, b.timeS), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) }
}

/**
 * Ids de los clips que el rectangulo TOCA (no hace falta encerrarlos enteros), en el orden de
 * `boxes`. Tocar el borde cuenta: un rectangulo de alto o ancho cero sobre un clip lo elige.
 */
export function clipsInMarquee(boxes: readonly MarqueeClipBox[], rect: MarqueeRect): string[] {
  const out: string[] = []
  for (const box of boxes) {
    if (box.endS < rect.startS || box.startS > rect.endS) continue
    if (box.bottom < rect.top || box.top > rect.bottom) continue
    out.push(box.id)
  }
  return out
}

/**
 * Seleccion que deja el rectangulo: sin Shift/Ctrl reemplaza la anterior; con Shift/Ctrl suma los
 * clips nuevos detras de los que ya estaban, sin repetir.
 */
export function marqueeSelection(current: readonly string[], picked: readonly string[], additive: boolean): string[] {
  if (!additive) return [...new Set(picked)]
  const out = [...current]
  const seen = new Set(current)
  for (const id of picked) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** Parte de la region de repeticion que se arrastra sobre la regla. */
export type LoopDragPart = 'start' | 'end' | 'body'

export interface LoopDragOptions {
  /** Largo minimo de la region. */
  minLengthS: number
  /** Fin de la sesion (la region no pasa de aqui). */
  maxS: number
  /** Ajuste a la rejilla del borde que se mueve (o del inicio, al mover la region entera). */
  snap?: (timeS: number) => number
}

/**
 * Region tras arrastrar `deltaS` segundos uno de sus bordes o la region entera. Con `body` el largo
 * no cambia; con un borde, el otro queda quieto y el largo nunca baja de `minLengthS`. Siempre
 * dentro de [0, maxS].
 */
export function dragLoopRegion(base: LoopRegionS, part: LoopDragPart, deltaS: number, options: LoopDragOptions): LoopRegionS {
  const snap = options.snap ?? ((s: number) => s)
  const maxS = Math.max(options.minLengthS, options.maxS)
  const length = base.endS - base.startS
  if (part === 'body') {
    const startS = Math.min(Math.max(0, snap(base.startS + deltaS)), Math.max(0, maxS - length))
    return { startS, endS: startS + length }
  }
  if (part === 'start') {
    const startS = Math.min(Math.max(0, snap(base.startS + deltaS)), base.endS - options.minLengthS)
    return { startS: Math.max(0, startS), endS: base.endS }
  }
  const endS = Math.max(Math.min(maxS, snap(base.endS + deltaS)), base.startS + options.minLengthS)
  return { startS: base.startS, endS }
}
