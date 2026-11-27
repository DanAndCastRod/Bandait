/**
 * Control de versiones musical del ecosistema Bandait (Canciones / ChordPro y Setlists).
 *
 * Permite mantener snapshots inmutables, ramas/variantes (ej. `main`, `vivo`, `acustico` o
 * personalizadas) y comparacion estructural (Diff) antes de restaurar o cambiar de variante.
 * Se persiste opcionalmente en `WorkspaceStore.vcsMap[bandId]` (sincronizado con Supabase en
 * bandas personales y compartidas) sin alterar el contrato base cuando una banda aun no tiene
 * historial.
 *
 * Modulo puro: sin DOM, sin React y sin import.meta.env.
 */
import type { Playlist, Song, WorkspaceStore } from '../types/hub.ts'
import { totalBars } from './workspaceSchema.ts'

export const DEFAULT_ECOSYSTEM_BRANCHES = ['main', 'vivo', 'acustico'] as const
export const MAX_ENTITY_COMMITS = 48
const BRANCH_RE = /^[A-Za-z0-9_-]{1,40}$/

export type VersionedEntityKind = 'song' | 'playlist'

export interface EntityCommit<T> {
  id: string
  branch: string
  parentId: string | null
  message: string
  authorName: string
  createdAt: string
  snapshot: T
}

export interface EntityVcsHistory<T> {
  activeBranch: string
  branches: Record<string, string>
  commits: EntityCommit<T>[]
}

export interface EcosystemBandVcs {
  songs: Record<string, EntityVcsHistory<Song>>
  playlists: Record<string, EntityVcsHistory<Playlist>>
}

export interface SongDiff {
  changed: boolean
  titleChanged: [string, string] | null
  bpmDelta: number
  keyChanged: [string, string] | null
  meterChanged: [string, string] | null
  barsDelta: number
  sectionsAdded: string[]
  sectionsRemoved: string[]
  sectionsModified: string[]
  summary: string[]
}

export interface PlaylistDiff {
  changed: boolean
  nameChanged: [string, string] | null
  countDelta: number
  durationDeltaSec: number
  songsAdded: string[]
  songsRemoved: string[]
  reorderedSongs: Array<{ title: string; fromIndex: number; toIndex: number }>
  transitionChanges: Array<{ title: string; from: string; to: string }>
  keyOrBpmChanges: Array<{ title: string; detail: string }>
  summary: string[]
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function normalizeBranchName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return cleaned && BRANCH_RE.test(cleaned) ? cleaned : 'main'
}

export function emptyEntityHistory<T>(branch = 'main'): EntityVcsHistory<T> {
  return {
    activeBranch: normalizeBranchName(branch),
    branches: {},
    commits: [],
  }
}

export function emptyBandVcs(): EcosystemBandVcs {
  return { songs: {}, playlists: {} }
}

function makeCommitId(prefix: string, nowIso: string, count: number): string {
  const compact = nowIso.replace(/[^0-9]/g, '').slice(0, 14)
  return `${prefix}_${compact}_${count + 1}`
}

export interface CommitEntityArgs<T> {
  history: EntityVcsHistory<T> | undefined
  snapshot: T
  message: string
  branch?: string
  authorName?: string
  nowIso?: string
  commitId?: string
}

export function commitEntitySnapshot<T>(args: CommitEntityArgs<T>): {
  history: EntityVcsHistory<T>
  commit: EntityCommit<T>
} {
  const prev = args.history ?? emptyEntityHistory<T>(args.branch ?? 'main')
  const branch = normalizeBranchName(args.branch ?? prev.activeBranch ?? 'main')
  const nowIso = args.nowIso ?? new Date().toISOString()
  const message = args.message.trim().slice(0, 160) || `Snapshot (${branch})`
  const authorName = (args.authorName ?? 'Integrante').trim().slice(0, 80) || 'Integrante'
  const id = args.commitId ?? makeCommitId('v', nowIso, prev.commits.length)
  const parentId = prev.branches[branch] ?? prev.commits[0]?.id ?? null

  const commit: EntityCommit<T> = {
    id,
    branch,
    parentId,
    message,
    authorName,
    createdAt: nowIso,
    snapshot: cloneJson(args.snapshot),
  }

  const nextBranches: Record<string, string> = { ...prev.branches, [branch]: id }
  const headIds = new Set(Object.values(nextBranches))
  const merged = [commit, ...prev.commits.filter((c) => c.id !== id)]
  const commits: EntityCommit<T>[] = []
  for (const item of merged) {
    if (commits.length < MAX_ENTITY_COMMITS || headIds.has(item.id)) commits.push(item)
  }

  return {
    history: {
      activeBranch: branch,
      branches: nextBranches,
      commits,
    },
    commit,
  }
}

