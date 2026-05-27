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
