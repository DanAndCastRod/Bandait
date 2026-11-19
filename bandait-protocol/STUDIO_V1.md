# Estudio v1: documento de sesión y rutas `/studio` del Worker

Fecha: 2026-11-19. Estado: normativo para las fases 1 a 5 del Estudio Bandait
(`docs/PLAN_ESTUDIO_BANDAIT.md`). Ejemplo canónico en `fixtures/studio_session.json`; las
pruebas del Hub (`bandait-leader-web/scripts/verify-studio-logic.ts`) y del Worker
(`bandait-stems-worker/tests/`) validan contra ese archivo.

El Estudio es una pestaña del Hub. Una **sesión** es un documento JSON que describe pistas,
clips y mezcla sobre audios inmutables. El documento vive en IndexedDB del navegador y, al
pulsar GUARDAR, en R2 detrás del Worker `bandait-stems`. El escenario no participa: ni el
líder, ni el follower, ni `CONTRACT_V3.md` conocen este documento.

A diferencia del workspace (`WORKSPACE_V2.md`, camelCase), este documento viaja por el Worker
y usa **snake_case**, igual que el manifiesto de stems. El Hub traduce en un solo módulo:
`bandait-leader-web/src/services/studio/session.ts` (`parseSession` / `serializeSession`).

Si el código y este contrato no coinciden, se corrigen primero el contrato y el fixture.

## 1. Reglas generales

- **Edición no destructiva.** Un audio (`asset`) es un archivo inmutable. Editar cambia solo
  el documento.
- **Tiempos en segundos** (`*_s`), números finitos de coma flotante, medidos desde el inicio
  de la sesión (el compás 1 empieza en `0.0`). Niveles en decibeles (`*_db`).
- **Validación estricta.** En la versión 1 un campo desconocido, un campo obligatorio ausente
  o un valor fuera de rango invalidan el documento completo: el Hub lanza
  `StudioSessionError` y el Worker responde 400 `bad_session`. Agregar un campo exige subir
  `version`. Las únicas tolerancias son las de la sección 2.6 (parámetros de efecto ausentes).
- **Identificadores.** `id` de sesión, audio, pista, clip, `take_group` y `job_id` cumplen
  `^[A-Za-z0-9_-]{1,80}$`. Dentro de una sesión son únicos por tipo; los ids de clip son
  únicos en toda la sesión, no solo en su pista. El id de pista `master` está reservado
  (sección 6.4).
- **Versión.** `version` es `1`. Otro valor se rechaza con `unsupported_version`.

## 2. Documento de sesión

### 2.1 Raíz

```
version             1
id                  string, id de la sesión; igual al {session} de la ruta
title               string, 1..120 caracteres después de recortar espacios
song_id             string | null. Canción de la librería (WORKSPACE_V2 Song.id) o null si
                    es una maqueta libre. Cumple ^[A-Za-z0-9_-]{1,80}$
bpm                 number, 40..260
beats_per_bar       integer, 1..12
key                 string | null, tonalidad ("C#m"), 1..12 caracteres
sample_rate         44100 | 48000 | 88200 | 96000. Frecuencia del AudioContext al crear
                    la sesión; no cambia después
latency_offset_ms   number, -500..500. Ajuste manual de alineación de tomas (sección 2.7)
updated_at          string ISO 8601 (UTC). Al guardar en la nube lo pone el Worker
updated_by          string | null, uuid del usuario que guardó. Lo pone el Worker
assets              Asset[], 0..256
tracks              Track[], 0..16, en orden de pantalla (arriba primero)
master              Master
```

Con `song_id`, el Hub toma BPM, compás, tonalidad y secciones de la canción al crear la
sesión; las secciones no se copian al documento: se leen del workspace al abrir.

### 2.2 Asset (audio)

```
id            string
file          string, exactamente "<id>.<ext>" con ext wav | flac | mp3. Es el {asset} de
              las rutas y el nombre del archivo en OPFS y en R2
kind          "recording" | "import" | "stem" | "generated" | "bounce" | "master"
label         string, 0..120 caracteres. Nombre para mostrar (archivo original, "Toma 3")
channels      1 | 2
sample_rate   integer, 8000..192000. Frecuencia real del archivo (puede diferir de la sesión
              en audios que devuelve un proveedor)
duration_s    number, > 0 y <= 1200
size          integer, 1..209715200 (200 MB). Bytes del archivo
source        null | { provider, job_id, prompt? }
```

`source` describe un audio generado o procesado por un proveedor:

```
provider   "musicai" | "lyria" | "suno"
job_id     string, id del trabajo que lo produjo (sección 6)
prompt     string opcional, 1..1000 caracteres (solo generación)
```

