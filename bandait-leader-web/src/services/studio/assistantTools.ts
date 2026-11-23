/**
 * Herramientas del asistente del Estudio (STUDIO_V2.md 4.3): traduce las llamadas a
 * herramientas que devuelve el trabajo `chat` en comandos PENDIENTES del registro de comandos
 * (commands.ts, por su firma CommandRegistry de types.ts), con una descripcion legible en
 * espanol, y arma los `tool_result` del turno siguiente.
 *
 * Flujo:
 *   1. prepareToolCalls(calls, registry, session): valida cada llamada contra la lista cerrada
 *      (nombre y argumentos con los esquemas de fixtures/studio_chat_tools_v2.json) y contra la
 *      sesion (ids que existen, pista del tipo correcto). Lo que no sirve queda 'failed' de una
 *      vez, sin mostrarse como aplicable; lo demas queda 'pending' con su descripcion.
 *   2. La interfaz muestra los pendientes. El usuario aplica (applyPendingCommand: corre el
 *      comando del registro, UN paso de deshacer) o rechaza (rejectPendingCommand) cada uno.
 *   3. Cuando ninguno sigue 'pending', toolResultsMessage arma el mensaje `tool` con un
 *      resultado por llamada, en el mismo orden y con el mismo call_id y name.
 *
 * Reglas del contrato (4.3.3): los numeros fuera de rango se ACOTAN (y el mensaje para el modelo
 * lo dice); un id inexistente, una pista de tipo equivocado o un nombre fuera de la lista
 * responden 'failed' con el motivo. Los argumentos quedan en snake_case: el comando los recibe
 * asi (StudioCommand.run).
 *
 * La lista de herramientas es una COPIA de bandait-protocol/fixtures/studio_chat_tools_v2.json
 * (el bundle del Hub no importa bandait-protocol); scripts/verify-studio-v2-input.ts comprueba
 * que sea identica al fixture.
 *
 * Modulo puro: sin DOM ni import.meta.env.
 */
import { stemRoleLabel, isStemRole } from '../stemNames.ts'
import { reviewNoteCall } from './noteReview.ts'
import {
  STUDIO_DRUMS_PRESETS,
  STUDIO_INSTRUMENT_TYPE_LABELS,
  STUDIO_MARKER_KIND_LABELS,
  STUDIO_MASTER_ID,
  STUDIO_SYNTH_PRESETS,
  findClip,
  findMarker,
  findMidiClip,
  findTrack,
  isDrumsPresetId,
  isStudioInstrumentType,
  isStudioMarkerKind,
  isSynthPresetId,
  type StudioSession,
  type StudioTrack,
} from './session.ts'
import type { AssistantToolName, AssistantToolStatus, CommandRegistry, StudioChatMessage, StudioChatToolCall, StudioChatToolResult } from './types.ts'

/** Largo maximo del mensaje de un tool_result (STUDIO_V2.md 4.3.1). */
export const ASSISTANT_RESULT_MESSAGE_MAX = 500

// ---------------------------------------------------------------------------
// Lista cerrada (copia del fixture)
// ---------------------------------------------------------------------------

/** Subconjunto de JSON Schema que usan las herramientas (ver la descripcion del fixture). */
export interface ToolJsonSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Readonly<Record<string, ToolJsonSchema>>
  required?: readonly string[]
  items?: ToolJsonSchema
  enum?: readonly string[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
}

/** Herramienta tal como esta en el fixture (claves snake_case). */
export interface WireAssistantTool {
  name: AssistantToolName
  command_id: string
  description: string
  parameters: ToolJsonSchema
}

const ROLES = ['vocals', 'backing_vocals', 'drums', 'bass', 'guitar', 'keys', 'strings', 'wind', 'other', 'instrumental', 'click', 'guide', 'unknown']
const PRESETS = ['pad_calido', 'bajo_sub', 'bajo_sintetico', 'lead_brillante', 'pluck', 'cuerdas', 'organo', 'campanas', 'teclas_suaves', 'basico', 'seco', 'amplio', 'lofi']
const ID: ToolJsonSchema = { type: 'string', minLength: 1, maxLength: 80 }
const BEAT: ToolJsonSchema = { type: 'number', minimum: 0, maximum: 5200 }
const NOTES: ToolJsonSchema = {
  type: 'array',
  maxItems: 1024,
  items: {
    type: 'object',
    properties: {
      pitch: { type: 'integer', minimum: 0, maximum: 127 },
      start: { type: 'number', minimum: 0 },
      length: { type: 'number', minimum: 0.015625 },
      velocity: { type: 'integer', minimum: 1, maximum: 127 },
    },
    required: ['pitch', 'start', 'length', 'velocity'],
  },
}

