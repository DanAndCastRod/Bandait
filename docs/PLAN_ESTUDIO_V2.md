# Estudio Bandait v2: MIDI, piano roll, instrumentos, atajos e IA integrada

**Fecha:** 2026-11-19
**Estado:** aprobado por Daniel Castañeda para implementar ("escribe el plan e implementalo").
**Parte de:** `docs/PLAN_ESTUDIO_BANDAIT.md` (v1, ya en producción). Este documento no lo
reemplaza: agrega lo que v1 dejó fuera (sección 6 de v1, "Fuera del alcance").

---

## 1. Alcance

| Bloque | Qué entrega |
|---|---|
| A. Contrato v2 | Pistas de instrumento y clips MIDI en el documento de sesión, con migración automática de v1 |
| B. MIDI | Clips MIDI, piano roll, grabación desde teclado (Web MIDI), importar y exportar `.mid` |
| C. Instrumentos | Sintetizador, caja de ritmos y sampler propios; plugins web WAM 2.0 de una lista cerrada |
| D. Atajos | Mapa de atajos profesional, editable, con paleta de comandos |
| E. IA en el Estudio | Componer MIDI, audio a MIDI, analizar un audio, asistente por chat que opera el Estudio |
| F. VST | Decisión y diseño; sin implementación nativa en esta etapa (sección 8) |

Reglas de v1 que siguen igual: edición no destructiva, un solo grafo para escuchar y exportar,
claves solo en el Worker, nada de estado de React por fotograma, el escenario no se toca, sin
emojis, todo en español. El Estudio sigue encendido por defecto y conserva su apagado.

## 2. Decisiones ya tomadas

| Tema | Decisión | Origen |
|---|---|---|
| Lyria | Pasa por URiT IA (ruta de música en preparación en urit-ai). Hasta entonces `generate` sigue con el adaptador de la Gemini API directa y sin clave cargada (503). No cambiar `generate` en esta etapa | Daniel Castañeda, vía la sesión de URiT, 2026-11-19 |
| Texto (asistente, componer, chat) | Por URiT IA (`urit-ai`) como consumidor `bandait`, proveedor `urit` del Worker. No con la clave directa: competiría por la cuota de Releven y accntant | Recomendación de la sesión de URiT, aceptada por Daniel Castañeda |
| Modelo de texto | Sin fijar: manda la cadena de URiT (`gemini-3.8-flash` y respaldos). No pedir `gemini-4-hydrogen` (JSON con esquema sin verificar) | Sesión de URiT |
| VST nativos | No en el navegador. Ahora: instrumentos propios y WAM 2.0. Puente local con VST3: etapa futura, opcional | Este plan, sección 8 |

## 3. Contrato `STUDIO_V2`

`bandait-protocol/STUDIO_V2.md` y `bandait-protocol/fixtures/studio_session_v2.json`. El
documento v1 sigue siendo válido de lectura: el Hub lo migra al abrirlo y lo guarda como v2.
La validación sigue siendo estricta (campo desconocido = error).

### 3.1 Cambios en el documento

- `version: 2`.
- Pista con `kind`: `audio` (como en v1) o `instrument`.
  - Una pista `audio` tiene `clips` de audio, igual que v1.
  - Una pista `instrument` tiene `instrument` y `midi_clips`. No tiene `clips` de audio.
- `instrument`:
  ```json
  {"type": "synth", "preset": "pad_calido", "params": {"...": 0}}
  ```
  `type`: `synth`, `drums`, `sampler` o `wam`. Con `wam`: `{"type": "wam", "plugin_id": "<id de la lista cerrada>", "state": {...}}`.
  Con `sampler`: las muestras son audios de la sesión (`asset_id` por nota o zona).
- `midi_clip`:
  ```json
  {"id": "mid_1", "start_beat": 16, "length_beats": 16, "loop": false,
   "notes": [{"pitch": 60, "start": 0, "length": 1, "velocity": 100}]}
  ```
  Tiempos en **beats** (negras), no en segundos: los clips sobreviven a un cambio de tempo.
  `start` de una nota es relativo al clip. `pitch` 0..127, `velocity` 1..127.
- Opcional en la raíz: `markers` (secciones y marcas: `{id, beat, label, kind}`), que llena el
  análisis de IA o el usuario.
- Tempo único por sesión (como v1). Mapa de tempo: fuera de alcance.
- Límites nuevos: 4 096 notas por clip MIDI, 256 clips MIDI por pista, 16 pistas en total.

### 3.2 Trabajos nuevos del Worker

