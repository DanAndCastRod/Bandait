"""The hub workspace (bandait-protocol/WORKSPACE_V2.md): download, parse, cache.

- ``parse_workspace`` turns any JSON value into typed, immutable dataclasses. It
  never raises: malformed items are skipped or clamped with a warning, because a
  bad field in the hub must not keep the band from playing.
- v1 documents (no ``schemaVersion``, PlaylistSong without ``songId``) are read
  as songs without sections. Their song ids are the ones the hub migration
  derives (section 6, ``derivedSongId``/``deterministicUuid`` in
  bandait-leader-web/src/services/workspaceSchema.ts, ported exactly), so when
  the hub later uploads the v2 version the import maps onto the same rows.
- Setlist order is ``orderIndex`` ascending with no assumed base, ties by array
  order (section 3); positions are ranks, never ``orderIndex`` itself.
- Unknown fields are preserved: each dataclass keeps them in ``extra`` and the
  cache stores the raw document untouched.
- ``obtain_workspace`` downloads the user's row (read only: the leader never
  writes to Supabase) and falls back to the last good cached copy offline.
"""

from __future__ import annotations

import json
import logging
import math
import os
import tempfile
import urllib.parse
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from src.cloud.http import DEFAULT_TIMEOUT_S, CloudError, CloudHTTPError, CloudOffline, request_json

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 2
WORKSPACE_TABLE = "bandait_workspaces"
CACHE_FORMAT = 1

SECTION_KINDS = (
    "intro", "verse", "pre_chorus", "chorus", "bridge", "solo", "interlude", "outro", "break", "custom",
)
DEFAULT_CUE_TEXT = {
    "intro": "Intro",
    "verse": "Estrofa",
    "pre_chorus": "Pre coro",
    "chorus": "Coro",
    "bridge": "Puente",
    "solo": "Solo",
    "interlude": "Interludio",
    "outro": "Final",
    "break": "Corte",
}
TRANSITION_MODES = ("manual_cue", "auto_count_in", "gapless")
VOICE_OUTPUTS = ("drummer", "all_in_ear")
BPM_MIN, BPM_MAX = 40.0, 260.0
COUNT_IN_BARS_MAX = 4
GAP_SEC_MAX = 30.0
BEATS_PER_BAR_MAX = 12  # the hub editor allows 1..12
SECTION_BARS_MAX = 4096
MAX_TEXT = 200
MAX_CHORDPRO = 100_000
MAX_WARNINGS = 100

_SONG_KEYS = {
    "id", "title", "artist", "bpm", "beatsPerBar", "beatUnit", "key", "camelot",
    "durationSec", "sections", "notes", "updatedAt",
}
_SECTION_KEYS = {"id", "kind", "label", "bars", "chordpro", "cueText"}
_ITEM_KEYS = {
    "id", "songId", "orderIndex", "title", "artist", "bpm", "key", "showKey", "camelot",
    "durationSec", "transitionMode", "countInBars", "countInVoice", "gapSec", "notes",
}
_PLAYLIST_KEYS = {"id", "bandId", "name", "createdAt", "updatedAt", "songs"}
_BAND_KEYS = {"id", "name", "genre"}
_VOICE_KEYS = {"enabled", "provider", "voice", "rate", "countIn", "sectionCues", "cueLeadBars", "output"}


# --------------------------------------------------------------------------- dataclasses
@dataclass(frozen=True)
class VoiceConfig:
    enabled: bool = False
    provider: str = "azure"
    voice: str = "es-CO-SalomeNeural"
    rate: str = "+0%"
    count_in: bool = True
    section_cues: bool = True
    cue_lead_bars: int = 1
    output: str = "drummer"
    extra: Mapping[str, object] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class Section:
    id: str
    kind: str
    label: str
    bars: int
    chordpro: str = ""
    # Resolved spoken cue: absent in the hub -> default text for ``kind``,
    # null or blank -> None (no cue), string -> that text.
    cue_text: Optional[str] = None
    extra: Mapping[str, object] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class Song:
    id: str
    title: str
    artist: str = ""
    bpm: float = 120
    beats_per_bar: int = 4
    beat_unit: int = 4
    key: str = ""
    camelot: str = ""
    duration_sec: Optional[float] = None
    sections: Tuple[Section, ...] = ()
    notes: str = ""
    updated_at: str = ""
    derived: bool = False  # built from a playlist item (v1 or a dangling songId)
    extra: Mapping[str, object] = field(default_factory=dict, compare=False)

    @property
    def total_bars(self) -> Optional[int]:
        return sum(s.bars for s in self.sections) if self.sections else None


