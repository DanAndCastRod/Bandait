# Estudio Bandait: plan de implementación

**Fecha:** 2026-11-18
**Estado:** propuesta para revisión de Daniel Castañeda. Nada de este plan está implementado.
**Alcance:** grabar, editar, mezclar, masterizar y generar audio dentro del Hub, con IA de Music.AI y
Lyria, y un adaptador listo para Suno cuando tenga API oficial.

---

## 1. Decisión de arquitectura

El Estudio es una pestaña nueva del Hub (`bandait-leader-web`), en el navegador. La nube es el
Worker `bandait-stems`, que ya existe.

| Alternativa | Veredicto | Motivo |
|---|---|---|
| Estudio en el Hub (navegador) | **Elegida** | No instala nada en el equipo. La UMC202HD es USB estándar y Chrome la ve sin driver. El Hub ya tiene reproductor multipista, IndexedDB, R2 y Music.AI. Moises Studio y Suno Studio son DAWs de navegador. |
| Estudio en el leader (PySide6 + ASIO) | Descartada para la interfaz | Mejor latencia, pero una línea de tiempo en Qt cuesta varias veces más y mete código de estudio en el proceso del escenario. Queda como motor de grabación opcional (fase 6). |
| Exportar a REAPER | Descartada | No se puede instalar en este equipo (decisión de Daniel Castañeda, 2026-11-18). |
| Wrappers no oficiales de Suno | Descartada | Violan sus términos y pueden caerse sin aviso. |

Reglas que no se negocian:

1. **El escenario no se toca.** Ni el leader, ni el follower, ni `CONTRACT_V3.md` cambian en las fases
   0 a 5. El Estudio nunca corre durante un show.
2. **Edición no destructiva.** Un audio grabado o importado es un archivo inmutable. Editar cambia
   solo el documento de sesión (JSON).
3. **Un solo grafo de audio.** La misma función construye el grafo para escuchar (`AudioContext`) y
   para exportar (`OfflineAudioContext`): lo que suena es lo que se exporta.
4. **Las claves viven en el Worker.** El navegador nunca ve una clave de Music.AI, Google o Suno.
5. **Sin re-render en el camino del audio.** Cabezal, medidores y formas de onda se pintan con
   refs, canvas y rAF, como ya hace `StemStudio`.
6. **Con un apagado de emergencia.** El Estudio nació oculto tras un interruptor. Desde el
   2026-11-19 está encendido por defecto (decisión de Daniel Castañeda: nadie más usa la app
   todavía). Se apaga para todos con `VITE_BANDAIT_STUDIO=0` en la compilación, o en un navegador
   con `localStorage['bandait_studio']='0'`.

## 2. Lo que ya existe y se reutiliza

| Pieza | Archivo | Uso en el Estudio |
|---|---|---|
| Programación alineada a la muestra en el reloj del `AudioContext` | `bandait-leader-web/src/services/stemPlayer.ts` | Patrón del motor nuevo. `StemPlayer` no se modifica: el prompter de ENSAYO depende de él (`components/studioApi.ts`). |
| Compases, secciones, dB | `services/stemTiming.ts` | Regla de la línea de tiempo, ajuste a compás, repetición por sección. |
| WAV de 16 bits y control de pico | `services/wav.ts` | Se amplía con 24 bits. |
| IndexedDB de stems | `services/stemStore.ts` | Patrón para la base nueva `bandait_studio`. |
| Cliente del Worker (token, errores) | `services/stemCloud.ts` | `authHeaders`, `send`, `failFrom` se usan tal cual. |
| Publicar stems de una canción | `uploadStems` en `services/stemCloud.ts` | "Publicar en la canción": el resultado del Estudio llega al leader por la ruta de hoy. |
| Sondeo de trabajos de Music.AI | `services/stemAnalysis.ts`, `bandait-stems-worker/src/index.ts` (`musicAi`, `copyNextStem`) | Mismo patrón para masterizar y separar. |
| Autorización por rol | `authorize()` en `bandait-stems-worker/src/index.ts:90` | Leer: integrante. Escribir y gastar créditos: Owner y MusicDirector. |
| Sistema de diseño | `docs/design_system/bandait_pro_redesign_studio.html` | Identidad del Estudio. Negro OLED, sin emojis, iconos de `lucide-react`. |

