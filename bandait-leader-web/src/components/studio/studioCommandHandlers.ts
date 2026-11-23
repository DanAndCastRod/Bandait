/**
 * Acciones de los comandos del Estudio (services/studio/commands.ts) sobre un StudioController.
 * Un solo registro sirve al teclado (keymap.matchEvent), a la paleta (Ctrl+K) y al chat del
 * asistente (assistantTools.applyPendingCommand): la misma accion, venga de donde venga.
 *
 * Reglas:
 *   - Cada comando que edita deja UN paso de deshacer (controller.apply). Los del asistente
 *     lanzan Error en espanol si no se pueden aplicar; quien llama lo muestra (el teclado y la
 *     paleta con un aviso, el chat como resultado 'failed' para el modelo).
 *   - Mientras se graba no se edita: los comandos de edicion quedan deshabilitados (isEnabled),
 *     igual que los botones de dividir, duplicar y borrar.
 *   - Los argumentos del asistente llegan ya validados y acotados (assistantTools.checkToolArguments),
 *     en snake_case. En clips de audio los beats se pasan a segundos con el bpm de la sesion
 *     (STUDIO_V2.md 4.3.3).
 */
import {
  createStudioRegistry,
  type StudioCommandHandler,
  type StudioCommandId,
} from '../../services/studio/commands'
import { normalizeNotes, quantize, transpose } from '../../services/studio/midiOps'
import {
  beatsToSeconds,
  defaultInstrument,
  defaultInstrumentTrack,
  defaultMidiClip,
  defaultTrack,
  drumsPresetParams,
  findClip,
  findMidiClip,
  findTrack,
  isDrumsPresetId,
  isStudioMarkerKind,
  isSynthPresetId,
  newStudioId,
  partialFxParamsFromWire,
  partialInstrumentParamsFromWire,
  roundBeat,
  STUDIO_MARKER_KIND_LABELS,
  STUDIO_MASTER_ID,
  STUDIO_MAX_MARKERS,
  STUDIO_MAX_TRACKS,
  synthPresetParams,
  type StudioFx,
  type StudioFxType,
  type StudioInstrument,
  type StudioMidiNote,
  type StudioSession,
} from '../../services/studio/session'
import {
  addInstrumentTrack,
  addMidiClip,
  addTrack,
  applyMixSuggestion,
  deleteClip,
  duplicateClip,
  duplicateMidiClip,
  moveClip,
  moveMidiClip,
  removeMidiClip,
  removeTrack,
  setClipGain,
  setInstrument,
  setMarkers,
  setTrackFx,
  splitClip,
  splitMidiClip,
  updateMaster,
  updateMidiClip,
  updateSessionMeta,
  updateTrack,
} from '../../services/studio/sessionOps'
import type { CommandRegistry, FxSuggestion, KeyValueStorage, QuantizeGrid, SessionMetaPatch, TrackPatch } from '../../services/studio/types'
import { isStemRole, type StemRole } from '../../services/stemNames'
import { downloadBlob, type StudioController } from './studioState'

/** De donde viene la orden: cambia el nombre del paso de deshacer y como se informa un error. */
export interface StudioCommandCtx {
  source: 'keyboard' | 'palette' | 'assistant'
}

/** Lo que el registro necesita de la vista (dialogos y permisos que no estan en el controlador). */
export interface StudioCommandUi {
  recordAllowed: () => boolean
  recordHint: () => string | null
  openPalette: () => void
  openShortcuts: () => void
  openExport: () => void
  pickMidiFile: () => void
  /** Muestra u oculta la ventana del asistente (Alt+A). */
  toggleAssistant: () => void
}

export type StudioRegistry = CommandRegistry<StudioCommandCtx>

/**
 * Puente mutable entre la vista y el registro: el registro se crea una sola vez y lee aqui lo que
 * cambia en cada render (permiso de grabar, dialogos). La vista lo actualiza con set() desde un
 * efecto, nunca durante el render.
 */
