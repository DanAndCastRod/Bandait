/**
 * Colaboracion en tiempo real del Estudio DAW:
 *   1. `mergeCollaborativeSessionDetailed(base, local, remote)`: fusion determinista de 3 vias por
 *      entidad (`tracks`, `clips`, `midiClips` y sus notas, cadenas de efectos por tipo, `markers`,
 *      `chords`, `master`, `assets`) para que dos integrantes de la banda editen pistas o secciones
 *      en simultaneo sin pisarse. Sin `base` (no se sabe de donde partieron) une en vez de borrar.
 *      Si el resultado no valida lanza `StudioMergeConflictError`: quien llama muestra el conflicto
 *      y NO sube nada (nunca se sube `local` con el etag del otro).
 *   2. `createStudioCollabChannel(...)`: suscripcion a un canal ligero sobre Supabase Realtime
 *      (`Broadcast` + `Presence` en `bandait-studio:${bandId}`). realtime-js devuelve la MISMA
 *      instancia para el mismo topic y no se vuelve a unir si ya esta unido, asi que el canal de
 *      cada banda tiene un unico dueno con conteo de referencias: la lista de sesiones y el
 *      controlador de una sesion abierta comparten el canal, y el canal se cierra solo cuando se
 *      va el ultimo suscriptor.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import {
  STUDIO_MAX_TRACKS,
  STUDIO_MIDI_MIN_NOTE_BEATS,
  STUDIO_NOTE_EPSILON_BEATS,
  compareChords,
  compareMarkers,
  compareNotes,
  usedAssetIds,
  validateSession,
  type StudioAsset,
  type StudioChord,
  type StudioClip,
  type StudioFx,
  type StudioMarker,
  type StudioMaster,
  type StudioMidiClip,
  type StudioMidiNote,
  type StudioSession,
  type StudioTrack,
} from './session.ts'

// ---------------------------------------------------------------------------
// Fusion determinista de 3 vias (`base` -> `local` vs `remote`)
// ---------------------------------------------------------------------------

/** La fusion no produjo un documento valido: hay que resolver a mano (recargar o sobrescribir). */
export class StudioMergeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioMergeConflictError'
  }
}

export interface StudioMergeResult {
  session: StudioSession
  /**
   * Rutas de los campos que los dos lados cambiaron distinto desde `base`. En ese caso se
   * conserva el valor local (la edicion de quien fusiona) y la interfaz lo avisa.
   */
  conflicts: string[]
}

interface MergeCtx {
  conflicts: string[]
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function pick3Way<T>(ctx: MergeCtx, path: string, base: T, local: T, remote: T): T {
  if (sameJson(local, remote)) return local
  if (sameJson(local, base)) return remote
  if (sameJson(remote, base)) return local
  ctx.conflicts.push(path)
  return local
}

/**
 * Lista con identidad por `keyOf`. Una edicion gana a un borrado (de cualquiera de los dos lados);
 * lo creado en un solo lado se conserva. Orden: el local si local reordeno respecto a base; si
 * no, el remoto; lo que falta se agrega en el orden del otro lado.
 */
function mergeKeyed<T>(
  ctx: MergeCtx,
  path: string,
  baseList: readonly T[],
  localList: readonly T[],
  remoteList: readonly T[],
  keyOf: (item: T) => string,
  mergeItem: (ctx: MergeCtx, path: string, baseItem: T, localItem: T, remoteItem: T) => T,
): T[] {
  const baseMap = new Map(baseList.map((item) => [keyOf(item), item]))
  const localMap = new Map(localList.map((item) => [keyOf(item), item]))
  const remoteMap = new Map(remoteList.map((item) => [keyOf(item), item]))

  const orderedKeys: string[] = []
  const seen = new Set<string>()
  const push = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k)
      orderedKeys.push(k)
    }
  }
  const baseOrder = baseList.map(keyOf).join('\u0001')
  const localOrder = localList.map(keyOf).join('\u0001')
  const localReordered = localOrder !== baseOrder
  const primary = localReordered ? localList : remoteList
  const secondary = localReordered ? remoteList : localList
  for (const x of primary) push(keyOf(x))
  for (const x of secondary) push(keyOf(x))

  const out: T[] = []
  for (const k of orderedKeys) {
    const b = baseMap.get(k)
    const l = localMap.get(k)
    const r = remoteMap.get(k)
    const itemPath = `${path}[${k}]`
    if (b !== undefined) {
      if (l !== undefined && r !== undefined) out.push(mergeItem(ctx, itemPath, b, l, r))
      else if (l !== undefined && !sameJson(l, b)) out.push(l) // borrado en remoto, editado aqui
      else if (r !== undefined && !sameJson(r, b)) out.push(r) // borrado aqui, editado en remoto
    } else if (l !== undefined && r !== undefined) {
      // Creado en los dos lados con la misma clave (un efecto del mismo tipo, por ejemplo).
      if (!sameJson(l, r)) ctx.conflicts.push(itemPath)
      out.push(l)
    } else if (l !== undefined) {
      out.push(l)
    } else if (r !== undefined) {
      out.push(r)
    }
  }
  return out
}

