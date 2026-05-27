"""Main Qt window for the Bandait Leader."""

from PySide6.QtWidgets import (
    QMainWindow,
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QPushButton,
    QLabel,
    QStackedWidget,
)
from PySide6.QtCore import Qt, QTimer

from sync.clock_service import ClockService
from network.bandait_server import BandaitServer
from domain.models import SessionState, SessionStatus


class MainWindow(QMainWindow):
    def __init__(self, clock: ClockService, server: BandaitServer):
        super().__init__()
        self.setWindowTitle("Bandait Leader")
        self.setMinimumSize(1200, 800)

        self._clock = clock
        self._server = server
        self._bpm = 120
        self._status = SessionStatus.IDLE

        self._build_ui()
        self._setup_timers()

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(16)

        # Header
        header = QHBoxLayout()
        self._status_label = QLabel("IDLE")
        self._status_label.setObjectName("statusLabel")
        self._bpm_label = QLabel("120 BPM")
        self._bpm_label.setObjectName("bpmDisplay")
        header.addWidget(self._status_label)
        header.addStretch()
        header.addWidget(self._bpm_label)
        layout.addLayout(header)

        # Transport controls
        transport = QHBoxLayout()
        self._btn_play = QPushButton("▶ PLAY")
        self._btn_play.setObjectName("actionPad")
        self._btn_play.clicked.connect(self._on_play)

        self._btn_stop = QPushButton("■ STOP")
        self._btn_stop.setObjectName("actionPadDanger")
        self._btn_stop.clicked.connect(self._on_stop)

        self._btn_record = QPushButton("● REC")
        self._btn_record.setObjectName("actionPadRecord")
        self._btn_record.clicked.connect(self._on_record)

        transport.addWidget(self._btn_play)
        transport.addWidget(self._btn_stop)
        transport.addWidget(self._btn_record)
        layout.addLayout(transport)

        # Main view stack (placeholder for future views)
        self._stack = QStackedWidget()
        self._placeholder = QLabel("Stage / Library / Mixer views will load here.")
        self._placeholder.setAlignment(Qt.AlignCenter)
        self._stack.addWidget(self._placeholder)
        layout.addWidget(self._stack)

        # Footer info
        self._info_label = QLabel("Waiting for followers...")
        self._info_label.setObjectName("infoLabel")
        layout.addWidget(self._info_label)

    def _setup_timers(self) -> None:
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._timer.start(100)  # 10 Hz UI refresh

    def _tick(self) -> None:
        now = self._clock.monotonic_ns()
        self._info_label.setText(f"Leader time: {now // 1_000_000} ms")

    def _on_play(self) -> None:
        self._status = SessionStatus.PLAYING
        self._status_label.setText("PLAYING")
        state = SessionState(
            session_id="default",
            leader_ip="0.0.0.0",
            status=self._status,
            current_song_id=None,
            next_event_timestamp=self._clock.monotonic_ns() + 1_000_000_000,
            bpm=self._bpm,
            beat=1,
        )
        # Fire-and-forget broadcast via asyncio
        import asyncio
        asyncio.create_task(self._server.broadcast_state(state))

    def _on_stop(self) -> None:
        self._status = SessionStatus.IDLE
        self._status_label.setText("IDLE")

    def _on_record(self) -> None:
        self._status_label.setText("RECORDING")
