# Bandait Leader (escritorio)

Líder de sesión en Python/PySide6: corre en la laptop de FOH, es la autoridad del
transporte y sirve el protocolo v3 (`../bandait-protocol/CONTRACT_V3.md`) por
Socket.IO en la LAN del escenario. No transmite audio: envía instrucciones de tiempo.

## Ejecutar

```
cd bandait-leader
pip install -r requirements.txt
python -m src.main                      # GUI
python -m src.headless --port 4040      # sin GUI (desarrollo / integración)
```

### Modo headless

`python -m src.headless` levanta `QCoreApplication + ClockService + BandaitServer`
con el setlist de demostración de `bandait-protocol/fixtures/v3_messages.json`
(`song_01` 120, `song_02` 96, `song_07` 140 BPM). Habla exactamente el mismo
protocolo que el escritorio, sin audio. Sirve para probar el follower o el hub
contra un líder real.

Opciones: `--host` (por defecto `0.0.0.0`), `--port` (4040; `0` = efímero),
`--session-id` (`default`), `--setlist archivo.json` (lista de
`{song_id, title, bpm, transition_mode}` o `{"setlist": [...]}`), `--no-demo`,
`--duration N` (se detiene solo), `--quiet`. Imprime cada cambio de estado.
Se detiene con Ctrl+C (o Ctrl+Break en Windows) cerrando el servidor de forma ordenada.
Si el puerto está ocupado sale con código 2 y lo dice.

## Variables de entorno

| Variable | Efecto |
|---|---|
| `BANDAIT_DB` | Ruta del SQLite. Todas las rutas de DB pasan por `src/core/paths.py:get_db_path()` |
| `BANDAIT_HOME` | Carpeta de datos (DB, grabaciones, `leader_config.json`). Por defecto `~/Documents/Bandait` |
| `BANDAIT_PORT`, `BANDAIT_HOST` | Puerto y host del servidor de la GUI (4040, `0.0.0.0`) |
| `BANDAIT_LAN_IP` | IP anunciada a los teléfonos (gana sobre la elegida en "Conectar músicos") |
| `BANDAIT_FOLLOWER_DIR` | Carpeta del follower compilado (por defecto `../landing/app`) |
| `BANDAIT_AUDIO_DISABLED=1` | No abre ningún stream de PortAudio (pruebas, CI) |
| `BANDAIT_ASIO=1` | Carga el PortAudio con ASIO de `sounddevice` (también desde el diálogo de audio) |

## Cómo llegan los músicos (contrato v3, sección 8)

Una página HTTPS no puede abrir `ws://` a una IP de la LAN, así que en escenario el
líder sirve el follower por HTTP en el mismo puerto que Socket.IO:

- `GET /` y estáticos: el bundle `landing/app` (compilar con `npm run build:landing` en
  la raíz). Orden de búsqueda: `BANDAIT_FOLLOWER_DIR`, config del líder, `../landing/app`,
  y dentro del .exe `sys._MEIPASS/follower`. Si falta, una página de ayuda (503).
  Rutas sin extensión devuelven `index.html`; archivos inexistentes, 404. `index.html` y
  `leader-info.json` van con `Cache-Control: no-store`; `assets/*` (con hash) se cachean.
- `GET /leader-info.json`: `{protocol_version, leader_instance_id, session_id, ip, port,
  follower_url, director_url}`.
- IP anunciada: la de la interfaz con ruta por defecto, sin loopback, link-local ni
  adaptadores virtuales (WSL, Hyper-V, Docker, VPN). Se puede fijar con `BANDAIT_LAN_IP`,
  `--lan-ip` (headless) o el selector de Red > Conectar músicos.
- Red > Conectar músicos (o el botón de la barra de estado): QR de músicos y director,
  URLs con botón Copiar. Se escanea con la cámara nativa del teléfono.

## Arquitectura del transporte (un solo camino)

```
botones laptop (laptop_foh) ─┐
                             ├─> ConcurrentControlManager.process_command (lock, cualquier hilo)
control_command (Socket.IO) ─┘        │
                                      ├─> outbox asyncio ─> state_update / setlist_jump al room
                                      └─> señal Qt encolada ─> ClockService.apply_update (hilo Qt)
                                                                  └─> AudioEngine.set_schedule
```

- Los handlers de Socket.IO corren en el loop asyncio del hilo del servidor y
  responden el ack sin esperar al hilo Qt.
- `beat_beacon` sale de una tarea asyncio en cada downbeat mientras está PLAYING.
- El clic de FOH está enganchado al mismo `anchor_ns` que los seguidores: el
  callback de audio convierte `outputBufferDacTime` (reloj del stream) a tiempo
  del líder y arranca el clic k en el frame exacto de `anchor_ns + k*beat_ns`.
  El callback no usa locks, colas, logging ni prints, ni crea buffers.

## Audio y ruteo

- Se abre el dispositivo elegido con todas sus salidas (máximo 64).
  Salidas 1-2 = PA (FOH), Salida 3 = clic del baterista.
- Fallback con 2 salidas: no existe Salida 3, así que el clic del baterista no
  suena y **no** se envía a la PA. Para oírlo en Salidas 1-2 (ensayo, audífonos)
  active "Clic en PA" en Audio > Dispositivos de Audio.
- El monitoreo de la entrada hacia las salidas está apagado (evita realimentación).
- La elección se guarda en `leader_config.json` por nombre y API (los índices de
  PortAudio cambian al conectar o desconectar equipos).

## Base de datos

`init_db` aplica migraciones aditivas e idempotentes: agrega las columnas que el
modelo define y la base vieja no tiene. Antes de cualquier `ALTER` copia el archivo
a `<nombre>.bak-AAAAMMDDHHMMSS`. Nunca borra ni recrea la base.

## Reloj del líder

Todo `*_ns` es `time.perf_counter_ns()` (contrato v3, sección 2), leído solo en
`src/sync/leader_clock.py:leader_now_ns()`. `time.monotonic_ns()` está prohibido en
`src/` (una prueba lo verifica): en Windows con Python < 3.13 tiene 15.6 ms de
resolución y metía ~4 ms de jitter en la sincronización. Para medir la latencia de
`sync_request` en reposo y tocando: `python scripts/sync_latency_bench.py`.

## Pruebas

```
cd bandait-leader
ruff check src tests
QT_QPA_PLATFORM=offscreen python -m pytest -q
```

`tests/conftest.py` redirige `BANDAIT_HOME`, `BANDAIT_DB`, `HOME` y `USERPROFILE` a
carpetas temporales y apaga el audio; la sesión falla si la base real del usuario
cambia. `tests/test_protocol_v3.py` usa un cliente Socket.IO real contra el servidor
en un puerto efímero y valida cada payload contra los fixtures.
