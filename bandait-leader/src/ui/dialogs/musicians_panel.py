"""Panel "Músicos conectados": quién está unido a la sesión y cómo está su enlace.

Los datos vienen de ``link_report`` (CONTRACT_V3 sección 3), que cada teléfono envía cada
5 s. El estado combina color y texto (BUENO / REGULAR / MALO / SIN DATOS), para que se
lea también sin distinguir colores. Es informativo: nada aquí toca el transporte.
"""

from __future__ import annotations

from typing import Callable, List, Optional

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QDialog, QHeaderView, QLabel, QTableWidget, QTableWidgetItem, QVBoxLayout

from src.network.link_report import HEALTH_LABELS, link_health
from src.sync.leader_clock import leader_now_ns

HEALTH_COLORS = {"ok": "#CCFF00", "warn": "#FFAA00", "bad": "#FF4D4D", "stale": "#888888"}
HEALTH_ORDER = {"bad": 0, "warn": 1, "stale": 2, "ok": 3}
ROLE_LABELS = {"musician": "Músico", "director": "Director", "foh": "FOH", "hub": "Hub"}
AUDIO_LABELS = {"armed": "Activo", "unarmed": "Sin activar", "suspended": "Suspendido", "unsupported": "No soportado"}
COLUMNS = ["Músico", "Rol", "RTT", "Jitter", "Salida de audio", "Audio", "Estado"]


def _ms(value) -> str:
    return "—" if value is None else f"{value:.1f} ms"


def worst_health(followers: List[dict], now_ns: int) -> Optional[str]:
    """Peor estado entre los músicos conectados, o None si no hay nadie."""
    levels = [link_health(f.get("link"), now_ns)[0] for f in followers]
    return min(levels, key=HEALTH_ORDER.__getitem__) if levels else None


def summary_text(followers: List[dict], now_ns: int) -> str:
    """Texto corto para la barra de estado: 'Músicos: 3 · peor RTT 21.0 ms'."""
    if not followers:
        return "Músicos: 0"
    rtts = [f["link"]["rtt_ms"] for f in followers if f.get("link") and f["link"].get("rtt_ms") is not None]
    worst = f" · peor RTT {max(rtts):.1f} ms" if rtts else ""
    return f"Músicos: {len(followers)}{worst}"


class MusiciansPanel(QDialog):
    def __init__(self, followers: List[dict], now: Callable[[], int] = leader_now_ns, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Músicos conectados")
        self.setMinimumSize(760, 320)
        self._now = now
        self._followers: List[dict] = []

        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(10)
        self.summary = QLabel()
        self.summary.setStyleSheet("font-size: 14px; font-weight: 600;")
        layout.addWidget(self.summary)

        self.table = QTableWidget(0, len(COLUMNS))
        self.table.setHorizontalHeaderLabels(COLUMNS)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.table.setSelectionMode(QTableWidget.NoSelection)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Stretch)
        for col in range(1, len(COLUMNS)):
            header.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        layout.addWidget(self.table)

        hint = QLabel(
            "RTT: ida y vuelta de la red. Jitter: cuánto varía. Salida de audio: latencia del "
            "teléfono (Bluetooth la sube); se compensa sola. Bueno: RTT < 20 ms y jitter < 3 ms."
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #888888; font-size: 11px;")
        layout.addWidget(hint)

        # Sin reportes nuevos un músico pasa a SIN DATOS: se recalcula aunque nadie reporte.
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._render)
        self._timer.start(2000)
        self.set_followers(followers)

    def set_followers(self, followers: List[dict]) -> None:
        self._followers = list(followers or [])
        self._render()

    def _render(self) -> None:
        now = self._now()
        rows = sorted(
            self._followers,
            key=lambda f: (HEALTH_ORDER[link_health(f.get("link"), now)[0]], str(f.get("alias", "")).lower()),
        )
        self.table.setRowCount(len(rows))
        for r, f in enumerate(rows):
            link = f.get("link") or {}
            level, reason = link_health(f.get("link"), now)
            values = [
                str(f.get("alias", "")),
                ROLE_LABELS.get(f.get("role"), str(f.get("role", ""))),
                _ms(link.get("rtt_ms")),
                _ms(link.get("jitter_ms")),
                _ms(link.get("output_latency_ms")),
                AUDIO_LABELS.get(link.get("audio"), "—") + (" · silenciado" if link.get("muted") else ""),
                f"{HEALTH_LABELS[level]} · {reason}",
            ]
            for c, text in enumerate(values):
                item = QTableWidgetItem(text)
                if 2 <= c <= 4:
                    item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                if c == 6:
                    item.setForeground(QColor(HEALTH_COLORS[level]))
                self.table.setItem(r, c, item)
        self.summary.setText(summary_text(self._followers, now) if self._followers else "Nadie conectado todavía")
