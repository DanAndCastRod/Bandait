---
type: plan
id: 01KSKCEGM6BCX4EBDPN8VVTWC9
version: 3
sessionId: ses_2go5kktw9si6uzg5x
title: Bandait Líder — DAW Profesional en Español
createdAt: 1779840795271
updatedAt: 1779846578714
comments: []
---
# Bandait Líder — Transformación a DAW Profesional

## Contexto
Transformar el esqueleto funcional actual en una aplicación de producción profesional para acompañamiento de ensayos y eventos en vivo. Toda la interfaz en español.

## Objetivos
1. Apariencia de DAW profesional (Ableton/Studio One/Cubase)
2. Mixer real con VU meters, faders, mute/solo/pan
3. Timeline con secciones de canción
4. Transporte profesional con tiempo, BPM, tap tempo
5. Stage view fullscreen para eventos
6. Gestión de biblioteca, setlists y eventos en español
7. Integración IA como asistente de ensayos
8. Audio multicanal con routing a tarjetas Behringer

## Stack
- PySide6 (Qt6)
- Python 3.11+
- sounddevice (PortAudio/ASIO)
- numpy
- python-socketio
- SQLAlchemy + Alembic
- google-generativeai

## Fases de Implementación

### Fase A: Design System
- Paleta OLED Noir & Neon completa
- Tipografía: Inter (UI), JetBrains Mono (números)
- QSS con estados hover/pressed/disabled
- Iconos SVG inline para todos los controles

### Fase B: MainWindow DAW
- Layout tipo Ableton: transporte arriba, mixer derecha, timeline centro, navegación izquierda
- Tabs: Escenario, Mezcla, Biblioteca, Eventos, Ensayos, IA
- Barra de estado con info de red y audio

### Fase C: Transporte Profesional
- Display de tiempo mm:ss.ms con JetBrains Mono
- BPM grande con tap tempo
- Botones: Reproducir, Detener, Grabar, Bucle, Localizar
- Indicador de estado de grabación (LED rojo parpadeante)

### Fase D: Mixer Real
- 4 canales con VU meters animados
- Faders con valores en dB
- Botones Mute/Solo/Pan por canal
- Matrix de routing a salidas físicas
- Master channel

### Fase E: Timeline
- Pista horizontal con secciones (Intro, Verso, Coro, Puente)
- Playhead que se desplaza
- Zoom horizontal
- Marcadores de tiempo

### Fase F: Stage View
- Fullscreen sin chrome
- Letra gigante centrada
- BPM y próxima sección
- Beacon de red (barra superior)
- Slide to stop

### Fase G: Biblioteca y Gestión
- Importar canciones (LRC, ChordPro, MP3 backing)
- Editor de setlists (drag & drop)
- Gestión de eventos/gigs
- Historial de ensayos con grabaciones

### Fase H: IA Assistant
- Chat con Gemini
- Análisis de grabaciones
- Sugerencias de setlist
- Transcripción de notas de voz

## Notas
- Todo en español: botones, labels, tooltips
- Performance: 60fps en UI, audio sin dropouts
- Responsive: adaptarse a resoluciones 1366x768 hasta 4K
