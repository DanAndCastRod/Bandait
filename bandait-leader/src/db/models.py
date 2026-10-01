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
    text,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker, Mapped, mapped_column

from src.core.paths import ensure_parent_dir, get_db_path

logger = logging.getLogger(__name__)


Base = declarative_base()

# Association table: Setlist <-> Song (ordered)
setlist_song_association = Table(
    "setlist_songs",
    Base.metadata,
    Column("setlist_id", String, ForeignKey("setlists.id")),
    Column("song_id", String, ForeignKey("songs.id")),
    Column("position", Integer, default=0),
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

    setlists: Mapped[List["Setlist"]] = relationship(
        secondary=setlist_song_association,
        back_populates="songs",
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
        }


class Setlist(Base):
    __tablename__ = "setlists"
    __allow_unmapped__ = True

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    band_id: Mapped[Optional[str]] = mapped_column(String, ForeignKey("bands.id"), nullable=True, default="band_default")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

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


def load_setlist_entries(session, setlist_id: str) -> List[dict]:
    """Ordered songs of a setlist as protocol setlist entries (song_id, title, bpm,
    order_index, transition_mode). Order: position, then insertion order."""
    rows = session.execute(
        text(
            "SELECT s.id, s.title, s.bpm FROM setlist_songs ss "
            "JOIN songs s ON s.id = ss.song_id "
            "WHERE ss.setlist_id = :sid "
            "ORDER BY COALESCE(ss.position, 0), ss.rowid"
        ),
        {"sid": setlist_id},
    ).fetchall()
    return [
        {
            "song_id": str(row[0]),
            "title": row[1] or "",
            "bpm": row[2] if row[2] else 120,
            "order_index": i,
            "transition_mode": "manual_cue",
        }
        for i, row in enumerate(rows)
    ]
