"""Library controls of the leader: every visible control does something.

- Every button style the code uses exists in the stylesheet the app loads (2.1.1
  shipped buttons that rendered as plain text because it did not).
- Nothing says "no disponible": unfinished controls are hidden, not disabled.
- Songs, setlists and events are created, edited and deleted from the library;
  hub rows answer with where they are edited; deletions say what is lost.
- The live setlist is never changed or deleted under a song that is playing.
"""

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from PySide6.QtWidgets import QAbstractButton, QAbstractSlider, QComboBox, QPushButton

from src.cloud.workspace import parse_workspace
from src.core.paths import get_db_path
from src.db import library_ops as ops
from src.db.cloud_import import import_band
from src.db.models import Gig, Setlist, Song, init_db
from src.db.seed import seed_database

ROOT = Path(__file__).resolve().parents[1]
QSS = ROOT / "src" / "styles" / "bandait_dark.qss"
FIXTURE = ROOT.parent / "bandait-protocol" / "fixtures" / "workspace_v2.json"
SONG_1 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a01"
CLOUD_SETLIST = "cloud:band_01:pl_01"


def hub_band():
    with open(FIXTURE, encoding="utf-8") as fh:
        return parse_workspace(json.load(fh)).band("band_01")


def connected(obj, *signatures) -> bool:
    meta = obj.metaObject()
    for sig in signatures:
        index = meta.indexOfSignal(sig)
        if index >= 0 and obj.isSignalConnected(meta.method(index)):
            return True
    return False


# ------------------------------------------------------------------ stylesheet

def test_every_button_style_used_in_code_exists_in_the_loaded_stylesheet():
    qss = QSS.read_text(encoding="utf-8")
    base = re.search(r"(?m)^QPushButton \{([^}]*)\}", qss)
    assert base and "border:" in base.group(1) and "background-color:" in base.group(1)
    assert re.search(r"(?m)^QPushButton:disabled \{", qss)
    names = set()
    for path in (ROOT / "src" / "ui").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        buttons = set(re.findall(r"([\w.]+)\s*=\s*QPushButton\(", text))
        for var, name in re.findall(r'([\w.]+)\.setObjectName\("(\w+)"\)', text):
            if var in buttons:
                names.add(name)
        names.update(n for n in re.findall(r'_button\([^,()]+,\s*"(\w*)"', text) if n)
    assert {"primary", "danger", "success"} <= names  # the scan found the library buttons
    missing = sorted(n for n in names if f"QPushButton#{n}" not in qss)
    assert missing == [], f"objectName sin regla en bandait_dark.qss: {missing}"


# ------------------------------------------------------------------ whole window

@pytest.fixture
def window(qapp):
    seed_database()
    from src.ui.main_window import MainWindow

    win = MainWindow()
    win.show()
    yield win
    win.close()


def _all_pages(win):
    """Every main tab and every library sub-tab, so hidden pages are checked too."""
    for i in range(win.tabs.count()):
        win.tabs.setCurrentIndex(i)
        if win.tabs.widget(i) is win.library_view:
            for j in range(win.library_view.tabs.count()):
                win.library_view.tabs.setCurrentIndex(j)
                yield
        else:
            yield


def test_no_control_without_a_function(window):
    problems = []
    for w in window.findChildren(QAbstractButton) + window.findChildren(QAbstractSlider) \
            + window.findChildren(QComboBox):
        words = (w.toolTip() + " " + (w.text() if isinstance(w, QAbstractButton) else "")).lower()
        if "no disponible" in words:
            problems.append(f"'no disponible': {type(w).__name__} {words.strip()!r}")
    for _ in _all_pages(window):
        for b in window.findChildren(QPushButton):
            if not b.isVisibleTo(window):
                continue
            if not connected(b, "clicked()", "clicked(bool)", "toggled(bool)", "pressed()", "released()"):
                problems.append(f"sin acción: {b.text()!r}")
            if not b.isEnabled() and not b.toolTip().startswith("Selecciona"):
                problems.append(f"deshabilitado sin motivo visible: {b.text()!r} ({b.toolTip()!r})")
    assert problems == []
    assert window.transport.loop_btn.isHidden()
    assert all(ch.pan_slider.isHidden() for ch in window.mixer.channels)