export class StudioUiBridge implements StudioCommandUi {
  private state: StudioCommandUi = {
    recordAllowed: () => false,
    recordHint: () => null,
    openPalette: () => {},
    openShortcuts: () => {},
    openExport: () => {},
    pickMidiFile: () => {},
    toggleAssistant: () => {},
  }

  set(patch: Partial<StudioCommandUi>): void {
    this.state = { ...this.state, ...patch }
  }

  recordAllowed(): boolean {
    return this.state.recordAllowed()
  }

  recordHint(): string | null {
    return this.state.recordHint()
  }

  openPalette(): void {
    this.state.openPalette()
  }

  openShortcuts(): void {
    this.state.openShortcuts()
  }

  openExport(): void {
    this.state.openExport()
  }

  pickMidiFile(): void {
    this.state.pickMidiFile()
  }

  toggleAssistant(): void {
    this.state.toggleAssistant()
  }
}

/** Compases del loop cuando el cabezal no esta en una seccion (igual que el boton LOOP). */
const DEFAULT_LOOP_BARS = 4

/** Lo que sube o baja la velocidad de las notas cada Alt+Arriba o Alt+Abajo (1..127). */
const NOTE_VELOCITY_STEP = 5

/**
 * Comandos que solo tienen sentido con argumentos (los usa el asistente): no salen en la paleta
 * ni en la hoja de atajos.
 */
export const STUDIO_ARGS_ONLY_COMMANDS: ReadonlySet<string> = new Set<StudioCommandId>([
  'track.remove',
  'clip.move',
  'clip.duplicate',
  'clip.split',
  'clip.delete',
  'clip.set_gain',
  'midi.add_clip',
  'midi.replace_notes',
  'midi.transpose',
  'midi.quantize',
  'instrument.set',
  'track.set_mix',
  'track.set_fx',
  'master.set',
  'session.set_meta',
  'marker.add',
  'marker.remove',
])

/** Almacen del navegador que nunca lanza (navegacion privada, cuota llena). */
export const studioKeymapStorage: KeyValueStorage = {
  getItem(key) {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem(key, value) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
    } catch {
      // Sin almacenamiento los atajos valen solo para esta visita.
    }
  },
  removeItem(key) {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
    } catch {
      // Igual que arriba.
    }
  },
}

// ---------------------------------------------------------------------------
// Lectura de argumentos (ya validados por assistantTools; aqui solo se tipan)
// ---------------------------------------------------------------------------

type Args = Readonly<Record<string, unknown>> | undefined

function str(args: Args, key: string): string | undefined {
  const v = args?.[key]
  return typeof v === 'string' ? v : undefined
}

function num(args: Args, key: string): number | undefined {
  const v = args?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args?.[key]
  return typeof v === 'boolean' ? v : undefined
}

