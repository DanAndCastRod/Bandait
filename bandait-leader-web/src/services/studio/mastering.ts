/**
 * Cadena de Masterizacion DSP Local (Cero Cuota IA).
 *
 * Construye la cadena completa del Bus Master (`eq` -> `compressor` glue -> `saturator` tape ->
 * `stereo_imager` con graves en mono -> `limiter`) y la CALIBRA midiendo el resultado real:
 *
 *   1. Se renderiza la mezcla SIN la cadena del master (mismo grafo que el export) y se mide su
 *      LUFS integrado BS.1770: es el punto de partida, el mismo sea cual sea el master actual
 *      (aplicar Auto-Master dos veces da el mismo resultado).
 *   2. Se arma la cadena con el umbral del compresor relativo a ese nivel y una ganancia inicial.
 *   3. Se renderiza CON la cadena, se mide LUFS integrado y pico real (sobremuestreo x4 de
 *      loudness.ts) y se corrige: el volumen del master (va antes del limitador) para el LUFS y el
 *      techo del limitador para el pico real, hasta 3 vueltas, hasta quedar a +-0,5 LU del objetivo
 *      y bajo el techo de pico real.
 *
 * El limitador del Estudio trabaja sobre pico de MUESTRA; el pico real entre muestras se controla
 * midiendo el render y bajando el techo del limitador lo que haga falta. Los numeros que se
 * anuncian son los medidos, no los pedidos.
 *
 * Perfiles de destino:
 *   - `streaming`:   -14,0 LUFS, techo -1,0 dBTP (Spotify / YouTube / Apple Music)
 *   - `club`:        -11,0 LUFS, techo -0,8 dBTP (pegada grave y densidad alta)
 *   - `live_stage`:   -9,0 LUFS, techo -0,5 dBTP (consistencia para PA / In-Ear en vivo)
 *   - `dynamic`:     -16,0 LUFS, techo -1,0 dBTP (acustico / jazz / alto rango dinamico)
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env. La medicion llega inyectada
 * (`AutoMasterMeasure`), asi se prueba en node con un render simulado.
 */
import { dynamicsCompressorMakeupDb } from './fx.ts'
import {
  STUDIO_VOLUME_DB_MAX,
  STUDIO_VOLUME_DB_MIN,
  type StudioFx,
  type StudioMaster,
  type StudioSession,
} from './session.ts'

export type AutoMasterProfile = 'streaming' | 'club' | 'live_stage' | 'dynamic'
export type AutoMasterTone = 'warm' | 'balanced' | 'open'

export interface AutoMasterSpec {
  id: AutoMasterProfile
  label: string
  description: string
  targetLufs: number
  ceilingDb: number
  glueRatio: number
  tapeDriveDb: number
  stereoWidth: number
  monoBassHz: number
}

export const AUTO_MASTER_PROFILES: Readonly<Record<AutoMasterProfile, AutoMasterSpec>> = {
  streaming: {
    id: 'streaming',
    label: 'Streaming (-14 LUFS)',
    description: 'Calibrado para Spotify, Apple Music y YouTube, con el pico real medido bajo -1.0 dBTP.',
    targetLufs: -14,
    ceilingDb: -1.0,
    glueRatio: 2.0,
    tapeDriveDb: 2.4,
    stereoWidth: 1.08,
    monoBassHz: 110,
  },
  club: {
    id: 'club',
    label: 'Club / Pegada (-11 LUFS)',
    description: 'Subgraves firmes en mono bajo 130 Hz, saturación cálida y pegada densa.',
    targetLufs: -11,
    ceilingDb: -0.8,
    glueRatio: 2.8,
    tapeDriveDb: 4.0,
    stereoWidth: 1.15,
    monoBassHz: 130,
  },
  live_stage: {
    id: 'live_stage',
    label: 'Escenario / In-Ear (-9 LUFS)',
    description: 'Máxima consistencia de nivel para pistas de respaldo en PA y monitoreo.',
    targetLufs: -9,
    ceilingDb: -0.5,
    glueRatio: 3.2,
    tapeDriveDb: 3.5,
    stereoWidth: 1.04,
    monoBassHz: 120,
  },
  dynamic: {
    id: 'dynamic',
    label: 'Dinámico / Acústico (-16 LUFS)',
    description: 'Compresión transparente que respeta transientes naturales y alto LRA.',
    targetLufs: -16,
    ceilingDb: -1.0,
    glueRatio: 1.6,
    tapeDriveDb: 1.4,
    stereoWidth: 1.05,
    monoBassHz: 90,
  },
}

