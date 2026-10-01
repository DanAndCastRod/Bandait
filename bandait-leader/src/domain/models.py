"""Pure domain models (immutable dataclasses)."""

import uuid
from dataclasses import dataclass, field
from typing import List, Optional, Tuple
from enum import Enum


class SessionStatus(str, Enum):
    IDLE = "IDLE"
    COUNTING = "COUNTING"
    PLAYING = "PLAYING"
    PAUSED = "PAUSED"


class MessageType(str, Enum):
    SYNC_BEACON = "SYNC_BEACON"
    STATE_UPDATE = "STATE_UPDATE"
    SONG_LOAD = "SONG_LOAD"
    PLAY = "PLAY"
    STOP = "STOP"
    PANIC = "PANIC"
    FULL_STATE = "FULL_STATE"
    SETLIST_JUMP = "SETLIST_JUMP"
    COMMAND_ACK = "COMMAND_ACK"


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
    segments: List[ChordSegment] = field(default_factory=list)
    lyrics: List[LyricLine] = field(default_factory=list)
    audio_path: Optional[str] = None


@dataclass(frozen=True)
class Setlist:
    id: str
    name: str
    songs: List[Song] = field(default_factory=list)


class MemberRole(str, Enum):
    OWNER = "Owner"
    MUSIC_DIRECTOR = "MusicDirector"
    MUSICIAN = "Musician"
    SUBSTITUTE = "Substitute"
    SOUND_ENGINEER = "SoundEngineer"


class AuthProvider(str, Enum):
    GOOGLE = "google"
    OTP_WHATSAPP = "otp_whatsapp"
    OTP_SMS = "otp_sms"


@dataclass(frozen=True)
class UserProfile:
    id: str
    name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    auth_provider: AuthProvider = AuthProvider.GOOGLE
    created_at: str = ""


@dataclass(frozen=True)
class UserSession:
    token: str
    user_id: str
    user_name: str
    active_band_id: str
    role: MemberRole
    expires_at: float


class TransitionMode(str, Enum):
    MANUAL_CUE = "manual_cue"
    AUTO_COUNT_IN = "auto_count_in"
    GAPLESS = "gapless"


@dataclass(frozen=True)
class PlaylistItem:
    id: str
    playlist_id: str
    song_id: str
    order: int
    show_key: str = ""
    target_bpm: Optional[int] = None
    transition_mode: TransitionMode = TransitionMode.MANUAL_CUE
    count_in_bars: int = 2
    transition_notes: str = ""
    created_at: str = ""
    updated_at: str = ""


@dataclass(frozen=True)
class Band:
    id: str
    name: str
    owner_id: str
    created_at: str = ""


@dataclass(frozen=True)
class BandMember:
    id: str
    band_id: str = "band_default"
    user_id: str = ""
    name: str = ""
    phone: str = ""  # WhatsApp / SMS OTP
    email: str = ""
    role: MemberRole = MemberRole.MUSICIAN
    instrument: str = ""  # e.g., "vocals", "drums", "bass"
    color: str = "#00FFFF"


@dataclass(frozen=True)
class Gig:
    id: str
    name: str
    venue: str
    date: str
    setlist_id: str
    members: List[str] = field(default_factory=list)
    notes: str = ""


@dataclass(frozen=True)
class ExcelSongRow:
    id: str
    titulo: str
    artista: str
    bpm_original: int
    tono_original: str
    duracion_segundos: float
    letra_chordpro: str


@dataclass(frozen=True)
class ExcelSetlistRow:
    setlist_id: str
    nombre_show: str
    cancion_id: str
    orden: int
    tono_show: str
    modo_transicion: str
    notas: str


@dataclass(frozen=True)
class ExcelEquipoRow:
    usuario_id: str
    nombre: str
    telefono: str
    rol: str


@dataclass(frozen=True)
class ExcelMasterWorkbook:
    canciones: List[ExcelSongRow] = field(default_factory=list)
    setlists: List[ExcelSetlistRow] = field(default_factory=list)
    equipo: List[ExcelEquipoRow] = field(default_factory=list)