def test_file_menu_actions_open_the_library_editors(window, monkeypatch):
    lv = window.library_view
    opened = []
    monkeypatch.setattr(lv, "_run_dialog", lambda dialog: opened.append(type(dialog).__name__) or False)
    window.tabs.setCurrentIndex(0)
    window.action_new_setlist.trigger()
    assert window.tabs.currentWidget() is lv and lv.tabs.currentIndex() == 1
    window.action_new_song.trigger()
    assert lv.tabs.currentIndex() == 0
    window.action_new_gig.trigger()
    assert lv.tabs.currentIndex() == 2
    assert opened == ["SetlistEditorDialog", "SongEditorDialog", "GigEditorDialog"]


# ------------------------------------------------------------------ library view

@pytest.fixture
def view(qapp, monkeypatch):
    from src.ui.views.library_view import LibraryView

    seed_database()
    import_band(get_db_path(), hub_band())
    v = LibraryView()
    v.confirms, v.infos, v.fails, v.dialogs = [], [], [], []
    v.answer = True
    v.fill = None  # callable(dialog) that types into the dialog; None = Cancelar
    monkeypatch.setattr(v, "_confirm", lambda title, text, verb: v.confirms.append((title, text, verb)) or v.answer)
    monkeypatch.setattr(v, "_inform", lambda title, text: v.infos.append(text))
    monkeypatch.setattr(v, "_fail", lambda what, e: v.fails.append(str(e)))

    def run(dialog):
        v.dialogs.append(dialog)
        if v.fill is None:
            return False
        v.fill(dialog)
        return dialog.try_accept()

    monkeypatch.setattr(v, "_run_dialog", run)
    yield v
    assert v.fails == []
    v.close()


def db():
    return init_db(get_db_path())()


def test_song_buttons_follow_the_selection(view):
    view.songs_table.clearSelection()
    assert not view.edit_song_btn.isEnabled() and not view.delete_song_btn.isEnabled()
    assert view.edit_song_btn.toolTip() == "Selecciona una canción"
    assert view.new_song_btn.isEnabled() and view.import_btn.isEnabled()
    assert view.select_song("song-002")
    assert view.edit_song_btn.isEnabled() and view.delete_song_btn.isEnabled()
    assert view.select_song(SONG_1)
    assert "hub" in view.edit_song_btn.toolTip()


def test_new_song_from_the_button(view):
    saved = []
    view.song_saved.connect(saved.append)

    def fill(d):
        d.title_edit.setText("Carretera")
        d.artist_edit.setText("La Ruta")
        d.bpm_spin.setValue(92)
        d.meter_combo.setCurrentText("6/8")
        d.key_edit.setText("D")
        d.duration_edit.setText("3:45")
        d.text_edit.setPlainText("[Am]Cruzamos la [F]noche")

    view.fill = fill
    view.new_song_btn.click()
    assert len(saved) == 1 and view.selected_song_id() == saved[0]
    song = db().get(Song, saved[0])
    assert (song.title, song.bpm, song.beats_per_bar, song.beat_unit, song.duration_seconds, song.source) == \
        ("Carretera", 92, 6, 8, 225, "local")
    assert song.lyrics_text == "Cruzamos la noche" and view.song_origin_of(song.id) == "local"


def test_cancel_writes_nothing(view):
    before = view.song_ids()
    view.new_song_btn.click()  # fill is None: Cancelar
    assert view.song_ids() == before and len(view.dialogs) == 1


def test_song_editor_stays_open_with_the_error(qapp):
    from src.ui.dialogs.library_editors import SongEditorDialog

    d = SongEditorDialog()
    assert not d.try_accept()
    assert d.error_label.text() == "Escribe el título de la canción." and not d.error_label.isHidden()
    d.title_edit.setText("X")
    d.duration_edit.setText("3.45")
    assert not d.try_accept() and "mm:ss" in d.error_label.text()
    d.duration_edit.setText("3:45")
    assert d.try_accept() and d.error_label.isHidden()


def test_edit_a_local_song(view):
    view.select_song("song-002")
    seen = []

    def fill(d):
        seen.append(d.title_edit.text())
        d.title_edit.setText("Ritmo de Calle (en vivo)")
        d.bpm_spin.setValue(140)

    view.fill = fill
    view.edit_song_btn.click()
    assert seen == ["Ritmo de Calle"]
    song = db().get(Song, "song-002")
    assert (song.title, song.bpm, song.source) == ("Ritmo de Calle (en vivo)", 140, "local")


