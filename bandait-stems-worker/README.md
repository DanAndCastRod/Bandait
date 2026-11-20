# bandait-stems: stems de las bandas en Cloudflare R2

Worker de Bandait que guarda y sirve los stems de cada canción de una banda, para que el hub
(estudio en casa) y el líder (PA) usen los mismos archivos. Producción:
`https://bandait-stems.oooglue.workers.dev` (bucket privado `bandait-stems`, sin dominio público).

Bandait no tiene backend: el Worker valida la sesión de Supabase de quien llama con **su propio
JWT** y la clave publicable (`SUPABASE_ANON_KEY`, pública), mediante la RPC
`bandait_band_role(p_band)` del SQL de bandas compartidas. No hay `service_role` en ningún lado y
RLS sigue siendo la fuente de verdad. Se descartó reutilizar `urit-media` de URiT: necesita un
consumidor con backend que firme permisos, que aquí sería otro Worker; con R2 enlazado ese mismo
Worker ya guarda y sirve los archivos.

## API v1

Todas las rutas, salvo `/v1/health`, piden `Authorization: Bearer <access_token de Supabase>`.
`{band}` es el uuid de una banda compartida (`bandait_bands.id`) o `me` para el workspace personal
(solo su dueño lo lee y escribe). `{song}` es el id de la canción en el hub (`[A-Za-z0-9_-]{1,80}`;
en el líder, `songs.cloud_id`). `{name}` es el nombre del archivo, codificado con
`encodeURIComponent` (`[A-Za-z0-9 ._()-]{1,120}`, extensión mp3/m4a/wav/flac/ogg/aac).

| Método y ruta | Quién | Respuesta |
|---|---|---|
| `GET /v1/health` | cualquiera | `{"ok":true,"version":"1.0.0"}` |
| `GET /v1/bands/{band}/songs/{song}/manifest` | integrante | manifiesto, o 404 `no_stems` |
| `PUT /v1/bands/{band}/songs/{song}/files/{name}` | Owner, MusicDirector | `{"file","size"}`; cuerpo = bytes, `Content-Length` obligatorio, `Content-Type` `audio/*` u `application/octet-stream`, máximo 200 MB |
| `GET /v1/bands/{band}/songs/{song}/files/{name}` | integrante | bytes |
| `PUT /v1/bands/{band}/songs/{song}/manifest` | Owner, MusicDirector | manifiesto guardado (con `updated_at`) |
| `DELETE /v1/bands/{band}/songs/{song}` | Owner, MusicDirector | `{"deleted": n}` |
| `POST /v1/bands/{band}/songs/{song}/analysis` | Owner, MusicDirector | 202 `{"status":"STARTED","job_id","separate"}`; cuerpo = mezcla de audio, `Content-Length` obligatorio, `Content-Type` `audio/*`, máximo 95 MB. Con `?separate=1` el cuerpo es la canción completa y Music AI además separa los stems |
| `GET /v1/bands/{band}/songs/{song}/analysis` | integrante (leer no gasta créditos) | `{"status":"STARTED","job_id"}`, `{"status":"IMPORTING","job_id","done","total"}` (separación: copiando stems), `{"status":"SUCCEEDED","job_id","created_at","draft","stems"?}`, `{"status":"FAILED","job_id","error"}` o 404 `no_analysis` |

Subir: primero cada archivo, después el manifiesto. El manifiesto es el commit: cada archivo que
lista debe existir con ese `size` (si no, 409 `missing_file`) y los archivos que ya no lista se
borran. Reemplazar los stems de una canción es volver a subir y mandar el manifiesto nuevo.

Manifiesto (máximo 16 stems, 64 KB):

```json
{"version": 1, "song_id": "<song>", "offset_ms": 0,
 "stems": [{"file": "Hoy - Vocals.mp3", "role": "vocals", "label": "Voz", "size": 8812345}]}
```

