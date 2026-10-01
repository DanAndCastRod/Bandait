"""Leader time base.

CONTRACT_V3 section 2: every ``*_ns`` field is the leader's high-resolution
monotonic clock, ``time.perf_counter_ns()``, as an integer (QueryPerformanceCounter
on Windows, CLOCK_MONOTONIC on Linux). ``time.monotonic_ns`` must not be used:
on Windows with Python < 3.13 it is GetTickCount64 with 15.625 ms resolution.

``leader_now_ns()`` is the ONLY function the leader uses to read its clock
(protocol timestamps, anchors, command receipt times, dedupe windows, beacons,
UI beat display). The audio callback maps PortAudio stream time to this same
clock (``AudioEngine``). Tests inject time through the objects that take a
clock (``ConcurrentControlManager(clock)``, ``BandaitServer(clock_service)``)
instead of patching this module.
"""

from __future__ import annotations

import time

CLOCK_NAME = "perf_counter"


def leader_now_ns() -> int:
    """Current leader time in integer nanoseconds."""
    return time.perf_counter_ns()


def leader_clock_resolution_ns() -> int:
    """Resolution advertised by the OS for the leader clock."""
    try:
        res = time.get_clock_info(CLOCK_NAME).resolution
    except Exception:
        res = 1e-9
    return max(1, int(round(res * 1e9)))


def measured_resolution_ns(samples: int = 5000) -> int:
    """Smallest positive step observed between consecutive reads."""
    best = None
    prev = leader_now_ns()
    for _ in range(samples):
        cur = leader_now_ns()
        step = cur - prev
        if step > 0 and (best is None or step < best):
            best = step
        prev = cur
    return best if best is not None else 0
