"""Process-wide real-time policy for the leader's audio callback.

The PortAudio callback is Python: before each block it must take the GIL from
whichever thread holds it (Qt UI, uvicorn/Socket.IO, recorder). Two process
settings decide how long that can take, plus the garbage collector.

GIL hand-off (measured 2026-10-01, Windows 11, 16 threads, Python 3.11.0,
PortAudio default output, 256 frames at 48 kHz = 5.33 ms per block, a pure
Python CPU-bound thread standing in for Qt/uvicorn bursts, 5 s per run;
delay = perf_counter() at callback entry - PortAudio timeInfo.currentTime):

    timer 15.6 ms (default), switchinterval 5 ms: p50 15.9-16.9 ms, 69-72 xruns
    timer 15.6 ms (default), switchinterval 1 ms: p50 13.8-15.6 ms, 48-54 xruns
    timer 1 ms,              switchinterval 5 ms: p50  5.2-5.4 ms,   3-9 xruns
    timer 1 ms,              switchinterval 1 ms: p50  1.1-1.6 ms,     0 xruns
    (no competing thread: p50 0.13-0.19 ms in every configuration)

On Windows the GIL wait is a timed wait on the system timer, so
``sys.setswitchinterval`` alone does nothing until the process asks for a
1 ms timer (``timeBeginPeriod(1)``). Both are applied. Windows 11 ignores
that request for a minimized or hidden window unless the process opts out of
power throttling, so that is requested too (the FOH window is often hidden
behind the mixer software). The cost is a little more CPU wake-up: fine on a
plugged-in FOH laptop. Measured throughput of the competing thread did not
drop (92-182k ops/s across runs, within noise).

Garbage collector policy (conservative, documented):

- The collector stays ENABLED with the default thresholds. uvicorn, Socket.IO
  and Qt wrappers create reference cycles; disabling GC would grow memory for
  the whole gig, and higher thresholds mean fewer but longer pauses.
- ``gc.collect()`` once after the imports and before the audio stream opens
  (that pause cannot hit a running stream), then ``gc.freeze()`` once the
  window is up: everything alive at startup moves to the permanent generation,
  so later full collections only walk objects created during the show. The
  freeze is O(1) and never collects. See ``freeze_startup_heap``.
- The audio callback itself is GC-neutral: it allocates no container objects
  that outlive the block (tests/test_audio_realtime.py checks it), so it does
  not push the collector towards a collection.
"""

from __future__ import annotations

import atexit
import gc
import logging
import sys
import time
from typing import Optional

logger = logging.getLogger(__name__)

SWITCH_INTERVAL_S = 0.001
TIMER_RESOLUTION_MS = 1

_timer_period_set = False


def _windows_timer_resolution() -> Optional[str]:
    """timeBeginPeriod(1), undone at exit. Returns an error text or None."""
    global _timer_period_set
    if _timer_period_set:
        return None
    try:
        import ctypes

        winmm = ctypes.WinDLL("winmm")
        rc = winmm.timeBeginPeriod(TIMER_RESOLUTION_MS)
        if rc != 0:  # TIMERR_NOCANDO
            return f"timeBeginPeriod devolvio {rc}"
        _timer_period_set = True
        atexit.register(winmm.timeEndPeriod, TIMER_RESOLUTION_MS)
        return None
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def _windows_disable_power_throttling() -> Optional[str]:
    """Keep the timer request and full CPU speed when the window is hidden
    (Windows 10 1709+ / 11). Returns an error text or None."""
    try:
        import ctypes
        from ctypes import wintypes

        class _State(ctypes.Structure):
            _fields_ = [
                ("Version", wintypes.ULONG),
                ("ControlMask", wintypes.ULONG),
                ("StateMask", wintypes.ULONG),
            ]

        process_power_throttling = 4  # PROCESS_INFORMATION_CLASS.ProcessPowerThrottling
        execution_speed = 0x1  # PROCESS_POWER_THROTTLING_EXECUTION_SPEED
        ignore_timer_resolution = 0x4  # PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
        state = _State(1, execution_speed | ignore_timer_resolution, 0)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetProcessInformation.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        kernel32.SetProcessInformation.restype = wintypes.BOOL
        ok = kernel32.SetProcessInformation(
            kernel32.GetCurrentProcess(), process_power_throttling,
            ctypes.byref(state), ctypes.sizeof(state),
        )
        if not ok:
            # Older Windows 10 builds do not know the timer-resolution flag.
            state.ControlMask = execution_speed
            ok = kernel32.SetProcessInformation(
                kernel32.GetCurrentProcess(), process_power_throttling,
                ctypes.byref(state), ctypes.sizeof(state),
            )
            if not ok:
                return f"SetProcessInformation fallo (error {ctypes.get_last_error()})"
            return "solo EXECUTION_SPEED (Windows sin IGNORE_TIMER_RESOLUTION)"
        return None
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}"


def apply_realtime_policy() -> dict:
    """Call once at startup, before the audio stream opens. Never raises."""
    report = {"switch_interval_s": None, "timer_resolution_ms": None, "power_throttling": None}
    try:
        sys.setswitchinterval(SWITCH_INTERVAL_S)
        report["switch_interval_s"] = sys.getswitchinterval()
    except Exception as exc:
        report["switch_interval_error"] = str(exc)
    if sys.platform == "win32":
        err = _windows_timer_resolution()
        report["timer_resolution_ms"] = TIMER_RESOLUTION_MS if err is None else None
        if err:
            report["timer_resolution_error"] = err
        note = _windows_disable_power_throttling()
        report["power_throttling"] = "desactivado" if note is None else note
    logger.info("Politica de tiempo real: %s", report)
    return report


def freeze_startup_heap(collect: bool) -> dict:
    """``collect=True``: full collection, then freeze (call before the audio
    stream opens). ``collect=False``: freeze only, O(1), safe while audio runs.
    Never raises."""
    report = {"collect_ms": None, "frozen_objects": None}
    try:
        if collect:
            t0 = time.perf_counter()
            gc.collect()
            report["collect_ms"] = round((time.perf_counter() - t0) * 1000.0, 2)
        gc.freeze()
        report["frozen_objects"] = gc.get_freeze_count()
    except Exception as exc:
        report["error"] = str(exc)
    return report


def measure_full_collection_ms(repeat: int = 3) -> float:
    """Best-of-N duration of ``gc.collect()`` in ms (diagnostics only: it is a
    full collection, never call it while the audio stream is running)."""
    best = None
    for _ in range(max(1, repeat)):
        t0 = time.perf_counter()
        gc.collect()
        dt = (time.perf_counter() - t0) * 1000.0
        best = dt if best is None or dt < best else best
    return round(best, 3)
