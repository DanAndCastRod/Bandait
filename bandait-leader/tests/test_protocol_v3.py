"""Real Socket.IO integration tests against the leader (CONTRACT_V3).

A python-socketio AsyncClient talks to BandaitServer running on its own thread
and an ephemeral port, exactly like a phone would. Every emitted payload is
validated against bandait-protocol/fixtures/v3_messages.json.

pytest-timeout is not installed: every await is bounded by asyncio.wait_for.
"""

import asyncio
import math
import uuid
from collections import defaultdict

import pytest
import socketio

from src.domain.models import LEADER_INSTANCE_ID
from src.network.server import BandaitServer
from src.sync.clock_service import ClockService
from src.sync.leader_clock import leader_now_ns
from src.sync.transport_math import START_LEAD_NS
from v3_shapes import load_fixtures, validate

FIXTURES = load_fixtures()
DEMO_SETLIST = FIXTURES["state_playing"]["setlist"]  # song_01 120, song_02 96, song_07 140
EVENTS = ("full_state", "state_update", "beat_beacon", "setlist_jump", "follower_joined", "follower_left")
TEST_TIMEOUT_S = 40


@pytest.fixture
def leader():
    server = BandaitServer(ClockService(), host="127.0.0.1", port=0, session_id="default")
    server.set_setlist(DEMO_SETLIST)
    assert server.start(), server.status_message
    yield server
    thread = server._thread
    server.stop()
    assert thread is None or not thread.is_alive()


def run(coro):
    return asyncio.run(asyncio.wait_for(coro, TEST_TIMEOUT_S))


class Probe:
    """A follower/director phone."""

    def __init__(self, server, alias="Bajo", role="musician"):
        self.url = f"http://127.0.0.1:{server.port}"
        self.alias = alias
        self.role = role
        self.client_id = str(uuid.uuid4())
        self.sio = socketio.AsyncClient(reconnection=False)
        self.queues = defaultdict(asyncio.Queue)
        for event in EVENTS:
            self.sio.on(event, self._handler(event))

    def _handler(self, event):
        async def handler(data):
            await self.queues[event].put(data)

        return handler

    async def connect(self):
        await self.sio.connect(self.url, transports=["websocket"], wait_timeout=5)

    async def join(self):
        return await self.sio.call(
            "join_session",
            {
                "session_id": "default",
                "client_id": self.client_id,
                "role": self.role,
                "alias": self.alias,
                "protocol_version": 3,
            },
            timeout=5,
        )

    async def command(self, type_, payload=None, command_id=None, origin="director_mobile"):
        return await self.sio.call(
            "control_command",
            {
                "session_id": "default",
                "command_id": command_id or str(uuid.uuid4()),
                "type": type_,
                "origin": origin,
                "sender_id": self.client_id,
                "payload": payload or {},
            },
            timeout=5,
        )

    async def next(self, event, timeout=3.0):
        return await asyncio.wait_for(self.queues[event].get(), timeout)

    async def nothing(self, event, wait=0.4):
        try:
            data = await asyncio.wait_for(self.queues[event].get(), wait)
        except asyncio.TimeoutError:
            return True
        raise AssertionError(f"unexpected {event}: {data}")

    def drain(self, event):
        q = self.queues[event]
        while not q.empty():
            q.get_nowait()

    async def close(self):
        if self.sio.connected:
            await self.sio.disconnect()


async def joined(server, **kw):
    probe = Probe(server, **kw)
    await probe.connect()
    await probe.join()
    await probe.next("full_state")
    probe.drain("follower_joined")
    return probe


async def sleep_until_leader(t_ns):
    while leader_now_ns() < t_ns:
        await asyncio.sleep(min(0.05, max(0.001, (t_ns - leader_now_ns()) / 1e9)))


def test_join_ack_and_full_state_always(leader):
    async def scenario():
        probe = Probe(leader)
        await probe.connect()
        ack = await probe.join()
        validate("join_session_ack", ack)
        assert ack["status"] == "joined" and ack["session_id"] == "default"
        assert ack["protocol_version"] == 3
        assert abs(ack["leader_time_ns"] - leader_now_ns()) < 2_000_000_000
        state = await probe.next("full_state")  # sent even though the session is IDLE
        validate("session_state", state)
        assert state["status"] == "IDLE" and state["anchor_ns"] is None
        # One UUID per leader process, in the ack and in every SessionState.
        assert ack["leader_instance_id"] == state["leader_instance_id"] == LEADER_INSTANCE_ID
        assert state["current_song_id"] == "song_01" and len(state["setlist"]) == 3
        await probe.close()

    run(scenario())


def test_sync_request_echo(leader):
    async def scenario():
        probe = Probe(leader)
        await probe.connect()
        before = leader_now_ns()
        ack = await probe.sio.call("sync_request", {"client_send_ms": 18234.125}, timeout=5)
        after = leader_now_ns()
        validate("sync_request_ack", ack)
        assert ack["client_send_ms"] == 18234.125
        assert before <= ack["leader_time_ns"] <= after
        bad = await probe.sio.call("sync_request", {"client_send_ms": "x"}, timeout=5)
        assert bad["client_send_ms"] is None and isinstance(bad["leader_time_ns"], int)
        await probe.close()

    run(scenario())


