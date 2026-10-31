"""Leader download of cloud stems (bandait-stems Worker), with a fake HTTP opener."""

import io
import json
import urllib.error
import urllib.parse

import numpy as np
import pytest
import soundfile as sf

from src.audio import stem_library as lib
from src.cloud.http import CloudHTTPError, CloudOffline
from src.cloud.stems_cloud import StemsCloud, sync_song

BAND = "11111111-2222-4333-8444-555555555555"


def wav_bytes(seconds=0.1):
    buf = io.BytesIO()
    sf.write(buf, np.zeros((int(seconds * 48000), 2), dtype=np.float32), 48000, format="WAV")
    return buf.getvalue()


class FakeWorker:
    def __init__(self, scope=BAND, deny_band=False):
        self.files = {"Hoy - Vocals.wav": wav_bytes(), "Hoy - Drums.wav": wav_bytes(0.2)}
        self.scope = scope
        self.deny_band = deny_band
        self.updated_at = "2026-10-30T22:00:00.000Z"
        self.requests = []

    def manifest(self):
        return {"version": 1, "song_id": "hub-song-1", "offset_ms": 35, "updated_at": self.updated_at,
                "stems": [{"file": n, "role": "vocals" if "Vocals" in n else "drums",
                           "label": "Voz principal" if "Vocals" in n else "Bateria", "size": len(b)}
                          for n, b in self.files.items()]}

    def __call__(self, req, timeout):
        url = req.full_url
        self.requests.append(url)
        assert req.headers["Authorization"] == "Bearer tok"
        assert req.get_header("User-agent", "").startswith("Bandait-Leader")  # never Python-urllib

        def fail(code, err):
            raise urllib.error.HTTPError(url, code, err, {}, io.BytesIO(json.dumps({"error": err}).encode()))

        if f"/bands/{BAND}/" in url and self.deny_band:
            fail(403, "not_a_member")
        if f"/bands/{self.scope}/" not in url:
            fail(404, "no_stems")
        if url.endswith("/manifest"):
            return io.BytesIO(json.dumps(self.manifest()).encode())
        name = urllib.parse.unquote(url.rsplit("/", 1)[1])
        return io.BytesIO(self.files[name])



def test_download_applies_roles_labels_offset_and_skips_when_current(tmp_path):
    worker = FakeWorker()
    cloud = StemsCloud(lambda: "tok", base_url="https://stems.test", opener=worker)
    root = tmp_path / "Stems"
    steps = []
    assert sync_song(cloud, "local-7", BAND, "hub-song-1", root, progress=lambda i, n: steps.append((i, n))) == "updated"
    stem_set = lib.load("local-7", root)
    assert [(s.role, s.label) for s in stem_set.stems] == [("vocals", "Voz principal"), ("drums", "Bateria")]
    assert stem_set.offset_ms == 35.0
    assert stem_set.cloud == {"scope": BAND, "song": "hub-song-1", "updated_at": worker.updated_at}
    assert steps[-1] == (2, 2)
    assert not [p for p in root.iterdir() if p.name.startswith("descarga-")]  # temp dir removed

    n = len(worker.requests)
    assert sync_song(cloud, "local-7", BAND, "hub-song-1", root) == "current"
    assert len(worker.requests) == n + 1  # only the manifest

    worker.updated_at = "2026-10-31T10:00:00.000Z"
    worker.files["Hoy - Bass.wav"] = wav_bytes()
    assert sync_song(cloud, "local-7", BAND, "hub-song-1", root) == "updated"
    assert len(lib.load("local-7", root).stems) == 3


def test_personal_workspace_fallback_and_no_stems(tmp_path):
    worker = FakeWorker(scope="me", deny_band=True)
    cloud = StemsCloud(lambda: "tok", base_url="https://stems.test", opener=worker)
    assert sync_song(cloud, "l1", BAND, "hub-song-1", tmp_path) == "updated"
    assert lib.load("l1", tmp_path).cloud["scope"] == "me"
    assert sync_song(StemsCloud(lambda: "tok", "https://s", FakeWorker(scope="nadie")), "l2", BAND, "x", tmp_path) == "none"


def test_hand_imported_stems_win_unless_forced(tmp_path):
    src = tmp_path / "Bass.wav"
    src.write_bytes(wav_bytes())
    lib.import_stems("l1", [str(src)], tmp_path / "Stems")
    cloud = StemsCloud(lambda: "tok", base_url="https://stems.test", opener=FakeWorker())
    assert sync_song(cloud, "l1", BAND, "hub-song-1", tmp_path / "Stems") == "local"
    assert [s.role for s in lib.load("l1", tmp_path / "Stems").stems] == ["bass"]
    assert sync_song(cloud, "l1", BAND, "hub-song-1", tmp_path / "Stems", force=True) == "updated"
    assert len(lib.load("l1", tmp_path / "Stems").stems) == 2


def test_truncated_download_keeps_local_stems(tmp_path):
    worker = FakeWorker()
    good = sync_song(StemsCloud(lambda: "tok", "https://s", worker), "l1", BAND, "hub-song-1", tmp_path)
    assert good == "updated"
    worker.updated_at = "nuevo"
    worker.files["Hoy - Drums.wav"] = worker.files["Hoy - Drums.wav"][:100]  # body shorter than the manifest says

    real_manifest = worker.manifest

    def stale_size():
        m = real_manifest()
        m["stems"][1]["size"] += 50
        return m

    worker.manifest = stale_size
    with pytest.raises(CloudHTTPError):
        sync_song(StemsCloud(lambda: "tok", "https://s", worker), "l1", BAND, "hub-song-1", tmp_path)
    assert lib.load("l1", tmp_path).cloud["updated_at"] != "nuevo"  # previous stems intact


def test_cloudflare_block_text_reaches_the_message(tmp_path):
    def blocked(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(b"error code: 1010\n"))

    with pytest.raises(CloudHTTPError) as info:
        sync_song(StemsCloud(lambda: "tok", "https://s", blocked), "l1", BAND, "x", tmp_path)
    assert "error code: 1010" in str(info.value) and info.value.status == 403


def test_offline_raises_cloud_offline(tmp_path):
    def down(req, timeout):
        raise urllib.error.URLError("sin red")

    with pytest.raises(CloudOffline):
        sync_song(StemsCloud(lambda: "tok", "https://s", down), "l1", BAND, "x", tmp_path)
