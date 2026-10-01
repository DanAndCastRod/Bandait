/**
 * Verificacion del workspace v2 (bandait-protocol/WORKSPACE_V2.md), sin framework de pruebas.
 *   node --experimental-strip-types scripts/verify-workspace-schema.ts   (parte de npm run verify:logic)
 *
 * Cubre: migracion v1 -> v2 (idempotente, determinista, conserva campos desconocidos, nunca
 * regenera ids, empareja por title/artist), el fixture canonico, la validacion, el motor de
 * sincronizacion con datos migrados (sin ecos ni falsos conflictos), el parser de ChordPro y
 * el calculo de compases de inicio.
 */
import assert from 'node:assert/strict'
import fixtureJson from '../../bandait-protocol/fixtures/workspace_v2.json' with { type: 'json' }
import {
  MIGRATION_EPOCH,
  UUID_RE,
  defaultVoiceConfig,
  deterministicUuid,
  effectiveCueText,
  estimateDurationSec,
  loadWorkspaceDocument,
  migrateWorkspace,
  parseImportedWorkspace,
  playlistItemFromSong,
  sectionStartBars,
  songDurationSec,
  totalBars,
  transitionEntryNotice,
  validateWorkspace,
} from '../src/services/workspaceSchema.ts'
import { classifyHeading, layoutChordLine, layoutChordPro, matchPlainHeading, parseChordProSong } from '../src/services/chordpro.ts'
import {
  WorkspaceSyncEngine,
  stableStringify,
  syncMetaKey,
  type CloudAdapter,
  type EngineStatus,
  type KeyValueStore,
  type RemoteHint,
  type WriteResult,
} from '../src/services/workspaceSync.ts'
import type { Song, WorkspaceInput, WorkspaceStore } from '../src/types/hub.ts'

