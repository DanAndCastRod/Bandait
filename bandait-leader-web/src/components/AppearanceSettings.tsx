import React, { useState } from 'react'
import { Palette, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { useHub } from '../context/hubContextCore'
import {
  ACCENT_PRESETS,
  MIN_CONTRAST,
  RADIUS_MAX,
  RADIUS_MIN,
  RADIUS_STOPS,
  THEME_HINTS,
  THEME_IDS,
  THEME_LABELS,
  THEME_TOKENS,
  clampRadius,
  defaultUiPreferences,
  effectiveAccent,
  formatRatio,
  normalizeHex,
  radiusToStop,
  stopToRadius,
  type ThemeId,
  type UiPreferences,
} from '../services/appearance'
import { cardStyle, colors, headerBarStyle, labelStyle, mono, radius, viewStyle } from './hubStyles'

const sectionTitle: React.CSSProperties = {
  margin: 0,
  fontFamily: mono,
  fontSize: '11px',
  fontWeight: 700,
  letterSpacing: '1px',
  color: colors.muted,
}

const sectionStyle: React.CSSProperties = {
  ...cardStyle,
  padding: '14px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  minWidth: 0,
}

const fieldStyle: React.CSSProperties = {
  background: colors.input,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.field,
  color: colors.text,
  fontFamily: mono,
  fontSize: '13px',
  padding: '7px 10px',
  minWidth: 0,
  boxSizing: 'border-box',
}

const ghost: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  background: colors.elevated,
  border: `1px solid ${colors.border}`,
  color: colors.text,
  borderRadius: radius.control,
  padding: '7px 12px',
  fontFamily: mono,
  fontSize: '11px',
  fontWeight: 700,
  cursor: 'pointer',
}

/** Miniatura de un tema con sus propios colores (no los vigentes). */
const ThemeSwatch: React.FC<{ theme: ThemeId }> = ({ theme }) => {
  const t = THEME_TOKENS[theme]
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '4px',
        width: '100%',
        padding: '8px',
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: radius.field,
        boxSizing: 'border-box',
      }}
    >
      <span style={{ gridColumn: '1 / -1', height: '8px', background: t.card, border: `1px solid ${t.border}`, borderRadius: 'var(--b-radius-field)' }} />
      <span style={{ height: '6px', width: '70%', background: t.text, borderRadius: 'var(--b-radius-field)' }} />
      <span style={{ height: '6px', width: '50%', justifySelf: 'end', background: t.muted, borderRadius: 'var(--b-radius-field)' }} />
      <span style={{ height: '14px', background: t.accent, borderRadius: 'var(--b-radius-card)' }} />
      <span style={{ height: '14px', background: t.elevated, border: `1px solid ${t.border}`, borderRadius: 'var(--b-radius-card)' }} />
    </span>
  )
}

/**
 * APARIENCIA: tema, acento con contraste WCAG y redondez. Es del musico (va en su workspace
 * personal), asi que cualquier rol puede cambiarla, tambien en una banda compartida de solo
 * lectura. Componente propio para poder moverlo dentro del shell sin arrastrar AJUSTES.
 */
