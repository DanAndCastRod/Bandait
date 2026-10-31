"""
Bandait Líder: transporte compacto de la barra superior (2.3).

Botones de transporte, compás y tiempo, tempo con TAP y ±1, pulso y estado. Todo el estilo
sale del QSS por propiedades (objectName "transport", role "beat", kind "readout"...).
"""

import time

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from src.ui import components as ui
from src.ui import theme

_STATUS = {
    "PLAYING": ("EN VIVO", "ok"),
    "COUNTING": ("CONTEO", "act"),
    "PAUSED": ("PAUSA", "warn"),
    "IDLE": ("DETENIDO", ""),
}


class TransportWidget(QWidget):
    """El widget solo expresa intenciones (play, pausa, stop, tempo). El estado que muestra
    lo fija la ventana principal desde el SessionState del líder, de modo que los botones
    nunca muestran un estado que el transporte no tiene."""

    play_clicked = Signal()
    pause_clicked = Signal()
    stop_clicked = Signal()
    rec_clicked = Signal()
    loop_clicked = Signal(bool)
    tap_tempo_clicked = Signal()
    bpm_changed = Signal(int)  # BPM pedido por el usuario (TAP)
    tempo_nudge_clicked = Signal(int)  # delta_bpm (+1 / -1)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._is_playing = False
        self._is_recording = False
        self._is_looping = False
        self._bpm = 120
        self._seconds = 0.0
        self._tap_times = []
        self._status = "IDLE"
        self._lit_beat = None
        self._setup_ui()

    def _transport_btn(self, text: str, ident: str, tooltip: str, checkable: bool = False) -> QPushButton:
        btn = QPushButton(text)
        btn.setObjectName("transport")
        btn.setProperty("id", ident)
        btn.setToolTip(tooltip)
        btn.setCheckable(checkable)
        btn.setFixedSize(44, 40)
        return btn

    def _setup_ui(self):
        layout = QHBoxLayout(self)
        layout.setSpacing(theme.SPACE_5)
        layout.setContentsMargins(0, 0, 0, 0)

        buttons = QHBoxLayout()
        buttons.setSpacing(theme.SPACE_2)
        self.stop_btn = self._transport_btn("■", "stop", "Detener")
        self.stop_btn.clicked.connect(self._on_stop)
        self.play_btn = self._transport_btn("▶", "play", "Reproducir (Espacio)", checkable=True)
        self.play_btn.clicked.connect(self._on_play)
        self.rec_btn = self._transport_btn("●", "rec", "Grabar las entradas", checkable=True)
        self.rec_btn.clicked.connect(self._on_rec)
        for b in (self.stop_btn, self.play_btn, self.rec_btn):
            buttons.addWidget(b)
        layout.addLayout(buttons)

        # Compás y tiempo
        readout = QVBoxLayout()
        readout.setSpacing(2)
        readout.addWidget(ui.label("Compás · tiempo", "label"))
        row = QHBoxLayout()
        row.setSpacing(theme.SPACE_2)
        self.bar_display = ui.label("---:--", "readout")
        self.time_display = ui.label("00:00.000", "muted")
        row.addWidget(self.bar_display)
        row.addWidget(self.time_display)
        readout.addLayout(row)
        layout.addLayout(readout)

        # Tempo
        tempo = QVBoxLayout()
        tempo.setSpacing(2)
        tempo.addWidget(ui.label("Tempo", "label"))
        trow = QHBoxLayout()
        trow.setSpacing(theme.SPACE_2)
        self.bpm_display = ui.label("120", "readout-active")
        self.bpm_display.setToolTip("BPM del transporte")
        trow.addWidget(self.bpm_display)
        self.tap_btn = ui.button("TAP", "chip", "Marca el tempo con varios toques")
        self.tap_btn.setCheckable(False)
        self.tap_btn.clicked.connect(self._on_tap_tempo)
        self.nudge_down_btn = ui.button("−1", "chip", "Bajar 1 BPM en el siguiente compás")
        self.nudge_down_btn.setCheckable(False)
        self.nudge_down_btn.clicked.connect(lambda: self.tempo_nudge_clicked.emit(-1))
        self.nudge_up_btn = ui.button("+1", "chip", "Subir 1 BPM en el siguiente compás")
        self.nudge_up_btn.setCheckable(False)
        self.nudge_up_btn.clicked.connect(lambda: self.tempo_nudge_clicked.emit(1))
        for b in (self.tap_btn, self.nudge_down_btn, self.nudge_up_btn):
            trow.addWidget(b)
        tempo.addLayout(trow)
        layout.addLayout(tempo)

        # Pulso y estado
        pulse = QVBoxLayout()
        pulse.setSpacing(6)
        pulse.addStretch()
        self.status_label = ui.tag("DETENIDO")
        self.status_label.setAlignment(Qt.AlignCenter)
        pulse.addWidget(self.status_label, 0, Qt.AlignLeft)
        beats = QHBoxLayout()
        beats.setSpacing(4)
        self.beat_indicators = []
        for i in range(4):
            led = QFrame()
            led.setProperty("role", "beat")
            led.setProperty("state", "")
            led.setFixedSize(18, 6)
            beats.addWidget(led)
            self.beat_indicators.append(led)
        pulse.addLayout(beats)
        pulse.addStretch()
        layout.addLayout(pulse)

        # BUCLE quedó sin uso en el transporte: el bucle de sección vive en la vista Ensayo.
        self.loop_btn = QPushButton("BUCLE")
        self.loop_btn.setCheckable(True)
        self.loop_btn.clicked.connect(self._on_loop)
        self.loop_btn.hide()
        # Compatibilidad: el estado de red ahora va en la barra de estado.
        self.net_label = QLabel("")
        self.net_label.hide()

    # ------------------------------------------------------------------ display
    def _update_time_display(self):
        minutes = int(self._seconds) // 60
        seconds = int(self._seconds) % 60
        millis = int((self._seconds % 1) * 1000)
        self.time_display.setText(f"{minutes:02d}:{seconds:02d}.{millis:03d}")

    def _show_status(self, text: str, kind: str):
        self.status_label.setText(text)
        ui.set_prop(self.status_label, "tag", kind)

    def _on_play(self):
        # The click toggled the checkable button; the real state comes back
        # through set_transport_status(), so restore what the leader says now.
        self.play_btn.setChecked(self._status == "PLAYING")
        if self._status == "PLAYING":
            self.pause_clicked.emit()
        else:
            self.play_clicked.emit()

    def _on_stop(self):
        self.stop_clicked.emit()

    def set_transport_status(self, status: str):
        """Reflejar el estado del lider (IDLE / PLAYING / PAUSED / COUNTING)."""
        self._status = status
        self._is_playing = status == "PLAYING"
        self.play_btn.setChecked(self._is_playing)
        tips = {"PLAYING": "Pausar (Espacio)", "PAUSED": "Continuar en el siguiente compás (Espacio)"}
        self.play_btn.setToolTip(tips.get(status, "Reproducir (Espacio)"))
        if not self._is_recording:
            self._show_status(*_STATUS.get(status, _STATUS["IDLE"]))
        if status == "IDLE":
            self.bar_display.setText("---:--")

    def _on_rec(self):
        self.set_recording_state(self.rec_btn.isChecked())
        self.rec_clicked.emit()

    def set_recording_state(self, recording: bool):
        """Reflejar el estado de grabación sin emitir señales."""
        self._is_recording = recording
        self.rec_btn.setChecked(recording)
        if recording:
            self._show_status("GRABANDO", "danger")
        else:
            self.set_transport_status(self._status)

    def _on_loop(self):
        self._is_looping = self.loop_btn.isChecked()
        self.loop_clicked.emit(self._is_looping)

    def _on_tap_tempo(self):
        now = time.time()
        self._tap_times.append(now)
        self._tap_times = [t for t in self._tap_times if now - t < 2.0]
        if len(self._tap_times) >= 2:
            intervals = [self._tap_times[i] - self._tap_times[i - 1] for i in range(1, len(self._tap_times))]
            avg_interval = sum(intervals) / len(intervals)
            if avg_interval > 0:
                self.set_bpm(max(40, min(300, int(60.0 / avg_interval))))
        self.tap_btn.setDown(True)
        QTimer.singleShot(150, lambda: self.tap_btn.setDown(False))

    def set_bpm(self, bpm: int):
        """BPM pedido por el usuario (TAP): se emite para que el lider lo aplique."""
        self._bpm = max(40, min(260, int(bpm)))
        self.bpm_display.setText(str(self._bpm))
        self.bpm_changed.emit(self._bpm)

    def display_bpm(self, bpm: float):
        """Mostrar el BPM del SessionState sin emitir senales."""
        self._bpm = bpm
        text = str(int(bpm)) if float(bpm).is_integer() else f"{bpm:.1f}"
        self.bpm_display.setText(text)

    def set_time(self, seconds: float):
        self._seconds = seconds
        self._update_time_display()

    def set_bar(self, bar, beat=None):
        """Compás y pulso actuales (None: transporte detenido)."""
        if bar is None:
            self.bar_display.setText("---:--")
        else:
            self.bar_display.setText(f"{int(bar):03d}:{int(beat or 1)}")

    def set_beat(self, beat: int):
        """Pulso actual (1-4). Solo repule los dos indicadores que cambian."""
        prev = self._lit_beat
        if prev == beat:
            return
        if prev is not None and 0 < prev <= len(self.beat_indicators):
            ui.set_prop(self.beat_indicators[prev - 1], "state", "")
        if 0 < beat <= len(self.beat_indicators):
            ui.set_prop(self.beat_indicators[beat - 1], "state", "one" if beat == 1 else "on")
        self._lit_beat = beat

    def clear_beat(self):
        for led in self.beat_indicators:
            ui.set_prop(led, "state", "")
        self._lit_beat = None

    def set_network_status(self, ok: bool, message: str = ""):
        """El estado de red se muestra en la barra de estado; se guarda por compatibilidad."""
        self.net_label.setText(message or ("Sync OK" if ok else "Sin conexión"))
