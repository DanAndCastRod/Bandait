# Fase 4: Stage Experience & Polish

**Objetivo Crítico:** Usabilidad extrema en condiciones de baja luz y alto estrés (el escenario).

---

## 📅 Desglose de Sprints

### Sprint 9: Stage UI (Dark & Big)
**Objetivo:** Legibilidad máxima y protección de pantallas OLED.

#### Tareas
- [x] **Tema "Stage Mode":**
    - **Componente Stitch:** Ver `leader_tablet_dashboard_v1/v2` y `musician_stage_view`.
    - Colores: Fondo `#000000`, Texto Principal Blanco, Acentos Cyan/Magenta neón.
    - Evitar grandes áreas blancas que iluminen la cara del músico.
- [x] **Tipografía Dinámica:**
    - La letra actual debe ser *Gigante*.
    - Indicador de Acorde actual (si aplica) anclado en zona visible.
- [x] **Wakelock:**
    - Integrar `wakelock_plus`. Activar automáticamente al entrar a una Sesión. Desactivar al salir.
- [/] **Prevención de Errores UI:**
    - Gestos de deslizar para bloquear/desbloquear controles críticos en el Líder.
    - Ocultar botones de navegación de sistema (Immersive Mode) si es posible.

### Sprint 10: Feedback Sensorial y Pánico
**Objetivo:** Comunicación no verbal entre Líder y Banda.

#### Tareas
- [x] **Metrónomo Visual Periférico:**
    - Bordes de la pantalla (5px frame) flashean con el beat.
    - Flash fuerte en el "1" (Downbeat), flash suave en otros tiempos.
    - Color configurable por usuario (ej. baterista prefiere rojo, bajista azul).
- [x] **Comando de Pánico:**
    - Botón "STOP ALL" en el líder con confirmación de slide (para no tocar por error).
    - Acción: Envía señal de parada prioritaria. Todos los clientes cortan audio inmediatamente y muestran pantalla de "PAUSA GENERADA POR LÍDER".
- [x] **Notificaciones Toast Gigantes:**
    - Mensajes del líder: "Siguiente: Balada", "Saltar al Coro". Texto que ocupa toda la pantalla por 2 segundos.

## 🧪 Criterios de Aceptación
1.  Pantalla no se apaga tras 30 mins sin tocarla.
2.  El metrónomo visual es distinguible con visión periférica (mirando al instrumento, no al cel).
3.  Modo Pánico funciona instantáneamente (< 100ms percepción).
