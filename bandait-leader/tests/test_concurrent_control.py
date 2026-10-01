"""ConcurrentControlManager: CONTRACT_V3 command semantics with a fake clock."""

import threading

from src.domain.concurrent_control import ConcurrentControlManager, DEDUP_WINDOW_NS
from src.domain.models import CommandType, ConcurrentCommand, SessionStatus, Song
from src.sync.transport_math import START_LEAD_NS

T0 = 5_000_000_000_000  # leader time far above 2**31 ns


class FakeClock:
    def __init__(self, now=T0):
        self.now = now

    def get_leader_time_ns(self) -> int:
        return self.now

    def advance(self, ns):
        self.now += ns


def make(setlist=True):
    clock = FakeClock()
    mgr = ConcurrentControlManager(clock, session_id="default")
    if setlist:
        mgr.set_setlist([
            Song(id="s1", title="Uno", bpm=120),
            Song(id="s2", title="Dos", bpm=128),
            Song(id="s3", title="Tres", bpm=95),
            Song(id="s4", title="Cuatro (Balada)", bpm=80),
        ])
    return clock, mgr


def cmd(mgr, type_, payload=None, cid=None, origin="director_mobile"):
    data = {"session_id": "default", "type": type_, "origin": origin, "sender_id": "u", "payload": payload or {}}
    if cid:
        data["command_id"] = cid
    return mgr.process_raw(data)


def test_initial_state_and_setlist():
    _clock, mgr = make()
    st = mgr.get_state()
    assert st.status is SessionStatus.IDLE
    assert st.current_song_id == "s1" and st.current_order_index == 0 and st.bpm == 120
    assert [e.order_index for e in st.setlist] == [0, 1, 2, 3]
    wire = mgr.wire_state()
    assert wire["protocol_version"] == 3 and wire["anchor_ns"] is None


def test_play_from_idle_anchors_with_lead():
    clock, mgr = make()
    v0 = mgr.get_state().state_version
    res = cmd(mgr, "PLAY", cid="p1")
    assert res.accepted and res.action_taken == "PLAY"
    st = res.new_state
    assert st.status is SessionStatus.PLAYING
    assert st.anchor_ns == clock.now + START_LEAD_NS
    assert st.bar_offset == 1 and st.paused_bar is None
    assert st.state_version == v0 + 1
    assert st.last_command.command_id == "p1" and st.last_command.origin == "director_mobile"
    assert res.ack["state"]["anchor_ns"] >= res.ack["state"]["leader_time_ns"] + START_LEAD_NS


def test_play_while_playing_is_noop_and_keeps_phase():
    clock, mgr = make()
    first = cmd(mgr, "PLAY").new_state
    clock.advance(30_000_000)
    res = cmd(mgr, "PLAY", origin="laptop_foh")
    assert res.accepted and res.action_taken == "noop_already_playing"
    assert not res.changed
    assert res.new_state.anchor_ns == first.anchor_ns
    assert res.new_state.state_version == first.state_version


def test_unknown_type_is_rejected_never_play():
    _clock, mgr = make()
    for bad in ("FOO", "play", "", None, 42):
        res = cmd(mgr, bad)
        assert not res.accepted
        assert res.reason == "invalid_type"
        assert res.action_taken == "none"
    assert mgr.get_state().status is SessionStatus.IDLE


def test_dedupe_by_command_id_within_60s():
    clock, mgr = make()
    a = cmd(mgr, "PLAY", cid="same")
    b = cmd(mgr, "STOP", cid="same")  # same id, different type: not re-applied
    assert b.duplicate and b.ack["duplicate"] is True
    assert b.ack["action_taken"] == "PLAY" and b.ack["state_version"] == a.ack["state_version"]
    assert mgr.get_state().status is SessionStatus.PLAYING
    clock.advance(DEDUP_WINDOW_NS + 1)
    c = cmd(mgr, "STOP", cid="same")
    assert not c.duplicate and c.action_taken == "STOP"


