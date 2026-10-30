/**
 * Verificacion de la logica pura de bandas compartidas (src/services/sharedBands.ts).
 *   node --experimental-strip-types scripts/verify-shared-bands-logic.ts   (parte de npm run verify:logic)
 *
 * Cubre: partir y unir el workspace sin falsos "cambios" (lo que dispararia subidas a la nube),
 * deteccion de ediciones reales por parte, remapeo de id al compartir, invitaciones a partir de
 * los integrantes, copia de setlists entre bandas (reutiliza canciones, ids nuevos, origen
 * intacto, resultado valido), roles y enlaces de invitacion.
 * Las politicas RLS se prueban aparte: `npm run test:rls` desde la raiz del repo.
 */
import assert from 'node:assert/strict'
import fixtureJson from '../../bandait-protocol/fixtures/workspace_v2.json' with { type: 'json' }
import {
  canEditRole,
  canInviteRole,
  copyPlaylistToBand,
  inviteLink,
  invitesFromMembers,
  membersFromRows,
  mergeWorkspace,
  personalPart,
  readInviteParam,
  remapBandId,
  resolveSharedRole,
  sliceBand,
  type MemberRow,
  type SharedBand,
} from '../src/services/sharedBands.ts'
import { loadWorkspaceDocument, validateWorkspace } from '../src/services/workspaceSchema.ts'
import { stableStringify } from '../src/services/workspaceSync.ts'
import type { BandMember, WorkspaceStore } from '../src/types/hub.ts'