let passed = 0
const failures: string[] = []
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`)
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const fixture = () => clone(fixtureJson) as unknown as WorkspaceStore
type Rec = Record<string, unknown>

/** Workspace v1 tal como lo guardaba el Hub antes de la Fase 1, con campos "del futuro". */
function v1Workspace(): WorkspaceInput {
  const item = (id: string, title: string, extra: Rec = {}) => ({
    id,
    orderIndex: 1,
    title,
    artist: 'Banda A',
    bpm: 124,
    key: 'Am',
    showKey: 'Am',
    camelot: '8A',
    durationSec: 215,
    transitionMode: 'manual_cue',
    countInBars: 2,
    notes: '',
    ...extra,
  })
  return {
    bands: [
      { id: 'band_a', name: 'Banda A', ownerId: 'u1', currentUserRole: 'Owner', membersCount: 1, createdAt: '2026-09-01', bandFuture: 'x' },
      { id: 'band_b', name: 'Banda B', ownerId: 'u1', currentUserRole: 'Owner', membersCount: 1, createdAt: '2026-09-01' },
    ],
    activeBandId: 'band_a',
    membersMap: { band_a: [], band_b: [] },
    playlistsMap: {
      band_a: [
        {
          id: 'pl_a1',
          bandId: 'band_a',
          name: 'Show 1',
          createdAt: '2026-09-01',
          updatedAt: '2026-09-15',
          playlistFuture: 1,
          songs: [
            item('song_1', 'Medianoche', { itemFuture: true }),
            item('song_2', '  MEDIANOCHE ', { artist: 'banda a ', bpm: 126 }),
            item('song_3', 'Ruta', { bpm: 300, camelot: '7A', durationSec: 198 }),
          ],
        },
        { id: 'pl_a2', bandId: 'band_a', name: 'Show 2', createdAt: '2026-09-02', updatedAt: '2026-09-20', songs: [item('song_4', 'Ruta')] },
      ],
      band_b: [{ id: 'pl_b1', bandId: 'band_b', name: 'Show B', createdAt: '2026-09-03', updatedAt: '2026-09-03', songs: [item('song_5', 'Medianoche')] }],
    },
    equipmentMap: { band_a: [], band_b: [] },
    stemsMap: {},
    rootFuture: { keep: true },
  } as unknown as WorkspaceInput
}

const items = (ws: WorkspaceStore, bandId: string) => (ws.playlistsMap[bandId] ?? []).flatMap((pl) => pl.songs)

// ---------------------------------------------------------------------------
// Adaptador de nube falso que guarda el JSON CRUDO (con _sync) y lo pasa por la misma
// funcion que usa supabaseClient.ts (loadWorkspaceDocument): migra antes de reconciliar.
// ---------------------------------------------------------------------------

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r))
}

class FakeClock {
  now = Date.parse('2026-10-01T12:00:00.000Z')
  private seq = 0
  private timers = new Map<number, { at: number; fn: () => void }>()
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timers.set(id, { at: this.now + ms, fn })
    return id
  }
  clearTimer = (h: unknown): void => {
    this.timers.delete(h as number)
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      await settle()
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.timers.delete(due[0])
      this.now = Math.max(this.now, due[1].at)
      due[1].fn()
    }
    this.now = target
    await settle()
  }
}

class MemStore implements KeyValueStore {
  map = new Map<string, string>()
  get(k: string) {
    return this.map.get(k) ?? null
  }
  set(k: string, v: string) {
    this.map.set(k, v)
    return true
  }
}

class RawCloud implements CloudAdapter<WorkspaceStore> {
  raw: unknown = null
  updatedAt = ''
  clientWriteId: string | null = null
  calls: string[] = []
  expectedSeen: string[] = []
  private listener: ((h: RemoteHint) => void) | null = null
  writes() {
    return this.calls.filter((c) => c !== 'fetch').length
  }
  async fetchRow() {
    this.calls.push('fetch')
    if (this.raw === null) return { ok: true as const, row: null }
    return {
      ok: true as const,
      row: { data: loadWorkspaceDocument(clone(this.raw)), raw: clone(this.raw), updatedAt: this.updatedAt, clientWriteId: this.clientWriteId },
    }
  }
  private store(data: WorkspaceStore, updatedAt: string, id: string) {
    // Igual que wrapWorkspace en supabaseClient.ts.
    this.raw = { ...clone(data), _sync: { schema: 1, client_write_id: id, client_id: 'tab', updated_at: updatedAt } }
    this.updatedAt = updatedAt
    this.clientWriteId = id
    this.listener?.({ updatedAt, clientWriteId: id }) // eco realtime de la propia escritura
  }
  async insertRow(data: WorkspaceStore, updatedAt: string, id: string): Promise<WriteResult> {
    this.calls.push('insert')
    if (this.raw !== null) return { ok: false, conflict: true }
    this.store(data, updatedAt, id)
    return { ok: true, updatedAt }
  }
  async updateRow(data: WorkspaceStore, updatedAt: string, id: string, expected: string): Promise<WriteResult> {
    this.calls.push('update')
    this.expectedSeen.push(expected)
    if (this.raw === null || this.updatedAt !== expected) return { ok: false, conflict: true }
    this.store(data, updatedAt, id)
    return { ok: true, updatedAt }
  }
  subscribe(cb: (h: RemoteHint) => void) {
    this.listener = cb
    return () => {
      this.listener = null
    }
  }
  /** Escritura de otro dispositivo (p. ej. un Hub viejo que todavia escribe v1). */
  remoteWrite(raw: unknown, updatedAt: string) {
    this.raw = clone(raw)
    this.updatedAt = updatedAt
    this.clientWriteId = 'otro-dispositivo'
    this.listener?.({ updatedAt, clientWriteId: 'otro-dispositivo' })
  }
}

function makeEngine(cloud: RawCloud, clock: FakeClock, local: WorkspaceStore, store = new MemStore()) {
  const applied: WorkspaceStore[] = []
  const statuses: EngineStatus[] = []
  const notices: string[] = []
  let seq = 0
  const engine = new WorkspaceSyncEngine<WorkspaceStore>({
    userId: 'u1',
    adapter: cloud,
    store,
    initialLocal: local,
    onApplyRemote: (d) => applied.push(d),
    onStatus: (s) => statuses.push(s),
    onNotice: (n) => notices.push(n.message),
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newId: () => `w-${++seq}`,
    random: () => 0,
  })
  return { engine, applied, statuses, notices, store, last: () => statuses[statuses.length - 1] }
}

async function main() {
  console.log('Migracion v1 -> v2')

  await check('v1 -> v2: schemaVersion, songId, countInVoice/gapSec y voiceMap por defecto; resultado valido', () => {
    const m = migrateWorkspace(v1Workspace())
    assert.equal(m.schemaVersion, 2)
    for (const bandId of ['band_a', 'band_b']) {
      for (const it of items(m, bandId)) {
        assert.equal(typeof it.songId, 'string')
        assert.equal(it.countInVoice, true)
        assert.equal(it.gapSec, 0)
      }
      assert.deepEqual(m.voiceMap[bandId], defaultVoiceConfig())
    }
    const v = validateWorkspace(m)
    assert.deepEqual(v.errors, [])
    assert.equal(v.ok, true)
  })

  await check('empareja title/artist sin distinguir mayusculas ni espacios extremos (por banda)', () => {
    const m = migrateWorkspace(v1Workspace())
    const a = items(m, 'band_a')
    assert.equal(a[0].songId, a[1].songId, '"Medianoche" y "  MEDIANOCHE " / "banda a " son la misma cancion')
    assert.equal(a[2].songId, a[3].songId, '"Ruta" en dos setlists de la misma banda')
    assert.notEqual(a[0].songId, a[2].songId)
    assert.equal(m.songsMap.band_a.length, 2)
    const b = items(m, 'band_b')
    assert.notEqual(b[0].songId, a[0].songId, 'otra banda, otra libreria')
    assert.equal(m.songsMap.band_b.length, 1)
  })

  await check('la Song creada copia title, artist, bpm, key, camelot y durationSec; 4/4 y sin secciones', () => {
    const m = migrateWorkspace(v1Workspace())
    const [med, ruta] = m.songsMap.band_a
    assert.match(med.id, UUID_RE)
    assert.equal(med.id[14], '4', 'formato UUID v4')
    assert.deepEqual(
      { ...med, id: 'x' },
      { id: 'x', title: 'Medianoche', artist: 'Banda A', bpm: 124, beatsPerBar: 4, beatUnit: 4, key: 'Am', camelot: '8A', durationSec: 215, sections: [], updatedAt: '2026-09-15' }
    )
    assert.equal(ruta.bpm, 260, 'un BPM v1 fuera de rango se acota a 40..260 en la Song (el item conserva el suyo)')
    assert.equal(items(m, 'band_a')[2].bpm, 300)
    assert.equal(ruta.camelot, '7A')
  })

  await check('conserva campos desconocidos en raiz, banda, setlist e item', () => {
    const m = migrateWorkspace(v1Workspace()) as unknown as Rec
    assert.deepEqual(m.rootFuture, { keep: true })
    const ws = m as unknown as WorkspaceStore
    assert.equal((ws.bands[0] as unknown as Rec).bandFuture, 'x')
    assert.equal((ws.playlistsMap.band_a[0] as unknown as Rec).playlistFuture, 1)
    assert.equal((ws.playlistsMap.band_a[0].songs[0] as unknown as Rec).itemFuture, true)
  })

  await check('idempotente: migrar la salida devuelve el MISMO objeto', () => {
    const m = migrateWorkspace(v1Workspace())
    assert.equal(migrateWorkspace(m), m)
    assert.equal(stableStringify(migrateWorkspace(clone(m))), stableStringify(m))
  })

  await check('determinista: dos dispositivos que migran el mismo v1 obtienen el mismo v2', () => {
    assert.equal(stableStringify(migrateWorkspace(v1Workspace())), stableStringify(migrateWorkspace(v1Workspace())))
  })

  await check('no modifica la entrada', () => {
    const input = v1Workspace()
    const before = stableStringify(input)
    migrateWorkspace(input)
    assert.equal(stableStringify(input), before)
  })

  await check('nunca regenera ids: canciones existentes, secciones, items y songId presentes', () => {
    const input = v1Workspace() as unknown as Rec
    const existing = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      title: 'medianoche',
      artist: 'BANDA A',
      bpm: 120,
      beatsPerBar: 3,
      beatUnit: 4,
      key: 'Am',
      sections: [{ id: 's-keep', kind: 'verse', label: 'Estrofa', bars: 8, chordpro: '' }],
      updatedAt: '2026-09-01T00:00:00.000Z',
      songFuture: 'y',
    }
    input.songsMap = { band_a: [existing] }
    const pl = (input.playlistsMap as Rec).band_a as Array<Rec>
    ;(pl[0].songs as Array<Rec>)[2].songId = 'aaaaaaaa-0000-4000-8000-000000000001' // ya enlazado aunque el titulo difiera
    const m = migrateWorkspace(input as unknown as WorkspaceInput)
    const a = items(m, 'band_a')
    assert.deepEqual(
      a.map((it) => it.id),
      ['song_1', 'song_2', 'song_3', 'song_4']
    )
    assert.equal(a[0].songId, existing.id, 'empareja con la cancion existente')
    assert.equal(a[2].songId, existing.id, 'un songId presente no se toca')
    assert.deepEqual(m.songsMap.band_a[0], existing, 'la cancion existente queda intacta (id, secciones, campos extra)')
    assert.equal(m.songsMap.band_a.length, 2, 'solo se crea "Ruta" (para song_4)')
  })

  await check('v2 parcial: un Hub viejo agrego un item sin songId; solo se completa ese item', () => {
    const base = fixture()
    const v2 = clone(base) as unknown as Rec
    const songs = ((v2.playlistsMap as Rec).band_01 as Array<Rec>)[0].songs as Array<Rec>
    songs.push({ id: 'it_old', orderIndex: 2, title: 'segunda', artist: 'Banda de Prueba', bpm: 96, key: 'D', showKey: 'D', camelot: '', durationSec: 0, transitionMode: 'manual_cue', countInBars: 1 })
    const m = migrateWorkspace(v2 as unknown as WorkspaceInput)
    const out = m.playlistsMap.band_01[0].songs
    assert.equal(out[2].songId, '7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a02')
    assert.equal(out[2].countInVoice, true)
    assert.equal(out[2].gapSec, 0)
    assert.equal(out[0], (v2 as unknown as WorkspaceStore).playlistsMap.band_01[0].songs[0], 'los demas items conservan su referencia')
    assert.deepEqual(m.songsMap, (v2 as unknown as WorkspaceStore).songsMap, 'no se crea ninguna cancion')
    assert.equal(m.songsMap.band_01[0], (v2 as unknown as WorkspaceStore).songsMap.band_01[0], 'las canciones conservan su referencia')
  })

  await check('songId roto: se recrea la Song con ESE id (nunca uno nuevo)', () => {
    const v2 = fixture() as unknown as Rec
    ;(((v2.playlistsMap as Rec).band_01 as Array<Rec>)[0].songs as Array<Rec>)[1].songId = 'bbbbbbbb-0000-4000-8000-00000000000b'
    const m = migrateWorkspace(v2 as unknown as WorkspaceInput)
    const recreated = m.songsMap.band_01.find((s) => s.id === 'bbbbbbbb-0000-4000-8000-00000000000b')
    assert.ok(recreated)
    assert.equal(recreated?.title, 'Segunda')
    assert.equal(validateWorkspace(m).ok, true)
    assert.equal(migrateWorkspace(m), m)
  })

  await check('voiceMap existente (con campos extra) se conserva; schemaVersion > 2 no se toca', () => {
    const v2 = fixture() as unknown as Rec
    ;((v2.voiceMap as Rec).band_01 as Rec).futureVoice = 1
    const m = migrateWorkspace(v2 as unknown as WorkspaceInput)
    assert.equal(((m.voiceMap as unknown as Rec).band_01 as Rec).futureVoice, 1)
    const v3 = { ...v1Workspace(), schemaVersion: 3 } as unknown as WorkspaceInput
    assert.equal(migrateWorkspace(v3), v3)
  })

  await check('fecha de canciones creadas: la del setlist, o una fija si no hay', () => {
    const input = v1Workspace() as unknown as Rec
    const pls = (input.playlistsMap as Rec).band_b as Array<Rec>
    delete pls[0].updatedAt
    pls[0].createdAt = 'no-es-fecha'
    const m = migrateWorkspace(input as unknown as WorkspaceInput)
    assert.equal(m.songsMap.band_b[0].updatedAt, MIGRATION_EPOCH)
  })

  console.log('Fixture canonico (bandait-protocol/fixtures/workspace_v2.json)')

  await check('el fixture valida sin errores y la migracion no lo cambia', () => {
    const fx = fixture()
    const v = validateWorkspace(fx)
    assert.deepEqual(v.errors, [])
    if (v.warnings.length) console.log(`       advertencias: ${v.warnings.join(' | ')}`)
    assert.equal(migrateWorkspace(fx), fx)
  })

  await check('loadWorkspaceDocument quita _sync y no altera el resto', () => {
    const fx = fixture()
    const loaded = loadWorkspaceDocument({ ...clone(fx), _sync: { schema: 1, client_write_id: 'x' } })
    assert.ok(loaded)
    assert.equal('_sync' in (loaded as object), false)
    assert.equal(stableStringify(loaded), stableStringify(fx))
    assert.equal(loadWorkspaceDocument({ bands: [] }), null)
    assert.equal(loadWorkspaceDocument('texto'), null)
  })

  await check('compases: start_bar = 1 + suma de las anteriores, total y duracion estimada', () => {
    const song = fixture().songsMap.band_01[0]
    assert.deepEqual(sectionStartBars(song.sections), [1, 5, 13, 21])
    assert.equal(totalBars(song.sections), 24)
    assert.equal(songDurationSec(song), 48, '24 compases * 4 * 60 / 120')
    assert.equal(songDurationSec(song, 96), 60, 'con el BPM del show')
    assert.equal(estimateDurationSec(8, 3, 90), 16)
    assert.deepEqual(sectionStartBars([]), [])
    assert.equal(songDurationSec(fixture().songsMap.band_01[1]), null, 'sin secciones no hay final conocido')
  })

  await check('avisos de voz: ausente = por defecto, null = sin aviso, texto = ese texto, custom = label', () => {
    const [intro, , , outro] = fixture().songsMap.band_01[0].sections
    assert.equal(effectiveCueText(intro), 'Intro')
    assert.equal(effectiveCueText(outro), null)
    assert.equal(effectiveCueText({ kind: 'chorus', label: 'Coro final', cueText: 'Todos' }), 'Todos')
    assert.equal(effectiveCueText({ kind: 'pre_chorus', label: 'x' }), 'Pre coro')
    assert.equal(effectiveCueText({ kind: 'custom', label: 'Rap' }), 'Rap')
  })

  await check('transiciones: aviso cuando la anterior no tiene secciones', () => {
    const [withSections, without] = fixture().songsMap.band_01
    assert.equal(transitionEntryNotice(1, 'auto_count_in', withSections), null, 'it_02 del fixture entra bien')
    assert.equal(transitionEntryNotice(1, 'auto_count_in', without)?.level, 'warn')
    assert.equal(transitionEntryNotice(1, 'gapless', without)?.level, 'warn')
    assert.equal(transitionEntryNotice(1, 'gapless', null)?.level, 'warn')
    assert.equal(transitionEntryNotice(1, 'manual_cue', without), null)
    assert.equal(transitionEntryNotice(0, 'auto_count_in', null)?.level, 'info', 'el primero siempre espera PLAY')
    assert.equal(transitionEntryNotice(0, 'manual_cue', null), null)
  })

  await check('validacion: detecta cada regla rota', () => {
    const bad = fixture() as unknown as Rec
    const song = ((bad.songsMap as Rec).band_01 as Array<Rec>)[0]
    song.bpm = 300
    const secs = song.sections as Array<Rec>
    secs[0].bars = 0
    secs[1].kind = 'coro'
    secs[2].id = 's-01'
    secs[3].cueText = 5
    const its = ((bad.playlistsMap as Rec).band_01 as Array<Rec>)[0].songs as Array<Rec>
    its[0].songId = 'no-existe'
    its[0].countInBars = 5
    its[1].gapSec = 31
    its[1].countInVoice = 'si'
    const voice = (bad.voiceMap as Rec).band_01 as Rec
    voice.rate = '+60%'
    voice.cueLeadBars = 3
    voice.output = 'pa'
    bad.schemaVersion = 1
    const v = validateWorkspace(bad)
    const expectFragments = [
      'schemaVersion',
      '.bpm: debe estar entre',
      'sections[0].bars',
      'sections[1].kind',
      'sections[2].id: "s-01" repetido',
      'sections[3].cueText',
      'songs[0].songId: "no-existe"',
      'songs[0].countInBars',
      'songs[1].gapSec',
      'songs[1].countInVoice',
      'voiceMap.band_01.rate',
      'voiceMap.band_01.cueLeadBars',
      'voiceMap.band_01.output',
    ]
    for (const f of expectFragments) assert.ok(v.errors.some((e) => e.includes(f)), `falta el error "${f}" en ${JSON.stringify(v.errors)}`)
    assert.equal(v.ok, false)
  })

  await check('importar: acepta la exportacion del Hub y el documento suelto; rechaza la exportacion antigua', () => {
    const fx = fixture()
    const fromExport = parseImportedWorkspace({ formato: 'json', agrupacion: fx.bands[0], workspace: clone(fx) })
    assert.equal(fromExport.ok, true)
    const fromV1 = parseImportedWorkspace(v1Workspace())
    assert.equal(fromV1.ok && fromV1.workspace.schemaVersion, 2)
    const old = parseImportedWorkspace({ formato: 'json', agrupacion: fx.bands[0], setlists: [] })
    assert.equal(old.ok, false)
    assert.ok(!old.ok && old.error.includes('exportación antigua'))
    assert.equal(parseImportedWorkspace(42).ok, false)
  })

  await check('item de setlist desde la libreria: copia de respaldo y valores v2 por defecto', () => {
    const song = fixture().songsMap.band_01[0] as Song
    const it = playlistItemFromSong(song)
    assert.equal(it.songId, song.id)
    assert.equal(it.durationSec, 48)
    assert.equal(it.countInVoice, true)
    assert.equal(it.gapSec, 0)
    assert.equal(it.showKey, 'Am')
  })

  await check('deterministicUuid: formato v4/RFC 4122 y estable', () => {
    const a = deterministicUuid('semilla')
    assert.match(a, UUID_RE)
    assert.equal(a[14], '4')
    assert.ok('89ab'.includes(a[19]))
    assert.equal(deterministicUuid('semilla'), a)
    assert.notEqual(deterministicUuid('semilla2'), a)
  })

  console.log('Sincronizacion con datos migrados (ecos y conflictos)')

  await check('nube v1 + copia local migrada del mismo v1: en sincronia, CERO escrituras y sin respaldos', async () => {
    const clock = new FakeClock()
    const cloud = new RawCloud()
    cloud.raw = { ...v1Workspace(), _sync: { schema: 1, client_write_id: 'viejo' } }
    cloud.updatedAt = '2026-09-30T10:00:00.000+00:00'
    const store = new MemStore()
    store.set(syncMetaKey('u1'), JSON.stringify({ updatedAt: null, lastSyncedAt: '2026-09-30T10:00:00.000+00:00', dirty: false }))
    const local = loadWorkspaceDocument(v1Workspace()) as WorkspaceStore // migrada por separado, como al cargar localStorage
    const t = makeEngine(cloud, clock, local, store)
    t.engine.start()
    await clock.advance(10000)
    assert.equal(cloud.writes(), 0)
    assert.equal(t.applied.length, 0)
    assert.equal(t.engine.getBackups().length, 0)
    assert.equal(t.notices.length, 0)
    assert.equal(t.last().state, 'synced')
    assert.equal(t.engine.getMeta().dirty, false)
  })

  await check('nube v1 + local sin meta (primera vez en este navegador): sigue sin escribir', async () => {
    const clock = new FakeClock()
    const cloud = new RawCloud()
    cloud.raw = v1Workspace()
    cloud.updatedAt = '2026-09-30T10:00:00.000+00:00'
    const t = makeEngine(cloud, clock, loadWorkspaceDocument(v1Workspace()) as WorkspaceStore)
    t.engine.start()
    await clock.advance(10000)
    assert.equal(cloud.writes(), 0)
    assert.equal(t.engine.getMeta().lastSyncedAt, '2026-09-30T10:00:00.000+00:00')
  })

  await check('un Hub viejo escribe un item sin songId: se adopta migrado una vez, sin escribir ni entrar en bucle', async () => {
    const clock = new FakeClock()
    const cloud = new RawCloud()
    const v2 = migrateWorkspace(v1Workspace())
    cloud.raw = clone(v2)
    cloud.updatedAt = '2026-09-30T10:00:00.000+00:00'
    const store = new MemStore()
    store.set(syncMetaKey('u1'), JSON.stringify({ updatedAt: null, lastSyncedAt: cloud.updatedAt, dirty: false }))
    const t = makeEngine(cloud, clock, v2, store)
    t.engine.start()
    await clock.advance(5000)
    assert.equal(t.applied.length, 0)

    const fromOld = clone(v2) as unknown as Rec
    const firstList = ((fromOld.playlistsMap as Rec).band_a as Array<Rec>)[0].songs as Array<Rec>
    firstList.push({ id: 'song_9', orderIndex: 4, title: 'Nueva', artist: 'Banda A', bpm: 100, key: 'C', showKey: 'C', camelot: '', durationSec: 0, transitionMode: 'manual_cue', countInBars: 1 })
    cloud.remoteWrite(fromOld, '2026-09-30T11:00:00.000+00:00')
    await clock.advance(5000)
    assert.equal(t.applied.length, 1)
    const adopted = t.applied[0]
    const nueva = items(adopted, 'band_a').find((it) => it.id === 'song_9')
    assert.ok(nueva?.songId, 'el item llega con songId')
    assert.ok(adopted.songsMap.band_a.some((s) => s.id === nueva?.songId))

    t.engine.retryNow() // nueva descarga: la misma fila migrada da el mismo contenido
    await clock.advance(5000)
    assert.equal(t.applied.length, 1, 'no se vuelve a adoptar')
    assert.equal(cloud.writes(), 0, 'la migracion sola nunca sube nada')
    assert.equal(t.engine.getBackups().length, 0)
    assert.equal(t.notices.length, 0)
  })

  await check('la primera edicion real sube v2 completo con escritura condicional; el eco propio se ignora', async () => {
    const clock = new FakeClock()
    const cloud = new RawCloud()
    cloud.raw = v1Workspace()
    cloud.updatedAt = '2026-09-30T10:00:00.000+00:00'
    const local = loadWorkspaceDocument(v1Workspace()) as WorkspaceStore
    const t = makeEngine(cloud, clock, local)
    t.engine.start()
    await clock.advance(5000)
    assert.equal(cloud.writes(), 0)

    const edited = clone(local)
    edited.songsMap.band_a[0].sections = [{ id: 'sec-1', kind: 'intro', label: 'Intro', bars: 4, chordpro: '[Am]' }]
    t.engine.notifyLocalChange(edited)
    await clock.advance(5000)
    assert.deepEqual(cloud.calls.filter((c) => c !== 'fetch'), ['update'])
    assert.deepEqual(cloud.expectedSeen, ['2026-09-30T10:00:00.000+00:00'], 'update ... where updated_at = base conocida')
    const stored = cloud.raw as Rec
    assert.equal(stored.schemaVersion, 2)
    assert.equal(((stored._sync as Rec).client_write_id as string).startsWith('w-'), true)
    assert.equal(stableStringify(loadWorkspaceDocument(stored)), stableStringify(edited))
    assert.equal(t.applied.length, 0, 'el eco realtime de la propia escritura no se re-aplica')
    assert.equal(t.last().state, 'synced')
    await clock.advance(10000)
    assert.equal(cloud.writes(), 1, 'sin escrituras extra')
  })

  await check('cambios locales v1 pendientes + nube sin cambios: se suben ya migrados, sin respaldo', async () => {
    const clock = new FakeClock()
    const cloud = new RawCloud()
    cloud.raw = v1Workspace()
    cloud.updatedAt = '2026-09-30T10:00:00.000+00:00'
    const store = new MemStore()
    store.set(syncMetaKey('u1'), JSON.stringify({ updatedAt: '2026-09-30T10:30:00.000Z', lastSyncedAt: cloud.updatedAt, dirty: true }))
    const pending = v1Workspace() as unknown as Rec
    ;((pending.bands as Array<Rec>)[0]).name = 'Banda A (renombrada offline)'
    const t = makeEngine(cloud, clock, loadWorkspaceDocument(pending) as WorkspaceStore, store)
    t.engine.start()
    await clock.advance(5000)
    assert.equal(cloud.writes(), 1)
    assert.equal((cloud.raw as Rec).schemaVersion, 2)
    assert.equal(t.engine.getBackups().length, 0)
  })

  await check('dos dispositivos migran el mismo v1; uno edita y el otro adopta sin conflicto', async () => {
    const clock = new FakeClock()
    const cloud = new RawCloud()
    cloud.raw = v1Workspace()
    cloud.updatedAt = '2026-09-30T10:00:00.000+00:00'
    const a = makeEngine(cloud, clock, loadWorkspaceDocument(v1Workspace()) as WorkspaceStore)
    const bLocal = loadWorkspaceDocument(v1Workspace()) as WorkspaceStore
    a.engine.start()
    await clock.advance(3000)
    const edited = clone(bLocal)
    edited.voiceMap.band_a = { ...edited.voiceMap.band_a, enabled: true }
    // B arranca y edita; A recibe el aviso realtime de B.
    const bCloudView = cloud
    const b = makeEngine(bCloudView, clock, bLocal)
    b.engine.start()
    await clock.advance(3000)
    b.engine.notifyLocalChange(edited)
    await clock.advance(5000)
    assert.equal(cloud.writes(), 1)
    // A no recibe el eco (cada motor tiene su propio listener en este falso): forzar la descarga.
    a.engine.retryNow()
    await clock.advance(3000)
    assert.equal(a.applied.length, 1)
    assert.equal(a.applied[0].voiceMap.band_a.enabled, true)
    assert.equal(a.engine.getBackups().length + b.engine.getBackups().length, 0)
    assert.equal(a.notices.length + b.notices.length, 0)
    assert.equal(cloud.writes(), 1)
  })

  console.log('ChordPro')

  await check('ChordPro en espanol con entornos, {chorus} y metadatos', () => {
    const r = parseChordProSong(
      [
        '{title: Hoy Vuelvo}',
        '{artist: Banda de Prueba}',
        '{key: Am}',
        '{tempo: 96}',
        '{start_of_verse: Estrofa 1}',
        '[Am]Hoy vuelvo a [F]casa',
        '[C]con la noche en [G]calma',
        '{end_of_verse}',
        '',
        '{soc}',
        '[F]Canta [G]fuerte, [Am]canta',
        '{eoc}',
        '',
        '{sov}',
        '[Am]Segunda [F#m7]vuelta',
        '{eov}',
        '{start_of_bridge}',
        '[Dm]Puente [E7]aquí',
        '{end_of_bridge}',
        '{chorus}',
      ].join('\r\n')
    )
    assert.equal(r.title, 'Hoy Vuelvo')
    assert.equal(r.artist, 'Banda de Prueba')
    assert.equal(r.key, 'Am')
    assert.equal(r.bpm, 96)
    assert.deepEqual(
      r.sections.map((s) => [s.kind, s.label, s.bars]),
      [
        ['verse', 'Estrofa 1', 8],
        ['chorus', 'Coro', 8],
        ['verse', 'Estrofa 2', 8],
        ['bridge', 'Puente', 8],
        ['chorus', 'Coro', 8],
      ]
    )
    assert.equal(r.sections[0].chordpro, '[Am]Hoy vuelvo a [F]casa\n[C]con la noche en [G]calma')
    assert.equal(r.sections[2].chordpro, '[Am]Segunda [F#m7]vuelta', 'acordes en linea intactos')
    assert.equal(r.sections[4].chordpro, r.sections[1].chordpro, '{chorus} repite el ultimo coro')
    assert.ok(r.sections.every((s) => !s.chordpro.includes('{')), 'sin directivas en los cuerpos')
  })

  await check('encabezados en texto plano en espanol: [Coro], Coro:, ESTROFA 1, Intro, Pre coro, Puente, Solo, Final', () => {
    const r = parseChordProSong(
      [
        'Intro: [Am] [F] [C] [G]',
        '',
        'ESTROFA 1',
        '[Am]Hoy vuelvo a [F]casa',
        '',
        'Pre coro',
        '[Dm]Ya casi',
        '',
        '[Coro]',
        '[F]Canta [G]fuerte',
        '',
        'Puente:',
        '[Dm]Un puente',
        '',
        'Solo',
        '[Am] [F]',
        '',
        'Coro final',
        '[F]Canta otra vez',
        '',
        'Final',
        '[Am]',
      ].join('\n')
    )
    assert.deepEqual(
      r.sections.map((s) => [s.kind, s.label]),
      [
        ['intro', 'Intro'],
        ['verse', 'Estrofa 1'],
        ['pre_chorus', 'Pre coro'],
        ['chorus', 'Coro'],
        ['bridge', 'Puente'],
        ['solo', 'Solo'],
        ['chorus', 'Coro final'],
        ['outro', 'Final'],
      ]
    )
    assert.equal(r.sections[0].chordpro, '[Am] [F] [C] [G]', 'contenido en la misma linea del encabezado')
    assert.equal(r.sections[1].chordpro, '[Am]Hoy vuelvo a [F]casa')
    assert.equal(r.title, null)
  })

  await check('ChordPro en ingles: {t:}, Verse 1, Chorus:, {c: Bridge}, Outro', () => {
    const r = parseChordProSong(
      ['{t: Midnight}', '{artist: Test Band}', 'Verse 1', '[G]Walking down the [D]road', 'Chorus:', '[C]Sing it [G]loud', '{c: Bridge}', '[Em]Over the [C]hill', '{c: repeat twice}', 'Outro', '[G]'].join('\n')
    )
    assert.equal(r.title, 'Midnight')
    assert.equal(r.artist, 'Test Band')
    assert.deepEqual(
      r.sections.map((s) => [s.kind, s.label]),
      [
        ['verse', 'Verse 1'],
        ['chorus', 'Chorus'],
        ['bridge', 'Bridge'],
        ['outro', 'Outro'],
      ]
    )
    assert.equal(r.sections[2].chordpro, '[Em]Over the [C]hill\n{c: repeat twice}', 'un comentario que no es encabezado se conserva')
  })

  await check('cancion sin encabezados: una sola seccion "custom"', () => {
    const text = '[Am]Una sola [F]letra\n[C]sin encabezados\n\n[G]otra estrofa sin título'
    const r = parseChordProSong(`\n${text}\n\n`)
    assert.equal(r.sections.length, 1)
    assert.deepEqual(r.sections[0], { kind: 'custom', label: 'Letra', bars: 8, chordpro: text, cueText: null })
    assert.equal(parseChordProSong('   \n\n').sections.length, 0)
  })

  await check('contenido sin encabezado tras un entorno: estrofa; solo acordes al inicio: intro', () => {
    const r = parseChordProSong('[Am] [F]\n{soc}\n[F]Coro aquí\n{eoc}\n[C]Verso sin título')
    assert.deepEqual(
      r.sections.map((s) => [s.kind, s.label]),
      [
        ['intro', 'Intro'],
        ['chorus', 'Coro'],
        ['verse', 'Estrofa 1'],
      ]
    )
  })

  await check('lineas de letra que empiezan como encabezado no se confunden', () => {
    assert.equal(matchPlainHeading('Solo quiero verte'), null)
    assert.equal(matchPlainHeading('Final feliz para los dos'), null)
    assert.equal(matchPlainHeading('[Am]'), null)
    assert.equal(matchPlainHeading('[Am]Coro de voces'), null)
    assert.equal(matchPlainHeading('Ella dijo: ven'), null)
    assert.deepEqual(classifyHeading('Solo de guitarra', true), { kind: 'solo', label: 'Solo de guitarra' })
    assert.equal(classifyHeading('Solo de guitarra', false), null)
    assert.deepEqual(classifyHeading('ESTRIBILLO 2', false), { kind: 'chorus', label: 'Estribillo 2' })
    assert.deepEqual(classifyHeading('Introducción', false), { kind: 'intro', label: 'Introducción' })
  })

  await check('vista previa: acordes alineados encima de su silaba', () => {
    const a = layoutChordLine('[Am]Hoy vuelvo a [F]casa')
    assert.equal(a.lyrics, 'Hoy vuelvo a casa')
    assert.equal(a.chords.indexOf('Am'), 0)
    assert.equal(a.chords.indexOf('F'), a.lyrics.indexOf('casa'))
    const b = layoutChordLine('[Am]Ho[F#m7]y')
    assert.equal(b.chords, 'Am F#m7', 'un acorde largo no pisa al siguiente')
    assert.equal(b.chords.indexOf('F#m7'), b.lyrics.indexOf('y'))
    assert.deepEqual(layoutChordLine('sin acordes'), { chords: '', lyrics: 'sin acordes' })
    assert.deepEqual(
      layoutChordPro('{c: Repetir}\n\n[G]x').map((l) => l.type),
      ['comment', 'blank', 'pair']
    )
  })

  console.log(`\n${passed} ok, ${failures.length} fallas`)
  if (failures.length > 0) process.exit(1)
}

void main()
