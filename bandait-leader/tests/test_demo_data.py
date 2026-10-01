"""Demo data: opt-in only, marked source='demo', removable in one action, and
never confused with the band's songs.

Background (2026-10-01): the GUI seeded every empty database with three demo
songs; a user whose chosen hub setlist was empty saw them and concluded that
the sync had failed.
"""

import glob
import json
import sqlite3
from pathlib import Path

import pytest
from PySide6.QtWidgets import QMessageBox

from src.cloud.workspace import parse_workspace
from src.core.paths import get_db_path
from src.db.cloud_import import import_band
from src.db.models import DEMO_SIGNATURES, Setlist, Song, init_db, load_setlist_entries, plan_demo_marks
from src.db.seed import count_demo_rows, demo_rows, load_demo_data, remove_demo_data, seed_database

FIXTURE = Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "workspace_v2.json"
SONG_1 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a01"
CLOUD_SETLIST = "cloud:band_01:pl_01"


def hub_band():
    with open(FIXTURE, encoding="utf-8") as fh:
        return parse_workspace(json.load(fh)).band("band_01")


def rows(db, sql, params=()):
    con = sqlite3.connect(db)
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def sources(db, table):
    return dict(rows(db, f"SELECT id, source FROM {table}"))


def make_pre_demo_db(db):
    """A database as left by 2.1.0: the seed rows with source 'local' and no
    ``source`` column in setlists, gigs and band_members."""
    load_demo_data(db)
    con = sqlite3.connect(db)
    try:
        con.execute("UPDATE songs SET source = 'local'")
        for table in ("setlists", "gigs", "band_members"):
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})") if r[1] != "source"]
            con.execute(f"CREATE TABLE {table}_old AS SELECT {', '.join(cols)} FROM {table}")
            con.execute(f"DROP TABLE {table}")
            con.execute(f"ALTER TABLE {table}_old RENAME TO {table}")
        con.commit()
    finally:
        con.close()


# --------------------------------------------------------------------------- seed
def test_seed_rows_are_demo_and_match_the_migration_signatures():
    for table, objects in demo_rows().items():
        label, signatures = DEMO_SIGNATURES[table]
        assert {o.id: getattr(o, label) for o in objects} == signatures
        assert {o.source for o in objects} == {"demo"}


def test_load_demo_data_is_idempotent_and_leaves_user_rows_alone(tmp_path):
    db = str(tmp_path / "b.db")
    Session = init_db(db)
    with Session() as s:  # the user already has a song with a demo id
        s.add(Song(id="song-001", title="Mi canción", bpm=100))
        s.commit()
    assert load_demo_data(db) == 2 + 1 + 1 + 3  # song-002/003, setlist, gig, 3 members
    assert load_demo_data(db) == 0
    assert sources(db, "songs") == {"song-001": "local", "song-002": "demo", "song-003": "demo"}
    with Session() as s:
        assert s.get(Song, "song-001").title == "Mi canción"
        assert [e["song_id"] for e in load_setlist_entries(s, "setlist-001")] == ["song-002", "song-003"]


# --------------------------------------------------------------------------- migration
def test_migration_marks_only_untouched_seed_rows_with_one_backup(tmp_path):
    db = str(tmp_path / "bandait.db")
    Session = init_db(db)
    with Session() as s:  # same title as a demo song, other id: the user's own
        s.add(Song(id="mine", title="Medianoche en Pereira", bpm=90))
        s.commit()
    Session.kw["bind"].dispose()
    make_pre_demo_db(db)
    con = sqlite3.connect(db)
    con.execute("UPDATE songs SET title = 'Ritmo de Calle (mi versión)' WHERE id = 'song-002'")  # renamed
    con.execute("UPDATE songs SET source = 'cloud' WHERE id = 'song-003'")  # a hub row: never demo
    con.execute("UPDATE band_members SET name = 'Ana' WHERE id = 'member-003'")
    con.commit()
    con.close()
    assert len(plan_demo_marks(db)) == 1 + 1 + 1 + 2  # song-001, setlist, gig, 2 members

    init_db(db)
    assert len(glob.glob(db + ".bak-*")) == 1  # one backup before ALTER + marks
    assert sources(db, "songs") == {"song-001": "demo", "song-002": "local", "song-003": "cloud", "mine": "local"}
    assert sources(db, "setlists") == {"setlist-001": "demo"}
    assert sources(db, "gigs") == {"gig-001": "demo"}
    assert sources(db, "band_members") == {"member-001": "demo", "member-002": "demo", "member-003": "local"}
    # the backup is the untouched original
    backup = glob.glob(db + ".bak-*")[0]
    assert dict(rows(backup, "SELECT id, source FROM songs"))["song-001"] == "local"
    # idempotent: nothing left to do, no second backup
    assert plan_demo_marks(db) == []
    init_db(db)
    assert len(glob.glob(db + ".bak-*")) == 1


