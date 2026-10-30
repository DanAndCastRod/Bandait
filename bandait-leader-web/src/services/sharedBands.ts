/**
 * Bandas compartidas (docs/DEPLOY.md, seccion 3.11; SQL en docs/sql/bandas_compartidas.sql).
 *
 * Una banda compartida vive en su propia fila de `bandait_bands`: un documento de workspace v2
 * con UNA sola banda, cuyo id es el de la fila. La pertenencia (correo + rol) vive en
 * `bandait_band_members` y la hace cumplir RLS; aqui solo se refleja en la UI.
 *
 * El Hub trabaja sobre un workspace UNIDO: la parte personal (la fila de bandait_workspaces)
 * mas cada banda compartida. Este modulo parte y une ese workspace. Es puro (sin React ni
 * supabase-js) y se prueba con `node scripts/verify-shared-bands-logic.ts`.
 */

import type { Band, BandMember, MemberRole, Playlist, PlaylistSong, Song, WorkspaceStore } from '../types/hub.ts'

/** Roles que editan canciones y setlists de una banda compartida (lo mismo que exige RLS). */
export const EDIT_ROLES: readonly MemberRole[] = ['Owner', 'MusicDirector']
/** Roles que invitan integrantes (un MusicDirector no puede invitar a un Owner). */
export const INVITE_ROLES: readonly MemberRole[] = ['Owner', 'MusicDirector']

export const canEditRole = (role: MemberRole | null | undefined): boolean => !!role && EDIT_ROLES.includes(role)
export const canInviteRole = (role: MemberRole | null | undefined): boolean => !!role && INVITE_ROLES.includes(role)

export const MEMBER_ROLES: readonly MemberRole[] = ['Owner', 'MusicDirector', 'Musician', 'Substitute', 'SoundEngineer']

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

/** Fila de bandait_band_members tal como la devuelve PostgREST. */
export interface MemberRow {
  band_id: string
  email: string
  role: string
  name: string
  instrument: string
  created_at: string
}

/** Banda compartida a la que el usuario tiene acceso. */
export interface SharedBand {
  id: string
  ownerId: string
  /** Rol del usuario actual (quien la creo es siempre Owner). */
  role: MemberRole
  /** Documento v2 de una sola banda (bands[0].id === id). */
  data: WorkspaceStore
  members: BandMember[]
}

const isMemberRole = (value: string): value is MemberRole => (MEMBER_ROLES as readonly string[]).includes(value)

/** Rol del usuario actual en una banda compartida, o null si no aparece. */
export function resolveSharedRole(
  ownerId: string,
  rows: readonly MemberRow[],
  currentUserId: string,
  currentEmail: string
): MemberRole | null {
  if (ownerId === currentUserId) return 'Owner'
  const mine = rows.find((r) => normalizeEmail(r.email) === normalizeEmail(currentEmail))
  return mine && isMemberRole(mine.role) ? mine.role : null
}

/**
 * Integrantes para la UI. El del usuario actual lleva su userId real (asi `resolveActorRole`
 * lo reconoce); el resto, `email:<correo>`, porque la nube no expone ids de otras cuentas.
 * Quien creo la banda aparece aunque no tenga fila propia.
 */
export function membersFromRows(
  rows: readonly MemberRow[],
  bandId: string,
  ownerId: string,
  currentUserId: string,
  currentEmail: string,
  ownerFallback: { name: string; email: string } | null = null
): BandMember[] {
  const me = normalizeEmail(currentEmail)
  const members: BandMember[] = rows
    .filter((r) => r.band_id === bandId && isMemberRole(r.role))
    .map((r) => {
      const email = normalizeEmail(r.email)
      return {
        id: `mem_${email}`,
        bandId,
        userId: email === me ? currentUserId : `email:${email}`,
        name: r.name || email.split('@')[0],
        email,
        role: r.role as MemberRole,
        instrument: r.instrument || 'Instrumentista',
        joinedAt: (r.created_at || '').slice(0, 10),
      }
    })
  if (ownerId === currentUserId && !members.some((m) => m.userId === currentUserId) && ownerFallback) {
    members.unshift({
      id: `mem_${normalizeEmail(ownerFallback.email) || 'owner'}`,
      bandId,
      userId: currentUserId,
      name: ownerFallback.name,
      email: normalizeEmail(ownerFallback.email),
      role: 'Owner',
      instrument: 'Director Musical',
      joinedAt: '',
    })
  }
  return members
}

/**
 * Documento de una sola banda para guardar en bandait_bands. Normaliza los campos que dependen
 * de quien mira (rol, cantidad de integrantes) y deja fuera integrantes y stems: los
 * integrantes viven en su tabla y los stems son de cada cuenta.
 */
