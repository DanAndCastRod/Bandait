/**
 * ChordPro en el Hub: separar una cancion completa en secciones y maquetar acordes sobre
 * silabas para la vista previa.
 *
 * Modulo puro (probado con `node scripts/verify-workspace-schema.ts`).
 *
 * Reconoce:
 * - entornos {start_of_verse: label} / {sov}, {start_of_chorus} / {soc}, {start_of_bridge} /
 *   {sob} y cualquier {start_of_<nombre>} (intro, solo, outro...), con su {end_of_*} / {eo?};
 * - {chorus} / {chorus: label}: repite el ultimo coro;
 * - comentarios {c: ...} / {comment: ...} / {ci: ...}: si el texto es un encabezado conocido
 *   ("Coro", "Intro"...) abren seccion; si no, se conservan dentro de la seccion;
 * - encabezados en texto plano: [Coro], (Coro), Coro:, "Coro: [F]Canta...", ESTROFA 1, Intro,
 *   Puente, Pre coro, Solo, Final... (espanol e ingles);
 * - metadatos {title:} / {t:}, {artist:} (o {subtitle:} / {st:} si no hay artist), {key:},
 *   {tempo:}.
 * Los acordes en linea [Am] quedan intactos. Cada seccion arranca con 8 compases; el usuario
 * los ajusta. Una cancion sin encabezados queda como una sola seccion "custom".
 */
import type { SectionKind } from '../types/hub.ts'

export const DEFAULT_SECTION_BARS = 8

export interface ParsedSection {
  kind: SectionKind
  label: string
  bars: number
  chordpro: string
  /** Solo se fija (null) en la seccion unica de una cancion sin encabezados. */
  cueText?: null
}

export interface ParsedChordProSong {
  title: string | null
  artist: string | null
  key: string | null
  bpm: number | null
  sections: ParsedSection[]
}

const META_DIRECTIVES = new Set([
  'title',
  't',
  'subtitle',
  'st',
  'artist',
  'key',
  'tempo',
  'time',
  'capo',
  'album',
  'year',
  'composer',
  'lyricist',
  'arranger',
  'copyright',
  'duration',
  'meta',
  'sorttitle',
  'new_song',
  'ns',
])

const COMMENT_DIRECTIVES = new Set(['c', 'comment', 'ci', 'comment_italic', 'cb', 'comment_box', 'highlight'])

const SHORT_START: Record<string, string> = { sov: 'verse', soc: 'chorus', sob: 'bridge', sot: 'tab', sog: 'grid' }
const SHORT_END: Record<string, string> = { eov: 'verse', eoc: 'chorus', eob: 'bridge', eot: 'tab', eog: 'grid' }

/** Nombre de entorno ChordPro -> kind. */
const ENV_KIND: Record<string, SectionKind> = {
  verse: 'verse',
  chorus: 'chorus',
  bridge: 'bridge',
  intro: 'intro',
  outro: 'outro',
  solo: 'solo',
  interlude: 'interlude',
  break: 'break',
  pre_chorus: 'pre_chorus',
  prechorus: 'pre_chorus',
  'pre-chorus': 'pre_chorus',
}

const AUTO_LABEL: Record<SectionKind, string> = {
  intro: 'Intro',
  verse: 'Estrofa',
  pre_chorus: 'Pre coro',
  chorus: 'Coro',
  bridge: 'Puente',
  solo: 'Solo',
  interlude: 'Interludio',
  outro: 'Final',
  break: 'Corte',
  custom: 'Sección',
}

/** Palabras de encabezado (normalizadas: minusculas, sin tildes). Las mas largas primero. */
const HEADING_WORDS: ReadonlyArray<[string, SectionKind]> = (
  [
    ['pre estribillo', 'pre_chorus'],
    ['pre coro', 'pre_chorus'],
    ['precoro', 'pre_chorus'],
    ['pre chorus', 'pre_chorus'],
    ['prechorus', 'pre_chorus'],
    ['introduccion', 'intro'],
    ['intro', 'intro'],
    ['estrofa', 'verse'],
    ['verso', 'verse'],
    ['verse', 'verse'],
    ['estribillo', 'chorus'],
    ['coro', 'chorus'],
    ['chorus', 'chorus'],
    ['refrain', 'chorus'],
    ['puente', 'bridge'],
    ['bridge', 'bridge'],
    ['solo', 'solo'],
    ['interludio', 'interlude'],
    ['interlude', 'interlude'],
    ['instrumental', 'interlude'],
    ['final', 'outro'],
    ['outro', 'outro'],
    ['coda', 'outro'],
    ['ending', 'outro'],
    ['cierre', 'outro'],
    ['corte', 'break'],
    ['break', 'break'],
  ] as Array<[string, SectionKind]>
).sort((a, b) => b[0].length - a[0].length)

