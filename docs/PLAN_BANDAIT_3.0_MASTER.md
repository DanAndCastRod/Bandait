# Bandait 3.0: The Live Band Operating System
## Plan Maestro de Reconceptualización, Arquitectura y Diseño de Hardware/Escenario

**Fecha de Aprobación:** 4 de Septiembre de 2026  
**Estado:** Aprobado para Ejecución en Sprints  
**Tema Visual Predeterminado:** Swiss Bauhaus Lab (Personalizable independientemente por músico)  
**Restricción Estética Central:** Cero iconos emoji en toda la plataforma (100% SVG vectorial técnico y tipografía especializada).

---

## 1. Visión y Reconceptualización

Bandait 3.0 evoluciona de un metrónomo sincronizado básico a un **Sistema Operativo en Vivo para Bandas**, cubriendo las necesidades críticas del escenario, el ensayo y la administración técnica de agrupaciones musicales:

* **Sincronización Híbrida de Ultra-Baja Latencia:** Protocolo de tiempo NTP local sobre Wi-Fi (offset verificado < 5.1ms, jitter < 0.2ms) con fallback transparente por Internet (WebSocket/WebRTC).
* **Ruteo Físico ASIO Profesional en Líder:** Generación de clic y pistas auxiliares directo al hardware de audio (Salidas 1-2 a PA/FOH, Salida 3 dedicada al baterista por cable sin latencia de red).
* **Control Remoto desde Smartphone:** El director musical puede gobernar el transporte, tempo, sección y armado de pistas desde su teléfono sin acercarse a la laptop del líder.
* **Administración Multi-Banda y Web Hub:** Gestión de múltiples agrupaciones por usuario con autenticación Google OAuth y SMS/OTP por número celular.
* **Playlists y Setlists de Primer Nivel:** Manejo de tonalidades por show, tiempos acumulados, notas de transición entre canciones y orden drag-and-drop.
* **Importación y Exportación Universal XLSX:** Todo el catálogo de canciones, setlists y miembros de equipo se importa y exporta en plantillas Excel estandarizadas.
* **Mezcla Multipista y Asistente IA:** Separación de stems, detección de acordes ChordPro, avisos de voz realistas (*"Coro en 2 compases"*) y asistente armónico basado en la rueda Camelot.
* **Ergonomía de Hardware y 4 Estilos Radicales:** Componentes físicos-digitales de audio (diales rotativos, faders graduados en dB, displays VFD) con elección libre e independiente de estilo visual por cada músico en su propio dispositivo.

---

## 2. Sistema de Diseño Visual y Tipografía

### 2.1. Estilo Predeterminado: Swiss Bauhaus Lab
* **Filosofía:** Racionalismo funcionalista inspirado en Dieter Rams y laboratorios de acústica suizos. Ausencia total de ruido visual decorativo.
* **Tipografía Display & Títulos:** `Space Grotesk` (Google Fonts) — Geometría sin serifa de lectura rápida.
* **Tipografía de Datos & Acordes:** `IBM Plex Mono` (Google Fonts) — Precisión métrica monoespaciada quirúrgica.
* **Componentes:** Botones cilíndricos planos, cortes ortogonales a 90°, divisores de 1px exacto, acentos en Naranja Internacional (`#ff4500`) y Azul Cobalto Técnico (`#0066ff`) sobre chasis gris cemento mate (`#181a1f`).

### 2.2. Selección Libre de Estilos por Músico (Almacenamiento Local)
Cada músico puede alternar libremente su experiencia visual en `localStorage` sin alterar la sincronización musical del resto de la banda:

1. **Swiss Bauhaus Lab (Default):** `Space Grotesk` + `IBM Plex Mono` (Precisión clínica de ensayo).
2. **Mil-Spec Avionics HUD:** `Bebas Neue` + `Share Tech Mono` (Biseles octogonales, franjas hazard, fósforo ámbar para escenarios con humo y reflectores a 3 metros).
3. **Tokyo 1989 VFD:** `Orbitron` + `Silkscreen` (Brillo fluorescente cian, rejilla de matriz de puntos 5x7 y estética sampler clásico Akai/Roland).
4. **Concert Hall:** `Cinzel` + `Playfair Display` (Serif monumental, compases en números romanos, terciopelo carbón y bronce bruñido para auditorios y directores sinfónicos).

### 2.3. Componentes Físico-Digitales de Hardware
* **Fader Vertical con Escala dB:** Calibración de ganancia (+6 dB a -∞ dB) con punto *Unity (0 dB)* para monitoreo personal in-ear.
* **Limitador de Picos de Seguridad:** Limitador de audio a -0.5 dBFS en todos los retornos in-ear para proteger los oídos de los músicos contra transientes.
* **Potenciómetro Rotativo 270°:** Dial continuo con indicador LED de estado para ajuste de tempo, ganancia y fase.
* **Cinta de Estructura de Canción (Song Ribbon):** Bloques cromáticos por sección con cursor de cabezal activo en tiempo real.
* **Iconografía Vectorial Normalizada:** Cero emojis. Uso exclusivo de glifos SVG técnicos (normas ISO/DIN de audio).