export function sliceBand(ws: WorkspaceStore, bandId: string): WorkspaceStore | null {
  const band = ws.bands.find((b) => b.id === bandId)
  if (!band) return null
  const voice = ws.voiceMap?.[bandId]
  return {
    schemaVersion: ws.schemaVersion,
    activeBandId: bandId,
    bands: [{ ...band, currentUserRole: 'Owner', membersCount: 0 }],
    membersMap: { [bandId]: [] },
    playlistsMap: { [bandId]: ws.playlistsMap[bandId] ?? [] },
    equipmentMap: { [bandId]: ws.equipmentMap[bandId] ?? [] },
    stemsMap: {},
    songsMap: { [bandId]: ws.songsMap?.[bandId] ?? [] },
    voiceMap: voice ? { [bandId]: voice } : {},
  }
}

function withoutKeys<T>(map: Record<string, T> | undefined, ids: ReadonlySet<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(map ?? {})) if (!ids.has(k)) out[k] = v
  return out
}

/**
 * Parte personal del workspace unido (lo que va a bandait_workspaces y a localStorage).
 * Si la banda activa es compartida, la personal conserva `fallbackActive` (la ultima personal).
 */
export function personalPart(ws: WorkspaceStore, sharedIds: ReadonlySet<string>, fallbackActive: string): WorkspaceStore {
  const bands = ws.bands.filter((b) => !sharedIds.has(b.id))
  const has = (id: string) => bands.some((b) => b.id === id)
  const activeBandId = has(ws.activeBandId) ? ws.activeBandId : has(fallbackActive) ? fallbackActive : bands[0]?.id ?? ''
  return {
    ...ws,
    bands,
    activeBandId,
    membersMap: withoutKeys(ws.membersMap, sharedIds),
    playlistsMap: withoutKeys(ws.playlistsMap, sharedIds),
    equipmentMap: withoutKeys(ws.equipmentMap, sharedIds),
    songsMap: withoutKeys(ws.songsMap, sharedIds),
    voiceMap: withoutKeys(ws.voiceMap, sharedIds),
  }
}

/** Workspace unido: personal + compartidas. Una compartida cuyo id choque con una personal se omite. */
export function mergeWorkspace(personal: WorkspaceStore, shared: readonly SharedBand[], activeBandId: string): WorkspaceStore {
  const ws: WorkspaceStore = {
    ...personal,
    bands: [...personal.bands],
    membersMap: { ...personal.membersMap },
    playlistsMap: { ...personal.playlistsMap },
    equipmentMap: { ...personal.equipmentMap },
    songsMap: { ...personal.songsMap },
    voiceMap: { ...personal.voiceMap },
  }
  for (const sb of shared) {
    const id = sb.id
    const band = sb.data.bands.find((b) => b.id === id)
    if (!band || ws.bands.some((b) => b.id === id)) continue
    const merged: Band = { ...band, ownerId: sb.ownerId, currentUserRole: sb.role, membersCount: sb.members.length }
    ws.bands.push(merged)
    ws.membersMap[id] = sb.members
    ws.playlistsMap[id] = sb.data.playlistsMap[id] ?? []
    ws.equipmentMap[id] = sb.data.equipmentMap[id] ?? []
    ws.songsMap[id] = sb.data.songsMap?.[id] ?? []
    const voice = sb.data.voiceMap?.[id]
    if (voice) ws.voiceMap[id] = voice
  }
  ws.activeBandId = ws.bands.some((b) => b.id === activeBandId)
    ? activeBandId
    : ws.bands.some((b) => b.id === personal.activeBandId)
      ? personal.activeBandId
      : ws.bands[0]?.id ?? ''
  return ws
}

/** Copia de un documento de una banda con otro id de banda (al compartir una banda personal). */
export function remapBandId(slice: WorkspaceStore, fromId: string, toId: string): WorkspaceStore {
  const band = slice.bands.find((b) => b.id === fromId)
  if (!band) return slice
  return {
    ...slice,
    activeBandId: toId,
    bands: [{ ...band, id: toId }],
    membersMap: { [toId]: [] },
    playlistsMap: { [toId]: (slice.playlistsMap[fromId] ?? []).map((pl) => ({ ...pl, bandId: toId })) },
    equipmentMap: { [toId]: (slice.equipmentMap[fromId] ?? []).map((eq) => ({ ...eq, bandId: toId })) },
    songsMap: { [toId]: slice.songsMap?.[fromId] ?? [] },
    voiceMap: slice.voiceMap?.[fromId] ? { [toId]: slice.voiceMap[fromId] } : {},
  }
}