def test_play_ack_and_state_update_with_lead(leader):
    async def scenario():
        probe = await joined(leader)
        ack = await probe.command("PLAY", command_id="2b9f0c4e-8d1a-4f6b-b3c7-5e2a9d0f1a44")
        validate("command_ack", ack)
        assert ack["accepted"] is True and ack["duplicate"] is False
        assert ack["action_taken"] == "PLAY" and ack["reason"] is None
        update = await probe.next("state_update")
        validate("session_state", update)
        assert update["leader_instance_id"] == LEADER_INSTANCE_ID
        assert update["status"] == "PLAYING"
        assert update["state_version"] == ack["state_version"]
        assert update["anchor_ns"] >= update["leader_time_ns"] + START_LEAD_NS
        assert update["bar_offset"] == 1
        assert update["last_command"] == {
            "command_id": "2b9f0c4e-8d1a-4f6b-b3c7-5e2a9d0f1a44",
            "type": "PLAY",
            "origin": "director_mobile",
        }
        # A second PLAY from another device must not restart the phase.
        again = await probe.command("PLAY", origin="laptop_foh")
        assert again["accepted"] and again["action_taken"] == "noop_already_playing"
        assert again["state_version"] == ack["state_version"]
        assert again["state"]["anchor_ns"] == update["anchor_ns"]
        await probe.nothing("state_update")
        await probe.close()

    run(scenario())


def test_duplicate_command_id_returns_cached_ack(leader):
    async def scenario():
        probe = await joined(leader)
        cid = str(uuid.uuid4())
        first = await probe.command("PLAY", command_id=cid)
        await probe.next("state_update")
        retry = await probe.command("PLAY", command_id=cid)
        validate("command_ack", retry)
        assert retry["duplicate"] is True and retry["accepted"] is True
        assert retry["action_taken"] == first["action_taken"]
        assert retry["state_version"] == first["state_version"]
        # Same id with another type: still the cached ack, nothing applied.
        other = await probe.command("STOP", command_id=cid)
        assert other["duplicate"] is True and other["action_taken"] == "PLAY"
        await probe.nothing("state_update")
        assert leader.get_state()["status"] == "PLAYING"
        await probe.close()

    run(scenario())


def test_invalid_type_is_rejected(leader):
    async def scenario():
        probe = await joined(leader)
        for bad in ("FOO", "play", None):
            ack = await probe.command(bad)
            validate("command_ack", ack)
            assert ack["accepted"] is False and ack["reason"] == "invalid_type"
            assert ack["state"]["status"] == "IDLE"
        await probe.nothing("state_update")
        await probe.close()

    run(scenario())


def test_cue_next_conflict_guard(leader):
    async def scenario():
        director = await joined(leader, alias="Director", role="director")
        stale = await director.command("CUE_NEXT", {"expected_song_id": "song_02"})
        validate("command_ack", stale)
        assert stale["accepted"] is False and stale["reason"] == "conflict"
        assert stale["state"]["current_song_id"] == "song_01"
        ok = await director.command("CUE_NEXT", {"expected_song_id": "song_01"})
        assert ok["accepted"] and ok["state"]["current_song_id"] == "song_02"
        assert ok["state"]["current_order_index"] == 1 and ok["state"]["bpm"] == 96
        update = await director.next("state_update")
        assert update["current_song_id"] == "song_02"
        # The second device also believed song_01 was current: rejected, no double skip.
        dup = await director.command("CUE_NEXT", {"expected_song_id": "song_01"})
        assert dup["reason"] == "conflict" and dup["state"]["current_song_id"] == "song_02"
        await director.nothing("setlist_jump")  # sequential cue
        await director.close()

    run(scenario())


def test_jump_song_emits_setlist_jump(leader):
    async def scenario():
        probe = await joined(leader)
        ack = await probe.command("JUMP_SONG", {"song_id": "song_07"})
        assert ack["accepted"] and ack["action_taken"] == "JUMP_SONG"
        st = ack["state"]
        assert st["status"] == "PLAYING" and st["bpm"] == 140 and st["bar_offset"] == 1
        assert st["anchor_ns"] >= st["leader_time_ns"] + START_LEAD_NS
        jump = await probe.next("setlist_jump")
        validate("setlist_jump", jump)
        assert jump["song_id"] == "song_07" and jump["order_index"] == 2
        assert jump["previous_song_id"] == "song_01" and jump["triggered_by"] == "director_mobile"
        missing = await probe.command("JUMP_SONG", {"song_id": "nope"})
        assert missing["reason"] == "out_of_range"
        await probe.close()

    run(scenario())


