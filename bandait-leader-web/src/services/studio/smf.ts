/**
 * Archivos MIDI estandar (SMF) tipo 0 y 1 para el Estudio Bandait: importar y exportar `.mid`.
 * Contrato: types.ts, seccion "v2 · smf.ts". Modulo propio y puro, sin dependencias.
 *
 * Formato (Standard MIDI File 1.0, MIDI Association):
 *   - Cabecera "MThd": largo 6, formato (0, 1 o 2), numero de pistas y division. Con el bit 15 de
 *     la division en 1 es SMPTE (no se admite); si no, son ticks por negra.
 *   - Cada pista "MTrk" es una lista de eventos: delta-time de longitud variable (7 bits por
 *     byte, el bit alto indica que sigue otro) y el evento. Mensajes de canal 0x8n..0xEn con
 *     running status (un byte de datos sin estado repite el ultimo estado de canal); los meta
 *     eventos (0xFF tipo largo datos) y los sysex (0xF0 / 0xF7 largo datos) cancelan el running
 *     status. Note-on con velocidad 0 es note-off.
 *   - Metas usados: 0x03 nombre de pista, 0x51 tempo (microsegundos por negra, 3 bytes), 0x58
 *     compas (numerador, denominador en potencia de 2, clocks por clic, fusas por negra), 0x2F fin
 *     de pista. Los fragmentos de tipo desconocido se saltan.
 *
 * Decisiones que el contrato no fija:
 *   - Lectura: una pista con notas en varios canales (lo normal en un tipo 0) se separa en una
 *     SmfTrack por canal, en orden de canal; el nombre lleva " (canal N)", con N de 1 a 16.
 *   - Lectura: si llega un note-on de una nota que sigue sonando, el note-off siguiente cierra la
 *     mas antigua (FIFO); el solape se resuelve despues con la regla de midiOps.
 *   - Lectura: una nota de largo cero queda con el largo minimo (STUDIO_MIDI_MIN_NOTE_BEATS).
 *   - Lectura: el BPM se redondea a 3 decimales; no se acota (el usuario decide).
 *   - Escritura: note-off como 0x8n con velocidad 64 y running status. A igual tick van primero
 *     los note-off, y dentro de cada grupo por pitch: una nota repetida no se corta a si misma.
 *
 * Modulo puro: sin DOM ni import.meta.env (se prueba en scripts/verify-studio-logic.ts).
 */
import { normalizeNotes } from './midiOps.ts'
import { STUDIO_MIDI_MIN_NOTE_BEATS, roundBeat, type StudioMidiClip, type StudioMidiNote } from './session.ts'
import type { SmfApi, SmfFile, SmfTrack, SmfWriteClip } from './types.ts'

/** Ticks por negra al escribir. */
export const SMF_TICKS_PER_BEAT = 480

/** Canal de percusion General MIDI (canal 10 en la numeracion 1..16). */
export const SMF_DRUM_CHANNEL = 9

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

class Reader {
  pos: number
  readonly bytes: Uint8Array
  readonly end: number

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes
    this.pos = start
    this.end = end
  }

  need(n: number): void {
    if (this.pos + n > this.end) throw new Error('El archivo MIDI está incompleto (se corta en medio de un evento)')
  }

  u8(): number {
    this.need(1)
    return this.bytes[this.pos++]
  }

  u16(): number {
    this.need(2)
    const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1]
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const b = this.bytes
    const v = b[this.pos] * 0x1000000 + ((b[this.pos + 1] << 16) | (b[this.pos + 2] << 8) | b[this.pos + 3])
    this.pos += 4
    return v
  }

  /** Cantidad de longitud variable: a lo sumo 4 bytes (hasta 0x0FFFFFFF). */
  vlq(): number {
    let value = 0
    for (let i = 0; i < 4; i++) {
      const b = this.u8()
      value = value * 128 + (b & 0x7f)
      if ((b & 0x80) === 0) return value
    }
    throw new Error('El archivo MIDI tiene un tiempo de longitud variable de más de 4 bytes')
  }

  ascii(n: number): string {
    this.need(n)
    let s = ''
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.bytes[this.pos + i])
    this.pos += n
    return s
  }

  slice(n: number): Uint8Array {
    this.need(n)
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}

