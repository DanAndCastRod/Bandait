# CONTEXT.md - Bandait

## 🎯 Visión del Proyecto
**Bandait** es un sistema multiplataforma de sincronización en tiempo real para músicos en vivo. Su propósito es eliminar el caos en el escenario manteniendo a toda la banda alineada (literal y figurativamente) mediante tecnología de ultra-baja latencia.

**Problema:** Enviar audio por Wi-Fi causa latencia variable (jitter), haciendo imposible un metrónomo compartido preciso.
**Solución:** "Sincronización de Relojes, no de Audio". Los dispositivos acuerdan qué hora es (NTP) y ejecutan comandos en el futuro ("Tocar beat en T=1000500").

---

## 🏗️ Arquitectura Técnica

### Topología
- **Líder (Server):** PC, Tablet o Teléfono principal. Orquesta la sesión, tiene la base de datos de canciones y estado global.
- **Seguidores (Clients):** Teléfonos de los músicos. Reciben comandos de tiempo y contenido (letras, acordes) y generan su propio audio localmente.

### Stack Tecnológico
- **Framework Principal:** [Flutter](https://flutter.dev) (iOS, Android, Windows, macOS, Web).
- **Comunicación:** WebSockets (Socket.io) sobre TCP/UDP transportando payloads JSON ligeros.
- **Protocolo de Sincronización:** Implementación custom de NTP (Network Time Protocol) para calcular offset y latencia de ida y vuelta (RTT).
- **Audio:** Generación nativa (Platform Channels / FFI) o librerías de bajo nivel (`flutter_soloud`) para asegurar timing preciso.
- **Descubrimiento:** mDNS (Bonjour/Zeroconf) y escaneo de QR.

---

## 📂 Estructura de Datos Clave (JSON)

### Estado de Sesión (State Object)
```json
{
  "sessionId": "x7z9-b3a1",
  "leaderIp": "192.168.1.15",
  "status": "PLAYING", // IDLE, COUNTING, PLAYING, PAUSED
  "currentSongId": "song_05",
  "nextEventTimestamp": 1715000500123, // Hora absoluta del próximo '1' musical
  "bpm": 120
}
```

### Canción (LRC / Estructura)
```json
{
  "id": "song_05",
  "title": "Medianoche en Pereira",
  "bpm": 124,
  "segments": [
    {"label": "Intro", "bars": 8},
    {"label": "Verso A", "bars": 16}
  ],
  "lyrics": [
    {"time": 12.500, "text": "Las luces de la ciudad..."}
  ]
}
```

---

## 🎨 Principios de Diseño (UX/UI)
1.  **Stage-First:** Fondo 100% Negro (OLED Save), Alto Contraste.
2.  **Fat Finger Friendly:** Botones grandes en las esquinas.
3.  **Low Cognitive Load:** Información mínima necesaria. Si eres baterista, solo ves el tempo y estructura; si eres vocalista, ves la letra gigante.
4.  **Feedback Sensorial:** Confirmación visual y háptica de comandos críticos.


Dentro de archivos importantes para el contexto del proyecto se encuentran los siguientes:
- [.cursorrules](./.cursorrules)
- [chat.md](./chat.md)
- [CONTEXT.md](./CONTEXT.md)
- [README.md](./README.md)
- [TODO.md](./TODO.md)
- [GEMINI.md](./GEMINI.md)
- [Claude.md](./CLAUDE.md)
- [plans](./plans)
- [Guia de diseño](./guia_diseño.md)
- [Risk Assessment](./risk_assessment.md)

Recuerda siempre mantener actualizados los checklist de [plans](./plans) y sincronizados con [TODO.md](./TODO.md)