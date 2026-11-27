/**
 * Puente bidireccional entre el Universo de la Cancion (`Song` / `ChordPro` / `Setlist`) y el
 * Estudio DAW (`StudioSession`):
 *   - `songToStudioSeed(song)`: traduce secciones por compases a `StudioMarker[]` y acordes en
 *     linea `[Am]` de cada seccion `chordpro` a `StudioChord[]` exactos en beats.
 *   - `studioToSongPatch(song, session)`: traduce de vuelta `bpm`, `beatsPerBar`, `key`,
 *     `StudioMarker[]` -> `SongSection[]` (conservando letras y avisos hablados existentes cuando
 *     coinciden) y `StudioChord[]` -> acordes ChordPro, devolviendo una vista previa Diff antes de
 *     sobrescribir la ficha oficial de la cancion.
 *   - `sessionToNewSong(session, idFactory)`: promueve una maqueta libre creada en el Estudio DAW
 *     (`songId === null`) a una `Song` oficial lista para agregar a un Setlist.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import type { SectionKind, Song, SongSection } from '../../types/hub.ts'
import { diffSongs, type SongDiff } from '../versionControl.ts'
import { clampBpm, sectionStartBars, totalBars } from '../workspaceSchema.ts'
import {
  STUDIO_MAX_BEAT,
  STUDIO_MAX_MARKERS,
  STUDIO_MAX_SESSION_CHORD_NAME,
  STUDIO_MAX_SESSION_CHORDS,
  compareChords,
  compareMarkers,
  newStudioId,
  roundBeat,
  sessionEndSeconds,
  secondsToBeats,
  type StudioChord,
  type StudioMarker,
  type StudioMarkerKind,
  type StudioSession,
} from './session.ts'

const SECTION_TO_MARKER_KIND: Record<SectionKind, StudioMarkerKind> = {
  intro: 'intro',
  verse: 'verse',
  pre_chorus: 'pre_chorus',
  chorus: 'chorus',
  bridge: 'bridge',
  solo: 'solo',
  interlude: 'interlude',
  outro: 'outro',
  break: 'break',
  custom: 'marker',
}

const MARKER_TO_SECTION_KIND: Record<StudioMarkerKind, SectionKind> = {
  intro: 'intro',
  verse: 'verse',
  pre_chorus: 'pre_chorus',
  chorus: 'chorus',
  bridge: 'bridge',
  solo: 'solo',
  interlude: 'interlude',
  outro: 'outro',
  break: 'break',
  marker: 'custom',
}

const CHORD_TOKEN_RE = /\[([A-G][#b♯♭]?[^\]]{0,14})\]/g

function sanitizeChordName(raw: string): string | null {
  const cleaned = raw.trim().replace(/♯/g, '#').replace(/♭/g, 'b').slice(0, STUDIO_MAX_SESSION_CHORD_NAME)
  if (!cleaned || !/^[A-G]/.test(cleaned)) return null
  return cleaned
}

/** Extrae acordes `[Acorde]` de un bloque ChordPro distribuyendolos proporcionalmente en sus compases. */
export function extractChordsFromSection(
  chordpro: string,
  sectionStartBeat: number,
  sectionLengthBeats: number,
  beatsPerBar: number,
): StudioChord[] {
  if (!chordpro.trim() || !(sectionLengthBeats > 0)) return []
  const lines = chordpro
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('{'))

  const lineChords: string[][] = []
  for (const line of lines) {
    const found: string[] = []
    for (const m of line.matchAll(CHORD_TOKEN_RE)) {
      const name = sanitizeChordName(m[1])
      if (name) found.push(name)
    }
    if (found.length > 0) lineChords.push(found)
  }
  if (lineChords.length === 0) return []

  const bpb = Math.max(1, beatsPerBar)
  const out: StudioChord[] = []
  const spanPerLine = sectionLengthBeats / lineChords.length

  lineChords.forEach((chordsInLine, lineIdx) => {
    const lineStart = sectionStartBeat + lineIdx * spanPerLine
    const step = Math.max(0.5, spanPerLine / chordsInLine.length)
    chordsInLine.forEach((name, idx) => {
      // Cuantizar suavemente a medios tiempos cuando el reparto cae cerca de la rejilla.
      const rawBeat = lineStart + idx * step
      const beat = roundBeat(Math.round(rawBeat * 2) / 2)
      const lengthBeats = roundBeat(Math.max(0.5, Math.min(step, sectionStartBeat + sectionLengthBeats - beat, bpb * 4)))
      if (beat >= 0 && beat + lengthBeats <= STUDIO_MAX_BEAT) {
        out.push({ beat, lengthBeats, name })
      }
    })
  })
  return out.sort(compareChords).slice(0, STUDIO_MAX_SESSION_CHORDS)
}

