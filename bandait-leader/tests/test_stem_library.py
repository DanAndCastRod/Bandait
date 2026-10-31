"""Stems on disk: import from a ZIP or loose files, manifest, decoding."""

import zipfile

import numpy as np
import pytest
import soundfile as sf

from src.audio import stem_library as lib


def tone(path, seconds=0.5, rate=44100, channels=2, fmt=None):
    t = np.arange(int(seconds * rate)) / rate
    wave = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    data = np.stack([wave] * channels, axis=1) if channels > 1 else wave
    sf.write(str(path), data, rate, format=fmt) if fmt else sf.write(str(path), data, rate)
    return path


def test_import_zip_like_moises(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    tone(src / "a.wav")
    zpath = tmp_path / "Hoy vuelvo a casa.zip"
    with zipfile.ZipFile(zpath, "w") as zf:
        for name in ("Hoy vuelvo a casa/Hoy vuelvo a casa - Vocals.wav",
                     "Hoy vuelvo a casa/Hoy vuelvo a casa - Drums.wav",
                     "../../escape - Bass.wav",
                     "__MACOSX/Hoy vuelvo a casa/._vocals.wav"):
            zf.write(src / "a.wav", name)
        zf.writestr("Hoy vuelvo a casa/readme.txt", "hola")
    root = tmp_path / "Stems"
    stem_set = lib.import_stems("song-1", [str(zpath)], root=root)
    assert [(s.role, s.label) for s in stem_set.stems] == [("vocals", "Voz"), ("drums", "Bateria"), ("bass", "Bajo")]
    folder = lib.song_dir("song-1", root)
    assert sorted(p.name for p in folder.iterdir()) == sorted(
        ["Hoy vuelvo a casa - Vocals.wav", "Hoy vuelvo a casa - Drums.wav", "escape - Bass.wav", "manifest.json"])
    assert not (tmp_path / "escape - Bass.wav").exists()  # zip slip: only base names are used
    assert lib.has_stems("song-1", root)
    assert lib.load("song-1", root).stems[2].file == "escape - Bass.wav"


def test_import_replaces_and_keeps_offset(tmp_path):
    root = tmp_path / "Stems"
    tone(tmp_path / "drums.wav")
    tone(tmp_path / "Bajo.wav")
    first = lib.import_stems("s", [str(tmp_path / "drums.wav")], root=root)
    first.offset_ms = 120.0
    lib.save(first, root)
    second = lib.import_stems("s", [str(tmp_path / "Bajo.wav"), str(tmp_path / "notes.txt")], root=root)
    assert [s.role for s in second.stems] == ["bass"]
    assert second.offset_ms == 120.0
    assert sorted(p.name for p in lib.song_dir("s", root).iterdir()) == ["Bajo.wav", "manifest.json"]
    lib.remove("s", root)
    assert lib.load("s", root) is None


def test_import_refuses_nothing_and_too_many(tmp_path):
    with pytest.raises(lib.StemImportError, match="No se encontraron"):
        lib.import_stems("s", [str(tmp_path / "nada.txt")], root=tmp_path / "Stems")
    files = [str(tone(tmp_path / f"pista {i}.wav", seconds=0.01)) for i in range(lib.MAX_STEMS + 1)]
    with pytest.raises(lib.StemImportError, match="Demasiadas"):
        lib.import_stems("s", files, root=tmp_path / "Stems")
    assert not lib.song_dir("s", tmp_path / "Stems").exists()


def test_song_dir_is_safe_for_any_id(tmp_path):
    d = lib.song_dir("../../a b/c:d", tmp_path)
    assert d.parent == tmp_path and "/" not in d.name and ".." not in d.name


def test_decode_resamples_and_reports_bad_files(tmp_path):
    root = tmp_path / "Stems"
    tone(tmp_path / "Vocals.mp3", seconds=1.0, rate=44100, fmt="MP3")
    tone(tmp_path / "Bass.wav", seconds=1.0, rate=44100, channels=1)
    (tmp_path / "Drums.m4a").write_bytes(b"\x00\x00\x00\x18ftypM4A ")
    stem_set = lib.import_stems("s", [str(tmp_path / n) for n in ("Vocals.mp3", "Bass.wav", "Drums.m4a")], root=root)
    decoded = lib.decode(stem_set, 48000, root)
    (v, vdata, verr), (b, bdata, berr), (d, ddata, derr) = decoded
    assert verr == "" and vdata.dtype == np.int16 and vdata.shape[1] == 2
    assert abs(vdata.shape[0] - 48000) < 2400  # MP3 adds encoder padding
    assert berr == "" and bdata.shape == (48000, 2) and np.array_equal(bdata[:, 0], bdata[:, 1])
    assert ddata is None and "exporta los stems en MP3" in derr