function byId<T extends { id: string }>(item: T): string {
  return item.id
}

function mergeClip(ctx: MergeCtx, path: string, base: StudioClip, local: StudioClip, remote: StudioClip): StudioClip {
  const p = <K extends keyof StudioClip>(k: K) => pick3Way(ctx, `${path}.${String(k)}`, base[k], local[k], remote[k])
  const merged: StudioClip = {
    ...local,
    assetId: p('assetId'),
    startS: p('startS'),
    offsetS: p('offsetS'),
    lengthS: p('lengthS'),
    gainDb: p('gainDb'),
    fadeInS: p('fadeInS'),
    fadeOutS: p('fadeOutS'),
    takeGroup: p('takeGroup'),
    active: p('active'),
  }
  delete merged.phaseInvert
  delete merged.fadeShape
  const phase = pick3Way(ctx, `${path}.phaseInvert`, base.phaseInvert === true, local.phaseInvert === true, remote.phaseInvert === true)
  if (phase) merged.phaseInvert = true
  const shape = pick3Way(ctx, `${path}.fadeShape`, base.fadeShape ?? 'linear', local.fadeShape ?? 'linear', remote.fadeShape ?? 'linear')
  if (shape !== 'linear') merged.fadeShape = shape
  return merged
}

/** Una nota se identifica por tono y comienzo (las notas no tienen id en el documento). */
function noteKey(n: StudioMidiNote): string {
  return `${n.pitch}@${n.start}`
}

/**
 * Notas de un clip, fusionadas nota a nota. Despues se ordenan y se recortan los solapes del
 * mismo tono (la nota anterior se acorta; si queda mas corta que el minimo, se quita) y se
 * descartan las que empiezan despues del final del clip.
 */
function mergeNotes(
  ctx: MergeCtx,
  path: string,
  base: readonly StudioMidiNote[],
  local: readonly StudioMidiNote[],
  remote: readonly StudioMidiNote[],
  clipLengthBeats: number,
): StudioMidiNote[] {
  if (sameJson(local, remote)) return [...local]
  if (sameJson(local, base)) return [...remote]
  if (sameJson(remote, base)) return [...local]
  const merged = mergeKeyed(ctx, path, base, local, remote, noteKey, (c, p, b, l, r) => ({
    pitch: l.pitch,
    start: l.start,
    length: pick3Way(c, `${p}.length`, b.length, l.length, r.length),
    velocity: pick3Way(c, `${p}.velocity`, b.velocity, l.velocity, r.velocity),
  }))
  const sorted = merged.filter((n) => n.start < clipLengthBeats).sort(compareNotes)
  const lastByPitch = new Map<number, StudioMidiNote>()
  const out: StudioMidiNote[] = []
  for (const note of sorted) {
    const prev = lastByPitch.get(note.pitch)
    if (prev && note.start < prev.start + prev.length - STUDIO_NOTE_EPSILON_BEATS) {
      const shortened = note.start - prev.start
      if (shortened >= STUDIO_MIDI_MIN_NOTE_BEATS) prev.length = shortened
      else out.splice(out.indexOf(prev), 1)
    }
    const copy = { ...note }
    out.push(copy)
    lastByPitch.set(note.pitch, copy)
  }
  return out
}