| `kind` | Entrada | Proveedor | Resultado |
|---|---|---|---|
| `compose` | `prompt`, `bpm`, `key`, `beats_per_bar`, `length_bars`, `role` (`drums`, `bass`, `chords`, `melody`), contexto opcional (notas de otras pistas, resumidas) | `urit` (texto con JSON y esquema) | `notes` listas para un clip MIDI |
| `analyze` | `asset_id` | Music.AI (workflow de análisis existente, `MUSICAI_WORKFLOW`) | `bpm`, `key`, `beats_per_bar`, `markers`, `chords` |
| `chat` | `messages` (conversación), `session_summary` (pistas, clips, mezcla; sin audio) | `urit` con herramientas (`tools`) | `reply` y/o `tool_calls` (comandos del Estudio) |

`chat` no ejecuta nada: devuelve las llamadas a herramientas tal como las pidió el modelo
(incluida `signature`, que URiT exige devolver en el turno siguiente). El Hub las muestra, el
usuario las aplica (cada una es un paso de deshacer) y el Hub manda el resultado en el turno
siguiente. Las herramientas son los comandos del registro de la sección 6 que el asistente puede
usar (lista cerrada en el contrato).

Mismas reglas de v1 para todo trabajo: solo editores y `STUDIO_SPENDER_UIDS`, tope de gasto,
costo estimado antes de confirmar, `job_id` elegido por el Hub, el trabajo no modifica la sesión.

## 4. MIDI

- **Piano roll** (canvas): teclado vertical, rejilla de compases y beats, herramientas de dibujar,
  seleccionar (rectángulo y Shift), borrar, cortar nota y pintar velocidad; carril de velocidad;
  ajuste a la rejilla (1/4 a 1/32 y tresillos); cuantizar con fuerza; transponer (flechas,
  Shift = octava); duplicar; legato; zoom horizontal y vertical; escuchar la nota al dibujarla.
- **Grabar MIDI**: API Web MIDI (Chrome y Edge de escritorio). Elegir dispositivo, canal y pista
  armada; grabación sobre el clic con el mismo conteo de v1; cuantizar al terminar (opcional).
  Teclado de computadora como teclado musical (fila A..K) cuando no hay dispositivo.
- **Importar y exportar `.mid`**: archivo MIDI estándar tipo 0 y 1, escrito en un módulo propio y
  puro (`services/studio/smf.ts`), sin dependencias.
- La UMC202HD no tiene puertos MIDI: hace falta un teclado USB.

## 5. Instrumentos

- `synth`: sustractivo, 2 osciladores, filtro con envolvente, ADSR, LFO; presets en español.
- `drums`: caja de ritmos sintetizada (bombo, caja, hi-hat abierto y cerrado, toms, platillo,
  palmas) mapeada a General MIDI percusión (36, 38, 42, 46...).
- `sampler`: zonas con audios de la sesión, afinación por nota raíz.
- Todos en `AudioWorklet` o nodos nativos, deterministas, y presentes en `buildGraph`: lo que
  suena es lo que se exporta (`OfflineAudioContext`).
- Polifonía limitada (32 voces por pista) con robo de voz.
- **WAM 2.0**: anfitrión mínimo para plugins web. Solo una **lista cerrada** de plugins empaquetados
  con el Hub (nunca código cargado desde una URL arbitraria: sería ejecutar código ajeno en la
  sesión del usuario). Si el SDK no se puede instalar o verificar, queda la interfaz del anfitrión
  y la lista vacía, y se dice.

## 6. Atajos y paleta de comandos

- Registro único de comandos (`services/studio/commands.ts`): id, nombre en español, categoría,
  atajo por defecto, contexto (`global`, `timeline`, `piano_roll`, `mixer`), si lo puede usar el
  asistente. La interfaz, el teclado, la paleta y el chat llaman al mismo registro.
- Mapa por defecto con convenciones de DAW:

| Atajo | Comando |
|---|---|
| Espacio | Reproducir y parar |
| R | Grabar |
| Enter / Inicio | Ir al inicio |
| L | Activar el loop |
| C | Clic |
| Ctrl+Z / Ctrl+Y o Ctrl+Shift+Z | Deshacer y rehacer |
| Ctrl+C / Ctrl+X / Ctrl+V | Copiar, cortar, pegar (clips y notas) |
| Ctrl+D | Duplicar |
| Supr / Retroceso | Borrar |
| S | Dividir en el cabezal |
| Q | Cuantizar |
| M / Shift+S | Mute y solo de la pista seleccionada |
| Ctrl+A | Seleccionar todo (en el contexto activo) |
| Flechas | Mover; en el piano roll, transponer o mover en la rejilla |
| + / - | Zoom horizontal |
| 1..5 | Herramientas (seleccionar, dibujar, borrar, cortar, velocidad) |
| E | Alternar línea de tiempo y piano roll (no Tab: es la navegación del teclado) |
| Ctrl+K | Paleta de comandos |
| Ctrl+S | Guardar en la nube |
| Ctrl+E | Exportar |
| Alt+N / Alt+I | Pista de audio nueva / pista de instrumento nueva |
| Alt+A | Mostrar u ocultar el asistente (también escribiendo en él) |

Los atajos funcionan con el foco dentro del Estudio. Ninguno usa teclas que el navegador se queda (`BROWSER_RESERVED_SHORTCUTS` en `keymap.ts`: Ctrl+T, Ctrl+N, Ctrl+W, Ctrl+J, Ctrl+Shift+J, F5, F12 y otras); un atajo editado con una de ellas no se guarda. Ctrl+J abría las descargas de Chrome y Ctrl+T una pestaña (2026-11-23).

Atajos de DAW agregados el 2026-11-22 (pedido de Daniel Castaneda). Contexto: G = en todo el
Estudio, LT = línea de tiempo, PR = piano roll.

| Atajo | Contexto | Comando |
|---|---|---|
| Ctrl+C / Ctrl+X / Ctrl+V | LT | Copiar, cortar y pegar clips. Pegar va a la misma pista del clip copiado (o a la pista elegida si todo salió de una sola pista y es compatible: audio en audio, MIDI en instrumento), en el cabezal si se movió desde que se copió; si no, justo detrás del original. Ctrl+V repetido encadena copias. Cortar y pegar sin mover el cabezal devuelve el clip a su lugar |
| Ctrl+D | LT y PR | Duplicar la selección justo detrás (clips o notas) |
| Shift + clic / Ctrl + clic | LT | Agregar o quitar un clip de la selección; arrastrar uno de los elegidos mueve todos |
| Ctrl+A | LT | Elegir todos los clips que suenan (en el piano roll, todas las notas) |
| Supr, Q, S, flechas | LT | Actúan sobre todos los clips elegidos. S sin clips elegidos divide los de la pista elegida bajo el cabezal |
| Shift+J | LT | Unir clips MIDI de una pista (o trozos seguidos de un mismo audio) |
| 0 | LT | Silenciar o hacer sonar los clips elegidos: audio con `active`, MIDI con `muted` (desde el 2026-11-25, STUDIO_V2.md 2.4) |
| Arrastre en zona vacía | LT | Rectángulo de selección: elige los clips que toca; con Shift o Ctrl suma a la selección (2026-11-25) |
| Alt+[ / Alt+] | LT | Recortar el inicio o el final del clip al cabezal |
| (paleta) | LT | Fundido de entrada hasta el cabezal y de salida desde el cabezal (clips de audio) |
| Fin | G | Ir al final de la sesión |
| , / . | G | Retroceder o avanzar un compás |
| Ctrl+Izquierda / Ctrl+Derecha | G | Marca anterior o siguiente (marcas de la sesión e inicio de secciones) |
| Ctrl+L | G | Loop con el rango de la selección (clips, o notas en el piano roll) |
| Shift+T | G | Tap tempo (desde el tercer golpe; una pausa de 2 s cierra un paso de deshacer) |
| Shift+K | G | Activar o quitar el conteo previo antes de grabar |
| Shift+Z | G | Ver toda la sesión |
| Shift+C | G | Centrar la vista en el cabezal |
| Shift+M | G | Agregar una marca en el cabezal (M sigue siendo el mute de la pista) |
| Shift+R | G | Armar o desarmar la pista elegida |
| F2 | G | Renombrar la pista elegida |
| Ctrl+Shift+D | G | Duplicar la pista elegida |
| Alt+Arriba / Alt+Abajo | LT | Subir o bajar la pista elegida |
| 1..9 | LT | Elegir la pista por su número (en el piano roll, 1..5 siguen siendo las herramientas) |
| Ctrl+I | PR | Invertir la selección de notas |
| Shift+L | PR | Legato |
| Alt+Arriba / Alt+Abajo | PR | Subir o bajar la velocidad de las notas (de 5 en 5) |
| Shift+Derecha / Shift+Izquierda | PR | Alargar o acortar las notas un paso de la rejilla |

