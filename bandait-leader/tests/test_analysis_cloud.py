"""Analizar con IA desde el líder: mezcla, cliente del Worker, inspector y controlador."""

import io
import json
import urllib.error
import urllib.parse

import numpy as np
import pytest
import soundfile as sf
from PySide6.QtWidgets import QApplication

from src.audio import stem_library as lib
from src.cloud.analysis_cloud import AnalysisCloud, draft_summary, mix_for_analysis
from src.cloud.http import CloudHTTPError
from src.cloud.stems_cloud import StemsCloud

BAND = "11111111-2222-4333-8444-555555555555"
DRAFT = {"status": "SUCCEEDED", "draft": {"bpm": 124, "key": "E", "lyrics_unplaced": ["x"],
                                          "sections": [{"label": "Intro", "bars": 8}, {"label": "Coro", "bars": 16}]}}


def tone(path, seconds=1.0, freq=440, amp=0.5):
    t = np.arange(int(seconds * 48000)) / 48000
    sf.write(str(path), np.stack([amp * np.sin(2 * np.pi * freq * t)] * 2, axis=1).astype(np.float32), 48000)
    return str(path)


def test_mix_skips_click_and_stays_under_full_scale(tmp_path):
    files = [tone(tmp_path / "Vocals.wav"), tone(tmp_path / "Bass.wav", freq=110), tone(tmp_path / "click.wav", amp=1.0)]
    stem_set = lib.import_stems("s", files, root=tmp_path / "Stems")
    wav = mix_for_analysis(stem_set, tmp_path / "Stems")
    data, rate = sf.read(io.BytesIO(wav))
    assert rate == 22050 and data.ndim == 1 and abs(len(data) - 22050) < 50
    assert np.abs(data).max() <= 0.9


class FakeWorker:
    def __init__(self, deny_band=False, status_body=None):
        self.deny_band = deny_band
        self.status_body = status_body
        self.calls = []

    def __call__(self, req, timeout):
        url = req.full_url
        self.calls.append((req.get_method(), urllib.parse.unquote(url), req.get_header("Content-type")))
        assert req.get_header("User-agent", "").startswith("Bandait-Leader")

        def fail(code, err):
            raise urllib.error.HTTPError(url, code, err, {}, io.BytesIO(json.dumps({"error": err}).encode()))

        if f"/bands/{BAND}/" in url and self.deny_band:
            fail(403, "not_a_member")
        if req.get_method() == "POST":
            return io.BytesIO(b'{"status":"STARTED","job_id":"j1"}')
        if self.status_body is None:
            fail(404, "no_analysis")
        return io.BytesIO(json.dumps(self.status_body).encode())


def client(worker):
    return AnalysisCloud(StemsCloud(lambda: "tok", "https://w.test", worker))


def test_client_start_status_and_personal_fallback():
    w = FakeWorker()
    scope, resp = client(w).start(BAND, "song-1", b"RIFF....")
    assert scope == BAND and resp["status"] == "STARTED"
    assert w.calls[0][0] == "POST" and w.calls[0][2] == "audio/wav"
    assert client(FakeWorker()).status(BAND, "song-1") == (BAND, {})
    w2 = FakeWorker(deny_band=True, status_body=DRAFT)
    scope, resp = client(w2).status(BAND, "song-1")
    assert scope == "me" and resp["status"] == "SUCCEEDED"


def test_editor_error_is_readable():
    def denied(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "x", {}, io.BytesIO(b'{"error":"not_an_editor"}'))

    with pytest.raises(CloudHTTPError) as info:
        client(denied).start(BAND, "s", b"x")
    assert "Owner o el Director" in str(info.value)


def test_draft_summary():
    assert draft_summary({}) == "Sin análisis todavía."
    assert "Analizando" in draft_summary({"status": "STARTED"})
    text = draft_summary(DRAFT)
    assert "2 secciones, 24 compases" in text and "124 BPM" in text and "letra sin ubicar" in text
    assert "Falló" in draft_summary({"status": "FAILED", "error": "x"})


