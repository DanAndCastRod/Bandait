/**
 * Logica pura de la ventana del asistente del Estudio (components/studio/StudioAssistant.tsx y
 * StudioChatPanel.tsx): modos y limites de la ventana, conversacion guardable en IndexedDB, zona
 * que se escucha antes de aplicar un cambio, chips de contexto y pedidos rapidos.
 *
 * Modulo puro: sin DOM, React ni import.meta.env (se prueba en scripts/verify-studio-v2-input.ts).
 */
import type { PendingAssistantCommand } from './assistantTools.ts'
import { findClip, findMidiClip, findTrack, secondsToBeats, type StudioSession } from './session.ts'
import type { CommandContext, StudioChatMessage, StudioChatToolCall, StudioChatToolResult, StudioJobEstimateV2 } from './types.ts'

// ---------------------------------------------------------------------------
// Ventana: modos, posicion y tamano
// ---------------------------------------------------------------------------

/** ACOPLADO (columna a la derecha), FLOTANTE (ventana libre) o MINIMIZADO (pastilla). */
export type AssistantMode = 'docked' | 'floating' | 'minimized'

export interface AssistantRect {
  x: number
  y: number
  w: number
  h: number
}

export interface AssistantLayout {
  mode: AssistantMode
  /** Modo al que vuelve al mostrarse (Alt+A o la pastilla). */
  lastOpen: 'docked' | 'floating'
  /** Ancho de la columna acoplada, en px. */
  dockWidth: number
  /** Posicion y tamano de la ventana flotante, en px de la ventana del navegador. */
  float: AssistantRect
}

export interface Viewport {
  width: number
  height: number
}

export const ASSISTANT_LAYOUT_STORAGE_KEY = 'bandait_studio_assistant'
/** Por debajo de este ancho la ventana flotante es una hoja inferior. */
export const ASSISTANT_NARROW_PX = 760
export const ASSISTANT_DOCK_MIN_W = 300
export const ASSISTANT_DOCK_MAX_W = 640
export const ASSISTANT_DOCK_DEFAULT_W = 380
export const ASSISTANT_FLOAT_MIN_W = 300
export const ASSISTANT_FLOAT_MIN_H = 280
/** Margen que la ventana flotante deja con los bordes del navegador. */
export const ASSISTANT_EDGE_PX = 8

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** Ancho de la columna acoplada: entre el minimo y el 60 % de la ventana (sin pasar el maximo). */
export function clampDockWidth(width: number, viewport: Viewport): number {
  const max = Math.min(ASSISTANT_DOCK_MAX_W, Math.floor(viewport.width * 0.6))
  return Math.round(clampNumber(finite(width, ASSISTANT_DOCK_DEFAULT_W), ASSISTANT_DOCK_MIN_W, max))
}

/**
 * Ventana flotante dentro del navegador: el tamano entre el minimo y lo que cabe con margen, y la
 * posicion de modo que la ventana entera quede visible. Con un navegador mas chico que el minimo,
 * la ventana ocupa lo que hay desde el margen.
 */
export function clampFloatRect(rect: AssistantRect, viewport: Viewport): AssistantRect {
  const room = { w: Math.max(0, viewport.width - 2 * ASSISTANT_EDGE_PX), h: Math.max(0, viewport.height - 2 * ASSISTANT_EDGE_PX) }
  const w = Math.round(Math.min(clampNumber(finite(rect.w, 420), ASSISTANT_FLOAT_MIN_W, room.w), room.w))
  const h = Math.round(Math.min(clampNumber(finite(rect.h, 560), ASSISTANT_FLOAT_MIN_H, room.h), room.h))
  const x = Math.round(clampNumber(finite(rect.x, 0), ASSISTANT_EDGE_PX, viewport.width - ASSISTANT_EDGE_PX - w))
  const y = Math.round(clampNumber(finite(rect.y, 0), ASSISTANT_EDGE_PX, viewport.height - ASSISTANT_EDGE_PX - h))
  return { x, y, w, h }
}

