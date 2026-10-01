"""One transport path: laptop buttons and remote commands both go
manager -> (queued Qt signal) -> ClockService -> AudioEngine, on the Qt thread."""

import asyncio
import threading
import uuid

import pytest
import socketio

from src.ui.main_window import MainWindow


@pytest.fixture
def window(qapp):
    # The GUI no longer seeds the database: opt in to the 3 demo songs.
    from src.db.seed import seed_database

    seed_database()
    win = MainWindow()
    yield win
    win.close()
    assert win.server._thread is None
    assert win.server.status == "stopped"


def test_services_start_and_setlist_is_live(window, qtbot):
    assert window.server.is_running(), window.server.status_message
    assert window.clock_service.is_running()
    state = window.server.get_state()
    assert len(state["setlist"]) == 3  # demo setlist (opted in) pushed into the server
    assert state["current_song_id"] == "song-001"
    assert "Audio: no disponible" in window.status_audio.text()  # disabled in tests, still visible


def test_laptop_play_goes_through_manager_clock_and_audio(window, qtbot):
    window.transport.play_btn.click()
    state = window.server.get_state()
    assert state["status"] == "PLAYING"
    assert state["last_command"]["origin"] == "laptop_foh"
    qtbot.waitUntil(lambda: window.clock_service.status == "PLAYING", timeout=3000)
    assert window.audio_engine._schedule, "AudioEngine did not receive the schedule"
    assert window.audio_engine._schedule[-1].anchor_ns == state["anchor_ns"]
    qtbot.waitUntil(lambda: window.transport.play_btn.isChecked(), timeout=3000)
    # Pressing play again pauses (the button shows the leader's state).
    window.transport.play_btn.click()
    assert window.server.get_state()["status"] == "PAUSED"
    qtbot.waitUntil(lambda: window.clock_service.status == "PAUSED", timeout=3000)
    assert window.audio_engine._schedule == ()


def test_stage_controls_send_cue_and_panic(window, qtbot):
    window.stage_view.next_btn.click()
    assert window.server.get_state()["current_song_id"] == "song-002"
    # The UI sends expected_song_id from what it displays: wait for the mirror.
    qtbot.waitUntil(lambda: window.clock_service.session_state["current_song_id"] == "song-002", timeout=3000)
    window.stage_view.prev_btn.click()
    assert window.server.get_state()["current_song_id"] == "song-001"
    window.transport.play_btn.click()
    qtbot.waitUntil(lambda: window.clock_service.status == "PLAYING", timeout=3000)
    window.stage_view.panic_btn.click()
    st = window.server.get_state()
    assert st["status"] == "IDLE" and st["last_command"]["type"] == "PANIC"


def test_remote_command_is_marshalled_into_the_qt_thread(window, qtbot):
    applied_on = []
    window.clock_service.session_state_changed.connect(
        lambda _s: applied_on.append(threading.current_thread() is threading.main_thread())
    )
    port = window.server.port
    result = {}

    def phone():
        async def go():
            sio = socketio.AsyncClient(reconnection=False)
            await sio.connect(f"http://127.0.0.1:{port}", transports=["websocket"], wait_timeout=5)
            result["ack"] = await sio.call(
                "control_command",
                {"session_id": "default", "command_id": str(uuid.uuid4()), "type": "PLAY",
                 "origin": "director_mobile", "sender_id": "phone", "payload": {}},
                timeout=5,
            )
            await sio.disconnect()

        asyncio.run(asyncio.wait_for(go(), 15))

    t = threading.Thread(target=phone)
    t.start()
    qtbot.waitUntil(lambda: not t.is_alive(), timeout=20000)
    assert result["ack"]["accepted"] is True
    qtbot.waitUntil(lambda: window.clock_service.status == "PLAYING", timeout=3000)
    assert applied_on and all(applied_on)
    assert window.audio_engine._schedule


def test_no_dead_menu_actions(window):
    from PySide6.QtCore import QMetaMethod  # noqa: F401

    dead = []
    for menu_action in window.menuBar().actions():
        for action in menu_action.menu().actions():
            if action.isSeparator():
                continue
            meta = action.metaObject()
            signal = meta.method(meta.indexOfSignal("triggered(bool)"))
            connected = action.isSignalConnected(signal)
            if action.isEnabled() and not connected:
                dead.append(action.text())
            if not action.isEnabled():
                assert "no disponible" in action.text()
    assert dead == []


def test_audio_dialog_choice_is_applied_and_persisted(window, tmp_path):
    from src.core.leader_config import load_settings
    from src.ui.dialogs.audio_devices import AudioDeviceChoice

    choice = AudioDeviceChoice(
        device_id=window.audio_engine.device, device_name="Interfaz X", hostapi="ASIO",
        drummer_click=False, pa_click=True, enable_asio=True,
    )
    window.apply_audio_choice(choice)
    assert window.audio_engine.enable_pa_click is True
    assert window.audio_engine.enable_drummer_click is False
    saved = load_settings()
    assert (saved.audio_output_device_name, saved.audio_output_hostapi) == ("Interfaz X", "ASIO")
    assert saved.pa_click_enabled and not saved.drummer_click_enabled and saved.enable_asio
