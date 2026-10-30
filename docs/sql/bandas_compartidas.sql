-- Bandas compartidas (docs/DEPLOY.md, seccion 3.11).
--
-- Una banda compartida es una fila de bandait_bands cuyo `content` es un documento de
-- workspace v2 con UNA sola banda (bands[0].id = id de la fila). La pertenencia vive en
-- bandait_band_members, indexada por correo, y la hace cumplir RLS:
--   * leer la banda y su lista de integrantes: cualquier integrante (o quien la creo);
--   * editar el contenido: Owner y MusicDirector;
--   * invitar: Owner y MusicDirector (solo un Owner invita a otro Owner);
--   * cambiar roles o quitar integrantes: Owner; cada integrante puede salirse;
--   * borrar la banda: solo quien la creo (owner_id).
-- El correo que cuenta es el de auth.users, y solo si esta confirmado (Google lo entrega
-- confirmado). Nunca el que el cliente diga.
--
-- Idempotente: se puede volver a ejecutar completo. No toca bandait_workspaces.

begin;

create table if not exists public.bandait_bands (
  id         uuid primary key,
  owner_id   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content    jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint bandait_bands_content_is_object check (jsonb_typeof(content) = 'object'),
  -- La banda del documento es la de la fila: el cliente no puede colgar otra banda aqui.
  constraint bandait_bands_content_band_id check ((content -> 'bands' -> 0 ->> 'id') = id::text),
  constraint bandait_bands_content_size check (octet_length(content::text) < 5000000)
);

create table if not exists public.bandait_band_members (
  band_id    uuid not null references public.bandait_bands (id) on delete cascade,
  email      text not null,
  role       text not null,
  name       text not null default '',
  instrument text not null default '',
  invited_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (band_id, email),
  constraint bandait_band_members_email_normalized check (email = lower(btrim(email)) and email like '_%@_%'),
  constraint bandait_band_members_role check (role in ('Owner', 'MusicDirector', 'Musician', 'Substitute', 'SoundEngineer')),
  constraint bandait_band_members_name_len check (char_length(name) <= 120 and char_length(instrument) <= 120)
);

create index if not exists bandait_band_members_email_idx on public.bandait_band_members (email);

-- Correo confirmado de quien llama, en minusculas. null sin sesion o sin confirmar.
create or replace function public.bandait_current_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(u.email)
  from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null
$$;

-- Rol de quien llama en la banda, o null si no pertenece. security definer: las politicas
-- de bandait_band_members la usan sin volver a evaluar sus propias politicas (recursion).
create or replace function public.bandait_band_role(p_band uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.bandait_bands b where b.id = p_band and b.owner_id = auth.uid()) then 'Owner'
    else (
      select m.role
      from public.bandait_band_members m
      where m.band_id = p_band and m.email = public.bandait_current_email()
    )
  end
$$;

revoke all on function public.bandait_current_email() from public, anon;
revoke all on function public.bandait_band_role(uuid) from public, anon;
grant execute on function public.bandait_current_email() to authenticated;
grant execute on function public.bandait_band_role(uuid) to authenticated;

alter table public.bandait_bands enable row level security;
alter table public.bandait_band_members enable row level security;

revoke all on table public.bandait_bands from public, anon, authenticated;
revoke all on table public.bandait_band_members from public, anon, authenticated;
-- Columnas: nadie cambia owner_id ni el id de una banda, ni la banda o el correo de una invitacion.
grant select, insert, delete on table public.bandait_bands to authenticated;
grant update (content, updated_at) on table public.bandait_bands to authenticated;
grant select, insert, delete on table public.bandait_band_members to authenticated;
grant update (role, name, instrument) on table public.bandait_band_members to authenticated;

drop policy if exists "bandait_bands_select" on public.bandait_bands;
drop policy if exists "bandait_bands_insert" on public.bandait_bands;
drop policy if exists "bandait_bands_update" on public.bandait_bands;
drop policy if exists "bandait_bands_delete" on public.bandait_bands;

-- owner_id va explicito: en `insert ... returning` (lo que hace supabase-js con
-- .insert().select()) la fila nueva aun no es visible para bandait_band_role.
create policy "bandait_bands_select" on public.bandait_bands
  for select to authenticated
  using (owner_id = auth.uid() or public.bandait_band_role(id) is not null);

create policy "bandait_bands_insert" on public.bandait_bands
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy "bandait_bands_update" on public.bandait_bands
  for update to authenticated
  using (public.bandait_band_role(id) in ('Owner', 'MusicDirector'))
  with check (public.bandait_band_role(id) in ('Owner', 'MusicDirector'));

create policy "bandait_bands_delete" on public.bandait_bands
  for delete to authenticated
  using (owner_id = auth.uid());

drop policy if exists "bandait_members_select" on public.bandait_band_members;
drop policy if exists "bandait_members_insert" on public.bandait_band_members;
drop policy if exists "bandait_members_update" on public.bandait_band_members;
drop policy if exists "bandait_members_delete" on public.bandait_band_members;

create policy "bandait_members_select" on public.bandait_band_members
  for select to authenticated
  using (public.bandait_band_role(band_id) is not null);

create policy "bandait_members_insert" on public.bandait_band_members
  for insert to authenticated
  with check (
    public.bandait_band_role(band_id) = 'Owner'
    or (public.bandait_band_role(band_id) = 'MusicDirector' and role <> 'Owner')
  );

create policy "bandait_members_update" on public.bandait_band_members
  for update to authenticated
  using (public.bandait_band_role(band_id) = 'Owner')
  with check (public.bandait_band_role(band_id) = 'Owner');

create policy "bandait_members_delete" on public.bandait_band_members
  for delete to authenticated
  using (public.bandait_band_role(band_id) = 'Owner' or email = public.bandait_current_email());

commit;

-- Realtime: avisos de cambios en bandas e invitaciones (respeta RLS). Fuera de la
-- transaccion: si la publicacion no existe (Postgres sin Supabase) no aborta lo anterior.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bandait_bands'
    ) then
      alter publication supabase_realtime add table public.bandait_bands;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bandait_band_members'
    ) then
      alter publication supabase_realtime add table public.bandait_band_members;
    end if;
  end if;
end $$;
