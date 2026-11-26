import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Copy, Download, FileMusic, Layers, Music, Piano, Plus, Redo2, Scissors, Trash2, Undo2, Upload, ZoomIn, ZoomOut } from 'lucide-react'
import { isStemAudioPath } from '../../services/stemNames'
import { dbToGain, type SectionSpan } from '../../services/stemTiming'
import { clipFadeFactor } from '../../services/studio/graph'
import { listPlugins } from '../../services/studio/instruments/wamHost'
import { peaksForRange } from '../../services/studio/peaks'
import {
  beatsToSeconds,
  findAsset,
  findClip,
  findMidiClip,
  secondsToBeats,
  sessionEndSeconds,
  STUDIO_INSTRUMENT_TYPE_LABELS,
  STUDIO_MAX_SESSION_SECONDS,
  STUDIO_MAX_TRACKS,
  type StudioClip,
  type StudioMidiClip,
  type StudioMidiNote,
  type StudioSession,
  type StudioTrack,
} from '../../services/studio/session'
import { expandMidiClipNotes, moveClip, moveClipsBy, moveMidiClip, resizeMidiClip, setClipFades, snapTime, trimClip } from '../../services/studio/sessionOps'
import { clipsInMarquee, dragLoopRegion, marqueeFromPoints, marqueeSelection, type LoopDragPart, type MarqueeClipBox, type MarqueeRect } from '../../services/studio/timelineMath'
import type { AssetPeaks, LoopRegionS, PeakColumns, SnapMode } from '../../services/studio/types'
import { studioTrackColor, type StudioCanvasPalette } from '../../services/studioCanvasPalette'
import { StudioPianoRoll } from './StudioPianoRoll'
import { StudioTrackHeader } from './StudioTrackHeader'
import { useStudioCanvasPalette } from './useStudioCanvasPalette'
import {
  downloadBlob,
  formatBarBeat,
  formatTimecode,
  isMidiFile,
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
  /** Todos los clips elegidos (seleccion multiple), con el principal. */
  selectedIds: ReadonlySet<string>
  hoverClipId: string | null
  sections: readonly SectionSpan[]
  loop: LoopRegionS | null
  missing: ReadonlySet<string>
  arms: Readonly<Record<string, ArmChannel>>
  /** Pista de instrumento armada para MIDI. */
  midiArmed: string | null
  selectedTrackId: string | null
  /** Tramo de la toma en curso, para marcarlo en las pistas armadas. */
  recBand: LoopRegionS | null
  /** Rectangulo de seleccion en curso (coordenadas del contenido), o null. */
  marquee: MarqueeRect | null
  getPeaks: (assetId: string) => AssetPeaks | null
  /** Colores del tema vigente (useStudioCanvasPalette). */
  palette: StudioCanvasPalette
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
  const selected = scene.selectedIds.has(clip.id)
  const hovered = clip.id === scene.hoverClipId
  const asset = findAsset(scene.session, clip.assetId)
  const missing = scene.missing.has(clip.assetId)
  const x = Math.max(box.x, -2)
  const w = Math.min(box.x + box.w, view.width + 2) - x
  const pal = scene.palette

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, box.y, w, box.h)
  ctx.clip()
  ctx.fillStyle = withAlpha(color, clip.active ? (selected ? 0.3 : 0.18) : selected ? 0.18 : 0.08)
  ctx.fillRect(x, box.y, w, box.h)

  if (missing) {
    ctx.strokeStyle = pal.missingHatch
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
    ctx.fillStyle = pal.fadeShade
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
    // Un clip inactivo sin grupo de tomas es un clip silenciado (tecla 0), no una toma alternativa.
    const state = clip.active ? '' : clip.takeGroup === null ? 'SILENCIO  ' : 'TOMA  '
    const text = `${generated ? 'IA  ' : ''}${state}${name}`
    ctx.font = FONT
    ctx.textBaseline = 'top'
    const tx = Math.max(box.x, 0) + 6
    const ty = box.y + (clip.active ? 5 : 7)
    // Fondo bajo el texto: se lee tambien encima de la forma de onda.
    ctx.fillStyle = pal.labelBg
    ctx.fillRect(tx - 3, ty - 2, ctx.measureText(text).width + 6, 14)
    ctx.fillStyle = missing ? pal.danger : withAlpha(pal.text, clip.active ? 0.92 : 0.7)
    ctx.fillText(text, tx, ty)
  }
  ctx.restore()

  ctx.strokeStyle = selected ? pal.text : withAlpha(color, clip.active ? 0.75 : 0.4)
  ctx.lineWidth = selected ? 1.5 : 1
  if (!clip.active) ctx.setLineDash([4, 3])
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
  ctx.setLineDash([])

  // Manijas de fade del clip elegido o bajo el puntero.
  if (clip.active && (selected || hovered) && box.w > 40) {
    ctx.fillStyle = pal.text
    const hy = box.y + 1
    const inX = box.x + clip.fadeInS * view.zoom
    const outX = box.x + box.w - clip.fadeOutS * view.zoom
    ctx.fillRect(inX - 3, hy, 7, 7)
    ctx.fillRect(outX - 4, hy, 7, 7)
  }
}

// --- Clips MIDI ---

/** Notas que suenan en cada clip (repeticion desplegada), por identidad del clip: se recalculan solo si cambia. */
const expandedNotes = new WeakMap<StudioMidiClip, StudioMidiNote[]>()

function soundingNotes(clip: StudioMidiClip): StudioMidiNote[] {
  let notes = expandedNotes.get(clip)
  if (!notes) {
    notes = expandMidiClipNotes(clip)
    expandedNotes.set(clip, notes)
  }
  return notes
}

function midiClipBox(clip: StudioMidiClip, bpm: number, row: TrackRowLayout, view: View): ClipBox {
  const x = beatsToSeconds(clip.startBeat, bpm) * view.zoom - view.scrollX
  const w = beatsToSeconds(clip.lengthBeats, bpm) * view.zoom
  return { x, y: RULER_H + row.top + 4, w, h: TRACK_ROW_H - 8 }
}

