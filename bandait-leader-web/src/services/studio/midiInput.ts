/**
 * Entrada MIDI del Estudio Bandait v2 (docs/PLAN_ESTUDIO_V2.md seccion 4; STUDIO_V2.md 2.4):
 * Web MIDI (Chrome y Edge de escritorio), el teclado de la computadora como teclado musical de
 * respaldo, y la grabacion de una toma a un clip MIDI alineado al transporte.
 *
 * Reloj. Cada mensaje MIDI (y cada KeyboardEvent) trae `timeStamp` en el reloj de
 * performance.now(), en milisegundos. El Estudio programa todo en el reloj del AudioContext, en
 * segundos. La conversion usa AudioContext.getOutputTimestamp(), que devuelve un par
 * { contextTime, performanceTime }: el instante del contexto que esta saliendo POR LOS PARLANTES
 * en el instante performanceTime. Entonces:
 *
 *     ctxTime = contextTime + (timeStamp - performanceTime) / 1000
 *
 * es el instante del contexto que el musico estaba ESCUCHANDO cuando toco la tecla. Como
 * contextTime ya va atrasado respecto de currentTime en la latencia de salida, esta conversion
 * compensa la latencia de salida sola: una nota tocada "a tiempo con lo que se oye" cae a tiempo
 * en la linea de tiempo. Si el navegador no tiene getOutputTimestamp (o devuelve ceros, por
 * ejemplo con el contexto suspendido), se usa el respaldo
 *
 *     contextTime = currentTime - (baseLatency + outputLatency), performanceTime = performance.now()
 *
 * que estima lo mismo con las latencias que informa el navegador. El par se toma de nuevo en cada
 * evento (es barato), asi la deriva entre los dos relojes no se acumula. La latencia de la propia
 * entrada MIDI (USB, 1 a 3 ms) no se compensa.
 *
 * Toma. Se graba sobre el clic con el mismo conteo de v1: quien llama arranca el motor con
 * engine.play({ countIn: true }) y pasa el PlayStart que devuelve (ya despues del conteo). La toma
 * es lineal, como la de audio (recorder.ts); si el transporte repite una region, quien llama pasa
 * `loop` y las vueltas se superponen dentro de esa region (las notas de todas las vueltas quedan
 * en un solo clip, normalizado). Nada aqui toca la sesion: stopRecording devuelve una MidiTake y
 * quien llama la agrega con sessionOps.addMidiClip (un paso de deshacer).
 *
 * Las funciones puras (parseMidiMessage, performanceToCtxTime, eventsToTake, computerKeyPitch) se
 * prueban en scripts/verify-studio-v2-input.ts; la clase usa el navegador.
 */
import {
  STUDIO_MAX_BEAT,
  STUDIO_MAX_NOTES_PER_CLIP,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MIDI_MIN_CLIP_BEATS,
  STUDIO_MIDI_MIN_NOTE_BEATS,
  roundBeat,
  secondsToBeats,
  type StudioMidiNote,
} from './session.ts'
import { normalizeNotes, quantize } from './midiOps.ts'
import {
  COMPUTER_KEYBOARD_DEFAULT_OCTAVE,
  computerKeyPitch,
  createComputerKeyboard,
  isComputerKeyboardCode,
  type ComputerKeyboard,
} from './computerKeyboard.ts'
import type {
  MidiAccessStatus,
  MidiInputApi,
  MidiInputDevice,
  MidiNoteEvent,
  MidiRecordOptions,
  MidiRecordingApi,
  MidiTake,
} from './types.ts'

// El teclado de la computadora (mapa de teclas, octava, velocidad 100) vive en computerKeyboard.ts;
// computerKeyPitch se reexporta aqui porque es parte de MidiRecordingApi (types.ts).
export { computerKeyPitch }

/**
 * Tolerancia para una nota tocada apenas antes del arranque (el musico se adelanta al primer
 * tiempo): hasta 60 ms antes de playStartCtxTime la nota se conserva y su beat se acota al
 * inicio de la toma. Lo anterior (el conteo) se descarta.
 */
