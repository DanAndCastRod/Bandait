/**
 * Verificacion de la apariencia (docs/REQUERIMIENTOS_WEB_3.0.md, secciones 1 y 4.5), sin
 * framework de pruebas:
 *   node --experimental-strip-types scripts/verify-appearance-logic.ts   (parte de npm run verify:logic)
 *
 * Cubre: contraste WCAG y eleccion de tinta, ajuste del acento cuando ninguna tinta llega a
 * 4,5:1, tokens de los dos temas (contraste y que global.css no derive), acotado de la
 * redondez, auditoria de radios de botones y transporte en los CSS, lectura tolerante de
 * `uiPreferences`, fusion con el workspace (nunca entra en una banda compartida) y la cache
 * que lee index.html antes del primer render.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fixtureJson from '../../bandait-protocol/fixtures/workspace_v2.json' with { type: 'json' }
import {
  ACCENT_PRESETS,
  APPEARANCE_CACHE_KEY,
  CACHE_VAR_NAME_RE,
  CACHE_VAR_VALUE_RE,
  INK_DARK,
  INK_LIGHT,
  MIN_CONTRAST,
  RADIUS_DEFAULT,
  RADIUS_MAX,
  RADIUS_MIN,
  RADIUS_STOPS,
  THEME_IDS,
  THEME_TOKENS,
  appearanceVars,
  carryUiPreferences,
  clampRadius,
  contrastRatio,
  defaultUiPreferences,
  effectiveAccent,
  ensureAccentContrast,
  formatRatio,
  normalizeHex,
  parseAppearanceCache,
  parseUiPreferences,
  hexToRgb,
  pickOnAccent,
  radiusToStop,
  relativeLuminance,
  rgbToHsl,
  resolveUiPreferences,
  serializeAppearanceCache,
  stopToRadius,
  uiPreferencesEqual,
  uiPreferencesWarnings,
  withUiPreferences,
  type ThemeId,
  type UiPreferences,
} from '../src/services/appearance.ts'
import {
  GRID_MIN_CONTRAST,
  HINT_MIN_CONTRAST,
  RULER_TEXT_MIN_CONTRAST,
  STUDIO_CANVAS_NEUTRALS,
  STUDIO_CANVAS_ROLES,
  TRACK_MIN_CONTRAST,
  buildStudioCanvasPalette,
  readableOn,
  studioTrackColor,
} from '../src/services/studioCanvasPalette.ts'
import { loadWorkspaceDocument, migrateWorkspace, parseImportedWorkspace, validateWorkspace } from '../src/services/workspaceSchema.ts'
import { defaultWaveformPreferences } from '../src/services/waveform.ts'
import { mergeWorkspace, personalPart, sliceBand, type SharedBand } from '../src/services/sharedBands.ts'
import { stableStringify } from '../src/services/workspaceSync.ts'
import type { WorkspaceStore } from '../src/types/hub.ts'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`)
  }
}

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const globalCss = read('../src/styles/global.css')
const studioCss = read('../src/styles/studio.css')
const indexHtml = read('../index.html')
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const fixture = () => clone(fixtureJson) as unknown as WorkspaceStore

const prefs = (p: Partial<UiPreferences>): UiPreferences => ({ ...defaultUiPreferences(), ...p })

console.log('Contraste WCAG y tinta del acento')

check('normalizeHex acepta #abc, abc, #AABBCC y aabbcc; rechaza lo demas', () => {
  assert.equal(normalizeHex('#abc'), '#AABBCC')
  assert.equal(normalizeHex('abc'), '#AABBCC')
  assert.equal(normalizeHex(' #5cc8c2 '), '#5CC8C2')
  assert.equal(normalizeHex('5CC8C2'), '#5CC8C2')
  for (const bad of ['', '#12', '#12345', '#1234567', 'red', '#GGGGGG', null, 12, undefined, '#5CC8C2;}']) assert.equal(normalizeHex(bad), null, String(bad))
})

check('luminancia relativa y ratio: blanco/negro 21:1, gris #777777 sobre blanco ~4,48:1', () => {
  assert.equal(relativeLuminance('#FFFFFF'), 1)
  assert.equal(relativeLuminance('#000000'), 0)
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF') * 100) / 100, 21)
  assert.equal(contrastRatio('#FFFFFF', '#000000'), contrastRatio('#000000', '#FFFFFF'), 'simetrico')
  assert.ok(Math.abs(contrastRatio('#777777', '#FFFFFF') - 4.48) < 0.01)
  assert.equal(formatRatio(4.4999), '4,4:1', 'redondea hacia abajo: nunca muestra 4,5 si no llega')
  assert.equal(formatRatio(21), '21,0:1')
})

check('pickOnAccent elige la tinta de mayor contraste entre #15181C y #FFFFFF', () => {
  assert.equal(pickOnAccent('#5CC8C2').ink, INK_DARK)
  assert.equal(pickOnAccent('#1A7F7A').ink, INK_LIGHT)
  assert.equal(pickOnAccent('#FFFF00').ink, INK_DARK)
  assert.equal(pickOnAccent('#000080').ink, INK_LIGHT)
  const c = pickOnAccent('#D96459')
  assert.equal(c.ratio, Math.max(contrastRatio('#D96459', INK_DARK), contrastRatio('#D96459', INK_LIGHT)))
})

check('ensureAccentContrast: 4096 colores, todos terminan con tinta >= 4,5:1; sin ajuste si ya llegaban', () => {
  let adjusted = 0
  for (let r = 0; r < 16; r++)
    for (let g = 0; g < 16; g++)
      for (let b = 0; b < 16; b++) {
        const hex = `#${[r, g, b].map((v) => (v * 17).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
        const res = ensureAccentContrast(hex)
        assert.ok(res.ratio >= MIN_CONTRAST, `${hex} -> ${res.accent} ${res.ratio}`)
        assert.ok(res.ink === INK_DARK || res.ink === INK_LIGHT)
        assert.equal(Math.abs(contrastRatio(res.accent, res.ink) - res.ratio) < 1e-9, true)
        if (pickOnAccent(hex).ratio >= MIN_CONTRAST) assert.equal(res.adjusted || res.accent !== hex, false, `${hex} no debia ajustarse`)
        else {
          assert.equal(res.adjusted, true, `${hex} debia ajustarse`)
          adjusted++
        }
      }
  assert.ok(adjusted > 0, 'hay colores de media luminancia que ninguna tinta salva')
})

check('un gris medio (#787878, luminancia ~0,188) no llega con ninguna tinta: se ajusta poco y se avisa', () => {
  assert.ok(contrastRatio('#787878', INK_DARK) < MIN_CONTRAST && contrastRatio('#787878', INK_LIGHT) < MIN_CONTRAST)
  const res = ensureAccentContrast('#787878')
  assert.equal(res.adjusted, true)
  assert.equal(res.requested, '#787878')
  assert.notEqual(res.accent, '#787878')
  assert.ok(res.ratio >= MIN_CONTRAST)
  const delta = Math.abs(relativeLuminance(res.accent) - relativeLuminance('#787878'))
  assert.ok(delta < 0.03, `ajuste pequeno (delta de luminancia ${delta})`)
})

check('los acentos sugeridos llegan a 4,5:1 sin ajuste', () => {
  for (const p of ACCENT_PRESETS) assert.equal(ensureAccentContrast(p.hex).adjusted, false, p.name)
})

console.log('Temas Dark Grafito y Light Estudio')

check('acento por defecto de cada tema: su tinta es la calculada y llega a 4,5:1', () => {
  for (const id of THEME_IDS) {
    const t = THEME_TOKENS[id]
    assert.equal(pickOnAccent(t.accent).ink, t['on-accent'], id)
    assert.ok(pickOnAccent(t.accent).ratio >= MIN_CONTRAST, id)
    const v = appearanceVars(prefs({ theme: id }))
    assert.equal(v.vars['--b-accent'], t.accent)
    assert.equal(v.vars['--b-on-accent'], t['on-accent'])
  }
})

check('contraste de los tokens: texto, atenuado, semanticos y tinta sobre semanticos >= 4,5:1 en ambos temas', () => {
  for (const id of THEME_IDS) {
    const t = THEME_TOKENS[id]
    const grounds = [t.bg, t.surface, t.card, t.modal, t.input]
    for (const ground of grounds) {
      for (const fg of ['text', 'text-soft', 'muted', 'faint', 'danger-text', 'warning-text', 'success-text'] as const) {
        assert.ok(contrastRatio(t[fg], ground) >= MIN_CONTRAST, `${id}: ${fg} ${t[fg]} sobre ${ground} = ${contrastRatio(t[fg], ground).toFixed(2)}`)
      }
      for (const sem of ['accent', 'cobalt', 'success', 'warning', 'danger', 'violet', 'cyan'] as const) {
        assert.ok(contrastRatio(t[sem], ground) >= 3, `${id}: ${sem} como borde o icono sobre ${ground} >= 3:1`)
      }
    }
    assert.ok(contrastRatio(t.text, t.elevated) >= 7, `${id}: texto sobre elevado >= 7:1 (densidad de consola)`)
    for (const sem of ['cobalt', 'success', 'warning', 'danger', 'violet', 'cyan'] as const) {
      assert.ok(contrastRatio(t['on-strong'], t[sem]) >= MIN_CONTRAST, `${id}: on-strong sobre ${sem} = ${contrastRatio(t['on-strong'], t[sem]).toFixed(2)}`)
    }
  }
})

function cssBlock(selector: string): Record<string, string> {
  const start = globalCss.indexOf(`${selector} {`)
  assert.ok(start >= 0, `falta el bloque ${selector} en global.css`)
  const body = globalCss.slice(start, globalCss.indexOf('}', start))
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/--b-([a-z-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

check('global.css define exactamente los tokens de THEME_TOKENS en cada tema (sin deriva)', () => {
  const blocks: Record<ThemeId, Record<string, string>> = {
    'dark-grafito': cssBlock(":root,\n[data-theme='dark-grafito']"),
    'light-estudio': cssBlock("[data-theme='light-estudio']"),
  }
  for (const id of THEME_IDS) {
    const css = blocks[id]
    for (const [name, value] of Object.entries(THEME_TOKENS[id])) {
      assert.equal(css[name]?.toUpperCase(), value.toUpperCase(), `${id}: --b-${name} en global.css`)
    }
    assert.deepEqual(Object.keys(css).sort(), Object.keys(THEME_TOKENS[id]).sort(), `${id}: mismas variables`)
  }
})

check('el Estudio mapea sus tokens --stu-* a los globales (sigue el tema, sin colores fijos)', () => {
  const block = studioCss.slice(studioCss.indexOf('.stu {'), studioCss.indexOf('}', studioCss.indexOf('.stu {')))
  const all = [...block.matchAll(/--stu-([a-z-]+):\s*([^;]+);/g)]
  // Geometria (no color): curva, ancho de cabeceras, separacion y radios de los paneles.
  const stu = all.filter((m) => !['ease', 'head-w', 'gap', 'r-panel', 'r-inner'].includes(m[1]))
  assert.ok(stu.length >= 14)
  for (const m of stu) assert.match(m[2], /^var\(--b-[a-z-]+\)$/, `--stu-${m[1]}`)
  // Los radios de los paneles salen de la redondez del musico (que nunca baja de 8 px).
  for (const m of all.filter((x) => x[1].startsWith('r-'))) assert.match(m[2], /^min\(var\(--b-radius-control\), \d+px\)$/, `--stu-${m[1]}`)
  const hex = studioCss.match(/#[0-9a-f]{3,8}\b/gi) ?? []
  assert.deepEqual(hex, [], 'studio.css sin hexadecimales fijos')
})

console.log('Lienzos del Estudio (paleta por tema)')

const HEX6 = /^#[0-9A-F]{6}$/
const RGBA = /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d+)\)$/
const ROW_BACKGROUNDS = ['lane', 'laneAlt', 'rowWhite', 'rowBlack'] as const

/** Colores de pista (por posicion y por rol) tal como los declara studioState.ts. */
function declaredTrackColors(): string[] {
  const src = read('../src/components/studio/studioState.ts')
  const track = /const TRACK_COLORS[^=]*=\s*\[([^\]]+)\]/.exec(src)?.[1] ?? ''
  const role = /const ROLE_COLORS[^=]*=\s*\{([^}]+)\}/.exec(src)?.[1] ?? ''
  return [...new Set([...track.matchAll(/#[0-9A-Fa-f]{6}/g), ...role.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase()))]
}

check('cada tema define todos los roles de los lienzos con un color valido (hex o rgba)', () => {
  assert.ok(STUDIO_CANVAS_ROLES.length >= 50)
  assert.equal(new Set(STUDIO_CANVAS_ROLES).size, STUDIO_CANVAS_ROLES.length, 'roles sin repetir')
  for (const theme of THEME_IDS) {
    const pal = buildStudioCanvasPalette(theme, null)
    assert.equal(pal.theme, theme)
    for (const role of STUDIO_CANVAS_ROLES) {
      const value = pal[role]
      assert.equal(typeof value, 'string', `${theme}.${role}`)
      assert.ok(HEX6.test(value) || RGBA.test(value), `${theme}.${role}: ${value}`)
    }
    for (const [role, value] of Object.entries(STUDIO_CANVAS_NEUTRALS[theme])) assert.match(value, HEX6, `${theme}.${role} declarado en hexadecimal`)
  }
})

check('Light Estudio pinta claro y Dark Grafito oscuro: fondo, carriles, regla, piano y velocidad', () => {
  const surfaces = ['bg', 'lane', 'laneAlt', 'takeLane', 'ruler', 'rowWhite', 'rowBlack', 'keybed', 'keyWhite', 'velocityBg'] as const
  const light = buildStudioCanvasPalette('light-estudio', null)
  const dark = buildStudioCanvasPalette('dark-grafito', null)
  for (const role of surfaces) {
    assert.ok(relativeLuminance(light[role]) > 0.6, `light-estudio.${role} ${light[role]} es claro`)
    assert.ok(relativeLuminance(dark[role]) < 0.03, `dark-grafito.${role} ${dark[role]} es oscuro`)
  }
  assert.ok(relativeLuminance(light.text) < 0.03 && relativeLuminance(dark.text) > 0.6, 'texto sobre clips invertido')
})

check('texto de la regla y del teclado >= 4,5:1 sobre su fondo; pistas de texto >= 3:1', () => {
  for (const theme of THEME_IDS) {
    const p = buildStudioCanvasPalette(theme, null)
    const pairs: Array<[string, string, string, number]> = [
      ['rulerText/ruler', p.rulerText, p.ruler, RULER_TEXT_MIN_CONTRAST],
      ['rulerTextActive/ruler', p.rulerTextActive, p.ruler, RULER_TEXT_MIN_CONTRAST],
      ['rulerText/section', p.rulerText, p.section, RULER_TEXT_MIN_CONTRAST],
      ['keyLabel/keyWhite', p.keyLabel, p.keyWhite, RULER_TEXT_MIN_CONTRAST],
      ['keyLabel/keybed', p.keyLabel, p.keybed, RULER_TEXT_MIN_CONTRAST],
      ['text/lane', p.text, p.lane, RULER_TEXT_MIN_CONTRAST],
      ['rulerHint/ruler', p.rulerHint, p.ruler, HINT_MIN_CONTRAST],
    ]
    for (const [name, fg, bg, min] of pairs) {
      const ratio = contrastRatio(fg, bg)
      assert.ok(ratio >= min, `${theme} ${name}: ${ratio.toFixed(2)} < ${min}`)
    }
  }
})

check('rejilla de compas y de tiempo >= 1,3:1 sobre todo fondo de fila; la de compas mas marcada', () => {
  for (const theme of THEME_IDS) {
    const p = buildStudioCanvasPalette(theme, null)
    for (const bg of ROW_BACKGROUNDS) {
      for (const line of ['gridStrong', 'gridSoft'] as const) {
        const ratio = contrastRatio(p[line], p[bg])
        assert.ok(ratio >= GRID_MIN_CONTRAST, `${theme} ${line}/${bg}: ${ratio.toFixed(2)}`)
      }
      assert.ok(contrastRatio(p.gridStrong, p[bg]) > contrastRatio(p.gridSoft, p[bg]), `${theme} compas > tiempo sobre ${bg}`)
      assert.ok(contrastRatio(p.gridSoft, p[bg]) > contrastRatio(p.gridFaint, p[bg]), `${theme} tiempo > subdivision sobre ${bg}`)
      assert.ok(contrastRatio(p.gridFaint, p[bg]) > 1.02, `${theme} la subdivision se ve sobre ${bg}`)
    }
    assert.ok(contrastRatio(p.rowLine, p.lane) >= GRID_MIN_CONTRAST, `${theme} separador de filas`)
  }
})

check('medidores: LED verde, ambar y rojo >= 3:1 contra el LED apagado en ambos temas', () => {
  for (const theme of THEME_IDS) {
    const p = buildStudioCanvasPalette(theme, null)
    for (const role of ['meterOk', 'meterHot', 'meterOver', 'meterHold'] as const) {
      const ratio = contrastRatio(p[role], p.meterOff)
      assert.ok(ratio >= 3, `${theme} ${role}/meterOff: ${ratio.toFixed(2)}`)
    }
  }
})

check('colores de pista: los mismos en Dark Grafito; en Light Estudio mas oscuros, mismo tono y >= 3:1 sobre los carriles', () => {
  const declared = declaredTrackColors()
  assert.ok(declared.length >= 8, `colores de studioState.ts: ${declared.length}`)
  const dark = buildStudioCanvasPalette('dark-grafito', null)
  const light = buildStudioCanvasPalette('light-estudio', null)
  for (const color of declared) {
    assert.equal(studioTrackColor(dark, color), color, `Dark Grafito conserva ${color}`)
    const adapted = studioTrackColor(light, color)
    for (const bg of ['lane', 'laneAlt'] as const) {
      const ratio = contrastRatio(adapted, light[bg])
      assert.ok(ratio >= TRACK_MIN_CONTRAST, `${color} -> ${adapted} sobre ${bg}: ${ratio.toFixed(2)}`)
      assert.ok(contrastRatio(color, dark[bg]) >= TRACK_MIN_CONTRAST, `${color} sobre ${bg} de Dark Grafito`)
    }
    assert.ok(relativeLuminance(adapted) < relativeLuminance(color), `${color} se oscurece`)
    const [h0, s0] = rgbToHsl(hexToRgb(color))
    const [h1] = rgbToHsl(hexToRgb(adapted))
    if (s0 > 0.05) assert.ok(Math.min(Math.abs(h0 - h1), 1 - Math.abs(h0 - h1)) < 0.02, `${color} -> ${adapted} conserva el tono`)
  }
})

check('acento del musico: la linea de repeticion y la curva de EQ llegan a 3:1 sobre el carril', () => {
  for (const theme of THEME_IDS) {
    for (const accent of [null, ...ACCENT_PRESETS.map((p) => p.hex), '#FFFFFF', '#000000']) {
      const p = buildStudioCanvasPalette(theme, accent)
      assert.ok(contrastRatio(p.accent, p.lane) >= TRACK_MIN_CONTRAST, `${theme} ${accent}: ${p.accent}`)
    }
  }
  assert.equal(buildStudioCanvasPalette('dark-grafito', null).accent, THEME_TOKENS['dark-grafito'].accent)
})

check('cache: misma combinacion, mismo objeto; otro tema u otro acento, otra paleta; tema invalido = Dark Grafito', () => {
  const a = buildStudioCanvasPalette('light-estudio', '#e06c9f')
  assert.equal(buildStudioCanvasPalette('light-estudio', '#E06C9F'), a)
  assert.notEqual(buildStudioCanvasPalette('dark-grafito', '#E06C9F'), a)
  assert.notEqual(buildStudioCanvasPalette('light-estudio', '#2B62A8'), a)
  assert.equal(buildStudioCanvasPalette('light-estudio', null), buildStudioCanvasPalette('light-estudio', THEME_TOKENS['light-estudio'].accent))
  assert.equal(buildStudioCanvasPalette('neon', null).theme, 'dark-grafito')
  assert.equal(readableOn('#123456', '#FFFFFF', 3), '#123456', 'si ya llega, no cambia')
})

check('auditoria: los lienzos del Estudio no pintan con colores literales y repintan al cambiar el tema', () => {
  const files = ['StudioTimeline.tsx', 'StudioPianoRoll.tsx', 'StudioMixer.tsx', 'StudioTrackHeader.tsx', 'StudioInspector.tsx', 'StudioDevicePanel.tsx', 'StudioAnalyzer.tsx']
  for (const file of files) {
    const src = read(`../src/components/studio/${file}`)
    const literal = src.split('\n').filter((line) => /(fillStyle|strokeStyle)\s*=/.test(line) && /#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(line))
    assert.deepEqual(literal, [], `${file}: colores literales en el canvas`)
    assert.ok(/#[0-9A-Fa-f]{6}\b/.test(src) === false, `${file}: sin hexadecimales fijos`)
    assert.ok(src.includes('useStudioCanvasPalette()'), `${file}: lee la paleta del tema`)
  }
  const dom = read('../src/services/appearanceDom.ts')
  assert.ok(dom.includes('dispatchEvent') && dom.includes('APPEARANCE_EVENT'), 'applyAppearance avisa el cambio')
  const store = read('../src/services/studioCanvasPaletteDom.ts')
  assert.ok(store.includes('addEventListener(APPEARANCE_EVENT'), 'la paleta escucha el aviso')
})

console.log('Redondez y transporte')

check('clampRadius: entero entre 8 y 999; lo invalido da el valor por defecto', () => {
  assert.equal(clampRadius(3), RADIUS_MIN)
  assert.equal(clampRadius(0), RADIUS_MIN)
  assert.equal(clampRadius(-20), RADIUS_MIN)
  assert.equal(clampRadius(1200), RADIUS_MAX)
  assert.equal(clampRadius(12.6), 13)
  assert.equal(clampRadius('24px'), 24)
  assert.equal(clampRadius(' 16 '), 16)
  for (const bad of [NaN, Infinity, null, undefined, '', 'abc', {}, []]) assert.equal(clampRadius(bad), RADIUS_DEFAULT, String(bad))
})

check('deslizador: paradas de 8 a 999 y vuelta a la parada mas cercana', () => {
  assert.equal(RADIUS_STOPS[0], RADIUS_MIN)
  assert.equal(RADIUS_STOPS[RADIUS_STOPS.length - 1], RADIUS_MAX)
  RADIUS_STOPS.forEach((r, i) => {
    assert.equal(radiusToStop(r), i)
    assert.equal(stopToRadius(i), r)
  })
  assert.equal(stopToRadius(-3), RADIUS_MIN)
  assert.equal(stopToRadius(99), RADIUS_MAX)
  assert.equal(RADIUS_STOPS[radiusToStop(9)], 8)
  assert.equal(RADIUS_STOPS[radiusToStop(500)], 48)
})

check('appearanceVars escribe --b-radius en px', () => {
  assert.equal(appearanceVars(prefs({ radius: 999 })).vars['--b-radius'], '999px')
  assert.equal(appearanceVars(prefs({ radius: 2 })).vars['--b-radius'], '8px')
})

/** Reglas "selector { ... }" con su border-radius, sin @media ni @keyframes. */
function radiusRules(css: string): Array<{ selector: string; value: string }> {
  const out: Array<{ selector: string; value: string }> = []
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim()
    const r = /(?:^|;|\s)border-radius:\s*([^;]+);/.exec(m[2])
    if (r) out.push({ selector, value: r[1].trim() })
  }
  return out
}

const BUTTON_SELECTOR = /(^|[\s,])button\b|\.stu-btn|\.stu-key|\.stx-btn|\.rh-chip|\.stu-row\b|\.stu-take-name|role='button'/

check('auditoria: ningun boton con radio menor a 8px en global.css ni en studio.css', () => {
  const offenders: string[] = []
  for (const [file, css] of [['global.css', globalCss], ['studio.css', studioCss]] as const) {
    for (const { selector, value } of radiusRules(css)) {
      if (!BUTTON_SELECTOR.test(selector)) continue
      const v = value.replace(/\s*!important$/, '')
      const px = /^(\d+(?:\.\d+)?)px$/.exec(v)
      const ok = (px !== null && Number(px[1]) >= 8) || v === '50%' || /^(calc\()?var\(--b-radius-(control|transport|card|field)\)/.test(v)
      if (!ok) offenders.push(`${file}: ${selector} -> ${value}`)
    }
  }
  assert.deepEqual(offenders, [])
})

check('regla global: todo boton usa --b-radius-control (>= 8px) con !important; transporte 9999px', () => {
  assert.match(globalCss, /--b-radius-control:\s*max\(8px,\s*var\(--b-radius\)\);/)
  assert.match(globalCss, /--b-radius-transport:\s*9999px;/)
  assert.match(globalCss, /button,\n\[role='button'\],[\s\S]*?\{\n\s*border-radius: var\(--b-radius-control\) !important;/)
  const transport = /\.b-transport,\nbutton\.b-transport,\n\.stu-key,\nbutton\.stu-key,\nbutton\.ga-play,\nbutton\.ga-round \{\n\s*border-radius: var\(--b-radius-transport\) !important;/
  assert.match(globalCss, transport, 'transporte del Hub (.b-transport), del Estudio (.stu-key) y de stems y ensayo (.ga-play, .ga-round) circulares')
  assert.ok(globalCss.indexOf('.b-transport,') > globalCss.indexOf("button,\n[role='button']"), 'la regla del transporte va despues')
  const key = radiusRules(studioCss).find((r) => r.selector === '.stu-key')
  assert.equal(key?.value, 'var(--b-radius-transport)')
})

check('redondez por defecto: pildora en botones, campos 14px y tarjetas 18px; campos y menus nunca < 8px', () => {
  assert.equal(RADIUS_DEFAULT, 999)
  assert.equal(defaultUiPreferences().radius, 999)
  assert.match(globalCss, /--b-radius: 999px;/)
  assert.match(globalCss, /--b-radius-field: min\(var\(--b-radius-control\), 14px\);/)
  assert.match(globalCss, /--b-radius-card: min\(var\(--b-radius-control\), 18px\);/)
  const field = /input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\):not\(\[type='range'\]\),\nselect,\ntextarea,[\s\S]*?\{\n\s*border-radius: var\(--b-radius-field\) !important;/
  assert.match(globalCss, field)
  assert.match(globalCss, /\.b-block,[\s\S]*?\{\n\s*border-radius: var\(--b-radius-card\) !important;/)
})

check('minimalismo: bordes de 1px con baja opacidad (hexadecimal con alfa) en ambos temas', () => {
  for (const id of THEME_IDS) {
    for (const name of ['border', 'border-soft', 'border-strong'] as const) {
      const v = THEME_TOKENS[id][name]
      assert.match(v, /^#[0-9A-F]{8}$/, `${id}: --b-${name}`)
      assert.ok(parseInt(v.slice(7), 16) <= 0x30, `${id}: --b-${name} con alfa <= 19%`)
    }
  }
})

check('hubStyles: los botones compartidos usan la redondez del musico', () => {
  const hub = read('../src/components/hubStyles.ts')
  for (const fn of ['primaryButton', 'ghostButton', 'iconButton']) {
    const start = hub.indexOf(fn)
    const body = hub.slice(start, hub.indexOf('\n}', start))
    assert.match(body, /borderRadius: radius\.control/, fn)
  }
})

console.log('Lectura tolerante y fusion con el workspace')

check('parseUiPreferences: ausente o no-objeto da null; campos danados toman el valor por defecto', () => {
  for (const none of [undefined, null, 'dark', 3, []]) assert.equal(parseUiPreferences(none), null)
  assert.deepEqual(parseUiPreferences({ theme: 'neon', accent: 'rojo', radius: 'abc' }), { ...defaultUiPreferences() })
  // Un documento v1 (sin `waveform`) toma la forma de onda por defecto.
  assert.deepEqual(parseUiPreferences({ theme: 'light-estudio', accent: '#abc', radius: 3 }), {
    version: 2,
    theme: 'light-estudio',
    accent: '#AABBCC',
    radius: 8,
    waveform: defaultWaveformPreferences(),
  })
  assert.deepEqual(parseUiPreferences({ version: 7, theme: 'dark-grafito', accent: null, radius: 2000, futuro: true }), {
    version: 2,
    theme: 'dark-grafito',
    accent: null,
    radius: 999,
    waveform: defaultWaveformPreferences(),
  })
  assert.deepEqual(parseUiPreferences({}), defaultUiPreferences())
})

check('uiPreferencesWarnings avisa sin bloquear; validateWorkspace las suma como advertencias', () => {
  assert.deepEqual(uiPreferencesWarnings(undefined), [])
  assert.deepEqual(uiPreferencesWarnings(defaultUiPreferences()), [])
  assert.equal(uiPreferencesWarnings('x').length, 1)
  assert.equal(uiPreferencesWarnings({ version: 0, theme: 'neon', accent: 'x', radius: 4 }).length, 4)
  const ws = { ...fixture(), uiPreferences: { theme: 'neon', radius: 4 } }
  const v = validateWorkspace(ws)
  assert.deepEqual(v.errors, [])
  assert.equal(v.warnings.filter((w) => w.startsWith('uiPreferences')).length, 2)
})

check('el fixture trae uiPreferences: valida, la migracion lo conserva y es identidad', () => {
  const fx = fixture()
  assert.deepEqual(parseUiPreferences(fx.uiPreferences), fx.uiPreferences)
  assert.deepEqual(validateWorkspace(fx).errors, [])
  assert.equal(migrateWorkspace(fx), fx)
  const loaded = loadWorkspaceDocument({ ...clone(fx), _sync: { client_write_id: 'x' } })
  assert.deepEqual(loaded?.uiPreferences, fx.uiPreferences)
  const imported = parseImportedWorkspace({ workspace: clone(fx) })
  assert.ok(imported.ok)
  if (imported.ok) assert.deepEqual(imported.workspace.uiPreferences, fx.uiPreferences)
})

check('una version v1 sin uiPreferences migra sin agregarlo (no provoca escrituras)', () => {
  const fx = fixture()
  delete fx.uiPreferences
  const m = migrateWorkspace(fx)
  assert.equal(m, fx)
  assert.equal('uiPreferences' in m, false)
  assert.deepEqual(resolveUiPreferences(m.uiPreferences), defaultUiPreferences())
})

check('withUiPreferences: mismo objeto si no cambia (sin escritura), nuevo objeto si cambia; solo la raiz', () => {
  const fx = fixture()
  const same = withUiPreferences(fx, clone(fx.uiPreferences!))
  assert.equal(same, fx)
  const next = withUiPreferences(fx, prefs({ theme: 'dark-grafito', radius: 999 }))
  assert.notEqual(next, fx)
  assert.equal(next.bands, fx.bands)
  assert.equal(next.songsMap, fx.songsMap)
  assert.deepEqual(next.uiPreferences, { version: 2, theme: 'dark-grafito', accent: null, radius: 999, waveform: defaultWaveformPreferences() })
  const dirty = withUiPreferences({ ...fx, uiPreferences: { ...fx.uiPreferences!, extra: 1 } as unknown as UiPreferences }, fx.uiPreferences!)
  assert.equal(Object.keys(dirty.uiPreferences!).length, 5, 'limpia campos sobrantes')
  const dirtyWave = withUiPreferences({ ...fx, uiPreferences: { ...fx.uiPreferences!, waveform: { ...fx.uiPreferences!.waveform, extra: 1 } } as unknown as UiPreferences }, fx.uiPreferences!)
  assert.notEqual(dirtyWave.uiPreferences, fx.uiPreferences)
  assert.equal(Object.keys(dirtyWave.uiPreferences!.waveform).length, 9, 'limpia campos sobrantes del bloque waveform')
  // Un documento v1 (4 campos, sin waveform) se reescribe al guardar algo, con la version y el bloque.
  const v1 = { ...fx, uiPreferences: { version: 1, theme: 'dark-grafito', accent: null, radius: 999 } as unknown as UiPreferences }
  const upgraded = withUiPreferences(v1, prefs({ theme: 'dark-grafito', radius: 999 }))
  assert.notEqual(upgraded, v1)
  assert.equal(upgraded.uiPreferences!.version, 2)
  assert.deepEqual(upgraded.uiPreferences!.waveform, defaultWaveformPreferences())
})

check('banda compartida: uiPreferences queda en la parte personal y nunca en el contenido de la banda', () => {
  const personal = fixture()
  const bandId = 'aaaaaaaa-0000-4000-8000-000000000001'
  const shared: SharedBand = {
    id: bandId,
    ownerId: 'otro',
    role: 'Musician',
    members: [],
    data: {
      schemaVersion: 2,
      activeBandId: bandId,
      bands: [{ id: bandId, name: 'Compartida', genre: '', ownerId: 'otro', currentUserRole: 'Owner', membersCount: 0, createdAt: '2026-11-25' }],
      membersMap: { [bandId]: [] },
      playlistsMap: { [bandId]: [] },
      equipmentMap: { [bandId]: [] },
      stemsMap: {},
      songsMap: { [bandId]: [] },
      voiceMap: {},
    },
  }
  const merged = mergeWorkspace(personal, [shared], bandId)
  assert.equal(merged.activeBandId, bandId)
  // Un Musician de solo lectura cambia su apariencia con la banda compartida activa.
  const edited = withUiPreferences(merged, prefs({ theme: 'dark-grafito', accent: '#B48EDB', radius: 24 }))
  const slice = sliceBand(edited, bandId)
  assert.ok(slice)
  assert.equal('uiPreferences' in (slice as object), false, 'el documento de la banda no lleva apariencia')
  assert.equal(stableStringify(slice), stableStringify(sliceBand(merged, bandId)), 'la banda compartida no cambia: nada que bloquear ni escribir')
  const mine = personalPart(edited, new Set([bandId]), personal.activeBandId)
  assert.deepEqual(mine.uiPreferences, { version: 2, theme: 'dark-grafito', accent: '#B48EDB', radius: 24, waveform: defaultWaveformPreferences() })
  assert.notEqual(stableStringify(mine), stableStringify(personalPart(merged, new Set([bandId]), personal.activeBandId)), 'la parte personal si cambia')
})

check('importar un JSON conserva la apariencia de quien importa', () => {
  const mine = prefs({ theme: 'light-estudio', accent: '#2B62A8', radius: 16 })
  const current = { ...fixture(), uiPreferences: mine }
  const fromFile = { ...fixture(), uiPreferences: prefs({ theme: 'dark-grafito', radius: 999 }) }
  assert.deepEqual(carryUiPreferences(fromFile, current).uiPreferences, mine)
  const noPrefs = fixture()
  delete noPrefs.uiPreferences
  assert.equal('uiPreferences' in carryUiPreferences(fromFile, noPrefs), false, 'si quien importa no tenia, queda sin el campo')
  assert.equal(carryUiPreferences(noPrefs, noPrefs), noPrefs)
})

check('resolveUiPreferences: workspace, luego respaldo, luego fabrica; uiPreferencesEqual', () => {
  const backup = prefs({ theme: 'light-estudio' })
  assert.deepEqual(resolveUiPreferences(undefined, backup), backup)
  assert.deepEqual(resolveUiPreferences({ theme: 'dark-grafito', radius: 20 }, backup), prefs({ radius: 20 }))
  assert.deepEqual(resolveUiPreferences(undefined), defaultUiPreferences())
  assert.ok(uiPreferencesEqual(prefs({}), defaultUiPreferences()))
  assert.ok(!uiPreferencesEqual(prefs({ radius: 9 }), defaultUiPreferences()))
})

console.log('Cache del dispositivo (index.html antes del primer render)')

check('serializar y leer la cache: mismo tema, variables y preferencias', () => {
  const p = prefs({ theme: 'light-estudio', accent: '#787878', radius: 999 })
  const cache = parseAppearanceCache(serializeAppearanceCache(p))
  assert.ok(cache)
  assert.equal(cache.theme, 'light-estudio')
  assert.deepEqual(cache.prefs, p)
  assert.equal(cache.vars['--b-radius'], '999px')
  assert.equal(cache.vars['--b-accent'], effectiveAccent(p).accent, 'guarda el acento ya ajustado')
  assert.notEqual(cache.vars['--b-accent'], '#787878')
})

check('cache danada o con valores peligrosos: se ignora o se filtra', () => {
  for (const bad of [null, '', '{', '[]', '"x"', 'null']) assert.equal(parseAppearanceCache(bad), null, String(bad))
  const evil = JSON.stringify({
    theme: 'neon',
    prefs: { theme: 'light-estudio' },
    vars: { '--b-accent': 'red;}</style><script>', '--evil-x': '#000', '--b-radius': '12px', background: '#fff' },
  })
  const cache = parseAppearanceCache(evil)
  assert.ok(cache)
  assert.equal(cache.theme, 'light-estudio', 'tema invalido: el de las preferencias')
  assert.deepEqual(cache.vars, { '--b-radius': '12px' })
})

check('el script de index.html usa la misma clave y el mismo filtro que parseAppearanceCache', () => {
  assert.ok(indexHtml.includes(`localStorage.getItem('${APPEARANCE_CACHE_KEY}')`))
  assert.ok(indexHtml.includes(CACHE_VAR_NAME_RE.source), 'filtro de nombres')
  assert.ok(indexHtml.includes(CACHE_VAR_VALUE_RE.source), 'filtro de valores')
  assert.match(indexHtml, /<html lang="es" data-theme="dark-grafito">/, 'Dark Grafito por defecto sin JS')
  assert.ok(indexHtml.indexOf('bandait_ui_appearance') < indexHtml.indexOf('/src/main.tsx'), 'corre antes del bundle')
  assert.ok(indexHtml.includes(THEME_TOKENS['light-estudio'].bg) && indexHtml.includes(THEME_TOKENS['dark-grafito'].bg), 'theme-color de cada tema')
})

console.log(`\n${passed} ok, ${failures.length} fallas`)
if (failures.length > 0) process.exit(1)
