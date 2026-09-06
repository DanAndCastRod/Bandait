"""High-precision clock synchronization service using NTP-like algorithm."""

import time
import statistics
from dataclasses import dataclass
from typing import Callable, Optional
from PySide6.QtCore import QObject, Signal, QThread


@dataclass(frozen=True)
class SyncResult:
    """Result of a single NTP-style sync exchange."""

    rtt_ms: float
    offset_ms: float
    timestamp_ns: int


class _ClockWorker(QObject):
    """Worker that runs sync logic in a dedicated thread."""

    beacon = Signal()
    synced = Signal(SyncResult)

    def __init__(self, interval_ms: int = 1000) -> None:
        super().__init__()
        self._interval_ms = interval_ms
        self._running = False
        self._request_time_ns: Optional[int] = None
        self._pending_callback: Optional[Callable[[], int]] = None

    def start(self) -> None:
        self._running = True
        while self._running:
            self.beacon.emit()
            time.sleep(self._interval_ms / 1000.0)

    def stop(self) -> None:
        self._running = False

    def record_request(self, request_time_ns: int) -> None:
        self._request_time_ns = request_time_ns

    def record_response(self, response_time_ns: int, leader_time_ns: int) -> None:
        if self._request_time_ns is None:
            return
        t0 = self._request_time_ns
        t1 = leader_time_ns
        t2 = response_time_ns
        t3 = time.monotonic_ns()

        rtt_ns = (t3 - t0) - (t2 - t1)
        offset_ns = ((t1 - t0) + (t2 - t3)) // 2

        result = SyncResult(
            rtt_ms=rtt_ns / 1e6,
            offset_ms=offset_ns / 1e6,
            timestamp_ns=t3,
        )
        self.synced.emit(result)
        self._request_time_ns = None


