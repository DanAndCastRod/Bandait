import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AlignHorizontalJustifyStart,
  ArrowLeft,
  CopyPlus,
  Download,
  Eraser,
  Gauge,
  Magnet,
  MousePointer2,
  Pencil,
  Redo2,
  Scissors,
  Sliders,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { drumLanes } from '../../services/studio/instruments/core'
import { addNotes, moveNotes, removeNotes, resizeNotes, setVelocity, splitNotesAt, STUDIO_QUANTIZE_GRIDS } from '../../services/studio/midiOps'
import {
  beatsToSeconds,
  findMidiClip,
  roundBeat,
  secondsToBeats,
  STUDIO_INSTRUMENT_TYPE_LABELS,
  STUDIO_MIDI_MIN_NOTE_BEATS,
  type StudioMidiClip,
  type StudioMidiNote,
} from '../../services/studio/session'
import type { MidiEditResult, QuantizeGrid } from '../../services/studio/types'
import { inkOn, studioTrackColor, type StudioCanvasPalette } from '../../services/studioCanvasPalette'
import { StudioHumanizePopover } from './StudioHumanizePopover'
import { downloadBlob, formatBarBeat, isBlackKey, pitchName, trackColor, useStudio, type PianoTool, type StudioController } from './studioState'
import { useStudioCanvasPalette } from './useStudioCanvasPalette'

interface Props {
  controller: StudioController
}

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

const KEYS_W = 64
const RULER_H = 24
const VEL_H = 76
const EDGE_PX = 6
const DRAG_THRESHOLD_PX = 3
const MIN_PX_BEAT = 10
const MAX_PX_BEAT = 480
const DEFAULT_PX_BEAT = 72
const MIN_ROW_H = 7
const MAX_ROW_H = 28
const DEFAULT_ROW_H = 14
/** Beats de mas despues del final del clip, para poder ver y estirar el borde. */
const TAIL_BEATS = 4
const DEFAULT_VELOCITY = 100
const FONT = "600 9px 'IBM Plex Mono', monospace"

const TOOLS: readonly { tool: PianoTool; label: string; key: string; Icon: typeof Pencil }[] = [
  { tool: 'select', label: 'Seleccionar', key: '1', Icon: MousePointer2 },
  { tool: 'draw', label: 'Dibujar', key: '2', Icon: Pencil },
  { tool: 'erase', label: 'Borrar', key: '3', Icon: Eraser },
  { tool: 'cut', label: 'Cortar nota', key: '4', Icon: Scissors },
  { tool: 'velocity', label: 'Velocidad', key: '5', Icon: Gauge },
]

const GRID_LABELS: Readonly<Record<QuantizeGrid, string>> = { '1/1': '1/1', '1/2': '1/2', '1/4': '1/4', '1/8': '1/8', '1/16': '1/16', '1/32': '1/32' }

interface View {
  scrollX: number
  scrollY: number
  width: number
  height: number
  pxPerBeat: number
  rowH: number
}

/** Filas del piano roll de arriba a abajo. En percusion: los carriles de la caja y los pitch que use el clip. */
interface Rows {
  pitches: readonly number[]
  rowOf: ReadonlyMap<number, number>
  /** Nombre de cada carril de percusion; null en modo melodico. */
  labels: ReadonlyMap<number, string> | null
}

const MELODIC_ROWS: Rows = (() => {
  const pitches = Array.from({ length: 128 }, (_v, i) => 127 - i)
  return { pitches, rowOf: new Map(pitches.map((p, i) => [p, i])), labels: null }
})()

const drumRowsCache = new WeakMap<readonly StudioMidiNote[], Rows>()
const NO_NOTES: readonly StudioMidiNote[] = []

function rowsFor(drums: boolean, notes: readonly StudioMidiNote[]): Rows {
  if (!drums) return MELODIC_ROWS
  const cached = drumRowsCache.get(notes)
  if (cached) return cached
  const lanes = drumLanes()
  const labels = new Map<number, string>(lanes.map((lane) => [lane.pitch, lane.label]))
  const set = new Set<number>(lanes.map((lane) => lane.pitch))
  for (const n of notes) set.add(n.pitch)
  const pitches = [...set].sort((a, b) => b - a)
  const rows: Rows = { pitches, rowOf: new Map(pitches.map((p, i) => [p, i])), labels }
  drumRowsCache.set(notes, rows)
  return rows
}

interface Rubber {
  b0: number
  b1: number
  r0: number
  r1: number
}

interface Scene {
  clip: StudioMidiClip
  notes: readonly StudioMidiNote[]
  selection: ReadonlySet<number>
  rows: Rows
  color: string
  gridStep: number
  beatsPerBar: number
  rubber: Rubber | null
  hoverRow: number | null
  /** Colores del tema vigente (useStudioCanvasPalette). */
  palette: StudioCanvasPalette
}

const alphaCache = new Map<string, string>()

function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 100) / 100
  const key = `${hex}/${a}`
  const cached = alphaCache.get(key)
  if (cached) return cached
  const n = Number.parseInt(hex.slice(1), 16)
  const value = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
  alphaCache.set(key, value)
  return value
}

const xOfBeat = (beat: number, v: View) => KEYS_W + beat * v.pxPerBeat - v.scrollX
const yOfRow = (row: number, v: View) => RULER_H + row * v.rowH - v.scrollY

function isOnGrid(value: number, step: number): boolean {
  const q = value / step
  return Math.abs(q - Math.round(q)) < 1e-6
}

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------