function mergeMidiClip(ctx: MergeCtx, path: string, base: StudioMidiClip, local: StudioMidiClip, remote: StudioMidiClip): StudioMidiClip {
  const p = <K extends keyof StudioMidiClip>(k: K) => pick3Way(ctx, `${path}.${String(k)}`, base[k], local[k], remote[k])
  const lengthBeats = p('lengthBeats')
  const merged: StudioMidiClip = {
    ...local,
    startBeat: p('startBeat'),
    lengthBeats,
    loop: p('loop'),
    loopBeats: p('loopBeats'),
    notes: mergeNotes(ctx, `${path}.notes`, base.notes, local.notes, remote.notes, lengthBeats),
  }
  delete merged.muted
  const muted = pick3Way(ctx, `${path}.muted`, base.muted === true, local.muted === true, remote.muted === true)
  if (muted) merged.muted = true
  return merged
}

function mergeFx(ctx: MergeCtx, path: string, base: StudioFx, local: StudioFx, remote: StudioFx): StudioFx {
  const bypass = pick3Way(ctx, `${path}.bypass`, base.bypass, local.bypass, remote.bypass)
  const bp = base.params as unknown as Record<string, unknown>
  const lp = local.params as unknown as Record<string, unknown>
  const rp = remote.params as unknown as Record<string, unknown>
  const params: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(lp), ...Object.keys(rp)])) {
    const value = pick3Way(ctx, `${path}.params.${key}`, bp[key], lp[key], rp[key])
    if (value !== undefined) params[key] = value
  }
  return { ...local, bypass, params } as unknown as StudioFx
}

/** Cadena de efectos fusionada por tipo (a lo sumo uno de cada tipo; el limitador, de ultimo). */
function mergeFxChain(ctx: MergeCtx, path: string, base: readonly StudioFx[], local: readonly StudioFx[], remote: readonly StudioFx[]): StudioFx[] {
  if (sameJson(local, remote)) return [...local]
  if (sameJson(local, base)) return [...remote]
  if (sameJson(remote, base)) return [...local]
  const chain = mergeKeyed(ctx, path, base, local, remote, (fx) => fx.type, mergeFx)
  const limiter = chain.filter((fx) => fx.type === 'limiter')
  return [...chain.filter((fx) => fx.type !== 'limiter'), ...limiter]
}

function mergeTrack(ctx: MergeCtx, path: string, base: StudioTrack, local: StudioTrack, remote: StudioTrack): StudioTrack {
  // Si cambio el tipo de pista (raro), gana local y se anota el choque.
  if (local.kind !== remote.kind) {
    ctx.conflicts.push(`${path}.kind`)
    return local
  }
  const p = <K extends keyof StudioTrack>(k: K) => pick3Way(ctx, `${path}.${String(k)}`, base[k], local[k], remote[k])
  const audio = local.kind === 'audio'
  return {
    ...local,
    name: p('name'),
    role: p('role'),
    volumeDb: p('volumeDb'),
    pan: p('pan'),
    mute: p('mute'),
    solo: p('solo'),
    reverbSendDb: p('reverbSendDb'),
    fx: mergeFxChain(ctx, `${path}.fx`, base.fx, local.fx, remote.fx),
    clips: audio ? mergeKeyed(ctx, `${path}.clips`, base.clips, local.clips, remote.clips, byId, mergeClip) : [],
    instrument: audio ? null : p('instrument'),
    midiClips: audio ? [] : mergeKeyed(ctx, `${path}.midiClips`, base.midiClips, local.midiClips, remote.midiClips, byId, mergeMidiClip),
    frozenAssetId: audio ? null : p('frozenAssetId'),
  }
}