/** Sufijo permitido en un encabezado sin marca: numero (1, 2, II) y/o "final", "bis", "x2". */
const STRICT_SUFFIX = /^(?:(?:\d{1,2}|[ivx]{1,4})(?:\s+|$))?(?:final|bis|x\s?\d|\d\s?x)?$/

function normalizeHeading(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.\-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sentenceCase(text: string): string {
  const hasLetters = /\p{L}/u.test(text)
  if (!hasLetters || text !== text.toUpperCase()) return text
  const lower = text.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Clasifica el texto de un posible encabezado. `marked`: venia con una marca explicita
 * (corchetes, parentesis, dos puntos, comentario {c:}), lo que permite calificativos mas
 * largos ("Solo de guitarra"). Sin marca solo se acepta palabra + numero/"final".
 */
export function classifyHeading(text: string, marked: boolean): { kind: SectionKind; label: string } | null {
  const raw = text.replace(/^[*_\s]+|[*_\s]+$/g, '')
  const norm = normalizeHeading(raw)
  if (!norm || norm.length > 40) return null
  for (const [word, kind] of HEADING_WORDS) {
    if (norm !== word && !norm.startsWith(`${word} `) && !(/\d$/.test(norm) && norm.startsWith(word) && /^\d+$/.test(norm.slice(word.length)))) {
      continue
    }
    const suffix = norm.slice(word.length).trim()
    const ok = suffix === '' || STRICT_SUFFIX.test(suffix) || (marked && suffix.length <= 24 && suffix.split(' ').length <= 4)
    if (!ok) return null
    return { kind, label: sentenceCase(raw) }
  }
  return null
}

const CHORD_ONLY = /^[\s|]*(?:\[[^\]]*\][\s|]*)+$/

function isChordOnly(line: string): boolean {
  return CHORD_ONLY.test(line)
}

/** Encabezado en texto plano. `rest` es contenido en la misma linea ("Coro: [F]Canta"). */
export function matchPlainHeading(line: string): { kind: SectionKind; label: string; rest: string } | null {
  let s = line.trim()
  if (!s) return null
  let marked = false
  if (s.startsWith('#')) {
    s = s.replace(/^#+\s*/, '')
    marked = true
  }
  s = s.replace(/^\*\*(.+)\*\*$/, '$1').trim()

  const wrapped = s.match(/^\[([^\]]+)\]$/) || s.match(/^\(([^)]+)\)$/)
  if (wrapped) {
    const h = classifyHeading(wrapped[1], true)
    return h ? { ...h, rest: '' } : null
  }
  const colon = s.match(/^([^:[\]{}]{1,40}):\s*(.*)$/)
  if (colon) {
    const h = classifyHeading(colon[1], true)
    return h ? { ...h, rest: colon[2] } : null
  }
  // "Intro [Am] [F] [C] [G]": encabezado seguido solo de acordes.
  const withChords = s.match(/^([^[\]{}]{1,40}?)\s+(\[.*)$/)
  if (withChords && isChordOnly(withChords[2])) {
    const h = classifyHeading(withChords[1], marked)
    if (h) return { ...h, rest: withChords[2] }
  }
  const h = classifyHeading(s, marked)
  return h ? { ...h, rest: '' } : null
}

interface Directive {
  name: string
  value: string | null
}

function parseDirective(trimmed: string): Directive | null {
  const m = trimmed.match(/^\{\s*([A-Za-z][\w-]*)\s*(?:[:\s]\s*([\s\S]*?))?\s*\}$/)
  if (!m) return null
  return { name: m[1].toLowerCase(), value: m[2] === undefined ? null : m[2].trim() }
}

interface Block {
  kind: SectionKind | null
  label: string | null
  /** El usuario no lo nombro (contenido sin encabezado). */
  implicit: boolean
  lines: string[]
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

/** Separa una cancion ChordPro completa en secciones. */
export function parseChordProSong(text: string): ParsedChordProSong {
  const result: ParsedChordProSong = { title: null, artist: null, key: null, bpm: null, sections: [] }
  let subtitle: string | null = null
  const blocks: Block[] = []
  let current: Block | null = null
  let inEnv = false
  let hasHeadings = false

  const open = (kind: SectionKind, label: string | null): Block => {
    const block: Block = { kind, label, implicit: false, lines: [] }
    blocks.push(block)
    current = block
    hasHeadings = true
    return block
  }
  const ensureBlock = (): Block => {
    if (current) return current
    const block: Block = { kind: null, label: null, implicit: true, lines: [] }
    blocks.push(block)
    current = block
    return block
  }

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '')
    const trimmed = line.trim()
    const d = parseDirective(trimmed)

    if (d) {
      const { name, value } = d
      if (META_DIRECTIVES.has(name)) {
        if ((name === 'title' || name === 't') && value) result.title = value
        else if (name === 'artist' && value) result.artist = value
        else if ((name === 'subtitle' || name === 'st') && value) subtitle = value
        else if (name === 'key' && value) result.key = value
        else if (name === 'tempo' && value) {
          const n = Number.parseFloat(value)
          if (Number.isFinite(n) && n > 0) result.bpm = n
        }
        continue
      }
      const startEnv = name.startsWith('start_of_') ? name.slice('start_of_'.length) : SHORT_START[name]
      if (startEnv) {
        const kind = ENV_KIND[startEnv] ?? 'custom'
        const fallback = kind === 'custom' ? sentenceCase(startEnv.replace(/_/g, ' ').toUpperCase()) : null
        open(kind, value || fallback)
        inEnv = true
        continue
      }
      if (name.startsWith('end_of_') || SHORT_END[name]) {
        current = null
        inEnv = false
        continue
      }
      if (name === 'chorus') {
        const last = [...blocks].reverse().find((b) => b.kind === 'chorus')
        const block = open('chorus', value || 'Coro')
        if (last) block.lines = trimBlankLines(last.lines)
        current = null
        inEnv = false
        continue
      }
      if (COMMENT_DIRECTIVES.has(name)) {
        const h = !inEnv && value ? classifyHeading(value, true) : null
        if (h) {
          open(h.kind, h.label)
          continue
        }
        ensureBlock().lines.push(line)
        continue
      }
      // Otra directiva ({define}, {textfont}...): se conserva dentro de la seccion abierta.
      if (current) (current as Block).lines.push(line)
      continue
    }

    if (trimmed.startsWith('#')) {
      // Comentario ChordPro: solo cuenta si es un encabezado ("# Coro").
      const h = !inEnv ? matchPlainHeading(trimmed) : null
      if (h) {
        const block = open(h.kind, h.label)
        if (h.rest) block.lines.push(h.rest)
      }
      continue
    }

    if (!inEnv) {
      const h = matchPlainHeading(line)
      if (h) {
        const block = open(h.kind, h.label)
        if (h.rest) block.lines.push(h.rest)
        continue
      }
    }

    if (trimmed === '' && !current) continue
    ensureBlock().lines.push(line)
  }

  if (!result.artist && subtitle) result.artist = subtitle

  if (!hasHeadings) {
    const body = trimBlankLines(blocks.flatMap((b) => b.lines))
    if (body.length > 0) {
      result.sections.push({ kind: 'custom', label: 'Letra', bars: DEFAULT_SECTION_BARS, chordpro: body.join('\n'), cueText: null })
    }
    return result
  }

  let verseCount = 0
  for (const block of blocks) {
    const body = trimBlankLines(block.lines)
    if (block.implicit && body.length === 0) continue
    let kind: SectionKind
    let label: string
    if (block.implicit) {
      const chordsOnly = body.every((l) => l.trim() === '' || isChordOnly(l))
      if (chordsOnly) {
        kind = result.sections.length === 0 ? 'intro' : 'interlude'
        label = AUTO_LABEL[kind]
      } else {
        kind = 'verse'
        label = `Estrofa ${verseCount + 1}`
      }
    } else {
      kind = block.kind ?? 'custom'
      label = block.label ?? (kind === 'verse' ? `Estrofa ${verseCount + 1}` : AUTO_LABEL[kind])
    }
    if (kind === 'verse') verseCount++
    result.sections.push({ kind, label, bars: DEFAULT_SECTION_BARS, chordpro: body.join('\n') })
  }
  return result
}