---

## 3. Arquitectura del Sistema

```
+-------------------------------------------------------------------------------+
|                             CLOUD & WEB ADMIN HUB                             |
|  * Supabase / PostgreSQL (Multi-tenant)                                       |
|  * Auth: Google OAuth + SMS / WhatsApp OTP (Celular)                          |
|  * CRUD Universal + XLSX Import / Export Service (openpyxl)                   |
|  * AI Pipeline (Demucs Stems + Audio-to-ChordPro + Camelot AI DJ)             |
+---------------------------------------+---------------------------------------+
                                        | Sync / WebSockets
                                        v
+-------------------------------------------------------------------------------+
|                      ESTACIÓN CENTRAL: LÍDER DESKTOP                          |
|  * PySide6 + Python 3.11                                                      |
|  * Audio Engine: sounddevice (Backend PortAudio ASIO)                         |
|  * Salida FOH 1-2: Pistas auxiliares / Metrónomo PA                           |
|  * Salida 3 Cable: Clic dedicado baterista (< 1.5ms)                          |
|  * Servidor NTP Local: Broadcast UDP / Wi-Fi Hotspot Autónomo                 |
+---------------------------------------+---------------------------------------+
                                        | WebSockets locales (Wi-Fi 5 GHz)
                                        v
+-------------------------------------------------------------------------------+
|                       SEGUIDORES & CONTROL REMOTO PWA                         |
|  * React 19 + TypeScript + Vite PWA                                           |
|  * Web Audio API (Generador de clic oscilador local)                          |
|  * Control Remoto de Director desde Smartphone                                |
|  * Mezclador Táctil In-Ear (3 vías: Clic, Guía Vocal, Stems)                  |
|  * Selector de Estilo Local (Swiss, Mil-Spec, Tokyo, Concert Hall)            |
+---------------------------------------+---------------------------------------+
```

---

## 4. Estructura de Datos Central (TypeScript / Python Schemas)

### 4.1. Roles y Multi-Banda
* **Roles:** `Owner`, `MusicDirector`, `Musician`, `Substitute`.
* **Entidades:** `Band`, `BandMember`, `Song`, `Playlist`, `PlaylistItem`.

### 4.2. Entidad Playlist / Setlist
```typescript
interface PlaylistItem {
  id: string;
  song_id: string;
  order: number;
  show_key?: string;           // Tono específico para este concierto (ej: Bm -1)
  transition_type: 'gapless' | 'crossfade' | 'count_in' | 'manual_cue';
  transition_notes?: string;   // "Entrada directa con redoble de tom"
  target_bpm?: number;         // Permite ajustar el tempo para este show específico
}
```

---

## 5. Plan de Ejecución en Sprints

### Sprint 1: Higiene, ASIO y Desbloqueo PWA
1. **Aislamiento Legacy:** Mover `lib/`, `android/`, `ios/`, etc. a `_archive/flutter_legacy/`.
2. **Corrección de Fase Clock:** Forzar `beat = 1` y reiniciar fase de reloj en comandos `START` y `RESUME` en `clock_service.py`.
3. **Motor ASIO Líder:** Implementar selección y activación de interfaces ASIO multicanal en `engine.py`.
4. **Desbloqueo de Navegación Follower:** Enrutamiento entre Connect, Stage, Library y Settings en el PWA con soporte para temas locales.

### Sprint 2: Web Admin Hub, Multi-Banda y XLSX IO
1. Autenticación Google OAuth + Número de Celular OTP.
2. Gestión multi-agrupación con roles granulares.
3. Importador y exportador universal de canciones y setlists en formato `.xlsx`.
4. Sincronización offline-first con SQLite local en Desktop y caché en PWA.

### Sprint 3: Control Remoto y Ergonomía de Hardware
1. Implementación del protocolo de control remoto para el smartphone del líder.
2. Integración de los componentes de hardware (Faders dB, Knobs, Displays VFD, Song Ribbon).
3. Motor de temas con Swiss Bauhaus Lab como predeterminado y switch de estilos.

### Sprint 4: Mezcla Multipista y Co-Pilot con IA
1. Pipeline asíncrono para separación de pistas (stems).
2. Transcriptor de audio a acordes ChordPro y cálculo de BPM.
3. Asistente armónico para setlists (Camelot Wheel DJ).
4. Generador de prompts de voz para monitoreo in-ear.

---

*Documento consolidado en `docs/PLAN_BANDAIT_3.0_MASTER.md` y respaldado en control de versiones Git.*
