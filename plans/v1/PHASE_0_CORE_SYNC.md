# Fase 0: Core de Sincronización (The Heartbeat)

**Objetivo Crítico:** Lograr que múltiples dispositivos tengan un consenso de tiempo absoluto con una precisión de < 5ms, independientemente de la latencia de la red.

## 🧠 Conceptos Teóricos
En esta fase no nos importa el audio, solo el **Tiempo**. Implementaremos una variante del algoritmo NTP (Network Time Protocol) sobre WebSockets.

### Fórmula de Sincronización
Para cada cliente, necesitamos calcular el `offset` (diferencia de reloj) respecto al Líder.

```dart
// t0: Cliente envía petición
// t1: Servidor recibe petición
// t2: Servidor envía respuesta
// t3: Cliente recibe respuesta

RTT (Round Trip Time) = (t3 - t0) - (t2 - t1)
Offset = ((t1 - t0) + (t2 - t3)) / 2

RelojCorregido = HoraLocal + Offset
```

---

## 📅 Desglose de Sprints

### Sprint 1: Infraestructura de Red P2P
**Objetivo:** Establecer comunicación bidireccional fiable/rápida entre dispositivos en la misma LAN.

#### Tareas
- [ ] **Setup del Proyecto:**
    - Estructura de directorios Clean Architecture: `domain`, `data`, `presentation`.
    - Inyección de dependencias (`get_it`, `injectable`).
- [ ] **Servidor WebSocket (Líder):**
    - Implementar `ServerEngine` usando `dart:io` HttpServer o `shelf_web_socket`.
    - Mapeo de clientes conectados: `Map<ClientId, WebSocketChannel>`.
    - Broadcast de mensajes.
- [ ] **Cliente WebSocket (Seguidor):**
    - Implementar `ClientEngine` con reconexión automática (Exponential backoff).
    - Manejo de estados de conexión: `Disconnected`, `Connecting`, `Connected`.
- [ ] **Protocolo de Mensajería:**
    - Definir `MessageModel` (JSON): `{ "type": "PING", "payload": {}, "timestamp": 123456 }`.
    - Tipos iniciales: `HANDSHAKE`, `PING`, `PONG`, `ACK`.

### Sprint 2: Motor de Sincronización de Reloj
**Objetivo:** Implementar la lógica matemática para alinear los relojes.

#### Tareas
- [ ] **Lógica de Ping/Pong NTP:**
    - Cliente envía `SYNC_REQUEST` con `t0`.
    - Servidor responde `SYNC_RESPONSE` adjuntando `t1` y `t2`.
    - Cliente recibe en `t3` y calcula.
- [ ] **Filtro de Calidad:**
    - Descartar muestras con RTT inusualmente alto (spikes de red).
    - Promediar las últimas N muestras válidas para suavizar el `offset`.
    - Implementar "Drift Correction" continuo (resincronizar cada X segundos).
- [ ] **UI de Debug:**
    - Pantalla técnica que muestre: "Offset: -12ms", "RTT: 4ms", "Jitter: 1ms".
    - Botón "Flash Test": El líder envía comando "Flash en T+2000ms". Todos los dispositivos deben flashear la pantalla visualmente al unísono para validar a ojo.

## 🧪 Criterios de Aceptación
1.  La conexión persiste aunque el servidor (app líder) vaya a background y vuelva (en Android puede requerir Foreground Service, evaluar).
2.  El cálculo del offset es consistente (variación < 2ms) tras 10 pings.
3.  Prueba visual de flash sincronizado satisfactoria.
