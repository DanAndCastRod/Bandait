# Plan de Desarrollo: Bandait (The Stage-Ready Sync System)

Este documento define la hoja de ruta para construir **Bandait**, un sistema de misión crítica para la sincronización de bandas en vivo. El enfoque es iterativo, priorizando la estabilidad del núcleo (sincronización de reloj) antes de expandir funcionalidades.

**Filosofía del Proyecto:** "La latencia de red existe; la sincronización es sobre el tiempo futuro, no el presente."

---

## 📅 Resumen de Fases

| Fase | Objetivo Principal | Duración Est. |
| :--- | :--- | :--- |
| **Fase 0** | **Core de Sincronización (PoC)**. Lograr que dos dispositivos "piensen" en el mismo milisegundo. | 2 Sprints |
| **Fase 1** | **El "Click" Perfecto**. Generación de audio nativo y metrónomo estable. | 2 Sprints |
| **Fase 2** | **Contenido y Estructura**. Letras (LRC), Playlists y Gestión básica. | 2 Sprints |
| **Fase 3** | **UX "Zero-Stress" y Red**. Conexión QR, Discovery, Health Check. | 2 Sprints |
| **Fase 4** | **Stage Mode & Advanced**. UI OLED, Visual Cues, MIDI. | 2 Sprints |

---

## 🛠️ Detalle de Sprints y Listas de Chequeo

### 🔥 Fase 0: Core de Sincronización (The Heartbeat)
*Objetivo: Establecer la arquitectura Cliente-Servidor y el protocolo de tiempo.*

#### Sprint 1: Arquitectura y WebSockets
- [ ] Inicializar proyecto Flutter (Clean Architecture).
- [ ] Implementar Servidor WebSocket simple (en el dispositivo "Líder" o PC Server mock).
- [ ] Implementar Cliente WebSocket (en dispositivo "Seguidor").
- [ ] Definir protocolo de mensajes JSON básico (`HANDSHAKE`, `PING`, `PONG`).
- [ ] **Componente Stitch:** Ver `network_&_sync_diagnostic` para herramientas de debug visual.
- [ ] **Prueba de Concepto:** Lograr conexión bidireccional entre PC y Android/iOS.

#### Sprint 2: Algoritmo de Sincronización (NTP Simplificado)
- [ ] Implementar lógica de cálculo de *Offset* y *Round Trip Time (RTT)*.
- [ ] Crear el "Reloj Maestro" en el Líder.
- [ ] Crear el "Reloj Ajustado" en los Seguidores (`HoraLocal + Offset`).
- [ ] **KPI:** Lograr que ambos dispositivos impriman el timestamp actual con una diferencia < 5ms en logs.

---

### 🔊 Fase 1: El Audio (The Click)
*Objetivo: Audio de latencia ultra-baja y precisión rítmica.*

#### Sprint 3: Generación de Audio Nativo
- [x] Integrar motor de audio de baja latencia (e.g., `flutter_soloud` o `dart_az` / Platform Channels a Oboe/CoreAudio).
- [x] Crear sintetizador de ondas simple (Senoidal/Cuadrada) para el "Bip".
- [x] Evitar carga de archivos MP3/WAV para el click (reducir latencia de decodificación).
- [ ] **Componente Stitch:** Ver `audio_engine_&_latency_settings` para settings de buffer/offset.

#### Sprint 4: Programación de Eventos Futuros
- [x] Implementar lógica `Play(atTime: futureTimestamp)`.
- [x] Manejar el *scheduling* del audio en el hilo nativo.
- [x] **Prueba de Fuego:** Poner dos dispositivos lado a lado, iniciar el metrónomo y grabar el audio para verificar el *phasing* (que suenen al unísono).

---

### 📝 Fase 2: Contenido y Gestión
*Objetivo: Que la banda sepa qué tocar y cantar.*

#### Sprint 5: Motor de Letras (.LRC)
- [x] Crear parser de archivos LRC (letras con timestamps).
- [x] **Componente Stitch:** `synchronized_lrc_editor_1` & `_2` (UI Implementada).
- [x] Implementar UI de scroll automático basado en el tiempo de la canción.
- [x] Lógica de interpolación y renderizado.

#### Sprint 6: Gestión de Canciones
- [x] Definir estructura de datos `Song` con Hive.
- [x] **Componente Stitch:** `song_library_manager` (Lista y Filtro).
- [x] UI de Librería: Listado, búsqueda, filtrado por tags.
- [x] UI de Editor de Letras: Sincronización básica.

#### Sprint 7: Gestión de Setlists (Sprint Extra)
- [x] **Componente Stitch:** `dynamic_setlist_manager`.
- [x] Modelo `Setlist` y Repositorio.
- [x] UI de Librería de Setlists.
- [x] UI de Editor de Setlist (Reordenar, Agregar/Quitar canciones).

---

### 🌐 Fase 3: Conectividad y UX "Zero-Stress"
*Objetivo: Que conectarse sea mágico y a prueba de fallos.*

#### Sprint 8: Session Lobby & Roles
- [x] Implementar pantalla "¿Quién eres?" (Líder/Músico).
- [x] **Componente Stitch:** `leader_session_lobby` y `instrument_&_profile_selection`.
- [x] Líder: Pantalla de creación de sesión (IP, Puerto).
- [x] Generador de QR para conexión rápida.
- [x] Músico: Escáner QR y selección de Instrumento/Perfil.

#### Sprint 9: Network Health & Diagnostics
- [x] **Componente Stitch:** `network_&_sync_diagnostic`.
- [x] Monitor de latencia (Ping/RTT) en tiempo real.
- [x] UI Semáforo: Verde (<10ms), Amarillo (Jitter), Rojo (Desconexión).
- [x] Alertas pasivas inteligentes ("Mala conexión WiFi").

---

### 🎸 Fase 4: Stage Experience & Polish
*Objetivo: Usabilidad en condiciones de escenario.*

#### Sprint 10: Dashboards de Control
- [x] **Componente Stitch:** `leader_tablet_dashboard_v1` / `v2`.
- [x] Unificar controles de Transporte, Setlist y Librería en una sola pantalla para el Líder.
- [x] **Componente Stitch:** `musician_stage_view` (Mejoras Visuales).
- [x] Tema "OLED Black" verdadero para ahorro de batería.

#### Sprint 11: Feedback Visual y Pánico
- [x] **Metrónomo Visual:** Bordes de pantalla parpadeando con el beat.
- [x] **Panic Button:** Stop All seguro.

---

### 🚀 Fase 5 (Futuro): Advanced Features
- [ ] MIDI Out via Bluetooth LE.
- [ ] Cues de voz (pistas de guía auditiva).
- [ ] Editor de canciones en Desktop.

---

### 📦 Fase 6: Despliegue y Distribución
*Objetivo: Poner la app en las manos de los músicos.*

#### Sprint 13: CI/CD & Beta Testing
- [ ] Configurar GitHub Actions / Codemagic para builds automáticos (Android APK / iOS IPA).
- [ ] Setup de Google Play Console (Internal Testing Track).
- [ ] Setup de Apple TestFlight.
- [ ] Implementar verificación de versiones obligatorias (Force Update).

#### Sprint 14: Public Release
- [ ] Generación de Screenshots y Assets de tienda.
- [ ] Redacción de políticas de privacidad (permisos de Audio/Microphone).
- [ ] Lanzamiento en Producción.
