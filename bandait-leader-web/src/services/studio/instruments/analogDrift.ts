/**
 * Deriva analogica (`analog_drift`, STUDIO_V2.md 7.3) de `synth` y `drums`, determinista.
 *
 * Determinismo: todo sale de la POSICION MUSICAL de la nota (segundos de sesion, `PlannedNote.startS`)
 * y de la pista, nunca de la hora del AudioContext. Asi la misma nota suena igual cada vez que se
 * reproduce, desde cualquier punto, y en el export (bounce offline). Las notas en vivo (teclado o
 * MIDI) no tienen posicion musical: usan la hora del contexto, y no se exportan.
 *
 * Dos capas:
 *   - Tolerancia por nota (`noteDriftBipolar`): desvio estatico de afinacion, corte y decaimiento,
 *     como dos voces de un poly analogico que nunca quedan iguales.
 *   - Vagabundeo lento (`analogWander`): ruido de valor con interpolacion coseno, nudos cada
 *     WANDER_KNOT_S y una octava a la mitad de amplitud; en [-1, 1], continuo y correlacionado a lo
 *     largo de segundos. Es funcion del tiempo de sesion, asi que una nota larga recorre la curva y
 *     dos notas seguidas comparten la misma "temperatura" del oscilador.
 *
 * Modulo puro salvo `scheduleWander`, que solo programa eventos en un AudioParam (unos pocos por
 * nota, ninguno por muestra).
 */

/** Hash determinista en [-1, 1). */
function hashBipolar(a: number, b: number, salt: number): number {
  let h = (Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(salt | 0, 2246822519)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 2147483648 - 1
}

/** Sal de una pista (FNV-1a de su id): dos pistas con el mismo instrumento no derivan igual. */
export function trackDriftSalt(trackId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < trackId.length; i++) {
    h ^= trackId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h | 0
}

/** Desvio estatico por nota en [-1, 1): pitch, posicion musical (ms) y sal (pista ^ parametro). */
export function noteDriftBipolar(pitch: number, seedS: number, salt: number): number {
  return hashBipolar(pitch, Math.round(seedS * 1000), salt)
}

/** Separacion de los nudos del vagabundeo lento, en segundos. */
export const WANDER_KNOT_S = 1.7
/** Paso de los eventos que siguen la curva en un AudioParam. */
export const WANDER_STEP_S = 0.25
/** Hasta donde se sigue la curva en una voz (despues queda en el ultimo valor). */
export const WANDER_MAX_S = 32

function knotValue(index: number, salt: number): number {
  return hashBipolar(index, 0x5bd1e995, salt)
}

function smoothNoise(t: number, salt: number): number {
  const i = Math.floor(t)
  const f = t - i
  const w = (1 - Math.cos(Math.PI * f)) / 2
  return knotValue(i, salt) * (1 - w) + knotValue(i + 1, salt) * w
}

/** Vagabundeo lento en [-1, 1] en el segundo de sesion `sessionS`, continuo. */
export function analogWander(sessionS: number, salt: number): number {
  if (!Number.isFinite(sessionS)) return 0
  const t = sessionS / WANDER_KNOT_S
  // Dos octavas: la lenta manda; la rapida (el doble) le da textura. Suma maxima 1.5 -> /1.5.
  return (smoothNoise(t, salt) + 0.5 * smoothNoise(t * 2 + 17.3, salt ^ 0x2c1b3c6d)) / 1.5
}

/** Donde esta una voz en la musica: lo que pasa scheduleMidiClips a cada nota de un clip. */
export interface VoiceMusicalPosition {
  /** Segundo de sesion en que empieza la nota (semilla de la tolerancia por nota). */
  seedS: number
  /** Segundo de sesion que suena en el instante de inicio de la voz (con chase, mayor que seedS). */
  sessionS: number
  /** Sal de la pista (trackDriftSalt). */
  salt: number
}

/** Capa de vagabundeo: [profundidad, sal]. Varias capas se suman en el mismo parametro. */
export type WanderLayer = readonly [depth: number, salt: number]

/** Valor de varias capas de vagabundeo en el segundo `sessionS`. */
export function wanderValue(layers: readonly WanderLayer[], sessionS: number): number {
  let v = 0
  for (const [depth, salt] of layers) v += depth * analogWander(sessionS, salt)
  return v
}

/**
 * Programa en `param`, desde `start` (hora del contexto) y durante `durS`, el valor
 * `base + wanderValue(layers, sessionS + t)`: un setValueAtTime y una rampa lineal cada
 * WANDER_STEP_S (como mucho WANDER_MAX_S). Sin profundidad no programa nada.
 */
export function scheduleWander(param: AudioParam, base: number, layers: readonly WanderLayer[], start: number, sessionS: number, durS: number): void {
  if (!layers.some(([depth]) => depth !== 0) || !Number.isFinite(start)) return
  param.setValueAtTime(base + wanderValue(layers, sessionS), start)
  const span = Math.min(WANDER_MAX_S, Math.max(0, durS))
  for (let t = WANDER_STEP_S; t <= span + 1e-9; t += WANDER_STEP_S) {
    param.linearRampToValueAtTime(base + wanderValue(layers, sessionS + t), start + t)
  }
}