const MIDI_LABEL_H = 18

function paintMidiClip(ctx: CanvasRenderingContext2D, scene: Scene, track: StudioTrack, clip: StudioMidiClip, row: TrackRowLayout, color: string, view: View): void {
  const bpm = scene.session.bpm
  const box = midiClipBox(clip, bpm, row, view)
  if (box.x > view.width || box.x + box.w < 0) return
  const selected = scene.selectedIds.has(clip.id)
  // Silenciado (tecla 0): mismo dibujo que un clip de audio en silencio, atenuado y con borde punteado.
  const muted = clip.muted === true
  const x = Math.max(box.x, -2)
  const w = Math.min(box.x + box.w, view.width + 2) - x
  const beatPx = beatsToSeconds(1, bpm) * view.zoom
  const pal = scene.palette

  ctx.save()
  ctx.beginPath()
  ctx.rect(x, box.y, w, box.h)
  ctx.clip()
  ctx.fillStyle = withAlpha(color, muted ? (selected ? 0.12 : 0.05) : selected ? 0.24 : 0.12)
  ctx.fillRect(x, box.y, w, box.h)

  // Vueltas del patron: lineas punteadas donde vuelve a empezar.
  if (clip.loop && clip.loopBeats < clip.lengthBeats) {
    ctx.strokeStyle = withAlpha(color, 0.5)
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    for (let b = clip.loopBeats; b < clip.lengthBeats - 1e-6; b += clip.loopBeats) {
      const lx = Math.round(box.x + b * beatPx) + 0.5
      ctx.moveTo(lx, box.y + MIDI_LABEL_H)
      ctx.lineTo(lx, box.y + box.h)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Notas en miniatura: el rango de pitch del clip ocupa el alto bajo la etiqueta.
  const notes = soundingNotes(clip)
  if (notes.length > 0) {
    let low = 127
    let high = 0
    for (const n of notes) {
      if (n.pitch < low) low = n.pitch
      if (n.pitch > high) high = n.pitch
    }
    const span = Math.max(12, high - low + 1)
    const mid = (low + high) / 2
    low = Math.max(0, Math.floor(mid - span / 2))
    const top = box.y + MIDI_LABEL_H
    const area = box.h - MIDI_LABEL_H - 4
    const noteH = Math.max(1.5, Math.min(5, area / span))
    ctx.fillStyle = withAlpha(color, muted ? 0.32 : 0.92)
    for (const n of notes) {
      const nx = box.x + n.start * beatPx
      const nw = Math.max(1.5, Math.min(n.length, clip.lengthBeats - n.start) * beatPx - 1)
      if (nx > view.width || nx + nw < 0) continue
      const ny = top + area - ((n.pitch - low + 1) / span) * area
      ctx.fillRect(nx, ny, nw, noteH)
    }
  }

  if (w > 34) {
    const instrument = track.instrument
    const name = instrument ? STUDIO_INSTRUMENT_TYPE_LABELS[instrument.type].toUpperCase() : 'MIDI'
    const text = `${muted ? 'SILENCIO  ' : ''}MIDI  ${name}  ${clip.notes.length}${clip.loop ? '  LOOP' : ''}`
    ctx.font = FONT
    ctx.textBaseline = 'top'
    const tx = Math.max(box.x, 0) + 6
    const ty = box.y + 5
    ctx.fillStyle = pal.labelBg
    ctx.fillRect(tx - 3, ty - 2, ctx.measureText(text).width + 6, 14)
    ctx.fillStyle = withAlpha(pal.text, muted ? 0.7 : 0.92)
    ctx.fillText(text, tx, ty)
  }
  ctx.restore()

  ctx.strokeStyle = selected ? pal.text : withAlpha(color, muted ? 0.4 : 0.75)
  ctx.lineWidth = selected ? 1.5 : 1
  if (muted) ctx.setLineDash([4, 3])
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
  ctx.setLineDash([])
  // Bordes que se arrastran para recortar, en el clip elegido.
  if (selected && box.w > 24) {
    ctx.fillStyle = pal.text
    ctx.fillRect(box.x + 1, box.y + box.h / 2 - 8, 2, 16)
    ctx.fillRect(box.x + box.w - 3, box.y + box.h / 2 - 8, 2, 16)
  }
}

function paintTimeline(ctx: CanvasRenderingContext2D, scene: Scene, view: View, buffers: PeakBuffers): void {
  const { session, rows } = scene
  const { width, height, zoom, scrollX } = view
  const t0 = scrollX / zoom
  const t1 = (scrollX + width) / zoom
  const pal = scene.palette
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, width, height)

  // Filas
  rows.forEach((row, index) => {
    const y = RULER_H + row.top
    ctx.fillStyle = index % 2 === 0 ? pal.lane : pal.laneAlt
    ctx.fillRect(0, y, width, TRACK_ROW_H)
    if (row.laneCount > 0) {
      ctx.fillStyle = pal.takeLane
      ctx.fillRect(0, y + TRACK_ROW_H, width, row.height - TRACK_ROW_H)
    }
    if (scene.arms[row.trackId] !== undefined || scene.midiArmed === row.trackId) {
      ctx.fillStyle = pal.armedTint
      ctx.fillRect(0, y, width, TRACK_ROW_H)
    } else if (scene.selectedTrackId === row.trackId) {
      ctx.fillStyle = pal.selectedTrackTint
      ctx.fillRect(0, y, width, TRACK_ROW_H)
    }
    ctx.fillStyle = pal.rowLine
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
    ctx.fillStyle = pal.gridStrong
    ctx.fillRect(x, RULER_H, 1, rowsBottom - RULER_H)
    if (showBeats && barStep === 1) {
      ctx.fillStyle = pal.gridSoft
      for (let beat = 1; beat < session.beatsPerBar; beat++) {
        ctx.fillRect(Math.round((bar * barS + beat * beatS) * zoom - scrollX), RULER_H, 1, rowsBottom - RULER_H)
      }
    }
  }

  // Region de repeticion sobre las pistas
  if (scene.loop) {
    const lx = scene.loop.startS * zoom - scrollX
    const lw = (scene.loop.endS - scene.loop.startS) * zoom
    ctx.fillStyle = pal.loopFill
    ctx.fillRect(lx, RULER_H, lw, rowsBottom - RULER_H)
    ctx.fillStyle = pal.loopEdge
    ctx.fillRect(Math.round(lx), RULER_H, 1, rowsBottom - RULER_H)
    ctx.fillRect(Math.round(lx + lw), RULER_H, 1, rowsBottom - RULER_H)
  }

  // Clips: los activos encima de los inactivos; el elegido al final
  session.tracks.forEach((track, index) => {
    const row = rows[index]
    if (!row) return
    const color = studioTrackColor(pal, trackColor(index, track.role))
    if (track.kind === 'instrument') {
      let selectedMidi: StudioMidiClip | null = null
      for (const clip of track.midiClips) {
        if (clip.id === scene.selectedClipId) selectedMidi = clip
        else paintMidiClip(ctx, scene, track, clip, row, color, view)
      }
      if (selectedMidi) paintMidiClip(ctx, scene, track, selectedMidi, row, color, view)
      if (track.midiClips.length === 0 && view.width > 200) {
        ctx.font = FONT
        ctx.textBaseline = 'middle'
        ctx.fillStyle = pal.hint
        ctx.fillText('DOBLE CLIC PARA CREAR UN CLIP MIDI', 10, RULER_H + row.top + TRACK_ROW_H / 2)
      }
      return
    }
    let selected: StudioClip | null = null
    for (const clip of track.clips) {
      if (clip.id === scene.selectedClipId) selected = clip
      else paintClip(ctx, scene, clip, row, color, view, buffers)
    }
    if (selected) paintClip(ctx, scene, selected, row, color, view, buffers)
    if (row.laneCount > 0) {
      ctx.font = FONT
      ctx.textBaseline = 'top'
      ctx.fillStyle = pal.hint
      ctx.fillText('TOMAS', 6, RULER_H + row.top + TRACK_ROW_H + 3)
    }
  })

  // Toma en curso
  if (scene.recBand && scene.recBand.endS > scene.recBand.startS) {
    const rx = scene.recBand.startS * zoom - scrollX
    const rw = (scene.recBand.endS - scene.recBand.startS) * zoom
    rows.forEach((row) => {
      if (scene.arms[row.trackId] === undefined && scene.midiArmed !== row.trackId) return
      ctx.fillStyle = pal.recFill
      ctx.fillRect(rx, RULER_H + row.top + 4, rw, TRACK_ROW_H - 8)
      ctx.strokeStyle = pal.danger
      ctx.lineWidth = 1
      ctx.strokeRect(rx + 0.5, RULER_H + row.top + 4.5, rw - 1, TRACK_ROW_H - 9)
    })
  }

  // Rectangulo de seleccion (arrastre en una zona vacia)
  if (scene.marquee) {
    const mx = scene.marquee.startS * zoom - scrollX
    const mw = Math.max(1, (scene.marquee.endS - scene.marquee.startS) * zoom)
    const my = scene.marquee.top
    const mh = Math.max(1, scene.marquee.bottom - scene.marquee.top)
    ctx.fillStyle = pal.selectionFill
    ctx.fillRect(mx, my, mw, mh)
    ctx.strokeStyle = pal.selection
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeRect(Math.round(mx) + 0.5, Math.round(my) + 0.5, Math.round(mw) - 1, Math.round(mh) - 1)
    ctx.setLineDash([])
  }

  // Regla (siempre visible: se dibuja en el scroll vertical del cuerpo)
  const ry = view.scrollTop
  ctx.fillStyle = pal.ruler
  ctx.fillRect(0, ry, width, RULER_H)
  ctx.font = FONT
  ctx.textBaseline = 'middle'
  for (const section of scene.sections) {
    if (section.endSec < t0 || section.startSec > t1) continue
    const sx = section.startSec * zoom - scrollX
    const sw = (section.endSec - section.startSec) * zoom
    const active = scene.loop !== null && Math.abs(scene.loop.startS - section.startSec) < 0.001 && Math.abs(scene.loop.endS - section.endSec) < 0.001
    ctx.fillStyle = active ? pal.sectionActive : pal.section
    ctx.fillRect(sx + 1, ry + 2, sw - 2, SECTION_BAND_H - 3)
    if (sw > 26) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(sx + 1, ry, sw - 2, SECTION_BAND_H)
      ctx.clip()
      ctx.fillStyle = active ? pal.rulerTextActive : pal.rulerText
      ctx.fillText(section.label.toUpperCase(), Math.max(sx, 0) + 6, ry + SECTION_BAND_H / 2 + 0.5)
      ctx.restore()
    }
  }
  if (scene.sections.length === 0) {
    ctx.fillStyle = pal.rulerHint
    ctx.fillText('SIN SECCIONES: ARRASTRA SOBRE LA REGLA PARA MARCAR UNA REPETICIÓN', 8, ry + SECTION_BAND_H / 2 + 0.5)
  }
  if (scene.loop) {
    const lx = scene.loop.startS * zoom - scrollX
    const lw = (scene.loop.endS - scene.loop.startS) * zoom
    ctx.fillStyle = pal.loopRuler
    ctx.fillRect(lx, ry + SECTION_BAND_H, lw, RULER_H - SECTION_BAND_H)
    ctx.fillStyle = pal.accent
    ctx.fillRect(lx, ry + RULER_H - 3, lw, 3)
    // Tiradores de los bordes: se arrastran para estirar o encoger la repeticion; el centro la mueve.
    ctx.fillRect(Math.round(lx), ry + SECTION_BAND_H + 2, 3, RULER_H - SECTION_BAND_H - 2)
    ctx.fillRect(Math.round(lx + lw) - 3, ry + SECTION_BAND_H + 2, 3, RULER_H - SECTION_BAND_H - 2)
  }
  for (let bar = startBar; bar * barS <= t1; bar += barStep) {
    const x = Math.round(bar * barS * zoom - scrollX)
    ctx.fillStyle = pal.rulerTick
    ctx.fillRect(x, ry + SECTION_BAND_H + 12, 1, RULER_H - SECTION_BAND_H - 12)
    ctx.fillStyle = pal.rulerText
    ctx.fillText(String(bar + 1), x + 4, ry + SECTION_BAND_H + 9)
  }
  ctx.fillStyle = pal.rowLine
  ctx.fillRect(0, ry + RULER_H - 1, width, 1)
  ctx.fillRect(0, ry + SECTION_BAND_H, width, 1)

  // Marcas de la sesion (Shift+M; Ctrl+flechas va de una a otra): linea fina y nombre en la regla.
  for (const marker of session.markers) {
    const ms = beatsToSeconds(marker.beat, session.bpm)
    if (ms < t0 - 1 || ms > t1) continue
    const mx = Math.round(ms * zoom - scrollX)
    ctx.fillStyle = pal.markerLine
    ctx.fillRect(mx, ry + RULER_H, 1, rowsBottom - RULER_H)
    ctx.fillStyle = pal.marker
    ctx.beginPath()
    ctx.moveTo(mx, ry + RULER_H - 1)
    ctx.lineTo(mx + 6, ry + RULER_H - 7)
    ctx.lineTo(mx, ry + RULER_H - 13)
    ctx.closePath()
    ctx.fill()
    if (marker.label) {
      ctx.font = FONT
      ctx.textBaseline = 'middle'
      ctx.fillText(marker.label.toUpperCase(), mx + 9, ry + RULER_H - 7)
    }
  }
}

// ---------------------------------------------------------------------------
// Geometria del puntero
// ---------------------------------------------------------------------------

type ClipPart = 'body' | 'start' | 'end' | 'fadeIn' | 'fadeOut'

type MidiPart = 'body' | 'start' | 'end'

type Hit =
  | { kind: 'section'; section: SectionSpan }
  | { kind: 'loop'; part: LoopDragPart }
  | { kind: 'ruler' }
  | { kind: 'clip'; clipId: string; part: ClipPart }
  | { kind: 'midi'; clipId: string; part: MidiPart }
  | { kind: 'empty'; trackId: string | null }

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
    } else if (scene.loop) {
      // Banda de compases con repeticion: bordes para estirarla, centro para moverla.
      const lx0 = scene.loop.startS * view.zoom - view.scrollX
      const lx1 = scene.loop.endS * view.zoom - view.scrollX
      const edge = Math.min(EDGE_PX, Math.max(2, (lx1 - lx0) / 4))
      if (Math.abs(px - lx0) <= edge) return { kind: 'loop', part: 'start' }
      if (Math.abs(px - lx1) <= edge) return { kind: 'loop', part: 'end' }
      if (px > lx0 && px < lx1) return { kind: 'loop', part: 'body' }
    }
    return { kind: 'ruler' }
  }
  for (let index = 0; index < scene.session.tracks.length; index++) {
    const row = scene.rows[index]
    if (!row || py < RULER_H + row.top || py >= RULER_H + row.top + row.height) continue
    const track = scene.session.tracks[index]
    if (track.kind === 'instrument') {
      const ordered = [...track.midiClips].reverse().sort((a, b) => Number(b.id === scene.selectedClipId) - Number(a.id === scene.selectedClipId))
      for (const clip of ordered) {
        const box = midiClipBox(clip, scene.session.bpm, row, view)
        if (px < box.x || px > box.x + box.w || py < box.y || py > box.y + box.h) continue
        const edge = Math.min(EDGE_PX, box.w / 4)
        if (px - box.x <= edge) return { kind: 'midi', clipId: clip.id, part: 'start' }
        if (box.x + box.w - px <= edge) return { kind: 'midi', clipId: clip.id, part: 'end' }
        return { kind: 'midi', clipId: clip.id, part: 'body' }
      }
      return { kind: 'empty', trackId: track.id }
    }
    const clips = track.clips
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
    return { kind: 'empty', trackId: track.id }
  }
  return { kind: 'empty', trackId: null }
}

