# Fase 3: Conectividad y UX "Zero-Stress"

**Objetivo Crítico:** Eliminar la fricción técnica. Un músico no debería saber qué es una dirección IP.

---

## 📅 Desglose de Sprints

### Sprint 8: Session Lobby & Roles
**Objetivo:** Gestión de Identidad y Sesión.

#### Tareas
- [x] **Pantalla de Roles:**
    - **Componente Stitch:** `leader_session_lobby` (Creación) y `instrument_&_profile_selection`.
    - **Líder:** Crear sesión, definir nombre de banda, obtener IP local.
    - **Músico:** Seleccionar Instrumento (Guitarra, Batería, Voz) y Nombre.
- [x] **Discovery Protocol:**
    - Implementar mDNS (Bonjour/NSD) para broadcast de la sesión.
    - UI: "Buscando servidores..." -> Lista de sesiones encontradas.
- [x] **QR Handshake:**
    - Generar QR con JSON de conexión en el Líder.
    - Escáner en el Músico para auto-configuración de socket.

### Sprint 9: Network Health & Diagnostics
**Objetivo:** Establecer conexión real (TCP) y sobrevivir al caos del Wi-Fi.

#### Tareas
- [x] **Socket Infrastructure:**
    - Implementar `SocketServer` (Líder) y `SocketClient` (Músico).
    - Protocolo de Handshake: `HELLO` -> `WELCOME`.
- [x] **Network Diagnostics:**
    - **Componente Stitch:** `network_&_sync_diagnostic`.
    - Monitor de Latencia (Ping/RTT) y Jitter en tiempo real via `HEARTBEAT`.
- [x] **UI Semáforo:**
    - 🟢 Ping < 10ms.
    - 🟡 Ping < 50ms (Advertencia).
    - 🔴 Ping > 100ms (Crítico).
- [x] **Reconexión Inteligente:**
    - Lógica de reintento exponencial.
    - Alertas pasivas inteligentes ("Mala conexión WiFi") sin bloquear UI.

## 🧪 Criterios de Aceptación
1.  Un usuario puede unirse a una sesión escaneando un QR.
2.  Cada dispositivo tiene un "Nombre" y un "Instrumento" asociado.
3.  La app notifica si la calidad de red degrada.
