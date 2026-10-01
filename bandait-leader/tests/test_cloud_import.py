"""Import of a hub band into SQLite: idempotent upsert by cloud id, cloud-only
deletions, local data untouched, one transaction, and the setlist entries that
wave 2 reads (transitions and sections)."""

import copy
import glob
import json
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from src.cloud.sync import import_snapshot
from src.cloud.workspace import WorkspaceSnapshot, parse_workspace
from src.db import cloud_import
from src.db.cloud_import import import_band, read_cloud_setlists
from src.db.models import (
    BandVoiceConfig,
    Gig,
    Setlist,
    Song,
    init_db,
    list_cloud_setlists,
    load_setlist_entries,
)
from src.db.seed import seed_database

FIXTURE = Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "workspace_v2.json"
SONG_1 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a01"
SONG_2 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a02"


def fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def band(raw=None, band_id="band_01"):
    return parse_workspace(raw if raw is not None else fixture()).band(band_id)


def dump(db):
    """Every row of every table that the importer touches (created_at excluded)."""
    con = sqlite3.connect(db)
    try:
        out = {}
        for table, order in (
            ("songs", "id"), ("song_sections", "id"), ("setlists", "id"),
            ("setlist_songs", "setlist_id, position, song_id"), ("band_voice_configs", "band_cloud_id"),
        ):
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})") if r[1] != "created_at"]
            out[table] = con.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY {order}").fetchall()
        return out
    finally:
        con.close()


@pytest.fixture
def db(tmp_path):
    path = str(tmp_path / "bandait.db")
    seed_database(path)  # local songs and a local setlist, as on a real laptop
    return path


def test_import_is_idempotent_and_keeps_local_songs(db):
    before_local = dump(db)["songs"]
    report = import_band(db, band())
    assert (report.songs_upserted, report.setlists_upserted, report.items) == (2, 1, 2)
    assert report.song_ids == {SONG_1: SONG_1, SONG_2: SONG_2}
    first = dump(db)
    import_band(db, band())
    assert dump(db) == first  # same rows, same values
    Session = init_db(db)
    with Session() as s:
        sources = {song.id: song.source for song in s.query(Song).all()}
        assert sources == {"song-001": "local", "song-002": "local", "song-003": "local",
                           SONG_1: "cloud", SONG_2: "cloud"}
        local_rows = [r for r in dump(db)["songs"] if r[0].startswith("song-")]
        assert local_rows == [r for r in before_local]
        intro = s.get(Song, SONG_1)
        assert (intro.beats_per_bar, intro.cloud_id, intro.band_cloud_id) == (4, SONG_1, "band_01")
        assert [sec.label for sec in intro.sections] == ["Intro", "Estrofa 1", "Coro", "Final"]
        assert "Hoy vuelvo a casa" in intro.lyrics_text and "[Am]" not in intro.lyrics_text
        assert s.query(Setlist).filter(Setlist.cloud_id.is_(None)).count() == 1  # local setlist intact


def test_setlist_entries_carry_transitions_and_sections_for_wave2(db):
    report = import_band(db, band())
    Session = init_db(db)
    with Session() as s:
        entries = load_setlist_entries(s, report.setlist_ids["pl_01"])
    first, second = entries
    assert (first["song_id"], first["bpm"], first["transition_mode"], first["count_in_bars"],
            first["count_in_voice"], first["gap_sec"], first["total_bars"]) == (
        SONG_1, 120, "manual_cue", 1, True, 0.0, 24)
    assert [(x["label"], x["bars"], x["start_bar"], x["cue_text"]) for x in first["sections"]] == [
        ("Intro", 4, 1, "Intro"), ("Estrofa 1", 8, 5, "Estrofa"), ("Coro", 8, 13, "Coro"), ("Final", 4, 21, None)]
    assert first["sections"][1]["chordpro"].startswith("[Am]Hoy")
    assert (second["transition_mode"], second["count_in_bars"], second["gap_sec"], second["bpm"],
            second["show_key"], second["total_bars"], second["sections"]) == (
        "auto_count_in", 2, 3.0, 96, "D", None, [])
    assert [e["order_index"] for e in entries] == [0, 1]