Un audio `generated` **debe** traer `source`: es la marca de "generado por IA" que la
interfaz muestra. En los demás tipos `source` puede ser `null` (por ejemplo un `master`
hecho con la normalización local, o un `stem` importado de la canción).

Un audio puede estar listado sin que ningún clip lo use (una toma descartada). El Hub limpia
los audios sin uso solo cuando el usuario lo pide.

### 2.3 Track (pista)

```
id               string, distinto de "master"
name             string, 1..60 caracteres
role             rol de bandait-protocol/fixtures/stem_names.json, o "unknown"
volume_db        number, -60..12. -60 o menos es silencio
pan              number, -1..1 (-1 izquierda, 1 derecha)
mute             boolean
solo             boolean
reverb_send_db   number, -60..0. -60 es sin envío
fx               Fx[], 0..2: a lo sumo un "eq" y un "compressor", en el orden en que procesan
clips            Clip[], 0..256
```

Solo: si alguna pista tiene `solo: true`, suenan únicamente las pistas con `solo: true`.
`mute` gana sobre `solo`. El envío a la reverb sale después del fader (post-fader).

### 2.4 Clip

```
id            string
asset_id      string, id de un audio de `assets`
start_s       number, >= 0. Posición del clip en la sesión
offset_s      number, >= 0. Dónde empieza la ventana dentro del audio
length_s      number, >= 0.01. Largo de la ventana
gain_db       number, -60..24
fade_in_s     number, >= 0
fade_out_s    number, >= 0
take_group    string | null
active        boolean
```

Reglas:

- `offset_s + length_s <= duration_s` del audio (tolerancia 0.001 s).
- `start_s + length_s <= 1200` (20 minutos por sesión; tolerancia 0.001 s).
- `fade_in_s + fade_out_s <= length_s` (tolerancia 0.000001 s).
- Mover cambia `start_s`. Recortar y dividir cambian solo `start_s`, `offset_s` y `length_s`.
- Un clip con `active: false` no suena y no se exporta.
- **Tomas.** Los clips de una misma pista con el mismo `take_group` son tomas alternativas
  de un pasaje. El grupo es local a la pista: el mismo texto en dos pistas son dos grupos.
  Elegir una toma (`setActiveTake`) la activa y desactiva las demás tomas del grupo que se
  solapan con ella en el tiempo. El documento no prohíbe dos tomas activas solapadas: quien
  reproduce suena **todos** los clips activos, así que los editores deben mantener la regla.
- Dos clips de una pista pueden solaparse; ambos suenan.

### 2.5 Master

```
volume_db   number, -60..12
fx          Fx[], 0..3: a lo sumo un "eq", un "compressor" y un "limiter". Si hay limitador,
            va de último
reverb      { decay_s, return_db }
```

`reverb` es la reverb compartida a la que envían las pistas (respuesta al impulso generada):

```
decay_s     number, 0.2..10 (1.8 por defecto)
return_db   number, -60..12 (0 por defecto). Nivel del retorno hacia el master
```

Cadena del master: suma de pistas + retorno de reverb -> `eq` y `compressor` en el orden de
`fx` -> `volume_db` -> `limiter` -> medidor -> salida. El limitador, si existe, es el último
proceso antes de la salida, **después** de `volume_db`: subir el fader del master no pasa el
techo.

### 2.6 Fx (efecto)

```
type     "eq" | "compressor" | "limiter"
bypass   boolean
params   objeto según `type`
```

Un parámetro ausente toma su valor por defecto; `serializeSession` siempre escribe todos. Un
parámetro desconocido o fuera de rango invalida el documento.

| `type` | Parámetro | Rango | Por defecto | Qué es |
|---|---|---|---|---|
| `eq` | `hpf_hz` | 0..1000 | 0 | Pasa altos de 12 dB/octava, Q 0.707. 0 = apagado |
| `eq` | `low_db` | -18..18 | 0 | Shelving de graves, fijo en 120 Hz |
| `eq` | `mid_hz` | 200..8000 | 1000 | Frecuencia de la banda media |
| `eq` | `mid_db` | -18..18 | 0 | Ganancia de la banda media (peaking) |
| `eq` | `mid_q` | 0.1..10 | 1 | Q de la banda media |
| `eq` | `high_db` | -18..18 | 0 | Shelving de agudos, fijo en 8000 Hz |
| `compressor` | `threshold_db` | -60..0 | -18 | Umbral |
| `compressor` | `ratio` | 1..20 | 3 | Relación |
| `compressor` | `attack_ms` | 0..1000 | 10 | Ataque |
| `compressor` | `release_ms` | 10..1000 | 150 | Relajación |
| `compressor` | `knee_db` | 0..40 | 6 | Codo |
| `compressor` | `makeup_db` | 0..24 | 0 | Ganancia de compensación, después del compresor |
| `limiter` | `ceiling_db` | -12..0 | -1 | Techo de pico |
| `limiter` | `release_ms` | 10..1000 | 100 | Relajación. La anticipación es fija: 5 ms |

