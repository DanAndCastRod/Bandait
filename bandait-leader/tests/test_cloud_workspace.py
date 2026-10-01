"""Workspace v1/v2 parsing against the normative fixture, malformed input,
the atomic cache and the offline fallback."""

import copy
import json
import os
from pathlib import Path

import pytest

from src.cloud.auth import AuthManager, GoTrueClient, SessionStore, parse_token_response
from src.cloud.workspace import (
    DEFAULT_CUE_TEXT,
    WorkspaceUnavailable,
    deterministic_uuid,
    derived_song_id,
    load_cache,
    obtain_workspace,
    parse_workspace,
    save_cache,
)

FIXTURE = Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "workspace_v2.json"
SONG_1 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a01"
SONG_2 = "7b0e6c1e-4f5a-4c7d-9a1b-2c3d4e5f6a02"


def fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)


def v1_from_fixture():
    """The same show as a v1 document: no schemaVersion, songsMap, voiceMap or songId."""
    raw = fixture()
    for key in ("schemaVersion", "songsMap", "voiceMap"):
        raw.pop(key)
    for item in raw["playlistsMap"]["band_01"][0]["songs"]:
        for key in ("songId", "countInVoice", "gapSec"):
            item.pop(key)
    return raw


# --------------------------------------------------------------------------- v2
def test_fixture_v2_parses_without_warnings():
    ws = parse_workspace(fixture())
    assert ws.schema_version == 2 and ws.warnings == ()
    assert ws.active_band_id == "band_01"
    assert [b.name for b in ws.bands] == ["Banda de Prueba"]
    band = ws.band("band_01")
    intro, second = band.songs
    assert (intro.id, intro.bpm, intro.beats_per_bar, intro.beat_unit, intro.key) == (SONG_1, 120, 4, 4, "Am")
    assert [(s.kind, s.label, s.bars) for s in intro.sections] == [
        ("intro", "Intro", 4), ("verse", "Estrofa 1", 8), ("chorus", "Coro", 8), ("outro", "Final", 4)]
    assert intro.total_bars == 24
    assert intro.sections[1].chordpro.startswith("[Am]Hoy vuelvo a [F]casa")
    # cueText: absent -> default per kind; null -> no cue
    assert [s.cue_text for s in intro.sections] == ["Intro", "Estrofa", "Coro", None]
    assert second.sections == () and second.total_bars is None

    (playlist,) = band.playlists
    first, nxt = playlist.items
    assert (first.song_id, first.transition_mode, first.count_in_bars, first.count_in_voice, first.gap_sec) == (
        SONG_1, "manual_cue", 1, True, 0.0)
    assert (nxt.song_id, nxt.transition_mode, nxt.count_in_bars, nxt.gap_sec, nxt.bpm, nxt.show_key) == (
        SONG_2, "auto_count_in", 2, 3.0, 96, "D")
    v = band.voice
    assert (v.enabled, v.voice, v.rate, v.count_in, v.section_cues, v.cue_lead_bars, v.output) == (
        True, "es-CO-SalomeNeural", "+0%", True, True, 1, "drummer")


def test_unknown_fields_are_preserved():
    raw = fixture()
    raw["futureRoot"] = {"x": 1}
    raw["songsMap"]["band_01"][0]["tempoMap"] = [1, 2]
    raw["songsMap"]["band_01"][0]["sections"][0]["lighting"] = "azul"
    raw["playlistsMap"]["band_01"][0]["songs"][0]["dmx"] = 7
    raw["voiceMap"]["band_01"]["pitch"] = "+2st"
    ws = parse_workspace(raw)
    band = ws.band("band_01")
    assert band.songs[0].extra == {"tempoMap": [1, 2]}
    assert band.songs[0].sections[0].extra == {"lighting": "azul"}
    assert band.playlists[0].items[0].extra == {"dmx": 7}
    assert band.voice.extra == {"pitch": "+2st"}
    assert ws.raw["futureRoot"] == {"x": 1} and ws.raw is raw  # cache keeps the raw document


# --------------------------------------------------------------------------- v1
def test_v1_items_become_songs_without_sections_with_hub_compatible_ids():
    ws = parse_workspace(v1_from_fixture())
    assert ws.schema_version == 1
    band = ws.band("band_01")
    assert [s.title for s in band.songs] == ["Intro", "Segunda"]
    assert all(s.sections == () and s.derived for s in band.songs)
    expected = deterministic_uuid("bandait:song:band_01:intro:banda de prueba")
    assert band.songs[0].id == expected == "24d1b6d4-5fa9-4651-b0ca-b7de9776fadf"
    items = band.playlists[0].items
    assert [i.song_id for i in items] == [s.id for s in band.songs]
    assert (items[0].count_in_voice, items[0].gap_sec) == (True, 0.0)  # v2 defaults filled in
    assert band.voice.enabled is False  # default VoiceConfig
    # deterministic: parsing twice gives the same ids
    assert [s.id for s in parse_workspace(v1_from_fixture()).band("band_01").songs] == [s.id for s in band.songs]


