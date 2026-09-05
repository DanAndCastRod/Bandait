# Bandait 3.0 Project Rules

1. **Source of Truth:** All architecture, sprint tasks, and implementations must follow `docs/PLAN_BANDAIT_3.0_MASTER.md`.
2. **Zero Emojis:** Do NOT use emoji icons anywhere (UI, markdown, or chat). Use inline SVG icons or monospace badges.
3. **Audio Routing:** The Desktop Leader app uses PySide6 with `sounddevice` (PortAudio ASIO backend) for Outputs 1-2 (PA/FOH) and Output 3 (Drummer wired).
4. **Follower Audio:** Audio stems are pre-cached in IndexedDB on follower devices; live transport uses lightweight NTP packets (< 1 KB/s).
5. **Visual Theme:** Default theme is Swiss Bauhaus Lab (`Space Grotesk` + `IBM Plex Mono`). 4 themes are user-selectable via `localStorage`.
