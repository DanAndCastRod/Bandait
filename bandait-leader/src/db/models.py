"""SQLAlchemy ORM models for Bandait Leader."""

import logging
import os
import sqlite3
from datetime import datetime
from typing import List, Optional

from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Float,
    Boolean,
    DateTime,
    ForeignKey,
    Table,
    Text,
    event,
    inspect,
    text,
)
from sqlalchemy.orm import Session as OrmSession
from sqlalchemy.orm import declarative_base, relationship, sessionmaker, Mapped, mapped_column

from src.core.paths import ensure_parent_dir, get_db_path

logger = logging.getLogger(__name__)


Base = declarative_base()

TRANSITION_MODES = ("manual_cue", "auto_count_in", "gapless")

# Association table: Setlist <-> Song (ordered). Each row is one setlist item and
# carries how the band enters it (WORKSPACE_V2 sections 3-4). Defaults keep local
# setlists exactly as before: manual cue, no count-in.
setlist_song_association = Table(
    "setlist_songs",
    Base.metadata,
    Column("setlist_id", String, ForeignKey("setlists.id")),
    Column("song_id", String, ForeignKey("songs.id")),
    Column("position", Integer, default=0),
    Column("transition_mode", String, default="manual_cue"),
    Column("count_in_bars", Integer, default=0),
    Column("count_in_voice", Boolean, default=True),
    Column("gap_sec", Float, default=0.0),
    Column("show_key", String, default=""),
    Column("show_bpm", Float, nullable=True),  # NULL = the song's bpm
    Column("item_cloud_id", String, nullable=True),  # PlaylistSong.id in the hub
    Column("notes", Text, default=""),
)

# Association table: Gig <-> BandMember
gig_member_association = Table(
    "gig_members",
    Base.metadata,
    Column("gig_id", String, ForeignKey("gigs.id")),
    Column("member_id", String, ForeignKey("band_members.id")),
)


class User(Base):
    __tablename__ = "users"
    __allow_unmapped__ = True

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    email: Mapped[Optional[str]] = mapped_column(String, default="")
    phone: Mapped[Optional[str]] = mapped_column(String, default="")
    auth_provider: Mapped[str] = mapped_column(String, default="google")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "email": self.email,
            "phone": self.phone,
            "auth_provider": self.auth_provider,
        }


class Band(Base):
    __tablename__ = "bands"
    __allow_unmapped__ = True

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    owner_id: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    members: Mapped[List["BandMember"]] = relationship("BandMember", back_populates="band")
    setlists: Mapped[List["Setlist"]] = relationship("Setlist", back_populates="band")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "owner_id": self.owner_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class Song(Base):
    __tablename__ = "songs"
    __allow_unmapped__ = True

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    artist: Mapped[str] = mapped_column(String, default="")
    bpm: Mapped[int] = mapped_column(Integer, default=120)
    key: Mapped[str] = mapped_column(String, default="")
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    lyrics_text: Mapped[str] = mapped_column(Text, default="")
    chords_text: Mapped[str] = mapped_column(Text, default="")
    audio_path: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # Cloud (Web Hub) metadata. source == "cloud" rows are a read-only mirror of the
    # hub: only src/db/cloud_import.py writes them (see _guard_cloud_songs).
    source: Mapped[str] = mapped_column(String, default="local")  # "local" | "cloud"
    cloud_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)  # Song.id in the hub
    band_cloud_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    cloud_updated_at: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    beats_per_bar: Mapped[int] = mapped_column(Integer, default=4)
    beat_unit: Mapped[int] = mapped_column(Integer, default=4)
    camelot: Mapped[str] = mapped_column(String, default="")

    setlists: Mapped[List["Setlist"]] = relationship(
        secondary=setlist_song_association,
        back_populates="songs",
    )
    sections: Mapped[List["SongSection"]] = relationship(
        "SongSection",
        order_by="SongSection.position",
        cascade="all, delete-orphan",
        back_populates="song",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "bpm": self.bpm,
            "key": self.key,
            "duration_seconds": self.duration_seconds,
            "lyrics_text": self.lyrics_text,
            "chords_text": self.chords_text,
            "audio_path": self.audio_path,
            "source": self.source,
            "beats_per_bar": self.beats_per_bar,
        }


