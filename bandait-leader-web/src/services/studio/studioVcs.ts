/**
 * Control de versiones musical del Estudio DAW (STUDIO_V2.md 7.2):
 *   - Commits / Snapshots inmutables con cero duplicacion de audios WAV/FLAC/MP3
 *   - Ramas / Variantes (`main`, `vivo`, `acustico` o personalizadas)
 *   - Fusion determinista entre el almacen local (IndexedDB) y el indice remoto (R2)
 *   - `diffStudioSessions(base, target)`: comparacion musical legible de mezcla, FX, notas MIDI,
 *     clips, estructura y tonalidad/tempo para previsualizacion y conmutacion A/B instantanea.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import { normalizeBranchName } from '../versionControl.ts'
import {
  MAX_VCS_COMMITS_CLIENT,
  parseSession,
  serializeSession,
  type StudioFx,
  type StudioSession,
  type StudioTrack,
  type WireStudioSession,
} from './studioVcsHelpersInternal.ts'
import type { StudioVcsCommitMeta, StudioVcsIndex } from './types.ts'

export { MAX_VCS_COMMITS_CLIENT }
export const DEFAULT_STUDIO_BRANCHES = ['main', 'vivo', 'acustico'] as const

export interface StudioVcsBundle {
  activeBranch: string
  index: StudioVcsIndex
  /** Copias locales serializadas por commitId para conmutacion A/B offline en 0 ms. */
  localCommits: Record<string, WireStudioSession>
}

export interface StudioTrackDiffItem {
  trackId: string
  name: string
  status: 'added' | 'removed' | 'modified'
  changes: string[]
}

export interface StudioSessionDiff {
  changed: boolean
  titleChanged: [string, string] | null
  bpmDelta: number
  keyChanged: [string, string] | null
  beatsPerBarDelta: number
  masterChanges: string[]
  tracks: StudioTrackDiffItem[]
  markersDelta: number
  chordsDelta: number
  totalMidiNotesDelta: number
  summary: string[]
}

export function emptyStudioVcsIndex(): StudioVcsIndex {
  return {
    version: 1,
    branches: {},
    commits: [],
    protectedAssets: [],
    etag: null,
  }
}

export function emptyStudioVcsBundle(branch = 'main'): StudioVcsBundle {
  return {
    activeBranch: normalizeBranchName(branch),
    index: emptyStudioVcsIndex(),
    localCommits: {},
  }
}

function recomputeProtectedAssets(commits: readonly StudioVcsCommitMeta[]): string[] {
  const set = new Set<string>()
  for (const c of commits) {
    for (const file of c.assetFiles) set.add(file)
  }
  return [...set].sort()
}

export interface CreateLocalCommitArgs {
  bundle: StudioVcsBundle
  session: StudioSession
  branch?: string
  message: string
  authorId?: string | null
  authorName?: string
  commitId?: string
  nowIso?: string
}

/** Crea un snapshot local inmediato (listo para escucha A/B y sincronizacion posterior con R2). */
export function commitStudioLocal(args: CreateLocalCommitArgs): {
  bundle: StudioVcsBundle
  commit: StudioVcsCommitMeta
} {
  const branch = normalizeBranchName(args.branch ?? args.bundle.activeBranch ?? 'main')
  const nowIso = args.nowIso ?? new Date().toISOString()
  const compact = nowIso.replace(/[^0-9]/g, '').slice(0, 14)
  const id = args.commitId ?? `cmt_${compact}_${args.bundle.index.commits.length + 1}`
  const message = args.message.trim().slice(0, 160) || `Snapshot (${branch})`
  const authorName = (args.authorName ?? 'Integrante').trim().slice(0, 80) || 'Integrante'
  const parentId = args.bundle.index.branches[branch] ?? null

  const snapshotSession: StudioSession = {
    ...args.session,
    updatedAt: nowIso,
    updatedBy: args.authorId ?? args.session.updatedBy,
  }
  const wire = serializeSession(snapshotSession)

  const meta: StudioVcsCommitMeta = {
    id,
    branch,
    parentId,
    message,
    authorId: args.authorId ?? null,
    authorName,
    createdAt: nowIso,
    trackCount: snapshotSession.tracks.length,
    bpm: snapshotSession.bpm,
    key: snapshotSession.key,
    assetFiles: snapshotSession.assets.map((a) => a.file),
  }

  const nextBranches: Record<string, string> = { ...args.bundle.index.branches, [branch]: id }
  const headIds = new Set(Object.values(nextBranches))
  const mergedCommits = [meta, ...args.bundle.index.commits.filter((c) => c.id !== id)]
  const keptCommits: StudioVcsCommitMeta[] = []
  for (const c of mergedCommits) {
    if (keptCommits.length < MAX_VCS_COMMITS_CLIENT || headIds.has(c.id)) keptCommits.push(c)
  }
  const keptIds = new Set(keptCommits.map((c) => c.id))
  const nextLocalCommits: Record<string, WireStudioSession> = {}
  for (const [cid, doc] of Object.entries(args.bundle.localCommits)) {
    if (keptIds.has(cid)) nextLocalCommits[cid] = doc
  }
  nextLocalCommits[id] = wire

  return {
    bundle: {
      activeBranch: branch,
      index: {
        version: 1,
        branches: nextBranches,
        commits: keptCommits,
        protectedAssets: recomputeProtectedAssets(keptCommits),
        etag: args.bundle.index.etag,
      },
      localCommits: nextLocalCommits,
    },
    commit: meta,
  }
}

