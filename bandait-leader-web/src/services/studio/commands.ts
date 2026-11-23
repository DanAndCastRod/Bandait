/**
 * Registro unico de comandos del Estudio Bandait (docs/PLAN_ESTUDIO_V2.md, seccion 6). La
 * interfaz, el teclado, la paleta (Ctrl+K) y el chat llaman al MISMO registro. Contrato: types.ts,
 * seccion "v2 · commands.ts"; herramientas del asistente: STUDIO_V2.md 4.3.3 y
 * bandait-protocol/fixtures/studio_chat_tools_v2.json.
 *
 * Como se usa:
 *   - STUDIO_COMMAND_SPECS describe cada comando (id, nombre, categoria, atajos por defecto,
 *     contexto, herramienta del asistente) sin la accion. La vista arma los comandos con
 *     buildStudioCommands(handlers): un comando sin handler no se registra.
 *   - El teclado usa matchEvent con los comandos y el keymap de loadKeymap; la paleta usa
 *     registry.list() y displayShortcut; el chat usa registry.forAssistantTool(name).
 *
 * Decisiones que el plan no fija:
 *   - Los comandos de edicion del teclado (copiar, cortar, pegar, duplicar, borrar, dividir,
 *     cuantizar, seleccionar todo) son globales: la accion decide segun el contexto activo (clips
 *     en la linea de tiempo, notas en el piano roll). Asi un atajo no queda repetido por vista.
 *   - Las herramientas del asistente que operan sobre un clip por id son comandos aparte, sin
 *     atajo (clip.split, clip.duplicate, midi.quantize...): reciben sus argumentos del chat.
 *   - Flechas: en la linea de tiempo mueven el clip en la rejilla (izquierda y derecha) y cambian
 *     de pista (arriba y abajo); en el piano roll transponen (Shift = octava) y mueven en la rejilla.
 *   - Atajos de DAW (2026-11-22, docs/PLAN_ESTUDIO_V2.md seccion 6): los comandos nuevos van al
 *     final de cada bloque. Las letras de la fila del teclado musical (A..K, Z, X) solas no se
 *     usan para comandos nuevos: con el teclado musical encendido serian notas. Por eso Shift+T,
 *     Shift+Z, Shift+M, etc. Ctrl+J queda reservado para el asistente.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import {
  defaultKeymap,
  displayShortcut,
  findConflicts,
  formatShortcut,
  loadKeymap,
  matchEvent,
  normalizeShortcut,
  parseShortcut,
  resetKeymap,
  saveKeymap,
  shortcutFromEvent,
} from './keymap.ts'
import type { AssistantToolName, CommandCategory, CommandContext, CommandRegistry, CommandsApi, StudioCommand } from './types.ts'

export {
  KEYMAP_STORAGE_KEY,
  commandShortcuts,
  contextsOverlap,
  defaultKeymap,
  displayShortcut,
  findConflicts,
  formatShortcut,
  loadKeymap,
  matchEvent,
  normalizeShortcut,
  parseShortcut,
  resetKeymap,
  saveKeymap,
  shortcutFromEvent,
  type KeymapCommand,
} from './keymap.ts'

/** Descripcion de un comando sin su accion. */
export type StudioCommandSpec = Omit<StudioCommand<unknown>, 'run' | 'isEnabled'>

function spec<Id extends string>(
  id: Id,
  label: string,
  category: CommandCategory,
  context: CommandContext,
  defaultShortcuts: readonly string[],
  assistantTool: AssistantToolName | null = null,
): StudioCommandSpec & { id: Id } {
  return { id, label, category, context, defaultShortcuts, assistantAllowed: assistantTool !== null, assistantTool }
}

