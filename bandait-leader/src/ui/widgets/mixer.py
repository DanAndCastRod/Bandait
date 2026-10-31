"""
Bandait DAW — Mezclador de Canales Profesional
Mixer con 4 canales: VU meters, faders, mute/solo/pan, routing matrix.
"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QComboBox, QFrame, QSlider, QSizePolicy
)
from PySide6.QtCore import Qt, Signal, QTimer
from PySide6.QtGui import QFont

from .vu_meter import VUMeter
from .fader import FaderWidget


class ChannelStrip(QWidget):
    """Tira de canal individual con controles completos."""

    mute_changed = Signal(int, bool)
    solo_changed = Signal(int, bool)
    fader_changed = Signal(int, float)
    pan_changed = Signal(int, float)
    routing_changed = Signal(int, str)

    def __init__(self, channel_id: int, name: str = "Canal", parent=None, stem: bool = False):
        super().__init__(parent)
        self.channel_id = channel_id
        self._name = name
        # Stem strip: no VU (levels are per output, not per stem) and no output
        # routing (stems always go to Salidas 1-2).
        self._stem = stem
        self._muted = False
        self._soloed = False

        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(4)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.setAlignment(Qt.AlignHCenter)

        # === NOMBRE DEL CANAL ===
        self.name_label = QLabel(self._name)
        self.name_label.setFont(QFont("Inter", 9, QFont.Bold))
        _tone(self.name_label, "fg")
        self.name_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.name_label)

        # === VU METER ===
        self.vu = VUMeter(f"CH{self.channel_id + 1}")
        self.vu.setMinimumHeight(150)
        layout.addWidget(self.vu)
        self.vu.setVisible(not self._stem)

        # === BOTONES MUTE/SOLO ===
        buttons_layout = QHBoxLayout()
        buttons_layout.setSpacing(4)

        self.mute_btn = QPushButton("M")
        self.mute_btn.setCheckable(True)
        self.mute_btn.setObjectName("toggle")
        self.mute_btn.setProperty("id", "mute")
        self.mute_btn.setToolTip("Silenciar canal")
        self.mute_btn.clicked.connect(self._on_mute)
        buttons_layout.addWidget(self.mute_btn)

        self.solo_btn = QPushButton("S")
        self.solo_btn.setCheckable(True)
        self.solo_btn.setObjectName("toggle")
        self.solo_btn.setProperty("id", "solo")
        self.solo_btn.setToolTip("Solo canal")
        self.solo_btn.clicked.connect(self._on_solo)
        buttons_layout.addWidget(self.solo_btn)

        layout.addLayout(buttons_layout)

        # === PAN ===
        pan_label = QLabel("PAN")
        pan_label.setFont(QFont("Inter", 7))
        _tone(pan_label, "muted")
        pan_label.setAlignment(Qt.AlignCenter)
        pan_label.setVisible(False)  # pan is hidden until the mixer applies it
        layout.addWidget(pan_label)
        self.pan_label = pan_label

        self.pan_slider = QSlider(Qt.Horizontal)
        self.pan_slider.setMinimum(-50)
        self.pan_slider.setMaximum(50)
        self.pan_slider.setValue(0)
        self.pan_slider.setMaximumWidth(60)
        self.pan_slider.valueChanged.connect(self._on_pan)
        # El mezclador no aplica paneo todavía: oculto hasta que exista.
        self.pan_slider.setEnabled(False)
        self.pan_slider.setVisible(False)
        layout.addWidget(self.pan_slider)

        self.pan_display = QLabel("C")
        self.pan_display.setFont(QFont("JetBrains Mono", 8))
        _tone(self.pan_display, "muted")
        self.pan_display.setAlignment(Qt.AlignCenter)
        self.pan_display.setVisible(False)  # goes with the hidden pan slider
        layout.addWidget(self.pan_display)

        # === FADER ===
        self.fader = FaderWidget("Vol")
        self.fader.setMinimumHeight(160)
        self.fader.value_changed.connect(self._on_fader)
        layout.addWidget(self.fader)

        # === ROUTING ===
        routing_label = QLabel("SALIDA")
        routing_label.setFont(QFont("Inter", 7))
        _tone(routing_label, "muted")
        routing_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(routing_label)
        routing_label.setVisible(not self._stem)
        self.routing_label = routing_label

        self.routing_combo = QComboBox()
        self.routing_combo.addItems([
            "Master",
            "Salida 1",
            "Salida 2",
            "Salida 3",
            "Salida 4"
        ])
        self.routing_combo.setMaximumWidth(80)
        self.routing_combo.currentTextChanged.connect(self._on_routing)
        layout.addWidget(self.routing_combo)
        self.routing_combo.setVisible(not self._stem)

        layout.addStretch()

    def _on_mute(self):
        self._muted = self.mute_btn.isChecked()
        self.mute_changed.emit(self.channel_id, self._muted)

    def _on_solo(self):
        self._soloed = self.solo_btn.isChecked()
        self.solo_changed.emit(self.channel_id, self._soloed)

    def _on_fader(self, db: float):
        self.fader_changed.emit(self.channel_id, db)

    def _on_pan(self, value: int):
        pan = value / 50.0  # -1.0 a 1.0
        if pan == 0:
            self.pan_display.setText("C")
            _tone(self.pan_display, "muted")
        elif pan < 0:
            self.pan_display.setText(f"L{abs(int(pan * 100))}")
            _tone(self.pan_display, "active")
        else:
            self.pan_display.setText(f"R{int(pan * 100)}")
            _tone(self.pan_display, "active")
        self.pan_changed.emit(self.channel_id, pan)

    def _on_routing(self, text: str):
        self.routing_changed.emit(self.channel_id, text)

    def set_level(self, level: float):
        """Actualizar VU meter."""
        self.vu.set_level(level)

    def set_name(self, name: str):
        self._name = name
        self.name_label.setText(name)


class MixerWidget(QWidget):
    """Mezclador completo con master y 4 canales."""

    channel_mute = Signal(int, bool)
    channel_solo = Signal(int, bool)
    channel_fader = Signal(int, float)
    channel_pan = Signal(int, float)
    channel_routing = Signal(int, str)
    master_fader = Signal(float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.channels = []
        self._setup_ui()

    def _setup_ui(self):
        layout = QHBoxLayout(self)
        layout.setSpacing(0)
        layout.setContentsMargins(0, 0, 0, 0)

        # Canales 1-4
        for i in range(4):
            ch = ChannelStrip(i, f"Canal {i + 1}")
            ch.mute_changed.connect(self.channel_mute.emit)
            ch.solo_changed.connect(self.channel_solo.emit)
            ch.fader_changed.connect(self.channel_fader.emit)
            ch.pan_changed.connect(self.channel_pan.emit)
            ch.routing_changed.connect(self.channel_routing.emit)
            self.channels.append(ch)
            layout.addWidget(ch)

            # Separador
            if i < 3:
                sep = QFrame()
                sep.setObjectName("separator_v")
                sep.setProperty("role", "divider")
                layout.addWidget(sep)

        # Separador antes del master
        sep_master = QFrame()
        sep_master.setObjectName("separator_v")
        sep_master.setProperty("role", "divider")
        layout.addWidget(sep_master)

        # Master
        master_frame = QFrame()
        master_frame.setObjectName("panel")
        master_layout = QVBoxLayout(master_frame)
        master_layout.setSpacing(4)
        master_layout.setContentsMargins(8, 4, 8, 4)
        master_layout.setAlignment(Qt.AlignHCenter)

        master_label = QLabel("MASTER")
        master_label.setFont(QFont("Inter", 10, QFont.Bold))
        _tone(master_label, "active")
        master_label.setAlignment(Qt.AlignCenter)
        master_layout.addWidget(master_label)

        self.master_vu = VUMeter("MST")
        self.master_vu.setMinimumHeight(150)
        master_layout.addWidget(self.master_vu)

        # Master fader
        self.master_fader_widget = FaderWidget("Master", min_db=-60.0, max_db=6.0)
        self.master_fader_widget.setMinimumHeight(160)
        self.master_fader_widget.value_changed.connect(self.master_fader.emit)
        master_layout.addWidget(self.master_fader_widget)

        # Indicadores
        self.stereo_label = QLabel("STEREO")
        self.stereo_label.setFont(QFont("Inter", 8))
        _tone(self.stereo_label, "muted")
        self.stereo_label.setAlignment(Qt.AlignCenter)
        master_layout.addWidget(self.stereo_label)

        master_layout.addStretch()
        layout.addWidget(master_frame)

    def set_channel_name(self, channel_id: int, name: str):
        if 0 <= channel_id < len(self.channels):
            self.channels[channel_id].set_name(name)

    def set_channel_level(self, channel_id: int, level: float):
        if 0 <= channel_id < len(self.channels):
            self.channels[channel_id].set_level(level)

    def set_master_level(self, level: float):
        self.master_vu.set_level(level)

def _tone(widget, tone: str) -> None:
    """Text color from the QSS template (QLabel[tone=...]); no inline styles."""
    from src.ui.components import set_prop

    set_prop(widget, "tone", tone)
