"""Stem mixer of the live song (phase 3): one strip per stem, alignment and import.

Visible only when the live song has stems. Mute / solo / volume are resolved here to
one linear gain per stem and sent to the audio engine by MainWindow.
"""

from typing import List

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDoubleSpinBox, QFrame, QHBoxLayout, QLabel, QPushButton, QScrollArea, QVBoxLayout, QWidget,
)

from src.ui import theme
from src.ui.widgets.mixer import ChannelStrip


def resolve_gains(gains_db: List[float], muted: List[bool], soloed: List[bool]) -> List[float]:
    """Linear gain per stem: solo wins over mute; -60 dB or less is silence."""
    any_solo = any(soloed)
    out = []
    for db, m, s in zip(gains_db, muted, soloed):
        audible = s if any_solo else not m
        out.append(0.0 if not audible or db <= -60.0 else 10 ** (db / 20.0))
    return out


class StemMixerWidget(QWidget):
    gains_changed = Signal(list)  # linear gain per stem
    stem_changed = Signal(int, float, bool)  # index, gain_db, muted (to persist)
    offset_changed = Signal(float)  # ms
    import_requested = Signal()
    remove_requested = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.strips: List[ChannelStrip] = []
        self._db: List[float] = []
        self._muted: List[bool] = []
        self._solo: List[bool] = []

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        head = QHBoxLayout()
        head.setContentsMargins(12, 8, 12, 0)
        title = QLabel("STEMS")
        title.setProperty("kind", "panel-title")
        head.addWidget(title)
        self.song_label = QLabel("")
        self.song_label.setProperty("kind", "body")
        head.addWidget(self.song_label, 1)
        layout.addLayout(head)

        self.status = QLabel("")
        self.status.setWordWrap(True)
        self.status.setProperty("tone", "warning")
        self.status.hide()
        layout.addWidget(self.status)

        self._strips_host = QWidget()
        self._strips_layout = QHBoxLayout(self._strips_host)
        self._strips_layout.setContentsMargins(0, 0, 0, 0)
        self._strips_layout.setSpacing(0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setWidget(self._strips_host)
        layout.addWidget(scroll, 1)

        foot = QHBoxLayout()
        foot.setContentsMargins(12, 0, 12, 8)
        align = QLabel("ALINEACION")
        align.setProperty("kind", "label")
        foot.addWidget(align)
        self.offset_spin = QDoubleSpinBox()
        self.offset_spin.setRange(-5000.0, 5000.0)
        self.offset_spin.setDecimals(0)
        self.offset_spin.setSingleStep(5.0)
        self.offset_spin.setSuffix(" ms")
        self.offset_spin.setToolTip("Positivo: los stems suenan antes; negativo: después")
        self.offset_spin.setKeyboardTracking(False)
        self.offset_spin.valueChanged.connect(self.offset_changed.emit)
        foot.addWidget(self.offset_spin)
        foot.addStretch()
        self.import_btn = QPushButton("Reemplazar")
        self.import_btn.setToolTip("Importar otro ZIP o archivos para esta canción")
        self.import_btn.clicked.connect(self.import_requested.emit)
        foot.addWidget(self.import_btn)
        self.remove_btn = QPushButton("Quitar")
        self.remove_btn.setObjectName("danger")
        self.remove_btn.setToolTip("Borrar los stems de esta canción del portátil")
        self.remove_btn.clicked.connect(self.remove_requested.emit)
        foot.addWidget(self.remove_btn)
        layout.addLayout(foot)

    def set_stems(self, song_title: str, stems, offset_ms: float, errors=()):
        """``stems``: StemInfo list (label, gain_db, muted). ``errors``: per-stem decode errors."""
        for strip in self.strips:
            strip.setParent(None)
            strip.deleteLater()
        self.strips = []
        while self._strips_layout.count():
            self._strips_layout.takeAt(0)
        self._db = [float(s.gain_db) for s in stems]
        self._muted = [bool(s.muted) for s in stems]
        self._solo = [False] * len(stems)
        for i, info in enumerate(stems):
            strip = ChannelStrip(i, info.label.upper(), stem=True)
            strip.fader.set_db(info.gain_db)
            strip.mute_btn.setChecked(info.muted)
            strip._muted = info.muted
            strip.mute_changed.connect(self._on_mute)
            strip.solo_changed.connect(self._on_solo)
            strip.fader_changed.connect(self._on_fader)
            self._strips_layout.addWidget(strip)
            self.strips.append(strip)
        self._strips_layout.addStretch()
        self.song_label.setText(song_title)
        self.offset_spin.blockSignals(True)
        self.offset_spin.setValue(offset_ms)
        self.offset_spin.blockSignals(False)
        self.set_status("\n".join(errors) if errors else "")

    def set_status(self, text: str):
        self.status.setText(text)
        self.status.setVisible(bool(text))

    def gains(self) -> List[float]:
        return resolve_gains(self._db, self._muted, self._solo)

    def _emit(self, index: int):
        self.gains_changed.emit(self.gains())
        self.stem_changed.emit(index, self._db[index], self._muted[index])

    def _on_mute(self, index: int, muted: bool):
        self._muted[index] = muted
        self._emit(index)

    def _on_solo(self, index: int, soloed: bool):
        self._solo[index] = soloed
        self.gains_changed.emit(self.gains())

    def _on_fader(self, index: int, db: float):
        self._db[index] = db
        self._emit(index)
