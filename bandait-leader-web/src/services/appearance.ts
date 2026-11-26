/**
 * Apariencia del Hub y del Estudio (docs/REQUERIMIENTOS_WEB_3.0.md, secciones 1 y 4.5).
 *
 * Modulo puro: sin React, sin window, document ni localStorage. Se prueba con
 * `node scripts/verify-appearance-logic.ts` (parte de `npm run verify:logic`). Lo que toca el
 * DOM vive en `appearanceDom.ts`.
 *
 * Las preferencias (`uiPreferences`) son de cada musico: viajan en su workspace personal
 * (`bandait_workspaces`), nunca en una banda compartida (`bandait_bands.content`).
 *
 * Version 2 (2026-11-26): agrega el bloque `waveform` (forma de onda, `waveform.ts`). Un
 * documento v1 sin el bloque se lee con la forma de onda por defecto; un hub v1 lee un v2 con
 * los campos que conoce.
 */
import {
  WAVEFORM_KEY_COUNT,
  defaultWaveformPreferences,
  parseWaveformPreferences,
  waveformPreferencesEqual,
  waveformPreferencesWarnings,
  type WaveformPreferences,
} from './waveform.ts'

export type { WaveformPreferences }

export const UI_PREFERENCES_VERSION = 2

export type ThemeId = 'dark-grafito' | 'light-estudio'

export const THEME_IDS: readonly ThemeId[] = ['dark-grafito', 'light-estudio']

export const THEME_LABELS: Record<ThemeId, string> = {
  'dark-grafito': 'Dark Grafito',
  'light-estudio': 'Light Estudio',
}

export const THEME_HINTS: Record<ThemeId, string> = {
  'dark-grafito': 'Baja fatiga: escenario y estudio con poca luz.',
  'light-estudio': 'Alta legibilidad bajo luz de dia.',
}

export interface UiPreferences {
  version: number
  theme: ThemeId
  /** Acento elegido (#RRGGBB). null: el acento propio del tema. */
  accent: string | null
  /** Redondez de los botones en px, de RADIUS_MIN a RADIUS_MAX (pildora). */
  radius: number
  /** Forma de onda de los clips de audio (estilo, datos, escala, color, zoom vertical). */
  waveform: WaveformPreferences
}

export const RADIUS_MIN = 8
export const RADIUS_MAX = 999
/** Por defecto redondo (pedido de Daniel Castaneda, 2026-11-25): botones en pildora, campos 14 px, tarjetas 18 px. */
export const RADIUS_DEFAULT = 999
/** Paradas del deslizador: lo util esta entre 8 y 32 px; 999 es la pildora. */
export const RADIUS_STOPS: readonly number[] = [8, 10, 12, 14, 16, 20, 24, 32, 48, 999]
/** Transporte (Play, Pausa, Stop, Grabar): siempre circular, sin importar la redondez. */
export const TRANSPORT_RADIUS = '9999px'

/** Tintas posibles sobre el acento. */
export const INK_DARK = '#15181C'
export const INK_LIGHT = '#FFFFFF'
/** WCAG 2.x, texto normal, nivel AA. */
export const MIN_CONTRAST = 4.5

export const DEFAULT_THEME: ThemeId = 'dark-grafito'

/** Acentos sugeridos en APARIENCIA: todos llegan a 4,5:1 con alguna tinta sin ajuste (lo prueba verify). */
export const ACCENT_PRESETS: ReadonlyArray<{ hex: string; name: string }> = [
  { hex: '#5CC8C2', name: 'Turquesa Grafito' },
  { hex: '#7AA5D6', name: 'Cobalto' },
  { hex: '#B8CF7A', name: 'Lima' },
  { hex: '#D9A24E', name: 'Ambar' },
  { hex: '#E06C9F', name: 'Magenta' },
  { hex: '#B48EDB', name: 'Violeta' },
  { hex: '#1A7F7A', name: 'Turquesa Estudio' },
  { hex: '#2B62A8', name: 'Azul tinta' },
]

