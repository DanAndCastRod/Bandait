import React, { useMemo } from 'react'
import { layoutChordPro } from '../services/chordpro'
import { colors, mono } from './hubStyles'

interface Props {
  chordpro: string
  /** Texto cuando la seccion no tiene contenido. */
  emptyText?: string
  /** 'chords': acordes sobre la letra (por defecto); 'lyrics': solo la letra. */
  mode?: 'chords' | 'lyrics'
  /** Tamano de letra en px (13 por defecto; el prompter de ENSAYO usa mas). */
  fontSize?: number
  testId?: string
}

/**
 * Vista previa de una seccion: acordes sobre las silabas, monoespaciado, fondo negro OLED.
 * Las lineas largas se desplazan dentro del recuadro, nunca ensanchan la pagina.
 */
export const ChordProPreview: React.FC<Props> = ({ chordpro, emptyText = 'Sección sin letra ni acordes.', mode = 'chords', fontSize = 13, testId = 'chordpro-preview' }) => {
  const all = useMemo(() => layoutChordPro(chordpro), [chordpro])
  // Solo letra: se quitan los acordes y las lineas que eran solo acordes (cuadros de compases).
  const lines = useMemo(
    () => (mode === 'lyrics' ? all.filter((l) => l.type !== 'pair' || l.lyrics.trim() !== '').map((l) => (l.type === 'pair' ? { ...l, chords: '' } : l)) : all),
    [all, mode]
  )
  const hasContent = lines.some((l) => l.type !== 'blank')

  return (
    <div
      data-testid={testId}
      data-mode={mode}
      className="touch-scroll-x"
      style={{
        background: colors.oled,
        border: `1px solid ${colors.borderSoft}`,
        borderRadius: '4px',
        padding: '10px 12px',
        fontFamily: mono,
        fontSize: `${fontSize}px`,
        lineHeight: 1.35,
        overflowX: 'auto',
        maxWidth: '100%',
        boxSizing: 'border-box',
      }}
    >
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