function mergeMaster(ctx: MergeCtx, base: StudioMaster, local: StudioMaster, remote: StudioMaster): StudioMaster {
  return {
    ...local,
    volumeDb: pick3Way(ctx, 'master.volumeDb', base.volumeDb, local.volumeDb, remote.volumeDb),
    reverb: {
      decayS: pick3Way(ctx, 'master.reverb.decayS', base.reverb.decayS, local.reverb.decayS, remote.reverb.decayS),
      returnDb: pick3Way(ctx, 'master.reverb.returnDb', base.reverb.returnDb, local.reverb.returnDb, remote.reverb.returnDb),
    },
    fx: mergeFxChain(ctx, 'master.fx', base.fx, local.fx, remote.fx),
  }
}

function chordKey(c: StudioChord): string {
  return `${c.beat}:${c.name}`
}

function mergeChords(ctx: MergeCtx, base: readonly StudioChord[], local: readonly StudioChord[], remote: readonly StudioChord[]): StudioChord[] {
  if (sameJson(local, remote)) return [...local]
  if (sameJson(local, base)) return [...remote]
  if (sameJson(remote, base)) return [...local]
  return mergeKeyed(ctx, 'chords', base, local, remote, chordKey, (c, p, b, l, r) => pick3Way(c, p, b, l, r)).sort(compareChords)
}

/**
 * Base sintetica cuando no se conoce el ancestro comun: lo que existe en los DOS lados, con los
 * valores del remoto. Asi lo que solo esta en un lado se conserva (union, nunca borrado) y en lo
 * comun gana la edicion local, igual que con base.
 */
function syntheticBase(local: StudioSession, remote: StudioSession): StudioSession {
  const localTracks = new Map(local.tracks.map((t) => [t.id, t]))
  const has = <T>(list: readonly T[], keyOf: (x: T) => string) => {
    const keys = new Set(list.map(keyOf))
    return (x: T) => keys.has(keyOf(x))
  }
  const tracks = remote.tracks
    .filter((t) => localTracks.has(t.id))
    .map((rt) => {
      const lt = localTracks.get(rt.id)!
      const localMidi = new Map(lt.midiClips.map((c) => [c.id, c]))
      return {
        ...rt,
        fx: rt.fx.filter(has(lt.fx, (fx) => fx.type)),
        clips: rt.clips.filter(has(lt.clips, byId)),
        midiClips: rt.midiClips
          .filter((c) => localMidi.has(c.id))
          .map((c) => ({ ...c, notes: c.notes.filter(has(localMidi.get(c.id)!.notes, noteKey)) })),
      }
    })
  return {
    ...remote,
    assets: remote.assets.filter(has(local.assets, byId)),
    tracks,
    markers: remote.markers.filter(has(local.markers, byId)),
    chords: (remote.chords ?? []).filter(has(local.chords ?? [], chordKey)),
    master: { ...remote.master, fx: remote.master.fx.filter(has(local.master.fx, (fx) => fx.type)) },
  }
}

/**
 * Fusiona tres estados de sesion (`base` comun, `local` del musico actual y `remote` descargado de
 * la nube). Con `base` null une los dos lados (nunca borra lo que solo tiene uno). Lanza
 * `StudioMergeConflictError` si el resultado no es un documento valido.
 */
