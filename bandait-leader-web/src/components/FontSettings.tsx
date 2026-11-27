import React, { useEffect } from 'react'
import {
  LABEL_FONTS,
  UI_FONTS,
  labelFontStack,
  uiFontStack,
  type FontPreferences,
  type LabelFontId,
  type UiFontId,
} from '../services/fonts'
import { colors, mono, radius } from './hubStyles'

const PREVIEW_LINK_ATTR = 'data-bandait-font-preview'

/**
 * Baja una sola vez todas las familias de la lista para las vistas previas (solo al abrir
 * APARIENCIA, no en el arranque del Hub).
 */
function usePreviewFonts(): void {
  useEffect(() => {
    if (typeof document === 'undefined' || !document.head) return
    if (document.head.querySelector(`link[${PREVIEW_LINK_ATTR}]`)) return
    const families = [...UI_FONTS, ...LABEL_FONTS].map((f) => f.googleFamily).filter((f): f is string => !!f)
    if (families.length === 0) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap`
    link.setAttribute(PREVIEW_LINK_ATTR, '1')
    document.head.appendChild(link)
  }, [])
}

function optionStyle(active: boolean): React.CSSProperties {
  return {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '4px',
    padding: '10px 12px',
    minHeight: '44px',
    textAlign: 'left',
    background: active ? colors.elevated : 'transparent',
    border: `1px solid ${active ? colors.orange : colors.border}`,
    boxShadow: active ? `inset 0 0 0 1px ${colors.orange}` : 'none',
    borderRadius: radius.control,
    color: colors.text,
    cursor: 'pointer',
    minWidth: 0,
  }
}

interface Props {
  value: FontPreferences
  onChange: (next: FontPreferences) => void
}

/**
 * TIPOGRAFIA en APARIENCIA: letra de la interfaz y letra de etiquetas y cifras. Cada opcion se
 * muestra escrita con su propia fuente para elegir viendo, no por nombre.
 */
export const FontSettings: React.FC<Props> = ({ value, onChange }) => {
  usePreviewFonts()
  const setUi = (ui: UiFontId) => onChange({ ...value, ui })
  const setLabels = (labels: LabelFontId) => onChange({ ...value, labels })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }} data-testid="appearance-font">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span id="appearance-font-ui-title" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
          Interfaz: textos, títulos y botones
        </span>
        <div role="radiogroup" aria-labelledby="appearance-font-ui-title" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px' }}>
          {UI_FONTS.map((font) => {
            const active = value.ui === font.id
            return (
              <button
                key={font.id}
                type="button"
                role="radio"
                aria-checked={active}
                className="stx-btn b-block"
                data-testid={`appearance-font-ui-${font.id}`}
                title={font.hint}
                onClick={() => setUi(font.id)}
                style={optionStyle(active)}
              >
                <span style={{ fontFamily: uiFontStack(font.id), fontSize: '17px', fontWeight: 600, letterSpacing: '-0.01em' }}>Luz de madrugada</span>
                <span style={{ fontFamily: uiFontStack(font.id), fontSize: '12px', color: colors.muted }}>
                  {font.family} · {font.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <span id="appearance-font-labels-title" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
          Etiquetas, lecturas y cifras
        </span>
        <div role="radiogroup" aria-labelledby="appearance-font-labels-title" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 220px), 1fr))', gap: '8px' }}>
          {LABEL_FONTS.map((font) => {
            const active = value.labels === font.id
            const stack = labelFontStack(font.id, value.ui)
            return (
              <button
                key={font.id}
                type="button"
                role="radio"
                aria-checked={active}
                className="stx-btn b-block"
                data-testid={`appearance-font-labels-${font.id}`}
                title={font.hint}
                onClick={() => setLabels(font.id)}
                style={optionStyle(active)}
              >
                <span style={{ fontFamily: stack, fontSize: '13px', fontWeight: 700, letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  92 BPM · 001.3 · -6 dB
                </span>
                <span style={{ fontFamily: uiFontStack(value.ui), fontSize: '12px', color: colors.muted }}>{font.label}</span>
              </button>
            )
          })}
        </div>
      </div>
      <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.5, color: colors.muted }}>
        Se aplica a todo el Hub y al Estudio. Las fuentes nuevas se descargan la primera vez que las eliges; sin conexión se usa la del sistema.
      </p>
    </div>
  )
}
