/**
 * Verificacion de la forma de onda configurable (ola 2 de Web 3.0, pedido de Daniel Castaneda):
 *   node --experimental-strip-types --no-warnings scripts/verify-waveform-logic.ts
 *
 * Cubre: src/services/waveform.ts (preferencias, limites, avisos, escala), waveformRender.ts (el
 * dibujo contra un contexto 2D que graba las llamadas: estilos, armado, capas, rejilla de barras,
 * colores), el RMS de studio/peaks.ts (calculo, reagrupado y compatibilidad con picos sin RMS) y
 * el bloque `waveform` dentro de uiPreferences (appearance.ts y validateWorkspace).
 *
 * Nada de esto toca el navegador, la red ni datos reales.
 */
import assert from 'node:assert/strict'
import fixtureJson from '../../bandait-protocol/fixtures/workspace_v2.json' with { type: 'json' }
import {
  WAVEFORM_BAR_GAP_MAX,
  WAVEFORM_BAR_WIDTH_MAX,
  WAVEFORM_DB_FLOOR,
  WAVEFORM_GAIN_MAX,
  WAVEFORM_GAIN_MIN,
  WAVEFORM_KEY_COUNT,
  clampBarGap,
  clampBarWidth,
  clampWaveformGain,
  defaultWaveformPreferences,
  normalizeWaveformPreferences,
  parseWaveformPreferences,
  waveformHeight,
  waveformPreferencesEqual,
  waveformPreferencesWarnings,
  type WaveformPreferences,
} from '../src/services/waveform.ts'
import { WAVEFORM_PAD_PX, barColumns, drawWaveform, resolveWaveformColors, waveformAlpha, waveformLayers, type WaveformContext } from '../src/services/waveformRender.ts'
import { computePeaks, peaksForRange, peaksHaveRms } from '../src/services/studio/peaks.ts'
import { defaultUiPreferences, parseUiPreferences, uiPreferencesWarnings } from '../src/services/appearance.ts'
import { validateWorkspace } from '../src/services/workspaceSchema.ts'
import type { WorkspaceStore } from '../src/types/hub.ts'

