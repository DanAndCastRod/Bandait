"""ClockService: NTP-style math and the Qt-side transport mirror."""

import time

from src.sync.clock_service import ClockService, SyncResult
from src.sync.leader_clock import leader_now_ns
from src.sync.transport_math import Segment


def _state(version, status="PLAYING", anchor=None, bpm=120, bar_offset=1, paused_bar=None):
    return {
        "protocol_version": 3,
        "session_id": "default",
        "status": status,
        "state_version": version,
        "current_song_id": "s1",
        "current_order_index": 0,
        "bpm": bpm,
        "beats_per_bar": 4,
        "anchor_ns": anchor,
        "bar_offset": bar_offset,
        "paused_bar": paused_bar,
        "leader_time_ns": leader_now_ns(),
        "setlist": [],
        "last_command": None,
    }


def test_ntp_algorithm_basic(qapp):
    """Basic NTP offset calculation with simulated symmetric delay."""
    clock = ClockService(mode="follower")
    for _ in range(15):
        clock.record_sync_request()
        time.sleep(0.001)
        clock.record_sync_response(leader_now_ns())
    offset = clock.get_stable_offset_ms()
    assert offset is not None
    assert abs(offset) < 2.0, f"Offset too large: {offset}ms"


def test_median_filtering_outliers(qapp):
    clock = ClockService(mode="follower", sync_window=10)
    base_time = leader_now_ns()
    results = [SyncResult(rtt_ms=2.0, offset_ms=5.0, timestamp_ns=base_time + i) for i in range(8)]
    results.append(SyncResult(rtt_ms=200.0, offset_ms=100.0, timestamp_ns=base_time + 8))
    results.append(SyncResult(rtt_ms=150.0, offset_ms=-80.0, timestamp_ns=base_time + 9))
    for r in results:
        clock._results.append(r)
    clock._compute_stable_offset()
    offset = clock.get_stable_offset_ms()
    assert offset is not None and 3.0 < offset < 7.0


def test_leader_time_monotonic(qapp):
    clock = ClockService(mode="leader")
    t1 = clock.get_leader_time_ns()
    time.sleep(0.05)
    t2 = clock.get_leader_time_ns()
    assert t2 >= t1
    assert 45.0 < (t2 - t1) / 1e6 < 200.0


def test_ns_signals_do_not_overflow(qapp):
    """Regression: Signal(int) is 32-bit in C++; ns timestamps overflow after 2.1 s."""
    clock = ClockService()
    got = {}
    clock.transport_state_changed.connect(lambda s, b, a: got.setdefault("transport", (s, b, a)))
    clock.phase_reset.connect(lambda bar, a: got.setdefault("phase", (bar, a)))
    clock.schedule_changed.connect(lambda sched: got.setdefault("schedule", sched))
    clock.session_state_changed.connect(lambda st: got.setdefault("state", st))
    anchor = leader_now_ns() + 250_000_000
    assert anchor > 2**31
    sched = (Segment(anchor, 120, 4, 1),)
    assert clock.apply_session_state(_state(5, anchor=anchor), sched)
    assert got["transport"] == ("PLAYING", 1, anchor)
    assert got["phase"] == (1, anchor)
    assert got["schedule"] == sched
    assert got["state"]["anchor_ns"] == anchor


def test_stale_versions_are_ignored(qapp):
    clock = ClockService()
    anchor = leader_now_ns()
    assert clock.apply_session_state(_state(7, anchor=anchor), (Segment(anchor, 120, 4, 1),))
    assert not clock.apply_session_state(_state(6, status="IDLE"))
    assert clock.status == "PLAYING" and clock.state_version == 7
    assert clock.apply_session_state(_state(8, status="PAUSED", paused_bar=4))
    assert clock.status == "PAUSED" and clock.schedule == () and clock.paused_bar == 4


def test_calculate_beat_at_time_phase_locked(qapp):
    clock = ClockService()
    anchor = leader_now_ns() + 250_000_000
    beat = 500_000_000
    clock.apply_session_state(_state(1, anchor=anchor, bar_offset=5), (Segment(anchor, 120, 4, 5),))
    assert clock.calculate_beat_at_time(anchor - 1) is None
    assert clock.calculate_beat_at_time(anchor) == (5, 1)
    assert clock.calculate_beat_at_time(anchor + beat + 1000) == (5, 2)
    assert clock.calculate_beat_at_time(anchor + 4 * beat + 1000) == (6, 1)
    assert abs(clock.position_seconds(anchor + beat) - (4 * 4 * 0.5 + 0.5)) < 1e-6


def test_beat_updated_emitted_once_per_beat(qapp):
    clock = ClockService()
    anchor = leader_now_ns() - 10  # already sounding
    beats = []
    clock.beat_updated.connect(lambda bar, beat, bpm: beats.append((bar, beat)))
    clock.apply_session_state(_state(1, anchor=anchor), (Segment(anchor, 120, 4, 1),))
    clock._tick()
    clock._tick()
    assert beats == [(1, 1)]


def test_new_leader_instance_resets_version_tracking(qapp):
    clock = ClockService()
    first = dict(_state(40, status="IDLE"), leader_instance_id="11111111-1111-4111-8111-111111111111")
    assert clock.apply_session_state(first)
    restarted = dict(_state(1, status="IDLE"), leader_instance_id="22222222-2222-4222-8222-222222222222")
    assert clock.apply_session_state(restarted)  # version 1 accepted: the leader restarted
    assert clock.state_version == 1
    assert not clock.apply_session_state(dict(restarted))  # same instance, same version: stale