class ClockService(QObject):
    """Provides NTP-style clock synchronization for followers."""

    # Emitted every ~1s when acting as server (leader)
    beacon = Signal()

    # Emitted when a sync exchange completes (follower mode)
    sync_result = Signal(SyncResult)

    # Emitted when a stable offset is computed
    offset_stable = Signal(float)  # offset_ms

    # Transport phase signals
    beat_updated = Signal(int, int, float)  # bar, beat (1-4), bpm
    transport_state_changed = Signal(str, int, int)  # status, beat, timestamp_ns
    phase_reset = Signal(int, int)  # beat=1, timestamp_ns

    def __init__(
        self,
        mode: str = "leader",  # "leader" or "follower"
        sync_window: int = 10,
        outlier_threshold: float = 2.0,
        parent: Optional[QObject] = None,
    ) -> None:
        super().__init__(parent)
        self._mode = mode
        self._sync_window = sync_window
        self._outlier_threshold = outlier_threshold
        self._results: list[SyncResult] = []
        self._stable_offset_ms: Optional[float] = None
        self._worker: Optional[_ClockWorker] = None
        self._thread: Optional[QThread] = None

        # Transport clock phase management
        self._status = "IDLE"
        self._bpm = 120
        self._beats_per_bar = 4
        self._current_beat = 1
        self._current_bar = 1
        self._phase_start_ns: Optional[int] = None
        self._next_event_timestamp_ns: int = 0

    def start(self) -> None:
        self._worker = _ClockWorker()
        self._worker.beacon.connect(self._on_beacon)
        self._worker.synced.connect(self._on_synced)
        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        self._thread.started.connect(self._worker.start)
        self._thread.start()

    def stop(self) -> None:
        if self._worker:
            self._worker.stop()
        if self._thread:
            self._thread.quit()
            self._thread.wait(5000)

    def _on_beacon(self) -> None:
        self.beacon.emit()

    def _on_synced(self, result: SyncResult) -> None:
        self.sync_result.emit(result)
        self._results.append(result)
        if len(self._results) > self._sync_window:
            self._results.pop(0)
        self._compute_stable_offset()

    def _compute_stable_offset(self) -> None:
        if len(self._results) < 3:
            return
        offsets = [r.offset_ms for r in self._results]
        median = statistics.median(offsets)
        mad = statistics.median([abs(o - median) for o in offsets])
        threshold = max(mad * self._outlier_threshold, 1.0)
        filtered = [o for o in offsets if abs(o - median) <= threshold]
        if not filtered:
            return
        stable = statistics.mean(filtered)
        if self._stable_offset_ms is None or abs(stable - self._stable_offset_ms) > 0.5:
            self._stable_offset_ms = stable
            self.offset_stable.emit(stable)

    def get_leader_time_ns(self) -> int:
        """Return current leader time in nanoseconds (monotonic)."""
        return time.monotonic_ns()

    def get_leader_time_ms(self) -> float:
        """Return current leader time in milliseconds."""
        return time.monotonic_ns() / 1e6

    def convert_to_local(self, leader_time_ms: float) -> float:
        """Convert a leader timestamp to local time using stable offset."""
        if self._stable_offset_ms is None:
            return leader_time_ms
        return leader_time_ms - self._stable_offset_ms

    def convert_to_leader(self, local_time_ms: float) -> float:
        """Convert a local timestamp to leader time using stable offset."""
        if self._stable_offset_ms is None:
            return local_time_ms
        return local_time_ms + self._stable_offset_ms

    def get_stable_offset_ms(self) -> Optional[float]:
        return self._stable_offset_ms

    def record_sync_request(self) -> int:
        """Record local time before sending sync request. Returns request time."""
        t0 = time.monotonic_ns()
        if self._worker:
            self._worker.record_request(t0)
        return t0

    def record_sync_response(self, leader_time_ns: int) -> None:
        """Process sync response from leader."""
        t2 = time.monotonic_ns()
        if self._worker:
            self._worker.record_response(t2, leader_time_ns)

    @property
    def status(self) -> str:
        return self._status

    @property
    def current_beat(self) -> int:
        return self._current_beat

    @property
    def current_bar(self) -> int:
        return self._current_bar

    @property
    def bpm(self) -> int:
        return self._bpm

    @property
    def next_event_timestamp_ns(self) -> int:
        return self._next_event_timestamp_ns

    @property
    def phase_start_ns(self) -> Optional[int]:
        return self._phase_start_ns

    def start_playback(
        self,
        bpm: Optional[int] = None,
        lead_in_ms: float = 0.0,
        beats_per_bar: int = 4,
    ) -> dict:
        """Start playback, forcing beat = 1 and resetting clock phase."""
        if bpm is not None:
            self._bpm = max(20, min(500, int(bpm)))
        self._beats_per_bar = max(1, beats_per_bar)
        self._current_beat = 1
        self._current_bar = 1
        self._status = "PLAYING"

        now_ns = self.get_leader_time_ns()
        lead_in_ns = int(lead_in_ms * 1e6)
        self._phase_start_ns = now_ns + lead_in_ns
        self._next_event_timestamp_ns = self._phase_start_ns

        self.phase_reset.emit(1, self._phase_start_ns)
        self.beat_updated.emit(1, 1, float(self._bpm))
        self.transport_state_changed.emit("PLAYING", 1, self._phase_start_ns)

        return {
            "status": "PLAYING",
            "bpm": self._bpm,
            "beat": 1,
            "bar": 1,
            "next_event_timestamp": self._next_event_timestamp_ns,
        }

    def resume_playback(
        self,
        bpm: Optional[int] = None,
        lead_in_ms: float = 0.0,
    ) -> dict:
        """Resume playback, forcing beat = 1 and resetting clock phase."""
        if bpm is not None:
            self._bpm = max(20, min(500, int(bpm)))
        self._current_beat = 1
        self._status = "PLAYING"

        now_ns = self.get_leader_time_ns()
        lead_in_ns = int(lead_in_ms * 1e6)
        self._phase_start_ns = now_ns + lead_in_ns
        self._next_event_timestamp_ns = self._phase_start_ns

        self.phase_reset.emit(1, self._phase_start_ns)
        self.beat_updated.emit(self._current_bar, 1, float(self._bpm))
        self.transport_state_changed.emit("PLAYING", 1, self._phase_start_ns)

        return {
            "status": "PLAYING",
            "bpm": self._bpm,
            "beat": 1,
            "bar": self._current_bar,
            "next_event_timestamp": self._next_event_timestamp_ns,
        }

    def stop_playback(self) -> dict:
        """Stop playback and reset transport phase."""
        self._status = "IDLE"
        self._current_beat = 1
        self._current_bar = 1
        self._phase_start_ns = None
        self._next_event_timestamp_ns = 0

        self.transport_state_changed.emit("IDLE", 1, 0)

        return {
            "status": "IDLE",
            "bpm": self._bpm,
            "beat": 1,
            "bar": 1,
            "next_event_timestamp": 0,
        }

    def pause_playback(self) -> dict:
        """Pause playback preserving current position."""
        self._status = "PAUSED"
        now_ns = self.get_leader_time_ns()
        self.transport_state_changed.emit("PAUSED", self._current_beat, now_ns)

        return {
            "status": "PAUSED",
            "bpm": self._bpm,
            "beat": self._current_beat,
            "bar": self._current_bar,
            "next_event_timestamp": 0,
        }

    def handle_transport_command(
        self,
        command: str,
        bpm: Optional[int] = None,
        lead_in_ms: float = 0.0,
    ) -> dict:
        """Unified command handler enforcing clock phase reset on START and RESUME."""
        cmd = command.strip().upper()
        if cmd in ("START", "PLAY"):
            return self.start_playback(bpm=bpm, lead_in_ms=lead_in_ms)
        elif cmd == "RESUME":
            return self.resume_playback(bpm=bpm, lead_in_ms=lead_in_ms)
        elif cmd == "STOP":
            return self.stop_playback()
        elif cmd == "PAUSE":
            return self.pause_playback()
        else:
            raise ValueError(f"Unknown transport command: {command}")

    def calculate_beat_at_time(self, time_ns: Optional[int] = None) -> tuple[int, int, int]:
        """Calculate (bar, beat, next_event_timestamp_ns) from phase clock."""
        if self._phase_start_ns is None or self._status != "PLAYING":
            return (self._current_bar, self._current_beat, self._next_event_timestamp_ns)

        if time_ns is None:
            time_ns = self.get_leader_time_ns()

        elapsed_ns = time_ns - self._phase_start_ns
        if elapsed_ns < 0:
            return (1, 1, self._phase_start_ns)

        beat_duration_ns = int((60.0 / self._bpm) * 1e9)
        total_beats = elapsed_ns // beat_duration_ns
        current_beat = int((total_beats % self._beats_per_bar) + 1)
        current_bar = int((total_beats // self._beats_per_bar) + 1)
        next_event_ns = self._phase_start_ns + int((total_beats + 1) * beat_duration_ns)

        self._current_beat = current_beat
        self._current_bar = current_bar
        self._next_event_timestamp_ns = next_event_ns

        return (current_bar, current_beat, next_event_ns)