`limiter` solo es válido en el master.

### 2.7 Alineación de una toma

```
start_s = posicion_al_arrancar
        + (t_primer_bloque - t_arranque_reproduccion)
        - latencia_ida_y_vuelta
        - latency_offset_ms / 1000
```

`t_*` son tiempos del `AudioContext`. `latencia_ida_y_vuelta` sale de la calibración por
interfaz y frecuencia; no se guarda en el documento, porque depende del equipo. Un
`latency_offset_ms` positivo adelanta las tomas siguientes; no mueve las ya grabadas. Si el
resultado es negativo, el clip empieza en `start_s = 0` con `offset_s` igual al sobrante.

### 2.8 Límites

| Límite | Valor |
|---|---|
| Pistas por sesión | 16 |
| Duración de la sesión | 1200 s (20 minutos) |
| Tamaño del documento serializado (UTF-8) | 262144 bytes (256 KB) |
| Tamaño de un audio | 209715200 bytes (200 MB) |
| Audios por sesión | 256 |
| Clips por pista | 256 |
| `title` | 120 caracteres |
| `name` de pista | 60 caracteres |
| `prompt` | 1000 caracteres |

### 2.9 Códigos de `StudioSessionError` (validación en el Hub)

`StudioSessionError` trae `code`, `path` (ruta del campo, por ejemplo
`tracks[0].clips[2].length_s`) y un mensaje en español.

| `code` | Cuándo |
|---|---|
| `not_an_object` | la raíz, o un elemento, no es un objeto |
| `unsupported_version` | `version` distinto de 1 |
| `missing_field` | falta un campo obligatorio |
| `unknown_field` | hay un campo que la versión 1 no define |
| `bad_type` | tipo incorrecto (texto donde va número, etcétera) |
| `out_of_range` | número o largo de texto fuera de rango |
| `bad_id` | un id no cumple el patrón, o una pista se llama `master` |
| `bad_value` | valor fuera de la lista permitida (`kind`, `role`, `type`, extensión de `file`) |
| `duplicate_id` | id repetido |
| `unknown_asset` | un clip apunta a un audio que no está en `assets` |
| `clip_out_of_asset` | la ventana del clip se sale del audio |
| `bad_fades` | los fades no caben en el clip |
| `session_too_long` | un clip termina después de los 20 minutos |
| `too_many` | más pistas, audios, clips o efectos que el límite |
| `bad_fx` | efecto repetido, `limiter` fuera del master o que no va de último |
| `missing_source` | audio `generated` sin `source` |
| `document_too_large` | el documento serializado supera 256 KB |

## 3. Rutas del Worker

Se agregan a la API v1 de `bandait-stems` (`bandait-stems-worker/README.md`), con las mismas
reglas de autenticación: `Authorization: Bearer <access_token de Supabase>`; `{band}` es el
uuid de la banda compartida o `me`. Leer: integrante. Escribir y lanzar trabajos: Owner y
MusicDirector.

`{session}` y `{job}` cumplen `^[A-Za-z0-9_-]{1,80}$`. `{asset}` es el `file` del audio:
`<id>.<ext>` con `id` de ese mismo patrón y `ext` `wav`, `flac` o `mp3`.

| Método y ruta | Quién | Respuesta |
|---|---|---|
| `GET /v1/bands/{band}/studio` | integrante | 200 `{"sessions":[{"id","title","song_id","updated_at"}]}`, ordenadas por `updated_at` descendente. Sin sesiones: lista vacía. Con más de 500 carpetas de sesión la respuesta trae además `"truncated": true` (solo se leyeron las primeras 500) |
| `GET /v1/bands/{band}/studio/{session}/session` | integrante | 200 documento, con cabecera `ETag`; 404 `no_session` |
| `PUT /v1/bands/{band}/studio/{session}/session` | Owner, MusicDirector | 200 documento guardado, con `ETag` nuevo |
| `DELETE /v1/bands/{band}/studio/{session}` | Owner, MusicDirector | 200 `{"deleted": n}` (objetos borrados; 0 si no existía) |
| `PUT /v1/bands/{band}/studio/{session}/assets/{asset}` | Owner, MusicDirector | 200 `{"file","size"}` |
| `GET /v1/bands/{band}/studio/{session}/assets/{asset}` | integrante | 200 bytes, o 206 con `Range`; 404 `no_asset` |
| `POST /v1/bands/{band}/studio/{session}/jobs` | Owner, MusicDirector | 202 `{"job_id","status":"STARTED","kind"}` |
| `POST /v1/bands/{band}/studio/{session}/jobs?estimate=1` | Owner, MusicDirector | 200 estimación de costo, sin lanzar nada (sección 6.6) |
| `GET /v1/bands/{band}/studio/{session}/jobs/{job}` | integrante | 200 estado del trabajo (sección 6.5); 404 `no_job` |