/** Texto de un meta: UTF-8 si es valido; si no, Latin-1 (lo habitual en archivos viejos). */
function decodeText(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data)
  } catch {
    let s = ''
    for (const b of data) s += String.fromCharCode(b)
    return s
  }
}

interface RawNote {
  pitch: number
  velocity: number
  startTick: number
  endTick: number
}

interface ParsedTrack {
  name: string | null
  /** Notas por canal. */
  byChannel: Map<number, RawNote[]>
  tempos: { tick: number; usPerBeat: number }[]
  signatures: { tick: number; numerator: number; denominatorPow: number | null }[]
}

function parseTrack(r: Reader): ParsedTrack {
  const track: ParsedTrack = { name: null, byChannel: new Map(), tempos: [], signatures: [] }
  /** Notas abiertas por canal y pitch (FIFO). */
  const open = new Map<number, { tick: number; velocity: number }[]>()
  let tick = 0
  let running = 0
  let ended = false

  const noteOff = (channel: number, pitch: number, at: number): void => {
    const queue = open.get(channel * 128 + pitch)
    const first = queue?.shift()
    if (!first) return
    let list = track.byChannel.get(channel)
    if (!list) track.byChannel.set(channel, (list = []))
    list.push({ pitch, velocity: first.velocity, startTick: first.tick, endTick: at })
  }

  while (r.pos < r.end && !ended) {
    tick += r.vlq()
    r.need(1)
    let status = r.bytes[r.pos]
    if (status < 0x80) {
      // Running status: el byte es dato del ultimo mensaje de canal.
      if (running === 0) throw new Error('El archivo MIDI usa running status sin un estado previo')
      status = running
    } else {
      r.pos++
    }

    if (status === 0xff) {
      running = 0
      const type = r.u8()
      const len = r.vlq()
      const data = r.slice(len)
      if (type === 0x2f) ended = true
      else if (type === 0x03 && track.name === null) track.name = decodeText(data)
      else if (type === 0x51 && len >= 3) track.tempos.push({ tick, usPerBeat: (data[0] << 16) | (data[1] << 8) | data[2] })
      else if (type === 0x58 && len >= 1) track.signatures.push({ tick, numerator: data[0], denominatorPow: len >= 2 ? data[1] : null })
      continue
    }
    if (status === 0xf0 || status === 0xf7) {
      running = 0
      r.slice(r.vlq())
      continue
    }
    if (status >= 0xf0) throw new Error(`El archivo MIDI trae un evento no válido dentro de una pista (0x${status.toString(16)})`)

    running = status
    const kind = status & 0xf0
    const channel = status & 0x0f
    const d1 = r.u8() & 0x7f
    const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : r.u8() & 0x7f
    if (kind === 0x90 && d2 > 0) {
      const key = channel * 128 + d1
      let queue = open.get(key)
      if (!queue) open.set(key, (queue = []))
      queue.push({ tick, velocity: d2 })
    } else if (kind === 0x80 || kind === 0x90) {
      noteOff(channel, d1, tick)
    }
  }
  // Una nota sin note-off se cierra al final de la pista.
  for (const [key, queue] of open) {
    while (queue.length > 0) noteOff(Math.floor(key / 128), key % 128, tick)
  }
  return track
}

