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

## 3. Hoja de Ruta de Sprints

1. **Sprint 1 (En curso):** Higiene legacy Flutter (`_archive/flutter_legacy/`), corrección de fase `beat = 1` en `clock_service.py`, motor ASIO multicanal en `engine.py`, navegación PWA con tema Swiss Lab y base Flywheel.
2. **Sprint 2:** Web Admin Hub, autenticación WhatsApp/Google, roles multi-banda y servicio XLSX con *Diff Preview*.
3. **Sprint 3:** Protocolo de control remoto concurrente, banner de alerta de saltos de setlist y componentes táctiles de hardware.
4. **Sprint 4:** Pre-caché IndexedDB de stems, pipeline de IA en nube (Demucs) y asistente Camelot.

---

## 4. Guía para Nuevos Chats de Agentes (Antigravity / agy)

Si inicias una sesión en este repositorio desde otro chat de `agy`:
1. Lee `docs/PLAN_BANDAIT_3.0_MASTER.md` antes de proponer cambios arquitectónicos.
2. Consulta `AGENTS.md` para las reglas de desarrollo, pruebas y restricciones visuales.
3. Verifica el estado de las pruebas con `pytest bandait-leader/tests` y `npm test --prefix bandait-follower`.
