"""CONTRACT_V3 section 6 beat math."""

from src.sync.transport_math import (
    START_LEAD_NS,
    Segment,
    add_segment,
    clamp_bpm,
    next_click,
    next_downbeat,
    position_at,
)

A = 1_000_000_000_000  # an anchor well above 2**31 ns


def test_beat_and_bar_formula():
    seg = Segment(A, 120, 4, 1)  # beat = 0.5 s
    assert seg.beat_ns == 500_000_000
    assert seg.bar_beat_at(A - 1) is None  # k < 0: nothing sounds before the anchor
    assert seg.bar_beat_at(A) == (1, 1)
    assert seg.bar_beat_at(A + 499_999_999) == (1, 1)
    assert seg.bar_beat_at(A + 500_000_000) == (1, 2)
    assert seg.bar_beat_at(A + 4 * 500_000_000) == (2, 1)
    seg9 = Segment(A, 120, 4, 9)
    assert seg9.bar_beat_at(A + 5 * 500_000_000) == (10, 2)


def test_click_k_lands_at_anchor_plus_k_beats():
    seg = Segment(A, 140, 4, 1)
    beat = 60e9 / 140
    for k in (0, 1, 7, 1000):
        assert seg.click_time(k) == A + int(round(k * beat))
    when, beat_no, down = next_click((seg,), A + 1)
    assert when == seg.click_time(1) and beat_no == 2 and not down
    when, beat_no, down = next_click((seg,), seg.click_time(4))
    assert when == seg.click_time(4) and beat_no == 1 and down


def test_old_segment_runs_until_new_anchor_rule2():
    old = Segment(A, 120, 4, 1)
    new_anchor = A + 4 * 500_000_000  # bar boundary of the old segment
    new = Segment(new_anchor, 121, 4, 2)
    sched = (old, new)
    # Before the new anchor the old tempo rules.
    assert position_at(sched, new_anchor - 1) == (1, 4)
    assert position_at(sched, new_anchor) == (2, 1)
    # Exactly one click at the boundary (no double click).
    when, _beat, down = next_click(sched, old.click_time(3) + 1)
    assert when == new_anchor and down
    when2, _b, _d = next_click(sched, new_anchor + 1)
    assert when2 == new.click_time(1)


def test_next_downbeat_and_bar_boundary():
    seg = Segment(A, 120, 4, 3)
    assert next_downbeat((seg,), A - 5) == (A, 3)
    assert next_downbeat((seg,), A + 1) == (A + 2_000_000_000, 4)
    n, when = seg.next_bar_boundary(A + 2_000_000_000)
    assert (n, when) == (1, A + 2_000_000_000)
    n, when = seg.next_bar_boundary(A + 2_000_000_001)
    assert (n, when) == (2, A + 4_000_000_000)


def test_add_segment_drops_superseded_and_past():
    s1 = Segment(A, 120, 4, 1)
    s2 = Segment(A + 2_000_000_000, 121, 4, 2)
    s3 = Segment(A + 2_000_000_000, 122, 4, 2)  # replaces pending s2
    sched = add_segment((s1,), s2, now_ns=A + 100)
    assert sched == (s1, s2)
    sched = add_segment(sched, s3, now_ns=A + 200)
    assert sched == (s1, s3)
    s4 = Segment(A + 10_000_000_000, 123, 4, 6)
    sched = add_segment(sched, s4, now_ns=A + 5_000_000_000)
    assert sched == (s3, s4)  # s1 is fully in the past


def test_clamp_and_lead():
    assert START_LEAD_NS == 250_000_000
    assert clamp_bpm(500) == 260
    assert clamp_bpm(1) == 40
    assert clamp_bpm(121) == 121
