"""Headless Bandait leader (no GUI) for development and cross-app tests.

    cd bandait-leader
    python -m src.headless --port 4040

Runs QCoreApplication + ClockService + BandaitServer with a demo setlist taken
from ``bandait-protocol/fixtures/v3_messages.json`` (state_playing.setlist).
Speaks exactly the same CONTRACT_V3 protocol as the desktop leader. No audio.
Stop with Ctrl+C (or --duration N for an automatic stop).
"""

from __future__ import annotations

import argparse
import json
import logging
import signal
import sys
from pathlib import Path
from typing import List, Optional

from PySide6.QtCore import QCoreApplication, Qt, QTimer

from src.network.server import BandaitServer
from src.sync.clock_service import ClockService

FIXTURES = Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "v3_messages.json"

_FALLBACK_SETLIST = [
    {"song_id": "song_01", "title": "Intro", "bpm": 120, "order_index": 0, "transition_mode": "manual_cue"},
    {"song_id": "song_02", "title": "Segunda", "bpm": 96, "order_index": 1, "transition_mode": "auto_count_in"},
    {"song_id": "song_07", "title": "Septima", "bpm": 140, "order_index": 2, "transition_mode": "gapless"},
]


def demo_setlist(path: Path = FIXTURES) -> List[dict]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        setlist = data["state_playing"]["setlist"]
        if isinstance(setlist, list) and setlist:
            return setlist
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return list(_FALLBACK_SETLIST)


def load_setlist_file(path: str) -> List[dict]:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        data = data.get("setlist", [])
    if not isinstance(data, list):
        raise ValueError("el archivo debe contener una lista de canciones o {\"setlist\": [...]}")
    return data


def _summary(state: dict) -> str:
    return (
        f"v{state.get('state_version')} {state.get('status')} song={state.get('current_song_id')} "
        f"bpm={state.get('bpm')} anchor_ns={state.get('anchor_ns')} bar_offset={state.get('bar_offset')} "
        f"paused_bar={state.get('paused_bar')} last={((state.get('last_command') or {}).get('type'))}"
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.headless", description="Lider Bandait sin interfaz")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=4040)
    parser.add_argument("--session-id", default="default")
    parser.add_argument("--setlist", help="JSON con la lista de canciones (song_id, title, bpm, ...)")
    parser.add_argument("--no-demo", action="store_true", help="arrancar sin setlist")
    parser.add_argument("--duration", type=float, default=0.0, help="detenerse solo tras N segundos")
    parser.add_argument("--quiet", action="store_true", help="no imprimir cada cambio de estado")
    parser.add_argument("--lan-ip", help="IP anunciada a los telefonos (por defecto: automatica)")
    parser.add_argument("--follower-dir", help="carpeta del follower compilado (por defecto: landing/app)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = QCoreApplication.instance() or QCoreApplication(sys.argv[:1])

    clock = ClockService()
    clock.start()
    server = BandaitServer(
        clock,
        host=args.host,
        port=args.port,
        session_id=args.session_id,
        lan_ip=args.lan_ip,
        follower_dir=args.follower_dir,
    )
    server.signals.state_changed.connect(clock.apply_update, Qt.QueuedConnection)
    if not args.quiet:
        server.signals.state_changed.connect(
            lambda update: print(f"[estado] {_summary(update.wire_state)}", flush=True), Qt.QueuedConnection
        )
        server.signals.followers_changed.connect(
            lambda f: print(f"[red] seguidores: {[x.get('alias') for x in (f or [])]}", flush=True),
            Qt.QueuedConnection,
        )

    if args.setlist:
        try:
            entries = load_setlist_file(args.setlist)
        except (OSError, ValueError) as exc:
            print(f"No se pudo leer el setlist {args.setlist}: {exc}", file=sys.stderr)
            clock.stop()
            return 2
    elif args.no_demo:
        entries = []
    else:
        entries = demo_setlist()
    server.set_setlist(entries)

    if not server.start():
        print(f"ERROR: {server.status_message}", file=sys.stderr, flush=True)
        clock.stop()
        return 2

    print(
        f"Bandait lider headless escuchando en {server.get_url()} (LAN {server.lan_url()}), "
        f"sesion '{server.session_id}', setlist {len(entries)} canciones. Ctrl+C para salir.",
        flush=True,
    )
    print(f"  Musicos:  {server.follower_url()}", flush=True)
    print(f"  Director: {server.director_url()}", flush=True)
    others = [c.label for c in server.lan_candidates() if c.ip != server.lan_ip()]
    if others:
        print(f"  Otras redes (use --lan-ip): {'; '.join(others)}", flush=True)
    bundle = server.follower_dir()
    print(f"  Follower: {bundle if bundle else 'NO ENCONTRADO (ejecute npm run build:landing)'}", flush=True)

    def _quit(*_args) -> None:
        app.quit()

    signal.signal(signal.SIGINT, _quit)
    if hasattr(signal, "SIGBREAK"):
        signal.signal(signal.SIGBREAK, _quit)
    try:
        signal.signal(signal.SIGTERM, _quit)
    except (ValueError, OSError):
        pass
    # Let the Python interpreter run signal handlers while Qt's loop is in C++.
    keepalive = QTimer()
    keepalive.timeout.connect(lambda: None)
    keepalive.start(200)
    if args.duration > 0:
        QTimer.singleShot(int(args.duration * 1000), app.quit)

    rc = 0
    try:
        rc = app.exec()
    finally:
        keepalive.stop()
        server.stop()
        clock.stop()
        print("Bandait lider headless detenido", flush=True)
    return rc


if __name__ == "__main__":
    sys.exit(main())
