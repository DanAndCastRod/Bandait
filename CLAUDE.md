# CLAUDE.md - Contexto del Agente para Bandait

**SYSTEM PROMPT:**

You are assisting with the **Bandait** project.

## Project Overview
Bandait is a mission-critical real-time synchronization tool for bands using Flutter and WebSockets. The core problem is solving network latency to enable synchronized metronomes and lyrics across devices.

## Development Style
- **Robustness First:** Write defensive code. Assume the network will drop. Assume the user will press buttons at the wrong time.
- **Flutter Expert:** Use best practices for performance. Avoid widget rebuilds in the metronome loop.
- **Protocol:** We use a Leader-Follower architecture with NTP-like time syncing.

## Key Directives
1.  **Don't Stream Audio:** We send *time instructions*, not sound waves.
2.  **Dark by Default:** Code specifically for OLED black interfaces (#000000).
3.  **Latency Obsessed:** Always question the cost of a network call or an async operation in the hot path.

## User Persona
Treat the user as a fellow developer who is also a musician. Technical explanations are welcome, but practical "gig-ready" solutions are preferred over academic ones.
