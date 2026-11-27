/**
 * Puente bidireccional entre el Universo de la Cancion (`Song` / `ChordPro` / `Setlist`) y el
 * Estudio DAW (`StudioSession`):
 *   - `songToStudioSeed(song)`: traduce secciones por compases a `StudioMarker[]` y acordes en
 *     linea `[Am]` de cada seccion `chordpro` a `StudioChord[]` exactos en beats.
 *   - `studioToSongPatch(song, session)`: traduce de vuelta `bpm`, `beatsPerBar`, `key`, duracion,
 *     `StudioMarker[]` -> `SongSection[]` y `StudioChord[]` -> acordes ChordPro, devolviendo una
 *     vista previa antes de sobrescribir la ficha oficial. Las secciones emparejadas con un
 *     marcador conservan su letra y su aviso hablado (si tienen letra con acordes en linea y los
 *     del Estudio difieren, los acordes NO se aplican y la vista previa lo dice); las secciones
 *     sin marcador se eliminan, y la vista previa lista las que se van con letra (`lyricsRemoved`)
 *     para que la interfaz pida confirmacion.
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

/** Nombres de acorde `[X]` de un bloque ChordPro, en orden (sin `[%]` ni directivas). */
export function chordNamesOf(chordpro: string): string[] {
  const out: string[] = []
  for (const line of chordpro.split(/\r?\n/)) {
    if (line.trim().startsWith('{')) continue
    for (const m of line.matchAll(CHORD_TOKEN_RE)) {
      const name = sanitizeChordName(m[1])
      if (name) out.push(name)
    }
  }
  return out
}

/** Texto cantado de un bloque ChordPro: lo que queda al quitar acordes, `[%]`, barras y directivas. */
export function lyricTextOf(chordpro: string): string {
  return chordpro
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('{'))
    .map((line) => line.replace(/\[[^\]]*\]/g, ' ').replace(/[|%]/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i])
}

interface BuiltSections {
  sections: SongSection[]
  /** Secciones cuyos acordes se reescriben con los del Estudio. */
  chordsUpdated: string[]
  /** Secciones con letra y acordes en linea cuyos acordes difieren de los del Estudio: se conserva la letra. */
  chordsKept: string[]
}

function buildSectionsFromSession(
  session: StudioSession,
  existingSections: readonly SongSection[],
  idGen: (prefix: 'mk' | 'sec' | 'song') => string,
): BuiltSections {
  const bpb = Math.max(1, session.beatsPerBar)
  const sorted = [...session.markers].sort(compareMarkers)
  const sessionChords = [...(session.chords ?? [])].sort(compareChords)
  const endS = sessionEndSeconds(session)
  const sessionEndBeat = Math.max(
    sorted.length > 0 ? sorted[sorted.length - 1].beat + bpb * 4 : bpb * 8,
    endS > 0 ? Math.ceil(secondsToBeats(endS, session.bpm) / bpb) * bpb : bpb * 8,
  )
  const chordsUpdated: string[] = []
  const chordsKept: string[] = []

  if (sorted.length === 0) {
    if (existingSections.length > 0) return { sections: existingSections.map((s) => ({ ...s })), chordsUpdated, chordsKept }
    const bars = Math.max(4, Math.round(sessionEndBeat / bpb))
    return {
      sections: [
        {
          id: idGen('sec'),
          kind: 'verse',
          label: 'Arreglo Principal',
          bars,
          chordpro: formatChordsAsChordPro(sessionChords, 0, bars * bpb, bpb),
        },
      ],
      chordsUpdated,
      chordsKept,
    }
  }

  // Cada seccion existente se empareja a lo sumo con un marcador: dos marcadores "Coro" no
  // comparten id (el lider usa el id de la seccion como clave).
  const used = new Set<string>()
  const sections = sorted.map((m, i) => {
    const nextBeat = i + 1 < sorted.length ? sorted[i + 1].beat : Math.max(m.beat + bpb * 4, sessionEndBeat)
    const bars = Math.max(1, Math.round((nextBeat - m.beat) / bpb))
    const kind = MARKER_TO_SECTION_KIND[m.kind] ?? 'custom'
    const label = m.label.trim() || kind.toUpperCase()
    const byIndex = existingSections[i]
    const match =
      byIndex && byIndex.kind === kind && !used.has(byIndex.id)
        ? byIndex
        : existingSections.find((s) => !used.has(s.id) && s.kind === kind && s.label.trim().toLowerCase() === label.toLowerCase())
    if (match) used.add(match.id)

    const endBeat = m.beat + bars * bpb
    const studioNames = sessionChords.filter((c) => c.beat >= m.beat - 0.01 && c.beat < endBeat - 0.01).map((c) => c.name)
    const studioChordsText = formatChordsAsChordPro(sessionChords, m.beat, endBeat, bpb)
    const existing = match?.chordpro ?? ''
    let chordpro = existing
    if (!existing.trim()) {
      // Nada que perder: los acordes del Estudio, si hay.
      if (studioChordsText) {
        chordpro = studioChordsText
        chordsUpdated.push(label)
      }
    } else if (!sameNames(chordNamesOf(existing), studioNames)) {
      const hasLyrics = lyricTextOf(existing).length > 0
      const existingNames = chordNamesOf(existing)
      if (!hasLyrics) {
        // Solo acordes: se reescriben con los del Estudio.
        chordpro = studioChordsText
        chordsUpdated.push(label)
      } else if (existingNames.length === 0) {
        // Letra sin acordes: los acordes del Estudio van encima y la letra queda intacta.
        chordpro = `${studioChordsText}\n${existing}`
        chordsUpdated.push(label)
      } else {
        // Letra con acordes en linea: reubicarlos sobre las silabas no es seguro; se conserva tal cual.
        chordsKept.push(label)
      }
    }

    return {
      id: match?.id ?? idGen('sec'),
      kind,
      label,
      bars,
      chordpro,
      ...(match?.cueText !== undefined ? { cueText: match.cueText } : {}),
    }
  })
  return { sections, chordsUpdated, chordsKept }
}

