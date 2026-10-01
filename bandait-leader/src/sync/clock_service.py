"""Leader clock service: time base, NTP-style follower math and the Qt-side
mirror of the transport.

Transport flow (one path for every origin):

    ConcurrentControlManager.process_command  (any thread, under its lock)
      -> BandaitServer publishes StateUpdate  (queued Qt signal)
      -> ClockService.apply_update            (Qt main thread)
      -> AudioEngine.set_schedule             (Qt main thread, lock-free swap)

ClockService never decides transport semantics; it applies what the manager
published and derives the bar/beat display from the same anchor the followers
use. Every Signal argument that can carry nanoseconds is declared ``object``:
a C++ ``int`` is 32 bits and overflows after 2.1 s.
"""

import statistics
from dataclasses import dataclass
from typing import Optional

from PySide6.QtCore import QObject, QTimer, Signal

from src.sync.leader_clock import leader_now_ns
from src.sync.transport_math import EMPTY_SCHEDULE, Schedule, position_at


@dataclass(frozen=True)
class SyncResult:
    """Result of a single NTP-style sync exchange."""

    rtt_ms: float
    offset_ms: float
    timestamp_ns: int


class _ClockWorker(QObject):
    """NTP-style sample bookkeeping (follower mode)."""

    synced = Signal(object)  # SyncResult

    def __init__(self) -> None:
        super().__init__()
        self._request_time_ns: Optional[int] = None

    def record_request(self, request_time_ns: int) -> None:
        self._request_time_ns = request_time_ns

    def record_response(self, response_time_ns: int, leader_time_ns: int) -> None:
        if self._request_time_ns is None:
            return
        t0 = self._request_time_ns
        t1 = leader_time_ns
        t2 = response_time_ns
        t3 = leader_now_ns()

        rtt_ns = (t3 - t0) - (t2 - t1)
        offset_ns = ((t1 - t0) + (t2 - t3)) // 2

        result = SyncResult(rtt_ms=rtt_ns / 1e6, offset_ms=offset_ns / 1e6, timestamp_ns=t3)
        self.synced.emit(result)
        self._request_time_ns = None


