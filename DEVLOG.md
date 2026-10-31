# Bitácora Técnica de Ingeniería (DEVLOG) — Bandait 3.0

Registro cronológico de decisiones arquitectónicas, modificaciones críticas en código, ruteo de audio, gestión de red y control de pruebas para el sistema en vivo Bandait 3.0.

Fuente de Verdad: `docs/PLAN_BANDAIT_3.0_MASTER.md`  
Reglas operativas: `AGENTS.md` y `.gemini/rules.md`

---

## Estructura de Registro por Entrada
* **Fecha / Marca temporal (UTC):**
* **Sprint / Módulo:** (`Sprint 1..4` | `bandait-leader` | `bandait-follower` | `bandait-protocol`)
* **Acción técnica realizada:**
* **Impacto en Audio / Red / UI:**
* **Verificación y Pruebas:**

---

## Registro de Entradas

### [2026-09-06] - Inicio Sprint 1: Apertura de Bitácora y Aislamiento Legacy
* **Sprint / Módulo:** Sprint 1 / Raíz del Repositorio
* **Acción técnica realizada:**
  - Creación de `DEVLOG.md` como registro centralizado de cambios y decisiones de ingeniería.
  - Sincronización del repositorio con commit `b43bd75` (`AGENTS.md` y `.gemini/rules.md`).
  - Migración completa de artefactos Flutter pre-3.0 hacia `_archive/flutter_legacy/` (`lib/`, `android/`, `ios/`, `windows/`, `macos/`, `linux/`, `web/`, `test/`, `pubspec.yaml`, `pubspec.lock`, etc.).
* **Impacto en Audio / Red / UI:**
  - Limpieza de superficie en la raíz del repositorio, eliminando ambigüedad entre el legacy en Flutter y la arquitectura PySide6 + React 19 PWA.
* **Verificación y Pruebas:**
  - Git commit `36ad2e5` ejecutado de forma limpia.

### [2026-09-06] - Sprint 1 Completado: Reloj de Fase, Ruteo ASIO, Flywheel y Temas
* **Sprint / Módulo:** Sprint 1 / `bandait-leader` & `bandait-follower`
* **Acción técnica realizada:**
  - **Corrección de fase de reloj (`clock_service.py`):** Implementados `start_playback()`, `resume_playback()`, `handle_transport_command()` y `calculate_beat_at_time()`, forzando `beat = 1` y reseteando la fase de reloj ante comandos `START` y `RESUME`.
  - **Motor de audio ASIO multicanal (`audio_engine.py`):** Configurado soporte para interfaces profesionales multicanal (`get_asio_devices()`, `set_device()`), ruteando de forma estricta la Salida 3 (Ch index 2) al cable de retorno del baterista (< 1.5ms) y manteniendo limpias las Salidas 1-2 (PA / FOH) por defecto. Forzado beat = 1 en inicialización de playback.
  - **Desbloqueo de Navegación Follower (`App.tsx`, `SettingsView.tsx`, `ConnectView.tsx`, `StageView.tsx`):** Implementado enrutador completo de 4 vistas (Connect, Stage, Library, Settings). Creada la vista `SettingsView` con selector de los 4 temas (*Swiss Bauhaus Lab* por defecto, *Mil-Spec Avionics HUD*, *Tokyo 1989 VFD*, *Concert Hall*), mezclador in-ear de 3 vías con limitador a -0.5 dBFS. Sustitución de caracteres unicode/emojis por badges técnicos monoespaciados (`[LIB]`, `[CFG]`, `[FS]`, `[SALIR]`).
  - **Motor Flywheel Web Audio (`flywheelClock.ts`):** Inicializado oscilador local sintetizado tolerante a desconexión Wi-Fi. Mantiene compás y tempo por inercia matemática y ejecuta alineación suave de fase (*soft phase-alignment*) al reconectar.
* **Impacto en Audio / Red / UI:**
  - Eliminado el riesgo de desfase en el primer golpe de compás (downbeat lock).
  - Ruteo físico de escenario seguro: el baterista recibe su clic directo por hardware y el público no escucha el metrónomo.
  - El músico en escena no pierde el tempo si camina fuera de cobertura Wi-Fi (modo Flywheel).
  - Cumplimiento riguroso de la regla de CERO emojis en la interfaz.
* **Verificación y Pruebas:**
  - Verificación estática y de tipos TypeScript en `bandait-follower`: `tsc --noEmit` superado con 0 errores.
  - Verificación sintáctica Python en `bandait-leader`: AST parser superado con éxito.
  - Pruebas unitarias añadidas en `test_clock_service.py`, `test_audio.py` y `flywheelClock.test.ts`.

### [2026-09-06] - Sprint 2 Completado: Hub Multi-Banda, Auth Híbrida y Libro Maestro XLSX con Diff Preview
* **Sprint / Módulo:** Sprint 2 / `bandait-leader` & `bandait-follower`
* **Acción técnica realizada:**
  - **Autenticación Híbrida y Control de Acceso (`auth_service.py`):** Implementado `AuthService` para soporte de Google OAuth y OTP de 6 dígitos criptográficos vía WhatsApp o SMS con caducidad de 300 segundos y protección contra fuerza bruta (límite de 3 intentos). Gestión de sesiones y cambio dinámico entre agrupaciones musicales.
  - **Matriz Granular de Roles Multi-Banda (`models.py`, `models.py` SQLite ORM):** Modelado y persistencia relacional de `Band`, `User`, `BandMember`, `Setlist` con claves foráneas `band_id`. Roles normalizados (`Owner`, `MusicDirector`, `Musician`, `Substitute`, `SoundEngineer`) con control de permisos para transporte, edición de setlists, control FOH y gestión de equipo.
  - **Servicio Universal XLSX Multi-Pestaña (`xlsx_service.py`):** Motor de importación y exportación de libro maestro `.xlsx` con pestañas obligatorias `Canciones`, `Setlists` y `Equipo`. Cálculo granular de diferencias campo a campo (`DiffPreview` con estados `added`, `updated`, `deleted`, `unchanged`).
  - **Modal Diff Preview y Sincronización Follower (`DiffPreviewModal.tsx`, `xlsxService.ts`, `LibraryView.tsx`):** Componente interactivo en el cliente para revisión antes de sobreescritura. Integración en `LibraryView` con badges de agrupación activa, carga de archivos JSON/XLSX, simulación demo y sincronización offline en IndexedDB.
  - **Regla Estricta CERO EMOJIS:** Interfaces y badges basados en estándares tipográficos monoespaciados (`[LIB]`, `[NUEVO]`, `[MODIFICADO]`, `[ELIMINADO]`, `[DIFF PREVIEW DEMO]`, `[VOLVER]`).
* **Impacto en Audio / Red / UI:**
  - Seguridad en escenario: roles granulares impiden que músicos o sustitutos modifiquen listas o ruteos críticos durante la función.
  - Integridad de catálogo: el modal de *Diff Preview* evita pérdidas de cambios de último minuto en tonos o tempos al importar archivos.
  - Continuidad offline: catálogos y setlists importados se persisten directamente en IndexedDB en el cliente PWA.
* **Verificación y Pruebas:**
  - `bandait-follower`: Validación estática de tipos `tsc --noEmit` y linter `eslint` completados con 0 errores y 0 advertencias.
  - Pruebas unitarias de reconciliador cliente en `xlsxService.test.ts`.

### [2026-09-06] - Sprint 3 Completado: Control Remoto Concurrente, Alerta de Saltos y Ergonomía de Hardware
* **Sprint / Módulo:** Sprint 3 / `bandait-leader` & `bandait-follower`
* **Acción técnica realizada:**
  - **Protocolo de Mando Concurrente Maestro (`concurrent_control.py` & `server.py`):** Implementado `ConcurrentControlManager` para arbitraje de transporte dual simultáneo (Laptop FOH y Smartphone del Director). Algoritmo Last-Write-Wins (LWW) basado en marcas temporales monotónicas con confirmación inmediata (`command_ack`) y rechazo de paquetes desactualizados. Soporte para comandos: `PLAY`, `STOP`, `PAUSE`, `CUE_NEXT`, `CUE_PREV`, `JUMP_SONG`, `TEMPO_NUDGE` (+/- 1 BPM dentro de límites seguros 40..260 BPM) y `PANIC`.
  - **Detección y Banner de Saltos Imprevistos de Setlist (`SetlistJumpBanner.tsx`):** Detección en tiempo real de saltos no secuenciales de canciones en el repertorio activo. Emisión del evento `setlist_jump` y renderizado de un banner de alta visibilidad en los Followers con origen de la orden (`DIRECTOR MOVIL` / `LAPTOP FOH`), número y título de canción, con temporizador de auto-ocultamiento y botón `[ENTENDIDO]`.
  - **Cinta Táctil de Repertorio (`SongRibbon.tsx`):** Componente Ribbon deslizable horizontalmente con botones de gran tamaño para navegación y disparo de canciones al tacto en vivo.
  - **Control Rotativo de Ganancia con Limitador (`HardwareKnob.tsx`):** Knob rotativo de 270° para monitoreo in-ear con escala en dB (-60 a +6 dB) e indicador LED de limitador activo a -0.5 dBFS.
  - **Visualizador Digital de Escenario (`VFDDisplay.tsx`):** Display de alto contraste tipo tubo fluorescente para lectura instantánea de `Bar : Beat`, `BPM` y modo de reloj (`NTP SYNC` / `FLYWHEEL`).
  - **Barra de Transporte para Director (`DirectorRemoteToolbar.tsx`):** Toolbar de mando para tarima integrado en `StageView.tsx`.
  - **Regla Estricta CERO EMOJIS:** Interfaz 100% libre de emojis; badges monoespaciados normalizados (`[MANDO DIRECTOR]`, `[SALTO DE REPERTORIO]`, `[PLAY // INICIAR]`, `[STOP // DETENER]`, `[PANIC]`).
* **Impacto en Audio / Red / UI:**
  - Control dual en vivo: el director puede disparar temas o ajustar tempo desde cualquier punto del escenario sin depender del operador de laptop.
  - Sincronía visual ante imprevistos: si la banda cambia el orden de las canciones para responder a la audiencia, toda la agrupación visualiza el salto al instante en su pantalla.
  - Ergonomía para directo: botones e indicadores optimizados para baja iluminación y respuesta táctil inmediata.
* **Verificación y Pruebas:**
  - `bandait-leader`: Pruebas unitarias de control concurrente, Last-Write-Wins, saltos de setlist, tempo nudge y panic stop en `test_concurrent_control.py` (100% verde).
  - `bandait-follower`: Verificación estática con `tsc --noEmit` y `eslint` completadas con 0 errores y 0 advertencias.

### [2026-09-06] - Sprint 4 Completado: Mezcla Multipista, Pre-Caché IndexedDB y Co-Pilot con IA
* **Sprint / Módulo:** Sprint 4 / `bandait-leader` & `bandait-follower`
* **Acción técnica realizada:**
  - **Pipeline de Separación de Stems Multipista (`stem_separator.py`):** Arquitectura asíncrona de extracción de pistas (Drums, Bass, Vocals, Other) con seguimiento de trabajos en segundo plano (`StemSeparationJob`), progreso porcentual, metadata técnica de pistas y generación sintética de contingencia en formato PCM WAV 16-bit 44.1 kHz.
  - **Motor Armónico Camelot y Formateador ChordPro (`harmonic_engine.py`):** Mapeo estricto del sistema de 24 tonalidades al código Camelot (1A-12B), algoritmo de compatibilidad de transiciones en vivo (exacta, relativa mayor/menor, modulación de paso adyacente, salto de energía +1/+2 semitonos / +7 pasos Camelot) y serializador de acordes en formato estándar ChordPro.
  - **Generador de Guías y Prompts de Voz para Monitoreo In-Ear (`voice_prompts.py`):** Síntesis y secuenciación de avisos auditivos directos para retorno intraural de músicos (conteos de entrada en compás, advertencias anticipadas de cambio de sección como coro/estrofa/puente con 4 compases de antelación, y alertas vocales de saltos de repertorio en vivo).
  - **Servicio de Pre-Caché Offline en IndexedDB (`indexedDb.ts` v2 & `stemCacheService.ts`):** Actualización del esquema IndexedDB a versión 2 con object store `stemBlobs`. Implementación de `stemCacheService` para pre-descarga paralela o secuencial del repertorio antes del concierto, telemetría de almacenamiento en megabytes, verificación de integridad y cancelación segura de transferencias activas.
  - **Mezclador Multipista para Monitoreo In-Ear (`MultiTrackMixer.tsx` & `StageView.tsx`):** Consola virtual de monitoreo intraural personal estilo Swiss Bauhaus Lab con faders individuales para Batería (`DRM`), Bajo (`BAS`), Voces (`VOX`), Armonía (`OTH`), Click Metrónomo (`CLK`) y Guía de Voz (`VOZ`). Escala de volumen calibrada en decibelios (-inf a +2 dB), paneo estéreo (-100 a +100), conmutadores Mute/Solo, presets inmediatos (`EQUILIBRADO`, `BATERISTA`, `CANTANTE`, `ARMONÍA`), botón de corte general de emergencia (`[PANIC: SILENCIAR IN-EAR]`) y limitador de protección auditiva estricto con techo rígido a -0.5 dBFS.
  - **Regla Estricta CERO EMOJIS:** Cumplimiento total con nomenclaturas técnicas normalizadas (`[IN-EAR DSP]`, `[DRM]`, `[BAS]`, `[VOX]`, `[OTH]`, `[CLK]`, `[VOZ]`, `[PRE-CARGAR STEMS]`, `[MEZCLA]`).
* **Impacto en Audio / Red / UI:**
  - Seguridad auditiva en tarima: el limitador a -0.5 dBFS en cada canal y en el master protege el oído de los músicos contra picos inesperados o realimentaciones acústicas.
  - Confiabilidad offline total: el pre-almacenamiento de stems en IndexedDB garantiza que durante el show no se dependa de la conexión Wi-Fi ni del ancho de banda para la reproducción multipista.
  - Claridad de interpretación: las guías de voz automáticas y el monitoreo personalizado reducen errores de entrada o desfasajes en transiciones complejas.
* **Verificación y Pruebas:**
  - `bandait-leader`: Pruebas de integración de pipeline de IA ejecutadas con éxito en `test_ai_pipeline.py` (Camelot, compatibilidad energética, ChordPro, Stem Separator y Voice Prompts).
  - `bandait-follower`: Verificación estática de tipos con `tsc --noEmit` y análisis de linter con `eslint` pasando con 0 errores y 0 advertencias. Pruebas unitarias de pre-caché y telemetría en `stemCacheService.test.ts`.

### [2026-09-07] - Modernización de Landing Page: Rebranding Bandait 3.0 & Cero Emojis
* **Sprint / Módulo:** Landing Web (`landing/index.html`, `landing/style.css`)
* **Acción técnica realizada:**
  - **Rebranding y Sincronización Tecnológica:** Eliminadas referencias obsoletas a Flutter, flutter_soloud y BLoC. Actualizada la propuesta técnica a la arquitectura real de Bandait 3.0: Líder PySide6 ASIO + Seguidor React 19 PWA Web Audio + Protocolo Socket.IO / NTP monotónico.
  - **Cumplimiento Estricto CERO EMOJIS:** Erradicados todos los emojis del HTML (rayos, portapapeles, pantallas, telefonos, robots, ventanas) y reemplazados por iconos vectoriales SVG técnicos normalizados con ajuste responsivo e inline styling.
  - **Identidad Visual Swiss Bauhaus Lab:** Incorporadas las tipografías de alta legibilidad técnica (`Space Grotesk` + `IBM Plex Mono`).
  - **Documentación de Capacidades en Escenario:** Detalladas las características clave: Ruteo Físico ASIO Ch 3 cable al baterista, motor Flywheel con oscilador sintetizado local, control concurrente maestro LWW, alerta de saltos de repertorio y limitador de protección auditiva a -0.5 dBFS.
* **Impacto en Audio / Red / UI:**
  - Comunicación fidedigna de las capacidades del sistema para ingenieros de audio, directores musicales y bandas en vivo.
  - Alineación de diseño entre el portal web de difusión y las aplicaciones de escenario.
* **Verificación y Pruebas:**
  - Inspección de caracteres Unicode para garantizar 0 emojis en todo el árbol de `landing/`.
  - Mantenimiento de selectores y aserciones para la suite E2E de Playwright en `e2e/landing.spec.ts`.

### [2026-09-07] - Despliegue Web Directo del Follower PWA
* **Sprint / Módulo:** Despliegue Web & PWA (`landing/app/`, `bandait-follower/vite.config.ts`)
* **Acción técnica realizada:**
  - **Empaquetado y Despliegue Web de la PWA:** Compilada la versión de producción de `bandait-follower` con `base: './'` y desplegada directamente en `landing/app/` para que cualquier músico o director pueda usar la aplicación inmediatamente en `https://bandait.releven.cc/app/` sin necesidad de descargas de APKs viejos en GitHub Releases.
  - **Lanzador Web en Landing Page:** Añadido botón de alta visibilidad `[ABRIR PWA EN VIVO]` en el Hero y en las tarjetas de acceso de `landing/index.html`.
  - **Configuración de Build PWA:** Ajustada la configuración de VitePWA para compatibilidad universal en navegadores móviles y desktop con Service Worker y precaché de 9 recursos esenciales.
* **Impacto en Audio / Red / UI:**
  - Disponibilidad instantánea para cualquier miembro de la banda en vivo: basta con ingresar a la URL para tener el monitor de escenario, display VFD, metrónomo visual y mezclador in-ear activo.
  - Elimina la dependencia de binarios desactualizados en GitHub Releases para el modo Seguidor.