export function mergeCollaborativeSessionDetailed(
  base: StudioSession | null,
  local: StudioSession,
  remote: StudioSession,
): StudioMergeResult {
  const ctx: MergeCtx = { conflicts: [] }
  const ref = base ?? syntheticBase(local, remote)
  const tracks = mergeKeyed(ctx, 'tracks', ref.tracks, local.tracks, remote.tracks, byId, mergeTrack)
  if (tracks.length > STUDIO_MAX_TRACKS) {
    throw new StudioMergeConflictError(`Juntas, las dos versiones pasan de ${STUDIO_MAX_TRACKS} pistas.`)
  }
  const markers = mergeKeyed<StudioMarker>(ctx, 'markers', ref.markers, local.markers, remote.markers, byId, (c, p, b, l, r) => ({
    ...l,
    beat: pick3Way(c, `${p}.beat`, b.beat, l.beat, r.beat),
    label: pick3Way(c, `${p}.label`, b.label, l.label, r.label),
    kind: pick3Way(c, `${p}.kind`, b.kind, l.kind, r.kind),
  })).sort(compareMarkers)

  const chords = mergeChords(ctx, ref.chords ?? [], local.chords ?? [], remote.chords ?? [])

  // Union de assets: los referenciados mas los agregados en cualquiera de los dos lados.
  const assetMap = new Map<string, StudioAsset>()
  for (const a of remote.assets) assetMap.set(a.id, a)
  for (const a of local.assets) assetMap.set(a.id, a)

  const s = <K extends keyof StudioSession>(k: K) => pick3Way(ctx, String(k), ref[k], local[k], remote[k])
  const provisional: StudioSession = {
    ...local,
    version: 2,
    id: local.id,
    songId: s('songId'),
    title: s('title'),
    bpm: s('bpm'),
    beatsPerBar: s('beatsPerBar'),
    key: s('key'),
    sampleRate: local.sampleRate,
    latencyOffsetMs: s('latencyOffsetMs'),
    updatedAt: local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
    updatedBy: local.updatedBy ?? remote.updatedBy,
    assets: [...assetMap.values()],
    tracks,
    master: mergeMaster(ctx, ref.master, local.master, remote.master),
    markers,
  }
  if (chords.length > 0) provisional.chords = chords
  else delete provisional.chords

  // Un audio sin uso que uno de los dos lados quito a proposito (estaba en base) se va.
  const needed = usedAssetIds(provisional)
  const baseAssetIds = new Set(ref.assets.map((a) => a.id))
  const localAssetIds = new Set(local.assets.map((a) => a.id))
  const remoteAssetIds = new Set(remote.assets.map((a) => a.id))
  provisional.assets = provisional.assets.filter((a) => {
    if (needed.has(a.id)) return true
    const removedLocally = baseAssetIds.has(a.id) && !localAssetIds.has(a.id)
    const removedRemotely = baseAssetIds.has(a.id) && !remoteAssetIds.has(a.id)
    return !(removedLocally || removedRemotely)
  })

  // Resolver colisiones de IDs de clip entre pistas distintas (poco probable, pero blindado).
  const usedClipIds = new Set<string>()
  const assetIds = new Set(provisional.assets.map((a) => a.id))
  provisional.tracks = provisional.tracks.map((track) => {
    if (track.kind === 'audio') {
      const clips = track.clips.filter((c) => {
        if (usedClipIds.has(c.id) || !assetIds.has(c.assetId)) return false
        usedClipIds.add(c.id)
        return true
      })
      return { ...track, clips }
    }
    const midiClips = track.midiClips.filter((c) => {
      if (usedClipIds.has(c.id)) return false
      usedClipIds.add(c.id)
      return true
    })
    return { ...track, midiClips }
  })

  try {
    validateSession(provisional)
  } catch (err) {
    const detail = err instanceof Error && err.message ? ` (${err.message})` : ''
    throw new StudioMergeConflictError(`No se pudieron combinar los cambios automáticamente${detail}.`)
  }
  return { session: provisional, conflicts: ctx.conflicts }
}

/** `mergeCollaborativeSessionDetailed` sin el detalle de choques. Lanza StudioMergeConflictError. */
export function mergeCollaborativeSession(base: StudioSession | null, local: StudioSession, remote: StudioSession): StudioSession {
  return mergeCollaborativeSessionDetailed(base, local, remote).session
}

// ---------------------------------------------------------------------------
// Canal Realtime compartido (Broadcast + Presence sobre Supabase Realtime)
// ---------------------------------------------------------------------------

export interface StudioCollaboratorPresence {
  userId: string
  name: string
  role: string
  sessionId: string | null
  branch: string
  selectedTrackId: string | null
  updatedAt: string
}

export type StudioCollabEvent =
  | { type: 'session_catalog_changed'; sessionId: string; senderId: string; title: string }
  | { type: 'session_saved'; sessionId: string; etag: string; senderId: string; updatedAt: string }
  | { type: 'vcs_updated'; sessionId: string; branch: string; commitId: string; senderId: string }

export interface RealtimeChannelLike {
  on(type: 'broadcast', filter: { event: string }, callback: (payload: { payload?: unknown }) => void): RealtimeChannelLike
  on(type: 'presence', filter: { event: 'sync' }, callback: () => void): RealtimeChannelLike
  subscribe(callback?: (status: string) => void): RealtimeChannelLike
  track(payload: Record<string, unknown>): Promise<unknown>
  send(args: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): Promise<unknown>
  presenceState(): Record<string, unknown[]>
  unsubscribe(): Promise<unknown>
}

