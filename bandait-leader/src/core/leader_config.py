"""Persisted leader settings (JSON under ``bandait_home()``).

Defensive by design: a missing, unreadable or corrupt file never stops the
leader from starting; it falls back to defaults and the next save rewrites it.
Writes are atomic (temp file + replace) so a crash mid-write cannot leave a
half-written config behind.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, fields
from typing import Optional

from src.core.paths import config_path, ensure_parent_dir


@dataclass
class LeaderSettings:
    # Audio output device, stored by name + host API because PortAudio indices
    # change when devices are plugged or unplugged.
    audio_output_device_name: Optional[str] = None
    audio_output_hostapi: Optional[str] = None
    # Click routing: drummer click on Out 3 (channel index 2), PA click on Out 1-2.
    drummer_click_enabled: bool = True
    pa_click_enabled: bool = False
    # Load the ASIO-enabled PortAudio build shipped with sounddevice
    # (SD_ENABLE_ASIO). Read before sounddevice is imported: needs a restart.
    enable_asio: bool = False
    # Setlist that was last loaded as the live setlist.
    active_setlist_id: Optional[str] = None
    # LAN IPv4 advertised to phones (None = automatic; BANDAIT_LAN_IP wins over it).
    lan_ip: Optional[str] = None
    # Follower bundle folder (None = BANDAIT_FOLLOWER_DIR / repo landing/app / exe bundle).
    follower_dir: Optional[str] = None


def load_settings(path: Optional[str] = None) -> LeaderSettings:
    path = path or config_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return LeaderSettings()
    if not isinstance(raw, dict):
        return LeaderSettings()
    known = {f.name: f for f in fields(LeaderSettings)}
    values = {}
    defaults = LeaderSettings()
    for name in known:
        if name not in raw:
            continue
        value = raw[name]
        default = getattr(defaults, name)
        if isinstance(default, bool):
            if isinstance(value, bool):
                values[name] = value
        elif value is None or isinstance(value, str):
            values[name] = value
    return LeaderSettings(**values)


def save_settings(settings: LeaderSettings, path: Optional[str] = None) -> None:
    path = path or config_path()
    ensure_parent_dir(path)
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".leader_config.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(asdict(settings), fh, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
