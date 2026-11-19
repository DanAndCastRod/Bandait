import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, Layers, Plus, Redo2, Scissors, Trash2, Undo2, Upload, ZoomIn, ZoomOut } from 'lucide-react'
import { isStemAudioPath } from '../../services/stemNames'
import { dbToGain, type SectionSpan } from '../../services/stemTiming'
import { clipFadeFactor } from '../../services/studio/graph'
import { peaksForRange } from '../../services/studio/peaks'
import { findAsset, findClip, sessionEndSeconds, STUDIO_MAX_SESSION_SECONDS, STUDIO_MAX_TRACKS, type StudioClip, type StudioSession } from '../../services/studio/session'
import { moveClip, setClipFades, snapTime, trimClip } from '../../services/studio/sessionOps'
import type { AssetPeaks, LoopRegionS, PeakColumns, SnapMode } from '../../services/studio/types'
import { StudioTrackHeader } from './StudioTrackHeader'
import {
  formatTimecode,
  layoutTracks,
  RULER_H,
  TAKE_LANE_H,
  TRACK_ROW_H,
  trackColor,
  useStudio,
  type ArmChannel,
  type StudioController,
  type TrackRowLayout,
} from './studioState'

interface Props {
  controller: StudioController
  /** false en modo de solo reproduccion y mezcla. */
  recordAllowed: boolean
}

const MIN_ZOOM = 2
const MAX_ZOOM = 480
const DEFAULT_ZOOM = 36
const SECTION_BAND_H = 18
const EDGE_PX = 7
const HANDLE_PX = 9
const FOOTER_H = 52
const DRAG_THRESHOLD_PX = 3
const MIN_LOOP_S = 0.1
const FONT = "600 10px 'IBM Plex Mono', monospace"

const SNAP_OPTIONS: readonly { mode: SnapMode; label: string; title: string }[] = [
  { mode: 'off', label: 'LIBRE', title: 'Sin ajuste' },
  { mode: 'beat', label: 'TIEMPO', title: 'Ajustar a cada tiempo' },
  { mode: 'bar', label: 'COMPÁS', title: 'Ajustar al compás' },
]

// ---------------------------------------------------------------------------
// Pintado (funciones puras sobre un contexto 2D)
// ---------------------------------------------------------------------------

interface View {
  scrollX: number
  /** Scroll vertical del cuerpo: la regla se dibuja ahi para quedar siempre a la vista. */
  scrollTop: number
  width: number
  height: number
  zoom: number
}

interface Scene {
  session: StudioSession
  rows: readonly TrackRowLayout[]
  selectedClipId: string | null
  hoverClipId: string | null
  sections: readonly SectionSpan[]
  loop: LoopRegionS | null
  missing: ReadonlySet<string>
  arms: Readonly<Record<string, ArmChannel>>
  /** Tramo de la toma en curso, para marcarlo en las pistas armadas. */
  recBand: LoopRegionS | null
  getPeaks: (assetId: string) => AssetPeaks | null
}

interface PeakBuffers {
  a: PeakColumns
  b: PeakColumns
}

const alphaCache = new Map<string, string>()

function withAlpha(hex: string, alpha: number): string {
  const key = `${hex}/${alpha}`
  const cached = alphaCache.get(key)
  if (cached) return cached
  const n = Number.parseInt(hex.slice(1), 16)
  const value = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  alphaCache.set(key, value)
  return value
}

function columnsOf(buffers: PeakColumns, columns: number): PeakColumns {
  return { min: buffers.min.subarray(0, columns), max: buffers.max.subarray(0, columns) }
}

interface ClipBox {
  x: number
  y: number
  w: number
  h: number
}

function clipBox(clip: StudioClip, row: TrackRowLayout, view: View): ClipBox {
  const x = clip.startS * view.zoom - view.scrollX
  const w = clip.lengthS * view.zoom
  if (clip.active) return { x, y: RULER_H + row.top + 4, w, h: TRACK_ROW_H - 8 }
  const lane = row.lanes.get(clip.id) ?? 0
  return { x, y: RULER_H + row.top + TRACK_ROW_H + lane * TAKE_LANE_H + 2, w, h: TAKE_LANE_H - 4 }
}

function paintWave(ctx: CanvasRenderingContext2D, clip: StudioClip, peaks: AssetPeaks, box: ClipBox, view: View, buffers: PeakBuffers): void {
  const first = peaks.channels[0]
  if (!first) return
  const vx0 = Math.max(box.x, 0)
  const vx1 = Math.min(box.x + box.w, view.width)
  const columns = Math.min(buffers.a.min.length, Math.floor(vx1 - vx0))
  if (columns < 1) return
  const request = {
    sampleRate: peaks.sampleRate,
    startS: clip.offsetS + (vx0 - box.x) / view.zoom,
    endS: clip.offsetS + (vx0 + columns - box.x) / view.zoom,
    columns,
  }
  const a = peaksForRange(first, request, columnsOf(buffers.a, columns))
  const second = peaks.channels[1]
  const b = second ? peaksForRange(second, request, columnsOf(buffers.b, columns)) : null
  const gain = dbToGain(clip.gainDb)
  const mid = box.y + box.h / 2
  const half = Math.max(1, box.h / 2 - 3)
  ctx.beginPath()
  for (let i = 0; i < columns; i++) {
    const factor = gain * clipFadeFactor(clip, (vx0 + i + 0.5 - box.x) / view.zoom)
    const hi = Math.min(1, (b ? Math.max(a.max[i], b.max[i]) : a.max[i]) * factor)
    if (i === 0) ctx.moveTo(vx0, mid - hi * half)
    else ctx.lineTo(vx0 + i, mid - hi * half)
  }
  for (let i = columns - 1; i >= 0; i--) {
    const factor = gain * clipFadeFactor(clip, (vx0 + i + 0.5 - box.x) / view.zoom)
    const lo = Math.max(-1, (b ? Math.min(a.min[i], b.min[i]) : a.min[i]) * factor)
    ctx.lineTo(vx0 + i, mid - lo * half)
  }
  ctx.closePath()
  ctx.fill()
  ctx.fillRect(vx0, mid - 0.5, columns, 1)
}

