"""
Bandait DAW — Fader de Canal
Fader vertical con display de valor en dB.
"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import QLabel, QSlider, QVBoxLayout, QWidget


class FaderWidget(QWidget):
    """Fader vertical con label y display de valor."""

    value_changed = Signal(float)

    def __init__(self, label: str = "Vol", min_db: float = -60.0, max_db: float = 6.0, parent=None):
        super().__init__(parent)
        self.min_db = min_db
        self.max_db = max_db
        self._value_db = 0.0

        layout = QVBoxLayout(self)
        layout.setSpacing(4)
        layout.setContentsMargins(4, 4, 4, 4)

        # Label
        self.label = QLabel(label)
        self.label.setFont(QFont("Inter", 9, QFont.Bold))
        self.label.setStyleSheet("color: #666666;")
        self.label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.label)

        # Fader
        self.slider = QSlider(Qt.Vertical)
        self.slider.setMinimum(0)
        self.slider.setMaximum(1000)
        self.slider.setValue(750)  # ~0dB por defecto
        self.slider.setMinimumHeight(120)
        self.slider.valueChanged.connect(self._on_slider_changed)
        layout.addWidget(self.slider, 1)

        # Display de dB
        self.display = QLabel("0.0dB")
        self.display.setFont(QFont("JetBrains Mono", 9, QFont.Bold))
        self.display.setStyleSheet("color: #00FFFF;")
        self.display.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.display)

    def _on_slider_changed(self, value: int):
        """Convertir valor del slider (0-1000) a dB."""
        # Curva logarítmica aproximada
        normalized = value / 1000.0
        if normalized <= 0:
            self._value_db = self.min_db
        else:
            # Mapeo: 0 -> -60dB, 0.75 -> 0dB, 1.0 -> +6dB
            if normalized <= 0.75:
                self._value_db = self.min_db + (normalized / 0.75) * 60
            else:
                self._value_db = (normalized - 0.75) / 0.25 * self.max_db

        self._update_display()
        self.value_changed.emit(self._value_db)

    def _update_display(self):
        if self._value_db <= self.min_db + 1:
            self.display.setText("-∞")
            self.display.setStyleSheet("color: #333333;")
        elif self._value_db < -12:
            self.display.setText(f"{self._value_db:.1f}dB")
            self.display.setStyleSheet("color: #00FFFF;")
        elif self._value_db < 0:
            self.display.setText(f"{self._value_db:.1f}dB")
            self.display.setStyleSheet("color: #CCFF00;")
        else:
            self.display.setText(f"+{self._value_db:.1f}dB")
            self.display.setStyleSheet("color: #FFAA00;")

    def get_db(self) -> float:
        return self._value_db

    def set_db(self, db: float):
        self._value_db = max(self.min_db, min(self.max_db, db))
        if self._value_db <= self.min_db + 1:
            self.slider.setValue(0)
        elif self._value_db <= 0:
            normalized = (self._value_db - self.min_db) / 60 * 0.75
            self.slider.setValue(int(normalized * 1000))
        else:
            normalized = 0.75 + (self._value_db / self.max_db) * 0.25
            self.slider.setValue(int(normalized * 1000))
        self._update_display()
