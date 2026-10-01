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