export function createEntityBranch<T>(
  history: EntityVcsHistory<T> | undefined,
  branchName: string,
  currentSnapshot: T,
  authorName = 'Integrante',
  nowIso?: string,
): EntityVcsHistory<T> {
  const targetBranch = normalizeBranchName(branchName)
  const base = history ?? emptyEntityHistory<T>('main')
  if (base.branches[targetBranch]) {
    return { ...base, activeBranch: targetBranch }
  }
  return commitEntitySnapshot({
    history: base,
    snapshot: currentSnapshot,
    branch: targetBranch,
    message: `Rama creada: ${targetBranch}`,
    authorName,
    nowIso,
  }).history
}

export function findEntityCommit<T>(history: EntityVcsHistory<T> | undefined, commitId: string): EntityCommit<T> | null {
  if (!history) return null
  return history.commits.find((c) => c.id === commitId) ?? null
}

export function branchHeadSnapshot<T>(history: EntityVcsHistory<T> | undefined, branch: string): T | null {
  if (!history) return null
  const norm = normalizeBranchName(branch)
  const headId = history.branches[norm]
  if (!headId) return null
  const found = findEntityCommit(history, headId)
  return found ? cloneJson(found.snapshot) : null
}

/** Calcula diferencias musicales legibles entre dos versiones de una Cancion (`base` -> `target`). */
export function diffSongs(base: Song, target: Song): SongDiff {
  const summary: string[] = []
  const titleChanged: [string, string] | null = base.title !== target.title ? [base.title, target.title] : null
  if (titleChanged) summary.push(`Título: "${base.title}" -> "${target.title}"`)

  const bpmDelta = Math.round((target.bpm - base.bpm) * 100) / 100
  if (bpmDelta !== 0) summary.push(`BPM: ${base.bpm} -> ${target.bpm} (${bpmDelta > 0 ? `+${bpmDelta}` : bpmDelta})`)

  const keyChanged: [string, string] | null = (base.key || '') !== (target.key || '') ? [base.key || '—', target.key || '—'] : null
  if (keyChanged) summary.push(`Tonalidad: ${keyChanged[0]} -> ${keyChanged[1]}`)

  const baseMeter = `${base.beatsPerBar}/${base.beatUnit}`
  const targetMeter = `${target.beatsPerBar}/${target.beatUnit}`
  const meterChanged: [string, string] | null = baseMeter !== targetMeter ? [baseMeter, targetMeter] : null
  if (meterChanged) summary.push(`Compás: ${baseMeter} -> ${targetMeter}`)

  const barsA = totalBars(base.sections)
  const barsB = totalBars(target.sections)
  const barsDelta = barsB - barsA
  if (barsDelta !== 0) summary.push(`Compases totales: ${barsA} -> ${barsB} (${barsDelta > 0 ? `+${barsDelta}` : barsDelta})`)

  const byIdA = new Map(base.sections.map((s) => [s.id, s]))
  const byIdB = new Map(target.sections.map((s) => [s.id, s]))
  const sectionsAdded: string[] = []
  const sectionsRemoved: string[] = []
  const sectionsModified: string[] = []

  for (const s of target.sections) {
    const prev = byIdA.get(s.id)
    if (!prev) {
      sectionsAdded.push(s.label || s.kind)
    } else if (
      prev.label !== s.label ||
      prev.kind !== s.kind ||
      prev.bars !== s.bars ||
      prev.chordpro.trim() !== s.chordpro.trim() ||
      (prev.cueText ?? null) !== (s.cueText ?? null)
    ) {
      sectionsModified.push(s.label || s.kind)
    }
  }
  for (const s of base.sections) {
    if (!byIdB.has(s.id)) sectionsRemoved.push(s.label || s.kind)
  }

  if (sectionsAdded.length > 0) summary.push(`Secciones añadidas (${sectionsAdded.length}): ${sectionsAdded.join(', ')}`)
  if (sectionsRemoved.length > 0) summary.push(`Secciones eliminadas (${sectionsRemoved.length}): ${sectionsRemoved.join(', ')}`)
  if (sectionsModified.length > 0) summary.push(`Secciones editadas (${sectionsModified.length}): ${sectionsModified.join(', ')}`)
  if ((base.notes ?? '') !== (target.notes ?? '')) summary.push('Notas de interpretación modificadas')

  return {
    changed: summary.length > 0,
    titleChanged,
    bpmDelta,
    keyChanged,
    meterChanged,
    barsDelta,
    sectionsAdded,
    sectionsRemoved,
    sectionsModified,
    summary,
  }
}

