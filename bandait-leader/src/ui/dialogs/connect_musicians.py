"""Dialogo "Conectar músicos": QR para músicos y director (CONTRACT_V3 sección 8).

Los teléfonos abren la URL con la cámara nativa y cargan el follower desde el
propio líder por HTTP en la LAN. Esta es la única fuente de QR del líder.
"""

from __future__ import annotations

from typing import Callable, Optional

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
)

from src.network.lan import qr_matrix

AUTO_LABEL = "Automática"


def qr_pixmap(data: str, size: int = 260) -> QPixmap:
    """QR as black modules on white (best for phone cameras), quiet zone included."""
    matrix = qr_matrix(data)
    n = len(matrix)
    scale = max(1, size // n)
    img = QImage(n * scale, n * scale, QImage.Format_RGB32)
    img.fill(QColor("#FFFFFF"))
    painter = QPainter(img)
    try:
        black = QColor("#000000")
        for y, row in enumerate(matrix):
            for x, dark in enumerate(row):
                if dark:
                    painter.fillRect(x * scale, y * scale, scale, scale, black)
    finally:
        painter.end()
    return QPixmap.fromImage(img)


class _QrPanel(QFrame):
    def __init__(self, title: str, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("panel")
        layout = QVBoxLayout(self)
        heading = QLabel(title)
        heading.setFont(QFont("Inter", 14, QFont.Bold))
        heading.setStyleSheet("color: #00FFFF;")
        heading.setAlignment(Qt.AlignCenter)
        layout.addWidget(heading)
        self.qr = QLabel()
        self.qr.setAlignment(Qt.AlignCenter)
        self.qr.setMinimumSize(270, 270)
        layout.addWidget(self.qr)
        row = QHBoxLayout()
        self.url = QLineEdit()
        self.url.setReadOnly(True)
        row.addWidget(self.url)
        self.copy_btn = QPushButton("Copiar")
        self.copy_btn.clicked.connect(self._copy)
        row.addWidget(self.copy_btn)
        layout.addLayout(row)

    def set_url(self, url: str) -> None:
        self.url.setText(url)
        self.qr.setPixmap(qr_pixmap(url))

    def _copy(self) -> None:
        QApplication.clipboard().setText(self.url.text())


class ConnectMusiciansDialog(QDialog):
    def __init__(self, server, on_ip_selected: Optional[Callable[[Optional[str]], None]] = None,
                 saved_ip: Optional[str] = None, parent=None) -> None:
        super().__init__(parent)
        self._server = server
        self._on_ip_selected = on_ip_selected
        self.setWindowTitle("Conectar músicos")
        self.setStyleSheet(
            "QDialog { background: #000000; color: #F0F0F0; }"
            "QLabel { color: #F0F0F0; }"
            "QLineEdit { background: #0A0A0A; color: #F0F0F0; border: 1px solid #1E1E1E; padding: 4px; }"
        )
        layout = QVBoxLayout(self)

        ip_row = QHBoxLayout()
        ip_row.addWidget(QLabel("IP del líder en la red:"))
        self.ip_combo = QComboBox()
        self.ip_combo.setMinimumWidth(360)
        ip_row.addWidget(self.ip_combo, 1)
        self.refresh_btn = QPushButton("Actualizar redes")
        self.refresh_btn.clicked.connect(lambda: self._load_candidates(refresh=True))
        ip_row.addWidget(self.refresh_btn)
        layout.addLayout(ip_row)

        panels = QHBoxLayout()
        self.musicians = _QrPanel("MÚSICOS")
        self.director = _QrPanel("DIRECTOR")
        panels.addWidget(self.musicians)
        panels.addWidget(self.director)
        layout.addLayout(panels)

        note = QLabel(
            "Escanee el código con la cámara del teléfono (no hace falta abrir ninguna app). "
            "El teléfono debe estar en la misma red Wi-Fi que esta laptop."
        )
        note.setWordWrap(True)
        note.setStyleSheet("color: #666666;")
        layout.addWidget(note)

        self.warning = QLabel("")
        self.warning.setWordWrap(True)
        self.warning.setStyleSheet("color: #FFAA00;")
        layout.addWidget(self.warning)

        buttons = QDialogButtonBox(QDialogButtonBox.Close)
        buttons.button(QDialogButtonBox.Close).setText("Cerrar")
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        self._saved_ip = saved_ip
        self._load_candidates()
        self.ip_combo.currentIndexChanged.connect(self._on_ip_changed)

    def _load_candidates(self, refresh: bool = False) -> None:
        candidates = self._server.lan_candidates(refresh=refresh)
        current = self._saved_ip
        self.ip_combo.blockSignals(True)
        self.ip_combo.clear()
        self._server.set_lan_ip(None)
        auto_ip = self._server.lan_ip()
        self.ip_combo.addItem(f"{AUTO_LABEL} ({auto_ip})", None)
        select = 0
        for c in candidates:
            self.ip_combo.addItem(c.label, c.ip)
            if current and c.ip == current:
                select = self.ip_combo.count() - 1
        if current and select == 0:
            self.ip_combo.addItem(f"{current} (no detectada en este equipo)", current)
            select = self.ip_combo.count() - 1
        self.ip_combo.setCurrentIndex(select)
        self.ip_combo.setEnabled(len(candidates) > 1 or bool(current))
        self.ip_combo.blockSignals(False)
        self._server.set_lan_ip(self.ip_combo.currentData())
        self._refresh()

    def _on_ip_changed(self, _index: int) -> None:
        ip = self.ip_combo.currentData()
        self._saved_ip = ip
        self._server.set_lan_ip(ip)
        if self._on_ip_selected is not None:
            self._on_ip_selected(ip)
        self._refresh()

    def _refresh(self) -> None:
        self.musicians.set_url(self._server.follower_url())
        self.director.set_url(self._server.director_url())
        problems = []
        if self._server.status != "running":
            problems.append(f"El servidor de red no está activo: {self._server.status_message}")
        if self._server.follower_dir() is None:
            problems.append(
                "No se encontró la app del músico compilada: ejecute npm run build:landing "
                "en la raíz del repositorio (los teléfonos verían una página de ayuda)."
            )
        self.warning.setText("\n".join(problems))
