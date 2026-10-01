"""Test isolation: no test may read or write the user's real files.

Environment overrides are applied at import time (before any ``src`` module
computes a path) and again per test with a fresh tmp folder:

- BANDAIT_HOME / BANDAIT_DB -> tmp (database, recordings, leader config)
- HOME / USERPROFILE        -> tmp (anything still using ``~`` lands in tmp)
- BANDAIT_PORT=0            -> MainWindow binds an ephemeral port
- BANDAIT_AUDIO_DISABLED=1  -> no PortAudio stream is ever opened
"""

import os
import tempfile

import pytest

_REAL_HOME = os.path.expanduser("~")
_REAL_DB = os.path.join(_REAL_HOME, "Documents", "Bandait", "bandait.db")
_TMP_ROOT = tempfile.mkdtemp(prefix="bandait-tests-")


def _stat(path):
    try:
        st = os.stat(path)
        return (st.st_size, st.st_mtime_ns)
    except OSError:
        return None


_REAL_DB_BEFORE = _stat(_REAL_DB)

os.environ["BANDAIT_HOME"] = os.path.join(_TMP_ROOT, "bandait_home")
os.environ["BANDAIT_DB"] = os.path.join(_TMP_ROOT, "bandait_home", "bandait.db")
os.environ["HOME"] = os.path.join(_TMP_ROOT, "user_home")
os.environ["USERPROFILE"] = os.path.join(_TMP_ROOT, "user_home")
os.environ["BANDAIT_PORT"] = "0"
os.environ["BANDAIT_HOST"] = "127.0.0.1"
os.environ["BANDAIT_AUDIO_DISABLED"] = "1"
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.makedirs(os.environ["HOME"], exist_ok=True)


@pytest.fixture(autouse=True)
def isolated_user_dirs(tmp_path, monkeypatch):
    home = tmp_path / "bandait_home"
    user_home = tmp_path / "user_home"
    home.mkdir()
    user_home.mkdir()
    monkeypatch.setenv("BANDAIT_HOME", str(home))
    monkeypatch.setenv("BANDAIT_DB", str(home / "bandait.db"))
    monkeypatch.setenv("HOME", str(user_home))
    monkeypatch.setenv("USERPROFILE", str(user_home))
    monkeypatch.setenv("BANDAIT_PORT", "0")
    monkeypatch.setenv("BANDAIT_HOST", "127.0.0.1")
    monkeypatch.setenv("BANDAIT_AUDIO_DISABLED", "1")
    yield home


def pytest_sessionfinish(session, exitstatus):
    """Fail loudly if anything touched the user's real database."""
    if _stat(_REAL_DB) != _REAL_DB_BEFORE:
        session.exitstatus = 1
        print(f"\nERROR: la suite modifico la base real del usuario: {_REAL_DB}")