export const MIDI_EARLY_TOLERANCE_S = 0.06
/** Tope de eventos guardados en una toma: lo que llega despues se ignora (memoria acotada). */
export const MIDI_MAX_RECORDED_EVENTS = 4 * STUDIO_MAX_NOTES_PER_CLIP

// ---------------------------------------------------------------------------
// Puras
// ---------------------------------------------------------------------------

/** Mensaje MIDI de nota ya leido. Note-on con velocidad 0 es note-off (norma MIDI 1.0). */
export interface ParsedMidiNote {
  type: 'on' | 'off'
  channel: number
  pitch: number
  velocity: number
}

/**
 * Lee un mensaje de nota (0x8n note-off, 0x9n note-on). Todo lo demas (control, pitch bend,
 * reloj, sysex, mensajes cortados) devuelve null. Running status no aplica: Web MIDI entrega
 * cada mensaje completo con su byte de estado.
 */
export function parseMidiMessage(data: ArrayLike<number> | null | undefined): ParsedMidiNote | null {
  if (!data || data.length < 3) return null
  const status = data[0] & 0xff
  const command = status & 0xf0
  if (command !== 0x80 && command !== 0x90) return null
  const pitch = data[1] & 0x7f
  const velocity = data[2] & 0x7f
  const channel = status & 0x0f
  if (command === 0x90 && velocity > 0) return { type: 'on', channel, pitch, velocity }
  return { type: 'off', channel, pitch, velocity: command === 0x80 ? velocity : 0 }
}

/** timeStamp de performance.now() (ms) -> tiempo del AudioContext (s). Ver el comentario del modulo. */
export function performanceToCtxTime(timeStampMs: number, stamp: { contextTime: number; performanceTime: number }): number {
  return stamp.contextTime + (timeStampMs - stamp.performanceTime) / 1000
}

/** Region de repeticion del transporte durante la toma, en beats de la sesion. */
export interface MidiLoopRegion {
  startBeat: number
  endBeat: number
}

/**
 * Opciones de una toma. Ademas de MidiRecordOptions (types.ts): `beatsPerBar` (para alinear el
 * clip al compas; 4 si falta) y `loop` (region que repite el transporte, o null).
 */
export type MidiTakeOptions = MidiRecordOptions & {
  stopCtxTime: number
  beatsPerBar: number
  loop?: MidiLoopRegion | null
}

function channelMatches(event: MidiNoteEvent, channel: number | 'all'): boolean {
  // El teclado de la computadora es el respaldo sin dispositivo: siempre se graba.
  return channel === 'all' || event.source === 'keyboard' || event.channel === channel
}

function validLoop(loop: MidiLoopRegion | null | undefined): MidiLoopRegion | null {
  if (!loop || !Number.isFinite(loop.startBeat) || !Number.isFinite(loop.endBeat)) return null
  if (loop.startBeat < 0 || loop.endBeat - loop.startBeat < STUDIO_MIDI_MIN_CLIP_BEATS) return null
  return loop
}

/** Ultimo beat permitido para el final de un clip: 5200 beats y 1200 s al tempo de la sesion. */
function maxEndBeat(bpm: number): number {
  return Math.min(STUDIO_MAX_BEAT, secondsToBeats(STUDIO_MAX_SESSION_SECONDS, bpm))
}

interface OpenNote {
  pitch: number
  velocity: number
  beat: number
}

/**
 * Eventos capturados -> toma (puro). Cada evento se pasa a beats de la sesion con
 *     beat = (ctxTime - playStartCtxTime) * bpm / 60 + secondsToBeats(positionAtStart, bpm)
 * Se descartan los eventos del conteo (antes de playStartCtxTime menos MIDI_EARLY_TOLERANCE_S),
 * los de otro canal y los posteriores a stopCtxTime. Un note-on repetido sobre una nota que sigue
 * sonando cierra la anterior; un note-off sin su note-on se ignora; las notas que siguen apretadas
 * al parar se cierran en stopCtxTime (`hangingNotes`).
 *
 * Sin loop, el clip empieza en el compas de la primera nota y termina al final del compas en que
 * termina la ultima. Con loop, el clip es exactamente la region y cada nota se dobla dentro de
 * ella (beat relativo modulo el largo de la region): las vueltas se superponen.
 * Las notas salen normalizadas (midiOps.normalizeNotes) y, si se pidio, cuantizadas. Null si no
 * quedo ninguna nota.
 */
