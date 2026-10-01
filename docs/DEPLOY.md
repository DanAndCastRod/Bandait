# Guía de Despliegue y Operación en Nube — Bandait 3.0

Esta guía documenta la infraestructura en producción, el despliegue perimetral en Cloudflare, la autenticación con Google y el aprovisionamiento seguro de Supabase para Bandait 3.0 (revisada el 2026-09-30).

---

## 1. Topología de Infraestructura Web

La suite web está consolidada en el directorio `landing/` y opera sobre la red perimetral de **Cloudflare** bajo el dominio oficial:
**`https://bandait.releven.cc`**

```
+--------------------------------------------------------------------------------+
|                        CLOUDFLARE EDGE (bandait.releven.cc)                    |
|                                                                                |
|  * /             -> Landing Page de presentación y centro de descargas         |
|  * /hub/         -> Web Admin Hub (Gestión de bandas, setlists y hardware)    |
|  * /app/         -> Seguidor PWA en vivo (Terminal de escenario para músicos)  |
+---------------------------------------+----------------------------------------+
                                        |
                 +----------------------+----------------------+
                 |                                             |
                 v                                             v
+----------------------------------+        +-----------------------------------+
|             GOOGLE               |        |          SUPABASE CLOUD           |
|  * Proveedor de Supabase Auth    |        |  * Auth: sesión verificada (PKCE) |
|    (login de nube, sección 2.1)  |        |  * 1 fila por cuenta, RLS por     |
|  * GIS opcional: solo perfil     |        |    auth.uid() (sección 3.3)       |
|    local, sin nube (sección 2.2) |        |  * Realtime opcional              |
+----------------------------------+        +-----------------------------------+
```

### Rutas y Reglas Edge
* **Ruteo SPA:** Definido en `landing/_redirects` para que rutas internas (`/hub/*` y `/app/*`) no devuelvan error 404 al recargar el navegador.
* **Caché:** `landing/_headers` marca `sw.js`, `manifest.webmanifest` y `index.html` del follower con `Cache-Control: public, max-age=0, must-revalidate`, para que los teléfonos tomen cada despliegue de inmediato. Los assets con hash (`/app/assets/*`) son `immutable`.
* **Política de privacidad:** `landing/privacidad/index.html`, publicada en `https://bandait.releven.cc/privacidad/`. Google la exige para publicar la app OAuth (sección 2.1). Si cambia el tratamiento de datos, actualízala junto con su fecha.

---

## 2. Google: dos usos distintos

El Hub usa Google de dos maneras, y solo una de ellas da acceso a la nube:

| Uso | Para qué | Quién verifica el token | ¿Abre la nube? |
|---|---|---|---|
| **Google vía Supabase Auth** (botón "CONTINUAR CON GOOGLE (NUBE)") | Cuenta real, sincronización entre dispositivos | Supabase (servidor) | Sí, y es la única forma |
| **Google Identity Services** (botón "CONTINUAR CON GOOGLE (PERFIL LOCAL)") | Nombre y foto para un perfil de este navegador | Nadie: el JWT solo se decodifica en el navegador (con controles de `aud`, `iss` y `exp`) | No |

Además existen el **perfil local** (nombre + correo como etiqueta, sin verificación) y el **MODO DEMO** (datos ficticios). Ninguno de los dos toca la nube.

### 2.1. Login de nube: Google como proveedor de Supabase (recomendado)