`role` usa los roles de `bandait-protocol/fixtures/stem_names.json` más `unknown`. El líder no
puede decodificar m4a/aac: conviene subir MP3.

### Análisis con IA (Music AI)

El análisis gasta créditos de Music AI: solo Owner y MusicDirector lo lanzan y leen. El hub manda
una mezcla mono de los stems de la canción (sin clic ni guía), a 22 050 Hz en WAV de 16 bits
(unos 10 MB por 4 minutos); el Worker la sube a Music AI con el workflow `MUSICAI_WORKFLOW` y
guarda el trabajo en `analysis.json` de la canción. `GET .../analysis` consulta el trabajo; cuando
termina, ensambla el borrador una sola vez (`src/analysis.ts`) y lo deja guardado, así que el
siguiente GET lo devuelve sin volver a Music AI. Hay un solo análisis por canción: lanzar otro lo
reemplaza. Lo puede lanzar el hub o el líder; el borrador se acepta en el editor de canciones del
hub, que primero hace `GET` y solo sube una mezcla nueva con ANALIZAR (o ANALIZAR DE NUEVO).

El hub consulta cada 5 s, hasta 6 minutos. Borrador:

```json
{"source": "music.ai", "bpm": 128.0, "key": "C#m", "beats_per_bar": 4,
 "sections": [{"kind": "intro", "label": "Intro", "bars": 4, "start_bar": 1,
               "chordpro": "[C#m]    [A]    [E]    [B]", "cue_text": null}],
 "lyrics_unplaced": ["línea sin tiempos"], "notes": ["..."]}
```

`kind` usa los tipos de sección de `bandait-protocol/WORKSPACE_V2.md`. Con letra alineada (tiempos
por palabra), `chordpro` trae la letra con cada acorde en línea sobre la palabra donde cambia
(`[A]linea con [E]acorde`) y los compases sin canto como líneas solo de acordes; sin letra, cuatro
compases por línea. La letra sin tiempos no se puede ubicar en las secciones y llega en
`lyrics_unplaced`. `analysis.json` guarda el resultado crudo y `ASSEMBLER_VERSION`: un borrador de
otra versión se rehace desde ese resultado sin llamar a Music AI.

**Separar desde un audio** (`?separate=1`, workflow `MUSICAI_SPLIT_WORKFLOW`, por defecto
`splited_stems_bandait`): las salidas `Vocals`, `Drums`, `Bass`, `Guitars`, `Keys`, `Piano`, `Other`
(y `Guitar`, `Strings`, `Wind`, `Backing Vocals` si existen) son stems. Al terminar el trabajo, cada
`GET` copia un stem de Music AI a `files/` (respuesta `IMPORTING`, para no pasar de unos segundos
por petición; la copia es idempotente) y, con todos copiados, escribe `manifest.json` (roles y
etiquetas en español, `offset_ms` 0), que **reemplaza** los stems anteriores de la canción, y
después el borrador. En la prueba del 2026-10-31 cada stem de una canción de 4 min pesó 43 MB (WAV
de 16 bits, 44.1 kHz, estéreo): unos 300 MB por canción en R2.

Errores propios: 503 `analysis_unavailable` (sin `MUSICAI_API_KEY` o Music AI caído), 502
`analysis_auth_failed` / `analysis_failed` / `analysis_upload_failed` / `stems_copy_failed` (se
reintenta con otro GET), 413 `file_too_large`, 415 `not_audio`, 411 `length_required`.

Errores: `{"error": "<codigo>"}` con `missing_token` / `invalid_token` (401), `not_a_member` /
`not_an_editor` (403), `no_stems` / `no_file` (404), `bad_band` / `bad_song` / `bad_file` /
`bad_manifest` / `incomplete_upload` (400), `missing_file` (409), `length_required` (411),
`file_too_large` / `manifest_too_large` (413), `not_audio` (415), `auth_unavailable` (502),
`no_analysis` (404) y los del análisis (arriba).

