# Contrato de protocolo Bandait v3 (líder ↔ follower ↔ hub)

Fecha: 2026-09-30. Estado: normativo. Ejemplos canónicos de cada mensaje en
`fixtures/v3_messages.json`; las pruebas de cada lado deben validar contra ese archivo.
Si una implementación necesita apartarse de este documento, se corrige primero el
documento y los fixtures, nunca solo el código.

## 1. Transporte y codificación

- Socket.IO v4. Servidor: `python-socketio` AsyncServer (ASGI sobre uvicorn) en el
  líder, puerto 4040 por defecto. Cada sesión es un room cuyo nombre es `session_id`.
- **Todas las claves del payload van en snake_case.** No hay camelCase en el cable.
  Los clientes TypeScript traducen en un único módulo frontera (decode/encode).
- `protocol_version: 3` viaja en `join_session` y en cada `SessionState`.

## 2. Base de tiempo

- Todo campo `*_ns` es tiempo del reloj monotónico **de alta resolución** del líder
  (`time.perf_counter_ns()`), entero. No usar `time.monotonic_ns()`: en Windows con
  Python < 3.13 tiene resolución de 15.6 ms (GetTickCount64), lo que mete ~4 ms de
  jitter de cuantización en cada timestamp (medido el 2026-09-30). `perf_counter_ns`
  usa QueryPerformanceCounter en Windows y CLOCK_MONOTONIC en Linux. En JS se maneja
  como `number` y se convierte a ms dividiendo entre 1e6.
- Los clientes **nunca** envían su propio reloj como si fuera tiempo del líder.
- Sincronización estilo NTP: el follower envía `sync_request` con `client_send_ms`
  (su `performance.now()`, opaco para el líder); el líder responde por ack con
  `client_send_ms` (eco) y `leader_time_ns`. El follower calcula, con `t3` = recepción:
  - `rtt_ms = t3 - client_send_ms`
  - `offset_ms = leader_time_ns / 1e6 - (client_send_ms + t3) / 2`
  - `leader_ms = local_ms + offset_ms`; `local_ms = leader_ms - offset_ms`
  - El offset es grande y constante (relojes con orígenes distintos); eso es correcto.
    El **jitter** es la dispersión (MAD o desviación) de las muestras de offset, no el
    offset en sí.

## 3. Eventos cliente → líder

| Evento | Payload | Respuesta (ack de Socket.IO) |
|---|---|---|
| `join_session` | `{session_id, client_id, role, alias, protocol_version}` | `{status: "joined", session_id, protocol_version, leader_time_ns}` y además el líder emite `full_state` a ese socket **siempre**, aunque el estado sea IDLE |
| `sync_request` | `{client_send_ms}` | `{client_send_ms, leader_time_ns}` |
| `control_command` | `{session_id, command_id, type, origin, sender_id, payload}` | `command_ack` (sección 5) |

- `role`: `"musician" | "director" | "foh" | "hub"`.
- `origin`: `"director_mobile" | "laptop_foh" | "hub"`.
- `command_id`: UUID generado por el cliente. Reintentar con el mismo `command_id` es
  idempotente: el líder devuelve el ack guardado con `duplicate: true` sin reaplicar
  (ventana de deduplicación: 60 s).
- `type` (CommandType): `PLAY | STOP | PAUSE | RESUME | CUE_NEXT | CUE_PREV | JUMP_SONG | TEMPO_NUDGE | PANIC`.
  Un `type` desconocido se **rechaza** (`accepted: false, reason: "invalid_type"`);
  nunca se interpreta como PLAY.
- Payloads por tipo:
  - `JUMP_SONG`: `{song_id}` o `{order_index}` (0-based).
  - `CUE_NEXT` / `CUE_PREV`: `{expected_song_id}` opcional: la canción que el emisor
    creía actual. Si no coincide con la actual, se rechaza con `reason: "conflict"`
    (otro dispositivo ya movió el setlist; evita saltar dos canciones por pulsaciones
    simultáneas).
  - `TEMPO_NUDGE`: `{delta_bpm}` (entero, normalmente ±1). BPM resultante acotado a 40..260.
- El evento `broadcast_state` desaparece: ningún cliente puede escribir el estado de la
  sesión directamente. El líder de escritorio usa su API interna.

## 4. Eventos líder → clientes

| Evento | Destino | Payload |
|---|---|---|
| `full_state` | socket que se une | `SessionState` |
| `state_update` | room | `SessionState`, en cada cambio de transporte, canción o tempo |
| `beat_beacon` | room | `{session_id, state_version, anchor_ns, bpm, beats_per_bar, bar_offset, leader_time_ns}`, una vez por compás (en cada downbeat) mientras `status == "PLAYING"` |
| `setlist_jump` | room | `{session_id, song_id, title, order_index, previous_song_id, triggered_by, timestamp_ns}` |
| `follower_joined` / `follower_left` | room | `{sid, client_id, alias, role}` |

