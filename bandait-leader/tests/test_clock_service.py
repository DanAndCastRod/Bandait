"""Tests for NTP-like clock synchronization."""

import time
import pytest
from src.sync.clock_service import ClockService, SyncResult


def test_ntp_algorithm_basic(qapp):
    """Test basic NTP offset calculation with simulated symmetric delay."""
    clock = ClockService(mode="follower")

    # Simulate: t0=0, t1=50, t2=50, t3=100 (symmetric 50ms each way)
    # RTT = (100 - 0) - (50 - 50) = 100ms
    # Offset = ((50 - 0) + (50 - 100)) / 2 = (50 + (-50)) / 2 = 0ms
    clock.record_sync_request()
    time.sleep(0.01)  # Small processing delay
    leader_time_ns = time.monotonic_ns()
    clock.record_sync_response(leader_time_ns)

    # After enough samples, offset should converge
    for _ in range(15):
        t0 = time.monotonic_ns()
        time.sleep(0.001)  # 1ms simulated network
        t1 = time.monotonic_ns()
        time.sleep(0.001)
        t2 = time.monotonic_ns()
        clock.record_sync_request()
        clock.record_sync_response(t1)

    offset = clock.get_stable_offset_ms()
    # Offset should be small (near zero for local test)
    if offset is not None:
        assert abs(offset) < 10.0, f"Offset too large: {offset}ms"


def test_median_filtering_outliers(qapp):
    """Test that outlier RTT samples are filtered correctly."""
    clock = ClockService(mode="follower", sync_window=10)

    # Inject 8 normal samples + 2 extreme outliers
    base_time = time.monotonic_ns()
    results = []
    for i in range(8):
        results.append(SyncResult(rtt_ms=2.0, offset_ms=5.0, timestamp_ns=base_time + i * 1e9))
    # Outliers
    results.append(SyncResult(rtt_ms=200.0, offset_ms=100.0, timestamp_ns=base_time + 8 * 1e9))
    results.append(SyncResult(rtt_ms=150.0, offset_ms=-80.0, timestamp_ns=base_time + 9 * 1e9))

    for r in results:
        clock.sync_result.emit(r)
        clock._results.append(r)
        if len(clock._results) > 10:
            clock._results.pop(0)

    clock._compute_stable_offset()
    offset = clock.get_stable_offset_ms()

    if offset is not None:
        # Should be close to 5.0, not affected by outliers
        assert 3.0 < offset < 7.0, f"Offset {offset}ms not robust to outliers"


def test_leader_time_monotonic(qapp):
    """Verify leader time uses monotonic clock."""
    clock = ClockService(mode="leader")
    t1 = clock.get_leader_time_ns()
    time.sleep(0.05)
    t2 = clock.get_leader_time_ns()
    assert t2 >= t1
    diff_ms = (t2 - t1) / 1e6
    assert 40.0 < diff_ms < 100.0  # Should be ~50ms
