# Risk Assessment & Mitigation Strategies

Este documento rastrea los riesgos técnicos y de producto de alto nivel para el proyecto Bandait, junto con las estrategias para mitigarlos.

## 🔴 Riesgo Crítico: iOS Background Execution & WebSocket Death
**Nivel de Riesgo:** ALTO
**Impacto:** Pérdida de sincronización en dispositivos "Seguidores" si el músico bloquea la pantalla o cambia de app. iOS cierra conexiones socket agresivamente en background.

### Descripción
El sistema operativo iOS suspende la ejecución de apps en background después de unos segundos, cortando la conexión WebSocket con el Líder. Esto rompe la continuidad del metrónomo o la recepción de comandos.

### Estrategias de Mitigación

#### 1. Wakelock (Prevención de Bloqueo)
*   **Estrategia:** Mantener la pantalla encendida siempre que el "Modo Escenario" esté activo.
*   **Implementación:** Usar el plugin `wakelock_plus`.
*   **Trade-off:** Mayor consumo de batería (aceptable en gigs de 1-2 horas).

#### 2. Background Audio Entitlement (Hack Técnico)
*   **Estrategia:** Declarar la app como una aplicación de reproducción de música. Reproducir un track de silencio infinito o el propio click generado nativamente permite que el OS mantenga la CPU y la red activas.
*   **Implementación:** Configurar `UIBackgroundModes` -> `audio` en `Info.plist`.
*   **Riesgo:** Apple puede rechazar la app si considera que no es una app de audio "real" (aunque un metrónomo LO ES, así que es defendible).

#### 3. Reconexión Agresiva ("Catch-up")
*   **Estrategia:** Si la app muere y el usuario vuelve, reconectar instantáneamente y solicitar el estado actual.
*   **Implementación:** El offset de reloj se mantiene válido por minutos. Al volver a foreground, solo se necesita resincronizar el "Playhead" (dónde va la canción).

#### 4. Guided Access (Solución Operativa)
*   **Estrategia:** Educar al usuario para usar "Guided Access" (Acceso Guiado) en iOS durante el show.
*   **Implementación:** Mostrar un tutorial en la app sugiriendo bloquear el dispositivo en modo quiosco para evitar interrupciones por notificaciones o gestos accidentales.

---

## 🟠 Riesgo Medio: Sincronización en Redes Congestionadas
**Nivel de Riesgo:** MEDIO
**Impacto:** Jitter alto en entornos con mucha interferencia RF (bares, escenarios con muchos móviles).

### Estrategias de Mitigación
1.  **Clock Drift Smoothing:** No confiar en un solo paquete NTP. Usar una ventana deslizante de los mejores 5 de los últimos 20 pings.
2.  **Panic UI:** Si el Jitter > 50ms, mostrar alerta visual discreta (semáforo amarillo) para que el músico sepa que puede haber una micro-desviación.
3.  **Local "Flywheel":** El metrónomo de audio debe correr con su propio timer de cristal local una vez iniciado, usando la red solo para correcciones macro, no para triggerear cada beat individualmente.