El nombre `StemStudio` ya está tomado por el reproductor de stems. El módulo nuevo se llama
**Estudio** en la interfaz y `studio/` en el código, con el prefijo `Studio*` para sus componentes;
`StemStudio` conserva su nombre.

## 3. Arquitectura

```
+-------------------------- Navegador (Hub, pestaña ESTUDIO) --------------------------+
|  UMC202HD --getUserMedia--> AudioWorklet grabador --> Worker OPFS (WAV 24 bits)       |
|                                                                                      |
|  StudioEngine (sin React)                                                            |
|    clips -> ganancia/fades -> inserts (EQ, compresor) -> paneo -> fader --+          |
|    envío a reverb ---------------------------------------------------------+-> master |
|    master: EQ -> compresor -> limitador -> medidor LUFS -> salida                    |
|    buildGraph(ctx, sesion): el mismo para AudioContext y OfflineAudioContext         |
|                                                                                      |
|  IndexedDB bandait_studio: sesiones, picos de forma de onda                          |
|  OPFS: audio (tomas, importados, generados, mezclas)                                 |
+------------------------------------+-------------------------------------------------+
                                     | HTTPS + JWT de Supabase
                                     v
+--------------------------- Worker bandait-stems (Cloudflare) -------------------------+
|  /v1/bands/{band}/studio/...   sesiones, audios, trabajos                            |
|  R2: bucket bandait-stems                                                            |
|  Secretos: MUSICAI_API_KEY (existe), GEMINI_API_KEY, ASSIST_API_KEY, SUNO_API_KEY    |
+----------+----------------------+----------------------+-----------------------------+
           v                      v                      v
       Music.AI               Lyria (Google)        Suno (cuando haya API)
   separar, masterizar        generar audio         generar audio
```

### 3.1. Módulos nuevos en el Hub

```
bandait-leader-web/src/
  views/StudioHubView.tsx              pestaña; lista de sesiones y sesión abierta
  components/studio/
    StudioTransport.tsx                reproducir, grabar, clic, conteo, tempo, posición
    StudioTimeline.tsx                 regla de compases, pistas, clips (canvas), cabezal
    StudioTrackHeader.tsx              armar, mute, solo, fader, paneo, entrada
    StudioMixer.tsx                    faders, medidores, inserts, envío a reverb, master
    StudioInspector.tsx                clip seleccionado, parámetros de efectos
    StudioDevicePanel.tsx              entrada, calibración de latencia, aviso de monitoreo
    StudioJobsPanel.tsx                masterizar, separar, generar, asistente
  services/studio/
    session.ts                         tipos, validación, migración del documento
    sessionOps.ts                      operaciones puras: mover, recortar, dividir, fades, tomas
    history.ts                         deshacer y rehacer
    engine.ts                          transporte y programación de clips
    graph.ts                           buildGraph(ctx, sesion)
    fx.ts                              EQ, compresor, reverb, limitador
    recorder.ts                        getUserMedia, worklet, alineación de la toma
    recorder.worklet.ts                captura de bloques Float32
    opfsWriter.worker.ts               escritura de WAV en OPFS
    latency.ts                         calibración por correlación cruzada
    click.ts                           metrónomo del Estudio
    loudness.ts                        LUFS integrado y pico real (BS.1770)
    peaks.ts                           picos para dibujar formas de onda
    bounce.ts                          mezcla final sin tiempo real, WAV 16 o 24 bits
    studioStore.ts                     IndexedDB y OPFS
    studioCloud.ts                     cliente de las rutas /studio del Worker
    jobs.ts                            lanzar y sondear trabajos de IA
```

Los módulos de `services/studio/` que son lógica pura (`session`, `sessionOps`, `history`,
`latency`, `loudness`, `peaks`, parte de `bounce`) no importan DOM ni `import.meta.env`, igual que
`stemCloud.ts`, para probarse con `node --experimental-strip-types`.

