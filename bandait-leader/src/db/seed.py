"""Seed database with sample songs for testing."""

import os
from datetime import datetime

from .models import BandMember, Gig, Setlist, Song, init_db


def seed_database(db_path: str = None):
    """Create sample data if database is empty."""
    if db_path is None:
        db_path = os.path.join(os.path.expanduser("~"), "Documents", "Bandait", "bandait.db")

    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    Session = init_db(db_path)
    session = Session()

    # Check if already seeded
    if session.query(Song).count() > 0:
        session.close()
        return

    # Sample song 1: Classic rock with LRC-style lyrics
    song1 = Song(
        id="song-001",
        title="Medianoche en Pereira",
        artist="Los Inquietos",
        bpm=124,
        key="Am",
        duration_seconds=245,
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

    # Sample song 2: Simpler song
    song2 = Song(
        id="song-002",
        title="Ritmo de Calle",
        artist="Banda Local",
        bpm=138,
        key="Em",
        duration_seconds=210,
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

    # Sample song 3: Ballad
    song3 = Song(
        id="song-003",
        title="Desde Lejos",
        artist="Solistas",
        bpm=88,
        key="G",
        duration_seconds=315,
        lyrics_text="""[Intro]
(Piano solo)

[Verso 1]
Desde lejos te observo
Y no puedo hablar
Las palabras se pierden
En el aire""",
    )

    # Create setlist
    setlist1 = Setlist(
        id="setlist-001",
        name="Set de Ensayo - Mayo 2026",
    )
    setlist1.songs = [song1, song2, song3]

    # Create gig
    gig1 = Gig(
        id="gig-001",
        name="Concierto Bar La Esquina",
        venue="La Esquina Bar",
        date=datetime(2026, 6, 15, 21, 0),
        setlist_id="setlist-001",
        status="confirmed",
    )

    # Create band members
    member1 = BandMember(
        id="member-001",
        name="Daniel Castañeda",
        role="Guitarra / Voz",
        color="#00FFFF",
    )
    member2 = BandMember(
        id="member-002",
        name="Andrés López",
        role="Batería",
        color="#CCFF00",
    )
    member3 = BandMember(
        id="member-003",
        name="María García",
        role="Bajo",
        color="#FF00FF",
    )

    session.add_all([song1, song2, song3, setlist1, gig1, member1, member2, member3])
    session.commit()
    session.close()

    print("[DB] Base de datos sembrada: 3 canciones, 1 setlist, 1 evento, 3 miembros")


if __name__ == "__main__":
    seed_database()