def test_last_write_wins_by_leader_receipt_time():
    clock, mgr = make()
    late = ConcurrentCommand("late", CommandType.STOP, "director_mobile", "u", "default", clock.now)
    clock.advance(1_000)
    first = ConcurrentCommand("first", CommandType.PLAY, "laptop_foh", "u", "default", clock.now)
    assert mgr.process_command(first).accepted
    # Received earlier than the applied command but processed after it.
    res = mgr.process_command(late)
    assert not res.accepted and res.reason == "conflict" and res.action_taken == "rejected_stale"
    assert mgr.get_state().status is SessionStatus.PLAYING


def test_pause_resume_bar_math():
    clock, mgr = make()
    st = cmd(mgr, "PLAY").new_state
    anchor = st.anchor_ns
    beat = 500_000_000  # 120 bpm
    clock.now = anchor + 9 * beat + 10  # bar 3, beat 2
    paused = cmd(mgr, "PAUSE").new_state
    assert paused.status is SessionStatus.PAUSED
    assert paused.anchor_ns is None and paused.paused_bar == 3
    assert cmd(mgr, "PAUSE").action_taken == "noop_already_paused"
    clock.advance(7_000_000_000)
    resumed = cmd(mgr, "RESUME").new_state
    assert resumed.status is SessionStatus.PLAYING
    assert resumed.bar_offset == 4 and resumed.paused_bar is None
    assert resumed.anchor_ns == clock.now + START_LEAD_NS
    sched = mgr.get_schedule()
    assert len(sched) == 1 and sched[0].bar_offset == 4


def test_pause_inside_start_lead_resumes_at_bar_one():
    clock, mgr = make()
    cmd(mgr, "PLAY")
    clock.advance(100_000_000)  # before the anchor
    assert cmd(mgr, "PAUSE").new_state.paused_bar == 0
    assert cmd(mgr, "PLAY").new_state.bar_offset == 1  # PLAY while PAUSED = RESUME


def test_stop_and_panic():
    _clock, mgr = make()
    cmd(mgr, "PLAY")
    stopped = cmd(mgr, "STOP").new_state
    assert stopped.status is SessionStatus.IDLE and stopped.anchor_ns is None and stopped.bar_offset == 1
    cmd(mgr, "PLAY")
    panic = cmd(mgr, "PANIC").new_state
    assert panic.status is SessionStatus.IDLE and panic.last_command.type == "PANIC"
    assert mgr.get_schedule() == ()


def test_cue_conflict_out_of_range_and_no_setlist():
    _clock, mgr = make()
    assert cmd(mgr, "CUE_NEXT", {"expected_song_id": "s2"}).reason == "conflict"
    ok = cmd(mgr, "CUE_NEXT", {"expected_song_id": "s1"})
    assert ok.accepted and ok.new_state.current_song_id == "s2" and ok.new_state.bpm == 128
    assert ok.new_state.status is SessionStatus.IDLE and ok.jump_alert is None
    # Second device pressed NEXT believing s1 was still current: rejected.
    assert cmd(mgr, "CUE_NEXT", {"expected_song_id": "s1"}).reason == "conflict"
    assert cmd(mgr, "CUE_PREV").accepted
    assert cmd(mgr, "CUE_PREV").reason == "out_of_range"
    _c2, empty = make(setlist=False)
    assert cmd(empty, "CUE_NEXT").reason == "no_setlist"
    assert cmd(empty, "JUMP_SONG", {"song_id": "x"}).reason == "no_setlist"


def test_cue_while_playing_reanchors_without_rewriting_the_past():
    clock, mgr = make()
    first = cmd(mgr, "PLAY").new_state
    clock.now = first.anchor_ns + 1_100_000_000
    res = cmd(mgr, "CUE_NEXT")
    st = res.new_state
    assert st.status is SessionStatus.PLAYING and st.current_song_id == "s2"
    assert st.anchor_ns == clock.now + START_LEAD_NS and st.bar_offset == 1 and st.bpm == 128
    sched = mgr.get_schedule()
    assert len(sched) == 2 and sched[0].anchor_ns == first.anchor_ns  # old keeps clicking
    assert res.jump_alert is None  # sequential