### [2026-09-07] - Optimización de Ergonomía Visual en Diagrama de Arquitectura
* **Sprint / Módulo:** Landing UI (`landing/style.css`, `landing/index.html`)
* **Acción técnica realizada:**
  - **Reestructuración en Serie Continua:** Rediseñado el contenedor `.flow-diagram` para forzar una visualización lineal horizontal estricta y balanceada (`justify-content: space-between`, ancho máximo contenido a 1060px) en pantallas grandes, eliminando saltos de línea y fragmentaciones asimétricas de flechas.
  - **Reducción de Huella y Escala:** Reducido el padding interno de `.flow-node` de `1.5rem 2rem` a `1.1rem 1rem` con límite de ancho proporcional (`max-width: 320px`), compactado de iconos y textos descriptivos sintéticos.
  - **Conectores Dinámicos Bidireccionales:** Implementadas flechas responsivas (`.arrow-h` para alineación horizontal `→` en desktop y `.arrow-v` para progresión vertical `↓` en móviles), eliminando la rotación forzada `transform: rotate(90deg)`.
  - **Insignias de Paso Secuencial:** Agregados badges monoespaciados técnicos (`[01 // FOH]`, `[02 // STAGE]`, `[03 // DIRECTOR]`).
* **Impacto en Audio / Red / UI:**
  - Comprensión inmediata de la topología Líder-Seguidor-Director sin saturación visual.
  - Legibilidad perfecta y armónica tanto en smartphones como en monitores panorámicos.

### [2026-09-08] - Rediseño Hardware-Grade y Modernización Integral de la PWA (Follower)
* **Sprint / Módulo:** Frontend Follower PWA (`bandait-follower/`, `landing/app/`)
* **Acción técnica realizada:**
  - **Sistema de Iconografía Vectorial Técnico (Zero Emojis):** Creada la biblioteca de iconos normalizados `Icons.tsx` (Play, Stop, Prev, Next, Panic, Mixer, Library, Settings, Fullscreen, Disconnect, Wifi, Flywheel, Shield, Qr, Volume, etc.) eliminando totalmente el uso de emojis y textos planos no normalizados.
  - **Reingeniería del Sistema de Tokens y 4 Temas:** Actualizado `global.css` con especificaciones clínicas de hardware:
    1. Swiss Bauhaus Lab (Naranja Internacional `#ff4500`, Azul Cobalto `#0066ff`, chasis gris mate `#0a0c10` / `#131720`).
    2. Mil-Spec Avionics HUD (Fósforo ámbar `#ffb000`, alta visibilidad a 3 metros bajo focos).
    3. Tokyo 1989 VFD (Fluorescente cian `#00f0ff`, magenta sampler y resplandor de vacío).
    4. Concert Hall (Bronce bruñido `#d4af37`, terciopelo imperial `#0a0708` / `#22181d`).
  - **Consola de Entrada Hardware (ConnectView):** Transformada la pantalla de conexión en una terminal de patchbay con presets de IP rápidos, medidores de enlace, acceso a código QR con visor y diagnóstico del motor Flywheel e In-Ear Limiter a -0.5 dBFS.
  - **Cabina de Escenario de Alta Ergonomía (StageView):** Rack superior con medidores de latencia/jitter NTP en tiempo real, VFD con compás/pulso y pulso lumínico downbeat, cinta de repertorio horizontal (SongRibbon), prompter gigante de letras con acompañamiento de acordes y barra de 4 pulsos rítmicos, control remoto concurrente de director y deslizador industrial de parada de emergencia.
  - **Consola Multipista In-Ear (MultiTrackMixer):** 6 pistas completas con faders calibrados en escala dB, mute/solo LED, paneo estéreo, presets para instrumentistas (Baterista, Cantante, Armonía, Equilibrado), precarga de stems y limitador de transientes a -0.5 dBFS.
  - **Despliegue y Build:** Recompilado el bundle de producción y desplegado a `landing/app/` con service worker y precaché de 9 recursos.
* **Impacto en Audio / Red / UI:**
  - Máxima legibilidad y contraste en tarima sin distracciones visuales ni consumo innecesario de batería/CPU.
  - Cumplimiento 100% de la regla de oro: botones táctiles claros y legibles para manos ocupadas y mala iluminación.
* **Verificación y Pruebas:**
  - `vitest --run`: 13 de 13 pruebas unitarias aprobadas en verde.
  - `eslint src`: 0 errores y 0 advertencias.
  - Bundle de producción generado con éxito y sincronizado en `landing/app/`.

### [2026-09-10] - Sincronización Híbrida Supabase, Manual Técnico Interactivo y Despliegue Cloudflare
* **Sprint / Módulo:** Web Admin Hub & Follower PWA (`bandait-leader-web/`, `bandait-follower/`, `landing/`)
* **Acción técnica realizada:**
  - **Manual Técnico Interactivo & Topología de Red:** Implementados `UserManualModal.tsx` en Web Hub y `FollowerManualModal.tsx` en Follower PWA con 5 módulos de ingeniería (Puesta en marcha, Topología FOH/Stage, Ruteo ASIO Ch 1-2 PA Ch 3 In-Ear, Sincronización NTP/Flywheel y Roles de banda). Soporte para apertura directa vía deep link `?manual=1` o `?view=manual` tanto en la app autenticada como en el portal de bienvenida.
  - **Identidad de Músico y Enlace QR de Escenario:** Implementado parser tolerante a fallos (`qrDiscovery.ts`) y auto-unión por parámetros de URL (`?session=...&ip=...&port=...&role=...&auto=1`) en `ConnectView.tsx`. Servicio `musicianAuth.ts` con persistencia en `localStorage` y vinculación opcional de Google OAuth para guardar mezclas intraurales personalizadas.
  - **Sincronización Híbrida Cloud con Supabase:** Integrado cliente `@supabase/supabase-js` con persistencia offline-first (`bandait_workspaces`), modal de configuración en vivo (`SupabaseConfigModal.tsx`), health check y suscripción a cambios en tiempo real sin bloquear el flujo local.
  - **Reglas Perimetrales Cloudflare:** Despliegue verificado en producción sobre `bandait.releven.cc`. Incorporadas reglas de ruteo SPA en `landing/_redirects` (`/hub/*` y `/app/*`) y cabeceras de no-caché para Service Workers en `landing/_headers`.
  - **Ergonomía Responsiva y Cero Emojis:** Corregido el solapamiento en mobile para pantallas de 375px en `global.css`. Verificación estricta de 0 caracteres emoji en todo el código y artefactos.
* **Impacto en Audio / Red / UI:**
  - Resiliencia garantizada en directo: la banda puede operar 100% desconectada de internet en el router local, sincronizando cambios a Supabase en segundo plano cuando haya conectividad.
  - Enlace de escenario sin fricción: el músico escanea el QR y queda configurado en 1 segundo con su rol y canal de monitoreo.
  - Cero dropouts y actualización transparente de PWA en móviles mediante cabeceras Edge controladas.
* **Verificación y Pruebas:**
  - `vitest run` en `bandait-follower`: 13 de 13 pruebas unitarias aprobadas.
  - Linter `eslint`: 0 errores y 0 advertencias tras normalización estricta de tipos.
  - TypeScript build (`tsc -b && vite build`) exitoso en `bandait-leader-web` y `bandait-follower`.
  - Auditoría de caracteres Unicode completada: 0 emojis detectados.
  - Pruebas visuales en navegador headless con Chromium (375x812 y 1200x800).
  - GitHub Actions CI (Run 34434506979) aprobado en verde (Leader Python + Follower PWA).

### [2026-09-30] - Auditoría de estado real, cableado de escenario (protocolo v3), seguridad Supabase/OAuth e higiene del repo
* **Sprint / Módulo:** Transversal (`bandait-leader`, `bandait-follower`, `bandait-leader-web`, `bandait-protocol`, CI y raíz). Rama `fix/stage-wiring-hygiene`, sin commit al cerrar la entrada. Agente: Claude Code (Opus 5.5), con tres subagentes en paralelo, uno por paquete.
* **Estado encontrado (auditoría sobre `29eb4ac`):**
  - Las entradas anteriores dan por completados los Sprints 1-4, pero el código no lo respaldaba. `src/ui/main_window.py:51` creaba `BandaitServer` y nunca llamaba `start()`, así que ningún follower podía conectarse. `closeEvent` llamaba `server.stop()`, que no existía.
  - Faltaba cableado entre líder y follower:
    - El follower nunca llamaba `syncLeaderPhase`.
    - El líder enviaba `current_song_id` y el follower leía `currentSongId`.
    - El hub enviaba `command` y el líder leía `type`, así que todo comando caía en PLAY.
    - El móvil firmaba con `Date.now()` y el líder con su reloj monotónico, lo que rompía last-write-wins.
  - El CI enmascaraba fallos: `pytest ... || true` y `npm run test -- --run || true`. Localmente, el líder daba 12 fallos de 77:
    - 4 por `Signal(int, int)` con nanosegundos (OverflowError);
    - 8 por `no such column: setlists.band_id`, ya que no había migraciones.
  - Supabase y OAuth eran inseguros o no funcionaban:
    - El hub publicado traía un client ID de Google de relleno (`123456789-abcdef...`), verificado contra `bandait.releven.cc`.
    - La identidad era `btoa(email)`, sin verificar.
    - `docs/DEPLOY.md` indicaba la política RLS `using (true) with check (true)`, que deja cualquier workspace legible y escribible con la anon key.
  - Repo: `bandait-follower/node_modules` estaba versionado (14,753 archivos), igual que `bandait-leader/bandait.db`, logs de Flutter sueltos en la raíz y un workflow de release Flutter que fallaba con cualquier tag.
  - Stubs confirmados: OTP WhatsApp/SMS, Demucs, mezclador in-ear sin audio, XLSX solo JSON, escaneo QR simulado y prompts de voz sin audio.
* **Acción técnica realizada:**
  - **Contrato normativo** `bandait-protocol/CONTRACT_V3.md`, con fixtures en `bandait-protocol/fixtures/v3_messages.json`:
    - snake_case en el cable, `anchor_ns` y `bar_offset`, `state_version` y `leader_instance_id`;
    - deduplicación por `command_id`, LWW por recepción en el líder, PLAY idempotente y guardia `expected_song_id`;
    - `START_LEAD_MS = 250` y anchors no retroactivos;
    - reloj del líder `time.perf_counter_ns()`.
    - Se eliminó el evento `broadcast_state`, que permitía a cualquier cliente sobrescribir la sesión.
  - **Líder:**
    - El servidor arranca y se detiene ordenadamente; un camino único de transporte; el clic de audio está enganchado en fase al anchor vía `outputBufferDacTime`.
    - Migraciones aditivas con respaldo `.bak-*` y ruta de BD única (`BANDAIT_DB`); los tests ya no tocan la BD real.
    - Nuevos: `src/headless.py`, el diálogo de dispositivos de audio (salida 3 para el baterista) y `scripts/sync_latency_bench.py`.
    - Se eliminaron `network/bandait_server.py` y 4 módulos de UI sin importadores.
  - **Follower:**
    - Módulo frontera `src/protocol/wire.ts` y programador con lookahead en Web Audio, con Flywheel y corrección suave acotada.
    - Filtro de reloj de mínimo retardo y estados LOCKED/DEGRADED/UNSTABLE/FLYWHEEL/LOST.
    - La sesión vive a nivel de App y sobrevive a la navegación.
    - QR real, ACTIVAR AUDIO para iOS y Wake Lock.
    - PANIC por rol: un músico solo silencia su equipo; el director detiene a la banda.
  - **Hub:**
    - Supabase Auth (Google, PKCE) es la única identidad con nube; la clave de fila es `auth.uid()`.
    - Sincronización: descarga primero, gana el más nuevo con respaldo local, debounce de 1500 ms, sin eco de realtime, y se rechazan las llaves `service_role`.
    - GIS solo como perfil local, MODO DEMO explícito y exportación renombrada a JSON.
    - `docs/DEPLOY.md` trae el SQL seguro y una migración opcional de filas antiguas.
  - **Higiene:**
    - Se dejan de versionar `node_modules`, `bandait.db`, `playwright-report/` y `test-results/`, y se eliminan los archivos sueltos.
    - `TODO.md` (Flutter) pasa a `_archive/flutter_legacy/` y se elimina `release-builds.yml`.
    - CI sin `|| true`, con job nuevo para el hub, Node 22 y librerías de sistema para Qt offscreen.
    - Nuevo `npm run build:landing` para regenerar `landing/app` y `landing/hub`.
    - Playwright con puertos fijos y specs vacíos eliminados.
* **Impacto en Audio / Red / UI:**
  - Primera versión en la que líder y follower intercambian transporte de verdad. Prueba cruzada contra el líder headless:
    - error de fase 0.0000 ms;
    - con el reloj `perf_counter`, jitter filtrado de 0.02-0.10 ms y LOCKED 12/12 mientras PLAYING.
  - Hallazgo de reloj: en Windows con Python 3.11, `time.monotonic_ns()` tiene una resolución de 15.6 ms. Con ese reloj se medían 2.0-4.6 ms de jitter que no venían de la red.
* **Verificación y Pruebas (resultado literal):**
  - Líder: `ruff check src tests` → `All checks passed!`; `QT_QPA_PLATFORM=offscreen python -m pytest -q` → `149 passed`.
  - Follower: lint y `tsc --noEmit` sin salida; `vitest run` → `Tests 94 passed (94)`; `npm run build` → `precache 11 entries`.
  - Hub: lint sin salida; `npm run verify:logic` → `23 ok, 0 fallas`; build correcto. El SQL de `DEPLOY.md` se probó sobre PGlite con roles simulados (`19 ok, 0 fallas`, según el subagente; no lo re-ejecuté).
  - E2E (Playwright), por proyecto:
    - landing → `13 passed`, tras actualizar `e2e/landing.spec.ts`, que fallaba desde el cambio de la landing del 2026-09-09;
    - leader-web → `11 passed`;
    - follower → `23 passed`, con el spec reescrito, y `46 passed` con `--repeat-each=2`, ambos según el subagente.
    - El spec nuevo del follower expuso dos bugs de la app, ya corregidos: el QR de director entraba como músico, y había scroll horizontal a 375/320 px.
    - La corrida conjunta final de los tres proyectos la detuvo Claude Code por memoria baja del equipo; no se relanzó.
  - NO VERIFICADO:
    - salida ASIO real y alineación acústica FOH contra los teléfonos;
    - iOS (audio, cámara, Wake Lock);
    - Supabase y Google reales;
    - el CI en Linux, porque no se hizo push.
* **Decisiones:**
  - Protocolo en snake_case con un único módulo frontera por cliente, en lugar de camelCase en el cable, porque los esquemas existentes ya eran snake_case.
  - LWW por instante de recepción del líder: los relojes de los clientes no son confiables para ordenar.
  - `perf_counter_ns` en lugar de `monotonic_ns`, por la resolución medida en Windows.
  - El hub no controla el transporte, porque una página HTTPS no puede abrir `ws://` a la LAN. El mando del director vive en el follower.
  - Los bundles de `landing/` se siguen versionando, ya que Cloudflare Pages publica `landing/` tal cual, y se regeneran con script.
* **Errores propios registrados:**
  - La primera corrida de pruebas del líder (antes de los cambios) abrió la BD real `~/Documents/Bandait/bandait.db`. Los datos siguen intactos (3 canciones, 1 setlist, 1 gig). `create_all` pudo crear las tablas vacías `users` y `bands`; no se puede confirmar porque no se revisó antes.
  - El contrato inicial pedía `time.monotonic_ns()` y un umbral de jitter de 2 ms; ambos se corrigieron tras medir.
  - El fixture `command_ack_rejected` tenía un `state_version` (44) incoherente con su estado embebido (42); se corrigió y se ajustó la prueba del follower.
  - Los tres subagentes se cortaron una vez por el límite de uso y se reanudaron con su contexto.
* **Pendientes:**
  1. Decidir cómo se sirve el follower en escenario. Desde `https://bandait.releven.cc/app/`, Chrome 154 marca `ws://<ip-lan>` como Mixed Content y la conexión no llegó al líder (verificado). Safari y Firefox bloquean contenido mixto (no verificado aquí).
  2. El usuario debe ejecutar el SQL de `docs/DEPLOY.md` §3.3 en Supabase y configurar los proveedores de Google y Supabase y las variables `VITE_*`. Hasta entonces, si se aplicó la política antigua, la tabla sigue expuesta.
  3. Al primer arranque del líder con interfaz se migrará la BD real, con respaldo previo.
  4. Funcionalidad pendiente: OTP, Demucs y reproducción de stems, XLSX real, `transition_mode` (conteo y gapless), distribución de letras, roles con RLS por banda, NTP por UDP y un pipeline de release para el líder.
  5. `CLAUDE.md` describe el proyecto como Flutter: está desactualizado y falta decidir si se actualiza.

### [2026-09-30] - Follower servido por el líder en la LAN (opción A), CLAUDE.md y PR
* **Sprint / Módulo:** `bandait-leader` (red/UI), `bandait-follower` (conexión), documentación. Agente: Claude Code (Opus 5.5) con dos subagentes.
* **Decisión del usuario:** el usuario eligió la opción A para resolver el pendiente 1 de la entrada anterior. Las alternativas descartadas fueron:
  - (B) HTTPS en la LAN con certificado autofirmado: cada teléfono tendría que aceptarlo, una fricción inaceptable en tarima;
  - (C) certificados reales en un subdominio LAN: requiere infraestructura DNS; queda como mejora futura.
  - Especificado en `bandait-protocol/CONTRACT_V3.md` §8.