@dataclass(frozen=True)
class PlaylistItem:
    id: str
    song_id: str
    order_index: int  # 0-based rank in the setlist after sorting by orderIndex
    title: str = ""
    artist: str = ""
    bpm: Optional[float] = None  # show bpm; None = the song's
    key: str = ""
    show_key: str = ""
    camelot: str = ""
    duration_sec: Optional[float] = None
    transition_mode: str = "manual_cue"
    count_in_bars: int = 0
    count_in_voice: bool = True
    gap_sec: float = 0.0
    notes: str = ""
    hub_order_index: Optional[float] = None  # raw orderIndex (any base): only for sorting
    extra: Mapping[str, object] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class Playlist:
    id: str
    band_id: str
    name: str
    items: Tuple[PlaylistItem, ...] = ()
    created_at: str = ""
    updated_at: str = ""
    extra: Mapping[str, object] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class Band:
    id: str
    name: str
    genre: str = ""
    extra: Mapping[str, object] = field(default_factory=dict, compare=False)


@dataclass(frozen=True)
class BandContent:
    band: Band
    songs: Tuple[Song, ...] = ()
    playlists: Tuple[Playlist, ...] = ()
    voice: VoiceConfig = field(default_factory=VoiceConfig)

    def song(self, song_id: str) -> Optional[Song]:
        return next((s for s in self.songs if s.id == song_id), None)


@dataclass(frozen=True)
class Workspace:
    schema_version: int
    active_band_id: Optional[str]
    bands: Tuple[Band, ...]
    content: Mapping[str, BandContent]
    warnings: Tuple[str, ...] = ()
    raw: Mapping[str, object] = field(default_factory=dict, compare=False, repr=False)

    def band(self, band_id: Optional[str]) -> Optional[BandContent]:
        if not band_id:
            return None
        return self.content.get(band_id)


# --------------------------------------------------------------------------- helpers
class _Warnings:
    def __init__(self):
        self.items: List[str] = []
        self.dropped = 0

    def add(self, message: str) -> None:
        if len(self.items) < MAX_WARNINGS:
            self.items.append(message)
        else:
            self.dropped += 1

    def result(self) -> Tuple[str, ...]:
        if self.dropped:
            return tuple(self.items) + (f"... y {self.dropped} avisos más",)
        return tuple(self.items)


def _text(value: object, limit: int = MAX_TEXT) -> str:
    if isinstance(value, str):
        return value.strip()[:limit]
    if isinstance(value, bool) or value is None:
        return ""
    if isinstance(value, (int, float)) and math.isfinite(value):
        return str(value)[:limit]
    return ""


def _number(value: object) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _as_bpm(value: float) -> float:
    value = max(BPM_MIN, min(BPM_MAX, value))
    return int(value) if float(value).is_integer() else value


def _int_in(value: object, lo: int, hi: int) -> Optional[int]:
    number = _number(value)
    if number is None or not number.is_integer():
        return None
    number = int(number)
    return number if lo <= number <= hi else None


def _extra(obj: Mapping[str, object], known: set) -> Dict[str, object]:
    return {k: v for k, v in obj.items() if k not in known}


def _norm(value: object) -> str:
    if isinstance(value, str):
        return value.strip().lower()
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value).strip().lower()


_M32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return (a * b) & _M32