export interface StudioSongSeed {
  title: string
  songId: string
  bpm: number
  beatsPerBar: number
  key: string | null
  markers: StudioMarker[]
  chords: StudioChord[]
}

/** Genera marcadores y acordes iniciales de Estudio a partir de una `Song` de la libreria. */
export function songToStudioSeed(song: Song, idGen: (prefix: 'mk' | 'sec' | 'song') => string = newStudioId): StudioSongSeed {
  const beatsPerBar = Math.max(1, Math.min(12, Math.round(song.beatsPerBar || 4)))
  const bpm = clampBpm(song.bpm)
  const starts = sectionStartBars(song.sections)
  const markers: StudioMarker[] = []
  const chords: StudioChord[] = []

  song.sections.forEach((sec, idx) => {
    const startBar = starts[idx] ?? 1
    const beat = roundBeat((startBar - 1) * beatsPerBar)
    if (beat <= STUDIO_MAX_BEAT && markers.length < STUDIO_MAX_MARKERS) {
      markers.push({
        id: idGen('mk'),
        beat,
        label: (sec.label || '').trim().slice(0, 60),
        kind: SECTION_TO_MARKER_KIND[sec.kind] ?? 'marker',
      })
    }
    const secBeats = Math.max(1, Math.round(sec.bars || 4)) * beatsPerBar
    for (const ch of extractChordsFromSection(sec.chordpro, beat, secBeats, beatsPerBar)) {
      if (chords.length < STUDIO_MAX_SESSION_CHORDS) chords.push(ch)
    }
  })

  return {
    title: song.title.trim().slice(0, 120) || 'Sesión',
    songId: song.id,
    bpm,
    beatsPerBar,
    key: song.key?.trim() ? song.key.trim().slice(0, 12) : null,
    markers: markers.sort(compareMarkers),
    chords: chords.sort(compareChords),
  }
}

/** Aplica la estructura y armonia de una `Song` sobre una `StudioSession` existente. */
export function applySongStructureToSession(
  session: StudioSession,
  song: Song,
  idGen: (prefix: 'mk' | 'sec' | 'song') => string = newStudioId,
): StudioSession {
  const seed = songToStudioSeed(song, idGen)
  return {
    ...session,
    songId: song.id,
    bpm: seed.bpm,
    beatsPerBar: seed.beatsPerBar,
    key: seed.key,
    markers: seed.markers,
    chords: seed.chords.length > 0 ? seed.chords : session.chords,
  }
}

function formatChordsAsChordPro(chords: readonly StudioChord[], startBeat: number, endBeat: number, beatsPerBar: number): string {
  const inRange = chords.filter((c) => c.beat >= startBeat - 0.01 && c.beat < endBeat - 0.01)
  if (inRange.length === 0) return ''
  const bars: string[][] = []
  const totalBarsCount = Math.max(1, Math.round((endBeat - startBeat) / Math.max(1, beatsPerBar)))
  for (let b = 0; b < totalBarsCount; b++) bars.push([])
  for (const c of inRange) {
    const barIdx = Math.min(totalBarsCount - 1, Math.max(0, Math.floor((c.beat - startBeat) / Math.max(1, beatsPerBar))))
    bars[barIdx].push(`[${c.name}]`)
  }
  const nonEmpty = bars.map((b) => (b.length > 0 ? b.join(' ') : '[%]'))
  const lines: string[] = []
  for (let i = 0; i < nonEmpty.length; i += 4) {
    lines.push(nonEmpty.slice(i, i + 4).join('  '))
  }
  return lines.join('\n')
}