Toda respuesta de error es `{"error": "<código>"}` con el estado HTTP de la sección 7.

### 3.1 Objetos en R2

Bajo el prefijo de la banda (`bands/<uuid>/` o `users/<uid>/`):

```
studio/<session>/session.json        documento
studio/<session>/assets/<file>       audios
studio/<session>/jobs/<job>.json     estado interno de un trabajo (no es parte del contrato)
studio/_usage/AAAA-MM.json           gasto del mes de la banda (sección 6.7)
```

En la raíz del bucket, fuera de todo prefijo de banda: `studio/_usage/AAAA-MM.json`, el gasto
del mes de todo el Worker (sección 6.7).

`_usage` no es un id de sesión accesible: las rutas con `{session}` que empiece por `_`
responden 400 `bad_session_id`.

## 4. Guardar y leer la sesión

### 4.1 `GET .../session`

Devuelve el documento tal como se guardó, `Content-Type: application/json`, con `ETag`
fuerte (entre comillas) y `Cache-Control: no-store`. El cliente guarda el `ETag` tal cual
llega y lo devuelve en el siguiente `PUT`.

### 4.2 `PUT .../session`

Cuerpo: el documento (máximo 256 KB; si no, 413 `session_too_large`). El límite se aplica dos
veces: al cuerpo recibido (se corta la lectura al pasarlo, con o sin `Content-Length`) y al
documento que se guarda, ya normalizado y con `updated_at` y `updated_by` del Worker. Un
cliente que quiera estar seguro deja unos 100 bytes de margen.

Precondición obligatoria, exactamente una de las dos:

- `If-None-Match: *` para crear. Si la sesión ya existe: 412 `session_conflict`.
- `If-Match: <etag>` para reemplazar. Si no coincide con el guardado, o la sesión no existe:
  412 `session_conflict`.

Sin ninguna de las dos: 428 `precondition_required`.

El Worker valida el documento con las reglas de la sección 2 (400 `bad_session`); `id` debe
ser igual a `{session}` (400 `bad_session`). Cada audio de `assets` debe existir en
`assets/<file>` con ese `size`: si no, 409 `missing_asset`. Luego pone `updated_at` (hora del
Worker) y `updated_by` (el `sub` del token), guarda y responde el documento guardado con su
`ETag`. Guardar el documento **no** borra audios que dejaron de estar listados.

Ante un 412 el Hub no pisa nada: avisa que otra persona guardó, y ofrece recargar o guardar
como copia (sesión nueva con otro id).

### 4.3 `DELETE .../{session}`

Borra el documento, los audios y los trabajos de la sesión. Es idempotente.

## 5. Audios

### 5.1 `PUT .../assets/{asset}`

Cuerpo: los bytes. `Content-Length` obligatorio (411 `length_required`), mayor que cero
(400 `empty_body`) y de hasta 200 MB (413 `file_too_large`). `Content-Type` `audio/*` o
`application/octet-stream` (415 `not_audio`). Si llegan menos bytes que los declarados:
400 `incomplete_upload`.

Un audio es **inmutable**: si ya existe con el mismo tamaño responde 200 `{"file","size"}`
sin volver a escribir (reintentar es seguro); si existe con otro tamaño, 409 `asset_exists`.

Se puede subir un audio antes de que exista el documento de la sesión: la mezcla que se manda
a masterizar se sube así.

Una sesión admite hasta 320 audios en `assets/` (los 256 del documento más margen para mezclas
y resultados de trabajos): pasado ese número, 409 `too_many_assets`. No hay todavía cuota de
almacenamiento por banda ni limpieza de audios de sesiones sin documento (pendiente).

### 5.2 `GET .../assets/{asset}`

200 con los bytes, `Content-Length`, `Content-Type` según la extensión (`audio/wav`,
`audio/flac`, `audio/mpeg`), `Accept-Ranges: bytes` y `ETag`. Con `Range: bytes=a-b` (un solo
rango) responde 206 con `Content-Range`; un rango imposible, 416 `bad_range`.