function paintClip(ctx: CanvasRenderingContext2D, scene: Scene, clip: StudioClip, row: TrackRowLayout, color: string, view: View, buffers: PeakBuffers): void {
  const box = clipBox(clip, row, view)
  if (box.x > view.width || box.x + box.w < 0) return
  const selected = clip.id === scene.selectedClipId
  const hovered = clip.id === scene.hoverClipId
  const asset = findAsset(scene.session, clip.assetId)
  const missing = scene.missing.has(clip.assetId)
  const x = Math.max(box.x, -2)
  const w = Math.min(box.x + box.w, view.width + 2) - x

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, box.y, w, box.h)
  ctx.clip()
  ctx.fillStyle = withAlpha(color, clip.active ? (selected ? 0.3 : 0.18) : selected ? 0.18 : 0.08)
  ctx.fillRect(x, box.y, w, box.h)

  if (missing) {
    ctx.strokeStyle = withAlpha('#D96459', 0.5)
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let hx = x - box.h; hx < x + w; hx += 10) {
      ctx.moveTo(hx, box.y + box.h)
      ctx.lineTo(hx + box.h, box.y)
    }
    ctx.stroke()
  } else {
    const peaks = scene.getPeaks(clip.assetId)
    if (peaks) {
      ctx.fillStyle = withAlpha(color, clip.active ? 0.9 : 0.45)
      paintWave(ctx, clip, peaks, box, view, buffers)
    }
  }

  // Fades: lo que queda fuera de la curva se oscurece y la curva se traza encima.
  if (clip.active) {
    const fadeIn = clip.fadeInS * view.zoom
    const fadeOut = clip.fadeOutS * view.zoom
    ctx.fillStyle = 'rgba(15, 17, 20, 0.6)'
    ctx.strokeStyle = withAlpha(color, 0.9)
    ctx.lineWidth = 1
    if (fadeIn >= 1) {
      ctx.beginPath()
      ctx.moveTo(box.x, box.y)
      ctx.lineTo(box.x + fadeIn, box.y)
      ctx.lineTo(box.x, box.y + box.h)
      ctx.closePath()
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(box.x, box.y + box.h)
      ctx.lineTo(box.x + fadeIn, box.y)
      ctx.stroke()
    }
    if (fadeOut >= 1) {
      const end = box.x + box.w
      ctx.beginPath()
      ctx.moveTo(end, box.y)
      ctx.lineTo(end - fadeOut, box.y)
      ctx.lineTo(end, box.y + box.h)
      ctx.closePath()
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(end, box.y + box.h)
      ctx.lineTo(end - fadeOut, box.y)
      ctx.stroke()
    }
  }

  // Etiqueta
  if (w > 34) {
    const generated = asset?.kind === 'generated'
    const name = missing ? 'FALTA EL AUDIO' : (asset?.label || 'Audio')
    const text = `${generated ? 'IA  ' : ''}${clip.active ? '' : 'TOMA  '}${name}`
    ctx.font = FONT
    ctx.textBaseline = 'top'
    const tx = Math.max(box.x, 0) + 6
    const ty = box.y + (clip.active ? 5 : 7)
    // Fondo bajo el texto: se lee tambien encima de la forma de onda.
    ctx.fillStyle = 'rgba(15, 17, 20, 0.72)'
    ctx.fillRect(tx - 3, ty - 2, ctx.measureText(text).width + 6, 14)
    ctx.fillStyle = missing ? '#D96459' : withAlpha('#D5DAE0', clip.active ? 0.92 : 0.7)
    ctx.fillText(text, tx, ty)
  }
  ctx.restore()

  ctx.strokeStyle = selected ? '#D5DAE0' : withAlpha(color, clip.active ? 0.75 : 0.4)
  ctx.lineWidth = selected ? 1.5 : 1
  if (!clip.active) ctx.setLineDash([4, 3])
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
  ctx.setLineDash([])

  // Manijas de fade del clip elegido o bajo el puntero.
  if (clip.active && (selected || hovered) && box.w > 40) {
    ctx.fillStyle = '#D5DAE0'
    const hy = box.y + 1
    const inX = box.x + clip.fadeInS * view.zoom
    const outX = box.x + box.w - clip.fadeOutS * view.zoom
    ctx.fillRect(inX - 3, hy, 7, 7)
    ctx.fillRect(outX - 4, hy, 7, 7)
  }
}