class CommandType(str, Enum):
    """CONTRACT_V3 section 3. Anything else is rejected with ``invalid_type``."""

    PLAY = "PLAY"
    STOP = "STOP"
    PAUSE = "PAUSE"
    RESUME = "RESUME"
    CUE_NEXT = "CUE_NEXT"
    CUE_PREV = "CUE_PREV"
    JUMP_SONG = "JUMP_SONG"
    TEMPO_NUDGE = "TEMPO_NUDGE"
    PANIC = "PANIC"

    @classmethod
    def parse(cls, value: object) -> Optional["CommandType"]:
        """Strict parse: exact upper-case names only, never a fallback."""
        if not isinstance(value, str):
            return None
        try:
            return cls(value)
        except ValueError:
            return None


class CommandOrigin(str, Enum):
    DIRECTOR_MOBILE = "director_mobile"
    LAPTOP_FOH = "laptop_foh"
    HUB = "hub"


class ClientRole(str, Enum):
    MUSICIAN = "musician"
    DIRECTOR = "director"
    FOH = "foh"
    HUB = "hub"


PROTOCOL_VERSION = 3

# CONTRACT_V3 section 4: one UUID per leader process. state_version restarts at 1
# when the leader restarts; followers detect the restart by this id changing.
LEADER_INSTANCE_ID = str(uuid.uuid4())


@dataclass(frozen=True)
class SetlistEntry:
    song_id: str
    title: str
    bpm: float
    order_index: int
    transition_mode: str = TransitionMode.MANUAL_CUE.value

    def to_wire(self) -> dict:
        return {
            "song_id": self.song_id,
            "title": self.title,
            "bpm": self.bpm,
            "order_index": self.order_index,
            "transition_mode": self.transition_mode,
        }


@dataclass(frozen=True)
class LastCommand:
    command_id: str
    type: str
    origin: str

    def to_wire(self) -> dict:
        return {"command_id": self.command_id, "type": self.type, "origin": self.origin}


@dataclass(frozen=True)
class SetlistJumpAlert:
    song_id: str
    title: str
    order_index: int  # 0-based, same as SessionState.current_order_index
    previous_song_id: Optional[str] = None
    triggered_by: str = "laptop_foh"
    timestamp_ns: int = 0

    def to_wire(self, session_id: str) -> dict:
        return {
            "session_id": session_id,
            "song_id": self.song_id,
            "title": self.title,
            "order_index": self.order_index,
            "previous_song_id": self.previous_song_id,
            "triggered_by": self.triggered_by,
            "timestamp_ns": self.timestamp_ns,
        }


@dataclass(frozen=True)
class ConcurrentCommand:
    """A validated transport command.

    ``received_ns`` is the leader clock at receipt. It is the only time used for
    ordering (last-write-wins, rule 10); client clocks never participate.
    """

    command_id: str
    command_type: CommandType
    origin: str
    sender_id: str
    session_id: str
    received_ns: int
    payload: dict = field(default_factory=dict)


@dataclass(frozen=True)
class SessionState:
    """CONTRACT_V3 SessionState. ``leader_time_ns`` is stamped by ``to_wire``."""

    session_id: str
    status: SessionStatus = SessionStatus.IDLE
    state_version: int = 1
    current_song_id: Optional[str] = None
    current_order_index: Optional[int] = None
    bpm: float = 120
    beats_per_bar: int = 4
    anchor_ns: Optional[int] = None
    bar_offset: int = 1
    paused_bar: Optional[int] = None
    setlist: Tuple[SetlistEntry, ...] = ()
    last_command: Optional[LastCommand] = None

    def to_wire(self, leader_time_ns: int) -> dict:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "leader_instance_id": LEADER_INSTANCE_ID,
            "session_id": self.session_id,
            "status": self.status.value,
            "state_version": self.state_version,
            "current_song_id": self.current_song_id,
            "current_order_index": self.current_order_index,
            "bpm": self.bpm,
            "beats_per_bar": self.beats_per_bar,
            "anchor_ns": self.anchor_ns,
            "bar_offset": self.bar_offset,
            "paused_bar": self.paused_bar,
            "leader_time_ns": int(leader_time_ns),
            "setlist": [entry.to_wire() for entry in self.setlist],
            "last_command": self.last_command.to_wire() if self.last_command else None,
        }
