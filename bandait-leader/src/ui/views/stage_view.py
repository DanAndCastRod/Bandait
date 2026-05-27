"""
Bandait DAW — Vista de Escenario (Modo Evento en Vivo)
Pantalla fullscreen minimalista para performance en vivo.
Flash de bordes para metrónomo, letras grandes, beacon de red.
"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame, QSizePolicy
)
from PySide6.QtCore import Qt, QTimer, Signal, QPropertyAnimation, QEasingCurve
from PySide6.QtGui import QFont, QKeyEvent, QColor


class StageView(QWidget):
    """Vista de escenario para eventos en vivo. Pantalla completa, minimalista."""

    panic_clicked = Signal()
    next_song_clicked = Signal()
    prev_song_clicked = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._bpm = 120
        self._beat = 1
        self._song_title = "Sin canción"
        self._section = "Intro"
        self._next_section = "Verso"
        self._is_fullscreen = False
        self._network_ok = True
        self._beat_flash = False
        self._lyrics = []
        self._current_lyric_idx = 0

        self._setup_ui()
        self._setup_animations()
        self._setup_timer()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(0)
        layout.setContentsMargins(0, 0, 0, 0)

        # === BEACON DE RED (barra superior) ===
        self.beacon = QFrame()
        self.beacon.setFixedHeight(6)
        self.beacon.setStyleSheet("background-color: #CCFF00;")
        layout.addWidget(self.beacon)

        # === HEADER: Título y controles ===
        header = QHBoxLayout()
        header.setContentsMargins(24, 16, 24, 16)

        # Botón anterior
        self.prev_btn = QPushButton("◀ Anterior")
        self.prev_btn.setFont(QFont("Inter", 12, QFont.Bold))
        self.prev_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: 2px solid #666666;
                color: #666666;
                border-radius: 8px;
                padding: 12px 24px;
                font-size: 14px;
            }
            QPushButton:hover {
                border-color: #00FFFF;
                color: #00FFFF;
            }
        """)
        self.prev_btn.clicked.connect(self.prev_song_clicked.emit)
        header.addWidget(self.prev_btn)

        header.addStretch()

        # Info de canción
        info_layout = QVBoxLayout()
        self.song_title = QLabel(self._song_title)
        self.song_title.setFont(QFont("Inter", 18, QFont.Bold))
        self.song_title.setStyleSheet("color: #F0F0F0;")
        self.song_title.setAlignment(Qt.AlignCenter)
        info_layout.addWidget(self.song_title)

        self.section_label = QLabel(self._section)
        self.section_label.setFont(QFont("Inter", 14))
        self.section_label.setStyleSheet("color: #00FFFF;")
        self.section_label.setAlignment(Qt.AlignCenter)
        info_layout.addWidget(self.section_label)

        header.addLayout(info_layout)
        header.addStretch()

        # Botón siguiente
        self.next_btn = QPushButton("Siguiente ▶")
        self.next_btn.setFont(QFont("Inter", 12, QFont.Bold))
        self.next_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: 2px solid #666666;
                color: #666666;
                border-radius: 8px;
                padding: 12px 24px;
                font-size: 14px;
            }
            QPushButton:hover {
                border-color: #00FFFF;
                color: #00FFFF;
            }
        """)
        self.next_btn.clicked.connect(self.next_song_clicked.emit)
        header.addWidget(self.next_btn)

        layout.addLayout(header)

        # === ÁREA PRINCIPAL: Letra y metrónomo ===
        main_area = QHBoxLayout()
        main_area.setContentsMargins(40, 20, 40, 20)

        # Letra actual (izquierda, grande)
        lyrics_layout = QVBoxLayout()
        lyrics_layout.setAlignment(Qt.AlignCenter)

        current_label = QLabel("LETRA ACTUAL")
        current_label.setFont(QFont("Inter", 10))
        current_label.setStyleSheet("color: #666666;")
        current_label.setAlignment(Qt.AlignCenter)
        lyrics_layout.addWidget(current_label)

        self.current_lyric = QLabel("Esperando canción...")
        self.current_lyric.setFont(QFont("Inter", 36, QFont.Bold))
        self.current_lyric.setStyleSheet("color: #F0F0F0;")
        self.current_lyric.setAlignment(Qt.AlignCenter)
        self.current_lyric.setWordWrap(True)
        lyrics_layout.addWidget(self.current_lyric)

        # Próxima línea
        self.next_lyric = QLabel("")
        self.next_lyric.setFont(QFont("Inter", 20))
        self.next_lyric.setStyleSheet("color: #666666;")
        self.next_lyric.setAlignment(Qt.AlignCenter)
        self.next_lyric.setWordWrap(True)
        lyrics_layout.addWidget(self.next_lyric)

        main_area.addLayout(lyrics_layout, 3)

        # Separador
        sep = QFrame()
        sep.setStyleSheet("background: #1E1E1E; max-width: 2px; min-width: 2px;")
        main_area.addWidget(sep)

        # Panel derecho: BPM, beat, controles
        right_panel = QVBoxLayout()
        right_panel.setAlignment(Qt.AlignCenter)
        right_panel.setSpacing(20)

        # BPM grande
        bpm_label = QLabel("BPM")
        bpm_label.setFont(QFont("Inter", 12))
        bpm_label.setStyleSheet("color: #666666;")
        bpm_label.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(bpm_label)

        self.bpm_display = QLabel("120")
        self.bpm_display.setFont(QFont("JetBrains Mono", 72, QFont.Bold))
        self.bpm_display.setStyleSheet("color: #00FFFF;")
        self.bpm_display.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(self.bpm_display)

        # Indicadores de beat
        beat_layout = QHBoxLayout()
        beat_layout.setSpacing(16)
        self.beat_indicators = []
        for i in range(4):
            led = QLabel("●")
            led.setFont(QFont("JetBrains Mono", 32))
            led.setStyleSheet("color: #333333;")
            led.setAlignment(Qt.AlignCenter)
            self.beat_indicators.append(led)
            beat_layout.addWidget(led)
        right_panel.addLayout(beat_layout)

        # Próxima sección
        next_sec_label = QLabel("PRÓXIMA")
        next_sec_label.setFont(QFont("Inter", 10))
        next_sec_label.setStyleSheet("color: #666666;")
        next_sec_label.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(next_sec_label)

        self.next_section_label = QLabel(self._next_section)
        self.next_section_label.setFont(QFont("Inter", 16, QFont.Bold))
        self.next_section_label.setStyleSheet("color: #CCFF00;")
        self.next_section_label.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(self.next_section_label)

        right_panel.addStretch()
        main_area.addLayout(right_panel, 1)

        layout.addLayout(main_area, 1)

        # === CONTROLES INFERIORES ===
        bottom = QHBoxLayout()
        bottom.setContentsMargins(24, 16, 24, 16)

        # Botón pantalla completa
        self.fullscreen_btn = QPushButton("⛶ Pantalla Completa")
        self.fullscreen_btn.setFont(QFont("Inter", 11))
        self.fullscreen_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: 1px solid #666666;
                color: #666666;
                border-radius: 4px;
                padding: 8px 16px;
            }
            QPushButton:hover {
                border-color: #00FFFF;
                color: #00FFFF;
            }
        """)
        self.fullscreen_btn.clicked.connect(self._toggle_fullscreen)
        bottom.addWidget(self.fullscreen_btn)

        bottom.addStretch()

        # Botón pánico (slide to stop)
        self.panic_btn = QPushButton("DETENER SESIÓN")
        self.panic_btn.setFont(QFont("Inter", 14, QFont.Bold))
        self.panic_btn.setStyleSheet("""
            QPushButton {
                background: #FF0000;
                border: none;
                color: #000000;
                border-radius: 8px;
                padding: 16px 32px;
                font-size: 16px;
            }
            QPushButton:hover {
                background: #FF3333;
            }
            QPushButton:pressed {
                background: #CC0000;
            }
        """)
        self.panic_btn.clicked.connect(self.panic_clicked.emit)
        bottom.addWidget(self.panic_btn)

        layout.addLayout(bottom)

    def _setup_animations(self):
        """Configurar animaciones de flash para metrónomo."""
        self._flash_anim = QPropertyAnimation(self, b"styleSheet")
        self._flash_anim.setDuration(100)
        self._flash_anim.setEasingCurve(QEasingCurve.OutQuad)

    def _setup_timer(self):
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._flash_beat)
        self._timer.start(500)  # Flash cada medio segundo para test

    def _flash_beat(self):
        self._beat_flash = not self._beat_flash
        self.update()

    def set_song(self, title: str, current_lyric: str = "", next_lyric: str = "",
                 section: str = "", next_section: str = ""):
        self._song_title = title
        self.song_title.setText(title)
        self.current_lyric.setText(current_lyric or "Esperando canción...")
        self.next_lyric.setText(next_lyric)
        self.section_label.setText(section)
        self._section = section
        self._next_section = next_section
        self.next_section_label.setText(next_section)

    def set_bpm(self, bpm: int):
        self._bpm = bpm
        self.bpm_display.setText(str(bpm))

    def set_beat(self, beat: int):
        """Actualizar indicador de beat (1-4)."""
        self._beat = beat
        for i, led in enumerate(self.beat_indicators):
            if i == beat - 1:
                led.setStyleSheet("color: #CCFF00; font-weight: bold;")
            else:
                led.setStyleSheet("color: #333333;")

    def set_network_status(self, ok: bool):
        self._network_ok = ok
        if ok:
            self.beacon.setStyleSheet("background-color: #CCFF00;")
        else:
            self.beacon.setStyleSheet("background-color: #FF0000;")

    def _toggle_fullscreen(self):
        if self._is_fullscreen:
            self.showNormal()
            self._is_fullscreen = False
            self.fullscreen_btn.setText("⛶ Pantalla Completa")
        else:
            self.showFullScreen()
            self._is_fullscreen = True
            self.fullscreen_btn.setText("⛶ Salir Pantalla Completa")

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_Escape and self._is_fullscreen:
            self._toggle_fullscreen()
        super().keyPressEvent(event)