function paintRoll(ctx: CanvasRenderingContext2D, scene: Scene, view: View): void {
  const { clip, rows, notes, selection, color, beatsPerBar, palette: pal } = scene
  const { width, height, pxPerBeat, rowH } = view
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, width, height)

  // Filas: teclas negras mas oscuras; linea mas clara en cada Do.
  const firstRow = Math.max(0, Math.floor(view.scrollY / rowH))
  const lastRow = Math.min(rows.pitches.length - 1, Math.ceil((view.scrollY + height - RULER_H) / rowH))
  for (let r = firstRow; r <= lastRow; r++) {
    const pitch = rows.pitches[r]
    const y = yOfRow(r, view)
    const dark = rows.labels ? r % 2 === 1 : isBlackKey(pitch)
    ctx.fillStyle = dark ? pal.rowBlack : pal.rowWhite
    ctx.fillRect(KEYS_W, y, width - KEYS_W, rowH)
    if (scene.hoverRow === r) {
      ctx.fillStyle = pal.rowHover
      ctx.fillRect(KEYS_W, y, width - KEYS_W, rowH)
    }
    ctx.fillStyle = !rows.labels && pitch % 12 === 0 ? pal.gridStrong : pal.gridFaint
    ctx.fillRect(KEYS_W, y + rowH - 1, width - KEYS_W, 1)
  }
  const rowsBottom = Math.min(height, yOfRow(rows.pitches.length, view))

  // Rejilla vertical: compas, tiempo y subdivision (las lineas de compas siguen los compases de la sesion).
  const beatStart = Math.max(0, view.scrollX / pxPerBeat)
  const beatEnd = (view.scrollX + width - KEYS_W) / pxPerBeat
  let step = scene.gridStep
  while (step * pxPerBeat < 6) step *= 2
  for (let i = Math.floor(beatStart / step); i * step <= beatEnd; i++) {
    const b = i * step
    const abs = clip.startBeat + b
    const x = Math.round(xOfBeat(b, view))
    if (x < KEYS_W) continue
    ctx.fillStyle = isOnGrid(abs, beatsPerBar) ? pal.gridStrong : isOnGrid(abs, 1) ? pal.gridSoft : pal.gridFaint
    ctx.fillRect(x, RULER_H, 1, rowsBottom - RULER_H)
  }

  // Fuera del clip y, con repeticion, lo que queda despues del patron.
  const endX = xOfBeat(clip.lengthBeats, view)
  if (endX < width) {
    ctx.fillStyle = pal.outsideClip
    ctx.fillRect(Math.max(KEYS_W, endX), RULER_H, width - Math.max(KEYS_W, endX), rowsBottom - RULER_H)
  }
  const looping = clip.loop && clip.loopBeats < clip.lengthBeats - 1e-6
  if (looping) {
    const lx = Math.max(KEYS_W, xOfBeat(clip.loopBeats, view))
    ctx.fillStyle = pal.afterLoop
    ctx.fillRect(lx, RULER_H, Math.max(0, Math.min(endX, width) - lx), rowsBottom - RULER_H)
  }

  // Notas
  ctx.font = FONT
  ctx.textBaseline = 'middle'
  // Nombre de la nota sobre la nota: tinta de mayor contraste con el color de la pista.
  const noteInk = inkOn(color)
  const drawNote =(n: StudioMidiNote, offset: number, ghost: boolean, picked: boolean) => {
    const row = rows.rowOf.get(n.pitch)
    if (row === undefined || row < firstRow - 1 || row > lastRow + 1) return
    const x = xOfBeat(n.start + offset, view)
    const w = Math.max(2, n.length * pxPerBeat - 1)
    if (x > width || x + w < KEYS_W) return
    const y = yOfRow(row, view) + 1
    const h = Math.max(2, rowH - 2)
    if (ghost) {
      ctx.strokeStyle = withAlpha(color, 0.45)
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      return
    }
    ctx.fillStyle = withAlpha(color, picked ? 1 : 0.35 + 0.6 * (n.velocity / 127))
    ctx.fillRect(x, y, w, h)
    if (picked) {
      ctx.strokeStyle = pal.text
      ctx.lineWidth = 1.5
      ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5)
    }
    if (w > 34 && rowH >= 12) {
      ctx.fillStyle = picked ? noteInk : withAlpha(noteInk, 0.85)
      ctx.fillText(rows.labels ? (rows.labels.get(n.pitch) ?? pitchName(n.pitch)) : pitchName(n.pitch), x + 4, y + h / 2 + 0.5)
    }
  }
  notes.forEach((n, i) => drawNote(n, 0, false, selection.has(i)))
  if (looping) {
    for (let lap = 1; lap * clip.loopBeats < clip.lengthBeats - 1e-6; lap++) {
      for (const n of notes) {
        if (n.start < clip.loopBeats && n.start + lap * clip.loopBeats < clip.lengthBeats) drawNote(n, lap * clip.loopBeats, true, false)
      }
    }
  }

  // Seleccion por rectangulo
  if (scene.rubber) {
    const { b0, b1, r0, r1 } = scene.rubber
    const x0 = xOfBeat(Math.min(b0, b1), view)
    const x1 = xOfBeat(Math.max(b0, b1), view)
    const y0 = yOfRow(Math.min(r0, r1), view)
    const y1 = yOfRow(Math.max(r0, r1) + 1, view)
    ctx.fillStyle = pal.selectionFill
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    ctx.strokeStyle = pal.selection
    ctx.lineWidth = 1
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1)
  }

  // Teclado (fijo a la izquierda, encima de lo que se desplaza)
  ctx.fillStyle = pal.keybed
  ctx.fillRect(0, RULER_H, KEYS_W, height - RULER_H)
  for (let r = firstRow; r <= lastRow; r++) {
    const pitch = rows.pitches[r]
    const y = yOfRow(r, view)
    const black = !rows.labels && isBlackKey(pitch)
    ctx.fillStyle = scene.hoverRow === r ? withAlpha(color, 0.45) : black ? pal.keyBlack : pal.keyWhite
    ctx.fillRect(black ? 0 : 0, y, black ? KEYS_W * 0.62 : KEYS_W - 1, rowH - 1)
    const label = rows.labels ? (rows.labels.get(pitch) ?? pitchName(pitch)) : pitch % 12 === 0 ? pitchName(pitch) : null
    if (label && rowH >= 9) {
      ctx.fillStyle = rows.labels && !rows.labels.has(pitch) ? pal.keyLabelFaint : pal.keyLabel
      ctx.textBaseline = 'middle'
      ctx.fillText(label.toUpperCase(), black ? KEYS_W * 0.62 + 3 : 5, y + rowH / 2)
    }
  }
  ctx.fillStyle = pal.rowLine
  ctx.fillRect(KEYS_W - 1, RULER_H, 1, height - RULER_H)

  // Regla: compases de la sesion y fin del clip.
  ctx.fillStyle = pal.ruler
  ctx.fillRect(KEYS_W, 0, width - KEYS_W, RULER_H)
  ctx.textBaseline = 'middle'
  let barStep = 1
  while (beatsPerBar * barStep * pxPerBeat < 40) barStep *= 2
  const firstBar = Math.max(0, Math.ceil((clip.startBeat + beatStart) / beatsPerBar - 1e-9))
  for (let bar = firstBar - (firstBar % barStep); (bar * beatsPerBar - clip.startBeat) <= beatEnd; bar += barStep) {
    const x = Math.round(xOfBeat(bar * beatsPerBar - clip.startBeat, view))
    if (x < KEYS_W - 1) continue
    ctx.fillStyle = pal.rulerTick
    ctx.fillRect(x, 10, 1, RULER_H - 10)
    ctx.fillStyle = pal.rulerText
    ctx.fillText(String(bar + 1), x + 4, 9)
  }
  if (endX >= KEYS_W && endX <= width) {
    ctx.fillStyle = withAlpha(color, 0.9)
    ctx.fillRect(Math.round(endX) - 1, 0, 2, RULER_H)
  }
  if (looping) {
    const lx = xOfBeat(clip.loopBeats, view)
    if (lx >= KEYS_W && lx <= width) {
      ctx.fillStyle = pal.accent
      ctx.fillRect(Math.round(lx) - 1, RULER_H - 6, 2, 6)
    }
  }
  ctx.fillStyle = pal.rowLine
  ctx.fillRect(0, RULER_H - 1, width, 1)
  ctx.fillStyle = pal.ruler
  ctx.fillRect(0, 0, KEYS_W, RULER_H - 1)
  ctx.fillStyle = pal.rulerHint
  ctx.fillText(rows.labels ? 'CARRIL' : 'NOTA', 6, RULER_H / 2)
}

