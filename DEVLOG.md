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
  - `bandait-leader`: Pruebas de servicio XLSX (`test_xlsx_service.py`) y servicio de autenticación multi-banda (`test_auth_service.py`) ejecutadas con éxito (100% verde).
  - `bandait-follower`: Validación estática de tipos `tsc --noEmit` y linter `eslint` completados con 0 errores y 0 advertencias.
  - Pruebas unitarias de reconciliador cliente en `xlsxService.test.ts`.