def test_hub_song_explains_where_it_is_edited(view):
    view.select_song(SONG_1)
    view.edit_song_btn.click()
    view.delete_song_btn.click()
    assert view.infos == [ops.CLOUD_SONG_EDIT, ops.CLOUD_SONG_DELETE]
    assert view.dialogs == [] and view.confirms == []
    assert db().get(Song, SONG_1) is not None


def test_delete_song_says_which_setlists_lose_it(view):
    removed = []
    view.song_removed.connect(removed.append)
    view.select_song("song-002")
    view.answer = False
    view.delete_song_btn.click()
    assert db().get(Song, "song-002") is not None  # Cancelar
    view.answer = True
    view.select_song("song-002")
    view.delete_song_btn.click()
    title, text, verb = view.confirms[-1]
    assert verb == "Borrar canción" and "Set de Ensayo - Mayo 2026" in text and "No se puede deshacer" in text
    assert db().get(Song, "song-002") is None and "song-002" not in view.song_ids()
    assert removed == ["song-002"]
    assert view.setlists_table.item(view.setlist_ids().index("setlist-001"), 1).text() == "2"


def test_new_edit_and_delete_setlist(view):
    saved, removed = [], []
    view.setlist_saved.connect(saved.append)
    view.setlist_removed.connect(removed.append)

    def fill_new(d):
        d.name_edit.setText("Viernes 21:00")
        for row in range(d.available_list.count()):
            d.available_list.item(row).setSelected(d.available_list.item(row).data(256) in ("song-003", SONG_1))
        d.add_selected()
        assert d.song_ids()[0] in ("song-003", SONG_1) and len(d.song_ids()) == 2

    view.fill = fill_new
    view.new_setlist_btn.click()
    new_id = saved[-1]
    assert view.selected_setlist_id() == new_id and view.setlist_origin_of(new_id) == "local"
    first, second = ops.setlist_song_ids(db(), new_id)

    def fill_edit(d):
        d.setlist_list.setCurrentRow(1)
        d.move_selected(-1)  # swap

    view.fill = fill_edit
    view.edit_setlist_btn.click()
    assert ops.setlist_song_ids(db(), new_id) == [second, first]

    s = db()
    ops.create_gig(s, ops.GigFields(name="Bar", date=datetime.now() + timedelta(days=1), setlist_id=new_id))
    view.reload()
    view.select_setlist(new_id)
    view.delete_setlist_btn.click()
    _title, text, verb = view.confirms[-1]
    assert verb == "Borrar setlist" and "1 evento queda sin setlist" in text and "siguen en la biblioteca" in text
    assert db().get(Setlist, new_id) is None and removed == [new_id]


def test_hub_setlist_is_read_only_but_duplicates_into_a_local_copy(view):
    view.select_setlist(CLOUD_SETLIST)
    view.edit_setlist_btn.click()
    view.delete_setlist_btn.click()
    assert view.infos == [ops.CLOUD_SETLIST_EDIT, ops.CLOUD_SETLIST_DELETE] and view.dialogs == []
    view.duplicate_setlist_btn.click()
    copy_id = view.selected_setlist_id()
    assert copy_id != CLOUD_SETLIST and view.setlist_origin_of(copy_id) == "local"
    assert ops.setlist_song_ids(db(), copy_id) == ops.setlist_song_ids(db(), CLOUD_SETLIST)


