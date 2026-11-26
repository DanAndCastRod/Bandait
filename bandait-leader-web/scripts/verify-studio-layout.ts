/**
 * Verificacion de la disposicion del Estudio en la ola 2 de Web 3.0:
 *   node --experimental-strip-types --no-warnings scripts/verify-studio-layout.ts
 *
 * Cubre: src/services/studio/panelLayout.ts (consola y panel lateral plegables, con lo guardado),
 * edgeScrollSpeed de timelineMath.ts (autoscroll del rectangulo de seleccion), los comandos y
 * atajos nuevos de commands.ts (sin teclas del navegador ni choques), la marca `muted` de los
 * clips MIDI en el resumen del chat (chatContext.ts, jobs.ts y studioCloud.ts) y que ninguna
 * capacidad del Estudio quede sin comando o sin boton por el rediseno.
 *
 * Nada de esto toca el navegador, la red ni datos reales.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import {
  LEGACY_MIXER_STORAGE_KEY,
  PANEL_LAYOUT_STORAGE_KEY,
  STUDIO_SIDE_TABS,
  defaultPanelLayout,
  parsePanelLayout,
  serializePanelLayout,
  showSideTab,
  toggleMixer,
  toggleSidePanel,
} from '../src/services/studio/panelLayout.ts'
import { EDGE_SCROLL_MAX_PX, EDGE_SCROLL_ZONE_PX, edgeScrollSpeed } from '../src/services/studio/timelineMath.ts'
import { BROWSER_RESERVED_SHORTCUTS, STUDIO_COMMAND_SPECS, createStudioRegistry, defaultKeymap, findConflicts, findCommandSpec } from '../src/services/studio/commands.ts'
import { midiClipMutedFlag } from '../src/services/studio/chatContext.ts'
import { buildSessionSummary } from '../src/services/studio/jobs.ts'
import { sessionSummaryToWire } from '../src/services/studio/studioCloud.ts'
import { parseSession } from '../src/services/studio/session.ts'

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

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

console.log('panelLayout.ts: consola y panel lateral')

check('por defecto: panel lateral abierto en DISPOSITIVO y consola abierta', () => {
  assert.deepEqual(defaultPanelLayout(), { sideOpen: true, sideTab: 'device', mixerOpen: true })
  assert.deepEqual(STUDIO_SIDE_TABS, ['inspector', 'device', 'jobs'])
  assert.equal(PANEL_LAYOUT_STORAGE_KEY, 'bandait_studio_panels')
})

check('se guarda y se restaura; lectura tolerante campo por campo', () => {
  const l = { sideOpen: false, sideTab: 'jobs' as const, mixerOpen: false }
  assert.deepEqual(parsePanelLayout(serializePanelLayout(l)), l)
  for (const bad of [null, '', '{', '[]', '"x"', 'null']) assert.deepEqual(parsePanelLayout(bad), defaultPanelLayout(), String(bad))
  assert.deepEqual(parsePanelLayout(JSON.stringify({ sideOpen: 'si', sideTab: 'mezcla', mixerOpen: 0 })), defaultPanelLayout())
  assert.deepEqual(parsePanelLayout(JSON.stringify({ sideTab: 'inspector' })), { ...defaultPanelLayout(), sideTab: 'inspector' })
})

check('la clave vieja del mezclador ("0" = plegado) se respeta si no hay disposicion guardada', () => {
  assert.equal(LEGACY_MIXER_STORAGE_KEY, 'bandait_studio_mixer')
  assert.equal(parsePanelLayout(null, '0').mixerOpen, false)
  assert.equal(parsePanelLayout(null, '1').mixerOpen, true)
  assert.equal(parsePanelLayout(JSON.stringify({ mixerOpen: true }), '0').mixerOpen, true, 'la nueva gana')
  assert.equal(parsePanelLayout(JSON.stringify({ sideOpen: false }), '0').mixerOpen, false, 'sin el campo, la vieja')
})

check('plegar a un clic; un icono del riel siempre abre (nunca esconde lo que se fue a buscar)', () => {
  const d = defaultPanelLayout()
  assert.equal(toggleMixer(d).mixerOpen, false)
  assert.equal(toggleMixer(toggleMixer(d)).mixerOpen, true)
  assert.equal(toggleSidePanel(d).sideOpen, false)
  assert.equal(showSideTab(d, 'device'), d, 'ya abierto en esa pestana: mismo objeto')
  assert.deepEqual(showSideTab(toggleSidePanel(d), 'device'), d, 'plegado: lo abre')
  assert.deepEqual(showSideTab(d, 'inspector'), { ...d, sideTab: 'inspector' })
})

console.log('timelineMath.ts: autoscroll del rectangulo de seleccion')

check('edgeScrollSpeed: 0 en el centro, negativo al inicio, positivo al final, maximo en el borde o afuera', () => {
  assert.equal(edgeScrollSpeed(500, 0, 1000), 0)
  assert.equal(edgeScrollSpeed(0, 0, 1000), -EDGE_SCROLL_MAX_PX)
  assert.equal(edgeScrollSpeed(-300, 0, 1000), -EDGE_SCROLL_MAX_PX, 'fuera del carril: maximo')
  assert.equal(edgeScrollSpeed(1000, 0, 1000), EDGE_SCROLL_MAX_PX)
  assert.equal(edgeScrollSpeed(5000, 0, 1000), EDGE_SCROLL_MAX_PX)
  const inside = edgeScrollSpeed(EDGE_SCROLL_ZONE_PX / 2, 0, 1000)
  assert.ok(inside < 0 && inside > -EDGE_SCROLL_MAX_PX, `a mitad de la franja: ${inside}`)
  assert.equal(edgeScrollSpeed(EDGE_SCROLL_ZONE_PX - 0.01, 0, 1000), -1, 'apenas entra: 1 px')
  assert.equal(edgeScrollSpeed(EDGE_SCROLL_ZONE_PX, 0, 1000), 0, 'justo en el limite de la franja: quieto')
})

check('edgeScrollSpeed: carril angosto achica la franja; datos invalidos no desplazan', () => {
  assert.equal(edgeScrollSpeed(50, 0, 100), 0, 'centro de un carril de 100 px')
  // La franja es un cuarto del carril (25 px), no 36: a 30 px del borde no se mueve, a 20 si.
  assert.equal(edgeScrollSpeed(30, 0, 100), 0)
  assert.ok(edgeScrollSpeed(20, 0, 100) < 0)
  assert.ok(edgeScrollSpeed(80, 0, 100) > 0)
  assert.equal(edgeScrollSpeed(Number.NaN, 0, 100), 0)
  assert.equal(edgeScrollSpeed(10, 100, 100), 0, 'sin ancho')
  assert.equal(edgeScrollSpeed(10, 0, 100, 36, 0), 0, 'sin velocidad')
})

console.log('commands.ts: comandos y atajos nuevos')

const NEW: Array<[string, string[]]> = [
  ['view.toggle_mixer', ['Alt+M']],
  ['view.toggle_side_panel', ['Alt+P']],
  ['view.show_inspector', []],
  ['view.show_device', []],
  ['view.show_jobs', []],
  ['view.waveform', []],
]

check('consola (Alt+M), panel lateral (Alt+P), paneles y forma de onda en la paleta: globales y de vista', () => {
  for (const [id, shortcuts] of NEW) {
    const spec = findCommandSpec(id)
    assert.ok(spec, id)
    assert.deepEqual(spec.defaultShortcuts, shortcuts, id)
    assert.equal(spec.context, 'global', id)
    assert.equal(spec.category, 'vista', id)
    assert.equal(spec.assistantAllowed, false, `${id}: no es herramienta del asistente`)
  }
})

check('ningun atajo por defecto es del navegador ni choca con otro (incluido Alt+A del asistente)', () => {
  for (const spec of STUDIO_COMMAND_SPECS) for (const s of spec.defaultShortcuts) assert.ok(!BROWSER_RESERVED_SHORTCUTS.has(s), `${spec.id}: ${s}`)
  assert.deepEqual(findConflicts(STUDIO_COMMAND_SPECS, defaultKeymap(STUDIO_COMMAND_SPECS)), [])
  // Alt + letras que Firefox usa para sus menus (archivo, editar, ver, historial, marcadores, herramientas, ayuda).
  for (const [, shortcuts] of NEW) for (const s of shortcuts) assert.ok(!/^Alt\+[FEVSBTH]$/.test(s), s)
  assert.deepEqual(findCommandSpec('view.toggle_assistant')?.defaultShortcuts, ['Alt+A'])
})

check('el registro los acepta con handler y los corre', () => {
  const ran: string[] = []
  const handlers = Object.fromEntries(NEW.map(([id]) => [id, { run: () => void ran.push(id) }]))
  const registry = createStudioRegistry<unknown>(handlers)
  for (const [id] of NEW) assert.ok(registry.get(id), id)
  void registry.run('view.toggle_mixer', {})
  void registry.run('view.waveform', {})
  assert.deepEqual(ran, ['view.toggle_mixer', 'view.waveform'])
})

check('cada comando del registro tiene su accion en studioCommandHandlers (nada queda inalcanzable por teclado o paleta)', () => {
  const handlers = read('../src/components/studio/studioCommandHandlers.ts')
  const missing = STUDIO_COMMAND_SPECS.filter((s) => !handlers.includes(`'${s.id}'`)).map((s) => s.id)
  assert.deepEqual(missing, [])
})

check('rediseno: la vista conserva cada boton y panel (testids de las pruebas y de la auditoria)', () => {
  const view = read('../src/views/StudioHubView.tsx')
  const timeline = read('../src/components/studio/StudioTimeline.tsx')
  const mixer = read('../src/components/studio/StudioMixer.tsx')
  const transport = read('../src/components/studio/StudioTransport.tsx')
  const assistant = read('../src/components/studio/StudioAssistant.tsx')
  const all = view + timeline + mixer + transport + assistant
  for (const id of [
    'studio-back', 'studio-title', 'studio-save', 'studio-palette-open', 'studio-shortcuts-open', 'studio-assistant-toggle',
    'studio-dock-toggle', 'studio-console-toggle', 'studio-side-toggle', 'studio-dock-collapse', 'studio-tab-', 'studio-mixer-toggle', 'studio-export-open',
    'studio-undo', 'studio-redo', 'studio-split', 'studio-duplicate', 'studio-delete', 'studio-use-take', 'studio-add-midi-clip', 'studio-open-piano',
    'studio-snap-', 'studio-waveform-open', 'studio-add-track', 'studio-import', 'studio-add-instrument', 'studio-import-midi', 'studio-export-midi',
    'studio-stop', 'studio-play', 'studio-record', 'studio-loop', 'studio-click', 'studio-count-in', 'studio-bpm', 'studio-tap-tempo',
    'studio-assistant-pill', 'studio-assistant-minimize', 'studio-assistant-resize',
  ]) assert.ok(all.includes(`"${id}`) || all.includes(`\`${id}`), id)
  assert.ok(!assistant.includes("'docked'"), 'el asistente ya no tiene modo acoplado')
})

console.log('Resumen del chat: clips MIDI silenciados')

check('midiClipMutedFlag: { muted: true } solo si esta silenciado', () => {
  assert.deepEqual(midiClipMutedFlag({ muted: true }), { muted: true })
  assert.deepEqual(midiClipMutedFlag({ muted: false }), {})
  assert.deepEqual(midiClipMutedFlag({}), {})
})

check('el resumen que viaja marca el clip MIDI silenciado del fixture y no toca los demas', () => {
  const session = parseSession(structuredClone(sessionFixtureV2))
  const summary = buildSessionSummary(session, { playheadBeat: 0, selection: { trackId: null, clipIds: [], context: 'timeline' } })
  const wire = sessionSummaryToWire(summary) as { tracks: Array<{ midi_clips: Array<Record<string, unknown>> }> }
  const clips = wire.tracks.flatMap((t) => t.midi_clips)
  const muted = clips.filter((c) => c.muted === true)
  const expected = session.tracks.flatMap((t) => t.midiClips).filter((c) => c.muted === true).map((c) => c.id)
  assert.ok(expected.length >= 1, 'el fixture trae un clip silenciado')
  assert.deepEqual(muted.map((c) => c.id).sort(), [...expected].sort())
  assert.ok(clips.filter((c) => c.muted !== true).every((c) => !('muted' in c)), 'un clip que suena no lleva la clave')
})

check('contrato: STUDIO_V2.md documenta `muted` en midi_clips del resumen', () => {
  const contract = read('../../bandait-protocol/STUDIO_V2.md')
  assert.match(contract, /"digest" \(opcional\), "muted" \(opcional\)/)
})

console.log(`\n${passed} ok, ${failures.length} fallas`)
if (failures.length > 0) process.exit(1)