CORS: solo los orígenes de `ALLOWED_ORIGINS` (hub en producción y servidores de desarrollo). El
líder (Python) no necesita CORS. El navegador puede mandar `If-Match`, `If-None-Match` y `Range`,
y leer `ETag`, `Content-Range` y `Accept-Ranges`.

## Estudio (`/studio`)

Sesiones, audios y trabajos de IA del Estudio Bandait. El contrato normativo, con cada campo,
límite y código de error, es `bandait-protocol/STUDIO_V1.md` más lo que cambia en
`bandait-protocol/STUDIO_V2.md` (pistas de instrumento, clips MIDI, marcas y los trabajos
`compose`, `analyze` y `chat`); aquí va el resumen. Mismas reglas
de autenticación: leer, cualquier integrante; escribir y lanzar trabajos, Owner y MusicDirector.
El escenario (leader, follower) no usa estas rutas.

| Método y ruta | Quién | Respuesta |
|---|---|---|
| `GET /v1/bands/{band}/studio` | integrante | `{"sessions":[{"id","title","song_id","updated_at"}]}`, la más reciente primero |
| `GET /v1/bands/{band}/studio/{session}/session` | integrante | documento, con `ETag`; 404 `no_session` |
| `PUT /v1/bands/{band}/studio/{session}/session` | Owner, MusicDirector | documento guardado, con `ETag` nuevo |
| `DELETE /v1/bands/{band}/studio/{session}` | Owner, MusicDirector | `{"deleted": n}` (documento, audios y trabajos) |
| `PUT /v1/bands/{band}/studio/{session}/assets/{asset}` | Owner, MusicDirector | `{"file","size"}` |
| `GET /v1/bands/{band}/studio/{session}/assets/{asset}` | integrante | bytes; 206 con `Range: bytes=a-b` |
| `POST /v1/bands/{band}/studio/{session}/jobs` | Owner, MusicDirector | 202 `{"job_id","status":"STARTED","kind"}` |
| `POST /v1/bands/{band}/studio/{session}/jobs?estimate=1` | Owner, MusicDirector | `{"kind","estimated_cost_usd","spent_usd","budget_usd","allowed"}`, sin lanzar nada |
| `GET /v1/bands/{band}/studio/{session}/jobs/{job}` | integrante | estado del trabajo; 404 `no_job` |

`{session}` y `{job}` son `[A-Za-z0-9_-]{1,80}` (una sesión no puede empezar por `_`). `{asset}`
es `<id>.wav`, `<id>.flac` o `<id>.mp3`. En R2, bajo el prefijo de la banda:
`studio/<session>/session.json`, `studio/<session>/assets/<file>`,
`studio/<session>/jobs/<job>.json` y `studio/_usage/AAAA-MM.json`.

**Guardar la sesión.** `PUT .../session` pide exactamente una precondición: `If-None-Match: *`
para crear o `If-Match: <etag>` para reemplazar (sin ninguna, 428 `precondition_required`). Si la
sesión ya existe, o el `ETag` no es el guardado, responde 412 `session_conflict` y no pisa nada.
El Worker valida el documento completo (`src/studioSession.ts`; 400 `bad_session`), exige que
cada audio listado exista en `assets/` con ese tamaño (409 `missing_asset`) y pone `updated_at` y
`updated_by`. Guardar no borra audios que dejaron de listarse. Documento de hasta 1 MiB (413
`session_too_large`). Acepta documentos `version` 1 y 2 y guarda cada uno en su versión (el
Worker no migra: el Hub migra un v1 al abrirlo y lo guarda como v2). Un v1 se valida con las
reglas de v1 (un campo de v2 en un v1 es error). En v2 se comprueban también los audios de los
congelados (`frozen_asset_id`) y de las zonas del sampler.