function paintVelocity(ctx: CanvasRenderingContext2D, scene: Scene, view: View, height: number): void {
  const { width, pxPerBeat } = view
  const pal = scene.palette
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = pal.velocityBg
  ctx.fillRect(0, 0, width, height)
  const top = 6
  const usable = height - top - 4
  ctx.fillStyle = pal.velocityGuide
  ctx.fillRect(KEYS_W, top, width - KEYS_W, 1)
  ctx.fillRect(KEYS_W, top + usable / 2, width - KEYS_W, 1)
  scene.notes.forEach((n, i) => {
    const x = xOfBeat(n.start, view)
    if (x > width || x < KEYS_W - 6) return
    const h = Math.max(2, (n.velocity / 127) * usable)
    const picked = scene.selection.has(i)
    ctx.fillStyle = picked ? pal.text : withAlpha(scene.color, 0.85)
    ctx.fillRect(Math.round(x), top + usable - h, 2, h)
    ctx.fillRect(Math.round(x) - 2, top + usable - h, Math.min(8, Math.max(4, n.length * pxPerBeat)), 2)
  })
  ctx.fillStyle = pal.keybed
  ctx.fillRect(0, 0, KEYS_W, height)
  ctx.fillStyle = pal.rowLine
  ctx.fillRect(KEYS_W - 1, 0, 1, height)
  ctx.fillRect(0, 0, width, 1)
  ctx.font = FONT
  ctx.textBaseline = 'middle'
  ctx.fillStyle = pal.keyLabel
  ctx.fillText('VEL', 6, height / 2)
}

// ---------------------------------------------------------------------------
// Puntero
// ---------------------------------------------------------------------------

type NotePart = 'body' | 'start' | 'end'

type Hit =
  | { kind: 'ruler'; beat: number }
  | { kind: 'keys'; row: number; pitch: number }
  | { kind: 'note'; index: number; part: NotePart; row: number; beat: number }
  | { kind: 'empty'; row: number; pitch: number | null; beat: number }

function hitRoll(scene: Scene, view: View, px: number, py: number): Hit {
  const beat = (view.scrollX + px - KEYS_W) / view.pxPerBeat
  if (py < RULER_H) return { kind: 'ruler', beat: Math.max(0, beat) }
  const row = Math.floor((view.scrollY + py - RULER_H) / view.rowH)
  const pitch = scene.rows.pitches[row] ?? null
  if (px < KEYS_W) return pitch === null ? { kind: 'empty', row, pitch, beat: 0 } : { kind: 'keys', row, pitch }
  for (let i = scene.notes.length - 1; i >= 0; i--) {
    const n = scene.notes[i]
    if (scene.rows.rowOf.get(n.pitch) !== row || beat < n.start || beat > n.start + n.length) continue
    const x0 = xOfBeat(n.start, view)
    const x1 = xOfBeat(n.start + n.length, view)
    if (x1 - x0 > EDGE_PX * 3) {
      if (x1 - px <= EDGE_PX) return { kind: 'note', index: i, part: 'end', row, beat }
      if (px - x0 <= EDGE_PX) return { kind: 'note', index: i, part: 'start', row, beat }
    } else if (x1 - px <= 3) return { kind: 'note', index: i, part: 'end', row, beat }
    return { kind: 'note', index: i, part: 'body', row, beat }
  }
  return { kind: 'empty', row, pitch, beat: Math.max(0, beat) }
}

type Drag =
  | { kind: 'move'; base: readonly StudioMidiNote[]; selection: number[]; anchor: number; grabBeat: number; grabRow: number; lastPitch: number; startPx: number; startPy: number; moved: boolean }
  | { kind: 'resize'; edge: 'start' | 'end'; base: readonly StudioMidiNote[]; selection: number[]; anchor: number; grabBeat: number; startPx: number; moved: boolean }
  | { kind: 'draw'; base: readonly StudioMidiNote[]; note: StudioMidiNote }
  | { kind: 'rubber'; base: readonly StudioMidiNote[]; additive: readonly number[]; startBeat: number; startRow: number; startPx: number; startPy: number; moved: boolean }
  | { kind: 'erase'; base: readonly StudioMidiNote[]; removed: Set<number> }
  | { kind: 'velocity'; base: readonly StudioMidiNote[]; selection: number[]; startPy: number }
  | { kind: 'lane'; base: readonly StudioMidiNote[]; values: Map<number, number> }