// ---------------------------------------------------------------------------
// Vista previa: acordes encima de las silabas
// ---------------------------------------------------------------------------

export type PreviewLine =
  | { type: 'pair'; chords: string; lyrics: string }
  | { type: 'comment'; text: string }
  | { type: 'blank' }

/** Maqueta una linea "[Am]Hoy [F]vuelvo" en dos renglones alineados (fuente monoespaciada). */
export function layoutChordLine(line: string): { chords: string; lyrics: string } {
  let chords = ''
  let lyrics = ''
  let hasChord = false
  const re = /\[([^\]]*)\]/g
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    lyrics += line.slice(last, m.index)
    last = m.index + m[0].length
    const chord = m[1]
    if (chords.length > 0 && chords.length >= lyrics.length) {
      // El acorde anterior es mas largo que su silaba: se separa con un espacio.
      lyrics = lyrics.padEnd(chords.length + 1, ' ')
    }
    chords = chords.padEnd(lyrics.length, ' ') + chord
    hasChord = true
  }
  lyrics += line.slice(last)
  return { chords: hasChord ? chords : '', lyrics }
}

export function layoutChordPro(body: string): PreviewLine[] {
  const out: PreviewLine[] = []
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '') {
      out.push({ type: 'blank' })
      continue
    }
    const d = parseDirective(trimmed)
    if (d) {
      if (COMMENT_DIRECTIVES.has(d.name) && d.value) out.push({ type: 'comment', text: d.value })
      continue
    }
    const { chords, lyrics } = layoutChordLine(line)
    out.push({ type: 'pair', chords, lyrics: lyrics.trim() === '' ? '' : lyrics })
  }
  return out
}