function paintTimeline(ctx: CanvasRenderingContext2D, scene: Scene, view: View, buffers: PeakBuffers): void {
  const { session, rows } = scene
  const { width, height, zoom, scrollX } = view
  const t0 = scrollX / zoom
  const t1 = (scrollX + width) / zoom
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#0F1114'
  ctx.fillRect(0, 0, width, height)

  // Filas
  rows.forEach((row, index) => {
    const y = RULER_H + row.top
    ctx.fillStyle = index % 2 === 0 ? '#14171B' : '#12151A'
    ctx.fillRect(0, y, width, TRACK_ROW_H)
    if (row.laneCount > 0) {
      ctx.fillStyle = '#0D0F12'
      ctx.fillRect(0, y + TRACK_ROW_H, width, row.height - TRACK_ROW_H)
    }
    if (scene.arms[row.trackId] !== undefined) {
      ctx.fillStyle = 'rgba(217, 100, 89, 0.06)'
      ctx.fillRect(0, y, width, TRACK_ROW_H)
    }
    ctx.fillStyle = '#2E343D'
    ctx.fillRect(0, y + row.height - 1, width, 1)
  })
  const rowsBottom = RULER_H + (rows.length > 0 ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0)

  // Rejilla de compases y tiempos
  const beatS = 60 / session.bpm
  const barS = beatS * session.beatsPerBar
  let barStep = 1
  while (barS * barStep * zoom < 64) barStep *= 2
  const firstBar = Math.max(0, Math.floor(t0 / barS))
  const startBar = firstBar - (firstBar % barStep)
  const showBeats = beatS * zoom >= 16
  for (let bar = startBar; bar * barS <= t1; bar += barStep) {
    const x = Math.round(bar * barS * zoom - scrollX)
    ctx.fillStyle = '#2A3038'
    ctx.fillRect(x, RULER_H, 1, rowsBottom - RULER_H)
    if (showBeats && barStep === 1) {
      ctx.fillStyle = '#1D2127'
      for (let beat = 1; beat < session.beatsPerBar; beat++) {
        ctx.fillRect(Math.round((bar * barS + beat * beatS) * zoom - scrollX), RULER_H, 1, rowsBottom - RULER_H)
      }
    }
  }

  // Region de repeticion sobre las pistas
  if (scene.loop) {
    const lx = scene.loop.startS * zoom - scrollX
    const lw = (scene.loop.endS - scene.loop.startS) * zoom
    ctx.fillStyle = 'rgba(92, 200, 194, 0.07)'
    ctx.fillRect(lx, RULER_H, lw, rowsBottom - RULER_H)
    ctx.fillStyle = 'rgba(92, 200, 194, 0.55)'
    ctx.fillRect(Math.round(lx), RULER_H, 1, rowsBottom - RULER_H)
    ctx.fillRect(Math.round(lx + lw), RULER_H, 1, rowsBottom - RULER_H)
  }

  // Clips: los activos encima de los inactivos; el elegido al final
  session.tracks.forEach((track, index) => {
    const row = rows[index]
    if (!row) return
    const color = trackColor(index)
    let selected: StudioClip | null = null
    for (const clip of track.clips) {
      if (clip.id === scene.selectedClipId) selected = clip
      else paintClip(ctx, scene, clip, row, color, view, buffers)
    }
    if (selected) paintClip(ctx, scene, selected, row, color, view, buffers)
    if (row.laneCount > 0) {
      ctx.font = FONT
      ctx.textBaseline = 'top'
      ctx.fillStyle = 'rgba(142, 151, 163, 0.5)'
      ctx.fillText('TOMAS', 6, RULER_H + row.top + TRACK_ROW_H + 3)
    }
  })

  // Toma en curso
  if (scene.recBand && scene.recBand.endS > scene.recBand.startS) {
    const rx = scene.recBand.startS * zoom - scrollX
    const rw = (scene.recBand.endS - scene.recBand.startS) * zoom
    rows.forEach((row) => {
      if (scene.arms[row.trackId] === undefined) return
      ctx.fillStyle = 'rgba(217, 100, 89, 0.28)'
      ctx.fillRect(rx, RULER_H + row.top + 4, rw, TRACK_ROW_H - 8)
      ctx.strokeStyle = '#D96459'
      ctx.lineWidth = 1
      ctx.strokeRect(rx + 0.5, RULER_H + row.top + 4.5, rw - 1, TRACK_ROW_H - 9)
    })
  }

  // Regla (siempre visible: se dibuja en el scroll vertical del cuerpo)
  const ry = view.scrollTop
  ctx.fillStyle = '#1A1E23'
  ctx.fillRect(0, ry, width, RULER_H)
  ctx.font = FONT
  ctx.textBaseline = 'middle'
  for (const section of scene.sections) {
    if (section.endSec < t0 || section.startSec > t1) continue
    const sx = section.startSec * zoom - scrollX
    const sw = (section.endSec - section.startSec) * zoom
    const active = scene.loop !== null && Math.abs(scene.loop.startS - section.startSec) < 0.001 && Math.abs(scene.loop.endS - section.endSec) < 0.001
    ctx.fillStyle = active ? 'rgba(92, 200, 194, 0.3)' : '#232830'
    ctx.fillRect(sx + 1, ry + 2, sw - 2, SECTION_BAND_H - 3)
    if (sw > 26) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(sx + 1, ry, sw - 2, SECTION_BAND_H)
      ctx.clip()
      ctx.fillStyle = active ? '#D5DAE0' : '#8E97A3'
      ctx.fillText(section.label.toUpperCase(), Math.max(sx, 0) + 6, ry + SECTION_BAND_H / 2 + 0.5)
      ctx.restore()
    }
  }
  if (scene.sections.length === 0) {
    ctx.fillStyle = '#4A525D'
    ctx.fillText('SIN SECCIONES: ARRASTRA SOBRE LA REGLA PARA MARCAR UNA REPETICIÓN', 8, ry + SECTION_BAND_H / 2 + 0.5)
  }
  if (scene.loop) {
    const lx = scene.loop.startS * zoom - scrollX
    const lw = (scene.loop.endS - scene.loop.startS) * zoom
    ctx.fillStyle = 'rgba(92, 200, 194, 0.22)'
    ctx.fillRect(lx, ry + SECTION_BAND_H, lw, RULER_H - SECTION_BAND_H)
    ctx.fillStyle = '#5CC8C2'
    ctx.fillRect(lx, ry + RULER_H - 3, lw, 3)
  }
  for (let bar = startBar; bar * barS <= t1; bar += barStep) {
    const x = Math.round(bar * barS * zoom - scrollX)
    ctx.fillStyle = '#4A525D'
    ctx.fillRect(x, ry + SECTION_BAND_H + 12, 1, RULER_H - SECTION_BAND_H - 12)
    ctx.fillStyle = '#8E97A3'
    ctx.fillText(String(bar + 1), x + 4, ry + SECTION_BAND_H + 9)
  }
  ctx.fillStyle = '#2E343D'
  ctx.fillRect(0, ry + RULER_H - 1, width, 1)
  ctx.fillRect(0, ry + SECTION_BAND_H, width, 1)
}

