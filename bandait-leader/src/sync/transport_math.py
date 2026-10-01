"""Beat math shared by the transport manager, the clock service, the beacon and
the audio callback (CONTRACT_V3 section 6). Pure functions, no Qt, no I/O.

    beat_ns = 60e9 / bpm
    k       = floor((t_ns - anchor_ns) / beat_ns), k >= 0
    beat    = (k mod beats_per_bar) + 1
    bar     = bar_offset + floor(k / beats_per_bar)
    click k at anchor_ns + k * beat_ns

A ``Schedule`` is a tuple of ``Segment`` sorted by anchor. Segment i is valid in
``[anchor_i, anchor_{i+1})``: a new anchor never rewrites the past (rule 2), the
previous segment keeps clicking until the new anchor.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Tuple

START_LEAD_NS = 250_000_000  # rule 1: START_LEAD_MS = 250
MIN_BPM = 40
MAX_BPM = 260


def beat_ns(bpm: float) -> float:
    return 60e9 / float(bpm)


@dataclass(frozen=True)
class Segment:
    anchor_ns: int
    bpm: float
    beats_per_bar: int
    bar_offset: int

    @property
    def beat_ns(self) -> float:
        return 60e9 / float(self.bpm)

    @property
    def bar_ns(self) -> float:
        return self.beat_ns * self.beats_per_bar

    def click_time(self, k: int) -> int:
        return self.anchor_ns + int(round(k * self.beat_ns))

    def beat_index_at(self, t_ns: int) -> int:
        """k for time t (may be negative before the anchor)."""
        return math.floor((t_ns - self.anchor_ns) / self.beat_ns)

    def bar_beat_at(self, t_ns: int) -> Optional[Tuple[int, int]]:
        k = self.beat_index_at(t_ns)
        if k < 0:
            return None
        return (self.bar_offset + k // self.beats_per_bar, (k % self.beats_per_bar) + 1)

    def first_click_at_or_after(self, t_ns: int) -> int:
        """Smallest k >= 0 whose click time is >= t_ns."""
        if t_ns <= self.anchor_ns:
            return 0
        k = math.ceil((t_ns - self.anchor_ns) / self.beat_ns)
        # Guard against float rounding at the boundary.
        while k > 0 and self.click_time(k - 1) >= t_ns:
            k -= 1
        while self.click_time(k) < t_ns:
            k += 1
        return k

    def next_bar_boundary(self, min_t_ns: int) -> Tuple[int, int]:
        """Smallest n >= 0 with bar boundary anchor + n*bar >= min_t. Returns (n, time)."""
        if min_t_ns <= self.anchor_ns:
            return 0, self.anchor_ns
        bar = self.bar_ns
        n = math.ceil((min_t_ns - self.anchor_ns) / bar)
        while n > 0 and self.anchor_ns + int(round((n - 1) * bar)) >= min_t_ns:
            n -= 1
        while self.anchor_ns + int(round(n * bar)) < min_t_ns:
            n += 1
        return n, self.anchor_ns + int(round(n * bar))


Schedule = Tuple[Segment, ...]
EMPTY_SCHEDULE: Schedule = ()


def active_index(schedule: Schedule, t_ns: int) -> int:
    """Index of the segment in force at t, or -1 if t is before the first anchor."""
    idx = -1
    for i, seg in enumerate(schedule):
        if seg.anchor_ns <= t_ns:
            idx = i
        else:
            break
    return idx


def position_at(schedule: Schedule, t_ns: int) -> Optional[Tuple[int, int]]:
    """(bar, beat) at time t, or None if nothing is sounding yet."""
    idx = active_index(schedule, t_ns)
    if idx < 0:
        return None
    return schedule[idx].bar_beat_at(t_ns)


def current_bar(schedule: Schedule, t_ns: int) -> Optional[int]:
    pos = position_at(schedule, t_ns)
    return None if pos is None else pos[0]


def next_click(schedule: Schedule, t_ns: int) -> Optional[Tuple[int, int, bool]]:
    """First click at or after t across segments: (time_ns, beat, is_downbeat)."""
    n = len(schedule)
    for i in range(n):
        seg = schedule[i]
        seg_end = schedule[i + 1].anchor_ns if i + 1 < n else None
        if seg_end is not None and seg_end <= t_ns:
            continue
        start = t_ns if t_ns > seg.anchor_ns else seg.anchor_ns
        k = seg.first_click_at_or_after(start)
        when = seg.click_time(k)
        if seg_end is not None and when >= seg_end:
            continue
        beat = (k % seg.beats_per_bar) + 1
        return when, beat, beat == 1
    return None


def next_downbeat(schedule: Schedule, t_ns: int) -> Optional[Tuple[int, int]]:
    """First downbeat at or after t: (time_ns, bar_number)."""
    n = len(schedule)
    for i in range(n):
        seg = schedule[i]
        seg_end = schedule[i + 1].anchor_ns if i + 1 < n else None
        if seg_end is not None and seg_end <= t_ns:
            continue
        start = t_ns if t_ns > seg.anchor_ns else seg.anchor_ns
        bars, when = seg.next_bar_boundary(start)
        if seg_end is not None and when >= seg_end:
            continue
        return when, seg.bar_offset + bars
    return None


def add_segment(schedule: Schedule, seg: Segment, now_ns: int) -> Schedule:
    """Append a segment: drop segments it supersedes and those fully in the past."""
    kept = [s for s in schedule if s.anchor_ns < seg.anchor_ns]
    idx = active_index(tuple(kept), now_ns)
    if idx > 0:
        kept = kept[idx:]
    kept.append(seg)
    return tuple(kept)


def clamp_bpm(bpm: float) -> int:
    return int(max(MIN_BPM, min(MAX_BPM, int(round(bpm)))))
