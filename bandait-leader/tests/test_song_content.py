"""CONTRACT_V3 9.1: song content served to the prompter and its content_etag."""

import hashlib
import json

from src.domain.concurrent_control import normalize_setlist

SONG = {
    "song_id": "song_01",
    "title": "Intro",
    "artist": "Banda de Prueba",
    "bpm": 120,
    "order_index": 0,
    "transition_mode": "manual_cue",
    "beats_per_bar": 4,
    "key": "Am",
    "show_key": "",
    "total_bars": 12,
    "sections": [
        {"id": "s-01", "kind": "intro", "label": "Intro", "bars": 4, "start_bar": 1,
         "chordpro": "[Am]  [F]", "cue_text": "Intro"},
        {"id": "s-02", "kind": "verse", "label": "Estrofa", "bars": 8, "start_bar": 5,
         "chordpro": "[Am]Hoy vuelvo a [F]casa", "cue_text": None},
    ],
}


def _entry(**changes):
    return normalize_setlist([dict(SONG, **changes)])[0]


def test_sections_and_metadata_survive_normalize():
    entry = _entry()
    assert entry.artist == "Banda de Prueba"
    assert entry.total_bars == 12
    assert [s.id for s in entry.sections] == ["s-01", "s-02"]
    assert entry.sections[1].chordpro == "[Am]Hoy vuelvo a [F]casa"
    # Re-normalizing the domain entry (set_setlist does it) keeps the content.
    again = normalize_setlist([entry])[0]
    assert again.content() == entry.content()


def test_show_key_falls_back_to_key():
    assert _entry().content()["show_key"] == "Am"
    assert _entry(show_key="Bm").content()["show_key"] == "Bm"


def test_content_etag_is_sha1_of_canonical_json():
    entry = _entry()
    canonical = json.dumps(entry.content(), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert entry.content_etag == hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:16]
    assert entry.content_wire()["content_etag"] == entry.content_etag
    assert entry.to_wire()["content_etag"] == entry.content_etag


def test_content_etag_changes_with_lyrics_only():
    base = _entry().content_etag
    sections = [dict(SONG["sections"][0]), dict(SONG["sections"][1], chordpro="[Am]Otra letra")]
    assert _entry(sections=sections).content_etag != base
    # The position in the setlist and the transition are not song content.
    assert _entry(order_index=5, transition_mode="gapless").content_etag == base


def test_malformed_sections_are_skipped():
    sections = [
        {"id": "", "bars": 4, "start_bar": 1},
        {"id": "s-x", "bars": 0, "start_bar": 1},
        {"id": "s-z", "bars": "4", "start_bar": 1},
        {"id": "s-y", "bars": 4.0, "start_bar": 1, "chordpro": 7},
        "basura",
    ]
    entry = _entry(sections=sections)
    assert [s.id for s in entry.sections] == ["s-y"]
    assert entry.sections[0].chordpro == ""
