"""Tests for Concurrent Master Control and Setlist Jump Detection."""

import time
from src.domain.models import (
    CommandType,
    ConcurrentCommand,
    SessionStatus,
    Song,
)
from src.domain.concurrent_control import ConcurrentControlManager


class MockClockService:
    def __init__(self):
        self.bpm = 120
        self.is_playing = False

    def get_leader_time_ns(self) -> int:
        return time.monotonic_ns()

    def start_playback(self, bpm: int = 120) -> None:
        self.bpm = bpm
        self.is_playing = True

    def stop_playback(self) -> None:
        self.is_playing = False


def create_sample_setlist():
    return [
        Song(id="song-1", title="Cancion 1", bpm=120),
        Song(id="song-2", title="Cancion 2", bpm=128),
        Song(id="song-3", title="Cancion 3", bpm=95),
        Song(id="song-4", title="Cancion 4 (Balada)", bpm=80),
        Song(id="song-5", title="Cancion 5 (Final)", bpm=145),
    ]


def test_concurrent_play_and_stop():
    clock = MockClockService()
    manager = ConcurrentControlManager(clock, session_id="test-session")
    songs = create_sample_setlist()
    manager.set_setlist(songs)

    # Director sends PLAY from mobile
    cmd_play = ConcurrentCommand(
        command_id="cmd_1",
        command_type=CommandType.PLAY,
        origin="director_mobile",
        sender_user_id="user_director",
        session_id="test-session",
        timestamp_ns=time.monotonic_ns(),
    )
    res_play = manager.process_command(cmd_play)
    assert res_play.success is True
    assert res_play.new_state.status == SessionStatus.PLAYING
    assert res_play.new_state.beat == 1

    # Sound tech sends STOP from laptop
    cmd_stop = ConcurrentCommand(
        command_id="cmd_2",
        command_type=CommandType.STOP,
        origin="laptop",
        sender_user_id="user_foh",
        session_id="test-session",
        timestamp_ns=time.monotonic_ns() + 1000,
    )
    res_stop = manager.process_command(cmd_stop)
    assert res_stop.success is True
    assert res_stop.new_state.status == SessionStatus.IDLE


def test_last_write_wins_stale_rejection():
    clock = MockClockService()
    manager = ConcurrentControlManager(clock)

    now = time.monotonic_ns()
    cmd_recent = ConcurrentCommand(
        command_id="cmd_recent",
        command_type=CommandType.PLAY,
        origin="laptop",
        sender_user_id="user_foh",
        session_id="default",
        timestamp_ns=now + 5000000,
    )
    res_recent = manager.process_command(cmd_recent)
    assert res_recent.success is True

    # Obsolete command delayed on Wi-Fi arrives later
    cmd_stale = ConcurrentCommand(
        command_id="cmd_stale",
        command_type=CommandType.STOP,
        origin="director_mobile",
        sender_user_id="user_director",
        session_id="default",
        timestamp_ns=now,  # older timestamp
    )
    res_stale = manager.process_command(cmd_stale)
    assert res_stale.success is False
    assert res_stale.action_taken == "rejected_stale"


def test_setlist_jump_alert_generation():
    clock = MockClockService()
    manager = ConcurrentControlManager(clock)
    songs = create_sample_setlist()
    manager.set_setlist(songs, start_index=0)  # at song-1

    # Sequential next: song-1 to song-2 -> NO jump alert
    cmd_next = ConcurrentCommand(
        command_id="cmd_seq",
        command_type=CommandType.CUE_NEXT,
        origin="laptop",
        sender_user_id="user_laptop",
        session_id="default",
        timestamp_ns=time.monotonic_ns(),
    )
    res_next = manager.process_command(cmd_next)
    assert res_next.success is True
    assert res_next.jump_alert is None
    assert res_next.new_state.current_song_id == "song-2"

    # NON-SEQUENTIAL JUMP: from song-2 directly to song-4 (Balada)
    cmd_jump = ConcurrentCommand(
        command_id="cmd_jump_1",
        command_type=CommandType.JUMP_SONG,
        origin="director_mobile",
        sender_user_id="user_director",
        session_id="default",
        timestamp_ns=time.monotonic_ns() + 1000,
        payload={"song_id": "song-4"},
    )
    res_jump = manager.process_command(cmd_jump)
    assert res_jump.success is True
    assert res_jump.jump_alert is not None
    assert res_jump.jump_alert.song_id == "song-4"
    assert res_jump.jump_alert.title == "Cancion 4 (Balada)"
    assert res_jump.jump_alert.order_index == 4
    assert res_jump.jump_alert.previous_song_id == "song-2"
    assert res_jump.jump_alert.triggered_by == "director_mobile"
    assert res_jump.new_state.bpm == 80
    assert res_jump.new_state.beat == 1


def test_tempo_nudge_and_clamping():
    clock = MockClockService()
    manager = ConcurrentControlManager(clock)
    manager.set_setlist([Song(id="s1", title="Test", bpm=120)])

    # Nudge +1 BPM
    cmd_nudge = ConcurrentCommand(
        command_id="cmd_nudge_up",
        command_type=CommandType.TEMPO_NUDGE,
        origin="director_mobile",
        sender_user_id="user_dir",
        session_id="default",
        timestamp_ns=time.monotonic_ns(),
        payload={"delta_bpm": 1},
    )
    res = manager.process_command(cmd_nudge)
    assert res.new_state.bpm == 121

    # Nudge extreme high clamps to 260
    cmd_extreme = ConcurrentCommand(
        command_id="cmd_extreme",
        command_type=CommandType.TEMPO_NUDGE,
        origin="director_mobile",
        sender_user_id="user_dir",
        session_id="default",
        timestamp_ns=time.monotonic_ns() + 1000,
        payload={"delta_bpm": 200},
    )
    res_extreme = manager.process_command(cmd_extreme)
    assert res_extreme.new_state.bpm == 260


def test_panic_stop():
    clock = MockClockService()
    manager = ConcurrentControlManager(clock)
    manager.set_setlist([Song(id="s1", title="Test", bpm=120)])

    # Start playing
    manager.process_command(ConcurrentCommand(
        command_id="play",
        command_type=CommandType.PLAY,
        origin="laptop",
        sender_user_id="u1",
        session_id="default",
        timestamp_ns=time.monotonic_ns(),
    ))

    # Send PANIC
    res_panic = manager.process_command(ConcurrentCommand(
        command_id="panic",
        command_type=CommandType.PANIC,
        origin="director_mobile",
        sender_user_id="user_dir",
        session_id="default",
        timestamp_ns=time.monotonic_ns() + 1000,
    ))
    assert res_panic.success is True
    assert res_panic.action_taken == "PANIC"
    assert res_panic.new_state.status == SessionStatus.IDLE


if __name__ == "__main__":
    test_concurrent_play_and_stop()
    test_last_write_wins_stale_rejection()
    test_setlist_jump_alert_generation()
    test_tempo_nudge_and_clamping()
    test_panic_stop()
    print("ALL CONCURRENT CONTROL TESTS PASSED OK")