// ---------------------------------------------------------------------------
// Geometria del puntero
// ---------------------------------------------------------------------------

type ClipPart = 'body' | 'start' | 'end' | 'fadeIn' | 'fadeOut'

type Hit =
  | { kind: 'section'; section: SectionSpan }
  | { kind: 'ruler' }
  | { kind: 'clip'; clipId: string; part: ClipPart }
  | { kind: 'empty' }

function rowAt(rows: readonly TrackRowLayout[], y: number): TrackRowLayout | null {
  const inner = y - RULER_H
  for (const row of rows) if (inner >= row.top && inner < row.top + row.height) return row
  return null
}

function hitTest(scene: Scene, view: View, px: number, py: number): Hit {
  const ry = py - view.scrollTop
  if (ry >= 0 && ry < RULER_H) {
    if (ry < SECTION_BAND_H) {
      const time = (view.scrollX + px) / view.zoom
      const section = scene.sections.find((s) => time >= s.startSec && time < s.endSec)
      if (section) return { kind: 'section', section }
    }
    return { kind: 'ruler' }
  }
  for (let index = 0; index < scene.session.tracks.length; index++) {
    const row = scene.rows[index]
    if (!row || py < RULER_H + row.top || py >= RULER_H + row.top + row.height) continue
    const clips = scene.session.tracks[index].clips
    // El elegido se dibuja encima: se prueba primero. Luego, del ultimo al primero.
    const ordered = [...clips].reverse().sort((a, b) => Number(b.id === scene.selectedClipId) - Number(a.id === scene.selectedClipId))
    for (const clip of ordered) {
      const box = clipBox(clip, row, view)
      if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) continue
      if (!clip.active) return { kind: 'clip', clipId: clip.id, part: 'body' }
      if (box.w > 40 && py < box.y + HANDLE_PX + 2) {
        const inX = box.x + clip.fadeInS * view.zoom
        const outX = box.x + box.w - clip.fadeOutS * view.zoom
        if (Math.abs(px - inX) <= HANDLE_PX) return { kind: 'clip', clipId: clip.id, part: 'fadeIn' }
        if (Math.abs(px - outX) <= HANDLE_PX) return { kind: 'clip', clipId: clip.id, part: 'fadeOut' }
      }
      const edge = Math.min(EDGE_PX, box.w / 4)
      if (px - box.x <= edge) return { kind: 'clip', clipId: clip.id, part: 'start' }
      if (box.x + box.w - px <= edge) return { kind: 'clip', clipId: clip.id, part: 'end' }
      return { kind: 'clip', clipId: clip.id, part: 'body' }
    }
    return { kind: 'empty' }
  }
  return { kind: 'empty' }
}

const PART_CURSOR: Record<ClipPart, string> = { body: 'grab', start: 'ew-resize', end: 'ew-resize', fadeIn: 'col-resize', fadeOut: 'col-resize' }
const PART_LABEL: Record<ClipPart, string> = { body: 'Mover clip', start: 'Recortar clip', end: 'Recortar clip', fadeIn: 'Fade de entrada', fadeOut: 'Fade de salida' }

type Drag =
  | { kind: 'ruler'; startPx: number; startS: number; moved: boolean }
  | { kind: 'clip'; part: ClipPart; clipId: string; base: StudioSession; grabS: number; startPx: number; startPy: number; moved: boolean }

