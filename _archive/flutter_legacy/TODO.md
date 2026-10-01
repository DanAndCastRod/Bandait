# TODO List - Phase 0: Core Synchronization

## Sprint 1: Infraestructura de Red P2P
- [ ] **Setup del Proyecto**
    - [ ] Estructura de directorios Clean Architecture: `domain`, `data`, `presentation`
    - [ ] Inyección de dependencias (`get_it`, `injectable`)
- [ ] **Servidor WebSocket (Líder)**
    - [ ] Implementar `ServerEngine` (HttpServer/shelf_web_socket)
    - [ ] Mapeo de clientes conectados
    - [ ] Broadcast de mensajes
- [ ] **Cliente WebSocket (Seguidor)**
    - [ ] Implementar `ClientEngine` con reconexión automática
    - [ ] Manejo de estados de conexión
- [ ] **Protocolo de Mensajería**
    - [ ] Definir `MessageModel` (JSON)
    - [ ] Mensajes: HANDSHAKE, PING, PONG, ACK

## Sprint 2: Motor de Sincronización de Reloj
- [ ] **Lógica de Ping/Pong NTP**
    - [ ] SYNC_REQUEST / SYNC_RESPONSE
    - [ ] Cálculo de Offset y RTT
- [ ] **Filtro de Calidad**
    - [ ] Descartar samples con alto RTT
    - [ ] Promedio de muestras y Drift Correction
- [ ] **UI de Debug**
    - [ ] Pantalla técnica (Offset, RTT, Jitter)
    - [ ] Flash Test visual