/** Un trozo de una palabra: el acorde que cae encima (o '') y su texto. */
export interface ChordSegment {
  chord: string
  text: string
}

export type FlowLine =
  | { type: 'words'; words: ChordSegment[][]; hasChords: boolean; hasLyrics: boolean }
  | { type: 'comment'; text: string }
  | { type: 'blank' }

/**
 * Una linea "[Am]Ho[F#m7]y vuel[F]vo" en palabras que no se parten ("Ho"+"y" es una sola): asi
 * la vista que ajusta renglones (prompter de ENSAYO) corta entre palabras y el acorde sigue
 * encima de su silaba. El espacio despues de una palabra queda al final de su ultimo trozo, para
 * que el texto siga siendo la letra. Una linea solo de acordes da una palabra por acorde.
 */
export function chordWords(line: string): ChordSegment[][] {
  const words: ChordSegment[][] = []
  let word: ChordSegment[] = []
  let chord = ''
  const addText = (text: string) => {
    for (const piece of text.match(/\S+\s*|\s+/g) ?? []) {
      if (!chord && /^\s+$/.test(piece)) {
        // Espacio sin acorde: se pega a la palabra anterior (o se ignora al inicio de la linea).
        const prev = word.length > 0 ? word : words[words.length - 1]
        if (prev) prev[prev.length - 1].text += piece
        if (word.length > 0) {
          words.push(word)
          word = []
        }
        continue
      }
      word.push({ chord, text: piece })
      chord = ''
      if (/\s$/.test(piece)) {
        words.push(word)
        word = []
      }
    }
  }
  const re = /\[([^\]]*)\]/g
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    addText(line.slice(last, m.index))
    last = m.index + m[0].length
    // Dos acordes seguidos sin texto: el primero queda solo, como palabra propia.
    if (chord) {
      word.push({ chord, text: ' ' })
      words.push(word)
      word = []
    }
    chord = m[1].trim()
  }
  addText(line.slice(last))
  if (chord) word.push({ chord, text: '' })
  if (word.length > 0) words.push(word)
  return words
}

