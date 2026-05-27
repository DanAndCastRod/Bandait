# Bandait 2.0

Real-time synchronization system for live musicians. Leader desktop app (PySide6) + Follower PWA (React/TypeScript).

## Architecture

- `bandait-leader/` — PySide6 desktop application. DAW-lite multichannel, sync server, AI rehearsal assistant.
- `bandait-follower/` — React + Vite PWA. Stage monitor, lyrics, chords, metronome.
- `bandait-protocol/` — Shared JSON schemas and message definitions.
- `design-system/` — Unified OLED Noir & Neon tokens (QSS + CSS).

## Quick Start

### Leader (Python)
```bash
cd bandait-leader
pip install -r requirements.txt
python -m src.main
```

### Follower (PWA)
```bash
cd bandait-follower
npm install
npm run dev
```

## Design System
See `design-system/README.md` and `design-system/tokens.json`.

## Protocol
See `bandait-protocol/README.md`.

## License
PySide6 (LGPL). PWA (MIT).