def _cyrb128(seed: str) -> Tuple[int, int, int, int]:
    """Port of cyrb128 in the hub's workspaceSchema.ts (UTF-16 code units)."""
    h1, h2, h3, h4 = 1779033703, 3144134277, 1013904242, 2773480762
    data = seed.encode("utf-16-le")
    for i in range(0, len(data), 2):
        k = data[i] | (data[i + 1] << 8)
        h1 = h2 ^ _imul(h1 ^ k, 597399067)
        h2 = h3 ^ _imul(h2 ^ k, 2869860233)
        h3 = h4 ^ _imul(h3 ^ k, 951274213)
        h4 = h1 ^ _imul(h4 ^ k, 2716044179)
    h1 = _imul(h3 ^ (h1 >> 18), 597399067)
    h2 = _imul(h4 ^ (h2 >> 22), 2869860233)
    h3 = _imul(h1 ^ (h3 >> 17), 951274213)
    h4 = _imul(h2 ^ (h4 >> 19), 2716044179)
    h1 = (h1 ^ h2 ^ h3 ^ h4) & _M32
    h2 = (h2 ^ h1) & _M32
    h3 = (h3 ^ h1) & _M32
    h4 = (h4 ^ h1) & _M32
    return h1, h2, h3, h4


def deterministic_uuid(seed: str) -> str:
    """Same output as ``deterministicUuid`` in the hub (UUID v4 layout)."""
    hex_chars = list("".join(f"{n:08x}" for n in _cyrb128(seed)))
    hex_chars[12] = "4"
    hex_chars[16] = format((int(hex_chars[16], 16) & 0x3) | 0x8, "x")
    s = "".join(hex_chars)
    return f"{s[0:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:32]}"


def derived_song_id(band_id: str, title: object, artist: object, used: set) -> str:
    base = f"bandait:song:{band_id}:{_norm(title)}:{_norm(artist)}"
    n = 0
    while True:
        candidate = deterministic_uuid(base if n == 0 else f"{base}:{n}")
        if candidate not in used:
            return candidate
        n += 1


# --------------------------------------------------------------------------- parsing
def _parse_voice(raw: object, band_id: str, warn: _Warnings) -> VoiceConfig:
    default = VoiceConfig()
    if raw is None:
        return default
    if not isinstance(raw, dict):
        warn.add(f"Banda {band_id}: voiceMap no es un objeto; voz desactivada")
        return default
    provider = _text(raw.get("provider")) or default.provider
    voice = _text(raw.get("voice")) or default.voice
    rate = _text(raw.get("rate"), 16) or default.rate
    lead = _int_in(raw.get("cueLeadBars"), 1, 2)
    if raw.get("cueLeadBars") is not None and lead is None:
        warn.add(f"Banda {band_id}: cueLeadBars inválido; se usa 1")
    output = raw.get("output")
    if output not in VOICE_OUTPUTS:
        if output is not None:
            warn.add(f"Banda {band_id}: salida de voz {output!r} inválida; se usa 'drummer'")
        output = default.output

    def flag(name: str, fallback: bool) -> bool:
        value = raw.get(name)
        return value if isinstance(value, bool) else fallback

    return VoiceConfig(
        enabled=flag("enabled", default.enabled),
        provider=provider,
        voice=voice,
        rate=rate,
        count_in=flag("countIn", default.count_in),
        section_cues=flag("sectionCues", default.section_cues),
        cue_lead_bars=lead or default.cue_lead_bars,
        output=output,
        extra=_extra(raw, _VOICE_KEYS),
    )


def _parse_section(raw: object, where: str, index: int, warn: _Warnings) -> Optional[Section]:
    if not isinstance(raw, dict):
        warn.add(f"{where}: la sección {index + 1} no es un objeto; se omite")
        return None
    bars = _int_in(raw.get("bars"), 1, SECTION_BARS_MAX)
    if bars is None:
        warn.add(f"{where}: la sección {index + 1} no tiene compases válidos; se omite")
        return None
    kind = raw.get("kind")
    if kind not in SECTION_KINDS:
        warn.add(f"{where}: tipo de sección {kind!r} desconocido; se usa 'custom'")
        kind = "custom"
    label = _text(raw.get("label")) or DEFAULT_CUE_TEXT.get(kind, "") or f"Sección {index + 1}"
    chordpro = raw.get("chordpro")
    chordpro = chordpro[:MAX_CHORDPRO] if isinstance(chordpro, str) else ""
    if "cueText" not in raw:
        cue: Optional[str] = label if kind == "custom" else DEFAULT_CUE_TEXT[kind]
    else:
        value = raw.get("cueText")
        cue = value.strip()[:MAX_TEXT] if isinstance(value, str) else None
        if not cue:
            cue = None
    section_id = _text(raw.get("id"), 128) or f"s{index + 1}"
    return Section(
        id=section_id, kind=kind, label=label, bars=bars, chordpro=chordpro, cue_text=cue,
        extra=_extra(raw, _SECTION_KEYS),
    )


