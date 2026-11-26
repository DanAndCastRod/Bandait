import type React from 'react'
import { APPEARANCE_EVENT } from '../services/appearanceDom'

/**
 * Estilos compartidos de las vistas del Hub. Los colores son variables CSS (--b-*, global.css)
 * para que sigan el tema del musico (Dark Grafito / Light Estudio) y su acento; los valores de
 * cada tema viven en THEME_TOKENS (services/appearance.ts).
 *
 * Un `var(...)` no sirve en un <canvas>: para dibujar usa `canvasPalette()` (colores del tema
 * vigente, cacheados) o, en el Estudio, `useStudioCanvasPalette()`.
 */
export const mono = "'IBM Plex Mono', monospace"

export const colors = {
  oled: 'var(--b-bg)',
  card: 'var(--b-card)',
  cardAlt: 'var(--b-surface)',
  modal: 'var(--b-modal)',
  input: 'var(--b-input)',
  elevated: 'var(--b-elevated)',
  border: 'var(--b-border)',
  borderSoft: 'var(--b-border-soft)',
  text: 'var(--b-text)',
  muted: 'var(--b-muted)',
  disabled: 'var(--b-disabled)',
  /** Acento del musico (el nombre es historico: hoy es el turquesa Grafito o el que el elija). */
  orange: 'var(--b-accent)',
  cobalt: 'var(--b-cobalt)',
  success: 'var(--b-success)',
  warning: 'var(--b-warning)',
  danger: 'var(--b-danger)',
  violet: 'var(--b-violet)',
  cyan: 'var(--b-cyan)',
  /** Texto sobre un fondo de color semantico (cobalto, exito, aviso, peligro, violeta, cian). */
  onAccent: 'var(--b-on-strong)',
  /** Texto sobre el acento del musico: tinta calculada con contraste WCAG >= 4,5:1. */
  onBrand: 'var(--b-on-accent)',
}

/** Paleta Grafito en hexadecimal, solo para dibujar en <canvas> (no admite variables CSS). */
export const hexColors = {
  oled: '#111316',
  card: '#1A1D22',
  elevated: '#262A31',
  border: '#FFFFFF14',
  text: '#E4E7EB',
  muted: '#8E97A3',
  disabled: '#4A525D',
  orange: '#5CC8C2',
  cobalt: '#7AA5D6',
  success: '#B8CF7A',
  warning: '#D9A24E',
  danger: '#D96459',
}

export type CanvasPalette = Record<keyof typeof hexColors, string>

let paletteCache: CanvasPalette | null = null
let paletteListening = false

/**
 * Colores del tema vigente resueltos a valores concretos, para dibujar en <canvas>. Sin DOM
 * (o si una variable falta) devuelve la paleta Grafito fija. Se cachea: los estilos computados
 * se leen una vez y otra solo cuando applyAppearance() avisa un cambio (APPEARANCE_EVENT), asi
 * que se puede llamar en cada cuadro. Los lienzos del Estudio tienen su paleta con mas roles en
 * services/studioCanvasPalette.ts.
 */
export function canvasPalette(): CanvasPalette {
  if (paletteCache) return paletteCache
  const out = { ...hexColors }
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return out
  if (!paletteListening && typeof window !== 'undefined') {
    window.addEventListener(APPEARANCE_EVENT, () => {
      paletteCache = null
    })
    paletteListening = true
  }
  const style = getComputedStyle(document.documentElement)
  for (const key of Object.keys(hexColors) as Array<keyof typeof hexColors>) {
    const name = /^var\((--[a-z-]+)\)$/.exec(colors[key])?.[1]
    const value = name ? style.getPropertyValue(name).trim() : ''
    if (value) out[key] = value
  }
  paletteCache = out
  return out
}

/** Redondez: botones con la del musico (>= 8px), campos y tarjetas topados (global.css). */
export const radius = {
  control: 'var(--b-radius-control)',
  field: 'var(--b-radius-field)',
  card: 'var(--b-radius-card)',
  transport: 'var(--b-radius-transport)',
}

export const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  color: colors.muted,
  fontFamily: mono,
  display: 'block',
}

export const inputStyle: React.CSSProperties = {
  width: '100%',
  background: colors.input,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.field,
  padding: '8px 10px',
  color: colors.text,
  marginTop: '4px',
  boxSizing: 'border-box',
  minWidth: 0,
}

export const smallInputStyle: React.CSSProperties = {
  background: colors.elevated,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.field,
  padding: '4px 6px',
  color: colors.text,
  fontFamily: mono,
  fontSize: '12px',
  boxSizing: 'border-box',
  minWidth: 0,
}

export const cardStyle: React.CSSProperties = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.card,
}

export function primaryButton(color: string = colors.orange): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    background: color,
    border: 'none',
    borderRadius: radius.control,
    padding: '8px 16px',
    color: color === colors.orange ? colors.onBrand : colors.onAccent,
    fontSize: '12px',
    fontFamily: mono,
    fontWeight: 700,
    cursor: 'pointer',
  }
}

export const ghostButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  background: colors.elevated,
  border: `1px solid ${colors.border}`,
  borderRadius: radius.control,
  padding: '8px 14px',
  color: colors.text,
  fontSize: '12px',
  fontFamily: mono,
  cursor: 'pointer',
}

export function iconButton(color: string = colors.text, disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: colors.elevated,
    border: `1px solid ${colors.border}`,
    color: disabled ? colors.disabled : color,
    borderRadius: radius.control,
    padding: '5px 7px',
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

export const headerBarStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '16px',
  borderBottom: `1px solid ${colors.border}`,
  paddingBottom: '16px',
}

export const viewStyle: React.CSSProperties = {
  padding: 'clamp(12px, 3vw, 24px)',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
}

/** Texto comparable para busquedas: sin tildes ni mayusculas. */
export function searchKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}