export function eventsToTake(events: readonly MidiNoteEvent[], options: MidiTakeOptions): MidiTake | null {
  const { playStart, bpm } = options
  if (!Number.isFinite(bpm) || bpm <= 0) return null
  const beatsPerBar = Number.isInteger(options.beatsPerBar) && options.beatsPerBar > 0 ? options.beatsPerBar : 4
  const startBeat0 = secondsToBeats(playStart.positionAtStart, bpm)
  const toBeat = (ctxTime: number) => Math.max(0, (ctxTime - playStart.playStartCtxTime) * bpm / 60 + startBeat0)
  const earliest = playStart.playStartCtxTime - MIDI_EARLY_TOLERANCE_S
  const stopBeat = toBeat(options.stopCtxTime)
  const endLimit = maxEndBeat(bpm)

  const ordered = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => Number.isFinite(event.ctxTime) && event.ctxTime >= earliest && event.ctxTime <= options.stopCtxTime)
    .filter(({ event }) => channelMatches(event, options.channel))
    // Orden estable por tiempo; a igual tiempo, los note-off antes que los note-on.
    .sort((a, b) => a.event.ctxTime - b.event.ctxTime || (a.event.type === b.event.type ? a.index - b.index : a.event.type === 'off' ? -1 : 1))

  const open = new Map<number, OpenNote>()
  const absolute: StudioMidiNote[] = []
  const close = (note: OpenNote, endBeat: number) => {
    absolute.push({ pitch: note.pitch, start: note.beat, length: Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, endBeat - note.beat), velocity: note.velocity })
  }
  for (const { event } of ordered) {
    if (!Number.isInteger(event.pitch) || event.pitch < 0 || event.pitch > 127) continue
    const beat = toBeat(event.ctxTime)
    const sounding = open.get(event.pitch)
    if (event.type === 'on') {
      if (sounding) close(sounding, beat)
      const velocity = Math.min(127, Math.max(1, Math.round(event.velocity)))
      open.set(event.pitch, { pitch: event.pitch, velocity, beat })
    } else if (sounding) {
      close(sounding, beat)
      open.delete(event.pitch)
    }
  }
  const hangingNotes = open.size
  for (const note of open.values()) close(note, stopBeat)
  if (absolute.length === 0) return null

  const loop = validLoop(options.loop)
  let clipStart: number
  let clipLength: number
  let relative: StudioMidiNote[]
  if (loop) {
    clipStart = loop.startBeat
    clipLength = Math.min(loop.endBeat, endLimit) - loop.startBeat
    if (clipLength < STUDIO_MIDI_MIN_CLIP_BEATS) return null
    const span = loop.endBeat - loop.startBeat
    relative = absolute
      .filter((n) => n.start >= loop.startBeat - 1e-9)
      .map((n) => {
        const offset = (n.start - loop.startBeat) % span
        return { ...n, start: offset >= span - 1e-9 ? 0 : Math.max(0, offset) }
      })
  } else {
    const first = Math.min(...absolute.map((n) => n.start))
    const last = Math.max(...absolute.map((n) => n.start + n.length))
    clipStart = Math.floor(first / beatsPerBar + 1e-9) * beatsPerBar
    const clipEnd = Math.min(endLimit, Math.max(clipStart + beatsPerBar, Math.ceil(last / beatsPerBar - 1e-9) * beatsPerBar))
    clipLength = clipEnd - clipStart
    if (clipLength < STUDIO_MIDI_MIN_CLIP_BEATS) return null
    relative = absolute.map((n) => ({ ...n, start: n.start - clipStart }))
  }

  clipStart = roundBeat(clipStart)
  clipLength = roundBeat(clipLength)
  let notes = normalizeNotes(relative, clipLength)
  if (options.quantize) notes = quantize(notes, null, options.quantize, clipLength).notes
  if (notes.length > STUDIO_MAX_NOTES_PER_CLIP) notes = notes.slice(0, STUDIO_MAX_NOTES_PER_CLIP)
  if (notes.length === 0) return null
  return { trackId: options.trackId, startBeat: clipStart, lengthBeats: clipLength, notes, hangingNotes }
}

