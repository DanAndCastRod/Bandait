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

from src.ui.main_window import MainWindow
from src.network.server import BandaitServer
from src.sync.clock_service import ClockService
from src.audio.audio_engine import AudioEngine
from src.core.config import Config

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
    clock = ClockService(mode="leader")
    server = BandaitServer(clock, host=config.host, port=config.port)
    audio = AudioEngine(
        sample_rate=48000,
        block_size=256,
        channels=4,
    )

    window = MainWindow(clock=clock, server=server, audio=audio)
    window.show()

    with loop:
        # Start background services
        asyncio.ensure_future(server.start())
        loop.run_forever()

    return 0


if __name__ == "__main__":
    sys.exit(main())
