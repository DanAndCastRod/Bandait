import { memo, useMemo } from 'react'
import { PrompterLine, lyricLines, parsePrompterLines } from '../services/chordpro'
import { SongContent, SongSection } from '../types/protocol'

/** CANTANTE: lyrics only, large. MUSICO: chords over their syllables. */
export type PrompterMode = 'singer' | 'musician'

interface Props {
  content: SongContent
  sectionIndex: number
  mode: PrompterMode
}

function sectionName(section: SongSection): string {
  return (section.label || section.kind).toUpperCase()
}

function ChordLines({ lines }: { lines: PrompterLine[] }) {
  return (
    <>
      {lines.map((line, i) =>
        line.type === 'comment' ? (
          <div key={i} className="cp-comment">
            {line.text}
          </div>
        ) : (
          <div key={i} className={`cp-line${line.hasText ? '' : ' cp-line-chords-only'}`}>
            {line.chunks.map((chunk, j) => (
              <span key={j} className="cp-chunk">
                {line.hasChords && <span className="cp-chord">{chunk.chord || ' '}</span>}
                {line.hasText && <span className="cp-text">{chunk.text || ' '}</span>}
              </span>
            ))}
          </div>
        ),
      )}
    </>
  )
}

function SectionBody({ section, mode }: { section: SongSection; mode: PrompterMode }) {
  const lines = useMemo(() => parsePrompterLines(section.chordpro), [section.chordpro])
  const lyrics = useMemo(() => lyricLines(lines), [lines])
  if (mode === 'singer') {
    if (lyrics.length === 0) {
      return <div className="prompter-waiting">{section.cueText ? section.cueText.toUpperCase() : 'INSTRUMENTAL'}</div>
    }
    return (
      <>
        {lyrics.map((text, i) => (
          <div key={i} className="cp-lyric">
            {text}
          </div>
        ))}
      </>
    )
  }
  if (lines.length === 0) {
    return <div className="prompter-waiting">{section.cueText ? section.cueText.toUpperCase() : 'SIN ACORDES'}</div>
  }
  return <ChordLines lines={lines} />
}

/** First line of the next section, as a cue. */
function preview(section: SongSection, mode: PrompterMode): string {
  const lines = parsePrompterLines(section.chordpro)
  if (mode === 'singer') return lyricLines(lines)[0] ?? section.cueText ?? ''
  const first = lines.find((l) => l.type === 'chords')
  if (!first || first.type !== 'chords') return section.cueText ?? ''
  const chords = first.chunks
    .map((c) => c.chord)
    .filter(Boolean)
    .join(' ')
  const text = lyricLines([first])[0] ?? ''
  return [chords, text].filter(Boolean).join(' // ')
}

function ChordProPrompter({ content, sectionIndex, mode }: Props) {
  const section = content.sections[sectionIndex]
  const next = content.sections[sectionIndex + 1] ?? null
  if (!section) return <div className="prompter-waiting">SIN LETRA NI ACORDES</div>

  return (
    <div className={`cp-prompter cp-mode-${mode}`}>
      <div className="cp-section-head">
        <span className="cp-section-name">{sectionName(section)}</span>
        <span className="cp-section-bars">
          C {section.startBar}-{section.startBar + section.bars - 1}
        </span>
      </div>
      <div className="cp-body" key={section.id}>
        <SectionBody section={section} mode={mode} />
      </div>
      {next && (
        <div className="cp-next">
          <span className="cp-next-label">SIGUE: {sectionName(next)}</span>
          <span className="cp-next-text">{preview(next, mode)}</span>
        </div>
      )}
    </div>
  )
}

export default memo(ChordProPrompter)