/** Beat ajustado a la rejilla de la linea de tiempo (compas, tiempo o libre a 1/64). */
function snapBeat(beat: number, mode: SnapMode, beatsPerBar: number, floor = false): number {
  const step = mode === 'bar' ? beatsPerBar : mode === 'beat' ? 1 : 1 / 64
  const round = floor ? Math.floor : Math.round
  return Math.max(0, round(beat / step + (floor ? 1e-9 : 0)) * step)
}

const PART_CURSOR: Record<ClipPart, string> = { body: 'grab', start: 'ew-resize', end: 'ew-resize', fadeIn: 'col-resize', fadeOut: 'col-resize' }
const PART_LABEL: Record<ClipPart, string> = { body: 'Mover clip', start: 'Recortar clip', end: 'Recortar clip', fadeIn: 'Fade de entrada', fadeOut: 'Fade de salida' }

const MIDI_CURSOR: Record<MidiPart, string> = { body: 'grab', start: 'ew-resize', end: 'ew-resize' }
const MIDI_LABEL: Record<MidiPart, string> = { body: 'Mover clip MIDI', start: 'Recortar clip MIDI', end: 'Recortar clip MIDI' }

/**
 * Arrastre en curso. `group`: con varios clips elegidos, arrastrar el cuerpo de uno los mueve a
 * todos la misma distancia, en sus pistas (null = un solo clip, que si puede cambiar de pista).
 */
