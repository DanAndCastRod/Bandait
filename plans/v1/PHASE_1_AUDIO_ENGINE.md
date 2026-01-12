# Fase 1: El Audio (The Click)

**Objetivo Crítico:** Generar sonido sintético localmente con latencia de scheduling "sample-accurate". El audio NO viaja por la red.

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
- [ ] Integrar `flutter_soloud`.
- [ ] Crear sintetizador de Click:
    - Sonido "Tick" (Frecuencia alta, ej. 1200Hz, duración corta 50ms).
    - Sonido "Tock" (Frecuencia media, ej. 800Hz, para tiempos débiles).
- [ ] Implementar un "One-Shot" player y medir la latencia input-to-sound (tap en pantalla -> sonido).

### Sprint 4: El Scheduler del Futuro
**Objetivo:** Programar el sonido para que suene en un timestamp exacto del reloj sincronizado.

#### Tareas
- [ ] **Conversión Tiempo Global -> Tiempo de Audio:**
    - Mapear el timestamp NTP al timestamp del sistema de audio si es necesario.
- [ ] **Buffer de Eventos (Lookahead):**
    - No intentar triggerear el sonido *exactamente* en el milisegundo.
    - Estrategia: "Schedulear" el sonido para que el motor de audio lo toque en T.
    - Si el motor no soporta scheduling preciso, usar un `Timer` de alta precisión en Dart que dispare el sonido `AudioLatency` ms *antes* del target.
    - *Nota:* Dart `Timer` no es 100% preciso. Se prefiere usar loops nativos del engine de audio.
- [ ] **Lógica de Transporte:**
    - `Play`: El líder envía `{ "action": "START", "startTime": Now + 500ms, "bpm": 120 }`.
    - Cliente calcula el primer beat y los subsiguientes.
    - **Drift Correction musical:** Si el reloj del sistema se ajusta (NTP resync), el scheduler de audio debe corregir suavemente (pitch bend imperceptible o micro-ajuste de silencio) para no perder el bit.

## 🧪 Criterios de Aceptación
1.  Metrónomo estable a 120 BPM durante 10 minutos sin "tartamudear".
2.  Dos dispositivos suenan al unísono al oído humano (desfase < 20ms es imperceptible para clicks, < 10ms es ideal).
3.  Cambio de BPM fluido.
