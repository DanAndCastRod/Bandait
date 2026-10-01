"""HTTP side of the leader (CONTRACT_V3 section 8), on the same port as Socket.IO.

- ``GET /leader-info.json``: who the leader is and the follower links.
- ``GET /`` and static files: the follower bundle (``landing/app``) so phones on
  the stage LAN load it over plain HTTP from the leader itself.
- Unknown extension-less paths fall back to index.html (SPA routes); unknown
  file paths are 404. Path traversal is rejected before touching the disk.
- If the bundle is missing, a short Spanish page explains how to build it.

This is a plain ASGI app mounted as ``other_asgi_app`` of socketio.ASGIApp, so
``/socket.io/`` is untouched. File reads run in a worker thread and are cached
by (mtime, size) so serving phones never stalls ``sync_request`` handling.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path, PurePosixPath
from typing import Callable, Dict, Optional, Tuple
from urllib.parse import unquote

LEADER_ROOT = Path(__file__).resolve().parents[2]  # bandait-leader/
REPO_FOLLOWER_DIR = LEADER_ROOT.parent / "landing" / "app"

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
}

NO_STORE = "no-store"
REVALIDATE = "no-cache"
IMMUTABLE = "public, max-age=31536000, immutable"

MISSING_BUNDLE_HTML = """<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bandait - follower no compilado</title>
<style>
body{margin:0;background:#000000;color:#F0F0F0;font-family:system-ui,sans-serif;
padding:24px;line-height:1.5}
h1{color:#FFAA00;font-size:22px}code{background:#141414;color:#00FFFF;padding:2px 6px}
</style></head><body>
<h1>El lider esta activo, pero falta la app del musico</h1>
<p>Este lider Bandait no encontro el follower compilado, asi que no puede servirlo
a los telefonos.</p>
<p>En la laptop del lider, desde la raiz del repositorio, ejecute
<code>npm run build:landing</code> y recargue esta pagina.</p>
<p>Tambien puede indicar otra carpeta con la variable <code>BANDAIT_FOLLOWER_DIR</code>.</p>
</body></html>
"""


def frozen_follower_dir() -> Optional[Path]:
    base = getattr(sys, "_MEIPASS", None)
    return Path(base) / "follower" if base else None


def resolve_follower_dir(config_dir: Optional[str] = None) -> Optional[Path]:
    """First existing bundle (with index.html) in this order:
    BANDAIT_FOLLOWER_DIR, leader config, repo landing/app, PyInstaller bundle."""
    candidates = []
    env = os.environ.get("BANDAIT_FOLLOWER_DIR", "").strip()
    if env:
        candidates.append(Path(env))
    if config_dir:
        candidates.append(Path(config_dir))
    candidates.append(REPO_FOLLOWER_DIR)
    frozen = frozen_follower_dir()
    if frozen is not None:
        candidates.append(frozen)
    for c in candidates:
        try:
            if (c / "index.html").is_file():
                return c.resolve()
        except OSError:
            continue
    return None


def safe_relative_path(path: str) -> Optional[PurePosixPath]:
    """Relative POSIX path inside the bundle, or None if the request path is
    unsafe (traversal, backslashes, drive letters, NUL, encoded tricks)."""
    if not path.startswith("/"):
        return None
    decoded = path
    # Decode repeatedly so %252e%252e or mixed encodings cannot smuggle "..".
    for _ in range(3):
        nxt = unquote(decoded)
        if nxt == decoded:
            break
        decoded = nxt
    if "\\" in decoded or "\x00" in decoded:
        return None
    parts = []
    for seg in decoded.split("/"):
        if seg in ("", "."):
            continue
        # "..", "...", ".. " (Windows strips trailing dots/spaces), dotfiles,
        # drive letters / alternate data streams and 8.3 short names.
        if seg.startswith(".") or ":" in seg or "~" in seg or seg != seg.rstrip(". "):
            return None
        parts.append(seg)
    return PurePosixPath(*parts) if parts else PurePosixPath("index.html")


class LeaderHttpApp:
    """ASGI app for everything that is not ``/socket.io/``."""

    def __init__(
        self,
        info_provider: Callable[[], dict],
        bundle_dir_provider: Callable[[], Optional[Path]] = resolve_follower_dir,
    ) -> None:
        self._info = info_provider
        self._bundle_dir = bundle_dir_provider
        self._cache: Dict[Path, Tuple[int, int, bytes]] = {}

    async def __call__(self, scope, receive, send) -> None:
        kind = scope.get("type")
        if kind == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if kind == "websocket":
            await send({"type": "websocket.close", "code": 1000})
            return
        if kind != "http":
            return
        method = scope.get("method", "GET")
        if method not in ("GET", "HEAD"):
            await self._respond(send, 405, b"Metodo no permitido\n", "text/plain; charset=utf-8",
                                NO_STORE, head=False, extra=[(b"allow", b"GET, HEAD")])
            return
        head = method == "HEAD"
        raw = scope.get("raw_path")
        path = raw.decode("latin-1") if isinstance(raw, (bytes, bytearray)) and raw else scope.get("path", "/")
        path = path.split("?", 1)[0]
        try:
            await self._route(send, path, scope.get("path", path), head)
        except Exception:
            await self._respond(send, 500, b"Error interno\n", "text/plain; charset=utf-8", NO_STORE, head)

    async def _route(self, send, raw_path: str, decoded_path: str, head: bool) -> None:
        if decoded_path == "/leader-info.json":
            body = json.dumps(self._info(), ensure_ascii=False).encode("utf-8")
            await self._respond(send, 200, body, "application/json", NO_STORE, head,
                                extra=[(b"access-control-allow-origin", b"*")])
            return
        rel = safe_relative_path(raw_path)
        # The server may already have decoded the path: check that form too.
        if rel is None or safe_relative_path(decoded_path) is None:
            await self._respond(send, 404, b"No encontrado\n", "text/plain; charset=utf-8", NO_STORE, head)
            return
        bundle = self._bundle_dir()
        has_extension = "." in rel.name
        if bundle is None:
            if not has_extension or rel.name == "index.html":
                await self._respond(send, 503, MISSING_BUNDLE_HTML.encode("utf-8"),
                                    MIME_TYPES[".html"], NO_STORE, head)
            else:
                await self._respond(send, 404, b"No encontrado\n", "text/plain; charset=utf-8", NO_STORE, head)
            return
        target = (bundle / Path(*rel.parts)).resolve()
        try:
            target.relative_to(bundle)
        except ValueError:
            await self._respond(send, 404, b"No encontrado\n", "text/plain; charset=utf-8", NO_STORE, head)
            return
        if not target.is_file():
            if has_extension:
                await self._respond(send, 404, b"No encontrado\n", "text/plain; charset=utf-8", NO_STORE, head)
                return
            target = bundle / "index.html"  # SPA route
        body = await self._read(target)
        if body is None:
            await self._respond(send, 404, b"No encontrado\n", "text/plain; charset=utf-8", NO_STORE, head)
            return
        suffix = target.suffix.lower()
        mime = MIME_TYPES.get(suffix, "application/octet-stream")
        await self._respond(send, 200, body, mime, self._cache_policy(bundle, target), head)

    @staticmethod
    def _cache_policy(bundle: Path, target: Path) -> str:
        if target.name == "index.html":
            return NO_STORE
        try:
            rel = target.relative_to(bundle)
        except ValueError:
            return NO_STORE
        if rel.parts and rel.parts[0] == "assets":
            return IMMUTABLE  # Vite content-hashed file names
        return REVALIDATE

    async def _read(self, target: Path) -> Optional[bytes]:
        try:
            st = target.stat()
        except OSError:
            return None
        hit = self._cache.get(target)
        if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
            return hit[2]
        try:
            data = await asyncio.to_thread(target.read_bytes)
        except OSError:
            return None
        self._cache[target] = (st.st_mtime_ns, st.st_size, data)
        return data

    @staticmethod
    async def _respond(send, status: int, body: bytes, content_type: str, cache: str,
                       head: bool, extra=None) -> None:
        headers = [
            (b"content-type", content_type.encode("latin-1")),
            (b"content-length", str(len(body)).encode("latin-1")),
            (b"cache-control", cache.encode("latin-1")),
            (b"x-content-type-options", b"nosniff"),
        ]
        if extra:
            headers.extend(extra)
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": b"" if head else body})
