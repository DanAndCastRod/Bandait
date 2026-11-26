/**
 * Paleta de los lienzos del Estudio (linea de tiempo, piano roll, medidores, curva de EQ).
 *
 * Un <canvas> no entiende `var(--b-*)`: los colores se resuelven aqui, por tema y acento, a
 * valores concretos. Modulo puro (sin DOM): lo prueba `scripts/verify-appearance-logic.ts`. Lo
 * que lee el tema vigente del documento y avisa cuando cambia vive en `studioCanvasPaletteDom.ts`.
 *
 * Los neutros de cada tema son declarados (Dark Grafito conserva el aspecto de siempre del
 * Estudio); los derivados del acento y de los colores semanticos se calculan con alfa. Los
 * colores por rol de pista son datos: no cambian de tono, pero en Light Estudio se oscurecen
 * (misma tonalidad y saturacion) hasta leerse sobre el carril (`studioTrackColor`).
 */
import {
  DEFAULT_THEME,
  INK_DARK,
  INK_LIGHT,
  THEME_IDS,
  THEME_TOKENS,
  contrastRatio,
  hexToRgb,
  hslToHex,
  normalizeHex,
  pickOnAccent,
  relativeLuminance,
  rgbToHsl,
  type ThemeId,
} from './appearance.ts'

/** Roles de color de los lienzos. Cada tema define todos (lo comprueba verify). */
export const STUDIO_CANVAS_ROLES = [
  // Superficies de la linea de tiempo
  'bg',
  'lane',
  'laneAlt',
  'takeLane',
  'rowLine',
  'gridStrong',
  'gridSoft',
  'gridFaint',
  // Regla
  'ruler',
  'rulerText',
  'rulerTextActive',
  'rulerHint',
  'rulerTick',
  'section',
  'sectionActive',
  // Clips y textos sobre el carril
  'text',
  'labelBg',
  'fadeShade',
  'hint',
  // Acento: repeticion, curva de EQ
  'accent',
  'loopFill',
  'loopEdge',
  'loopRuler',
  // Seleccion, pista elegida, grabacion, marcas
  'selection',
  'selectionFill',
  'selectedTrackTint',
  'danger',
  'armedTint',
  'recFill',
  'missingHatch',
  'marker',
  'markerLine',
  // Piano roll
  'rowWhite',
  'rowBlack',
  'rowHover',
  'keybed',
  'keyWhite',
  'keyBlack',
  'keyLabel',
  'keyLabelFaint',
  'outsideClip',
  'afterLoop',
  'velocityBg',
  'velocityGuide',
  // Medidores
  'meterOk',
  'meterOkDim',
  'meterOkLedDim',
  'meterHot',
  'meterHotDim',
  'meterOver',
  'meterOverDim',
  'meterOff',
  'meterHold',
  'meterTick',
  // Curva de EQ
  'eqGrid',
  'eqAxis',
  'eqCurveFill',
  'eqBypass',
  'eqLabel',
] as const

export type StudioCanvasRole = (typeof STUDIO_CANVAS_ROLES)[number]

export type StudioCanvasPalette = Readonly<Record<StudioCanvasRole, string>> & {
  readonly theme: ThemeId
}

/** Contraste minimo de un color de pista (forma de onda, notas) sobre el carril: WCAG 1.4.11, 3:1. */
export const TRACK_MIN_CONTRAST = 3
/** Texto de la regla y del teclado sobre su fondo: WCAG AA texto normal. */
export const RULER_TEXT_MIN_CONTRAST = 4.5
/** Pistas de texto (sugerencias en la regla): grandes y secundarias, 3:1. */
export const HINT_MIN_CONTRAST = 3
/** Lineas de la rejilla (compas y tiempo) sobre cualquier fondo de fila. */
export const GRID_MIN_CONTRAST = 1.3

type NeutralRole =
  | 'bg'
  | 'lane'
  | 'laneAlt'
  | 'takeLane'
  | 'rowLine'
  | 'gridStrong'
  | 'gridSoft'
  | 'gridFaint'
  | 'ruler'
  | 'rulerText'
  | 'rulerTextActive'
  | 'rulerHint'
  | 'rulerTick'
  | 'section'
  | 'text'
  | 'rowWhite'
  | 'rowBlack'
  | 'keybed'
  | 'keyWhite'
  | 'keyBlack'
  | 'keyLabel'
  | 'keyLabelFaint'
  | 'velocityBg'
  | 'velocityGuide'
  | 'meterOk'
  | 'meterOkDim'
  | 'meterOff'
  | 'meterTick'
  | 'eqGrid'
  | 'eqAxis'