**Audios.** Inmutables: subir de nuevo el mismo nombre con el mismo tamaño responde 200 sin
reescribir; con otro tamaño, 409 `asset_exists`. `Content-Length` obligatorio (411), hasta 200 MB
(413), `Content-Type` `audio/*` u `application/octet-stream` (415). Se puede subir un audio antes
de que exista el documento. La descarga responde con el tipo según la extensión y admite un solo
rango; un rango imposible o múltiple es 416 `bad_range`.

**Trabajos.** Cuerpo JSON con `kind`:

| `kind` | Campos | Proveedor | Cómo corre |
|---|---|---|---|
| `master` | `asset_id`, `duration_s`, `target_lufs` | Music AI, workflow `MUSICAI_MASTER_WORKFLOW` | asíncrono |
| `separate` | `asset_id`, `duration_s` | Music AI, workflow `MUSICAI_SPLIT_WORKFLOW` | asíncrono |
| `generate` | `provider` (`lyria`, `suno`), `prompt`, `duration_s`, `bpm`, `key`, `instrumental` | Lyria por URiT IA (`POST /v1/music`); `suno` responde 501 | síncrono |
| `assist` | `metrics` (solo números, nunca audio) | modelo de lenguaje (`ASSIST_PROVIDER`, `ASSIST_MODEL`) | síncrono |
| `compose` | `prompt`, `bpm`, `key`, `beats_per_bar`, `length_bars`, `role`, `context` | texto con JSON y esquema (`ASSIST_PROVIDER`: `urit` o `gemini`) | síncrono |
| `analyze` | `asset_id`, `duration_s` | Music AI, workflow `MUSICAI_ANALYZE_WORKFLOW` o `MUSICAI_WORKFLOW` | asíncrono |
| `chat` | `messages`, `session_summary`, `tool_mode` | texto con herramientas (`ASSIST_PROVIDER`: `urit` o `gemini`) | síncrono |

`GET .../jobs/{job}` responde `STARTED`, `IMPORTING` (`done`, `total`), `SUCCEEDED` (`assets`,
`suggestions`, `notes` + `length_beats` + `description`, `analysis` o `reply` + `tool_calls`,
según el `kind`, y `cost_usd`) o `FAILED` (`error`). Un trabajo nunca modifica la sesión: deja
audios en `assets/` o devuelve propuestas, y el Hub las agrega cuando el usuario acepta.

- `master` y `separate` suben el audio de `assets/` a Music AI y lanzan el workflow. Cuando
  termina, cada `GET` copia **un** audio a `assets/` (mismo patrón que la separación de stems de
  arriba): el id del audio se reserva antes de copiar, así que reintentar tras un 502
  `asset_copy_failed` pisa el mismo objeto. El registro del trabajo se escribe con condición
  (`If-Match`): dos `GET` simultáneos no reservan dos juegos de ids ni se pisan. De un workflow de
  mastering se descartan las salidas cuya URL declara otra extensión (un informe `.json`) y se
  toma la única que se llame `master...` o la única que quede; si hay varias sin distinguir, el
  trabajo falla con un texto claro: conviene que el workflow tenga una sola salida de audio. Una
  salida solo se guarda si sus primeros bytes son de WAV, FLAC o MP3. El volumen objetivo solo se
  envía si `MUSICAI_MASTER_LUFS_PARAM` dice cómo se llama ese parámetro en el workflow.
- Si el Worker no puede consultar a Music AI en un `GET` (red, 5xx), responde 200 `STARTED` y el
  siguiente `GET` reintenta: el trabajo ya está pagado y no se da por fallido. Solo un 404 del
  proveedor lo pasa a `FAILED`.
- `generate` y `assist` esperan al proveedor dentro del `POST` y dejan el trabajo terminado; el
  primer `GET` ya devuelve el resultado. La espera va también a `ctx.waitUntil`, para que termine
  y guarde el resultado si el cliente corta (no verificado cuánto la sostiene Cloudflare). Con
  `?job_id=job_<id>` el `POST` es idempotente: repetirlo con el mismo id no lanza ni cobra otro
  trabajo. Límite conocido: la respuesta de Lyria llega en base64
  dentro de un JSON y se decodifica en memoria. Si la petición empieza a cortarse por tiempo o
  por CPU, el camino es Cloudflare Queues (explicado en `src/providers/lyria.ts`); no está
  agregado.