def test_v1_repeated_song_reuses_one_library_entry():
    raw = v1_from_fixture()
    items = raw["playlistsMap"]["band_01"][0]["songs"]
    items.append(dict(items[0], id="it_03", orderIndex=2, title="  INTRO ", artist="banda de prueba"))
    band = parse_workspace(raw).band("band_01")
    assert len(band.songs) == 2
    assert band.playlists[0].items[2].song_id == band.playlists[0].items[0].song_id


# Vectors produced by running the hub's own migrateWorkspace() (workspaceSchema.ts,
# `node --experimental-strip-types`) on these v1 documents on 2026-10-01.
HUB_V1_CASE_B = {
    "activeBandId": "b1", "bands": [{"id": "b1", "name": "Uno"}, {"id": "b2", "name": "Dos"}],
    "membersMap": {}, "equipmentMap": {}, "stemsMap": {},
    "playlistsMap": {
        "b1": [{"id": "p1", "bandId": "b1", "name": "Show", "songs": [
            {"id": "i1", "orderIndex": 2, "title": "  Medianoche en Pereira ", "artist": "LOS INQUIETOS",
             "bpm": 124, "key": "Am", "transitionMode": "manual_cue", "countInBars": 2},
            {"id": "i2", "orderIndex": 1, "title": "Canción del Ñandú", "artist": "", "bpm": 300, "key": "E",
             "transitionMode": "gapless", "countInBars": 0},
            {"id": "i3", "orderIndex": 3, "title": "medianoche en pereira", "artist": "Los Inquietos",
             "bpm": 126, "key": "Am", "transitionMode": "auto_count_in", "countInBars": 1},
        ]}],
        "b2": [{"id": "p1", "bandId": "b2", "name": "Otro", "songs": [
            {"id": "i1", "orderIndex": 1, "title": "Medianoche en Pereira", "artist": "Los Inquietos",
             "bpm": 124, "key": "Am", "transitionMode": "manual_cue", "countInBars": 2},
        ]}],
    },
}
HUB_V1_IDS = {
    ("a", "band_01", "it_01"): "24d1b6d4-5fa9-4651-b0ca-b7de9776fadf",
    ("a", "band_01", "it_02"): "eb2084a0-5932-473b-966c-0f1133110179",
    ("b", "b1", "i1"): "3a55f455-3826-4fea-944a-862827e44e3b",
    ("b", "b1", "i2"): "19344fae-4e79-421f-bbc2-703ed8765163",
    ("b", "b1", "i3"): "3a55f455-3826-4fea-944a-862827e44e3b",
    ("b", "b2", "i1"): "be487635-0df4-4df8-8be3-38267e75597c",
}


def test_v1_song_ids_equal_the_hub_migration():
    cases = {"a": v1_from_fixture(), "b": HUB_V1_CASE_B}
    got = {}
    for name, raw in cases.items():
        ws = parse_workspace(raw)
        for band in ws.bands:
            for playlist in ws.band(band.id).playlists:
                for item in playlist.items:
                    got[(name, band.id, item.id)] = item.song_id
    assert got == HUB_V1_IDS
    b1 = parse_workspace(HUB_V1_CASE_B).band("b1")
    assert len(b1.songs) == 2  # "Medianoche" twice (case/spaces differ) is one song
    assert b1.song("19344fae-4e79-421f-bbc2-703ed8765163").bpm == 260  # clamped like the hub


def test_setlist_order_is_orderindex_ascending_without_assuming_a_base():
    raw = fixture()
    items = raw["playlistsMap"]["band_01"][0]["songs"]
    items[0]["orderIndex"], items[1]["orderIndex"] = 2, 1  # hub numbering starts at 1
    items.append(dict(items[0], id="it_tie", orderIndex=2))  # tie: array order decides
    items.append(dict(items[1], id="it_none", orderIndex="x"))  # invalid: goes last
    ws = parse_workspace(raw)
    playlist = ws.band("band_01").playlists[0]
    assert [i.id for i in playlist.items] == ["it_02", "it_01", "it_tie", "it_none"]
    assert [i.order_index for i in playlist.items] == [0, 1, 2, 3]  # ranks, not orderIndex
    assert [i.hub_order_index for i in playlist.items] == [1, 2, 2, None]
    assert any("orderIndex" in w for w in ws.warnings)