1. En [Google Cloud Console](https://console.cloud.google.com), con una cuenta personal (no la de una organización corporativa, cuyas políticas pueden limitar el login a su dominio), abre **Google Auth Platform**:
   - **Branding:** nombre `Bandait`, correo de asistencia, página principal `https://bandait.releven.cc`, política de privacidad `https://bandait.releven.cc/privacidad/`. Dominios autorizados: `releven.cc` y `<tu-proyecto>.supabase.co`. Sin la URL de política de privacidad, Google no deja pasar la app a producción.
   - **Audience:** tipo *External*. En *Testing* solo entran los *test users*; con *Publish app* entra cualquier cuenta de Google. Con solo los alcances básicos no hace falta verificación.
   - **Data Access:** alcances `openid`, `.../auth/userinfo.email` y `.../auth/userinfo.profile`.
   - **Clients:** crea un **ID de cliente de OAuth 2.0** de tipo *Aplicación web*.
2. En **URIs de redireccionamiento autorizados** agrega exactamente la *Callback URL* que muestra Supabase en *Authentication -> Sign In / Providers -> Google*:
   ```text
   https://<tu-proyecto>.supabase.co/auth/v1/callback
   ```
   No hace falta agregar `https://bandait.releven.cc/hub/` aquí: Google devuelve al usuario a Supabase y Supabase lo devuelve al Hub (sección 3.5).
3. En Supabase -> **Authentication -> Sign In / Providers -> Google**: activa el proveedor y pega el *Client ID* y el *Client Secret*. El secreto vive solo en Supabase; nunca va en el Hub ni en ninguna variable `VITE_*`.

### 2.2. Google Identity Services para perfiles locales (opcional)

Solo si quieres el botón de perfil local con Google. Puede ser el mismo ID de cliente u otro.

1. En el ID de cliente, **Orígenes de JavaScript autorizados**:
   ```text
   https://bandait.releven.cc
   http://localhost:5173
   ```
   (el segundo solo para desarrollo). GIS usa ventana emergente: no necesita URIs de redireccionamiento.
2. Compila el Hub con `VITE_GOOGLE_CLIENT_ID=<numero>-<id>.apps.googleusercontent.com` (sección 3.6). Sin esa variable el botón aparece deshabilitado con la explicación; ya no hay un Client ID de relleno ni un acceso demo silencioso.
3. Recordatorio: este perfil es local. Para la nube se usa siempre la sección 2.1.

---

## 3. Supabase: aprovisionamiento seguro

> **Acción obligatoria del dueño del proyecto Supabase.** El SQL de esta sección debe ejecutarlo el usuario en el *SQL Editor* de su propio proyecto; el código del Hub no puede hacerlo por él. **Mientras no se ejecute la sección 3.3, si alguna vez se aplicó la política antigua de esta guía (`"Acceso completo a workspaces"`, `using (true) with check (true)`), la tabla de producción sigue legible y sobrescribible por cualquiera que tenga la URL del proyecto y la anon key**, que son públicas por diseño (viajan a todo navegador que use el Hub). Con esa política, además, los ids antiguos se podían adivinar a partir del correo.

Bandait opera **local-first**: todo se guarda en `localStorage` del navegador y funciona sin nube. La nube es una sola tabla con **una fila por cuenta de Supabase**, cuya clave es `auth.users.id` (`session.user.id` en el cliente).

### 3.1. Crear el proyecto
1. En [supabase.com](https://supabase.com) crea una organización y un proyecto (por ejemplo `bandait-cloud`).
2. Elige una región cercana (por ejemplo `sa-east-1` o `us-east-1`) y define la contraseña de la base (no la guardes en el repositorio).

### 3.2. Tabla de workspaces
*SQL Editor -> New query*. Es idempotente: si la tabla ya existe no la toca.

<!-- sql:schema -->
```sql
create table if not exists public.bandait_workspaces (
  user_id    text primary key,          -- auth.users.id (uuid) en texto
  workspace  jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
```

El cliente guarda dentro de `workspace` un objeto `_sync` (`client_write_id`, `client_id`, `updated_at`) para reconocer los ecos de realtime de sus propias escrituras.

### 3.3. Seguridad de la tabla (OBLIGATORIO)

Activa RLS, quita todo acceso al rol `anon`, borra la política permisiva antigua y deja solo políticas por usuario para `authenticated`:

<!-- sql:security -->
```sql
begin;

alter table public.bandait_workspaces enable row level security;

-- Politica permisiva que publicaba la version anterior de esta guia.
drop policy if exists "Acceso completo a workspaces" on public.bandait_workspaces;

-- Sin sesion (rol anon) no hay ningun acceso.
revoke all on table public.bandait_workspaces from anon;
revoke all on table public.bandait_workspaces from public;
grant select, insert, update, delete on table public.bandait_workspaces to authenticated;

drop policy if exists "bandait_ws_select_own" on public.bandait_workspaces;
drop policy if exists "bandait_ws_insert_own" on public.bandait_workspaces;
drop policy if exists "bandait_ws_update_own" on public.bandait_workspaces;
drop policy if exists "bandait_ws_delete_own" on public.bandait_workspaces;

create policy "bandait_ws_select_own" on public.bandait_workspaces
  for select to authenticated
  using (auth.uid()::text = user_id);

create policy "bandait_ws_insert_own" on public.bandait_workspaces
  for insert to authenticated
  with check (auth.uid()::text = user_id);

create policy "bandait_ws_update_own" on public.bandait_workspaces
  for update to authenticated
  using (auth.uid()::text = user_id)
  with check (auth.uid()::text = user_id);

create policy "bandait_ws_delete_own" on public.bandait_workspaces
  for delete to authenticated
  using (auth.uid()::text = user_id);

commit;
```

Notas:
- PostgreSQL solo admite `with check` en políticas `for insert` y solo `using` en `for select` / `for delete`; `for update` lleva ambas.
- Las políticas permisivas se combinan con OR: **una sola política extra con `true` vuelve a abrir la tabla**. Comprueba que solo quedan estas cuatro:

<!-- sql:check-policies -->
```sql
select policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'bandait_workspaces'
order by policyname;

select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'bandait_workspaces'
order by grantee, privilege_type;
```
  El primer resultado debe tener exactamente `bandait_ws_delete_own`, `bandait_ws_insert_own`, `bandait_ws_select_own` y `bandait_ws_update_own`. En el segundo no debe aparecer `anon`. Si hay otra política, bórrala con `drop policy "<nombre>" on public.bandait_workspaces;`.
- La `service_role` ignora RLS: nunca va en el Hub. El Hub rechaza al arrancar cualquier clave con `role: service_role` o con prefijo `sb_secret_`, tanto en las variables de compilación como en el override del modal NUBE.

### 3.4. Realtime (opcional)

Sin esto el Hub sincroniza igual (descarga al iniciar sesión y escribe con debounce), pero no ve al instante los cambios de otro dispositivo:

<!-- sql:realtime -->
```sql
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bandait_workspaces'
  ) then
    alter publication supabase_realtime add table public.bandait_workspaces;
  end if;
end $$;
```

Realtime respeta RLS: cada sesión solo recibe eventos de su propia fila. El cliente usa el evento como aviso y vuelve a leer la fila (no confía en el contenido del evento).

### 3.5. URLs de autenticación
En Supabase -> **Authentication -> URL Configuration**:
* **Site URL:** `https://bandait.releven.cc/hub/`
* **Redirect URLs** (lista exacta, sin comodines amplios):
  ```text
  https://bandait.releven.cc/hub/
  http://localhost:5173/
  ```
  (la segunda solo para desarrollo). El Hub calcula `redirectTo` como `location.origin` + el directorio real de la app (`/hub/` en producción, `/` en desarrollo) y el modal NUBE muestra la URL exacta que está usando. Si la URL no está en la lista, Supabase devuelve al usuario a la *Site URL*.
* El login usa el flujo PKCE de `supabase-js`: al volver, la URL trae `?code=...`, que la librería canjea por la sesión y limpia. Si Google o Supabase devuelven un error, el Hub lo muestra en la pantalla de acceso.

### 3.6. Variables de compilación (`VITE_*`)

El Hub publicado en `/hub/` es el bundle compilado de `bandait-leader-web/`. Las variables se incrustan al compilar, así que deben estar presentes en la máquina que ejecuta el build:

```bash
cd bandait-leader-web
cp .env.example .env.local      # .env.local esta ignorado por git
# completar VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY y, si se usa, VITE_GOOGLE_CLIENT_ID
cd ..
npm run build:landing -- hub    # compila y reemplaza landing/hub; luego commit + merge a main = despliegue
```

Proyecto de producción (desde el 2026-10-01): `bandait-cloud`, URL `https://xftzxzwopwzjmttrwtga.supabase.co`. Sus valores públicos (URL y *publishable key*) están **versionados** en `bandait-leader-web/.env.production`, para que cualquier `build:landing -- hub` salga con nube, en cualquier máquina:
- Vite solo carga ese archivo en `vite build`; el servidor de desarrollo y los e2e siguen en modo local.
- Un `.env.local` sobrescribe esos valores, por ejemplo para apuntar a un proyecto de pruebas.
- El CI falla si `.env.production` contiene una línea con `sb_secret_`.

| Variable | Valor | Obligatoria |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` (Project Settings -> API) | Para la nube |
| `VITE_SUPABASE_ANON_KEY` | anon key (JWT con `role: anon`) o publishable key (`sb_publishable_...`) | Para la nube |
| `VITE_GOOGLE_CLIENT_ID` | `<numero>-<id>.apps.googleusercontent.com` | No (solo perfil local con Google) |

Todas son públicas: quedan dentro del JavaScript que descarga cualquier visitante. La seguridad depende de RLS (sección 3.3), no de ocultar la anon key. El modal **NUBE** del Hub permite además un override por navegador (se guarda en `localStorage` y tiene prioridad); acepta las mismas claves y rechaza `service_role` / `sb_secret_`.

### 3.7. Migración opcional de filas antiguas

Hasta el 2026-09-30 la clave de la fila no era la cuenta de Supabase sino un id armado en el navegador:

| Origen antiguo | Clave de la fila | Se puede mapear a `auth.users.id` |
|---|---|---|
| Formulario "cuenta personal" (correo escrito a mano, sin verificar) | `usr_google_` + los primeros 16 caracteres alfanuméricos de `btoa(email.trim().toLowerCase())` | Sí, por correo, con los límites de abajo |
| Botón de Google Identity Services | `google_<sub de Google>` | Sí, por `auth.identities` (el `sub` lo verificó Supabase), si la persona entra con la misma cuenta de Google |
| Perfiles demo (`usr_director_01`, `usr_foh_02`, `usr_drummer_03`) | el id del perfil | No: las compartían todos los visitantes. Borrarlas |

Fórmula exacta del id por correo (código retirado de `authService.ts`): se recorta y pasa a minúsculas el correo, `btoa` lo codifica en Base64 tratando cada carácter como un byte **Latin-1** (no UTF-8), se eliminan los caracteres no alfanuméricos (`+`, `/`, `=`) y se toman los primeros 16. En SQL: `'usr_google_' || left(regexp_replace(encode(convert_to(lower(btrim(email)), 'LATIN1'), 'base64'), '[^a-zA-Z0-9]', '', 'g'), 16)`. Ejemplo: `musico@example.com` -> `usr_google_bXVzaWNvQGV4YW1w` (lo imprime `npm run verify:logic`).

Límites (léelos antes de migrar):
- **Colisiones por prefijo.** 16 caracteres Base64 codifican unos 12 bytes, así que dos correos que comparten los primeros ~12 caracteres generan el mismo id (comprobado: `danielcastaneda@gmail.com` y `danielcastaneda@grupobios.co` colisionan). El SQL omite los ids que corresponden a más de una cuenta, pero solo conoce cuentas registradas en Supabase: una fila pudo escribirla otra persona con un correo que colisiona y nunca se registró.
- **El correo nunca se verificó.** Cualquiera pudo escribir el correo de otra persona; la fila pertenece a quien la escribió, no necesariamente al dueño de la cuenta.
- **Contenido no confiable.** Con la política antigua la tabla era sobrescribible por cualquiera: revisa las filas antes de migrarlas.
- **Caracteres fuera de Latin-1** (por ejemplo CJK): `btoa` fallaba y esas personas nunca tuvieron fila; la función devuelve `null` y se ignoran.
- `lower()` de PostgreSQL y `toLowerCase()` de JavaScript coinciden en ASCII; en caracteres Latin-1 acentuados dependen de la intercalación de la base (no verificado contra un proyecto Supabase real). `btrim` solo quita espacios; los correos de `auth.users` no traen espacios.
- **Orden.** Cada persona debe existir en `auth.users`, es decir, haber entrado una vez con "CONTINUAR CON GOOGLE (NUBE)". Ese primer ingreso ya crea una fila nueva para su cuenta, así que por defecto la migración **omite** las cuentas que ya tienen fila. Para que la fila antigua reemplace a la nueva, cambia `false` por `true` en `bandait_opts`: la fila nueva no se borra, se aparta con la clave `respaldo_<id>_<epoch>` (RLS impide que alguien la lea desde el Hub; el paso de limpieza la borraría). El Hub de esa persona adopta la versión migrada en la siguiente descarga; si tenía cambios sin subir, quedan en un respaldo local.

<!-- sql:migration -->
```sql
begin;

-- Cambiar a true para que la fila antigua reemplace a la fila nueva de la cuenta.
create temporary table bandait_opts on commit drop as
  select false as reemplazar_fila_nueva;

create or replace function pg_temp.bandait_legacy_email_id(email text)
returns text language plpgsql as $$
begin
  return 'usr_google_' || left(
    regexp_replace(encode(convert_to(lower(btrim(email)), 'LATIN1'), 'base64'), '[^a-zA-Z0-9]', '', 'g'),
    16);
exception when others then
  return null; -- fuera de Latin-1: el codigo antiguo (btoa) tampoco generaba id
end $$;

create temporary table bandait_legacy_map on commit drop as
  select u.id::text as new_id, pg_temp.bandait_legacy_email_id(u.email) as legacy_id, 'correo' as via
  from auth.users u
  where u.email is not null
  union all
  select i.user_id::text, 'google_' || (i.identity_data ->> 'sub'), 'google_sub'
  from auth.identities i
  where i.provider = 'google' and i.identity_data ? 'sub';

-- Una fila antigua por cuenta (la mas reciente), solo si el id antiguo corresponde a UNA cuenta.
create temporary table bandait_rekey on commit drop as
  select legacy_id, new_id
  from (
    select w.user_id as legacy_id, m.new_id,
           row_number() over (partition by m.new_id order by w.updated_at desc) as rn
    from public.bandait_workspaces w
    join bandait_legacy_map m on m.legacy_id = w.user_id
    where m.legacy_id is not null
      and (select count(distinct m2.new_id) from bandait_legacy_map m2 where m2.legacy_id = m.legacy_id) = 1
  ) x
  where rn = 1;

-- 1) Vista previa (revisar antes de confirmar).
select m.via, m.legacy_id, m.new_id, w.updated_at,
       (select count(distinct m2.new_id) from bandait_legacy_map m2 where m2.legacy_id = m.legacy_id) as cuentas_candidatas,
       exists (select 1 from bandait_rekey r where r.legacy_id = m.legacy_id) as se_migra,
       exists (select 1 from public.bandait_workspaces w2 where w2.user_id = m.new_id) as cuenta_ya_tiene_fila
from bandait_legacy_map m
join public.bandait_workspaces w on w.user_id = m.legacy_id
order by m.legacy_id;

-- 2) Solo con reemplazar_fila_nueva = true: apartar la fila nueva de esas cuentas.
update public.bandait_workspaces w
set user_id = 'respaldo_' || w.user_id || '_' || floor(extract(epoch from clock_timestamp()))::bigint
where (select reemplazar_fila_nueva from bandait_opts)
  and w.user_id in (select new_id from bandait_rekey);