- `generate` con `lyria` pasa por URiT IA (`POST {URIT_AI_URL}/v1/music`, sección 4A de
  `URiT/workers/ai/CONTRACT_V1.md`) con el mismo `URIT_AI_TOKEN` y las cabeceras del texto: el
  Worker **ya no usa `GEMINI_API_KEY`** para generar. Cuerpo `{task: "studio_generate", model,
  prompt, time_budget_ms: 85000}`; espera propia de 90 s. Hasta 30 s pedidos va a
  `lyria-3-clip-preview`, que **siempre entrega 30 s** (un pedido de 5 a 29 s devuelve 30 s); más
  largo, a `lyria-3.5`. Lyria no recibe duración, BPM ni tonalidad como parámetros: el Worker los
  escribe en el texto del pedido (la duración, solo en el modelo de canciones, como indicación).
  Errores: 401/403/503 y 422 `model_not_allowed` son 503 `provider_unavailable`; 429, 502
  `blocked` y 502 `provider_error` con `NO_AUDIO` dejan el trabajo `FAILED` con el motivo y
  costo 0; 504 (o la espera de 90 s) deja `FAILED` y el costo anotado, porque URiT lo cuenta
  como cobrado; el resto es 502 `provider_failed` sin costo. STUDIO_V2.md 4.6.
- `compose`, `chat` y `generate` ajustan el gasto anotado al `usage.estimated_usd` que devuelve
  URiT IA. Las llamadas a URiT tienen una espera propia (75 s el texto, 90 s la música) y las de
  Gemini directo, 75 s: un proveedor colgado no deja el `POST` abierto sin fin.
- `assist` pide al modelo un JSON con el esquema de sugerencias y el Worker **descarta** las que
  no cumplen el contrato (pista inexistente, parámetro fuera de rango, limitador en una pista).
- `compose`, `analyze` y `chat` (STUDIO_V2.md 4; lógica en `src/studioV2.ts`):
  - `compose` y `chat` usan el mismo proveedor que `assist` (`ASSIST_PROVIDER`; no hay variable
    aparte): `urit` por defecto (URiT IA como consumidor `bandait`, sin fijar modelo; `task`
    `studio_compose` y `studio_chat`) o `gemini` directo. Con `anthropic` responden 503.
  - `compose` pide JSON con el esquema del contrato y **normaliza** las notas: descarta las
    inválidas o fuera del clip, en batería las que no son percusión General MIDI, redondea a 6
    decimales, acota al final del clip, resuelve solapes del mismo tono y se queda con 1024. Sin
    notas útiles el trabajo queda `FAILED` (el costo queda: el modelo respondió).
  - `chat` traduce la conversación al formato de URiT (antepone el estado del Estudio al último
    mensaje del usuario), manda la lista cerrada de herramientas de
    `bandait-protocol/fixtures/studio_chat_tools_v2.json` (se importa tal cual; sin `command_id`)
    y `tool_mode`. Devuelve `reply` y **todas** las llamadas, con `id` `call_1`, `call_2`... y su
    `signature`: el Worker no descarta las de nombre desconocido ni las de argumentos inválidos,
    porque quitarlas rompería la cadena de firmas de Gemini 3; el Hub las responde `failed`. Más
    de 16 llamadas, o ni texto ni llamadas, es `FAILED`. Cuerpo de hasta 192 KB (los demás
    trabajos, 64 KB).
  - `analyze` sube el audio a Music AI con `MUSICAI_ANALYZE_WORKFLOW` o, si está vacío,
    `MUSICAI_WORKFLOW` (el mismo del análisis de canciones; por defecto
    `stems-workflow-releven-bandait`, que **también separa stems**: por eso la tarifa por defecto
    de `analyze` es 0.80 por minuto, la de `separate` más el análisis). Cuando termina, el `GET`
    lee las salidas JSON (las de audio no se leen ni se copian) y arma `bpm`, `key`,
    `beats_per_bar` (4: Music AI no lo informa), `downbeat_s`, `markers` y `chords`, en segundos
    dentro del audio, con las mismas reglas de `src/analysis.ts`. Si una salida no se puede
    descargar en ese momento (red o 5xx), responde `STARTED` sin cerrar el trabajo y el siguiente
    `GET` reintenta; un análisis ilegible deja el trabajo `FAILED`. No hay `IMPORTING`.