### SessionState

```
protocol_version   3
leader_instance_id string (UUID generado al arrancar el proceso líder; también va en el ack de join_session)
session_id         string
status             "IDLE" | "COUNTING" | "PLAYING" | "PAUSED"
state_version      int, estrictamente creciente por proceso líder (si cambia leader_instance_id, el
                   follower reinicia su seguimiento de versiones: el líder se reinició)
current_song_id    string | null
current_order_index int | null   (0-based)
bpm                number
beats_per_bar      int (4 por defecto)
anchor_ns          int | null    instante (reloj líder) del beat 1 del compás bar_offset; null salvo PLAYING/COUNTING
bar_offset         int           número de compás en anchor_ns (empieza en 1)
paused_bar         int | null    compás en que se pausó; null salvo PAUSED
leader_time_ns     int           reloj del líder al emitir
setlist            [{song_id, title, bpm, order_index, transition_mode}]
last_command       {command_id, type, origin} | null
```

`transition_mode`: `"manual_cue" | "auto_count_in" | "gapless"` (por ahora solo se
transporta; la lógica de conteo y gapless queda pendiente).

## 5. command_ack

```
{command_id, accepted, duplicate, action_taken, reason, state_version, state}
```

`reason` es null si se aceptó; si no: `"invalid_type" | "conflict" | "no_setlist" | "out_of_range"`.
`action_taken` describe lo aplicado, p. ej. `"PLAY"`, `"noop_already_playing"`.

## 6. Semántica de transporte (normativa)

Matemática de beat, con `beat_ns = 60e9 / bpm` y `k = floor((t_ns - anchor_ns) / beat_ns)`, `k >= 0`:

- `beat = (k mod beats_per_bar) + 1`
- `bar = bar_offset + floor(k / beats_per_bar)`
- Clic número k en `anchor_ns + k * beat_ns`; acento cuando `beat == 1`.

Reglas:

1. `START_LEAD_MS = 250`. Todo anchor nuevo cumple `anchor_ns >= leader_time_ns + 250 ms`
   para que el mensaje llegue a todos antes del primer clic.
2. **Un cambio de anchor nunca es retroactivo.** El follower mantiene su horario
   anterior hasta `anchor_ns` y desde ahí usa los parámetros nuevos.
3. `PLAY` desde IDLE: `status = PLAYING`, `anchor_ns = ahora + 250 ms`, `bar_offset = 1`,
   beat 1. `PLAY` estando PLAYING es no-op (`noop_already_playing`): **no** reinicia fase
   (dos dispositivos pulsando PLAY a la vez no deben provocar dos arranques).
4. `PAUSE`: `status = PAUSED`, `anchor_ns = null`, `paused_bar` = compás actual.
5. `RESUME` desde PAUSED: `status = PLAYING`, `anchor_ns = ahora + 250 ms`,
   `bar_offset = paused_bar + 1`, empieza en beat 1. `PAUSE` ya no reinicia nada por sí
   mismo; el reinicio de fase ocurre en `RESUME`.
6. `STOP`: `status = IDLE`, `anchor_ns = null`, `bar_offset = 1`. Los clientes cancelan
   los clics ya programados (no esperan a que suenen).
7. `PANIC`: igual que STOP y además `last_command.type == "PANIC"`; los clientes silencian
   **todo** su audio local de inmediato (clic e in-ear), no solo el transporte.
8. `TEMPO_NUDGE` en PLAYING: el bpm nuevo arranca en el primer límite de compás que cumpla
   la regla 1; `anchor_ns` y `bar_offset` se recalculan para ese compás. En IDLE/PAUSED
   solo cambia `bpm`.
9. `JUMP_SONG` (y `CUE_*` en PLAYING): cambio inmediato de canción con anchor nuevo
   (`ahora + 250 ms`, `bar_offset = 1`, bpm de la canción destino) y emisión de
   `setlist_jump` si el salto no es secuencial.
10. Last-write-wins: el líder ordena por **su** instante de recepción
    (`time.perf_counter_ns()` al recibir); los timestamps del cliente no participan en el orden.

## 7. Comportamiento obligatorio del follower

- Programa los clics en el `AudioContext` a partir de `anchor_ns`/`bpm` convertidos a
  tiempo local (programador con lookahead; no `setInterval` por beat).
- `AudioContext` creado o reanudado dentro de un gesto del usuario (iOS).
- **Flywheel**: si se cae el socket en PLAYING, sigue programando con el último
  anchor/bpm/offset conocidos. Al reconectar, con al menos 3 muestras de sync nuevas,
  corrige la fase de forma suave (error < 2 ms se ignora; < 50 ms se reparte en al menos
  un compás; mayor, re-ancla en el siguiente límite de beat sin clics dobles).