## 4. Documento de sesión

Contrato nuevo: `bandait-protocol/STUDIO_V1.md`, con su ejemplo canónico en
`bandait-protocol/fixtures/studio_session.json`. Se escribe antes que el código (fase 1). Claves en
snake_case en el cable; el Hub traduce en `session.ts`.

```json
{
  "version": 1,
  "id": "ses_9f2c",
  "title": "Hoy - maqueta",
  "song_id": "sng_41",
  "bpm": 128.0,
  "beats_per_bar": 4,
  "key": "C#m",
  "sample_rate": 48000,
  "updated_at": "2026-11-18T22:10:00Z",
  "updated_by": "<uuid del usuario>",
  "assets": [
    {"id": "ast_a1", "file": "ast_a1.wav", "kind": "recording", "channels": 1,
     "sample_rate": 48000, "duration_s": 212.4, "size": 30585644,
     "source": null}
  ],
  "tracks": [
    {"id": "trk_1", "name": "Voz", "role": "vocals", "volume_db": 0.0, "pan": 0.0,
     "mute": false, "solo": false, "reverb_send_db": -18.0,
     "fx": [{"type": "eq", "bypass": false, "params": {"hpf_hz": 90, "low_db": 0,
             "mid_hz": 2500, "mid_db": 2, "mid_q": 1.0, "high_db": 1.5}}],
     "clips": [{"id": "clp_1", "asset_id": "ast_a1", "start_s": 7.5, "offset_s": 0.0,
                "length_s": 30.0, "gain_db": 0.0, "fade_in_s": 0.01, "fade_out_s": 0.05,
                "take_group": "tk_1", "active": true}]}
  ],
  "master": {"volume_db": 0.0, "fx": [{"type": "limiter", "bypass": false,
             "params": {"ceiling_db": -1.0}}]}
}
```

- `kind` de un audio: `recording`, `import`, `stem`, `generated`, `bounce`, `master`.
- `source` de un audio generado o procesado: `{"provider", "job_id", "prompt"?}`.
- `role` usa los roles de `bandait-protocol/fixtures/stem_names.json`.
- `start_s` es la posición del clip en la sesión; `offset_s` y `length_s` son la ventana dentro del
  audio. Recortar y dividir solo cambian esos tres números.
- Las tomas de un mismo pasaje comparten `take_group`; suena la que tiene `active: true`.
- Límites: 16 pistas, 20 minutos por sesión, 256 KB de documento, 200 MB por audio.

`song_id` es opcional. Con canción, la sesión hereda BPM, compás, tonalidad y secciones del
workspace; sin canción, es una maqueta libre.

## 5. Grabación con la UMC202HD

### 5.0. Entrada por defecto (decisión de Daniel Castañeda, 2026-11-19)

El Estudio no exige la UMC202HD. Sin elegir nada, graba con la entrada por defecto del sistema: el
micrófono y el controlador de audio propios del equipo. La interfaz externa es una opción más de
la lista, no un requisito.

- Al abrir el Estudio por primera vez se usa la entrada por defecto del sistema (`deviceId:
  'default'`). La elección del usuario se recuerda por navegador; si esa entrada ya no está
  conectada, se vuelve a la de por defecto con un aviso, sin bloquear la grabación.
- El número de canales se adapta a la entrada: se pide `channelCount: { ideal: 2 }` y se arma lo
  que el navegador entregue. Un micrófono integrado suele dar un solo canal: una pista mono.
- El procesamiento de voz se pide apagado también en el micrófono integrado. Si el navegador o el
  controlador no lo respetan, se graba igual y se muestra el aviso.
- Con micrófono integrado no hay monitoreo directo ni cable de loopback: la calibración de
  latencia es acústica (el clic suena por la salida y lo recoge el micrófono) y se recomienda
  grabar con audífonos para que la reproducción no se cuele en la toma.
- La calibración se guarda por pareja de entrada y salida, no solo por interfaz.
- La prueba de la fase 0 se puede correr con cualquier entrada. El criterio de "dos canales
  independientes" aplica solo a entradas de dos canales; con una entrada mono el veredicto se da
  sobre bloques perdidos y variación de latencia.