export function defaultUiPreferences(): UiPreferences {
  return { version: UI_PREFERENCES_VERSION, theme: DEFAULT_THEME, accent: null, radius: RADIUS_DEFAULT, waveform: defaultWaveformPreferences() }
}

// ---------------------------------------------------------------------------
// Tokens de cada tema. global.css define los mismos valores bajo
// `:root, [data-theme='dark-grafito']` y `[data-theme='light-estudio']`; la prueba compara
// ambos para que no deriven.
// ---------------------------------------------------------------------------

export type ThemeTokenName =
  | 'bg'
  | 'surface'
  | 'card'
  | 'modal'
  | 'input'
  | 'elevated'
  | 'hover'
  | 'border'
  | 'border-soft'
  | 'border-strong'
  | 'well'
  | 'lane'
  | 'text'
  | 'text-soft'
  | 'muted'
  | 'faint'
  | 'disabled'
  | 'accent'
  | 'on-accent'
  | 'cobalt'
  | 'success'
  | 'warning'
  | 'danger'
  | 'violet'
  | 'cyan'
  | 'danger-text'
  | 'warning-text'
  | 'success-text'
  | 'on-strong'

export const THEME_TOKENS: Record<ThemeId, Record<ThemeTokenName, string>> = {
  'dark-grafito': {
    bg: '#111316',
    surface: '#16191D',
    card: '#1A1D22',
    modal: '#1E2227',
    input: '#22262C',
    elevated: '#262A31',
    hover: '#2E333A',
    border: '#FFFFFF14',
    'border-soft': '#FFFFFF0B',
    'border-strong': '#FFFFFF26',
    well: '#0C0E10',
    lane: '#121417',
    text: '#E4E7EB',
    'text-soft': '#C3C9D1',
    muted: '#8E97A3',
    faint: '#868F9B',
    disabled: '#4A525D',
    accent: '#5CC8C2',
    'on-accent': '#15181C',
    cobalt: '#7AA5D6',
    success: '#B8CF7A',
    warning: '#D9A24E',
    danger: '#D96459',
    violet: '#B48EDB',
    cyan: '#7AC4D6',
    'danger-text': '#E8A49B',
    'warning-text': '#E3C07A',
    'success-text': '#C8DB9F',
    'on-strong': '#15181C',
  },
  'light-estudio': {
    bg: '#F2F3F5',
    surface: '#F8F9FA',
    card: '#FFFFFF',
    modal: '#FFFFFF',
    input: '#EEF0F3',
    elevated: '#E8EAEE',
    hover: '#DEE1E6',
    border: '#15181C17',
    'border-soft': '#15181C0D',
    'border-strong': '#15181C2B',
    well: '#E4E7EB',
    lane: '#EDEFF2',
    text: '#15181C',
    'text-soft': '#2C3238',
    muted: '#4F5761',
    faint: '#5F6771',
    disabled: '#9AA2AC',
    accent: '#1A7F7A',
    'on-accent': '#FFFFFF',
    cobalt: '#2B62A8',
    success: '#46691A',
    warning: '#8A5608',
    danger: '#B23B30',
    violet: '#7046A6',
    cyan: '#1A6B80',
    'danger-text': '#A3332A',
    'warning-text': '#7E4F07',
    'success-text': '#3F6016',
    'on-strong': '#FFFFFF',
  },
}

/** Color del navegador (meta theme-color) por tema. */
export const THEME_META_COLOR: Record<ThemeId, string> = {
  'dark-grafito': THEME_TOKENS['dark-grafito'].bg,
  'light-estudio': THEME_TOKENS['light-estudio'].bg,
}