void ({ performanceToCtxTime, eventsToTake, computerKeyPitch } satisfies MidiRecordingApi)

// ---------------------------------------------------------------------------
// Navegador: tipos minimos (estructurales, para poder inyectar dobles en las pruebas)
// ---------------------------------------------------------------------------

/** Lo que se usa de un MIDIInput de Web MIDI. */
export interface MidiInputPortLike {
  readonly id: string
  readonly name?: string | null
  readonly manufacturer?: string | null
  readonly state?: string
  readonly type?: string
  addEventListener(type: 'midimessage', listener: (event: { data?: ArrayLike<number> | null; timeStamp?: number }) => void): void
  removeEventListener(type: 'midimessage', listener: (event: { data?: ArrayLike<number> | null; timeStamp?: number }) => void): void
  /** Cierra el puerto (Web MIDI lo abre solo al escuchar, pero quitar el oyente no lo cierra). */
  close?: () => Promise<unknown>
}

/**
 * true si el objetivo de una pulsacion esta dentro de un dialogo (hoja de atajos, paleta,
 * exportar): ahi las letras son del dialogo, no del teclado musical. Sin DOM (pruebas), false.
 */
export function isInsideDialog(target: unknown): boolean {
  const el = target as { closest?: (selector: string) => unknown } | null
  return typeof el?.closest === 'function' && Boolean(el.closest('[role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
}

/** Lo que se usa de un MIDIAccess. */
export interface MidiAccessLike {
  readonly inputs: { values(): Iterable<MidiInputPortLike>; get(id: string): MidiInputPortLike | undefined }
  addEventListener(type: 'statechange', listener: (event: { port?: { id: string; type?: string; state?: string } | null }) => void): void
  removeEventListener(type: 'statechange', listener: (event: { port?: { id: string; type?: string; state?: string } | null }) => void): void
}

export interface MidiNavigatorLike {
  requestMIDIAccess?: (options?: { sysex?: boolean; software?: boolean }) => Promise<MidiAccessLike>
  permissions?: { query(descriptor: { name: string }): Promise<{ state: string }> }
}

/** Lo que se usa del AudioContext para pasar al reloj del contexto. */
export interface MidiClockContext {
  readonly currentTime: number
  readonly baseLatency?: number
  readonly outputLatency?: number
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number }
}

export interface StudioMidiInputDeps {
  /** El contexto del motor (engine.getContext()): la entrada comparte su reloj. */
  getContext: () => MidiClockContext
  /** Por defecto `navigator`. */
  navigator?: MidiNavigatorLike
  /** Por defecto performance.now(). */
  now?: () => number
  /** Donde escucha el teclado de la computadora si setComputerKeyboard no recibe otro. Por defecto `window`. */
  keyboardTarget?: EventTarget
}

/** Par de relojes vigente (ver el comentario del modulo). */
export function clockStamp(ctx: MidiClockContext, nowMs: number): { contextTime: number; performanceTime: number } {
  const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null
  if (stamp && Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime) && (stamp.performanceTime ?? 0) > 0) {
    return { contextTime: stamp.contextTime as number, performanceTime: stamp.performanceTime as number }
  }
  const base = Number.isFinite(ctx.baseLatency) ? (ctx.baseLatency as number) : 0
  const output = Number.isFinite(ctx.outputLatency) ? (ctx.outputLatency as number) : 0
  return { contextTime: ctx.currentTime - base - output, performanceTime: nowMs }
}

/** true si el foco esta en un campo donde se escribe: ahi el teclado nunca toca notas. */
export function isTextFieldTarget(target: EventTarget | null | undefined): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown; type?: unknown } | null | undefined
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable === true) return true
  const tag = el.tagName.toUpperCase()
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  // Casillas, radios, botones y deslizadores no escriben texto.
  const type = typeof el.type === 'string' ? el.type.toLowerCase() : 'text'
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type)
}

