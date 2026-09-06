"""Pure domain models (immutable dataclasses)."""

from dataclasses import dataclass, field
from typing import List, Optional
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


@dataclass(frozen=True)
class SessionState:
    session_id: str
    leader_ip: str
    status: SessionStatus
    current_song_id: Optional[str]
    next_event_timestamp: int  # nanoseconds from leader monotonic clock
    bpm: int
    beat: int = 1  # 1-4