/** Ventana flotante por defecto: abajo a la derecha. */
export function defaultFloatRect(viewport: Viewport): AssistantRect {
  const w = 420
  const h = Math.min(600, Math.round(viewport.height * 0.7))
  return clampFloatRect({ x: viewport.width - w - 24, y: viewport.height - h - 24, w, h }, viewport)
}

export function defaultAssistantLayout(viewport: Viewport): AssistantLayout {
  return { mode: 'minimized', lastOpen: 'docked', dockWidth: clampDockWidth(ASSISTANT_DOCK_DEFAULT_W, viewport), float: defaultFloatRect(viewport) }
}

/** Layout guardado (JSON de localStorage) saneado y acotado a la ventana; lo invalido toma el valor por defecto. */
export function parseAssistantLayout(raw: string | null, viewport: Viewport): AssistantLayout {
  const fallback = defaultAssistantLayout(viewport)
  if (!raw) return fallback
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof data !== 'object' || data === null) return fallback
  const v = data as Record<string, unknown>
  const mode: AssistantMode = v.mode === 'docked' || v.mode === 'floating' || v.mode === 'minimized' ? v.mode : fallback.mode
  const lastOpen = v.lastOpen === 'floating' || v.lastOpen === 'docked' ? v.lastOpen : mode === 'floating' ? 'floating' : 'docked'
  const f = typeof v.float === 'object' && v.float !== null ? (v.float as Record<string, unknown>) : {}
  const float = clampFloatRect(
    { x: finite(f.x, fallback.float.x), y: finite(f.y, fallback.float.y), w: finite(f.w, fallback.float.w), h: finite(f.h, fallback.float.h) },
    viewport,
  )
  return { mode, lastOpen, dockWidth: clampDockWidth(finite(v.dockWidth, fallback.dockWidth), viewport), float }
}

export function serializeAssistantLayout(layout: AssistantLayout): string {
  return JSON.stringify({ mode: layout.mode, lastOpen: layout.lastOpen, dockWidth: layout.dockWidth, float: layout.float })
}

/** Cambia de modo recordando a cual volver. */
export function withAssistantMode(layout: AssistantLayout, mode: AssistantMode): AssistantLayout {
  if (mode === layout.mode) return layout
  return { ...layout, mode, lastOpen: mode === 'minimized' ? layout.lastOpen : mode }
}

/** Alt+A: minimizado vuelve al ultimo modo abierto; abierto se minimiza. */
export function toggleAssistantLayout(layout: AssistantLayout): AssistantLayout {
  return withAssistantMode(layout, layout.mode === 'minimized' ? layout.lastOpen : 'minimized')
}

// ---------------------------------------------------------------------------
// Conversacion guardada (IndexedDB, por sesion del Estudio)
// ---------------------------------------------------------------------------

/** Llamadas de la ultima respuesta del asistente que esperan decision. */
export interface AssistantProposal {
  calls: StudioChatToolCall[]
  pendings: PendingAssistantCommand[]
}

export interface StoredAssistantChat {
  version: 1
  messages: StudioChatMessage[]
  proposal: AssistantProposal | null
  /** Descripcion legible de cada llamada ya decidida, por call_id. */
  descriptions: Record<string, string>
  /** Costo por mensaje ya confirmado en esta conversacion (null = falta confirmar). */
  approved: StudioJobEstimateV2 | null
  spentUsd: number
}

/** Tope de mensajes guardados: el pedido al Worker se recorta a 40 igual (jobs.trimChatMessages). */
export const ASSISTANT_CHAT_MAX_STORED = 200

export function emptyAssistantChat(): StoredAssistantChat {
  return { version: 1, messages: [], proposal: null, descriptions: {}, approved: null, spentUsd: 0 }
}

/**
 * Conversacion lista para guardar: objetos planos (structured clone). Si un cambio se esta
 * escuchando (aplicado de forma provisional), se guarda como aplicado: si la pagina se cierra en
 * ese momento, el cambio queda en la sesion, y la conversacion debe decir lo mismo.
 */
