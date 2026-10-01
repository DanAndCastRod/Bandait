"""Leader clock: time.perf_counter_ns() with sub-millisecond resolution
(CONTRACT_V3 section 2), and no time.monotonic in leader code."""

import re
import time
from pathlib import Path

from src.sync.leader_clock import (
    CLOCK_NAME,
    leader_clock_resolution_ns,
    leader_now_ns,
    measured_resolution_ns,
)

SRC = Path(__file__).resolve().parents[1] / "src"


def test_leader_clock_is_perf_counter():
    assert CLOCK_NAME == "perf_counter"
    before = time.perf_counter_ns()
    now = leader_now_ns()
    after = time.perf_counter_ns()
    assert before <= now <= after


def test_effective_resolution_is_under_one_millisecond():
    assert leader_clock_resolution_ns() < 1_000_000
    step = measured_resolution_ns()
    assert 0 < step < 1_000_000, f"smallest observed step: {step} ns"


def test_consecutive_reads_are_monotonic_and_distinct():
    values = [leader_now_ns() for _ in range(2000)]
    assert all(b >= a for a, b in zip(values, values[1:]))
    assert len(set(values)) > 100  # a 15.6 ms clock would give 1-2 distinct values here


def test_no_monotonic_clock_in_leader_code():
    pattern = re.compile(r"\bmonotonic(_ns)?\s*\(")
    offenders = []
    for path in SRC.rglob("*.py"):
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if pattern.search(line):
                offenders.append(f"{path.relative_to(SRC)}:{lineno}: {line.strip()}")
    assert offenders == []