- Reconexión infinita con backoff acotado (máximo 5 s). Un solo bucle de sync activo.

## 8. Cómo llega el follower al teléfono en escenario (decisión del 2026-09-30)

Una página HTTPS no puede abrir `ws://` hacia una IP de la LAN (contenido mixto:
verificado en Chrome 154; Safari y Firefox lo bloquean). Por eso, **en escenario el
follower lo sirve el propio líder por HTTP en la LAN**, en el mismo puerto que Socket.IO:

| Ruta HTTP del líder | Contenido |
|---|---|
| `GET /` y archivos estáticos | El bundle del follower (`landing/app`, generado con `npm run build:landing`). Si falta, una página HTML que lo explica. |
| `GET /leader-info.json` | `{protocol_version, leader_instance_id, session_id, ip, port, follower_url, director_url}` con `Content-Type: application/json` y `Cache-Control: no-store` |
| `/socket.io/` | Socket.IO, sin cambios |

- `ip` es la IPv4 LAN principal del líder. Se prefiere la interfaz con gateway por
  defecto y se descartan loopback, link-local y adaptadores virtuales (WSL, Hyper-V, VPN).
- URL del QR para músicos: `http://<ip>:<port>/?ip=<ip>&port=<port>&session=<session_id>&auto=1`.
  Para el director se añade `&role=director`. El músico la abre con la **cámara nativa**
  del teléfono; no hace falta el escáner integrado.
- Si el follower se carga desde el líder (`/leader-info.json` responde con JSON válido),
  usa ese origen como líder sin pedir IP.
- Si el follower se carga desde HTTPS (Cloudflare, `bandait.releven.cc/app/`) y el destino
  no es `localhost`/`127.0.0.1`, **no** intenta el socket: ofrece abrir
  `http://<ip>:<port>/?...` con los mismos parámetros (navegación de nivel superior,
  permitida).
- En HTTP (contexto no seguro) no hay service worker, Wake Lock ni cámara: el follower
  lo detecta con `window.isSecureContext`, no lanza errores y usa alternativas: video
  inline silencioso en bucle para mantener la pantalla encendida, y la cámara nativa
  para el QR.

## 9. Contenido de canción, conteo y transiciones (v3.1, Fase 1, en implementación)

Fuente de los datos: el workspace v2 sincronizado desde el hub (`WORKSPACE_V2.md`).

### 9.1 Contenido de canción por HTTP del líder

`GET /songs/<song_id>.json` (mismo puerto, `Cache-Control: no-cache`, con `ETag`):

```
{song_id, title, artist, bpm, beats_per_bar, key, show_key, total_bars | null,
 sections: [{id, kind, label, bars, start_bar, chordpro, cue_text | null}],
 content_etag}
```

- `start_bar` empieza en 1 y es acumulativo.
- `setlist[]` del SessionState agrega `content_etag` por ítem.
- El follower descarga todo el setlist al unirse y vuelve a pedir un ítem cuando cambia su `content_etag`. Así el prompter sigue funcionando en Flywheel, sin red.

### 9.2 Conteo (COUNTING)

- Un conteo de `n` compases se modela con la misma matemática de la sección 6: `anchor_ns` es el inicio del conteo y `bar_offset = 1 - n`. Los compases ≤ 0 son de conteo y el compás 1 es el primero de la canción.
- Mientras `bar < 1`, `status = "COUNTING"`. En el límite del compás 1, el líder emite `state_update` con `status = "PLAYING"` sin cambiar el anchor, lo que no es retroactivo.
- PLAY sobre un ítem con `countInBars > 0` arranca en COUNTING. Se mantienen la regla de los 250 ms de margen y la de no reiniciar fase si ya está sonando.

### 9.3 Transiciones automáticas

- El líder conoce `total_bars` de la canción actual. Al cruzar el último compás, aplica el `transitionMode` del ítem siguiente (WORKSPACE_V2 §4).
- `gapless` re-ancla en el límite exacto, con el BPM nuevo y `bar_offset = 1`.
- `auto_count_in` re-ancla tras `gapSec`, con `bar_offset = 1 - countInBars`.
- `manual_cue` pasa a IDLE con la siguiente canción como `current_song_id`.
- Todo cambio de canción emite `setlist_jump` solo si el salto no es secuencial. Las transiciones automáticas sí son secuenciales.

### 9.4 Avisos de voz

- Los audios se generan **antes del show**. En vivo nunca se llama a la API.
- El líder los reproduce por la salida de cue: `output = "drummer"` usa la salida 3 y `"all_in_ear"` usa las salidas de in-ear configuradas. Cada palabra arranca en su beat (WORKSPACE_V2 §5.1).
- El aviso de una sección suena en el beat 1 del compás `start_bar - cueLeadBars`.
- Los audios se sirven también por `GET /cues/<sha256>.wav`, para que en una versión futura los teléfonos puedan reproducirlos.