// ---------------------------------------------------------------------------
// Color y contraste (WCAG 2.x)
// ---------------------------------------------------------------------------

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/** '#abc', 'abc', '#AABBCC' o 'aabbcc' -> '#AABBCC'. null si no es un color hexadecimal. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const m = HEX_RE.exec(value.trim())
  if (!m) return null
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  return `#${hex.toUpperCase()}`
}

export function hexToRgb(hex: string): [number, number, number] {
  const n = normalizeHex(hex)
  if (!n) throw new Error(`Color invalido: ${hex}`)
  return [parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16)]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase()
}

/** Luminancia relativa (WCAG 2.x): canales sRGB linealizados, 0.2126 R + 0.7152 G + 0.0722 B. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Ratio de contraste (L1 + 0.05) / (L2 + 0.05), de 1 a 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Ratio con un decimal y coma, como se muestra en la interfaz ("7,2:1"). */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10) / 10).toFixed(1).replace('.', ',')}:1`
}

export interface InkChoice {
  ink: string
  ratio: number
}

/** Tinta sobre el acento: la de mayor contraste entre INK_DARK e INK_LIGHT (empate: la oscura). */
export function pickOnAccent(accent: string): InkChoice {
  const dark = contrastRatio(accent, INK_DARK)
  const light = contrastRatio(accent, INK_LIGHT)
  return light > dark ? { ink: INK_LIGHT, ratio: light } : { ink: INK_DARK, ratio: dark }
}

/** [r, g, b] 0..255 -> [h, s, l] 0..1. */
export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0)
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  return [h / 6, s, l]
}

/** h, s, l 0..1 -> '#RRGGBB'. */
export function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) return rgbToHex(l * 255, l * 255, l * 255)
  const hue = (p: number, q: number, t: number) => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return rgbToHex(hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255)
}

export interface AccentContrast {
  /** Acento que se usa (el elegido, o el ajustado si el elegido no llegaba). */
  accent: string
  /** Tinta de contraste (--b-on-accent). */
  ink: string
  ratio: number
  /** true si hubo que mover la luminosidad del acento para llegar a MIN_CONTRAST. */
  adjusted: boolean
  /** Acento tal como lo eligio el musico. */
  requested: string
}

/**
 * Acento y tinta con contraste >= MIN_CONTRAST. Ningun color con luminancia relativa entre
 * ~0.183 y ~0.216 llega a 4,5:1 ni con #15181C ni con #FFFFFF (el mejor caso ronda 4,2:1): ese
 * acento se oscurece o se aclara (misma tonalidad y saturacion, en pasos de 0,5 % de
 * luminosidad) hasta llegar, eligiendo el cambio mas pequeno.
 */
export function ensureAccentContrast(accent: string): AccentContrast {
  const requested = normalizeHex(accent) ?? THEME_TOKENS[DEFAULT_THEME].accent
  const direct = pickOnAccent(requested)
  if (direct.ratio >= MIN_CONTRAST) return { accent: requested, ink: direct.ink, ratio: direct.ratio, adjusted: false, requested }
  const [h, s, l] = rgbToHsl(hexToRgb(requested))
  const step = 0.005
  for (let i = 1; i <= 200; i++) {
    const candidates = [l - i * step, l + i * step]
      .filter((v) => v >= 0 && v <= 1)
      .map((v) => hslToHex(h, s, v))
      .map((hex) => ({ hex, ...pickOnAccent(hex) }))
      .filter((c) => c.ratio >= MIN_CONTRAST)
      .sort((a, b) => b.ratio - a.ratio)
    if (candidates.length > 0) {
      const best = candidates[0]
      return { accent: best.hex, ink: best.ink, ratio: best.ratio, adjusted: true, requested }
    }
  }
  // Inalcanzable: el negro y el blanco siempre llegan.
  return { accent: INK_DARK, ink: INK_LIGHT, ratio: contrastRatio(INK_DARK, INK_LIGHT), adjusted: true, requested }
}

/** Acento efectivo de unas preferencias: el elegido o el del tema. */
export function effectiveAccent(prefs: Pick<UiPreferences, 'theme' | 'accent'>): AccentContrast {
  return ensureAccentContrast(prefs.accent ?? THEME_TOKENS[prefs.theme].accent)
}

// ---------------------------------------------------------------------------
// Redondez
// ---------------------------------------------------------------------------

/** Numero (o texto numerico) -> px enteros entre RADIUS_MIN y RADIUS_MAX. Lo invalido da el valor por defecto. */
export function clampRadius(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim().replace(/px$/i, '')) : NaN
  if (!Number.isFinite(n)) return RADIUS_DEFAULT
  return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(n)))
}

/** Indice de la parada del deslizador mas cercana a un radio. */
export function radiusToStop(radius: number): number {
  const r = clampRadius(radius)
  let best = 0
  for (let i = 1; i < RADIUS_STOPS.length; i++) {
    if (Math.abs(RADIUS_STOPS[i] - r) < Math.abs(RADIUS_STOPS[best] - r)) best = i
  }
  return best
}

export function stopToRadius(index: unknown): number {
  const i = typeof index === 'number' && Number.isFinite(index) ? Math.round(index) : 0
  return RADIUS_STOPS[Math.min(RADIUS_STOPS.length - 1, Math.max(0, i))]
}

// ---------------------------------------------------------------------------
// Lectura tolerante y fusion con el workspace
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

/**
 * Lectura tolerante de `uiPreferences` (de la nube, de localStorage o de un JSON importado).
 * null si no hay un objeto (campo ausente). Cada campo invalido toma su valor por defecto; una
 * version mayor (hub mas nuevo) se lee igual con los campos que este hub conoce.
 */
export function parseUiPreferences(raw: unknown): UiPreferences | null {
  if (!isPlainObject(raw)) return null
  const d = defaultUiPreferences()
  return {
    version: UI_PREFERENCES_VERSION,
    theme: isThemeId(raw.theme) ? raw.theme : d.theme,
    accent: normalizeHex(raw.accent),
    radius: raw.radius === undefined ? d.radius : clampRadius(raw.radius),
    waveform: parseWaveformPreferences(raw.waveform),
  }
}

/** Avisos (no errores) sobre un `uiPreferences` mal formado; vacio si esta bien o ausente. */
export function uiPreferencesWarnings(raw: unknown, path = 'uiPreferences'): string[] {
  if (raw === undefined) return []
  if (!isPlainObject(raw)) return [`${path}: debe ser un objeto; se usan los valores por defecto.`]
  const out: string[] = []
  if (raw.version !== undefined && (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1)) {
    out.push(`${path}.version: debe ser un entero >= 1.`)
  }
  if (raw.theme !== undefined && !isThemeId(raw.theme)) out.push(`${path}.theme: ${JSON.stringify(raw.theme)} no es un tema conocido.`)
  if (raw.accent !== undefined && raw.accent !== null && normalizeHex(raw.accent) === null) {
    out.push(`${path}.accent: debe ser un color #RRGGBB o null.`)
  }
  if (raw.radius !== undefined) {
    const ok = typeof raw.radius === 'number' && Number.isFinite(raw.radius) && raw.radius >= RADIUS_MIN && raw.radius <= RADIUS_MAX
    if (!ok) out.push(`${path}.radius: debe ir de ${RADIUS_MIN} a ${RADIUS_MAX} px.`)
  }
  out.push(...waveformPreferencesWarnings(raw.waveform, `${path}.waveform`))
  return out
}