Cada proveedor es un archivo en `src/providers/`: `lyria.ts` (Lyria por URiT IA), `suno.ts`, `urit.ts` (asistente,
`compose` y `chat` por URiT IA, por defecto), `gemini.ts` (lo mismo con la clave de Gemini
directa) y `anthropic.ts` (solo `assist`). Lo que no se pudo confirmar en documentación oficial
está marcado ahí con `NO VERIFICADO`.

**Control de gasto.** Antes de llamar al proveedor, el Worker guarda el trabajo en `STARTED` y
anota su costo estimado en `studio/_usage/AAAA-MM.json` de la banda (mes en UTC) y en el
contador global `studio/_usage/AAAA-MM.json` de la raíz del bucket; si el proveedor rechaza la
petición, lo revierte. Si el gasto del mes más el costo estimado pasa de
`STUDIO_MONTHLY_BUDGET_USD` (banda) o de `STUDIO_GLOBAL_MONTHLY_BUDGET_USD` (todo el Worker), el
`POST` responde 429 `quota_exceeded` sin llamar al proveedor. Sin esas variables no hay tope; con
un valor que no es un número, el tope es 0 (bloquea todo, para que un error de tipeo no deje el
gasto libre). Los contadores se actualizan con escritura condicional y reintento: dos trabajos a
la vez no pierden entradas ni pasan juntos el tope. `master`, `separate` y `analyze` se cobran por la
duración real del audio en R2 (cabecera WAV o FLAC; en MP3 un piso por tamaño), o por la
declarada si es mayor. Con `STUDIO_SPENDER_UIDS` solo los uuid listados pueden gastar (403
`not_a_spender` para el resto, también en `POST .../analysis`): el tope por banda no limita el
total, porque cada cuenta tiene su workspace `me` y puede crear bandas.
Las tarifas son estimaciones y **no están confirmadas** con las
páginas de precios: se ajustan con `STUDIO_RATE_MASTER_USD_PER_MIN` (0.20),
`STUDIO_RATE_SEPARATE_USD_PER_MIN` (0.50), `STUDIO_RATE_LYRIA_CLIP_USD` (0.04 por clip de 30 s),
`STUDIO_RATE_LYRIA_SONG_USD` (0.08 por canción de `lyria-3.5`; estas dos sí son los precios de
URiT IA, CONTRACT_V1.md 4A), `STUDIO_RATE_ASSIST_USD` (0.05 por consulta),
`STUDIO_RATE_COMPOSE_USD` (0.05 por consulta), `STUDIO_RATE_ANALYZE_USD_PER_MIN` (0.80: el
workflow por defecto separa y analiza; 0.30 no cubría la separación) y `STUDIO_RATE_CHAT_USD`
(0.03 por vuelta) más `STUDIO_RATE_CHAT_USD_PER_32KB` (0.015 por cada 32 KB completos de
conversación). `STUDIO_RATE_LYRIA_USD_PER_30S` ya no se lee.

