/**
 * Colaboracion en tiempo real del Estudio DAW:
 *   1. `mergeCollaborativeSession(base, local, remote)`: fusion determinista de 3 vias por entidad
 *      (`tracks`, `clips`, `midiClips`, `markers`, `chords`, `master`, `assets`) para que dos
 *      integrantes de la banda editen pistas o secciones en simultaneo sin pisarse ni disparar
 *      bloqueos `412 Precondition Failed`.
 *   2. `createStudioCollabChannel(...)`: canal ligero sobre Supabase Realtime (`Broadcast` +
 *      `Presence` en `bandait-studio:${bandId}`) desacoplado de `import.meta.env` para poderse
 *      probar en Node sin navegador.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import {
  STUDIO_MAX_TRACKS,
  compareChords,
  compareMarkers,
  usedAssetIds,
  validateSession,
  type StudioAsset,
  type StudioChord,
  type StudioClip,
  type StudioMarker,
  type StudioMaster,
  type StudioMidiClip,
  type StudioSession,
  type StudioTrack,
} from './session.ts'

// ---------------------------------------------------------------------------
// Fusion determinista de 3 vias (`base` -> `local` vs `remote`)
// ---------------------------------------------------------------------------

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function pick3Way<T>(base: T, local: T, remote: T): T {
  if (sameJson(local, remote)) return local
  if (!sameJson(local, base)) return local
  return remote
}

function mergeById3Way<T extends { id: string }>(
  baseList: readonly T[],
  localList: readonly T[],
  remoteList: readonly T[],
  mergeItem: (baseItem: T, localItem: T, remoteItem: T) => T,
): T[] {
  const baseMap = new Map(baseList.map((item) => [item.id, item]))
  const localMap = new Map(localList.map((item) => [item.id, item]))
  const remoteMap = new Map(remoteList.map((item) => [item.id, item]))

  const orderedIds: string[] = []
  const seen = new Set<string>()
  const pushId = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id)
      orderedIds.push(id)
    }
  }
  // Si local reordeno respecto a base, manda el orden local; si no, manda el remoto.
  const baseOrder = baseList.map((x) => x.id).join(',')
  const localOrder = localList.map((x) => x.id).join(',')
  const primary = localOrder !== baseOrder ? localList : remoteList
  const secondary = localOrder !== baseOrder ? remoteList : localList
  for (const x of primary) pushId(x.id)
  for (const x of secondary) pushId(x.id)

  const out: T[] = []
  for (const id of orderedIds) {
    const b = baseMap.get(id)
    const l = localMap.get(id)
    const r = remoteMap.get(id)
    if (b) {
      if (l && r) {
        out.push(mergeItem(b, l, r))
      } else if (l && !r) {
        // Borrado en remoto; si local lo edito desde base, se preserva la edicion local.
        if (!sameJson(l, b)) out.push(l)
      } else if (!l && r) {
        // Borrado en local; si remoto lo edito desde base, se preserva la edicion remota.
        if (!sameJson(r, b)) out.push(r)
      }
    } else {
      // Creado en local, remoto o ambos.
      if (l && r) out.push(sameJson(l, r) ? l : l)
      else if (l) out.push(l)
      else if (r) out.push(r)
    }
  }
  return out
}

function mergeClip(base: StudioClip, local: StudioClip, remote: StudioClip): StudioClip {
  const merged: StudioClip = {
    id: local.id,
    assetId: pick3Way(base.assetId, local.assetId, remote.assetId),
    startS: pick3Way(base.startS, local.startS, remote.startS),
    offsetS: pick3Way(base.offsetS, local.offsetS, remote.offsetS),
    lengthS: pick3Way(base.lengthS, local.lengthS, remote.lengthS),
    gainDb: pick3Way(base.gainDb, local.gainDb, remote.gainDb),
    fadeInS: pick3Way(base.fadeInS, local.fadeInS, remote.fadeInS),
    fadeOutS: pick3Way(base.fadeOutS, local.fadeOutS, remote.fadeOutS),
    takeGroup: pick3Way(base.takeGroup, local.takeGroup, remote.takeGroup),
    active: pick3Way(base.active, local.active, remote.active),
  }
  const phase = pick3Way(base.phaseInvert === true, local.phaseInvert === true, remote.phaseInvert === true)
  if (phase) merged.phaseInvert = true
  const shape = pick3Way(base.fadeShape ?? 'linear', local.fadeShape ?? 'linear', remote.fadeShape ?? 'linear')
  if (shape !== 'linear') merged.fadeShape = shape
  return merged
}

function mergeMidiClip(base: StudioMidiClip, local: StudioMidiClip, remote: StudioMidiClip): StudioMidiClip {
  const muted = pick3Way(base.muted === true, local.muted === true, remote.muted === true)
  const merged: StudioMidiClip = {
    id: local.id,
    startBeat: pick3Way(base.startBeat, local.startBeat, remote.startBeat),
    lengthBeats: pick3Way(base.lengthBeats, local.lengthBeats, remote.lengthBeats),
    loop: pick3Way(base.loop, local.loop, remote.loop),
    loopBeats: pick3Way(base.loopBeats, local.loopBeats, remote.loopBeats),
    notes: pick3Way(base.notes, local.notes, remote.notes),
  }
  if (muted) merged.muted = true
  return merged
}

function mergeTrack(base: StudioTrack, local: StudioTrack, remote: StudioTrack): StudioTrack {
  // Si cambio el kind de pista (raro), gana local.
  if (local.kind !== remote.kind) return local
  return {
    id: local.id,
    kind: local.kind,
    name: pick3Way(base.name, local.name, remote.name),
    role: pick3Way(base.role, local.role, remote.role),
    volumeDb: pick3Way(base.volumeDb, local.volumeDb, remote.volumeDb),
    pan: pick3Way(base.pan, local.pan, remote.pan),
    mute: pick3Way(base.mute, local.mute, remote.mute),
    solo: pick3Way(base.solo, local.solo, remote.solo),
    reverbSendDb: pick3Way(base.reverbSendDb, local.reverbSendDb, remote.reverbSendDb),
    fx: pick3Way(base.fx, local.fx, remote.fx),
    clips: local.kind === 'audio' ? mergeById3Way(base.clips, local.clips, remote.clips, mergeClip) : [],
    instrument: local.kind === 'instrument' ? pick3Way(base.instrument, local.instrument, remote.instrument) : null,
    midiClips: local.kind === 'instrument' ? mergeById3Way(base.midiClips, local.midiClips, remote.midiClips, mergeMidiClip) : [],
    frozenAssetId: local.kind === 'instrument' ? pick3Way(base.frozenAssetId, local.frozenAssetId, remote.frozenAssetId) : null,
  }
}

function mergeMaster(base: StudioMaster, local: StudioMaster, remote: StudioMaster): StudioMaster {
  return {
    volumeDb: pick3Way(base.volumeDb, local.volumeDb, remote.volumeDb),
    reverb: {
      decayS: pick3Way(base.reverb.decayS, local.reverb.decayS, remote.reverb.decayS),
      returnDb: pick3Way(base.reverb.returnDb, local.reverb.returnDb, remote.reverb.returnDb),
    },
    fx: pick3Way(base.fx, local.fx, remote.fx),
  }
}

function mergeChords(base: readonly StudioChord[], local: readonly StudioChord[], remote: readonly StudioChord[]): StudioChord[] {
  if (sameJson(local, remote)) return [...local]
  if (!sameJson(local, base) && sameJson(remote, base)) return [...local]
  if (sameJson(local, base) && !sameJson(remote, base)) return [...remote]
  const keyOf = (c: StudioChord) => `${c.beat}:${c.name}`
  const baseSet = new Set(base.map(keyOf))
  const localMap = new Map(local.map((c) => [keyOf(c), c]))
  const remoteMap = new Map(remote.map((c) => [keyOf(c), c]))
  const out = new Map<string, StudioChord>()
  for (const [k, c] of localMap) {
    if (!baseSet.has(k) || remoteMap.has(k)) out.set(k, c)
  }
  for (const [k, c] of remoteMap) {
    if (!baseSet.has(k)) out.set(k, c)
  }
  return [...out.values()].sort(compareChords)
}

/**
 * Fusiona tres estados de sesion (`base` comun, `local` del musico actual y `remote` descargado de
 * la nube o recibido por Realtime). Si `base` es null se usa `remote` como referencia conservadora
 * para preservar pistas y clips nuevos creados localmente.
 */
