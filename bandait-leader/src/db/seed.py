"""Demo data: three sample songs, a setlist, a gig and three band members.

The GUI no longer loads it on its own. It used to seed every empty database,
and a user whose chosen hub setlist was empty saw these songs and read it as
"the songs did not sync". Now it is loaded only with ``BANDAIT_DEMO=1`` or
Ayuda > Cargar canciones de demostración. Every row carries ``source='demo'``
and ``remove_demo_data`` deletes exactly those rows, after a backup.

Ids and titles must keep matching ``models.DEMO_SIGNATURES`` (the migration that
marks the rows seeded by older versions relies on them; a test checks it).
"""

import logging
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Dict, Optional

from src.core.paths import get_db_path

from .models import DEMO_SOURCE, BandMember, Gig, Setlist, Song, backup_db, init_db

logger = logging.getLogger(__name__)

DEMO_SETLIST_ID = "setlist-001"


def demo_rows() -> Dict[str, list]:
    """Fresh (unsaved) ORM objects of the demo data."""
    song1 = Song(
        id="song-001",
        title="Medianoche en Pereira",
        artist="Los Inquietos",
        bpm=124,
        key="Am",
        duration_seconds=245,
        source=DEMO_SOURCE,
        lyrics_text="""[Intro]
(Luz de neón parpadea)

[Verso 1]
Las luces de la ciudad
Se reflejan en tu piel
Medianoche en Pereira
Y yo pensando en usted

[Pre-Coro]
El viento trae tu nombre
Desde la otra orilla

[Coro]
Medianoche, medianoche
Pereira me hace sentir
Que aunque estés tan lejos
Siempre vas a volver

[Verso 2]
Las calles están vacías
Solo queda el silencio
Y el eco de tu risa
En cada rincón

[Coro]
Medianoche, medianoche
Pereira me hace sentir
Que aunque estés tan lejos
Siempre vas a volver

[Outro]
Medianoche...
(Fade out)""",
        chords_text="""{title: Medianoche en Pereira}
{artist: Los Inquietos}
{key: Am}
{bpm: 124}

[Intro]
Am - F - C - G (x2)

[Verso 1]
Am         F
Las luces de la ciudad
C          G
Se reflejan en tu piel
Am         F
Medianoche en Pereira
C          G
Y yo pensando en usted

[Pre-Coro]
Dm         Am
El viento trae tu nombre
E          Am
Desde la otra orilla

[Coro]
F          C
Medianoche, medianoche
G          Am
Pereira me hace sentir
F          C
Que aunque estés tan lejos
G          Am
Siempre vas a volver""",
    )
    song2 = Song(
        id="song-002",
        title="Ritmo de Calle",
        artist="Banda Local",
        bpm=138,
        key="Em",
        duration_seconds=210,
        source=DEMO_SOURCE,
        lyrics_text="""[Intro]
(Instrumental)

[Verso]
El ritmo de la calle
Late en mi corazón
Cada paso que doy
Es una canción

[Coro]
Baila, baila, baila
No pares de moverte
Baila, baila, baila
Siente el ritmo""",
    )
    song3 = Song(
        id="song-003",
        title="Desde Lejos",
        artist="Solistas",
        bpm=88,
        key="G",
        duration_seconds=315,
        source=DEMO_SOURCE,
        lyrics_text="""[Intro]
(Piano solo)

[Verso 1]
Desde lejos te observo
Y no puedo hablar
Las palabras se pierden
En el aire""",
    )
    setlist = Setlist(id=DEMO_SETLIST_ID, name="Set de Ensayo - Mayo 2026", source=DEMO_SOURCE)
    gig = Gig(
        id="gig-001",
        name="Concierto Bar La Esquina",
        venue="La Esquina Bar",
        date=datetime(2026, 6, 15, 21, 0),
        setlist_id=DEMO_SETLIST_ID,
        status="confirmed",
        source=DEMO_SOURCE,
    )
    members = [
        BandMember(id="member-001", name="Daniel Castañeda", role="Guitarra / Voz", color="#00FFFF",
                   source=DEMO_SOURCE),
        BandMember(id="member-002", name="Andrés López", role="Batería", color="#CCFF00", source=DEMO_SOURCE),
        BandMember(id="member-003", name="María García", role="Bajo", color="#FF00FF", source=DEMO_SOURCE),
    ]
    return {"songs": [song1, song2, song3], "setlists": [setlist], "gigs": [gig], "band_members": members}