def _parse_song(raw: object, band_id: str, index: int, warn: _Warnings) -> Optional[Song]:
    where = f"Banda {band_id}, canción {index + 1}"
    if not isinstance(raw, dict):
        warn.add(f"{where}: no es un objeto; se omite")
        return None
    song_id = _text(raw.get("id"), 128)
    if not song_id:
        warn.add(f"{where}: sin id; se omite")
        return None
    title = _text(raw.get("title"))
    where = f"Canción '{title or song_id}'"
    if not title:
        warn.add(f"{where}: sin título")
        title = "Sin título"
    bpm = _number(raw.get("bpm"))
    if bpm is None:
        warn.add(f"{where}: BPM inválido; se usa 120")
        bpm = 120.0
    elif not BPM_MIN <= bpm <= BPM_MAX:
        warn.add(f"{where}: BPM {bpm:g} fuera de {BPM_MIN:g}..{BPM_MAX:g}; se ajusta")
    beats = _int_in(raw.get("beatsPerBar"), 1, BEATS_PER_BAR_MAX)
    if beats is None:
        if raw.get("beatsPerBar") is not None:
            warn.add(f"{where}: beatsPerBar inválido; se usa 4")
        beats = 4
    unit = _int_in(raw.get("beatUnit"), 1, 64) or 4
    sections_raw = raw.get("sections")
    sections: List[Section] = []
    if isinstance(sections_raw, list):
        for i, item in enumerate(sections_raw):
            section = _parse_section(item, where, i, warn)
            if section is not None:
                sections.append(section)
    elif sections_raw is not None:
        warn.add(f"{where}: 'sections' no es una lista; queda sin secciones")
    duration = _number(raw.get("durationSec"))
    return Song(
        id=song_id,
        title=title,
        artist=_text(raw.get("artist")),
        bpm=_as_bpm(bpm),
        beats_per_bar=beats,
        beat_unit=unit,
        key=_text(raw.get("key"), 16),
        camelot=_text(raw.get("camelot"), 8),
        duration_sec=duration if duration is not None and duration >= 0 else None,
        sections=tuple(sections),
        notes=_text(raw.get("notes"), 2000),
        updated_at=_text(raw.get("updatedAt"), 64),
        extra=_extra(raw, _SONG_KEYS),
    )


def _song_from_item(song_id: str, raw: Mapping[str, object]) -> Song:
    """WORKSPACE_V2 section 6 step 2: a song without sections from an item."""
    bpm = _number(raw.get("bpm"))
    duration = _number(raw.get("durationSec"))
    return Song(
        id=song_id,
        title=_text(raw.get("title")) or "Sin título",
        artist=_text(raw.get("artist")),
        bpm=_as_bpm(bpm if bpm is not None else 120.0),
        key=_text(raw.get("key"), 16),
        camelot=_text(raw.get("camelot"), 8),
        duration_sec=duration if duration is not None and duration >= 0 else None,
        derived=True,
    )