def test_section_ids_are_any_string_and_beats_per_bar_is_1_to_12():
    raw = fixture()
    song = raw["songsMap"]["band_01"][0]
    song["sections"][0]["id"] = "intro-a"
    song["sections"][1]["id"] = 7
    song["beatsPerBar"] = 12
    raw["songsMap"]["band_01"][1]["beatsPerBar"] = 13
    ws = parse_workspace(raw)
    intro, second = ws.band("band_01").songs
    assert [s.id for s in intro.sections] == ["intro-a", "7", "s-03", "s-04"]
    assert intro.beats_per_bar == 12
    assert second.beats_per_bar == 4 and any("beatsPerBar" in w for w in ws.warnings)


def test_deterministic_uuid_matches_the_hub_implementation():
    # Vectors computed with deterministicUuid() of bandait-leader-web workspaceSchema.ts (node).
    assert deterministic_uuid("bandait:song:band_01:medianoche:los inquietos") == \
        "1a6eb148-2598-4f8f-a0cb-0252f375a3f4"
    assert deterministic_uuid("bandait:song:b:\u00f1and\u00fa \u2603 \U0001D11E:x") == \
        "797296c0-5a50-40df-8870-0f6702a213dc"
    assert deterministic_uuid("") == "027ae52e-cfc7-4621-9593-990d4b41437c"
    used = {deterministic_uuid("bandait:song:b:t:a")}
    assert derived_song_id("b", "T", "A", used) == deterministic_uuid("bandait:song:b:t:a:1")


# --------------------------------------------------------------------------- malformed
@pytest.mark.parametrize("raw", [None, [], "texto", 42, {"bands": "no"}, {"bands": [None, 3, {"id": ""}]}])
def test_garbage_never_raises(raw):
    ws = parse_workspace(raw)
    assert ws.bands == () or all(b.id for b in ws.bands)


def test_malformed_items_are_skipped_or_clamped_with_warnings():
    raw = fixture()
    songs = raw["songsMap"]["band_01"]
    songs[0]["sections"].append({"kind": "verse", "label": "Rota", "bars": 0})
    songs[0]["sections"].append("no soy un objeto")
    songs[0]["sections"].append({"kind": "rap", "label": "Rap", "bars": 2})
    songs[0]["bpm"] = 999
    songs[1]["beatsPerBar"] = "cuatro"
    songs.append({"title": "Sin id"})
    songs.append(None)
    items = raw["playlistsMap"]["band_01"][0]["songs"]
    items[1]["transitionMode"] = "teleport"
    items[1]["countInBars"] = 9
    items[1]["gapSec"] = -5
    items.append({"id": "it_x", "songId": "no-existe", "orderIndex": 5, "title": "Huérfana", "bpm": 101})
    items.append("basura")
    raw["voiceMap"]["band_01"]["output"] = "pa"
    raw["playlistsMap"]["band_01"].append({"id": "pl_01", "name": "Duplicado"})

    ws = parse_workspace(raw)
    band = ws.band("band_01")
    intro = band.song(SONG_1)
    assert [s.label for s in intro.sections] == ["Intro", "Estrofa 1", "Coro", "Final", "Rap"]
    assert intro.sections[-1].kind == "custom" and intro.sections[-1].cue_text == "Rap"
    assert intro.bpm == 260
    assert band.song(SONG_2).beats_per_bar == 4
    (playlist,) = band.playlists  # duplicate playlist id skipped
    item = playlist.items[1]
    assert (item.transition_mode, item.count_in_bars, item.gap_sec) == ("manual_cue", 4, 0.0)
    orphan = playlist.items[2]
    assert orphan.song_id == "no-existe"
    assert band.song("no-existe").title == "Huérfana" and band.song("no-existe").bpm == 101
    assert band.voice.output == "drummer"
    assert len(ws.warnings) >= 10
    assert all(isinstance(w, str) and w for w in ws.warnings)


def test_newer_schema_is_read_with_a_warning():
    raw = fixture()
    raw["schemaVersion"] = 3
    ws = parse_workspace(raw)
    assert ws.schema_version == 3 and ws.band("band_01").songs
    assert any("más nuevo" in w for w in ws.warnings)


def test_default_cue_table_matches_the_spec():
    assert DEFAULT_CUE_TEXT == {
        "intro": "Intro", "verse": "Estrofa", "pre_chorus": "Pre coro", "chorus": "Coro",
        "bridge": "Puente", "solo": "Solo", "interlude": "Interludio", "outro": "Final", "break": "Corte",
    }


# --------------------------------------------------------------------------- cache
def test_cache_is_atomic_and_scoped_to_the_account(tmp_path):
    path = str(tmp_path / "cloud" / "workspace.json")
    save_cache(path, user_id="u1", email="a@b.c", raw=fixture(), updated_at="2026-10-01T00:00:00Z",
               fetched_at="2026-10-01T10:00:00+00:00")
    assert [p.name for p in (tmp_path / "cloud").iterdir()] == ["workspace.json"]  # no temp left behind
    cached = load_cache(path, "u1")
    assert cached.fetched_at == "2026-10-01T10:00:00+00:00" and cached.updated_at == "2026-10-01T00:00:00Z"
    assert cached.raw == fixture()
    assert load_cache(path, "otra-cuenta") is None
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("{corrupto")
    assert load_cache(path, "u1") is None