const SPECS = [
  // Transporte
  spec('transport.play_pause', 'Reproducir y parar', 'transporte', 'global', ['Space']),
  spec('transport.record', 'Grabar', 'transporte', 'global', ['R']),
  spec('transport.go_to_start', 'Ir al inicio', 'transporte', 'global', ['Enter', 'Home']),
  spec('transport.toggle_loop', 'Activar o desactivar el loop', 'transporte', 'global', ['L']),
  spec('transport.toggle_click', 'Activar o desactivar el clic', 'transporte', 'global', ['C']),
  spec('transport.go_to_end', 'Ir al final', 'transporte', 'global', ['End']),
  spec('transport.bar_back', 'Retroceder un compás', 'transporte', 'global', [',']),
  spec('transport.bar_forward', 'Avanzar un compás', 'transporte', 'global', ['.']),
  spec('transport.prev_marker', 'Ir a la marca anterior', 'transporte', 'global', ['Ctrl+ArrowLeft']),
  spec('transport.next_marker', 'Ir a la marca siguiente', 'transporte', 'global', ['Ctrl+ArrowRight']),
  spec('transport.loop_selection', 'Loop con el rango de la selección', 'transporte', 'global', ['Ctrl+L']),
  spec('transport.tap_tempo', 'Tap tempo', 'transporte', 'global', ['Shift+T']),
  spec('transport.toggle_count_in', 'Activar o quitar el conteo previo', 'transporte', 'global', ['Shift+K']),
  // Edicion (la accion decide segun el contexto activo)
  spec('edit.undo', 'Deshacer', 'edicion', 'global', ['Ctrl+Z']),
  spec('edit.redo', 'Rehacer', 'edicion', 'global', ['Ctrl+Y', 'Ctrl+Shift+Z']),
  spec('edit.copy', 'Copiar', 'edicion', 'global', ['Ctrl+C']),
  spec('edit.cut', 'Cortar', 'edicion', 'global', ['Ctrl+X']),
  spec('edit.paste', 'Pegar', 'edicion', 'global', ['Ctrl+V']),
  spec('edit.duplicate', 'Duplicar la selección', 'edicion', 'global', ['Ctrl+D']),
  spec('edit.delete', 'Borrar la selección', 'edicion', 'global', ['Delete', 'Backspace']),
  spec('edit.select_all', 'Seleccionar todo', 'edicion', 'global', ['Ctrl+A']),
  spec('edit.split', 'Dividir en el cabezal', 'edicion', 'global', ['S']),
  spec('edit.quantize', 'Cuantizar la selección', 'edicion', 'global', ['Q']),
  // Ctrl+J queda para el asistente; Ctrl+Shift+J es "unir" (Ctrl+J en Ableton y Logic).
  spec('edit.join', 'Unir clips', 'edicion', 'timeline', ['Ctrl+Shift+J']),
  // Pistas
  spec('track.toggle_mute', 'Mute de la pista seleccionada', 'pistas', 'global', ['M']),
  spec('track.toggle_solo', 'Solo de la pista seleccionada', 'pistas', 'global', ['Shift+S']),
  spec('track.add_audio', 'Pista de audio nueva', 'pistas', 'global', ['Ctrl+T'], 'add_audio_track'),
  spec('track.add_instrument', 'Pista de instrumento nueva', 'pistas', 'global', ['Ctrl+Shift+T'], 'add_instrument_track'),
  spec('track.remove', 'Quitar una pista', 'pistas', 'global', [], 'remove_track'),
  spec('track.select_prev', 'Pista anterior', 'pistas', 'timeline', ['ArrowUp']),
  spec('track.select_next', 'Pista siguiente', 'pistas', 'timeline', ['ArrowDown']),
  spec('track.toggle_arm', 'Armar la pista seleccionada para grabar', 'pistas', 'global', ['Shift+R']),
  spec('track.rename', 'Renombrar la pista seleccionada', 'pistas', 'global', ['F2']),
  spec('track.duplicate', 'Duplicar la pista seleccionada', 'pistas', 'global', ['Ctrl+Shift+D']),
  spec('track.move_up', 'Subir la pista seleccionada', 'pistas', 'timeline', ['Alt+ArrowUp']),
  spec('track.move_down', 'Bajar la pista seleccionada', 'pistas', 'timeline', ['Alt+ArrowDown']),
  // 1..9 eligen pista solo en la linea de tiempo: en el piano roll, 1..5 son las herramientas.
  spec('track.select_1', 'Elegir la pista 1', 'pistas', 'timeline', ['1']),
  spec('track.select_2', 'Elegir la pista 2', 'pistas', 'timeline', ['2']),
  spec('track.select_3', 'Elegir la pista 3', 'pistas', 'timeline', ['3']),
  spec('track.select_4', 'Elegir la pista 4', 'pistas', 'timeline', ['4']),
  spec('track.select_5', 'Elegir la pista 5', 'pistas', 'timeline', ['5']),
  spec('track.select_6', 'Elegir la pista 6', 'pistas', 'timeline', ['6']),
  spec('track.select_7', 'Elegir la pista 7', 'pistas', 'timeline', ['7']),
  spec('track.select_8', 'Elegir la pista 8', 'pistas', 'timeline', ['8']),
  spec('track.select_9', 'Elegir la pista 9', 'pistas', 'timeline', ['9']),
  // Linea de tiempo
  spec('clip.nudge_left', 'Mover el clip a la izquierda en la rejilla', 'edicion', 'timeline', ['ArrowLeft']),
  spec('clip.nudge_right', 'Mover el clip a la derecha en la rejilla', 'edicion', 'timeline', ['ArrowRight']),
  spec('clip.move', 'Mover un clip', 'edicion', 'timeline', [], 'move_clip'),
  spec('clip.duplicate', 'Duplicar un clip', 'edicion', 'timeline', [], 'duplicate_clip'),
  spec('clip.split', 'Dividir un clip', 'edicion', 'timeline', [], 'split_clip'),
  spec('clip.delete', 'Borrar un clip', 'edicion', 'timeline', [], 'delete_clip'),
  spec('clip.set_gain', 'Ganancia de un clip', 'edicion', 'timeline', [], 'set_clip_gain'),
  // 0 y no Shift+M (Shift+M es "agregar marca"): como "desactivar clip" de Ableton.
  spec('clip.toggle_mute', 'Silenciar o hacer sonar el clip', 'edicion', 'timeline', ['0']),
  spec('clip.trim_start', 'Recortar el inicio del clip al cabezal', 'edicion', 'timeline', ['Alt+[']),
  spec('clip.trim_end', 'Recortar el final del clip al cabezal', 'edicion', 'timeline', ['Alt+]']),
  spec('clip.fade_in', 'Fundido de entrada hasta el cabezal', 'edicion', 'timeline', []),
  spec('clip.fade_out', 'Fundido de salida desde el cabezal', 'edicion', 'timeline', []),
  // Piano roll
  spec('notes.transpose_up', 'Subir un semitono', 'midi', 'piano_roll', ['ArrowUp']),
  spec('notes.transpose_down', 'Bajar un semitono', 'midi', 'piano_roll', ['ArrowDown']),
  spec('notes.octave_up', 'Subir una octava', 'midi', 'piano_roll', ['Shift+ArrowUp']),
  spec('notes.octave_down', 'Bajar una octava', 'midi', 'piano_roll', ['Shift+ArrowDown']),
  spec('notes.nudge_left', 'Mover las notas a la izquierda en la rejilla', 'midi', 'piano_roll', ['ArrowLeft']),
  spec('notes.nudge_right', 'Mover las notas a la derecha en la rejilla', 'midi', 'piano_roll', ['ArrowRight']),
  spec('notes.legato', 'Legato', 'midi', 'piano_roll', ['Shift+L']),
  spec('tool.select', 'Herramienta seleccionar', 'herramientas', 'piano_roll', ['1']),
  spec('tool.draw', 'Herramienta dibujar', 'herramientas', 'piano_roll', ['2']),
  spec('tool.erase', 'Herramienta borrar', 'herramientas', 'piano_roll', ['3']),
  spec('tool.cut', 'Herramienta cortar nota', 'herramientas', 'piano_roll', ['4']),
  spec('tool.velocity', 'Herramienta velocidad', 'herramientas', 'piano_roll', ['5']),
  spec('notes.invert_selection', 'Invertir la selección de notas', 'midi', 'piano_roll', ['Ctrl+I']),
  spec('notes.velocity_up', 'Subir la velocidad de las notas', 'midi', 'piano_roll', ['Alt+ArrowUp']),
  spec('notes.velocity_down', 'Bajar la velocidad de las notas', 'midi', 'piano_roll', ['Alt+ArrowDown']),
  spec('notes.lengthen', 'Alargar las notas un paso de la rejilla', 'midi', 'piano_roll', ['Shift+ArrowRight']),
  spec('notes.shorten', 'Acortar las notas un paso de la rejilla', 'midi', 'piano_roll', ['Shift+ArrowLeft']),
  // MIDI e instrumentos (asistente)
  spec('midi.add_clip', 'Agregar un clip MIDI', 'midi', 'timeline', [], 'add_midi_clip'),
  spec('midi.replace_notes', 'Reemplazar las notas de un clip MIDI', 'midi', 'piano_roll', [], 'replace_midi_notes'),
  spec('midi.transpose', 'Transponer un clip MIDI', 'midi', 'piano_roll', [], 'transpose_midi_clip'),
  spec('midi.quantize', 'Cuantizar un clip MIDI', 'midi', 'piano_roll', [], 'quantize_midi_clip'),
  spec('midi.toggle_computer_keyboard', 'Teclado de la computadora como teclado musical', 'midi', 'global', []),
  spec('instrument.set', 'Cambiar el preset o los parámetros del instrumento', 'midi', 'global', [], 'set_instrument'),
  // Mezcla (asistente)
  spec('track.set_mix', 'Mezcla de una pista', 'mezcla', 'mixer', [], 'set_track_mix'),
  spec('track.set_fx', 'Efecto de una pista o del master', 'mezcla', 'mixer', [], 'set_track_fx'),
  spec('master.set', 'Master y reverb compartida', 'mezcla', 'mixer', [], 'set_master'),
  spec('session.set_meta', 'Título, tempo, tonalidad y compás de la sesión', 'archivo', 'global', [], 'set_session_meta'),
  // Marcas
  spec('marker.add', 'Agregar una marca', 'marcas', 'global', [], 'add_marker'),
  spec('marker.remove', 'Quitar una marca', 'marcas', 'global', [], 'remove_marker'),
  // Shift+M y no M: M es el mute de la pista.
  spec('marker.add_here', 'Agregar una marca en el cabezal', 'marcas', 'global', ['Shift+M']),
  // Vista
  spec('view.zoom_in', 'Acercar', 'vista', 'global', ['Plus']),
  spec('view.zoom_out', 'Alejar', 'vista', 'global', ['Minus']),
  // E y no Tab: Tab es la navegacion del teclado y el Estudio nunca se la quita al navegador.
  spec('view.toggle_editor', 'Alternar línea de tiempo y piano roll', 'vista', 'global', ['E']),
  spec('view.command_palette', 'Paleta de comandos', 'vista', 'global', ['Ctrl+K']),
  spec('view.shortcuts', 'Hoja de atajos', 'vista', 'global', ['?']),
  spec('view.zoom_fit', 'Ver toda la sesión', 'vista', 'global', ['Shift+Z']),
  spec('view.center_playhead', 'Centrar la vista en el cabezal', 'vista', 'global', ['Shift+C']),
  spec('view.toggle_assistant', 'Mostrar u ocultar el asistente', 'vista', 'global', ['Ctrl+J']),
  // Archivo
  spec('file.save_cloud', 'Guardar en la nube', 'archivo', 'global', ['Ctrl+S']),
  spec('file.export', 'Exportar', 'archivo', 'global', ['Ctrl+E']),
  spec('file.import_midi', 'Importar un archivo MIDI', 'archivo', 'global', []),
  spec('file.export_midi', 'Exportar a archivo MIDI', 'archivo', 'global', []),
] as const