def test_jump_song_alert_is_zero_based():
    clock, mgr = make()
    res = cmd(mgr, "JUMP_SONG", {"song_id": "s4"})
    assert res.accepted and res.new_state.status is SessionStatus.PLAYING
    assert res.new_state.bpm == 80 and res.new_state.bar_offset == 1
    alert = res.jump_alert
    assert alert.order_index == 3 and alert.previous_song_id == "s1" and alert.triggered_by == "director_mobile"
    by_index = cmd(mgr, "JUMP_SONG", {"order_index": 1})
    assert by_index.new_state.current_song_id == "s2"
    assert cmd(mgr, "JUMP_SONG", {"song_id": "nope"}).reason == "out_of_range"
    assert cmd(mgr, "JUMP_SONG", {"order_index": 99}).reason == "out_of_range"
    assert cmd(mgr, "JUMP_SONG", {"order_index": True}).reason == "out_of_range"


def test_tempo_nudge_applies_at_next_valid_bar_boundary():
    clock, mgr = make()
    st = cmd(mgr, "PLAY").new_state
    anchor = st.anchor_ns
    bar = 2_000_000_000  # 120 bpm, 4/4
    clock.now = anchor + bar - 100_000_000  # 100 ms before bar 2: too close (lead 250 ms)
    res = cmd(mgr, "TEMPO_NUDGE", {"delta_bpm": 1})
    nst = res.new_state
    assert nst.bpm == 121
    assert nst.anchor_ns == anchor + 2 * bar and nst.bar_offset == 3
    assert nst.anchor_ns >= clock.now + START_LEAD_NS
    # A second nudge before that boundary replaces the pending segment.
    clock.advance(50_000_000)
    again = cmd(mgr, "TEMPO_NUDGE", {"delta_bpm": 1}).new_state
    assert again.bpm == 122 and again.anchor_ns == anchor + 2 * bar and again.bar_offset == 3
    sched = mgr.get_schedule()
    assert [s.bpm for s in sched] == [120, 122]


def test_tempo_nudge_clamps_and_validates():
    _clock, mgr = make()
    assert cmd(mgr, "TEMPO_NUDGE", {"delta_bpm": 500}).new_state.bpm == 260
    assert cmd(mgr, "TEMPO_NUDGE", {"delta_bpm": 1}).action_taken == "noop_tempo_unchanged"
    assert cmd(mgr, "TEMPO_NUDGE", {"delta_bpm": -1000}).new_state.bpm == 40
    assert cmd(mgr, "TEMPO_NUDGE", {"delta_bpm": "1"}).reason == "out_of_range"
    assert cmd(mgr, "TEMPO_NUDGE", {}).reason == "out_of_range"
    st = mgr.get_state()
    assert st.status is SessionStatus.IDLE and st.anchor_ns is None  # IDLE: only bpm changes


def test_set_setlist_never_moves_a_playing_band():
    _clock, mgr = make()
    playing = cmd(mgr, "PLAY").new_state
    mgr.set_setlist([Song(id="x", title="X", bpm=200), Song(id="s1", title="Uno", bpm=120)])
    st = mgr.get_state()
    assert st.status is SessionStatus.PLAYING and st.anchor_ns == playing.anchor_ns
    assert st.bpm == 120 and st.current_song_id == "s1" and st.current_order_index == 1


def test_listener_receives_every_change_and_threads_do_not_corrupt_state():
    clock, mgr = make()
    seen = []
    lock = threading.Lock()

    def listener(update):
        with lock:
            seen.append(update.state.state_version)

    mgr.add_listener(listener)
    start_version = mgr.get_state().state_version

    def worker(prefix):
        for i in range(200):
            clock.advance(1)
            cmd(mgr, "TEMPO_NUDGE", {"delta_bpm": 1 if i % 2 else -1}, cid=f"{prefix}-{i}")

    threads = [threading.Thread(target=worker, args=(p,)) for p in ("a", "b")]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    final = mgr.get_state().state_version
    assert len(seen) == final - start_version
    assert sorted(seen) == list(range(start_version + 1, final + 1))