function obj(args: Args, key: string): Record<string, unknown> | undefined {
  const v = args?.[key]
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Falta ${what}.`)
  return value
}

function notesArg(args: Args): StudioMidiNote[] {
  const raw = args?.notes
  if (!Array.isArray(raw)) throw new Error('Faltan las notas.')
  const out: StudioMidiNote[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const n = item as Record<string, unknown>
    if (typeof n.pitch !== 'number' || typeof n.start !== 'number' || typeof n.length !== 'number' || typeof n.velocity !== 'number') continue
    out.push({ pitch: n.pitch, start: n.start, length: n.length, velocity: n.velocity })
  }
  return out
}

function roleArg(args: Args): StemRole | undefined {
  const role = args?.role
  return isStemRole(role) ? role : undefined
}

const FX_TYPES: readonly StudioFxType[] = ['eq', 'compressor', 'limiter']
const GRIDS: readonly QuantizeGrid[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32']

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/** Registro del Estudio con todas las acciones conectadas a `controller`. */
export function createStudioCommandRegistry(controller: StudioController, ui: StudioCommandUi): StudioRegistry {
  const snap = () => controller.snapshot()
  const notRecording = () => !snap().recording
  const inPiano = () => snap().editor === 'piano_roll' && snap().pianoClipId !== null
  const inTimeline = () => snap().editor === 'timeline'
  /** Hay clips elegidos en la linea de tiempo. */
  const hasClips = () => inTimeline() && controller.selectedClips().length > 0
  const sessionHasClips = () => snap().session.tracks.some((track) => track.clips.length > 0 || track.midiClips.length > 0)
  const label =(ctx: StudioCommandCtx, text: string) => (ctx.source === 'assistant' ? `Asistente: ${text}` : text)

  /**
   * Aplica una operacion como un paso de deshacer. A diferencia de controller.run, el error se
   * lanza: el chat lo devuelve al modelo y el teclado lo muestra como aviso.
   */
  const commit = (ctx: StudioCommandCtx, text: string, operation: (session: StudioSession) => StudioSession): void => {
    const current = snap().session
    const next = operation(current)
    controller.apply(next, label(ctx, text))
  }

  const editing: Pick<StudioCommandHandler<StudioCommandCtx>, 'isEnabled'> = { isEnabled: notRecording }

  const seekBars = (direction: -1 | 1) => {
    const session = snap().session
    controller.seek(Math.max(0, controller.engine.position() + direction * (60 / session.bpm) * session.beatsPerBar))
  }

  const toggleLoop = () => {
    const { engine, sections, session } = snap()
    if (engine.loop) {
      controller.setLoop(null)
      return
    }
    const position = controller.engine.position()
    const section = sections.find((s) => position >= s.startSec && position < s.endSec)
    if (section) {
      controller.setLoop({ startS: section.startSec, endS: section.endSec })
      return
    }
    const barS = (60 / session.bpm) * session.beatsPerBar
    const startS = Math.floor(position / barS + 1e-6) * barS
    controller.setLoop({ startS, endS: startS + barS * DEFAULT_LOOP_BARS })
  }

  const handlers: Partial<Record<StudioCommandId, StudioCommandHandler<StudioCommandCtx>>> = {
    // ---- transporte ----
    'transport.play_pause': { run: () => controller.togglePlay() },
    'transport.record': {
      run: () => {
        if (ui.recordAllowed()) controller.toggleRecord()
        else controller.notify('warn', ui.recordHint() ?? 'La grabación no está disponible aquí.')
      },
    },
    'transport.go_to_start': { run: () => controller.seek(0) },
    'transport.toggle_loop': { run: toggleLoop },
    'transport.toggle_click': { run: () => controller.setClick({ enabled: !snap().engine.click.enabled }) },
    'transport.go_to_end': { run: () => controller.goToEnd() },
    'transport.bar_back': { run: () => controller.stepBar(-1) },
    'transport.bar_forward': { run: () => controller.stepBar(1) },
    'transport.prev_marker': { run: () => controller.goToMarker(-1) },
    'transport.next_marker': { run: () => controller.goToMarker(1) },
    'transport.loop_selection': { run: () => controller.loopSelection(), isEnabled: notRecording },
    'transport.tap_tempo': { run: () => controller.tapTempo(), ...editing },
    'transport.toggle_count_in': { run: () => controller.toggleCountIn() },

    // ---- edicion ----
    'edit.undo': { run: () => controller.undo(), isEnabled: () => notRecording() && snap().canUndo },
    'edit.redo': { run: () => controller.redo(), isEnabled: () => notRecording() && snap().canRedo },
    // Notas en el piano roll; clips en la linea de tiempo. Sin nada que copiar o pegar, la tecla
    // queda para el navegador (isEnabled false no la consume: StudioHubView BROWSER_PASSTHROUGH).
    'edit.copy': { run: () => controller.copySelection(), isEnabled: () => inPiano() || hasClips() },
    'edit.cut': { run: () => controller.cutSelection(), isEnabled: () => notRecording() && (inPiano() || hasClips()) },
    'edit.paste': { run: () => controller.pasteSelection(), isEnabled: () => notRecording() && (inPiano() || (inTimeline() && controller.hasClipClipboard())) },
    'edit.select_all': { run: () => controller.selectAll(), isEnabled: () => inPiano() || (inTimeline() && sessionHasClips()) },
    'edit.join': { run: () => controller.joinSelected(), isEnabled: () => notRecording() && inTimeline() },
    'edit.duplicate': { run: () => controller.duplicateSelection(), ...editing },
    'edit.delete': { run: () => controller.deleteSelection(), ...editing },
    'edit.split': { run: () => controller.splitSelection(), ...editing },
    'edit.quantize': { run: () => controller.quantizeSelection(), ...editing },

    // ---- pistas ----
    'track.toggle_mute': { run: () => controller.toggleTrackMute() },
    'track.toggle_solo': { run: () => controller.toggleTrackSolo() },
    'track.add_audio': {
      ...editing,
      run: (ctx, args) => {
        if (!args) {
          controller.addEmptyTrack()
          return
        }
        const name = required(str(args, 'name'), 'el nombre de la pista')
        commit(ctx, `agregar pista ${name}`, (session) => {
          if (session.tracks.length >= STUDIO_MAX_TRACKS) throw new Error(`El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas por sesión.`)
          return addTrack(session, { track: defaultTrack({ id: newStudioId('trk'), name, role: roleArg(args) }) })
        })
      },
    },
    'track.add_instrument': {
      ...editing,
      run: (ctx, args) => {
        if (!args) {
          controller.addInstrumentTrack('synth')
          return
        }
        const name = required(str(args, 'name'), 'el nombre de la pista')
        const type = required(str(args, 'instrument_type'), 'el tipo de instrumento')
        if (type !== 'synth' && type !== 'drums' && type !== 'sampler') throw new Error(`Tipo de instrumento desconocido: "${type}".`)
        const preset = str(args, 'preset')
        if (preset !== undefined && type === 'synth' && !isSynthPresetId(preset)) throw new Error(`El preset "${preset}" no es de sintetizador.`)
        if (preset !== undefined && type === 'drums' && !isDrumsPresetId(preset)) throw new Error(`El preset "${preset}" no es de caja de ritmos.`)
        const instrument = defaultInstrument(type, type === 'sampler' ? null : (preset ?? null))
        commit(ctx, `agregar pista de instrumento ${name}`, (session) => {
          if (session.tracks.length >= STUDIO_MAX_TRACKS) throw new Error(`El Estudio admite hasta ${STUDIO_MAX_TRACKS} pistas por sesión.`)
          return addInstrumentTrack(session, { track: defaultInstrumentTrack({ id: newStudioId('trk'), name, instrument, role: roleArg(args) }) })
        })
      },
    },
    'track.remove': {
      ...editing,
      run: (ctx, args) => {
        const trackId = required(str(args, 'track_id'), 'la pista')
        const track = findTrack(snap().session, trackId)
        if (!track) throw new Error(`No existe la pista "${trackId}".`)
        commit(ctx, `quitar pista ${track.name}`, (session) => removeTrack(session, { trackId }))
      },
    },
    'track.select_prev': { run: () => controller.selectAdjacentTrack(-1) },
    'track.select_next': { run: () => controller.selectAdjacentTrack(1) },
    'track.toggle_arm': {
      ...editing,
      run: () => {
        if (ui.recordAllowed()) controller.toggleArmSelectedTrack()
        else controller.notify('warn', ui.recordHint() ?? 'La grabación no está disponible aquí.')
      },
    },
    'track.rename': { run: () => controller.renameSelectedTrack(), ...editing },
    'track.duplicate': { run: () => controller.duplicateSelectedTrack(), ...editing },
    'track.move_up': { run: () => controller.moveSelectedTrack(-1), ...editing },
    'track.move_down': { run: () => controller.moveSelectedTrack(1), ...editing },
    'track.select_1': { run: () => controller.selectTrackByNumber(1) },
    'track.select_2': { run: () => controller.selectTrackByNumber(2) },
    'track.select_3': { run: () => controller.selectTrackByNumber(3) },
    'track.select_4': { run: () => controller.selectTrackByNumber(4) },
    'track.select_5': { run: () => controller.selectTrackByNumber(5) },
    'track.select_6': { run: () => controller.selectTrackByNumber(6) },
    'track.select_7': { run: () => controller.selectTrackByNumber(7) },
    'track.select_8': { run: () => controller.selectTrackByNumber(8) },
    'track.select_9': { run: () => controller.selectTrackByNumber(9) },
    'track.set_mix': {
      ...editing,
      run: (ctx, args) => {
        const trackId = required(str(args, 'track_id'), 'la pista')
        const patch: TrackPatch = {}
        const name = str(args, 'name')
        if (name !== undefined) patch.name = name
        const volumeDb = num(args, 'volume_db')
        if (volumeDb !== undefined) patch.volumeDb = volumeDb
        const pan = num(args, 'pan')
        if (pan !== undefined) patch.pan = pan
        const mute = bool(args, 'mute')
        if (mute !== undefined) patch.mute = mute
        const solo = bool(args, 'solo')
        if (solo !== undefined) patch.solo = solo
        const reverbSendDb = num(args, 'reverb_send_db')
        if (reverbSendDb !== undefined) patch.reverbSendDb = reverbSendDb
        commit(ctx, 'mezcla de una pista', (session) => updateTrack(session, { trackId, patch }))
      },
    },
    'track.set_fx': {
      ...editing,
      run: (ctx, args) => {
        const trackId = required(str(args, 'track_id'), 'la pista')
        const fxType = required(str(args, 'fx_type'), 'el efecto') as StudioFxType
        if (!FX_TYPES.includes(fxType)) throw new Error(`Efecto desconocido: "${fxType}".`)
        const params = partialFxParamsFromWire(fxType, obj(args, 'params') ?? {})
        const bypass = bool(args, 'bypass')
        commit(ctx, 'ajustar un efecto', (session) => {
          // Regla de v1 6.4: si ya esta, cambian solo los params que vienen y se quita el bypass.
          const suggestion = { target: 'fx', trackId, fxType, params, reason: '' } as FxSuggestion
          let next = applyMixSuggestion(session, { suggestion })
          if (bypass === true) {
            const chain = trackId === STUDIO_MASTER_ID ? next.master.fx : (findTrack(next, trackId)?.fx ?? [])
            const fx: StudioFx[] = chain.map((item) => (item.type === fxType ? ({ ...item, bypass: true } as StudioFx) : item))
            next = setTrackFx(next, { trackId, fx })
          }
          return next
        })
      },
    },

    // ---- linea de tiempo ----
    'clip.nudge_left': {
      ...editing,
      run: () => {
        if (snap().selectedClipId) controller.nudgeSelected(-1)
        else seekBars(-1)
      },
    },
    'clip.nudge_right': {
      ...editing,
      run: () => {
        if (snap().selectedClipId) controller.nudgeSelected(1)
        else seekBars(1)
      },
    },
    'clip.move': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const startBeat = required(num(args, 'start_beat'), 'el beat de destino')
        const trackId = str(args, 'track_id')
        const session = snap().session
        if (findMidiClip(session, clipId)) {
          commit(ctx, 'mover clip MIDI', (s) => moveMidiClip(s, { clipId, startBeat, trackId }))
          return
        }
        if (!findClip(session, clipId)) throw new Error(`No existe el clip "${clipId}".`)
        commit(ctx, 'mover clip', (s) => moveClip(s, { clipId, startS: beatsToSeconds(startBeat, s.bpm), trackId }))
      },
    },
    'clip.duplicate': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const startBeat = num(args, 'start_beat')
        const session = snap().session
        if (findMidiClip(session, clipId)) {
          commit(ctx, 'duplicar clip MIDI', (s) => duplicateMidiClip(s, { clipId, newClipId: newStudioId('mid'), startBeat }))
          return
        }
        if (!findClip(session, clipId)) throw new Error(`No existe el clip "${clipId}".`)
        commit(ctx, 'duplicar clip', (s) =>
          duplicateClip(s, { clipId, newClipId: newStudioId('clp'), startS: startBeat === undefined ? undefined : beatsToSeconds(startBeat, s.bpm) }),
        )
      },
    },
    'clip.split': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const atBeat = required(num(args, 'at_beat'), 'el beat del corte')
        const session = snap().session
        const before = session
        if (findMidiClip(session, clipId)) {
          commit(ctx, 'dividir clip MIDI', (s) => splitMidiClip(s, { clipId, atBeat, newClipId: newStudioId('mid') }))
        } else if (findClip(session, clipId)) {
          commit(ctx, 'dividir clip', (s) => splitClip(s, { clipId, atS: beatsToSeconds(atBeat, s.bpm), newClipId: newStudioId('clp') }))
        } else {
          throw new Error(`No existe el clip "${clipId}".`)
        }
        if (snap().session === before) throw new Error('El corte cae fuera del clip o deja un trozo demasiado corto.')
      },
    },
    'clip.delete': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const session = snap().session
        if (findMidiClip(session, clipId)) commit(ctx, 'borrar clip MIDI', (s) => removeMidiClip(s, { clipId }))
        else if (findClip(session, clipId)) commit(ctx, 'borrar clip', (s) => deleteClip(s, { clipId }))
        else throw new Error(`No existe el clip "${clipId}".`)
      },
    },
    'clip.set_gain': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const gainDb = required(num(args, 'gain_db'), 'la ganancia')
        if (findMidiClip(snap().session, clipId)) throw new Error('La ganancia de clip es solo para clips de audio.')
        commit(ctx, 'ganancia de clip', (s) => setClipGain(s, { clipId, gainDb }))
      },
    },
    'clip.toggle_mute': { run: () => controller.toggleSelectedClipsMute(), isEnabled: () => notRecording() && inTimeline() },
    'clip.trim_start': { run: () => controller.trimSelectedToPlayhead('start'), isEnabled: () => notRecording() && inTimeline() },
    'clip.trim_end': { run: () => controller.trimSelectedToPlayhead('end'), isEnabled: () => notRecording() && inTimeline() },
    'clip.fade_in': { run: () => controller.fadeSelectedToPlayhead('in'), isEnabled: () => notRecording() && inTimeline() },
    'clip.fade_out': { run: () => controller.fadeSelectedToPlayhead('out'), isEnabled: () => notRecording() && inTimeline() },

    // ---- piano roll ----
    'notes.transpose_up': { run: () => controller.transposeNotes(1), ...editing },
    'notes.transpose_down': { run: () => controller.transposeNotes(-1), ...editing },
    'notes.octave_up': { run: () => controller.transposeNotes(12), ...editing },
    'notes.octave_down': { run: () => controller.transposeNotes(-12), ...editing },
    'notes.nudge_left': { run: () => controller.nudgeNotes(-1), ...editing },
    'notes.nudge_right': { run: () => controller.nudgeNotes(1), ...editing },
    'notes.legato': { run: () => controller.legatoNotes(), isEnabled: () => inPiano() && notRecording() },
    'tool.select': { run: () => controller.setPianoTool('select') },
    'tool.draw': { run: () => controller.setPianoTool('draw') },
    'tool.erase': { run: () => controller.setPianoTool('erase') },
    'tool.cut': { run: () => controller.setPianoTool('cut') },
    'tool.velocity': { run: () => controller.setPianoTool('velocity') },
    'notes.invert_selection': { run: () => controller.invertNoteSelection(), isEnabled: inPiano },
    'notes.velocity_up': { run: () => controller.nudgeNotesVelocity(NOTE_VELOCITY_STEP), isEnabled: () => inPiano() && notRecording() },
    'notes.velocity_down': { run: () => controller.nudgeNotesVelocity(-NOTE_VELOCITY_STEP), isEnabled: () => inPiano() && notRecording() },
    'notes.lengthen': { run: () => controller.resizeSelectedNotes(1), isEnabled: () => inPiano() && notRecording() },
    'notes.shorten': { run: () => controller.resizeSelectedNotes(-1), isEnabled: () => inPiano() && notRecording() },

    // ---- MIDI e instrumentos ----
    'midi.add_clip': {
      ...editing,
      run: (ctx, args) => {
        const trackId = required(str(args, 'track_id'), 'la pista')
        const startBeat = required(num(args, 'start_beat'), 'el beat de inicio')
        const lengthBeats = roundBeat(required(num(args, 'length_beats'), 'el largo del clip'))
        const notes = normalizeNotes(notesArg(args), lengthBeats)
        commit(ctx, 'agregar clip MIDI', (s) =>
          addMidiClip(s, { trackId, clip: defaultMidiClip({ id: newStudioId('mid'), startBeat: roundBeat(startBeat), lengthBeats, notes }) }),
        )
      },
    },
    'midi.replace_notes': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const loc = findMidiClip(snap().session, clipId)
        if (!loc) throw new Error(`No existe el clip MIDI "${clipId}".`)
        const notes = normalizeNotes(notesArg(args), loc.clip.lengthBeats)
        commit(ctx, 'reemplazar notas', (s) => updateMidiClip(s, { clipId, patch: { notes } }))
      },
    },
    'midi.transpose': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const semitones = Math.round(required(num(args, 'semitones'), 'los semitonos'))
        const loc = findMidiClip(snap().session, clipId)
        if (!loc) throw new Error(`No existe el clip MIDI "${clipId}".`)
        const notes = transpose(loc.clip.notes, null, semitones, loc.clip.lengthBeats).notes
        commit(ctx, 'transponer clip MIDI', (s) => updateMidiClip(s, { clipId, patch: { notes } }))
      },
    },
    'midi.quantize': {
      ...editing,
      run: (ctx, args) => {
        const clipId = required(str(args, 'clip_id'), 'el clip')
        const grid = required(str(args, 'grid'), 'la rejilla') as QuantizeGrid
        if (!GRIDS.includes(grid)) throw new Error(`Rejilla desconocida: "${grid}".`)
        const loc = findMidiClip(snap().session, clipId)
        if (!loc) throw new Error(`No existe el clip MIDI "${clipId}".`)
        const notes = quantize(loc.clip.notes, null, { grid, triplets: bool(args, 'triplets') ?? false, strength: num(args, 'strength') ?? 1 }, loc.clip.lengthBeats).notes
        commit(ctx, 'cuantizar clip MIDI', (s) => updateMidiClip(s, { clipId, patch: { notes } }))
      },
    },
    'midi.toggle_computer_keyboard': { run: () => controller.toggleComputerKeyboard() },
    'instrument.set': {
      ...editing,
      run: (ctx, args) => {
        const trackId = required(str(args, 'track_id'), 'la pista')
        const track = findTrack(snap().session, trackId)
        const current = track?.instrument
        if (!track || !current) throw new Error(`La pista "${trackId}" no tiene instrumento.`)
        const preset = str(args, 'preset')
        const raw = obj(args, 'params') ?? {}
        let instrument: StudioInstrument
        if (current.type === 'synth') {
          if (preset !== undefined && !isSynthPresetId(preset)) throw new Error(`El preset "${preset}" no es de sintetizador.`)
          const base = preset !== undefined ? synthPresetParams(preset) : current.params
          instrument = { ...current, preset: preset ?? current.preset, params: { ...base, ...partialInstrumentParamsFromWire('synth', raw) } }
        } else if (current.type === 'drums') {
          if (preset !== undefined && !isDrumsPresetId(preset)) throw new Error(`El preset "${preset}" no es de caja de ritmos.`)
          const base = preset !== undefined ? drumsPresetParams(preset) : current.params
          instrument = { ...current, preset: preset ?? current.preset, params: { ...base, ...partialInstrumentParamsFromWire('drums', raw) } }
        } else {
          throw new Error(`El instrumento de "${track.name}" no admite presets ni parámetros desde el asistente.`)
        }
        commit(ctx, `instrumento de ${track.name}`, (s) => setInstrument(s, { trackId, instrument }))
      },
    },

    // ---- mezcla ----
    'master.set': {
      ...editing,
      run: (ctx, args) => {
        const volumeDb = num(args, 'volume_db')
        const decayS = num(args, 'reverb_decay_s')
        const returnDb = num(args, 'reverb_return_db')
        commit(ctx, 'master', (s) =>
          updateMaster(s, {
            patch: {
              ...(volumeDb !== undefined ? { volumeDb } : {}),
              ...(decayS !== undefined || returnDb !== undefined
                ? { reverb: { decayS: decayS ?? s.master.reverb.decayS, returnDb: returnDb ?? s.master.reverb.returnDb } }
                : {}),
            },
          }),
        )
      },
    },
    'session.set_meta': {
      ...editing,
      run: (ctx, args) => {
        const patch: SessionMetaPatch = {}
        const title = str(args, 'title')
        if (title !== undefined) patch.title = title
        const bpm = num(args, 'bpm')
        if (bpm !== undefined) patch.bpm = bpm
        const key = str(args, 'key')
        if (key !== undefined) patch.key = key.trim() === '' ? null : key.trim()
        const beatsPerBar = num(args, 'beats_per_bar')
        if (beatsPerBar !== undefined) patch.beatsPerBar = Math.round(beatsPerBar)
        commit(ctx, 'datos de la sesión', (s) => updateSessionMeta(s, { patch }))
      },
    },

    // ---- marcas ----
    'marker.add': {
      ...editing,
      run: (ctx, args) => {
        const beat = roundBeat(required(num(args, 'beat'), 'el beat'))
        const kind = required(str(args, 'kind'), 'el tipo de marca')
        if (!isStudioMarkerKind(kind)) throw new Error(`Tipo de marca desconocido: "${kind}".`)
        const text = (str(args, 'label') ?? '').trim() || STUDIO_MARKER_KIND_LABELS[kind]
        commit(ctx, `agregar marca ${text}`, (s) => {
          if (s.markers.length >= STUDIO_MAX_MARKERS) throw new Error(`La sesión admite hasta ${STUDIO_MAX_MARKERS} marcas.`)
          return setMarkers(s, { markers: [...s.markers, { id: newStudioId('mk'), beat, label: text, kind }] })
        })
      },
    },
    'marker.remove': {
      ...editing,
      run: (ctx, args) => {
        const markerId = required(str(args, 'marker_id'), 'la marca')
        commit(ctx, 'quitar marca', (s) => {
          if (!s.markers.some((m) => m.id === markerId)) throw new Error(`No existe la marca "${markerId}".`)
          return setMarkers(s, { markers: s.markers.filter((m) => m.id !== markerId) })
        })
      },
    },

    'marker.add_here': { run: () => controller.addMarkerAtPlayhead(), ...editing },

    // ---- vista ----
    'view.zoom_fit': { run: () => controller.zoomToFit() },
    'view.center_playhead': { run: () => controller.centerOnPlayhead() },
    'view.zoom_in': { run: () => controller.zoomIn() },
    'view.zoom_out': { run: () => controller.zoomOut() },
    'view.toggle_editor': { run: () => controller.toggleEditor() },
    'view.command_palette': { run: () => ui.openPalette() },
    'view.shortcuts': { run: () => ui.openShortcuts() },
    'view.toggle_assistant': { run: () => ui.toggleAssistant() },

    // ---- archivo ----
    'file.save_cloud': { run: () => void controller.saveToCloud() },
    'file.export': { run: () => ui.openExport(), isEnabled: notRecording },
    'file.import_midi': { run: () => ui.pickMidiFile(), ...editing },
    'file.export_midi': {
      run: () => {
        const file = controller.exportSessionMidi()
        if (!file) {
          controller.notify('info', 'No hay notas MIDI que exportar: crea una pista de instrumento con un clip MIDI.')
          return
        }
        downloadBlob(file.blob, file.name)
      },
    },
  }

  return createStudioRegistry(handlers)
}