export function serializeAssistantChat(chat: StoredAssistantChat, auditioning: PendingAssistantCommand | null = null): StoredAssistantChat {
  const messages = chat.messages.slice(-ASSISTANT_CHAT_MAX_STORED)
  const proposal = chat.proposal
    ? {
        calls: chat.proposal.calls.map((c) => ({ ...c, arguments: { ...c.arguments } })),
        pendings: chat.proposal.pendings.map((p) => (auditioning && p.callId === auditioning.callId ? { ...auditioning } : { ...p, args: { ...p.args }, adjusted: [...p.adjusted], ignored: [...p.ignored], ...(p.warnings ? { warnings: [...p.warnings] } : {}) })),
      }
    : null
  return {
    version: 1,
    messages: JSON.parse(JSON.stringify(messages)) as StudioChatMessage[],
    proposal: proposal ? (JSON.parse(JSON.stringify(proposal)) as AssistantProposal) : null,
    descriptions: { ...chat.descriptions },
    approved: chat.approved ? { ...chat.approved } : null,
    spentUsd: Number.isFinite(chat.spentUsd) && chat.spentUsd > 0 ? chat.spentUsd : 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const TOOL_STATUSES: ReadonlySet<string> = new Set(['applied', 'rejected', 'failed'])
const PENDING_STATUSES: ReadonlySet<string> = new Set(['pending', 'applied', 'rejected', 'failed'])

function parseToolCall(raw: unknown): StudioChatToolCall | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !isRecord(raw.arguments)) return null
  if (raw.signature !== null && typeof raw.signature !== 'string') return null
  return { id: raw.id, name: raw.name, arguments: raw.arguments, signature: raw.signature }
}

function parseToolResult(raw: unknown): StudioChatToolResult | null {
  if (!isRecord(raw) || typeof raw.callId !== 'string' || typeof raw.name !== 'string' || !isRecord(raw.response)) return null
  const { status, message } = raw.response
  if (typeof status !== 'string' || !TOOL_STATUSES.has(status) || typeof message !== 'string') return null
  return { callId: raw.callId, name: raw.name, response: { status: status as StudioChatToolResult['response']['status'], message } }
}

function parseMessage(raw: unknown): StudioChatMessage | null {
  if (!isRecord(raw)) return null
  if (raw.role === 'user') return typeof raw.text === 'string' && raw.text.length > 0 ? { role: 'user', text: raw.text } : null
  if (raw.role === 'model') {
    if (raw.text !== null && typeof raw.text !== 'string') return null
    if (!Array.isArray(raw.toolCalls)) return null
    const toolCalls = raw.toolCalls.map(parseToolCall)
    if (toolCalls.some((c) => c === null)) return null
    return { role: 'model', text: raw.text, toolCalls: toolCalls as StudioChatToolCall[] }
  }
  if (raw.role === 'tool') {
    if (!Array.isArray(raw.toolResults) || raw.toolResults.length === 0) return null
    const toolResults = raw.toolResults.map(parseToolResult)
    if (toolResults.some((r) => r === null)) return null
    return { role: 'tool', toolResults: toolResults as StudioChatToolResult[] }
  }
  return null
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((s) => typeof s === 'string') ? [...value] : null
}

function parsePending(raw: unknown): PendingAssistantCommand | null {
  if (!isRecord(raw)) return null
  const { callId, name, commandId, args, description, status, message } = raw
  if (typeof callId !== 'string' || typeof name !== 'string' || typeof description !== 'string' || typeof message !== 'string') return null
  if (commandId !== null && typeof commandId !== 'string') return null
  if (!isRecord(args) || typeof status !== 'string' || !PENDING_STATUSES.has(status)) return null
  const adjusted = stringList(raw.adjusted)
  const ignored = stringList(raw.ignored)
  if (!adjusted || !ignored) return null
  const pending: PendingAssistantCommand = { callId, name, commandId, args, description, status: status as PendingAssistantCommand['status'], message, adjusted, ignored }
  const warnings = raw.warnings === undefined ? undefined : stringList(raw.warnings)
  if (warnings) pending.warnings = warnings
  return pending
}