Errores propios del Estudio: 400 `bad_session_id` / `bad_session` / `bad_asset` / `bad_job` /
`empty_body` / `incomplete_upload`, 403 `not_a_spender`, 404 `no_session` / `no_asset` /
`no_job`, 409 `missing_asset` / `asset_exists` / `too_many_assets` (320 audios por sesión), 411
`length_required`, 412 `session_conflict`, 413 `session_too_large` / `file_too_large`, 415
`not_audio`, 416 `bad_range`, 428 `precondition_required`, 429 `quota_exceeded`, 501
`provider_unavailable` (`suno`), 502 `provider_failed` (solo al lanzar) / `asset_copy_failed`,
503 `provider_unavailable` (falta el secreto o el workflow) / `usage_busy`.

Pendiente conocido: no hay cuota de almacenamiento por banda ni limpieza de audios de sesiones
sin documento; `If-None-Match: *` en `onlyIf` de R2 está sin verificar contra R2 real (si R2 lo
ignorara, crear una sesión o un audio queda protegido solo por el `head` previo).

## Variables y secretos

Variables (en `wrangler.jsonc`, públicas): `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`ALLOWED_ORIGINS`, `MAX_FILE_MB`, `MUSICAI_WORKFLOW`, `MUSICAI_SPLIT_WORKFLOW`, `MUSICAI_ANALYZE_WORKFLOW` (opcional),
`MUSICAI_MASTER_WORKFLOW`, `MUSICAI_MASTER_LUFS_PARAM`, `ASSIST_PROVIDER` (`urit`; también `gemini` o `anthropic`), `URIT_AI_URL` (`https://ai.urit.services`), `URIT_AI_CONSUMER` (`bandait`),
`ASSIST_MODEL` (vacío: con `urit` manda la cadena de modelos de URiT; con `gemini`, `gemini-flash-latest`; con `anthropic`, `claude-sonnet-5-5`), `STUDIO_MONTHLY_BUDGET_USD`,
`STUDIO_GLOBAL_MONTHLY_BUDGET_USD`, `STUDIO_SPENDER_UIDS` y, opcionales,
`LYRIA_CLIP_MODEL`, `LYRIA_SONG_MODEL` y las tarifas `STUDIO_RATE_*`.

Secretos (nunca en el repositorio; `npx wrangler secret put <NOMBRE>`). El navegador no recibe
ninguno:

| Secreto | Para qué | Sin él |
|---|---|---|
| `MUSICAI_API_KEY` | análisis de canciones; trabajos `master`, `separate` y `analyze` | 503 `analysis_unavailable` / `provider_unavailable` |
| `URIT_AI_TOKEN` | `generate` con Lyria, y `assist`, `compose` y `chat` con `ASSIST_PROVIDER` `urit` (token del consumidor `bandait` en URiT IA; ClipVault `urit-ai-credentials/bandait_token`) | 503 `provider_unavailable` |
| `GEMINI_API_KEY` | opcional: solo `assist`, `compose` y `chat` con `ASSIST_PROVIDER` `gemini` (alternativa directa). Lyria ya no la usa | 503 `provider_unavailable` con `gemini` |
| `ASSIST_API_KEY` | opcional: `assist`, `compose` y `chat` con `gemini` (si falta, usa `GEMINI_API_KEY`), o `assist` con `anthropic` (clave de Anthropic) | 503 `provider_unavailable` |
| `SUNO_API_KEY` | futuro: hoy `suno` responde 501 aunque exista | no aplica |

No hay `service_role` de Supabase en ningún lado: `SUPABASE_ANON_KEY` es la clave publicable.

## Desarrollo y despliegue

```
npm install
npm test            # node --experimental-strip-types; R2, Supabase, Music AI, Lyria, URiT IA y Gemini simulados
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir dist
```

Despliegue: con el token de Cloudflare de ClipVault (`releven-deploy-cloudflare-api-key`) en
`CLOUDFLARE_API_TOKEN`, `npx wrangler deploy`. El bucket se creó una vez con
`npx wrangler r2 bucket create bandait-stems`. Los secretos del Worker (sección "Variables y
secretos") se cargan aparte con `npx wrangler secret put` y no se despliegan con el código.
