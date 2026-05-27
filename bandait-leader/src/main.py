#!/usr/bin/env python3
"""
Bandait Leader — Entry point.
Desktop DAW-lite, sync server, and AI rehearsal assistant.
"""

import sys
import asyncio
import logging
from pathlib import Path

from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt
from qasync import QEventLoop

from ui.main_window import MainWindow
from network.bandait_server import BandaitServer
from sync.clock_service import ClockService
from core.config import Config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("bandait")


def main() -> int:
    config = Config.from_env()

    app = QApplication(sys.argv)
    app.setApplicationName("Bandait Leader")
    app.setApplicationDisplayName("Bandait")
    app.setStyle("Fusion")

    # Install asyncio event loop compatible with Qt
    loop = QEventLoop(app)
    asyncio.set_event_loop(loop)

    # Load dark stylesheet
    style_path = Path(__file__).parent / "styles" / "dark_theme.qss"
    if style_path.exists():
        app.setStyleSheet(style_path.read_text(encoding="utf-8"))

    # Services
    clock = ClockService()
    server = BandaitServer(host=config.host, port=config.port, clock=clock)

    window = MainWindow(clock=clock, server=server)
    window.show()

    with loop:
        # Start background services
        asyncio.ensure_future(server.start())
        asyncio.ensure_future(clock.run())
        loop.run_forever()

    return 0


if __name__ == "__main__":
    sys.exit(main())
