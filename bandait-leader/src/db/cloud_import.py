"""Import one hub band (a parsed workspace) into the leader's SQLite database.

Rules (Phase 1, one-way hub -> leader):

- Upsert by ``cloud_id``. Imported songs get ``source = 'cloud'`` and are a
  read-only mirror: the hub is the only place to edit them.
- The leader mirrors exactly the chosen band: cloud songs, setlists and voice
  configs that are not in it any more (deleted in the hub, or of another band)
  are removed. Rows with ``source = 'local'`` or ``'demo'`` (or setlists
  without ``cloud_id``) are never touched.
- A song id that collides with a local song gets the local id
  ``cloud-<hub id>`` instead: local data always wins its id.
- Everything runs in one ``BEGIN IMMEDIATE`` transaction: the database ends up
  with the whole new state or with the previous one, never half.
- Importing the same workspace twice leaves identical rows (deterministic ids,
  timestamps from the hub).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

from sqlalchemy import create_engine, delete, event, insert, select, update

from src.db.models import (
    Base,
    BandVoiceConfig,
    Gig,
    Rehearsal,
    Setlist,
    Song,
    SongSection,
    migrate_db,
    setlist_song_association,
)

logger = logging.getLogger(__name__)

songs_t = Song.__table__
sections_t = SongSection.__table__
setlists_t = Setlist.__table__
items_t = setlist_song_association
voice_t = BandVoiceConfig.__table__
gigs_t = Gig.__table__
rehearsals_t = Rehearsal.__table__

_CHORD_RE = re.compile(r"\[[^\]]*\]")
_SPACES_RE = re.compile(r"[ \t]{2,}")


@dataclass
class ImportReport:
    band_id: str
    band_name: str = ""
    songs_upserted: int = 0
    songs_deleted: int = 0
    setlists_upserted: int = 0
    setlists_deleted: int = 0
    items: int = 0
    warnings: List[str] = field(default_factory=list)
    song_ids: Dict[str, str] = field(default_factory=dict)  # hub song id -> local id
    setlist_ids: Dict[str, str] = field(default_factory=dict)  # hub playlist id -> local id


def _parse_ts(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def lyrics_text(sections) -> str:
    """Plain lyrics (chords stripped) with a [Label] line per section, the format
    the existing stage and library views already read."""
    lines: List[str] = []
    for section in sections:
        lines.append(f"[{section.label}]")
        for line in (section.chordpro or "").splitlines():
            text = _SPACES_RE.sub(" ", _CHORD_RE.sub("", line)).strip()
            if text:
                lines.append(text)
        lines.append("")
    return "\n".join(lines).strip()


def chords_text(song) -> str:
    head = [f"{{title: {song.title}}}"]
    if song.artist:
        head.append(f"{{artist: {song.artist}}}")
    if song.key:
        head.append(f"{{key: {song.key}}}")
    head.append(f"{{tempo: {song.bpm:g}}}")
    head.append(f"{{time: {song.beats_per_bar}/{song.beat_unit}}}")
    body = []
    for section in song.sections:
        body.append(f"[{section.label}]")
        if section.chordpro:
            body.append(section.chordpro)
        body.append("")
    return "\n".join(head + [""] + body).strip()


def _song_values(song, band_id: str) -> dict:
    duration = song.duration_sec
    if duration is None and song.sections:
        beats = sum(s.bars for s in song.sections) * song.beats_per_bar
        duration = beats * 60.0 / float(song.bpm)
    return {
        "title": song.title,
        "artist": song.artist,
        "bpm": song.bpm,
        "key": song.key,
        "duration_seconds": float(duration) if duration is not None else 0.0,
        "lyrics_text": lyrics_text(song.sections),
        "chords_text": chords_text(song),
        "source": "cloud",
        "cloud_id": song.id,
        "band_cloud_id": band_id,
        "cloud_updated_at": song.updated_at or None,
        "beats_per_bar": song.beats_per_bar,
        "beat_unit": song.beat_unit,
        "camelot": song.camelot,
    }


def _apply(conn, content) -> ImportReport:
    band = content.band
    report = ImportReport(band_id=band.id, band_name=band.name)

    # ---- songs
    song_rows = conn.execute(select(songs_t.c.id, songs_t.c.cloud_id, songs_t.c.source)).fetchall()
    cloud_by_hub_id: Dict[str, str] = {}
    cloud_pks = set()
    taken = set()
    for pk, cloud_id, source in song_rows:
        taken.add(pk)
        if source == "cloud":
            cloud_pks.add(pk)
            if cloud_id and cloud_id not in cloud_by_hub_id:
                cloud_by_hub_id[cloud_id] = pk
    local_pks = taken - cloud_pks

    kept_songs = set()
    for song in content.songs:
        pk = cloud_by_hub_id.get(song.id)
        if pk is None:
            for candidate in (song.id, f"cloud-{song.id}"):
                if candidate not in local_pks and candidate not in kept_songs and candidate not in cloud_pks:
                    pk = candidate
                    break
        if pk is None or pk in kept_songs:
            report.warnings.append(f"Canción '{song.title}': su id choca con otra canción; se omite")
            continue
        values = _song_values(song, band.id)
        if pk in cloud_pks:
            conn.execute(update(songs_t).where(songs_t.c.id == pk).values(**values))
        else:
            conn.execute(insert(songs_t).values(id=pk, audio_path="", **values))
        conn.execute(delete(sections_t).where(sections_t.c.song_id == pk))
        if song.sections:
            conn.execute(
                insert(sections_t),
                [
                    {
                        "id": f"{pk}#{i}",
                        "song_id": pk,
                        "position": i,
                        "cloud_id": s.id,
                        "kind": s.kind,
                        "label": s.label,
                        "bars": s.bars,
                        "chordpro": s.chordpro,
                        "cue_text": s.cue_text,
                    }
                    for i, s in enumerate(song.sections)
                ],
            )
        kept_songs.add(pk)
        report.song_ids[song.id] = pk
        report.songs_upserted += 1

    stale_songs = sorted(cloud_pks - kept_songs)
    if stale_songs:
        conn.execute(delete(sections_t).where(sections_t.c.song_id.in_(stale_songs)))
        conn.execute(delete(items_t).where(items_t.c.song_id.in_(stale_songs)))
        conn.execute(delete(songs_t).where(songs_t.c.id.in_(stale_songs), songs_t.c.source == "cloud"))
        report.songs_deleted = len(stale_songs)

    # ---- setlists
    setlist_rows = conn.execute(
        select(setlists_t.c.id, setlists_t.c.cloud_id, setlists_t.c.band_cloud_id)
    ).fetchall()
    cloud_setlists: Dict[tuple, str] = {}
    cloud_setlist_pks = set()
    taken_setlists = set()
    for pk, cloud_id, band_cloud_id in setlist_rows:
        taken_setlists.add(pk)
        if cloud_id is not None:
            cloud_setlist_pks.add(pk)
            cloud_setlists.setdefault((band_cloud_id, cloud_id), pk)

    kept_setlists = set()

    def free_setlist_pk(candidate: str) -> bool:
        # A local setlist keeps its id; a cloud row can be reused (overwritten).
        if candidate in kept_setlists:
            return False
        return candidate not in taken_setlists or candidate in cloud_setlist_pks

    for playlist in content.playlists:
        pk = cloud_setlists.get((band.id, playlist.id))
        if pk is None or pk in kept_setlists:
            base = f"cloud:{band.id}:{playlist.id}"
            pk, n = base, 1
            while not free_setlist_pk(pk):
                n += 1
                pk = f"{base}#{n}"
        stamp = _parse_ts(playlist.updated_at) or _parse_ts(playlist.created_at)
        values = {"name": playlist.name, "cloud_id": playlist.id, "band_cloud_id": band.id, "band_id": None,
                  "source": "cloud"}
        if stamp is not None:
            values["updated_at"] = stamp
        if pk in cloud_setlist_pks:
            conn.execute(update(setlists_t).where(setlists_t.c.id == pk).values(**values))
        else:
            created = _parse_ts(playlist.created_at) or stamp
            if created is not None:
                values["created_at"] = created
            conn.execute(insert(setlists_t).values(id=pk, **values))
            taken_setlists.add(pk)
        conn.execute(delete(items_t).where(items_t.c.setlist_id == pk))
        rows = []
        for item in playlist.items:
            song_pk = report.song_ids.get(item.song_id)
            if song_pk is None:
                report.warnings.append(
                    f"Setlist '{playlist.name}': '{item.title or item.song_id}' no tiene canción importada; se omite"
                )
                continue
            rows.append(
                {
                    "setlist_id": pk,
                    "song_id": song_pk,
                    "position": len(rows),
                    "transition_mode": item.transition_mode,
                    "count_in_bars": item.count_in_bars,
                    "count_in_voice": item.count_in_voice,
                    "gap_sec": float(item.gap_sec),
                    "show_key": item.show_key,
                    "show_bpm": float(item.bpm) if item.bpm is not None else None,
                    "item_cloud_id": item.id,
                    "notes": item.notes,
                }
            )
        if rows:
            conn.execute(insert(items_t), rows)
        kept_setlists.add(pk)
        report.setlist_ids[playlist.id] = pk
        report.setlists_upserted += 1
        report.items += len(rows)

    stale_setlists = sorted(cloud_setlist_pks - kept_setlists)
    if stale_setlists:
        conn.execute(delete(items_t).where(items_t.c.setlist_id.in_(stale_setlists)))
        conn.execute(update(gigs_t).where(gigs_t.c.setlist_id.in_(stale_setlists)).values(setlist_id=None))
        conn.execute(
            update(rehearsals_t).where(rehearsals_t.c.setlist_id.in_(stale_setlists)).values(setlist_id=None)
        )
        conn.execute(
            delete(setlists_t).where(setlists_t.c.id.in_(stale_setlists), setlists_t.c.cloud_id.is_not(None))
        )
        report.setlists_deleted = len(stale_setlists)

    # ---- voice config
    voice = content.voice
    raw = {
        "enabled": voice.enabled, "provider": voice.provider, "voice": voice.voice, "rate": voice.rate,
        "countIn": voice.count_in, "sectionCues": voice.section_cues, "cueLeadBars": voice.cue_lead_bars,
        "output": voice.output, **dict(voice.extra),
    }
    voice_values = {
        "enabled": voice.enabled, "provider": voice.provider, "voice": voice.voice, "rate": voice.rate,
        "count_in": voice.count_in, "section_cues": voice.section_cues,
        "cue_lead_bars": voice.cue_lead_bars, "output": voice.output,
        "raw_json": json.dumps(raw, ensure_ascii=False, sort_keys=True, default=str),
    }
    conn.execute(delete(voice_t).where(voice_t.c.band_cloud_id != band.id))
    exists = conn.execute(select(voice_t.c.band_cloud_id).where(voice_t.c.band_cloud_id == band.id)).first()
    if exists:
        conn.execute(update(voice_t).where(voice_t.c.band_cloud_id == band.id).values(**voice_values))
    else:
        conn.execute(insert(voice_t).values(band_cloud_id=band.id, **voice_values))
    return report


def _import_engine(db_path: str):
    """Engine with a real transaction from the first statement (BEGIN IMMEDIATE),
    instead of pysqlite's deferred BEGIN before the first write."""
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"timeout": 15})

    @event.listens_for(engine, "connect")
    def _no_implicit_begin(dbapi_connection, _record):
        dbapi_connection.isolation_level = None

    @event.listens_for(engine, "begin")
    def _begin_immediate(conn):
        conn.exec_driver_sql("BEGIN IMMEDIATE")

    return engine


