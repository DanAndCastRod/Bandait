/**
 * Colaboracion del Estudio y versiones del workspace (correcciones de la revision de la ola 3):
 *   - canal Realtime compartido con conteo de referencias frente a un cliente falso que deduplica
 *     por topic como realtime-js (ciclo lista -> sesion -> lista);
 *   - fusion de 3 vias: base nula (union), borrado frente a edicion, pistas reordenadas, audios
 *     nuevos de los dos lados, notas por tono y comienzo, efectos por tipo, choques y fallo de
 *     validacion (StudioMergeConflictError, nunca `local` en silencio);
 *   - vcsMap: ids unicos, tope por entidad, tope en bytes y limpieza al borrar.
 *
 *   node --experimental-strip-types --no-warnings scripts/verify-studio-collab.ts
 */
import assert from 'node:assert/strict'
import sessionFixtureV2 from '../../bandait-protocol/fixtures/studio_session_v2.json' with { type: 'json' }
import type { Song, WorkspaceStore } from '../src/types/hub.ts'
import {
  STUDIO_MAX_TRACKS,
  defaultFx,
  parseSession,
  validateSession,
  type StudioAsset,
  type StudioClip,
  type StudioFx,
  type StudioMidiClip,
  type StudioSession,
  type StudioTrack,
} from '../src/services/studio/session.ts'
import {
  StudioMergeConflictError,
  createStudioCollabChannel,
  mergeCollaborativeSession,
  mergeCollaborativeSessionDetailed,
  studioCollabSubscriberCount,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type StudioCollabEvent,
  type StudioCollaboratorPresence,
} from '../src/services/studio/studioCollab.ts'
import {
  MAX_ENTITY_COMMITS,
  commitEntitySnapshot,
  getBandVcs,
  pruneBandVcs,
  pruneWorkspaceVcs,
  withSongHistory,
  type EcosystemBandVcs,
} from '../src/services/versionControl.ts'

