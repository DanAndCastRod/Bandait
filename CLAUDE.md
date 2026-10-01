# CLAUDE.md - Agent Context for Bandait

**SYSTEM PROMPT:**

You are assisting with the **Bandait** project.

## Project Overview
Bandait 3.0 is a mission-critical, real-time "live band operating system". A FOH leader keeps the band's metronome, transport and setlist in sync across the musicians' phones over the stage LAN. The core problem is network latency and unreliability: everyone has to hit beat 1 together, and keep the tempo when Wi-Fi drops.

The source of truth for product and architecture is `docs/PLAN_BANDAIT_3.0_MASTER.md`. The source of truth for anything on the wire is `bandait-protocol/CONTRACT_V3.md`, and its fixtures in `bandait-protocol/fixtures/v3_messages.json`. If code and contract disagree, fix the contract and fixtures first, then the code on every side.

## Repository Map
| Path | What it is | Stack |
|---|---|---|
| `bandait-leader/` | Desktop leader (FOH laptop): Socket.IO server, transport, ASIO click routing (Out 1-2 PA, Out 3 drummer). On the LAN it also serves the follower over HTTP. | Python 3.11, PySide6, python-socketio + uvicorn, sounddevice, SQLAlchemy/SQLite |
| `bandait-follower/` | Musician / director PWA: Web Audio lookahead click scheduler, Flywheel, setlist jump banner, director remote | React 18, TypeScript, Vite, socket.io-client |
| `bandait-leader-web/` | Web Admin Hub (bands, setlists, members, equipment, stems); local-first, optional Supabase sync | React, TypeScript, Vite, Supabase JS |
| `bandait-protocol/` | Normative wire contract v3, JSON schemas, canonical fixtures | Markdown, JSON Schema |
| `landing/` | Static site published by Cloudflare Pages as-is: `/` landing, `/hub/` and `/app/` are **committed build outputs** | HTML/CSS |
| `e2e/` | Playwright specs (projects: landing, leader-web, follower) | Playwright |
| `_archive/flutter_legacy/` | Old Flutter app. Frozen; do not develop here. | Flutter |

## Development Style
- **Robustness first:** write defensive code. Assume the network will drop. Assume the user will press buttons at the wrong time. Two devices pressing PLAY at once must not cause two phase resets.
- **No re-renders in the metronome hot path:** schedule clicks on the `AudioContext` and drive beat visuals through refs/rAF, not React state ticking. On the leader, the audio callback stays realtime-safe: no locks, allocation, logging or prints.
- **Protocol:** Leader-Follower with NTP-like sync. The leader clock is `time.perf_counter_ns()`. Never use `time.monotonic_ns()`: on Windows with Python < 3.13 it has 15.6 ms resolution. Wire keys are snake_case; each TS client translates in a single boundary module (`bandait-follower/src/protocol/wire.ts`). Last-write-wins uses the leader's receipt time.

## Key Directives
1. **Don't stream audio:** we send *time instructions*, not sound waves.
2. **Dark by default:** code for OLED black interfaces (#000000). **No emojis** anywhere (UI, QSS, HTML, docs): use technical SVG icons or monospace badges.
3. **Latency obsessed:** always question the cost of a network call or an async operation in the hot path.
4. **Stage serving:** an HTTPS page cannot open `ws://` to a LAN IP (mixed content). On stage, phones load the follower from the leader at `http://<lan-ip>:4040/`, via QR scanned with the phone's own camera. The Cloudflare-hosted `/app/` must never try to open a LAN socket; it redirects the user to the leader URL instead (contract section 8).
5. **Never trust docs over code:** DEVLOG entries before 2026-09-30 described intent, not verified behavior. Verify the wiring (who calls it, whether the app starts it) and run the tests.

## Verification (CI must stay red when something fails: never add `|| true`)
- Leader: `cd bandait-leader && ruff check src tests && QT_QPA_PLATFORM=offscreen python -m pytest -q`
- Follower: `cd bandait-follower && npm run lint && npx tsc --noEmit && npx vitest run && npm run build`
- Hub: `cd bandait-leader-web && npm run lint && npm run verify:logic && npm run build`
- E2E: `npx playwright test` from the repo root (Playwright starts the dev servers on 5173/5174).
- Headless leader, for testing followers without the GUI: `cd bandait-leader && python -m src.headless --port 4040`
- Tests must never touch the user's real data. The leader's DB path goes through `BANDAIT_DB`/`BANDAIT_HOME`, and the leader's `tests/conftest.py` fails the session if the real DB changes.

## Deployment
- Cloudflare Pages publishes `landing/` from `main` as-is. A merge to `main` is a production deploy.
- After changing the follower or the hub, regenerate the published bundles with `npm run build:landing` from the root, and commit `landing/app` / `landing/hub`. Never copy bundles by hand.
- Hub cloud features need `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (and optionally `VITE_GOOGLE_CLIENT_ID`) at build time, plus the RLS SQL in `docs/DEPLOY.md`. Never ship a `service_role` key.

## Work Log
This repo's convention is `DEVLOG.md`: a 5-point entry per block of work (see `docs/DEPLOY.md` section 4). Record what was verified versus assumed, your own mistakes, and actionable pending items. Never record secrets.

## User Persona
Treat the user as a fellow developer who is also a musician. Technical explanations are welcome, but practical "gig-ready" solutions are preferred over academic ones.