/** Ids de los comandos del Estudio. */
export type StudioCommandId = (typeof SPECS)[number]['id']

/** Todos los comandos del Estudio, en el orden de la paleta y la hoja de atajos. */
export const STUDIO_COMMAND_SPECS: readonly StudioCommandSpec[] = SPECS

/** Nombres de las categorias para la paleta y la hoja de atajos. */
export const STUDIO_COMMAND_CATEGORY_LABELS: Readonly<Record<CommandCategory, string>> = {
  transporte: 'Transporte',
  edicion: 'Edición',
  pistas: 'Pistas',
  herramientas: 'Herramientas',
  vista: 'Vista',
  archivo: 'Archivo',
  midi: 'MIDI',
  mezcla: 'Mezcla',
  marcas: 'Marcas',
}

/** Nombres de los contextos para la hoja de atajos. */
export const STUDIO_COMMAND_CONTEXT_LABELS: Readonly<Record<CommandContext, string>> = {
  global: 'En todo el Estudio',
  timeline: 'Línea de tiempo',
  piano_roll: 'Piano roll',
  mixer: 'Mezclador',
}

export function findCommandSpec(id: string): StudioCommandSpec | null {
  return STUDIO_COMMAND_SPECS.find((c) => c.id === id) ?? null
}

/** Accion de un comando que arma la vista. */
export interface StudioCommandHandler<Ctx> {
  run: StudioCommand<Ctx>['run']
  isEnabled?: (ctx: Ctx) => boolean
}