def test_hub_deletions_remove_only_cloud_rows(db):
    import_band(db, band())
    raw = fixture()
    raw["songsMap"]["band_01"] = [s for s in raw["songsMap"]["band_01"] if s["id"] != SONG_2]
    raw["playlistsMap"]["band_01"][0]["songs"] = raw["playlistsMap"]["band_01"][0]["songs"][:1]
    report = import_band(db, band(raw))
    assert report.songs_deleted == 1
    Session = init_db(db)
    with Session() as s:
        assert s.get(Song, SONG_2) is None
        assert s.get(Song, "song-001") is not None
        entries = load_setlist_entries(s, report.setlist_ids["pl_01"])
        assert [e["song_id"] for e in entries] == [SONG_1]
    # the playlist itself deleted in the hub
    raw["playlistsMap"]["band_01"] = []
    report = import_band(db, band(raw))
    assert report.setlists_deleted == 1
    with Session() as s:
        assert s.query(Setlist).filter(Setlist.cloud_id.isnot(None)).count() == 0
        assert s.query(Setlist).count() == 1  # the local one


def test_switching_band_mirrors_only_the_chosen_band(db):
    raw = fixture()
    other = copy.deepcopy(raw["songsMap"]["band_01"][1])
    other["id"] = "99999999-0000-4000-8000-000000000001"
    raw["bands"].append({"id": "band_02", "name": "Otra"})
    raw["songsMap"]["band_02"] = [other]
    raw["playlistsMap"]["band_02"] = [{"id": "pl_01", "name": "Show B", "songs": [
        {"id": "x", "songId": other["id"], "orderIndex": 0, "transitionMode": "gapless", "countInBars": 0}]}]
    import_band(db, band(raw, "band_01"))
    report = import_band(db, band(raw, "band_02"))
    assert report.songs_deleted == 2 and report.setlists_deleted == 1
    Session = init_db(db)
    with Session() as s:
        cloud = s.query(Song).filter(Song.source == "cloud").all()
        assert [x.id for x in cloud] == [other["id"]]
        assert [r["name"] for r in list_cloud_setlists(s)] == ["Show B"]
        assert [r.band_cloud_id for r in s.query(BandVoiceConfig).all()] == ["band_02"]
    assert read_cloud_setlists(db, "band_01") == []
    assert [r["name"] for r in read_cloud_setlists(db, "band_02")] == ["Show B"]


def test_v1_row_then_hub_v2_upload_maps_onto_the_same_rows(db):
    """The cloud row stays v1 until the first real edit in the hub; the v2 the hub
    then uploads must update the leader's rows, not duplicate them."""
    v1 = fixture()
    for key in ("schemaVersion", "songsMap", "voiceMap"):
        v1.pop(key)
    for item in v1["playlistsMap"]["band_01"][0]["songs"]:
        for key in ("songId", "countInVoice", "gapSec"):
            item.pop(key)
    first = import_band(db, band(v1))
    # ids the hub's migrateWorkspace() derives for this v1 (see test_cloud_workspace)
    derived = {"Intro": "24d1b6d4-5fa9-4651-b0ca-b7de9776fadf", "Segunda": "eb2084a0-5932-473b-966c-0f1133110179"}
    assert sorted(first.song_ids) == sorted(derived.values())

    v2 = json.loads(json.dumps(fixture()).replace(SONG_1, derived["Intro"]).replace(SONG_2, derived["Segunda"]))
    second = import_band(db, band(v2))
    assert second.songs_deleted == 0 and second.setlists_deleted == 0
    assert second.song_ids == first.song_ids and second.setlist_ids == first.setlist_ids
    Session = init_db(db)
    with Session() as s:
        cloud = s.query(Song).filter(Song.source == "cloud").all()
        assert sorted(x.id for x in cloud) == sorted(derived.values())  # no duplicates
        assert len(s.get(Song, derived["Intro"]).sections) == 4  # the v2 edit arrived
        assert s.query(Song).filter(Song.source == "local").count() == 3


def test_cloud_id_colliding_with_a_local_song_gets_its_own_id(db):
    raw = fixture()
    raw["songsMap"]["band_01"][0]["id"] = "song-001"  # same id as a seeded local song
    raw["playlistsMap"]["band_01"][0]["songs"][0]["songId"] = "song-001"
    report = import_band(db, band(raw))
    assert report.song_ids["song-001"] == "cloud-song-001"
    Session = init_db(db)
    with Session() as s:
        assert s.get(Song, "song-001").source == "local"
        assert s.get(Song, "song-001").title == "Medianoche en Pereira"
        assert s.get(Song, "cloud-song-001").title == "Intro"
        entries = load_setlist_entries(s, report.setlist_ids["pl_01"])
        assert entries[0]["song_id"] == "cloud-song-001"
    assert import_band(db, band(raw)).song_ids["song-001"] == "cloud-song-001"  # stable