/** Copia de fixtures/studio_chat_tools_v2.json `tools`, en el mismo orden. */
export const STUDIO_ASSISTANT_TOOLS: readonly WireAssistantTool[] = [
  {
    name: 'set_session_meta',
    command_id: 'session.set_meta',
    description: 'Cambia datos de la sesion: titulo, tempo (bpm), tonalidad (key) o compas (beats_per_bar). Manda solo lo que cambia. key vacio quita la tonalidad.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
        bpm: { type: 'number', minimum: 40, maximum: 260 },
        key: { type: 'string', maxLength: 12, description: 'Tonalidad, por ejemplo C#m o Bb. Vacio = sin tonalidad.' },
        beats_per_bar: { type: 'integer', minimum: 1, maximum: 12 },
      },
    },
  },
  {
    name: 'add_audio_track',
    command_id: 'track.add_audio',
    description: 'Agrega al final una pista de audio vacia.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 60 },
        role: { type: 'string', enum: ROLES },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_instrument_track',
    command_id: 'track.add_instrument',
    description:
      'Agrega al final una pista de instrumento: synth (sintetizador), drums (caja de ritmos) o sampler (sin zonas; el usuario elige las muestras). preset es un id de preset del tipo; si falta, el del tipo por defecto.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 60 },
        role: { type: 'string', enum: ROLES },
        instrument_type: { type: 'string', enum: ['synth', 'drums', 'sampler'] },
        preset: {
          type: 'string',
          enum: PRESETS,
          description: 'synth: pad_calido, bajo_sub, bajo_sintetico, lead_brillante, pluck, cuerdas, organo, campanas, teclas_suaves. drums: basico, seco, amplio, lofi.',
        },
      },
      required: ['name', 'instrument_type'],
    },
  },
  {
    name: 'remove_track',
    command_id: 'track.remove',
    description: 'Quita una pista con todos sus clips. Los audios quedan en la sesion.',
    parameters: { type: 'object', properties: { track_id: ID }, required: ['track_id'] },
  },
  {
    name: 'set_track_mix',
    command_id: 'track.set_mix',
    description:
      'Cambia nombre, fader (volume_db), paneo (pan, -1 izquierda a 1 derecha), mute, solo o envio a la reverb (reverb_send_db, -60 = sin envio) de una pista. Manda solo lo que cambia.',
    parameters: {
      type: 'object',
      properties: {
        track_id: ID,
        name: { type: 'string', minLength: 1, maxLength: 60 },
        volume_db: { type: 'number', minimum: -60, maximum: 12 },
        pan: { type: 'number', minimum: -1, maximum: 1 },
        mute: { type: 'boolean' },
        solo: { type: 'boolean' },
        reverb_send_db: { type: 'number', minimum: -60, maximum: 0 },
      },
      required: ['track_id'],
    },
  },
  {
    name: 'set_track_fx',
    command_id: 'track.set_fx',
    description:
      'Agrega o ajusta un efecto. track_id es el id de una pista o master. Si la pista ya tiene ese efecto se cambian solo los params que vienen y se quita el bypass; si no, se agrega con valores por defecto mas los que vienen. limiter solo en master. Parametros de eq: hpf_hz, low_db, mid_hz, mid_db, mid_q, high_db. De compressor: threshold_db, ratio, attack_ms, release_ms, knee_db, makeup_db. De limiter: ceiling_db, release_ms.',
    parameters: {
      type: 'object',
      properties: {
        track_id: ID,
        fx_type: { type: 'string', enum: ['eq', 'compressor', 'limiter'] },
        bypass: { type: 'boolean' },
        params: {
          type: 'object',
          properties: {
            hpf_hz: { type: 'number', minimum: 0, maximum: 1000 },
            low_db: { type: 'number', minimum: -18, maximum: 18 },
            mid_hz: { type: 'number', minimum: 200, maximum: 8000 },
            mid_db: { type: 'number', minimum: -18, maximum: 18 },
            mid_q: { type: 'number', minimum: 0.1, maximum: 10 },
            high_db: { type: 'number', minimum: -18, maximum: 18 },
            threshold_db: { type: 'number', minimum: -60, maximum: 0 },
            ratio: { type: 'number', minimum: 1, maximum: 20 },
            attack_ms: { type: 'number', minimum: 0, maximum: 1000 },
            release_ms: { type: 'number', minimum: 10, maximum: 1000 },
            knee_db: { type: 'number', minimum: 0, maximum: 40 },
            makeup_db: { type: 'number', minimum: 0, maximum: 24 },
            ceiling_db: { type: 'number', minimum: -12, maximum: 0 },
          },
        },
      },
      required: ['track_id', 'fx_type'],
    },
  },
  {
    name: 'set_master',
    command_id: 'master.set',
    description: 'Cambia el fader del master (volume_db) o la reverb compartida (reverb_decay_s, reverb_return_db). Manda solo lo que cambia.',
    parameters: {
      type: 'object',
      properties: {
        volume_db: { type: 'number', minimum: -60, maximum: 12 },
        reverb_decay_s: { type: 'number', minimum: 0.2, maximum: 10 },
        reverb_return_db: { type: 'number', minimum: -60, maximum: 12 },
      },
    },
  },
  {
    name: 'set_instrument',
    command_id: 'instrument.set',
    description:
      'Cambia el preset o parametros del instrumento de una pista synth o drums. Con preset se escriben todos sus parametros; despues se aplican los params que vengan (solo los que cambian, nombres snake_case de STUDIO_V2.md 2.3, por ejemplo filter_cutoff_hz o kick_level_db).',
    parameters: {
      type: 'object',
      properties: {
        track_id: ID,
        preset: { type: 'string', enum: PRESETS },
        params: { type: 'object', description: 'Parametros del instrumento que cambian, con su nombre snake_case.' },
      },
      required: ['track_id'],
    },
  },
  {
    name: 'add_midi_clip',
    command_id: 'midi.add_clip',
    description:
      'Agrega un clip MIDI a una pista de instrumento. Tiempos en beats (negras): start_beat es la posicion en la sesion (beat 0 = inicio); start de cada nota es relativo al clip. En una caja de ritmos usa las notas General MIDI: 36 bombo, 38 caja, 39 palmas, 42 hi-hat cerrado, 46 hi-hat abierto, 41 tom grave, 45 tom medio, 48 tom agudo, 49 platillo.',
    parameters: {
      type: 'object',
      properties: {
        track_id: ID,
        start_beat: BEAT,
        length_beats: { type: 'number', minimum: 0.0625, maximum: 5200 },
        notes: NOTES,
      },
      required: ['track_id', 'start_beat', 'length_beats', 'notes'],
    },
  },
  {
    name: 'replace_midi_notes',
    command_id: 'midi.replace_notes',
    description: 'Reemplaza todas las notas de un clip MIDI. start de cada nota en beats, relativo al clip.',
    parameters: { type: 'object', properties: { clip_id: ID, notes: NOTES }, required: ['clip_id', 'notes'] },
  },
  {
    name: 'transpose_midi_clip',
    command_id: 'midi.transpose',
    description: 'Transpone todas las notas de un clip MIDI en semitonos (12 = una octava). Las notas que saldrian de 0..127 se acotan.',
    parameters: {
      type: 'object',
      properties: { clip_id: ID, semitones: { type: 'integer', minimum: -48, maximum: 48 } },
      required: ['clip_id', 'semitones'],
    },
  },
  {
    name: 'quantize_midi_clip',
    command_id: 'midi.quantize',
    description:
      'Cuantiza el inicio de las notas de un clip MIDI a una rejilla (1/4 = un beat, 1/16 = un cuarto de beat). triplets usa tresillos. strength de 0 a 1 (1 = todo a la rejilla).',
    parameters: {
      type: 'object',
      properties: {
        clip_id: ID,
        grid: { type: 'string', enum: ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'] },
        triplets: { type: 'boolean' },
        strength: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['clip_id', 'grid'],
    },
  },
  {
    name: 'move_clip',
    command_id: 'clip.move',
    description: 'Mueve un clip (de audio o MIDI) para que empiece en start_beat. Con track_id lo pasa a otra pista del mismo tipo (audio con audio, instrumento con instrumento).',
    parameters: { type: 'object', properties: { clip_id: ID, start_beat: BEAT, track_id: ID }, required: ['clip_id', 'start_beat'] },
  },
  {
    name: 'duplicate_clip',
    command_id: 'clip.duplicate',
    description: 'Duplica un clip en su misma pista. Sin start_beat, la copia queda justo despues del original.',
    parameters: { type: 'object', properties: { clip_id: ID, start_beat: BEAT }, required: ['clip_id'] },
  },
  {
    name: 'split_clip',
    command_id: 'clip.split',
    description: 'Divide un clip en dos en el beat at_beat de la sesion, que debe caer dentro del clip.',
    parameters: { type: 'object', properties: { clip_id: ID, at_beat: BEAT }, required: ['clip_id', 'at_beat'] },
  },
  {
    name: 'delete_clip',
    command_id: 'clip.delete',
    description: 'Borra un clip de audio o MIDI.',
    parameters: { type: 'object', properties: { clip_id: ID }, required: ['clip_id'] },
  },
  {
    name: 'set_clip_gain',
    command_id: 'clip.set_gain',
    description: 'Cambia la ganancia de un clip de audio, en dB.',
    parameters: {
      type: 'object',
      properties: { clip_id: ID, gain_db: { type: 'number', minimum: -60, maximum: 24 } },
      required: ['clip_id', 'gain_db'],
    },
  },
  {
    name: 'add_marker',
    command_id: 'marker.add',
    description: 'Agrega una marca en un beat de la sesion. kind es la seccion que empieza ahi, o marker para una marca suelta.',
    parameters: {
      type: 'object',
      properties: {
        beat: BEAT,
        label: { type: 'string', maxLength: 60 },
        kind: { type: 'string', enum: ['intro', 'verse', 'pre_chorus', 'chorus', 'bridge', 'solo', 'interlude', 'break', 'outro', 'marker'] },
      },
      required: ['beat', 'kind'],
    },
  },
  {
    name: 'remove_marker',
    command_id: 'marker.remove',
    description: 'Quita una marca por su id.',
    parameters: { type: 'object', properties: { marker_id: ID }, required: ['marker_id'] },
  },
]

const TOOLS_BY_NAME: ReadonlyMap<string, WireAssistantTool> = new Map(STUDIO_ASSISTANT_TOOLS.map((t) => [t.name, t]))

export function isAssistantToolName(name: unknown): name is AssistantToolName {
  return typeof name === 'string' && TOOLS_BY_NAME.has(name)
}

export function findAssistantTool(name: string): WireAssistantTool | null {
  return TOOLS_BY_NAME.get(name) ?? null
}

// ---------------------------------------------------------------------------
// Validacion de argumentos (subconjunto de JSON Schema del fixture)
// ---------------------------------------------------------------------------

export interface ToolArgsCheck {
  ok: boolean
  /** Argumentos validados (copia; numeros acotados y enteros redondeados), en snake_case. */
  args: Record<string, unknown>
  /** En espanol, si ok es false. */
  error: string | null
  /** Rutas de los numeros que se acotaron o redondearon ("notes[3].velocity"). */
  adjusted: string[]
  /** Rutas de los campos que no estan en el esquema y se ignoraron. */
  ignored: string[]
}

class ArgsError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copia de un valor JSON (objeto libre como set_instrument.params). */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v)
    return out
  }
  return value
}