class SongSection(Base):
    """One section of a song in performance order (WORKSPACE_V2 section 2).

    Bars, not seconds: section n starts at bar 1 + sum(bars of the previous ones).
    ``cue_text`` is already resolved at import: NULL means no spoken cue.
    """

    __tablename__ = "song_sections"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # "<song_id>#<position>"
    song_id: Mapped[str] = mapped_column(String, ForeignKey("songs.id"), index=True, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cloud_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    kind: Mapped[str] = mapped_column(String, default="custom")
    label: Mapped[str] = mapped_column(String, default="")
    bars: Mapped[int] = mapped_column(Integer, default=1)
    chordpro: Mapped[str] = mapped_column(Text, default="")
    cue_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    song: Mapped["Song"] = relationship("Song", back_populates="sections")


class BandVoiceConfig(Base):
    """VoiceConfig of a hub band (WORKSPACE_V2 section 5). ``raw_json`` keeps the
    original object, unknown fields included."""

    __tablename__ = "band_voice_configs"

    band_cloud_id: Mapped[str] = mapped_column(String, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    provider: Mapped[str] = mapped_column(String, default="azure")
    voice: Mapped[str] = mapped_column(String, default="es-CO-SalomeNeural")
    rate: Mapped[str] = mapped_column(String, default="+0%")
    count_in: Mapped[bool] = mapped_column(Boolean, default=True)
    section_cues: Mapped[bool] = mapped_column(Boolean, default=True)
    cue_lead_bars: Mapped[int] = mapped_column(Integer, default=1)
    output: Mapped[str] = mapped_column(String, default="drummer")
    raw_json: Mapped[str] = mapped_column(Text, default="{}")


class Setlist(Base):
    __tablename__ = "setlists"
    __allow_unmapped__ = True

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    band_id: Mapped[Optional[str]] = mapped_column(String, ForeignKey("bands.id"), nullable=True, default="band_default")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Set only for setlists imported from the hub (Playlist.id and Band.id there).
    cloud_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    band_cloud_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)

    band: Mapped[Optional["Band"]] = relationship("Band", back_populates="setlists")
    songs: Mapped[List["Song"]] = relationship(
        secondary=setlist_song_association,
        back_populates="setlists",
        order_by=setlist_song_association.c.position,
    )
    gigs: Mapped[List["Gig"]] = relationship("Gig", back_populates="setlist")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "band_id": self.band_id,
            "songs": [s.to_dict() for s in self.songs],
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class BandMember(Base):
    __tablename__ = "band_members"
    __allow_unmapped__ = True

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    band_id: Mapped[Optional[str]] = mapped_column(String, ForeignKey("bands.id"), nullable=True, default="band_default")
    user_id: Mapped[str] = mapped_column(String, default="")
    role: Mapped[str] = mapped_column(String, default="")
    color: Mapped[str] = mapped_column(String, default="#00FFFF")
    email: Mapped[str] = mapped_column(String, default="")
    phone: Mapped[str] = mapped_column(String, default="")

    band: Mapped[Optional["Band"]] = relationship("Band", back_populates="members")
    gigs: Mapped[List["Gig"]] = relationship(
        secondary=gig_member_association,
        back_populates="members",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "band_id": self.band_id,
            "user_id": self.user_id,
            "role": self.role,
            "color": self.color,
        }


class Gig(Base):
    __tablename__ = "gigs"
    __allow_unmapped__ = True

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    venue: Mapped[str] = mapped_column(String, default="")
    date: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    setlist_id: Mapped[Optional[str]] = mapped_column(String, ForeignKey("setlists.id"))
    notes: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String, default="planned")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    setlist: Mapped[Optional["Setlist"]] = relationship("Setlist", back_populates="gigs")
    members: Mapped[List["BandMember"]] = relationship(
        secondary=gig_member_association,
        back_populates="gigs",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "venue": self.venue,
            "date": self.date.isoformat() if self.date else None,
            "setlist_id": self.setlist_id,
            "setlist": self.setlist.to_dict() if self.setlist else None,
            "notes": self.notes,
            "status": self.status,
            "members": [m.to_dict() for m in self.members],
        }