export function parseSmf(input: Uint8Array | ArrayBuffer): SmfFile {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  const r = new Reader(bytes, 0, bytes.length)
  if (bytes.length < 14 || r.ascii(4) !== 'MThd') throw new Error('No es un archivo MIDI estándar (falta la cabecera MThd)')
  const headerLength = r.u32()
  if (headerLength < 6) throw new Error('La cabecera del archivo MIDI es demasiado corta')
  const headerEnd = r.pos + headerLength
  const format = r.u16()
  const declaredTracks = r.u16()
  const division = r.u16()
  if (format === 2) throw new Error('El archivo MIDI es de tipo 2 (patrones independientes): el Estudio solo lee tipo 0 y 1')
  if (format !== 0 && format !== 1) throw new Error(`Tipo de archivo MIDI desconocido: ${format}`)
  if (division & 0x8000) throw new Error('El archivo MIDI usa división SMPTE: el Estudio solo lee ticks por negra')
  if (division === 0) throw new Error('El archivo MIDI declara 0 ticks por negra')
  if (headerEnd > bytes.length) throw new Error('El archivo MIDI está incompleto (cabecera cortada)')
  r.pos = headerEnd

  const parsed: ParsedTrack[] = []
  while (r.pos < bytes.length && parsed.length < declaredTracks) {
    if (bytes.length - r.pos < 8) throw new Error('El archivo MIDI está incompleto (fragmento cortado)')
    const id = r.ascii(4)
    const len = r.u32()
    if (r.pos + len > bytes.length) throw new Error('El archivo MIDI está incompleto (pista cortada)')
    if (id === 'MTrk') parsed.push(parseTrack(new Reader(bytes, r.pos, r.pos + len)))
    r.pos += len
  }
  if (parsed.length < declaredTracks) throw new Error(`El archivo MIDI declara ${declaredTracks} pistas y trae ${parsed.length}`)

  // Primer tempo y primer compas por tick (a igual tick, el de la pista anterior).
  const tempos = parsed.flatMap((t) => t.tempos).sort((a, b) => a.tick - b.tick)
  const signatures = parsed.flatMap((t) => t.signatures).sort((a, b) => a.tick - b.tick)
  const firstTempo = tempos.find((t) => t.usPerBeat > 0)
  const bpm = firstTempo ? Math.round((60_000_000 / firstTempo.usPerBeat) * 1000) / 1000 : null
  const tempoChanges = firstTempo ? tempos.some((t) => t.usPerBeat !== firstTempo.usPerBeat) : false

  const tracks: SmfTrack[] = []
  for (const t of parsed) {
    const channels = [...t.byChannel.keys()].sort((a, b) => a - b)
    for (const channel of channels) {
      const raw = t.byChannel.get(channel) ?? []
      if (raw.length === 0) continue
      const notes = normalizeNotes(
        raw.map((n) => ({
          pitch: n.pitch,
          start: roundBeat(n.startTick / division),
          length: Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, roundBeat((n.endTick - n.startTick) / division)),
          velocity: n.velocity,
        })),
        Infinity,
      )
      const name = channels.length > 1 ? `${t.name ?? 'Pista'} (canal ${channel + 1})` : t.name
      tracks.push({ name, channel, isDrums: channel === SMF_DRUM_CHANNEL, notes })
    }
  }
  return {
    format,
    ticksPerBeat: division,
    bpm,
    beatsPerBar: signatures.length > 0 ? beatsPerBarFromSignature(signatures[0].numerator, signatures[0].denominatorPow) : null,
    timeSignature: signatures.length > 0 ? `${signatures[0].numerator}/${2 ** (signatures[0].denominatorPow ?? 2)}` : null,
    tracks,
    tempoChanges,
  }
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

class Writer {
  private chunks: number[] = []

  byte(b: number): void {
    this.chunks.push(b & 0xff)
  }

  bytes(list: ArrayLike<number>): void {
    for (let i = 0; i < list.length; i++) this.byte(list[i])
  }

  u16(v: number): void {
    this.byte(v >> 8)
    this.byte(v)
  }

  u32(v: number): void {
    this.byte(Math.floor(v / 0x1000000))
    this.byte(v >> 16)
    this.byte(v >> 8)
    this.byte(v)
  }