function checkValue(schema: ToolJsonSchema, value: unknown, path: string, adjusted: string[], ignored: string[]): unknown {
  const label = `"${path}"`
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) throw new ArgsError(`${label} debe ser un objeto.`)
      // Objeto sin propiedades declaradas (set_instrument.params): libre, lo valida el comando.
      if (!schema.properties) return cloneJson(value)
      const out: Record<string, unknown> = {}
      for (const [key, inner] of Object.entries(value)) {
        const prop = schema.properties[key]
        const innerPath = path ? `${path}.${key}` : key
        if (!prop) {
          ignored.push(innerPath)
          continue
        }
        // null en un campo opcional = ausente (los modelos a veces lo mandan asi).
        if (inner === null) continue
        out[key] = checkValue(prop, inner, innerPath, adjusted, ignored)
      }
      for (const key of schema.required ?? []) {
        if (!(key in out)) throw new ArgsError(`Falta el campo "${path ? `${path}.${key}` : key}".`)
      }
      return out
    }
    case 'array': {
      if (!Array.isArray(value)) throw new ArgsError(`${label} debe ser una lista.`)
      if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ArgsError(`${label} admite hasta ${schema.maxItems} elementos.`)
      const items = schema.items
      return items ? value.map((item, i) => checkValue(items, item, `${path}[${i}]`, adjusted, ignored)) : value.map(cloneJson)
    }
    case 'string': {
      if (typeof value !== 'string') throw new ArgsError(`${label} debe ser un texto.`)
      if (schema.enum && !schema.enum.includes(value)) throw new ArgsError(`${label} no admite "${value.slice(0, 40)}". Valores posibles: ${schema.enum.join(', ')}.`)
      if (schema.minLength !== undefined && value.trim().length < schema.minLength) throw new ArgsError(`${label} no puede ir vacío.`)
      if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new ArgsError(`${label} admite hasta ${schema.maxLength} caracteres.`)
      return value
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ArgsError(`${label} debe ser un número.`)
      let n = schema.type === 'integer' ? Math.round(value) : value
      if (schema.minimum !== undefined && n < schema.minimum) n = schema.minimum
      if (schema.maximum !== undefined && n > schema.maximum) n = schema.maximum
      if (n !== value) adjusted.push(path)
      return n
    }
    case 'boolean': {
      if (typeof value !== 'boolean') throw new ArgsError(`${label} debe ser verdadero o falso.`)
      return value
    }
  }
}