interface RecordingState {
  options: MidiRecordOptions & { beatsPerBar?: number; loop?: MidiLoopRegion | null }
  events: MidiNoteEvent[]
}

type MessageListener = (event: { data?: ArrayLike<number> | null; timeStamp?: number }) => void

/**
 * Entrada MIDI del Estudio. Una sola instancia por vista del Estudio; `close()` al salir.
 *
 * Teclado de la computadora (reglas de computerKeyboard.ts): escucha keydown y keyup en fase de
 * captura. Las teclas del teclado musical (isComputerKeyboardCode) sin Ctrl, Alt, Cmd ni Shift se
 * consumen (preventDefault y stopPropagation) mientras el modo esta activo, para que no disparen
 * los atajos de una letra (S dividir...). Con el foco en un campo de texto no hace nada. Al perder
 * el foco la ventana se sueltan todas las notas (no quedan notas colgadas).
 */
export class StudioMidiInput implements MidiInputApi {
  private readonly getContext: () => MidiClockContext
  private readonly nav: MidiNavigatorLike | null
  private readonly now: () => number
  private readonly defaultKeyboardTarget: EventTarget | null

  private access: MidiAccessLike | null = null
  private openPort: MidiInputPortLike | null = null
  private openDeviceId: string | null = null
  private openChannel: number | 'all' = 'all'
  private keyboardTarget: EventTarget | null = null
  private readonly keyboard: ComputerKeyboard = createComputerKeyboard(COMPUTER_KEYBOARD_DEFAULT_OCTAVE)
  private readonly noteListeners = new Set<(event: MidiNoteEvent) => void>()
  private readonly deviceListeners = new Set<(devices: MidiInputDevice[]) => void>()
  private readonly octaveListeners = new Set<(octave: number) => void>()
  private recording: RecordingState | null = null
  private closed = false