# --------------------------------------------------------------------------- removal
def test_remove_demo_data_deletes_only_demo_rows_after_a_backup(tmp_path):
    db = str(tmp_path / "bandait.db")
    seed_database(db)
    import_band(db, hub_band())  # hub songs and setlist next to the demo ones
    Session = init_db(db)
    with Session() as s:  # a local setlist of the user that also uses a demo song
        mine = Song(id="mine", title="Propia", bpm=100)
        s.add(mine)
        local = Setlist(id="local-1", name="Mi set")
        local.songs = [mine, s.get(Song, "song-001")]
        s.add(local)
        s.commit()

    result = remove_demo_data(db)
    assert (result.songs, result.setlists, result.gigs, result.members) == (3, 1, 1, 3)
    assert result.backup and Path(result.backup).exists()
    assert rows(result.backup, "SELECT COUNT(*) FROM songs WHERE source = 'demo'") == [(3,)]
    assert count_demo_rows(db).total == 0
    assert sorted(sources(db, "songs")) == sorted(["mine", SONG_1, "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a02"])
    assert sorted(sources(db, "setlists")) == sorted(["local-1", CLOUD_SETLIST])
    assert rows(db, "SELECT COUNT(*) FROM gigs") == [(0,)] and rows(db, "SELECT COUNT(*) FROM band_members") == [(0,)]
    with Session() as s:
        assert [e["song_id"] for e in load_setlist_entries(s, "local-1")] == ["mine"]  # lost only the demo item
        assert len(load_setlist_entries(s, CLOUD_SETLIST)) == 2  # hub setlist untouched
    # nothing left: no second backup
    again = remove_demo_data(db)
    assert again.total == 0 and again.backup is None
    assert len(glob.glob(db + ".bak-*")) == 1


# --------------------------------------------------------------------------- window
@pytest.fixture
def window(qapp, monkeypatch):
    answers = []
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: answers.pop(0) if answers else QMessageBox.No)
    windows = []

    def make():
        from src.ui.main_window import MainWindow

        win = MainWindow()
        windows.append(win)
        return win

    make.answers = answers
    yield make
    for win in windows:
        win.close()


def test_help_menu_loads_and_removes_demo_data(window):
    win = window()
    lv = win.library_view
    assert lv.song_ids() == [] and lv.remove_demo_btn.isHidden()

    win.action_demo_load.trigger()  # answered No: nothing happens
    assert lv.song_ids() == []

    window.answers.append(QMessageBox.Yes)
    win.action_demo_load.trigger()
    assert sorted(lv.song_ids()) == ["song-001", "song-002", "song-003"]
    assert {lv.songs_table.item(r, 5).text() for r in range(lv.songs_table.rowCount())} == {"DEMO"}
    assert not lv.remove_demo_btn.isHidden()
    win._activate_setlist("setlist-001")
    assert len(win.server.get_state()["setlist"]) == 3 and win.setlist_notice() == ""

    window.answers.append(QMessageBox.Yes)
    lv.remove_demo_btn.click()
    assert lv.song_ids() == [] and lv.setlist_ids() == []
    assert len(glob.glob(get_db_path() + ".bak-*")) == 1
    # the demo setlist was live: it is replaced by nothing, with the notice
    assert win._live_setlist_id is None and win.server.get_state()["setlist"] == []
    assert win.setlist_notice().startswith("SIN SETLIST EN VIVO")


def test_demo_setlist_cannot_be_removed_while_it_plays(window, qtbot):
    seed_database()
    win = window()
    assert win._live_setlist_id == "setlist-001"
    win.send_command("PLAY")
    qtbot.waitUntil(lambda: win.clock_service.status == "PLAYING", timeout=5000)
    window.answers.append(QMessageBox.Yes)
    win._remove_demo_data()
    assert count_demo_rows().total == 8  # refused before asking
    assert window.answers == [QMessageBox.Yes]
    assert "detén la banda" in win.status_bar.currentMessage()
    win.send_command("STOP")


def test_cloud_song_replace_is_blocked_before_the_dialog(qapp, tmp_path, monkeypatch):
    from src.ui.views.library_view import CLOUD_READ_ONLY_MESSAGE, LibraryView

    seed_database()
    import_band(get_db_path(), hub_band())
    asked, told = [], []
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: asked.append(a) or QMessageBox.Yes)
    monkeypatch.setattr(QMessageBox, "information", lambda *a, **k: told.append(a[2]))
    monkeypatch.setattr(QMessageBox, "warning", lambda *a, **k: told.append(a[2]))
    view = LibraryView()
    assert view.song_origin_of(SONG_1) == "cloud"
    lrc = tmp_path / "intro.lrc"
    lrc.write_text("[ti:Intro]\n[ar:Banda de Prueba]\n[00:01.00]letra editada en el lider\n", encoding="utf-8")
    view._import_file(str(lrc))
    assert asked == []  # no "¿Reemplazar?" for a hub song
    assert told == [CLOUD_READ_ONLY_MESSAGE]
    view._db_session.expire_all()
    assert "letra editada" not in view._db_session.get(Song, SONG_1).lyrics_text

    # a demo (non-hub) song can still be replaced, and the message is true
    told.clear()
    demo = tmp_path / "demo.lrc"
    demo.write_text("[ti:Ritmo de Calle]\n[ar:Banda Local]\n[00:01.00]nueva letra\n", encoding="utf-8")
    view._import_file(str(demo))
    assert len(asked) == 1 and told == ["Canción actualizada: Ritmo de Calle"]
    view._db_session.expire_all()
    assert view._db_session.get(Song, "song-002").lyrics_text == "nueva letra"