## 6. Trabajos de IA

Un trabajo nunca modifica la sesión. Deja audios en `assets/` o devuelve sugerencias; el Hub
los agrega al documento cuando el usuario acepta.

### 6.1 `POST .../jobs`

Cuerpo JSON (máximo 64 KB), con `kind` y los campos de su tipo. Campo desconocido, ausente o
fuera de rango: 400 `bad_job`.

| `kind` | Campos | Proveedor |
|---|---|---|
| `master` | `asset_id`, `duration_s`, `target_lufs` | Music.AI, workflow `MUSICAI_MASTER_WORKFLOW` |
| `separate` | `asset_id`, `duration_s` | Music.AI, workflow `MUSICAI_SPLIT_WORKFLOW` |
| `generate` | `provider`, `prompt`, `duration_s`, `bpm`, `key`, `instrumental` | Lyria; Suno cuando tenga API |
| `assist` | `metrics` | modelo de lenguaje |

```
master
  asset_id      string. Id (sin extensión) de un audio ya subido a assets/: la mezcla
  duration_s    number, > 0 y <= 1200. Duración del audio, declarada por el Hub. El costo NO
                depende solo de ella: el Worker calcula la duración real desde el audio en R2
                (cabecera WAV o FLAC; en MP3, un piso por tamaño) y cobra la mayor de las dos
  target_lufs   number, -24..-6 (-14 por defecto en el Hub)

separate
  asset_id      string, como en master
  duration_s    number, > 0 y <= 1200

generate
  provider      "lyria" | "suno"
  prompt        string, 1..1000 caracteres
  duration_s    number, 5..240. Duración pedida; el proveedor puede devolver otra
  bpm           number, 40..260
  key           string | null
  instrumental  boolean

assist
  metrics       Metrics (sección 6.3)
```

`asset_id` se resuelve buscando en `assets/` el archivo `<asset_id>.wav`, `.flac` o `.mp3`;
si no existe: 404 `no_asset`.

Respuesta: 202 `{"job_id": "<id>", "status": "STARTED", "kind": "<kind>"}`.

**Idempotencia.** El cliente puede elegir el id con `?job_id=<id>` (`job_` más el patrón de
id; si no cumple, 400 `bad_job`). Si ya existe un trabajo con ese id en la sesión, el `POST` no
lanza otro ni cobra: responde el mismo 202 y el estado se lee con `GET`. El Hub lo usa siempre:
guarda el id antes de enviar y, si la respuesta se pierde (un `generate` espera decenas de
segundos), consulta ese id en vez de relanzar. Sin `job_id`, el id lo elige el Worker.

**Orden de un `POST`.** Antes de llamar al proveedor el Worker guarda el trabajo en `STARTED`
y anota el costo (sección 6.7). Si el proveedor rechaza la petición, revierte las dos cosas y
responde 502. `generate` y `assist` esperan al proveedor dentro del `POST`; el Worker mantiene
esa espera viva aunque el cliente corte la conexión (`waitUntil`), de modo que el resultado
queda guardado y se puede consultar por `job_id`.

Errores propios: 429 `quota_exceeded` (tope mensual, sección 6.7); 403 `not_a_spender` (el
usuario no está en la lista de quienes pueden gastar, sección 6.7); 503 `provider_unavailable`
(falta el secreto o el workflow del proveedor); 501 `provider_unavailable` (`suno`, hasta que
tenga acceso); 502 `provider_failed` (el proveedor rechazó la petición); 503 `usage_busy` (el
contador de gasto no se pudo actualizar tras varios intentos; se reintenta).

### 6.2 Resultado por `kind`

| `kind` | `SUCCEEDED` trae | Audios que deja |
|---|---|---|
| `master` | `assets` con 1 elemento | uno, `kind: "master"`, `source.provider: "musicai"` |
| `separate` | `assets` con 1 o más | uno por instrumento, `kind: "stem"`, con `role`; `source.provider: "musicai"` |
| `generate` | `assets` con 1 elemento | uno, `kind: "generated"`, `source` con `provider`, `job_id` y `prompt` |
| `assist` | `suggestions` | ninguno |

Cada elemento de `assets` en la respuesta de un trabajo (**JobAsset**):

```
id            string, id nuevo del audio (lo elige el Worker)
file          string, "<id>.<ext>"
kind          "master" | "stem" | "generated"
label         string, nombre para mostrar ("Master -14 LUFS", "Voz", "Pad 16 compases")
role          rol de stem_names.json o "unknown"; null si no aplica (master, generate)
size          integer, bytes en R2
channels      1 | 2 | null
sample_rate   integer | null
duration_s    number | null
source        { provider, job_id, prompt? }
```

