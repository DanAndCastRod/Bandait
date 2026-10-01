"""Paint smoke tests (offscreen): every custom widget and the main window are
painted in the states the stage uses, so CI catches paint bugs (wrong QPainter
argument types, overflowing coordinates) before a show does.

Each test drives a widget through representative states and calls grab(),
repaint() and processEvents(). The paint guard turns any paint exception into a
counted failure; the fixture asserts that none happened and nothing was logged.
"""

import logging
import math

import pytest

from src.ui.widgets._paint import paint_failures, reset_paint_failures


@pytest.fixture(autouse=True)
def no_paint_failures(qapp, caplog):
    reset_paint_failures()
    caplog.set_level(logging.ERROR, logger="bandait.ui.paint")
    yield
    failures = paint_failures()
    logged = [r.getMessage() for r in caplog.records if r.name == "bandait.ui.paint"]
    reset_paint_failures()
    assert failures == {}, failures
    assert logged == []


def paint(widget, qapp, sizes=None):
    """grab + repaint + processEvents at each size; the widget must be shown."""
    for size in sizes or [None]:
        if size is not None:
            widget.resize(*size)
        pixmap = widget.grab()
        assert not pixmap.isNull()
        widget.repaint()
        qapp.processEvents()
    assert paint_failures() == {}, paint_failures()


def shown(qtbot, widget, size=(800, 300)):
    qtbot.addWidget(widget)
    widget.resize(*size)
    widget.show()
    return widget


# --------------------------------------------------------------------------- timeline
def test_timeline_states(qtbot, qapp):
    from src.ui.widgets.timeline import TimelineWidget

    tl = shown(qtbot, TimelineWidget())
    tl.set_bpm(120)
    tl.set_duration(180)
    paint(tl, qapp)  # no sections, playhead at 0
    for i, label in enumerate(["Intro", "Verso", "Pre-Coro", "Coro", "Puente", "Solo", "Outro",
                               "Una sección con un nombre larguísimo"]):
        tl.add_section(label, i * 16, 16)
    tl.add_section("x", 2, 0)  # zero-length section
    for seconds in (0.0, 45.0, 90.0, 179.9, 180.0, 10_000.0, -5.0):  # start / middle / end / beyond
        tl.set_position(seconds)
        paint(tl, qapp)
    tl._position = tl._duration * 3  # beyond, bypassing the setter's clamp
    paint(tl, qapp)
    tl.set_position(30.0)
    for _ in range(30):
        tl.zoom_in()
    paint(tl, qapp)
    for _ in range(60):
        tl.zoom_out()
    paint(tl, qapp)
    # garbage in (cloud data, a NaN from the clock): never a paint failure
    tl.set_bpm(None)
    tl.set_position(math.nan)
    tl.set_duration(math.inf)
    paint(tl, qapp)
    tl.set_bpm(300)
    tl.set_duration(24 * 3600)  # long song: only the visible beats are drawn
    tl.set_position(12 * 3600)
    paint(tl, qapp, sizes=[(800, 300), (10, 200), (2400, 260)])
    tl.start_playback()  # internal playhead timer
    qtbot.wait(120)
    tl.stop_playback()
    paint(tl, qapp)


# --------------------------------------------------------------------------- VU meter
def test_vu_meter_levels(qtbot, qapp):
    from src.ui.widgets.vu_meter import VUMeter

    vu = shown(qtbot, VUMeter("CH1"), size=(48, 240))
    db_to_level = {"-inf": 0.0, "-20": 40 / 60, "0": 1.0, "clip": 1.5}  # level 0..1 = -60..0 dB
    for _name, level in db_to_level.items():
        vu.set_level(level)
        paint(vu, qapp, sizes=[(36, 120), (48, 240), (48, 900)])
    for level in (float("-inf"), float("inf"), math.nan, -3, None, "basura"):
        vu.set_level(level)
        paint(vu, qapp)
    assert vu._level == 0.0  # garbage counts as silence
    vu.set_level(1.0)
    for _ in range(80):  # peak hold and decay
        vu._decay_peak()
    paint(vu, qapp)


# --------------------------------------------------------------------------- stage view
def test_stage_view_with_and_without_song(qtbot, qapp):
    from src.ui.main_window import EMPTY_SETLIST_NOTICE
    from src.ui.views.stage_view import StageView

    sv = shown(qtbot, StageView(), size=(1280, 720))
    paint(sv, qapp)  # no song
    sv.set_setlist_notice(EMPTY_SETLIST_NOTICE)
    paint(sv, qapp)
    assert sv.setlist_notice_text() == EMPTY_SETLIST_NOTICE
    sv.set_song("Medianoche en Pereira", "Las luces de la ciudad", "Se reflejan en tu piel", "Verso", "Coro")
    sv.set_lyrics([{"time": 0.0, "text": "Las luces"}, {"time": 5.0, "text": "de la ciudad"}])
    sv.set_bpm(124)
    sv.set_setlist_notice(None)
    for beat in (1, 2, 3, 4, 1):
        sv.set_beat(beat)
        sv.set_bar(17)
        paint(sv, qapp)
    sv.show_jump_alert("Desde Lejos", 2)
    sv.set_network_status(False)
    paint(sv, qapp, sizes=[(1280, 720), (640, 400), (1920, 1080)])
    sv.clear_beat()
    sv.set_bar(None)
    sv.set_song(title="Sin canción")
    paint(sv, qapp)


