"""Cloud account in the desktop leader: menu, status bar, startup sync in the
background, offline copy, revoked session and the live-setlist rules."""

import json
import re
import time
from pathlib import Path

import pytest

from src.cloud.auth import CloudUser, SessionStore
from src.cloud.controller import CloudController, format_cloud_status
from src.cloud.workspace import WorkspaceSnapshot, parse_workspace, save_cache
from src.core.leader_config import (
    DEFAULT_SUPABASE_KEY,
    DEFAULT_SUPABASE_URL,
    LeaderSettings,
    load_settings,
    resolve_cloud_config,
    save_settings,
)
from src.core.paths import cloud_workspace_cache_path

FIXTURE = Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "workspace_v2.json"
SONG_1 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a01"
SONG_2 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a02"
CLOUD_SETLIST = "cloud:band_01:pl_01"


def fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def seed_session(fake):
    """A saved session, as left by a previous login on this laptop."""
    _access, refresh = fake.issue()
    user = CloudUser(id=fake.user["id"], email=fake.user["email"], name="Músico de Prueba")
    assert SessionStore().save(refresh, user)
    return user


def choose_show(user_id):
    save_settings(LeaderSettings(cloud_band_id="band_01", cloud_user_id=user_id, active_setlist_id=CLOUD_SETLIST))


@pytest.fixture
def make_window(qapp):
    windows = []

    def make():
        from src.ui.main_window import MainWindow

        win = MainWindow()
        windows.append(win)
        return win

    yield make
    for win in windows:
        win.close()
        assert not win.cloud.sync_running() and not win.cloud.login_running()


# --------------------------------------------------------------------------- config
def test_supabase_config_defaults_env_and_secret_rejection(monkeypatch):
    monkeypatch.delenv("BANDAIT_SUPABASE_URL")
    monkeypatch.delenv("BANDAIT_SUPABASE_KEY")
    cfg = resolve_cloud_config(LeaderSettings())
    assert (cfg.url, cfg.key, cfg.source) == (DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_KEY, "default")
    cfg = resolve_cloud_config(LeaderSettings(supabase_url="https://otro.supabase.co/", supabase_key="sb_publishable_o"))
    assert (cfg.url, cfg.key, cfg.source) == ("https://otro.supabase.co", "sb_publishable_o", "config")
    monkeypatch.setenv("BANDAIT_SUPABASE_URL", "https://env.supabase.co")
    monkeypatch.setenv("BANDAIT_SUPABASE_KEY", "sb_secret_nunca")
    cfg = resolve_cloud_config(LeaderSettings(supabase_key="sb_publishable_o"))
    assert cfg.url == "https://env.supabase.co" and cfg.key == "sb_publishable_o"  # secret ignored
    monkeypatch.setenv("BANDAIT_SUPABASE_URL", "http://inseguro.example")
    assert resolve_cloud_config(LeaderSettings()).url == DEFAULT_SUPABASE_URL
    # a service_role JWT is refused like the hub does
    import base64

    payload = base64.urlsafe_b64encode(json.dumps({"role": "service_role"}).encode()).decode().rstrip("=")
    monkeypatch.setenv("BANDAIT_SUPABASE_KEY", f"eyJhbGciOiJIUzI1NiJ9.{payload}.firma")
    assert resolve_cloud_config(LeaderSettings()).key == DEFAULT_SUPABASE_KEY
    saved = LeaderSettings(cloud_band_id="b", cloud_user_id="u", supabase_url="https://x.supabase.co")
    save_settings(saved)
    assert load_settings() == saved


def test_status_text_formats():
    user = CloudUser(id="u", email="a@b.c")
    assert format_cloud_status(None, None)[0] == "NUBE: sin sesión"
    assert format_cloud_status(None, None, revoked_message="x")[0] == "NUBE: sesión cerrada"
    ws = parse_workspace(fixture())
    cloud = WorkspaceSnapshot(ws, "cloud", "u", "a@b.c", None, "2026-10-01T15:04:00+00:00")
    text, _color, _tip = format_cloud_status(user, cloud)
    assert text.startswith("NUBE: a@b.c // sincronizado ") and len(text.rsplit(" ", 1)[1]) == 5
    cache = WorkspaceSnapshot(ws, "cache", "u", "a@b.c", None, "2026-09-30T20:00:00+00:00", error="Sin red")
    text, _color, tip = format_cloud_status(user, cache)
    assert re.fullmatch(r"SIN CONEXION // copia del \d\d/\d\d/2026 \d\d:\d\d", text)
    assert "Sin red" in tip