`channels`, `sample_rate` y `duration_s` van en `null` cuando el Worker no los conoce: el
Hub los completa al decodificar el audio, antes de agregarlo a `assets` del documento.

### 6.3 Metrics (cuerpo de `assist`)

El Hub mide las pistas con `loudness.ts` y manda solo números; nunca audio.

```
metrics
  target_lufs    number, -24..-6. Volumen objetivo de la mezcla
  master         { lufs, true_peak_db }
  tracks         TrackMetrics[], 1..16

TrackMetrics
  track_id       string
  name           string
  role           rol de stem_names.json o "unknown"
  lufs           number | null. LUFS integrado de la pista sola, post-fader; null si es silencio
  true_peak_db   number | null. Pico real en dBTP; null si es silencio
  bands          { low_db, low_mid_db, high_mid_db, high_db } | null. null si es silencio
  volume_db      number, fader actual
  pan            number, paneo actual
  fx             Fx[], efectos actuales de la pista (sección 2.6)
```

`bands` es la energía por banda en dB relativa a la energía total de la pista (cada valor
<= 0, con piso en -120): `low_db` hasta 200 Hz, `low_mid_db` de 200 a 2000 Hz, `high_mid_db`
de 2000 a 6000 Hz, `high_db` desde 6000 Hz.

`master.lufs` y `master.true_peak_db` son `number | null` con el mismo criterio.

### 6.4 Suggestions (resultado de `assist`)

`suggestions` es una lista de 0 a 32 cambios propuestos. Cada uno se aplica por separado,
como un paso de deshacer, cuando el usuario lo acepta.

```
track_id   string. Id de una pista de las métricas, o "master" para el bus master
target     "volume_db" | "pan" | "fx"
value      number | null. Valor nuevo cuando target es "volume_db" o "pan"; null con "fx"
fx_type    "eq" | "compressor" | "limiter" | null. Obligatorio con target "fx"; null si no
params     objeto | null. Con target "fx": parámetros de la sección 2.6 para `fx_type`, solo
           los que cambian (puede ser parcial). null con los demás targets
reason     string, 1..280 caracteres, en español: por qué se propone el cambio
```

Ejemplo:

```json
{"suggestions": [
  {"track_id": "trk_1", "target": "volume_db", "value": -3.0, "fx_type": null, "params": null,
   "reason": "La voz queda 4 LU por encima de la guitarra; bajarla la asienta en la mezcla."},
  {"track_id": "trk_2", "target": "fx", "value": null, "fx_type": "eq",
   "params": {"hpf_hz": 80, "low_db": -2},
   "reason": "La guitarra acumula energía bajo 200 Hz que compite con el bajo."},
  {"track_id": "master", "target": "fx", "value": null, "fx_type": "limiter",
   "params": {"ceiling_db": -1},
   "reason": "El pico real del master supera -1 dBTP."}
]}
```

Reglas:

- `volume_db` y `pan` respetan los rangos de la pista (2.3); con `track_id: "master"` solo se
  admite `volume_db` (rango de 2.5), nunca `pan`.
- Con `target: "fx"`, aplicar es: si la pista ya tiene un efecto de ese `fx_type`, se
  reemplazan solo los parámetros listados y `bypass` pasa a `false`; si no lo tiene, se agrega
  con los valores por defecto más los listados. `limiter` solo se propone para `master`.
- El Worker valida la salida del modelo contra estas reglas y **descarta** las sugerencias
  que no cumplen (pista inexistente, parámetro fuera de rango). El Hub las valida otra vez
  antes de mostrarlas. Una lista vacía es un resultado válido.

### 6.5 `GET .../jobs/{job}`

Todas las respuestas son 200 y traen `job_id`, `kind` y `status`:

```
{"job_id", "kind", "status": "STARTED"}
{"job_id", "kind", "status": "IMPORTING", "done": n, "total": m}
{"job_id", "kind", "status": "SUCCEEDED", "assets": JobAsset[], "cost_usd": number}
{"job_id", "kind": "assist", "status": "SUCCEEDED", "suggestions": Suggestion[], "cost_usd": number}
{"job_id", "kind", "status": "FAILED", "error": "<texto para mostrar>"}
```

- `STARTED`: el proveedor trabaja. Cualquier estado intermedio del proveedor (en cola,
  procesando) se informa como `STARTED`. También cuando el Worker **no pudo consultar** al
  proveedor en ese `GET` (red, 5xx): un fallo del sondeo no es un fallo del trabajo, que ya
  está pagado. `GET` nunca responde `provider_failed`. Solo un 404 del proveedor (el trabajo
  ya no existe allí) pasa a `FAILED`.