export interface RealtimeClientLike {
  channel(name: string, opts?: { config?: { presence?: { key?: string }; broadcast?: { self?: boolean } } }): RealtimeChannelLike
  removeChannel?(channel: RealtimeChannelLike): Promise<unknown>
}

export interface StudioCollabHandle {
  updatePresence(patch: Partial<Omit<StudioCollaboratorPresence, 'userId' | 'updatedAt'>>): void
  broadcast(event: StudioCollabEvent): void
  dispose(): void
}

export interface CreateStudioCollabOptions {
  client: RealtimeClientLike | null
  bandId: string
  initialPresence: Omit<StudioCollaboratorPresence, 'updatedAt'>
  onEvent?: (event: StudioCollabEvent) => void
  onPeersChange?: (peers: StudioCollaboratorPresence[]) => void
}

export function studioCollabChannelName(bandId: string): string {
  return `bandait-studio:${bandId}`
}

interface ChannelSubscriber {
  presence: StudioCollaboratorPresence
  onEvent?: (event: StudioCollabEvent) => void
  onPeersChange?: (peers: StudioCollaboratorPresence[]) => void
}

interface SharedChannel {
  client: RealtimeClientLike
  bandId: string
  channel: RealtimeChannelLike
  subscribed: boolean
  /** En orden de llegada: el ultimo vivo es quien publica su presencia (una por usuario). */
  subscribers: ChannelSubscriber[]
}

/** Un canal por (cliente, banda). WeakMap: un cliente descartado no retiene sus canales. */
const sharedChannels = new WeakMap<object, Map<string, SharedChannel>>()

function parseEvent(payload: unknown): StudioCollabEvent | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (p.type === 'session_catalog_changed' && typeof p.sessionId === 'string') {
    return { type: 'session_catalog_changed', sessionId: p.sessionId, senderId: String(p.senderId ?? ''), title: typeof p.title === 'string' ? p.title : '' }
  }
  if (p.type === 'session_saved' && typeof p.sessionId === 'string' && typeof p.etag === 'string') {
    return { type: 'session_saved', sessionId: p.sessionId, etag: p.etag, senderId: String(p.senderId ?? ''), updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '' }
  }
  if (p.type === 'vcs_updated' && typeof p.sessionId === 'string' && typeof p.commitId === 'string') {
    return { type: 'vcs_updated', sessionId: p.sessionId, branch: typeof p.branch === 'string' ? p.branch : 'main', commitId: p.commitId, senderId: String(p.senderId ?? '') }
  }
  return null
}

function readPeers(shared: SharedChannel): StudioCollaboratorPresence[] {
  const own = new Set(shared.subscribers.map((s) => s.presence.userId))
  const peers: StudioCollaboratorPresence[] = []
  let state: Record<string, unknown[]>
  try {
    state = shared.channel.presenceState()
  } catch {
    return peers
  }
  for (const list of Object.values(state)) {
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      if (typeof r.userId !== 'string' || own.has(r.userId)) continue
      peers.push({
        userId: r.userId,
        name: typeof r.name === 'string' && r.name ? r.name : 'Integrante',
        role: typeof r.role === 'string' ? r.role : 'Musician',
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
        branch: typeof r.branch === 'string' ? r.branch : 'main',
        selectedTrackId: typeof r.selectedTrackId === 'string' ? r.selectedTrackId : null,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
      })
    }
  }
  return peers
}

function publishPresence(shared: SharedChannel): void {
  const top = shared.subscribers[shared.subscribers.length - 1]
  if (!shared.subscribed || !top) return
  void shared.channel.track({ ...top.presence }).catch(() => undefined)
}

function emitPeers(shared: SharedChannel, only?: ChannelSubscriber): void {
  const peers = readPeers(shared)
  for (const sub of only ? [only] : [...shared.subscribers]) {
    try {
      sub.onPeersChange?.(peers)
    } catch {
      // Un suscriptor que falla no corta a los demas.
    }
  }
}