export interface AutoMasterInput {
  profile: AutoMasterProfile
  tone?: AutoMasterTone
  targetLufsOverride?: number
  /** LUFS integrado medido en la mezcla pre-master (si se dispone). */
  measuredLufs?: number | null
  /** Energia Bark (24 bandas en dB) para correccion tonal suave automatica. */
  measuredBarkDb?: Float32Array | null
}

export interface AutoMasterResult {
  master: StudioMaster
  targetLufs: number
  ceilingDb: number
  appliedMakeupDb: number
  summary: string
}

export function isAutoMasterProfile(value: unknown): value is AutoMasterProfile {
  return value === 'streaming' || value === 'club' || value === 'live_stage' || value === 'dynamic'
}

export function isAutoMasterTone(value: unknown): value is AutoMasterTone {
  return value === 'warm' || value === 'balanced' || value === 'open'
}

/**
 * Reparte la ganancia explicita de la cadena: primero el volumen del master (va justo antes del
 * limitador, hasta STUDIO_VOLUME_DB_MAX) y lo que sobre en el makeup del compresor (0..24 dB).
 */
export function splitMasterGain(totalDb: number): { volumeDb: number; makeupDb: number } {
  const total = Number.isFinite(totalDb) ? totalDb : 0
  const volumeDb = Math.max(STUDIO_VOLUME_DB_MIN, Math.min(STUDIO_VOLUME_DB_MAX, total))
  const makeupDb = Math.max(0, Math.min(24, total - STUDIO_VOLUME_DB_MAX))
  return { volumeDb: Math.round(volumeDb * 10) / 10, makeupDb: Math.round(makeupDb * 10) / 10 }
}

