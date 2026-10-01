"""Single source of truth for every file path the leader reads or writes.

All user data (database, recordings, config, cloud cache) lives under
``bandait_home()``.
Environment overrides, in priority order:

- ``BANDAIT_DB``: full path of the SQLite database file.
- ``BANDAIT_HOME``: base folder for database, recordings and config.

Without overrides the base folder is ``~/Documents/Bandait`` (the historical
location, so existing installs keep their data). Tests must set both variables
to a temporary folder (see ``tests/conftest.py``).
"""

from __future__ import annotations

import os
from pathlib import Path


def bandait_home() -> Path:
    """Base folder for the leader's user data."""
    override = os.environ.get("BANDAIT_HOME", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / "Documents" / "Bandait").resolve()


def get_db_path() -> str:
    """Absolute path of the SQLite database. Honors ``BANDAIT_DB``."""
    override = os.environ.get("BANDAIT_DB", "").strip()
    if override:
        return str(Path(override).expanduser().resolve())
    return str(bandait_home() / "bandait.db")


def recordings_dir() -> str:
    return str(bandait_home() / "Recordings")


def config_path() -> str:
    """JSON file with persisted leader settings (audio device, routing, setlist)."""
    return str(bandait_home() / "leader_config.json")


def cloud_dir() -> str:
    """Data downloaded from the Web Hub. Never tokens: the session lives in keyring."""
    return str(bandait_home() / "cloud")


def cloud_workspace_cache_path() -> str:
    """Last good workspace snapshot from Supabase (offline fallback at the venue)."""
    return str(bandait_home() / "cloud" / "workspace.json")


def ensure_parent_dir(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
