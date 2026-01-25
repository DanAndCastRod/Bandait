# Fase 5: Advanced Features (Futuro)

**Objetivo:** Llevar la automatización al siguiente nivel, controlando hardware externo.

---

## 📅 Desglose de Sprints

### Sprint 11: Integración MIDI (Bluetooth LE)
**Objetivo:** Cambiar presets de pedales y teclados automáticamente.

#### Tareas
- [ ] Integrar librería MIDI BLE (`flutter_midi_command`).
- [ ] **Componente Stitch:** Ver `personal_monitor_mixer` (Concepto futuro).
- [ ] UI de Mapeo MIDI en Líder:
    - "En el Segundo 45 (Coro), enviar Program Change #12 al Canal 1".
- [ ] Motor de Disparo MIDI:
    - El Scheduler (Fase 1) ahora también dispara eventos MIDI además de audio.
    - **Caso de uso:** Guitarrista tiene su pedalera conectada por BT al celular. Al llegar el solo, el celular le cambia el efecto automáticamente.

### Sprint 12: Cues de Voz y Automatización de Estructura
**Objetivo:** Que nadie se pierda en la canción.

#### Tareas
- [ ] **Pista de Cues (Guide Track):**
    - Canal de audio separado (Left: Click, Right: Cues... o mezclado si es mono).
    - Sintetizar voz (Text-to-Speech pre-grabado) que diga: "Uno, Dos, Tres, Puente...".
- [ ] **Saltos Dinámicos (Live Looping/Jumps):**
    - Botones en Líder: "Repetir Coro", "Ir al Final".
    - Lógica compleja: Al recibir comando "Repetir Coro", el scheduler debe esperar al final del compás actual y saltar sin perder el tiempo musical (Quantized Jump).

## 🧪 Criterios de Aceptación
1.  Envío de comandos MIDI verificado con dispositivo externo.
2.  Los saltos de estructura mantienen la coherencia rítmica (no se cruza el beat).