def test_pause_resume_bar_math(leader):
    leader.set_setlist([{"song_id": "fast", "title": "Rapida", "bpm": 240}])  # bar = 1 s

    async def scenario():
        probe = await joined(leader)
        play = await probe.command("PLAY")
        anchor = play["state"]["anchor_ns"]
        await sleep_until_leader(anchor + 1_500_000_000)  # middle of bar 2
        pause = await probe.command("PAUSE")
        validate("command_ack", pause)
        st = pause["state"]
        assert st["status"] == "PAUSED" and st["anchor_ns"] is None
        beat_ns = 60e9 / 240
        k = math.floor((st["leader_time_ns"] - anchor) / beat_ns)
        assert st["paused_bar"] == 1 + k // 4
        assert st["paused_bar"] >= 2
        resume = await probe.command("RESUME")
        rs = resume["state"]
        assert rs["status"] == "PLAYING" and rs["paused_bar"] is None
        assert rs["bar_offset"] == st["paused_bar"] + 1
        assert rs["anchor_ns"] >= rs["leader_time_ns"] + START_LEAD_NS
        await probe.close()

    run(scenario())


def test_tempo_nudge_lands_on_bar_boundary_and_beacon(leader):
    async def scenario():
        probe = await joined(leader)
        play = await probe.command("PLAY")  # song_01, 120 bpm: bar = 2 s
        anchor = play["state"]["anchor_ns"]
        beacon = await probe.next("beat_beacon", timeout=3.0)  # first downbeat = anchor
        validate("beat_beacon", beacon)
        assert beacon["anchor_ns"] == anchor and beacon["bar_offset"] == 1
        assert beacon["state_version"] == play["state_version"]
        await sleep_until_leader(anchor + 300_000_000)
        nudge = await probe.command("TEMPO_NUDGE", {"delta_bpm": 1})
        validate("command_ack", nudge)
        st = nudge["state"]
        assert st["bpm"] == 121
        bar_old = 4 * 60e9 / 120
        bars = round((st["anchor_ns"] - anchor) / bar_old)
        assert bars >= 1
        assert abs(st["anchor_ns"] - (anchor + bars * bar_old)) <= 2  # on a bar boundary
        assert st["anchor_ns"] >= st["leader_time_ns"] + START_LEAD_NS
        assert st["anchor_ns"] - bar_old < st["leader_time_ns"] + START_LEAD_NS  # the first valid one
        assert st["bar_offset"] == 1 + bars
        high = await probe.command("TEMPO_NUDGE", {"delta_bpm": 999})
        assert high["state"]["bpm"] == 260
        bad = await probe.command("TEMPO_NUDGE", {"delta_bpm": "fast"})
        assert bad["reason"] == "out_of_range"
        await probe.close()

    run(scenario())


def test_stop_and_panic(leader):
    async def scenario():
        probe = await joined(leader)
        await probe.command("PLAY")
        stop = await probe.command("STOP")
        assert stop["state"]["status"] == "IDLE" and stop["state"]["anchor_ns"] is None
        assert stop["state"]["bar_offset"] == 1
        await probe.command("PLAY")
        panic = await probe.command("PANIC", origin="hub")
        st = panic["state"]
        assert st["status"] == "IDLE" and st["last_command"]["type"] == "PANIC"
        assert st["last_command"]["origin"] == "hub"
        await probe.close()

    run(scenario())


def test_follower_joined_and_left(leader):
    async def scenario():
        watcher = await joined(leader, alias="FOH", role="foh")
        teclas = Probe(leader, alias="Teclas", role="director")
        await teclas.connect()
        await teclas.join()
        ev = await watcher.next("follower_joined")
        while ev["client_id"] == watcher.client_id:  # the watcher's own join, if late
            ev = await watcher.next("follower_joined")
        validate("follower_joined", ev)
        assert (ev["client_id"], ev["alias"], ev["role"]) == (teclas.client_id, "Teclas", "director")
        sid = ev["sid"]
        await teclas.close()
        left = await watcher.next("follower_left")
        validate("follower_left", left)
        assert left == {"sid": sid, "client_id": teclas.client_id, "alias": "Teclas", "role": "director"}
        await watcher.close()

    run(scenario())


def test_clients_cannot_write_state(leader):
    async def scenario():
        probe = await joined(leader)
        await probe.sio.emit("broadcast_state", {"session_id": "default", "state": {"status": "PLAYING"}})
        await probe.nothing("state_update")
        assert leader.get_state()["status"] == "IDLE"
        await probe.close()

    run(scenario())


def test_local_laptop_command_reaches_followers(leader):
    async def scenario():
        probe = await joined(leader)
        result = await asyncio.get_running_loop().run_in_executor(
            None, leader.submit_local_command, "PLAY"
        )
        assert result.accepted
        update = await probe.next("state_update")
        assert update["status"] == "PLAYING"
        assert update["last_command"]["origin"] == "laptop_foh"
        await probe.close()

    run(scenario())


def test_stop_is_graceful_with_clients_connected():
    server = BandaitServer(ClockService(), host="127.0.0.1", port=0)
    assert server.start(), server.status_message

    async def scenario():
        probe = await joined(server)
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, server.stop)
        for _ in range(50):
            if not probe.sio.connected:
                break
            await asyncio.sleep(0.1)
        assert not probe.sio.connected
        await probe.close()

    run(scenario())
    assert server._thread is None and server.status == "stopped"
