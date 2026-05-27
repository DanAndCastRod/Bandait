---
type: plan
id: 01KSKCEGM6BCX4EBDPN8VVTWC9
version: 2
sessionId: ses_2go5kktw9si6uzg5x
title: Bandait 2.0 — Pivotaje a Líder PySide6 + PWA + IA
createdAt: 1779840795271
updatedAt: 1779841015593
comments: []
---
# Contexto

Bandait es un sistema de sincronización en tiempo real para músicos en vivo. El objetivo es pivotar la arquitectura actual (Flutter monolítico) a un sistema híbrido:
- **Líder**: Aplicación de escritorio en PySide6 (Python) con DAW multicanal, grabación multipista, servidor de sincronización NTP/Socket.IO y proxy de IA (Google Cloud).
- **Seguidores**: PWA (React + TypeScript + Vite) instalable en iOS/Android/Desktop sin builds nativas.
- **Sincronización**: Protocolo custom basado en timestamps absolutos (NTP-lite) vía WebSocket/Socket.IO.

## Pasos

### Fase 0: Fundamentos del Monorepo (Semanas 1-2)
1. Crear estructura de carpetas:
   - `/bandait-leader/` — PySide6, Python 3.11+
   - `/bandait-follower/` — React 18, TypeScript, Vite, PWA
   - `/bandait-protocol/` — JSON Schemas compartidos (Song, SessionState, MessageModel)
2. Configurar entornos:
   - Líder: `requirements.txt` (PySide6, sounddevice, numpy, soundfile, python-socketio, uvicorn, google-generativeai, sqlalchemy, alembic, keyring, qasync)
   - Seguidor: `package.json` (React, TypeScript, Vite, vite-plugin-pwa, socket.io-client)
3. Setup CI GitHub Actions:
   - Líder: `ruff` lint, `pytest` tests
   - Seguidor: `eslint`, `vitest`, build PWA
4. Definir Design System unificado:
   - Paleta OLED Noir & Neon (tokens CSS y QSS)
   - Tipografía: Inter (UI) + JetBrains Mono (números/BPM)
5. Especificar protocolo de red v2:
   - Mensajes: SYNC_BEACON, STATE_UPDATE, SONG_LOAD, PLAY, STOP, PANIC
   - Payloads JSON con timestamps absolutos (`leaderTime`)

### Fase 1: Motor de Sincronización y Red (Semanas 3-5)
1. Implementar `ClockService` en Python:
   - Algoritmo NTP (offset/RTT) usando `time.monotonic_ns()`
   - Thread dedicado de broadcast de beacon cada 1s
2. Implementar servidor Socket.IO (`bandait_server.py`):
   - Rooms por `sessionId`
   - Eventos: `join_session`, `sync_request`, `state_broadcast`
   - Reconexión con envío de `FULL_STATE`
3. Implementar cliente WebSocket en PWA:
   - Conexión WSS/WS con cálculo de offset vía `performance.now()`
   - Visual Metronome programado con compensación de tiempo
4. Implementar discovery:
   - Líder genera QR con sessionId + IP + Puerto
   - PWA escanea QR o ingresa IP manual
5. Tests: Validar sync con jitter < 20ms en LAN

### Fase 2: DAW Lite y Audio Multicanal (Semanas 6-9)
1. Implementar `audio_engine.py`:
   - Stream `sounddevice` con `blocksize=256`, `latency='low'`, `channels=4`
   - Callback de audio en C via PortAudio/ASIO (Behringer UMC)
   - Generación de click/metronomo matemático (impulso + filtro paso bajo)
2. Implementar mixer interno:
   - Clase `Track`: buffer circular (`numpy`), volumen, pan, mute, solo, `output_channels`
   - Clase `Mixer`: suma ponderada por bloques a outbuffer
3. Implementar grabación multipista:
   - Stream de input simultáneo
   - Escritura por bloques a `.flac` individuales por canal/pista vía `soundfile`
   - Auto-guardado por canción
4. Implementar transporte (Play/Stop/Record):
   - UI PySide6: botones grandes, atajos de teclado (Space=Play, R=Record, Esc=Stop)
   - Sincronización transporte con Socket.IO (`PLAY_AT_T`)
5. Tests E2E: Grabación 4 pistas simultáneas sin dropouts durante 60 minutos