def test_deleting_a_cloud_setlist_detaches_gigs(db):
    report = import_band(db, band())
    sid = report.setlist_ids["pl_01"]
    Session = init_db(db)
    with Session() as s:
        s.add(Gig(id="g1", name="Viernes", date=datetime(2026, 10, 2), setlist_id=sid))
        s.commit()
    raw = fixture()
    raw["playlistsMap"]["band_01"] = []
    import_band(db, band(raw))
    with Session() as s:
        assert s.get(Gig, "g1").setlist_id is None


def test_import_is_one_transaction(db, monkeypatch):
    import_band(db, band())
    before = dump(db)
    raw = fixture()
    raw["songsMap"]["band_01"][0]["title"] = "Cambiada"
    raw["playlistsMap"]["band_01"] = []
    real_apply = cloud_import._apply

    def failing_apply(conn, content):
        real_apply(conn, content)  # every write done...
        raise RuntimeError("corte de luz")  # ...and then the process dies

    monkeypatch.setattr(cloud_import, "_apply", failing_apply)
    with pytest.raises(RuntimeError):
        import_band(db, band(raw))
    assert dump(db) == before


def test_cloud_songs_are_read_only_through_the_orm(db):
    import_band(db, band())
    Session = init_db(db)
    with Session() as s:
        song = s.get(Song, SONG_1)
        song.title = "Editada en el líder"
        s.commit()
        s.delete(s.get(Song, SONG_2))
        s.commit()
        local = s.get(Song, "song-001")
        local.title = "Local editada"
        s.commit()
    with Session() as s:
        assert s.get(Song, SONG_1).title == "Intro"
        assert s.get(Song, SONG_2) is not None
        assert s.get(Song, "song-001").title == "Local editada"


def test_old_database_gets_the_cloud_columns_with_a_backup(tmp_path):
    db = str(tmp_path / "viejo.db")
    con = sqlite3.connect(db)
    con.executescript(
        """
        CREATE TABLE songs (id VARCHAR PRIMARY KEY, title VARCHAR NOT NULL, bpm INTEGER);
        CREATE TABLE setlists (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL);
        CREATE TABLE setlist_songs (setlist_id VARCHAR, song_id VARCHAR, position INTEGER);
        INSERT INTO songs VALUES ('a', 'Vieja', 100);
        INSERT INTO setlists VALUES ('sl', 'Show');
        INSERT INTO setlist_songs VALUES ('sl', 'a', 0);
        """
    )
    con.commit()
    con.close()
    import_band(db, band())
    assert len(glob.glob(db + ".bak-*")) == 1
    con = sqlite3.connect(db)
    try:
        cols = {r[1] for r in con.execute("PRAGMA table_info(songs)")}
        assert {"cloud_id", "source", "beats_per_bar", "band_cloud_id"} <= cols
        item_cols = {r[1] for r in con.execute("PRAGMA table_info(setlist_songs)")}
        assert {"transition_mode", "count_in_bars", "count_in_voice", "gap_sec", "show_key", "show_bpm"} <= item_cols
        assert con.execute("SELECT source, beats_per_bar FROM songs WHERE id='a'").fetchone() == ("local", 4)
    finally:
        con.close()
    Session = init_db(db)
    with Session() as s:
        (entry,) = load_setlist_entries(s, "sl")
        assert (entry["transition_mode"], entry["count_in_bars"], entry["sections"]) == ("manual_cue", 0, [])
    import_band(db, band())
    assert len(glob.glob(db + ".bak-*")) == 1  # idempotent: no second backup


def test_sync_import_snapshot_picks_the_only_band_and_refuses_a_missing_one(db):
    ws = parse_workspace(fixture())
    snap = WorkspaceSnapshot(workspace=ws, source="cloud", user_id="u", email="", updated_at=None,
                             fetched_at="2026-10-01T00:00:00+00:00")
    outcome = import_snapshot(snap, None, db)
    assert outcome.ok and outcome.band_id == "band_01" and outcome.report.songs_upserted == 2
    before = dump(db)
    missing = import_snapshot(snap, "band_borrada", db)
    assert not missing.ok and missing.needs_band_choice
    assert dump(db) == before  # nothing imported, nothing deleted