def test_failed_cache_write_keeps_the_previous_copy(tmp_path, monkeypatch):
    folder = tmp_path / "cache"
    path = str(folder / "workspace.json")
    save_cache(path, user_id="u1", email="", raw={"v": 1}, updated_at=None)
    monkeypatch.setattr(os, "replace", lambda *a: (_ for _ in ()).throw(OSError("disco lleno")))
    with pytest.raises(OSError):
        save_cache(path, user_id="u1", email="", raw={"v": 2}, updated_at=None)
    monkeypatch.undo()
    assert load_cache(path, "u1").raw == {"v": 1}
    assert [p.name for p in folder.iterdir()] == ["workspace.json"]  # temp file cleaned up


# --------------------------------------------------------------------------- obtain
def _manager(fake):
    access, refresh = fake.issue()
    manager = AuthManager(GoTrueClient(fake.url, fake.api_key), SessionStore())
    import time

    manager.set_tokens(parse_token_response(fake.token_body(access, refresh), time.time()))
    return manager


def test_obtain_downloads_caches_and_never_writes(fake_supabase, tmp_path):
    fake_supabase.workspace = fixture()
    manager = _manager(fake_supabase)
    cache = str(tmp_path / "cloud" / "workspace.json")
    snap = obtain_workspace(manager, fake_supabase.url, fake_supabase.api_key, cache)
    assert snap.source == "cloud" and snap.error is None
    assert snap.workspace.band("band_01").songs[0].id == SONG_1
    assert load_cache(cache, fake_supabase.user["id"]).raw == fixture()
    assert fake_supabase.rest_writes == []
    methods = {r[0] for r in fake_supabase.requests if r[1].startswith("/rest/")}
    assert methods == {"GET"}


def test_expired_jwt_is_refreshed_once_and_retried(fake_supabase, tmp_path):
    fake_supabase.workspace = fixture()
    manager = _manager(fake_supabase)
    fake_supabase.expire_access_tokens()  # server says 401 although our clock says valid
    snap = obtain_workspace(manager, fake_supabase.url, fake_supabase.api_key, str(tmp_path / "w.json"))
    assert snap.source == "cloud"
    rest = [r for r in fake_supabase.requests if r[1].startswith("/rest/")]
    assert len(rest) == 2


def test_offline_falls_back_to_the_cache_and_says_so(fake_supabase, tmp_path):
    fake_supabase.workspace = fixture()
    manager = _manager(fake_supabase)
    cache = str(tmp_path / "w.json")
    url = fake_supabase.url
    first = obtain_workspace(manager, url, fake_supabase.api_key, cache)
    fake_supabase.stop()  # the venue has no Internet
    manager._expires_at = 0  # force a refresh attempt too
    snap = obtain_workspace(manager, url, fake_supabase.api_key, cache)
    assert snap.source == "cache" and "Sin conexión" in snap.error
    assert snap.fetched_at == first.fetched_at
    assert snap.workspace.band("band_01").songs[0].id == SONG_1
    assert manager.is_signed_in()  # offline never signs the user out


def test_offline_without_cache_is_reported(fake_supabase, tmp_path):
    manager = _manager(fake_supabase)
    fake_supabase.stop()
    manager._expires_at = 0
    with pytest.raises(WorkspaceUnavailable, match="Sin conexión"):
        obtain_workspace(manager, "http://127.0.0.1:9", "k", str(tmp_path / "nada.json"))


def test_revoked_session_uses_cache_and_flags_it(fake_supabase, tmp_path):
    fake_supabase.workspace = fixture()
    manager = _manager(fake_supabase)
    cache = str(tmp_path / "w.json")
    obtain_workspace(manager, fake_supabase.url, fake_supabase.api_key, cache)
    fake_supabase.revoke_all()
    manager._expires_at = 0
    snap = obtain_workspace(manager, fake_supabase.url, fake_supabase.api_key, cache)
    assert snap.source == "cache" and snap.revoked
    assert not manager.is_signed_in()


def test_account_without_row_keeps_the_cache(fake_supabase, tmp_path):
    fake_supabase.workspace = copy.deepcopy(fixture())
    manager = _manager(fake_supabase)
    cache = str(tmp_path / "w.json")
    obtain_workspace(manager, fake_supabase.url, fake_supabase.api_key, cache)
    fake_supabase.has_row = False
    snap = obtain_workspace(manager, fake_supabase.url, fake_supabase.api_key, cache)
    assert snap.source == "cache" and "no tiene datos" in snap.error
