"""BandaitServer unit-level checks (no network traffic)."""

import socket

import pytest

from src.network.server import BandaitServer
from src.sync.clock_service import ClockService


@pytest.fixture
def server():
    clock = ClockService(mode="leader")
    srv = BandaitServer(clock, host="127.0.0.1", port=14040)
    yield srv
    srv.stop()


def test_server_creation(server):
    assert server.host == "127.0.0.1"
    assert server.port == 14040
    assert server.get_url() == "http://127.0.0.1:14040"
    assert server.status == "stopped"


def test_broadcast_state_event_is_gone(server):
    handlers = server._sio.handlers.get("/", {})
    assert "broadcast_state" not in handlers
    for event in ("join_session", "sync_request", "control_command", "connect", "disconnect"):
        assert event in handlers


def test_initial_state_is_contract_shaped(server):
    state = server.get_state()
    assert state["protocol_version"] == 3
    assert state["status"] == "IDLE"
    assert isinstance(state["leader_time_ns"], int)


def test_port_busy_is_reported_not_raised():
    blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        blocker.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    port = blocker.getsockname()[1]
    statuses = []
    try:
        srv = BandaitServer(ClockService(), host="127.0.0.1", port=port)
        srv.signals.status_changed.connect(lambda s, m: statuses.append((s, m)))
        assert srv.start() is False
        assert srv.status == "error"
        assert "ocupado" in srv.status_message
        assert statuses[-1][0] == "error"
        assert srv._thread is None
        srv.stop()
    finally:
        blocker.close()


def test_start_stop_restart_ephemeral_port():
    srv = BandaitServer(ClockService(), host="127.0.0.1", port=0)
    assert srv.start(), srv.status_message
    first_id = srv.get_state()["leader_instance_id"]
    first_version = srv.get_state()["state_version"]
    first_port = srv.port
    assert first_port > 0 and srv.is_running()
    thread = srv._thread
    srv.stop()
    assert not thread.is_alive()
    assert srv.status == "stopped"
    assert srv.start(), srv.status_message
    # Same process: same instance id, versions keep increasing across a restart.
    assert srv.get_state()["leader_instance_id"] == first_id
    assert srv.get_state()["state_version"] >= first_version
    srv.stop()
    assert srv.status == "stopped"


def test_slow_start_is_not_killed(monkeypatch):
    """Regression (2026-09-30): on a loaded laptop uvicorn took >5 s to come up and
    start() shut the server down, leaving the band without sync. A slow start must
    stay alive and report "running" once uvicorn is listening."""
    import time

    import src.network.server as server_mod

    monkeypatch.setattr(server_mod, "_START_TIMEOUT_S", 0.0)
    srv = BandaitServer(ClockService(), host="127.0.0.1", port=0)
    statuses = []
    srv.signals.status_changed.connect(lambda s, m: statuses.append(s))
    try:
        assert srv.start() is True
        assert srv._thread is not None and srv._thread.is_alive()
        deadline = time.monotonic() + 15
        while srv.status != "running" and time.monotonic() < deadline:
            time.sleep(0.05)
        assert srv.status == "running", srv.status_message
        assert "error" not in statuses
    finally:
        srv.stop()
    assert srv.status == "stopped"
