"""Rehearsal loop (leader-local API of ConcurrentControlManager), driven by a fake clock.

At 120 BPM in 4/4 a bar lasts exactly 2 s, so every boundary is an exact integer of ns.
"""

import numpy as np
import pytest

from src.domain.concurrent_control import LOOP_PUBLISH_BARS, ConcurrentControlManager, LoopInfo
from src.domain.models import SessionStatus, Song
from src.sync.transport_math import START_LEAD_NS, Segment, bar_start_time, position_at
from v3_shapes import load_fixtures, validate

T0 = 5_000_000_000_000
BAR_NS = 2_000_000_000
TICK_NS = 100_000_000  # the UI calls tick() every ~100 ms


class FakeClock:
    def __init__(self, now=T0):
        self.now = now

    def get_leader_time_ns(self) -> int:
        return self.now


def make(t0=T0):
    clock = FakeClock(t0)
    mgr = ConcurrentControlManager(clock, session_id="default")
    mgr.set_setlist([Song(id="s1", title="Uno", bpm=120), Song(id="s2", title="Dos", bpm=128)])
    updates = []
    mgr.add_listener(updates.append)
    return clock, mgr, updates


def play(clock, mgr):
    res = mgr.process_local("PLAY")
    assert res.accepted and res.action_taken == "PLAY"
    return res.new_state.anchor_ns


def run_until(clock, mgr, until_ns, step=TICK_NS):
    """Advance the clock in UI-timer steps, calling tick() each time."""
    published = []
    while clock.now < until_ns:
        clock.now += step
        if mgr.tick():
            published.append(clock.now)
    return published


# --------------------------------------------------------------------------- math helper
def test_bar_start_time_respects_segment_windows():
    a = Segment(10 * BAR_NS, 120, 4, 1)
    loop = Segment(12 * BAR_NS, 120, 4, 1)  # bar 3 of `a` would start here: replaced by bar 1
    sched = (a, loop)
    assert bar_start_time(sched, 2, 10 * BAR_NS) == (11 * BAR_NS, a)
    # Bar 3 never starts in `a` (its window ends first); in `loop` it starts 2 bars later.
    assert bar_start_time(sched, 3, 10 * BAR_NS) == (14 * BAR_NS, loop)
    assert bar_start_time(sched, 0, 10 * BAR_NS) is None