/** Neutros declarados de cada tema (hexadecimal #RRGGBB). */
export const STUDIO_CANVAS_NEUTRALS: Record<ThemeId, Record<NeutralRole, string>> = {
  'dark-grafito': {
    bg: '#0F1114',
    lane: '#14171B',
    laneAlt: '#12151A',
    takeLane: '#0D0F12',
    rowLine: '#2E343D',
    gridStrong: '#373E48',
    gridSoft: '#2B3038',
    gridFaint: '#1F2329',
    ruler: '#1A1E23',
    rulerText: '#8E97A3',
    rulerTextActive: '#D5DAE0',
    rulerHint: '#6E7783',
    rulerTick: '#4A525D',
    section: '#232830',
    text: '#D5DAE0',
    rowWhite: '#16191E',
    rowBlack: '#111317',
    keybed: '#1A1E23',
    keyWhite: '#262B33',
    keyBlack: '#101215',
    keyLabel: '#8E97A3',
    keyLabelFaint: '#4A525D',
    velocityBg: '#121418',
    velocityGuide: '#1D2127',
    meterOk: '#5CC8C2',
    meterOkDim: '#3C6E6B',
    meterOff: '#1D2127',
    meterTick: '#4A525D',
    eqGrid: '#232830',
    eqAxis: '#2E343D',
  },
  'light-estudio': {
    bg: '#E4E7EB',
    lane: '#F7F8F9',
    laneAlt: '#EFF1F3',
    takeLane: '#E8EBEE',
    rowLine: '#C3C8CF',
    gridStrong: '#AEB5BE',
    gridSoft: '#C6CBD2',
    gridFaint: '#DDE1E5',
    ruler: '#E3E6EA',
    rulerText: '#4F5761',
    rulerTextActive: '#15181C',
    rulerHint: '#5F6771',
    rulerTick: '#9AA2AC',
    section: '#D2D6DC',
    text: '#15181C',
    rowWhite: '#F7F8F9',
    rowBlack: '#ECEEF1',
    keybed: '#D9DCE1',
    keyWhite: '#FFFFFF',
    keyBlack: '#3A4048',
    keyLabel: '#4F5761',
    keyLabelFaint: '#9AA2AC',
    velocityBg: '#EEF0F3',
    velocityGuide: '#D2D6DC',
    meterOk: '#1A7F7A',
    meterOkDim: '#8FC7C3',
    meterOff: '#D2D6DC',
    meterTick: '#9AA2AC',
    eqGrid: '#D2D6DC',
    eqAxis: '#AEB5BE',
  },
}

/** Opacidades de los derivados con alfa: en claro, algo mas de cuerpo para que se vean. */
const ALPHA: Record<ThemeId, Record<string, number>> = {
  'dark-grafito': {
    labelBg: 0.72,
    fadeShade: 0.6,
    hint: 0.45,
    loopFill: 0.07,
    loopEdge: 0.55,
    loopRuler: 0.22,
    sectionActive: 0.3,
    selectionFill: 0.12,
    selectedTrackTint: 0.05,
    armedTint: 0.06,
    recFill: 0.28,
    missingHatch: 0.5,
    markerLine: 0.35,
    rowHover: 0.035,
    outsideClip: 0.55,
    afterLoop: 0.5,
    meterOkLedDim: 0.32,
    meterHotDim: 0.36,
    meterOverDim: 0.42,
    eqCurveFill: 0.14,
  },
  'light-estudio': {
    labelBg: 0.82,
    fadeShade: 0.62,
    hint: 0.72,
    loopFill: 0.1,
    loopEdge: 0.7,
    loopRuler: 0.26,
    sectionActive: 0.3,
    selectionFill: 0.12,
    selectedTrackTint: 0.07,
    armedTint: 0.07,
    recFill: 0.2,
    missingHatch: 0.55,
    markerLine: 0.45,
    rowHover: 0.045,
    outsideClip: 0.1,
    afterLoop: 0.06,
    meterOkLedDim: 0.3,
    meterHotDim: 0.3,
    meterOverDim: 0.32,
    eqCurveFill: 0.16,
  },
}