const DRAG_LABEL: Readonly<Record<Exclude<Drag['kind'], 'rubber'>, string>> = {
  move: 'Mover notas',
  resize: 'Cambiar largo de notas',
  draw: 'Dibujar nota',
  erase: 'Borrar notas',
  velocity: 'Velocidad de notas',
  lane: 'Velocidad de notas',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

/**
 * Piano roll del clip MIDI abierto (docs/PLAN_ESTUDIO_V2.md, seccion 4). Todo se pinta en dos
 * canvas del tamano visible (notas con teclado y regla, y carril de velocidad); el scroll es
 * nativo sobre un espaciador y el cabezal es un div que se mueve con transform desde el unico
 * requestAnimationFrame del Estudio. Un arrastre edita un borrador local y deja un solo paso de
 * deshacer al soltar. Las herramientas, la rejilla y la seleccion viven en el controlador, para
 * que los atajos del registro de comandos (parte 2) actuen sobre lo mismo que esta vista.
 */
export const StudioPianoRoll: React.FC<Props> = ({ controller }) => {
  const snap = useStudio(controller)
  const { session, piano, recording } = snap
  const loc = snap.pianoClipId ? findMidiClip(session, snap.pianoClipId) : null
  const clip = loc?.clip ?? null
  const track = loc?.track ?? null
  const drums = track?.instrument?.type === 'drums'
  // rowsFor guarda el resultado por arreglo de notas: no hace falta memorizar aqui.
  const rows = rowsFor(drums, clip?.notes ?? NO_NOTES)
  const [pxPerBeat, setPxPerBeat] = useState(DEFAULT_PX_BEAT)
  const [rowH, setRowH] = useState(DEFAULT_ROW_H)
  const [velocityText, setVelocityText] = useState('')
  const [humanizeOpen, setHumanizeOpen] = useState(false)

  const bodyRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const laneRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const statusRef = useRef<HTMLSpanElement>(null)
  const dirtyRef = useRef(true)
  const pxRef = useRef(DEFAULT_PX_BEAT)
  const rowRef = useRef(DEFAULT_ROW_H)
  const dragRef = useRef<Drag | null>(null)
  const draftRef = useRef<MidiEditResult | null>(null)
  const rubberRef = useRef<Rubber | null>(null)
  const hoverRowRef = useRef<number | null>(null)
  const anchorRef = useRef<{ beat: number; px: number } | null>(null)
  const rowAnchorRef = useRef<{ row: number; py: number } | null>(null)
  const scrolledForRef = useRef<string | null>(null)

  const lengthBeats = clip?.lengthBeats ?? 4
  const contentWidth = KEYS_W + Math.ceil((lengthBeats + TAIL_BEATS) * pxPerBeat)
  const contentHeight = RULER_H + rows.pitches.length * rowH
  const selectionCount = piano.selection.length
  // Colores del tema vigente: cacheados, cambian (y repintan) solo al cambiar tema o acento.
  const palette = useStudioCanvasPalette()
  const paletteRef = useRef(palette)
  const color = studioTrackColor(palette, trackColor(loc?.trackIndex ?? 0, loc?.track.role))

  useEffect(() => {
    paletteRef.current = palette
    dirtyRef.current = true
  }, [palette, clip, piano, rows, pxPerBeat, rowH, contentWidth, contentHeight])

  useLayoutEffect(() => {
    pxRef.current = pxPerBeat
    const anchor = anchorRef.current
    const body = bodyRef.current
    if (anchor && body) body.scrollLeft = Math.max(0, anchor.beat * pxPerBeat - (anchor.px - KEYS_W))
    anchorRef.current = null
  }, [pxPerBeat])

  useLayoutEffect(() => {
    rowRef.current = rowH
    const anchor = rowAnchorRef.current
    const body = bodyRef.current
    if (anchor && body) body.scrollTop = Math.max(0, anchor.row * rowH - (anchor.py - RULER_H))
    rowAnchorRef.current = null
  }, [rowH])

  // Al abrir un clip: la vista se centra en sus notas (o en Do4) y empieza en el beat 0.
  const clipId = clip?.id ?? null
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || !clipId || scrolledForRef.current === clipId) return
    scrolledForRef.current = clipId
    const current = controller.pianoClip()
    const notes = current?.clip.notes ?? []
    const currentRows = rowsFor(current?.track.instrument?.type === 'drums', notes)
    const pitchesSorted = notes.map((n) => n.pitch).sort((a, b) => a - b)
    const center = pitchesSorted.length > 0 ? pitchesSorted[Math.floor(pitchesSorted.length / 2)] : 60
    const row = currentRows.rowOf.get(center) ?? 0
    body.scrollLeft = 0
    body.scrollTop = Math.max(0, row * rowRef.current - (body.clientHeight - RULER_H) / 2)
    dirtyRef.current = true
  }, [clipId, controller])

  const viewOf = useCallback((): View | null => {
    const body = bodyRef.current
    if (!body) return null
    return { scrollX: body.scrollLeft, scrollY: body.scrollTop, width: body.clientWidth, height: body.clientHeight, pxPerBeat: pxRef.current, rowH: rowRef.current }
  }, [])

  /** Lo que se pinta: el borrador del arrastre si lo hay, si no las notas del documento. */
  const sceneOf = useCallback((): Scene | null => {
    const current = controller.snapshot()
    const location = controller.pianoClip()
    if (!location) return null
    const draft = draftRef.current
    const notes = draft?.notes ?? location.clip.notes
    return {
      clip: location.clip,
      notes,
      selection: new Set(draft?.selection ?? current.piano.selection),
      rows: rowsFor(location.track.instrument?.type === 'drums', notes),
      color: studioTrackColor(paletteRef.current, trackColor(location.trackIndex, location.track.role)),
      gridStep: controller.pianoGridBeats(),
      beatsPerBar: current.session.beatsPerBar,
      rubber: rubberRef.current,
      hoverRow: hoverRowRef.current,
      palette: paletteRef.current,
    }
  }, [controller])

  // Bucle de pintado: cabezal por transform y los dos canvas cuando algo cambio.
  useEffect(() => {
    const body = bodyRef.current
    const canvas = canvasRef.current
    const lane = laneRef.current
    if (!body || !canvas || !lane) return
    const ctx = canvas.getContext('2d')
    const laneCtx = lane.getContext('2d')
    if (!ctx || !laneCtx) return
    const markDirty = () => {
      dirtyRef.current = true
    }
    body.addEventListener('scroll', markDirty, { passive: true })
    const observer = new ResizeObserver(markDirty)
    observer.observe(body)
    let lastX = Number.NaN
    let lastVisible = true

    const off = controller.onFrame(() => {
      const current = controller.snapshot()
      const location = controller.pianoClip()
      const playhead = playheadRef.current
      if (location && playhead) {
        const rel = secondsToBeats(controller.engine.position(), current.session.bpm) - location.clip.startBeat
        const x = Math.round((KEYS_W + rel * pxRef.current) * 2) / 2
        const visible = rel >= 0 && rel <= location.clip.lengthBeats && x - body.scrollLeft >= KEYS_W
        if (x !== lastX) {
          playhead.style.transform = `translate3d(${x}px, 0, 0)`
          lastX = x
        }
        if (visible !== lastVisible) {
          playhead.style.opacity = visible ? '1' : '0'
          lastVisible = visible
        }
        // Mientras suena, la vista sigue al cabezal por paginas (salvo durante un arrastre).
        if (current.engine.status === 'playing' && !dragRef.current && rel >= 0 && rel <= location.clip.lengthBeats) {
          const left = body.scrollLeft
          const visibleW = body.clientWidth - KEYS_W
          const cx = rel * pxRef.current
          if (cx > left + visibleW - 24 || cx < left) body.scrollLeft = Math.max(0, cx - visibleW * 0.12)
        }
      }
      if (!dirtyRef.current) return
      dirtyRef.current = false
      const scene = sceneOf()
      const view = viewOf()
      if (!scene || !view || view.width === 0 || view.height === 0) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== Math.round(view.width * dpr) || canvas.height !== Math.round(view.height * dpr)) {
        canvas.width = Math.round(view.width * dpr)
        canvas.height = Math.round(view.height * dpr)
        canvas.style.width = `${view.width}px`
        canvas.style.height = `${view.height}px`
      }
      if (lane.width !== Math.round(view.width * dpr) || lane.height !== Math.round(VEL_H * dpr)) {
        lane.width = Math.round(view.width * dpr)
        lane.height = Math.round(VEL_H * dpr)
        lane.style.width = `${view.width}px`
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintRoll(ctx, scene, view)
      laneCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintVelocity(laneCtx, scene, view, VEL_H)
      const status = statusRef.current
      if (status) {
        const picked = [...scene.selection].map((i) => scene.notes[i]).filter(Boolean)
        const one = picked.length === 1 ? picked[0] : null
        status.textContent = `${scene.notes.length} notas · ${picked.length} elegidas${one ? ` · ${scene.rows.labels?.get(one.pitch) ?? pitchName(one.pitch)} · vel ${one.velocity} · ${formatBarBeat(scene.clip.startBeat + one.start, scene.beatsPerBar)}` : ''}`
      }
    })
    return () => {
      off()
      observer.disconnect()
      body.removeEventListener('scroll', markDirty)
    }
  }, [controller, sceneOf, viewOf])

  // ---- zoom ----

  const zoomH = useCallback((next: number, anchorPx?: number) => {
    const body = bodyRef.current
    const target = clamp(next, MIN_PX_BEAT, MAX_PX_BEAT)
    if (!body || target === pxRef.current) return
    const px = anchorPx ?? KEYS_W + (body.clientWidth - KEYS_W) / 2
    anchorRef.current = { beat: (body.scrollLeft + px - KEYS_W) / pxRef.current, px }
    setPxPerBeat(target)
  }, [setPxPerBeat])

  const zoomV = useCallback((next: number, anchorPy?: number) => {
    const body = bodyRef.current
    const target = Math.round(clamp(next, MIN_ROW_H, MAX_ROW_H))
    if (!body || target === rowRef.current) return
    const py = anchorPy ?? RULER_H + (body.clientHeight - RULER_H) / 2
    rowAnchorRef.current = { row: (body.scrollTop + py - RULER_H) / rowRef.current, py }
    setRowH(target)
  }, [setRowH])

  // Ctrl + rueda o pellizco tactil de 2 dedos: zoom horizontal/vertical.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let pinchStartDist = 0
    let pinchStartPx = DEFAULT_PX_BEAT
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey && !event.altKey) return
      event.preventDefault()
      const rect = body.getBoundingClientRect()
      if (event.altKey) zoomV(rowRef.current * Math.exp(-event.deltaY * 0.0022), event.clientY - rect.top)
      else zoomH(pxRef.current * Math.exp(-event.deltaY * 0.0022), event.clientX - rect.left)
    }
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        const dx = event.touches[0].clientX - event.touches[1].clientX
        const dy = event.touches[0].clientY - event.touches[1].clientY
        pinchStartDist = Math.hypot(dx, dy)
        pinchStartPx = pxRef.current
      }
    }
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && pinchStartDist > 12) {
        event.preventDefault()
        const dx = event.touches[0].clientX - event.touches[1].clientX
        const dy = event.touches[0].clientY - event.touches[1].clientY
        const dist = Math.hypot(dx, dy)
        const rect = body.getBoundingClientRect()
        const midX = (event.touches[0].clientX + event.touches[1].clientX) / 2 - rect.left
        zoomH(pinchStartPx * (dist / pinchStartDist), midX)
      }
    }
    body.addEventListener('wheel', onWheel, { passive: false })
    body.addEventListener('touchstart', onTouchStart, { passive: true })
    body.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      body.removeEventListener('wheel', onWheel)
      body.removeEventListener('touchstart', onTouchStart)
      body.removeEventListener('touchmove', onTouchMove)
    }
  }, [zoomH, zoomV])

  useEffect(
    () =>
      controller.onViewCommand((command) => {
        if (command.type !== 'zoom' || controller.snapshot().editor !== 'piano_roll') return
        zoomH(pxRef.current * (command.direction > 0 ? 1.5 : 1 / 1.5))
      }),
    [controller, zoomH],
  )

  // ---- edicion con el puntero ----

  const pointerAt = (event: React.PointerEvent | React.MouseEvent, target: HTMLElement | null): { px: number; py: number; view: View } | null => {
    const view = viewOf()
    if (!target || !view) return null
    const rect = target.getBoundingClientRect()
    return { px: event.clientX - rect.left, py: event.clientY - rect.top, view }
  }

  const snapOn = (event: { altKey: boolean }) => controller.snapshot().piano.snap && !event.altKey

  /** Inicio ajustado: hacia abajo a la rejilla (dibujar) o al mas cercano (mover). */
  const snapBeat = (beat: number, on: boolean, mode: 'floor' | 'round' | 'ceil'): number => {
    if (!on) return roundBeat(beat)
    const step = controller.pianoGridBeats()
    const fn = mode === 'floor' ? Math.floor : mode === 'ceil' ? Math.ceil : Math.round
    return roundBeat(fn(beat / step + (mode === 'floor' ? 1e-9 : mode === 'ceil' ? -1e-9 : 0)) * step)
  }

  const commitDraft = (label: string, base: readonly StudioMidiNote[]) => {
    const draft = draftRef.current
    draftRef.current = null
    dirtyRef.current = true
    if (!draft) return
    // Si el clip cambio durante el arrastre (deshacer con el teclado), el borrador ya no vale.
    if (controller.pianoClip()?.clip.notes !== base) return
    controller.editNotes(label, () => draft)
  }

  const startDraw = (hit: Extract<Hit, { kind: 'empty' }>, event: React.PointerEvent, scene: Scene) => {
    if (hit.pitch === null) return
    const on = snapOn(event)
    const start = snapBeat(hit.beat, on, 'floor')
    if (start >= scene.clip.lengthBeats) return
    const drawLength = controller.snapshot().piano.drawLength
    const length = Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, Math.min(drawLength, scene.clip.lengthBeats - start))
    const note: StudioMidiNote = { pitch: hit.pitch, start, length, velocity: DEFAULT_VELOCITY }
    const base = scene.notes
    draftRef.current = addNotes(base, [note], scene.clip.lengthBeats)
    dragRef.current = { kind: 'draw', base, note }
    controller.previewPitch(hit.pitch, DEFAULT_VELOCITY)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const at = pointerAt(event, canvasRef.current)
    const scene = sceneOf()
    if (!at || !scene) return
    event.currentTarget.focus({ preventScroll: true })
    const hit = hitRoll(scene, at.view, at.px, at.py)
    const bpm = controller.snapshot().session.bpm
    if (hit.kind === 'ruler') {
      controller.seek(beatsToSeconds(scene.clip.startBeat + Math.min(hit.beat, scene.clip.lengthBeats), bpm))
      return
    }
    if (hit.kind === 'keys') {
      controller.previewPitch(hit.pitch, DEFAULT_VELOCITY)
      return
    }
    if (recording) return
    const tool = controller.snapshot().piano.tool
    const selection = controller.snapshot().piano.selection
    const capture = () => event.currentTarget.setPointerCapture(event.pointerId)

    if (hit.kind === 'note') {
      const note = scene.notes[hit.index]
      if (tool === 'erase') {
        draftRef.current = { notes: removeNotes(scene.notes, [hit.index]), selection: [] }
        dragRef.current = { kind: 'erase', base: scene.notes, removed: new Set([hit.index]) }
        dirtyRef.current = true
        capture()
        return
      }
      if (tool === 'cut') {
        const at2 = snapBeat(hit.beat, snapOn(event), 'round')
        controller.editNotes('Cortar nota', (notes, length) => splitNotesAt(notes, [hit.index], at2, length))
        return
      }
      const inSelection = selection.includes(hit.index)
      let picked: number[]
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        picked = inSelection ? selection.filter((i) => i !== hit.index) : [...selection, hit.index]
        controller.selectNotes(picked)
        if (inSelection) return
      } else {
        picked = inSelection ? [...selection] : [hit.index]
        if (!inSelection) controller.selectNotes(picked)
      }
      if (tool === 'velocity') {
        dragRef.current = { kind: 'velocity', base: scene.notes, selection: picked, startPy: at.py }
        capture()
        return
      }
      if (hit.part === 'body') {
        dragRef.current = { kind: 'move', base: scene.notes, selection: picked, anchor: hit.index, grabBeat: hit.beat, grabRow: hit.row, lastPitch: note.pitch, startPx: at.px, startPy: at.py, moved: false }
      } else {
        dragRef.current = { kind: 'resize', edge: hit.part, base: scene.notes, selection: picked, anchor: hit.index, grabBeat: hit.beat, startPx: at.px, moved: false }
      }
      capture()
      return
    }

    // Lugar vacio
    if (tool === 'draw') {
      startDraw(hit, event, scene)
      capture()
      dirtyRef.current = true
      return
    }
    if (tool === 'select' || tool === 'velocity') {
      dragRef.current = { kind: 'rubber', base: scene.notes, additive: event.shiftKey || event.ctrlKey || event.metaKey ? [...selection] : [], startBeat: hit.beat, startRow: hit.row, startPx: at.px, startPy: at.py, moved: false }
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) controller.clearNoteSelection()
      capture()
      return
    }
    if (tool === 'erase') {
      dragRef.current = { kind: 'erase', base: scene.notes, removed: new Set() }
      capture()
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const at = pointerAt(event, canvasRef.current)
    const scene = sceneOf()
    if (!at || !scene) return
    const drag = dragRef.current
    if (!drag) {
      const hit = hitRoll(scene, at.view, at.px, at.py)
      const row = hit.kind === 'keys' || hit.kind === 'note' || hit.kind === 'empty' ? hit.row : null
      if (row !== hoverRowRef.current) {
        hoverRowRef.current = row
        dirtyRef.current = true
      }
      const tool = controller.snapshot().piano.tool
      event.currentTarget.style.cursor =
        hit.kind === 'ruler' || hit.kind === 'keys'
          ? 'pointer'
          : hit.kind === 'note'
            ? tool === 'erase'
              ? 'not-allowed'
              : tool === 'cut'
                ? 'col-resize'
                : tool === 'velocity'
                  ? 'ns-resize'
                  : hit.part === 'body'
                    ? 'grab'
                    : 'ew-resize'
            : tool === 'draw'
              ? 'crosshair'
              : 'default'
      return
    }
    const len = scene.clip.lengthBeats
    const beat = (at.view.scrollX + at.px - KEYS_W) / at.view.pxPerBeat
    const row = clamp(Math.floor((at.view.scrollY + at.py - RULER_H) / at.view.rowH), 0, scene.rows.pitches.length - 1)
    const on = snapOn(event)

    if (drag.kind === 'move') {
      if (!drag.moved && Math.hypot(at.px - drag.startPx, at.py - drag.startPy) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      const anchor = drag.base[drag.anchor]
      const deltaRaw = beat - drag.grabBeat
      const delta = on ? snapBeat(anchor.start + deltaRaw, true, 'round') - anchor.start : deltaRaw
      const fromPitch = scene.rows.pitches[drag.grabRow] ?? anchor.pitch
      const toPitch = scene.rows.pitches[row] ?? fromPitch
      draftRef.current = moveNotes(drag.base, drag.selection, delta, toPitch - fromPitch, len)
      const newPitch = anchor.pitch + (toPitch - fromPitch)
      if (newPitch !== drag.lastPitch && newPitch >= 0 && newPitch <= 127) {
        drag.lastPitch = newPitch
        controller.previewPitch(newPitch, anchor.velocity)
      }
      event.currentTarget.style.cursor = 'grabbing'
    } else if (drag.kind === 'resize') {
      if (!drag.moved && Math.abs(at.px - drag.startPx) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      const anchor = drag.base[drag.anchor]
      const deltaRaw = beat - drag.grabBeat
      const edgeBeat = drag.edge === 'end' ? anchor.start + anchor.length : anchor.start
      const delta = on ? snapBeat(edgeBeat + deltaRaw, true, 'round') - edgeBeat : deltaRaw
      draftRef.current = resizeNotes(drag.base, drag.selection, drag.edge, delta, len)
    } else if (drag.kind === 'draw') {
      const end = on ? snapBeat(beat, true, 'ceil') : beat
      const minLength = on ? controller.pianoGridBeats() : STUDIO_MIDI_MIN_NOTE_BEATS
      const length = roundBeat(Math.max(Math.min(minLength, len - drag.note.start), end - drag.note.start))
      draftRef.current = addNotes(drag.base, [{ ...drag.note, length: Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, length) }], len)
    } else if (drag.kind === 'rubber') {
      if (!drag.moved && Math.hypot(at.px - drag.startPx, at.py - drag.startPy) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      rubberRef.current = { b0: drag.startBeat, b1: Math.max(0, beat), r0: drag.startRow, r1: row }
    } else if (drag.kind === 'erase') {
      const hit = hitRoll({ ...scene, notes: drag.base }, at.view, at.px, at.py)
      if (hit.kind === 'note' && !drag.removed.has(hit.index)) {
        drag.removed.add(hit.index)
        draftRef.current = { notes: removeNotes(drag.base, [...drag.removed]), selection: [] }
      }
    } else if (drag.kind === 'velocity') {
      const delta = Math.round((drag.startPy - at.py) * 0.8)
      draftRef.current = delta === 0 ? null : setVelocity(drag.base, drag.selection, delta, 'add')
    }
    dirtyRef.current = true
  }

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    dirtyRef.current = true
    if (drag.kind === 'rubber') {
      const rubber = rubberRef.current
      rubberRef.current = null
      if (!commit || !rubber) return
      const scene = sceneOf()
      if (!scene) return
      const b0 = Math.min(rubber.b0, rubber.b1)
      const b1 = Math.max(rubber.b0, rubber.b1)
      const r0 = Math.min(rubber.r0, rubber.r1)
      const r1 = Math.max(rubber.r0, rubber.r1)
      const inside: number[] = []
      drag.base.forEach((n, i) => {
        const r = scene.rows.rowOf.get(n.pitch)
        if (r !== undefined && r >= r0 && r <= r1 && n.start < b1 && n.start + n.length > b0) inside.push(i)
      })
      controller.selectNotes([...drag.additive, ...inside])
      return
    }
    if (!commit) {
      draftRef.current = null
      return
    }
    if ((drag.kind === 'move' || drag.kind === 'resize') && !drag.moved) {
      draftRef.current = null
      return
    }
    if (drag.kind === 'draw') {
      const added = draftRef.current
      const pickedNote = added?.selection.length === 1 ? added.notes[added.selection[0]] : null
      commitDraft(DRAG_LABEL.draw, drag.base)
      if (pickedNote) controller.setPiano({ drawLength: pickedNote.length })
      return
    }
    if (drag.kind === 'resize' && drag.selection.length === 1) {
      const resized = draftRef.current?.selection.length === 1 ? draftRef.current.notes[draftRef.current.selection[0]] : null
      commitDraft(DRAG_LABEL.resize, drag.base)
      if (resized) controller.setPiano({ drawLength: resized.length })
      return
    }
    commitDraft(DRAG_LABEL[drag.kind], drag.base)
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const at = pointerAt(event, canvasRef.current)
    const scene = sceneOf()
    if (!at || !scene || recording) return
    const hit = hitRoll(scene, at.view, at.px, at.py)
    const tool = controller.snapshot().piano.tool
    // Con seleccionar, doble clic en un lugar vacio dibuja una nota; en una nota, la borra.
    if (tool !== 'select') return
    if (hit.kind === 'note') {
      controller.editNotes('Borrar nota', (notes) => ({ notes: removeNotes(notes, [hit.index]), selection: [] }))
    } else if (hit.kind === 'empty' && hit.pitch !== null) {
      const on = !event.altKey && controller.snapshot().piano.snap
      const start = snapBeat(hit.beat, on, 'floor')
      if (start >= scene.clip.lengthBeats) return
      const length = Math.max(STUDIO_MIDI_MIN_NOTE_BEATS, Math.min(controller.snapshot().piano.drawLength, scene.clip.lengthBeats - start))
      controller.editNotes('Dibujar nota', (notes, len) => addNotes(notes, [{ pitch: hit.pitch as number, start, length, velocity: DEFAULT_VELOCITY }], len))
      controller.previewPitch(hit.pitch, DEFAULT_VELOCITY)
    }
  }

  // ---- carril de velocidad ----

  const laneValue = (py: number) => clamp(Math.round(((VEL_H - 4 - py) / (VEL_H - 10)) * 127), 1, 127)

  const paintLaneAt = (drag: Extract<Drag, { kind: 'lane' }>, px: number, py: number, view: View) => {
    const beat = (view.scrollX + px - KEYS_W) / view.pxPerBeat
    const tolerance = 4 / view.pxPerBeat
    const selection = controller.snapshot().piano.selection
    const value = laneValue(py)
    drag.base.forEach((n, i) => {
      if (selection.length > 0 && !selection.includes(i)) return
      if (Math.abs(n.start - beat) <= tolerance || (beat >= n.start && beat < n.start + Math.min(n.length, 8 / view.pxPerBeat))) drag.values.set(i, value)
    })
    if (drag.values.size === 0) return
    draftRef.current = { notes: drag.base.map((n, i) => (drag.values.has(i) ? { ...n, velocity: drag.values.get(i) as number } : n)), selection: [...selection] }
    dirtyRef.current = true
  }

  const onLaneDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || recording) return
    const at = pointerAt(event, laneRef.current)
    const scene = sceneOf()
    if (!at || !scene || at.px < KEYS_W) return
    const drag: Extract<Drag, { kind: 'lane' }> = { kind: 'lane', base: scene.notes, values: new Map() }
    dragRef.current = drag
    event.currentTarget.setPointerCapture(event.pointerId)
    paintLaneAt(drag, at.px, at.py, at.view)
  }

  const onLaneMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'lane') return
    const at = pointerAt(event, laneRef.current)
    if (at) paintLaneAt(drag, at.px, at.py, at.view)
  }

  const onLaneUp = (event: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.kind !== 'lane') return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!commit || drag.values.size === 0) {
      draftRef.current = null
      dirtyRef.current = true
      return
    }
    commitDraft(DRAG_LABEL.lane, drag.base)
  }

  // ---- barra ----

  if (!loc || !clip || !track) {
    return (
      <div className="stu-pr" data-testid="studio-piano-roll">
        <div className="stu-pr-tools">
          <button type="button" className="stu-btn" onClick={() => controller.showTimeline()} data-testid="studio-piano-back">
            <ArrowLeft size={14} />
            LÍNEA DE TIEMPO
          </button>
        </div>
        <p className="stu-help" style={{ padding: '16px' }}>
          El clip MIDI ya no existe. Vuelve a la línea de tiempo y abre otro.
        </p>
      </div>
    )
  }

  const commitVelocity = () => {
    const value = Number(velocityText)
    setVelocityText('')
    if (!Number.isFinite(value) || velocityText.trim() === '') return
    controller.setNotesVelocity(clamp(Math.round(value), 1, 127), 'set')
  }

  const exportClip = () => {
    const file = controller.exportMidiClip(clip.id)
    if (file) downloadBlob(file.blob, file.name)
  }

  const instrumentLabel = track.instrument ? STUDIO_INSTRUMENT_TYPE_LABELS[track.instrument.type] : 'Instrumento'

  return (
    <div className="stu-pr" data-testid="studio-piano-roll" style={{ ['--stu-track' as string]: color }}>
      <div className="stu-pr-tools">
        <button type="button" className="stu-btn" onClick={() => controller.showTimeline()} title="Volver a la línea de tiempo (E)" data-testid="studio-piano-back">
          <ArrowLeft size={14} />
          LÍNEA DE TIEMPO
        </button>
        <span className="stu-pr-title">
          <strong>{track.name}</strong>
          <span className="stu-label">
            {instrumentLabel} · compás {formatBarBeat(clip.startBeat, session.beatsPerBar)} · {(clip.lengthBeats / session.beatsPerBar).toFixed(2)} compases
          </span>
        </span>

        <div className="stu-bar-group" role="group" aria-label="Deshacer y rehacer">
          <button type="button" className="stu-btn" data-size="icon" disabled={!snap.canUndo || recording} onClick={() => controller.undo()} aria-label={snap.undoLabel ? `Deshacer: ${snap.undoLabel}` : 'Deshacer'} title={snap.undoLabel ? `Deshacer: ${snap.undoLabel} (Ctrl+Z)` : 'Deshacer (Ctrl+Z)'}>
            <Undo2 size={14} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={!snap.canRedo || recording} onClick={() => controller.redo()} aria-label={snap.redoLabel ? `Rehacer: ${snap.redoLabel}` : 'Rehacer'} title={snap.redoLabel ? `Rehacer: ${snap.redoLabel} (Ctrl+Y)` : 'Rehacer (Ctrl+Y)'}>
            <Redo2 size={14} />
          </button>
        </div>

        <div className="stu-seg" role="group" aria-label="Herramienta">
          {TOOLS.map(({ tool, label, key, Icon }) => (
            <button
              key={tool}
              type="button"
              className="stu-btn"
              data-size="icon"
              data-on={piano.tool === tool}
              aria-pressed={piano.tool === tool}
              onClick={() => controller.setPianoTool(tool)}
              aria-label={`${label} (${key})`}
              title={`${label} (${key})`}
              data-testid={`studio-piano-tool-${tool}`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>

        <div className="stu-bar-group" role="group" aria-label="Rejilla">
          <select className="stu-field" data-size="mini" style={{ minHeight: '28px' }} value={piano.grid} onChange={(event) => controller.setPiano({ grid: event.target.value as QuantizeGrid })} aria-label="Rejilla" title="Rejilla para dibujar, mover y cuantizar" data-testid="studio-piano-grid">
            {STUDIO_QUANTIZE_GRIDS.map((grid) => (
              <option key={grid} value={grid}>
                {GRID_LABELS[grid]}
              </option>
            ))}
          </select>
          <button type="button" className="stu-btn" data-size="icon" data-on={piano.triplets} aria-pressed={piano.triplets} onClick={() => controller.setPiano({ triplets: !piano.triplets })} aria-label="Tresillos" title="Tresillos (la rejilla vale 2/3)" data-testid="studio-piano-triplets">
            3
          </button>
          <button type="button" className="stu-btn" data-size="icon" data-on={piano.snap} aria-pressed={piano.snap} onClick={() => controller.setPiano({ snap: !piano.snap })} aria-label="Ajustar a la rejilla" title="Ajustar a la rejilla. Alt mientras arrastras lo suspende." data-testid="studio-piano-snap">
            <Magnet size={14} />
          </button>
        </div>

        <div className="stu-bar-group" role="group" aria-label="Cuantizar">
          <label className="stu-pr-strength" title="Fuerza de cuantizar: cuánto se acerca cada nota a la rejilla">
            <span className="stu-label">Fuerza</span>
            <input
              type="range"
              className="stu-range"
              min={0}
              max={100}
              step={5}
              value={Math.round(piano.quantizeStrength * 100)}
              onChange={(event) => controller.setPiano({ quantizeStrength: Number(event.target.value) / 100 })}
              aria-label="Fuerza de cuantizar"
              aria-valuetext={`${Math.round(piano.quantizeStrength * 100)} %`}
            />
            <span className="stu-pr-val">{Math.round(piano.quantizeStrength * 100)}%</span>
          </label>
          <button type="button" className="stu-btn" disabled={recording || clip.notes.length === 0} onClick={() => controller.quantizeNotes()} title={selectionCount > 0 ? 'Cuantizar las notas elegidas (Q)' : 'Cuantizar todas las notas (Q)'} data-testid="studio-piano-quantize">
            CUANTIZAR
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || clip.notes.length < 2} onClick={() => controller.legatoNotes()} aria-label="Legato" title="Legato: cada nota llega hasta la siguiente" data-testid="studio-piano-legato">
            <AlignHorizontalJustifyStart size={14} />
          </button>
        </div>

        <div className="stu-bar-group stu-wave-anchor" role="group" aria-label="Humanizar">
          <label className="stu-pr-strength" title="Intensidad de humanización: micro-timing (tiempo), velocidad y duración">
            <span className="stu-label">Humano</span>
            <input
              type="range"
              className="stu-range"
              min={0}
              max={100}
              step={5}
              value={Math.round(piano.humanizeAmount * 100)}
              onChange={(event) => controller.setPiano({ humanizeAmount: Number(event.target.value) / 100 })}
              aria-label="Intensidad de humanización"
              aria-valuetext={`${Math.round(piano.humanizeAmount * 100)} %`}
              data-testid="studio-piano-humanize-amount"
            />
            <span className="stu-pr-val">{Math.round(piano.humanizeAmount * 100)}%</span>
          </label>
          <button
            type="button"
            className="stu-btn"
            disabled={recording || clip.notes.length === 0}
            onClick={() => controller.humanizeNotes()}
            title={selectionCount > 0 ? 'Humanizar tiempo y velocidad de las notas elegidas (H)' : 'Humanizar tiempo y velocidad de todas las notas (H)'}
            data-testid="studio-piano-humanize"
          >
            HUMANIZAR
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="icon"
            data-on={humanizeOpen}
            aria-pressed={humanizeOpen}
            aria-expanded={humanizeOpen}
            disabled={recording}
            onClick={() => setHumanizeOpen((v) => !v)}
            title="Opciones avanzadas de humanización analógica (Swing, Strum, Acentos) y generador de acordes MIDI"
            data-testid="studio-piano-humanize-options"
          >
            <Sliders size={14} />
          </button>
          {humanizeOpen && <StudioHumanizePopover controller={controller} onClose={() => setHumanizeOpen(false)} />}
        </div>

        <div className="stu-bar-group" role="group" aria-label="Transponer">
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || clip.notes.length === 0} onClick={() => controller.transposeNotes(-12)} aria-label="Bajar una octava" title="Bajar una octava (Shift + flecha abajo)">
            -12
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || clip.notes.length === 0} onClick={() => controller.transposeNotes(-1)} aria-label="Bajar un semitono" title="Bajar un semitono (flecha abajo)">
            -1
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || clip.notes.length === 0} onClick={() => controller.transposeNotes(1)} aria-label="Subir un semitono" title="Subir un semitono (flecha arriba)" data-testid="studio-piano-up">
            +1
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || clip.notes.length === 0} onClick={() => controller.transposeNotes(12)} aria-label="Subir una octava" title="Subir una octava (Shift + flecha arriba)">
            +12
          </button>
        </div>

        <div className="stu-bar-group" role="group" aria-label="Notas elegidas">
          <input
            className="stu-field"
            data-size="mini"
            style={{ width: '52px', minHeight: '28px' }}
            inputMode="numeric"
            placeholder="VEL"
            value={velocityText}
            disabled={recording || clip.notes.length === 0}
            onChange={(event) => setVelocityText(event.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitVelocity()
              if (event.key === 'Escape') setVelocityText('')
            }}
            onBlur={commitVelocity}
            aria-label={selectionCount > 0 ? 'Velocidad de las notas elegidas, 1 a 127' : 'Velocidad de todas las notas, 1 a 127'}
            title="Velocidad (1 a 127) de las notas elegidas, o de todas. Enter aplica."
            data-testid="studio-piano-velocity"
          />
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || selectionCount === 0} onClick={() => controller.duplicateNotes()} aria-label="Duplicar las notas elegidas" title="Duplicar las notas elegidas (Ctrl+D)" data-testid="studio-piano-duplicate">
            <CopyPlus size={14} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || selectionCount === 0} onClick={() => controller.deleteNotes()} aria-label="Borrar las notas elegidas" title="Borrar las notas elegidas (Supr)" data-testid="studio-piano-delete">
            <Trash2 size={14} />
          </button>
        </div>

        <span className="stu-bar-spacer" />

        <div className="stu-bar-group" role="group" aria-label="Zoom">
          <button type="button" className="stu-btn" data-size="icon" disabled={rowH <= MIN_ROW_H} onClick={() => zoomV(rowH - 3)} aria-label="Filas más bajas" title="Filas más bajas (Alt + rueda)">
            <ZoomOut size={14} style={{ transform: 'rotate(90deg)' }} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={rowH >= MAX_ROW_H} onClick={() => zoomV(rowH + 3)} aria-label="Filas más altas" title="Filas más altas (Alt + rueda)">
            <ZoomIn size={14} style={{ transform: 'rotate(90deg)' }} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={pxPerBeat <= MIN_PX_BEAT} onClick={() => zoomH(pxPerBeat / 1.5)} aria-label="Alejar" title="Alejar (Ctrl + rueda)">
            <ZoomOut size={14} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={pxPerBeat >= MAX_PX_BEAT} onClick={() => zoomH(pxPerBeat * 1.5)} aria-label="Acercar" title="Acercar (Ctrl + rueda)">
            <ZoomIn size={14} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={clip.notes.length === 0} onClick={exportClip} aria-label="Exportar este clip a un archivo MIDI" title="Exportar este clip a .mid" data-testid="studio-piano-export">
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="stu-pr-body" ref={bodyRef}>
        <div className="stu-pr-spacer" style={{ width: `${contentWidth}px`, height: `${contentHeight}px` }}>
          <canvas
            ref={canvasRef}
            className="stu-pr-canvas"
            tabIndex={0}
            role="application"
            aria-label={`Piano roll de ${track.name}. Herramienta ${TOOLS.find((t) => t.tool === piano.tool)?.label ?? ''}. Dibujar: clic en un lugar vacío. Seleccionar: clic o rectángulo, Shift suma. Arrastra una nota para moverla o su borde para cambiar el largo. Alt suspende la rejilla. Clic en el teclado: escuchar la nota.`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => endDrag(event, true)}
            onPointerCancel={(event) => endDrag(event, false)}
            onPointerLeave={() => {
              if (hoverRowRef.current !== null && !dragRef.current) {
                hoverRowRef.current = null
                dirtyRef.current = true
              }
            }}
            onDoubleClick={onDoubleClick}
            data-testid="studio-piano-canvas"
          />
          <div ref={playheadRef} className="stu-playhead stu-pr-playhead" data-state={recording ? 'recording' : 'idle'} aria-hidden="true" />
        </div>
      </div>
      <canvas
        ref={laneRef}
        className="stu-pr-vel"
        style={{ height: `${VEL_H}px` }}
        aria-label="Carril de velocidad: arrastra sobre las notas para pintar su velocidad (solo las elegidas si hay selección)."
        role="img"
        onPointerDown={onLaneDown}
        onPointerMove={onLaneMove}
        onPointerUp={(event) => onLaneUp(event, true)}
        onPointerCancel={(event) => onLaneUp(event, false)}
        data-testid="studio-piano-velocity-lane"
      />
      <div className="stu-pr-foot">
        <span ref={statusRef} className="stu-label stu-mono" aria-live="polite" data-testid="studio-piano-status" />
        <span className="stu-label">{drums ? 'Modo percusión: un carril por voz de la caja (General MIDI).' : 'Doble clic con seleccionar: dibuja o borra una nota.'}</span>
      </div>
    </div>
  )
}
