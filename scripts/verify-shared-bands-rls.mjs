// Prueba de las politicas RLS de docs/sql/bandas_compartidas.sql sobre Postgres real (PGlite, WASM).
//
// Simula lo minimo de Supabase: esquema auth con users/uid()/jwt() y los roles anon y
// authenticated. Cada caso corre como `authenticated` con request.jwt.claim.sub del usuario.
// Uso: node scripts/verify-shared-bands-rls.mjs  (sale con codigo 1 si algo falla)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const migration = readFileSync(join(root, 'docs', 'sql', 'bandas_compartidas.sql'), 'utf8')

const U = {
  ana: '11111111-1111-4111-8111-111111111111', // crea la banda
  beto: '22222222-2222-4222-8222-222222222222', // director invitado
  caro: '33333333-3333-4333-8333-333333333333', // musica invitada
  dani: '44444444-4444-4444-8444-444444444444', // ajeno a la banda
  eva: '55555555-5555-4555-8555-555555555555', // invitada pero con correo SIN confirmar
}
const BAND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const db = new PGlite()
let failures = 0
let passes = 0

function check(cond, label) {
  if (cond) {
    passes += 1
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}`)
  }
}

/** Ejecuta como un usuario autenticado (o anon si user es null). Devuelve { rows } o { error }. */
async function as(user, sql, params = []) {
  try {
    return await db.transaction(async (tx) => {
      if (user) {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user])
        await tx.exec('set local role authenticated')
      } else {
        await tx.query(`select set_config('request.jwt.claim.sub', '', true)`)
        await tx.exec('set local role anon')
      }
      const res = await tx.query(sql, params)
      return { rows: res.rows, affected: res.affectedRows ?? 0 }
    })
  } catch (error) {
    return { error: String(error.message || error) }
  }
}

const content = (id, name) => JSON.stringify({ schemaVersion: 2, activeBandId: id, bands: [{ id, name }], songsMap: { [id]: [] } })

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  grant usage on schema public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users values
    ('${U.ana}', 'Ana@Banda.co', now()),
    ('${U.beto}', 'beto@banda.co', now()),
    ('${U.caro}', 'caro@banda.co', now()),
    ('${U.dani}', 'dani@otra.co', now()),
    ('${U.eva}', 'eva@banda.co', null);
`)

console.log('Migracion')
await db.exec(migration)
await db.exec(migration) // idempotente
check(true, 'la migracion corre dos veces sin error')

console.log('Crear banda e invitar')
let r = await as(U.ana, `insert into public.bandait_bands (id, content) values ($1, $2::jsonb) returning owner_id`, [BAND, content(BAND, 'SIC')])
if (r.error) console.log("    ->", r.error); check(!r.error && r.rows[0]?.owner_id === U.ana, 'Ana crea la banda y queda como owner_id')
r = await as(U.ana, `insert into public.bandait_bands (id, owner_id, content) values ($1, $2, $3::jsonb)`, [OTHER, U.beto, content(OTHER, 'X')])
check(!!r.error, 'nadie crea una banda a nombre de otro')
r = await as(U.ana, `insert into public.bandait_bands (id, content) values ($1, $2::jsonb)`, [OTHER, content(BAND, 'X')])
check(!!r.error, 'el documento no puede traer otra banda que la de la fila')
r = await as(null, `insert into public.bandait_bands (id, content) values ($1, $2::jsonb)`, [OTHER, content(OTHER, 'X')])
check(!!r.error, 'anon no crea bandas')

r = await as(U.ana, `insert into public.bandait_band_members (band_id, email, role, name) values
  ($1, 'ana@banda.co', 'Owner', 'Ana'), ($1, 'beto@banda.co', 'MusicDirector', 'Beto'), ($1, 'caro@banda.co', 'Musician', 'Caro'), ($1, 'eva@banda.co', 'Musician', 'Eva')`, [BAND])
check(!r.error, 'Ana (Owner) invita a director y musicos')
r = await as(U.ana, `insert into public.bandait_band_members (band_id, email, role) values ($1, 'MAL@banda.co', 'Musician')`, [BAND])
check(!!r.error, 'el correo debe llegar normalizado en minusculas')
r = await as(U.ana, `insert into public.bandait_band_members (band_id, email, role) values ($1, 'x@banda.co', 'Admin')`, [BAND])
check(!!r.error, 'solo roles conocidos')

console.log('Lectura')
r = await as(U.caro, `select id from public.bandait_bands`)
check(r.rows?.length === 1 && r.rows[0].id === BAND, 'Caro (Musician) ve la banda')
r = await as(U.caro, `select email from public.bandait_band_members where band_id = $1`, [BAND])
check(r.rows?.length === 4, 'Caro ve la lista de integrantes')
r = await as(U.dani, `select id from public.bandait_bands`)
check(r.rows?.length === 0, 'Dani (ajeno) no ve la banda')
r = await as(U.dani, `select email from public.bandait_band_members`)
check(r.rows?.length === 0, 'Dani no ve los integrantes')
r = await as(U.eva, `select id from public.bandait_bands`)
check(r.rows?.length === 0, 'Eva con correo sin confirmar no ve la banda')
r = await as(null, `select id from public.bandait_bands`)
check(!!r.error || r.rows?.length === 0, 'anon no lee bandas')