# --------------------------------------------------------------------------- window
def test_account_menu_and_status_when_signed_out(make_window):
    win = make_window()
    assert [a.text() for a in win.menuBar().actions()].count("&Cuenta") == 1
    assert [a.text() for a in win.account_menu.actions()] == ["Iniciar sesión con &Google"]
    assert win.status_cloud.text() == "NUBE: sin sesión"
    win._cloud_sync_now()  # pressed at the wrong time: message, no crash, no thread
    assert not win.cloud.sync_running()
    assert "inicia sesión" in win.status_bar.currentMessage()


def test_startup_sync_runs_in_background_and_loads_the_chosen_setlist(make_window, qtbot, fake_supabase):
    import threading

    fake_supabase.workspace = fixture()
    user = seed_session(fake_supabase)
    choose_show(user.id)
    # Hold the workspace read until the window exists: if startup waited on the
    # network, make_window() would never return before the gate opens.
    fake_supabase.rest_gate = threading.Event()
    try:
        win = make_window()
        # the local setlist is live at once; the cloud one arrives when the sync ends
        assert win.server.get_state()["setlist"]
        assert "sincronizado" not in win.status_cloud.text()
    finally:
        fake_supabase.rest_gate.set()
    qtbot.waitUntil(lambda: "sincronizado" in win.status_cloud.text(), timeout=30000)
    assert win.status_cloud.text().startswith("NUBE: musico@example.com // sincronizado ")
    qtbot.waitUntil(lambda: win._live_setlist_id == CLOUD_SETLIST, timeout=5000)
    state = win.server.get_state()
    assert [e["song_id"] for e in state["setlist"]] == [SONG_1, SONG_2]
    assert [e["transition_mode"] for e in state["setlist"]] == ["manual_cue", "auto_count_in"]
    # wave 2 data rides on the entries kept by the window
    assert win._live_entries[0]["total_bars"] == 24 and win._live_entries[1]["gap_sec"] == 3.0
    assert CLOUD_SETLIST in win.library_view.setlist_ids()
    assert [a.text() for a in win.account_menu.actions() if not a.isSeparator()] == [
        "&Sincronizar ahora", "Elegir &banda...", "Elegir se&tlist...", "&Cerrar sesión (musico@example.com)"]
    assert fake_supabase.rest_writes == []


def test_offline_startup_uses_the_cached_copy(make_window, qtbot, fake_supabase):
    user = seed_session(fake_supabase)
    choose_show(user.id)
    save_cache(cloud_workspace_cache_path(), user_id=user.id, email=user.email, raw=fixture(),
               updated_at=None, fetched_at="2026-09-30T20:00:00+00:00")
    fake_supabase.stop()  # no Internet at the venue
    win = make_window()
    qtbot.waitUntil(lambda: win.status_cloud.text().startswith("SIN CONEXION // copia del "), timeout=20000)
    qtbot.waitUntil(lambda: win._live_setlist_id == CLOUD_SETLIST, timeout=5000)
    assert [e["song_id"] for e in win.server.get_state()["setlist"]] == [SONG_1, SONG_2]
    assert win.cloud.is_signed_in()  # offline is not a sign-out


def test_revoked_session_at_startup_signs_out_with_a_message(make_window, qtbot, fake_supabase):
    fake_supabase.workspace = fixture()
    seed_session(fake_supabase)
    fake_supabase.revoke_all()
    win = make_window()
    qtbot.waitUntil(lambda: win.status_cloud.text() == "NUBE: sesión cerrada", timeout=15000)
    assert not win.cloud.is_signed_in()
    assert "Inicia sesión de nuevo" in win.status_cloud.toolTip()
    assert [a.text() for a in win.account_menu.actions()] == ["Iniciar sesión con &Google"]
    assert SessionStore().load() is None


