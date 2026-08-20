"""Pure domain models (immutable dataclasses)."""

from dataclasses import dataclass, field
from enum import StrEnum


class SessionStatus(StrEnum):
    IDLE = "IDLE"
    COUNTING = "COUNTING"
    PLAYING = "PLAYING"
    PAUSED = "PAUSED"


class MessageType(StrEnum):
    SYNC_BEACON = "SYNC_BEACON"
    STATE_UPDATE = "STATE_UPDATE"
    SONG_LOAD = "SONG_LOAD"
    PLAY = "PLAY"
    STOP = "STOP"
    PANIC = "PANIC"
    FULL_STATE = "FULL_STATE"


@dataclass(frozen=True)
class LyricLine:
    time: float
    text: str


@dataclass(frozen=True)
class ChordSegment:
    label: str
    bars: int


@dataclass(frozen=True)
class Song:
    id: str
    title: str
    bpm: int
    key: str = ""
    segments: list[ChordSegment] = field(default_factory=list)
    lyrics: list[LyricLine] = field(default_factory=list)
    audio_path: str | None = None


@dataclass(frozen=True)
class Setlist:
    id: str
    name: str
    songs: list[Song] = field(default_factory=list)


@dataclass(frozen=True)
class BandMember:
    id: str
    name: str
    role: str  # e.g., "vocals", "drums", "bass"
    color: str = "#00FFFF"


@dataclass(frozen=True)
class Gig:
    id: str
    name: str
    venue: str
    date: str
    setlist_id: str
    members: list[str] = field(default_factory=list)
    notes: str = ""


@dataclass(frozen=True)
class SessionState:
    session_id: str
    leader_ip: str
    status: SessionStatus
    current_song_id: str | None
    next_event_timestamp: int  # nanoseconds from leader monotonic clock
    bpm: int
    beat: int = 0  # 1-4