/** Invitaciones a crear al compartir una banda personal: sus integrantes con correo valido. */
export function invitesFromMembers(
  members: readonly BandMember[],
  ownerEmail: string
): Array<{ email: string; role: MemberRole; name: string; instrument: string }> {
  const owner = normalizeEmail(ownerEmail)
  const seen = new Set<string>()
  const out: Array<{ email: string; role: MemberRole; name: string; instrument: string }> = []
  for (const m of members) {
    const email = normalizeEmail(m.email || '')
    if (!isValidEmail(email) || seen.has(email)) continue
    seen.add(email)
    out.push({
      email,
      role: email === owner ? 'Owner' : m.role,
      name: (m.name || '').slice(0, 120),
      instrument: (m.instrument || '').slice(0, 120),
    })
  }
  if (owner && isValidEmail(owner) && !seen.has(owner)) {
    out.unshift({ email: owner, role: 'Owner', name: '', instrument: 'Director Musical' })
  }
  return out
}

const looseText = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const songKey = (title: string, artist: string) => `${looseText(title)}\u0000${looseText(artist)}`

export interface CopyPlaylistResult {
  workspace: WorkspaceStore
  playlist: Playlist
  /** Canciones nuevas en la libreria de destino. */
  createdSongs: number
  /** Canciones que ya estaban en el destino (mismo titulo y artista) y se reutilizaron. */
  reusedSongs: number
}

/**
 * Copia un setlist (y las canciones que use) de una banda a otra dentro del workspace unido.
 * Las canciones se emparejan por titulo + artista (sin tildes ni mayusculas): si el destino ya
 * la tiene, se reutiliza; si no, se copia con ids nuevos (cancion y secciones). Nunca toca el origen.
 */
export function copyPlaylistToBand(
  ws: WorkspaceStore,
  fromBandId: string,
  playlistId: string,
  toBandId: string,
  newId: () => string,
  now: string
): CopyPlaylistResult | null {
  if (fromBandId === toBandId) return null
  const source = (ws.playlistsMap[fromBandId] ?? []).find((p) => p.id === playlistId)
  if (!source || !ws.bands.some((b) => b.id === toBandId)) return null
  const sourceSongs = ws.songsMap?.[fromBandId] ?? []
  const targetSongs = [...(ws.songsMap?.[toBandId] ?? [])]
  const byKey = new Map(targetSongs.map((s) => [songKey(s.title, s.artist), s]))
  const idMap = new Map<string, string>()
  let createdSongs = 0
  let reusedSongs = 0

  const items: PlaylistSong[] = source.songs.map((item) => {
    let targetId = idMap.get(item.songId)
    if (!targetId) {
      const original: Song | undefined = sourceSongs.find((s) => s.id === item.songId)
      const title = original?.title ?? item.title
      const artist = original?.artist ?? item.artist
      const existing = byKey.get(songKey(title, artist))
      if (existing) {
        targetId = existing.id
        reusedSongs += 1
      } else {
        const copy: Song = original
          ? {
              ...JSON.parse(JSON.stringify(original)),
              id: newId(),
              sections: original.sections.map((sec) => ({ ...JSON.parse(JSON.stringify(sec)), id: newId() })),
              updatedAt: now,
            }
          : {
              id: newId(),
              title,
              artist,
              bpm: item.bpm,
              beatsPerBar: 4,
              beatUnit: 4,
              key: item.key,
              camelot: item.camelot,
              durationSec: item.durationSec,
              sections: [],
              updatedAt: now,
            }
        targetSongs.push(copy)
        byKey.set(songKey(copy.title, copy.artist), copy)
        targetId = copy.id
        createdSongs += 1
      }
      idMap.set(item.songId, targetId)
    }
    return { ...item, id: newId(), songId: targetId }
  })

  const targetPlaylists = ws.playlistsMap[toBandId] ?? []
  const name = targetPlaylists.some((p) => p.name === source.name) ? `${source.name} (copia)` : source.name
  const day = now.slice(0, 10)
  const playlist: Playlist = { ...source, id: `pl_${newId()}`, bandId: toBandId, name, songs: items, createdAt: day, updatedAt: day }

  return {
    workspace: {
      ...ws,
      songsMap: { ...ws.songsMap, [toBandId]: targetSongs },
      playlistsMap: { ...ws.playlistsMap, [toBandId]: [...targetPlaylists, playlist] },
    },
    playlist,
    createdSongs,
    reusedSongs,
  }
}

/** Parametro de la URL que abre una banda compartida: ?banda=<uuid>. */
export const INVITE_PARAM = 'banda'

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function inviteLink(appBaseUrl: string, bandId: string): string {
  const base = appBaseUrl.endsWith('/') ? appBaseUrl : `${appBaseUrl}/`
  return `${base}?${INVITE_PARAM}=${encodeURIComponent(bandId)}`
}

/** Id de banda de un enlace de invitacion, o null. Solo acepta un UUID. */
export function readInviteParam(search: string): string | null {
  const value = new URLSearchParams(search).get(INVITE_PARAM)
  return value && UUID_LIKE.test(value) ? value.toLowerCase() : null
}