function parseEstimate(raw: unknown): StudioJobEstimateV2 | null {
  if (!isRecord(raw) || raw.kind !== 'chat') return null
  if (typeof raw.estimatedCostUsd !== 'number' || !Number.isFinite(raw.estimatedCostUsd) || typeof raw.allowed !== 'boolean') return null
  return raw as unknown as StudioJobEstimateV2
}

/**
 * Conversacion guardada, validada. Devuelve null si no hay o si esta danada (se empieza una nueva):
 * un mensaje con forma rara invalidaria el pedido al Worker (STUDIO_V2.md 4.3.1).
 */
export function parseStoredAssistantChat(raw: unknown): StoredAssistantChat | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.messages)) return null
  const messages = raw.messages.map(parseMessage)
  if (messages.some((m) => m === null)) return null
  let proposal: AssistantProposal | null = null
  if (raw.proposal !== null && raw.proposal !== undefined) {
    if (!isRecord(raw.proposal) || !Array.isArray(raw.proposal.calls) || !Array.isArray(raw.proposal.pendings)) return null
    const calls = raw.proposal.calls.map(parseToolCall)
    const pendings = raw.proposal.pendings.map(parsePending)
    if (calls.some((c) => c === null) || pendings.some((p) => p === null)) return null
    proposal = { calls: calls as StudioChatToolCall[], pendings: pendings as PendingAssistantCommand[] }
    // La propuesta responde a la ultima respuesta del modelo: si no, se descarta.
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'model' || last.toolCalls.length !== proposal.calls.length) proposal = null
  }
  const descriptions: Record<string, string> = {}
  if (isRecord(raw.descriptions)) for (const [k, v] of Object.entries(raw.descriptions)) if (typeof v === 'string') descriptions[k] = v
  const spent = typeof raw.spentUsd === 'number' && Number.isFinite(raw.spentUsd) && raw.spentUsd > 0 ? raw.spentUsd : 0
  return { version: 1, messages: messages as StudioChatMessage[], proposal, descriptions, approved: parseEstimate(raw.approved), spentUsd: spent }
}

// ---------------------------------------------------------------------------
// Escuchar antes de aplicar
// ---------------------------------------------------------------------------

export interface BeatRange {
  startBeat: number
  endBeat: number
}

/** Compases que se escuchan cuando el cambio no dice donde actua (desde el cabezal). */
export const AUDITION_FALLBACK_BARS = 8
/** Tope de la zona que se escucha: un clip largo se escucha desde su inicio. */
export const AUDITION_MAX_BARS = 16

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Rango en beats de un clip de audio o MIDI, o null si no existe. */
function clipRange(session: StudioSession, clipId: string): BeatRange | null {
  const audio = findClip(session, clipId)
  if (audio) {
    const startBeat = secondsToBeats(audio.clip.startS, session.bpm)
    return { startBeat, endBeat: startBeat + secondsToBeats(audio.clip.lengthS, session.bpm) }
  }
  const midi = findMidiClip(session, clipId)
  return midi ? { startBeat: midi.clip.startBeat, endBeat: midi.clip.startBeat + midi.clip.lengthBeats } : null
}

/** Clip de una pista mas cercano al cabezal (el que lo contiene, si hay). */
function trackRange(session: StudioSession, trackId: string, playheadBeat: number): BeatRange | null {
  const track = findTrack(session, trackId)
  if (!track) return null
  const ranges: BeatRange[] = []
  for (const c of track.clips) if (c.active) ranges.push({ startBeat: secondsToBeats(c.startS, session.bpm), endBeat: secondsToBeats(c.startS + c.lengthS, session.bpm) })
  for (const c of track.midiClips ?? []) ranges.push({ startBeat: c.startBeat, endBeat: c.startBeat + c.lengthBeats })
  let best: BeatRange | null = null
  let bestDistance = Infinity
  for (const r of ranges) {
    const d = playheadBeat < r.startBeat ? r.startBeat - playheadBeat : playheadBeat > r.endBeat ? playheadBeat - r.endBeat : 0
    if (d < bestDistance) {
      best = r
      bestDistance = d
    }
  }
  if (!best) return null
  // Con el cabezal dentro del clip se escucha desde el compas del cabezal.
  return bestDistance === 0 ? { startBeat: Math.max(best.startBeat, playheadBeat), endBeat: best.endBeat } : best
}

