"""PortAudio loading: ASIO opt-in and foreign portaudio.dll on PATH."""

import os
import sys

import pytest

from src.audio import portaudio_setup as pa
from src.ui.dialogs.audio_devices import asio_status_text


def test_env_flag():
    assert pa.env_flag("1") is True and pa.env_flag(" Yes ") is True
    assert pa.env_flag("0") is False and pa.env_flag("off") is False
    assert pa.env_flag("") is None and pa.env_flag(None) is None and pa.env_flag("x") is None


def test_bandait_asio_env_overrides_the_setting():
    assert pa.asio_wanted(False, {"BANDAIT_ASIO": "1"}) is True
    assert pa.asio_wanted(True, {"BANDAIT_ASIO": "0"}) is False  # gig troubleshooting
    assert pa.asio_wanted(True, {}) is True
    assert pa.asio_wanted(False, {"SD_ENABLE_ASIO": "1"}) is False  # the setting decides
    assert pa.asio_wanted(None, {"SD_ENABLE_ASIO": "1"}) is True  # no setting: honor it
    assert pa.asio_wanted(None, {"SD_ENABLE_ASIO": "0"}) is False


@pytest.mark.parametrize("stale", ["0", "", "false"])
def test_sd_enable_asio_is_removed_when_asio_is_off(stale):
    # sounddevice loads the ASIO DLL if the variable merely exists.
    env = {"SD_ENABLE_ASIO": stale}
    pa.configure_asio_env(False, env)
    assert "SD_ENABLE_ASIO" not in env
    pa.configure_asio_env(True, env)
    assert env["SD_ENABLE_ASIO"] == "1"


def test_finds_portaudio_dll_on_path(tmp_path, monkeypatch):
    shadow = tmp_path / "audacity"
    clean = tmp_path / "clean"
    shadow.mkdir()
    clean.mkdir()
    (shadow / "portaudio.dll").write_bytes(b"MZ")
    env = {"PATH": os.pathsep.join([str(clean), str(shadow)])}
    found = pa.find_shadowing_portaudio(env, platform="win32")
    assert found == [(str(shadow), os.path.abspath(str(shadow / "portaudio.dll")))]
    # An empty PATH entry is the current folder for ctypes.util.find_library.
    monkeypatch.chdir(shadow)
    found = pa.find_shadowing_portaudio({"PATH": os.pathsep + str(clean)}, platform="win32")
    assert [entry for entry, _dll in found] == [""]
    # Linux and macOS use find_library on purpose (system libportaudio).
    assert pa.find_shadowing_portaudio(env, platform="linux") == []


def test_path_without_drops_only_the_shadowing_entries(tmp_path):
    a, b, c = str(tmp_path / "a"), str(tmp_path / "b"), str(tmp_path / "c")
    value = os.pathsep.join([a, b, c, ""])
    assert pa.path_without(value, [b, ""]) == os.pathsep.join([a, c])


@pytest.fixture
def fake_sounddevice(tmp_path, monkeypatch):
    """A stand-in ``sounddevice`` module that records the environment it was
    imported with, so the test sees what PortAudio would have seen."""
    pkg = tmp_path / "fake_sd"
    pkg.mkdir()
    (pkg / "sounddevice.py").write_text(
        "import os\n"
        "SEEN_PATH = os.environ.get('PATH', '')\n"
        "SEEN_ASIO = os.environ.get('SD_ENABLE_ASIO')\n"
        "_libname = r'C:\\bundle\\libportaudio64bit' + ('-asio' if SEEN_ASIO is not None else '') + '.dll'\n"
        "def query_hostapis():\n"
        "    names = ['MME', 'Windows WASAPI'] + (['ASIO'] if SEEN_ASIO is not None else [])\n"
        "    return [{'name': n} for n in names]\n",
        encoding="utf-8",
    )
    monkeypatch.delitem(sys.modules, "sounddevice", raising=False)
    monkeypatch.syspath_prepend(str(pkg))
    monkeypatch.setattr(pa, "_SETUP", None)
    yield
    sys.modules.pop("sounddevice", None)  # monkeypatch restores the real module


def test_import_hides_the_foreign_dll_and_restores_path(tmp_path, monkeypatch, fake_sounddevice):
    shadow = tmp_path / "old_reaper"
    shadow.mkdir()
    (shadow / "portaudio.dll").write_bytes(b"MZ")
    path_before = os.pathsep.join([str(shadow), str(tmp_path)])
    monkeypatch.setenv("PATH", path_before)
    monkeypatch.setenv("SD_ENABLE_ASIO", "0")
    monkeypatch.delenv("BANDAIT_ASIO", raising=False)
    monkeypatch.setattr(pa.sys, "platform", "win32")

    setup = pa.ensure_sounddevice(asio=True)

    sd = setup.module
    assert str(shadow) not in sd.SEEN_PATH.split(os.pathsep)  # hidden during the import
    assert os.environ["PATH"] == path_before  # and restored right after
    assert sd.SEEN_ASIO == "1"
    assert setup.asio_loaded and setup.library.endswith("-asio.dll")
    assert setup.shadowing and setup.shadow_avoided
    assert "Se ignoro un PortAudio ajeno" in setup.warnings()[0]
    assert pa.ensure_sounddevice(asio=False) is setup  # first call wins (DLL is fixed)


def test_asio_off_imports_without_the_variable(monkeypatch, fake_sounddevice):
    monkeypatch.setenv("SD_ENABLE_ASIO", "0")
    monkeypatch.delenv("BANDAIT_ASIO", raising=False)
    setup = pa.ensure_sounddevice(asio=False)
    assert setup.module.SEEN_ASIO is None
    assert not setup.asio_loaded and setup.warnings() == []


def test_warnings_for_the_ui():
    missing = pa.PortAudioSetup(error="OSError: no se encontro la DLL")
    assert "PortAudio no disponible" in missing.warnings()[0]
    not_loaded = pa.PortAudioSetup(asio_requested=True, module=object(), library="x.dll")
    assert "no tiene ASIO" in not_loaded.warnings()[0]
    shadowed = pa.PortAudioSetup(module=object(), shadowing=["C:\\x\\portaudio.dll"])
    assert "reemplaza al de Bandait" in shadowed.warnings()[0]


def test_audio_dialog_asio_text():
    assert asio_status_text(True, None) == "ASIO detectado."
    loaded = pa.PortAudioSetup(module=object(), asio_loaded=True)
    assert "no hay dispositivos ASIO" in asio_status_text(False, loaded)
    assert "no esta cargado" in asio_status_text(False, pa.PortAudioSetup(module=object()))