def test_events_new_filter_load_and_delete(view):
    activated = []
    view.setlist_activated.connect(activated.append)
    view.tabs.setCurrentIndex(2)

    def fill(d):
        d.name_edit.setText("Bar La Ruta")
        d.venue_edit.setText("Pereira")
        d.setlist_combo.setCurrentIndex(d.setlist_combo.findData("setlist-001"))

    view.fill = fill
    view.new_gig_btn.click()
    gig_id = view.selected_gig_id()
    assert gig_id and view.events_table.item(view.gig_ids().index(gig_id), 4).text() == "PRÓXIMO"
    assert view.events_table.item(view.gig_ids().index(gig_id), 3).text() == "Set de Ensayo - Mayo 2026"
    assert view.upcoming_events.text() == "Próximos: 1"  # the demo gig is in the past

    view.event_filter.setCurrentIndex(3)  # Pasados
    assert gig_id not in view.gig_ids() and len(view.gig_ids()) == 1
    view.event_filter.setCurrentIndex(1)  # Próximos
    assert view.gig_ids() == [gig_id]

    view.select_gig(gig_id)
    view.load_gig_btn.click()
    assert activated == ["setlist-001"]

    view.fill = lambda d: d.setlist_combo.setCurrentIndex(0)  # Sin setlist
    view.edit_gig_btn.click()
    view.select_gig(gig_id)
    view.load_gig_btn.click()
    assert view.infos == ["Este evento no tiene setlist: edítalo y elige uno."] and activated == ["setlist-001"]

    view.delete_gig_btn.click()
    assert view.confirms[-1][2] == "Borrar evento" and db().get(Gig, gig_id) is None


# ------------------------------------------------------------------ live setlist safety

@pytest.fixture
def live(qapp, monkeypatch):
    """MainWindow with the demo setlist live and the library dialogs scripted."""
    seed_database()
    from src.ui.main_window import MainWindow

    win = MainWindow()
    lv = win.library_view
    lv.confirms, lv.infos = [], []
    monkeypatch.setattr(lv, "_confirm", lambda title, text, verb: lv.confirms.append(text) or True)
    monkeypatch.setattr(lv, "_inform", lambda title, text: lv.infos.append(text))
    lv.fill = None
    monkeypatch.setattr(lv, "_run_dialog", lambda d: bool(lv.fill) and (lv.fill(d) or d.try_accept()))
    assert win._live_setlist_id == "setlist-001"
    yield win
    win.send_command("STOP")
    win.close()


def live_ids(win):
    return [e["song_id"] for e in win.server.get_state()["setlist"]]


def test_load_in_live_while_playing_waits_for_stop(live, qtbot):
    s = db()
    other = ops.create_setlist(s, "Otro", ["song-003"])
    live.library_view.reload()
    live.send_command("PLAY")
    qtbot.waitUntil(lambda: live.clock_service.status == "PLAYING", timeout=5000)
    live.library_view.select_setlist(other.id)
    live.library_view.load_setlist_btn.click()
    assert live._live_setlist_id == "setlist-001" and live._pending_live_setlist == other.id
    assert len(live_ids(live)) == 3  # nothing changed under the song
    live.send_command("STOP")
    qtbot.waitUntil(lambda: live._live_setlist_id == other.id, timeout=5000)
    assert live_ids(live) == ["song-003"]


def test_live_setlist_cannot_be_deleted_while_playing(live, qtbot):
    lv = live.library_view
    live.send_command("PLAY")
    qtbot.waitUntil(lambda: live.clock_service.status == "PLAYING", timeout=5000)
    lv.select_setlist("setlist-001")
    lv.delete_setlist_btn.click()
    assert lv.infos and "detenla antes de borrarlo" in lv.infos[-1] and lv.confirms == []
    lv.select_song("song-001")
    lv.delete_song_btn.click()
    assert "detenla antes de borrar una de sus canciones" in lv.infos[-1]
    assert db().get(Setlist, "setlist-001") is not None and db().get(Song, "song-001") is not None
    live.send_command("STOP")
    qtbot.waitUntil(lambda: live._transport_idle(), timeout=5000)
    lv.select_setlist("setlist-001")
    lv.delete_setlist_btn.click()
    assert "Es el setlist en vivo" in lv.confirms[-1]
    assert live._live_setlist_id is None and live.server.get_state()["setlist"] == []


def test_editing_the_live_setlist_reaches_the_phones(live):
    lv = live.library_view
    lv.select_setlist("setlist-001")

    def reverse(d):
        ids = d.song_ids()
        d.setlist_list.clear()
        for sid in reversed(ids):
            d._append(sid)

    lv.fill = reverse
    lv.edit_setlist_btn.click()
    assert live_ids(live) == ["song-003", "song-002", "song-001"]

    lv.select_song("song-002")
    lv.fill = lambda d: d.bpm_spin.setValue(150)
    lv.edit_song_btn.click()
    entry = next(e for e in live.server.get_state()["setlist"] if e["song_id"] == "song-002")
    assert entry["bpm"] == 150