### 5.1. Captura

- `getUserMedia` con `deviceId` exacto, `channelCount: 2`, y `echoCancellation`,
  `noiseSuppression` y `autoGainControl` en `false`. Tras abrir, se lee `track.getSettings()` y se
  avisa si el navegador no respetó algún valor.
- La señal pasa a un `AudioWorkletNode` que entrega bloques Float32 por canal. No se usa
  `MediaRecorder`: comprime y no da posición exacta.
- Un Web Worker escribe cada canal armado en un WAV de 24 bits en OPFS, a medida que llega. Si la
  pestaña se cierra, al volver se ofrece recuperar la toma.
- Entrada 1 y entrada 2 son pistas mono independientes, o un par estéreo si así se arma la pista.
- La frecuencia de la sesión es la del `AudioContext` al crearla. Un audio importado a otra
  frecuencia se convierte una vez al importar.
- Navegadores admitidos para grabar: Chrome y Edge de escritorio. En los demás, y en móvil, el
  Estudio abre en modo de solo reproducción y mezcla.

### 5.2. Alineación de la toma

El worklet anota el tiempo del `AudioContext` del primer bloque capturado. La posición de la toma es:

```
start_s = posicion_al_arrancar + (t_primer_bloque - t_arranque_reproduccion) - latencia_ida_y_vuelta
```

`latencia_ida_y_vuelta` sale de una calibración que se hace una vez por interfaz y frecuencia: el
Estudio emite un clic, lo graba y mide el retardo por correlación cruzada (`latency.ts`). La
UMC202HD no tiene loopback interno, así que la calibración pide un cable de Salida 1 a Entrada 1, o
en su defecto el audífono pegado al micrófono. Sin calibración se usa la estimación del navegador
(`outputLatency + baseLatency` más la latencia del track) y se muestra el aviso "sin calibrar". Hay
además un ajuste manual en milisegundos por sesión.

### 5.3. Monitoreo y clic

- El músico se escucha con la perilla MIX de la interfaz (monitoreo directo, sin retardo). El
  monitoreo por software existe, apagado por defecto y con aviso de retardo.
- El clic del Estudio se programa en el `AudioContext` con anticipación, igual que el del follower,
  desde el BPM y el compás de la sesión. Tiene conteo previo configurable y volumen propio, y no
  entra en la mezcla final.
- Modos: grabación libre, entrada y salida por región (pinchazo), y repetición de una sección que
  apila tomas en el mismo `take_group`.

## 6. Edición, mezcla y exportación

**Edición (fase 2).** Mover, recortar por los bordes, dividir en el cabezal, duplicar, borrar,
fades con manijas, ganancia de clip, elegir toma activa, ajuste a compás o a tiempo, deshacer y
rehacer (100 pasos). Atajos: espacio, R, S, supr, Ctrl+Z, Ctrl+Y.

**Mezcla (fase 2).** Por pista: fader, paneo, mute, solo, EQ de cuatro bandas (`BiquadFilterNode`),
compresor (`DynamicsCompressorNode`) y envío a una reverb compartida (`ConvolverNode` con respuesta
generada). En el master: EQ, compresor, limitador con anticipación (worklet propio) y medidor de
LUFS integrado y pico real.

**Exportación (fase 2).** `OfflineAudioContext` con `buildGraph`. Salidas: mezcla estéreo en WAV de
16 o 24 bits, pistas por separado, y "Publicar en la canción", que sube el resultado como stems de
la canción con `uploadStems` para que el leader lo reciba como hoy.

**Fuera del alcance de este plan:** estirar tiempo y cambiar tono, automatización por curvas,
comping por barrido, plugins de terceros, video. Se reevalúan al cerrar la fase 5.

## 7. Rutas nuevas del Worker

Se agregan a la API v1 del Worker y se documentan en `bandait-stems-worker/README.md`. Mismas
reglas de autenticación de hoy. `{session}` y `{asset}` siguen `[A-Za-z0-9_-]{1,80}`; un audio
lleva extensión `wav`, `flac` o `mp3`. En R2 viven bajo el prefijo de la banda, en `studio/`.

