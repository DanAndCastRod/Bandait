# Bandait Leader (escritorio)

Líder de sesión en Python/PySide6: corre en la laptop de FOH, es la autoridad del
transporte y sirve el protocolo v3 (`../bandait-protocol/CONTRACT_V3.md`) por
Socket.IO en la LAN del escenario. No transmite audio: envía instrucciones de tiempo.

Licencia: GPL-3.0-or-later (`../LICENSE`). Componentes de terceros y sus fuentes:
`../NOTICE.md`.

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

## Cuenta y sincronización

El líder descarga lo que la banda preparó en el Web Hub (`https://bandait.releven.cc/hub/`)
y lo deja en la base local, para tocar **sin Internet** en el lugar del show. La
sincronización es de una sola vía: el líder solo lee de Supabase y nunca escribe. Las
canciones y setlists se editan en el hub.

**Paso único en Supabase (dueño del proyecto).** En *Authentication > URL Configuration >
Redirect URLs* agrega exactamente estas tres URL, sin comodines:

```text
http://127.0.0.1:53682/callback
http://127.0.0.1:53683/callback
http://127.0.0.1:53684/callback
```

El líder usa la primera y, si ese puerto está ocupado, las siguientes. Si Supabase no
acepta la dirección de retorno, manda el navegador a la *Site URL* (`/hub/`) y Bandait se
queda esperando: a los 20 s el diálogo de inicio de sesión lo explica y tiene el botón
"Copiar URLs de retorno". El código actual de Supabase Auth acepta direcciones de loopback
por IP aunque no estén en la lista (RFC 8252). Agregarlas igual deja el login
independiente de la versión del servidor.

**Uso.**

1. *Cuenta > Iniciar sesión con Google* abre el navegador del sistema. Al terminar, la
   pestaña dice "Sesión iniciada, vuelve a Bandait".
2. Elige la banda que toca este equipo. Si la cuenta tiene una sola, se elige sola.
3. Elige el setlist del show: queda en vivo para los músicos.

Después, cada arranque sincroniza en segundo plano: el setlist local suena de inmediato y
no espera a la red. *Cuenta > Sincronizar ahora* repite la descarga a pedido. Si una
actualización llega mientras la banda toca, se aplica al próximo STOP: nunca se cambia el
setlist debajo de una canción que está sonando.

**Barra de estado.**

- `NUBE: <correo> // sincronizado HH:MM`: se descargó del hub a esa hora.
- `SIN CONEXION // copia del <fecha>`: no hay red y se usa la última copia descargada.
- `NUBE: sesión cerrada`: la sesión se revocó o venció en Supabase y hay que volver a
  entrar.

El detalle y los avisos de datos mal formados aparecen en el tooltip.

**Qué se guarda y dónde.**

| Dato | Lugar |
|---|---|
| Sesión: solo el *refresh token* y el id, correo y nombre | Administrador de credenciales de Windows, servicio `Bandait Leader`, entrada `supabase_session`. Nunca en archivos ni en logs |
| *Access token* | Solo en memoria. Se renueva cuando faltan menos de 2 minutos para que venza, y solo cuando hace falta |
| Última copia buena del workspace | `BANDAIT_HOME/cloud/workspace.json`, escrita de forma atómica, con `updated_at` y `fetched_at` |
| Canciones, secciones, setlists, transiciones y voz de la banda elegida | La base SQLite: `songs.source = 'cloud'`, `song_sections`, `setlist_songs` y `band_voice_configs` |

**Reglas de la importación.**

- Las canciones de la nube son de solo lectura en el líder.
- Lo que se borra en el hub, o pertenece a otra banda, se borra aquí, pero solo si vino de
  la nube.
- Las canciones y setlists locales nunca se tocan. Si un id del hub choca con una canción
  local, la de la nube se guarda como `cloud-<id>`.
- Todo ocurre en una sola transacción.
- Si la banda elegida desaparece del hub, o la cuenta no tiene fila, no se importa nada y
  se avisa.
- Se aceptan workspaces v1 y v2 (`bandait-protocol/WORKSPACE_V2.md`). En v1, el id de
  cada canción se deriva de la banda, el título y el artista con la misma función del
  hub. Así, cuando el hub sube la versión v2 de esos datos, se actualizan las mismas filas
  sin duplicarlas.
- El orden del setlist es el de `orderIndex` ascendente, sin suponer desde qué número
  cuenta. Ante un empate manda el orden del arreglo.

**Cerrar sesión.** *Cuenta > Cerrar sesión* olvida la sesión en este equipo y la revoca en
Supabase solo para este dispositivo (`scope=local`). El hub abierto en el navegador sigue
con su sesión, y lo ya descargado se queda para tocar.

**Otro proyecto Supabase.** Orden de prioridad: las variables `BANDAIT_SUPABASE_URL` y
`BANDAIT_SUPABASE_KEY`, luego `supabase_url` y `supabase_key` en `leader_config.json`, y por
último el proyecto de producción. Solo se aceptan claves públicas: se rechazan las que
empiezan por `sb_secret_` y los JWT con `role: service_role`.

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

