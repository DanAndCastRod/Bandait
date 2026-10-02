"""Local edits of the library (src/db/library_ops): songs, setlists and events.

Hub rows are refused before anything is written; demo rows become the user's
when edited; setlist items keep their transition and count-in across edits."""

import json
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import update

from src.cloud.workspace import parse_workspace
from src.core.paths import get_db_path
from src.db import library_ops as ops
from src.db.cloud_import import import_band
from src.db.models import Gig, Setlist, Song, init_db, load_setlist_entries
from src.db.seed import remove_demo_data, seed_database

FIXTURE = Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "workspace_v2.json"
SONG_1 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a01"
CLOUD_SETLIST = "cloud:band_01:pl_01"


@pytest.fixture
def session():
    s = init_db(get_db_path())()
    yield s
    s.close()


@pytest.fixture
def hub(session):
    with open(FIXTURE, encoding="utf-8") as fh:
        import_band(get_db_path(), parse_workspace(json.load(fh)).band("band_01"))
    session.expire_all()
    return session


def song(session, title="Carretera", **kw):
    return ops.create_song(session, ops.SongFields(title=title, **kw))


# ------------------------------------------------------------------ songs

def test_create_song_splits_chordpro_into_lyrics_and_chords(session):
    s = song(session, bpm=92, key="D", beats_per_bar=6, beat_unit=8, duration_seconds=225,
             text="[Intro]\n[Am]  [F]  [C]  [G]\n[Am]Cruzamos la [F]noche sin [C]mirar a[G]trás\n[Coro]\n[F]Canta")
    session.expire_all()
    s = session.get(Song, s.id)
    assert s.source == "local" and s.id.startswith("song-local-")
    assert (s.bpm, s.key, s.beats_per_bar, s.beat_unit, s.duration_seconds) == (92, "D", 6, 8, 225)
    # chord-only lines go, section lines stay, a chord inside a word joins it back
    assert s.lyrics_text == "[Intro]\nCruzamos la noche sin mirar atrás\n[Coro]\nCanta"
    assert s.chords_text.startswith("[Intro]\n[Am]")
    assert ops.song_text(s) == s.chords_text


def test_plain_lyrics_have_no_chords_text(session):
    s = song(session, text="Primera línea\n[Coro]\nsegunda")
    assert s.lyrics_text == "Primera línea\n[Coro]\nsegunda" and s.chords_text == ""


@pytest.mark.parametrize("fields, message", [
    (dict(title="  "), "título"),
    (dict(title="X", bpm=10), "entre 20 y 400"),
    (dict(title="X", bpm="rápido"), "número entero"),
    (dict(title="X", beats_per_bar=0), "Compás inválido"),
    (dict(title="X", beat_unit=3), "Compás inválido"),
    (dict(title="X", duration_seconds=25 * 3600), "24 horas"),
])
def test_invalid_song_is_refused_with_a_message(session, fields, message):
    with pytest.raises(ops.LibraryEditError, match=message):
        ops.create_song(session, ops.SongFields(**fields))
    assert session.query(Song).count() == 0


def test_duration_and_meter_parsing():
    assert ops.parse_duration("3:45") == 225 and ops.parse_duration("") == 0
    assert ops.format_duration(225) == "3:45" and ops.format_duration(0) == ""
    assert ops.parse_meter("12/8") == (12, 8)
    for bad in ("3.45", "3:7", "abc"):
        with pytest.raises(ops.LibraryEditError):
            ops.parse_duration(bad)
    with pytest.raises(ops.LibraryEditError):
        ops.parse_meter("4-4")


def test_update_song_and_demo_song_becomes_local(session):
    seed_database()
    session.expire_all()
    ops.update_song(session, "song-002", ops.SongFields(title="Ritmo de Calle (v2)", bpm=140))
    session.expire_all()
    s = session.get(Song, "song-002")
    assert (s.title, s.bpm, s.source) == ("Ritmo de Calle (v2)", 140, "local")
    remove_demo_data()
    session.expire_all()
    assert session.get(Song, "song-002") is not None  # the user's edit survives the demo cleanup


def test_cloud_song_cannot_be_edited_or_deleted(hub):
    with pytest.raises(ops.CloudReadOnly, match="edítala en bandait.releven.cc/hub"):
        ops.update_song(hub, SONG_1, ops.SongFields(title="hackeada"))
    with pytest.raises(ops.CloudReadOnly, match="bórrala en bandait.releven.cc/hub"):
        ops.delete_song(hub, SONG_1)
    hub.expire_all()
    assert hub.get(Song, SONG_1).title != "hackeada"


def test_delete_song_removes_it_from_every_setlist(session):
    a, b = song(session, "A"), song(session, "B")
    s1 = ops.create_setlist(session, "Uno", [a.id, b.id])
    s2 = ops.create_setlist(session, "Dos", [a.id])
    assert ops.song_setlist_names(session, a.id) == ["Dos", "Uno"]
    assert ops.delete_song(session, a.id) == ["Dos", "Uno"]
    assert session.get(Song, a.id) is None
    assert ops.setlist_song_ids(session, s1.id) == [b.id] and ops.setlist_song_ids(session, s2.id) == []


def test_missing_song_is_a_clear_error(session):
    with pytest.raises(ops.LibraryEditError, match="ya no existe"):
        ops.update_song(session, "nope", ops.SongFields(title="X"))


# ------------------------------------------------------------------ setlists

def test_create_setlist_keeps_order_and_drops_duplicates(session):
    a, b, c = song(session, "A"), song(session, "B"), song(session, "C")
    sl = ops.create_setlist(session, "  Viernes  ", [c.id, a.id, c.id, b.id])
    assert sl.name == "Viernes" and sl.source == "local" and sl.id.startswith("setlist-local-")
    assert [e["song_id"] for e in load_setlist_entries(session, sl.id)] == [c.id, a.id, b.id]