let passed = 0
const failures: string[] = []
function check(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`)
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const personalFixture = () => loadWorkspaceDocument(clone(fixtureJson)) as WorkspaceStore
const SHARED_ID = '9f1c2b3a-1111-4222-8333-444455556666'
const ME = 'user-me'
const OWNER = 'user-owner'
let counter = 0
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

/** Banda compartida hecha a partir de la banda del fixture, con otro id. */
function sharedFromFixture(role: SharedBand['role'] = 'Musician'): SharedBand {
  const base = personalFixture()
  const slice = sliceBand(base, base.bands[0].id) as WorkspaceStore
  const data = remapBandId(slice, base.bands[0].id, SHARED_ID)
  data.bands[0].name = "B&O's"
  return { id: SHARED_ID, ownerId: OWNER, role, data, members: [] }
}

function main() {
  console.log('Partir y unir')

  check('unir y volver a partir no cambia la parte personal ni la compartida', () => {
    const personal = personalFixture()
    const shared = sharedFromFixture()
    const merged = mergeWorkspace(personal, [shared], SHARED_ID)
    assert.equal(merged.bands.length, personal.bands.length + 1)
    assert.equal(merged.activeBandId, SHARED_ID)
    const back = personalPart(merged, new Set([SHARED_ID]), personal.activeBandId)
    assert.equal(stableStringify(back), stableStringify(personal), 'la parte personal sale identica')
    assert.equal(stableStringify(sliceBand(merged, SHARED_ID)), stableStringify(sliceBand(mergeWorkspace(personal, [shared], ''), SHARED_ID)))
  })

  check('el rol y la cantidad de integrantes no cuentan como edicion del contenido', () => {
    const personal = personalFixture()
    const a = mergeWorkspace(personal, [sharedFromFixture('Musician')], SHARED_ID)
    const member: BandMember = { id: 'm', bandId: SHARED_ID, userId: ME, name: 'Yo', email: 'yo@x.co', role: 'Owner', instrument: '', joinedAt: '' }
    const b = mergeWorkspace(personal, [{ ...sharedFromFixture('Owner'), members: [member] }], SHARED_ID)
    assert.equal(a.bands.find((x) => x.id === SHARED_ID)?.currentUserRole, 'Musician')
    assert.equal(b.bands.find((x) => x.id === SHARED_ID)?.currentUserRole, 'Owner')
    assert.equal(b.membersMap[SHARED_ID].length, 1)
    assert.equal(stableStringify(sliceBand(a, SHARED_ID)), stableStringify(sliceBand(b, SHARED_ID)))
    assert.deepEqual(sliceBand(b, SHARED_ID)?.membersMap[SHARED_ID], [], 'los integrantes nunca van en el documento')
  })

  check('editar una cancion compartida cambia solo esa parte', () => {
    const personal = personalFixture()
    const merged = mergeWorkspace(personal, [sharedFromFixture('Owner')], SHARED_ID)
    const beforeShared = stableStringify(sliceBand(merged, SHARED_ID))
    const edited = clone(merged)
    edited.songsMap[SHARED_ID][0].bpm = 99
    assert.notEqual(stableStringify(sliceBand(edited, SHARED_ID)), beforeShared)
    assert.equal(
      stableStringify(personalPart(edited, new Set([SHARED_ID]), personal.activeBandId)),
      stableStringify(personal),
      'la parte personal no se entera'
    )
  })

  check('cambiar a una banda compartida no altera la banda activa guardada en la parte personal', () => {
    const personal = personalFixture()
    const merged = mergeWorkspace(personal, [sharedFromFixture()], personal.activeBandId)
    const switched = { ...merged, activeBandId: SHARED_ID }
    assert.equal(personalPart(switched, new Set([SHARED_ID]), personal.activeBandId).activeBandId, personal.activeBandId)
  })

  check('una compartida con el mismo id que una personal se omite (nunca pisa datos personales)', () => {
    const personal = personalFixture()
    const clash = { ...sharedFromFixture(), id: personal.bands[0].id }
    const merged = mergeWorkspace(personal, [clash], personal.bands[0].id)
    assert.equal(merged.bands.length, personal.bands.length)
    assert.equal(merged.bands[0].name, personal.bands[0].name)
  })

  check('la banda activa cae en la personal si la recordada ya no existe', () => {
    const personal = personalFixture()
    assert.equal(mergeWorkspace(personal, [], 'ya-no-existe').activeBandId, personal.activeBandId)
  })

  check('el documento de una banda compartida es un workspace v2 valido que se vuelve a cargar igual', () => {
    const data = sharedFromFixture().data
    assert.equal(data.bands.length, 1)
    assert.equal(data.bands[0].id, SHARED_ID)
    assert.ok(data.playlistsMap[SHARED_ID].every((p) => p.bandId === SHARED_ID), 'playlists remapeadas')
    const reloaded = loadWorkspaceDocument(clone(data))
    assert.ok(reloaded)
    assert.equal(stableStringify(reloaded), stableStringify(data))
    assert.ok(validateWorkspace(data).ok, validateWorkspace(data).errors.join(' '))
  })

  console.log('Invitaciones y roles')

  check('invitaciones desde los integrantes: correos normalizados, sin duplicados, Owner primero', () => {
    const base = { bandId: 'b', userId: 'x', instrument: 'Bajo', joinedAt: '' }
    const invites = invitesFromMembers(
      [
        { ...base, id: '1', name: 'Pipe', email: ' Pipe@Gmail.com ', role: 'Musician' },
        { ...base, id: '2', name: 'Pipe dup', email: 'pipe@gmail.com', role: 'Substitute' },
        { ...base, id: '3', name: 'Sin correo', email: '', role: 'Musician' },
        { ...base, id: '4', name: 'Malo', email: 'no-es-correo', role: 'Musician' },
      ],
      'Daniel@Grupo.co'
    )
    assert.deepEqual(
      invites.map((i) => [i.email, i.role]),
      [
        ['daniel@grupo.co', 'Owner'],
        ['pipe@gmail.com', 'Musician'],
      ]
    )
  })

  check('rol: quien crea es Owner; los demas segun su fila por correo; un ajeno no tiene rol', () => {
    const rows: MemberRow[] = [{ band_id: SHARED_ID, email: 'pipe@gmail.com', role: 'MusicDirector', name: 'Pipe', instrument: '', created_at: '2026-10-29T00:00:00Z' }]
    assert.equal(resolveSharedRole(OWNER, rows, OWNER, 'otro@x.co'), 'Owner')
    assert.equal(resolveSharedRole(OWNER, rows, ME, 'PIPE@gmail.com'), 'MusicDirector')
    assert.equal(resolveSharedRole(OWNER, rows, ME, 'nadie@x.co'), null)
    assert.ok(canEditRole('MusicDirector') && canEditRole('Owner') && !canEditRole('Musician') && !canEditRole(null))
    assert.ok(canInviteRole('MusicDirector') && !canInviteRole('SoundEngineer'))
  })

  check('integrantes para la UI: el propio con su userId real, el creador aunque no tenga fila', () => {
    const rows: MemberRow[] = [{ band_id: SHARED_ID, email: 'pipe@gmail.com', role: 'Musician', name: '', instrument: '', created_at: '2026-10-29T10:00:00Z' }]
    const asPipe = membersFromRows(rows, SHARED_ID, OWNER, ME, 'pipe@gmail.com')
    assert.equal(asPipe.length, 1)
    assert.equal(asPipe[0].userId, ME)
    assert.equal(asPipe[0].name, 'pipe')
    const asOwner = membersFromRows(rows, SHARED_ID, OWNER, OWNER, 'daniel@grupo.co', { name: 'Daniel', email: 'daniel@grupo.co' })
    assert.deepEqual(
      asOwner.map((m) => [m.name, m.role, m.userId]),
      [
        ['Daniel', 'Owner', OWNER],
        ['pipe', 'Musician', 'email:pipe@gmail.com'],
      ]
    )
  })

  check('enlace de invitacion: se arma sobre la base del Hub y solo acepta un UUID', () => {
    assert.equal(inviteLink('https://bandait.releven.cc/hub/', SHARED_ID), `https://bandait.releven.cc/hub/?banda=${SHARED_ID}`)
    assert.equal(inviteLink('http://localhost:5173', SHARED_ID), `http://localhost:5173/?banda=${SHARED_ID}`)
    assert.equal(readInviteParam(`?banda=${SHARED_ID.toUpperCase()}`), SHARED_ID)
    assert.equal(readInviteParam('?banda=../../etc'), null)
    assert.equal(readInviteParam('?code=abc'), null)
  })

  console.log('Copiar setlists entre bandas')

  check('copiar a otra banda: canciones con ids nuevos, origen intacto y resultado valido', () => {
    const personal = personalFixture()
    const fromId = personal.bands[0].id
    const merged = mergeWorkspace(personal, [{ ...sharedFromFixture('Owner'), data: emptyBand() }], fromId)
    const before = stableStringify(sliceBand(merged, fromId))
    const source = merged.playlistsMap[fromId][0]
    const res = copyPlaylistToBand(merged, fromId, source.id, SHARED_ID, newId, '2026-10-29T12:00:00.000Z')
    assert.ok(res)
    assert.equal(stableStringify(sliceBand(res.workspace, fromId)), before, 'la banda de origen no cambia')
    const targetSongs = res.workspace.songsMap[SHARED_ID]
    const sourceIds = new Set(merged.songsMap[fromId].map((s) => s.id))
    assert.ok(targetSongs.every((s) => !sourceIds.has(s.id)), 'ids de cancion nuevos')
    assert.equal(res.playlist.bandId, SHARED_ID)
    assert.equal(res.playlist.songs.length, source.songs.length)
    assert.ok(res.playlist.songs.every((it) => targetSongs.some((s) => s.id === it.songId)), 'cada item apunta a una cancion del destino')
    assert.deepEqual(
      res.playlist.songs.map((it) => it.orderIndex),
      source.songs.map((it) => it.orderIndex),
      'conserva el orden'
    )
    const slice = sliceBand(res.workspace, SHARED_ID) as WorkspaceStore
    assert.ok(validateWorkspace(slice).ok, validateWorkspace(slice).errors.join(' '))
  })

  check('copiar reutiliza canciones del destino con el mismo titulo y artista (sin tildes ni mayusculas)', () => {
    const personal = personalFixture()
    const fromId = personal.bands[0].id
    const target = emptyBand()
    const original = personal.songsMap[fromId][0]
    target.songsMap[SHARED_ID] = [{ ...clone(original), id: 'ya-existe', title: original.title.toUpperCase(), artist: ` ${original.artist} ` }]
    const merged = mergeWorkspace(personal, [{ ...sharedFromFixture('Owner'), data: target }], fromId)
    const source = merged.playlistsMap[fromId][0]
    const res = copyPlaylistToBand(merged, fromId, source.id, SHARED_ID, newId, '2026-10-29T12:00:00.000Z')
    assert.ok(res)
    assert.ok(res.reusedSongs >= 1)
    assert.ok(res.playlist.songs.some((it) => it.songId === 'ya-existe'))
    const again = copyPlaylistToBand(res.workspace, fromId, source.id, SHARED_ID, newId, '2026-10-29T12:00:00.000Z')
    assert.ok(again)
    assert.equal(again.createdSongs, 0, 'la segunda copia no duplica canciones')
    assert.equal(again.playlist.name, `${source.name} (copia)`)
  })

  check('copiar a la misma banda o desde un setlist inexistente no hace nada', () => {
    const personal = personalFixture()
    const fromId = personal.bands[0].id
    assert.equal(copyPlaylistToBand(personal, fromId, personal.playlistsMap[fromId][0].id, fromId, newId, ''), null)
    assert.equal(copyPlaylistToBand(personal, fromId, 'no-existe', SHARED_ID, newId, ''), null)
  })

  console.log(`\n${passed} ok, ${failures.length} fallas`)
  if (failures.length > 0) process.exit(1)
}

/** Documento de banda compartida vacia (sin canciones ni setlists). */
function emptyBand(): WorkspaceStore {
  const data = clone(sharedFromFixture().data)
  data.songsMap[SHARED_ID] = []
  data.playlistsMap[SHARED_ID] = []
  return data
}

main()