let passed = 0
const failures: string[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}`)
    console.log(`       ${err instanceof Error ? err.message.split('\n').join('\n       ') : String(err)}`)
  }
}

const prefs = (p: Partial<WaveformPreferences> = {}): WaveformPreferences => ({ ...defaultWaveformPreferences(), ...p })
const fixture = (): WorkspaceStore => structuredClone(fixtureJson) as unknown as WorkspaceStore

/** Contexto 2D que graba las llamadas (fill/stroke con el color vigente en ese momento). */
interface Call {
  op: string
  args: number[]
  style?: string
}

function recorder(withRoundRect = true): WaveformContext & { calls: Call[] } {
  const calls: Call[] = []
  const ctx = {
    calls,
    fillStyle: '' as unknown,
    strokeStyle: '' as unknown,
    lineWidth: 1,
    beginPath: () => calls.push({ op: 'beginPath', args: [] }),
    moveTo: (x: number, y: number) => calls.push({ op: 'moveTo', args: [x, y] }),
    lineTo: (x: number, y: number) => calls.push({ op: 'lineTo', args: [x, y] }),
    closePath: () => calls.push({ op: 'closePath', args: [] }),
    fill: () => calls.push({ op: 'fill', args: [], style: String(ctx.fillStyle) }),
    stroke: () => calls.push({ op: 'stroke', args: [], style: String(ctx.strokeStyle) }),
    fillRect: (x: number, y: number, w: number, h: number) => calls.push({ op: 'fillRect', args: [x, y, w, h], style: String(ctx.fillStyle) }),
    rect: (x: number, y: number, w: number, h: number) => calls.push({ op: 'rect', args: [x, y, w, h] }),
  } as WaveformContext & { calls: Call[] }
  if (withRoundRect) ctx.roundRect = (x: number, y: number, w: number, h: number, r?: number) => void calls.push({ op: 'roundRect', args: [x, y, w, h, r ?? 0] })
  return ctx
}

/** Columnas de prueba: una rampa con algo de asimetria y un RMS a la mitad. */
function columns(count: number): { min: Float32Array; max: Float32Array; rms: Float32Array } {
  const min = new Float32Array(count)
  const max = new Float32Array(count)
  const rms = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    max[i] = (i + 1) / count
    min[i] = -((i + 1) / count) * 0.8
    rms[i] = ((i + 1) / count) * 0.5
  }
  return { min, max, rms }
}

const COLORS = { solid: 'rgba(1, 2, 3, 0.9)', translucent: 'rgba(1, 2, 3, 0.36)' }

console.log('waveform.ts: preferencias')

check('por defecto reproduce el aspecto de antes: relleno, espejo, pico, lineal, color de pista, sin zoom', () => {
  const d = defaultWaveformPreferences()
  assert.deepEqual(d, { version: 1, style: 'filled', layout: 'mirrored', data: 'peak', scale: 'linear', color: 'track', gain: 1, barWidth: 2, barGap: 1 })
  assert.equal(WAVEFORM_KEY_COUNT, 9)
  assert.notEqual(defaultWaveformPreferences(), defaultWaveformPreferences(), 'cada llamada es un objeto nuevo')
})

check('lectura tolerante: campo por campo, lo danado toma su valor por defecto; nunca null', () => {
  for (const none of [undefined, null, 'barras', 3, []]) assert.deepEqual(parseWaveformPreferences(none), defaultWaveformPreferences())
  const all = { version: 9, style: 'bars', layout: 'bottom', data: 'peak-rms', scale: 'db', color: 'neutral', gain: 2.5, barWidth: 4, barGap: 0, extra: true }
  assert.deepEqual(parseWaveformPreferences(all), { version: 1, style: 'bars', layout: 'bottom', data: 'peak-rms', scale: 'db', color: 'neutral', gain: 2.5, barWidth: 4, barGap: 0 })
  assert.deepEqual(parseWaveformPreferences({ style: 'puntos', layout: 7, data: 'max', scale: 'log', color: '#fff' }), defaultWaveformPreferences())
  assert.equal(normalizeWaveformPreferences(null).style, 'filled')
})

check('limites: zoom 0,5..3 en pasos de 0,05; barra 1..6 px y separacion 0..4 px enteros', () => {
  assert.equal(clampWaveformGain(0.1), WAVEFORM_GAIN_MIN)
  assert.equal(clampWaveformGain(99), WAVEFORM_GAIN_MAX)
  assert.equal(clampWaveformGain(1.234), 1.25)
  assert.equal(clampWaveformGain('2'), 2)
  assert.equal(clampWaveformGain('x'), 1)
  assert.equal(clampWaveformGain(Number.NaN), 1)
  assert.equal(clampBarWidth(0), 1)
  assert.equal(clampBarWidth(10), WAVEFORM_BAR_WIDTH_MAX)
  assert.equal(clampBarWidth(2.6), 3)
  assert.equal(clampBarWidth('4px'), 4)
  assert.equal(clampBarGap(-3), 0)
  assert.equal(clampBarGap(9), WAVEFORM_BAR_GAP_MAX)
  assert.equal(clampBarGap(undefined), 1)
  assert.deepEqual(parseWaveformPreferences({ gain: 0, barWidth: 99, barGap: -1 }), prefs({ gain: 0.5, barWidth: 6, barGap: 0 }))
})

check('avisos (no errores) por campo; sin avisos para lo valido o ausente', () => {
  assert.deepEqual(waveformPreferencesWarnings(undefined), [])
  assert.deepEqual(waveformPreferencesWarnings(defaultWaveformPreferences()), [])
  assert.equal(waveformPreferencesWarnings('x').length, 1)
  const w = waveformPreferencesWarnings({ version: 0, style: 'puntos', layout: 'arriba', data: 'max', scale: 'log', color: 1, gain: 7, barWidth: 1.5, barGap: 5 })
  assert.equal(w.length, 9, w.join(' | '))
  assert.ok(w.every((line) => line.startsWith('uiPreferences.waveform.')))
})

check('igualdad campo por campo', () => {
  assert.ok(waveformPreferencesEqual(prefs(), defaultWaveformPreferences()))
  for (const patch of [{ style: 'bars' }, { layout: 'bottom' }, { data: 'rms' }, { scale: 'db' }, { color: 'accent' }, { gain: 1.5 }, { barWidth: 3 }, { barGap: 2 }] as const) {
    assert.ok(!waveformPreferencesEqual(prefs(patch as Partial<WaveformPreferences>), defaultWaveformPreferences()), JSON.stringify(patch))
  }
})

check('waveformHeight: lineal y dB con piso de -48; el zoom multiplica la altura y se acota a 1', () => {
  assert.equal(waveformHeight(0.5, 'linear', 1), 0.5)
  assert.equal(waveformHeight(-0.5, 'linear', 1), 0.5, 'valor absoluto')
  assert.equal(waveformHeight(0.5, 'linear', 3), 1, 'acotado')
  assert.equal(waveformHeight(Number.NaN, 'linear', 1), 0)
  assert.equal(waveformHeight(1, 'db', 1), 1, '0 dBFS llena')
  assert.equal(waveformHeight(0, 'db', 1), 0)
  assert.ok(Math.abs(waveformHeight(10 ** (WAVEFORM_DB_FLOOR / 20), 'db', 1)) < 1e-9, 'el piso queda en 0')
  assert.ok(Math.abs(waveformHeight(10 ** (-24 / 20), 'db', 1) - 0.5) < 1e-9, '-24 dB a la mitad')
  assert.equal(waveformHeight(10 ** (-60 / 20), 'db', 1), 0, 'debajo del piso')
  assert.ok(waveformHeight(0.1, 'db', 1) > waveformHeight(0.1, 'linear', 1), 'dB levanta lo bajo')
})

console.log('waveformRender.ts: dibujo')

check('por defecto dibuja EXACTAMENTE el poligono de antes (borde superior, inferior de vuelta y linea del centro)', () => {
  const n = 6
  const cols = columns(n)
  const box = { x: 10, top: 20, height: 40 }
  const factor = (i: number) => 1 - i * 0.05
  const ctx = recorder()
  drawWaveform(ctx, { min: cols.min, max: cols.max, rms: cols.rms, count: n, x: box.x, top: box.top, height: box.height, factor }, prefs(), COLORS)
  // Algoritmo de StudioTimeline antes de la opcion: mid - hi * half, de ida por el maximo y de vuelta por el minimo.
  const mid = box.top + box.height / 2
  const half = Math.max(1, box.height / 2 - WAVEFORM_PAD_PX)
  const expected: Call[] = [{ op: 'beginPath', args: [] }]
  for (let i = 0; i < n; i++) {
    const hi = Math.min(1, cols.max[i] * factor(i))
    expected.push({ op: i === 0 ? 'moveTo' : 'lineTo', args: [box.x + i, mid - hi * half] })
  }
  for (let i = n - 1; i >= 0; i--) {
    const lo = Math.max(-1, cols.min[i] * factor(i))
    expected.push({ op: 'lineTo', args: [box.x + i, mid - lo * half] })
  }
  expected.push({ op: 'closePath', args: [] }, { op: 'fill', args: [], style: COLORS.solid })
  expected.push({ op: 'fillRect', args: [box.x, mid - 0.5, n, 1], style: COLORS.solid })
  assert.equal(ctx.calls.length, expected.length)
  ctx.calls.forEach((call, i) => {
    assert.equal(call.op, expected[i].op, `paso ${i}`)
    call.args.forEach((v, j) => assert.ok(Math.abs(v - expected[i].args[j]) < 1e-5, `paso ${i} arg ${j}: ${v} vs ${expected[i].args[j]}`))
    if (expected[i].style) assert.equal(call.style, expected[i].style)
  })
})

check('barras: una por paso (ancho + separacion), alineadas al inicio del clip; no "nadan" al desplazar', () => {
  const n = 40
  const cols = columns(n)
  const p = prefs({ style: 'bars', barWidth: 3, barGap: 1 })
  const ctx = recorder()
  drawWaveform(ctx, { min: cols.min, max: cols.max, rms: null, count: n, x: 100, top: 0, height: 50, barOrigin: 100 }, p, COLORS)
  const bars = ctx.calls.filter((c) => c.op === 'roundRect')
  assert.equal(bars.length, 10)
  bars.forEach((b, k) => {
    assert.equal(b.args[0], 100 + k * 4, 'x en la rejilla')
    assert.equal(b.args[2], 3, 'ancho')
    assert.ok(b.args[4] <= 1.5 + 1e-9, 'radio de punta redonda: la mitad del ancho como maximo')
  })
  assert.equal(ctx.calls.filter((c) => c.op === 'fill').length, 1, 'todas las barras en un solo relleno')
  assert.equal(ctx.calls.filter((c) => c.op === 'fillRect').length, 0, 'sin linea del centro en barras')
  // Misma rejilla con la ventana corrida 6 px (el clip empezo 6 px antes de la vista).
  const shifted = recorder()
  drawWaveform(shifted, { min: cols.min, max: cols.max, rms: null, count: n, x: 106, top: 0, height: 50, barOrigin: 100 }, p, COLORS)
  const xs = shifted.calls.filter((c) => c.op === 'roundRect').map((c) => c.args[0])
  assert.ok(xs.every((x) => (x - 100) % 4 === 0), `rejilla anclada al clip: ${xs.join(',')}`)
})

check('barColumns: columnas de cada barra; separacion 0 y ancho 1 da una barra por columna', () => {
  const seen: Array<[number, number, number]> = []
  barColumns(0, 5, 0, 1, 0, (x, c0, c1) => seen.push([x, c0, c1]))
  assert.deepEqual(seen, [[0, 0, 1], [1, 1, 2], [2, 2, 3], [3, 3, 4], [4, 4, 5]])
  const partial: Array<[number, number, number]> = []
  barColumns(10, 6, 7, 2, 2, (x, c0, c1) => partial.push([x, c0, c1]))
  assert.deepEqual(partial, [[11, 1, 3], [15, 5, 6]], 'la barra que empieza antes de la vista se salta si no tiene columnas visibles')
})

check('sin roundRect (navegador viejo) las barras caen a rectangulos', () => {
  const cols = columns(8)
  const ctx = recorder(false)
  drawWaveform(ctx, { min: cols.min, max: cols.max, rms: null, count: 8, x: 0, top: 0, height: 30 }, prefs({ style: 'bars', barWidth: 2, barGap: 0 }), COLORS)
  assert.equal(ctx.calls.filter((c) => c.op === 'rect').length, 4)
})

check('desde la base: todo queda entre la base y el techo de la banda', () => {
  const cols = columns(12)
  for (const style of ['bars', 'filled', 'line'] as const) {
    const ctx = recorder()
    drawWaveform(ctx, { min: cols.min, max: cols.max, rms: cols.rms, count: 12, x: 0, top: 10, height: 40 }, prefs({ style, layout: 'bottom', gain: 3 }), COLORS)
    const base = 10 + 40 - WAVEFORM_PAD_PX
    for (const c of ctx.calls) {
      if (c.op === 'moveTo' || c.op === 'lineTo') assert.ok(c.args[1] <= base + 1e-9 && c.args[1] >= 10 + WAVEFORM_PAD_PX - 1e-9, `${style}: y=${c.args[1]}`)
      if (c.op === 'roundRect') assert.ok(Math.abs(c.args[1] + c.args[3] - base) < 1e-9 && c.args[1] >= 10 + WAVEFORM_PAD_PX - 1e-9, `${style}: barra fuera`)
    }
    assert.equal(ctx.calls.filter((c) => c.op === 'fillRect').length, 0, `${style}: sin linea del centro`)
  }
})

check('pico + RMS: dos capas, el pico translucido primero y el RMS solido encima; sin RMS, una sola capa', () => {
  const cols = columns(10)
  const ctx = recorder()
  drawWaveform(ctx, { min: cols.min, max: cols.max, rms: cols.rms, count: 10, x: 0, top: 0, height: 40 }, prefs({ data: 'peak-rms' }), COLORS)
  const fills = ctx.calls.filter((c) => c.op === 'fill').map((c) => c.style)
  assert.deepEqual(fills, [COLORS.translucent, COLORS.solid])
  const noRms = recorder()
  drawWaveform(noRms, { min: cols.min, max: cols.max, rms: null, count: 10, x: 0, top: 0, height: 40 }, prefs({ data: 'peak-rms' }), COLORS)
  assert.deepEqual(noRms.calls.filter((c) => c.op === 'fill').map((c) => c.style), [COLORS.solid], 'picos guardados sin RMS: el pico de siempre')
  assert.deepEqual(waveformLayers({ data: 'rms' }, false, COLORS), [{ layer: 'peak', color: COLORS.solid }])
  assert.deepEqual(waveformLayers({ data: 'rms' }, true, COLORS), [{ layer: 'rms', color: COLORS.solid }])
})

check('RMS: simetrico sobre el centro y mas bajo que el pico', () => {
  const cols = columns(4)
  const ctx = recorder()
  drawWaveform(ctx, { min: cols.min, max: cols.max, rms: cols.rms, count: 4, x: 0, top: 0, height: 46 }, prefs({ data: 'rms' }), COLORS)
  const pts = ctx.calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => c.args[1])
  const mid = 23
  // Ida (0..3) y vuelta (3..0): cada columna a la misma distancia del centro arriba y abajo.
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(mid - pts[i] - (pts[7 - i] - mid)) < 1e-9, `columna ${i}`)
  const half = 23 - WAVEFORM_PAD_PX
  assert.ok(Math.abs(mid - pts[3] - cols.rms[3] * half) < 1e-5)
})

check('contorno: traza (stroke) los bordes, no rellena la forma; en espejo dos trazos', () => {
  const cols = columns(6)
  const ctx = recorder()
  drawWaveform(ctx, { min: cols.min, max: cols.max, rms: null, count: 6, x: 0, top: 0, height: 30 }, prefs({ style: 'line' }), COLORS)
  assert.equal(ctx.calls.filter((c) => c.op === 'stroke').length, 1)
  assert.equal(ctx.calls.filter((c) => c.op === 'fill').length, 0)
  assert.equal(ctx.calls.filter((c) => c.op === 'moveTo').length, 2, 'borde superior e inferior')
  assert.equal(ctx.lineWidth, 1)
})

check('escala dB y zoom: nunca se sale de la banda; columna en el piso queda en el centro', () => {
  const min = new Float32Array([-1, -(10 ** (WAVEFORM_DB_FLOOR / 20))])
  const max = new Float32Array([1, 10 ** (WAVEFORM_DB_FLOOR / 20)])
  const ctx = recorder()
  drawWaveform(ctx, { min, max, rms: null, count: 2, x: 0, top: 0, height: 40 }, prefs({ scale: 'db', gain: 3 }), COLORS)
  const ys = ctx.calls.filter((c) => c.op === 'moveTo' || c.op === 'lineTo').map((c) => c.args[1])
  assert.ok(ys.every((y) => y >= WAVEFORM_PAD_PX - 1e-9 && y <= 40 - WAVEFORM_PAD_PX + 1e-9), ys.join(','))
  assert.ok(Math.abs(ys[1] - 20) < 1e-6, 'la columna en -48 dB queda en el centro')
})

check('nada que dibujar: sin columnas o sin alto no toca el contexto', () => {
  const cols = columns(4)
  for (const input of [{ count: 0, height: 40 }, { count: 4, height: 0 }]) {
    const ctx = recorder()
    drawWaveform(ctx, { min: cols.min, max: cols.max, rms: null, x: 0, top: 0, ...input }, prefs(), COLORS)
    assert.equal(ctx.calls.length, 0)
  }
})

check('colores: pista, acento o neutro, con la opacidad de quien dibuja; el pico translucido al 40 %', () => {
  const sources = { track: '#E06C9F', accent: '#5CC8C2', neutral: '#E4E7EB' }
  assert.deepEqual(resolveWaveformColors('track', sources, 0.9), { solid: 'rgba(224, 108, 159, 0.9)', translucent: 'rgba(224, 108, 159, 0.36)' })
  assert.equal(resolveWaveformColors('accent', sources, 0.45).solid, 'rgba(92, 200, 194, 0.45)')
  assert.equal(resolveWaveformColors('neutral', sources, 1).solid, 'rgba(228, 231, 235, 0.78)')
  assert.equal(waveformAlpha('rgb(1,2,3)', 0.5), 'rgb(1,2,3)', 'otro formato se devuelve tal cual')
})

console.log('peaks.ts: RMS y picos guardados antes')

check('computePeaks guarda el RMS por cubeta en Uint8 (0..255)', () => {
  const constant = new Float32Array(8).fill(0.5)
  const p = computePeaks(constant, 4)
  assert.ok(p.rms instanceof Uint8Array)
  assert.deepEqual([...p.rms!], [128, 128])
  const sine = new Float32Array(4800)
  for (let i = 0; i < sine.length; i++) sine[i] = Math.sin((2 * Math.PI * 100 * i) / 48000)
  const s = computePeaks(sine, 480)
  for (const v of s.rms!) assert.ok(Math.abs(v / 255 - Math.SQRT1_2) < 0.01, `seno: ${v}`)
  const nan = computePeaks(new Float32Array([Number.NaN, Number.NaN]), 2)
  assert.equal(nan.rms![0], 0, 'NaN cuenta como silencio')
  assert.ok(peaksHaveRms([p, s]))
})

check('peaksForRange reagrupa el RMS como raiz de la media de los cuadrados y reutiliza el arreglo', () => {
  const samples = new Float32Array(40)
  samples.fill(0.2, 0, 20)
  samples.fill(0.6, 20, 40)
  const p = computePeaks(samples, 10)
  const out = { min: new Float32Array(1), max: new Float32Array(1), rms: new Float32Array(1) }
  const cols = peaksForRange(p, { sampleRate: 40, startS: 0, endS: 1, columns: 1 }, out)
  assert.equal(cols, out)
  const r1 = Math.round(0.2 * 255) / 255
  const r2 = Math.round(0.6 * 255) / 255
  assert.ok(Math.abs(cols.rms![0] - Math.sqrt((r1 * r1 + r2 * r2) / 2)) < 1e-6, String(cols.rms![0]))
  const fresh = peaksForRange(p, { sampleRate: 40, startS: 0, endS: 1, columns: 4 })
  assert.equal(fresh.rms!.length, 4, 'sin out: arreglo nuevo con RMS')
})

check('picos guardados sin RMS: el pico sigue igual y no se escribe RMS (se usa el pico al dibujar)', () => {
  const p = computePeaks(new Float32Array([0.5, -0.5, 0.25, -0.25]), 2)
  const old = { min: p.min, max: p.max, samplesPerBucket: p.samplesPerBucket }
  assert.ok(!peaksHaveRms([old]))
  assert.ok(!peaksHaveRms([]))
  const out = { min: new Float32Array(2), max: new Float32Array(2), rms: new Float32Array([7, 7]) }
  const cols = peaksForRange(old, { sampleRate: 4, startS: 0, endS: 1, columns: 2 }, out)
  assert.deepEqual([...cols.rms!], [7, 7], 'el RMS de salida no se toca')
  assert.deepEqual([...cols.max], [...peaksForRange(p, { sampleRate: 4, startS: 0, endS: 1, columns: 2 }).max], 'el pico es el mismo con o sin RMS')
  assert.equal(peaksForRange(old, { sampleRate: 4, startS: 0, endS: 1, columns: 2 }).rms, undefined)
})

console.log('appearance.ts: bloque waveform dentro de uiPreferences')

check('uiPreferences v2 lleva el bloque; un v1 sin el toma la forma de onda por defecto', () => {
  const d = defaultUiPreferences()
  assert.equal(d.version, 2)
  assert.deepEqual(d.waveform, defaultWaveformPreferences())
  assert.deepEqual(parseUiPreferences({ version: 1, theme: 'dark-grafito', accent: null, radius: 999 })?.waveform, defaultWaveformPreferences())
  assert.deepEqual(parseUiPreferences({ waveform: { style: 'bars', gain: 9 } })?.waveform, prefs({ style: 'bars', gain: 3 }))
})

check('el fixture del contrato trae un bloque waveform valido y se lee igual', () => {
  const fx = fixture()
  const parsed = parseUiPreferences(fx.uiPreferences)
  assert.deepEqual(parsed, fx.uiPreferences)
  assert.equal(parsed?.waveform.style, 'bars')
  assert.deepEqual(uiPreferencesWarnings(fx.uiPreferences), [])
})

check('validateWorkspace: un bloque waveform danado da advertencias, nunca errores', () => {
  const ws = { ...fixture(), uiPreferences: { ...fixture().uiPreferences!, waveform: { style: 'puntos', gain: 'mucho', barGap: 12 } } } as unknown as WorkspaceStore
  const v = validateWorkspace(ws)
  assert.deepEqual(v.errors, [])
  const mine = v.warnings.filter((w) => w.startsWith('uiPreferences.waveform'))
  assert.equal(mine.length, 3, mine.join(' | '))
  assert.equal(uiPreferencesWarnings({ waveform: 'x' }).length, 1)
})

console.log(`\n${passed} ok, ${failures.length} fallas`)
if (failures.length > 0) process.exit(1)
