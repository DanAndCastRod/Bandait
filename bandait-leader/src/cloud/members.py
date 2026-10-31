"""Members of a shared band (docs/sql/bandas_compartidas.sql, table bandait_band_members).

Read only, like the workspace download: the roles are changed in the hub. RLS returns
the member list only to members of that band, so the leader sends the user's own JWT
plus the publishable key, never a secret one.
"""

from __future__ import annotations

import urllib.parse
from typing import Dict, List

from src.cloud.http import DEFAULT_TIMEOUT_S, CloudHTTPError, request_json

MEMBERS_TABLE = "bandait_band_members"
ROLES = ("Owner", "MusicDirector", "Musician", "Substitute", "SoundEngineer")
_MAX_TEXT = 120


def _text(value: object, limit: int = _MAX_TEXT) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def fetch_band_members(config, access_token: str, band_id: str, timeout: float = DEFAULT_TIMEOUT_S) -> List[Dict[str, str]]:
    """``[{email, role, name, instrument}]`` of ``band_id``, sorted by role then name.

    ``config`` is a ``CloudConfig`` (url + publishable key). ``[]`` when the shared-band
    tables do not exist yet (SQL not applied) or RLS hides the band. Raises
    ``CloudOffline`` / ``CloudHTTPError`` like the rest of ``src.cloud``."""
    if not isinstance(band_id, str) or not band_id.strip():
        return []
    query = urllib.parse.urlencode({
        "band_id": f"eq.{band_id.strip()}",
        "select": "email,role,name,instrument",
    })
    try:
        data = request_json(
            "GET",
            f"{config.url.rstrip('/')}/rest/v1/{MEMBERS_TABLE}?{query}",
            headers={"apikey": config.key, "Authorization": f"Bearer {access_token}"},
            timeout=timeout,
        )
    except CloudHTTPError as err:
        if err.status == 404 or err.error_code in ("PGRST205", "42P01"):
            return []
        raise
    if not isinstance(data, list):
        raise CloudHTTPError(200, "bad_shape", "La nube respondió algo inesperado al leer los integrantes")
    members: List[Dict[str, str]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        email = _text(row.get("email"), 320).lower()
        if not email:
            continue
        role = row.get("role") if row.get("role") in ROLES else "Musician"
        members.append({
            "email": email,
            "role": role,
            "name": _text(row.get("name")),
            "instrument": _text(row.get("instrument")),
        })
    members.sort(key=lambda m: (ROLES.index(m["role"]), (m["name"] or m["email"]).casefold()))
    return members