type Drag =
  | { kind: 'ruler'; startPx: number; startS: number; moved: boolean }
  | { kind: 'loop'; part: LoopDragPart; base: LoopRegionS; startPx: number; startS: number; moved: boolean }
  /** Rectangulo de seleccion desde una zona vacia; sin moverse es un clic (cabezal y pista). */
  | { kind: 'marquee'; startPx: number; startPy: number; startS: number; trackId: string | null; additive: boolean; before: readonly string[]; moved: boolean }
  | { kind: 'clip'; part: ClipPart; clipId: string; base: StudioSession; grabS: number; startPx: number; startPy: number; moved: boolean; group: readonly string[] | null }
  | { kind: 'midi'; part: MidiPart; clipId: string; base: StudioSession; grabBeat: number; startPx: number; startPy: number; moved: boolean; group: readonly string[] | null }

/**
 * Cajas de todos los clips en coordenadas del contenido (segundos y px verticales), para el
 * rectangulo de seleccion. Las tomas inactivas se eligen en su carril, donde se dibujan.
 */
function marqueeBoxes(session: StudioSession, rows: readonly TrackRowLayout[], view: View): MarqueeClipBox[] {
  const boxes: MarqueeClipBox[] = []
  session.tracks.forEach((track, index) => {
    const row = rows[index]
    if (!row) return
    for (const clip of track.clips) {
      const box = clipBox(clip, row, view)
      boxes.push({ id: clip.id, startS: clip.startS, endS: clip.startS + clip.lengthS, top: box.y, bottom: box.y + box.h })
    }
    for (const clip of track.midiClips) {
      const box = midiClipBox(clip, session.bpm, row, view)
      boxes.push({ id: clip.id, startS: beatsToSeconds(clip.startBeat, session.bpm), endS: beatsToSeconds(clip.startBeat + clip.lengthBeats, session.bpm), top: box.y, bottom: box.y + box.h })
    }
  })
  return boxes
}