/** Calcula diferencias de orden, repertorio y transiciones entre dos versiones de un Setlist. */
export function diffPlaylists(base: Playlist, target: Playlist): PlaylistDiff {
  const summary: string[] = []
  const nameChanged: [string, string] | null = base.name !== target.name ? [base.name, target.name] : null
  if (nameChanged) summary.push(`Nombre: "${base.name}" -> "${target.name}"`)

  const countDelta = target.songs.length - base.songs.length
  const durA = base.songs.reduce((acc, s) => acc + (s.durationSec || 0) + (s.gapSec || 0), 0)
  const durB = target.songs.reduce((acc, s) => acc + (s.durationSec || 0) + (s.gapSec || 0), 0)
  const durationDeltaSec = Math.round(durB - durA)

  if (countDelta !== 0) summary.push(`Temas: ${base.songs.length} -> ${target.songs.length}`)
  if (Math.abs(durationDeltaSec) >= 1) {
    summary.push(`Duración total: ${durationDeltaSec > 0 ? `+${durationDeltaSec}` : durationDeltaSec} s`)
  }

  const mapA = new Map(base.songs.map((s, idx) => [s.id || `${s.songId}:${idx}`, { item: s, index: idx }]))
  const mapB = new Map(target.songs.map((s, idx) => [s.id || `${s.songId}:${idx}`, { item: s, index: idx }]))

  const songsAdded: string[] = []
  const songsRemoved: string[] = []
  const reorderedSongs: Array<{ title: string; fromIndex: number; toIndex: number }> = []
  const transitionChanges: Array<{ title: string; from: string; to: string }> = []
  const keyOrBpmChanges: Array<{ title: string; detail: string }> = []

  for (const [key, entryB] of mapB) {
    const entryA = mapA.get(key)
    if (!entryA) {
      songsAdded.push(entryB.item.title)
      continue
    }
    if (entryA.index !== entryB.index) {
      reorderedSongs.push({ title: entryB.item.title, fromIndex: entryA.index + 1, toIndex: entryB.index + 1 })
    }
    if (entryA.item.transitionMode !== entryB.item.transitionMode) {
      transitionChanges.push({ title: entryB.item.title, from: entryA.item.transitionMode, to: entryB.item.transitionMode })
    }
    const details: string[] = []
    if (entryA.item.bpm !== entryB.item.bpm) details.push(`${entryA.item.bpm}->${entryB.item.bpm} BPM`)
    if (entryA.item.showKey !== entryB.item.showKey) details.push(`Tono ${entryA.item.showKey || '—'}->${entryB.item.showKey || '—'}`)
    if (details.length > 0) keyOrBpmChanges.push({ title: entryB.item.title, detail: details.join(', ') })
  }

  for (const [key, entryA] of mapA) {
    if (!mapB.has(key)) songsRemoved.push(entryA.item.title)
  }

  if (songsAdded.length > 0) summary.push(`Añadidos (${songsAdded.length}): ${songsAdded.join(', ')}`)
  if (songsRemoved.length > 0) summary.push(`Quitados (${songsRemoved.length}): ${songsRemoved.join(', ')}`)
  if (reorderedSongs.length > 0) summary.push(`Reordenados: ${reorderedSongs.length} temas`)
  if (transitionChanges.length > 0) summary.push(`Transiciones cambiadas: ${transitionChanges.length}`)
  if (keyOrBpmChanges.length > 0) summary.push(`Ajustes de show (BPM/Tono): ${keyOrBpmChanges.length}`)

  return {
    changed: summary.length > 0,
    nameChanged,
    countDelta,
    durationDeltaSec,
    songsAdded,
    songsRemoved,
    reorderedSongs,
    transitionChanges,
    keyOrBpmChanges,
    summary,
  }
}

/** Obtiene el almacen VCS de una banda dentro de `WorkspaceStore` (vacio si aun no existe). */
export function getBandVcs(ws: WorkspaceStore, bandId: string): EcosystemBandVcs {
  const raw = ws.vcsMap?.[bandId]
  if (!raw || typeof raw !== 'object') return emptyBandVcs()
  return {
    songs: raw.songs && typeof raw.songs === 'object' ? raw.songs : {},
    playlists: raw.playlists && typeof raw.playlists === 'object' ? raw.playlists : {},
  }
}

/** Escribe el historial VCS de una cancion en `WorkspaceStore`. */
export function withSongHistory(ws: WorkspaceStore, bandId: string, songId: string, history: EntityVcsHistory<Song>): WorkspaceStore {
  const bandVcs = getBandVcs(ws, bandId)
  return {
    ...ws,
    vcsMap: {
      ...(ws.vcsMap ?? {}),
      [bandId]: {
        ...bandVcs,
        songs: { ...bandVcs.songs, [songId]: history },
      },
    },
  }
}

/** Escribe el historial VCS de un setlist en `WorkspaceStore`. */
export function withPlaylistHistory(ws: WorkspaceStore, bandId: string, playlistId: string, history: EntityVcsHistory<Playlist>): WorkspaceStore {
  const bandVcs = getBandVcs(ws, bandId)
  return {
    ...ws,
    vcsMap: {
      ...(ws.vcsMap ?? {}),
      [bandId]: {
        ...bandVcs,
        playlists: { ...bandVcs.playlists, [playlistId]: history },
      },
    },
  }
}