# --------------------------------------------------------------------------- transport / mixer
def test_transport_playing_and_stopped(qtbot, qapp):
    from src.ui.widgets.transport import TransportWidget

    tr = shown(qtbot, TransportWidget(), size=(1280, 90))
    for status in ("IDLE", "PLAYING", "PAUSED", "COUNTING", "IDLE"):
        tr.set_transport_status(status)
        tr.display_bpm(96.5 if status == "PLAYING" else 120)
        tr.set_time(3725.42 if status == "PLAYING" else 0.0)
        for beat in (1, 2, 3, 4):
            tr.set_beat(beat)
        paint(tr, qapp)
    tr.set_recording_state(True)
    tr.set_network_status(False, "Red caída")
    paint(tr, qapp)
    tr.set_recording_state(False)
    tr.clear_beat()
    paint(tr, qapp)


def test_mixer_strips_and_faders(qtbot, qapp):
    from src.ui.widgets.fader import FaderWidget
    from src.ui.widgets.mixer import ChannelStrip, MixerWidget

    mixer = shown(qtbot, MixerWidget(), size=(420, 600))
    for level in (0.0, 0.5, 1.0, 2.0):
        for ch in range(4):
            mixer.set_channel_level(ch, level)
        mixer.set_master_level(level)
        paint(mixer, qapp)
    strip = shown(qtbot, ChannelStrip(0, "Click"), size=(90, 500))
    strip.set_level(0.8)
    paint(strip, qapp)
    fader = shown(qtbot, FaderWidget("Vol"), size=(60, 300))
    for db in (-60.0, -12.0, 0.0, 6.0):
        fader.set_db(db)
        paint(fader, qapp)


# --------------------------------------------------------------------------- views / dialogs
def test_library_ai_and_pickers(qtbot, qapp):
    from src.db.seed import load_demo_data
    from src.ui.dialogs.account_select import BandSelectorDialog, SetlistSelectorDialog
    from src.ui.views.ai_view import AIView
    from src.ui.views.library_view import LibraryView

    lib = shown(qtbot, LibraryView(), size=(1000, 700))
    paint(lib, qapp)  # empty library
    load_demo_data()
    lib._load_songs_from_db()
    lib._load_setlists_from_db()
    for tab in range(lib.tabs.count()):
        lib.tabs.setCurrentIndex(tab)
        paint(lib, qapp)
    lib.set_cloud_mode(True)
    paint(lib, qapp)
    ai = shown(qtbot, AIView(), size=(900, 600))
    paint(ai, qapp)
    bands = shown(qtbot, BandSelectorDialog([{"id": "b", "name": "Banda", "genre": "", "songs": 0, "setlists": 1}]),
                  size=(460, 360))
    paint(bands, qapp)
    picker = shown(qtbot, SetlistSelectorDialog([{"id": "a", "name": "Al revés - Album", "songs": 0}]),
                   size=(460, 360))
    paint(picker, qapp)
    empty = shown(qtbot, SetlistSelectorDialog([]), size=(460, 360))
    paint(empty, qapp)


# --------------------------------------------------------------------------- main window
@pytest.fixture
def window(qapp):
    windows = []

    def make():
        from src.ui.main_window import MainWindow

        win = MainWindow()
        windows.append(win)
        win.resize(1600, 900)
        win.show()
        return win

    yield make
    for win in windows:
        win.close()


def test_main_window_without_songs(window, qapp):
    win = window()
    for tab in range(win.tabs.count()):
        win.tabs.setCurrentIndex(tab)
        paint(win, qapp)
    assert win.setlist_notice()  # no setlist: the notice is painted too


def test_main_window_playing_with_the_playhead_visible(window, qapp, qtbot):
    """The exact path of the 2026-10-01 crash: playback moves the timeline's
    playhead (visible only while playing) on the Mezcla tab."""
    from src.db.seed import seed_database

    seed_database()
    win = window()
    assert win.server.get_state()["setlist"]
    win.tabs.setCurrentIndex(1)  # Mezcla: timeline visible
    paint(win, qapp)
    win.send_command("PLAY")
    qtbot.waitUntil(lambda: win.clock_service.status == "PLAYING", timeout=5000)
    for _ in range(6):
        win._update_ui()
        win.timeline.set_position(win.timeline._duration / 2)
        paint(win.timeline, qapp)
        qtbot.wait(40)
    win._on_clock_beat(3, 1, 120.0)
    for tab in range(win.tabs.count()):
        win.tabs.setCurrentIndex(tab)
        paint(win, qapp)
    win.send_command("STOP")
    qtbot.waitUntil(lambda: win.clock_service.status == "IDLE", timeout=5000)
    paint(win, qapp)
