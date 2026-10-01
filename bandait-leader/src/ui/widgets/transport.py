"""
Bandait DAW — Barra de Transporte Profesional
Controles de reproducción con display de tiempo, BPM, y estado.
"""

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QPushButton, QLabel,
    QFrame, QSizePolicy
)
from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QFont


class TransportWidget(QWidget):
    """Barra de transporte profesional tipo DAW.

    El widget solo expresa intenciones (play, pausa, stop, tempo). El estado que
    muestra lo fija la ventana principal desde el SessionState del lider, de modo
    que los botones nunca muestran un estado que el transporte no tiene.
    """

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

        self._setup_ui()

    def _setup_ui(self):
        layout = QHBoxLayout(self)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 12, 16, 12)

        # === TIEMPO ===
        time_frame = QFrame()
        time_frame.setObjectName("panel")
        time_layout = QVBoxLayout(time_frame)
        time_layout.setSpacing(2)
        time_layout.setContentsMargins(12, 8, 12, 8)

        time_label = QLabel("TIEMPO")
        time_label.setFont(QFont("Inter", 8))
        time_label.setStyleSheet("color: #666666;")
        time_layout.addWidget(time_label)

        self.time_display = QLabel("00:00.000")
        self.time_display.setObjectName("timeDisplay")
        self.time_display.setFont(QFont("JetBrains Mono", 28, QFont.Bold))
        self.time_display.setStyleSheet("""
            color: #CCFF00;
            background-color: #0A0A0A;
            border: 1px solid #1E1E1E;
            border-radius: 4px;
            padding: 8px 16px;
        """)
        self.time_display.setAlignment(Qt.AlignCenter)
        time_layout.addWidget(self.time_display)

        layout.addWidget(time_frame)

        # === CONTROLES PRINCIPALES ===
        controls_frame = QFrame()
        controls_frame.setObjectName("panel")
        controls_layout = QHBoxLayout(controls_frame)
        controls_layout.setSpacing(8)
        controls_layout.setContentsMargins(12, 8, 12, 8)

        # Botón Detener
        self.stop_btn = QPushButton("■")
        self.stop_btn.setObjectName("transport")
        self.stop_btn.setProperty("id", "stop")
        self.stop_btn.setToolTip("Detener (Espacio)")
        self.stop_btn.setStyleSheet("""
            QPushButton {
                min-width: 56px; min-height: 56px;
                border-radius: 8px;
                font-size: 20px; font-weight: bold;
                border: 2px solid #FF0000;
                color: #FF0000;
                background: transparent;
            }
            QPushButton:hover {
                background: #FF0000;
                color: #000000;
            }
        """)
        self.stop_btn.clicked.connect(self._on_stop)
        controls_layout.addWidget(self.stop_btn)

        # Botón Reproducir
        self.play_btn = QPushButton("▶")
        self.play_btn.setObjectName("transport")
        self.play_btn.setProperty("id", "play")
        self.play_btn.setToolTip("Reproducir (Espacio)")
        self.play_btn.setCheckable(True)
        self.play_btn.setStyleSheet("""
            QPushButton {
                min-width: 72px; min-height: 72px;
                border-radius: 8px;
                font-size: 28px; font-weight: bold;
                border: 2px solid #CCFF00;
                color: #CCFF00;
                background: transparent;
            }
            QPushButton:hover {
                background: #CCFF00;
                color: #000000;
            }
            QPushButton:checked {
                background: #CCFF00;
                color: #000000;
            }
        """)
        self.play_btn.clicked.connect(self._on_play)
        controls_layout.addWidget(self.play_btn)

        # Botón Grabar
        self.rec_btn = QPushButton("●")
        self.rec_btn.setObjectName("transport")
        self.rec_btn.setProperty("id", "rec")
        self.rec_btn.setToolTip("Grabar (R)")
        self.rec_btn.setCheckable(True)
        self.rec_btn.setStyleSheet("""
            QPushButton {
                min-width: 56px; min-height: 56px;
                border-radius: 50%;
                font-size: 20px; font-weight: bold;
                border: 2px solid #FF0000;
                color: #FF0000;
                background: transparent;
            }
            QPushButton:hover {
                background: #FF0000;
                color: #000000;
            }
            QPushButton:checked {
                background: #FF0000;
                color: #000000;
            }
        """)
        self.rec_btn.clicked.connect(self._on_rec)
        controls_layout.addWidget(self.rec_btn)

        layout.addWidget(controls_frame)

        # === BPM Y METRÓNOMO ===
        bpm_frame = QFrame()
        bpm_frame.setObjectName("panel")
        bpm_layout = QVBoxLayout(bpm_frame)
        bpm_layout.setSpacing(4)
        bpm_layout.setContentsMargins(12, 8, 12, 8)

        bpm_header = QHBoxLayout()
        bpm_label = QLabel("BPM")
        bpm_label.setFont(QFont("Inter", 8))
        bpm_label.setStyleSheet("color: #666666;")
        bpm_header.addWidget(bpm_label)

        self.tap_btn = QPushButton("TAP")
        self.tap_btn.setFont(QFont("Inter", 8, QFont.Bold))
        self.tap_btn.setStyleSheet("""
            QPushButton {
                min-width: 40px; min-height: 20px;
                font-size: 10px;
                border: 1px solid #666666;
                color: #666666;
                border-radius: 2px;
                padding: 2px 6px;
            }
            QPushButton:hover {
                border-color: #00FFFF;
                color: #00FFFF;
            }
        """)
        self.tap_btn.clicked.connect(self._on_tap_tempo)
        bpm_header.addWidget(self.tap_btn)

        nudge_style = """
            QPushButton {
                min-width: 28px; min-height: 20px;
                font-size: 10px;
                border: 1px solid #666666;
                color: #666666;
                border-radius: 2px;
                padding: 2px 4px;
            }
            QPushButton:hover {
                border-color: #00FFFF;
                color: #00FFFF;
            }
        """
        self.nudge_down_btn = QPushButton("-1")
        self.nudge_down_btn.setToolTip("Bajar 1 BPM en el siguiente compas")
        self.nudge_down_btn.setStyleSheet(nudge_style)
        self.nudge_down_btn.clicked.connect(lambda: self.tempo_nudge_clicked.emit(-1))
        bpm_header.addWidget(self.nudge_down_btn)
        self.nudge_up_btn = QPushButton("+1")
        self.nudge_up_btn.setToolTip("Subir 1 BPM en el siguiente compas")
        self.nudge_up_btn.setStyleSheet(nudge_style)
        self.nudge_up_btn.clicked.connect(lambda: self.tempo_nudge_clicked.emit(1))
        bpm_header.addWidget(self.nudge_up_btn)
        bpm_layout.addLayout(bpm_header)

        self.bpm_display = QLabel("120")
        self.bpm_display.setFont(QFont("JetBrains Mono", 32, QFont.Bold))
        self.bpm_display.setStyleSheet("""
            color: #00FFFF;
            background-color: #0A0A0A;
            border: 1px solid #1E1E1E;
            border-radius: 4px;
            padding: 4px 12px;
        """)
        self.bpm_display.setAlignment(Qt.AlignCenter)
        bpm_layout.addWidget(self.bpm_display)

        # Indicador de beat
        beat_layout = QHBoxLayout()
        beat_layout.setSpacing(4)
        self.beat_indicators = []
        for i in range(4):
            led = QLabel("●")
            led.setFont(QFont("JetBrains Mono", 14))
            led.setStyleSheet("color: #333333;")
            led.setAlignment(Qt.AlignCenter)
            self.beat_indicators.append(led)
            beat_layout.addWidget(led)
        bpm_layout.addLayout(beat_layout)

        layout.addWidget(bpm_frame)

        # === ESTADO Y OPCIONES ===
        status_frame = QFrame()
        status_frame.setObjectName("panel")
        status_layout = QVBoxLayout(status_frame)
        status_layout.setSpacing(4)
        status_layout.setContentsMargins(12, 8, 12, 8)

        # Loop
        self.loop_btn = QPushButton("BUCLE")
        self.loop_btn.setCheckable(True)
        # Sin implementacion de bucle en el transporte v3: deshabilitado y visible.
        self.loop_btn.setEnabled(False)
        self.loop_btn.setToolTip("Bucle: no disponible en esta version")
        self.loop_btn.setFont(QFont("Inter", 9, QFont.Bold))
        self.loop_btn.setStyleSheet("""
            QPushButton {
                min-height: 28px;
                border: 1px solid #666666;
                color: #666666;
                border-radius: 4px;
                padding: 4px 12px;
            }
            QPushButton:checked {
                border-color: #00FFFF;
                color: #00FFFF;
                background: rgba(0, 255, 255, 20);
            }
            QPushButton:hover {
                border-color: #00FFFF;
            }
        """)
        self.loop_btn.clicked.connect(self._on_loop)
        status_layout.addWidget(self.loop_btn)

        # Estado
        self.status_label = QLabel("Listo")
        self.status_label.setFont(QFont("Inter", 10))
        self.status_label.setStyleSheet("color: #666666;")
        self.status_label.setAlignment(Qt.AlignCenter)
        status_layout.addWidget(self.status_label)

        # Indicador de red
        net_layout = QHBoxLayout()
        self.net_led = QLabel("●")
        self.net_led.setFont(QFont("JetBrains Mono", 10))
        self.net_led.setStyleSheet("color: #CCFF00;")
        net_layout.addWidget(self.net_led)

        self.net_label = QLabel("Sync OK")
        self.net_label.setFont(QFont("Inter", 9))
        self.net_label.setStyleSheet("color: #666666;")
        net_layout.addWidget(self.net_label)
        net_layout.addStretch()
        status_layout.addLayout(net_layout)

        layout.addWidget(status_frame)
        layout.addStretch()

    def _update_time_display(self):
        minutes = int(self._seconds) // 60
        seconds = int(self._seconds) % 60
        millis = int((self._seconds % 1) * 1000)
        self.time_display.setText(f"{minutes:02d}:{seconds:02d}.{millis:03d}")

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
        if status == "PLAYING":
            self.play_btn.setToolTip("Pausar (Espacio)")
            if not self._is_recording:
                self.status_label.setText("Reproduciendo")
                self.status_label.setStyleSheet("color: #CCFF00;")
        elif status == "PAUSED":
            self.play_btn.setToolTip("Continuar en el siguiente compas (Espacio)")
            if not self._is_recording:
                self.status_label.setText("Pausado")
                self.status_label.setStyleSheet("color: #FFAA00;")
        else:
            self.play_btn.setToolTip("Reproducir (Espacio)")
            if not self._is_recording:
                self.status_label.setText("Detenido")
                self.status_label.setStyleSheet("color: #666666;")

    def _on_rec(self):
        self.set_recording_state(self.rec_btn.isChecked())
        self.rec_clicked.emit()

    def set_recording_state(self, recording: bool):
        """Reflejar el estado de grabación sin emitir señales."""
        self._is_recording = recording
        self.rec_btn.setChecked(recording)
        if recording:
            self.status_label.setText("GRABANDO")
            self.status_label.setStyleSheet("color: #FF0000; font-weight: bold;")
        else:
            self.set_transport_status(self._status)

    def _on_loop(self):
        self._is_looping = self.loop_btn.isChecked()
        self.loop_clicked.emit(self._is_looping)

    def _on_tap_tempo(self):
        import time
        now = time.time()
        self._tap_times.append(now)
        # Mantener solo últimos 4 taps
        self._tap_times = [t for t in self._tap_times if now - t < 2.0]

        if len(self._tap_times) >= 2:
            intervals = [self._tap_times[i] - self._tap_times[i-1]
                        for i in range(1, len(self._tap_times))]
            avg_interval = sum(intervals) / len(intervals)
            if avg_interval > 0:
                bpm = int(60.0 / avg_interval)
                self.set_bpm(max(40, min(300, bpm)))

        self.tap_btn.setStyleSheet("""
            QPushButton {
                min-width: 40px; min-height: 20px;
                font-size: 10px;
                border: 1px solid #00FFFF;
                color: #00FFFF;
                border-radius: 2px;
                padding: 2px 6px;
            }
        """)
        QTimer.singleShot(200, lambda: self.tap_btn.setStyleSheet("""
            QPushButton {
                min-width: 40px; min-height: 20px;
                font-size: 10px;
                border: 1px solid #666666;
                color: #666666;
                border-radius: 2px;
                padding: 2px 6px;
            }
            QPushButton:hover {
                border-color: #00FFFF;
                color: #00FFFF;
            }
        """))

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

    def set_beat(self, beat: int):
        """Actualizar indicador de beat (1-4). Solo toca los dos LEDs que cambian."""
        prev = getattr(self, "_lit_beat", None)
        if prev == beat:
            return
        if prev is not None and 0 < prev <= len(self.beat_indicators):
            self.beat_indicators[prev - 1].setStyleSheet("color: #333333;")
        if 0 < beat <= len(self.beat_indicators):
            self.beat_indicators[beat - 1].setStyleSheet("color: #CCFF00;")
        self._lit_beat = beat

    def clear_beat(self):
        for led in self.beat_indicators:
            led.setStyleSheet("color: #333333;")
        self._lit_beat = None

    def set_network_status(self, ok: bool, message: str = ""):
        if ok:
            self.net_led.setStyleSheet("color: #CCFF00;")
            self.net_label.setText(message or "Sync OK")
            self.net_label.setStyleSheet("color: #666666;")
        else:
            self.net_led.setStyleSheet("color: #FF0000;")
            self.net_label.setText(message or "Sin conexión")
            self.net_label.setStyleSheet("color: #FF0000;")