def _parse_item(
    raw: Mapping[str, object], position: int, song_id: str, where: str, warn: _Warnings
) -> PlaylistItem:
    item_id = _text(raw.get("id"), 128) or f"item-{position + 1}"
    order = _number(raw.get("orderIndex"))
    mode = raw.get("transitionMode")
    if mode not in TRANSITION_MODES:
        if mode is not None:
            warn.add(f"{where}: transición {mode!r} inválida; se usa manual_cue")
        mode = "manual_cue"
    count_in = _number(raw.get("countInBars"))
    if count_in is None or not count_in.is_integer():
        if raw.get("countInBars") is not None:
            warn.add(f"{where}: countInBars inválido; se usa 0")
        count_in = 0
    elif not 0 <= count_in <= COUNT_IN_BARS_MAX:
        warn.add(f"{where}: countInBars {count_in:g} fuera de 0..{COUNT_IN_BARS_MAX}; se ajusta")
        count_in = max(0, min(COUNT_IN_BARS_MAX, count_in))
    gap = _number(raw.get("gapSec"))
    if gap is None:
        gap = 0.0
    elif not 0 <= gap <= GAP_SEC_MAX:
        warn.add(f"{where}: gapSec {gap:g} fuera de 0..{GAP_SEC_MAX:g}; se ajusta")
        gap = max(0.0, min(GAP_SEC_MAX, gap))
    voice = raw.get("countInVoice")
    bpm = _number(raw.get("bpm"))
    if bpm is not None and not BPM_MIN <= bpm <= BPM_MAX:
        warn.add(f"{where}: BPM {bpm:g} fuera de {BPM_MIN:g}..{BPM_MAX:g}; se ajusta")
    duration = _number(raw.get("durationSec"))
    return PlaylistItem(
        id=item_id,
        song_id=song_id,
        order_index=position,  # replaced by the rank once the playlist is sorted
        title=_text(raw.get("title")),
        artist=_text(raw.get("artist")),
        bpm=_as_bpm(bpm) if bpm is not None else None,
        key=_text(raw.get("key"), 16),
        show_key=_text(raw.get("showKey"), 16),
        camelot=_text(raw.get("camelot"), 8),
        duration_sec=duration if duration is not None and duration >= 0 else None,
        transition_mode=mode,
        count_in_bars=int(count_in),
        count_in_voice=voice if isinstance(voice, bool) else True,
        gap_sec=gap,
        notes=_text(raw.get("notes"), 2000),
        hub_order_index=order,
        extra=_extra(raw, _ITEM_KEYS),
    )


def _schema_version(raw: Mapping[str, object], warn: _Warnings) -> int:
    value = raw.get("schemaVersion")
    if value is None:
        return 1
    number = _number(value)
    if number is None and isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            number = None
    if number is None or not number.is_integer() or number < 1:
        warn.add(f"schemaVersion {value!r} inválido; se lee como v1")
        return 1
    if number > SCHEMA_VERSION:
        warn.add(f"Workspace v{int(number)} (hub más nuevo): se leen los campos de v{SCHEMA_VERSION}")
    return int(number)


