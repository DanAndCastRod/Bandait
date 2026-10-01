"""init_db: idempotent additive migrations with a backup, and BANDAIT_DB routing."""

import glob
import os
import re
import sqlite3

from src.core.paths import get_db_path
from src.db.models import init_db, load_setlist_entries, plan_migrations, Setlist, Song


def _build_old_schema(path):
    """A DB created before artist/band_id/updated_at/... existed."""
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE songs (
            id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, bpm INTEGER, key VARCHAR,
            duration_seconds FLOAT, lyrics_text TEXT, chords_text TEXT, audio_path VARCHAR,
            created_at DATETIME
        );
        CREATE TABLE setlists (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, created_at DATETIME);
        CREATE TABLE setlist_songs (setlist_id VARCHAR, song_id VARCHAR, position INTEGER);
        CREATE TABLE band_members (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL, role VARCHAR, color VARCHAR);
        INSERT INTO songs (id, title, bpm, key, duration_seconds, lyrics_text, chords_text, audio_path)
            VALUES ('a', 'Primera', 100, 'C', 200, 'la la', '', ''),
                   ('b', 'Segunda', 132, 'Em', 180, '', '', ''),
                   ('c', 'Tercera', 90, 'G', 240, '', '', '');
        INSERT INTO setlists (id, name) VALUES ('sl', 'Show viejo');
        INSERT INTO setlist_songs VALUES ('sl', 'c', 0), ('sl', 'a', 1), ('sl', 'b', 2);
        INSERT INTO band_members (id, name, role, color) VALUES ('m1', 'Ana', 'Bajo', '#FF00FF');
        """
    )
    con.commit()
    con.close()


def _columns(path, table):
    con = sqlite3.connect(path)
    try:
        return {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
    finally:
        con.close()


def test_old_schema_is_migrated_without_data_loss(tmp_path):
    db = str(tmp_path / "bandait.db")
    _build_old_schema(db)
    assert plan_migrations(db), "the old schema must need migrations"

    Session = init_db(db)

    backups = glob.glob(db + ".bak-*")
    assert len(backups) == 1
    assert re.search(r"\.bak-\d{14}$", backups[0])
    assert "band_id" not in _columns(backups[0], "setlists")  # backup = untouched original
    assert {"band_id", "updated_at"} <= _columns(db, "setlists")
    assert "artist" in _columns(db, "songs")
    assert {"band_id", "user_id", "email", "phone"} <= _columns(db, "band_members")

    session = Session()
    try:
        titles = sorted(s.title for s in session.query(Song).all())
        assert titles == ["Primera", "Segunda", "Tercera"]
        assert session.get(Song, "a").artist == ""  # scalar default filled in
        setlist = session.query(Setlist).one()  # used to raise "no such column: setlists.band_id"
        assert setlist.band_id == "band_default"
        entries = load_setlist_entries(session, "sl")
        assert [e["song_id"] for e in entries] == ["c", "a", "b"]
        assert [e["order_index"] for e in entries] == [0, 1, 2]
        assert entries[1]["bpm"] == 100
    finally:
        session.close()

    # Idempotent: a second open neither migrates nor backs up again.
    assert plan_migrations(db) == []
    init_db(db)
    assert len(glob.glob(db + ".bak-*")) == 1


def test_fresh_db_needs_no_backup(tmp_path):
    db = str(tmp_path / "nuevo.db")
    init_db(db)
    assert os.path.exists(db)
    assert glob.glob(db + ".bak-*") == []


def test_every_db_path_honors_bandait_db(tmp_path, monkeypatch):
    target = tmp_path / "custom" / "mi.db"
    monkeypatch.setenv("BANDAIT_DB", str(target))
    assert get_db_path() == str(target.resolve())
    from src.db.seed import seed_database

    seed_database()
    assert target.exists()
    Session = init_db()
    session = Session()
    try:
        assert session.query(Song).count() == 3
    finally:
        session.close()


def test_library_view_opens_a_legacy_db(qapp, tmp_path, monkeypatch):
    db = tmp_path / "legacy.db"
    _build_old_schema(str(db))
    monkeypatch.setenv("BANDAIT_DB", str(db))
    from src.ui.views.library_view import LibraryView

    view = LibraryView()
    assert view.setlists_table.rowCount() == 1
    assert view.songs_table.rowCount() == 3
    assert [e["title"] for e in view.get_setlist_entries("sl")] == ["Tercera", "Primera", "Segunda"]
    assert db.exists()  # never deleted and recreated
