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
/**
 * Topes de `vcsMap` (WORKSPACE_V2.md 9). Cada commit es una copia completa de la cancion o del
 * setlist y viaja dentro de `bandait_bands.content` (banda compartida) o de
 * `bandait_workspaces.workspace` (personal), asi que el historial tiene que ser corto.
 */
export const MAX_ENTITY_COMMITS = 12
/** Bytes (UTF-8) del historial de UNA banda. */
export const MAX_BAND_VCS_BYTES = 256 * 1024
/** Bytes del historial de todas las bandas de un workspace personal juntas. */
export const MAX_WORKSPACE_VCS_BYTES = 1024 * 1024
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

function randomSuffix(): string {
  const bytes = new Uint8Array(4)
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Id unico de verdad: fecha + sufijo aleatorio, distinto de todos los del historial. */
function makeCommitId(prefix: string, nowIso: string, existing: readonly { id: string }[]): string {
  const compact = nowIso.replace(/[^0-9]/g, '').slice(0, 14)
  const taken = new Set(existing.map((c) => c.id))
  let id = `${prefix}_${compact}_${randomSuffix()}`
  while (taken.has(id)) id = `${prefix}_${compact}_${randomSuffix()}`
  return id
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
  const id = args.commitId ?? makeCommitId('v', nowIso, prev.commits)
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Lector tolerante de un historial (WORKSPACE_V2.md 9): descarta commits sin la forma minima,
 * ramas que apuntan a commits que no estan y conserva los campos desconocidos de cada commit.
 * Devuelve null si no queda nada utilizable.
 */
function readHistory<T>(raw: unknown): EntityVcsHistory<T> | null {
  if (!isRecord(raw) || !Array.isArray(raw.commits)) return null
  const commits: EntityCommit<T>[] = []
  const seen = new Set<string>()
  for (const c of raw.commits) {
    if (!isRecord(c) || typeof c.id !== 'string' || !c.id || seen.has(c.id) || typeof c.branch !== 'string' || !isRecord(c.snapshot)) continue
    seen.add(c.id)
    commits.push({
      ...(c as unknown as EntityCommit<T>),
      parentId: typeof c.parentId === 'string' ? c.parentId : null,
      message: typeof c.message === 'string' ? c.message : '',
      authorName: typeof c.authorName === 'string' ? c.authorName : 'Integrante',
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
    })
  }
  const branches: Record<string, string> = {}
  if (isRecord(raw.branches)) {
    for (const [k, v] of Object.entries(raw.branches)) if (BRANCH_RE.test(k) && typeof v === 'string' && seen.has(v)) branches[k] = v
  }
  if (commits.length === 0) return null
  const activeBranch = typeof raw.activeBranch === 'string' && BRANCH_RE.test(raw.activeBranch) ? raw.activeBranch : 'main'
  return { activeBranch, branches, commits }
}

function readHistories<T>(raw: unknown): Record<string, EntityVcsHistory<T>> {
  const out: Record<string, EntityVcsHistory<T>> = {}
  if (!isRecord(raw)) return out
  for (const [id, h] of Object.entries(raw)) {
    const history = readHistory<T>(h)
    if (history) out[id] = history
  }
  return out
}

/** Obtiene el almacen VCS de una banda dentro de `WorkspaceStore` (vacio si aun no existe). */
export function getBandVcs(ws: WorkspaceStore, bandId: string): EcosystemBandVcs {
  const raw = ws.vcsMap?.[bandId] as unknown
  if (!isRecord(raw)) return emptyBandVcs()
  return {
    ...(raw as unknown as EcosystemBandVcs),
    songs: readHistories<Song>(raw.songs),
    playlists: readHistories<Playlist>(raw.playlists),
  }
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

/** Recorta un historial a MAX_ENTITY_COMMITS (las cabezas de rama se quedan). */
function capHistory<T>(history: EntityVcsHistory<T>): EntityVcsHistory<T> {
  if (history.commits.length <= MAX_ENTITY_COMMITS) return history
  const heads = new Set(Object.values(history.branches))
  const commits: EntityCommit<T>[] = []
  for (const c of history.commits) if (commits.length < MAX_ENTITY_COMMITS || heads.has(c.id)) commits.push(c)
  return { ...history, commits }
}

export interface PruneBandVcsOptions {
  /** Canciones que existen: los historiales de las demas se borran. Sin el campo, no se filtra. */
  songIds?: ReadonlySet<string>
  playlistIds?: ReadonlySet<string>
  maxBytes?: number
}

/**
 * Poda el historial de una banda: quita el de entidades borradas, deja MAX_ENTITY_COMMITS por
 * entidad y, si la banda pasa de `maxBytes`, expulsa primero los commits mas viejos que no son
 * cabeza, luego las ramas mas viejas que no son la activa y por ultimo los historiales enteros
 * mas viejos. Pura y determinista.
 */
export function pruneBandVcs(bandVcs: EcosystemBandVcs, options: PruneBandVcsOptions = {}): EcosystemBandVcs {
  const maxBytes = options.maxBytes ?? MAX_BAND_VCS_BYTES
  type Kind = 'songs' | 'playlists'
  const tables: Record<Kind, Record<string, EntityVcsHistory<unknown>>> = { songs: {}, playlists: {} }
  for (const kind of ['songs', 'playlists'] as const) {
    const live = kind === 'songs' ? options.songIds : options.playlistIds
    for (const [id, h] of Object.entries(bandVcs[kind] as Record<string, EntityVcsHistory<unknown>>)) {
      if (live && !live.has(id)) continue
      const history = readHistory<unknown>(h)
      if (history) tables[kind][id] = capHistory(history)
    }
  }
  const rebuild = (): EcosystemBandVcs => ({
    ...bandVcs,
    songs: tables.songs as Record<string, EntityVcsHistory<Song>>,
    playlists: tables.playlists as Record<string, EntityVcsHistory<Playlist>>,
  })
  // Tamano por commit, calculado una vez; el total se descuenta al expulsar.
  const sizes = new Map<EntityCommit<unknown>, number>()
  let total = utf8Bytes({ songs: {}, playlists: {} })
  for (const kind of ['songs', 'playlists'] as const) {
    for (const [id, h] of Object.entries(tables[kind])) {
      total += utf8Bytes(id) + utf8Bytes({ activeBranch: h.activeBranch, branches: h.branches, commits: [] })
      for (const c of h.commits) {
        const size = utf8Bytes(c) + 1
        sizes.set(c, size)
        total += size
      }
    }
  }
  const removeCommit = (kind: Kind, id: string, commit: EntityCommit<unknown>) => {
    const h = tables[kind][id]
    const commits = h.commits.filter((c) => c !== commit)
    const branches = Object.fromEntries(Object.entries(h.branches).filter(([, head]) => head !== commit.id))
    total -= sizes.get(commit) ?? 0
    if (commits.length === 0) delete tables[kind][id]
    else tables[kind][id] = { ...h, commits, branches }
  }
  while (total > maxBytes) {
    // 1) El commit mas viejo que no es cabeza. 2) La cabeza mas vieja que no es la rama activa.
    // 3) La cabeza mas vieja de todas (se pierde ese historial entero si era el ultimo commit).
    let victim: { kind: Kind; id: string; commit: EntityCommit<unknown>; rank: number } | null = null
    for (const kind of ['songs', 'playlists'] as const) {
      for (const [id, h] of Object.entries(tables[kind])) {
        const heads = new Set(Object.values(h.branches))
        const activeHead = h.branches[h.activeBranch]
        for (const commit of h.commits) {
          const rank = !heads.has(commit.id) ? 0 : commit.id !== activeHead ? 1 : 2
          if (!victim || rank < victim.rank || (rank === victim.rank && commit.createdAt < victim.commit.createdAt)) {
            victim = { kind, id, commit, rank }
          }
        }
      }
    }
    if (!victim) break
    removeCommit(victim.kind, victim.id, victim.commit)
  }
  return rebuild()
}

/**
 * Poda `vcsMap` de un workspace: quita las bandas que ya no estan, los historiales de canciones y
 * setlists borrados, y aplica los topes por banda y del workspace entero (WORKSPACE_V2.md 9).
 */
export function pruneWorkspaceVcs(ws: WorkspaceStore): WorkspaceStore {
  if (!ws.vcsMap) return ws
  const bandIds = ws.bands.map((b) => b.id).filter((id) => ws.vcsMap?.[id])
  const perBand = Math.min(MAX_BAND_VCS_BYTES, Math.floor(MAX_WORKSPACE_VCS_BYTES / Math.max(1, bandIds.length)))
  const vcsMap: Record<string, EcosystemBandVcs> = {}
  for (const bandId of bandIds) {
    const pruned = pruneBandVcs(getBandVcs(ws, bandId), {
      songIds: new Set((ws.songsMap?.[bandId] ?? []).map((s) => s.id)),
      playlistIds: new Set((ws.playlistsMap[bandId] ?? []).map((p) => p.id)),
      maxBytes: perBand,
    })
    if (Object.keys(pruned.songs).length > 0 || Object.keys(pruned.playlists).length > 0) vcsMap[bandId] = pruned
  }
  return { ...ws, vcsMap }
}

/** Escribe el historial VCS de una cancion en `WorkspaceStore` (y aplica los topes). */
export function withSongHistory(ws: WorkspaceStore, bandId: string, songId: string, history: EntityVcsHistory<Song>): WorkspaceStore {
  const bandVcs = getBandVcs(ws, bandId)
  return pruneWorkspaceVcs({
    ...ws,
    vcsMap: {
      ...(ws.vcsMap ?? {}),
      [bandId]: {
        ...bandVcs,
        songs: { ...bandVcs.songs, [songId]: history },
      },
    },
  })
}

/** Escribe el historial VCS de un setlist en `WorkspaceStore` (y aplica los topes). */
export function withPlaylistHistory(ws: WorkspaceStore, bandId: string, playlistId: string, history: EntityVcsHistory<Playlist>): WorkspaceStore {
  const bandVcs = getBandVcs(ws, bandId)
  return pruneWorkspaceVcs({
    ...ws,
    vcsMap: {
      ...(ws.vcsMap ?? {}),
      [bandId]: {
        ...bandVcs,
        playlists: { ...bandVcs.playlists, [playlistId]: history },
      },
    },
  })
}