def parse_workspace(raw: object) -> Workspace:
    """Typed view of a workspace document. Never raises."""
    warn = _Warnings()
    if not isinstance(raw, dict):
        warn.add("El workspace no es un objeto JSON; se ignora")
        return Workspace(schema_version=1, active_band_id=None, bands=(), content={}, warnings=warn.result(), raw={})
    version = _schema_version(raw, warn)

    def mapping(name: str) -> Mapping[str, object]:
        value = raw.get(name)
        if value is None:
            return {}
        if not isinstance(value, dict):
            warn.add(f"'{name}' no es un objeto; se ignora")
            return {}
        return value

    songs_map = mapping("songsMap")
    playlists_map = mapping("playlistsMap")
    voice_map = mapping("voiceMap")

    bands: List[Band] = []
    bands_raw = raw.get("bands")
    if not isinstance(bands_raw, list):
        if bands_raw is not None:
            warn.add("'bands' no es una lista; se ignora")
        bands_raw = []
    seen_bands = set()
    for i, item in enumerate(bands_raw):
        if not isinstance(item, dict):
            warn.add(f"Banda {i + 1}: no es un objeto; se omite")
            continue
        band_id = _text(item.get("id"), 128)
        if not band_id or band_id in seen_bands:
            warn.add(f"Banda {i + 1}: id vacío o repetido; se omite")
            continue
        seen_bands.add(band_id)
        bands.append(Band(
            id=band_id,
            name=_text(item.get("name")) or band_id,
            genre=_text(item.get("genre")),
            extra=_extra(item, _BAND_KEYS),
        ))

    # Every song id of the document: a derived id must never collide with one.
    used_ids = set()
    for value in songs_map.values():
        if isinstance(value, list):
            for s in value:
                if isinstance(s, dict) and isinstance(s.get("id"), str) and s["id"].strip():
                    used_ids.add(s["id"].strip())

    content: Dict[str, BandContent] = {}
    for band in bands:
        songs: List[Song] = []
        by_id: Dict[str, Song] = {}
        songs_raw = songs_map.get(band.id)
        if songs_raw is not None and not isinstance(songs_raw, list):
            warn.add(f"Banda {band.name}: songsMap no es una lista; se ignora")
            songs_raw = []
        # (normalized title, normalized artist) -> song id, first wins: the hub's
        # findSongByTitleArtist, on the raw values (not the cleaned display title).
        match_index: Dict[Tuple[str, str], str] = {}
        for i, item in enumerate(songs_raw or []):
            song = _parse_song(item, band.id, i, warn)
            if song is None:
                continue
            if song.id in by_id:
                warn.add(f"Canción {song.id} repetida en {band.name}; se usa la primera")
                continue
            by_id[song.id] = song
            songs.append(song)
            match_index.setdefault((_norm(item.get("title")), _norm(item.get("artist"))), song.id)

        playlists: List[Playlist] = []
        playlists_raw = playlists_map.get(band.id)
        if playlists_raw is not None and not isinstance(playlists_raw, list):
            warn.add(f"Banda {band.name}: playlistsMap no es una lista; se ignora")
            playlists_raw = []
        seen_playlists = set()
        for p_index, pl in enumerate(playlists_raw or []):
            if not isinstance(pl, dict):
                warn.add(f"Banda {band.name}, setlist {p_index + 1}: no es un objeto; se omite")
                continue
            pl_id = _text(pl.get("id"), 128)
            if not pl_id or pl_id in seen_playlists:
                warn.add(f"Banda {band.name}, setlist {p_index + 1}: id vacío o repetido; se omite")
                continue
            seen_playlists.add(pl_id)
            name = _text(pl.get("name")) or "Setlist sin nombre"
            items_raw = pl.get("songs")
            if not isinstance(items_raw, list):
                if items_raw is not None:
                    warn.add(f"Setlist '{name}': 'songs' no es una lista; queda vacío")
                items_raw = []
            parsed_items: List[Tuple[int, float, int, PlaylistItem]] = []
            for position, item in enumerate(items_raw):
                where = f"Setlist '{name}', ítem {position + 1}"
                if not isinstance(item, dict):
                    warn.add(f"{where}: no es un objeto; se omite")
                    continue
                song_ref = _text(item.get("songId"), 128)
                if not song_ref:
                    # v1 (or a v2 item without songId): the hub migration rule, so a
                    # later v2 upload of the same data keeps exactly these ids.
                    key = (_norm(item.get("title")), _norm(item.get("artist")))
                    song_ref = match_index.get(key)
                    if song_ref is None:
                        song_ref = derived_song_id(band.id, item.get("title"), item.get("artist"), used_ids)
                        used_ids.add(song_ref)
                        derived = _song_from_item(song_ref, item)
                        songs.append(derived)
                        by_id[song_ref] = derived
                        match_index[key] = song_ref
                elif song_ref not in by_id:
                    # Dangling reference: recreate the song from the item's backup
                    # copy (same rule as the hub migration) instead of losing it.
                    warn.add(f"{where}: la canción {song_ref} no está en la librería; se usa la copia del ítem")
                    match = _song_from_item(song_ref, item)
                    songs.append(match)
                    by_id[song_ref] = match
                    used_ids.add(song_ref)
                parsed = _parse_item(item, position, song_ref, where, warn)
                order = parsed.hub_order_index
                if order is None:
                    warn.add(f"{where}: sin orderIndex válido; va al final del setlist")
                parsed_items.append((1 if order is None else 0, order or 0.0, position, parsed))
            # WORKSPACE_V2 section 3: orderIndex ascending, whatever its base (the hub
            # counts from 1, the fixture from 0); ties keep the array order. The
            # position in the setlist is the rank, never orderIndex itself.
            parsed_items.sort(key=lambda t: (t[0], t[1], t[2]))
            ordered = tuple(replace(p, order_index=rank) for rank, (_m, _o, _i, p) in enumerate(parsed_items))
            playlists.append(Playlist(
                id=pl_id,
                band_id=band.id,
                name=name,
                items=ordered,
                created_at=_text(pl.get("createdAt"), 64),
                updated_at=_text(pl.get("updatedAt"), 64),
                extra=_extra(pl, _PLAYLIST_KEYS),
            ))
        content[band.id] = BandContent(
            band=band,
            songs=tuple(songs),
            playlists=tuple(playlists),
            voice=_parse_voice(voice_map.get(band.id), band.id, warn),
        )

    active = _text(raw.get("activeBandId"), 128) or None
    if active is not None and active not in content:
        active = None
    return Workspace(
        schema_version=version,
        active_band_id=active,
        bands=tuple(bands),
        content=content,
        warnings=warn.result(),
        raw=raw,
    )