function union(a: BeatRange, b: BeatRange): BeatRange {
  return { startBeat: Math.min(a.startBeat, b.startBeat), endBeat: Math.max(a.endBeat, b.endBeat) }
}

/** La zona que toca un cambio propuesto, en beats, sin ajustar a compases. null = no se deduce. */
function rawZone(pending: Pick<PendingAssistantCommand, 'name' | 'args'>, session: StudioSession, playheadBeat: number): BeatRange | null {
  const a = pending.args
  const clipId = str(a.clip_id)
  const bar = session.beatsPerBar
  switch (pending.name) {
    case 'add_midi_clip': {
      const start = num(a.start_beat)
      const length = num(a.length_beats)
      return start !== null && length !== null ? { startBeat: start, endBeat: start + length } : null
    }
    case 'move_clip':
    case 'duplicate_clip': {
      const from = clipId ? clipRange(session, clipId) : null
      if (!from) return null
      const length = from.endBeat - from.startBeat
      const to = num(a.start_beat) ?? (pending.name === 'duplicate_clip' ? from.endBeat : from.startBeat)
      return union(from, { startBeat: to, endBeat: to + length })
    }
    case 'split_clip':
    case 'delete_clip':
    case 'set_clip_gain':
    case 'replace_midi_notes':
    case 'transpose_midi_clip':
    case 'quantize_midi_clip':
      return clipId ? clipRange(session, clipId) : null
    case 'add_marker': {
      const beat = num(a.beat)
      return beat !== null ? { startBeat: beat, endBeat: beat + AUDITION_FALLBACK_BARS * bar } : null
    }
    case 'remove_marker': {
      const id = str(a.marker_id)
      const marker = id ? (session.markers ?? []).find((m) => m.id === id) : undefined
      return marker ? { startBeat: marker.beat, endBeat: marker.beat + AUDITION_FALLBACK_BARS * bar } : null
    }
    case 'set_track_mix':
    case 'set_track_fx':
    case 'set_instrument':
    case 'remove_track': {
      const trackId = str(a.track_id)
      return trackId ? trackRange(session, trackId, playheadBeat) : null
    }
    default:
      return null
  }
}

/**
 * Zona que se reproduce en loop al ESCUCHAR un cambio: la del clip, pista o marca que toca,
 * ajustada a compases enteros, de 1 a 16 compases. Si no se puede deducir, 8 compases desde el
 * compas del cabezal. Se calcula con la sesion de ANTES de aplicar (el clip puede desaparecer).
 */
export function auditionZone(pending: Pick<PendingAssistantCommand, 'name' | 'args'>, session: StudioSession, playheadBeat: number): BeatRange {
  const bar = session.beatsPerBar > 0 ? session.beatsPerBar : 4
  const playhead = Number.isFinite(playheadBeat) ? Math.max(0, playheadBeat) : 0
  const zone = rawZone(pending, session, playhead)
  if (!zone || !(zone.endBeat > zone.startBeat) || !Number.isFinite(zone.startBeat) || !Number.isFinite(zone.endBeat)) {
    const start = Math.floor(playhead / bar) * bar
    return { startBeat: start, endBeat: start + AUDITION_FALLBACK_BARS * bar }
  }
  const startBeat = Math.max(0, Math.floor(zone.startBeat / bar) * bar)
  let endBeat = Math.ceil(zone.endBeat / bar - 1e-9) * bar
  endBeat = Math.max(endBeat, startBeat + bar)
  endBeat = Math.min(endBeat, startBeat + AUDITION_MAX_BARS * bar)
  return { startBeat, endBeat }
}