- Un trabajo cuyo `POST` se interrumpió antes de tener id del proveedor se informa `STARTED`
  durante 10 minutos desde su creación y después `FAILED` ("quedó incompleto"). Su costo queda
  anotado: el proveedor pudo haber cobrado.
- `IMPORTING`: el proveedor terminó y el Worker copia los audios a `assets/`, **uno por cada
  `GET`** (patrón de `copyNextStem`). Hay que seguir consultando. Una copia que falla
  responde 502 `asset_copy_failed`; es idempotente y se reintenta con el siguiente `GET`.
- `SUCCEEDED` y `FAILED` son finales; repetir el `GET` devuelve lo mismo.
- `cost_usd` es el costo estimado que se sumó al gasto del mes.
- Dos `GET` simultáneos del mismo trabajo no se pisan: el registro se escribe con condición
  (`If-Match` del que se leyó) y el que pierde responde con el estado del que ganó, sin copiar.
- Una salida solo se guarda como audio si sus primeros bytes son de WAV, FLAC o MP3; la
  extensión del audio sale de ahí. En `master` se descartan las salidas cuya URL declara otra
  extensión (un informe `.json`); si quedan varias y ninguna se llama `master...`, o el
  contenido no es audio, el trabajo pasa a `FAILED` con un texto que dice qué revisar en el
  workflow.

Sondeo recomendado para el Hub: cada 3 s, hasta 15 minutos; los errores de red y
`asset_copy_failed` se reintentan hasta 8 veces seguidas.

### 6.6 Estimación: `POST .../jobs?estimate=1`

Mismo cuerpo que 6.1. No lanza el trabajo ni gasta. Valida igual (los mismos errores, incluso
`provider_unavailable`, para deshabilitar el botón). Respuesta 200:

```
{"kind", "estimated_cost_usd": number, "spent_usd": number, "budget_usd": number | null,
 "allowed": boolean}
```

`spent_usd` es el gasto del mes en curso de la banda; `budget_usd` es
`STUDIO_MONTHLY_BUDGET_USD` o `null` si no hay tope; `allowed` es `false` cuando lanzar el
trabajo daría 429 `quota_exceeded`, por el tope de la banda o por el tope global del Worker
(que no se expone). `estimated_cost_usd` ya usa la duración real del audio (sección 6.1).

### 6.7 Control de gasto

El Worker lleva `studio/_usage/AAAA-MM.json` por banda (mes en UTC):

```
{"month": "2026-11", "total_usd": 1.84,
 "entries": [{"at": "<ISO 8601>", "job_id", "kind", "provider", "seconds": number,
              "cost_usd": number, "user": "<uuid>"}]}
```

El costo se anota **antes** de llamar al proveedor (no al terminar) con las tarifas
configuradas en el Worker, y se revierte si el proveedor rechaza la petición. Si
`total_usd + costo estimado` supera `STUDIO_MONTHLY_BUDGET_USD`, el `POST` responde 429
`quota_exceeded` y no llama al proveedor. El contador se actualiza con escritura condicional y
reintento (comprobar el tope y anotar es una sola operación): dos trabajos lanzados a la vez
no pierden entradas ni pasan juntos el tope. Sigue siendo un tope de contención, no de
facturación: las tarifas son estimaciones.

**Tope global.** Además del contador por banda hay uno de todo el Worker, en
`studio/_usage/AAAA-MM.json` en la raíz del bucket, con la misma forma más `scope` (el prefijo
que gastó) en cada entrada. Si `STUDIO_GLOBAL_MONTHLY_BUDGET_USD` tiene valor, ningún trabajo
pasa ese total, sea de la banda que sea. Existe porque el tope por banda no limita el gasto
total: cada cuenta de Supabase es editora de su workspace `me`, y cualquiera puede crear una
banda y ser su Owner, cada uno con su propio tope.

**Quién puede gastar.** Con `STUDIO_SPENDER_UIDS` (uuid separados por coma) solo esos usuarios
lanzan trabajos de IA y análisis (`POST .../jobs`, su estimación y `POST .../analysis`); el
resto recibe 403 `not_a_spender`. Vacía: cualquier editor. Mientras el registro de cuentas del
proyecto esté abierto, se recomienda configurarla.

## 7. Códigos de error del Worker

Además de los que ya existen (`missing_token` 401, `invalid_token` 401, `not_a_member` 403,
`not_an_editor` 403, `bad_band` 400, `not_found` 404, `method_not_allowed` 405,
`auth_unavailable` 502, `internal` 500):