/** Copia limpia (tipos y rangos garantizados). */
export function normalizeUiPreferences(prefs: Partial<UiPreferences> | null | undefined): UiPreferences {
  return parseUiPreferences(prefs ?? {}) ?? defaultUiPreferences()
}

export function uiPreferencesEqual(a: UiPreferences | null | undefined, b: UiPreferences | null | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.version === b.version &&
    a.theme === b.theme &&
    a.accent === b.accent &&
    a.radius === b.radius &&
    waveformPreferencesEqual(a.waveform, b.waveform)
  )
}

/** Claves de un uiPreferences limpio (y del bloque waveform): withUiPreferences no reescribe si coinciden. */
const UI_PREFERENCES_KEY_COUNT = Object.keys(defaultUiPreferences()).length

function hasCleanShape(raw: unknown): boolean {
  if (!isPlainObject(raw) || Object.keys(raw).length !== UI_PREFERENCES_KEY_COUNT) return false
  return isPlainObject(raw.waveform) && Object.keys(raw.waveform).length === WAVEFORM_KEY_COUNT
}

/** Preferencias vigentes: las del workspace si las trae, si no las de respaldo, si no las de fabrica. */
export function resolveUiPreferences(workspaceValue: unknown, fallback?: UiPreferences | null): UiPreferences {
  return parseUiPreferences(workspaceValue) ?? (fallback ? normalizeUiPreferences(fallback) : defaultUiPreferences())
}