/** Valida los argumentos de una herramienta con su esquema. Nunca lanza. */
export function checkToolArguments(name: string, args: unknown): ToolArgsCheck {
  const tool = findAssistantTool(name)
  if (!tool) return { ok: false, args: {}, error: 'Herramienta desconocida.', adjusted: [], ignored: [] }
  const adjusted: string[] = []
  const ignored: string[] = []
  try {
    const out = checkValue(tool.parameters, args ?? {}, '', adjusted, ignored) as Record<string, unknown>
    return { ok: true, args: out, error: null, adjusted, ignored }
  } catch (err) {
    const message = err instanceof ArgsError ? err.message : 'Argumentos inválidos.'
    return { ok: false, args: {}, error: message, adjusted, ignored }
  }
}

// ---------------------------------------------------------------------------
// Descripciones legibles
// ---------------------------------------------------------------------------

function num(value: number, decimals = 1): string {
  const fixed = value.toFixed(decimals)
  const trimmed = decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed
  return trimmed.replace('.', ',')
}

function db(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${num(rounded, 1)} dB`
}

function semitones(value: number): string {
  if (value === 12) return 'una octava arriba'
  if (value === -12) return 'una octava abajo'
  const abs = Math.abs(value)
  return `${abs} ${abs === 1 ? 'semitono' : 'semitonos'} ${value > 0 ? 'arriba' : 'abajo'}`
}

/** "compás 5" o "compás 5, tiempo 3" (o "tiempo 2,5") con el compás de la sesión. */
export function beatPositionText(beat: number, beatsPerBar: number): string {
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4
  const bar = Math.floor(beat / bpb + 1e-9)
  const inBar = Math.round((beat - bar * bpb) * 1000) / 1000
  return inBar === 0 ? `compás ${bar + 1}` : `compás ${bar + 1}, tiempo ${num(inBar + 1, 3)}`
}

function lengthText(beats: number, beatsPerBar: number): string {
  const bpb = beatsPerBar > 0 ? beatsPerBar : 4
  const bars = beats / bpb
  if (Number.isInteger(Math.round(bars * 1000) / 1000) && bars >= 1) {
    const n = Math.round(bars)
    return n === 1 ? '1 compás' : `${n} compases`
  }
  return `${num(beats, 3)} beats`
}

function trackName(session: StudioSession, trackId: unknown): string {
  if (trackId === STUDIO_MASTER_ID) return 'Master'
  const track = typeof trackId === 'string' ? findTrack(session, trackId) : null
  return track ? `"${track.name}"` : `la pista ${String(trackId)}`
}

function clipText(session: StudioSession, clipId: unknown): string {
  if (typeof clipId !== 'string') return 'un clip'
  const audio = findClip(session, clipId)
  if (audio) return `el clip de audio de "${audio.track.name}"`
  const midi = findMidiClip(session, clipId)
  if (midi) return `el clip MIDI de "${midi.track.name}"`
  return `el clip ${clipId}`
}

function presetLabel(preset: unknown): string | null {
  if (isSynthPresetId(preset)) return STUDIO_SYNTH_PRESETS.find((p) => p.id === preset)?.label ?? preset
  if (isDrumsPresetId(preset)) return STUDIO_DRUMS_PRESETS.find((p) => p.id === preset)?.label ?? preset
  return null
}

function panText(pan: number): string {
  const pct = Math.round(Math.abs(pan) * 100)
  return pct === 0 ? 'paneo al centro' : `paneo ${pct} % a la ${pan < 0 ? 'izquierda' : 'derecha'}`
}

function joinParts(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`
}