# --------------------------------------------------------------------------- the loop
def test_two_repeats_reanchor_twice_on_the_exact_boundary_then_clear():
    clock, mgr, updates = make()
    anchor = play(clock, mgr)
    info = mgr.set_loop(1, 2, 2)
    assert info == LoopInfo(True, 1, 2, 2, 0)
    v_before = mgr.get_state().state_version

    run_until(clock, mgr, anchor + 8 * BAR_NS)

    loops = [u for u in updates if u.state.state_version > v_before]
    assert [u.wire_state["anchor_ns"] for u in loops] == [anchor + 2 * BAR_NS, anchor + 4 * BAR_NS]
    for u in loops:
        st = u.wire_state
        assert st["bar_offset"] == 1 and st["status"] == "PLAYING" and st["bpm"] == 120
        assert st["last_command"]["type"] == "PLAY"  # a loop is not a command: last_command untouched
        assert st["anchor_ns"] >= st["leader_time_ns"] + START_LEAD_NS  # rule 1
        assert st["anchor_ns"] - st["leader_time_ns"] <= LOOP_PUBLISH_BARS * BAR_NS  # published close to it
        assert u.schedule[-1] == Segment(st["anchor_ns"], 120, 4, 1)
    assert [u.state.state_version for u in loops] == [v_before + 1, v_before + 2]
    # Three passes over bars 1-2, then the song goes on with bar 3 and the loop is gone.
    sched = mgr.get_schedule()
    assert position_at(sched, anchor + 4 * BAR_NS) == (1, 1)
    assert position_at(sched, anchor + 6 * BAR_NS) == (3, 1)
    assert position_at(sched, anchor + 6 * BAR_NS + BAR_NS // 2) == (3, 3)
    assert mgr.loop_info() == LoopInfo()


def test_repeat_counter_follows_what_is_sounding():
    clock, mgr, _updates = make()
    anchor = play(clock, mgr)
    mgr.set_loop(1, 2, 2)
    run_until(clock, mgr, anchor + BAR_NS + BAR_NS // 2)
    # The first return is published (boundary at 2 bars) but the first pass still sounds.
    assert mgr.loop_info().current_repeat == 0
    run_until(clock, mgr, anchor + 2 * BAR_NS + BAR_NS // 2)
    assert mgr.loop_info().current_repeat == 1
    run_until(clock, mgr, anchor + 4 * BAR_NS + BAR_NS // 2)
    info = mgr.loop_info()
    assert info.active and info.current_repeat == 2 and info.repeats == 2


def test_infinite_loop_keeps_going():
    clock, mgr, _updates = make()
    anchor = play(clock, mgr)
    info = mgr.set_loop(1, 1, 0)
    assert info.infinite
    published = run_until(clock, mgr, anchor + 20 * BAR_NS)
    # One return per bar; the one for bar 21 is already published (pending).
    assert len(published) == 21
    info = mgr.loop_info()
    assert info.active and info.current_repeat == 20
    # Still bar 1 after 20 bars.
    assert position_at(mgr.get_schedule(), anchor + 20 * BAR_NS + 1)[0] == 1


def test_loop_entered_from_outside_jumps_on_the_next_downbeat():
    clock, mgr, updates = make()
    anchor = play(clock, mgr)
    clock.now = anchor + BAR_NS // 4  # bar 1, beat 1
    assert mgr.set_loop(5, 6, 1).current_repeat == 0
    entry = updates[-1].wire_state
    assert entry["anchor_ns"] == anchor + BAR_NS and entry["bar_offset"] == 5
    run_until(clock, mgr, anchor + BAR_NS + 1)
    assert mgr.loop_info().current_repeat == 0  # the entry is not a repeat
    run_until(clock, mgr, anchor + 8 * BAR_NS)
    sched = mgr.get_schedule()
    assert position_at(sched, anchor + 3 * BAR_NS) == (5, 1)  # second pass starts
    assert position_at(sched, anchor + 5 * BAR_NS) == (7, 1)  # then the song continues
    assert not mgr.loop_info().active


def test_loop_armed_in_idle_waits_for_play():
    clock, mgr, updates = make()
    n = len(updates)
    mgr.set_loop(3, 4, 1)
    assert not mgr.tick() and len(updates) == n
    anchor = play(clock, mgr)
    assert not mgr.tick()  # inside the start lead: nothing yet
    run_until(clock, mgr, anchor + 2 * BAR_NS)
    # Bar 1 sounds as a lead-in bar; bar 3 starts on the next downbeat.
    assert position_at(mgr.get_schedule(), anchor + BAR_NS) == (3, 1)


@pytest.mark.parametrize("command,payload", [
    ("STOP", {}), ("PANIC", {}), ("JUMP_SONG", {"song_id": "s2"}), ("CUE_NEXT", {}),
])
def test_transport_commands_cancel_the_loop(command, payload):
    clock, mgr, updates = make()
    anchor = play(clock, mgr)
    mgr.set_loop(1, 2, 0)
    run_until(clock, mgr, anchor + BAR_NS)
    assert mgr.loop_info().active
    assert mgr.process_local(command, payload).accepted
    assert not mgr.loop_info().active
    n = len(updates)
    if mgr.get_state().status is not SessionStatus.PLAYING:
        play(clock, mgr)
        n += 1
    run_until(clock, mgr, clock.now + 10 * BAR_NS)
    assert len(updates) == n  # no loop anchor after the cancel


def test_stop_cancels_and_clear_loop_lets_the_song_continue():
    clock, mgr, _updates = make()
    anchor = play(clock, mgr)
    mgr.set_loop(1, 2, 0)
    run_until(clock, mgr, anchor + 5 * BAR_NS)  # third pass; the return at 6 bars is published
    mgr.clear_loop()
    run_until(clock, mgr, anchor + 12 * BAR_NS)
    sched = mgr.get_schedule()
    # That return still sounds (a published anchor is never withdrawn), then bars keep counting.
    assert position_at(sched, anchor + 6 * BAR_NS) == (1, 1)
    assert position_at(sched, anchor + 9 * BAR_NS) == (4, 1)


def test_pause_before_a_published_return_does_not_count_it():
    clock, mgr, _updates = make()
    anchor = play(clock, mgr)
    mgr.set_loop(1, 2, 2)
    run_until(clock, mgr, anchor + BAR_NS + BAR_NS // 2)  # return published for 2 bars, not sounding
    assert mgr.process_local("PAUSE").accepted  # paused in bar 2
    clock.now += TICK_NS
    assert mgr.loop_info().current_repeat == 0
    resume_anchor = mgr.process_local("RESUME").new_state.anchor_ns  # resumes at bar 3: outside
    run_until(clock, mgr, resume_anchor + BAR_NS // 2)
    st = mgr.get_state()
    assert st.bar_offset == 1  # back to the section: the late return counts as the first repeat
    clock.now = st.anchor_ns + 1
    assert mgr.loop_info().current_repeat == 1


def test_invalid_loops_are_rejected():
    _clock, mgr, _updates = make()
    for args in ((0, 2, 1), (3, 2, 1), (1, 2, -1), ("1", 2, 1), (1.5, 2, 1), (True, 2, 1)):
        with pytest.raises(ValueError):
            mgr.set_loop(*args)
    assert not mgr.loop_info().active


def test_loop_is_dropped_when_the_song_changes_in_idle():
    _clock, mgr, _updates = make()
    mgr.set_loop(1, 2, 1)
    mgr.set_setlist([Song(id="s2", title="Dos", bpm=128)])
    assert not mgr.loop_info().active


def test_tempo_nudge_inside_the_loop_keeps_looping_at_the_new_tempo():
    clock, mgr, updates = make()
    anchor = play(clock, mgr)
    mgr.set_loop(1, 2, 0)
    run_until(clock, mgr, anchor + 5 * BAR_NS)  # second pass; next return published at 8 bars
    assert mgr.process_local("TEMPO_NUDGE", {"delta_bpm": 4}).accepted
    run_until(clock, mgr, anchor + 16 * BAR_NS)
    last = updates[-1].wire_state
    assert last["bpm"] == 124 and last["bar_offset"] == 1
    assert updates[-1].schedule[-1].bpm == 124


# --------------------------------------------------------------------------- wire shape
def test_loop_state_matches_the_contract_shapes():
    clock, mgr, updates = make()
    mgr.set_setlist(load_fixtures()["state_playing"]["setlist"])
    anchor = play(clock, mgr)
    mgr.set_loop(1, 2, 1)
    run_until(clock, mgr, anchor + BAR_NS)
    wire = updates[-1].wire_state
    assert wire["bar_offset"] == 1 and wire["anchor_ns"] == anchor + 2 * BAR_NS
    validate("session_state", wire)
    pytest.importorskip("jsonschema")
    pytest.importorskip("referencing")
    from test_protocol_schemas import _validator

    errors = list(_validator("session_state.json").iter_errors(wire))
    assert not errors, [e.message for e in errors]


# --------------------------------------------------------------------------- audio
SR = 48000
BLOCK = 256


@pytest.fixture
def engine(monkeypatch):
    import sounddevice as sd

    from src.audio.audio_engine import AudioEngine

    dev = {"name": "Interfaz 8x8", "hostapi": 0, "max_input_channels": 2, "max_output_channels": 8,
           "default_samplerate": SR}
    monkeypatch.setattr(sd, "query_devices", lambda *a: dev if a else [dev])
    monkeypatch.setattr(sd, "query_hostapis", lambda: [{"name": "ASIO"}])
    eng = AudioEngine(sample_rate=SR, block_size=BLOCK, device=0)
    eng.enable_pa_click = False
    eng.enable_drummer_click = True
    return eng


def _render(engine, start_ns, seconds):
    frames = int(seconds * SR) // BLOCK * BLOCK
    out = np.zeros((frames, 8), dtype=np.float32)
    for b in range(frames // BLOCK):
        block = np.zeros((BLOCK, 8), dtype=np.float32)
        engine._render(None, block, BLOCK, start_ns + int(round(b * BLOCK * 1e9 / SR)))
        out[b * BLOCK:(b + 1) * BLOCK] = block
    return out


def test_audio_engine_gets_the_loop_segment_and_stems_jump_back(qapp, engine):
    from src.sync.clock_service import ClockService

    anchor = 10_000_000_000
    clock, mgr, _updates = make(anchor - START_LEAD_NS)
    service = ClockService(mode="leader")
    service.schedule_changed.connect(engine.set_schedule)  # the MainWindow wiring
    mgr.add_listener(service.apply_update)
    data = np.zeros((SR * 10, 2), dtype=np.int16)
    data[SR // 2] = 16000  # one hit 0.5 s into bar 1
    engine.set_stems([data], [1.0], ref_bpm=120)

    assert play(clock, mgr) == anchor
    mgr.set_loop(1, 1, 1)  # bar 1, once more
    clock.now = anchor + TICK_NS
    assert mgr.tick()
    assert engine._schedule[-1] == Segment(anchor + BAR_NS, 120, 4, 1)

    out = _render(engine, anchor, 4.0)
    hits = np.flatnonzero(np.abs(out[:, 0]) > 0.1)
    # Stem hit in the first pass and again in the repeat (bar 1 restarts at 2 s).
    assert [int(h) for h in hits] == [SR // 2, 2 * SR + SR // 2]
    # Drummer click: accented downbeat on the loop anchor too.
    click = np.abs(out[:, 2])
    assert click[2 * SR] > 0.5
