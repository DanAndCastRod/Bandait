"""
Bandait DAW — Línea de Tiempo / Arrangement View
Vista de arreglo con secciones de canción, playhead, zoom.
Interactivo: drag secciones, zoom rueda ratón, click para posicionar.
"""

import math

from PySide6.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel, QFrame, QScrollArea, QSizePolicy
from PySide6.QtCore import Qt, QRect, QTimer, Signal, QPoint
from PySide6.QtGui import QPainter, QColor, QPen, QBrush, QFont, QMouseEvent, QPolygon, QWheelEvent, QKeyEvent

from src.ui import theme

from ._paint import safe_paint

# Bounds that keep every coordinate inside Qt's 32-bit int (QRect, QPoint):
# a bad duration or zoom must never turn into an OverflowError while painting.
MAX_DURATION_S = 24 * 3600.0
_X_LIMIT = 1_000_000


def _finite(value, default: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


LANE_H = 52  # alto de cada carril de stem (px)

class SectionItem:
    """Sección de canción (Intro, Verso, Coro, etc.)."""

    COLORS = {
        "Intro": QColor(92, 200, 194, 80),
        "Verso": QColor(184, 207, 122, 80),
        "Pre-Coro": QColor(217, 162, 78, 80),
        "Coro": QColor(180, 142, 219, 80),
        "Puente": QColor(92, 200, 194, 60),
        "Solo": QColor(217, 100, 89, 80),
        "Outro": QColor(124, 133, 145, 80),
    }

    def __init__(self, label: str, start_beat: int, duration_beats: int,
                 color: QColor = None):
        self.label = label
        self.start_beat = start_beat
        self.duration_beats = duration_beats
        self.color = color or self.COLORS.get(label, QColor(92, 200, 194, 60))


class TimelineWidget(QWidget):
    """Línea de tiempo con secciones y playhead."""

    position_changed = Signal(float)  # segundos
    section_clicked = Signal(str)
    section_moved = Signal(str, int, int)  # label, new_start_beat, duration

    def __init__(self, parent=None):
        super().__init__(parent)
        self._sections = []
        self._position = 0.0  # segundos
        self._duration = 180.0  # 3 minutos default
        self._bpm = 120
        self._beats_per_bar = 4
        self._zoom = 1.0
        self._beat_width = 20.0
        self._header_height = 30
        self._track_height = 60
        self._ruler_height = 24
        self._playing = False

        # Drag state
        self._drag_section = None
        self._drag_start_x = 0
        self._drag_start_beat = 0

        self._lanes = []
        self._lane_duration = 0.001
        self.setMinimumHeight(200)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding
        )
        self.setFocusPolicy(Qt.StrongFocus)

        # Timer para playhead
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._update_playhead)

    def set_bpm(self, bpm: int):
        self._bpm = max(40.0, min(300.0, _finite(bpm, self._bpm)))
        self.update()

    def set_lanes(self, lanes, duration: float):
        """Stem lanes: [(label, envelope 0..1, gain)] over ``duration`` seconds."""
        self._lanes = list(lanes or [])
        self._lane_duration = max(0.001, float(duration or 0.0))
        if duration and duration > self._duration:
            self.set_duration(duration)
        self.setMinimumHeight(200 + len(self._lanes) * (LANE_H + 4))
        self.update()

    def set_duration(self, seconds: float):
        self._duration = max(1.0, min(MAX_DURATION_S, _finite(seconds, self._duration)))
        self.update()

    def set_position(self, seconds: float):
        self._position = max(0.0, min(self._duration, _finite(seconds, 0.0)))
        self.update()

    def add_section(self, label: str, start_beat: int, duration_beats: int,
                    color: QColor = None):
        section = SectionItem(label, start_beat, duration_beats, color)
        self._sections.append(section)
        self.update()

    def clear_sections(self):
        self._sections.clear()
        self.update()

    def start_playback(self):
        self._playing = True
        self._timer.start(33)

    def stop_playback(self):
        self._playing = False
        self._timer.stop()

    def _update_playhead(self):
        """Actualizar posición del playhead (llamado por timer interno)."""
        if self._playing:
            self._position += 0.033
            if self._position >= self._duration:
                self._position = 0.0
            self.update()
            self.position_changed.emit(self._position)

    def _seconds_to_x(self, seconds: float) -> int:
        beat_duration = 60.0 / self._bpm
        total_beats = _finite(seconds, 0.0) / beat_duration
        x = self._header_height + total_beats * self._beat_width * self._zoom
        return int(max(-_X_LIMIT, min(_X_LIMIT, x)))

    def _x_to_seconds(self, x: int) -> float:
        beat_duration = 60.0 / self._bpm
        beats = (x - self._header_height) / (self._beat_width * self._zoom)
        return beats * beat_duration

    def _x_to_beat(self, x: int) -> int:
        beats = (x - self._header_height) / (self._beat_width * self._zoom)
        return int(beats)

    @safe_paint
    def paintEvent(self, event, painter):
        painter.setRenderHint(QPainter.Antialiasing)

        w = self.width()
        h = self.height()
        bg = QColor(21, 24, 28)
        painter.fillRect(self.rect(), bg)

        # === RULER (tiempo) ===
        ruler_rect = QRect(0, 0, w, self._ruler_height)
        painter.fillRect(ruler_rect, QColor(27, 31, 36))
        painter.setPen(QPen(QColor(38, 44, 52), 1))
        painter.drawLine(0, self._ruler_height, w, self._ruler_height)

        # Marcas de tiempo: solo los beats visibles (no todos los de la canción).
        beat_duration = 60.0 / self._bpm
        total_beats = int(self._duration / beat_duration)
        first_beat = max(0, self._x_to_beat(0))
        last_beat = min(total_beats, self._x_to_beat(w) + 1)
        painter.setFont(QFont("JetBrains Mono", 9))

        for beat in range(first_beat, last_beat + 1):
            x = self._seconds_to_x(beat * beat_duration)
            if x < 0 or x > w:
                continue

            bar = beat // self._beats_per_bar
            beat_in_bar = beat % self._beats_per_bar

            if beat_in_bar == 0:
                # Barra
                painter.setPen(QPen(QColor(124, 133, 145), 1))
                painter.drawLine(x, 0, x, self._ruler_height)
                painter.setPen(QColor(213, 218, 224))
                painter.drawText(x + 2, 14, f"{bar + 1}")
            else:
                # Beat
                painter.setPen(QPen(QColor(54, 61, 71), 1))
                painter.drawLine(x, self._ruler_height - 8, x, self._ruler_height)

        # === PISTAS ===
        track_y = self._ruler_height + 4

        # Pista de secciones
        track_rect = QRect(0, track_y, w, self._track_height)
        painter.fillRect(track_rect, QColor(27, 31, 36))
        painter.setPen(QPen(QColor(38, 44, 52), 1))
        painter.drawRect(track_rect)

        # Dibujar secciones
        for section in self._sections:
            start_sec = section.start_beat * beat_duration
            end_sec = (section.start_beat + section.duration_beats) * beat_duration

            x1 = self._seconds_to_x(start_sec)
            x2 = self._seconds_to_x(end_sec)
            width = max(1, x2 - x1)

            section_rect = QRect(x1, track_y + 2, width, self._track_height - 4)
            painter.fillRect(section_rect, section.color)
            painter.setPen(QPen(section.color.lighter(150), 1))
            painter.drawRect(section_rect)

            # Label
            painter.setFont(QFont("Inter", 10, QFont.Bold))
            painter.setPen(QColor(213, 218, 224))
            text_rect = QRect(x1 + 4, track_y + 8, width - 8, 20)
            painter.drawText(text_rect, Qt.AlignLeft, section.label)

            # Duración en compases
            bars = section.duration_beats // self._beats_per_bar
            painter.setFont(QFont("JetBrains Mono", 8))
            painter.setPen(QColor(186, 194, 204))
            dur_rect = QRect(x1 + 4, track_y + 28, width - 8, 16)
            painter.drawText(dur_rect, Qt.AlignLeft, f"{bars} compas{'es' if bars != 1 else ''}")

        # === CARRILES DE STEMS (envolvente por pista; gris si está en silencio) ===
        lane_y = track_y + self._track_height + 6
        for label, env, gain in self._lanes:
            lane_rect = QRect(0, lane_y, w, LANE_H)
            painter.fillRect(lane_rect, QColor(theme.SURFACE))
            if env is not None and len(env):
                painter.setPen(QPen(QColor(theme.ACTIVE if gain > 0 else theme.FAINT), 1))
                mid = lane_y + LANE_H // 2
                half = LANE_H // 2 - 4
                n = len(env)
                for x in range(0, w, 2):
                    t = self._x_to_seconds(x)
                    if t < 0 or t >= self._lane_duration:
                        continue
                    a = float(env[min(n - 1, int(t / self._lane_duration * n))]) * half
                    painter.drawLine(x, int(mid - a), x, int(mid + a))
            painter.setFont(QFont(theme.FONT_UI, 9, QFont.Bold))
            text_w = painter.fontMetrics().horizontalAdvance(label) + 12
            painter.fillRect(QRect(4, lane_y + 4, text_w, 18), QColor(theme.ELEVATED))
            painter.setPen(QColor(theme.FG))
            painter.drawText(QRect(10, lane_y + 5, text_w, 16), Qt.AlignLeft, label)
            lane_y += LANE_H + 4

        # === PLAYHEAD ===
        playhead_x = self._seconds_to_x(self._position)
        if 0 <= playhead_x < w:
            painter.setPen(QPen(QColor(217, 100, 89), 2))
            painter.drawLine(playhead_x, 0, playhead_x, h)

            # Triángulo en la parte superior. drawPolygon exige QPolygon/QPoint:
            # una lista plana de ints lanza TypeError y tumbaba la app al tocar.
            painter.setBrush(QBrush(QColor(217, 100, 89)))
            painter.drawPolygon(QPolygon([
                QPoint(playhead_x - 6, 0),
                QPoint(playhead_x + 6, 0),
                QPoint(playhead_x, 8),
            ]))

        # === TIEMPO ACTUAL ===
        painter.setFont(QFont("JetBrains Mono", 10))
        painter.setPen(QColor(184, 207, 122))
        mins = int(self._position) // 60
        secs = int(self._position) % 60
        ms = int((self._position % 1) * 100)
        time_text = f"{mins:02d}:{secs:02d}.{ms:02d}"
        painter.drawText(8, h - 8, time_text)

        # === INFO ZOOM ===
        painter.setFont(QFont("JetBrains Mono", 8))
        painter.setPen(QColor(124, 133, 145))
        painter.drawText(w - 80, h - 8, f"Zoom: {self._zoom:.1f}x")

    def mousePressEvent(self, event: QMouseEvent):
        if event.button() == Qt.LeftButton:
            x = event.pos().x()
            y = event.pos().y()
            track_y = self._ruler_height + 4

            # Verificar si click en una sección (para drag)
            beat_duration = 60.0 / self._bpm
            for section in self._sections:
                start_sec = section.start_beat * beat_duration
                end_sec = (section.start_beat + section.duration_beats) * beat_duration
                x1 = self._seconds_to_x(start_sec)
                x2 = self._seconds_to_x(end_sec)

                if x1 <= x <= x2 and track_y <= y <= track_y + self._track_height:
                    self._drag_section = section
                    self._drag_start_x = x
                    self._drag_start_beat = section.start_beat
                    self.setCursor(Qt.ClosedHandCursor)
                    return

            # Si no es sección, posicionar playhead
            pos = self._x_to_seconds(x)
            self.set_position(pos)
            self.position_changed.emit(pos)

    def mouseMoveEvent(self, event: QMouseEvent):
        if self._drag_section and (event.buttons() & Qt.LeftButton):
            dx = event.pos().x() - self._drag_start_x
            dbeats = int(dx / (self._beat_width * self._zoom))
            new_start = max(0, self._drag_start_beat + dbeats)
            self._drag_section.start_beat = new_start
            self.update()

    def mouseReleaseEvent(self, event: QMouseEvent):
        if self._drag_section:
            self.section_moved.emit(
                self._drag_section.label,
                self._drag_section.start_beat,
                self._drag_section.duration_beats
            )
            self._drag_section = None
            self._drag_start_x = 0
            self.setCursor(Qt.ArrowCursor)

    def wheelEvent(self, event: QWheelEvent):
        """Zoom con rueda del ratón."""
        delta = event.angleDelta().y()
        if delta > 0:
            self._zoom = min(5.0, self._zoom * 1.1)
        else:
            self._zoom = max(0.1, self._zoom / 1.1)
        self.update()

    def zoom_in(self):
        self._zoom = min(5.0, self._zoom * 1.25)
        self.update()

    def zoom_out(self):
        self._zoom = max(0.1, self._zoom / 1.25)
        self.update()

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_Space:
            # Espacio es el transporte de la banda: lo maneja la ventana principal.
            event.ignore()
            return
        elif event.key() == Qt.Key_Home:
            self.set_position(0)
        elif event.key() == Qt.Key_End:
            self.set_position(self._duration)
        else:
            super().keyPressEvent(event)

    def resizeEvent(self, event):
        self.update()
        super().resizeEvent(event)