- Las letras solas de la fila del teclado musical (A..K, Z, X) no se usan para atajos nuevos: con
  el teclado musical encendido son notas. Por eso los atajos nuevos con letra llevan Shift o Ctrl.
- Editable por usuario (guardado por navegador), con detección de choques y botón de restaurar.
- Nunca se dispara mientras se escribe en un campo.
- Una hoja de atajos visible (`?`).

## 7. IA en el Estudio

| Herramienta | Dónde corre | Costo |
|---|---|---|
| Componer MIDI (`compose`) | Worker, `urit` | por consulta |
| Audio a MIDI | Navegador, si se puede instalar y verificar un modelo abierto (por ejemplo Basic Pitch de Spotify, licencia a confirmar); si no, queda la interfaz con el motivo | sin costo por uso |
| Analizar un audio (`analyze`) | Worker, Music.AI | por minuto |
| Asistente por chat (`chat`) | Worker, `urit` con herramientas | por consulta |
| Asistente de mezcla (`assist`) | Worker, `urit` (ya existe) | por consulta |
| Generar audio (`generate`) | Worker, Lyria (ya existe) | por 30 s |
| Masterizar y separar | Worker, Music.AI (ya existe) | por minuto |

Todo lo que llega de un modelo es una **propuesta**: entra como clip nuevo, como sugerencia o como
comando pendiente, y el usuario lo acepta. Cada aceptación es un paso de deshacer.

### 7.1 El chat conoce la música (2026-11-23)

El resumen que recibe el chat (`STUDIO_V2.md` 4.3.2) lleva, además de la estructura:

- **Notas MIDI resumidas** por clip (`digest`): registro, clases de altura con peso por duración,
  notas por compás, rejilla dominante, velocidad media y, en patrones de hasta 64 notas, las notas
  literales `[pitch, start_beat, dur_beats, vel]`.
- **Armonía conocida**: los acordes que ANALIZAR AUDIO encontró, si el usuario aceptó GUARDAR
  ACORDES (campo `chords` del documento, `STUDIO_V2.md` 2.9), y la progresión por sección de la
  canción ligada desde su ficha ChordPro (`song_chart`, nunca la letra).
- **Mediciones de mezcla**: la última medición del ASISTENTE DE MEZCLA o del botón MEDIR MEZCLA
  del chat (gratis, en el equipo), con `fresh` según la versión del documento.

Antes de aplicar notas del asistente, el Hub avisa (sin bloquear) de notas fuera de la
tonalidad, choques de registro con otra pista en el mismo tramo y notas fuera del rango útil del
instrumento (`services/studio/noteReview.ts`).

### 7.2 Anexo: Escuchar a pedido (lo que tiene que cambiar URiT IA)

Bandait ya tiene listo ESCUCHAR FRAGMENTO del chat (`STUDIO_V2.md` 4.3.5), apagado con
`STUDIO_CHAT_LISTEN` = `"0"` en el Worker. Hoy URiT IA rechaza audio en `/v1/text`
(`workers/ai/src/validate.ts`: la parte `inline` solo existe en `/v1/vision` y solo con
`IMAGE_TYPES`; el cuerpo de `/v1/text` tiene tope de 256 KB). Para prenderlo, URiT IA tiene que:

1. **Aceptar `inline` de audio en `/v1/text`** en mensajes `user`, con `mime_type`
   `audio/wav` o `audio/mpeg` (`{"inline": {"mime_type": "audio/wav", "data": "<base64>"}}`), igual
   que la imagen en `/v1/vision`. Traducción a Gemini: `inlineData` con el mismo `mimeType`
   (Gemini acepta audio en línea en `generateContent`). Las demás partes (texto, `tool_call`,
   `tool_result`) y las herramientas no cambian: el chat del Estudio sigue usando herramientas en
   la misma llamada.
2. **Solo para consumidores autorizados**: un ajuste nuevo del consumidor, por ejemplo
   `settings.allow_audio: true` en `PUT /v1/admin/consumers/<id>`. Sin él, la parte de audio
   responde 400 `invalid_request` con `detail` la ruta del campo (como hoy). Se habilita para
   `bandait`.
3. **Límites**: hasta 1 parte de audio por llamada, hasta **1 MiB de audio decodificado** por
   parte (30 s de WAV 16 kHz 16 bit mono son 960044 bytes; un MP3 de 30 s pesa menos) y
   **duración máxima 30 s** si URiT puede leer la cabecera WAV; pasar el tope es 413
   `payload_too_large`. El cuerpo de `/v1/text` con audio necesita un tope mayor que 256 KB: al
   menos **1,5 MiB** (1 MiB en base64 son unos 1,34 MiB más la conversación de hasta 192 KB).
   Propuesta: tope de 2 MiB solo cuando el consumidor tiene `allow_audio`.