const FX_LABELS: Record<string, string> = { eq: 'el EQ', compressor: 'el compresor', limiter: 'el limitador' }

function countText(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/**
 * Descripcion en espanol de una llamada ya validada, para la lista de cambios propuestos:
 * "Cambiar el tempo a 96 BPM", "Mover el clip MIDI de "Bajo" al compás 9".
 */
export function describeToolCall(name: string, args: Readonly<Record<string, unknown>>, session: StudioSession): string {
  const bpb = session.beatsPerBar
  const a: Readonly<Record<string, unknown>> = args
  switch (name) {
    case 'set_session_meta': {
      const parts: string[] = []
      if (typeof a.title === 'string') parts.push(`el título a "${a.title}"`)
      if (typeof a.bpm === 'number') parts.push(`el tempo a ${num(a.bpm, 2)} BPM`)
      if (typeof a.key === 'string') parts.push(a.key.trim() ? `la tonalidad a ${a.key.trim()}` : 'quitar la tonalidad')
      if (typeof a.beats_per_bar === 'number') parts.push(`el compás a ${a.beats_per_bar} tiempos`)
      return parts.length ? `Cambiar ${joinParts(parts)}` : 'Sin cambios en la sesión'
    }
    case 'add_audio_track': {
      const role = isStemRole(a.role) && a.role !== 'unknown' ? ` (rol ${stemRoleLabel(a.role)})` : ''
      return `Agregar la pista de audio "${String(a.name)}"${role}`
    }
    case 'add_instrument_track': {
      const type = isStudioInstrumentType(a.instrument_type) ? STUDIO_INSTRUMENT_TYPE_LABELS[a.instrument_type].toLowerCase() : 'instrumento'
      const preset = presetLabel(a.preset)
      return `Agregar la pista de instrumento "${String(a.name)}": ${type}${preset ? `, preset ${preset}` : ''}`
    }
    case 'remove_track': {
      const track = typeof a.track_id === 'string' ? findTrack(session, a.track_id) : null
      if (!track) return `Quitar ${trackName(session, a.track_id)}`
      const clips = track.clips.length + track.midiClips.length
      return clips > 0 ? `Quitar la pista "${track.name}" con ${countText(clips, 'clip', 'clips')}` : `Quitar la pista "${track.name}"`
    }
    case 'set_track_mix': {
      const parts: string[] = []
      if (typeof a.name === 'string') parts.push(`nombre "${a.name}"`)
      if (typeof a.volume_db === 'number') parts.push(`fader a ${db(a.volume_db)}`)
      if (typeof a.pan === 'number') parts.push(panText(a.pan))
      if (typeof a.mute === 'boolean') parts.push(a.mute ? 'silenciar (mute)' : 'quitar el mute')
      if (typeof a.solo === 'boolean') parts.push(a.solo ? 'activar solo' : 'quitar el solo')
      if (typeof a.reverb_send_db === 'number') parts.push(a.reverb_send_db <= -60 ? 'sin envío a la reverb' : `envío a la reverb a ${db(a.reverb_send_db)}`)
      return `Pista ${trackName(session, a.track_id)}: ${parts.length ? joinParts(parts) : 'sin cambios'}`
    }
    case 'set_track_fx': {
      const where = a.track_id === STUDIO_MASTER_ID ? 'Master' : `Pista ${trackName(session, a.track_id)}`
      const fx = FX_LABELS[String(a.fx_type)] ?? 'un efecto'
      const params = isPlainObject(a.params) ? Object.entries(a.params as Record<string, unknown>) : []
      const detail = params.length ? ` (${params.map(([k, v]) => `${k} ${typeof v === 'number' ? num(v, 2) : String(v)}`).join(', ')})` : ''
      if (a.bypass === true) return `${where}: apagar ${fx}${detail}`
      return `${where}: ajustar ${fx}${detail}`
    }
    case 'set_master': {
      const parts: string[] = []
      if (typeof a.volume_db === 'number') parts.push(`fader a ${db(a.volume_db)}`)
      if (typeof a.reverb_decay_s === 'number') parts.push(`reverb de ${num(a.reverb_decay_s, 2)} s`)
      if (typeof a.reverb_return_db === 'number') parts.push(`retorno de la reverb a ${db(a.reverb_return_db)}`)
      return `Master: ${parts.length ? joinParts(parts) : 'sin cambios'}`
    }
    case 'set_instrument': {
      const parts: string[] = []
      const preset = presetLabel(a.preset)
      if (preset) parts.push(`preset ${preset}`)
      const n = isPlainObject(a.params) ? Object.keys(a.params as Record<string, unknown>).length : 0
      if (n > 0) parts.push(countText(n, 'parámetro', 'parámetros'))
      return `Instrumento de ${trackName(session, a.track_id)}: ${parts.length ? joinParts(parts) : 'sin cambios'}`
    }
    case 'add_midi_clip': {
      const notes = Array.isArray(a.notes) ? (a.notes as unknown[]).length : 0
      return `Agregar un clip MIDI de ${countText(notes, 'nota', 'notas')} en ${trackName(session, a.track_id)}, ${beatPositionText(Number(a.start_beat), bpb)}, largo ${lengthText(Number(a.length_beats), bpb)}`
    }
    case 'replace_midi_notes': {
      const notes = Array.isArray(a.notes) ? (a.notes as unknown[]).length : 0
      return `Reemplazar las notas de ${clipText(session, a.clip_id)} por ${countText(notes, 'nota', 'notas')}`
    }
    case 'transpose_midi_clip':
      return `Transponer ${clipText(session, a.clip_id)} ${semitones(Number(a.semitones))}`
    case 'quantize_midi_clip': {
      const strength = typeof a.strength === 'number' ? ` con fuerza ${Math.round(a.strength * 100)} %` : ''
      return `Cuantizar ${clipText(session, a.clip_id)} a ${String(a.grid)}${a.triplets === true ? ' en tresillos' : ''}${strength}`
    }
    case 'move_clip': {
      const to = typeof a.track_id === 'string' ? ` y pasarlo a ${trackName(session, a.track_id)}` : ''
      return `Mover ${clipText(session, a.clip_id)} al ${beatPositionText(Number(a.start_beat), bpb)}${to}`
    }
    case 'duplicate_clip': {
      const where = typeof a.start_beat === 'number' ? ` en el ${beatPositionText(a.start_beat, bpb)}` : ' justo después del original'
      return `Duplicar ${clipText(session, a.clip_id)}${where}`
    }
    case 'split_clip':
      return `Dividir ${clipText(session, a.clip_id)} en el ${beatPositionText(Number(a.at_beat), bpb)}`
    case 'delete_clip':
      return `Borrar ${clipText(session, a.clip_id)}`
    case 'set_clip_gain':
      return `Ganancia de ${clipText(session, a.clip_id)} a ${db(Number(a.gain_db))}`
    case 'add_marker': {
      const kind = isStudioMarkerKind(a.kind) ? STUDIO_MARKER_KIND_LABELS[a.kind] : 'Marca'
      const label = typeof a.label === 'string' && a.label.trim() ? `"${a.label.trim()}" (${kind})` : kind
      return `Agregar la marca ${label} en el ${beatPositionText(Number(a.beat), bpb)}`
    }
    case 'remove_marker': {
      const marker = typeof a.marker_id === 'string' ? findMarker(session, a.marker_id) : null
      if (!marker) return `Quitar la marca ${String(a.marker_id)}`
      return `Quitar la marca "${marker.label || STUDIO_MARKER_KIND_LABELS[marker.kind]}" del ${beatPositionText(marker.beat, bpb)}`
    }
    default:
      return `Herramienta desconocida: ${name}`
  }
}

// ---------------------------------------------------------------------------
// Comprobaciones contra la sesion (antes de mostrar como aplicable)
// ---------------------------------------------------------------------------

function trackOf(session: StudioSession, id: unknown): StudioTrack | null {
  return typeof id === 'string' ? findTrack(session, id) : null
}

/**
 * Motivo (en espanol, para el modelo) por el que la llamada no se puede aplicar a ESTA sesion, o
 * null. El comando vuelve a comprobar todo al correr: esto solo evita mostrar como aplicable algo
 * que seguro falla.
 */
export function toolSessionProblem(name: string, args: Readonly<Record<string, unknown>>, session: StudioSession): string | null {
  const a = args
  const noTrack = (id: unknown) => `No existe la pista "${String(id)}".`
  const noClip = (id: unknown) => `No existe el clip "${String(id)}".`
  switch (name) {
    case 'remove_track':
    case 'set_track_mix':
      return trackOf(session, a.track_id) ? null : noTrack(a.track_id)
    case 'set_track_fx': {
      if (a.track_id === STUDIO_MASTER_ID) return null
      if (!trackOf(session, a.track_id)) return noTrack(a.track_id)
      return a.fx_type === 'limiter' ? 'El limitador solo va en el master.' : null
    }
    case 'set_instrument': {
      const track = trackOf(session, a.track_id)
      if (!track) return noTrack(a.track_id)
      if (track.kind !== 'instrument' || !track.instrument) return `La pista "${track.name}" es de audio: no tiene instrumento.`
      if (track.instrument.type !== 'synth' && track.instrument.type !== 'drums') return `El instrumento de "${track.name}" no admite presets ni parámetros desde el asistente.`
      if (a.preset !== undefined) {
        const fits = track.instrument.type === 'synth' ? isSynthPresetId(a.preset) : isDrumsPresetId(a.preset)
        if (!fits) return `El preset "${String(a.preset)}" no es de ${STUDIO_INSTRUMENT_TYPE_LABELS[track.instrument.type].toLowerCase()}.`
      }
      return null
    }
    case 'add_instrument_track': {
      if (a.preset === undefined) return null
      if (a.instrument_type === 'synth' && !isSynthPresetId(a.preset)) return `El preset "${String(a.preset)}" no es de sintetizador.`
      if (a.instrument_type === 'drums' && !isDrumsPresetId(a.preset)) return `El preset "${String(a.preset)}" no es de caja de ritmos.`
      if (a.instrument_type === 'sampler') return 'El sampler no tiene presets.'
      return null
    }
    case 'add_midi_clip': {
      const track = trackOf(session, a.track_id)
      if (!track) return noTrack(a.track_id)
      return track.kind === 'instrument' ? null : `La pista "${track.name}" es de audio: los clips MIDI van en una pista de instrumento.`
    }
    case 'replace_midi_notes':
    case 'transpose_midi_clip':
    case 'quantize_midi_clip': {
      if (typeof a.clip_id === 'string' && findMidiClip(session, a.clip_id)) return null
      if (typeof a.clip_id === 'string' && findClip(session, a.clip_id)) return `"${a.clip_id}" es un clip de audio, no MIDI.`
      return noClip(a.clip_id)
    }
    case 'set_clip_gain': {
      if (typeof a.clip_id === 'string' && findClip(session, a.clip_id)) return null
      if (typeof a.clip_id === 'string' && findMidiClip(session, a.clip_id)) return `"${a.clip_id}" es un clip MIDI: la ganancia es solo de clips de audio.`
      return noClip(a.clip_id)
    }
    case 'move_clip': {
      const id = typeof a.clip_id === 'string' ? a.clip_id : ''
      const audio = findClip(session, id)
      const midi = audio ? null : findMidiClip(session, id)
      if (!audio && !midi) return noClip(a.clip_id)
      if (a.track_id === undefined) return null
      const target = trackOf(session, a.track_id)
      if (!target) return noTrack(a.track_id)
      const wanted = audio ? 'audio' : 'instrument'
      return target.kind === wanted ? null : `La pista "${target.name}" no es del mismo tipo que el clip.`
    }
    case 'duplicate_clip':
    case 'split_clip':
    case 'delete_clip': {
      const id = typeof a.clip_id === 'string' ? a.clip_id : ''
      return findClip(session, id) || findMidiClip(session, id) ? null : noClip(a.clip_id)
    }
    case 'remove_marker':
      return typeof a.marker_id === 'string' && findMarker(session, a.marker_id) ? null : `No existe la marca "${String(a.marker_id)}".`
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Comandos pendientes
// ---------------------------------------------------------------------------

export type PendingCommandStatus = 'pending' | AssistantToolStatus

/**
 * Herramientas que quitan o borran material. Nunca entran en APLICAR TODOS: se aceptan una por una,
 * para que un pedido escondido en el estado (un nombre de pista escrito por otro integrante) no se
 * aplique de pasada.
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(['remove_track', 'delete_clip', 'replace_midi_notes', 'remove_marker'])

/** true si el cambio propuesto quita o borra algo (ver DESTRUCTIVE_TOOLS). */
export function isDestructiveCommand(command: Pick<PendingAssistantCommand, 'name'>): boolean {
  return DESTRUCTIVE_TOOLS.has(command.name)
}

/** Los que APLICAR TODOS puede aplicar: pendientes y no destructivos. */
export function bulkApplicable(pendings: readonly PendingAssistantCommand[]): boolean[] {
  return pendings.map((p) => p.status === 'pending' && !isDestructiveCommand(p))
}

/** Una llamada del asistente convertida en cambio propuesto. */
export interface PendingAssistantCommand {
  /** id de la llamada (call_N). */
  callId: string
  /** Nombre tal como lo pidio el modelo. */
  name: string
  /** Comando del registro que la aplica; null si no hay (queda 'failed'). */
  commandId: string | null
  /** Argumentos validados (snake_case, numeros acotados). */
  args: Record<string, unknown>
  /** Que hace, en espanol, para la lista de cambios propuestos. */
  description: string
  /** 'pending' = se puede aplicar o rechazar; lo demas es definitivo. */
  status: PendingCommandStatus
  /** Para el modelo (tool_result) y la interfaz; vacio mientras esta 'pending'. */
  message: string
  /** Numeros que se acotaron o redondearon. */
  adjusted: string[]
  /** Campos que el esquema no tiene y se ignoraron. */
  ignored: string[]
  /**
   * Avisos de la revision local de notas (noteReview.ts), en espanol: fuera de tonalidad, choque
   * de registro, fuera del rango del instrumento. No impiden aplicar. Ausente o [] = sin avisos.
   */
  warnings?: string[]
}

function clip500(text: string): string {
  return text.length > ASSISTANT_RESULT_MESSAGE_MAX ? `${text.slice(0, ASSISTANT_RESULT_MESSAGE_MAX - 3)}...` : text
}

function failedCommand(call: StudioChatToolCall, description: string, message: string, commandId: string | null = null): PendingAssistantCommand {
  return { callId: call.id, name: call.name, commandId, args: {}, description, status: 'failed', message: clip500(message), adjusted: [], ignored: [] }
}

/**
 * Convierte UNA llamada en comando pendiente (o 'failed' con el motivo). No ejecuta nada.
 * `registry` es el registro de commands.ts (por su firma de types.ts).
 */
export function prepareToolCall<Ctx>(call: StudioChatToolCall, registry: CommandRegistry<Ctx>, session: StudioSession): PendingAssistantCommand {
  const tool = findAssistantTool(call.name)
  if (!tool) return failedCommand(call, `Herramienta desconocida: ${call.name}`, 'Herramienta desconocida.')
  const check = checkToolArguments(call.name, call.arguments)
  if (!check.ok) return failedCommand(call, `Cambio con datos inválidos (${call.name})`, `Argumentos inválidos: ${check.error ?? ''}`.trim(), tool.command_id)
  const description = describeToolCall(call.name, check.args, session)
  const command = registry.forAssistantTool(call.name)
  if (!command || command.id !== tool.command_id) {
    return failedCommand(call, description, 'El Estudio no tiene disponible ese comando en esta versión.', tool.command_id)
  }
  const problem = toolSessionProblem(call.name, check.args, session)
  if (problem) return { ...failedCommand(call, description, problem, command.id), args: check.args, adjusted: check.adjusted, ignored: check.ignored }
  const pending: PendingAssistantCommand = { callId: call.id, name: call.name, commandId: command.id, args: check.args, description, status: 'pending', message: '', adjusted: check.adjusted, ignored: check.ignored }
  const warnings = reviewNoteCall(call.name, check.args, session)
  return warnings.length > 0 ? { ...pending, warnings } : pending
}

/** Todas las llamadas de una respuesta, en el mismo orden. */
export function prepareToolCalls<Ctx>(calls: readonly StudioChatToolCall[], registry: CommandRegistry<Ctx>, session: StudioSession): PendingAssistantCommand[] {
  return calls.map((call) => prepareToolCall(call, registry, session))
}

function notesFor(pending: PendingAssistantCommand): string {
  const notes: string[] = []
  if (pending.adjusted.length) notes.push(`Se acotaron al rango permitido: ${pending.adjusted.slice(0, 8).join(', ')}${pending.adjusted.length > 8 ? '...' : ''}.`)
  if (pending.ignored.length) notes.push(`Se ignoraron campos desconocidos: ${pending.ignored.slice(0, 8).join(', ')}${pending.ignored.length > 8 ? '...' : ''}.`)
  // El modelo tambien ve los avisos de la revision local: puede corregir en la vuelta siguiente.
  if (pending.warnings?.length) notes.push(`Avisos de la revisión: ${pending.warnings.join(' ')}`)
  return notes.length ? ` ${notes.join(' ')}` : ''
}

/**
 * Aplica un comando pendiente con el registro (un paso de deshacer, lo garantiza el comando).
 * Devuelve el comando con su estado final: 'applied' o 'failed' (con el mensaje del Error del
 * comando). Un comando que no esta 'pending' se devuelve igual.
 */
export async function applyPendingCommand<Ctx>(pending: PendingAssistantCommand, registry: CommandRegistry<Ctx>, ctx: Ctx): Promise<PendingAssistantCommand> {
  if (pending.status !== 'pending' || !pending.commandId) return pending
  try {
    await registry.run(pending.commandId, ctx, pending.args)
    return { ...pending, status: 'applied', message: clip500(`Aplicado: ${pending.description}.${notesFor(pending)}`) }
  } catch (err) {
    const reason = err instanceof Error && err.message ? err.message : 'motivo desconocido'
    return { ...pending, status: 'failed', message: clip500(`No se pudo aplicar: ${reason}`) }
  }
}

/** El usuario rechazo el cambio. */
export function rejectPendingCommand(pending: PendingAssistantCommand): PendingAssistantCommand {
  if (pending.status !== 'pending') return pending
  return { ...pending, status: 'rejected', message: clip500(`El usuario rechazó el cambio: ${pending.description}.`) }
}

/** true si ningun comando sigue esperando decision (ya se puede responder al asistente). */
export function allSettled(pendings: readonly PendingAssistantCommand[]): boolean {
  return pendings.every((p) => p.status !== 'pending')
}

/**
 * Un tool_result por llamada, en el orden de `calls` y con su call_id y name (STUDIO_V2.md
 * 4.3.1). Lanza si alguna sigue 'pending'. Una llamada sin comando preparado (no deberia pasar)
 * se responde 'failed'.
 */
export function buildToolResults(calls: readonly StudioChatToolCall[], pendings: readonly PendingAssistantCommand[]): StudioChatToolResult[] {
  const byId = new Map(pendings.map((p) => [p.callId, p]))
  return calls.map((call) => {
    const p = byId.get(call.id)
    if (p && p.status === 'pending') throw new Error('Todavía hay cambios del asistente sin aplicar ni rechazar.')
    const status: AssistantToolStatus = p ? (p.status as AssistantToolStatus) : 'failed'
    const message = p ? p.message : 'El Estudio no procesó esta llamada.'
    return { callId: call.id, name: call.name, response: { status, message: clip500(message) } }
  })
}

/** Mensaje `tool` del turno siguiente. */
export function toolResultsMessage(calls: readonly StudioChatToolCall[], pendings: readonly PendingAssistantCommand[]): StudioChatMessage {
  return { role: 'tool', toolResults: buildToolResults(calls, pendings) }
}
