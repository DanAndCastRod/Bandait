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
- [ ] Integrar motor de audio de baja latencia (e.g., `flutter_soloud` o `dart_az` / Platform Channels a Oboe/CoreAudio).
- [ ] Crear sintetizador de ondas simple (Senoidal/Cuadrada) para el "Bip".
- [ ] Evitar carga de archivos MP3/WAV para el click (reducir latencia de decodificación).

#### Sprint 4: Programación de Eventos Futuros
- [ ] Implementar lógica `Play(atTime: futureTimestamp)`.
- [ ] Manejar el *scheduling* del audio en el hilo nativo.
- [ ] **Prueba de Fuego:** Poner dos dispositivos lado a lado, iniciar el metrónomo y grabar el audio para verificar el *phasing* (que suenen al unísono).

---

### 📝 Fase 2: Contenido y Gestión
*Objetivo: Que la banda sepa qué tocar y cantar.*

#### Sprint 5: Motor de Letras (.LRC)
- [ ] Crear parser de archivos LRC (letras con timestamps).
- [ ] Implementar UI de scroll automático basado en el tiempo de la canción.
- [ ] Lógica de interpolación: Si la canción va por el segundo 30, mostrar línea X.

#### Sprint 6: Gestión de Playlists (JSON)
- [ ] Definir estructura de datos `Song`, `Setlist`.
- [ ] UI de Líder: Crear/Editar Setlist, Reordenar (Drag & Drop).
- [ ] UI de Seguidor: Recepción de Setlist activo.
- [ ] Persistencia local (guardar repertorio en dispositivo).

---

### 🌐 Fase 3: Conectividad y UX "Zero-Stress"
*Objetivo: Que conectarse sea mágico y a prueba de fallos.*

#### Sprint 7: Discovery y QR
- [ ] Implementar mDNS/Bonjour para autodescubrimiento en LAN ("Bandait Server found").
- [ ] Generador de QR en Líder con payload de conexión (IP, Puerto, Token).
- [ ] Escáner de QR en Seguidor que auto-conecta al socket.

#### Sprint 8: Network Health Monitor
- [ ] Implementar "Heartbeat" continuo de red.
- [ ] UI Semáforo: Verde (<10ms), Amarillo (Jitter), Rojo (Desconexión).
- [ ] Manejo de reconexión automática transparente.
- [ ] Alertas pasivas: "Tu red es inestable".

---

### 🎸 Fase 4: Stage Experience & Polish
*Objetivo: Usabilidad en condiciones de escenario (oscuridad, nervios).*

#### Sprint 9: Stage UI (OLED Black)
- [ ] Implementar Tema "Stage Mode" (Fondo #000000, Texto Alto Contraste).
- [ ] Tipografía gigante dinámica (la línea actual ocupa 30% pantalla).
- [ ] Bloqueo de reposo de pantalla (Wakelock).

#### Sprint 10: Feedback Visual y Pánico
- [ ] **Metrónomo Visual:** Bordes de pantalla parpadeando con el beat.
- [ ] **Feedback Háptico:** Vibración al recibir comandos de transporte (Start/Stop).
- [ ] **Panic Button:** Implementar comando de "Fade Out / Stop All" seguro.

---

### 🚀 Fase 5 (Futuro): Advanced Features
- [ ] MIDI Out via Bluetooth LE.
- [ ] Cues de voz (pistas de guía auditiva).
- [ ] Editor de canciones en Desktop.

---

### 📦 Fase 6: Despliegue y Distribución
*Objetivo: Poner la app en las manos de los músicos.*

#### Sprint 11: CI/CD & Beta Testing
- [ ] Configurar GitHub Actions / Codemagic para builds automáticos (Android APK / iOS IPA).
- [ ] Setup de Google Play Console (Internal Testing Track).
- [ ] Setup de Apple TestFlight.
- [ ] Implementar verificación de versiones obligatorias (Force Update).

#### Sprint 12: Public Release
- [ ] Generación de Screenshots y Assets de tienda.
- [ ] Redacción de políticas de privacidad (permisos de Audio/Microphone).
- [ ] Lanzamiento en Producción.
