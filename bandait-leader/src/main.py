"""
Bandait DAW — Punto de entrada principal
Líder de sesión profesional para ensayos y eventos en vivo.
"""

import logging
import os
import sys

# Asegurar que la raíz de bandait-leader está en el path (imports "src.*")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _enable_asio_if_requested() -> None:
    """SD_ENABLE_ASIO must be set before sounddevice is imported."""
    from src.core.leader_config import load_settings

    try:
        wants_asio = load_settings().enable_asio
    except Exception:
        wants_asio = False
    if wants_asio or os.environ.get("BANDAIT_ASIO", "").strip() in ("1", "true", "yes"):
        os.environ.setdefault("SD_ENABLE_ASIO", "1")


def load_fonts():
    """Cargar fuentes personalizadas si están disponibles."""
    from PySide6.QtGui import QFontDatabase

    font_paths = [
        os.path.join(os.path.dirname(__file__), "..", "resources", "fonts", "JetBrainsMono-Regular.ttf"),
        os.path.join(os.path.dirname(__file__), "..", "resources", "fonts", "Inter-Regular.ttf"),
    ]
    for path in font_paths:
        if os.path.exists(path):
            QFontDatabase.addApplicationFont(path)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    _enable_asio_if_requested()

    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QApplication

    from src.ui.main_window import MainWindow

    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(sys.argv)
    app.setApplicationName("Bandait DAW")
    app.setApplicationVersion("2.1.0")
    app.setOrganizationName("Bandait")

    load_fonts()

    window = MainWindow()
    app.aboutToQuit.connect(window.shutdown)
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
