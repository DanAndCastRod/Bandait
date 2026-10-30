"""Capa de brillo (Ver > Brillo): oscurece toda la ventana del líder sin tocar el brillo de
Windows. No recibe clics ni teclado: es solo una veladura negra semitransparente encima."""

from __future__ import annotations

from PySide6.QtCore import QEvent, QObject, Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QWidget

from ._paint import safe_paint

BRIGHTNESS_LEVELS = (100, 85, 70, 55, 40)
MIN_BRIGHTNESS = 40


def clamp_brightness(value: int) -> int:
    return max(MIN_BRIGHTNESS, min(100, int(value)))


class DimOverlay(QWidget):
    """Hijo directo de la ventana; se mantiene del tamaño de la ventana y siempre arriba."""

    def __init__(self, parent: QWidget):
        super().__init__(parent)
        self.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        self.setAttribute(Qt.WA_NoSystemBackground, True)
        self.setFocusPolicy(Qt.NoFocus)
        self._alpha = 0
        parent.installEventFilter(self)
        self.setGeometry(parent.rect())
        self.hide()

    @property
    def brightness(self) -> int:
        return round(100 - self._alpha * 100 / 255)

    def set_brightness(self, percent: int) -> int:
        percent = clamp_brightness(percent)
        self._alpha = round((100 - percent) * 255 / 100)
        self.setVisible(self._alpha > 0)
        if self._alpha:
            self.raise_()
        self.update()
        return percent

    def eventFilter(self, obj: QObject, event: QEvent) -> bool:  # noqa: N802 (Qt API)
        if obj is self.parent() and event.type() in (QEvent.Resize, QEvent.Show):
            self.setGeometry(self.parent().rect())
            if self._alpha:
                self.raise_()
        return False

    @safe_paint
    def paintEvent(self, event, painter):  # noqa: N802 (Qt API)
        if self._alpha:
            painter.fillRect(self.rect(), QColor(0, 0, 0, self._alpha))