class Rehearsal(Base):
    __tablename__ = "rehearsals"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    date: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    setlist_id: Mapped[Optional[str]] = mapped_column(String, ForeignKey("setlists.id"))
    recording_folder: Mapped[str] = mapped_column(String, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    duration_minutes: Mapped[int] = mapped_column(Integer, default=0)

    setlist: Mapped[Optional["Setlist"]] = relationship("Setlist")


# --- Database setup ---

def _literal_default(column) -> Optional[str]:
    """SQL literal for a scalar Python-side default, or None (column stays NULL)."""
    default = column.default
    if default is None or not getattr(default, "is_scalar", False):
        return None
    value = default.arg
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return None


def _backup_path(db_path: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    candidate = f"{db_path}.bak-{stamp}"
    n = 1
    while os.path.exists(candidate):
        candidate = f"{db_path}.bak-{stamp}-{n}"
        n += 1
    return candidate


def plan_migrations(db_path: str) -> List[str]:
    """ALTER statements needed to add model columns missing from an existing DB."""
    if not os.path.exists(db_path):
        return []
    from sqlalchemy.dialects import sqlite as sqlite_dialect

    dialect = sqlite_dialect.dialect()
    con = sqlite3.connect(db_path)
    try:
        existing_tables = {
            row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        statements: List[str] = []
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue  # created by create_all
            have = {row[1] for row in con.execute(f'PRAGMA table_info("{table.name}")')}
            for column in table.columns:
                if column.name in have:
                    continue
                if column.primary_key:
                    raise RuntimeError(
                        f"No se puede migrar {table.name}.{column.name}: es clave primaria"
                    )
                col_type = column.type.compile(dialect=dialect)
                ddl = f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}'
                literal = _literal_default(column)
                if literal is not None:
                    ddl += f" DEFAULT {literal}"
                statements.append(ddl)
        return statements
    finally:
        con.close()


def migrate_db(db_path: str) -> Optional[str]:
    """Idempotent additive migration. Backs the file up before any ALTER.

    Returns the backup path when a migration ran, None when nothing was needed.
    Never drops or rewrites existing data.
    """
    statements = plan_migrations(db_path)
    if not statements:
        return None
    backup = _backup_path(db_path)
    src = sqlite3.connect(db_path)
    try:
        dst = sqlite3.connect(backup)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    con = sqlite3.connect(db_path)
    try:
        with con:  # one transaction: all columns or none
            for ddl in statements:
                con.execute(ddl)
    finally:
        con.close()
    logger.warning("DB migrada (%d columnas nuevas). Respaldo: %s", len(statements), backup)
    return backup


def init_db(db_path: Optional[str] = None) -> sessionmaker:
    """Open (and migrate if needed) the SQLite database. Honors BANDAIT_DB."""
    if db_path is None:
        db_path = get_db_path()
    if db_path != ":memory:":
        ensure_parent_dir(db_path)
        migrate_db(db_path)
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


def _int_or(value, default: int, lo: int, hi: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, number))


def _float_or(value, default: float, lo: float, hi: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN
        return default
    return max(lo, min(hi, number))


def load_setlist_entries(session, setlist_id: str) -> List[dict]:
    """Ordered songs of a setlist as protocol setlist entries.

    Keys of CONTRACT_V3 (song_id, title, bpm, order_index, transition_mode) plus
    what wave 2 needs for count-in, transitions and the prompter (CONTRACT_V3 9):
    count_in_bars, count_in_voice, gap_sec, show_key, key, artist, beats_per_bar,
    total_bars (None without sections) and sections with start_bar.
    Order: position, then insertion order. ``bpm`` is the show bpm when the item
    overrides it.
    """
    rows = session.execute(
        text(
            "SELECT s.id, s.title, s.bpm, ss.transition_mode, ss.count_in_bars, "
            "ss.count_in_voice, ss.gap_sec, ss.show_key, ss.show_bpm, s.key, s.artist, "
            "s.beats_per_bar, s.source, ss.item_cloud_id, ss.notes "
            "FROM setlist_songs ss "
            "JOIN songs s ON s.id = ss.song_id "
            "WHERE ss.setlist_id = :sid "
            "ORDER BY COALESCE(ss.position, 0), ss.rowid"
        ),
        {"sid": setlist_id},
    ).fetchall()
    song_ids = sorted({str(row[0]) for row in rows})
    sections: dict = {sid: [] for sid in song_ids}
    if song_ids:
        params = {f"s{i}": sid for i, sid in enumerate(song_ids)}
        placeholders = ", ".join(f":s{i}" for i in range(len(song_ids)))
        section_rows = session.execute(
            text(
                "SELECT song_id, cloud_id, kind, label, bars, chordpro, cue_text, id "
                f"FROM song_sections WHERE song_id IN ({placeholders}) "
                "ORDER BY song_id, position"
            ),
            params,
        ).fetchall()
        for srow in section_rows:
            sections.setdefault(str(srow[0]), []).append(srow)

    entries: List[dict] = []
    for i, row in enumerate(rows):
        song_id = str(row[0])
        song_bpm = row[2] if row[2] else 120
        show_bpm = row[8]
        mode = row[3] if row[3] in TRANSITION_MODES else "manual_cue"
        song_sections = []
        start_bar = 1
        for srow in sections.get(song_id, []):
            bars = _int_or(srow[4], 0, 0, 100000)
            if bars < 1:
                continue
            song_sections.append(
                {
                    "id": srow[1] or srow[7],
                    "kind": srow[2] or "custom",
                    "label": srow[3] or "",
                    "bars": bars,
                    "start_bar": start_bar,
                    "chordpro": srow[5] or "",
                    "cue_text": srow[6],
                }
            )
            start_bar += bars
        entries.append(
            {
                "song_id": song_id,
                "title": row[1] or "",
                "bpm": show_bpm if show_bpm else song_bpm,
                "order_index": i,
                "transition_mode": mode,
                "count_in_bars": _int_or(row[4], 0, 0, 4),
                "count_in_voice": bool(row[5]) if row[5] is not None else True,
                "gap_sec": _float_or(row[6], 0.0, 0.0, 30.0),
                "show_key": row[7] or "",
                "key": row[9] or "",
                "artist": row[10] or "",
                "beats_per_bar": _int_or(row[11], 4, 1, 12),
                "source": row[12] or "local",
                "item_cloud_id": row[13],
                "notes": row[14] or "",
                "total_bars": (start_bar - 1) if song_sections else None,
                "sections": song_sections,
            }
        )
    return entries


def list_cloud_setlists(session, band_cloud_id: Optional[str] = None) -> List[dict]:
    """Setlists imported from the hub (optionally of one band), with song counts."""
    sql = (
        "SELECT sl.id, sl.name, sl.cloud_id, sl.band_cloud_id, "
        "(SELECT COUNT(*) FROM setlist_songs ss JOIN songs s ON s.id = ss.song_id "
        " WHERE ss.setlist_id = sl.id) "
        "FROM setlists sl WHERE sl.cloud_id IS NOT NULL"
    )
    params = {}
    if band_cloud_id is not None:
        sql += " AND sl.band_cloud_id = :band"
        params["band"] = band_cloud_id
    sql += " ORDER BY sl.name, sl.id"
    return [
        {"id": r[0], "name": r[1] or "", "cloud_id": r[2], "band_cloud_id": r[3], "songs": int(r[4] or 0)}
        for r in session.execute(text(sql), params).fetchall()
    ]


# --- Cloud songs are read-only outside the importer ---

CLOUD_WRITE_FLAG = "bandait_cloud_write"


def _was_cloud(obj) -> bool:
    state = inspect(obj)
    original = state.committed_state.get("source", obj.source)
    return original == "cloud" or obj.source == "cloud"


@event.listens_for(OrmSession, "before_flush")
def _guard_cloud_songs(session, flush_context, instances):
    """Discard ORM edits or deletes of hub songs (the hub is the source of truth).

    Never raises: an exception here would leave the caller's session needing a
    rollback, and the library view would stop reading the live setlist.
    The importer sets ``session.info[CLOUD_WRITE_FLAG]`` and uses Core statements.
    """
    if session.info.get(CLOUD_WRITE_FLAG):
        return
    for obj in list(session.dirty):
        if isinstance(obj, Song) and session.is_modified(obj) and _was_cloud(obj):
            logger.warning("Cancion de la nube %s es de solo lectura: se descarta la edicion", obj.id)
            session.expire(obj)
    for obj in list(session.deleted):
        if isinstance(obj, Song) and _was_cloud(obj):
            logger.warning("Cancion de la nube %s es de solo lectura: no se borra", obj.id)
            session.expunge(obj)