export interface SongSyncPreview {
  updatedSong: Song
  diff: SongDiff
  /** Lineas de la vista previa: las del diff de la ficha mas duracion, acordes y letras en riesgo. */
  summary: string[]
  /** true si aplicar cambia algo de la ficha (incluida la duracion). */
  changed: boolean
  /** [antes, despues] en segundos, o null si no cambia. */
  durationChanged: [number | null, number] | null
  chordsUpdated: string[]
  chordsKept: string[]
  /** Secciones de la ficha sin marcador en el Estudio que llevan letra o aviso hablado: se eliminarian. */
  lyricsRemoved: Array<{ id: string; label: string }>
}

/** m:ss de una duracion en segundos ("—" si no hay). */
export function formatDurationSec(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Calcula la actualizacion propuesta de `Song` desde una `StudioSession` + su Diff de confirmacion. */
export function studioToSongPatch(
  song: Song,
  session: StudioSession,
  idGen: (prefix: 'mk' | 'sec' | 'song') => string = newStudioId,
  nowIso = new Date().toISOString(),
): SongSyncPreview {
  const built = buildSectionsFromSession(session, song.sections, idGen)
  const sections = built.sections
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

  const diff = diffSongs(song, updatedSong)
  const keptIds = new Set(sections.map((s) => s.id))
  const lyricsRemoved = song.sections
    .filter((s) => !keptIds.has(s.id) && (lyricTextOf(s.chordpro).length > 0 || (typeof s.cueText === 'string' && s.cueText.trim().length > 0)))
    .map((s) => ({ id: s.id, label: s.label || s.kind }))
  const before = song.durationSec ?? null
  const durationChanged: [number | null, number] | null = before === durationSec ? null : [before, durationSec]

  const summary = [...diff.summary]
  if (durationChanged) summary.push(`Duración: ${formatDurationSec(durationChanged[0])} -> ${formatDurationSec(durationChanged[1])}`)
  if (built.chordsUpdated.length > 0) summary.push(`Acordes del Estudio aplicados en: ${built.chordsUpdated.join(', ')}`)
  if (built.chordsKept.length > 0) {
    summary.push(`Acordes NO aplicados (la sección tiene letra con acordes en línea; se conserva): ${built.chordsKept.join(', ')}`)
  }
  if (lyricsRemoved.length > 0) {
    summary.push(`Se eliminarían CON SU LETRA (sin marcador en el Estudio): ${lyricsRemoved.map((s) => s.label).join(', ')}`)
  }

  return {
    updatedSong,
    diff,
    summary,
    changed: diff.changed || durationChanged !== null,
    durationChanged,
    chordsUpdated: built.chordsUpdated,
    chordsKept: built.chordsKept,
    lyricsRemoved,
  }
}

/** Promueve una sesion o maqueta libre del Estudio DAW a una nueva `Song` oficial del repertorio. */
export function sessionToNewSong(
  session: StudioSession,
  options: { artist?: string; camelot?: string; songId?: string; nowIso?: string } = {},
  idGen: (prefix: 'mk' | 'sec' | 'song') => string = newStudioId,
): Song {
  const nowIso = options.nowIso ?? new Date().toISOString()
  const { sections } = buildSectionsFromSession(session, [], idGen)
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
