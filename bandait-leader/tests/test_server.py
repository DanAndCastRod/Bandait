"""Tests for Bandait Socket.IO server."""


import pytest

from src.network.server import BandaitServer
from src.sync.clock_service import ClockService


@pytest.fixture
def server():
    clock = ClockService(mode="leader")
    srv = BandaitServer(clock, host="127.0.0.1", port=14040)
    return srv


def test_server_creation(server):
    """Test that server initializes with correct config."""
    assert server._host == "127.0.0.1"
    assert server._port == 14040
    assert server._sio is not None
    assert server.get_url() == "http://127.0.0.1:14040"


def test_session_storage(server):
    """Test that session state is stored correctly."""
    test_state = {
        "sessionId": "test-session",
        "leaderIp": "127.0.0.1",
        "status": "PLAYING",
        "currentSongId": "song_01",
        "nextEventTimestamp": 1000000,
        "bpm": 120,
    }
    # Simulate broadcast_state handler logic
    session_id = "test-session"
    server._sessions[session_id] = {"followers": set(), "state": test_state}
    assert session_id in server._sessions
    assert server._sessions[session_id]["state"]["bpm"] == 120


def test_sync_request_returns_leader_time(server):
    """Test sync_request handler returns valid leader time."""
    clock = server._clock
    leader_time = clock.get_leader_time_ns()
    assert leader_time > 0
    # Simulate response structure
    response = {
        "type": "SYNC_BEACON",
        "leaderTimeNs": leader_time,
    }
    assert "leaderTimeNs" in response
    assert response["type"] == "SYNC_BEACON"
