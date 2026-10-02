"""Local edits of the leader library: songs, setlists and events (gigs).

Hub rows are read-only here: songs with ``source == 'cloud'`` and setlists with a
``cloud_id`` are edited in the hub and arrive with a sync. Every function checks
that *before* touching the session and raises ``CloudReadOnly`` with the message
the user should see. (For songs, ``models._guard_cloud_songs`` would also discard
the write, but silently: the UI would then claim a change that never happened.)

Demo rows can be edited: an edited demo row becomes the user's (``'local'``), so
"Quitar datos de demostración" no longer deletes it.

Setlist items are written with Core statements on ``setlist_songs``: the
``Setlist.songs`` relationship cannot carry the per-item columns (transition,
count-in, show key), and those must survive an edit of the setlist.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import List, Optional, Tuple

from sqlalchemy import delete, insert, select, update

from .models import (
    DEMO_SOURCE,
    Gig,
    Setlist,
    Song,
    gig_member_association,
    setlist_song_association,
)

items_t = setlist_song_association

CLOUD_SONG_EDIT = "Esta canción viene del hub: edítala en bandait.releven.cc/hub y sincroniza."
CLOUD_SONG_DELETE = "Esta canción viene del hub: bórrala en bandait.releven.cc/hub y sincroniza."
CLOUD_SETLIST_EDIT = (
    "Este setlist viene del hub: edítalo en bandait.releven.cc/hub y sincroniza. "
    "Para cambiarlo solo en este equipo, usa Duplicar y edita la copia."
)
CLOUD_SETLIST_DELETE = "Este setlist viene del hub: bórralo en bandait.releven.cc/hub y sincroniza."

METERS = ("4/4", "3/4", "6/8", "2/4", "12/8", "5/4", "7/8")
BPM_RANGE = (20, 400)
MAX_DURATION_S = 24 * 3600
MAX_TEXT = 200_000
MAX_NAME = 200

# Item columns kept when a local setlist is edited (everything but the keys).
_ITEM_EXTRAS = ("transition_mode", "count_in_bars", "count_in_voice", "gap_sec", "show_key", "show_bpm", "notes")

# A chord inside brackets: root, then only chord vocabulary. "[Am7]", "[F#m7b5]",
# "[C/E]", "[D(add9)]" are chords; "[Coro]", "[Intro]", "[Estrofa 1]" are not.
_CHORD = re.compile(
    r"\[([A-G](?:#|b)?(?:maj|min|dim|aug|sus|add|m|M|\+|°|ø|\d+|\(|\)|#|b|-)*(?:/[A-G](?:#|b)?)?)\]"
)


class LibraryEditError(ValueError):
    """A change the library refuses; ``str(e)`` is the message for the user."""


class CloudReadOnly(LibraryEditError):
    """The row belongs to the hub."""


def new_id(prefix: str) -> str:
    return f"{prefix}-local-{uuid.uuid4().hex[:12]}"


def _commit(session) -> None:
    try:
        session.commit()
    except Exception:
        session.rollback()
        raise


# ------------------------------------------------------------------ songs

@dataclass
class SongFields:
    title: str
    artist: str = ""
    bpm: int = 120
    key: str = ""
    beats_per_bar: int = 4
    beat_unit: int = 4
    duration_seconds: float = 0.0
    text: str = ""  # lyrics, or ChordPro with chords in brackets


def parse_meter(meter: str) -> Tuple[int, int]:
    """'6/8' -> (6, 8). Raises LibraryEditError."""
    try:
        num, den = (int(x) for x in str(meter).strip().split("/"))
    except Exception:
        raise LibraryEditError(f"Compás inválido: {meter!r}. Usa el formato 4/4.") from None
    if not 1 <= num <= 16 or den not in (2, 4, 8, 16):
        raise LibraryEditError(f"Compás inválido: {meter}. Usa entre 1 y 16 pulsos sobre 2, 4, 8 o 16.")
    return num, den


def parse_duration(text: str) -> float:
    """'3:45' or '03:45' -> 225.0; '' -> 0. Raises LibraryEditError."""
    text = (text or "").strip()
    if not text:
        return 0.0
    m = re.fullmatch(r"(\d{1,3}):([0-5]\d)", text)
    if not m:
        raise LibraryEditError("Duración inválida: usa el formato mm:ss, por ejemplo 3:45.")
    seconds = int(m.group(1)) * 60 + int(m.group(2))
    if seconds > MAX_DURATION_S:
        raise LibraryEditError("Duración inválida: el máximo es 24 horas.")
    return float(seconds)


def format_duration(seconds) -> str:
    try:
        total = int(round(float(seconds or 0)))
    except (TypeError, ValueError):
        total = 0
    return f"{total // 60}:{total % 60:02d}" if total > 0 else ""


def validate_song(fields: SongFields) -> SongFields:
    title = (fields.title or "").strip()
    if not title:
        raise LibraryEditError("Escribe el título de la canción.")
    if len(title) > MAX_NAME:
        raise LibraryEditError(f"El título es muy largo (máximo {MAX_NAME} caracteres).")
    try:
        bpm = int(fields.bpm)
    except (TypeError, ValueError):
        raise LibraryEditError("El tempo debe ser un número entero de BPM.") from None
    if not BPM_RANGE[0] <= bpm <= BPM_RANGE[1]:
        raise LibraryEditError(f"El tempo debe estar entre {BPM_RANGE[0]} y {BPM_RANGE[1]} BPM.")
    parse_meter(f"{fields.beats_per_bar}/{fields.beat_unit}")
    duration = float(fields.duration_seconds or 0)
    if not 0 <= duration <= MAX_DURATION_S:
        raise LibraryEditError("Duración inválida: el máximo es 24 horas.")
    text = (fields.text or "").replace("\r\n", "\n").replace("\r", "\n")
    if len(text) > MAX_TEXT:
        raise LibraryEditError("La letra es muy larga.")
    return SongFields(
        title=title, artist=(fields.artist or "").strip()[:MAX_NAME], bpm=bpm,
        key=(fields.key or "").strip()[:12], beats_per_bar=int(fields.beats_per_bar),
        beat_unit=int(fields.beat_unit), duration_seconds=duration, text=text.strip("\n"),
    )


def split_song_text(text: str) -> Tuple[str, str]:
    """(lyrics_text, chords_text) from what the user typed.

    With chords or ChordPro directives the full text goes to ``chords_text`` and
    ``lyrics_text`` keeps only the words (section lines like "[Coro]" stay, chord-only
    lines go). Without chords, it is plain lyrics and ``chords_text`` is empty."""
    text = (text or "").strip("\n")
    lines = text.split("\n") if text else []
    has_chords = any(_CHORD.search(line) for line in lines)
    has_directives = any(line.strip().startswith("{") for line in lines)
    if not (has_chords or has_directives):
        return text, ""
    words = []
    for line in lines:
        if line.strip().startswith("{"):
            continue
        stripped = _CHORD.sub("", line)
        if _CHORD.search(line) and not stripped.strip():
            continue  # chord-only line (intro, instrumental)
        words.append(re.sub(r" {2,}", " ", stripped).rstrip())
    return "\n".join(words).strip("\n"), text


def song_text(song) -> str:
    """What the editor shows: the ChordPro text if there is one, else the lyrics."""
    return (song.chords_text or "") or (song.lyrics_text or "")


def song_fields(song) -> SongFields:
    return SongFields(
        title=song.title or "", artist=song.artist or "", bpm=song.bpm or 120, key=song.key or "",
        beats_per_bar=song.beats_per_bar or 4, beat_unit=song.beat_unit or 4,
        duration_seconds=song.duration_seconds or 0.0, text=song_text(song),
    )


def _is_cloud_song(song) -> bool:
    return (song.source or "local") == "cloud"


def _get_song(session, song_id: str) -> Song:
    song = session.get(Song, song_id) if song_id else None
    if song is None:
        raise LibraryEditError("La canción ya no existe en la biblioteca.")
    return song


def _apply_song(song: Song, fields: SongFields) -> None:
    lyrics, chords = split_song_text(fields.text)
    song.title = fields.title
    song.artist = fields.artist
    song.bpm = fields.bpm
    song.key = fields.key
    song.beats_per_bar = fields.beats_per_bar
    song.beat_unit = fields.beat_unit
    song.duration_seconds = fields.duration_seconds
    song.lyrics_text = lyrics
    song.chords_text = chords


def create_song(session, fields: SongFields) -> Song:
    fields = validate_song(fields)
    song = Song(id=new_id("song"), source="local")
    _apply_song(song, fields)
    session.add(song)
    _commit(session)
    return song


def update_song(session, song_id: str, fields: SongFields) -> Song:
    song = _get_song(session, song_id)
    if _is_cloud_song(song):
        raise CloudReadOnly(CLOUD_SONG_EDIT)
    fields = validate_song(fields)
    _apply_song(song, fields)
    if song.source == DEMO_SOURCE:
        song.source = "local"
    _commit(session)
    return song


def song_setlist_names(session, song_id: str) -> List[str]:
    rows = session.execute(
        select(Setlist.name).join(items_t, items_t.c.setlist_id == Setlist.id)
        .where(items_t.c.song_id == song_id).distinct().order_by(Setlist.name)
    ).fetchall()
    return [r[0] or "" for r in rows]


def delete_song(session, song_id: str) -> List[str]:
    """Delete a local or demo song and its setlist items. Returns the names of the
    setlists it was removed from."""
    song = _get_song(session, song_id)
    if _is_cloud_song(song):
        raise CloudReadOnly(CLOUD_SONG_DELETE)
    names = song_setlist_names(session, song_id)
    try:
        session.execute(delete(items_t).where(items_t.c.song_id == song_id))
        session.delete(song)  # sections go with it (delete-orphan)
        session.commit()
    except Exception:
        session.rollback()
        raise
    return names


# ------------------------------------------------------------------ setlists

def is_cloud_setlist(setlist) -> bool:
    return bool(getattr(setlist, "cloud_id", None))


def _get_setlist(session, setlist_id: str) -> Setlist:
    setlist = session.get(Setlist, setlist_id) if setlist_id else None
    if setlist is None:
        raise LibraryEditError("El setlist ya no existe en la biblioteca.")
    return setlist


def validate_setlist_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise LibraryEditError("Escribe el nombre del setlist.")
    if len(name) > MAX_NAME:
        raise LibraryEditError(f"El nombre es muy largo (máximo {MAX_NAME} caracteres).")
    return name


def setlist_song_ids(session, setlist_id: str) -> List[str]:
    rows = session.execute(
        select(items_t.c.song_id).where(items_t.c.setlist_id == setlist_id)
        .order_by(items_t.c.position)
    ).fetchall()
    return [r[0] for r in rows]


def _checked_song_ids(session, song_ids) -> List[str]:
    """Order kept, duplicates dropped; every id must exist."""
    seen, out = set(), []
    for sid in song_ids or []:
        if sid in seen:
            continue
        if session.get(Song, sid) is None:
            raise LibraryEditError("Una de las canciones elegidas ya no existe: vuelve a abrir el editor.")
        seen.add(sid)
        out.append(sid)
    return out


def _write_items(session, setlist_id: str, song_ids: List[str], extras: Optional[dict] = None) -> None:
    extras = extras or {}
    session.execute(delete(items_t).where(items_t.c.setlist_id == setlist_id))
    for position, sid in enumerate(song_ids):
        row = {"setlist_id": setlist_id, "song_id": sid, "position": position}
        row.update(extras.get(sid, {}))
        session.execute(insert(items_t).values(**row))


def create_setlist(session, name: str, song_ids) -> Setlist:
    name = validate_setlist_name(name)
    ids = _checked_song_ids(session, song_ids)
    setlist = Setlist(id=new_id("setlist"), name=name, source="local")
    try:
        session.add(setlist)
        session.flush()
        _write_items(session, setlist.id, ids)
        session.commit()
    except Exception:
        session.rollback()
        raise
    session.expire(setlist, ["songs"])
    return setlist


def update_setlist(session, setlist_id: str, name: str, song_ids) -> Setlist:
    """Rename and reorder a local setlist. Songs that stay keep their item
    settings (transition, count-in, show key); new ones get the defaults."""
    setlist = _get_setlist(session, setlist_id)
    if is_cloud_setlist(setlist):
        raise CloudReadOnly(CLOUD_SETLIST_EDIT)
    name = validate_setlist_name(name)
    ids = _checked_song_ids(session, song_ids)
    old = session.execute(
        select(items_t).where(items_t.c.setlist_id == setlist_id).order_by(items_t.c.position)
    ).mappings().fetchall()
    extras = {}
    for row in old:
        extras.setdefault(row["song_id"], {k: row[k] for k in _ITEM_EXTRAS})
    try:
        setlist.name = name
        setlist.updated_at = datetime.utcnow()
        if setlist.source == DEMO_SOURCE:
            setlist.source = "local"
        _write_items(session, setlist_id, ids, extras)
        session.commit()
    except Exception:
        session.rollback()
        raise
    session.expire(setlist, ["songs"])
    return setlist


def _copy_name(session, name: str) -> str:
    base = f"Copia de {name}"[:MAX_NAME]
    taken = {r[0] for r in session.execute(select(Setlist.name)).fetchall()}
    if base not in taken:
        return base
    n = 2
    while f"{base} ({n})" in taken:
        n += 1
    return f"{base} ({n})"


def duplicate_setlist(session, setlist_id: str) -> Setlist:
    """Local copy of any setlist, hub ones included: same songs, same item
    settings, editable here. The copy is never linked to the hub."""
    source = _get_setlist(session, setlist_id)
    rows = session.execute(
        select(items_t).where(items_t.c.setlist_id == setlist_id).order_by(items_t.c.position)
    ).mappings().fetchall()
    copy = Setlist(id=new_id("setlist"), name=_copy_name(session, source.name or "setlist"), source="local")
    try:
        session.add(copy)
        session.flush()
        for position, row in enumerate(rows):
            values = {k: row[k] for k in _ITEM_EXTRAS}
            values.update(setlist_id=copy.id, song_id=row["song_id"], position=position, item_cloud_id=None)
            session.execute(insert(items_t).values(**values))
        session.commit()
    except Exception:
        session.rollback()
        raise
    session.expire(copy, ["songs"])
    return copy


def delete_setlist(session, setlist_id: str) -> int:
    """Delete a local or demo setlist. Events that used it keep existing without a
    setlist; returns how many."""
    setlist = _get_setlist(session, setlist_id)
    if is_cloud_setlist(setlist):
        raise CloudReadOnly(CLOUD_SETLIST_DELETE)
    try:
        unlinked = session.execute(
            update(Gig.__table__).where(Gig.__table__.c.setlist_id == setlist_id).values(setlist_id=None)
        ).rowcount or 0
        session.execute(delete(items_t).where(items_t.c.setlist_id == setlist_id))
        session.delete(setlist)
        session.commit()
    except Exception:
        session.rollback()
        raise
    session.expire_all()
    return int(unlinked)


def gigs_using_setlist(session, setlist_id: str) -> int:
    return len(session.execute(select(Gig.id).where(Gig.setlist_id == setlist_id)).fetchall())


# ------------------------------------------------------------------ events (gigs)

@dataclass
class GigFields:
    name: str
    date: datetime
    venue: str = ""
    setlist_id: Optional[str] = None
    notes: str = ""


GIG_TODAY, GIG_UPCOMING, GIG_PAST = "hoy", "proximo", "pasado"
GIG_LABELS = {GIG_TODAY: "HOY", GIG_UPCOMING: "PRÓXIMO", GIG_PAST: "PASADO"}


def gig_when(date: Optional[datetime], now: Optional[datetime] = None) -> str:
    now = now or datetime.now()
    if date is None:
        return GIG_PAST
    if date.date() == now.date():
        return GIG_TODAY
    return GIG_UPCOMING if date > now else GIG_PAST


def validate_gig(session, fields: GigFields) -> GigFields:
    name = (fields.name or "").strip()
    if not name:
        raise LibraryEditError("Escribe el nombre del evento.")
    if len(name) > MAX_NAME:
        raise LibraryEditError(f"El nombre es muy largo (máximo {MAX_NAME} caracteres).")
    if not isinstance(fields.date, datetime):
        raise LibraryEditError("Elige la fecha y la hora del evento.")
    setlist_id = fields.setlist_id or None
    if setlist_id and session.get(Setlist, setlist_id) is None:
        raise LibraryEditError("El setlist elegido ya no existe: elige otro.")
    return GigFields(
        name=name, date=fields.date.replace(second=0, microsecond=0),
        venue=(fields.venue or "").strip()[:MAX_NAME], setlist_id=setlist_id,
        notes=(fields.notes or "").strip()[:MAX_TEXT],
    )


def _get_gig(session, gig_id: str) -> Gig:
    gig = session.get(Gig, gig_id) if gig_id else None
    if gig is None:
        raise LibraryEditError("El evento ya no existe.")
    return gig


def gig_fields(gig) -> GigFields:
    return GigFields(name=gig.name or "", date=gig.date, venue=gig.venue or "",
                     setlist_id=gig.setlist_id, notes=gig.notes or "")


def list_gigs(session) -> List[Gig]:
    return list(session.execute(select(Gig).order_by(Gig.date, Gig.name)).scalars())


def create_gig(session, fields: GigFields) -> Gig:
    fields = validate_gig(session, fields)
    gig = Gig(id=new_id("gig"), name=fields.name, date=fields.date, venue=fields.venue,
              setlist_id=fields.setlist_id, notes=fields.notes, source="local")
    session.add(gig)
    _commit(session)
    return gig


def update_gig(session, gig_id: str, fields: GigFields) -> Gig:
    gig = _get_gig(session, gig_id)
    fields = validate_gig(session, fields)
    gig.name, gig.date, gig.venue = fields.name, fields.date, fields.venue
    gig.setlist_id, gig.notes = fields.setlist_id, fields.notes
    if gig.source == DEMO_SOURCE:
        gig.source = "local"
    _commit(session)
    return gig


def delete_gig(session, gig_id: str) -> None:
    gig = _get_gig(session, gig_id)
    try:
        session.execute(delete(gig_member_association).where(gig_member_association.c.gig_id == gig_id))
        session.delete(gig)
        session.commit()
    except Exception:
        session.rollback()
        raise
