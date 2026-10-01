# Bandait 3.0: The Live Band Operating System

> **FUENTE DE VERDAD / SINGLE SOURCE OF TRUTH:**  
> Toda la arquitectura, modelos de datos, ergonomía de hardware, sistema de diseño y hoja de ruta de implementación están especificados y blindados en:  
> [`docs/PLAN_BANDAIT_3.0_MASTER.md`](docs/PLAN_BANDAIT_3.0_MASTER.md)  
> Cualquier desarrollo, refactorización o sesión de IA (Antigravity/agy) debe consultar y alinearse estrictamente con este documento.

---

## 1. Visión General

Bandait 3.0 es un sistema operativo en vivo de ultra-baja latencia para agrupaciones musicales y directores en escenario:
- **Estación Central Líder (Desktop):** Aplicación PySide6 en Python con ruteo de hardware ASIO nativo (salidas 1-2 a PA/FOH, salida 3 cableada para baterista a < 1.5ms).
- **Seguidores & Control Remoto (PWA):** Aplicación React 19 + TypeScript + Vite. Teleprompter ChordPro de alta visibilidad, monitoreo in-ear personal con pre-caché IndexedDB y limitador a -0.5 dBFS.
- **Mando Concurrente Maestro:** El Director Musical puede gobernar el transporte (Play, Stop, Cue, Next) indistintamente desde su smartphone o desde la laptop en mesa de sonido.
- **Tolerancia a Caídas Wi-Fi (Modo Flywheel):** El reloj de Web Audio API mantiene el pulso rítmico por inercia matemática si se interrumpe la red, realineando la fase suavemente (*soft phase-alignment*) al reconectar.
- **Web Admin Hub Multi-Banda:** Gestión multi-agrupación, roles (`Owner`, `MusicDirector`, `Musician`, `Substitute`), login por WhatsApp / SMS OTP y Google OAuth, con soporte universal de importación/exportación en Excel (`.xlsx`) mediante libro maestro con *Diff Preview*.
- **Pipeline de Audio IA:** Separación de stems en la nube con GPU (Demucs), detección de acordes y asistente de setlist armónico (Camelot Wheel).

---

## 2. Sistema de Diseño y Ergonomía de Hardware

- **Tema Predeterminado:** **Swiss Bauhaus Lab** (`Space Grotesk` + `IBM Plex Mono`).
- **Independencia por Músico:** Cada integrante elige libremente su estilo visual en su dispositivo (`localStorage`), desacoplado de la sincronización de red:
  1. *Swiss Bauhaus Lab* (Racionalismo funcionalista, escala métrica neutra).
  2. *Mil-Spec Avionics HUD* (`Bebas Neue` + `Share Tech Mono`, fósforo ámbar, lectura a 3 metros).
  3. *Tokyo 1989 VFD* (`Orbitron` + `Silkscreen`, brillo fluorescente cian, estética sampler vintage).
  4. *Concert Hall* (`Cinzel` + `Playfair Display`, números romanos, terciopelo y bronce bruñido).
- **Prototipos Interactivos:** Disponibles en `docs/design_system/`:
  - `docs/design_system/bandait_radical_styles_studio.html` (Estudio comparativo de los 4 estilos y tipografías).
  - `docs/design_system/bandait_pro_redesign_studio.html` (Paradigmas de layout: Cockpit HUD, Rack 19", Nordic Field).
  - `docs/design_system/bandait_blueprint_ui.html` (Simulador de consola central y ruteo ASIO).
- **Regla Estricta:** Cero iconos emoji en toda la plataforma (uso exclusivo de glifos SVG técnicos y tipografía especializada).

---

## 3. Estado real de implementación (2026-09-30)

La hoja de ruta de sprints está en el plan maestro. Lo que de verdad funciona hoy, verificado con pruebas y no solo descrito, es:

- **Núcleo de escenario (líder + follower):** el líder arranca su servidor Socket.IO, el transporte pasa por un único camino (laptop y director móvil), el follower programa el clic en Web Audio a partir del anchor del líder, con Flywheel y corrección suave de fase. El protocolo está fijado en [`bandait-protocol/CONTRACT_V3.md`](bandait-protocol/CONTRACT_V3.md).
- **En escenario:** el líder sirve el follower por HTTP en la LAN (`http://<ip-lan>:4040/`) y muestra dos QR, uno para músicos y otro para el director (menú Red > Conectar músicos). El sitio HTTPS `/app/` no puede conectarse a la LAN (contenido mixto) y redirige al líder.
- **Web Hub:** CRUD local-first, con nube en producción desde el 2026-10-01 (Supabase Auth con Google y RLS por usuario; proyecto y pasos en `docs/DEPLOY.md`).
- **Manuales de usuario desactualizados (pendiente de cierre):** los modales "Manual de usuario y guía técnica" del hub y "Manual de escenario" del follower describen el plan, no el comportamiento real. Por decisión del usuario, se reescriben **al final del refinamiento de la plataforma**; el detalle de lo que hay que corregir está en `DEVLOG.md` (entrada del 2026-10-01, "Manuales").
- **Pendiente** (stub o sin implementar): OTP por WhatsApp/SMS, Demucs/stems en nube, reproducción de stems en el mezclador in-ear, importación XLSX real, detección de acordes/BPM, prompts de voz con audio, lógica de `transition_mode` (conteo y gapless), distribución de letras, roles con permisos del lado del servidor y servidor NTP por UDP.
- Bugs abiertos y advertencias: [`bugs.md`](bugs.md). Historial: [`DEVLOG.md`](DEVLOG.md).

---

## 4. Guía para Nuevos Chats de Agentes (Antigravity / agy)

Si inicias una sesión en este repositorio desde otro chat de `agy`:
1. Lee `docs/PLAN_BANDAIT_3.0_MASTER.md` antes de proponer cambios arquitectónicos, y `bandait-protocol/CONTRACT_V3.md` antes de tocar la red.
2. Consulta `AGENTS.md` para las reglas de desarrollo, pruebas y restricciones visuales.
3. Verifica el estado de las pruebas (el CI no enmascara fallos):
   - Líder: `cd bandait-leader && ruff check src tests && QT_QPA_PLATFORM=offscreen python -m pytest -q`
   - Follower: `cd bandait-follower && npm run lint && npx vitest run && npm run build`
   - Hub: `cd bandait-leader-web && npm run lint && npm run verify:logic && npm run build`
   - E2E: `npx playwright test` desde la raíz.
4. Líder sin interfaz gráfica, para probar followers: `cd bandait-leader && python -m src.headless --port 4040`.
5. Los bundles publicados en `landing/app` y `landing/hub` se regeneran con `npm run build:landing` desde la raíz; no se copian a mano.