def test_sync_while_playing_waits_for_stop(make_window, qtbot, fake_supabase):
    fake_supabase.workspace = fixture()
    user = seed_session(fake_supabase)
    choose_show(user.id)
    win = make_window()
    qtbot.waitUntil(lambda: win._live_setlist_id == CLOUD_SETLIST, timeout=15000)
    win.send_command("PLAY")
    assert win.server.get_state()["status"] == "PLAYING"
    raw = fixture()
    items = raw["playlistsMap"]["band_01"][0]["songs"]
    items[0]["orderIndex"], items[1]["orderIndex"] = 1, 0  # reordered in the hub during the show
    fake_supabase.workspace = raw
    win._cloud_sync_now()
    qtbot.waitUntil(lambda: not win.cloud.sync_running() and win._pending_live_setlist == CLOUD_SETLIST,
                    timeout=15000)
    assert [e["song_id"] for e in win.server.get_state()["setlist"]] == [SONG_1, SONG_2]  # untouched
    win.send_command("STOP")
    qtbot.waitUntil(lambda: [e["song_id"] for e in win.server.get_state()["setlist"]] == [SONG_2, SONG_1],
                    timeout=5000)
    assert win._pending_live_setlist is None


def test_sign_out_keeps_the_show_and_revokes_remotely(make_window, qtbot, fake_supabase, monkeypatch):
    fake_supabase.workspace = fixture()
    user = seed_session(fake_supabase)
    choose_show(user.id)
    win = make_window()
    qtbot.waitUntil(lambda: win._live_setlist_id == CLOUD_SETLIST, timeout=15000)
    from PySide6.QtWidgets import QMessageBox

    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.Yes)
    win._cloud_logout()
    assert win.status_cloud.text() == "NUBE: sin sesión"
    assert SessionStore().load() is None
    qtbot.waitUntil(lambda: fake_supabase.logged_out == ["local"], timeout=10000)
    assert [e["song_id"] for e in win.server.get_state()["setlist"]] == [SONG_1, SONG_2]


# --------------------------------------------------------------------------- controller
def test_controller_login_then_sync(qapp, qtbot, fake_supabase, fake_browser, tmp_path):
    fake_supabase.workspace = fixture()
    db = str(tmp_path / "c.db")
    ctl = CloudController(LeaderSettings(), open_browser=fake_browser, login_ports=(0,), login_timeout=10,
                          db_path=lambda: db, cache_path=lambda: str(tmp_path / "w.json"))
    try:
        with qtbot.waitSignal(ctl.login_finished, timeout=15000) as login:
            assert ctl.start_login()
        result = login.args[0]
        assert result.ok and result.user.email == "musico@example.com" and result.persisted
        with qtbot.waitSignal(ctl.sync_finished, timeout=15000) as sync:
            assert ctl.start_sync(None, user_initiated=True)
            assert not ctl.start_sync(None)  # a second press while running is ignored
        outcome = sync.args[0]
        assert outcome.ok and outcome.band_id == "band_01" and outcome.source == "cloud"
        assert outcome.report.setlist_ids == {"pl_01": CLOUD_SETLIST}
    finally:
        ctl.shutdown()


def test_controller_drops_results_after_sign_out(qapp, qtbot, fake_supabase, tmp_path):
    fake_supabase.workspace = fixture()
    seed_session(fake_supabase)
    ctl = CloudController(LeaderSettings(), db_path=lambda: str(tmp_path / "c.db"),
                          cache_path=lambda: str(tmp_path / "w.json"))
    try:
        assert ctl.restore() is not None
        received = []
        ctl.sync_finished.connect(received.append)
        assert ctl.start_sync("band_01")
        ctl.sign_out()  # pressed while the download is in flight
        qtbot.waitUntil(lambda: not ctl.sync_running(), timeout=15000)
        qtbot.wait(200)
        assert received == [] and ctl.last_snapshot is None
    finally:
        ctl.shutdown()
