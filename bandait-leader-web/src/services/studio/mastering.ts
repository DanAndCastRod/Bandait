/**
 * Cadena de Masterizacion DSP Local Instantanea (Cero Cuota IA).
 *
 * Construye y calibra la cadena completa del Bus Master (`eq` -> `compressor` glue -> `saturator`
 * tape -> `stereo_imager` con graves en mono -> `limiter` True Peak) a partir de la sonoridad
 * BS.1770 medida (o estimada) y del perfil de destino:
 *   - `streaming`:   -14,0 LUFS, techo -1,0 dBTP (Spotify / YouTube / Apple Music)
 *   - `club`:        -11,0 LUFS, techo -0,8 dBTP (pegada grave y densidad alta)
 *   - `live_stage`:   -9,0 LUFS, techo -0,5 dBTP (consistencia para PA / In-Ear en vivo)
 *   - `dynamic`:     -16,0 LUFS, techo -1,0 dBTP (acustico / jazz / alto rango dinamico)
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
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
    description: 'Calibrado para Spotify, Apple Music y YouTube con techo seguro en -1.0 dBTP.',
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

  // Ganancia hacia el objetivo LUFS repartida entre makeup del compresor y fader del master.
  const totalDeltaDb =
    typeof input.measuredLufs === 'number' && Number.isFinite(input.measuredLufs) && input.measuredLufs > -65
      ? Math.max(-12, Math.min(18, targetLufs - input.measuredLufs))
      : Math.max(0, Math.min(8, (targetLufs - -18) * 0.65))

  const compMakeupDb = Math.round(Math.max(0, Math.min(12, totalDeltaDb * 0.6 + 1.2)) * 10) / 10
  const residualFaderDb = Math.round(
    Math.max(STUDIO_VOLUME_DB_MIN, Math.min(STUDIO_VOLUME_DB_MAX, totalDeltaDb - (compMakeupDb - 1.2))) * 10,
  ) / 10

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
        thresholdDb: -16,
        ratio: spec.glueRatio,
        attackMs: 25,
        releaseMs: 140,
        kneeDb: 6,
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
    appliedMakeupDb: Math.round((compMakeupDb + residualFaderDb) * 10) / 10,
    summary: `Auto-Master "${spec.label}" aplicado (${targetLufs} LUFS, techo ${spec.ceilingDb} dBTP, graves mono < ${spec.monoBassHz} Hz).`,
  }
}

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