// ---------------------------------------------------------------------------
// Contexto que viaja y pedidos rapidos
// ---------------------------------------------------------------------------

/** "c. 5-8" (o "c. 5") para un rango de beats; los compases empiezan en 1. */
export function barRangeText(range: BeatRange, beatsPerBar: number): string {
  const bar = beatsPerBar > 0 ? beatsPerBar : 4
  const first = Math.floor(range.startBeat / bar + 1e-9) + 1
  const last = Math.max(first, Math.ceil(range.endBeat / bar - 1e-9))
  return first === last ? `c. ${first}` : `c. ${first}-${last}`
}

export interface AssistantContextChip {
  id: 'track' | 'clip' | 'loop' | 'view'
  label: string
  value: string
}

export interface AssistantContextInput {
  session: StudioSession
  selectedTrackId: string | null
  selectedClipId: string | null
  loop: BeatRange | null
  context: CommandContext
}

const CONTEXT_NAMES: Readonly<Record<CommandContext, string>> = {
  global: 'ESTUDIO',
  timeline: 'LÍNEA DE TIEMPO',
  piano_roll: 'PIANO ROLL',
  mixer: 'MEZCLADOR',
}

/** Lo que el asistente sabe de donde esta parado el musico, para mostrarlo como chips. */
export function assistantContextChips(input: AssistantContextInput): AssistantContextChip[] {
  const { session } = input
  const chips: AssistantContextChip[] = []
  const track = input.selectedTrackId ? findTrack(session, input.selectedTrackId) : null
  if (track) chips.push({ id: 'track', label: 'PISTA', value: track.name })
  const clip = input.selectedClipId ? clipRange(session, input.selectedClipId) : null
  if (clip) chips.push({ id: 'clip', label: 'CLIP', value: barRangeText(clip, session.beatsPerBar) })
  if (input.loop && input.loop.endBeat > input.loop.startBeat) chips.push({ id: 'loop', label: 'LOOP', value: barRangeText(input.loop, session.beatsPerBar) })
  chips.push({ id: 'view', label: 'VISTA', value: CONTEXT_NAMES[input.context] })
  return chips
}

export interface AssistantQuickAction {
  id: 'arrangement' | 'mix' | 'track'
  label: string
  /** true si necesita una pista elegida. */
  needsTrack: boolean
}

export const ASSISTANT_QUICK_ACTIONS: readonly AssistantQuickAction[] = [
  { id: 'arrangement', label: 'SUGERIR ARREGLO', needsTrack: false },
  { id: 'mix', label: 'REVISAR MEZCLA', needsTrack: false },
  { id: 'track', label: 'EXPLICAR ESTA PISTA', needsTrack: true },
]

/** Pedido en espanol que llena una accion rapida (el musico lo puede editar antes de enviar). */
export function quickActionText(id: AssistantQuickAction['id'], trackName: string | null, loop: BeatRange | null, beatsPerBar: number): string {
  const where = loop && loop.endBeat > loop.startBeat ? ` en la zona del loop (${barRangeText(loop, beatsPerBar)})` : ''
  switch (id) {
    case 'arrangement':
      return `Sugiere un arreglo${where}: qué partes o instrumentos agregar y en qué compases, según el tempo, la tonalidad y las secciones. Propón los cambios para que yo los apruebe.`
    case 'mix':
      return `Revisa la mezcla${where}: niveles, paneo, ecualización, compresión y reverb de cada pista y del master. Dime qué cambiarías y por qué, y propón los ajustes.`
    case 'track':
      return trackName
        ? `Explica qué hace la pista "${trackName}" en la canción${where} y qué mejorarías de su sonido o de su parte.`
        : `Explica qué hace la pista seleccionada en la canción${where} y qué mejorarías.`
  }
}