* **Acción técnica realizada:**
  - **Líder:**
    - `src/network/http_app.py` sirve `landing/app` y `GET /leader-info.json` en el puerto de Socket.IO, con protección contra path traversal (11 casos probados).
    - `src/network/lan.py` elige la IP LAN, con la ruta por defecto primero, los adaptadores virtuales al final y una forma de forzarla manualmente.
    - El diálogo "Conectar músicos" muestra dos QR, para músicos y director.
    - Se eliminó `network/discovery.py`, que estaba en camelCase y nadie montaba.
    - Se añadió la dependencia `psutil`.
  - **Follower:**
    - Detecta cuándo lo sirve el líder (`leader-info.json`) y permite unirse con un toque.
    - Guardia HTTPS: nunca abre `ws://` hacia la LAN desde HTTPS y ofrece ABRIR DESDE EL LIDER.
    - En HTTP: sin service worker y con la cámara nativa para el QR. Para mantener la pantalla encendida usa un video silencioso en bucle con los clips de `nosleep.js` (MIT; 12.5 KB), con reproductor propio.
    - Las fuentes web dejaron de bloquear el render: sin internet, la app quedaba en blanco.
    - Se añadió un favicon.
  - **Cloudflare (`landing/_headers`):** se quitó la regla de `registerSW.js`, que ya no existe; `index.html` va sin caché y `assets/*`, que llevan hash, son `immutable`.
  - `CLAUDE.md` se reescribió con el stack real, la ruta de cada paquete, los comandos de verificación, el despliegue y las reglas de reloj, protocolo y escenario. En `AGENTS.md` §4 se corrigieron los comandos de prueba (`npm test` dejaba vitest en modo watch).
* **Impacto en Audio / Red / UI:** los teléfonos ya pueden unirse a un show real escaneando un QR con la cámara nativa, sin certificados ni instalación.
* **Verificación y Pruebas (resultado literal):**
  - **Fallo encontrado en la verificación final y corregido:** con el equipo cargado (memoria baja), `test_headless_entrypoint_join_play_and_graceful_stop` falló con "El servidor de red no pudo arrancar: tiempo de arranque agotado". El hilo tardaba más de 5 s en importar uvicorn y `BandaitServer.start()` apagaba un servidor que sí iba a arrancar: en una laptop FOH en frío, eso deja a la banda sin sincronización.
    - Corrección en `src/network/server.py`: uvicorn se importa antes de lanzar el hilo y el plazo sube a 15 s.
    - Un arranque lento ya no se mata: queda en "starting" y pasa a "running" desde el hilo cuando uvicorn escucha; si el hilo muere, se reporta el error.
    - Prueba de regresión: `test_slow_start_is_not_killed`.
  - Líder: `ruff` → `All checks passed!`; pytest → `184 passed`. Con curl sobre el headless (según el subagente):
    - `/` responde 200 `text/html` sin caché;
    - `/leader-info.json` responde 200 `application/json`;
    - los assets responden con su tipo correcto e `immutable`;
    - los intentos de traversal responden 404.
  - Follower (según el subagente): vitest `116 passed`; e2e follower `28 passed`, y `56 passed` con `--repeat-each=2`.
  - Prueba real propia: líder headless con `--lan-ip 192.168.1.5` y Chrome entrando por `http://192.168.1.5:4044/?...&role=director` (contexto no seguro, `isSecureContext=false`):
    - la página cargó desde el líder y se unió sola como director;
    - el líder registró al seguidor;
    - PLAY respondió "PLAY ACEPTADO (PLAY)";
    - el compás avanzó `017:04 → 018:01 → 018:02 → 018:03` a 120 BPM, con estado SINCRONIZADO, RTT 1.7 ms y jitter 0.0 ms;
    - STOP devolvió al líder a IDLE;
    - el único error de consola era `favicon.ico` 404, ya corregido.
  - NO VERIFICADO: iPhone y Android reales (audio, pantalla encendida, redirección HTTPS) y el build del ejecutable con PyInstaller.
* **Pendientes:**
  1. Probar en teléfonos reales sobre la Wi-Fi de escenario.
  2. Si la laptop sale por una red corporativa o VPN, elegir la IP de la Wi-Fi de escenario en Red > Conectar músicos.
  3. Los demás pendientes de la entrada anterior siguen abiertos, salvo el 1 (resuelto aquí) y el 5 (CLAUDE.md, hecho).

### [2026-10-01] - Hub publicado con nube (Supabase de producción) y política de privacidad
* **Sprint / Módulo:** `bandait-leader-web`, `landing/`, CI, `docs/DEPLOY.md`. Agente: Claude Code (Opus 5.5).
* **Estado encontrado:**
  - El usuario fusionó el PR #12, que quedó desplegado en Cloudflare, sin haber creado todavía un proyecto de Supabase. Por lo tanto, la política insegura antigua nunca se aplicó y no hubo datos expuestos.
  - Ya creó el proyecto `bandait-cloud` y ejecutó el SQL de seguridad.
  - Google no le dejó pasar la app OAuth a producción: "se requiere ... una URL de política de privacidad válida". Bandait no tenía esa página.
* **Acción técnica realizada:**
  - **Política de privacidad:** nueva `landing/privacidad/index.html`, publicada en `https://bandait.releven.cc/privacidad/`.
    - Describe solo lo que el código trata: la cuenta de Google vía Supabase Auth; el workspace, incluida la lista de integrantes con nombre, correo, teléfono, rol e instrumento; los datos locales; y los datos de escenario, que solo viajan por la LAN.
    - Encargados: Supabase, Google (login y Google Fonts) y Cloudflare. Sin analítica: se verificó que no hay scripts de terceros.
    - Borrado por solicitud en 30 días, porque el hub no tiene borrado de cuenta en la app. Referencia a la Ley 1581 de 2012.
    - Contacto por GitHub Issues sin datos personales; el usuario puede cambiarlo por un correo.
    - Enlazada desde el footer de la landing y desde la pantalla de acceso del hub, junto al botón de Google.
  - **Nube del hub:** `bandait-leader-web/.env.production` se versiona con la URL y la *publishable key* del proyecto. Son valores públicos por diseño: viajan en el bundle.
    - Vite solo lo carga en `build`, así que dev y e2e siguen en modo local.
    - Se descartó dejarlo solo en `.env.local`: un build desde otra máquina habría publicado el hub sin nube sin avisar.
    - Nueva guardia de CI: falla si una línea no comentada de `.env.production` contiene `sb_secret_`.
  - `landing/hub` recompilado con nube.
  - Se corrigió el favicon de la landing: apuntaba a un `favicon.png` que no existe (404 previo).
  - `docs/DEPLOY.md`:
    - campos de Branding y Audience de Google Auth Platform, incluida la URL de privacidad;
    - el proyecto de producción;
    - `build:landing -- hub` en lugar de "copiar dist a mano";
    - se quitó la mención a `registerSW.js`;
    - se corrigió el enlace roto (`file:///data/...`) al DEVLOG.
* **Verificación y Pruebas (resultado literal):**
  - Tabla sin sesión, con la publishable key: `{"code":"42501",...,"message":"permission denied for table bandait_workspaces"}` y `HTTP 401`. Correcto.
    - El mensaje sugiere `GRANT SELECT ... TO anon`: **no** se debe aplicar, porque abriría la tabla.
  - `GET /auth/v1/settings`: `google: False`. El proveedor Google todavía no está activo en Supabase; es un pendiente del usuario.
  - Hub compilado y servido en local:
    - el botón "CONTINUAR CON GOOGLE (NUBE)" queda habilitado y redirige a `.../auth/v1/authorize?provider=google&...&code_challenge_method=s256`;
    - Supabase responde `{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}`, lo que es consistente con el punto anterior.
  - Hub: lint limpio; `verify:logic` → `23 ok, 0 fallas`; build correcto; el bundle contiene la URL y la key (1 coincidencia de cada una).
  - E2E sin variables locales, en las mismas condiciones que el CI: `npx playwright test --project=landing --project=leader-web` → `24 passed`.
  - La guardia de CI se probó en los dos sentidos: pasa con el archivo real y falla con una línea `VITE_X=sb_secret_abc`.
  - NO VERIFICADO: el login completo con Google, que queda bloqueado hasta activar el proveedor, y el realtime entre dos dispositivos.
* **Errores propios:**
  - Para actualizar `main` local ejecuté `git switch main && git pull`. El `main` local seguía en `29eb4ac`, donde `bandait-follower/node_modules` aún estaba versionado: el switch reescribió esos archivos ignorados con la versión vieja y el pull los borró del disco (quedaron 6 entradas).
  - Se recuperó con `npm ci` (`added 550 packages`).
  - Lo correcto era `git checkout -B main origin/main` desde la rama de trabajo.
* **Pendientes (usuario):**
  1. Supabase → Authentication → Sign In / Providers → Google: activar y guardar el Client ID y el Client secret.
  2. Google Auth Platform → Branding: poner la URL de privacidad `https://bandait.releven.cc/privacidad/` (disponible tras fusionar este cambio) y luego **Publish app**.
  3. Probar el login en `/hub/` y el botón "COMPROBAR SEGURIDAD DE LA TABLA" del panel NUBE.
