/**
 * Instrumentos del Estudio v2 (STUDIO_V2.md 2.3): synth, drums, sampler y anfitrion WAM con
 * lista cerrada. Implementa InstrumentsApi de types.ts.
 *
 *   core.ts      logica pura (frecuencias, envolventes, robo de voz, ruido con semilla, notas
 *                que suenan en un tramo, caja de ritmos, sampler). Se prueba con node.
 *   voices.ts    voces, pool con robo y la clase base PolyInstrument.
 *   synth.ts, drums.ts, sampler.ts   cada instrumento, con nodos nativos.
 *   noise.ts     bufer de ruido con semilla, uno por contexto.
 *   wamHost.ts   anfitrion WAM 2.0 (STUDIO_WAM_PLUGINS, hoy vacia).
 *   factory.ts   createInstrument, instrumentAvailability, prepareInstruments.
 *   schedule.ts  scheduleMidiClips (notas y congelados contra el grafo).
 *
 * Se importa solo desde el Estudio (graph, engine, bounce y componentes del Estudio), que se carga
 * aparte: nada de esto entra al arranque del Hub.
 */
import type { InstrumentsApi } from '../types.ts'
import { noteFrequency, pickVoiceToSteal } from './core.ts'
import { createInstrument, instrumentAvailability, prepareInstruments } from './factory.ts'
import { scheduleMidiClips } from './schedule.ts'

export * from './core.ts'
export { EMPTY_PREPARATION, createInstrument, instrumentAvailability, needsPreparation, prepareInstruments, releaseInstruments } from './factory.ts'
export { MIDI_LOOKAHEAD_S, MIDI_TICK_MS, OFFLINE_CHUNK_S, frozenPlaybackSession, scheduleMidiClips } from './schedule.ts'
export { PolyInstrument, Voice, VoicePool } from './voices.ts'
export { STUDIO_WAM_PLUGINS, createWamInstrument, getWamState, listPlugins, pluginAvailability, type WamInstanceLike } from './wamHost.ts'

void ({ prepareInstruments, instrumentAvailability, createInstrument, pickVoiceToSteal, noteFrequency, scheduleMidiClips } satisfies InstrumentsApi)
