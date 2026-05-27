"""Main Qt window for the Bandait Leader with transport controls."""

from PySide6.QtWidgets import (
    QMainWindow,
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QPushButton,
    QLabel,
    QStackedWidget,
    QTabWidget,
)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QKeySequence, QShortcut

from src.sync.clock_service import ClockService
from src.network.server import BandaitServer
from src.audio.audio_engine import AudioEngine
from src.domain.models import SessionState, SessionStatus, MessageType
from src.db.models import init_db
from src.ui.library_view import LibraryView
from src.ui.gig_manager_view import GigManagerView
from src.ui.rehearsal_view import RehearsalView
from src.ui.ai_panel import AIPanel


class MainWindow(QMainWindow):
    def __init__(
        self,
        clock: ClockService,
        server: BandaitServer,
        audio: AudioEngine,
    ):
        super().__init__()
        self.setWindowTitle("Bandait Leader")
        self.setMinimumSize(1200, 800)

        self._clock = clock
        self._server = server
        self._audio = audio
        self._bpm = 120
        self._status = SessionStatus.IDLE
        self._recording = False
        self._current_beat = 0

        # Initialize database
        self._db_session_factory = init_db("bandait.db")

        self._build_ui()
        self._setup_timers()
        self._setup_shortcuts()
        self._connect_audio_signals()

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
        self._beat_label = QLabel("Beat: -")
        self._beat_label.setObjectName("beatDisplay")
        header.addWidget(self._status_label)
        header.addStretch()
        header.addWidget(self._beat_label)
        header.addWidget(self._bpm_label)
        layout.addLayout(header)

        # Transport controls
        transport = QHBoxLayout()
        self._btn_play = QPushButton("▶ PLAY")
        self._btn_play.setObjectName("actionPad")
        self._btn_play.setMinimumSize(120, 56)
        self._btn_play.clicked.connect(self._on_play)

        self._btn_stop = QPushButton("■ STOP")
        self._btn_stop.setObjectName("actionPadDanger")
        self._btn_stop.setMinimumSize(120, 56)
        self._btn_stop.clicked.connect(self._on_stop)

        self._btn_record = QPushButton("● REC")
        self._btn_record.setObjectName("actionPadRecord")
        self._btn_record.setMinimumSize(120, 56)
        self._btn_record.setCheckable(True)
        self._btn_record.clicked.connect(self._on_record_toggle)

        transport.addWidget(self._btn_play)
        transport.addWidget(self._btn_stop)
        transport.addWidget(self._btn_record)
        layout.addLayout(transport)

        # Main tabbed views
        self._tabs = QTabWidget()
        self._tabs.setDocumentMode(True)

        # Stage view (placeholder for now — will be full screen later)
        self._stage_placeholder = QLabel("STAGE MODE\n\nFull-screen performance view.\nPress F11 to toggle.")
        self._stage_placeholder.setAlignment(Qt.AlignCenter)
        self._stage_placeholder.setObjectName("stagePlaceholder")
        self._tabs.addTab(self._stage_placeholder, "▶ Stage")

        # Library view
        self._library_view = LibraryView(self._db_session_factory)
        self._library_view.setlist_loaded.connect(self._on_setlist_loaded)
        self._tabs.addTab(self._library_view, "📚 Library")

        # Gig Manager view
        self._gig_view = GigManagerView(self._db_session_factory)
        self._gig_view.gig_selected.connect(self._on_gig_selected)
        self._tabs.addTab(self._gig_view, "🎤 Gigs")

        # Rehearsal view
        self._rehearsal_view = RehearsalView(self._db_session_factory)
        self._rehearsal_view.rehearsal_selected.connect(self._on_rehearsal_selected)
        self._tabs.addTab(self._rehearsal_view, "🎧 Rehearsals")

        # AI Assistant panel (side tab)
        self._ai_panel = AIPanel()
        self._tabs.addTab(self._ai_panel, "🤖 AI")

        layout.addWidget(self._tabs)

        # Footer info
        self._info_label = QLabel("Waiting for followers...")
        self._info_label.setObjectName("infoLabel")
        layout.addWidget(self._info_label)

    def _setup_timers(self) -> None:
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)
        self._timer.start(100)  # 10 Hz UI refresh

    def _setup_shortcuts(self) -> None:
        # Space: Play/Stop toggle
        self._shortcut_play = QShortcut(QKeySequence("Space"), self)
        self._shortcut_play.activated.connect(self._on_play)

        # R: Record toggle
        self._shortcut_record = QShortcut(QKeySequence("R"), self)
        self._shortcut_record.activated.connect(self._on_record_toggle)

        # Esc: Panic stop
        self._shortcut_stop = QShortcut(QKeySequence("Escape"), self)
        self._shortcut_stop.activated.connect(self._on_stop)

    def _connect_audio_signals(self) -> None:
        self._audio.beat.connect(self._on_beat, type=Qt.QueuedConnection)
        self._audio.started.connect(self._on_audio_started)
        self._audio.stopped.connect(self._on_audio_stopped)
        self._audio.recording_started.connect(self._on_recording_started)
        self._audio.recording_stopped.connect(self._on_recording_stopped)

    def _tick(self) -> None:
        now = self._clock.get_leader_time_ms()
        status_text = f"Leader: {now:.0f} ms"
        if self._audio.is_running():
            status_text += " | Audio: ON"
        if self._audio.is_recording():
            status_text += " | REC"
        self._info_label.setText(status_text)

    def _on_play(self) -> None:
        if not self._audio.is_running():
            self._audio.start()
        self._status = SessionStatus.PLAYING
        self._status_label.setText("PLAYING")
        self._broadcast_state()

    def _on_stop(self) -> None:
        self._audio.stop()
        self._status = SessionStatus.IDLE
        self._status_label.setText("IDLE")
        self._beat_label.setText("Beat: -")
        self._broadcast_state()

    def _on_record_toggle(self) -> None:
        if not self._audio.is_recording():
            folder = self._audio.start_recording("bandait_session")
            self._btn_record.setChecked(True)
            self._btn_record.setText("■ STOP REC")
        else:
            self._audio.stop_recording()
            self._btn_record.setChecked(False)
            self._btn_record.setText("● REC")

    def _on_beat(self, beat_number: int, bpm: float) -> None:
        self._current_beat = beat_number
        self._beat_label.setText(f"Beat: {beat_number}/4")
        self._bpm_label.setText(f"{bpm:.0f} BPM")

    def _on_audio_started(self) -> None:
        self._status_label.setText("AUDIO READY")

    def _on_audio_stopped(self) -> None:
        self._status_label.setText("IDLE")

    def _on_recording_started(self, folder: str) -> None:
        self._status_label.setText(f"RECORDING → {folder}")

    def _on_recording_stopped(self) -> None:
        self._status_label.setText("PLAYING")

    def _broadcast_state(self) -> None:
        """Broadcast current state to all followers."""
        import asyncio
        state = {
            "sessionId": "default",
            "leaderIp": self._server._host,
            "status": self._status.value,
            "currentSongId": None,
            "nextEventTimestamp": self._clock.get_leader_time_ns() + 1_000_000_000,
            "bpm": self._bpm,
        }
        # Fire-and-forget
        asyncio.create_task(
            self._server._sio.emit(
                "state_update",
                state,
                room="default",
            )
        )

    def _on_setlist_loaded(self, setlist) -> None:
        self._info_label.setText(f"Setlist loaded: {setlist.name} ({len(setlist.songs)} songs)")

    def _on_gig_selected(self, gig) -> None:
        self._info_label.setText(f"Gig selected: {gig.name} @ {gig.venue}")

    def _on_rehearsal_selected(self, rehearsal) -> None:
        self._info_label.setText(f"Rehearsal: {rehearsal.date.strftime('%Y-%m-%d')}")

    def closeEvent(self, event) -> None:
        self._audio.stop()
        event.accept()