class ClockService(QObject):
    """Leader time base plus the Qt-side transport mirror."""

    # Emitted every ~1 s while started (heartbeat for UI health indicators).
    beacon = Signal()
    # Emitted when a sync exchange completes (follower mode).
    sync_result = Signal(object)  # SyncResult
    # Emitted when a stable offset is computed.
    offset_stable = Signal(float)  # offset_ms

    # Transport signals (Qt main thread only). ns values are Python ints: object.
    beat_updated = Signal(int, int, float)  # bar, beat (1..beats_per_bar), bpm
    transport_state_changed = Signal(str, int, object)  # status, beat, anchor_ns | None
    phase_reset = Signal(int, object)  # bar_offset, anchor_ns
    schedule_changed = Signal(object)  # Schedule (tuple of Segment)
    session_state_changed = Signal(object)  # wire SessionState dict

    UI_TICK_MS = 15

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
        self._worker: Optional[_ClockWorker] = _ClockWorker()
        self._worker.synced.connect(self._on_synced)

        # Transport mirror (written only on the Qt main thread).
        self._status = "IDLE"
        self._bpm: float = 120
        self._beats_per_bar = 4
        self._anchor_ns: Optional[int] = None
        self._bar_offset = 1
        self._paused_bar: Optional[int] = None
        self._state_version = 0
        self._leader_instance_id: Optional[str] = None
        self._schedule: Schedule = EMPTY_SCHEDULE
        self._wire_state: Optional[dict] = None
        self._last_position: Optional[tuple[int, int]] = None

        self._beacon_timer: Optional[QTimer] = None
        self._ui_timer: Optional[QTimer] = None

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        """Start the heartbeat and the beat display ticker. Idempotent."""
        if self._beacon_timer is None:
            self._beacon_timer = QTimer(self)
            self._beacon_timer.timeout.connect(self.beacon.emit)
        if self._ui_timer is None:
            self._ui_timer = QTimer(self)
            self._ui_timer.setTimerType(self._precise_timer_type())
            self._ui_timer.timeout.connect(self._tick)
        self._beacon_timer.start(1000)
        self._ui_timer.start(self.UI_TICK_MS)

    def stop(self) -> None:
        for timer in (self._beacon_timer, self._ui_timer):
            if timer is not None:
                timer.stop()

    def is_running(self) -> bool:
        return self._ui_timer is not None and self._ui_timer.isActive()

    @staticmethod
    def _precise_timer_type():
        from PySide6.QtCore import Qt

        return Qt.PreciseTimer

    # ------------------------------------------------------------------ time base
    def get_leader_time_ns(self) -> int:
        """Current leader time in nanoseconds. Thread-safe (no state)."""
        return leader_now_ns()

    def get_leader_time_ms(self) -> float:
        return leader_now_ns() / 1e6

    # ------------------------------------------------------------------ follower NTP math
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

    def convert_to_local(self, leader_time_ms: float) -> float:
        if self._stable_offset_ms is None:
            return leader_time_ms
        return leader_time_ms - self._stable_offset_ms

    def convert_to_leader(self, local_time_ms: float) -> float:
        if self._stable_offset_ms is None:
            return local_time_ms
        return local_time_ms + self._stable_offset_ms

    def get_stable_offset_ms(self) -> Optional[float]:
        return self._stable_offset_ms

    def record_sync_request(self) -> int:
        t0 = leader_now_ns()
        if self._worker:
            self._worker.record_request(t0)
        return t0

    def record_sync_response(self, leader_time_ns: int) -> None:
        t2 = leader_now_ns()
        if self._worker:
            self._worker.record_response(t2, leader_time_ns)

    # ------------------------------------------------------------------ transport mirror
    def apply_update(self, update) -> bool:
        """Apply a manager ``StateUpdate`` (Qt main thread). Stale versions are ignored."""
        return self.apply_session_state(update.wire_state, update.schedule)

    def apply_session_state(self, wire_state: dict, schedule: Optional[Schedule] = None) -> bool:
        try:
            version = int(wire_state.get("state_version", 0))
        except (TypeError, ValueError, AttributeError):
            return False
        instance = wire_state.get("leader_instance_id")
        if instance != self._leader_instance_id:
            # A different leader process: its state_version restarted at 1.
            self._leader_instance_id = instance
            self._state_version = 0
        if version <= self._state_version:
            return False
        prev_status = self._status
        prev_anchor = self._anchor_ns
        self._state_version = version
        self._wire_state = wire_state
        self._status = str(wire_state.get("status", "IDLE"))
        self._bpm = wire_state.get("bpm", self._bpm) or self._bpm
        self._beats_per_bar = int(wire_state.get("beats_per_bar", 4) or 4)
        self._anchor_ns = wire_state.get("anchor_ns")
        self._bar_offset = int(wire_state.get("bar_offset", 1) or 1)
        self._paused_bar = wire_state.get("paused_bar")
        new_schedule = tuple(schedule) if schedule is not None else EMPTY_SCHEDULE
        if self._status != "PLAYING":
            new_schedule = EMPTY_SCHEDULE
        if new_schedule != self._schedule:
            self._schedule = new_schedule
            self.schedule_changed.emit(new_schedule)
        if self._anchor_ns is not None and self._anchor_ns != prev_anchor:
            self.phase_reset.emit(self._bar_offset, self._anchor_ns)
        if self._status != prev_status or self._anchor_ns != prev_anchor:
            beat = 1
            self.transport_state_changed.emit(self._status, beat, self._anchor_ns)
        if self._status != "PLAYING":
            self._last_position = None
        self.session_state_changed.emit(wire_state)
        self._tick()
        return True

    def _tick(self) -> None:
        if not self._schedule:
            return
        pos = position_at(self._schedule, leader_now_ns())
        if pos is None or pos == self._last_position:
            return
        self._last_position = pos
        self.beat_updated.emit(pos[0], pos[1], float(self._bpm))

    def calculate_beat_at_time(self, time_ns: Optional[int] = None) -> Optional[tuple[int, int]]:
        """(bar, beat) at leader time t from the applied schedule, None if silent."""
        if time_ns is None:
            time_ns = leader_now_ns()
        return position_at(self._schedule, time_ns)

    def position_seconds(self, time_ns: Optional[int] = None) -> float:
        """Approximate song position for display (bars before the anchor + elapsed)."""
        if self._status == "PAUSED" and self._paused_bar is not None:
            return max(0, self._paused_bar) * self._beats_per_bar * 60.0 / float(self._bpm)
        if self._status != "PLAYING" or not self._schedule:
            return 0.0
        if time_ns is None:
            time_ns = leader_now_ns()
        seg = self._schedule[-1]
        for candidate in self._schedule:
            if candidate.anchor_ns <= time_ns:
                seg = candidate
        before = (seg.bar_offset - 1) * seg.beats_per_bar * 60.0 / float(seg.bpm)
        return max(0.0, before + (time_ns - seg.anchor_ns) / 1e9)

    @property
    def status(self) -> str:
        return self._status

    @property
    def bpm(self) -> float:
        return self._bpm

    @property
    def beats_per_bar(self) -> int:
        return self._beats_per_bar

    @property
    def anchor_ns(self) -> Optional[int]:
        return self._anchor_ns

    @property
    def bar_offset(self) -> int:
        return self._bar_offset

    @property
    def paused_bar(self) -> Optional[int]:
        return self._paused_bar

    @property
    def state_version(self) -> int:
        return self._state_version

    @property
    def schedule(self) -> Schedule:
        return self._schedule

    @property
    def session_state(self) -> Optional[dict]:
        return self._wire_state

    @property
    def current_beat(self) -> int:
        return self._last_position[1] if self._last_position else 1

    @property
    def current_bar(self) -> int:
        if self._last_position:
            return self._last_position[0]
        return self._paused_bar if self._paused_bar is not None else self._bar_offset
