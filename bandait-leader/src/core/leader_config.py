"""Persisted leader settings (JSON under ``bandait_home()``).

Defensive by design: a missing, unreadable or corrupt file never stops the
leader from starting; it falls back to defaults and the next save rewrites it.
Writes are atomic (temp file + replace) so a crash mid-write cannot leave a
half-written config behind.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
import urllib.parse
from dataclasses import asdict, dataclass, fields
from typing import Optional

from src.core.paths import config_path, ensure_parent_dir

logger = logging.getLogger(__name__)


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
    # Supabase project of the Web Hub (None = built-in production project).
    # BANDAIT_SUPABASE_URL / BANDAIT_SUPABASE_KEY win over these.
    supabase_url: Optional[str] = None
    supabase_key: Optional[str] = None
    # Hub band this laptop plays (Band.id of the workspace) and the account it
    # belongs to (band ids are only unique per account). The chosen setlist is
    # active_setlist_id, the same field local setlists use.
    cloud_band_id: Optional[str] = None
    cloud_user_id: Optional[str] = None


# Production Supabase project of the Web Hub. Public values by design (they also
# ship in every hub bundle, see bandait-leader-web/.env.production): security
# comes from RLS, never from hiding the publishable key.
DEFAULT_SUPABASE_URL = "https://xftzxzwopwzjmttrwtga.supabase.co"
DEFAULT_SUPABASE_KEY = "sb_publishable_kuAR_g2Z5RNbssRcuZ2IEA_qhu5iFv8"


@dataclass(frozen=True)
class CloudConfig:
    url: str  # no trailing slash
    key: str  # publishable / anon key, never a secret one
    source: str  # "env" | "config" | "default"


def _jwt_role(token: str) -> Optional[str]:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload.encode("ascii")))
    except (ValueError, UnicodeError):
        return None
    role = claims.get("role") if isinstance(claims, dict) else None
    return role if isinstance(role, str) else None


def validate_supabase_url(url: object) -> Optional[str]:
    """Normalized URL, or None. HTTPS only, except loopback (local tests)."""
    if not isinstance(url, str):
        return None
    url = url.strip().rstrip("/")
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError:
        return None
    if not parsed.hostname or parsed.query or parsed.fragment:
        return None
    if parsed.scheme == "https":
        return url
    if parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1"):
        return url
    return None


def validate_supabase_key(key: object) -> Optional[str]:
    """The key, or None if empty or secret. A secret key ignores RLS: the leader
    refuses it like the hub does (``sb_secret_`` prefix or a ``service_role`` JWT)."""
    if not isinstance(key, str):
        return None
    key = key.strip()
    if not key or key.startswith("sb_secret_") or _jwt_role(key) == "service_role":
        return None
    return key


def resolve_cloud_config(settings: Optional["LeaderSettings"] = None) -> CloudConfig:
    """Supabase URL and key. Priority: env, then leader config, then defaults.
    An invalid or secret override is ignored (logged) and the next source is used."""
    candidates = [
        ("env", os.environ.get("BANDAIT_SUPABASE_URL"), os.environ.get("BANDAIT_SUPABASE_KEY")),
        ("config", getattr(settings, "supabase_url", None), getattr(settings, "supabase_key", None)),
    ]
    url = key = None
    url_source = key_source = "default"
    for source, raw_url, raw_key in candidates:
        if url is None and raw_url:
            url = validate_supabase_url(raw_url)
            if url is None:
                logger.warning("URL de Supabase no valida en %s: se ignora", source)
            else:
                url_source = source
        if key is None and raw_key:
            key = validate_supabase_key(raw_key)
            if key is None:
                logger.warning("Clave de Supabase rechazada en %s (vacia o secreta): se ignora", source)
            else:
                key_source = source
    source = url_source if url_source == key_source else f"{url_source}+{key_source}"
    return CloudConfig(url=url or DEFAULT_SUPABASE_URL, key=key or DEFAULT_SUPABASE_KEY, source=source)


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