/**
 * Workspace con estas preferencias. Devuelve EL MISMO objeto si ya las tenia (asi el motor de
 * sincronizacion no ve un cambio ni escribe). Solo toca el campo de la raiz: nunca bandas.
 */
export function withUiPreferences<T extends object>(ws: T, prefs: UiPreferences): T {
  const clean = normalizeUiPreferences(prefs)
  const current = parseUiPreferences((ws as Record<string, unknown>).uiPreferences)
  const raw = (ws as Record<string, unknown>).uiPreferences
  if (current && uiPreferencesEqual(current, clean) && hasCleanShape(raw) && (raw as Record<string, unknown>).version === clean.version) return ws
  return { ...ws, uiPreferences: clean }
}

/**
 * Al importar un JSON (que puede venir de otra persona) la apariencia sigue siendo la del musico
 * que importa: `target` toma el `uiPreferences` de `source`, o queda sin el campo si `source` no
 * lo tenia.
 */
export function carryUiPreferences<T extends object>(target: T, source: object): T {
  const prefs = parseUiPreferences((source as Record<string, unknown>).uiPreferences)
  if (prefs) return withUiPreferences(target, prefs)
  if (!('uiPreferences' in target)) return target
  const copy = { ...target } as Record<string, unknown>
  delete copy.uiPreferences
  return copy as T
}

// ---------------------------------------------------------------------------
// Variables CSS y cache local
// ---------------------------------------------------------------------------

export interface AppearanceVars {
  theme: ThemeId
  /** Variables que se escriben en <html style>: acento, tinta y redondez. */
  vars: Record<string, string>
  accent: AccentContrast
}

/** Lo que el DOM necesita para aplicar unas preferencias. */
export function appearanceVars(prefs: UiPreferences): AppearanceVars {
  const clean = normalizeUiPreferences(prefs)
  const accent = effectiveAccent(clean)
  return {
    theme: clean.theme,
    accent,
    vars: {
      '--b-accent': accent.accent,
      '--b-on-accent': accent.ink,
      '--b-radius': `${clean.radius}px`,
    },
  }
}

/** Clave de la cache del dispositivo: la lee el script de index.html antes del primer render. */
export const APPEARANCE_CACHE_KEY = 'bandait_ui_appearance'

export interface AppearanceCache {
  v: 1
  theme: ThemeId
  vars: Record<string, string>
  prefs: UiPreferences
}

export function serializeAppearanceCache(prefs: UiPreferences): string {
  const { theme, vars } = appearanceVars(prefs)
  const cache: AppearanceCache = { v: 1, theme, vars, prefs: normalizeUiPreferences(prefs) }
  return JSON.stringify(cache)
}

/** Nombres y valores que el script de index.html acepta (el mismo filtro). */
export const CACHE_VAR_NAME_RE = /^--b-[a-z-]+$/
export const CACHE_VAR_VALUE_RE = /^[#0-9a-zA-Z.%(), -]{1,40}$/

/** Lectura tolerante de la cache: null si falta o esta danada. */
export function parseAppearanceCache(raw: string | null | undefined): AppearanceCache | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const prefs = parseUiPreferences(parsed.prefs) ?? defaultUiPreferences()
  const theme = isThemeId(parsed.theme) ? parsed.theme : prefs.theme
  const vars: Record<string, string> = {}
  if (isPlainObject(parsed.vars)) {
    for (const [k, v] of Object.entries(parsed.vars)) {
      if (CACHE_VAR_NAME_RE.test(k) && typeof v === 'string' && CACHE_VAR_VALUE_RE.test(v)) vars[k] = v
    }
  }
  return { v: 1, theme, vars, prefs }
}