console.log('Edicion del contenido')
r = await as(U.beto, `update public.bandait_bands set content = $2::jsonb, updated_at = now() where id = $1 returning id`, [BAND, content(BAND, 'SIC v2')])
check(r.rows?.length === 1, 'Beto (MusicDirector) edita el contenido')
r = await as(U.caro, `update public.bandait_bands set content = $2::jsonb where id = $1 returning id`, [BAND, content(BAND, 'hack')])
check(!r.error && r.rows?.length === 0, 'Caro (Musician) no edita: 0 filas')
r = await as(U.dani, `update public.bandait_bands set content = $2::jsonb where id = $1 returning id`, [BAND, content(BAND, 'hack')])
check(!r.error && r.rows?.length === 0, 'Dani no edita: 0 filas')
r = await as(U.ana, `update public.bandait_bands set owner_id = $2 where id = $1`, [BAND, U.dani])
check(!!r.error, 'nadie cambia owner_id (sin permiso de columna)')
r = await as(U.ana, `select content -> 'bands' -> 0 ->> 'name' as name from public.bandait_bands where id = $1`, [BAND])
check(r.rows?.[0]?.name === 'SIC v2', 'el contenido quedo con la edicion del director')

console.log('Gestion de integrantes')
r = await as(U.beto, `insert into public.bandait_band_members (band_id, email, role) values ($1, 'dani@otra.co', 'Owner')`, [BAND])
check(!!r.error, 'el director no invita a un Owner')
r = await as(U.beto, `insert into public.bandait_band_members (band_id, email, role) values ($1, 'dani@otra.co', 'Substitute') returning email`, [BAND])
check(!r.error && r.rows?.length === 1, 'el director invita a un suplente (insert ... returning, como supabase-js)')
r = await as(U.dani, `select id from public.bandait_bands`)
check(r.rows?.length === 1, 'Dani ahora ve la banda')
r = await as(U.caro, `insert into public.bandait_band_members (band_id, email, role) values ($1, 'z@banda.co', 'Musician')`, [BAND])
check(!!r.error, 'una musica no invita')
r = await as(U.beto, `update public.bandait_band_members set role = 'Owner' where band_id = $1 and email = 'beto@banda.co' returning email`, [BAND])
check(!r.error && r.rows?.length === 0, 'el director no se sube a Owner')
r = await as(U.ana, `update public.bandait_band_members set role = 'MusicDirector' where band_id = $1 and email = 'caro@banda.co' returning email`, [BAND])
check(r.rows?.length === 1, 'Ana cambia el rol de Caro')
r = await as(U.ana, `update public.bandait_band_members set email = 'otra@banda.co' where band_id = $1 and email = 'caro@banda.co'`, [BAND])
check(!!r.error, 'nadie cambia el correo de una invitacion')
r = await as(U.caro, `update public.bandait_bands set content = $2::jsonb where id = $1 returning id`, [BAND, content(BAND, 'SIC v3')])
check(r.rows?.length === 1, 'Caro, ya directora, edita')
r = await as(U.dani, `delete from public.bandait_band_members where band_id = $1 and email = 'dani@otra.co' returning email`, [BAND])
check(r.rows?.length === 1, 'Dani se sale de la banda')
r = await as(U.dani, `select id from public.bandait_bands`)
check(r.rows?.length === 0, 'tras salirse, Dani ya no ve la banda')
r = await as(U.beto, `delete from public.bandait_band_members where band_id = $1 and email = 'caro@banda.co' returning email`, [BAND])
check(!r.error && r.rows?.length === 0, 'el director no expulsa a nadie')

console.log('Borrado')
r = await as(U.beto, `delete from public.bandait_bands where id = $1 returning id`, [BAND])
check(!r.error && r.rows?.length === 0, 'el director no borra la banda')
r = await as(U.ana, `delete from public.bandait_band_members where band_id = $1 and email = 'ana@banda.co' returning email`, [BAND])
check(r.rows?.length === 1, 'Ana borra su propia fila de integrante...')
r = await as(U.ana, `select id from public.bandait_bands`)
check(r.rows?.length === 1, '...y sigue entrando por ser quien la creo')
r = await as(U.ana, `delete from public.bandait_bands where id = $1 returning id`, [BAND])
check(r.rows?.length === 1, 'Ana borra la banda')
r = await as(U.ana, `select count(*)::int as n from public.bandait_band_members`)
check(r.rows?.[0]?.n === 0, 'las invitaciones se borran en cascada')

console.log(`\n${passes} ok, ${failures} fallos`)
await db.close()
process.exit(failures === 0 ? 0 : 1)