| HTTP | `error` | Cuándo |
|---|---|---|
| 400 | `bad_session_id` | `{session}` no cumple el patrón o empieza por `_` |
| 400 | `bad_session` | el documento no es JSON, no cumple la sección 2, o su `id` no es `{session}` |
| 400 | `bad_asset` | `{asset}` no es `<id>.<wav\|flac\|mp3>` |
| 400 | `bad_job` | cuerpo de trabajo inválido, o `{job}` no cumple el patrón |
| 400 | `empty_body` | subida sin bytes |
| 400 | `incomplete_upload` | llegaron menos bytes que `Content-Length` |
| 404 | `no_session` | la sesión no existe |
| 404 | `no_asset` | el audio no existe |
| 404 | `no_job` | el trabajo no existe |
| 409 | `missing_asset` | el documento lista un audio que no está en `assets/` con ese tamaño |
| 409 | `asset_exists` | ya hay un audio con ese nombre y otro tamaño |
| 409 | `too_many_assets` | la sesión ya tiene 320 audios en `assets/` |
| 403 | `not_a_spender` | `STUDIO_SPENDER_UIDS` tiene valor y el usuario no está en la lista |
| 411 | `length_required` | subida sin `Content-Length` |
| 412 | `session_conflict` | `If-Match` no coincide, o `If-None-Match: *` y la sesión existe |
| 413 | `session_too_large` | documento de más de 256 KB |
| 413 | `file_too_large` | audio de más de 200 MB |
| 415 | `not_audio` | `Content-Type` que no es audio |
| 416 | `bad_range` | `Range` imposible o con más de un rango |
| 428 | `precondition_required` | `PUT` de sesión sin `If-Match` ni `If-None-Match: *` |
| 429 | `quota_exceeded` | el trabajo pasaría el tope mensual de la banda o el global del Worker |
| 501 | `provider_unavailable` | proveedor sin API todavía (`suno`) |
| 502 | `provider_failed` | el proveedor rechazó o falló al lanzar el trabajo (solo en `POST`; nada se cobra) |
| 503 | `usage_busy` | el contador de gasto no se pudo actualizar tras varios intentos; se reintenta |
| 502 | `asset_copy_failed` | falló la copia de un audio del proveedor a R2; se reintenta |
| 503 | `provider_unavailable` | falta el secreto o el workflow del proveedor |

Aviso para el cliente: `no_session` aquí es "la sesión del Estudio no existe" (404). El
cliente de stems (`stemCloud.ts`) usa ese mismo texto, con estado 401 y sin pasar por la red,
para "no hay sesión de nube". `studioCloud.ts` los distingue por el estado HTTP y traduce el
404 a `null` en `getSession`.

## 8. Variables del Worker

| Nombre | Tipo | Uso |
|---|---|---|
| `MUSICAI_API_KEY` | secreto (existe) | `master` y `separate` |
| `MUSICAI_SPLIT_WORKFLOW` | variable (existe) | `separate` |
| `MUSICAI_MASTER_WORKFLOW` | variable | `master`; sin ella, 503 `provider_unavailable` |
| `GEMINI_API_KEY` | secreto | `generate` con `lyria` |
| `ASSIST_API_KEY` | secreto | `assist` |
| `SUNO_API_KEY` | secreto (futuro) | `generate` con `suno` |
| `STUDIO_MONTHLY_BUDGET_USD` | variable | tope mensual por banda; sin ella no hay tope |
| `STUDIO_GLOBAL_MONTHLY_BUDGET_USD` | variable | tope mensual de todo el Worker; sin ella no hay tope global |
| `STUDIO_SPENDER_UIDS` | variable | uuid (separados por coma) que pueden lanzar trabajos; vacía: cualquier editor |
| `MUSICAI_MASTER_LUFS_PARAM` | variable | nombre del parámetro del workflow de mastering que recibe `target_lufs`; sin ella no se envía |
| `ASSIST_PROVIDER` | variable | proveedor del asistente; por defecto `anthropic` (el único implementado) |
| `ASSIST_MODEL` | variable | modelo del asistente; tiene valor por defecto en el código |
| `LYRIA_CLIP_MODEL`, `LYRIA_SONG_MODEL` | variables | modelos de Lyria para pedidos de hasta 30 s y más largos |
| `STUDIO_RATE_MASTER_USD_PER_MIN`, `STUDIO_RATE_SEPARATE_USD_PER_MIN`, `STUDIO_RATE_LYRIA_USD_PER_30S`, `STUDIO_RATE_ASSIST_USD` | variables | tarifas para estimar el costo; sin ellas, las de referencia del plan |

El navegador nunca recibe ninguna de estas claves.