def _insert_missing(session) -> int:
    """Add the demo rows whose id is free. A row with a demo id that belongs to
    the user (other source) is left alone and never linked to the demo setlist."""
    rows = demo_rows()
    inserted = 0
    setlist_songs = []
    for song in rows["songs"]:
        existing = session.get(Song, song.id)
        if existing is None:
            session.add(song)
            setlist_songs.append(song)
            inserted += 1
        elif existing.source == DEMO_SOURCE:
            setlist_songs.append(existing)
    setlist = rows["setlists"][0]
    existing_setlist = session.get(Setlist, setlist.id)
    if existing_setlist is None:
        setlist.songs = setlist_songs
        session.add(setlist)
        inserted += 1
        demo_setlist = True
    else:
        demo_setlist = existing_setlist.source == DEMO_SOURCE
    for gig in rows["gigs"]:
        if session.get(Gig, gig.id) is None:
            if not demo_setlist:
                gig.setlist_id = None
            session.add(gig)
            inserted += 1
    for member in rows["band_members"]:
        if session.get(BandMember, member.id) is None:
            session.add(member)
            inserted += 1
    session.commit()
    return inserted


def _dispose(Session) -> None:
    """Close the pooled connections of a short-lived init_db() (Windows keeps
    files with open handles locked)."""
    engine = Session.kw.get("bind")
    if engine is not None:
        engine.dispose()


def load_demo_data(db_path: Optional[str] = None) -> int:
    """Insert the demo rows that are missing. Returns how many rows were added."""
    Session = init_db(db_path or get_db_path())
    try:
        with Session() as session:
            inserted = _insert_missing(session)
    finally:
        _dispose(Session)
    if inserted:
        logger.info("Datos de demostración cargados: %d filas", inserted)
    return inserted


def seed_database(db_path: Optional[str] = None) -> int:
    """Demo data only if the database has no songs at all (tests, scripts)."""
    Session = init_db(db_path or get_db_path())
    try:
        with Session() as session:
            if session.query(Song).count() > 0:
                return 0
            return _insert_missing(session)
    finally:
        _dispose(Session)


@dataclass
class DemoRemoval:
    backup: Optional[str]
    songs: int = 0
    setlists: int = 0
    gigs: int = 0
    members: int = 0

    @property
    def total(self) -> int:
        return self.songs + self.setlists + self.gigs + self.members


_DEMO_SONGS = "SELECT id FROM songs WHERE source = 'demo'"
# A hub setlist (cloud_id) is never demo data, whatever its source says.
_DEMO_SETLISTS = "SELECT id FROM setlists WHERE source = 'demo' AND cloud_id IS NULL"
_DEMO_GIGS = "SELECT id FROM gigs WHERE source = 'demo'"
_DEMO_MEMBERS = "SELECT id FROM band_members WHERE source = 'demo'"


def count_demo_rows(db_path: Optional[str] = None) -> DemoRemoval:
    """How many demo rows the database has (``backup`` is None)."""
    db_path = db_path or get_db_path()
    _dispose(init_db(db_path))  # schema with the source columns
    con = sqlite3.connect(db_path, timeout=15)
    try:
        def n(select):
            return int(con.execute(f"SELECT COUNT(*) FROM ({select})").fetchone()[0])

        return DemoRemoval(None, n(_DEMO_SONGS), n(_DEMO_SETLISTS), n(_DEMO_GIGS), n(_DEMO_MEMBERS))
    finally:
        con.close()


def remove_demo_data(db_path: Optional[str] = None) -> DemoRemoval:
    """Delete exactly the rows with ``source='demo'`` (and their links) in one
    transaction, after a backup of the database file. Local and hub rows are
    never touched; a local setlist that contained a demo song loses that item."""
    db_path = db_path or get_db_path()
    counts = count_demo_rows(db_path)
    if counts.total == 0:
        return counts
    counts.backup = backup_db(db_path)
    con = sqlite3.connect(db_path, timeout=15)
    try:
        with con:  # all or nothing
            con.execute(f"DELETE FROM setlist_songs WHERE song_id IN ({_DEMO_SONGS})")
            con.execute(f"DELETE FROM song_sections WHERE song_id IN ({_DEMO_SONGS})")
            con.execute(f"DELETE FROM setlist_songs WHERE setlist_id IN ({_DEMO_SETLISTS})")
            con.execute(f"UPDATE gigs SET setlist_id = NULL WHERE setlist_id IN ({_DEMO_SETLISTS})")
            con.execute(f"UPDATE rehearsals SET setlist_id = NULL WHERE setlist_id IN ({_DEMO_SETLISTS})")
            con.execute(
                f"DELETE FROM gig_members WHERE gig_id IN ({_DEMO_GIGS}) OR member_id IN ({_DEMO_MEMBERS})"
            )
            con.execute("DELETE FROM songs WHERE source = 'demo'")
            con.execute(f"DELETE FROM setlists WHERE id IN ({_DEMO_SETLISTS})")
            con.execute("DELETE FROM gigs WHERE source = 'demo'")
            con.execute("DELETE FROM band_members WHERE source = 'demo'")
    finally:
        con.close()
    logger.warning(
        "Datos de demostración quitados: %d canciones, %d setlists, %d eventos, %d miembros. Respaldo: %s",
        counts.songs, counts.setlists, counts.gigs, counts.members, counts.backup,
    )
    return counts


if __name__ == "__main__":
    print(f"Filas de demostración agregadas: {load_demo_data()}")