let passed = 0
const failures: string[] = []

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`ok - ${name}`)
  } catch (err) {
    failures.push(name)
    console.error(`FALLO - ${name}`)
    console.error(err)
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// Cliente Realtime falso: deduplica por topic y no se vuelve a unir si ya esta unido
// ---------------------------------------------------------------------------

class FakeChannel implements RealtimeChannelLike {
  state: 'closed' | 'joining' | 'joined' = 'closed'
  removed = false
  tracked: Record<string, unknown> | null = null
  sent: Record<string, unknown>[] = []
  remotePresence: Record<string, unknown[]> = {}
  subscribeCalls = 0
  private bindings: Array<{ type: string; event: string; cb: (arg: { payload?: unknown }) => void }> = []
  readonly topic: string
  readonly presenceKey: string
  constructor(topic: string, presenceKey: string) {
    this.topic = topic
    this.presenceKey = presenceKey
  }
  on(type: 'broadcast' | 'presence', filter: { event: string }, cb: (arg: { payload?: unknown }) => void): RealtimeChannelLike {
    // realtime-js: no admite manejadores de presencia despues de subscribe().
    if (type === 'presence' && this.state !== 'closed') throw new Error('cannot add presence callbacks after subscribe()')
    this.bindings.push({ type, event: filter.event, cb })
    return this
  }
  subscribe(cb?: (status: string) => void): RealtimeChannelLike {
    this.subscribeCalls++
    // realtime-js: si ya esta unido (o uniendose) no hace nada y el callback NUNCA se llama.
    if (this.state !== 'closed') return this
    this.state = 'joining'
    queueMicrotask(() => {
      if (this.state !== 'joining') return
      this.state = 'joined'
      cb?.('SUBSCRIBED')
    })
    return this
  }
  track(payload: Record<string, unknown>): Promise<unknown> {
    if (this.state !== 'joined') return Promise.reject(new Error('no unido'))
    this.tracked = payload
    this.sync()
    return Promise.resolve('ok')
  }
  send(args: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): Promise<unknown> {
    if (this.state !== 'joined') return Promise.resolve('error')
    this.sent.push(args.payload)
    return Promise.resolve('ok')
  }
  presenceState(): Record<string, unknown[]> {
    return { ...this.remotePresence, ...(this.tracked ? { [this.presenceKey]: [this.tracked] } : {}) }
  }
  unsubscribe(): Promise<unknown> {
    this.state = 'closed'
    return Promise.resolve('ok')
  }
  deliver(payload: Record<string, unknown>): void {
    for (const b of this.bindings) if (b.type === 'broadcast' && b.event === 'studio_event') b.cb({ payload })
  }
  sync(): void {
    for (const b of this.bindings) if (b.type === 'presence' && b.event === 'sync') b.cb({})
  }
}

class FakeClient implements RealtimeClientLike {
  channels: FakeChannel[] = []
  created = 0
  channel(name: string, opts?: { config?: { presence?: { key?: string } } }): RealtimeChannelLike {
    const topic = `realtime:${name}`
    const existing = this.channels.find((c) => c.topic === topic)
    if (existing) return existing // RealtimeClient.channel deduplica por topic
    const created = new FakeChannel(topic, opts?.config?.presence?.key ?? '')
    this.channels.push(created)
    this.created++
    return created
  }
  removeChannel(channel: RealtimeChannelLike): Promise<unknown> {
    const ch = channel as FakeChannel
    void ch.unsubscribe()
    ch.removed = true
    this.channels = this.channels.filter((c) => c !== ch)
    return Promise.resolve('ok')
  }
}

const presence = (sessionId: string | null) => ({ userId: 'u_daniel', name: 'Daniel', role: 'Owner', sessionId, branch: 'main', selectedTrackId: null })

await check('Realtime: lista y controlador comparten el canal de la banda; se cierra con el ultimo suscriptor', async () => {
  const client = new FakeClient()
  const listEvents: StudioCollabEvent[] = []
  const ctrlEvents: StudioCollabEvent[] = []
  let ctrlPeers: StudioCollaboratorPresence[] = []

  // 1) Lista de sesiones.
  const list = createStudioCollabChannel({ client, bandId: 'band_1', initialPresence: presence(null), onEvent: (e) => listEvents.push(e) })
  await tick()
  const channel = client.channels[0]
  assert.equal(channel.state, 'joined')
  assert.equal(channel.tracked?.sessionId, null)

  // 2) Se abre una sesion: el controlador pide el mismo topic y recibe la MISMA instancia, ya unida.
  const ctrl = createStudioCollabChannel({
    client, bandId: 'band_1', initialPresence: presence('ses_1'),
    onEvent: (e) => ctrlEvents.push(e), onPeersChange: (p) => { ctrlPeers = p },
  })
  assert.equal(client.created, 1, 'un solo canal por banda')
  assert.equal(channel.subscribeCalls, 1, 'no se vuelve a suscribir un canal ya unido')
  assert.equal(channel.tracked?.sessionId, 'ses_1', 'la presencia publicada es la del controlador (sin esperar un SUBSCRIBED que no llega)')
  ctrl.broadcast({ type: 'session_saved', sessionId: 'ses_1', etag: 'e1', senderId: 'u_daniel', updatedAt: '' })
  assert.equal(channel.sent.length, 1, 'el controlador puede emitir: el canal ya estaba unido')

  // 3) La lista se desmonta: el canal compartido sigue vivo para el controlador.
  list.dispose()
  assert.equal(channel.removed, false)
  assert.equal(channel.state, 'joined')
  assert.equal(studioCollabSubscriberCount(client, 'band_1'), 1)
  channel.deliver({ type: 'session_saved', sessionId: 'ses_1', etag: 'e2', senderId: 'u_bajo', updatedAt: '' })
  channel.deliver({ type: 'session_saved', sessionId: 'ses_1', etag: 'e3', senderId: 'u_daniel', updatedAt: '' })
  assert.equal(ctrlEvents.length, 1, 'recibe los eventos de los demas, no los propios')
  assert.equal(listEvents.length, 0)

  // 4) Presencia de otros: la propia no se cuenta.
  channel.remotePresence = {
    u_bajo: [{ userId: 'u_bajo', name: 'Bajo', role: 'Musician', sessionId: 'ses_1' }],
    u_voz: [{ userId: 'u_voz', name: 'Voz', role: 'Musician', sessionId: null }],
  }
  channel.sync()
  assert.deepEqual(ctrlPeers.map((p) => [p.userId, p.sessionId]).sort(), [['u_bajo', 'ses_1'], ['u_voz', null]])

  // 5) Volver a la lista: la lista se suscribe ANTES de que el controlador se cierre.
  const list2 = createStudioCollabChannel({ client, bandId: 'band_1', initialPresence: presence(null), onEvent: (e) => listEvents.push(e) })
  assert.equal(channel.tracked?.sessionId, null, 'publica la presencia del ultimo suscriptor')
  ctrl.dispose()
  assert.equal(channel.removed, false, 'cerrar el controlador no cierra el canal de la lista')
  assert.equal(channel.tracked?.sessionId, null)
  channel.deliver({ type: 'session_catalog_changed', sessionId: 'ses_2', senderId: 'u_bajo', title: 'Nueva' })
  assert.equal(listEvents.length, 1)

  // 6) Se va el ultimo: ahora si se quita el canal; el siguiente crea uno nuevo y se une.
  list2.dispose()
  list2.dispose()
  assert.equal(channel.removed, true)
  assert.equal(client.channels.length, 0)
  assert.equal(studioCollabSubscriberCount(client, 'band_1'), 0)
  const again = createStudioCollabChannel({ client, bandId: 'band_1', initialPresence: presence(null) })
  await tick()
  assert.equal(client.created, 2)
  assert.equal(client.channels[0].state, 'joined')
  again.dispose()
})

await check('Realtime: el controlador que llega mientras el canal se une recibe SUBSCRIBED por el canal compartido', async () => {
  const client = new FakeClient()
  const list = createStudioCollabChannel({ client, bandId: 'band_2', initialPresence: presence(null) })
  const ctrl = createStudioCollabChannel({ client, bandId: 'band_2', initialPresence: presence('ses_9') })
  await tick()
  const channel = client.channels[0]
  assert.equal(channel.tracked?.sessionId, 'ses_9')
  list.dispose()
  ctrl.broadcast({ type: 'vcs_updated', sessionId: 'ses_9', branch: 'main', commitId: 'cmt_1', senderId: 'u_daniel' })
  assert.equal(channel.sent.length, 1)
  ctrl.dispose()
  assert.equal(channel.removed, true)
  // Banda personal o sin cliente: no abre nada.
  const none = createStudioCollabChannel({ client, bandId: 'me', initialPresence: presence(null) })
  none.broadcast({ type: 'vcs_updated', sessionId: 'x', branch: 'main', commitId: 'c', senderId: 'u' })
  none.dispose()
  assert.equal(client.created, 1)
})

// ---------------------------------------------------------------------------
// Fusion de 3 vias
// ---------------------------------------------------------------------------

const base = (): StudioSession => parseSession(structuredClone(sessionFixtureV2))
const track = (s: StudioSession, id: string): StudioTrack => s.tracks.find((t) => t.id === id)!
const withTrack = (s: StudioSession, id: string, patch: Partial<StudioTrack>): StudioSession => ({
  ...s,
  tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
})
const newAsset = (s: StudioSession, id: string): StudioAsset => ({ ...s.assets[0], id, file: `${id}.wav`, label: id })
const audioClipOf = (s: StudioSession): StudioClip => track(s, 'trk_1').clips[0]
const midiClipOf = (s: StudioSession, trackId: string): StudioMidiClip => track(s, trackId).midiClips[0]
const withMidiClip = (s: StudioSession, trackId: string, patch: Partial<StudioMidiClip>): StudioSession => {
  const t = track(s, trackId)
  return withTrack(s, trackId, { midiClips: t.midiClips.map((c, i) => (i === 0 ? { ...c, ...patch } : c)) })
}

await check('fusion: con base nula une los dos lados (nada que solo exista en el remoto se pierde)', () => {
  const b = base()
  const localTrack: StudioTrack = { ...track(b, 'trk_1'), id: 'trk_local', name: 'Guitarra local', clips: [{ ...audioClipOf(b), id: 'clp_local' }] }
  const local: StudioSession = { ...b, tracks: [...b.tracks.filter((t) => t.id !== 'trk_4'), localTrack] }
  const remoteAsset = newAsset(b, 'ast_remoto')
  const remoteTrack: StudioTrack = { ...track(b, 'trk_1'), id: 'trk_remoto', name: 'Coros', clips: [{ ...audioClipOf(b), id: 'clp_remoto', assetId: 'ast_remoto' }] }
  const remote: StudioSession = {
    ...b,
    assets: [...b.assets, remoteAsset],
    tracks: [...b.tracks, remoteTrack],
    markers: [...b.markers, { id: 'mrk_remoto', beat: 64, label: 'Puente', kind: b.markers[0].kind }],
  }
  const merged = mergeCollaborativeSession(null, local, remote)
  const ids = merged.tracks.map((t) => t.id)
  assert.ok(ids.includes('trk_local'), 'la pista local se conserva')
  assert.ok(ids.includes('trk_remoto'), 'la pista solo remota se conserva (antes se descartaba)')
  assert.ok(ids.includes('trk_4'), 'sin base no se puede saber si local la borro: union, no borrado')
  assert.ok(merged.markers.some((m) => m.id === 'mrk_remoto'))
  assert.ok(merged.assets.some((a) => a.id === 'ast_remoto'))
  validateSession(merged)
})

await check('fusion: borrado contra edicion (gana la edicion) y borrado sin edicion (se borra)', () => {
  const b = base()
  const local: StudioSession = { ...b, tracks: b.tracks.filter((t) => t.id !== 'trk_4') }
  const remoteEdited = withTrack(b, 'trk_4', { volumeDb: -7 })
  const kept = mergeCollaborativeSession(b, local, remoteEdited)
  assert.equal(track(kept, 'trk_4')?.volumeDb, -7, 'la edicion remota sobrevive al borrado local')
  const gone = mergeCollaborativeSession(b, local, withTrack(b, 'trk_1', { pan: 0.2 }))
  assert.ok(!gone.tracks.some((t) => t.id === 'trk_4'), 'sin edicion del otro lado, el borrado se respeta')
  assert.equal(track(gone, 'trk_1').pan, 0.2)
})

await check('fusion: pistas reordenadas (manda el lado que reordeno) sin perder ediciones', () => {
  const b = base()
  const reordered = (s: StudioSession) => ({ ...s, tracks: [track(s, 'trk_2'), track(s, 'trk_1'), track(s, 'trk_3'), track(s, 'trk_4')] })
  const m1 = mergeCollaborativeSession(b, reordered(b), withTrack(b, 'trk_3', { pan: -0.5 }))
  assert.deepEqual(m1.tracks.map((t) => t.id), ['trk_2', 'trk_1', 'trk_3', 'trk_4'])
  assert.equal(track(m1, 'trk_3').pan, -0.5)
  const m2 = mergeCollaborativeSession(b, withTrack(b, 'trk_3', { pan: 0.5 }), reordered(b))
  assert.deepEqual(m2.tracks.map((t) => t.id), ['trk_2', 'trk_1', 'trk_3', 'trk_4'], 'local no reordeno: manda el orden remoto')
  assert.equal(track(m2, 'trk_3').pan, 0.5)
})

await check('fusion: audios y clips nuevos de los dos lados quedan todos', () => {
  const b = base()
  const clip = audioClipOf(b)
  const local: StudioSession = {
    ...b,
    assets: [...b.assets, newAsset(b, 'ast_l')],
    tracks: b.tracks.map((t) => (t.id === 'trk_1' ? { ...t, clips: [...t.clips, { ...clip, id: 'clp_l', assetId: 'ast_l', startS: 100 }] } : t)),
  }
  const remote: StudioSession = {
    ...b,
    assets: [...b.assets, newAsset(b, 'ast_r')],
    tracks: b.tracks.map((t) => (t.id === 'trk_1' ? { ...t, clips: [...t.clips, { ...clip, id: 'clp_r', assetId: 'ast_r', startS: 200 }] } : t)),
  }
  const merged = mergeCollaborativeSession(b, local, remote)
  assert.ok(merged.assets.some((a) => a.id === 'ast_l') && merged.assets.some((a) => a.id === 'ast_r'))
  assert.deepEqual(track(merged, 'trk_1').clips.map((c) => c.id).sort(), ['clp_1', 'clp_l', 'clp_r'])
})

await check('fusion: notas por tono y comienzo (no el clip entero) con solapes recortados', () => {
  const b = base()
  const clip = midiClipOf(b, 'trk_2')
  const localNotes = clip.notes.map((n, i) => (i === 0 ? { ...n, velocity: 110 } : n))
  localNotes.push({ pitch: 100, start: 1, length: 2, velocity: 80 })
  const remoteNotes = [...clip.notes, { pitch: 100, start: 2, length: 1, velocity: 70 }, { pitch: 30, start: 4, length: 1, velocity: 64 }]
  const merged = mergeCollaborativeSession(b, withMidiClip(b, 'trk_2', { notes: localNotes }), withMidiClip(b, 'trk_2', { notes: remoteNotes }))
  const notes = midiClipOf(merged, 'trk_2').notes
  assert.equal(notes.length, clip.notes.length + 3, 'las notas nuevas de los dos lados entran')
  assert.equal(notes.find((n) => n.pitch === clip.notes[0].pitch && n.start === clip.notes[0].start)?.velocity, 110)
  const p100 = notes.filter((n) => n.pitch === 100)
  assert.deepEqual(p100.map((n) => [n.start, n.length]), [[1, 1], [2, 1]], 'el solape del mismo tono se recorta')
  validateSession(merged)
})

await check('fusion: efectos por tipo (cadena) y limitador del master de ultimo', () => {
  const b = base()
  const comp = track(b, 'trk_3').fx[0]
  const localComp = { ...comp, params: { ...(comp.params as unknown as Record<string, number>), thresholdDb: -20 } } as unknown as StudioFx
  const local = withTrack({ ...b, master: { ...b.master, fx: [defaultFx('eq'), ...b.master.fx] } }, 'trk_3', { fx: [localComp] })
  const limiter = b.master.fx[0]
  const remoteLimiter = { ...limiter, params: { ...(limiter.params as unknown as Record<string, number>), ceilingDb: -2 } } as unknown as StudioFx
  const remote = withTrack({ ...b, master: { ...b.master, fx: [remoteLimiter] } }, 'trk_3', { fx: [comp, defaultFx('eq')] })
  const merged = mergeCollaborativeSession(b, local, remote)
  const fx = track(merged, 'trk_3').fx
  assert.deepEqual(fx.map((f) => f.type), ['compressor', 'eq'])
  assert.equal((fx[0].params as unknown as Record<string, number>).thresholdDb, -20, 'parametro local del compresor')
  assert.deepEqual(merged.master.fx.map((f) => f.type), ['eq', 'limiter'])
  assert.equal((merged.master.fx[1].params as unknown as Record<string, number>).ceilingDb, -2, 'techo remoto del limitador')
})

await check('fusion: un ajuste cambiado distinto en los dos lados se informa como choque (se conserva el local)', () => {
  const b = base()
  const result = mergeCollaborativeSessionDetailed(b, withTrack(b, 'trk_1', { volumeDb: -3 }), withTrack(b, 'trk_1', { volumeDb: -9, pan: 0.3 }))
  assert.equal(track(result.session, 'trk_1').volumeDb, -3)
  assert.equal(track(result.session, 'trk_1').pan, 0.3)
  assert.deepEqual(result.conflicts, ['tracks[trk_1].volumeDb'])
  const clean = mergeCollaborativeSessionDetailed(b, withTrack(b, 'trk_1', { volumeDb: -3 }), withTrack(b, 'trk_2', { volumeDb: -9 }))
  assert.deepEqual(clean.conflicts, [])
})

await check('fusion: si el resultado no valida lanza StudioMergeConflictError (nunca devuelve local en silencio)', () => {
  const b = base()
  const extra = (prefix: string, n: number): StudioTrack[] =>
    Array.from({ length: n }, (_, i) => ({ ...track(b, 'trk_2'), id: `${prefix}_${i}`, midiClips: [{ ...midiClipOf(b, 'trk_2'), id: `${prefix}_clip_${i}` }] }))
  const room = STUDIO_MAX_TRACKS - b.tracks.length
  const local = { ...b, tracks: [...b.tracks, ...extra('trl', room)] }
  const remote = { ...b, tracks: [...b.tracks, ...extra('trr', room)] }
  validateSession(local)
  validateSession(remote)
  assert.throws(() => mergeCollaborativeSession(b, local, remote), StudioMergeConflictError)
  // Notas: cada lado valido por si solo, juntos pasan del tope por clip.
  const clip = midiClipOf(b, 'trk_2')
  const many = (pitch: number) => Array.from({ length: 2100 }, (_, i) => ({ pitch, start: i * 0.0625, length: 0.03125, velocity: 90 }))
  const bl = withMidiClip(b, 'trk_2', { lengthBeats: 256, loopBeats: 256 })
  const l2 = withMidiClip(bl, 'trk_2', { notes: [...clip.notes, ...many(20)] })
  const r2 = withMidiClip(bl, 'trk_2', { notes: [...clip.notes, ...many(21)] })
  validateSession(l2)
  validateSession(r2)
  assert.throws(() => mergeCollaborativeSession(bl, l2, r2), StudioMergeConflictError)
})

// ---------------------------------------------------------------------------
// vcsMap del workspace
// ---------------------------------------------------------------------------

const song = (id: string, extra = ''): Song => ({
  id,
  title: `Tema ${id}`,
  artist: 'Bandait',
  bpm: 120,
  beatsPerBar: 4,
  beatUnit: 4,
  key: 'Am',
  sections: [{ id: 'sec_1', kind: 'verse', label: 'Estrofa', bars: 8, chordpro: `[Am]Letra ${extra}` }],
  updatedAt: '2026-11-27T00:00:00.000Z',
})

const workspace = (songs: Song[], vcs?: EcosystemBandVcs): WorkspaceStore =>
  ({
    schemaVersion: 2,
    activeBandId: 'b_1',
    bands: [{ id: 'b_1', name: 'Banda' }],
    membersMap: {},
    playlistsMap: { b_1: [] },
    equipmentMap: {},
    stemsMap: {},
    songsMap: { b_1: songs },
    voiceMap: {},
    ...(vcs ? { vcsMap: { b_1: vcs } } : {}),
  }) as unknown as WorkspaceStore

await check('vcsMap: ids unicos aunque se repita el instante, y 12 commits por entidad', () => {
  let history = undefined as ReturnType<typeof commitEntitySnapshot<Song>>['history'] | undefined
  const ids = new Set<string>()
  for (let i = 0; i < 60; i++) {
    const { history: next, commit } = commitEntitySnapshot({ history, snapshot: song('s1', String(i)), message: `v${i}`, nowIso: '2026-11-27T10:00:00.000Z' })
    assert.ok(!ids.has(commit.id), `id repetido: ${commit.id}`)
    ids.add(commit.id)
    history = next
  }
  assert.ok(history)
  let ws = withSongHistory(workspace([song('s1')]), 'b_1', 's1', history)
  assert.equal(getBandVcs(ws, 'b_1').songs.s1.commits.length, MAX_ENTITY_COMMITS)
  ws = withSongHistory(ws, 'b_1', 's1', getBandVcs(ws, 'b_1').songs.s1)
  assert.equal(getBandVcs(ws, 'b_1').songs.s1.commits.length, MAX_ENTITY_COMMITS)
})

await check('vcsMap: borrar la cancion borra su historial; el lector tolera commits rotos', () => {
  const { history } = commitEntitySnapshot<Song>({ history: undefined, snapshot: song('s1'), message: 'v1' })
  const ws = withSongHistory(workspace([song('s1'), song('s2')]), 'b_1', 's1', history)
  assert.ok(getBandVcs(ws, 'b_1').songs.s1)
  const deleted = pruneWorkspaceVcs({ ...ws, songsMap: { b_1: [song('s2')] } })
  assert.equal(getBandVcs(deleted, 'b_1').songs.s1, undefined)
  assert.deepEqual(deleted.vcsMap, {}, 'una banda sin historiales no deja una clave vacia')
  const broken = workspace([song('s1')], {
    songs: {
      s1: { activeBranch: 'main', branches: { main: 'v_ok', vivo: 'v_fantasma' }, commits: [{ id: 'v_ok', branch: 'main', parentId: null, message: 'ok', authorName: 'Daniel', createdAt: '2026-11-27T00:00:00Z', snapshot: song('s1') }, { id: '', branch: 'main' } as never] },
      s2: { nada: true } as never,
    },
    playlists: {},
  })
  const read = getBandVcs(broken, 'b_1')
  assert.equal(read.songs.s1.commits.length, 1)
  assert.deepEqual(read.songs.s1.branches, { main: 'v_ok' })
  assert.equal(read.songs.s2, undefined)
})

await check('vcsMap: el tope en bytes expulsa primero lo viejo que no es cabeza y deja la banda bajo el tope', () => {
  let bandVcs: EcosystemBandVcs = { songs: {}, playlists: {} }
  const big = 'x'.repeat(4000)
  for (let s = 0; s < 6; s++) {
    let history = undefined as ReturnType<typeof commitEntitySnapshot<Song>>['history'] | undefined
    for (let i = 0; i < 10; i++) {
      history = commitEntitySnapshot({ history, snapshot: song(`s${s}`, `${big}${i}`), message: `v${i}`, nowIso: `2026-11-${String(10 + i).padStart(2, '0')}T00:00:0${s}.000Z` }).history
    }
    bandVcs = { ...bandVcs, songs: { ...bandVcs.songs, [`s${s}`]: history! } }
  }
  const maxBytes = 64 * 1024
  const pruned = pruneBandVcs(bandVcs, { maxBytes })
  const bytes = new TextEncoder().encode(JSON.stringify(pruned)).byteLength
  assert.ok(bytes <= maxBytes, `quedo en ${bytes} bytes`)
  for (let s = 0; s < 6; s++) {
    const h = pruned.songs[`s${s}`]
    assert.ok(h, `la cancion s${s} conserva al menos su cabeza`)
    assert.ok(h.commits.some((c) => c.id === h.branches.main), 'la cabeza de main sigue')
  }
})

console.log(`\n${passed} verificaciones OK${failures.length ? `, ${failures.length} FALLARON: ${failures.join(' | ')}` : ''}`)
if (failures.length) process.exit(1)