/** Reconcilia el indice local con el recibido desde Cloudflare R2 sin perder ramas ni commits. */
export function mergeStudioVcsIndices(local: StudioVcsIndex, remote: StudioVcsIndex): StudioVcsIndex {
  const byId = new Map<string, StudioVcsCommitMeta>()
  for (const c of local.commits) byId.set(c.id, c)
  for (const c of remote.commits) byId.set(c.id, c)

  const commits = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  const branches: Record<string, string> = { ...local.branches, ...remote.branches }
  for (const [branch, remoteHead] of Object.entries(remote.branches)) {
    const localHead = local.branches[branch]
    if (!localHead || localHead === remoteHead) {
      branches[branch] = remoteHead
      continue
    }
    const lc = byId.get(localHead)
    const rc = byId.get(remoteHead)
    if (lc && rc && lc.createdAt > rc.createdAt) branches[branch] = localHead
    else branches[branch] = remoteHead
  }

  return {
    version: 1,
    branches,
    commits,
    protectedAssets: recomputeProtectedAssets(commits),
    etag: remote.etag ?? local.etag,
  }
}

export function resolveLocalCommitSession(bundle: StudioVcsBundle, commitId: string): StudioSession | null {
  const wire = bundle.localCommits[commitId]
  if (!wire) return null
  try {
    return parseSession(wire)
  } catch {
    return null
  }
}

export function parseStoredVcsBundle(raw: unknown): StudioVcsBundle {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyStudioVcsBundle()
  const o = raw as Record<string, unknown>
  const activeBranch = typeof o.activeBranch === 'string' ? normalizeBranchName(o.activeBranch) : 'main'
  const rawIdx = typeof o.index === 'object' && o.index !== null ? (o.index as Record<string, unknown>) : null
  const branches: Record<string, string> = {}
  if (rawIdx && typeof rawIdx.branches === 'object' && rawIdx.branches !== null) {
    for (const [k, v] of Object.entries(rawIdx.branches as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) branches[normalizeBranchName(k)] = v
    }
  }
  const commits: StudioVcsCommitMeta[] = []
  if (rawIdx && Array.isArray(rawIdx.commits)) {
    for (const item of rawIdx.commits) {
      if (typeof item !== 'object' || item === null) continue
      const c = item as Record<string, unknown>
      if (typeof c.id !== 'string' || typeof c.branch !== 'string' || typeof c.createdAt !== 'string') continue
      commits.push({
        id: c.id,
        branch: c.branch,
        parentId: typeof c.parentId === 'string' ? c.parentId : null,
        message: typeof c.message === 'string' ? c.message : '',
        authorId: typeof c.authorId === 'string' ? c.authorId : null,
        authorName: typeof c.authorName === 'string' ? c.authorName : '',
        createdAt: c.createdAt,
        trackCount: typeof c.trackCount === 'number' ? c.trackCount : 0,
        bpm: typeof c.bpm === 'number' ? c.bpm : 120,
        key: typeof c.key === 'string' ? c.key : null,
        assetFiles: Array.isArray(c.assetFiles) ? c.assetFiles.filter((f): f is string => typeof f === 'string') : [],
      })
    }
  }
  const localCommits: Record<string, WireStudioSession> = {}
  if (typeof o.localCommits === 'object' && o.localCommits !== null) {
    for (const [cid, doc] of Object.entries(o.localCommits as Record<string, unknown>)) {
      if (typeof doc === 'object' && doc !== null && !Array.isArray(doc)) {
        localCommits[cid] = doc as WireStudioSession
      }
    }
  }
  return {
    activeBranch,
    index: {
      version: 1,
      branches,
      commits,
      protectedAssets: recomputeProtectedAssets(commits),
      etag: rawIdx && typeof rawIdx.etag === 'string' ? rawIdx.etag : null,
    },
    localCommits,
  }
}