## Instalador y releases

**Qué recibe el usuario.** `BandaitLeader-Setup-X.Y.Z.exe` (Windows 10/11, 64 bits) instala
para todo el equipo en `C:\Program Files\Bandait Leader` (pide administrador), con acceso
en el menú Inicio y, si se marca, en el escritorio. Abre el Firewall de Windows para
`BandaitLeader.exe`: entrada TCP, **solo redes privadas** (los teléfonos llegan al puerto
4040); la regla se borra al desinstalar. No descarga nada al instalar. Desinstalar no toca
`Documentos\Bandait` (base de datos, grabaciones, registros).

**Aviso de SmartScreen.** El instalador no está firmado. La primera vez Windows muestra
"Windows protegió su PC": pulse **Más información** y luego **Ejecutar de todas formas**.
Para comprobar la descarga: `Get-FileHash .\BandaitLeader-Setup-X.Y.Z.exe` y comparar con
`SHA256SUMS` del Release.

**Red del escenario.** Si Windows marcó la red como pública, los teléfonos no conectan:
*Configuración > Red e Internet > (la red) > Tipo de perfil de red: Privada*.

**Registros.** `Documentos\Bandait\logs\bandait-leader.log` (rota en 5 archivos de 2 MB) y
`bandait-leader-crash.log` (volcado de cierres nativos, por ejemplo de un driver ASIO). Con
`BANDAIT_HOME` definido, en `%BANDAIT_HOME%\logs`. Para un instalador que falla:
`BandaitLeader-Setup-X.Y.Z.exe /LOG="%TEMP%\bandait-setup.log"`.

**Chequeo de una instalación** (no abre audio ni toca la base; servidor en `127.0.0.1` y
puerto efímero; JSON y código 0 si todo está bien):

```
$p = Start-Process "C:\Program Files\Bandait Leader\BandaitLeader.exe" -ArgumentList '--smoke-test','--smoke-out',"$env:TEMP\bandait-smoke.json" -Wait -PassThru
$p.ExitCode; Get-Content "$env:TEMP\bandait-smoke.json"
```

El exe no tiene consola: PowerShell y cmd no lo esperan ni muestran su salida, de ahí
`Start-Process -Wait` y `--smoke-out`. Desde Git Bash sí espera e imprime el JSON.

**Publicar una versión.**

1. Subir `APP_VERSION` en `src/ui/main_window.py` (la única constante de versión) y
   `version` en `pyproject.toml`; `tests/test_packaging.py` exige que coincidan.
2. Integrar en `main` y luego: `git tag vX.Y.Z && git push --tags`.
3. `.github/workflows/release.yml` (windows-latest, Python 3.11) comprueba que el tag sea
   `v` + `APP_VERSION`, corre `tests/test_packaging.py`, compila con PyInstaller, ejecuta el
   exe con `--smoke-test` como un doble clic (sin consola), arma el instalador con Inno Setup
   y sube como artefactos el instalador, el zip portátil, `NOTICE.md` y `SHA256SUMS`. En un
   tag crea el GitHub Release con el instalador, `NOTICE.md` y `SHA256SUMS`; los archivos
   *Source code* que GitHub agrega a cada Release son la oferta de código fuente de la GPL.
   *Actions > Release (lider Windows) > Run workflow* hace lo mismo sin Release.

**Build local** (mejor en un venv limpio: lo que haya instalado se puede colar en el
paquete; `scripts/build_exe.py` excluye los casos conocidos):

```
cd bandait-leader
pip install -r requirements.txt pyinstaller
python scripts/build_exe.py                       # dist/BandaitLeader/ (onedir, ~140 MB)
dist/BandaitLeader/BandaitLeader.exe --smoke-test # desde Git Bash
iscc /DMyAppVersion=X.Y.Z scripts\installer.iss   # Inno Setup 6
```

*Onedir* y no *onefile*: onefile se descomprime en `%TEMP%` en cada arranque (lento, y el
antivirus lo revisa cada vez). El ícono sale de `python scripts/make_icon.py`.

**ASIO y PortAudio.** *Dispositivos de Audio > Habilitar ASIO* y reiniciar;
`BANDAIT_ASIO=1` o `BANDAIT_ASIO=0` lo fuerzan. Si otro programa dejó un `portaudio.dll`
en el `PATH`, Bandait lo ignora, usa el suyo y lo avisa en el registro, la barra de estado
y el diálogo de audio (`src/audio/portaudio_setup.py`).

**Tiempo real.** Al arrancar se piden un temporizador de Windows de 1 ms y
`sys.setswitchinterval(0.001)` (sin el temporizador, el intervalo no tiene efecto en
Windows), se desactiva la limitación de energía del proceso y se congela el heap de
arranque del recolector (`gc.freeze()`). Mediciones y política: `src/audio/rt_policy.py`.