/** Calcula la nueva cadena de `StudioMaster` lista para aplicar a una sesion. */
export function computeAutoMaster(currentMaster: StudioMaster, input: AutoMasterInput): AutoMasterResult {
  const spec = AUTO_MASTER_PROFILES[input.profile] ?? AUTO_MASTER_PROFILES.streaming
  const tone: AutoMasterTone = input.tone ?? 'balanced'
  const targetLufs =
    typeof input.targetLufsOverride === 'number' && Number.isFinite(input.targetLufsOverride)
      ? Math.max(-24, Math.min(-6, input.targetLufsOverride))
      : spec.targetLufs

  // Correccion tonal base segun el caracter elegido + balance espectral Bark si hay medicion.
  const lowDb = tone === 'warm' ? 1.5 : tone === 'open' ? -0.5 : 0.6
  let midDb = tone === 'warm' ? -0.8 : tone === 'open' ? -0.5 : -0.4
  let highDb = tone === 'warm' ? -0.6 : tone === 'open' ? 2.0 : 0.9

  if (input.measuredBarkDb && input.measuredBarkDb.length === 24) {
    const lowEnergy = (input.measuredBarkDb[1] + input.measuredBarkDb[2]) / 2
    const mudEnergy = (input.measuredBarkDb[3] + input.measuredBarkDb[4]) / 2
    const airEnergy = (input.measuredBarkDb[20] + input.measuredBarkDb[21]) / 2
    if (mudEnergy > lowEnergy + 3 && mudEnergy > -60) {
      midDb = Math.max(-3.5, Math.round((midDb - 1.2) * 10) / 10)
    }
    if (airEnergy < mudEnergy - 16 && mudEnergy > -60) {
      highDb = Math.min(3.5, Math.round((highDb + 1.0) * 10) / 10)
    }
  }

  // Nivel de partida: la mezcla sin master medida (o -18 LUFS si no hay medicion: solo para
  // armar la cadena; calibrateAutoMaster siempre mide).
  const preLufs =
    typeof input.measuredLufs === 'number' && Number.isFinite(input.measuredLufs) && input.measuredLufs > -65 ? input.measuredLufs : -18
  // Umbral del compresor relativo al nivel de la mezcla: pega unos pocos dB en los picos, sea cual
  // sea el volumen de llegada (un umbral fijo no comprime nada en una mezcla baja).
  const thresholdDb = Math.round(Math.max(-40, Math.min(-6, preLufs + 5)) * 10) / 10
  const kneeDb = 6
  // El DynamicsCompressorNode suma su propio makeup automatico: se cuenta aqui y el makeup
  // explicito queda en 0. La correccion fina la hace la calibracion midiendo.
  const autoMakeupDb = dynamicsCompressorMakeupDb(thresholdDb, kneeDb, spec.glueRatio)
  const { volumeDb: residualFaderDb, makeupDb: compMakeupDb } = splitMasterGain(targetLufs - preLufs - autoMakeupDb + 1.5)

  const fx: StudioFx[] = [
    {
      type: 'eq',
      bypass: false,
      params: {
        hpfHz: 28,
        lowDb: Math.round(lowDb * 10) / 10,
        midHz: 320,
        midDb: Math.round(midDb * 10) / 10,
        midQ: 1.4,
        highDb: Math.round(highDb * 10) / 10,
      },
    },
    {
      type: 'compressor',
      bypass: false,
      params: {
        thresholdDb,
        ratio: spec.glueRatio,
        attackMs: 25,
        releaseMs: 140,
        kneeDb,
        makeupDb: compMakeupDb,
      },
    },
    {
      type: 'saturator',
      bypass: false,
      params: {
        driveDb: spec.tapeDriveDb,
        toneDb: tone === 'warm' ? -1.5 : tone === 'open' ? 1.5 : 0,
        mix: 0.45,
        outputDb: -0.5,
      },
    },
    {
      type: 'stereo_imager',
      bypass: false,
      params: {
        width: spec.stereoWidth,
        monoBassHz: spec.monoBassHz,
      },
    },
    {
      type: 'limiter',
      bypass: false,
      params: {
        ceilingDb: spec.ceilingDb,
        releaseMs: 80,
      },
    },
  ]

  return {
    master: {
      volumeDb: residualFaderDb,
      reverb: currentMaster.reverb,
      fx,
    },
    targetLufs,
    ceilingDb: spec.ceilingDb,
    appliedMakeupDb: Math.round((compMakeupDb + autoMakeupDb + residualFaderDb) * 10) / 10,
    summary: `Cadena Auto-Master "${spec.label}" armada sin medir el resultado (objetivo ${targetLufs} LUFS, techo ${spec.ceilingDb} dBTP, graves mono < ${spec.monoBassHz} Hz).`,
  }
}

/**
 * Arma la cadena sin medir el resultado (sin render). La usa la prueba de forma de la cadena; la
 * accion AUTO-MASTER del Estudio usa calibrateAutoMaster, que mide.
 */
export function applyAutoMasterToSession(session: StudioSession, input: AutoMasterInput): {
  session: StudioSession
  result: AutoMasterResult
} {
  const result = computeAutoMaster(session.master, input)
  return {
    session: { ...session, master: result.master },
    result,
  }
}

// ---------------------------------------------------------------------------
// Calibracion midiendo el render
// ---------------------------------------------------------------------------