/** Ancho visible de los carriles: el del cuerpo menos la columna fija de cabeceras (su primer hijo). */
function laneWidth(body: HTMLElement): number {
  const heads = body.firstElementChild
  return Math.max(0, body.clientWidth - (heads instanceof HTMLElement ? heads.offsetWidth : 0))
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

// ---------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------

/**
 * Linea de tiempo del Estudio: regla de compases y secciones, pistas con formas de onda, tomas
 * alternativas en carriles, edicion con el puntero y cabezal. Todo el dibujo va en un canvas del
 * ancho visible (el scroll horizontal es nativo, sobre un espaciador) y se repinta solo cuando
 * algo cambia; el cabezal es un div que se mueve con transform desde requestAnimationFrame.
 */
export const StudioTimeline: React.FC<Props> = ({ controller, recordAllowed }) => {
  const snap = useStudio(controller)
  const { session, recording, ready } = snap
  const [zoom, setZoom] = useState(DEFAULT_ZOOM)
  const [dropping, setDropping] = useState(false)

  const bodyRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playheadRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirtyRef = useRef(true)
  const zoomRef = useRef(DEFAULT_ZOOM)
  const draftRef = useRef<StudioSession | null>(null)
  const loopDraftRef = useRef<LoopRegionS | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const hoverRef = useRef<string | null>(null)
  /** Tiempo que debe quedar bajo `px` tras cambiar el zoom. */
  const anchorRef = useRef<{ timeS: number; px: number } | null>(null)

  const rows = useMemo(() => layoutTracks(session), [session])
  const rowsHeight = rows.length > 0 ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0
  const contentHeight = RULER_H + rowsHeight + FOOTER_H
  const contentSeconds = Math.min(STUDIO_MAX_SESSION_SECONDS, Math.max(120, sessionEndSeconds(session) + 60))
  const selected = snap.selectedClipId ? findClip(session, snap.selectedClipId) : null

  // Cualquier cambio discreto repinta el canvas en el siguiente fotograma.
  useEffect(() => {
    dirtyRef.current = true
  }, [session, snap.selectedClipId, snap.peaksVersion, snap.engine.loop, snap.engine.missingAssetIds, snap.sections, snap.arms, recording, zoom, contentHeight])

  useLayoutEffect(() => {
    zoomRef.current = zoom
    const anchor = anchorRef.current
    const scroller = bodyRef.current
    if (anchor && scroller) scroller.scrollLeft = Math.max(0, anchor.timeS * zoom - anchor.px)
    anchorRef.current = null
  }, [zoom])

  const viewOf = useCallback((): View | null => {
    const scroller = bodyRef.current
    const body = bodyRef.current
    const canvas = canvasRef.current
    if (!scroller || !body || !canvas) return null
    return { scrollX: scroller.scrollLeft, scrollTop: body.scrollTop, width: laneWidth(scroller), height: canvas.clientHeight, zoom: zoomRef.current }
  }, [])

  const sceneOf = useCallback((): Scene => {
    const current = controller.snapshot()
    const shown = draftRef.current ?? current.session
    const fromS = controller.recordingFromS()
    return {
      session: shown,
      rows: layoutTracks(shown),
      selectedClipId: current.selectedClipId,
      hoverClipId: hoverRef.current,
      sections: current.sections,
      loop: loopDraftRef.current ?? current.engine.loop,
      missing: new Set(current.engine.missingAssetIds),
      arms: current.arms,
      recBand: fromS === null ? null : { startS: fromS, endS: Math.max(fromS, controller.engine.position()) },
      getPeaks: (assetId) => controller.getPeaks(assetId),
    }
  }, [controller])

  // Bucle de pintado: cabezal por transform, seguimiento del cabezal y canvas cuando hace falta.
  useEffect(() => {
    const canvas = canvasRef.current
    const scroller = bodyRef.current
    const body = bodyRef.current
    if (!canvas || !scroller || !body) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const buffers: PeakBuffers = { a: { min: new Float32Array(0), max: new Float32Array(0) }, b: { min: new Float32Array(0), max: new Float32Array(0) } }
    const markDirty = () => {
      dirtyRef.current = true
    }
    scroller.addEventListener('scroll', markDirty, { passive: true })
    body.addEventListener('scroll', markDirty, { passive: true })
    const observer = new ResizeObserver(markDirty)
    observer.observe(scroller)
    observer.observe(body)
    let lastX = -1

    const off = controller.onFrame(() => {
      const zoomNow = zoomRef.current
      const current = controller.snapshot()
      const position = controller.engine.position()
      const x = Math.round(position * zoomNow * 2) / 2
      const playhead = playheadRef.current
      if (playhead && x !== lastX) {
        playhead.style.transform = `translate3d(${x}px, 0, 0)`
        lastX = x
      }
      // Mientras suena, la vista sigue al cabezal por paginas (salvo durante un arrastre).
      const status = current.engine.status
      if (status === 'playing' && !dragRef.current) {
        const left = scroller.scrollLeft
        const width = laneWidth(scroller)
        if (x > left + width - 24 || x < left) scroller.scrollLeft = Math.max(0, x - width * 0.12)
      }
      if (current.recording) dirtyRef.current = true
      if (!dirtyRef.current) return
      dirtyRef.current = false
      const dpr = window.devicePixelRatio || 1
      const width = laneWidth(scroller)
      const height = canvas.clientHeight
      if (width === 0 || height === 0) return
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
        canvas.style.width = `${width}px`
      }
      if (buffers.a.min.length < width) {
        buffers.a = { min: new Float32Array(width), max: new Float32Array(width) }
        buffers.b = { min: new Float32Array(width), max: new Float32Array(width) }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintTimeline(ctx, sceneOf(), { scrollX: scroller.scrollLeft, scrollTop: body.scrollTop, width, height, zoom: zoomNow }, buffers)
    })
    return () => {
      off()
      observer.disconnect()
      scroller.removeEventListener('scroll', markDirty)
      body.removeEventListener('scroll', markDirty)
    }
  }, [controller, sceneOf])

  const changeZoom = useCallback((next: number, anchorPx?: number) => {
    const scroller = bodyRef.current
    const current = zoomRef.current
    const target = clampZoom(next)
    if (!scroller || target === current) return
    const px = anchorPx ?? laneWidth(scroller) / 2
    anchorRef.current = { timeS: (scroller.scrollLeft + px) / current, px }
    setZoom(target)
  }, [])

  // Ctrl + rueda: zoom alrededor del puntero. No pasivo, para poder cancelar el zoom de la pagina.
  useEffect(() => {
    const scroller = bodyRef.current
    if (!scroller) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const rect = (canvasRef.current ?? scroller).getBoundingClientRect()
      changeZoom(zoomRef.current * Math.exp(-event.deltaY * 0.0022), Math.max(0, event.clientX - rect.left))
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [changeZoom])

  const fitZoom = () => {
    const scroller = bodyRef.current
    if (!scroller) return
    const end = Math.max(8, sessionEndSeconds(session) + 2)
    anchorRef.current = { timeS: 0, px: 0 }
    const target = clampZoom(laneWidth(scroller) / end)
    if (target === zoomRef.current) scroller.scrollLeft = 0
    else setZoom(target)
  }

  // ---- puntero ----

  const pointerAt = (event: React.PointerEvent | React.MouseEvent | React.DragEvent): { px: number; py: number; view: View } | null => {
    const canvas = canvasRef.current
    const view = viewOf()
    if (!canvas || !view) return null
    const rect = canvas.getBoundingClientRect()
    return { px: event.clientX - rect.left, py: event.clientY - rect.top, view }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return
    const at = pointerAt(event)
    if (!at) return
    const scene = sceneOf()
    const hit = hitTest(scene, at.view, at.px, at.py)
    const timeS = Math.max(0, (at.view.scrollX + at.px) / at.view.zoom)
    event.currentTarget.focus({ preventScroll: true })
    if (hit.kind === 'section') {
      const same = scene.loop !== null && Math.abs(scene.loop.startS - hit.section.startSec) < 0.001 && Math.abs(scene.loop.endS - hit.section.endSec) < 0.001
      controller.setLoop(same ? null : { startS: hit.section.startSec, endS: hit.section.endSec })
      return
    }
    if (hit.kind === 'ruler') {
      dragRef.current = { kind: 'ruler', startPx: at.px, startS: timeS, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (hit.kind === 'clip') {
      controller.select(hit.clipId)
      const loc = findClip(scene.session, hit.clipId)
      if (!loc || recording) return
      dragRef.current = { kind: 'clip', part: hit.part, clipId: hit.clipId, base: scene.session, grabS: timeS - loc.clip.startS, startPx: at.px, startPy: at.py, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    controller.select(null)
    controller.seek(timeS)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const at = pointerAt(event)
    if (!at) return
    const drag = dragRef.current
    const timeS = Math.max(0, Math.min(STUDIO_MAX_SESSION_SECONDS, (at.view.scrollX + at.px) / at.view.zoom))
    if (!drag) {
      const hit = hitTest(sceneOf(), at.view, at.px, at.py)
      const hoverId = hit.kind === 'clip' ? hit.clipId : null
      if (hoverId !== hoverRef.current) {
        hoverRef.current = hoverId
        dirtyRef.current = true
      }
      event.currentTarget.style.cursor = hit.kind === 'clip' ? (recording ? 'default' : PART_CURSOR[hit.part]) : hit.kind === 'empty' ? 'default' : 'pointer'
      return
    }
    const current = controller.snapshot()
    const mode: SnapMode = event.altKey ? 'off' : current.snap
    if (drag.kind === 'ruler') {
      if (!drag.moved && Math.abs(at.px - drag.startPx) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      const a = snapTime(current.session, { timeS: drag.startS, mode })
      const b = snapTime(current.session, { timeS, mode })
      loopDraftRef.current = { startS: Math.min(a, b), endS: Math.max(a, b) }
      dirtyRef.current = true
      return
    }
    if (!drag.moved && Math.hypot(at.px - drag.startPx, at.py - drag.startPy) < DRAG_THRESHOLD_PX) return
    drag.moved = true
    const loc = findClip(drag.base, drag.clipId)
    if (!loc) return
    try {
      if (drag.part === 'body') {
        const startS = snapTime(drag.base, { timeS: Math.max(0, timeS - drag.grabS), mode })
        const row = loc.clip.active ? rowAt(layoutTracks(drag.base), at.py) : null
        draftRef.current = moveClip(drag.base, { clipId: drag.clipId, startS, trackId: row?.trackId })
        event.currentTarget.style.cursor = 'grabbing'
      } else if (drag.part === 'start' || drag.part === 'end') {
        draftRef.current = trimClip(drag.base, { clipId: drag.clipId, edge: drag.part, toS: snapTime(drag.base, { timeS, mode }) })
      } else if (drag.part === 'fadeIn') {
        draftRef.current = setClipFades(drag.base, { clipId: drag.clipId, fadeInS: Math.max(0, timeS - loc.clip.startS) })
      } else {
        draftRef.current = setClipFades(drag.base, { clipId: drag.clipId, fadeOutS: Math.max(0, loc.clip.startS + loc.clip.lengthS - timeS) })
      }
    } catch {
      // Un destino invalido (pista llena) deja el borrador como estaba.
    }
    dirtyRef.current = true
  }

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    dirtyRef.current = true
    if (drag.kind === 'ruler') {
      const region = loopDraftRef.current
      loopDraftRef.current = null
      if (!commit) return
      if (!drag.moved) controller.seek(drag.startS)
      else if (region && region.endS - region.startS >= MIN_LOOP_S) controller.setLoop(region)
      return
    }
    const draft = draftRef.current
    draftRef.current = null
    if (commit && draft && draft !== drag.base) {
      // Si la sesion cambio durante el arrastre (deshacer con el teclado), el borrador ya no vale.
      if (controller.snapshot().session === drag.base) controller.apply(draft, PART_LABEL[drag.part])
    }
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const at = pointerAt(event)
    if (!at) return
    const scene = sceneOf()
    const hit = hitTest(scene, at.view, at.px, at.py)
    if (hit.kind === 'ruler') controller.setLoop(null)
    if (hit.kind === 'clip') {
      const loc = findClip(scene.session, hit.clipId)
      if (loc && !loc.clip.active) controller.activateTake(hit.clipId)
    }
  }

  const onCanvasKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      if (snap.selectedClipId) controller.nudgeSelected(event.key === 'ArrowLeft' ? -1 : 1)
      else controller.seek(Math.max(0, controller.engine.position() + (event.key === 'ArrowLeft' ? -1 : 1) * (60 / session.bpm) * session.beatsPerBar))
    } else if (event.key === 'Enter' && selected && !selected.clip.active) {
      event.preventDefault()
      controller.activateTake(selected.clip.id)
    } else if (event.key === 'Home') {
      event.preventDefault()
      controller.seek(0)
    } else if (event.key === 'Escape') {
      controller.select(null)
    }
  }

  // ---- importar ----

  const audioFiles = (list: FileList | null): File[] => Array.from(list ?? []).filter((file) => file.type.startsWith('audio/') || isStemAudioPath(file.name))

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDropping(false)
    const files = audioFiles(event.dataTransfer.files)
    if (files.length === 0) {
      controller.notify('warn', 'Suelta archivos de audio (wav, flac, mp3, m4a, ogg o aac).')
      return
    }
    const at = pointerAt(event)
    const row = at && files.length === 1 ? rowAt(rows, at.py) : null
    if (at && row && event.target === canvasRef.current) {
      const timeS = snapTime(session, { timeS: Math.max(0, (at.view.scrollX + at.px) / at.view.zoom), mode: snap.snap })
      void controller.importFiles(files, { trackId: row.trackId, atS: timeS })
    } else {
      void controller.importFiles(files)
    }
  }

  const inputChannels = snap.device.report?.channelCount ?? 0
  const loadingFraction = snap.loading && snap.loading.total > 0 ? snap.loading.done / snap.loading.total : 0

  return (
    <section className="stu-tl" aria-label="Línea de tiempo" data-testid="studio-timeline">
      <div className="stu-tl-tools">
        <div className="stu-bar-group" role="group" aria-label="Deshacer y rehacer">
          <button
            type="button"
            className="stu-btn"
            data-size="icon"
            disabled={!snap.canUndo || recording}
            onClick={() => controller.undo()}
            aria-label={snap.undoLabel ? `Deshacer: ${snap.undoLabel} (Ctrl+Z)` : 'Deshacer (Ctrl+Z)'}
            title={snap.undoLabel ? `Deshacer: ${snap.undoLabel} (Ctrl+Z)` : 'Deshacer (Ctrl+Z)'}
            data-testid="studio-undo"
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            className="stu-btn"
            data-size="icon"
            disabled={!snap.canRedo || recording}
            onClick={() => controller.redo()}
            aria-label={snap.redoLabel ? `Rehacer: ${snap.redoLabel} (Ctrl+Y)` : 'Rehacer (Ctrl+Y)'}
            title={snap.redoLabel ? `Rehacer: ${snap.redoLabel} (Ctrl+Y)` : 'Rehacer (Ctrl+Y)'}
            data-testid="studio-redo"
          >
            <Redo2 size={14} />
          </button>
        </div>

        <div className="stu-bar-group" role="group" aria-label="Edición del clip">
          <button type="button" className="stu-btn" data-size="icon" disabled={recording || !ready} onClick={() => controller.splitAtPlayhead()} aria-label="Dividir en el cabezal (S)" title="Dividir en el cabezal (S)" data-testid="studio-split">
            <Scissors size={14} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={!selected || recording} onClick={() => controller.duplicateSelected()} aria-label="Duplicar el clip (Ctrl+D)" title="Duplicar el clip (Ctrl+D)" data-testid="studio-duplicate">
            <Copy size={14} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={!selected || recording} onClick={() => controller.deleteSelected()} aria-label="Borrar el clip (Supr)" title="Borrar el clip (Supr)" data-testid="studio-delete">
            <Trash2 size={14} />
          </button>
          {selected && !selected.clip.active && (
            <button type="button" className="stu-btn" disabled={recording} onClick={() => controller.activateTake(selected.clip.id)} title="Hacer que suene esta toma (doble clic o Enter)" data-testid="studio-use-take">
              <Layers size={14} />
              USAR TOMA
            </button>
          )}
        </div>

        <div className="stu-bar-group" role="group" aria-label="Ajuste a la rejilla">
          <span className="stu-label">Ajuste</span>
          <div className="stu-seg">
            {SNAP_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                className="stu-btn"
                data-on={snap.snap === option.mode}
                aria-pressed={snap.snap === option.mode}
                onClick={() => controller.setSnap(option.mode)}
                title={`${option.title}. Alt mientras arrastras lo suspende.`}
                data-testid={`studio-snap-${option.mode}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <span className="stu-label stu-mono" style={{ flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} aria-live="polite" data-testid="studio-selection">
          {selected
            ? `${selected.clip.active ? 'CLIP' : 'TOMA'} ${selected.track.name} · ${formatTimecode(selected.clip.startS)} · ${selected.clip.lengthS.toFixed(2)} s`
            : 'Sin clip elegido'}
        </span>

        <div className="stu-bar-group" role="group" aria-label="Zoom">
          <button type="button" className="stu-btn" data-size="icon" disabled={zoom <= MIN_ZOOM} onClick={() => changeZoom(zoom / 1.5)} aria-label="Alejar" title="Alejar (Ctrl + rueda)">
            <ZoomOut size={14} />
          </button>
          <button type="button" className="stu-btn" onClick={fitZoom} title="Ver toda la sesión">
            AJUSTAR
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={zoom >= MAX_ZOOM} onClick={() => changeZoom(zoom * 1.5)} aria-label="Acercar" title="Acercar (Ctrl + rueda)">
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      {snap.loading && (
        <div className="stu-progress" role="progressbar" aria-label="Cargando audios" aria-valuemin={0} aria-valuemax={snap.loading.total} aria-valuenow={snap.loading.done}>
          <div style={{ transform: `scaleX(${loadingFraction})` }} />
        </div>
      )}

      <div className="stu-tl-wrap">
      <div
        className="stu-tl-body"
        ref={bodyRef}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.types).includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          if (!dropping) setDropping(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={onDrop}
      >
        <div className="stu-tl-heads" style={{ minHeight: `${contentHeight}px` }}>
          <div className="stu-tl-corner" style={{ height: `${RULER_H}px` }}>
            <span className="stu-label">
              Pistas {session.tracks.length}/{STUDIO_MAX_TRACKS}
            </span>
            <span className="stu-label">{snap.loading ? `Audio ${snap.loading.done}/${snap.loading.total}` : ''}</span>
          </div>
          {session.tracks.map((track, index) => (
            <StudioTrackHeader
              key={track.id}
              controller={controller}
              track={track}
              index={index}
              height={rows[index]?.height ?? TRACK_ROW_H}
              armed={snap.arms[track.id] ?? null}
              recordAllowed={recordAllowed}
              recording={recording}
              inputChannels={inputChannels}
            />
          ))}
          <div className="stu-add-track">
            <button type="button" className="stu-btn" disabled={session.tracks.length >= STUDIO_MAX_TRACKS || recording} onClick={() => controller.addEmptyTrack()} data-testid="studio-add-track">
              <Plus size={14} />
              PISTA
            </button>
            <button type="button" className="stu-btn" disabled={!ready || recording || session.tracks.length >= STUDIO_MAX_TRACKS} onClick={() => fileRef.current?.click()} data-testid="studio-import">
              <Upload size={14} />
              AUDIO
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.wav,.flac,.mp3,.m4a,.ogg,.aac"
              multiple
              hidden
              onChange={(event) => {
                const files = audioFiles(event.target.files)
                event.target.value = ''
                if (files.length > 0) void controller.importFiles(files)
              }}
              data-testid="studio-import-input"
            />
          </div>
        </div>

        <div className="stu-tl-lanes">
          <div className="stu-tl-spacer" style={{ width: `${Math.ceil(contentSeconds * zoom)}px`, height: `${contentHeight}px` }}>
            <canvas
              ref={canvasRef}
              className="stu-canvas"
              style={{ height: `${contentHeight}px` }}
              tabIndex={0}
              role="application"
              aria-label="Clips de la sesión. Flechas: mover el clip elegido o el cabezal. Enter: usar la toma elegida. Inicio: volver al principio."
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={(event) => endDrag(event, true)}
              onPointerCancel={(event) => endDrag(event, false)}
              onPointerLeave={() => {
                if (hoverRef.current !== null && !dragRef.current) {
                  hoverRef.current = null
                  dirtyRef.current = true
                }
              }}
              onDoubleClick={onDoubleClick}
              onKeyDown={onCanvasKeyDown}
              data-testid="studio-canvas"
            />
            <div ref={playheadRef} className="stu-playhead" data-state={recording ? 'recording' : 'idle'} aria-hidden="true" />
          </div>
        </div>
      </div>
        {session.tracks.length === 0 && !snap.loading && (
          <div className="stu-empty" style={{ left: 'var(--stu-head-w)' }}>
            <strong style={{ color: 'var(--stu-text)', fontSize: '15px' }}>Sesión vacía</strong>
            <span>Arrastra archivos de audio aquí, agrega una pista para grabar o importa audio con el botón AUDIO.</span>
          </div>
        )}
        {dropping && <div className="stu-drop">SUELTA EL AUDIO: SOBRE UNA PISTA ENTRA AHÍ; FUERA, CREA PISTAS NUEVAS</div>}
      </div>
    </section>
  )
}
