/**
 * Tipografia del Hub y del Estudio (uiPreferences.font, WORKSPACE_V2.md 8). Modulo puro: sin
 * window ni document; lo prueba `scripts/verify-appearance-logic.ts`.
 *
 * Pedido de Daniel Castaneda (2026-11-27): algunos musicos encuentran la letra "muy cuadrada" y
 * quieren una tipografia mas moderna y minimalista. Dos elecciones:
 *  - `ui`: la letra de textos, titulos y botones (`--font-ui`).
 *  - `labels`: la de etiquetas, lecturas y datos (`--font-mono`): monoespaciada tecnica,
 *    monoespaciada suave, o la misma de la interfaz con cifras tabulares.
 *
 * El DOM las aplica con `data-font-ui` y `data-font-labels` en <html>; global.css asigna las
 * familias. Las que no son la de fabrica se bajan de Google Fonts al elegirlas.
 */

export const FONT_PREFERENCES_VERSION = 1

export type UiFontId = 'plex' | 'inter' | 'dm-sans' | 'jakarta' | 'manrope' | 'geist'
export type LabelFontId = 'mono' | 'geist-mono' | 'sans'

export interface FontPreferences {
  version: number
  ui: UiFontId
  labels: LabelFontId
}

export interface FontOption<T extends string> {
  id: T
  /** Nombre de la familia tal como se muestra y como la pide el CSS. */
  family: string
  /** Una palabra para elegir sin conocer la fuente. */
  label: string
  hint: string
  /** Parametro `family=` de Google Fonts (css2); null si ya la carga index.html o no hace falta. */
  googleFamily: string | null
}

export const UI_FONTS: readonly FontOption<UiFontId>[] = [
  { id: 'plex', family: 'IBM Plex Sans', label: 'Técnica', hint: 'La de siempre: precisa y algo cuadrada.', googleFamily: null },
  { id: 'inter', family: 'Inter', label: 'Neutra', hint: 'Muy legible en pantallas y tamaños pequeños.', googleFamily: 'Inter:wght@400;500;600;700' },
  { id: 'dm-sans', family: 'DM Sans', label: 'Suave', hint: 'Geométrica de curvas abiertas, amable.', googleFamily: 'DM+Sans:wght@400;500;600;700' },
  { id: 'jakarta', family: 'Plus Jakarta Sans', label: 'Moderna', hint: 'Contemporánea, con personalidad en los títulos.', googleFamily: 'Plus+Jakarta+Sans:wght@400;500;600;700' },
  { id: 'manrope', family: 'Manrope', label: 'Minimalista', hint: 'Limpia y ligera, con aire entre letras.', googleFamily: 'Manrope:wght@400;500;600;700' },
  { id: 'geist', family: 'Geist', label: 'Minimalista técnica', hint: 'Sobria, pensada para interfaces de software.', googleFamily: 'Geist:wght@400;500;600;700' },
]

export const LABEL_FONTS: readonly FontOption<LabelFontId>[] = [
  { id: 'mono', family: 'IBM Plex Mono', label: 'Monoespaciada técnica', hint: 'Etiquetas y cifras de consola, como hasta ahora.', googleFamily: null },
  { id: 'geist-mono', family: 'Geist Mono', label: 'Monoespaciada suave', hint: 'Cifras alineadas con trazo más redondo.', googleFamily: 'Geist+Mono:wght@400;500;600;700' },
  { id: 'sans', family: '', label: 'Igual que la interfaz', hint: 'Sin letra de máquina: etiquetas con la misma fuente y cifras tabulares.', googleFamily: null },
]

export const UI_FONT_IDS: readonly UiFontId[] = UI_FONTS.map((f) => f.id)
export const LABEL_FONT_IDS: readonly LabelFontId[] = LABEL_FONTS.map((f) => f.id)

/** Mismo patron que acepta el script de index.html antes del primer render. */
export const FONT_ID_RE = /^[a-z-]{1,20}$/

export const FONT_KEY_COUNT = 3

export function defaultFontPreferences(): FontPreferences {
  return { version: FONT_PREFERENCES_VERSION, ui: 'plex', labels: 'mono' }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isUiFontId(value: unknown): value is UiFontId {
  return typeof value === 'string' && (UI_FONT_IDS as readonly string[]).includes(value)
}

export function isLabelFontId(value: unknown): value is LabelFontId {
  return typeof value === 'string' && (LABEL_FONT_IDS as readonly string[]).includes(value)
}

/** Lectura tolerante: cada campo invalido toma el de fabrica; sin objeto, todo de fabrica. */
export function parseFontPreferences(raw: unknown): FontPreferences {
  const d = defaultFontPreferences()
  if (!isPlainObject(raw)) return d
  return {
    version: FONT_PREFERENCES_VERSION,
    ui: isUiFontId(raw.ui) ? raw.ui : d.ui,
    labels: isLabelFontId(raw.labels) ? raw.labels : d.labels,
  }
}

export function normalizeFontPreferences(prefs: Partial<FontPreferences> | null | undefined): FontPreferences {
  return parseFontPreferences(prefs ?? {})
}

export function fontPreferencesEqual(a: FontPreferences, b: FontPreferences): boolean {
  return a.version === b.version && a.ui === b.ui && a.labels === b.labels
}

export function fontPreferencesWarnings(raw: unknown, path = 'uiPreferences.font'): string[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [`${path}: debe ser un objeto; se usa la tipografía de fábrica.`]
  const out: string[] = []
  if (raw.ui !== undefined && !isUiFontId(raw.ui)) out.push(`${path}.ui: ${JSON.stringify(raw.ui)} no es una tipografía conocida.`)
  if (raw.labels !== undefined && !isLabelFontId(raw.labels)) out.push(`${path}.labels: ${JSON.stringify(raw.labels)} no es una opción conocida.`)
  return out
}

/** URL de Google Fonts (css2) con las familias que faltan para estas preferencias, o null. */
export function googleFontsUrl(prefs: FontPreferences): string | null {
  const families = [UI_FONTS.find((f) => f.id === prefs.ui)?.googleFamily, LABEL_FONTS.find((f) => f.id === prefs.labels)?.googleFamily].filter(
    (f): f is string => typeof f === 'string' && f.length > 0,
  )
  if (families.length === 0) return null
  return `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join('&')}&display=swap`
}

/** Pila CSS de la letra de interfaz (para vistas previas en linea). */
export function uiFontStack(id: UiFontId): string {
  const family = UI_FONTS.find((f) => f.id === id)?.family ?? 'IBM Plex Sans'
  return `'${family}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`
}

/** Pila CSS de la letra de etiquetas (para vistas previas en linea). */
export function labelFontStack(labels: LabelFontId, ui: UiFontId): string {
  if (labels === 'sans') return uiFontStack(ui)
  const family = LABEL_FONTS.find((f) => f.id === labels)?.family ?? 'IBM Plex Mono'
  return `'${family}', 'SF Mono', Menlo, Consolas, monospace`
}