export function mergeCollaborativeSession(
  base: StudioSession | null,
  local: StudioSession,
  remote: StudioSession,
): StudioSession {
  const ref = base ?? remote
  const tracks = mergeById3Way(ref.tracks, local.tracks, remote.tracks, mergeTrack).slice(0, STUDIO_MAX_TRACKS)
  const markers = mergeById3Way<StudioMarker>(
    ref.markers,
    local.markers,
    remote.markers,
    (b, l, r) => ({
      id: l.id,
      beat: pick3Way(b.beat, l.beat, r.beat),
      label: pick3Way(b.label, l.label, r.label),
      kind: pick3Way(b.kind, l.kind, r.kind),
    }),
  ).sort(compareMarkers)

  const chords = mergeChords(ref.chords ?? [], local.chords ?? [], remote.chords ?? [])

  // Union de assets, manteniendo todos los referenciados más los añadidos en cualquiera de los dos lados.
  const assetMap = new Map<string, StudioAsset>()
  for (const a of remote.assets) assetMap.set(a.id, a)
  for (const a of local.assets) assetMap.set(a.id, a)

  // Detectar si alguno de los dos lados limpio un asset sin usar.
  const provisional: StudioSession = {
    version: 2,
    id: local.id,
    songId: pick3Way(ref.songId, local.songId, remote.songId),
    title: pick3Way(ref.title, local.title, remote.title),
    bpm: pick3Way(ref.bpm, local.bpm, remote.bpm),
    beatsPerBar: pick3Way(ref.beatsPerBar, local.beatsPerBar, remote.beatsPerBar),
    key: pick3Way(ref.key, local.key, remote.key),
    sampleRate: local.sampleRate,
    latencyOffsetMs: pick3Way(ref.latencyOffsetMs, local.latencyOffsetMs, remote.latencyOffsetMs),
    updatedAt: local.updatedAt > remote.updatedAt ? local.updatedAt : remote.updatedAt,
    updatedBy: local.updatedBy ?? remote.updatedBy,
    assets: [...assetMap.values()],
    tracks,
    master: mergeMaster(ref.master, local.master, remote.master),
    markers,
    chords,
  }

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
  provisional.tracks = provisional.tracks.map((track) => {
    if (track.kind === 'audio') {
      const clips = track.clips.filter((c) => {
        if (usedClipIds.has(c.id)) return false
        if (!provisional.assets.some((a) => a.id === c.assetId)) return false
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
    return provisional
  } catch {
    return local
  }
}

// ---------------------------------------------------------------------------
// Canal Realtime desacoplado (Broadcast + Presence sobre Supabase Realtime)
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

export function createStudioCollabChannel(options: CreateStudioCollabOptions): StudioCollabHandle {
  const { client, bandId } = options
  let currentPresence: StudioCollaboratorPresence = {
    ...options.initialPresence,
    updatedAt: new Date().toISOString(),
  }

  if (!client || !bandId || bandId === 'me') {
    return {
      updatePresence() {},
      broadcast() {},
      dispose() {},
    }
  }

  let subscribed = false
  let disposed = false
  const channel = client.channel(studioCollabChannelName(bandId), {
    config: {
      presence: { key: currentPresence.userId },
      broadcast: { self: false },
    },
  })

  const emitPeers = () => {
    if (disposed || !options.onPeersChange) return
    try {
      const state = channel.presenceState()
      const peers: StudioCollaboratorPresence[] = []
      for (const list of Object.values(state)) {
        if (!Array.isArray(list)) continue
        for (const raw of list) {
          if (typeof raw !== 'object' || raw === null) continue
          const r = raw as Record<string, unknown>
          if (typeof r.userId !== 'string' || r.userId === currentPresence.userId) continue
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
      options.onPeersChange(peers)
    } catch {
      // Ignorar fallos de red transitorios.
    }
  }

  channel
    .on('broadcast', { event: 'studio_event' }, ({ payload }) => {
      if (disposed || !options.onEvent || typeof payload !== 'object' || payload === null) return
      const p = payload as Record<string, unknown>
      if (p.senderId === currentPresence.userId) return
      if (p.type === 'session_catalog_changed' && typeof p.sessionId === 'string') {
        options.onEvent({
          type: 'session_catalog_changed',
          sessionId: p.sessionId,
          senderId: String(p.senderId ?? ''),
          title: typeof p.title === 'string' ? p.title : '',
        })
      } else if (p.type === 'session_saved' && typeof p.sessionId === 'string' && typeof p.etag === 'string') {
        options.onEvent({
          type: 'session_saved',
          sessionId: p.sessionId,
          etag: p.etag,
          senderId: String(p.senderId ?? ''),
          updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
        })
      } else if (p.type === 'vcs_updated' && typeof p.sessionId === 'string' && typeof p.commitId === 'string') {
        options.onEvent({
          type: 'vcs_updated',
          sessionId: p.sessionId,
          branch: typeof p.branch === 'string' ? p.branch : 'main',
          commitId: p.commitId,
          senderId: String(p.senderId ?? ''),
        })
      }
    })
    .on('presence', { event: 'sync' }, emitPeers)
    .subscribe((status) => {
      if (disposed) return
      if (status === 'SUBSCRIBED') {
        subscribed = true
        void channel.track({ ...currentPresence }).catch(() => undefined)
      }
    })

  return {
    updatePresence(patch) {
      if (disposed) return
      currentPresence = {
        ...currentPresence,
        ...patch,
        updatedAt: new Date().toISOString(),
      }
      if (subscribed) {
        void channel.track({ ...currentPresence }).catch(() => undefined)
      }
    },
    broadcast(event) {
      if (disposed || !subscribed) return
      void channel
        .send({
          type: 'broadcast',
          event: 'studio_event',
          payload: event as unknown as Record<string, unknown>,
        })
        .catch(() => undefined)
    },
    dispose() {
      if (disposed) return
      disposed = true
      subscribed = false
      if (client.removeChannel) {
        void client.removeChannel(channel).catch(() => undefined)
      } else {
        void channel.unsubscribe().catch(() => undefined)
      }
    },
  }
}
