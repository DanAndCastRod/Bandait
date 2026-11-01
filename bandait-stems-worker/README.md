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
líder (Python) no necesita CORS.

## Desarrollo y despliegue

```
npm install
npm test            # node --experimental-strip-types, R2 y Supabase simulados
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir dist
```

Despliegue: con el token de Cloudflare de ClipVault (`releven-deploy-cloudflare-api-key`) en
`CLOUDFLARE_API_TOKEN`, `npx wrangler deploy`. El bucket se creó una vez con
`npx wrangler r2 bucket create bandait-stems`. No hay secretos en el Worker.