export const AppearanceSettings: React.FC = () => {
  const { user, uiPreferences: prefs, setUiPreferences } = useHub()
  const accent = effectiveAccent(prefs)
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const [radiusDraft, setRadiusDraft] = useState<string | null>(null)

  const update = (patch: Partial<UiPreferences>) => setUiPreferences({ ...prefs, ...patch })

  const commitHex = (text: string) => {
    const hex = normalizeHex(text)
    if (hex) update({ accent: hex })
    setHexDraft(null)
  }
  const commitRadius = (text: string) => {
    update({ radius: clampRadius(text) })
    setRadiusDraft(null)
  }

  const hexValue = hexDraft ?? (prefs.accent ?? accent.requested)
  const hexInvalid = hexDraft !== null && hexDraft.trim() !== '' && normalizeHex(hexDraft) === null
  const pill = prefs.radius >= RADIUS_MAX

  return (
    <div style={viewStyle} data-testid="appearance-settings">
      <div style={headerBarStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Palette size={22} style={{ color: colors.orange, flexShrink: 0 }} />
            <h2 style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.5px' }}>Apariencia</h2>
          </div>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: colors.muted }}>
            Tema, acento y redondez del Hub y del Estudio.{' '}
            {user ? 'Es tuya: se guarda en tu cuenta y no cambia nada de la banda.' : 'Sin sesión se guarda solo en este navegador.'}
          </p>
        </div>
        <button
          type="button"
          className="stx-btn"
          data-testid="appearance-reset"
          onClick={() => {
            setHexDraft(null)
            setRadiusDraft(null)
            setUiPreferences(defaultUiPreferences())
          }}
          style={ghost}
        >
          <RotateCcw size={13} /> RESTABLECER
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '14px', alignItems: 'start' }}>
        {/* TEMA */}
        <section style={sectionStyle} aria-labelledby="appearance-theme-title">
          <h3 id="appearance-theme-title" style={sectionTitle}>
            TEMA
          </h3>
          <div role="radiogroup" aria-labelledby="appearance-theme-title" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            {THEME_IDS.map((id) => {
              const active = prefs.theme === id
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className="stx-btn b-block"
                  data-testid={`appearance-theme-${id}`}
                  onClick={() => update({ theme: id })}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: '8px',
                    padding: '10px',
                    textAlign: 'left',
                    background: active ? colors.elevated : 'transparent',
                    border: `1px solid ${active ? colors.orange : colors.border}`,
                    boxShadow: active ? `inset 0 0 0 1px ${colors.orange}` : 'none',
                    borderRadius: radius.control,
                    color: colors.text,
                    cursor: 'pointer',
                    minWidth: 0,
                  }}
                >
                  <ThemeSwatch theme={id} />
                  <span style={{ fontFamily: mono, fontSize: '12px', fontWeight: 700 }}>{THEME_LABELS[id].toUpperCase()}</span>
                  <span style={{ fontSize: '11px', color: colors.muted, lineHeight: 1.4 }}>{THEME_HINTS[id]}</span>
                </button>
              )
            })}
          </div>
        </section>

        {/* ACENTO */}
        <section style={sectionStyle} aria-labelledby="appearance-accent-title">
          <h3 id="appearance-accent-title" style={sectionTitle}>
            ACENTO
          </h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={labelStyle}>Selector</span>
              <input
                type="color"
                data-testid="appearance-accent-picker"
                aria-label="Color de acento"
                value={accent.requested.toLowerCase()}
                onChange={(e) => {
                  setHexDraft(null)
                  update({ accent: normalizeHex(e.target.value) })
                }}
                style={{ width: '52px', height: '36px', padding: '2px', background: colors.input, border: `1px solid ${colors.border}`, borderRadius: radius.field, cursor: 'pointer' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 120px', minWidth: 0 }}>
              <span style={labelStyle}>Hexadecimal</span>
              <input
                type="text"
                data-testid="appearance-accent-hex"
                aria-label="Color de acento en hexadecimal"
                aria-invalid={hexInvalid}
                spellCheck={false}
                maxLength={7}
                value={hexValue}
                onChange={(e) => {
                  const text = e.target.value
                  setHexDraft(text)
                  const hex = normalizeHex(text)
                  if (hex && text.replace('#', '').length === 6) update({ accent: hex })
                }}
                onBlur={(e) => commitHex(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value)
                }}
                style={{ ...fieldStyle, width: '100%', borderColor: hexInvalid ? colors.danger : colors.border }}
              />
            </label>
            <button
              type="button"
              className="stx-btn"
              data-testid="appearance-accent-theme"
              disabled={prefs.accent === null}
              onClick={() => {
                setHexDraft(null)
                update({ accent: null })
              }}
              style={ghost}
            >
              USAR EL DEL TEMA
            </button>
          </div>
          {hexInvalid && (
            <span role="alert" style={{ fontSize: '11px', fontFamily: mono, color: 'var(--b-danger-text)' }}>
              Escribe un color como #5CC8C2.
            </span>
          )}

          <div role="group" aria-label="Acentos sugeridos" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {ACCENT_PRESETS.map((p) => {
              const active = accent.requested === p.hex
              return (
                <button
                  key={p.hex}
                  type="button"
                  className="stx-btn"
                  aria-label={`${p.name} ${p.hex}`}
                  aria-pressed={active}
                  title={`${p.name} ${p.hex}`}
                  onClick={() => {
                    setHexDraft(null)
                    update({ accent: p.hex })
                  }}
                  style={{
                    width: '28px',
                    height: '28px',
                    padding: 0,
                    background: p.hex,
                    border: `2px solid ${active ? colors.text : colors.border}`,
                    borderRadius: radius.control,
                    cursor: 'pointer',
                  }}
                />
              )
            })}
          </div>

          <div
            data-testid="appearance-accent-preview"
            style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '10px', background: colors.oled, border: `1px solid ${colors.border}`, borderRadius: radius.field }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 14px',
                background: 'var(--b-accent)',
                color: 'var(--b-on-accent)',
                borderRadius: radius.control,
                fontFamily: mono,
                fontSize: '12px',
                fontWeight: 700,
              }}
            >
              <Play size={13} /> GUARDAR
            </span>
            <span style={{ fontFamily: mono, fontSize: '12px', fontWeight: 700, color: 'var(--b-accent)' }}>Texto de acento</span>
            <span data-testid="appearance-contrast" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
              CONTRASTE <strong style={{ color: colors.text }}>{formatRatio(accent.ratio)}</strong> con tinta{' '}
              <strong style={{ color: colors.text }}>{accent.ink}</strong> (mínimo {formatRatio(MIN_CONTRAST)})
            </span>
          </div>
          {accent.adjusted && (
            <p
              data-testid="appearance-accent-adjusted"
              role="status"
              style={{ margin: 0, fontSize: '11px', lineHeight: 1.5, fontFamily: mono, color: 'var(--b-warning-text)' }}
            >
              {accent.requested} no llega a {formatRatio(MIN_CONTRAST)} ni con tinta oscura ni con blanca: se usa {accent.accent} (mismo tono, otra
              luminosidad).
            </p>
          )}
        </section>

        {/* REDONDEZ */}
        <section style={sectionStyle} aria-labelledby="appearance-radius-title">
          <h3 id="appearance-radius-title" style={sectionTitle}>
            REDONDEZ
          </h3>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="range"
              className="stx-range"
              data-testid="appearance-radius-slider"
              aria-label="Redondez de los botones"
              aria-valuetext={pill ? 'Píldora' : `${prefs.radius} px`}
              min={0}
              max={RADIUS_STOPS.length - 1}
              step={1}
              value={radiusToStop(prefs.radius)}
              onChange={(e) => {
                setRadiusDraft(null)
                update({ radius: stopToRadius(Number(e.target.value)) })
              }}
              style={{ flex: '1 1 160px' }}
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="number"
                data-testid="appearance-radius-input"
                aria-label="Redondez en píxeles"
                min={RADIUS_MIN}
                max={RADIUS_MAX}
                step={1}
                value={radiusDraft ?? String(prefs.radius)}
                onChange={(e) => setRadiusDraft(e.target.value)}
                onBlur={(e) => commitRadius(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRadius((e.target as HTMLInputElement).value)
                }}
                style={{ ...fieldStyle, width: '84px' }}
              />
              <span style={{ fontFamily: mono, fontSize: '12px', color: colors.muted }}>px</span>
            </label>
          </div>
          <span data-testid="appearance-radius-value" style={{ fontFamily: mono, fontSize: '11px', color: colors.muted }}>
            {pill ? `${prefs.radius} px: PÍLDORA` : `${prefs.radius} px`} · de {RADIUS_MIN} a {RADIUS_MAX} px. Ningún botón baja de {RADIUS_MIN} px.
          </span>

          <div
            data-testid="appearance-radius-preview"
            style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '10px', background: colors.oled, border: `1px solid ${colors.border}`, borderRadius: radius.field }}
          >
            <span style={{ ...ghost, cursor: 'default' }}>BOTÓN</span>
            <span style={{ ...ghost, cursor: 'default', background: 'var(--b-accent)', color: 'var(--b-on-accent)', borderColor: 'var(--b-accent)' }}>PRINCIPAL</span>
            <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', marginLeft: 'auto' }}>
              {[Play, Pause, Square].map((Icon, i) => (
                <span
                  key={i}
                  aria-hidden="true"
                  className="b-transport"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '32px',
                    height: '32px',
                    background: i === 0 ? 'var(--b-accent)' : colors.elevated,
                    color: i === 0 ? 'var(--b-on-accent)' : colors.text,
                    border: `1px solid ${i === 0 ? 'var(--b-accent)' : colors.border}`,
                    borderRadius: radius.transport,
                  }}
                >
                  <Icon size={13} />
                </span>
              ))}
              <span style={{ fontFamily: mono, fontSize: '10px', color: colors.muted, maxWidth: '110px', lineHeight: 1.3 }}>
                Transporte siempre circular
              </span>
            </span>
          </div>
        </section>
      </div>
    </div>
  )
}