export function serializeVcsBundle(bundle: StudioVcsBundle): Record<string, unknown> {
  return {
    activeBranch: bundle.activeBranch,
    index: bundle.index,
    localCommits: bundle.localCommits,
  }
}

// ---------------------------------------------------------------------------
// Diff musical entre dos sesiones del Estudio (`base` -> `target`)
// ---------------------------------------------------------------------------

function fmtDbDelta(delta: number): string {
  const r = Math.round(delta * 10) / 10
  return `${r > 0 ? `+${r}` : r} dB`
}

function fxSummary(chain: readonly StudioFx[]): string {
  if (chain.length === 0) return 'sin FX'
  return chain.map((fx) => `${fx.type}${fx.bypass ? '(off)' : ''}`).join('+')
}

function fxEqual(a: readonly StudioFx[], b: readonly StudioFx[]): boolean {
  if (a.length !== b.length) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function countTrackMidiNotes(track: StudioTrack): number {
  return track.midiClips.reduce((acc, clip) => acc + clip.notes.length, 0)
}

export function diffStudioSessions(base: StudioSession, target: StudioSession): StudioSessionDiff {
  const summary: string[] = []
  const titleChanged: [string, string] | null = base.title !== target.title ? [base.title, target.title] : null
  if (titleChanged) summary.push(`Título: "${base.title}" -> "${target.title}"`)

  const bpmDelta = Math.round((target.bpm - base.bpm) * 100) / 100
  if (bpmDelta !== 0) summary.push(`Tempo: ${base.bpm} -> ${target.bpm} BPM (${bpmDelta > 0 ? `+${bpmDelta}` : bpmDelta})`)

  const keyChanged: [string, string] | null = (base.key ?? '') !== (target.key ?? '') ? [base.key ?? '—', target.key ?? '—'] : null
  if (keyChanged) summary.push(`Tonalidad: ${keyChanged[0]} -> ${keyChanged[1]}`)

  const beatsPerBarDelta = target.beatsPerBar - base.beatsPerBar
  if (beatsPerBarDelta !== 0) summary.push(`Compás: ${base.beatsPerBar}/4 -> ${target.beatsPerBar}/4`)

  const masterChanges: string[] = []
  if (Math.abs(target.master.volumeDb - base.master.volumeDb) >= 0.05) {
    masterChanges.push(`Fader master ${fmtDbDelta(target.master.volumeDb - base.master.volumeDb)}`)
  }
  if (
    Math.abs(target.master.reverb.decayS - base.master.reverb.decayS) >= 0.05 ||
    Math.abs(target.master.reverb.returnDb - base.master.reverb.returnDb) >= 0.05
  ) {
    masterChanges.push(`Reverb (${target.master.reverb.decayS.toFixed(1)} s, ${target.master.reverb.returnDb.toFixed(1)} dB)`)
  }
  if (!fxEqual(base.master.fx, target.master.fx)) {
    masterChanges.push(`Cadena master: ${fxSummary(base.master.fx)} -> ${fxSummary(target.master.fx)}`)
  }
  if (masterChanges.length > 0) summary.push(`Bus Master: ${masterChanges.join(' · ')}`)

  const baseTracks = new Map(base.tracks.map((t) => [t.id, t]))
  const targetTracks = new Map(target.tracks.map((t) => [t.id, t]))
  const trackDiffs: StudioTrackDiffItem[] = []

  for (const t of target.tracks) {
    const prev = baseTracks.get(t.id)
    if (!prev) {
      trackDiffs.push({ trackId: t.id, name: t.name, status: 'added', changes: [`Pista ${t.kind === 'instrument' ? 'MIDI' : 'audio'} nueva`] })
      continue
    }
    const changes: string[] = []
    if (prev.name !== t.name) changes.push(`renombrada "${prev.name}" -> "${t.name}"`)
    if (Math.abs(t.volumeDb - prev.volumeDb) >= 0.05) changes.push(`fader ${fmtDbDelta(t.volumeDb - prev.volumeDb)}`)
    if (Math.abs(t.pan - prev.pan) >= 0.02) changes.push(`pan ${Math.round(prev.pan * 100)}% -> ${Math.round(t.pan * 100)}%`)
    if (prev.mute !== t.mute) changes.push(t.mute ? 'mute activado' : 'mute quitado')
    if (Math.abs(t.reverbSendDb - prev.reverbSendDb) >= 0.1) changes.push(`reverb ${fmtDbDelta(t.reverbSendDb - prev.reverbSendDb)}`)
    if (!fxEqual(prev.fx, t.fx)) changes.push(`FX ${fxSummary(prev.fx)} -> ${fxSummary(t.fx)}`)
    if (JSON.stringify(prev.instrument) !== JSON.stringify(t.instrument)) changes.push('instrumento/síntesis ajustado')
    if (JSON.stringify(prev.clips) !== JSON.stringify(t.clips)) {
      const deltaClips = t.clips.length - prev.clips.length
      changes.push(deltaClips === 0 ? 'edición de clips de audio' : `clips audio ${prev.clips.length} -> ${t.clips.length}`)
    }
    if (JSON.stringify(prev.midiClips) !== JSON.stringify(t.midiClips)) {
      const notesPrev = countTrackMidiNotes(prev)
      const notesNext = countTrackMidiNotes(t)
      changes.push(notesPrev === notesNext ? 'notas MIDI editadas' : `notas MIDI ${notesPrev} -> ${notesNext}`)
    }
    if (changes.length > 0) {
      trackDiffs.push({ trackId: t.id, name: t.name, status: 'modified', changes })
    }
  }

  for (const prev of base.tracks) {
    if (!targetTracks.has(prev.id)) {
      trackDiffs.push({ trackId: prev.id, name: prev.name, status: 'removed', changes: ['Pista eliminada'] })
    }
  }

  const addedCount = trackDiffs.filter((d) => d.status === 'added').length
  const removedCount = trackDiffs.filter((d) => d.status === 'removed').length
  const modCount = trackDiffs.filter((d) => d.status === 'modified').length
  if (addedCount > 0) summary.push(`${addedCount} pista(s) añadida(s)`)
  if (removedCount > 0) summary.push(`${removedCount} pista(s) eliminada(s)`)
  if (modCount > 0) summary.push(`${modCount} pista(s) modificada(s)`)

  const markersDelta = target.markers.length - base.markers.length
  if (JSON.stringify(base.markers) !== JSON.stringify(target.markers)) {
    summary.push(`Marcadores: ${base.markers.length} -> ${target.markers.length}`)
  }

  const baseChords = base.chords ?? []
  const targetChords = target.chords ?? []
  const chordsDelta = targetChords.length - baseChords.length
  if (JSON.stringify(baseChords) !== JSON.stringify(targetChords)) {
    summary.push(`Acordes: ${baseChords.length} -> ${targetChords.length}`)
  }

  const notesA = base.tracks.reduce((acc, t) => acc + countTrackMidiNotes(t), 0)
  const notesB = target.tracks.reduce((acc, t) => acc + countTrackMidiNotes(t), 0)
  const totalMidiNotesDelta = notesB - notesA

  return {
    changed: summary.length > 0,
    titleChanged,
    bpmDelta,
    keyChanged,
    beatsPerBarDelta,
    masterChanges,
    tracks: trackDiffs,
    markersDelta,
    chordsDelta,
    totalMidiNotesDelta,
    summary,
  }
}