def test_inspector_and_controller(qtbot, tmp_path, monkeypatch):
    from src.ui.analysis_controller import AnalysisController
    from src.ui.views.song_inspector import SongInspector

    insp = SongInspector()
    qtbot.addWidget(insp)
    insp.set_song({"title": "Dame tu aire", "artist": "Alex Ubago", "bpm": 92, "key": "Am"},
                  [{"label": "Intro", "bars": 8, "start_bar": 1}], "Voz, Bateria", True)
    assert insp.section_count() == 1 and insp.analyze_btn.isEnabled()
    insp.set_song({"title": "Sin nada"}, [], "", False, "Esta canción no tiene stems en el portátil")
    assert not insp.analyze_btn.isEnabled() and "stems" in insp.analyze_btn.toolTip()

    worker = FakeWorker(status_body=DRAFT)
    ctl = AnalysisController(lambda: StemsCloud(lambda: "tok", "https://w.test", worker))
    states = []
    ctl.state.connect(lambda s, t, busy: states.append((s, t)))
    ctl.select("local-1", (BAND, "song-1"))
    qtbot.waitUntil(lambda: any(s == "Listo" for s, _ in states), timeout=5000)
    assert "2 secciones" in states[-1][1]

    monkeypatch.setattr(lib, "load", lambda song_id, root=None: None)
    ctl.analyze()
    qtbot.waitUntil(lambda: states[-1][0] == "Error", timeout=5000)
    assert "no tiene stems" in states[-1][1]
    QApplication.processEvents()


def test_separate_upload_and_summary(tmp_path, monkeypatch):
    from src.cloud import analysis_cloud as ac

    w = FakeWorker()
    scope, resp = client(w).start(BAND, "song-1", b"fLaC....", "audio/flac", separate=True)
    assert w.calls[0][0] == "POST" and w.calls[0][1].endswith("/analysis?separate=1") and w.calls[0][2] == "audio/flac"

    song = tmp_path / "cancion.flac"
    song.write_bytes(b"x" * 10)
    assert ac.read_song_audio(str(song)) == (b"x" * 10, "audio/flac")
    (tmp_path / "notas.txt").write_text("x")
    with pytest.raises(ValueError, match="Formato"):
        ac.read_song_audio(str(tmp_path / "notas.txt"))
    monkeypatch.setattr(ac, "SEPARATE_MAX_BYTES", 5)
    with pytest.raises(ValueError, match="máximo"):
        ac.read_song_audio(str(song))

    assert "3/7" in draft_summary({"status": "IMPORTING", "done": 3, "total": 7})
    done = dict(DRAFT, stems={"stems": [{"file": "Vocals.wav"}, {"file": "Drums.wav"}]})
    assert draft_summary(done).startswith("2 stems separados")


def test_controller_separate_polls_import_and_asks_for_stems(qtbot, tmp_path, monkeypatch):
    from src.ui import analysis_controller as actl
    from src.ui.views.song_inspector import SongInspector

    monkeypatch.setattr(actl, "IMPORT_POLL_MS", 10)
    monkeypatch.setattr(actl, "POLL_MS", 10)
    steps = [{"status": "STARTED"}, {"status": "IMPORTING", "done": 1, "total": 2},
             dict(DRAFT, stems={"stems": [{"file": "Vocals.wav"}, {"file": "Drums.wav"}]})]

    class SeqWorker(FakeWorker):
        def __call__(self, req, timeout):
            self.calls.append((req.get_method(), urllib.parse.unquote(req.full_url), req.get_header("Content-type")))
            if req.get_method() == "POST":
                self.posted = True
                return io.BytesIO(b'{"status":"STARTED","job_id":"j1","separate":true}')
            if not getattr(self, "posted", False):
                raise urllib.error.HTTPError(req.full_url, 404, "x", {}, io.BytesIO(b'{"error":"no_analysis"}'))
            return io.BytesIO(json.dumps(steps.pop(0) if len(steps) > 1 else steps[0]).encode())

    song = tmp_path / "cancion.wav"
    song.write_bytes(b"RIFF" + b"\0" * 40)
    worker = SeqWorker()
    ctl = actl.AnalysisController(lambda: StemsCloud(lambda: "tok", "https://w.test", worker))
    states, ready = [], []
    ctl.state.connect(lambda s, t, busy: states.append(s))
    ctl.stems_ready.connect(ready.append)
    ctl.select("local-9", (BAND, "song-9"))
    qtbot.waitUntil(lambda: bool(states), timeout=5000)  # no analysis yet: no polling
    ctl.separate(str(song))
    qtbot.waitUntil(lambda: ready == ["local-9"], timeout=5000)
    assert "Copiando" in states and states[-1] == "Listo"
    assert any(c[0] == "POST" and c[1].endswith("?separate=1") and c[2] == "audio/wav" for c in worker.calls)

    insp = SongInspector()
    qtbot.addWidget(insp)
    insp.set_song({"title": "Sin stems"}, [], "", False, "Esta canción no tiene stems en el portátil", True, "")
    assert not insp.analyze_btn.isEnabled() and insp.separate_btn.isEnabled()
    insp.set_analysis("Copiando", "1/2", True)
    assert not insp.separate_btn.isEnabled()
    insp.set_analysis("Listo", "ok", False)
    assert insp.separate_btn.isEnabled() and not insp.analyze_btn.isEnabled()
