"""
Bandait DAW — Línea de Tiempo / Arrangement View
Vista de arreglo con secciones de canción, playhead, zoom.
"""

from PySide6.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel, QFrame, QScrollArea, QSizePolicy
from PySide6.QtCore import Qt, QRect, QTimer, Signal
from PySide6.QtGui import QPainter, QColor, QPen, QBrush, QFont


class SectionItem:
    """Sección de canción (Intro, Verso, Coro, etc.)."""

    def __init__(self, label: str, start_beat: int, duration_beats: int,
                 color: QColor = None):
        self.label = label
        self.start_beat = start_beat
        self.duration_beats = duration_beats
        self.color = color or QColor(0, 255, 255, 60)


class TimelineWidget(QWidget):
    """Línea de tiempo con secciones y playhead."""

    position_changed = Signal(float)  # segundos
    section_clicked = Signal(str)

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

        self.setMinimumHeight(200)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding
        )

        # Timer para playhead
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._update_playhead)

    def set_bpm(self, bpm: int):
        self._bpm = max(40, min(300, bpm))
        self.update()

    def set_duration(self, seconds: float):
        self._duration = max(1.0, seconds)
        self.update()

    def set_position(self, seconds: float):
        self._position = max(0.0, min(self._duration, seconds))
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
        self._timer.start(33)  # ~30fps

    def stop_playback(self):
        self._timer.stop()

    def _update_playhead(self):
        self._position += 0.033
        if self._position >= self._duration:
            self._position = 0.0
        self.update()
        self.position_changed.emit(self._position)

    def _seconds_to_x(self, seconds: float) -> int:
        beat_duration = 60.0 / self._bpm
        total_beats = seconds / beat_duration
        return int(self._header_height + total_beats * self._beat_width * self._zoom)

    def _x_to_seconds(self, x: int) -> float:
        beat_duration = 60.0 / self._bpm
        beats = (x - self._header_height) / (self._beat_width * self._zoom)
        return beats * beat_duration

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)

        w = self.width()
        h = self.height()
        bg = QColor(0, 0, 0)
        painter.fillRect(self.rect(), bg)

        # === RULER (tiempo) ===
        ruler_rect = QRect(0, 0, w, self._ruler_height)
        painter.fillRect(ruler_rect, QColor(10, 10, 10))
        painter.setPen(QPen(QColor(30, 30, 30), 1))
        painter.drawLine(0, self._ruler_height, w, self._ruler_height)

        # Marcas de tiempo
        beat_duration = 60.0 / self._bpm
        total_beats = int(self._duration / beat_duration)
        painter.setFont(QFont("JetBrains Mono", 9))

        for beat in range(total_beats + 1):
            x = self._seconds_to_x(beat * beat_duration)
            if x < 0 or x > w:
                continue

            bar = beat // self._beats_per_bar
            beat_in_bar = beat % self._beats_per_bar

            if beat_in_bar == 0:
                # Barra
                painter.setPen(QPen(QColor(102, 102, 102), 1))
                painter.drawLine(x, 0, x, self._ruler_height)
                painter.setPen(QColor(240, 240, 240))
                painter.drawText(x + 2, 14, f"{bar + 1}")
            else:
                # Beat
                painter.setPen(QPen(QColor(51, 51, 51), 1))
                painter.drawLine(x, self._ruler_height - 8, x, self._ruler_height)

        # === PISTAS ===
        track_y = self._ruler_height + 4

        # Pista de secciones
        track_rect = QRect(0, track_y, w, self._track_height)
        painter.fillRect(track_rect, QColor(10, 10, 10))
        painter.setPen(QPen(QColor(30, 30, 30), 1))
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
            painter.setPen(QColor(240, 240, 240))
            text_rect = QRect(x1 + 4, track_y + 8, width - 8, 20)
            painter.drawText(text_rect, Qt.AlignLeft, section.label)

            # Duración en compases
            bars = section.duration_beats // self._beats_per_bar
            painter.setFont(QFont("JetBrains Mono", 8))
            painter.setPen(QColor(200, 200, 200))
            dur_rect = QRect(x1 + 4, track_y + 28, width - 8, 16)
            painter.drawText(dur_rect, Qt.AlignLeft, f"{bars} compas{'es' if bars != 1 else ''}")

        # === PLAYHEAD ===
        playhead_x = self._seconds_to_x(self._position)
        if 0 <= playhead_x < w:
            painter.setPen(QPen(QColor(255, 0, 0), 2))
            painter.drawLine(playhead_x, 0, playhead_x, h)

            # Triángulo en la parte superior
            painter.setBrush(QBrush(QColor(255, 0, 0)))
            painter.drawPolygon([
                playhead_x - 6, 0,
                playhead_x + 6, 0,
                playhead_x, 8
            ])

        # === TIEMPO ACTUAL ===
        painter.setFont(QFont("JetBrains Mono", 10))
        painter.setPen(QColor(204, 255, 0))
        mins = int(self._position) // 60
        secs = int(self._position) % 60
        ms = int((self._position % 1) * 100)
        time_text = f"{mins:02d}:{secs:02d}.{ms:02d}"
        painter.drawText(8, h - 8, time_text)

        painter.end()

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            pos = self._x_to_seconds(event.pos().x())
            self.set_position(pos)
            self.position_changed.emit(pos)

    def mouseMoveEvent(self, event):
        if event.buttons() & Qt.LeftButton:
            pos = self._x_to_seconds(event.pos().x())
            self.set_position(pos)
            self.position_changed.emit(pos)

    def resizeEvent(self, event):
        self.update()
        super().resizeEvent(event)