/** Comandos completos: cada spec con su handler. Un spec sin handler queda fuera. */
export function buildStudioCommands<Ctx>(handlers: Partial<Record<StudioCommandId, StudioCommandHandler<Ctx>>>): StudioCommand<Ctx>[] {
  const out: StudioCommand<Ctx>[] = []
  for (const s of SPECS) {
    const h = handlers[s.id]
    if (!h) continue
    const command: StudioCommand<Ctx> = { ...s, run: h.run }
    if (h.isEnabled) command.isEnabled = h.isEnabled
    out.push(command)
  }
  return out
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

export function createCommandRegistry<Ctx>(): CommandRegistry<Ctx> {
  const commands: StudioCommand<Ctx>[] = []
  const byId = new Map<string, StudioCommand<Ctx>>()

  return {
    register(command: StudioCommand<Ctx>): void {
      if (typeof command.id !== 'string' || command.id === '') throw new Error('El comando no tiene id')
      if (byId.has(command.id)) throw new Error(`El comando "${command.id}" ya está registrado`)
      if (command.assistantAllowed !== (command.assistantTool !== null)) {
        throw new Error(`El comando "${command.id}" declara mal su herramienta del asistente`)
      }
      for (const s of command.defaultShortcuts) {
        if (normalizeShortcut(s) !== s) throw new Error(`El atajo "${s}" del comando "${command.id}" no está en forma canónica`)
      }
      commands.push(command)
      byId.set(command.id, command)
    },
    get(id: string): StudioCommand<Ctx> | null {
      return byId.get(id) ?? null
    },
    list(): readonly StudioCommand<Ctx>[] {
      return commands.slice()
    },
    forContext(context: CommandContext): readonly StudioCommand<Ctx>[] {
      return commands.filter((c) => c.context === context || c.context === 'global')
    },
    forAssistantTool(name: string): StudioCommand<Ctx> | null {
      return commands.find((c) => c.assistantAllowed && c.assistantTool === name) ?? null
    },
    async run(id: string, ctx: Ctx, args?: Readonly<Record<string, unknown>>): Promise<void> {
      const command = byId.get(id)
      if (!command) throw new Error(`Comando desconocido: "${id}"`)
      if (command.isEnabled && !command.isEnabled(ctx)) throw new Error(`"${command.label}" no está disponible ahora`)
      await command.run(ctx, args)
    },
  }
}

/** Registro con todos los comandos que tienen handler. */
export function createStudioRegistry<Ctx>(handlers: Partial<Record<StudioCommandId, StudioCommandHandler<Ctx>>>): CommandRegistry<Ctx> {
  const registry = createCommandRegistry<Ctx>()
  for (const command of buildStudioCommands(handlers)) registry.register(command)
  return registry
}

void ({
  createCommandRegistry,
  parseShortcut,
  formatShortcut,
  displayShortcut,
  shortcutFromEvent,
  defaultKeymap,
  findConflicts,
  loadKeymap,
  saveKeymap,
  resetKeymap,
  matchEvent,
} satisfies CommandsApi)
