"""Leader stems of the live song: background load, mixer, persistence, import from the window."""

import numpy as np
import pytest
import soundfile as sf
from PySide6.QtWidgets import QWidget

from src.audio import stem_library as lib
from src.audio.audio_engine import AudioEngine
from src.ui.stems_controller import StemsController
from src.ui.widgets.stem_mixer import StemMixerWidget, resolve_gains

SR = 48000


@pytest.fixture
def engine(monkeypatch):
    import sounddevice as sd

    dev = {"name": "x", "hostapi": 0, "max_input_channels": 2, "max_output_channels": 4,
           "default_samplerate": SR}
    monkeypatch.setattr(sd, "query_devices", lambda *a: dev if a else [dev])
    monkeypatch.setattr(sd, "query_hostapis", lambda: [{"name": "ASIO"}])
    return AudioEngine(sample_rate=SR, block_size=256, device=0)


def wav(path, seconds=0.2):
    sf.write(str(path), np.zeros((int(seconds * SR), 2), dtype=np.float32), SR)
    return str(path)


@pytest.fixture
def ctl(qtbot, engine, tmp_path):
    mixer = StemMixerWidget()
    container = QWidget()
    qtbot.addWidget(mixer)
    qtbot.addWidget(container)
    c = StemsController(engine, mixer, container, root=tmp_path / "Stems")
    c._save_timer.setInterval(10)
    return c, mixer, container, tmp_path


def test_resolve_gains():
    assert resolve_gains([0.0, -6.0, 0.0], [False, False, True], [False, False, False]) == pytest.approx(
        [1.0, 10 ** (-6 / 20), 0.0])
    assert resolve_gains([0.0, 0.0], [True, False], [True, False]) == [1.0, 0.0]  # solo wins over mute
    assert resolve_gains([-60.0], [False], [False]) == [0.0]


def test_song_without_stems_keeps_panel_hidden(ctl, engine):
    c, _mixer, container, _ = ctl
    c.show_song("s1", "Sin stems", 120)
    assert container.isHidden() and not engine.has_stems()


def test_load_mix_persist_and_drop_on_song_change(qtbot, ctl, engine):
    c, mixer, container, tmp = ctl
    root = tmp / "Stems"
    lib.import_stems("s1", [wav(tmp / "Vocals.wav"), wav(tmp / "Drums.wav")], root=root)
    shown = []
    c.stems_shown.connect(shown.append)
    c.show_song("s1", "Hoy vuelvo a casa", 92)
    qtbot.waitUntil(lambda: engine.has_stems(), timeout=5000)
    assert not container.isHidden() and shown[-1] is True
    assert [s.name_label.text() for s in mixer.strips] == ["VOZ", "BATERIA"]
    assert engine._stem_ref_bpm == 92.0

    mixer.strips[0].mute_btn.click()
    voices = engine._stems_cfg[0]
    assert voices[0][1] == 0.0 and voices[1][1] > 0
    mixer.offset_spin.setValue(40)
    assert engine._stem_offset_frames == pytest.approx(40 * SR / 1000)
    qtbot.waitUntil(lambda: lib.load("s1", root).offset_ms == 40.0, timeout=3000)
    saved = lib.load("s1", root)
    assert saved.stems[0].muted is True and saved.stems[1].muted is False

    # Another song while the first is decoding: the stale result is dropped.
    c.show_song("s1", "Hoy vuelvo a casa", 92)
    c.show_song("s2", "Otra", 120)
    c.wait_idle()
    qtbot.wait(50)
    assert container.isHidden() and not engine.has_stems()
    assert lib.load("s1", root).stems[0].muted is True  # settings were flushed, not lost


def test_import_replace_error_and_remove(qtbot, ctl, engine):
    c, mixer, container, tmp = ctl
    messages = []
    c.message.connect(messages.append)
    c.show_song("s9", "Nueva", 100)
    assert c.import_paths([wav(tmp / "Bass.wav")])
    qtbot.waitUntil(lambda: engine.has_stems(), timeout=5000)
    assert [s.name_label.text() for s in mixer.strips] == ["BAJO"]
    assert any("Stems listos" in m for m in messages)

    assert c.import_paths([str(tmp / "nada.txt")])
    qtbot.waitUntil(lambda: any("No se encontraron" in m for m in messages), timeout=5000)
    qtbot.waitUntil(lambda: not c.busy(), timeout=5000)
    assert engine.has_stems() and [s.name_label.text() for s in mixer.strips] == ["BAJO"]

    c.remove_live()
    assert not engine.has_stems() and container.isHidden()
    assert lib.load("s9", tmp / "Stems") is None