function buildSectionsFromSession(
  session: StudioSession,
  existingSections: readonly SongSection[],
  idGen: (prefix: 'mk' | 'sec' | 'song') => string,
): SongSection[] {
  const bpb = Math.max(1, session.beatsPerBar)
  const sorted = [...session.markers].sort(compareMarkers)
  const sessionChords = session.chords ?? []
  const endS = sessionEndSeconds(session)
  const sessionEndBeat = Math.max(
    sorted.length > 0 ? sorted[sorted.length - 1].beat + bpb * 4 : bpb * 8,
    endS > 0 ? Math.ceil(secondsToBeats(endS, session.bpm) / bpb) * bpb : bpb * 8,
  )

  if (sorted.length === 0) {
    if (existingSections.length > 0) return existingSections.map((s) => ({ ...s }))
    const bars = Math.max(4, Math.round(sessionEndBeat / bpb))
    return [
      {
        id: idGen('sec'),
        kind: 'verse',
        label: ' Arreglo Principal'.trim(),
        bars,
        chordpro: formatChordsAsChordPro(sessionChords, 0, bars * bpb, bpb),
      },
    ]
  }

  return sorted.map((m, i) => {
    const nextBeat = i + 1 < sorted.length ? sorted[i + 1].beat : Math.max(m.beat + bpb * 4, sessionEndBeat)
    const bars = Math.max(1, Math.round((nextBeat - m.beat) / bpb))
    const kind = MARKER_TO_SECTION_KIND[m.kind] ?? 'custom'
    const label = m.label.trim() || kind.toUpperCase()
    const match =
      existingSections[i] && existingSections[i].kind === kind
        ? existingSections[i]
        : existingSections.find((s) => s.label.trim().toLowerCase() === label.toLowerCase() && s.kind === kind)

    const studioChordsText = formatChordsAsChordPro(sessionChords, m.beat, m.beat + bars * bpb, bpb)
    // Si la seccion existente tenia letra sin corchetes o estaba vacia, inyectamos los acordes del Estudio;
    // si ya tenia letra con acordes, conservamos la letra intacta para nunca destruir letras vocales.
    let chordpro = match?.chordpro ?? ''
    if (!chordpro.trim() && studioChordsText) {
      chordpro = studioChordsText
    } else if (chordpro.trim() && !CHORD_TOKEN_RE.test(chordpro) && studioChordsText) {
      CHORD_TOKEN_RE.lastIndex = 0
      chordpro = `${studioChordsText}\n${chordpro}`
    }
    CHORD_TOKEN_RE.lastIndex = 0

    return {
      id: match?.id ?? idGen('sec'),
      kind,
      label,
      bars,
      chordpro,
      ...(match?.cueText !== undefined ? { cueText: match.cueText } : {}),
    }
  })
}

export interface SongSyncPreview {
  updatedSong: Song
  diff: SongDiff
}

/** Calcula la actualizacion propuesta de `Song` desde una `StudioSession` + su Diff de confirmacion. */
export function studioToSongPatch(
  song: Song,
  session: StudioSession,
  idGen: (prefix: 'mk' | 'sec' | 'song') => string = newStudioId,
  nowIso = new Date().toISOString(),
): SongSyncPreview {
  const sections = buildSectionsFromSession(session, song.sections, idGen)
  const bars = totalBars(sections)
  const beatsPerBar = Math.max(1, Math.min(12, session.beatsPerBar))
  const bpm = clampBpm(session.bpm)
  const durationSec = Math.max(
    1,
    Math.round(sessionEndSeconds(session) || (bars * beatsPerBar * 60) / bpm),
  )

  const updatedSong: Song = {
    ...song,
    bpm,
    beatsPerBar,
    key: session.key ?? song.key,
    durationSec,
    sections,
    updatedAt: nowIso,
  }

  return {
    updatedSong,
    diff: diffSongs(song, updatedSong),
  }
}

/** Promueve una sesion o maqueta libre del Estudio DAW a una nueva `Song` oficial del repertorio. */
export function sessionToNewSong(
  session: StudioSession,
  options: { artist?: string; camelot?: string; songId?: string; nowIso?: string } = {},
  idGen: (prefix: 'mk' | 'sec' | 'song') => string = newStudioId,
): Song {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const sections = buildSectionsFromSession(session, [], idGen)
  const beatsPerBar = Math.max(1, Math.min(12, session.beatsPerBar))
  const bpm = clampBpm(session.bpm)
  const bars = totalBars(sections)
  const durationSec = Math.max(1, Math.round(sessionEndSeconds(session) || (bars * beatsPerBar * 60) / bpm))

  return {
    id: options.songId ?? idGen('song'),
    title: session.title.trim() || 'Nueva Canción desde Estudio',
    artist: (options.artist ?? '').trim(),
    bpm,
    beatsPerBar,
    beatUnit: 4,
    key: session.key ?? 'C',
    ...(options.camelot ? { camelot: options.camelot } : {}),
    durationSec,
    sections,
    notes: 'Creada desde maqueta del Estudio DAW.',
    updatedAt: nowIso,
  }
}