### Fase 3: PWA Seguidor — Modo Stage y Biblioteca (Semanas 10-13)
1. Setup PWA base:
   - `vite-plugin-pwa` con Service Worker estratégico
   - Cache offline de setlist actual y canciones (IndexedDB)
2. Vistas principales:
   - **Stage View**: Pantalla completa. Letra gigante, acordes, BPM display, próxima línea atenuada
   - **Beacon de red**: Barra superior 4px (color + forma geométrica para daltónismo)
   - **Visual Metronome**: Flash de borde CSS `box-shadow` (Beat 1 Cyan, 2-4 gris)
   - **Slide-to-Stop**: Botón emergencia con gesto de deslizamiento
3. Modo Biblioteca (offline):
   - Lista de setlists y canciones cacheadas
   - Perfiles de músico por rol (Voz, Batería, Bajo)
4. Responsive Desktop:
   - Breakpoints > 1024px: layout split (letra + controles)
5. Tests: Lighthouse audit PWA installable, offline, performance > 90

### Fase 4: Gestión de Contenido y Eventos (Semanas 14-16)
1. Base de datos SQLite (líder):
   - Entidades: Song, Setlist, Gig, Rehearsal, BandMember, LyricLine, ChordSegment
   - Importadores: LRC, ChordPro, PDF
2. Editor de Setlist (PySide6):
   - Drag & drop de canciones, columnas BPM/Tonalidad/Duración
   - Asignación de pistas de audio por canción
3. Gestión de Gigs:
   - CRUD de eventos: fecha, venue, setlist, miembros
   - Post-gig notes
4. Sincronización de contenido:
   - Líder empuja setlist vía Socket.IO a seguidores
   - Seguidores almacenan en IndexedDB

### Fase 5: Integración IA — Asistente de Ensayos (Semanas 17-19)
1. Proxy de IA en el Líder:
   - Módulo `ai_assistant.py` usando `google-generativeai`
   - API key almacenada en Windows Credential Manager / macOS Keychain vía `keyring`
   - Rate limiting por minuto
2. Funciones IA:
   - **Análisis de Ensayo**: Comparar grabación multipista vs tempo/estructura esperados
   - **Sugerencia de Setlist**: Input lista de canciones + duración show, output orden óptimo
   - **Transcripción STT**: Google Speech-to-Text de notas de voz del director
   - **Chat de Ensayo**: UI en líder para consultas contextuales
3. UI de IA:
   - Panel lateral con historial de chat y resultados
   - Indicador visual de procesamiento (no bloquear UI)

### Fase 6: Polish, Deploy y QA (Semanas 20-22)
1. Líder:
   - PyInstaller `--onedir` + Inno Setup (Windows) / DMG (macOS)
   - Test en hardware real: Behringer UMC-202HD / UMC-204HD
   - Auto-update vía consulta a GitHub Releases
2. PWA:
   - Deploy en Vercel / GitHub Pages con HTTPS forzado
   - Lighthouse audit completo
3. Documentación:
   - `SETUP.md`: Conexión UMC, ASIO, firewall
   - `USER_GUIDE.md`: Flujo ensayo y evento
4. Tests E2E:
   - Simular 5 seguidores conectados 30 minutos
   - Medir drift de sync y generar log CSV de telemetría de red

## Files
- `bandait-leader/requirements.txt`
- `bandait-leader/src/main.py`
- `bandait-leader/src/audio/audio_engine.py`
- `bandait-leader/src/network/bandait_server.py`
- `bandait-leader/src/sync/clock_service.py`
- `bandait-leader/src/ui/main_window.py`
- `bandait-leader/src/db/models.py`
- `bandait-follower/package.json`
- `bandait-follower/vite.config.ts`
- `bandait-follower/src/main.tsx`
- `bandait-follower/src/views/StageView.tsx`
- `bandait-follower/src/hooks/useSync.ts`
- `bandait-protocol/schemas/session_state.json`
- `.github/workflows/ci.yml`

## Verification
- Líder y PWA se conectan vía LAN con jitter < 20ms
- Líder graba 4 pistas simultáneas sin dropouts durante 60 minutos
- PWA es installable, funciona offline con setlist precargada, pasa Lighthouse > 90
- IA responde consultas de setlist y análisis de ensayo en < 10s
- Transporte Play/Stop sincroniza todos los seguidores con drift < 50ms