def test_setlist_validation(session):
    a = song(session, "A")
    with pytest.raises(ops.LibraryEditError, match="nombre del setlist"):
        ops.create_setlist(session, " ", [a.id])
    with pytest.raises(ops.LibraryEditError, match="ya no existe"):
        ops.create_setlist(session, "X", [a.id, "missing"])
    assert session.query(Setlist).count() == 0


def test_update_setlist_keeps_item_settings_of_songs_that_stay(session):
    a, b, c = song(session, "A"), song(session, "B"), song(session, "C")
    sl = ops.create_setlist(session, "Show", [a.id, b.id])
    session.execute(update(ops.items_t).where(ops.items_t.c.song_id == b.id)
                    .values(transition_mode="auto_count_in", count_in_bars=2, show_key="E"))
    session.commit()
    ops.update_setlist(session, sl.id, "Show 2", [b.id, c.id])
    entries = load_setlist_entries(session, sl.id)
    assert [e["song_id"] for e in entries] == [b.id, c.id]
    by_id = {e["song_id"]: e for e in entries}
    assert by_id[b.id]["count_in_bars"] == 2 and by_id[b.id]["transition_mode"] == "auto_count_in"
    assert by_id[c.id]["transition_mode"] == "manual_cue" and by_id[c.id]["count_in_bars"] == 0
    assert session.get(Setlist, sl.id).name == "Show 2"


def test_cloud_setlist_is_read_only_but_can_be_duplicated(hub):
    with pytest.raises(ops.CloudReadOnly, match="usa Duplicar"):
        ops.update_setlist(hub, CLOUD_SETLIST, "X", [])
    with pytest.raises(ops.CloudReadOnly, match="bórralo"):
        ops.delete_setlist(hub, CLOUD_SETLIST)
    original = load_setlist_entries(hub, CLOUD_SETLIST)
    copy = ops.duplicate_setlist(hub, CLOUD_SETLIST)
    assert copy.cloud_id is None and copy.band_cloud_id is None and copy.source == "local"
    assert copy.name.startswith("Copia de ")
    copied = load_setlist_entries(hub, copy.id)
    assert [e["song_id"] for e in copied] == [e["song_id"] for e in original]
    assert [e.get("transition_mode") for e in copied] == [e.get("transition_mode") for e in original]
    rows = hub.execute(ops.items_t.select().where(ops.items_t.c.setlist_id == copy.id)).mappings().fetchall()
    assert all(r["item_cloud_id"] is None for r in rows)  # never linked to the hub items
    # a second copy gets a different name; a copy is editable
    assert ops.duplicate_setlist(hub, CLOUD_SETLIST).name == f"{copy.name} (2)"
    ops.update_setlist(hub, copy.id, "Mi versión", ops.setlist_song_ids(hub, copy.id)[:1])
    assert hub.get(Setlist, copy.id).name == "Mi versión"


def test_delete_setlist_unlinks_its_events(session):
    a = song(session, "A")
    sl = ops.create_setlist(session, "Show", [a.id])
    gig = ops.create_gig(session, ops.GigFields(name="Bar", date=datetime(2026, 10, 10, 21), setlist_id=sl.id))
    assert ops.gigs_using_setlist(session, sl.id) == 1
    assert ops.delete_setlist(session, sl.id) == 1
    assert session.get(Setlist, sl.id) is None and session.get(Song, a.id) is not None
    assert session.get(Gig, gig.id).setlist_id is None


# ------------------------------------------------------------------ events

def test_gig_when():
    now = datetime(2026, 10, 2, 12, 0)
    assert ops.gig_when(datetime(2026, 10, 2, 21, 0), now) == ops.GIG_TODAY
    assert ops.gig_when(datetime(2026, 10, 2, 9, 0), now) == ops.GIG_TODAY  # earlier the same day: still today
    assert ops.gig_when(datetime(2026, 10, 3, 0, 30), now) == ops.GIG_UPCOMING
    assert ops.gig_when(datetime(2026, 9, 30, 21, 0), now) == ops.GIG_PAST
    assert ops.gig_when(None, now) == ops.GIG_PAST


def test_gig_crud_and_validation(session):
    a = song(session, "A")
    sl = ops.create_setlist(session, "Show", [a.id])
    when = datetime.now() + timedelta(days=3)
    gig = ops.create_gig(session, ops.GigFields(name=" Bar La Ruta ", date=when, venue="Pereira", setlist_id=sl.id))
    assert gig.name == "Bar La Ruta" and gig.source == "local" and gig.date.second == 0
    ops.update_gig(session, gig.id, ops.GigFields(name="Bar", date=when, setlist_id=None, notes="backline"))
    assert (session.get(Gig, gig.id).setlist_id, session.get(Gig, gig.id).notes) == (None, "backline")
    assert [g.id for g in ops.list_gigs(session)] == [gig.id]
    with pytest.raises(ops.LibraryEditError, match="nombre del evento"):
        ops.create_gig(session, ops.GigFields(name="", date=when))
    with pytest.raises(ops.LibraryEditError, match="ya no existe"):
        ops.create_gig(session, ops.GigFields(name="X", date=when, setlist_id="missing"))
    ops.delete_gig(session, gig.id)
    assert ops.list_gigs(session) == []


def test_edited_demo_gig_survives_the_demo_cleanup(session):
    seed_database()
    session.expire_all()
    demo = ops.list_gigs(session)[0]
    assert demo.source == "demo"
    ops.update_gig(session, demo.id, ops.gig_fields(demo))
    remove_demo_data()
    session.expire_all()
    assert [g.id for g in ops.list_gigs(session)] == [demo.id]
