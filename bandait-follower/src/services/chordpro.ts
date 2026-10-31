/**
 * ChordPro for the stage prompter. Pure module.
 *
 * A line "[Am]Hoy vuelvo a [F]casa" is split into chunks {chord, text}. The view
 * renders each chunk as a block with its chord on top, so the chord stays over its
 * syllable even when the line wraps on a narrow phone (padding with spaces, as the
 * hub preview does, breaks as soon as the line wraps).
 */

export interface ChordChunk {
  chord: string
  text: string
}

export type PrompterLine =
  | { type: 'chords'; chunks: ChordChunk[]; hasChords: boolean; hasText: boolean }
  | { type: 'comment'; text: string }

const COMMENT_DIRECTIVES = new Set(['c', 'comment', 'ci', 'comment_italic', 'cb', 'comment_box', 'highlight'])
const DIRECTIVE = /^\{\s*([A-Za-z][\w-]*)\s*(?:[:\s]\s*([\s\S]*?))?\s*\}$/

export function chordChunks(line: string): ChordChunk[] {
  const chunks: ChordChunk[] = []
  const re = /\[([^\]]*)\]/g
  let last = 0
  let chord = ''
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const text = line.slice(last, m.index)
    if (text || chord) chunks.push({ chord, text })
    chord = m[1].trim()
    last = m.index + m[0].length
  }
  const tail = line.slice(last)
  if (tail || chord) chunks.push({ chord, text: tail })
  return chunks
}

/**
 * Splits each chunk at word boundaries so a long line wraps between words, not only
 * between chords: the chord stays on the first word, the rest become chord-less chunks.
 */
export function wrapChunks(chunks: ChordChunk[]): ChordChunk[] {
  const out: ChordChunk[] = []
  for (const chunk of chunks) {
    const words = chunk.text.match(/\S*\s*/g)?.filter((w) => w !== '') ?? []
    if (words.length <= 1) {
      out.push(chunk)
      continue
    }
    words.forEach((word, i) => out.push({ chord: i === 0 ? chunk.chord : '', text: word }))
  }
  return out
}

/** Section body -> prompter lines. Blank lines and non-comment directives are dropped. */
export function parsePrompterLines(body: string): PrompterLine[] {
  const out: PrompterLine[] = []
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '') continue
    const d = trimmed.match(DIRECTIVE)
    if (d) {
      const value = d[2]?.trim()
      if (COMMENT_DIRECTIVES.has(d[1].toLowerCase()) && value) out.push({ type: 'comment', text: value })
      continue
    }
    const chunks = wrapChunks(chordChunks(line))
    out.push({
      type: 'chords',
      chunks,
      hasChords: chunks.some((c) => c.chord !== ''),
      hasText: chunks.some((c) => c.text.trim() !== ''),
    })
  }
  return out
}

/** Lyrics only (singer view): chord-only lines are dropped. */
export function lyricLines(lines: PrompterLine[]): string[] {
  const out: string[] = []
  for (const l of lines) {
    if (l.type !== 'chords' || !l.hasText) continue
    out.push(
      l.chunks
        .map((c) => c.text)
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    )
  }
  return out
}