  vlq(value: number): void {
    let v = Math.max(0, Math.min(0x0fffffff, Math.floor(value)))
    const stack = [v & 0x7f]
    v = Math.floor(v / 128)
    while (v > 0) {
      stack.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    for (let i = stack.length - 1; i >= 0; i--) this.byte(stack[i])
  }

  get length(): number {
    return this.chunks.length
  }

  toArray(): number[] {
    return this.chunks
  }
}

function writeChunk(out: Writer, id: string, body: Writer): void {
  for (let i = 0; i < 4; i++) out.byte(id.charCodeAt(i))
  out.u32(body.length)
  out.bytes(body.toArray())
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * Negras por compas de un meta 0x58: numerador * 4 / 2^denominador (la sesion mide en negras: un
 * 6/8 son 3 negras, un 12/8 son 6). Sin denominador se asume negra. null si el resultado no es un
 * entero de 1 a 16 (por ejemplo 7/8): el Hub no cambia el compas de la sesion y avisa al importar.
 */
export function beatsPerBarFromSignature(numerator: number, denominatorPow: number | null): number | null {
  if (!Number.isInteger(numerator) || numerator <= 0) return null
  const pow = denominatorPow === null ? 2 : denominatorPow
  if (!Number.isInteger(pow) || pow < 0 || pow > 6) return null
  const beats = (numerator * 4) / 2 ** pow
  return Number.isInteger(beats) && beats >= 1 && beats <= 16 ? beats : null
}

interface OutEvent {
  tick: number
  /** 0 = note-off, 1 = note-on (a igual tick, primero los note-off). */
  order: 0 | 1
  pitch: number
  velocity: number
}

export function writeSmf(clips: readonly SmfWriteClip[], bpm: number, beatsPerBar: number): Uint8Array {
  if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0) throw new Error('El tempo debe ser un número mayor que cero')
  const numerator = Math.max(1, Math.min(255, Math.round(Number.isFinite(beatsPerBar) ? beatsPerBar : 4)))
  const out = new Writer()
  const header = new Writer()
  header.u16(1)
  header.u16(1 + clips.length)
  header.u16(SMF_TICKS_PER_BEAT)
  writeChunk(out, 'MThd', header)

  // Pista 0: tempo y compas.
  const usPerBeat = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / bpm)))
  const conductor = new Writer()
  conductor.vlq(0)
  conductor.bytes([0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff])
  conductor.vlq(0)
  // Denominador 2^2 = negra, 24 clocks MIDI por clic, 8 fusas por negra.
  conductor.bytes([0xff, 0x58, 0x04, numerator, 0x02, 0x18, 0x08])
  conductor.vlq(0)
  conductor.bytes([0xff, 0x2f, 0x00])
  writeChunk(out, 'MTrk', conductor)

  for (const clip of clips) {
    const channel = Math.max(0, Math.min(15, Math.round(clip.channel ?? 0)))
    const events: OutEvent[] = []
    for (const n of clip.notes) {
      if (!Number.isFinite(n.start) || !Number.isFinite(n.length) || n.start < 0) continue
      const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)))
      const velocity = Math.max(1, Math.min(127, Math.round(n.velocity)))
      const startTick = Math.round(n.start * SMF_TICKS_PER_BEAT)
      const endTick = Math.max(startTick + 1, Math.round((n.start + n.length) * SMF_TICKS_PER_BEAT))
      events.push({ tick: startTick, order: 1, pitch, velocity }, { tick: endTick, order: 0, pitch, velocity: 0x40 })
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order || a.pitch - b.pitch)
    const body = new Writer()
    const name = utf8(clip.name ?? '')
    body.vlq(0)
    body.bytes([0xff, 0x03])
    body.vlq(name.length)
    body.bytes(name)
    let last = 0
    let running = -1
    for (const e of events) {
      body.vlq(e.tick - last)
      last = e.tick
      const status = (e.order === 1 ? 0x90 : 0x80) | channel
      if (status !== running) body.byte(status)
      running = status
      body.byte(e.pitch)
      body.byte(e.velocity)
    }
    body.vlq(0)
    body.bytes([0xff, 0x2f, 0x00])
    writeChunk(out, 'MTrk', body)
  }
  return Uint8Array.from(out.toArray())
}

/**
 * Notas de un clip para exportar, en beats desde el inicio de la sesion: con la repeticion
 * desplegada y cada nota recortada al final del clip (asi suena, STUDIO_V2.md 2.4).
 */
export function midiClipExportNotes(clip: StudioMidiClip): StudioMidiNote[] {
  const notes: StudioMidiNote[] = []
  const pattern = clip.loop && clip.loopBeats < clip.lengthBeats ? clip.notes.filter((n) => n.start < clip.loopBeats) : clip.notes
  const lap = clip.loop && clip.loopBeats < clip.lengthBeats ? clip.loopBeats : clip.lengthBeats
  for (let offset = 0; offset < clip.lengthBeats; offset += lap) {
    for (const n of pattern) {
      const start = n.start + offset
      if (start >= clip.lengthBeats) continue
      const length = Math.min(n.length, clip.lengthBeats - start)
      if (length <= 0) continue
      notes.push({ ...n, start: roundBeat(clip.startBeat + start), length: roundBeat(length) })
    }
  }
  return normalizeNotes(notes, Infinity)
}

void ({ parseSmf, writeSmf } satisfies SmfApi)