# --------------------------------------------------------------------------- remote
@dataclass(frozen=True)
class RemoteWorkspace:
    raw: Mapping[str, object] = field(repr=False)
    updated_at: Optional[str]


def fetch_workspace(
    base_url: str, api_key: str, access_token: str, user_id: str, timeout: float = DEFAULT_TIMEOUT_S
) -> Optional[RemoteWorkspace]:
    """The user's row through PostgREST (RLS: only their own). None if no row.
    Read only: this module never sends a write to Supabase."""
    query = urllib.parse.urlencode({"select": "workspace,updated_at", "user_id": f"eq.{user_id}"})
    data = request_json(
        "GET",
        f"{base_url.rstrip('/')}/rest/v1/{WORKSPACE_TABLE}?{query}",
        headers={"apikey": api_key, "Authorization": f"Bearer {access_token}"},
        timeout=timeout,
    )
    if not isinstance(data, list):
        raise CloudHTTPError(200, "bad_shape", "La nube respondió algo inesperado al leer el workspace")
    if not data:
        return None
    row = data[0]
    if not isinstance(row, dict) or not isinstance(row.get("workspace"), dict):
        raise CloudHTTPError(200, "bad_row", "La fila del workspace en la nube está dañada")
    updated = row.get("updated_at")
    return RemoteWorkspace(raw=row["workspace"], updated_at=updated if isinstance(updated, str) else None)