/** Lo que devuelve una medicion del render: LUFS integrado y pico real (dBTP). */
export interface AutoMasterMeasurement {
  lufs: number
  truePeakDb: number
  lraLu?: number
  plrDb?: number
  /** Energia Bark (24 bandas en dB) de la mezcla; solo hace falta en la medicion sin master. */
  barkDb?: Float32Array | null
}

/** Renderiza `session` igual que el export y mide su salida. */
export type AutoMasterMeasure = (session: StudioSession, pass: number) => Promise<AutoMasterMeasurement>

export interface AutoMasterCalibration {
  master: StudioMaster
  targetLufs: number
  /** Techo de pico real del perfil (dBTP). */
  ceilingDb: number
  /** Techo que quedo en el limitador (pico de muestra) para que el pico real no pase `ceilingDb`. */
  limiterCeilingDb: number
  /** LUFS integrado de la mezcla sin master. */
  preMasterLufs: number
  /** Medicion del render con la cadena final. */
  measured: AutoMasterMeasurement
  /** Renders con la cadena (sin contar el de la mezcla sin master). */
  passes: number
  /** true si quedo a +-toleranceLu del objetivo y con el pico real bajo el techo. */
  converged: boolean
  summary: string
}

/** Tolerancia de sonoridad de la calibracion (LU). */
export const AUTO_MASTER_TOLERANCE_LU = 0.5
/** Renders con la cadena como maximo. */
export const AUTO_MASTER_MAX_PASSES = 3
/** Cuanto puede bajar el techo del limitador por debajo del techo del perfil para contener el pico real. */
const MAX_CEILING_DROP_DB = 3