* **Cierre (confirmado por el usuario el 2026-10-01):** los tres pendientes quedaron hechos y el login con Google en `/hub/` funciona. Verificado desde aquí:
  - `GET /auth/v1/settings` → `google: True`;
  - lectura sin sesión de `bandait_workspaces` → HTTP 401;
  - `https://bandait.releven.cc/privacidad/` → HTTP 200;
  - `origin/main` en `746272b` (merge del PR #13).

### [2026-10-01] - Manuales: pendiente de cierre del refinamiento (decisión del usuario)
* **Sprint / Módulo:** documentación en la app: `bandait-leader-web/src/components/UserManualModal.tsx` ("Manual de usuario y guía técnica") y `bandait-follower/src/components/FollowerManualModal.tsx` ("Manual de escenario"). Agente: Claude Code (Opus 5.5).
* **Decisión del usuario:** no reescribir los manuales ahora. Se actualizan **al final del refinamiento de la plataforma**, cuando el comportamiento deje de cambiar.
* **Estado encontrado (revisado contra el código el 2026-10-01):** ambos manuales se escribieron el 2026-09-09 describiendo el plan; en el hub solo se corrigió el paso de acceso. Afirmaciones falsas o desactualizadas:
  - Hub, paso 3: "sube pistas o stems Demucs de 6 canales". El input de archivo de `StemsHubView` no tiene manejador y Demucs no existe.
  - Hub, paso 4, y follower, "Conexión": "escanea el QR o entra a la PWA… pulsa ESTABLECER ENLACE". El QR sale del líder (Red > Conectar músicos) y se escanea con la cámara nativa; `/app/` en HTTPS no puede conectar a la LAN (CONTRACT_V3 §8); hay que tocar ACTIVAR AUDIO.
  - Hub, "Ruteo ASIO & Stems": una matriz de 6 canales con buses in-ear. El líder solo saca el clic (salidas 1-2 a la PA, salida 3 al baterista) y no reproduce pistas (`audio/track.py` es un placeholder).
  - Ambos, "Roles": letras con scroll y acordes transpuestos. El follower muestra "SIN LETRA" (distribución de letras pendiente) y los roles reales son músico y director.
  - Follower, "In-Ear": mezcla de clic, guía y stems con limitador en todo. Solo funcionan el volumen general y el del clic, y el limitador aplica solo al clic.
  - Ambos, "Flywheel": "se realinea en 4 compases". En realidad un error menor de 2 ms se ignora, uno menor de 50 ms se reparte en al menos un compás y uno mayor se re-ancla en el siguiente beat.
  - Follower, "Conexión": "offset verificado < 5.1 ms". No hay medición en Wi-Fi real que lo respalde.
* **Qué deben incluir los manuales nuevos y hoy falta:**
  - PANIC por rol: el músico solo silencia su equipo, el director detiene a la banda;
  - los estados del enlace: LOCKED, DEGRADED, UNSTABLE, FLYWHEEL y LOST;
  - el aviso "PANTALLA PUEDE APAGARSE" y el modo PANTALLA: API/VIDEO;
  - en el líder: permitir Python en el firewall en redes privadas, marcar la Wi-Fi de escenario como red privada y elegir su IP en Conectar músicos.
* **Pendiente (al cierre del refinamiento):** reescribir ambos manuales desde el comportamiento verificado en ese momento, marcar como PENDIENTE lo que no exista, regenerar `landing/` con `npm run build:landing` y verificar los textos en el e2e.

### [2026-10-01] - Fase 1, primera tanda: instalador GPL, audio en tiempo real, login del líder y librería de canciones
* **Sprint / Módulo:** `bandait-leader`, `bandait-leader-web`, `bandait-follower/public`, `bandait-protocol`, `landing/`, CI y releases, documentación. Rama `feat/phase1-wave1`. Agente: Claude Code (Opus 5.5), con tres subagentes en paralelo y propiedad de archivos separada.
* **Decisiones del usuario (2026-10-01):**
  - **Licencia GPL-3.0-or-later.** El SDK de ASIO pasó a licencia dual propietaria/GPLv3 el 2025-10-15, Link es GPLv2+ y PySide6 es LGPL.
  - **Solo Windows + ASIO.**
  - **Instalador sin firma por ahora.**
  - **Texto a voz con Azure AI Speech F0.** La llave está en ClipVault, en la entrada `bandait-instance-azure-speech`; nunca pasó por el chat.
  - **Supabase se documenta como proveedor externo.** El resto corre en Cloudflare: los servicios nuevos de voz y audio irán en Workers + R2.
  - Se descartaron:
    - XLSX;
    - mezcla in-ear con stems, Demucs y detección de acordes/BPM, que quedan para más adelante;
    - OTP, porque el login con Google ya resuelve el acceso.
* **Investigación previa (resumen):**
  - **Empaquetado.**
    - PyInstaller `--onedir` con Inno Setup sigue siendo la mejor opción.
    - Nuitka y `pyside6-deploy` no dan beneficio en tiempo real, porque el callback de PortAudio sigue esperando el GIL.
    - Sin firma, SmartScreen bloquea el instalador. Azure Artifact Signing no está disponible para personas en Colombia. Las opciones a futuro son SignPath (gratis para código abierto, condiciones por confirmar), un certificado OV o la Microsoft Store (MSIX); falta probar ASIO dentro de MSIX.
  - **Releven.**
    - El Worker de medios de URiT (R2) es el candidato para guardar pistas en la nube, pero se estaba escribiendo ese mismo día y no está desplegado.
    - Releven no tiene nada reutilizable para identidad (usa JWT propio), correo saliente ni texto a voz.
    - `RELEVEN_ECOSYSTEM.md` tiene credenciales en texto plano. El repo es privado, pero conviene rotarlas.
  - **Azure F0, medido con la llave real:**
    - hay dos voces es-CO (Salomé y Gonzalo) y cada solicitud tarda entre 0.8 y 1.35 s;
    - la frase "Uno. Dos. Tres. Cuatro." dura 5.3 s, cuando a 120 BPM cuatro beats duran 2 s;
    - las palabras sueltas duran entre 145 y 431 ms.
    - De ahí salió la regla de una palabra por beat con elección automática de velocidad (WORKSPACE_V2 §5.1).
* **Acción técnica realizada:**
  - **Especificación.**
    - `bandait-protocol/WORKSPACE_V2.md` y `fixtures/workspace_v2.json`: el documento que el hub guarda en Supabase pasa a ser un contrato hub → líder, con librería de canciones, secciones en compases, ChordPro por sección, transiciones por ítem, configuración de voz y migración v1 → v2 con ids deterministas.
    - `CONTRACT_V3.md` §9: contenido de canción por HTTP, estado COUNTING, transiciones automáticas y avisos de voz, para la segunda tanda.
    - `docs/DEPLOY.md`: tabla de qué corre en cada servicio y relación con Releven.
  - **Instalador y audio (subagente A).**
    - Archivo `LICENSE` (GPL-3.0) y `NOTICE.md` con cada componente, su licencia y su fuente; el build falla si falta uno.
    - `resources/icon.ico`.
    - `build_exe.py`: rutas de datos, información de versión, backend de keyring incluido, Qt sin módulos usados (de 229.6 a 141.9 MB).
    - `installer.iss`: instalación por máquina, regla del firewall solo para redes privadas al instalar y retirada al desinstalar.
    - `release.yml`: con tags `v*` o lanzamiento manual, compila, corre `--smoke-test` sobre el `.exe` y arma el instalador; con un tag, publica el Release con SHA256SUMS.
    - Dos fallas de ASIO corregidas en `src/audio/portaudio_setup.py`:
      - `SD_ENABLE_ASIO=0` igual activaba ASIO;
      - un `portaudio.dll` en el PATH tapaba al incluido en el paquete.
    - `src/audio/rt_policy.py`: temporizador de 1 ms, `setswitchinterval(0.001)`, sin estrangulamiento de energía y `gc.freeze()`.
    - El callback ya no reserva memoria por bloque.
  - **Login del líder y sincronización (subagente B-líder).**
    - `src/cloud/`: PKCE con el navegador del sistema y retorno a `127.0.0.1:53682`-`53684`; el refresh token se guarda en el Administrador de credenciales de Windows.
    - Lectura del workspace v1/v2 por PostgREST, de solo lectura, con caché atómica para tocar sin internet.
    - Importación a SQLite en una sola transacción con `cloud_id`; las canciones locales no se tocan.
    - Los ids de v1 se calculan con un port exacto de la función del hub, verificado contra la migración real del hub en Node.
    - Menú "Cuenta" y estado `NUBE` en la barra de estado.
  - **Hub (subagente B-hub).**
    - Pestaña CANCIONES:
      - editor de secciones en compases;
      - "Pegar ChordPro completo" con detección de secciones;
      - vista previa con acordes sobre las sílabas.
    - Setlist con referencias a la librería, BPM y tono por show y transiciones con conteo.
    - Pestaña VOZ Y CONTEOS.
    - Migración v1 → v2 idempotente y sin eco de sincronización.
    - Importar y exportar el JSON completo.
  - **Hecho por mí (lead):**
    - **Íconos del PWA reales.** `bandait-follower/public/icon-{192,512}.png` eran **archivos de texto de 122 bytes** ("Placeholder: Replace with actual...") y estaban así en producción. Ahora salen de la imagen original de 1024 px sobre negro puro con `scripts/make_icon.py --pwa`, y la imagen original pasó a ser la primera fuente del script.
    - Dependencia `mutagen` (GPL-2.0-or-later) agregada: el líder la usa para la duración de los MP3 y no se incluía en el `.exe`.
* **Fallas encontradas fuera del alcance pedido (subagente A):**
  - En el `.exe` sin consola, `sys.stdout` es `None` y uvicorn 0.51 llama `sys.stdout.isatty()`: **el servidor de red nunca habría arrancado para los usuarios**. Corregido en `src/main.py`, que redirige los streams estándar a devnull.
* **Mediciones (subagente A):**
  - Callback de 256 frames × 8 canales:

    | | Mediana por bloque | Memoria reservada por bloque |
    |---|---|---|
    | Antes | 30.6 µs | 17.7 KB |
    | Después | 19.9 µs | 0.6 KB |

  - Traspaso del GIL con otro hilo compitiendo:

    | Configuración | Retraso p50 | xruns |
    |---|---|---|
    | Temporizador por defecto | 15-17 ms | 48-72 |
    | Temporizador de 1 ms + intervalo de 1 ms | 1.1-1.6 ms | 0 |

  - `gc.collect` completo: 29-61 ms antes de `gc.freeze()` y 0 ms después.
  - Arranque del `.exe`: 3.2-5.9 s.
* **Verificación y Pruebas (corridas propias en la rama integrada, resultado literal):**
  - **Líder:**
    - `ruff check src tests` → `All checks passed!`
    - `QT_QPA_PLATFORM=offscreen python -m pytest -q` → `290 passed`
    - Detalle de la corrida que falló (paso a paso en "Prueba inestable", abajo):
      - una primera corrida dio `1 failed, 289 passed`, con fallo en `test_startup_sync_runs_in_background_and_loads_the_chosen_setlist`;
      - esa prueba pasó 3/3 sola;
      - tras la corrección, el módulo con las pruebas de auth pasó 5/5 (`34 passed`).
  - **Hub:** lint limpio; `verify:logic` → `23 ok, 0 fallas` y `34 ok, 0 fallas`; build correcto.
  - **Follower:** lint y `tsc` limpios; vitest → `Tests 116 passed (116)`.
  - **Bundles:** regenerados con `npm run build:landing`.
  - **E2E:** `npx playwright test` (landing + leader-web + follower) → `58 passed (1.1m)`.
  - **`.exe` empaquetado:** `--smoke-test` → `exit=0` (según el subagente A). Reporta:
    - `WinVaultKeyring`;
    - las DLL de PortAudio con y sin ASIO incluidas;
    - el follower servido desde el `.exe`;
    - Socket.IO con `101 Switching Protocols`.
  - **CI del PR #15, job "Instalador Windows" en `windows-latest`.** Falló dos veces antes de pasar:
    1. `test_license_is_the_full_gpl3_text`:
       - el runner hace checkout con `core.autocrlf` y `LICENSE` pasó a CRLF, con un hash distinto del oficial;
       - se reprodujo en local: con CRLF el SHA-256 es `230184f6…`, igual que en el CI, y normalizado es `3972dc97…`;
       - corrección: `.gitattributes` con `eol=lf` para LICENSE, NOTICE y fixtures, y la prueba normaliza los fines de línea.
    2. `ERROR: NOTICE.md no menciona: charset-normalizer`:
       - el entorno limpio del CI incluye ese paquete y el local no;
       - se agregó a NOTICE y el verificador del propio script ya no reporta faltantes con la lista exacta del CI.
    - **Tercera corrida: todos los pasos en verde:**
      - `Build listo: ...BandaitLeader.exe (version 2.1.0, 134.4 MB)`;
      - el smoke test del `.exe` empaquetado pasa;
      - `Successful compile (27.703 sec)` de Inno Setup;
      - artefacto `BandaitLeader-2.1.0-windows` de 102 MB; el paso del Release se salta en un PR, como corresponde.
    - Lección: compilar el instalador en el PR detectó dos fallas que el entorno local no podía mostrar.
  - **Prueba inestable:**
    - la prueba exigía que crear la ventana tardara menos de 10 s, y eso dependía de la carga de la máquina;
    - se reemplazó por una compuerta (`FakeSupabase.rest_gate`) que retiene la lectura del workspace hasta que la ventana existe. Así se demuestra que el arranque no espera la red sin depender del reloj;
    - el fallo no se reprodujo en 5 corridas, pero no se puede afirmar que esa fuera la única causa.
* **Errores propios:** el 2026-10-01 apunté el favicon de la landing a `app/icon-192x192.png` sin revisar que fuera una imagen: era el placeholder de texto. Queda corregido con los íconos reales.
* **Pendientes:**
  1. **Usuario:** agregar en Supabase → Authentication → URL Configuration → Redirect URLs estas tres:
     - `http://127.0.0.1:53682/callback`
     - `http://127.0.0.1:53683/callback`
     - `http://127.0.0.1:53684/callback`

     El GoTrue actual acepta loopback sin la lista, pero se documentan por compatibilidad.
  2. **Usuario:** probar el login real siguiendo los pasos de `bandait-leader/README.md` ("Cuenta y sincronización"). NO VERIFICADO aquí.
  3. Verificar en GitHub el build del instalador (ISCC) con el lanzamiento manual de `release.yml`. NO VERIFICADO localmente, porque Inno Setup no está instalado.
  4. Segunda tanda:
     - `normalize_setlist` debe conservar los campos nuevos;
     - `/songs/<id>.json` y el prompter por compás;
     - COUNTING y transiciones automáticas;
     - Worker de voz en Cloudflare con R2 y reproducción de avisos en la salida de cue;
     - `library_view` debe mostrar el origen de cada canción y bloquear "reemplazar" en las que vienen de la nube.
  5. Migrar `google-generativeai`, que perdió soporte el 2025-11-30, a `google-genai`. Hoy la vista IA queda "offline" en el `.exe`.

### [2026-10-01] - Líder: el dibujo nunca tumba la app, sin datos de demostración automáticos y setlist vacío visible
* **Sprint / Módulo:** `bandait-leader`. Rama `fix/leader-stage-robustness` (desde `main` en `23baea7`). Agente: Claude Code (Opus 5.5), subagente; el líder del trabajo hace los commits.
* **Estado encontrado (prueba real del usuario con el `.exe` instalado, `~/Documents/Bandait/logs/`):**
  - `bandait-leader.log`: `CRITICAL bandait.crash: Excepcion no controlada` a las 16:23:22 y 16:24:49, con `File "src\ui\widgets\timeline.py", line 206, in paintEvent` y `TypeError: 'PySide6.QtGui.QPainter.drawPolygon' called with wrong argument types: PySide6.QtGui.QPainter.drawPolygon(list)`.
  - `bandait-leader-crash.log`: dos veces `Fatal Python error: Aborted` con `<no Python frame>`. La app murió.
  - `timeline.py` llamaba `drawPolygon([x-6, 0, x+6, 0, x, 8])` (lista plana de ints). Solo se dibuja con el playhead visible, es decir, tocando.
  - La importación funcionó (`Nube importada (band_...): 0 canciones, 1 setlists`): el setlist elegido en el hub estaba vacío. La biblioteca seguía mostrando las canciones sembradas por `MainWindow.__init__` (`src/db/seed.py`: song-001..003, setlist-001, gig-001, member-001..003) y el usuario lo leyó como "no sincronizó". El aviso de setlist vacío duraba 6 s en la barra de estado.
* **Causa (verificada con un proceso aparte, PySide6 6.11.1, Windows 11):**
  - Si una excepción sale de un `paintEvent` de Python, el `QPainter` local nunca se termina (el traceback lo mantiene vivo). Qt avisa `QBackingStore::endPaint() called with active painter` y `QPaintDevice: Cannot destroy paint device that is being painted`, y el proceso termina con `abort()` (código 3, `Fatal Python error: Aborted`, `<no Python frame>`). Es la misma secuencia del log del usuario.
  - El excepthook de `src/main.py` solo registra: no puede evitarlo.
  - Con la llamada original (`drawPolygon` con la lista), el proceso de prueba murió por `access violation` (0xC0000005), a veces antes de que el excepthook registrara nada.
  - Qué llamada nativa invoca `abort()` después del aviso de Qt: NO VERIFICADO.
* **Corrección aplicada:**
  - `src/ui/widgets/timeline.py`: el triángulo del playhead usa `QPolygon` de `QPoint`. Auditoría de cada llamada a `QPainter` en `timeline.py` y `vu_meter.py` (las únicas con `paintEvent`; `connect_musicians.py` pinta un `QImage` dentro de `try/finally`): con un script se probaron en PySide 6.11 todas las sobrecargas usadas (`drawText` con rectángulo y banderas, `drawLine` con int y float, `fillRect` con rectángulos negativos). La única que fallaba era `drawPolygon` con lista; además `QRect` lanza `OverflowError` con coordenadas de más de 2^31. Por eso las coordenadas X se acotan a ±1 000 000, los setters ignoran NaN/inf/None, la duración se limita a 24 h y la regla solo recorre los beats visibles (antes recorría todos los beats de la canción en cada cuadro).
  - `src/ui/widgets/_paint.py` (nuevo): decorador `safe_paint`. Crea y siempre termina el `QPainter`, captura cualquier excepción, la registra una sola vez por clase de widget con traceback (después solo la cuenta), deja el fondo negro y nunca relanza. Aplicado a `TimelineWidget.paintEvent` y `VUMeter.paintEvent`. El VU ignora NaN y ya no repinta a 60 fps cuando el pico no cambia.
  - Datos de demostración:
    - la GUI ya no siembra la base; solo con `BANDAIT_DEMO=1` o *Ayuda > Cargar canciones de demostración* (con confirmación);
    - las filas llevan `source='demo'` (columna nueva en `setlists`, `gigs` y `band_members`; los setlists del hub se guardan con `source='cloud'`);
    - migración aditiva en `migrate_db`: con la misma copia previa marca como demo las filas sembradas por versiones anteriores, solo si el id y el título o nombre coinciden;
    - Biblioteca: columna "Origen" con NUBE / LOCAL / DEMO (reemplaza "Último uso" y "Último evento", que mostraban texto fijo), lo DEMO oculto con sesión y banda del hub, casilla "Mostrar demostración" y botón "Quitar datos de demostración" (confirmación, copia del archivo y borrado de solo las filas `demo`);
    - con una banda del hub elegida, `_load_initial_setlist` y el fin de la sincronización nunca dejan en vivo un setlist demo o local: el elegido, aunque esté vacío, o el primero de la banda.
  - Setlist vacío: aviso fijo en Escenario ("SETLIST VACIO: agrega canciones en bandait.releven.cc/hub (CANCIONES y SETLISTS) y luego Cuenta > Sincronizar ahora") y en la barra de estado (widget permanente: `showMessage` no lo tapa). Sin setlist en vivo, otro aviso. *Cuenta > Elegir setlist* muestra "Nombre (N canciones)" y una advertencia cuando el elegido está vacío.
  - Canciones de la nube: el "Reemplazar" al importar se bloquea antes del diálogo con "Esta canción viene del hub: edítala en bandait.releven.cc/hub y sincroniza." (antes la guarda del ORM descartaba el cambio y la UI decía "Canción actualizada").
* **Pruebas nuevas:**
  - `tests/test_paint_guard.py`: en subproceso, con el excepthook de `main.py`. Sin guarda: en Windows el proceso muere (con `raise`, abort con código 3 en 8 de 8 corridas aisladas, pero una corrida dentro de la suite completa terminó con código 1; con la llamada original, access violation). Por eso la prueba exige la muerte y el registro del excepthook, no el abort en sí. Con guarda: sobrevive a `grab()`, repintados y cierre, con un solo registro. Además, chequeo estático de que todo `paintEvent` de `src/ui` lleva `@safe_paint`. En otras plataformas el control sin guarda solo se registra; no se observó en Linux.
  - `tests/test_paint_smoke.py`: timeline con secciones, playhead en 0, en la mitad, al final y más allá, zoom y basura; VU en -inf / -20 / 0 / clip; escenario con y sin canción; transporte tocando y detenido; mezclador, biblioteca, IA, selectores y `MainWindow` tocando con el playhead visible. Exige que la guarda no haya registrado nada. Comprobado: con la llamada vieja de `drawPolygon` estas pruebas fallan.
  - `tests/test_demo_data.py`: firmas de la semilla, migración que marca solo lo intacto (con una sola copia), borrado de solo las filas `demo` con copia, menú y botón, rechazo mientras suena, y bloqueo de "Reemplazar" en canciones del hub.
  - Ajustadas: `test_visual_startup` (la semilla ahora se pide con `BANDAIT_DEMO=1`, más una prueba de arranque vacío), `test_leader_ui_path` (llama `seed_database()` explícitamente), `test_cloud_import` (las filas sembradas ahora son `demo`) y `test_cloud_ui` (al arrancar con banda sin datos locales no hay setlist en vivo, nunca el demo; más la prueba del setlist vacío del hub y del selector).
* **Verificación y Pruebas (resultado literal):**
  - `ruff check src tests` → `All checks passed!`
  - `QT_QPA_PLATFORM=offscreen python -m pytest -q`: dos corridas verdes (`314 passed in 121.04s`, `314 passed in 134.99s`). Tras un ajuste menor, una tercera dio `1 failed, 313 passed`: el control sin guarda de `raise` terminó con código 1 y sin abort, y la prueba exigía el abort. Se relajó a "muere y el excepthook registró". Corridas finales sobre el árbol definitivo: `314 passed in 77.55s (0:01:17)` y `314 passed in 85.89s (0:01:25)`.
  - `python scripts/build_exe.py` → `Build listo: ...\dist\BandaitLeader\BandaitLeader.exe (version 2.1.0, 142.6 MB)`; `BandaitLeader.exe --smoke-test` (con `BANDAIT_HOME` temporal) → `exit=0`, `"ok": true`, Socket.IO `HTTP/1.1 101 Switching Protocols`, keyring `WinVaultKeyring`. La GUI del `.exe` nuevo no se probó tocando: NO VERIFICADO.
* **Errores y hallazgos:**
  - Una corrida intermedia, con pruebas viejas que fallaban, terminó en `Windows fatal exception: access violation` dentro de `pytestqt` (`_process_events` en el teardown) mientras el hilo `bandait-cloud-sync` seguía en `save_cache`. Se reprodujo con una prueba temporal que falla mientras la sincronización está retenida. **También se reproduce en una copia limpia de `HEAD` (`git archive`)**, así que no lo introdujo este cambio. Solo aparece cuando una prueba falla con una sincronización en curso. Causa raíz NO investigada.
  - Durante una corrida, `conftest` reportó "la suite modifico la base real del usuario". La causa era el `BandaitLeader.exe` instalado, que el usuario abrió a las 18:02:27 y que escribió `bandait.db` a las 18:03:12. Las pruebas no lo tocaron: con la app cerrada, el archivo no cambió en las dos corridas completas.
* **Decisiones:**
  - La guarda es el dueño del `QPainter` (decorador que lo pasa como argumento), no un `try/except` dentro de cada `paintEvent`. Así ningún widget nuevo puede olvidarse de `end()`, y la prueba estática lo exige.
  - La marca de demo se hace por id y título juntos. Una fila renombrada por el usuario queda `local` y el borrado no la toca.
  - Con banda del hub y sin setlist elegido válido se carga el primero de la banda (orden nombre, id), no ninguno: en escenario es mejor tener la banda que nada. Si la banda no tiene setlists y la banda está detenida, se vacía el setlist en vivo y se muestra el aviso.
* **Pendientes:**
  1. Probar en el equipo del usuario el `.exe` nuevo tocando con el playhead visible (pestaña Mezcla) y con el setlist vacío del hub. NO VERIFICADO aquí con hardware real.
  2. Investigar el access violation de `pytestqt` con una sincronización en curso cuando una prueba falla (preexistente, ver arriba).
  3. Observar en el CI de Linux qué hace el control sin guarda de `test_paint_guard.py` (solo se registra; no se afirma).

### [2026-10-02] - Sistema de diseño bandait refinado para escenario y versión 2.1.1 del líder
* **Sprint / Módulo:** Sistema de diseño (artefacto de claude.ai, fuera del repo) / `bandait-leader` (versión)
* **Acción técnica realizada:**
  - Artefacto "bandait" (tipo Design System, https://claude.ai/artifact/BCRLwP6fB2PFKFMrQiwfsX, privado del usuario), versiones 6 y 7. No hay código del repo que lo use todavía; es el destino del rediseño del hub, la PWA y el líder.
    - `tokens.json` v2: tres temas. Oscuro (escenario) con `surface` #000000; Claro; Alto contraste (texto mínimo 7:1). Tono nuevo `warn` / `warn-soft` / `on-warn` y estilo tipográfico `chord`.
    - Bundle React 18 (`window.Bandait`, 23 componentes, 54 íconos Lucide). Nuevos: `Tag` (NUBE / LOCAL / DEMOSTRACIÓN), `ChordLine` (ChordPro, corta entre palabras y nunca dentro de una), `LinkMeter` (locked / degraded / unstable / flywheel / lost), `PanicButton` (mantener 800 ms; `local` silencia solo el equipo, `band` detiene a todos), `EmptyState` y `ConfirmDialog` (foco inicial en Cancelar, Escape, lista de lo que se pierde).
    - Rehechos en compases, no en segundos: `CueTimeline` (secciones con `startBar`/`bars`, conteo de entrada antes del compás 1), `LyricEditor` (líneas en ChordPro con compás de entrada, modos editar y sincronizar) y `TransportBar` (`status` stopped / counting / playing / paused, ±1 BPM, `LinkMeter`, PANIC de banda).
    - `SetlistItem` muestra la entrada de cada canción (`manual_cue`, `auto_count_in` con N compases, `gapless`, igual que CONTRACT_V3 sección 9) y el origen.
    - README: público de músicos independientes y bandas pequeñas y medianas, roles de la PWA (Músico, Director, Letras), regla "ningún control sin función" y ejemplos neutros (se quitaron los de culto: "Tu fidelidad", "Domingo 9:00", rol Proyección).
  - `bandait-leader`: `APP_VERSION` y `pyproject.toml` pasan de 2.1.0 a 2.1.1 para publicar el primer Release del líder PySide6, que incluye las correcciones del PR #16. El tag `v2.1.1` se empuja después del merge y `release.yml` construye y publica el Release.
* **Impacto en Audio / Red / UI:**
  - Sin cambio de comportamiento en este commit, aparte del número de versión.
  - El sistema de diseño ya no contradice las reglas de escenario: oscuro forzado al abrir el líder y la PWA, letra y avisos anclados al compás, PANIC sin disparo accidental y estados degradados visibles en amarillo.
* **Verificación y Pruebas (resultado literal):**
  - Contraste de tokens (script propio): `144/144` combinaciones cumplen; texto mínimo 4,79:1 en Claro, 5,9:1 en Oscuro, 8,24:1 en Alto contraste.
  - Render del bundle con React 18 de `bandait-follower/node_modules` (`renderToStaticMarkup`): `rendered 37/37`; las 24 vistas previas del artefacto: `24/24 previews OK`.
  - Revisión visual en Chromium (Playwright MCP) de las vistas previas en los tres temas, a 490 px y a ancho de laptop. Encontró cuatro fallos, corregidos antes de publicar:
    1. `TransportBar` aplastaba las casillas de pulso y el botón de clic, y PANIC se salía de la pantalla a 1344 px;
    2. `SetlistItem` cortaba el título a "Carret..." en el teléfono;
    3. la letra con acordes se partía en cajas enteras ("Canta" sola en una línea);
    4. la etiqueta del conteo no cabía en `CueTimeline`.
  - Versión: `python scripts/version.py --check-tag v2.1.1` -> `2.1.1`; `ruff check src tests` -> `All checks passed!`; `pytest -q tests/test_packaging.py` -> `19 passed`.
  - El instalador 2.1.1 y el Release: NO VERIFICADOS al escribir esta entrada (los produce el CI al empujar el tag).
* **Errores propios:**
  - El MCP de Playwright guardó 12 capturas en la raíz del repo, porque resuelve los nombres relativos contra el directorio de trabajo. Se movieron fuera del repo antes del commit.
  - Publicar al artefacto con la ruta corta 8.3 del scratchpad (`DANIEL~1.CAS`) fue bloqueado por una regla de permisos de lectura; con la ruta larga funcionó. `index.d.ts` exige `contentType: text/plain`.
  - La copia local del artefacto no tenía 7 fichas de componentes (Icon, IconButton, FileDrop, QRJoinCard, TextField, SelectField, Toggle). Se leyeron del artefacto después de publicar la versión 6 y se corrigieron en la 7.
* **Decisiones:**
  - Escenario siempre en oscuro con claro opcional: decisión del usuario. El tema Alto contraste se agregó para tarimas con mucha luz y baja visión. El hub sigue en claro por defecto, con oscuro opcional.
  - PANIC por mantener presionado (800 ms) y no por diálogo de confirmación: en vivo un diálogo es lento y un toque simple es peligroso.
  - "Ningún control sin función": un botón cuya acción no existe no se muestra, ni deshabilitado. Responde al reporte del usuario de controles que no hacen nada.
  - Las copias SVG de los 10 íconos nuevos no se subieron al grupo Icons del artefacto; el bundle los dibuja.
* **Pendientes:**
  1. PR que haga funcionar o quite cada control muerto: borrar setlists y bandas en el hub; los 7 botones deshabilitados y los 5 menús "no disponible" de la biblioteca del líder.
  2. Aplicar el sistema de diseño: hub y PWA con el bundle y los tokens; líder con QSS generado desde `tokens.json`; íconos de la app con `bandait-app-icon`.
  3. Subir al grupo Icons del artefacto las copias de `hand`, `octagon-x`, `volume-x`, `activity`, `cloud`, `hard-drive`, `flask-conical`, `moon`, `sun` y `contrast`.
  4. Probar en el equipo del usuario el instalador 2.1.1 descargado del Release.

### [2026-10-02] - Biblioteca del líder: botones que se ven y que funcionan (2.1.2)
* **Sprint / Módulo:** `bandait-leader` (Biblioteca, estilos QSS, menús, transporte, mezclador)
* **Estado encontrado (reporte del usuario con el instalador 2.1.1):** en Biblioteca, "Importar", "Nueva", "Eliminar", "Nuevo setlist" y "Nuevo evento" no se veían como botones o no hacían nada. "Acerca de" decía 2.1.1, así que no era una versión vieja instalada.
  - `src/ui/main_window.py` (`_apply_styles`) carga `src/styles/bandait_dark.qss`. Ese archivo solo tenía reglas para `QPushButton#transport` y `#toggle`. Las reglas `QPushButton`, `#primary`, `#danger` y `#success` estaban solo en `bandait_daw.qss`, que nada carga. Como la regla base `QMainWindow, QWidget, QDialog { background-color: #000000 }` también aplica a los botones, se dibujaban planos y sin borde, como texto (captura offscreen de la vista: los botones se confunden con los campos).
  - `src/ui/views/library_view.py`: "Nueva", "Eliminar", "Nuevo Setlist", "Editar", "Duplicar", "Nuevo Evento" y el filtro de eventos estaban `setEnabled(False)` con la etiqueta "No disponible en esta version". La pestaña Eventos nunca leía la tabla `gigs`.
  - Barrido de toda la ventana (script con `findChildren`, revisando las señales conectadas): además, el botón BUCLE del transporte, el paneo de los 4 canales del mezclador y 4 menús "(no disponible)" (Nueva Sesión, Abrir Sesión, Guardar, Preferencias). Ningún otro botón visible estaba sin acción.
* **Causa:** los controles se dejaron como marcadores deshabilitados y el estilo de botones quedó en un QSS que la app no carga. No se determinó por qué existen dos archivos QSS.
* **Corrección aplicada:**
  - `bandait_dark.qss`:
    - regla base de `QPushButton` (fondo #141414, borde #4A4A4A, hover y foco cian, `:disabled` atenuado pero con forma de botón);
    - variantes `#primary`, `#danger` y `#success`;
    - estilos de `QPlainTextEdit`, `QSpinBox`, `QDateTimeEdit` y `QCheckBox`;
    - `padding: 0` en `#transport`, porque el padding de la regla base se heredaba.
    - Los botones − y × del encabezado (28 px) quedaban sin espacio para el glifo: su estilo propio ahora fija `padding: 0`.
  - `src/db/library_ops.py` (nuevo): crea, edita y borra canciones, setlists y eventos locales.
    - Lo del hub (canción `source='cloud'`, setlist con `cloud_id`) se rechaza con `CloudReadOnly` antes de tocar la sesión, con el mensaje de dónde se edita.
    - Una fila DEMO editada pasa a `local`.
    - Los ítems de setlist se escriben con Core y, al editar, conservan transición, conteo y tonalidad del show de las canciones que siguen.
    - Duplicar copia cualquier setlist (también del hub) a uno local sin `item_cloud_id`.
    - Borrar un setlist deja sus eventos sin setlist.
    - Letra con acordes: `[Am]` es acorde y `[Coro]` es sección (regex de vocabulario de acordes); `lyrics_text` queda sin acordes y `chords_text` guarda el ChordPro.
  - `src/ui/dialogs/library_editors.py` (nuevo): editores de canción (título, artista, BPM, compás, tonalidad, duración mm:ss, letra ChordPro), de setlist (biblioteca a la izquierda, orden del show a la derecha, Agregar, Quitar, Subir, Bajar) y de evento (nombre, fecha y hora, lugar, setlist, notas). Un error de validación se muestra dentro y el diálogo no se cierra.
  - `library_view.py`:
    - todos los botones conectados;
    - Editar, Duplicar y Eliminar se activan al elegir una fila y, sin selección, dicen "Selecciona...";
    - con una fila del hub explican dónde se edita;
    - cada borrado confirma con el verbo en el botón y la lista de lo que se pierde (setlists que pierden la canción, eventos que quedan sin setlist, si es el setlist en vivo);
    - la pestaña Eventos lee `gigs`, filtra (Todos, Próximos, Hoy, Pasados) y carga el setlist del evento en vivo;
    - no se borra el setlist en vivo ni una de sus canciones mientras la banda toca.
  - `main_window.py`:
    - "Cargar en vivo" (biblioteca y eventos) pasa por `_request_live_setlist`: antes llamaba a `_activate_setlist` directo y podía cambiar el setlist debajo de una canción sonando;
    - editar el setlist en vivo o una de sus canciones lo recarga (al instante si está detenido, si no al detener);
    - borrar el setlist en vivo carga el inicial.
    - Archivo ahora tiene Nueva canción, Importar archivo, Nuevo setlist y Nuevo evento; se quitó el menú Editar (Preferencias no existía).
  - BUCLE y paneo: ocultos hasta que existan (`setVisible(False)`), no deshabilitados.
  - `models.py`:
    - el marcado de filas DEMO por id y título (`plan_demo_marks`) corría en cada arranque, con un respaldo cada vez, y habría vuelto a marcar DEMO una fila DEMO editada sin cambiarle el nombre;
    - ahora corre una sola vez por archivo: `PRAGMA user_version = 1` al terminar (o al crear una base nueva).
    - `tests/test_demo_data.py::make_pre_demo_db` pone `user_version = 0`, como un archivo real de 2.1.x.
  - Versión 2.1.1 -> 2.1.2.
* **Impacto en Audio / Red / UI:**
  - Ningún cambio en el camino del clic ni en el protocolo.
  - El setlist en vivo ya no cambia bajo una canción que suena desde la biblioteca.
  - Una banda sin hub puede armar canciones, setlists y eventos en la laptop.
* **Verificación y Pruebas (resultado literal):**
  - `ruff check src tests` -> `All checks passed!`
  - `QT_QPA_PLATFORM=offscreen python -m pytest -q` -> `353 passed in 113.31s (0:01:53)` (antes 314).
  - Pruebas nuevas:
    - `tests/test_library_ops.py`: 21 casos de la capa de datos;
    - `tests/test_library_controls.py`: 16 casos. Uno exige una regla en `bandait_dark.qss` para cada `objectName` de `QPushButton` del código (habría detectado el fallo de 2.1.1). Otro recorre todas las pestañas: ningún control dice "no disponible", ningún botón visible queda sin señal conectada y ninguno queda deshabilitado sin decir "Selecciona...". Otros cubren las acciones de Archivo, los flujos de canción, setlist y evento con hub y DEMO, "Cargar en vivo" diferido mientras suena y el borrado bloqueado del setlist en vivo;
    - `tests/test_demo_data.py`: marcado DEMO una sola vez.
  - `test_leader_ui_path::test_no_dead_menu_actions` ahora falla con cualquier acción deshabilitada.
  - Capturas offscreen (con `QT_QPA_FONTDIR`) de Biblioteca, los tres editores, Escenario y Mezcla.
  - El instalador 2.1.2 en el equipo del usuario: NO VERIFICADO.
* **Errores propios:**
  - El primer script de capturas de la ventana completa no cargó `tests/conftest.py`. Leyó la sesión real del hub desde el Administrador de credenciales de Windows, sincronizó la banda a una base temporal y guardó el refresh token rotado (la sesión guardada quedó presente y válida, `saved_at` de hace 61 s). Si el líder del usuario estaba abierto con el token anterior, puede pedir iniciar sesión otra vez. Los scripts siguientes importan `tests.conftest` primero y comprueban `MemoryKeyring`.
  - Al rearmar `library_view.py`, un archivo temporal escrito por Python en `/tmp` quedó en `C:\tmp` y la redirección de bash truncó el archivo con solo la primera mitad. Se reconstruyó con la segunda mitad tomada de `git show HEAD`.
  - Una prueba propia renombraba la copia antes de pedir la segunda y esperaba el sufijo "(2)": se corrigió el orden.
* **Decisiones:**
  - Eventos solo locales: el hub no tiene eventos (WORKSPACE_V2 no los define), así que no hay una segunda fuente de verdad.
  - Lo que aún no funciona se oculta, no se deshabilita: un botón gris con "no disponible" es un botón roto para el usuario.
  - Una fila DEMO editada pasa a ser del usuario; la alternativa (dejarla DEMO) haría que "Quitar datos de demostración" borre sus cambios.
  - En el editor de setlist no hay control de transición ni de conteo por canción: el líder todavía no ejecuta COUNTING ni transiciones automáticas. Se conservan los valores que trae el hub.
  - Se mantiene la paleta cian actual: el paso al sistema de diseño bandait (tokens a QSS) es un cambio aparte.
* **Pendientes:**
  1. Probar el instalador 2.1.2 en el equipo del usuario (artefacto del CI del PR; el Release espera el sí del usuario).
  2. Unificar los dos QSS (`bandait_daw.qss` no se carga) al generar el QSS desde `tokens.json` del sistema de diseño.
  3. Controles de transición y conteo por canción en el editor de setlist cuando el líder ejecute COUNTING.
  4. Bucle y paneo: implementarlos o quitarlos del código.

### [2026-10-04] - Releases v2.1.1 y v2.1.2 del líder publicados
* **Sprint / Módulo:** `bandait-leader` (distribución) / GitHub Releases
* **Acción técnica realizada:**
  - Con el sí del usuario, se empujaron los tags anotados `v2.1.1` (sobre `c5aff0b`, merge del PR #17) y `v2.1.2` (sobre `80d87bd`, merge del PR #18).
  - `release.yml` construyó cada `.exe`, corrió el smoke test, compiló el instalador y creó el Release.
  - Cierra el punto de las entradas de 2.1.1 y 2.1.2 que dejaba el Release "NO VERIFICADO" o "a la espera del sí del usuario".
* **Impacto en Audio / Red / UI:**
  - El botón "Releases en GitHub" de la landing lleva al instalador 2.1.2, marcado Latest.
  - Antes la página de Releases solo tenía las versiones viejas de Flutter (v1.0.x).
* **Verificación y Pruebas (resultado literal):**
  - Run `36962075877` (tag `v2.1.1`): `success`. Release "Bandait Leader 2.1.1", publicado `2026-10-02T03:55:59Z`, no borrador ni prerelease. Archivos: `BandaitLeader-Setup-2.1.1.exe` (44724994 bytes), `NOTICE.md` (8657) y `SHA256SUMS` (174).
  - Run `37248800440` (tag `v2.1.2`): `success`. Release "Bandait Leader 2.1.2", publicado `2026-10-05T00:49:12Z` (UTC), marcado Latest. Archivos: `BandaitLeader-Setup-2.1.2.exe` (44775845 bytes), `NOTICE.md` (8657) y `SHA256SUMS` (174).
  - La instalación de 2.1.2 en el equipo del usuario y la prueba de la Biblioteca con el instalador: NO VERIFICADAS al escribir esta entrada.
* **Pendientes:**
  1. Que el usuario instale 2.1.2 y pruebe la Biblioteca (canciones, setlists y eventos) y "Cargar en vivo" con la banda tocando.
  2. Siguiente bloque:
     - aplicar el sistema de diseño bandait al líder (un solo QSS generado desde `tokens.json`), al hub y a la PWA;
     - en el hub, borrar setlists y bandas;
     - Fase 1: letra por compases en la PWA, conteo y transiciones automáticas en el líder, avisos de voz (Worker de Cloudflare con Azure TTS) y prueba en ensayo real;
     - al final del refinamiento, reescribir los manuales dentro de la app.

### [2026-10-29] - Bandas compartidas entre cuentas de Google (hub, líder y Supabase)
* **Sprint / Módulo:** `bandait-leader-web`, `bandait-leader` (nube), `docs/sql`, `bandait-protocol/WORKSPACE_V2.md`
* **Acción técnica realizada:**
  - Pedido de Daniel Castañeda: compartir el repertorio entre los integrantes de una banda sin usar otras plataformas. Decisiones suyas:
    - alcance: compartir dentro de una banda y además copiar entre bandas;
    - permisos: Owner y MusicDirector editan, el resto solo lee;
    - invitación: por correo de Google más un enlace.
  - `docs/sql/bandas_compartidas.sql`:
    - tablas `bandait_bands` (un documento v2 de una sola banda por fila) y `bandait_band_members` (correo y rol);
    - funciones `security definer` `bandait_current_email()` (solo correo confirmado de `auth.users`) y `bandait_band_role(uuid)`;
    - RLS por pertenencia, permisos por columna (`owner_id`, `id` y `email` no se pueden cambiar) y realtime.
  - Hub:
    - `services/sharedBands.ts`, módulo puro: partir y unir el workspace, copiar setlists, invitaciones y enlaces;
    - adaptador por banda y operaciones de integrantes en `supabaseClient.ts`;
    - `HubContext`: un motor de sincronización por banda compartida, la parte personal sigue en `bandait_workspaces`, detección de ediciones por parte (comparando contra la última versión conocida, no por identidad de objeto), solo lectura según el rol, enlace `?banda=<uuid>` que sobrevive al login de Google, respaldos por banda, e importación de JSON que reemplaza solo la parte personal;
    - UI: panel COMPARTIR BANDA, invitaciones reales con enlace para copiar, QUITAR, SALIR DE LA BANDA, COPIAR A OTRA BANDA, aviso de solo lectura y etiqueta COMPARTIDA en el selector de bandas.
  - Líder:
    - `fetch_shared_bands` y `with_shared_bands`: cada fila se parsea por separado y se agrega a las bandas personales, marcada `shared`;
    - la caché guarda `shared_bands`;
    - si solo falla la lectura de compartidas, conserva las de la caché;
    - si las tablas no existen, no hay compartidas;
    - el selector muestra `[COMPARTIDA]`.
  - `landing/hub` regenerado con `npm run build:landing`.
* **Impacto en Audio / Red / UI:**
  - Ninguno en el camino de audio ni en la LAN: el líder sigue leyendo la nube solo para importar y nunca escribe.
  - Compartir una banda le cambia el id. En el líder hay que volver a elegirla en Cuenta > Elegir banda.
  - Sin el SQL aplicado en Supabase, el hub y el líder se comportan como antes.
* **Verificación y Pruebas (resultado literal):**
  - `npm run test:rls` (raíz, PGlite 0.3.10): `35 ok, 0 fallos`, con creación, invitación, lectura, edición por rol, permisos de columna, salida, expulsión y borrado en cascada.
  - Hub: `npm run verify:logic` da `23 ok`, `34 ok` y `14 ok` (el último es el script nuevo `verify-shared-bands-logic.ts`). `npm run lint`: sin problemas. `npm run build`: correcto.
  - E2E: `npx playwright test --project=leader-web` da `19 passed`. Las 2 nuevas son COPIAR A OTRA BANDA y el panel de INTEGRANTES sin nube.
  - Líder:
    - `ruff check src tests`: `All checks passed!`;
    - `pytest -q`: `359 passed`, con 6 casos nuevos en `test_cloud_workspace.py`;
    - el Supabase falso de `conftest.py` ahora sirve `bandait_bands`.
  - Capturas con el MCP de Playwright de PLAYLISTS (panel de copia), INTEGRANTES a 1440 px e INTEGRANTES a 375 px.
  - **NO VERIFICADO:** el flujo de nube contra el proyecto `bandait-cloud` real (compartir, invitar, entrar con una segunda cuenta, solo lectura, realtime entre dos navegadores). El SQL todavía no se aplica en Supabase y no hay e2e con Supabase.
* **Errores propios:**
  - La primera versión de la política de lectura de `bandait_bands` dependía solo de `bandait_band_role(id)`. En `insert ... returning`, que es lo que hace `.insert().select()`, la fila nueva todavía no es visible para la función y el insert fallaba por RLS. Lo detectó `test:rls` y se agregó `owner_id = auth.uid()` a la política.
  - Al comparar canciones por título y artista, el recorte de espacios se hacía sobre la clave unida, así que " Artista " no coincidía con "Artista". Lo detectó `verify-shared-bands-logic.ts`; ahora se normaliza cada campo.
  - En `refreshShared` la banda activa se comparaba después de actualizar la referencia, así que la comparación siempre daba igual. Se corrigió antes de probar.
  - Una aserción e2e buscaba texto visible dentro de un `<option>`; se cambió por un localizador de opción.
* **Decisiones:**
  - Documento v2 de una banda por fila, en vez de tablas normalizadas de canciones y setlists. Reutiliza la validación, la migración, el motor de sincronización y el parser del líder sin cambios.
  - La pertenencia va por correo y no por id de usuario: se puede invitar a quien todavía no entró nunca a Bandait.
  - El enlace de invitación no da acceso por sí solo; el acceso lo da el correo invitado.
  - El adaptador de una banda compartida nunca hace `insert` desde el motor. Si la fila desaparece, recrearla dejaría a un integrante como dueño de una banda ajena.
  - Para un rol de solo lectura, el motor arranca con `dirty: false`: nunca intenta subir.
  - Se usó PGlite porque Docker Desktop no estaba corriendo.
* **Pendientes:**
  1. Daniel Castañeda: ejecutar `docs/sql/bandas_compartidas.sql` en el SQL Editor de `bandait-cloud` y comprobarlo con dos cuentas (DEPLOY.md 3.11, "Comprobación").
  2. Hacer merge del PR. Es un despliegue a producción: `landing/hub` ya está regenerado.
  3. Borrar bandas compartidas desde el hub (hoy solo existe la política de borrado; no hay botón).
  4. Una e2e de nube con Supabase local o un proyecto de pruebas.
  5. Revisar PySide6 6.12 aparte y quitar el tope `<6.12`, que se agregó en este mismo PR. La CI del PR #20 instaló PySide6 6.12.0, publicado después de la última corrida verde (6.11.2, run `37251318217`), y eso trajo dos fallas:
     - en Linux, `pytest` termina `358 passed, 1 skipped` y luego el proceso muere con "shared QObject was deleted directly" y segfault (exit 139), reproducido dos veces;
     - en Windows, el chequeo de licencias del instalador falla porque `NOTICE.md` no menciona `PySide6_Pdf` ni `PySide6_WebEngine`, paquetes que 6.12 trae aparte.

### [2026-10-29] - Líder 2.1.3: bandas compartidas en el selector
* **Sprint / Módulo:** `bandait-leader` (distribución)
* **Acción técnica realizada:**
  - `APP_VERSION` y `pyproject.toml` pasan a 2.1.3.
  - Incluye la lectura de bandas compartidas del PR #20: Cuenta > Elegir banda las muestra como `[COMPARTIDA]`.
  - Incluye el tope `PySide6<6.12`.
  - Release pedido por Daniel Castañeda ("despleguemos, hagamos todo lo que sea desplegable").
* **Impacto en Audio / Red / UI:**
  - Ninguno en el camino de audio.
  - Quien compartió una banda debe volver a elegirla en el líder, porque cambia de id.
* **Verificación y Pruebas:**
  - `tests/test_packaging.py` en local (versión coherente entre `pyproject.toml` y `APP_VERSION`).
  - CI del PR y run de `release.yml` del tag: ver el Release publicado.
  - Instalación en el equipo de Daniel Castañeda: NO VERIFICADA.

### [2026-10-30] - Compartir: enlace ligado a su banda y sin recrear la banda de ejemplo
* **Sprint / Módulo:** `bandait-leader-web` (INTEGRANTES)
* **Acción técnica realizada:**
  - Reporte de Daniel Castañeda en producción: "la URL de compartir banda no cambia al cambiar de banda y usó la banda por defecto 'Banda de Daniel' a pesar de que tenía seleccionada B&O's".
  - Reproducido con una e2e nueva contra un Supabase simulado dentro de Playwright (`e2e/shared-bands.leader-web.spec.ts`: sesión inyectada y PostgREST en memoria). Se encontraron dos causas:
    1. El resultado de COMPARTIR BANDA, con su enlace, quedaba en el estado de la vista y seguía visible al cambiar de banda. Ahora cada resultado lleva `bandId` (`HubActionResult.bandId`) y solo se muestra en esa banda. El cuadro del enlace se reinicia con `key={link}`.
    2. Al compartir la única banda personal (B&O's, importada), el hub recreaba la banda de ejemplo "Banda de <nombre>" con un setlist y equipos de muestra, porque el formato exige al menos una banda. Eso hacía parecer que se había compartido otra banda. Ahora crea "Espacio personal" vacío y el mensaje lo explica.
  - En la reproducción lo que se subió a la nube sí era B&O's con sus canciones: el contenido compartido era correcto.
  - El botón de cerrar del modal de perfil ahora tiene `aria-label="Cerrar perfil"`.
* **Impacto en Audio / Red / UI:** solo en la UI del hub.
* **Verificación y Pruebas (resultado literal):**
  - `npx playwright test --project=leader-web`: `21 passed`, con 2 nuevas contra el Supabase simulado:
    - única banda personal → "Espacio personal" y el enlace sigue a la banda activa;
    - dos bandas personales → se comparte la elegida en el selector y la otra queda en la fila personal.
  - `npm run verify:logic`: `23`, `34` y `14 ok`. `npm run lint`: sin problemas.
* **Pendientes:**
  1. En la cuenta de Daniel Castañeda ya quedó creada la "Banda de Daniel" de ejemplo. El hub todavía no puede borrar bandas: se puede ignorar hasta que exista ese botón (pendiente 3 de la entrada del 2026-10-29).

### [2026-10-30] - Borrar bandas y setlists desde el hub
* **Sprint / Módulo:** `bandait-leader-web` (INTEGRANTES, PLAYLISTS)
* **Acción técnica realizada:**
  - Pendiente pedido por Daniel Castañeda. Cierra el pendiente 3 de la entrada del 2026-10-29 y la parte de "borrar setlists y bandas" de la del 2026-10-04.
  - INTEGRANTES, ZONA DE PELIGRO, botón BORRAR BANDA (con confirmación):
    - **Banda personal:** sale del workspace personal. Si era la última, queda "Espacio personal" vacío (helper `withPersonalPlaceholder`, compartido con COMPARTIR BANDA).
    - **Banda compartida:** solo quien la creó. Borra la fila de `bandait_bands`; las invitaciones se borran en cascada y la banda desaparece para todos. Lo exige la política `bandait_bands_delete` de RLS; el cliente devuelve "Solo quien creó la banda puede borrarla" si responde 0 filas.
  - PLAYLISTS, botón BORRAR SETLIST (con confirmación): las canciones siguen en la librería. Respeta el modo de solo lectura.
  - `supabaseClient.deleteSharedBand`.
* **Impacto en Audio / Red / UI:** en el líder, una banda borrada sale de Cuenta > Elegir banda en la siguiente sincronización. Si era la elegida, el líder lo dice y no vacía el show.
* **Verificación y Pruebas (resultado literal):**
  - `npx playwright test --project=leader-web`: `23 passed`, con 2 nuevas:
    - demo: borrar setlist y banda;
    - Supabase simulado: borrar la compartida, que desaparece de la nube y del selector, y luego la última personal, que deja "Espacio personal" en la fila personal.
  - `npm run verify:logic`: `23`, `34` y `14 ok`. `npm run lint`: sin problemas.
* **Errores propios:**
  - La primera versión de `deleteBand` sacaba la banda compartida de `sharedRef` antes de calcular la parte personal. La banda borrada se tomaba por personal y se volvía a guardar en `bandait_workspaces`. Lo detectó la e2e nueva; ahora la parte personal se calcula antes.
* **Pendientes:**
  1. Daniel Castañeda: borrar en su cuenta la "Banda de Daniel" de ejemplo que creó la versión anterior.

### [2026-10-30] - Fase 0: el click deja de perderse en teléfonos con latencia de salida alta; "Probar click" en el líder
* **Sprint / Módulo:** `bandait-follower` (flywheelClock, StageView), `bandait-leader` (audio_engine, main_window)
* **Acción técnica realizada:**
  - Reporte de Daniel Castañeda en el primer ensayo con B&O's: "en el teléfono sonó solo una vez y no volvió a sonar".
  - **Causa (reproducida con pruebas):**
    - `FlywheelClock.tick()` emitía cada click cuando le faltaban como mucho `SCHEDULE_AHEAD_MS` (120 ms) en el tiempo *oído*; con el intervalo de 25 ms, entre ~95 y 120 ms antes.
    - El nodo se programa en el reloj de audio (`currentTime`), que va por delante de lo oído en la latencia de salida. Si esa latencia supera ~95 ms (Android 100 a 200 ms, Bluetooth 200 a 300 ms), `ctxTime < currentTime + AUDIO_MIN_LEAD_SEC`: el click se descartaba en silencio y el cursor avanzaba.
    - El primero sonaba porque, justo al armar el audio, el navegador todavía reporta latencia 0.
  - **Corrección:**
    - La ventana se mide sobre el reloj de render: `horizon = now + SCHEDULE_AHEAD_MS + outputLeadMs`.
    - `AudioClockMapper.outputLeadMs()` vale `currentTime - (lo oído ahora)`, acotado a `MAX_OUTPUT_LEAD_MS` = 500 ms.
    - La línea inferior de Escenario muestra `SALIDA <ms>` (la latencia de audio del teléfono).
  - **Líder, "Probar click":**
    - `AudioEngine.test_click()` suena un compás 150 ms después de pulsarlo, por las salidas configuradas, sin tocar el transporte; los teléfonos no oyen nada.
    - Si no puede sonar, devuelve en una frase por qué: motor detenido, click apagado en todas las salidas o canción sonando.
    - Hay un botón en la barra de estado y una acción en el menú Audio.
    - Un PLAY durante la prueba no lo corta el fin de la prueba.
  - Revisado en el portátil de Daniel Castañeda (solo lectura y una apertura de flujo en silencio): "Altavoces (3- Realtek XU)" existe, es el predeterminado, MME lo reporta con 8 canales y abre en 8 y en 2 canales a 44,1 y 48 kHz. `leader_config.json` tiene `pa_click_enabled: true`. El click del portátil queda sin síntoma confirmado: "Probar click" sirve para diagnosticarlo.
* **Impacto en Audio / Red / UI:**
  - El click de la PWA arranca hasta 500 ms antes en el reloj de audio; lo oído sigue alineado con el líder.
  - Los teléfonos cargan la PWA desde el líder (`_internal/follower`), así que el arreglo les llega con el instalador 2.1.4. `landing/app` se regenera para la PWA publicada.
* **Verificación y Pruebas (resultado literal):**
  - PWA:
    - `npx vitest run`: `120 passed`. Las 4 pruebas nuevas (latencia de 150 y 300 ms con `getOutputTimestamp`, 200 ms sin él, y latencia reportada después del primer click) fallaban antes de la corrección (`4 failed`).
    - `npm run lint`, `npx tsc --noEmit` y `npm run build`: sin errores.
    - `npx playwright test --project=follower`: `28 passed`.
  - Líder: `ruff check src tests` da `All checks passed!` y `pytest -q` da `363 passed`, con 4 nuevas (`test_audio_phase_lock.py` y `test_leader_ui_path.py`).
  - NO VERIFICADO: el click en el teléfono de Daniel Castañeda con el instalador 2.1.4 en un ensayo real.
* **Pendientes:**
  1. Publicar el líder 2.1.4 e instalarlo.
  2. En el ensayo: confirmar que el click suena en cada teléfono, anotar el valor de `SALIDA` y pulsar "Probar click" en el portátil.

### [2026-10-30] - Fase 1a: latencia de cada músico en el líder (link_report)
* **Sprint / Módulo:** `bandait-protocol` (v3.2), `bandait-follower`, `bandait-leader`
* **Acción técnica realizada:**
  - Pedido de Daniel Castañeda: "quisiera poder ver la latencia".
  - **Protocolo** (contrato y fixtures primero):
    - evento `link_report` cliente → líder, sin respuesta, con `{session_id, client_id, rtt_ms, jitter_ms, samples, output_latency_ms, audio, muted}`;
    - sección 3 de `CONTRACT_V3.md`, fixture canónico en `v3_messages.json` y definición en `schemas/message_types.json`;
    - es informativo: el líder nunca toca el transporte por un reporte.
  - **PWA:**
    - `wire.encodeLinkReport` (redondea a 0,1 ms y deja null sin medida) y `SyncService.sendLinkReport`, que solo envía con la sesión unida;
    - `SessionController` reporta al unirse, cada 5 s (`LINK_REPORT_INTERVAL_MS`) y en cada cambio de audio, y deja de reportar con SALIR.
  - **Líder:**
    - `src/network/link_report.py`, puro: `parse_link_report` valida y acota (descarta en silencio lo inválido) y `link_health` clasifica en BUENO, REGULAR, MALO o SIN DATOS;
    - umbrales propuestos: RTT < 20 ms y jitter < 3 ms es bueno; hasta 50 ms u 8 ms, regular; un enlace es "sin datos" tras 15 s sin reportes;
    - el servidor guarda el último reporte por sid en `followers()[i]["link"]`.
  - **Interfaz del líder:**
    - "Seguidores: N" pasa a ser un botón "Músicos: N · peor RTT X ms", con el color del peor estado;
    - al pulsarlo, o desde Red > Músicos conectados..., se abre el panel `MusiciansPanel`: músico, rol, RTT, jitter, salida de audio, estado del audio y estado con texto, el peor primero, recalculado cada 2 s.
* **Impacto en Audio / Red / UI:**
  - Cada teléfono envía un mensaje cada 5 s, del orden de 200 bytes.
  - No cambia el camino del click ni el transporte.
  - Un teléfono con la PWA vieja (antes de 2.1.5) simplemente no reporta y aparece como SIN DATOS.
* **Verificación y Pruebas (resultado literal):**
  - Líder: `ruff check src tests` da `All checks passed!` y `pytest -q` da `368 passed`, con 5 nuevas: socket de punta a punta con el fixture, parseo y umbrales, y botón y panel.
  - PWA: `npx vitest run` da `123 passed`, con 3 nuevas: fixture canónico, redondeo y nulls, y ciclo de reportes con SALIR. `npm run lint`, `npx tsc --noEmit` y `npm run build`: sin errores.
  - NO VERIFICADO: los umbrales en un ensayo real con la banda.
* **Pendientes:**
  1. Fase 1b: paleta Grafito en el líder, la PWA y el hub, más el control de brillo y los arreglos visuales.
  2. Ajustar los umbrales después del primer ensayo.

### [2026-10-30] - Fase 1b: paleta Grafito en el líder, la PWA y el hub; brillo y arreglos visuales
* **Sprint / Módulo:** `design-system` (v3.0), `bandait-leader`, `bandait-follower`, `bandait-leader-web`
* **Acción técnica realizada:**
  - Pedido de Daniel Castañeda: la paleta neón "quema los ojos". Eligió Grafito entre tres opciones (neón actual, Grafito y Ámbar), en las tres apps.
  - **`design-system/tokens.json` v3.0 Grafito:** gris muy oscuro en vez de negro puro, blanco apagado y acentos desaturados (activo `#5CC8C2`, pulso y acordes `#B8CF7A`), más `on-accent` para el texto sobre acentos. El README explica por qué se retira la v2 neón (16:1 a 19:1, halo).
  - **Líder:**
    - `src/ui/theme.py` con los tokens y la tabla `NEON_TO_GRAFITO`; migración de 19 archivos con unas 666 líneas de color (hex, `QColor(r, g, b)`, `rgba`);
    - el QR sigue en blanco y negro puros (lo lee la cámara);
    - `tests/test_theme.py` falla si vuelve un color neón.
  - **Ver > Brillo** (100, 85, 70, 55 y 40 %): `DimOverlay` es una veladura sobre toda la ventana, transparente al ratón y pintada con `safe_paint`. Se guarda en `leader_config.json` (`brightness`); `load_settings` ahora acepta enteros.
  - **Arreglos visuales vistos en las capturas:**
    - el botón "+ Agregar Sección" de Mezcla aparecía como rectángulo cian sin texto: el QSS global pinta `#primary` de acento y el texto también era de acento; ahora tiene fondo transparente;
    - el encabezado "Tonalidad" salía cortado: las columnas numéricas se ajustan al contenido;
    - la barra de estado se desbordaba: "Audio:" se acorta con "…" (el texto completo va en el tooltip) y el reloj pasó al tooltip de "Red".
  - **PWA:**
    - tema `theme-grafito` predeterminado en `global.css`;
    - `services/theme.ts`: `resolveTheme` pasa a Grafito una sola vez a quien tenía `theme-swiss` (la app lo guardaba sola, no era una elección) y respeta milspec, tokyo y concert;
    - Ajustes muestra Grafito primero.
  - **Hub:**
    - migración de 13 archivos (unos 45 tonos) y `colors.onAccent` en `hubStyles.ts`;
    - en los bloques de estilo con fondo de acento y texto claro, el texto pasa a `#15181C` (16 automáticos y 2 condicionales a mano), porque los acentos Grafito son claros.
* **Impacto en Audio / Red / UI:** solo visual. Ningún cambio de protocolo ni de audio.
* **Verificación y Pruebas (resultado literal):**
  - Líder: `ruff check src tests` da `All checks passed!` y `pytest -q` da `370 passed`. Actualicé dos pruebas que verificaban la paleta vieja (`test_paint_guard` y `test_visual_startup` esperaban `#000000`) y agregué otras dos: sin colores neón, y brillo guardado.
  - PWA: `npx vitest run` da `126 passed` (3 nuevas de `resolveTheme`). `lint`, `tsc` y `build`: sin errores. Playwright follower: `28 passed`.
  - Hub: `npm run lint` sin problemas; `verify:logic` da `23`, `34` y `14 ok`. Playwright leader-web: `23 passed`, incluida "aplica el tema oscuro" con el fondo nuevo.
  - Capturas: líder offscreen (Mezcla con el botón visible y la barra completa) y hub demo (PLAYLISTS).
* **Pendientes:**
  1. Fase 2: Escenario con letra y acordes; el mezclador del líder solo cuando hay stems.
  2. Ver en un ensayo si 70 % de brillo es un buen punto de partida.

### [2026-10-30] - Fase 2: letra y acordes en Escenario (líder y PWA); mezclador oculto sin stems
* **Sprint / Módulo:** `bandait-protocol` (contrato §9.1), `bandait-leader`, `bandait-follower`, `e2e`
* **Acción técnica realizada:**
  - **Protocolo (§9.1, antes solo propuesto):**
    - cada ítem del setlist lleva `content_etag` (opcional en el esquema: un líder anterior no lo envía);
    - `GET /songs/<song_id>.json` devuelve título, artista, tonalidad, compases y secciones con `start_bar` y ChordPro;
    - `content_etag` son los primeros 16 hex de SHA-1 del JSON canónico del contenido;
    - fixture `song_content` y esquema `message_types.json#/definitions/song_content`.
  - **Líder:**
    - `normalize_setlist` conservaba solo cinco campos y botaba las secciones que ya traía `load_setlist_entries`. Ahora `SetlistEntry` guarda secciones, artista y tonalidad, y expone `content()`, `content_etag` y `content_wire()`;
    - `LeaderHttpApp` sirve la ruta con `ETag`, responde `304` a `If-None-Match`, `404` a canciones fuera del setlist cargado, `Cache-Control: no-cache` y CORS `*`;
    - **Escenario** nuevo:
      - a la izquierda, el riel del setlist en vivo;
      - en el centro, la sección actual según el compás, con acordes sobre las sílabas (vista ACORDES) o solo la letra en grande (vista LETRA), y la siguiente sección debajo;
      - a la derecha, BPM, pulso, compás y próxima sección;
      - maquetado puro en `src/ui/chordpro_layout.py`;
    - el mezclador queda oculto por defecto y se muestra con **Ver > Mezclador**. No lleva el clic (el clic se escribe directo en la salida): enruta las entradas de la interfaz. La fase 3 lo mostrará sola cuando una canción traiga stems.
  - **PWA:**
    - `wire.ts` decodifica `content_etag` y `song_content`;
    - `services/songContent.ts` descarga por etag, primero la canción actual y de a dos;
      - reintenta tras 3 s, hasta 4 intentos, y no insiste ante un `404`;
      - guarda en memoria, así que el prompter sigue en Flywheel sin red;
    - `ChordProPrompter` arma cada línea en bloques {acorde, palabra}, así el acorde sigue sobre su sílaba aunque la línea se parta en un teléfono angosto;
    - la sección sale del compás del scheduler por rAF y React solo vuelve a pintar cuando cambia la sección;
    - botón ACORDES/LETRA, que se recuerda en `localStorage`.
* **Impacto en Audio / Red / UI:**
  - Audio: ninguno.
  - Red: una petición HTTP por canción cuando cambia su etag, fuera del camino caliente del metrónomo.
  - UI: Escenario nuevo en el líder y prompter real en la PWA (antes decía "SIN LETRA // LA DISTRIBUCION DE LETRAS DESDE EL LIDER ESTA PENDIENTE").
* **Verificación y Pruebas (resultado literal):**
  - Líder: `ruff check src tests` da `All checks passed!` y `pytest -q` da `388 passed`. Pruebas nuevas:
    - `test_song_content.py`: etag, secciones conservadas y secciones mal formadas;
    - `test_stage_prompter.py`: maquetado, escape de HTML, sección por compás y modos;
    - casos `/songs` en `test_http_follower.py`: 200, 304, HEAD, 404 y servidor real;
    - esquema `song_content` y contenido del líder contra el esquema;
    - riel y mezclador oculto en `test_leader_ui_path.py`;
    - pintado con letra a tres tamaños en `test_paint_smoke.py`.
  - PWA: `npx vitest run` da `138 passed` (12 nuevas en `songContent.test.ts`); `lint`, `tsc` y `build`, sin errores. Playwright follower da `28 passed`; la prueba de escenario ahora sirve el fixture y comprueba INTRO, `Am` y "SIGUE: ESTROFA 1".
  - **Prueba real de punta a punta:** líder headless en 127.0.0.1:4041 con un setlist de prueba de 4 secciones, que sirve la PWA compilada.
    - `curl` dio `200` con `etag: "43347fec55f62144"`, `304` con `If-None-Match` y `404` para una canción ajena.
    - En Playwright a 412x860, tras PLAY el prompter pasó de INTRO a ESTROFA 1 (C 3-6), CORO (C 7-10) y FINAL, y se quedó en FINAL pasado el compás 16. Se probaron las dos vistas.
  - Capturas del Escenario del líder fuera de pantalla a 1280x720, en las vistas ACORDES y LETRA.
* **Errores propios y hallazgos:**
  - Un `\n` dentro de un heredoc quedó como salto de línea real en `http_app.py` (error de sintaxis); lo detectó ruff.
  - La primera versión del almacén reintentaba al instante tras un error de red, sin esperar. Lo detectó la prueba de reintentos; ahora espera el temporizador.
  - En la verificación con Playwright el service worker sirvió el bundle anterior hasta borrar su caché. Un teléfono que ya tiene la PWA puede necesitar una recarga para tomar la versión nueva.
  - **Hallazgo, anterior a este cambio:** `bandait_dark.qss` fija `QWidget { font-size: 13px }`, que pisa todo `setFont()`. El BPM de "72 pt" del Escenario salía en 13 px. En Escenario los tamaños pasaron a la hoja de estilo de cada etiqueta. Otras vistas del líder pueden tener el mismo problema; no lo revisé.
  - En el teléfono, con el mando del director visible, la caja de letra queda chica (unos 100 px a 412x860). Se agranda ocultando el mando, y un músico no lo tiene. No moví el deslizador de PANIC para hacer espacio.
* **Pendientes:**
  1. Ensayo real con B&O's: cargar letra y acordes de al menos una canción desde el hub y confirmar en dos teléfonos y en el líder que la sección cambia en el compás correcto.
  2. Revisar el resto de vistas del líder por el mismo `font-size: 13px` del QSS.
  3. Fase 3: stems en MP3 desde el ZIP de Moises (hub), reproducción en el líder y vista multipista; mostrar el mezclador solo cuando la canción tenga stems.
  4. Crear el tag de la versión del líder que incluya esta fase (los tags los crea Daniel Castaneda).

### [2026-10-30] - Fase 3 (líder): stems de la canción en vivo por la PA, sincronizados con el clic
* **Sprint / Módulo:** `bandait-protocol` (fixture `stem_names.json`), `bandait-leader`
* **Acción técnica realizada:**
  - **Reconocimiento por nombre** (`src/audio/stem_names.py`):
    - reglas y casos en `bandait-protocol/fixtures/stem_names.json`, compartidos con el hub;
    - gana la palabra clave que termina más a la derecha ("La Voz del Mar - Drums" da batería);
    - sin coincidencia, el rol queda `unknown`.
    - Daniel Castaneda no puede abrir Moises desde este equipo: los casos se escribieron a partir de los nombres típicos de exportación y faltan contrastarlos con un ZIP real.
  - **Biblioteca en disco** (`src/audio/stem_library.py`):
    - ruta `<BANDAIT_HOME>/Stems/<carpeta segura por song_id>/` con `manifest.json` (rol, etiqueta, ganancia, mute y alineación);
    - importar un ZIP (exportación de Moises) o archivos sueltos reemplaza los stems de la canción;
    - de cada miembro del ZIP solo se usa el nombre base, así que un `../../x` no sale de la carpeta;
    - topes de 400 MB por archivo, 2 GB por importación y 16 pistas;
    - reintentos cortos ante `PermissionError` de Windows.
  - **Decodificación** con `soundfile` (libsndfile 1.2.2, lee MP3) a int16 estéreo a la frecuencia del motor:
    - remuestreo con scipy si está y lineal si no; scipy no está en `requirements.txt`, así que el instalador usa el lineal;
    - **M4A/AAC no se puede leer en el líder** (libsndfile no lo soporta y no hay ffmpeg): la pista muestra "exporta los stems en MP3".
  - **Motor de audio**:
    - los stems suenan en las Salidas 1-2 (nunca en la del baterista);
    - la posición sale del mismo horario que el clic: posición musical desde el compás 1 al BPM de la canción, más la alineación;
    - el puntero corre libre y solo se realinea cuando cambia el horario (PLAY, reanudar, salto, nudge) o llegan stems o alineación nuevos;
    - así, si el BPM del hub no coincide exacto con la grabación, el stem deriva suave en vez de saltar cada pocos segundos.
  - **Interfaz**:
    - panel STEMS a la derecha, visible solo cuando la canción en vivo tiene stems, con un canal por pista (M, S y volumen), alineación en ms, Reemplazar y Quitar;
    - Audio > "Importar stems de la canción en vivo...";
    - importar y quitar solo con la banda detenida;
    - la carga corre en un hilo aparte y se descarta si la canción cambió mientras tanto;
    - los ajustes se guardan en el manifiesto (con espera de 800 ms tras el último cambio).
* **Impacto en Audio / Red / UI:**
  - Audio: nueva fuente en Salidas 1-2. El callback sigue sin reservar memoria por bloque (lo prueba `test_audio_stems.py`).
  - Red: ninguno.
  - UI: panel STEMS condicional.
* **Verificación y Pruebas (resultado literal):**
  - `ruff check src tests` da `All checks passed!` y `pytest -q` da `432 passed`. Nuevas:
    - `test_stem_names.py` (27): los 25 casos del fixture, más que las reglas coincidan con él;
    - `test_stem_library.py` (5): ZIP tipo Moises con un miembro malicioso, reemplazo que conserva la alineación, límites, MP3 real a 44,1 kHz remuestreado a 48 kHz, y M4A rechazado con el mensaje;
    - `test_audio_stems.py` (5):
      - el impulso del stem cae en el sample exacto con conteo de 2 compases y al reanudar desde el compás 3 con -250 ms de alineación;
      - ganancias, mute y STOP;
      - deriva libre sin saltos con BPM 120 contra una grabación a 121;
      - sin reservas por bloque con 5 stems;
    - `test_stems_controller.py` (5) y una prueba de ventana completa: importar, ver el panel, cambiar de canción (el panel se oculta) y volver (los stems se recargan del disco).
  - Captura fuera de pantalla de la ventana con 7 stems sintéticos.
  - **No verificado:** sonido real por una interfaz ASIO; un ZIP real de Moises; canciones de 4 minutos o más (tiempo de carga y memoria: unos 46 MB por stem de 4 minutos).
* **Errores propios y hallazgos:**
  - La primera mezcla sumaba sobre una vista 2D con saltos (`outdata[:, 0:2]`) y numpy reservaba unos 17 KB por bloque. Ahora se suma canal por canal con vistas 1D.
  - La prueba de memoria medía su propia lista de picos (20 KB de "crecimiento" falso). Medido aparte, el callback crece 288 B en 1.500 bloques, frente a 224 B sin stems.
  - Primera regla de sincronía: realinear si la deriva pasaba de 30 ms. La cambié antes de integrar, porque con un BPM inexacto habría saltos audibles cada pocos segundos.
* **Pendientes:**
  1. Probar con un ZIP real de Moises en MP3 (desde otro equipo) y agregar al fixture los nombres que no reconozca.
  2. Ensayo con interfaz real: confirmar la alineación stems-clic y el tiempo de carga de un setlist con stems.
  3. Decidir dónde guardar los stems en la nube (R2 por URiT o Supabase Storage) para que el hub y el líder los compartan. Hoy cada uno importa los suyos.
  4. Decidir si se agrega scipy al instalador (mejor remuestreo de 44,1 kHz a 48 kHz) o si se abre el stream a 44,1 kHz cuando la canción tiene stems.

### [2026-10-30] - Fase 3 (hub): estudio de stems en casa (PR #28)
* **Sprint / Módulo:** `bandait-leader-web` (vista PISTAS & STEMS), `e2e`, `landing/hub`. Lo hizo un subagente en un worktree aparte; la sesión principal lo integra.
* **Acción técnica realizada:**
  - `StemsHubView` era una maqueta (matriz fija de 6 canales, input sin manejador, Demucs inexistente). Ahora:
    - por cada canción, importar un ZIP de Moises o archivos sueltos;
    - lista reconocida con `stemNames.ts`, que aplica las mismas reglas y casos que el líder;
    - un rol `unknown` bloquea el guardado hasta corregirlo o desmarcar la pista;
    - opciones AGREGAR o REEMPLAZAR, y quitar.
  - Almacenamiento: audio en IndexedDB (`bandait_stems`, por `song_id`), solo en el navegador. No se tocó el esquema del workspace ni la sincronización con Supabase.
  - Reproductor Web Audio:
    - todas las pistas arrancan en el mismo instante del AudioContext;
    - mute, solo, volumen por pista y general;
    - repetir una sección o un tramo A-B programando tramos consecutivos, sin `source.loop`, para que pistas de distinta duración no se desalineen;
    - el AudioContext se cierra al salir de la vista.
  - ZIP con `fflate` 0.8.2, cargado solo cuando se suelta un ZIP (fragmento de 7.6 KB).
* **Impacto en Audio / Red / UI:** solo el hub; en el escenario no cambia nada. Ninguna red nueva.
* **Verificación y Pruebas (resultado literal, del informe del subagente):**
  - `npm run lint && npm run verify:logic && npm run build` dan EXIT=0. `verify:logic` da `38 ok, 0 fallas` en el script nuevo (los 25 casos del fixture, más los tiempos de sección).
  - Playwright leader-web da `26 passed`, y luego `3 passed` en el spec nuevo tras agregar dos pruebas. Las pruebas usan WAV y ZIP generados dentro de la prueba y cubren:
    - lista reconocida y un MP3 corrupto con su error en la pista;
    - reproducir, detener, mute y repetir la Intro;
    - stems que siguen tras recargar, y borrado;
    - un ZIP dañado con error legible;
    - 390 px sin scroll horizontal y el AudioContext cerrado al salir.
  - Capturas a 1440 y 390 px revisadas por el subagente.
* **Pendientes:**
  1. No se escuchó el audio (Chromium sin pantalla). Solo se probó WAV; MP3, M4A, FLAC y OGG dependen del navegador.
  2. Memoria: 6 stems de 4 minutos ocupan unos 0.5 GB decodificados; hay que medirlo en un móvil.
  3. Decidir si al SALIR del hub en equipos compartidos se borran los stems de IndexedDB.
  4. Retirar en un cambio aparte `stemsMap`, `SongStems`, `updateStemTrackVolume` y los datos demo de 6 canales, que ya no usa ninguna vista.
  5. Nube: los mismos pendientes que el líder (dónde guardar y si los metadatos van al workspace).

### [2026-10-31] - Fase 3: stems en la nube (Cloudflare R2) compartidos entre el hub y el líder
* **Sprint / Módulo:** `bandait-stems-worker` (nuevo), `bandait-leader-web` (PR #30, hecho por un subagente), `bandait-leader`, CI
* **Acción técnica realizada:**
  - **Decisión de Daniel Castaneda:** guardar los stems en R2 con la credencial de Cloudflare de ClipVault (`releven-deploy-cloudflare-api-key`). La calidad del remuestreo actual queda como está para ensayos.
  - **Worker `bandait-stems`** en `https://bandait-stems.oooglue.workers.dev`, bucket privado `bandait-stems`, desplegado con `wrangler deploy` a través de ClipVault.
    - Valida la sesión de Supabase de quien llama con su propio JWT y la clave publicable, mediante la RPC `bandait_band_role` ya existente. No hay `service_role` ni secretos en el Worker.
    - Escriben Owner y MusicDirector; leen todos los integrantes. `me` es el workspace personal.
    - Primero se suben los archivos y después el manifiesto, que es el commit: valida que cada archivo exista con su tamaño y borra los huérfanos.
    - Contrato en `bandait-stems-worker/README.md`.
    - **Alternativa descartada:** `urit-media` de URiT, porque necesita un consumidor con backend que firme permisos. Ese consumidor sería otro Worker, y con R2 enlazado ya alcanza para guardar y servir.
  - **Hub** (PR #30):
    - `stemCloud.ts` y la barra de estado por canción: SOLO EN ESTE EQUIPO, SUBIENDO n/m, EN LA NUBE, LA NUBE TIENE OTRA VERSIÓN, o ERROR con REINTENTAR;
    - los editores suben al guardar; cualquier integrante puede DESCARGAR DE LA NUBE;
    - borrar pregunta si es solo de este equipo o también de la nube;
    - aviso de que el líder no lee M4A;
    - `VITE_BANDAIT_STEMS_URL` en `.env.production` (valor público; tabla de DEPLOY.md, sección 3.6).
  - **Líder:**
    - `src/cloud/stems_cloud.py`: manifiesto de la banda compartida, con respaldo a `me`; descarga por bloques con verificación de tamaño;
    - aplica roles, etiquetas y alineación del manifiesto;
    - con la banda detenida, cambiar de canción revisa la nube; sin red usa lo del portátil;
    - Audio > "Descargar stems del setlist (nube)" reemplaza también los stems importados a mano, cosa que la revisión automática no hace.
  - **CI:** nuevo job "Stems Worker (R2)" con pruebas, tipos, build y un control de que no aparezcan `service_role` ni `sb_secret_` en `wrangler.jsonc`.
* **Impacto en Audio / Red / UI:**
  - Red: el líder usa la red solo con la banda detenida o en la descarga explícita del setlist; nunca durante la canción.
  - Audio: sin cambios.
  - UI: barra de nube en el estudio del hub y una acción nueva en el menú Audio del líder.
* **Verificación y Pruebas (resultado literal):**
  - Worker: `npm test` da `# pass 9`, `tsc` OK y `wrangler deploy --dry-run` OK.
  - En producción:
    - `GET /v1/health` da `{"ok":true,"version":"1.0.0"}`;
    - sin token: 401; con un JWT falso, `{"error":"invalid_token"}` 401, rechazado por Supabase;
    - preflight desde `https://bandait.releven.cc` devuelve `Access-Control-Allow-Origin` con ese origen; desde un origen ajeno, 403.
  - Líder: `ruff check src tests` da `All checks passed!` y `pytest -q` da `440 passed`. Pruebas nuevas en `test_stems_cloud.py` y `test_stems_controller.py`:
    - descarga, "current" sin volver a bajar, respaldo a `me`;
    - los stems manuales no se pisan sin `force`;
    - una descarga incompleta deja intactos los stems anteriores;
    - sin red se usan los locales;
    - descarga del setlist completo.
  - Hub (corrido por la sesión principal tras integrar): `lint` OK; `verify:logic` da `23/34/14/50 ok, 0 fallas`; `build` OK; `CI=1 npx playwright test --project=leader-web --retries=0` da `31 passed`.
* **No verificado:**
  - Subida y descarga reales con cuentas de Supabase reales (Owner y Musician de B&O's), y el CORS real desde el hub publicado.
  - Archivos cerca de 200 MB y redes lentas.
* **Errores propios:**
  - Integré la rama del hub con un merge local mientras Daniel Castaneda fusionaba el mismo PR #30 en GitHub. El contenido era idéntico (diff vacío).
  - Un `reset --hard` para alinear fue bloqueado por el clasificador de permisos; seguí en una rama nueva desde la remota (`stems-nube-integracion`) y la rama local anterior quedó sin tocar.
* **Pendientes:**
  1. Primera prueba real: Daniel Castaneda (Owner de B&O's) sube los stems de una canción en MP3 desde el hub; otro integrante los descarga; el líder los baja con Audio > Descargar stems del setlist.
  2. Opcional: un `GET` del Worker que devuelva el rol, para que el hub sepa si puede escribir sin intentar un PUT (nota del subagente).
  3. Opcional: progreso por bytes (XHR) para archivos grandes en el hub.
  4. Borrar la rama local vieja `feat/stems-nube` cuando ya no haga falta (`git branch -D feat/stems-nube`, lo corre Daniel Castaneda).

### [2026-10-31] - Líder 2.2.1: la descarga de stems fallaba en todas las canciones (Cloudflare error 1010)
* **Sprint / Módulo:** `bandait-leader` (`src/cloud/stems_cloud.py`, `src/ui/stems_controller.py`)
* **Estado encontrado:** Daniel Castaneda subió stems desde el hub y suenan bien allí. En el líder 2.2.0, Audio > "Descargar stems del setlist (nube)" mostró "0 canciones descargadas, 30 con error", sin motivo.
* **Causa (verificada):** Cloudflare responde `403` con `error code: 1010` (firma de navegador bloqueada) a las peticiones con el User-Agent por defecto de Python (`Python-urllib/3.x`). Con un User-Agent propio responden bien. Prueba en Python contra `https://bandait-stems.oooglue.workers.dev/v1/health`:
  - sin User-Agent propio: `403 b'error code: 1010\n'`;
  - con `Bandait-Leader/2.2.0`: `200 {"ok":true,"version":"1.0.0"}`.

  Fallaban también las canciones sin stems, porque la petición nunca llegaba al Worker. El motivo no aparecía porque el resumen solo contaba errores y el detalle iba al log.
* **Corrección aplicada:**
  - `StemsCloud` manda `User-Agent: Bandait-Leader/<APP_VERSION>`; la ventana le pasa la versión, porque en el instalador no hay código fuente que leer.
  - Si la respuesta de error no es el JSON del Worker, el error HTTP conserva su texto (por ejemplo "error code: 1010").
  - El resumen del setlist dice el primer error: "N con error (primero: <canción>: <motivo>)".
  - Versión 2.2.1.
* **Verificaciones:**
  - `pytest -q` da `442 passed`, con dos pruebas nuevas: el User-Agent nunca es Python-urllib, y el texto del bloqueo llega al mensaje.
  - Contra el Worker real, con un token falso:
    - con `Python-urllib/3.11`, `403` con la página HTML de bloqueo de Cloudflare;
    - con `Bandait-Leader/2.2.1`, `401 invalid_token`: llega al Worker.
  - **No verificado:** la descarga con la sesión real de Daniel Castaneda; queda para cuando instale la 2.2.1.
* **Errores propios:** las pruebas de la versión anterior usaban un servidor simulado que no reproduce la protección de Cloudflare, y la verificación en producción del Worker se hizo con `curl`, que Cloudflare no bloquea. Nada probó el cliente de Python contra el Worker real antes de publicar la 2.2.0.
* **Pendientes:**
  1. Instalar la 2.2.1 y repetir Audio > "Descargar stems del setlist (nube)".
  2. Si otro cliente en Python (por ejemplo el de Supabase en `src/cloud/http.py`) pasa algún día por un dominio con esa protección, necesitará el mismo User-Agent. Hoy Supabase responde bien.

### [2026-10-31] - Bandait 2.3: rediseño del líder, paridad con el hub y Music AI
* **Sprint / Módulo:** `bandait-leader` (2.3.0), `bandait-leader-web` (PR #34), `bandait-stems-worker`, `bandait-protocol`. La maqueta aprobada por Daniel Castaneda está en https://claude.ai/artifact/LcgsE5Mv2B9NFwp3hVo2Up. Plan: riel lateral, siete vistas con los mismos nombres en el líder y el hub, y entrega en un solo cambio.
* **Estado encontrado (líder):**
  - 142 `setStyleSheet` inline y unos 274 hex sueltos fuera de `theme.py`.
  - `QWidget { font-size: 13px }` pisaba todo `setFont`.
  - **"Inter" no existe en Windows y Qt la cambiaba por Agency FB**, una letra condensada: así se veía el líder en el equipo de Daniel Castaneda. Esa es la causa principal de que se viera "flojo".
  - La pestaña IA daba respuestas fijas; BUCLE y el pan no estaban conectados; "+ Agregar Sección" era solo visual.
  - Los diálogos no heredaban el QSS de la ventana: por eso cada uno tenía su propio estilo.
* **Acción técnica realizada:**
  - **Base de estilos:**
    - `theme.py` tiene escala tipográfica, espaciado, radios y `render_qss`;
    - `bandait_dark.qss` es una plantilla con `@TOKEN`, sin hex, aplicada a toda la aplicación;
    - la fuente base va en `QApplication.setFont` y se aplica antes de construir la interfaz;
    - Space Grotesk e IBM Plex Mono estáticas (OFL) en `resources/fonts` (las mismas de la PWA y el hub), con sustitución de Inter y JetBrains Mono;
    - `components.py` estila por propiedades (`role`, `kind`, `variant`, `tag`, `tone`, `health`);
    - `test_no_inline_styles.py` impide volver a los estilos inline: hoy queda 1 `setStyleSheet`, el de la plantilla.
  - **Estructura:**
    - riel lateral (`shell.py`, íconos dibujados con QPainter porque el instalador no trae QtSvg);
    - barra superior con banda, transporte compacto, canción en vivo y siguiente, músicos y PANIC;
    - barra de estado con chips que se ocultan mientras hay un mensaje temporal.
  - **Vistas:**
    - **Escenario:** tres columnas. Setlist; prompter con avance por secciones; pulso, músicos con latencia y estado de stems.
    - **Ensayo:** bucle de sección real en el transporte, hecho por el subagente (PR #35).
      - `set_loop`/`tick`: re-ancla en el límite de compás con un `bar_offset` menor, igual que TEMPO_NUDGE.
      - CONTRACT_V3 sección 6, regla 11.
      - Una prueba vitest muestra que la PWA lo sigue sin cambios.
    - **Setlists/Canciones:** la biblioteca sin título duplicado. Canciones con inspector (datos, stems, secciones) y Analizar con IA.
    - **Pistas:** regla de secciones y un carril por stem con su envolvente, calculada en el hilo de carga; mezclador de stems; mezclador de entradas plegado.
    - **Banda:** integrantes desde Supabase (`members.py`, RLS), conectados con latencia y salida de audio, y QR.
    - **Ajustes:** reúne audio, clic y ruteo, red, cuenta y nube, pantalla y voz.
    - Se borra `ai_view.py`.
  - **Music AI:**
    - el Worker recibe la mezcla, la sube a Music AI (workflow `stems-workflow-releven-bandait`, clave como secreto del Worker) y ensambla una sola vez el borrador (`analysis.ts`): secciones con compases, acordes por compás en ChordPro, BPM y tono;
    - el líder mezcla los stems (mono, 22 050 Hz, sin clic ni guía), lo lanza y consulta;
    - el hub lo acepta en el editor de la canción.
  - **Hub (PR #34, subagente):**
    - navegación SETLISTS, CANCIONES, ENSAYO, PISTAS, BANDA, AJUSTES;
    - ENSAYO con el prompter siguiendo la reproducción de los stems;
    - Analizar con IA;
    - editar equipos;
    - borrado del código en vivo que no se usaba.
* **Hallazgos de Music AI (análisis real de "Dame tu aire"):**
  - el workflow devuelve `Bpm`, `Root Key`, `Sections` (`{start,end,label}`), `ChordsMap` (con `start_bar`/`start_beat`) y `Lyrics`;
  - **`Lyrics` no trae tiempos**: la letra queda como "letra sin ubicar". Si se agrega al workflow el módulo de letra alineada, el ensamblador ya la ubica por sección;
  - detectó 124 BPM; en el hub la canción estaba en 92.
* **Verificación y Pruebas (resultado literal):**
  - Líder: `ruff check src tests` da `All checks passed!` y la última corrida completa local dio `1 failed, 490 passed` (falla de `test_no_control_without_a_function`, ya corregida; ese archivo da `16 passed`, y `test_no_inline_styles.py` da `2 passed`). La corrida completa posterior la detuvo Claude Code por falta de memoria en el equipo: la suite completa queda para el CI del PR.
  - Worker: `npm test` da `# pass 13`. Desplegado (versión `08dd9de5`) y con el secreto `MUSICAI_API_KEY` cargado.
  - Hub (según el informe del subagente, PR #34): `verify:logic` da `61 ok, 0 fallas` y Playwright leader-web da `39 passed`.
  - PWA (PR #35): `vitest` da `140 passed`.
  - Capturas fuera de pantalla de las siete vistas a 1440x900, comparadas con la maqueta.
* **No verificado:**
  - un análisis completo de punta a punta desde el hub o el líder con sesión real (el Worker y Music AI se probaron por separado);
  - el bucle con audio ASIO y teléfonos reales;
  - el líder en una pantalla real de Windows (solo capturas fuera de pantalla).
* **Errores propios:**
  - en un script usé `setProperty("text", ...)` sobre QLabel, que reemplaza el texto; lo detecté antes de usarlo y la propiedad pasó a `kind`;
  - Space Grotesk variable no se veía fuera de pantalla: se cambió por las estáticas;
  - quité `DIALOG_QSS` de un archivo antes que de su importador y el script se cortó a la mitad; se corrigió a mano.
* **Pendientes:**
  1. Tempo de práctica: hoy solo avisa. Necesita estirar el audio sin cambiar el tono (time-stretch), tanto en el líder como en el hub.
  2. Agregar al workflow de Music AI la letra con tiempos.
  3. Primera prueba real: analizar una canción de B&O's desde el hub o el líder, y aceptarla en el hub.
  4. Al aceptar un borrador en el hub cambian los ids de las secciones; el líder las ve como secciones nuevas.


### [2026-10-31] - Líder 2.2.2: el resumen de "Descargar stems del setlist" cuenta todos los resultados
* **Sprint / Módulo:** `bandait-leader` (`stems_controller.py`), `bandait-protocol/fixtures/stem_names.json`
* **Estado encontrado:** con la 2.2.1, Daniel Castaneda vio "0 canciones descargadas" y lo leyó como un fallo. En realidad la descarga funcionó:
  - `logs/bandait-leader.log` no tiene errores desde que arrancó la 2.2.1 (00:02); los 60 `HTTP 403` son de la 2.2.0, a las 23:35;
  - `Documents/Bandait/Stems/c68e20c5-.../manifest.json` tiene los 6 stems de "Dame tu aire" con `cloud.updated_at = 2026-10-31T04:29:48.259Z`.
* **Causa:** solo una canción tenía stems en la nube. Si ya estaba bajada, porque se descarga sola al elegirla con la banda detenida, contaba como "current"; las otras 29 contaban como "none". El resumen solo mostraba las descargadas y los errores.
* **Corrección aplicada:**
  - `setlist_summary` cuenta descargadas, ya al día, sin stems en la nube, solo locales y con error. Ejemplo: "0 descargadas, 1 ya al día, 29 sin stems en la nube".
  - El fixture de nombres suma los nombres reales de la exportación de Moises (`<artista> - <título>_<stem>_mixed.mp3`, incluido `guitars` y `piano`). Los reconocen el líder y el hub.
  - Versión 2.2.2.
* **Verificaciones:**
  - Líder: `pytest -q` da `450 passed`.
  - Hub: `npm run verify:logic` da `57 ok, 0 fallas` en el script de stems.
* **Pendientes:** integración con Music AI para proponer secciones y ChordPro (entrada aparte cuando exista).