| Método y ruta | Quién | Respuesta |
|---|---|---|
| `GET /v1/bands/{band}/studio` | integrante | `{"sessions":[{"id","title","song_id","updated_at"}]}` |
| `GET /v1/bands/{band}/studio/{session}/session` | integrante | documento, con `ETag`; 404 `no_session` |
| `PUT /v1/bands/{band}/studio/{session}/session` | Owner, MusicDirector | documento guardado. Pide `If-Match` (o `If-None-Match: *` al crear); si no coincide, 412 `session_conflict`. Cada audio listado debe existir: si no, 409 `missing_asset` |
| `DELETE /v1/bands/{band}/studio/{session}` | Owner, MusicDirector | `{"deleted": n}` |
| `PUT /v1/bands/{band}/studio/{session}/assets/{asset}` | Owner, MusicDirector | `{"file","size"}`. Un audio es inmutable: repetir con el mismo tamaño responde 200; con otro, 409 `asset_exists` |
| `GET /v1/bands/{band}/studio/{session}/assets/{asset}` | integrante | bytes, con soporte de `Range` |
| `POST /v1/bands/{band}/studio/{session}/jobs` | Owner, MusicDirector | 202 `{"job_id","status":"STARTED","kind"}` |
| `GET /v1/bands/{band}/studio/{session}/jobs/{job}` | integrante | `STARTED`, `IMPORTING` (`done`, `total`), `SUCCEEDED` (`assets` o `suggestions`), `FAILED` (`error`) |

Cuerpo de `POST .../jobs`:

| `kind` | Campos | Proveedor | Resultado |
|---|---|---|---|
| `master` | `asset_id` (una mezcla ya subida), `target_lufs` | Music.AI, workflow `MUSICAI_MASTER_WORKFLOW` | un audio `master` |
| `separate` | `asset_id` | Music.AI, `MUSICAI_SPLIT_WORKFLOW` (existe) | un audio `stem` por instrumento |
| `generate` | `provider` (`lyria`, `suno`), `prompt`, `duration_s`, `bpm`, `key`, `instrumental` | Lyria; Suno responde 501 `provider_unavailable` hasta tener acceso | un audio `generated` |
| `assist` | `metrics` (por pista: LUFS, pico, energía por banda, rol) | modelo de lenguaje | `suggestions`: cambios propuestos de fader, EQ y compresor |

Un trabajo terminado copia sus audios a `assets/` con el patrón de `copyNextStem` (un archivo por
`GET`, idempotente). El trabajo nunca modifica la sesión: el Hub agrega los audios como pistas
nuevas cuando el usuario acepta.

**Control de gasto.** Solo Owner y MusicDirector lanzan trabajos. El Worker lleva un contador
mensual por banda en R2 (`studio/_usage/AAAA-MM.json`) con proveedor, segundos y costo estimado, y
corta con 429 `quota_exceeded` al pasar el tope de `STUDIO_MONTHLY_BUDGET_USD`. El panel de
trabajos muestra el costo estimado antes de confirmar.

**Variables nuevas del Worker:** `MUSICAI_MASTER_WORKFLOW`, `STUDIO_MONTHLY_BUDGET_USD`, y los
secretos `GEMINI_API_KEY`, `ASSIST_API_KEY` y, más adelante, `SUNO_API_KEY`. Sin el secreto de un
proveedor, su trabajo responde 503 `provider_unavailable` y el botón sale deshabilitado.

Corrección pendiente detectada al leer: el README del Worker dice "No hay secretos en el Worker",
pero `wrangler.jsonc` ya declara `MUSICAI_API_KEY` como secreto. Se corrige en la fase 1.

## 8. Fases

Las estimaciones son días de trabajo de agente con revisión de Daniel Castañeda, y son
aproximadas: la fase 0 existe para ajustarlas.

### Fase 0. Prueba con la interfaz (1 día)

Una página de prueba bajo el interruptor, sin interfaz definitiva. Responde lo que hoy es
suposición:

- Chrome entrega las dos entradas de la UMC202HD como canales separados.
- El procesamiento de voz queda realmente apagado.
- Cuántos bloques se pierden en 10 minutos de grabación.
- Cuánto mide la latencia de ida y vuelta y cuánto varía entre tres mediciones.

**Criterio de salida:** dos canales independientes, cero bloques perdidos y variación de latencia
menor a 2 ms. Si falla, la grabación pasa al leader (fase 6) y el Estudio del navegador se queda
con edición, mezcla e IA. Requiere a Daniel Castañeda con la interfaz conectada.

### Fase 1. Grabar y reproducir (5 a 7 días)

- `STUDIO_V1.md` y su fixture; `session.ts` con validación.
- Rutas de sesión y de audios en el Worker, con pruebas.
- Pestaña ESTUDIO, lista de sesiones, crear desde una canción o libre.
- Motor, clic, grabación de dos entradas, calibración, formas de onda, importar audio y stems
  existentes de la canción.
- Guardado local continuo y subida a la nube al pulsar GUARDAR.

**Aceptación:** grabar voz y guitarra sobre los stems de una canción del setlist, cerrar el
navegador, abrir en otro equipo y oír las tomas alineadas con el clic.

### Fase 2. Editar, mezclar y exportar (8 a 10 días)

Todo lo de la sección 6.

**Aceptación:** la mezcla exportada y la que suena en el Estudio dan el mismo LUFS integrado con
diferencia menor a 0,1. "Publicar en la canción" deja los stems disponibles en el leader.

### Fase 3. IA de Music.AI (3 a 4 días)

Trabajos `master` y `separate`, panel de trabajos, contador de gasto. Normalización local a un
LUFS objetivo como respaldo sin conexión y sin costo.

**Aceptación:** masterizar una mezcla de 4 minutos y compararla con el original al mismo volumen
con un botón A/B.

### Fase 4. Generación (3 a 4 días)

Trabajo `generate` con Lyria, usando el BPM y la tonalidad de la sesión en el prompt. El audio
generado entra como pista y queda marcado como generado por IA en la sesión y en la interfaz.
Adaptador de Suno con respuesta 501.

**Punto a resolver en la fase:** si la llamada a Lyria tarda más de lo que el Worker puede
sostener en una petición, el trabajo pasa a Cloudflare Queues.

**Aceptación:** pedir "pad de 16 compases" en una sesión a 128 BPM en Do sostenido menor y
recibirlo como pista alineada al compás 1.

### Fase 5. Asistente, MIDI y colaboración (por definir)

- Asistente de mezcla: mide las pistas, propone cambios y el usuario los acepta uno por uno. Cada
  propuesta se aplica como un paso de deshacer.
- MIDI y sintetizador.
- Colaboración: presencia y bloqueo de sesión por Supabase Realtime. Sin edición simultánea.

Se planifica en detalle al cerrar la fase 4.

### Fase 6. Opcional: el leader como grabadora ASIO

`recorder.py` ya graba un WAV por canal. El leader subiría esas tomas como audios de una sesión
del Estudio. Solo se hace si la fase 0 falla o si se quiere grabar a la banda completa con una
interfaz de más entradas.

## 9. Verificación

| Capa | Cómo | Dónde |
|---|---|---|
| Lógica pura | `scripts/verify-studio-logic.ts`: esquema de sesión, operaciones de edición, cálculo de alineación, LUFS contra señales de referencia, picos, WAV de 24 bits | se suma a `npm run verify:logic` |
| Worker | `npm test` con R2, Supabase, Music.AI y Lyria simulados: permisos, `If-Match`, audios inmutables, trabajos, tope de gasto | `bandait-stems-worker/tests/` |
| Navegador | Playwright con micrófono simulado de Chrome (`--use-fake-device-for-media-stream`, `--use-file-for-fake-audio-capture`): grabar, comprobar alineación, editar, exportar y medir el resultado | `e2e/studio.leader-web.spec.ts` |
| Interfaz real | Lista manual con la UMC202HD al cerrar las fases 0, 1 y 2 | anotada en `DEVLOG.md` |
| Publicación | `npm run build:landing` y verificación de que el Estudio no aparece sin el interruptor | `e2e/` |