  constructor(deps: StudioMidiInputDeps) {
    this.getContext = deps.getContext
    const globalNav = typeof navigator === 'undefined' ? null : (navigator as unknown as MidiNavigatorLike)
    this.nav = deps.navigator ?? globalNav
    this.now = deps.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()))
    this.defaultKeyboardTarget = deps.keyboardTarget ?? (typeof window === 'undefined' ? null : window)
  }

  isSupported(): boolean {
    return typeof this.nav?.requestMIDIAccess === 'function'
  }

  /**
   * Estado del permiso SIN pedirlo (Permissions API con nombre 'midi'), para pintar el boton antes
   * del gesto del usuario. 'prompt' si el navegador no lo informa.
   */
  async queryAccess(): Promise<MidiAccessStatus> {
    if (!this.isSupported()) return 'unsupported'
    if (this.access) return 'granted'
    try {
      const status = await this.nav?.permissions?.query({ name: 'midi' })
      if (status?.state === 'granted') return 'granted'
      if (status?.state === 'denied') return 'denied'
    } catch {
      // Permissions API sin 'midi': se decide al pedir el acceso
    }
    return 'prompt'
  }

  async requestAccess(): Promise<MidiAccessStatus> {
    if (this.closed) return 'denied'
    if (!this.isSupported() || !this.nav?.requestMIDIAccess) return 'unsupported'
    if (this.access) return 'granted'
    try {
      // Sin sysex: no hace falta para notas y no pide el permiso ampliado.
      const access = await this.nav.requestMIDIAccess({ sysex: false })
      if (this.closed) return 'denied'
      this.access = access
      access.addEventListener('statechange', this.handleStateChange)
      this.emitDevices()
      return 'granted'
    } catch {
      // SecurityError o NotAllowedError: el usuario o la politica del sitio lo negaron.
      return 'denied'
    }
  }

  listInputs(): MidiInputDevice[] {
    if (!this.access) return []
    const out: MidiInputDevice[] = []
    for (const port of this.access.inputs.values()) {
      out.push({
        id: port.id,
        name: port.name?.trim() || 'Dispositivo MIDI',
        manufacturer: port.manufacturer?.trim() || '',
        connected: port.state !== 'disconnected',
      })
    }
    return out
  }

  onDevicesChange(listener: (devices: MidiInputDevice[]) => void): () => void {
    this.deviceListeners.add(listener)
    return () => this.deviceListeners.delete(listener)
  }

  open(deviceId: string, channel: number | 'all'): void {
    if (this.closed) throw new Error('La entrada MIDI ya se cerró.')
    if (channel !== 'all' && (!Number.isInteger(channel) || channel < 0 || channel > 15)) throw new Error('El canal MIDI debe estar entre 1 y 16.')
    this.detachPort()
    this.openChannel = channel
    const port = this.access?.inputs.get(deviceId)
    if (!port) {
      this.openDeviceId = null
      throw new Error('Ese dispositivo MIDI no está conectado. Conéctalo y vuelve a elegirlo.')
    }
    this.openDeviceId = deviceId
    this.attachPort(port)
  }

  setComputerKeyboard(enabled: boolean, target?: EventTarget): void {
    this.detachKeyboard()
    if (!enabled || this.closed) return
    const where = target ?? this.defaultKeyboardTarget
    if (!where) return
    this.keyboardTarget = where
    where.addEventListener('keydown', this.handleKeyDown as EventListener, { capture: true })
    where.addEventListener('keyup', this.handleKeyUp as EventListener, { capture: true })
    where.addEventListener('blur', this.handleBlur, { capture: true })
  }

  /** Octava base actual del teclado de la computadora (4 = Do central en la A). */
  getComputerKeyboardOctave(): number {
    return this.keyboard.octave
  }

  setComputerKeyboardOctave(octave: number): void {
    this.keyboard.setOctave(octave)
  }

  /**
   * Cambios de octava del teclado de la computadora hechos con Z y X (para el indicador de la
   * interfaz). setComputerKeyboardOctave no avisa: quien la llama ya sabe la octava nueva.
   */
  onOctaveChange(listener: (octave: number) => void): () => void {
    this.octaveListeners.add(listener)
    return () => this.octaveListeners.delete(listener)
  }

  onNote(listener: (event: MidiNoteEvent) => void): () => void {
    this.noteListeners.add(listener)
    return () => this.noteListeners.delete(listener)
  }

  /**
   * Empieza a guardar las notas entrantes para una toma. Ademas de MidiRecordOptions admite
   * `beatsPerBar` (4 por defecto) y `loop` (region que repite el transporte).
   */
  startRecording(options: MidiRecordOptions & { beatsPerBar?: number; loop?: MidiLoopRegion | null }): void {
    if (this.closed) throw new Error('La entrada MIDI ya se cerró.')
    if (this.recording) throw new Error('Ya hay una grabación MIDI en curso.')
    if (!Number.isFinite(options.bpm) || options.bpm <= 0) throw new Error('El tempo de la sesión no es válido para grabar.')
    this.recording = { options, events: [] }
  }

  stopRecording(stopCtxTime: number): MidiTake | null {
    const recording = this.recording
    this.recording = null
    if (!recording) return null
    const { options } = recording
    return eventsToTake(recording.events, {
      ...options,
      stopCtxTime,
      beatsPerBar: options.beatsPerBar ?? 4,
      loop: options.loop ?? null,
    })
  }

  isRecording(): boolean {
    return this.recording !== null
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.recording = null
    this.detachPort()
    this.detachKeyboard()
    this.access?.removeEventListener('statechange', this.handleStateChange)
    this.access = null
    this.noteListeners.clear()
    this.deviceListeners.clear()
    this.octaveListeners.clear()
  }

  // --- internos ---

  private ctxTimeOf(timeStampMs: number | undefined): number {
    const now = this.now()
    // Algunos navegadores entregan timeStamp 0 en mensajes sinteticos: se usa "ahora".
    const ts = typeof timeStampMs === 'number' && Number.isFinite(timeStampMs) && timeStampMs > 0 ? timeStampMs : now
    return performanceToCtxTime(ts, clockStamp(this.getContext(), now))
  }

  private emit(event: MidiNoteEvent): void {
    const rec = this.recording
    if (rec && rec.events.length < MIDI_MAX_RECORDED_EVENTS) rec.events.push(event)
    for (const listener of [...this.noteListeners]) {
      try {
        listener(event)
      } catch {
        // un oyente que falla no corta la entrada MIDI
      }
    }
  }

  private emitDevices(): void {
    const devices = this.listInputs()
    for (const listener of [...this.deviceListeners]) {
      try {
        listener(devices)
      } catch {
        // idem
      }
    }
  }

  private attachPort(port: MidiInputPortLike): void {
    this.openPort = port
    // Agregar el oyente abre el puerto implicitamente (Web MIDI).
    port.addEventListener('midimessage', this.handleMessage)
  }

  private detachPort(): void {
    const port = this.openPort
    this.openPort = null
    if (!port) return
    port.removeEventListener('midimessage', this.handleMessage)
    // Sin close() el puerto queda abierto mientras viva la pestana: en Windows (WinMM, de uso
    // exclusivo) otra aplicacion no podria abrir el teclado hasta cerrarla.
    try {
      void port.close?.().catch(() => undefined)
    } catch {
      // un puerto que ya no existe no impide soltar el resto
    }
  }

  private detachKeyboard(): void {
    const where = this.keyboardTarget
    if (where) {
      where.removeEventListener('keydown', this.handleKeyDown as EventListener, { capture: true })
      where.removeEventListener('keyup', this.handleKeyUp as EventListener, { capture: true })
      where.removeEventListener('blur', this.handleBlur, { capture: true })
    }
    this.keyboardTarget = null
    this.releaseHeldKeys(undefined)
  }

  private releaseHeldKeys(timeStamp: number | undefined): void {
    const released = this.keyboard.releaseAll()
    if (released.length === 0) return
    const ctxTime = this.ctxTimeOf(timeStamp)
    for (const action of released) {
      if (action.type === 'note_off') this.emit({ type: 'off', pitch: action.pitch, velocity: 0, channel: 0, ctxTime, source: 'keyboard' })
    }
  }

  /** true si la pulsacion es del teclado musical y debe consumirse (no llega a los atajos). */
  private consumesKey(event: KeyboardEvent): boolean {
    return isComputerKeyboardCode(event.code) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
  }

  private readonly handleMessage: MessageListener = (event) => {
    const parsed = parseMidiMessage(event.data)
    if (!parsed) return
    if (this.openChannel !== 'all' && parsed.channel !== this.openChannel) return
    this.emit({ ...parsed, ctxTime: this.ctxTimeOf(event.timeStamp), source: 'midi' })
  }

  private readonly handleStateChange = (event: { port?: { id: string; type?: string; state?: string } | null }): void => {
    const port = event.port
    // Conexion en caliente: si vuelve el dispositivo abierto, se engancha de nuevo.
    if (port && port.type === 'input' && port.id === this.openDeviceId && port.state === 'connected') {
      const current = this.access?.inputs.get(port.id)
      if (current && current !== this.openPort) {
        this.detachPort()
        this.attachPort(current)
      }
    }
    this.emitDevices()
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (isTextFieldTarget(event.target) || isInsideDialog(event.target)) return
    if (this.consumesKey(event)) {
      event.preventDefault()
      event.stopPropagation()
    }
    const action = this.keyboard.keyDown(event)
    if (action?.type === 'note_on') {
      this.emit({ type: 'on', pitch: action.pitch, velocity: action.velocity, channel: 0, ctxTime: this.ctxTimeOf(event.timeStamp), source: 'keyboard' })
    } else if (action?.type === 'octave') {
      for (const listener of [...this.octaveListeners]) {
        try {
          listener(action.octave)
        } catch {
          // un oyente que falla no corta el teclado
        }
      }
    }
  }

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    // Se suelta aunque el foco haya pasado a un campo: la nota empezo fuera de el.
    const action = this.keyboard.keyUp(event)
    if (action || (this.consumesKey(event) && !isTextFieldTarget(event.target) && !isInsideDialog(event.target))) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (action?.type === 'note_off') {
      this.emit({ type: 'off', pitch: action.pitch, velocity: 0, channel: 0, ctxTime: this.ctxTimeOf(event.timeStamp), source: 'keyboard' })
    }
  }

  private readonly handleBlur = (): void => {
    this.releaseHeldKeys(undefined)
  }
}
