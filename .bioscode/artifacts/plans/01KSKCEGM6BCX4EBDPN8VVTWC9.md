---
type: plan
id: 01KSKCEGM6BCX4EBDPN8VVTWC9
version: 5
sessionId: ses_2go5kktw9si6uzg5x
title: 'Bandait 2.0 — Implementación Completa: Líder Web + Desktop + PWA'
createdAt: 1779840795271
updatedAt: 1779940091664
comments: []
---
# Plan de Implementación: Bandait 2.0

## Contexto
El proyecto Bandait necesita:
1. **Líder Web** — Interfaz web que permite controlar el líder desde cualquier navegador (desktop, tablet, teléfono)
2. **Líder Desktop** — Aplicación PySide6 con estética DAW profesional (tipo Ableton/Studio One)
3. **PWA Seguidor** — Aplicación web progresiva que los músicos usan en sus teléfonos

## Estado Actual
- `bandait-leader/` — Líder Desktop PySide6 funcional pero con UI básica
- `bandait-leader-web/` — Template Vite vacío, sin funcionalidad Bandait
- `bandait-follower/` — PWA React esqueleto, no conecta al líder
- `bandait-protocol/` — Schemas JSON definidos
- `design-system/` — Tokens de diseño OLED Noir & Neon

## Fases de Implementación

### Fase 1: Líder Web — Control Remoto Profesional
**Objetivo**: Interfaz web React que se conecta al servidor Socket.IO del líder y permite control completo.

**Tareas**:
1.1 Reemplazar template Vite con app React real
1.2 Crear servicio Socket.IO cliente con reconexión automática
1.3 Implementar vistas: Transporte, Mixer, Timeline, Stage, Library
1.4 Aplicar estética OLED Noir & Neon (CSS con tokens del design system)
1.5 Implementar control remoto: Play/Stop/Rec, cambio de BPM, carga de canciones
1.6 Responsive: desktop (layout DAW), tablet (compacto), móvil (Stage mode)

### Fase 2: Líder Desktop — Estética DAW Profesional
**Objetivo**: Que se vea como Ableton Live / Studio One, no como app de inventario.

**Tareas**:
2.1 Crear QSS global con paleta OLED Noir & Neon
2.2 Rediseñar Transporte: barra profesional con tiempo, BPM, controles
2.3 Rediseñar Mixer: faders verticales, VU meters animados, mute/solo LEDs
2.4 Rediseñar Timeline: pista horizontal con secciones, playhead, zoom
2.5 Rediseñar Stage: pantalla completa, letra gigante, metrónomo visual
2.6 Rediseñar Library: tabla profesional con metadata, búsqueda, filtros
2.7 Animaciones: beat flash, transiciones suaves, micro-interacciones

### Fase 3: PWA Seguidor — Conexión Real al Líder
**Objetivo**: Teléfonos de músicos se conectan al líder y muestran letras, acordes, metrónomo.

**Tareas**:
3.1 Implementar cliente Socket.IO real con sync NTP-lite
3.2 Implementar Web Audio API para click metrónomo local
3.3 Implementar Stage View con scroll de letras sincronizado
3.4 Implementar Library con sync desde líder (IndexedDB)
3.5 Implementar QR scanner real con jsQR
3.6 Implementar modo offline con cache de setlist

### Fase 4: Deploy y Documentación
**Objetivo**: Empaquetar y desplegar todo.

**Tareas**:
4.1 PyInstaller para líder desktop (Windows .exe)
4.2 Build PWA y deploy a GitHub Pages
4.3 Build Líder Web y deploy a Vercel/Netlify
4.4 Actualizar documentación (SETUP.md, USER_GUIDE.md)
4.5 Verificar tests (Python + TypeScript)

## Criterios de Aceptación
- [ ] Líder Web se abre en navegador y controla el líder desktop
- [ ] Líder Desktop se ve como DAW profesional (negro, acentos neon)
- [ ] PWA se instala en teléfono y conecta al líder
- [ ] Tests pasan (Python + TypeScript)
- [ ] Documentación actualizada

## Notas
- Todo el código en español (UI, comentarios, documentación)
- Paleta: OLED Noir & Neon (#000000 fondo, #00FFFF cyan, #CCFF00 lime, #FF00FF magenta)
- Tipografía: JetBrains Mono (números/BPM), Inter (UI general)
