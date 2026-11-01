import React, { useMemo } from 'react'
import { flowChordPro, layoutChordPro } from '../services/chordpro'
import { colors, mono } from './hubStyles'

interface Props {
  chordpro: string
  /** Texto cuando la seccion no tiene contenido. */
  emptyText?: string
  /** 'chords': acordes sobre la letra (por defecto); 'lyrics': solo la letra. */
  mode?: 'chords' | 'lyrics'
  /** Tamano de letra (13 px por defecto; el prompter de ENSAYO pasa un clamp() de CSS). */
  fontSize?: number | string
  /**
   * 'grid' (por defecto): renglones monoespaciados que se desplazan a lo ancho, como el editor.
   * 'flow': las lineas largas pasan al renglon siguiente entre palabras y cada acorde sigue
   * encima de su silaba (prompter de ENSAYO, de lejos y en el telefono).
   */
  layout?: 'grid' | 'flow'
  /** Sin recuadro propio (cuando el contenedor ya lo pone). */
  bare?: boolean
  testId?: string
}

/**
 * Vista previa de una seccion: acordes sobre las silabas, monoespaciado, fondo negro OLED.
 * En 'grid' las lineas largas se desplazan dentro del recuadro, nunca ensanchan la pagina.
 */
export const ChordProPreview: React.FC<Props> = ({
  chordpro,
  emptyText = 'Sección sin letra ni acordes.',
  mode = 'chords',
  fontSize = 13,
  layout = 'grid',
  bare = false,
  testId = 'chordpro-preview',
}) => {
  const all = useMemo(() => (layout === 'grid' ? layoutChordPro(chordpro) : []), [chordpro, layout])
  const flow = useMemo(() => (layout === 'flow' ? flowChordPro(chordpro) : []), [chordpro, layout])
  // Solo letra: se quitan los acordes y las lineas que eran solo acordes (cuadros de compases).
  const lines = useMemo(
    () => (mode === 'lyrics' ? all.filter((l) => l.type !== 'pair' || l.lyrics.trim() !== '').map((l) => (l.type === 'pair' ? { ...l, chords: '' } : l)) : all),
    [all, mode]
  )
  const flowLines = useMemo(() => (mode === 'lyrics' ? flow.filter((l) => l.type !== 'words' || l.hasLyrics) : flow), [flow, mode])
  const hasContent = layout === 'flow' ? flowLines.some((l) => l.type !== 'blank') : lines.some((l) => l.type !== 'blank')
  const size = typeof fontSize === 'number' ? `${fontSize}px` : fontSize

  const frame: React.CSSProperties = bare
    ? { fontFamily: mono, fontSize: size, lineHeight: 1.35, maxWidth: '100%', minWidth: 0 }
    : {
        background: colors.oled,
        border: `1px solid ${colors.borderSoft}`,
        borderRadius: '4px',
        padding: '10px 12px',
        fontFamily: mono,
        fontSize: size,
        lineHeight: 1.35,
        maxWidth: '100%',
        boxSizing: 'border-box',
      }

  if (layout === 'flow') {
    return (
      <div data-testid={testId} data-mode={mode} data-layout="flow" style={frame}>
        {!hasContent && <div style={{ color: colors.disabled, fontSize: '0.6em' }}>{emptyText}</div>}
        {hasContent &&
          flowLines.map((line, i) => {
            if (line.type === 'blank') return <div key={i} style={{ height: '0.6em' }} />
            if (line.type === 'comment') {
              return (
                <div key={i} style={{ color: colors.muted, fontStyle: 'italic', fontSize: '0.75em', margin: '0.2em 0' }}>
                  {line.text}
                </div>
              )
            }
            const showChords = mode === 'chords' && line.hasChords
            // Linea solo de acordes (compases instrumentales): acordes en fila, con aire entre ellos.
            if (!line.hasLyrics) {
              return (
                <div key={i} className="cp-flow-line" style={{ columnGap: '1.6ch', marginBottom: '0.45em' }}>
                  {line.words.flat().map((s, j) => (
                    <span key={j} data-testid="chordpro-chords" style={{ color: colors.orange, fontWeight: 700 }}>
                      {s.chord}
                    </span>
                  ))}
                </div>
              )
            }
            return (
              <div key={i} className="cp-flow-line" style={{ marginBottom: showChords ? '0.45em' : '0.2em' }}>
                {line.words.map((word, j) => (
                  <span key={j} className="cp-flow-word">
                    {word.map((s, k) => (
                      <span key={k} className="cp-flow-seg">
                        {showChords && (
                          <span data-testid={s.chord ? 'chordpro-chords' : undefined} className="cp-flow-chord" style={{ color: colors.orange }}>
                            {s.chord || ' '}
                          </span>
                        )}
                        <span style={{ color: colors.text }}>{s.text}</span>
                      </span>
                    ))}
                  </span>
                ))}
              </div>
            )
          })}
      </div>
    )
  }

  return (
    <div data-testid={testId} data-mode={mode} className="touch-scroll-x" style={{ ...frame, overflowX: 'auto' }}>
      {!hasContent && <div style={{ color: colors.disabled, fontSize: '11px' }}>{emptyText}</div>}
      {hasContent &&
        lines.map((line, i) => {
          if (line.type === 'blank') return <div key={i} style={{ height: '0.8em' }} />
          if (line.type === 'comment') {
            return (
              <div key={i} style={{ color: colors.muted, fontStyle: 'italic', whiteSpace: 'pre' }}>
                {line.text}
              </div>
            )
          }
          return (
            <div key={i} style={{ marginBottom: '2px' }}>
              {line.chords && (
                <div data-testid="chordpro-chords" style={{ color: colors.orange, fontWeight: 700, whiteSpace: 'pre' }}>
                  {line.chords}
                </div>
              )}
              {line.lyrics && <div style={{ color: colors.text, whiteSpace: 'pre' }}>{line.lyrics}</div>}
            </div>
          )
        })}
    </div>
  )
}
