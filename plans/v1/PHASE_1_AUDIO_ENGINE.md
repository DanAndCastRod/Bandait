# Fase 1: El Audio (The Click)

**Objetivo Crítico:** Generar sonido sintético localmente con latencia de scheduling "sample-accurate". El audio NO viaja por la red.

> [!IMPORTANT]
> **Diseño Visual (Stitch):**
> Todas las interfaces de esta fase (Metrónomo, Debug, Settings) deben seguir el **Stitch Design System**:
> *   **Fondo:** OLED Black (`#000000` / `#0c0c0c`)
> *   **Acento:** Safety Orange (`#ff6600`)
> *   **Tipografía:** Space Grotesk (Técnica, legible)
> *   **Estilo:** Industrial, alto contraste, controles grandes.

## 🧠 Estrategia de Audio
Usar archivos de audio (mp3/wav) introduce latencia de lectura de disco y decodificación impredecible.
**Solución:** Síntesis de ondas en tiempo real o uso de buffers pre-cargados PCM muy pequeños gestionados por el motor de audio nativo.

---

## 📅 Desglose de Sprints

### Sprint 3: Motor de Audio de Baja Latencia
**Objetivo:** Lograr emitir sonido instantáneamente.

#### Investigación de Librerías Flutter
- **Opción A:** `flutter_soloud` (Binding C++ de SoLoud engine). Muy baja latencia, ideal para juegos/apps tiempo real.
- **Opción B:** `just_audio` (Demasiado alto nivel, posible latencia).
- **Opción C:** Platform Channels directos a Oboe (Android) / CoreAudio (iOS). (Más complejo, mejor resultado).
- **Decisión:** Empezar con **`flutter_soloud`** por balance rendimiento/dev-time.

#### Tareas
- [x] Integrar `flutter_soloud`.
- [x] Crear sintetizador de Click:
    - Sonido "Tick" (Frecuencia alta, ej. 1200Hz, duración corta 50ms).
    - Sonido "Tock" (Frecuencia media, ej. 800Hz, para tiempos débiles).
- [x] Implementar un "One-Shot" player y medir la latencia input-to-sound (tap en pantalla -> sonido).
- [ ] **Componente Stitch:** Ver `audio_engine_&_latency_settings` para diseño de configuración de buffer y latencia.

### Sprint 4: El Scheduler del Futuro
**Objetivo:** Programar el sonido para que suene en un timestamp exacto del reloj sincronizado.

#### Tareas
- [x] **Conversión Tiempo Global -> Tiempo de Audio:**
    - Implementado usando `AudioClock` sincronizado con NTP.
- [x] **Buffer de Eventos (Lookahead):**
    - Implementado en `AudioEngine` usando `AudioSource.load` con `flutter_soloud`.
- [x] **Lógica de Transporte:**
    - `Play`: Implementado en `MetronomeController`.
    - **Drift Correction:** Implementado re-calculo de `tick` en cada frame del `Ticker` si la desviación > threshold.

## 🚧 Integración UI (Stitch)
- [x] **Debug Audio Page:** Implementada (`DebugAudioPage`) siguiendo el diseño OLED/Black de Stitch.
- [x] **Audio Settings:** Implementada (`AudioSettingsScreen`) para configuración de buffer y latencia.

## 🧪 Criterios de Aceptación
1.  Metrónomo estable a 120 BPM durante 10 minutos sin "tartamudear".
2.  Dos dispositivos suenan al unísono al oído humano (desfase < 20ms es imperceptible para clicks, < 10ms es ideal).
3.  Cambio de BPM fluido.
