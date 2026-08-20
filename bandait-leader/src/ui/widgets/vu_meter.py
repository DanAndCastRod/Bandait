"""
Bandait DAW — Medidor de Nivel (VU Meter)
Widget personalizado con colores dinámicos según nivel.
"""

from PySide6.QtCore import QRect, Qt, QTimer
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import QWidget


class VUMeter(QWidget):
    """Medidor de nivel de audio con escala en dB."""

    # Colores por rango
    COLOR_LOW = QColor(0, 255, 255)      # Cyan: -60 a -24 dB
    COLOR_MID = QColor(204, 255, 0)     # Lime: -24 a -12 dB
    COLOR_HIGH = QColor(255, 170, 0)    # Naranja: -12 a -6 dB
    COLOR_PEAK = QColor(255, 0, 0)      # Rojo: > -6 dB

    def __init__(self, label: str = "CH", parent=None):
        super().__init__(parent)
        self.label_text = label
        self._level = 0.0  # 0.0 a 1.0
        self._peak = 0.0
        self._peak_hold_frames = 0
        self._peak_decay = 0.008
        self.setMinimumWidth(36)
        self.setMaximumWidth(48)
        self.setMinimumHeight(120)

        # Timer para decay del peak
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._decay_peak)
        self._timer.start(16)  # ~60fps

    def set_level(self, level: float):
        """Actualizar nivel (0.0 a 1.0)."""
        self._level = max(0.0, min(1.0, level))
        if self._level > self._peak:
            self._peak = self._level
            self._peak_hold_frames = 30  # Hold por ~0.5s
        self.update()

    def _decay_peak(self):
        if self._peak_hold_frames > 0:
            self._peak_hold_frames -= 1
        else:
            self._peak = max(0.0, self._peak - self._peak_decay)
        self.update()

    def _db_to_color(self, db: float) -> QColor:
        """Convertir dB a color."""
        if db < -24:
            return self.COLOR_LOW
        elif db < -12:
            return self.COLOR_MID
        elif db < -6:
            return self.COLOR_HIGH
        else:
            return self.COLOR_PEAK

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        w = self.width()
        h = self.height()
        bar_w = max(20, w - 16)
        bar_x = (w - bar_w) // 2

        # Fondo
        bg_rect = QRect(bar_x, 20, bar_w, h - 40)
        painter.fillRect(bg_rect, QColor(10, 10, 10))
        painter.setPen(QPen(QColor(30, 30, 30), 1))
        painter.drawRect(bg_rect)

        # Marcas de dB
        db_marks = [(-60, 1.0), (-48, 0.8), (-36, 0.6), (-24, 0.5),
                    (-18, 0.4), (-12, 0.3), (-6, 0.15), (-3, 0.08), (0, 0.0)]
        painter.setFont(QFont("JetBrains Mono", 7))
        painter.setPen(QColor(102, 102, 102))
        for db, y_norm in db_marks:
            y = int(20 + (h - 40) * y_norm)
            painter.drawText(2, y - 4, bar_x - 4, 10, Qt.AlignRight, str(db))
            painter.drawLine(bar_x, y, bar_x + 4, y)

        # Barra de nivel
        if self._level > 0:
            bar_h = int((h - 40) * self._level)
            bar_y = 20 + (h - 40) - bar_h
            QRect(bar_x + 2, bar_y, bar_w - 4, bar_h)

            # Gradient manual por segmentos
            segments = 20
            seg_h = bar_h // segments
            for i in range(segments):
                seg_y = bar_y + bar_h - (i + 1) * seg_h
                seg_db = -60 + (60 * (i / segments))
                color = self._db_to_color(seg_db)
                seg_rect = QRect(bar_x + 2, seg_y, bar_w - 4, seg_h - 1)
                painter.fillRect(seg_rect, color)

        # Peak hold line
        if self._peak > 0:
            peak_y = int(20 + (h - 40) * (1.0 - self._peak))
            painter.setPen(QPen(QColor(255, 255, 255), 2))
            painter.drawLine(bar_x, peak_y, bar_x + bar_w, peak_y)

        # Label
        painter.setPen(QColor(240, 240, 240))
        painter.setFont(QFont("Inter", 8, QFont.Bold))
        painter.drawText(0, 2, w, 16, Qt.AlignCenter, self.label_text)

        # Valor numérico
        db_val = int(-60 + 60 * self._level) if self._level > 0 else -60
        painter.setFont(QFont("JetBrains Mono", 8))
        color = self._db_to_color(db_val)
        painter.setPen(color)
        painter.drawText(0, h - 14, w, 12, Qt.AlignCenter, f"{db_val}dB")

        painter.end()