function openSharedChannel(client: RealtimeClientLike, bandId: string, presenceKey: string): SharedChannel {
  let byBand = sharedChannels.get(client)
  if (!byBand) {
    byBand = new Map()
    sharedChannels.set(client, byBand)
  }
  const existing = byBand.get(bandId)
  if (existing) return existing
  const channel = client.channel(studioCollabChannelName(bandId), {
    config: { presence: { key: presenceKey }, broadcast: { self: false } },
  })
  const shared: SharedChannel = { client, bandId, channel, subscribed: false, subscribers: [] }
  byBand.set(bandId, shared)
  // Los manejadores se registran UNA vez, antes de subscribe (realtime-js no admite agregar
  // manejadores de presencia despues de unirse), y reparten a todos los suscriptores.
  channel
    .on('broadcast', { event: 'studio_event' }, ({ payload }) => {
      const event = parseEvent(payload)
      if (!event) return
      for (const sub of [...shared.subscribers]) {
        if (event.senderId === sub.presence.userId) continue
        try {
          sub.onEvent?.(event)
        } catch {
          // Un suscriptor que falla no corta a los demas.
        }
      }
    })
    .on('presence', { event: 'sync' }, () => emitPeers(shared))
    .subscribe((status) => {
      if (byBand.get(bandId) !== shared) return
      if (status === 'SUBSCRIBED') {
        shared.subscribed = true
        publishPresence(shared)
        emitPeers(shared)
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        // realtime-js reintenta solo y vuelve a llamar con SUBSCRIBED al reunirse.
        shared.subscribed = false
      }
    })
  return shared
}

function closeSharedChannel(shared: SharedChannel): void {
  const byBand = sharedChannels.get(shared.client)
  if (byBand?.get(shared.bandId) === shared) byBand.delete(shared.bandId)
  shared.subscribed = false
  if (shared.client.removeChannel) {
    void shared.client.removeChannel(shared.channel).catch(() => undefined)
  } else {
    void shared.channel.unsubscribe().catch(() => undefined)
  }
}

/** Suscriptores vivos del canal de una banda (0 si no hay canal). Para pruebas y diagnostico. */
export function studioCollabSubscriberCount(client: RealtimeClientLike, bandId: string): number {
  return sharedChannels.get(client)?.get(bandId)?.subscribers.length ?? 0
}

export function createStudioCollabChannel(options: CreateStudioCollabOptions): StudioCollabHandle {
  const { client, bandId } = options
  if (!client || !bandId || bandId === 'me') {
    return { updatePresence() {}, broadcast() {}, dispose() {} }
  }
  const subscriber: ChannelSubscriber = {
    presence: { ...options.initialPresence, updatedAt: new Date().toISOString() },
    onEvent: options.onEvent,
    onPeersChange: options.onPeersChange,
  }
  const shared = openSharedChannel(client, bandId, subscriber.presence.userId)
  shared.subscribers.push(subscriber)
  if (shared.subscribed) {
    // El canal ya estaba unido (lo abrio la lista de sesiones): no habra otro SUBSCRIBED.
    publishPresence(shared)
    emitPeers(shared, subscriber)
  }
  let disposed = false

  return {
    updatePresence(patch) {
      if (disposed) return
      subscriber.presence = { ...subscriber.presence, ...patch, updatedAt: new Date().toISOString() }
      if (shared.subscribers[shared.subscribers.length - 1] === subscriber) publishPresence(shared)
    },
    broadcast(event) {
      if (disposed || !shared.subscribed) return
      void shared.channel
        .send({ type: 'broadcast', event: 'studio_event', payload: event as unknown as Record<string, unknown> })
        .catch(() => undefined)
    },
    dispose() {
      if (disposed) return
      disposed = true
      const index = shared.subscribers.indexOf(subscriber)
      if (index < 0) return
      const wasTop = index === shared.subscribers.length - 1
      shared.subscribers.splice(index, 1)
      if (shared.subscribers.length === 0) closeSharedChannel(shared)
      else if (wasTop) publishPresence(shared)
    },
  }
}