/** Vista neutra: la geometria vertical de los clips no depende del scroll ni del zoom. */
const NO_VIEW: View = { scrollX: 0, scrollTop: 0, width: 0, height: 0, zoom: 1 }

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
  const midiFileRef = useRef<HTMLInputElement>(null)
  const dirtyRef = useRef(true)
  // Colores del tema vigente: cacheados, cambian (y repintan) solo al cambiar tema o acento.
  const palette = useStudioCanvasPalette()
  const paletteRef = useRef(palette)
  const zoomRef = useRef(DEFAULT_ZOOM)
  const draftRef = useRef<StudioSession | null>(null)
  const loopDraftRef = useRef<LoopRegionS | null>(null)
  const marqueeRef = useRef<MarqueeRect | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const hoverRef = useRef<string | null>(null)
  /** Tiempo que debe quedar bajo `px` tras cambiar el zoom. */
  const anchorRef = useRef<{ timeS: number; px: number } | null>(null)

  const rows = useMemo(() => layoutTracks(session), [session])
  const rowsHeight = rows.length > 0 ? rows[rows.length - 1].top + rows[rows.length - 1].height : 0
  const contentHeight = RULER_H + rowsHeight + FOOTER_H
  const contentSeconds = Math.min(STUDIO_MAX_SESSION_SECONDS, Math.max(120, sessionEndSeconds(session) + 60))
  const selected = snap.selectedClipId ? findClip(session, snap.selectedClipId) : null
  const selectedMidi = snap.selectedClipId ? findMidiClip(session, snap.selectedClipId) : null
  const pianoOpen = snap.editor === 'piano_roll' && snap.pianoClipId !== null
  const hasInstrumentTrack = session.tracks.some((track) => track.kind === 'instrument')
  const wamPlugins = listPlugins()

  // Cualquier cambio discreto repinta el canvas en el siguiente fotograma.
  useEffect(() => {
    paletteRef.current = palette
    dirtyRef.current = true
  }, [
    palette,
    session,
    snap.selectedClipId,
    snap.selectedClipIds,
    snap.selectedTrackId,
    snap.midi.armedTrackId,
    snap.peaksVersion,
    snap.engine.loop,
    snap.engine.missingAssetIds,
    snap.sections,
    snap.arms,
    recording,
    zoom,
    contentHeight,
  ])

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
    const rowsShown = layoutTracks(shown)
    // Durante el rectangulo, los clips que toca se ven elegidos antes de soltar.
    const marquee = marqueeRef.current
    const drag = dragRef.current
    const selectedIds =
      marquee && drag?.kind === 'marquee'
        ? new Set(marqueeSelection(drag.before, clipsInMarquee(marqueeBoxes(shown, rowsShown, NO_VIEW), marquee), drag.additive))
        : new Set(current.selectedClipIds)
    return {
      session: shown,
      rows: rowsShown,
      selectedClipId: current.selectedClipId,
      selectedIds,
      marquee,
      hoverClipId: hoverRef.current,
      sections: current.sections,
      loop: loopDraftRef.current ?? current.engine.loop,
      missing: new Set(current.engine.missingAssetIds),
      arms: current.arms,
      midiArmed: current.midi.armedTrackId,
      selectedTrackId: current.selectedTrackId,
      recBand: fromS === null ? null : { startS: fromS, endS: Math.max(fromS, controller.engine.position()) },
      getPeaks: (assetId) => controller.getPeaks(assetId),
      palette: paletteRef.current,
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

  const fitZoom = useCallback(() => {
    const scroller = bodyRef.current
    if (!scroller) return
    const end = Math.max(8, sessionEndSeconds(controller.snapshot().session) + 2)
    anchorRef.current = { timeS: 0, px: 0 }
    const target = clampZoom(laneWidth(scroller) / end)
    if (target === zoomRef.current) scroller.scrollLeft = 0
    else setZoom(target)
  }, [controller])

  /** Deja el cabezal en el centro de la vista (Shift+C). */
  const centerPlayhead = useCallback(() => {
    const scroller = bodyRef.current
    if (!scroller) return
    scroller.scrollLeft = Math.max(0, controller.engine.position() * zoomRef.current - laneWidth(scroller) / 2)
    dirtyRef.current = true
  }, [controller])

  // Pedidos del registro de comandos (+, -, Shift+Z, Shift+C) mientras la linea de tiempo es el editor activo.
  useEffect(
    () =>
      controller.onViewCommand((command) => {
        if (controller.snapshot().editor !== 'timeline') return
        if (command.type === 'zoom') changeZoom(zoomRef.current * (command.direction > 0 ? 1.5 : 1 / 1.5))
        else if (command.type === 'fit') fitZoom()
        else if (command.type === 'center') centerPlayhead()
      }),
    [controller, changeZoom, fitZoom, centerPlayhead],
  )

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
    if (hit.kind === 'loop') {
      if (!scene.loop) return
      dragRef.current = { kind: 'loop', part: hit.part, base: scene.loop, startPx: at.px, startS: timeS, moved: false }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (hit.kind === 'clip' || hit.kind === 'midi') {
      // Shift o Ctrl (Cmd) + clic: agrega o quita el clip de la seleccion, sin arrastrar.
      if (event.shiftKey || event.ctrlKey || event.metaKey) {
        controller.toggleClipSelection(hit.clipId)
        return
      }
      // Clic sobre un clip que ya forma parte de una seleccion multiple: se arrastran todos.
      const current = controller.snapshot().selectedClipIds
      const inGroup = current.length > 1 && current.includes(hit.clipId)
      if (inGroup) controller.focusSelectedClip(hit.clipId)
      else controller.select(hit.clipId)
      const group = inGroup && hit.part === 'body' ? current : null
      if (hit.kind === 'clip') {
        const loc = findClip(scene.session, hit.clipId)
        if (!loc || recording) return
        dragRef.current = { kind: 'clip', part: hit.part, clipId: hit.clipId, base: scene.session, grabS: timeS - loc.clip.startS, startPx: at.px, startPy: at.py, moved: false, group }
      } else {
        const loc = findMidiClip(scene.session, hit.clipId)
        if (!loc || recording) return
        const beat = secondsToBeats(timeS, scene.session.bpm)
        dragRef.current = { kind: 'midi', part: hit.part, clipId: hit.clipId, base: scene.session, grabBeat: beat - loc.clip.startBeat, startPx: at.px, startPy: at.py, moved: false, group }
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    // Zona vacia: un clic deja el cabezal ahi y elige la pista; arrastrar dibuja un rectangulo que
    // elige los clips que toca. Con Shift o Ctrl (Cmd) el rectangulo suma a la seleccion y el
    // cabezal no se mueve.
    const additive = event.shiftKey || event.ctrlKey || event.metaKey
    const before = controller.snapshot().selectedClipIds
    if (!additive) {
      controller.select(null)
      if (hit.trackId) controller.selectTrack(hit.trackId)
      controller.seek(timeS)
    }
    dragRef.current = { kind: 'marquee', startPx: at.px, startPy: at.py, startS: timeS, trackId: hit.trackId, additive, before, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
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
      event.currentTarget.style.cursor =
        hit.kind === 'clip'
          ? recording
            ? 'default'
            : PART_CURSOR[hit.part]
          : hit.kind === 'midi'
            ? recording
              ? 'default'
              : MIDI_CURSOR[hit.part]
            : hit.kind === 'empty'
              ? 'default'
              : hit.kind === 'loop'
                ? hit.part === 'body'
                  ? 'grab'
                  : 'ew-resize'
                : 'pointer'
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
    if (drag.kind === 'loop') {
      if (!drag.moved && Math.abs(at.px - drag.startPx) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      loopDraftRef.current = dragLoopRegion(drag.base, drag.part, timeS - drag.startS, {
        minLengthS: MIN_LOOP_S,
        maxS: STUDIO_MAX_SESSION_SECONDS,
        snap: mode === 'off' ? undefined : (s) => snapTime(current.session, { timeS: s, mode }),
      })
      event.currentTarget.style.cursor = drag.part === 'body' ? 'grabbing' : 'ew-resize'
      dirtyRef.current = true
      return
    }
    if (drag.kind === 'marquee') {
      if (!drag.moved && Math.hypot(at.px - drag.startPx, at.py - drag.startPy) < DRAG_THRESHOLD_PX) return
      drag.moved = true
      marqueeRef.current = marqueeFromPoints({ timeS: drag.startS, y: drag.startPy }, { timeS, y: Math.max(RULER_H, at.py) })
      event.currentTarget.style.cursor = 'crosshair'
      dirtyRef.current = true
      return
    }
    if (!drag.moved && Math.hypot(at.px - drag.startPx, at.py - drag.startPy) < DRAG_THRESHOLD_PX) return
    drag.moved = true
    if (drag.group && drag.part === 'body') {
      // Varios clips: el que se agarro cae en la rejilla y los demas lo siguen la misma distancia.
      const span = drag.kind === 'clip' ? findClip(drag.base, drag.clipId)?.clip : null
      const midi = drag.kind === 'midi' ? findMidiClip(drag.base, drag.clipId)?.clip : null
      try {
        let deltaS = 0
        if (span && drag.kind === 'clip') {
          deltaS = snapTime(drag.base, { timeS: Math.max(0, timeS - drag.grabS), mode }) - span.startS
        } else if (midi && drag.kind === 'midi') {
          const startBeat = snapBeat(Math.max(0, secondsToBeats(timeS, drag.base.bpm) - drag.grabBeat), mode, drag.base.beatsPerBar)
          deltaS = beatsToSeconds(startBeat - midi.startBeat, drag.base.bpm)
        }
        draftRef.current = moveClipsBy(drag.base, drag.group, deltaS)
        event.currentTarget.style.cursor = 'grabbing'
      } catch {
        // Un destino invalido deja el borrador como estaba.
      }
      dirtyRef.current = true
      return
    }
    if (drag.kind === 'midi') {
      const beat = secondsToBeats(timeS, drag.base.bpm)
      try {
        if (drag.part === 'body') {
          const row = rowAt(layoutTracks(drag.base), at.py)
          const target = row ? drag.base.tracks.find((t) => t.id === row.trackId) : undefined
          const startBeat = snapBeat(Math.max(0, beat - drag.grabBeat), mode, drag.base.beatsPerBar)
          draftRef.current = moveMidiClip(drag.base, { clipId: drag.clipId, startBeat, trackId: target?.kind === 'instrument' ? target.id : undefined })
          event.currentTarget.style.cursor = 'grabbing'
        } else {
          draftRef.current = resizeMidiClip(drag.base, { clipId: drag.clipId, edge: drag.part, toBeat: snapBeat(beat, mode, drag.base.beatsPerBar) })
        }
      } catch {
        // Destino invalido (pista llena): el borrador queda como estaba.
      }
      dirtyRef.current = true
      return
    }
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
    if (drag.kind === 'loop') {
      const region = loopDraftRef.current
      loopDraftRef.current = null
      if (!commit) return
      if (!drag.moved) controller.seek(drag.startS)
      else if (region) controller.setLoop(region)
      return
    }
    if (drag.kind === 'marquee') {
      const rect = marqueeRef.current
      marqueeRef.current = null
      if (!commit || !drag.moved || !rect) return
      const session = controller.snapshot().session
      const picked = clipsInMarquee(marqueeBoxes(session, layoutTracks(session), NO_VIEW), rect)
      const ids = marqueeSelection(drag.before, picked, drag.additive)
      // El principal es el ultimo que entro: el inspector y el piano roll muestran ese.
      controller.selectClips(ids, picked[picked.length - 1])
      return
    }
    const draft = draftRef.current
    draftRef.current = null
    // Clic sin arrastre sobre un clip de una seleccion multiple: queda elegido solo ese.
    if (commit && !drag.moved && drag.group) controller.select(drag.clipId)
    if (commit && draft && draft !== drag.base) {
      // Si la sesion cambio durante el arrastre (deshacer con el teclado), el borrador ya no vale.
      const label = drag.group ? `Mover ${drag.group.length} clips` : drag.kind === 'midi' ? MIDI_LABEL[drag.part] : PART_LABEL[drag.part]
      if (controller.snapshot().session === drag.base) controller.apply(draft, label)
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
    if (hit.kind === 'midi') controller.openPianoRoll(hit.clipId)
    if (hit.kind === 'empty' && hit.trackId && !recording) {
      const track = scene.session.tracks.find((t) => t.id === hit.trackId)
      if (track?.kind !== 'instrument') return
      const beat = secondsToBeats(Math.max(0, (at.view.scrollX + at.px) / at.view.zoom), scene.session.bpm)
      const startBeat = snapBeat(beat, snap.snap === 'off' ? 'beat' : snap.snap, scene.session.beatsPerBar, true)
      controller.addMidiClipAt(track.id, startBeat, scene.session.beatsPerBar)
    }
  }

  // Las flechas, Inicio y los demas atajos los atiende el registro de comandos de la vista
  // (StudioHubView + commands.ts, contexto 'timeline'). Aqui quedan solo las dos teclas propias
  // del lienzo; las demas siguen de largo hasta el manejador global.
  const onCanvasKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === 'Enter' && selected && !selected.clip.active) {
      event.preventDefault()
      controller.activateTake(selected.clip.id)
    } else if (event.key === 'Escape') {
      controller.select(null)
    }
  }

  // ---- importar ----

  const midiFiles = (list: FileList | null): File[] => Array.from(list ?? []).filter((file) => isMidiFile(file))
  const audioFiles = (list: FileList | null): File[] => Array.from(list ?? []).filter((file) => !isMidiFile(file) && (file.type.startsWith('audio/') || isStemAudioPath(file.name)))

  const exportSession = () => {
    const file = controller.exportSessionMidi()
    if (!file) {
      controller.notify('info', 'No hay notas MIDI que exportar: crea una pista de instrumento con un clip MIDI.')
      return
    }
    downloadBlob(file.blob, file.name)
  }

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDropping(false)
    const midi = midiFiles(event.dataTransfer.files)
    for (const file of midi) void controller.importMidiFile(file)
    const files = audioFiles(event.dataTransfer.files)
    if (files.length === 0) {
      if (midi.length === 0) controller.notify('warn', 'Suelta archivos de audio (wav, flac, mp3, m4a, ogg o aac) o archivos MIDI (.mid).')
      return
    }
    const at = pointerAt(event)
    const hitRow = at && files.length === 1 ? rowAt(rows, at.py) : null
    // Sobre una pista de instrumento el audio no puede entrar: crea una pista nueva.
    const row = hitRow && session.tracks.find((t) => t.id === hitRow.trackId)?.kind === 'audio' ? hitRow : null
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
    <section className="stu-tl" aria-label={pianoOpen ? 'Piano roll' : 'Línea de tiempo'} data-testid="studio-timeline" data-editor={pianoOpen ? 'piano_roll' : 'timeline'}>
      {pianoOpen && <StudioPianoRoll controller={controller} />}
      <div className="stu-tl-tools" hidden={pianoOpen}>
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
          <button type="button" className="stu-btn" data-size="icon" disabled={(!selected && !selectedMidi) || recording} onClick={() => controller.duplicateSelected()} aria-label="Duplicar los clips elegidos (Ctrl+D)" title="Duplicar los clips elegidos detrás de ellos (Ctrl+D)" data-testid="studio-duplicate">
            <Copy size={14} />
          </button>
          <button type="button" className="stu-btn" data-size="icon" disabled={(!selected && !selectedMidi) || recording} onClick={() => controller.deleteSelected()} aria-label="Borrar los clips elegidos (Supr)" title="Borrar los clips elegidos (Supr). Shift o Ctrl + clic elige varios." data-testid="studio-delete">
            <Trash2 size={14} />
          </button>
          {selected && !selected.clip.active && (
            <button type="button" className="stu-btn" disabled={recording} onClick={() => controller.activateTake(selected.clip.id)} title="Hacer que suene esta toma (doble clic o Enter)" data-testid="studio-use-take">
              <Layers size={14} />
              USAR TOMA
            </button>
          )}
        </div>

        <div className="stu-bar-group" role="group" aria-label="MIDI">
          <button
            type="button"
            className="stu-btn"
            disabled={!hasInstrumentTrack || recording || !ready}
            onClick={() => controller.addMidiClipAtPlayhead()}
            title={hasInstrumentTrack ? 'Clip MIDI de 4 compases en el cabezal, en la pista de instrumento elegida' : 'Crea antes una pista de instrumento'}
            data-testid="studio-add-midi-clip"
          >
            <Music size={14} />
            CLIP MIDI
          </button>
          <button
            type="button"
            className="stu-btn"
            disabled={!selectedMidi && snap.pianoClipId === null}
            onClick={() => controller.toggleEditor()}
            title="Abrir el clip MIDI elegido en el piano roll (doble clic en el clip, o E)"
            data-testid="studio-open-piano"
          >
            <Piano size={14} />
            PIANO ROLL
          </button>
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

        <span
          className="stu-label stu-mono"
          style={{ flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          aria-live="polite"
          data-testid="studio-selection"
          data-count={snap.selectedClipIds.length}
        >
          {snap.selectedClipIds.length > 1
            ? `${snap.selectedClipIds.length} CLIPS ELEGIDOS`
            : selected
            ? `${selected.clip.active ? 'CLIP' : selected.clip.takeGroup === null ? 'SILENCIADO' : 'TOMA'} ${selected.track.name} · ${formatTimecode(selected.clip.startS)} · ${selected.clip.lengthS.toFixed(2)} s`
            : selectedMidi
              ? `${selectedMidi.clip.muted ? 'SILENCIADO ' : ''}MIDI ${selectedMidi.track.name} · ${formatBarBeat(selectedMidi.clip.startBeat, session.beatsPerBar)} · ${(selectedMidi.clip.lengthBeats / session.beatsPerBar).toFixed(2)} compases · ${selectedMidi.clip.notes.length} notas`
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

      {/* Oculta (no desmontada) mientras el piano roll ocupa el area: conserva scroll y zoom. */}
      <div className="stu-tl-wrap" hidden={pianoOpen}>
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
              midiArmed={snap.midi.armedTrackId === track.id}
              selected={snap.selectedTrackId === track.id}
              recordAllowed={recordAllowed}
              recording={recording}
              inputChannels={inputChannels}
            />
          ))}
          <div className="stu-add-track">
            <button type="button" className="stu-btn" disabled={session.tracks.length >= STUDIO_MAX_TRACKS || recording} onClick={() => controller.addEmptyTrack()} title="Pista de audio nueva" data-testid="studio-add-track">
              <Plus size={14} />
              PISTA
            </button>
            <button type="button" className="stu-btn" disabled={!ready || recording || session.tracks.length >= STUDIO_MAX_TRACKS} onClick={() => fileRef.current?.click()} data-testid="studio-import">
              <Upload size={14} />
              AUDIO
            </button>
            <select
              className="stu-field stu-add-instrument"
              value=""
              disabled={!ready || recording || session.tracks.length >= STUDIO_MAX_TRACKS}
              onChange={(event) => {
                const [type, option] = event.target.value.split(':')
                if (type === 'synth' || type === 'drums' || type === 'sampler') controller.addInstrumentTrack(type)
                else if (type === 'wam' && option) controller.addInstrumentTrack('wam', option)
              }}
              aria-label="Agregar una pista de instrumento"
              title="Pista de instrumento nueva: sintetizador, caja de ritmos, sampler o plugin web"
              data-testid="studio-add-instrument"
            >
              <option value="">+ INSTRUMENTO</option>
              <option value="synth">{STUDIO_INSTRUMENT_TYPE_LABELS.synth}</option>
              <option value="drums">{STUDIO_INSTRUMENT_TYPE_LABELS.drums}</option>
              <option value="sampler">{STUDIO_INSTRUMENT_TYPE_LABELS.sampler}</option>
              {wamPlugins.length === 0 ? (
                <option value="wam" disabled>
                  Plugins web: ninguno en este Hub
                </option>
              ) : (
                wamPlugins.map((plugin) => (
                  <option key={plugin.id} value={`wam:${plugin.id}`}>
                    {plugin.name} ({plugin.vendor})
                  </option>
                ))
              )}
            </select>
            <button type="button" className="stu-btn" disabled={!ready || recording} onClick={() => midiFileRef.current?.click()} title="Importar un archivo MIDI (.mid) como pistas de instrumento" data-testid="studio-import-midi">
              <FileMusic size={14} />
              .MID
            </button>
            <button type="button" className="stu-btn" data-size="icon" disabled={!hasInstrumentTrack} onClick={exportSession} aria-label="Exportar las pistas de instrumento a un archivo MIDI" title="Exportar las pistas de instrumento a .mid" data-testid="studio-export-midi">
              <Download size={14} />
            </button>
            <input
              ref={midiFileRef}
              type="file"
              accept=".mid,.midi,audio/midi,audio/x-midi"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void controller.importMidiFile(file)
              }}
              data-testid="studio-import-midi-input"
            />
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
              aria-label="Clips de la sesión. Flechas: mover el clip elegido o el cabezal. Enter: usar la toma elegida. Inicio: volver al principio. Arrastrar en una zona vacía: elegir los clips del rectángulo (Shift o Ctrl suma). 0: silenciar los clips elegidos. Doble clic en un clip MIDI: abrirlo en el piano roll; en una pista de instrumento vacía: crear un clip MIDI."
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
            <span>Arrastra archivos de audio o MIDI aquí, agrega una pista para grabar, importa audio con el botón AUDIO o crea una pista de instrumento para tocar y dibujar notas.</span>
          </div>
        )}
        {dropping && <div className="stu-drop">SUELTA EL AUDIO: SOBRE UNA PISTA ENTRA AHÍ; FUERA, CREA PISTAS NUEVAS. UN .MID CREA PISTAS DE INSTRUMENTO</div>}
      </div>
    </section>
  )
}
