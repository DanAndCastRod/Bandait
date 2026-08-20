"""
Bandait DAW — Punto de entrada principal
Líder de sesión profesional para ensayos y eventos en vivo.
"""

import os
import sys

# Asegurar que src/ está en el path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtCore import Qt
from PySide6.QtGui import QFontDatabase
from PySide6.QtWidgets import QApplication

from src.ui.main_window import MainWindow


def load_fonts():
    """Cargar fuentes personalizadas si están disponibles."""
    # Intentar cargar JetBrains Mono
    font_paths = [
        os.path.join(os.path.dirname(__file__), "..", "resources", "fonts", "JetBrainsMono-Regular.ttf"),
        os.path.join(os.path.dirname(__file__), "..", "resources", "fonts", "Inter-Regular.ttf"),
    ]
    for path in font_paths:
        if os.path.exists(path):
            QFontDatabase.addApplicationFont(path)


def main():
    # Configurar atributos de aplicación para rendimiento
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(sys.argv)
    app.setApplicationName("Bandait DAW")
    app.setApplicationVersion("2.0.0")
    app.setOrganizationName("Bandait")

    # Cargar fuentes
    load_fonts()

    # Crear y mostrar ventana principal
    window = MainWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