Ninguna prueba toca datos reales: sesiones y audios de prueba usan una banda y un bucket simulados.

## 10. Costos

Cifras de referencia sin confirmar con las páginas de precios oficiales. Se confirman antes de la
fase 3 y de la fase 4.

| Concepto | Referencia | Fuente |
|---|---|---|
| Masterizar en Music.AI | cerca de USD 0,20 por minuto | agregador de terceros |
| Separar stems en Music.AI | cerca de USD 0,07 por minuto y stem | agregador de terceros |
| Lyria 2 | cerca de USD 0,06 por 30 segundos | documentación de Google, enero de 2026 |
| Lyria 3 y 3 Pro | en vista previa, precio sujeto a cambio | blog de Google Cloud |
| Almacenamiento | una pista mono de 4 minutos a 48 kHz y 24 bits pesa unos 35 MB; una sesión de 8 pistas, unos 280 MB | cálculo propio |

El almacenamiento crece rápido. Pendiente de decisión: comprimir a FLAC antes de subir (cerca de
la mitad del tamaño, a cambio de una dependencia WebAssembly).

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| Chrome no entrega dos canales limpios de la UMC202HD | Fase 0 lo prueba antes de construir. Salida: fase 6. |
| Latencia variable entre sesiones del navegador | Calibración por interfaz, aviso "sin calibrar" y ajuste manual. |
| Memoria: 16 pistas decodificadas de 20 minutos no caben | Límites de la sección 4, aviso al acercarse, y decodificación por tramos si la fase 2 lo exige. |
| Gasto de IA sin control | Solo editores, tope mensual por banda, costo visible antes de confirmar. |
| Music.AI no ofrece el módulo de mastering en el plan contratado | Normalización local desde la fase 3; el trabajo `master` queda deshabilitado sin workflow. |
| Lyria cambia de precio o de API al salir de vista previa | Adaptador por proveedor: el cambio queda en un archivo del Worker. |
| El Estudio compite por atención con la estabilidad del escenario | Regla 1 de la sección 1 y el interruptor. |
| Audio generado por IA y derechos de uso | El audio queda marcado en la sesión. Revisar los términos de cada proveedor antes de publicar música con él. |

## 12. Lo que Daniel Castañeda debe decidir o configurar

1. **Fase 0:** una sesión con la UMC202HD conectada y un cable de Salida 1 a Entrada 1.
2. **Music.AI:** crear en su panel un workflow de mastering y dar su nombre para
   `MUSICAI_MASTER_WORKFLOW`. Confirmar que el plan contratado incluye ese módulo.
3. **Lyria:** indicar si la clave disponible es de la Gemini API o de Vertex AI. El plan asume
   Gemini API (una clave simple); Vertex pide una cuenta de servicio y más trabajo en el Worker.
4. **Asistente de mezcla:** elegir proveedor del modelo de lenguaje. Recomendación: Claude; la
   alternativa es reutilizar la clave de Gemini para no abrir otra cuenta.
5. **Suno:** llenar el formulario del programa de socios de su API.
6. **Tope mensual de gasto** por banda para `STUDIO_MONTHLY_BUDGET_USD`.
7. **FLAC o WAV** para lo que se sube a R2 (sección 10).

## 13. Fuentes externas consultadas el 2026-11-18

- Music.AI: https://music.ai/platform/ y https://music.ai/docs/
- Masterchannel en Music.AI: https://www.musictech.net/news/gear/music-ai-third-party-modules-masterchannel-cyanite-launch/
- Lyria en Vertex AI: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/music/generate-music
- Lyria 3 y 3 Pro: https://cloud.google.com/blog/products/ai-machine-learning/lyria-3-and-lyria-3-pro-on-vertex-ai/
- Programa de socios de la API de Suno: https://www.digitalmusicnews.com/2026/07/03/suno-is-opening-an-api-partner-program/
- Moises Studio: https://moises.ai/newsroom/product-announcements/moises-launches-studio-collaborative-workspace