4. **Precio**: el audio de entrada se cobra como tokens de entrada de audio de Gemini (unos 32
   tokens por segundo según la guía de Google, a confirmar contra la tabla vigente). URiT debe
   sumar esos tokens a `usage.input_tokens` (o informar `usage.audio_tokens`) y reflejarlos en
   `usage.estimated_usd`, con la tarifa de audio del modelo en `PRICES` si difiere de la de texto.
   Bandait ajusta su gasto con `usage.estimated_usd` como hoy; su recargo de referencia por vuelta
   que escucha es `STUDIO_RATE_CHAT_LISTEN_USD` (0,02 USD), que se corrige cuando URiT publique
   el precio.
5. **Registro**: el audio no se guarda ni se registra en URiT (igual que el texto); en
   `/v1/admin/requests` basta con contar las partes de audio y sus bytes.

Cuando URiT lo publique: verificar con una llamada real (un fragmento corto), cambiar
`STUDIO_CHAT_LISTEN` a `"1"` en `bandait-stems-worker/wrangler.jsonc`, ajustar
`STUDIO_RATE_CHAT_LISTEN_USD` al precio real y desplegar el Worker. El botón ESCUCHAR FRAGMENTO
aparece solo cuando la estimación del chat responde `listen: true`.

**Hecho el 2026-11-23.** URiT IA 0.4.0 en producción (contrato `workers/ai/CONTRACT_V1.md` 3.5,
consumidor `bandait` con `allow_audio`). Prueba real con el código del Worker (`chatCall` +
`uritText.chat`) y un WAV de 6 s: 200 en 5,6 s, USD 0,0042 la llamada completa (sistema,
herramientas, razonamiento y audio). El modelo acertó el tempo (120 BPM) y erró la tonalidad
(dijo La menor de un arpegio de Do mayor): lo que oye orienta, no reemplaza ANALIZAR AUDIO.
`STUDIO_CHAT_LISTEN` = `"1"` y recargo por defecto de 0,002 USD por vuelta que escucha (el audio
cuesta unos 0,0006 USD por 30 s; se cobra el `usage.estimated_usd` real). Worker 1.3.0.

## 8. VST

| Opción | Veredicto |
|---|---|
| Instrumentos propios y WAM 2.0 | **Esta etapa.** Funcionan en cualquier equipo, en la nube y al exportar |
| Puente local con VST3 (programa pequeño en el PC; el Estudio le habla por localhost) | **Futuro, opcional.** No sirve en el equipo de Daniel Castañeda (no se puede instalar software). Exige "congelar": cada pista VST guarda su audio renderizado para que la sesión suene en un equipo sin el plugin. Licencias: SDK de VST3 de Steinberg y, si se usa `pedalboard`, GPL v3 |
| VST en la nube | Descartado: licencias por equipo y latencia |

El contrato v2 reserva el lugar del congelado: una pista de instrumento puede llevar
`frozen_asset_id` (audio renderizado) que suena cuando el instrumento no está disponible.

## 9. Fases y verificación

| Fase | Entrega | Verificación |
|---|---|---|
| 1 | Contrato v2, migración, tipos | Fixture v2, migración v1 a v2 ida y vuelta en `verify-studio-logic.ts` |
| 2 | MIDI puro (SMF, cuantizar, operaciones de notas), instrumentos y motor, Web MIDI, comandos y atajos, trabajos nuevos del Worker | `verify:logic` y `npm test` del Worker |
| 3 | Piano roll, pistas de instrumento, paleta, panel de IA ampliado y chat | lint, build, e2e |
| 4 | Revisión independiente, correcciones, e2e completos, `build:landing`, `DEVLOG.md` | una corrida de cada suite al final |

## 10. Pendientes que dependen de Daniel Castañeda

1. Registrar el consumidor `bandait` en URiT IA y guardar su token en ClipVault (por ejemplo, el
   campo `bandait_token` de `urit-ai-credentials`). Sin él, `assist`, `compose` y `chat`
   responden 503. Alternativa temporal: `ASSIST_PROVIDER=gemini` (clave directa), que la sesión
   de URiT desaconseja.
2. Su uuid en `STUDIO_SPENDER_UIDS`.
3. Un teclado MIDI USB para probar la grabación MIDI.
4. A mediano plazo, una clave de Gemini propia de Bandait.
