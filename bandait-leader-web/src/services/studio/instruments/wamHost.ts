/**
 * Anfitrion de plugins WAM 2.0 (STUDIO_V2.md 2.3.4) con LISTA CERRADA.
 *
 * Solo se cargan plugins empaquetados con el Hub, por un import estatico del propio bundle. Nunca
 * codigo desde una URL: el documento no trae URL y ningun camino de este modulo acepta una. Un
 * `plugin_id` fuera de la lista deja el instrumento "no disponible" y suena el congelado.
 *
 * Estado en esta etapa: la lista esta VACIA. El SDK oficial (@webaudiomodules/sdk 0.0.12 y
 * @webaudiomodules/api 2.0.0-alpha.6, MIT segun npm) no se instalo: son versiones previas a una
 * estable y, con la lista vacia, serian codigo muerto en el bundle. Se instala y se verifica junto
 * con el primer plugin aprobado.
 *
 * Contrato con cada plugin de la lista: `loadModule()` importa un modulo PROPIO del Hub (un
 * envoltorio escrito al aprobar el plugin) que exporta `createInstance(ctx, state)` y devuelve un
 * objeto con la forma de `WamInstanceLike`. El envoltorio es el unico lugar que habla con el SDK.
 */
import { STUDIO_MAX_WAM_STATE_BYTES, STUDIO_WAM_PLUGIN_ID_RE, type StudioInstrument } from '../session.ts'
import type { InstrumentAvailability, StudioInstrumentNode, WamHostApi, WamPluginDescriptor } from '../types.ts'

/**
 * La lista cerrada. Agregar un plugin exige verificar su licencia (MIT, Apache-2.0, BSD),
 * empaquetarlo con el Hub y escribir su envoltorio; no cambia el contrato del documento.
 */
export const STUDIO_WAM_PLUGINS: readonly WamPluginDescriptor[] = []

/** Lo que devuelve el envoltorio de un plugin aprobado. */
export interface WamInstanceLike {
  /** Salida de audio del plugin. */
  readonly audioNode: AudioNode
  /** Nota en el reloj del contexto: 0x90 (note-on) o 0x80 (note-off), pitch y velocidad. */
  sendMidi(bytes: readonly [number, number, number], when: number): void
  /** Corta lo que suena (todas las notas apagadas). */
  allNotesOff(when: number): void
  getState(): Promise<Record<string, unknown>>
  setState(state: Readonly<Record<string, unknown>>): Promise<void>
  destroy(): void
}

interface WamModuleLike {
  createInstance(ctx: BaseAudioContext, state: Readonly<Record<string, unknown>>): Promise<WamInstanceLike>
}

export function listPlugins(): readonly WamPluginDescriptor[] {
  return STUDIO_WAM_PLUGINS
}

function findPlugin(pluginId: string): WamPluginDescriptor | null {
  return STUDIO_WAM_PLUGINS.find((p) => p.id === pluginId) ?? null
}

export function pluginAvailability(pluginId: string): InstrumentAvailability {
  if (typeof pluginId !== 'string' || !STUDIO_WAM_PLUGIN_ID_RE.test(pluginId)) {
    return { available: false, reason: 'El identificador del plugin no es válido.' }
  }
  if (!findPlugin(pluginId)) return { available: false, reason: 'El plugin no está en la lista de este Hub.' }
  return { available: true, reason: null }
}

function isWamModule(value: unknown): value is WamModuleLike {
  return typeof value === 'object' && value !== null && typeof (value as { createInstance?: unknown }).createInstance === 'function'
}

/**
 * Adapta una instancia del envoltorio a StudioInstrumentNode. NO VERIFICADO: no hay ningun plugin
 * aprobado con el que probarlo; la forma de WamInstanceLike es la que fija este Hub, no el SDK.
 */
function adaptWamInstance(instance: WamInstanceLike, ctx: BaseAudioContext): StudioInstrumentNode & { readonly instance: WamInstanceLike } {
  const output = ctx.createGain()
  instance.audioNode.connect(output)
  const sounding = new Map<number, number>()
  let disposed = false
  const clampByte = (v: number) => Math.max(0, Math.min(127, Math.round(v)))
  return {
    type: 'wam',
    output,
    polyphony: 32,
    instance,
    noteOn(pitch, velocity, when) {
      if (disposed) return
      const p = clampByte(pitch)
      instance.sendMidi([0x90, p, Math.max(1, clampByte(velocity))], when)
      sounding.set(p, (sounding.get(p) ?? 0) + 1)
    },
    noteOff(pitch, when) {
      if (disposed) return
      const p = clampByte(pitch)
      instance.sendMidi([0x80, p, 0], when)
      const left = (sounding.get(p) ?? 1) - 1
      if (left > 0) sounding.set(p, left)
      else sounding.delete(p)
    },
    playNote(pitch, velocity, startTime, endTime) {
      if (disposed || !(endTime > startTime)) return
      const p = clampByte(pitch)
      instance.sendMidi([0x90, p, Math.max(1, clampByte(velocity))], startTime)
      instance.sendMidi([0x80, p, 0], endTime)
    },
    allNotesOff(when) {
      if (disposed) return
      sounding.clear()
      instance.allNotesOff(when ?? ctx.currentTime)
    },
    update(next: StudioInstrument) {
      // El estado de un plugin no se aplica en caliente: quien llama reconstruye el instrumento.
      void next
      return false
    },
    activeVoices() {
      let n = 0
      for (const count of sounding.values()) n += count
      return n
    },
    dispose() {
      if (disposed) return
      disposed = true
      try {
        instance.audioNode.disconnect()
      } catch {
        // ya desconectado
      }
      output.disconnect()
      instance.destroy()
    },
  }
}

export async function createWamInstrument(ctx: BaseAudioContext, pluginId: string, state: Readonly<Record<string, unknown>>): Promise<StudioInstrumentNode> {
  const availability = pluginAvailability(pluginId)
  const plugin = findPlugin(pluginId)
  if (!availability.available || !plugin) throw new Error(availability.reason ?? 'El plugin no está en la lista de este Hub.')
  let module: unknown
  try {
    module = await plugin.loadModule()
  } catch {
    throw new Error(`No se pudo cargar el plugin «${plugin.name}».`)
  }
  if (!isWamModule(module)) throw new Error(`El plugin «${plugin.name}» no tiene la forma que espera el Estudio.`)
  let instance: WamInstanceLike
  try {
    instance = await module.createInstance(ctx, state)
  } catch {
    throw new Error(`El plugin «${plugin.name}» no arrancó en este navegador.`)
  }
  return adaptWamInstance(instance, ctx)
}

export async function getWamState(node: StudioInstrumentNode): Promise<Record<string, unknown>> {
  const instance = (node as { instance?: WamInstanceLike }).instance
  if (node.type !== 'wam' || !instance) throw new Error('Ese instrumento no es un plugin web.')
  const state = await instance.getState()
  const bytes = new TextEncoder().encode(JSON.stringify(state)).length
  if (bytes > STUDIO_MAX_WAM_STATE_BYTES) throw new Error('El estado del plugin pasa de 16 KB: no se puede guardar en la sesión.')
  return state
}

void ({ listPlugins, pluginAvailability, createWamInstrument, getWamState } satisfies WamHostApi)
