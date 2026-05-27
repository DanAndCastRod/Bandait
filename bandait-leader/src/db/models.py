"""SQLAlchemy ORM models for Bandait Leader."""

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
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

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


class Song(Base):
    __tablename__ = "songs"

    id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    bpm = Column(Integer, default=120)
    key = Column(String, default="")
    duration_seconds = Column(Float, default=0.0)
    lyrics_text = Column(Text, default="")
    chords_text = Column(Text, default="")
    audio_path = Column(String, default="")
    created_at = Column(DateTime, default=datetime.utcnow)

    setlists: List["Setlist"] = relationship(
        "Setlist",
        secondary=setlist_song_association,
        back_populates="songs",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "bpm": self.bpm,
            "key": self.key,
            "duration_seconds": self.duration_seconds,
            "lyrics_text": self.lyrics_text,
            "chords_text": self.chords_text,
            "audio_path": self.audio_path,
        }


class Setlist(Base):
    __tablename__ = "setlists"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    songs: List[Song] = relationship(
        Song,
        secondary=setlist_song_association,
        back_populates="setlists",
        order_by=setlist_song_association.c.position,
    )
    gigs: List["Gig"] = relationship("Gig", back_populates="setlist")

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "songs": [s.to_dict() for s in self.songs],
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class BandMember(Base):
    __tablename__ = "band_members"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    role = Column(String, default="")  # e.g., "vocals", "drums", "bass"
    color = Column(String, default="#00FFFF")
    email = Column(String, default="")
    phone = Column(String, default="")

    gigs: List["Gig"] = relationship(
        "Gig",
        secondary=gig_member_association,
        back_populates="members",
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "color": self.color,
        }


class Gig(Base):
    __tablename__ = "gigs"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    venue = Column(String, default="")
    date = Column(DateTime, nullable=False)
    setlist_id = Column(String, ForeignKey("setlists.id"))
    notes = Column(Text, default="")
    status = Column(String, default="planned")  # planned, confirmed, completed, cancelled
    created_at = Column(DateTime, default=datetime.utcnow)

    setlist: Optional[Setlist] = relationship("Setlist", back_populates="gigs")
    members: List[BandMember] = relationship(
        BandMember,
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

    id = Column(String, primary_key=True)
    date = Column(DateTime, default=datetime.utcnow)
    setlist_id = Column(String, ForeignKey("setlists.id"))
    recording_folder = Column(String, default="")
    notes = Column(Text, default="")
    duration_minutes = Column(Integer, default=0)

    setlist: Optional[Setlist] = relationship("Setlist")


# --- Database setup ---

def init_db(db_path: str = "bandait.db") -> sessionmaker:
    engine = create_engine(f"sqlite:///{db_path}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)