-- 3) Re-key de la fila antigua (y del id antiguo dentro del JSON: ownerId e userId de integrantes).
update public.bandait_workspaces w
set user_id    = r.new_id,
    workspace  = replace(w.workspace::text, '"' || r.legacy_id || '"', '"' || r.new_id || '"')::jsonb,
    updated_at = now()
from bandait_rekey r
where w.user_id = r.legacy_id
  and not exists (select 1 from public.bandait_workspaces w2 where w2.user_id = r.new_id);

commit;
```

Después, revisa y borra lo que quede sin dueño (filas antiguas no migradas, las demo compartidas y los `respaldo_...` del paso 2). Exporta antes lo que quieras conservar:

<!-- sql:cleanup -->
```sql
-- Vista previa
select user_id, updated_at
from public.bandait_workspaces w
where not exists (select 1 from auth.users u where u.id::text = w.user_id);

-- Borrado (tras revisar la vista previa)
delete from public.bandait_workspaces w
where not exists (select 1 from auth.users u where u.id::text = w.user_id);
```

Los workspaces que solo existen en `localStorage` de un navegador (perfil local o ids antiguos) no necesitan SQL: al iniciar sesión en la nube en ese mismo navegador, si la cuenta todavía no tiene fila, el Hub toma como punto de partida el workspace local del mismo correo y lo sube.

### 3.8. Comprobación final
1. Sin sesión, la tabla no debe ser legible. Desde una terminal:
   ```bash
   curl -s "https://<ref>.supabase.co/rest/v1/bandait_workspaces?select=user_id&limit=1" -H "apikey: <ANON_KEY>"
   ```
   Debe responder un error `42501` (`permission denied for table bandait_workspaces`), **no** un arreglo JSON. El botón **COMPROBAR SEGURIDAD DE LA TABLA** del modal NUBE hace la misma prueba.
2. Inicia sesión con "CONTINUAR CON GOOGLE (NUBE)": el indicador de la barra superior debe pasar de `SINCRONIZANDO` a `SINCRONIZADO`. Con otra cuenta en otro navegador no debe verse el workspace de la primera.
3. Estados del indicador: `SOLO LOCAL` (perfil local, Google local o demo), `SINCRONIZANDO`, `SINCRONIZADO` y `ERROR NUBE` (con el motivo en el modal NUBE; los errores de red se reintentan con espera creciente hasta 30 s).

### 3.9. Cómo sincroniza el cliente (resumen)
- Tras iniciar sesión **primero descarga** la fila; nunca escribe antes de terminar esa descarga. Una cuenta sin copia local en ese navegador ve "DESCARGANDO TU WORKSPACE" hasta tenerla.
- Reconcilia por `updated_at`: gana el lado más reciente. Si el perdedor tenía cambios que el otro no vio, se guarda como respaldo local (los 3 últimos, en el modal NUBE, para descargar o restaurar) y se avisa en pantalla. Los relojes de los dispositivos deben estar razonablemente en hora.
- Escribe con debounce de 1500 ms y de forma condicional (`update ... where updated_at = <versión conocida>`): si otro dispositivo escribió en medio, no lo pisa; vuelve a descargar y reconcilia.
- Ignora los ecos de realtime de sus propias escrituras (`_sync.client_write_id`).

### 3.10. Límites conocidos (pendientes)
- **Roles:** "solo un Owner cambia roles, nadie cambia su propio rol, siempre queda un Owner" se valida solo en el navegador. Cada fila es el workspace completo de una persona; aplicar permisos de verdad entre integrantes requiere tablas por banda (`bands`, `band_members`) con RLS por pertenencia en el servidor. Pendiente.
- Las invitaciones de integrantes no envían correo ni crean cuentas: solo agregan una fila a la lista local.
- La exportación es JSON (`EXPORTAR JSON`); el XLSX real está pendiente.
- Si alguna vez una clave `service_role` llegó a un bundle, a un override del modal o a un navegador, rótala en Supabase (Project Settings -> API): RLS no la detiene.

---

## 4. Política Estricta de Bitácora Técnica (DEVLOG)

Cualquier cambio arquitectónico, de ruteo de audio, sincronización de red o interfaz gráfica **DEBE** registrarse en [`DEVLOG.md`](../DEVLOG.md).

Toda entrada en `DEVLOG.md` debe respetar obligatoriamente la plantilla de 5 puntos:

```markdown
### [YYYY-MM-DD] - Título Descriptivo de la Intervención
* **Sprint / Módulo:** (Módulo intervenido)
* **Acción técnica realizada:** (Descripción detallada de cambios en código)
* **Impacto en Audio / Red / UI:** (Consecuencias operativas en escenario)
* **Verificación y Pruebas:** (Pruebas unitarias, linter, builds y CI ejecutados)
```

---

## 5. Regla de Oro de Escenario (Líder FOH)

El hosting web en Cloudflare y la sincronización Supabase son exclusivamente para **pre-producción, catálogo y setlists**. En vivo, el follower **no** se usa desde `https://bandait.releven.cc/app/`: una página HTTPS no puede abrir `ws://` hacia la LAN (contenido mixto; ver `bandait-protocol/CONTRACT_V3.md` §8). Si alguien lo intenta, la app no abre el socket y ofrece el botón ABRIR DESDE EL LIDER.

Durante el concierto o ensayo:
* El Líder (`bandait-leader` en Python PySide6) corre localmente en la laptop FOH, conectado al hardware ASIO. Además de Socket.IO, **sirve el follower por HTTP** en el mismo puerto (`http://<ip-lan>:4040/`), a partir del bundle `landing/app`.
* En el líder, menú **Red > Conectar músicos...** muestra dos QR, uno para músicos y otro para el director. Cada músico lo escanea con la **cámara nativa** del teléfono y la app se une sola a la sesión. Si la laptop tiene varias redes, se elige ahí la IP de la Wi-Fi de escenario.
* Los teléfonos se conectan a la red Wi-Fi local de escenario; la LAN no necesita salida a internet.
* En HTTP no hay instalación como app ni service worker. La pantalla se mantiene encendida con un video silencioso en bucle (en HTTPS se usa la Wake Lock API); está sin probar en iPhone y Android reales.
* La sincronización y el transporte viajan por la LAN sin depender de la nube.