def test_undecodable_stems_show_the_reason(qtbot, ctl, engine):
    c, mixer, container, tmp = ctl
    (tmp / "Drums.m4a").write_bytes(b"\x00\x00\x00\x18ftypM4A ")
    lib.import_stems("s3", [str(tmp / "Drums.m4a")], root=tmp / "Stems")
    c.show_song("s3", "M4A", 100)
    qtbot.waitUntil(lambda: not container.isHidden(), timeout=5000)
    assert not engine.has_stems()
    assert "exporta los stems en MP3" in mixer.status.text()


def cloud_ctl(qtbot, engine, tmp_path, worker, refs):
    from src.cloud.stems_cloud import StemsCloud

    mixer = StemMixerWidget()
    container = QWidget()
    qtbot.addWidget(mixer)
    qtbot.addWidget(container)
    c = StemsController(engine, mixer, container, root=tmp_path / "Stems",
                        cloud=lambda: StemsCloud(lambda: "tok", "https://stems.test", worker),
                        cloud_ref=lambda sid: refs.get(sid))
    return c, mixer, container


def test_cloud_stems_download_on_song_change_when_stopped(qtbot, engine, tmp_path):
    from tests.test_stems_cloud import BAND, FakeWorker

    worker = FakeWorker()
    c, mixer, container = cloud_ctl(qtbot, engine, tmp_path, worker, {"l1": (BAND, "hub-song-1")})
    c.show_song("l1", "Hoy vuelvo a casa", 92, allow_network=False)  # playing: no network
    c.wait_idle()
    assert worker.requests == [] and container.isHidden()
    c.show_song("l1", "Hoy vuelvo a casa", 92, allow_network=True)
    qtbot.waitUntil(lambda: engine.has_stems(), timeout=5000)
    assert [s.name_label.text() for s in mixer.strips] == ["VOZ PRINCIPAL", "BATERIA"]
    assert engine._stem_offset_frames == pytest.approx(35 * SR / 1000)


def test_cloud_offline_falls_back_to_local(qtbot, engine, tmp_path):
    import urllib.error

    lib.import_stems("l1", [wav(tmp_path / "Bass.wav")], root=tmp_path / "Stems")

    def down(req, timeout):
        raise urllib.error.URLError("sin red")

    messages = []
    c, mixer, _ = cloud_ctl(qtbot, engine, tmp_path, down, {"l1": ("b", "hub-1")})
    c.message.connect(messages.append)
    c.show_song("l1", "Otra", 100, allow_network=True)
    qtbot.waitUntil(lambda: engine.has_stems(), timeout=5000)
    assert [s.name_label.text() for s in mixer.strips] == ["BAJO"]
    assert any("Se usan los del portátil" in m for m in messages)


def test_setlist_errors_say_why(qtbot, engine, tmp_path):
    import io
    import urllib.error

    def blocked(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, io.BytesIO(b"error code: 1010"))

    c, _mixer, _ = cloud_ctl(qtbot, engine, tmp_path, blocked, {"l1": ("b", "hub-1"), "l2": ("b", "hub-2")})
    messages = []
    c.message.connect(messages.append)
    assert c.download_setlist([("l1", "Uno"), ("l2", "Dos")])
    qtbot.waitUntil(lambda: any("con error" in m for m in messages), timeout=5000)
    final = [m for m in messages if "con error" in m][-1]
    assert "2 con error" in final and "Uno" in final and "error code: 1010" in final


def test_download_whole_setlist(qtbot, engine, tmp_path):
    from tests.test_stems_cloud import BAND, FakeWorker

    worker = FakeWorker()
    refs = {"l1": (BAND, "hub-song-1"), "l2": (BAND, "hub-song-1"), "local": None}
    c, mixer, _ = cloud_ctl(qtbot, engine, tmp_path, worker, refs)
    messages = []
    c.message.connect(messages.append)
    c.show_song("l1", "Uno", 100)
    assert c.download_setlist([("l1", "Uno"), ("l2", "Dos"), ("local", "Sin nube")])
    qtbot.waitUntil(lambda: any("2 canciones descargadas" in m for m in messages), timeout=8000)
    qtbot.waitUntil(lambda: engine.has_stems(), timeout=5000)  # the live song reloads with its stems
    assert lib.load("l2", tmp_path / "Stems") is not None
    assert lib.load("local", tmp_path / "Stems") is None
