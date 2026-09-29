# Guía de Despliegue y Operación en Nube — Bandait 3.0

Esta guía documenta la infraestructura en producción, el despliegue perimetral en Cloudflare, la autenticación con Google y el aprovisionamiento de Supabase para Bandait 3.0.

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
|      GOOGLE IDENTITY OAUTH       |        |          SUPABASE CLOUD           |
|  * Autenticación OAuth 2.0 PKCE  |        |  * PostgreSQL Multi-Tenant        |
|  * Client ID para dominio propio |        |  * Sincronización en segundo plano|
+----------------------------------+        +-----------------------------------+
```

### Rutas y Reglas Edge
* **Ruteo SPA:** Definido en `landing/_redirects` para que rutas internas (`/hub/*` y `/app/*`) no devuelvan error 404 al recargar el navegador.
* **Service Workers:** Cabeceras en `landing/_headers` con directiva `Cache-Control: public, max-age=0, must-revalidate` para `sw.js` y `registerSW.js`, garantizando actualización inmediata en smartphones de músicos.

---

## 2. Paso a Paso: Configuración de Google OAuth

Para que el login de Google funcione sin errores de origen (`origin_mismatch`):

1. Accede a [Google Cloud Console -> APIs y Servicios -> Credenciales](https://console.cloud.google.com/apis/credentials).
2. Abre tu **ID de cliente de OAuth 2.0** (Tipo: *Aplicación web*).
3. En la sección **Orígenes de JavaScript autorizados**, añade:
   ```text
   https://bandait.releven.cc
   ```
4. En **URIs de redireccionamiento autorizados**, añade:
   ```text
   https://bandait.releven.cc/hub/
   https://bandait.releven.cc/app/
   ```
   *(Si usas el proveedor Google en Supabase, agrega también: `https://<tu-proyecto>.supabase.co/auth/v1/callback`)*.
5. Guarda los cambios. El botón nativo y el popup de Google funcionarán en `bandait.releven.cc`.

---

## 3. Paso a Paso: Aprovisionamiento de Supabase desde Cero

Bandait 3.0 opera de forma **Local-First** (los datos se guardan en `localStorage` e `IndexedDB` si no hay internet o si no tienes cuenta en Supabase). Para activar la persistencia en la nube multi-dispositivo:

### 3.1. Crear el Proyecto
1. Ingresa a [supabase.com](https://supabase.com) y crea una cuenta gratuita.
2. Crea una nueva organización y un nuevo proyecto (ejemplo: `bandait-cloud`).
3. Elige una región cercana (ej: `sa-east-1` o `us-east-1`) y define tu contraseña de base de datos.

### 3.2. Crear la Tabla de Espacios de Trabajo
En el panel lateral de Supabase, entra a **SQL Editor**, crea una nueva consulta y ejecuta:

```sql
-- Tabla principal para sincronizacion de workspaces y bandas
create table if not exists public.bandait_workspaces (
  user_id text primary key,
  workspace jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Habilitar seguridad de nivel de fila (RLS)
alter table public.bandait_workspaces enable row level security;

-- Politica permisiva para sincronizacion por ID de usuario autenticado
create policy "Acceso completo a workspaces"
  on public.bandait_workspaces
  for all
  using (true)
  with check (true);
```

### 3.3. Configurar URLs de Autenticación
1. En Supabase -> **Authentication** -> **URL Configuration**:
   * **Site URL:** `https://bandait.releven.cc/hub/`
   * **Redirect URLs:** Agrega `https://bandait.releven.cc/**`
2. *(Opcional)* En **Authentication** -> **Providers** -> **Google**:
   * Activa el switch "Enable Google provider".
   * Pega tu `Client ID` y `Client Secret` obtenidos en Google Cloud Console.

### 3.4. Conectar Supabase al Web Hub
1. En Supabase -> **Project Settings** -> **API**, localiza:
   * **Project URL** (ej: `https://abcdefghijklm.supabase.co`)
   * **anon / public key** (cadena JWT larga que comienza por `ey...`)
2. Abre [https://bandait.releven.cc/hub/](https://bandait.releven.cc/hub/) (o directo en `https://bandait.releven.cc/hub/?cloud=1`).
3. Haz clic en el botón **NUBE** en la barra superior.
4. Pega tu URL y anon key, y presiona **GUARDAR Y PROBAR CONEXIÓN**.
5. Verás el indicador verde: `Conexión a PostgreSQL en la nube activa y verificada`.

---

## 4. Política Estricta de Bitácora Técnica (DEVLOG)

Cualquier cambio arquitectónico, de ruteo de audio, sincronización de red o interfaz gráfica **DEBE** registrarse en [`DEVLOG.md`](file:///data/data/com.termux/files/home/proyectos_personales/Bandait/DEVLOG.md).

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

El hosting web en Cloudflare y la sincronización Supabase son exclusivamente para **pre-producción, catálogo, setlists y distribución del PWA a los músicos**.

Durante el concierto o ensayo:
* El Líder (`bandait-leader` en Python PySide6) corre localmente en la laptop FOH conectado al hardware ASIO.
* Los teléfonos de los músicos se conectan directamente a la red Wi-Fi local de escenario (LAN sin salida a internet requerida).
* La sincronización NTP y el transporte musical viajan a < 1.5ms sin depender de la nube.
