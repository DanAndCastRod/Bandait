/**
 * Creacion de instrumentos y preparacion por contexto. buildGraph (graph.ts) llama a
 * `createInstrument`, que es sincrono; lo asincrono (crear plugins WAM) lo hace antes
 * `prepareInstruments`, una vez por AudioContext y por cada OfflineAudioContext de bounce.
 *
 * synth, drums y sampler usan solo nodos nativos (osciladores, filtros, ganancias, ruido con
 * semilla y AudioBufferSourceNode): no hay worklet propio que cargar, asi que `workletReady` es
 * siempre false y no cambia nada. Lo que suena es lo mismo en tiempo real y offline.
 */
import type { StudioInstrument, StudioSession } from '../session.ts'
import type { InstrumentAvailability, InstrumentPreparation, StudioBuffers, StudioInstrumentNode } from '../types.ts'
import { DrumsEngine } from './drums.ts'
import { SamplerEngine } from './sampler.ts'
import { SynthEngine } from './synth.ts'
import { PolyInstrument } from './voices.ts'
import { createWamInstrument, pluginAvailability } from './wamHost.ts'

/** Preparacion vacia: sin plugins WAM. Basta para synth, drums y sampler. */
export const EMPTY_PREPARATION: InstrumentPreparation = { workletReady: false, wamNodes: new Map(), unavailable: new Map() }

export function instrumentAvailability(instrument: StudioInstrument): InstrumentAvailability {
  if (instrument.type === 'wam') return pluginAvailability(instrument.pluginId)
  return { available: true, reason: null }
}

interface ContextWam {
  nodes: Map<string, StudioInstrumentNode>
  pluginOf: Map<string, string>
  unavailable: Map<string, string>
}

const wamByContext = new WeakMap<BaseAudioContext, ContextWam>()

/**
 * Crea los plugins WAM que usa la sesion en `ctx` (los de synth, drums y sampler no necesitan
 * nada). Idempotente por contexto: un plugin ya creado para esa pista se reutiliza; si la pista
 * cambio de plugin, se libera el anterior.
 */
export async function prepareInstruments(ctx: BaseAudioContext, session: StudioSession): Promise<InstrumentPreparation> {
  let state = wamByContext.get(ctx)
  if (!state) {
    state = { nodes: new Map(), pluginOf: new Map(), unavailable: new Map() }
    wamByContext.set(ctx, state)
  }
  const wanted = new Map<string, StudioInstrument & { type: 'wam' }>()
  for (const track of session.tracks) {
    if (track.kind === 'instrument' && track.instrument?.type === 'wam') wanted.set(track.id, track.instrument)
  }
  for (const [trackId, node] of [...state.nodes]) {
    const instrument = wanted.get(trackId)
    if (!instrument || state.pluginOf.get(trackId) !== instrument.pluginId) {
      node.dispose()
      state.nodes.delete(trackId)
      state.pluginOf.delete(trackId)
    }
  }
  state.unavailable.clear()
  for (const [trackId, instrument] of wanted) {
    if (state.nodes.has(trackId)) continue
    const availability = pluginAvailability(instrument.pluginId)
    if (!availability.available) {
      state.unavailable.set(trackId, availability.reason ?? 'El plugin no está disponible.')
      continue
    }
    try {
      const node = await createWamInstrument(ctx, instrument.pluginId, instrument.state)
      state.nodes.set(trackId, node)
      state.pluginOf.set(trackId, instrument.pluginId)
    } catch (error) {
      state.unavailable.set(trackId, error instanceof Error ? error.message : 'El plugin no arrancó.')
    }
  }
  return { workletReady: false, wamNodes: new Map(state.nodes), unavailable: new Map(state.unavailable) }
}

/** true si la sesion usa un plugin WAM que `preparation` no tiene resuelto (creado o descartado). */
export function needsPreparation(session: StudioSession, preparation: InstrumentPreparation | null): boolean {
  for (const track of session.tracks) {
    if (track.kind !== 'instrument' || track.instrument?.type !== 'wam') continue
    if (!preparation || (!preparation.wamNodes.has(track.id) && !preparation.unavailable.has(track.id))) return true
  }
  return false
}

/** Libera los plugins WAM creados en `ctx` (al cerrar el motor o descartar un contexto). */
export function releaseInstruments(ctx: BaseAudioContext): void {
  const state = wamByContext.get(ctx)
  if (!state) return
  for (const node of state.nodes.values()) node.dispose()
  wamByContext.delete(ctx)
}

/**
 * Instrumento listo para conectar a la entrada de la pista, o null si no esta disponible (un WAM
 * que no esta en la lista o no arranco: suena el congelado). Para WAM devuelve el nodo de
 * `preparation`, que es de la preparacion y no del grafo.
 */
export function createInstrument(
  ctx: BaseAudioContext,
  trackId: string,
  instrument: StudioInstrument,
  buffers: StudioBuffers,
  preparation: InstrumentPreparation,
): StudioInstrumentNode | null {
  switch (instrument.type) {
    case 'synth':
      return new PolyInstrument(ctx, new SynthEngine(ctx, instrument))
    case 'drums':
      return new PolyInstrument(ctx, new DrumsEngine(ctx, instrument))
    case 'sampler':
      return new PolyInstrument(ctx, new SamplerEngine(ctx, instrument, buffers))
    case 'wam':
      return preparation.wamNodes.get(trackId) ?? null
    default:
      return null
  }
}
