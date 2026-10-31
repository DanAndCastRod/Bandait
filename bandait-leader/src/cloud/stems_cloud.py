"""Stems from the bandait-stems Worker (R2) into the leader's stem library.

Contract: bandait-stems-worker/README.md. The leader only reads: a band member's
session is enough (Owner / MusicDirector upload from the hub). Files are streamed
to disk in chunks (a stem is several MB; http.request caps bodies on purpose) and
their size is checked against the manifest before anything replaces local stems.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable, Optional, Tuple

from src.audio import stem_library as lib
from src.cloud.http import CloudHTTPError, CloudOffline

logger = logging.getLogger(__name__)

DEFAULT_STEMS_URL = "https://bandait-stems.oooglue.workers.dev"
TIMEOUT_S = 20.0
CHUNK = 256 * 1024
MANIFEST_CAP = 64 * 1024


def stems_url() -> str:
    return (os.environ.get("BANDAIT_STEMS_URL") or DEFAULT_STEMS_URL).rstrip("/")


Opener = Callable[[urllib.request.Request, float], object]


def _default_open(req: urllib.request.Request, timeout: float):
    return urllib.request.urlopen(req, timeout=timeout)


class StemsCloud:
    def __init__(self, token: Callable[[], str], base_url: Optional[str] = None, opener: Opener = _default_open):
        self._token = token
        self._base = (base_url or stems_url()).rstrip("/")
        self._open = opener

    def _request(self, path: str):
        req = urllib.request.Request(
            f"{self._base}{path}",
            headers={"Authorization": f"Bearer {self._token()}", "Accept": "*/*"},
            method="GET",
        )
        try:
            return self._open(req, TIMEOUT_S)
        except urllib.error.HTTPError as err:
            try:
                code = json.loads(err.read(4096) or b"{}").get("error", "")
            except (ValueError, AttributeError):
                code = ""
            raise CloudHTTPError(err.code, code, f"HTTP {err.code} {code}".strip()) from None
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as err:
            raise CloudOffline(f"Sin conexión con la nube de stems ({getattr(err, 'reason', err)})") from None

    @staticmethod
    def _song_path(scope: str, song: str) -> str:
        return f"/v1/bands/{urllib.parse.quote(scope, safe='')}/songs/{urllib.parse.quote(song, safe='')}"

    def manifest(self, band_cloud_id: Optional[str], song_cloud_id: str) -> Optional[Tuple[str, dict]]:
        """(scope, manifest) of a hub song, or None when it has no stems in the cloud.
        Tries the shared band first and falls back to the personal workspace ("me")."""
        scopes = [band_cloud_id, "me"] if band_cloud_id else ["me"]
        for scope in scopes:
            try:
                with self._request(f"{self._song_path(scope, song_cloud_id)}/manifest") as resp:
                    data = json.loads(resp.read(MANIFEST_CAP + 1)[:MANIFEST_CAP] or b"{}")
                return scope, data
            except CloudHTTPError as err:
                if err.status == 404:
                    return None
                if err.status in (400, 403) and scope != "me":
                    continue  # not a shared band (or not a member): try the personal workspace
                raise
        return None

    def download(self, scope: str, song_cloud_id: str, manifest: dict, dest: Path,
                 progress: Callable[[int, int], None] = lambda i, n: None) -> list:
        """Download every stem of ``manifest`` into ``dest``; returns the paths. Sizes are checked."""
        stems = manifest.get("stems") or []
        paths = []
        for i, stem in enumerate(stems):
            name = lib.basename(str(stem["file"]))
            target = dest / name
            progress(i, len(stems))
            path = f"{self._song_path(scope, song_cloud_id)}/files/{urllib.parse.quote(name, safe='')}"
            with self._request(path) as resp, open(target, "wb") as out:
                shutil.copyfileobj(resp, out, CHUNK)
            if target.stat().st_size != int(stem.get("size", -1)):
                raise CloudHTTPError(0, "incomplete_download", f"Descarga incompleta de {name}")
            paths.append(str(target))
        progress(len(stems), len(stems))
        return paths


def sync_song(
    cloud: StemsCloud,
    local_song_id: str,
    band_cloud_id: Optional[str],
    song_cloud_id: str,
    root: Optional[Path] = None,
    progress: Callable[[int, int], None] = lambda i, n: None,
    force: bool = False,
) -> str:
    """Bring a song's cloud stems to the local library. Returns "updated", "current",
    "none" (no stems in the cloud; local stems, if any, are kept) or "local" (stems
    imported by hand on this laptop win, unless ``force``)."""
    found = cloud.manifest(band_cloud_id, song_cloud_id)
    if found is None:
        return "none"
    scope, manifest = found
    updated_at = str(manifest.get("updated_at") or "")
    local = lib.load(local_song_id, root)
    if local and local.cloud and local.cloud.get("updated_at") == updated_at and local.cloud.get("song") == song_cloud_id:
        return "current"
    if local and not local.cloud and not force:
        return "local"
    base = root or lib.stems_root()
    base.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="descarga-", dir=str(base)))
    try:
        paths = cloud.download(scope, song_cloud_id, manifest, tmp, progress)
        stem_set = lib.import_stems(local_song_id, paths, root)
        by_file = {lib.basename(str(s.get("file"))): s for s in manifest.get("stems") or []}
        for info in stem_set.stems:
            meta = by_file.get(info.file)
            if meta:
                info.role = str(meta.get("role") or info.role)
                info.label = str(meta.get("label") or info.label)
        stem_set.offset_ms = float(manifest.get("offset_ms") or 0.0)
        stem_set.cloud = {"scope": scope, "song": song_cloud_id, "updated_at": updated_at}
        lib.save(stem_set, root)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return "updated"