/** La sesion sin la cadena del master (ni su volumen): el punto de partida de la calibracion. */
export function sessionWithoutMasterChain(session: StudioSession): StudioSession {
  return { ...session, master: { ...session.master, fx: [], volumeDb: 0 } }
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/** Ganancia explicita de la cadena: volumen del master + makeup del compresor. */
function masterGainOf(master: StudioMaster): number {
  const comp = master.fx.find((fx) => fx.type === 'compressor')
  return master.volumeDb + (comp && comp.type === 'compressor' ? comp.params.makeupDb : 0)
}

function withMasterGain(master: StudioMaster, totalDb: number): StudioMaster {
  const { volumeDb, makeupDb } = splitMasterGain(totalDb)
  return {
    ...master,
    volumeDb,
    fx: master.fx.map((fx) => (fx.type === 'compressor' ? { ...fx, params: { ...fx.params, makeupDb } } : fx)),
  }
}

function withLimiterCeiling(master: StudioMaster, ceilingDb: number): StudioMaster {
  return {
    ...master,
    fx: master.fx.map((fx) => (fx.type === 'limiter' ? { ...fx, params: { ...fx.params, ceilingDb: round1(Math.max(-12, Math.min(0, ceilingDb))) } } : fx)),
  }
}

function limiterCeilingOf(master: StudioMaster, fallback: number): number {
  const limiter = master.fx.find((fx) => fx.type === 'limiter')
  return limiter && limiter.type === 'limiter' ? limiter.params.ceilingDb : fallback
}

/**
 * Calibra Auto-Master midiendo: render sin master -> cadena inicial -> hasta
 * AUTO_MASTER_MAX_PASSES renders con la cadena, corrigiendo el volumen del master (antes del
 * limitador) por el error de LUFS (secante entre vueltas: el limitador hace la relacion menor a
 * 1:1) y el techo del limitador por el exceso de pico real. Idempotente: parte siempre de la
 * mezcla sin master. Lanza si la mezcla esta en silencio.
 */
export async function calibrateAutoMaster(
  session: StudioSession,
  input: Omit<AutoMasterInput, 'measuredLufs' | 'measuredBarkDb'>,
  measure: AutoMasterMeasure,
  options: { maxPasses?: number; toleranceLu?: number } = {},
): Promise<AutoMasterCalibration> {
  const maxPasses = Math.max(1, Math.min(6, options.maxPasses ?? AUTO_MASTER_MAX_PASSES))
  const tolerance = Math.max(0.1, options.toleranceLu ?? AUTO_MASTER_TOLERANCE_LU)
  const pre = await measure(sessionWithoutMasterChain(session), 0)
  if (!Number.isFinite(pre.lufs) || pre.lufs <= -65) {
    throw new Error('La mezcla está en silencio (o casi): no hay nada que masterizar.')
  }
  const initial = computeAutoMaster(session.master, { ...input, measuredLufs: pre.lufs, measuredBarkDb: pre.barkDb ?? null })
  const target = initial.targetLufs
  const ceiling = initial.ceilingDb
  let master = initial.master
  let measured: AutoMasterMeasurement = { lufs: Number.NEGATIVE_INFINITY, truePeakDb: Number.NEGATIVE_INFINITY }
  let previous: { gainDb: number; lufs: number } | null = null
  let passes = 0
  let converged = false

  for (let pass = 1; pass <= maxPasses; pass++) {
    measured = await measure({ ...session, master }, pass)
    passes = pass
    const lufsError = target - measured.lufs
    const tpExcess = measured.truePeakDb - ceiling
    if (Number.isFinite(measured.lufs) && Math.abs(lufsError) <= tolerance && tpExcess <= 0.05) {
      converged = true
      break
    }
    if (pass === maxPasses || !Number.isFinite(measured.lufs)) break

    // Pico real: bajar el techo del limitador lo que se paso (+0,1 dB de margen).
    if (tpExcess > 0.05) {
      const current = limiterCeilingOf(master, ceiling)
      master = withLimiterCeiling(master, Math.max(ceiling - MAX_CEILING_DROP_DB, current - tpExcess - 0.1))
    }
    // Sonoridad: el volumen del master empuja al limitador. Relacion 1:1 en la primera vuelta;
    // despues, la pendiente medida entre las dos ultimas (acotada: con el limitador trabajando,
    // subir 1 dB rinde menos de 1 LU).
    const gain = masterGainOf(master)
    let slope = 1
    if (previous && Math.abs(gain - previous.gainDb) > 0.05) {
      const s = (measured.lufs - previous.lufs) / (gain - previous.gainDb)
      if (Number.isFinite(s)) slope = Math.max(0.25, Math.min(1.5, s))
    }
    previous = { gainDb: gain, lufs: measured.lufs }
    const step = Math.max(-12, Math.min(12, lufsError / slope))
    master = withMasterGain(master, gain + step)
  }

  const spec = AUTO_MASTER_PROFILES[input.profile] ?? AUTO_MASTER_PROFILES.streaming
  const limiterCeilingDb = limiterCeilingOf(master, ceiling)
  const lufsText = Number.isFinite(measured.lufs) ? measured.lufs.toFixed(1) : '-inf'
  const tpText = Number.isFinite(measured.truePeakDb) ? measured.truePeakDb.toFixed(1) : '-inf'
  const head = `Auto-Master "${spec.label}": medido ${lufsText} LUFS (objetivo ${target}) y pico real ${tpText} dBTP (techo ${ceiling}, medidor x4 sobre el render).`
  const limiterNote = limiterCeilingDb < ceiling ? ` El limitador trabaja sobre pico de muestra: su techo quedó en ${limiterCeilingDb} dB para contener el pico real.` : ''
  const tail = converged
    ? ''
    : ` No convergió en ${passes} ${passes === 1 ? 'vuelta' : 'vueltas'}: ${Math.abs(target - measured.lufs) > tolerance ? `la sonoridad quedó a ${Math.abs(target - measured.lufs).toFixed(1)} LU del objetivo` : 'el pico real sigue por encima del techo'}.`
  return {
    master,
    targetLufs: target,
    ceilingDb: ceiling,
    limiterCeilingDb,
    preMasterLufs: pre.lufs,
    measured,
    passes,
    converged,
    summary: head + limiterNote + tail,
  }
}