def import_band(db_path: str, content) -> ImportReport:
    """Import ``content`` (a ``workspace.BandContent``) into the database at
    ``db_path`` in one transaction. Raises on failure with nothing changed."""
    if db_path != ":memory:":
        migrate_db(db_path)  # same additive, backed-up migration as init_db
    engine = _import_engine(db_path)
    try:
        Base.metadata.create_all(engine)
        with engine.begin() as conn:
            report = _apply(conn, content)
    finally:
        engine.dispose()
    logger.info(
        "Nube importada (%s): %d canciones, %d setlists, %d borradas, %d avisos",
        content.band.id, report.songs_upserted, report.setlists_upserted,
        report.songs_deleted + report.setlists_deleted, len(report.warnings),
    )
    return report


def read_cloud_setlists(db_path: str, band_cloud_id: Optional[str]) -> List[dict]:
    """``list_cloud_setlists`` on a short-lived connection (setlist picker)."""
    from sqlalchemy.orm import Session as OrmSession

    from src.db.models import list_cloud_setlists

    engine = create_engine(f"sqlite:///{db_path}", connect_args={"timeout": 5})
    try:
        with OrmSession(engine) as session:
            return list_cloud_setlists(session, band_cloud_id)
    finally:
        engine.dispose()


def load_voice_config(session, band_cloud_id: str) -> Optional[dict]:
    """Stored VoiceConfig of a band as a dict (wave 2 reads it), or None."""
    row = session.get(BandVoiceConfig, band_cloud_id)
    if row is None:
        return None
    return {
        "enabled": bool(row.enabled), "provider": row.provider, "voice": row.voice, "rate": row.rate,
        "count_in": bool(row.count_in), "section_cues": bool(row.section_cues),
        "cue_lead_bars": int(row.cue_lead_bars or 1), "output": row.output,
    }
