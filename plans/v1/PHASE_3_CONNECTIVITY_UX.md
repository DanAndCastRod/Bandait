# Fase 3: Conectividad y UX "Zero-Stress"

**Objetivo Crítico:** Eliminar la fricción técnica. Un músico no debería saber qué es una dirección IP.

---

## 📅 Desglose de Sprints

### Sprint 7: Discovery y Conexión Automática
**Objetivo:** Conexión mágica.

#### Tareas
- [ ] **Service Discovery (mDNS / NSD):**
    - **Líder:** Al iniciar servidor, registrar servicio `_bandait._tcp`.
    - **Seguidor:** Listener que busca servicios `_bandait._tcp` en la red local.
    - UI: Lista de "Bandas Encontradas".
- [ ] **QR Handshake:**
    - **Líder:** Mostrar QR con payload comprimido (protobuf o json min): `{"ip":"192.168.1.5", "p":8080, "t":"auth_token", "n":"NombreBanda"}`.
    - **Seguidor:** Escáner de cámara integrado. Al detectar, parsear y forzar conexión inmediata.
- [ ] **Security (Básico):**
    - Token de sesión simple para evitar que cualquiera en la Wi-Fi del bar se conecte y pare la música.

### Sprint 8: Robustez de Red (Network Resilience)
**Objetivo:** Sobrevivir al caos del Wi-Fi.

#### Tareas
- [ ] **Network Health Monitor:**
    - Calcular estadísticas de jitter y packet loss en segundo plano.
    - **UI Semáforo:**
        - 🟢 Ping < 10ms, Jitter < 2ms.
        - 🟡 Ping < 50ms, Jitter < 10ms.
        - 🔴 Ping > 100ms o Packet Loss > 5%.
- [ ] **Reconexión Inteligente:**
    - Si el socket muere, intentar reconectar silenciosamente cada 500ms, 1s, 2s...
    - Durante desconexión: El reloj local *sigue corriendo* con el último offset conocido (Free-running). El metrónomo NO debe parar, solo avisar visualmente "Desconectado - Drift posible".
- [ ] **Manejo de Background:**
    - Asegurar que el socket no se mata si el usuario cambia app momentáneamente (Android Foreground Service / iOS Background Tasks limitado). *Nota: iOS es muy restrictivo con sockets en background, diseñar para que la app deba estar en primer plano.*

## 🧪 Criterios de Aceptación
1.  Conexión exitosa escaneando QR en < 2 segundos.
2.  Apagar y prender el Wi-Fi del líder: Los seguidores deben detectar caída y reconectar solos al volver.
3.  Interfase clara de estado de red.