# --------------------------------------------------------------------------- cache
@dataclass(frozen=True)
class CachedWorkspace:
    raw: Mapping[str, object] = field(repr=False)
    user_id: str
    email: str
    updated_at: Optional[str]
    fetched_at: str  # ISO 8601 UTC


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def save_cache(
    path: str,
    *,
    user_id: str,
    email: str,
    raw: Mapping[str, object],
    updated_at: Optional[str],
    fetched_at: Optional[str] = None,
) -> str:
    """Write the snapshot atomically (temp file in the same folder + os.replace)."""
    fetched_at = fetched_at or utc_now_iso()
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    document = {
        "format": CACHE_FORMAT,
        "user_id": user_id,
        "email": email,
        "updated_at": updated_at,
        "fetched_at": fetched_at,
        "workspace": raw,
    }
    fd, tmp = tempfile.mkstemp(prefix=".workspace.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(document, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return fetched_at


def load_cache(path: str, user_id: Optional[str] = None) -> Optional[CachedWorkspace]:
    """The cached snapshot, or None if missing, unreadable or another account's."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or not isinstance(data.get("workspace"), dict):
        return None
    owner = data.get("user_id")
    if not isinstance(owner, str) or (user_id is not None and owner != user_id):
        return None
    fetched = data.get("fetched_at")
    updated = data.get("updated_at")
    email = data.get("email")
    return CachedWorkspace(
        raw=data["workspace"],
        user_id=owner,
        email=email if isinstance(email, str) else "",
        updated_at=updated if isinstance(updated, str) else None,
        fetched_at=fetched if isinstance(fetched, str) else "",
    )


# --------------------------------------------------------------------------- obtain
@dataclass(frozen=True)
class WorkspaceSnapshot:
    workspace: Workspace
    source: str  # "cloud" | "cache"
    user_id: str
    email: str
    updated_at: Optional[str]
    fetched_at: str
    error: Optional[str] = None  # why the cloud copy could not be used
    revoked: bool = False


class WorkspaceUnavailable(CloudError):
    def __init__(self, message: str, revoked: bool = False):
        super().__init__(message)
        self.revoked = revoked


def obtain_workspace(auth, base_url: str, api_key: str, cache_path: str,
                     timeout: float = DEFAULT_TIMEOUT_S) -> WorkspaceSnapshot:
    """Cloud copy when reachable (then cached), else the last good cache.

    ``auth`` is an ``AuthManager``. Raises WorkspaceUnavailable only when there
    is neither a cloud copy nor a cache for this account.
    """
    from src.cloud.auth import NotSignedIn, SessionRevoked

    user = auth.user
    if user is None:
        raise WorkspaceUnavailable("No hay sesión de la nube")
    error: Optional[str] = None
    revoked = False
    try:
        token = auth.access_token()
        try:
            remote = fetch_workspace(base_url, api_key, token, user.id, timeout)
        except CloudHTTPError as err:
            if err.status != 401:
                raise
            token = auth.access_token(force_refresh=True)  # expired or rotated JWT
            remote = fetch_workspace(base_url, api_key, token, user.id, timeout)
        if remote is None:
            error = "Tu cuenta todavía no tiene datos en el hub"
        else:
            fetched_at = utc_now_iso()
            try:
                save_cache(cache_path, user_id=user.id, email=user.email, raw=remote.raw,
                           updated_at=remote.updated_at, fetched_at=fetched_at)
            except OSError as err:
                logger.warning("No se pudo guardar la copia local del workspace: %s", err)
            return WorkspaceSnapshot(
                workspace=parse_workspace(remote.raw), source="cloud", user_id=user.id,
                email=user.email, updated_at=remote.updated_at, fetched_at=fetched_at,
            )
    except SessionRevoked as err:
        error, revoked = str(err), True
    except NotSignedIn as err:
        error = str(err)
    except CloudOffline as err:
        error = str(err)
    except CloudHTTPError as err:
        if err.status in (401, 403) or err.error_code == "42501":
            error = f"La nube rechazó la lectura del workspace ({err}). Revisa RLS (docs/DEPLOY.md 3.3)."
        else:
            error = f"Error de la nube: {err}"
    except CloudError as err:
        error = str(err)
    cached = load_cache(cache_path, user.id)
    if cached is None:
        raise WorkspaceUnavailable(error or "Sin copia local del workspace", revoked=revoked)
    return WorkspaceSnapshot(
        workspace=parse_workspace(cached.raw), source="cache", user_id=user.id,
        email=cached.email or user.email, updated_at=cached.updated_at,
        fetched_at=cached.fetched_at, error=error, revoked=revoked,
    )


def snapshot_from_cache(cache_path: str, user_id: str) -> Optional[WorkspaceSnapshot]:
    """The cached workspace without any network (startup status, band picker)."""
    cached = load_cache(cache_path, user_id)
    if cached is None:
        return None
    return WorkspaceSnapshot(
        workspace=parse_workspace(cached.raw), source="cache", user_id=cached.user_id,
        email=cached.email, updated_at=cached.updated_at, fetched_at=cached.fetched_at,
    )


def band_summaries(workspace: Workspace) -> List[dict]:
    """For the band picker: id, name, genre, song and setlist counts."""
    result = []
    for band in workspace.bands:
        content = workspace.content.get(band.id)
        result.append({
            "id": band.id,
            "name": band.name,
            "genre": band.genre,
            "songs": len(content.songs) if content else 0,
            "setlists": len(content.playlists) if content else 0,
        })
    return result


__all__: Sequence[str] = (
    "Band", "BandContent", "Playlist", "PlaylistItem", "Section", "Song", "VoiceConfig", "Workspace",
    "WorkspaceSnapshot", "WorkspaceUnavailable", "band_summaries", "deterministic_uuid", "fetch_workspace",
    "load_cache", "obtain_workspace", "parse_workspace", "save_cache", "snapshot_from_cache",
)
