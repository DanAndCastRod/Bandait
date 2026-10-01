import type React from 'react'

/** Estilos compartidos de las vistas del Hub (mismos tokens que el resto: fondo OLED, IBM Plex Mono). */
export const mono = "'IBM Plex Mono', monospace"

export const colors = {
  oled: '#000000',
  card: '#131720',
  cardAlt: '#11141c',
  modal: '#161b26',
  input: '#0d1017',
  elevated: '#1a202c',
  border: '#2a3346',
  borderSoft: '#1f2737',
  text: '#ffffff',
  muted: '#94a3b8',
  disabled: '#475569',
  orange: '#ff4500',
  cobalt: '#0066ff',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  violet: '#a855f7',
  cyan: '#38bdf8',
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
  borderRadius: '4px',
  padding: '8px 10px',
  color: colors.text,
  marginTop: '4px',
  boxSizing: 'border-box',
  minWidth: 0,
}

export const smallInputStyle: React.CSSProperties = {
  background: colors.elevated,
  border: `1px solid ${colors.border}`,
  borderRadius: '4px',
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
  borderRadius: '6px',
}

export function primaryButton(color: string = colors.orange): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    background: color,
    border: 'none',
    borderRadius: '4px',
    padding: '8px 16px',
    color: colors.text,
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
  borderRadius: '4px',
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
    borderRadius: '3px',
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