/** '#RRGGBB' + alfa -> 'rgba(r, g, b, a)'. */
export function rgbaOf(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 1000) / 1000})`
}

const readableCache = new Map<string, string>()

/**
 * El color, con la misma tonalidad y saturacion, movido en luminosidad (alejandose del fondo)
 * hasta llegar a `min` de contraste sobre `bg`. Si ya llega, el mismo color normalizado.
 */
export function readableOn(color: string, bg: string, min: number): string {
  const key = `${color}|${bg}|${min}`
  const cached = readableCache.get(key)
  if (cached) return cached
  const hex = normalizeHex(color) ?? INK_DARK
  let out = hex
  if (contrastRatio(hex, bg) < min) {
    const darken = relativeLuminance(bg) > 0.18
    const [h, s, l] = rgbToHsl(hexToRgb(hex))
    out = darken ? INK_DARK : INK_LIGHT
    for (let i = 1; i <= 100; i++) {
      const next = darken ? l - i * 0.01 : l + i * 0.01
      if (next < 0 || next > 1) break
      const candidate = hslToHex(h, s, next)
      if (contrastRatio(candidate, bg) >= min) {
        out = candidate
        break
      }
    }
  }
  readableCache.set(key, out)
  return out
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

const paletteCache = new Map<string, StudioCanvasPalette>()

/**
 * Paleta de los lienzos para un tema y un acento (#RRGGBB; null o invalido: el del tema). La
 * misma combinacion devuelve el mismo objeto: quien la guarda puede comparar por identidad.
 */
export function buildStudioCanvasPalette(theme: ThemeId | string | null | undefined, accent?: string | null): StudioCanvasPalette {
  const id: ThemeId = isThemeId(theme) ? theme : DEFAULT_THEME
  const tokens = THEME_TOKENS[id]
  const base = normalizeHex(accent) ?? tokens.accent
  const key = `${id}|${base}`
  const cached = paletteCache.get(key)
  if (cached) return cached
  const n = STUDIO_CANVAS_NEUTRALS[id]
  const a = ALPHA[id]
  // El acento del musico puede ser claro u oscuro: para lineas se asegura 3:1 sobre el carril.
  const accentLine = readableOn(readableOn(base, n.lane, TRACK_MIN_CONTRAST), n.laneAlt, TRACK_MIN_CONTRAST)
  const ink = INK_DARK
  const palette: StudioCanvasPalette = {
    theme: id,
    ...n,
    sectionActive: rgbaOf(accentLine, a.sectionActive),
    labelBg: rgbaOf(id === 'light-estudio' ? INK_LIGHT : '#0F1114', a.labelBg),
    fadeShade: rgbaOf(id === 'light-estudio' ? n.bg : '#0F1114', a.fadeShade),
    hint: rgbaOf(tokens.muted, a.hint),
    accent: accentLine,
    loopFill: rgbaOf(accentLine, a.loopFill),
    loopEdge: rgbaOf(accentLine, a.loopEdge),
    loopRuler: rgbaOf(accentLine, a.loopRuler),
    selection: tokens.cobalt,
    selectionFill: rgbaOf(tokens.cobalt, a.selectionFill),
    selectedTrackTint: rgbaOf(tokens.cobalt, a.selectedTrackTint),
    danger: tokens.danger,
    armedTint: rgbaOf(tokens.danger, a.armedTint),
    recFill: rgbaOf(tokens.danger, a.recFill),
    missingHatch: rgbaOf(tokens.danger, a.missingHatch),
    marker: tokens.warning,
    markerLine: rgbaOf(tokens.warning, a.markerLine),
    rowHover: rgbaOf(id === 'light-estudio' ? ink : '#D5DAE0', a.rowHover),
    outsideClip: rgbaOf(id === 'light-estudio' ? ink : '#000000', a.outsideClip),
    afterLoop: rgbaOf(id === 'light-estudio' ? ink : '#0F1114', a.afterLoop),
    meterOkLedDim: rgbaOf(n.meterOk, a.meterOkLedDim),
    meterHot: tokens.warning,
    meterHotDim: rgbaOf(tokens.warning, a.meterHotDim),
    meterOver: tokens.danger,
    meterOverDim: rgbaOf(tokens.danger, a.meterOverDim),
    meterHold: n.text,
    eqCurveFill: rgbaOf(accentLine, a.eqCurveFill),
    eqBypass: tokens.disabled,
    eqLabel: tokens.muted,
  }
  paletteCache.set(key, palette)
  return palette
}

/**
 * Color de una pista (por rol o posicion) legible sobre el carril del tema: en Dark Grafito los
 * de siempre; en Light Estudio, la misma tonalidad mas oscura.
 */
export function studioTrackColor(palette: StudioCanvasPalette, color: string): string {
  // Las filas alternan dos fondos: el color tiene que leerse sobre los dos.
  return readableOn(readableOn(color, palette.lane, TRACK_MIN_CONTRAST), palette.laneAlt, TRACK_MIN_CONTRAST)
}

/** Tinta para un texto sobre un color pleno (nombre de nota sobre la nota). */
export function inkOn(color: string): string {
  return pickOnAccent(normalizeHex(color) ?? INK_DARK).ink
}