/** Seccion ChordPro para la vista que ajusta renglones: palabras, comentarios y separaciones. */
export function flowChordPro(body: string): FlowLine[] {
  const out: FlowLine[] = []
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = raw.trim()
    if (trimmed === '') {
      out.push({ type: 'blank' })
      continue
    }
    const d = parseDirective(trimmed)
    if (d) {
      if (COMMENT_DIRECTIVES.has(d.name) && d.value) out.push({ type: 'comment', text: d.value })
      continue
    }
    const words = chordWords(trimmed)
    const segments = words.flat()
    out.push({
      type: 'words',
      words,
      hasChords: segments.some((s) => s.chord !== ''),
      hasLyrics: segments.some((s) => s.text.trim() !== ''),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Transposicion (solo en pantalla: el ChordPro guardado no cambia)
// ---------------------------------------------------------------------------

const NOTE_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
/** Nombre de cada tonalidad por clase de altura, con la ortografia usual. */
const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm']
/** Tonalidades que se escriben con bemoles (y sus relativas menores). */
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm'])
/** Lo que puede seguir a la fundamental: m, 7, maj7, sus4, add9, dim, aug, (b9)... */
const CHORD_QUALITY = /^(?:maj|min|mi|ma|m|M|dim|aug|sus|add|alt|no|omit|[0-9]|[#b+\-°ø()º,])*$/

function pitchClass(root: string): number | null {
  const m = /^([A-G])([#b]?)$/.exec(root)
  if (!m) return null
  return (NOTE_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12
}

function spell(pc: number, flats: boolean): string {
  const i = ((pc % 12) + 12) % 12
  return flats ? FLAT_NAMES[i] : SHARP_NAMES[i]
}

/** Tonalidad "E", "C#m", "Bb major"... -> { pc, minor } o null. */
function parseKey(key: string | null | undefined): { pc: number; minor: boolean } | null {
  const m = /^\s*([A-Ga-g][#b]?)\s*(m(?!aj)|min|minor)?/.exec(key ?? '')
  if (!m) return null
  const pc = pitchClass(m[1].charAt(0).toUpperCase() + m[1].slice(1))
  return pc === null ? null : { pc, minor: !!m[2] }
}

/** Tonalidad transpuesta con su nombre usual ("E" +1 -> "F", "Am" +1 -> "Bbm"). Null si no se reconoce. */
export function transposeKey(key: string | null | undefined, semitones: number): string | null {
  const k = parseKey(key)
  if (!k) return null
  const pc = (((k.pc + Math.round(semitones)) % 12) + 12) % 12
  return k.minor ? MINOR_KEYS[pc] : MAJOR_KEYS[pc]
}

/** La tonalidad se escribe con bemoles: F, Bb, Eb, Ab, Db, Gb y sus menores relativas. */
export function keyPrefersFlats(key: string | null | undefined): boolean {
  return key ? FLAT_KEYS.has(key) : false
}

/**
 * Transpone un acorde: "C#m7" +1 -> "Dm7", "C/G" +2 -> "D/A". `flats` decide la ortografia; sin
 * el se conserva la del acorde original (un bemol sigue en bemoles). Lo que no es un acorde
 * ("N.C.", "%", "x2", una palabra entre corchetes) vuelve igual.
 */
export function transposeChord(chord: string, semitones: number, flats?: boolean): string {
  const m = /^(\s*)([A-G][#b]?)(.*?)(?:\/([A-G][#b]?))?(\s*)$/.exec(chord)
  if (!m || !CHORD_QUALITY.test(m[3])) return chord
  const rootPc = pitchClass(m[2])
  if (rootPc === null) return chord
  const n = Math.round(semitones)
  let out = m[1] + spell(rootPc + n, flats ?? m[2].endsWith('b')) + m[3]
  if (m[4]) {
    const bassPc = pitchClass(m[4])
    if (bassPc === null) return chord
    out += '/' + spell(bassPc + n, flats ?? m[4].endsWith('b'))
  }
  return out + m[5]
}

/**
 * Transpone los acordes [..] de un ChordPro. `targetKey` (la tonalidad ya transpuesta) decide
 * sostenidos o bemoles; sin ella se conserva la ortografia de cada acorde. Las directivas {..} no
 * se tocan. 0 semitonos (o 12) devuelve el texto igual.
 */
export function transposeChordPro(body: string, semitones: number, targetKey?: string | null): string {
  const n = ((Math.round(semitones) % 12) + 12) % 12
  if (n === 0 || !body) return body
  const flats = targetKey ? keyPrefersFlats(targetKey) : undefined
  return body
    .split('\n')
    .map((line) => (/^\s*\{.*\}\s*$/.test(line) ? line : line.replace(/\[([^\]]*)\]/g, (_, c: string) => `[${transposeChord(c, n, flats)}]`)))
    .join('\n')
}
