"""Minimal JSON-over-HTTPS client on the standard library (urllib).

Errors are split by what the caller must do about them:

- ``CloudOffline``: no network, DNS failure, timeout, connection reset. Retry
  later; use the local copy meanwhile.
- ``CloudHTTPError``: the server answered with an error status. ``status`` and
  ``error_code`` tell the caller whether the session is dead or the failure is
  temporary.

Nothing here logs URLs, headers or bodies: they can carry tokens or auth codes.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Mapping, Optional, Tuple

DEFAULT_TIMEOUT_S = 15.0
MAX_BODY_BYTES = 32 * 1024 * 1024  # a workspace is far smaller; this caps a runaway reply


class CloudError(Exception):
    """Base class. ``str(err)`` is a Spanish message fit for the UI."""


class CloudOffline(CloudError):
    pass


class CloudHTTPError(CloudError):
    def __init__(self, status: int, error_code: str, message: str):
        super().__init__(message)
        self.status = status
        self.error_code = error_code

    @property
    def temporary(self) -> bool:
        return self.status == 429 or self.status >= 500


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None  # surface 3xx as HTTPError with the Location header


def _error_fields(body: bytes) -> Tuple[str, str]:
    """(error_code, message) from a GoTrue or PostgREST error body."""
    try:
        data = json.loads(body.decode("utf-8", errors="replace") or "null")
    except ValueError:
        return "", ""
    if not isinstance(data, dict):
        return "", ""
    code = data.get("error_code") or data.get("code") or data.get("error") or ""
    message = (
        data.get("error_description")
        or data.get("msg")
        or data.get("message")
        or data.get("error")
        or ""
    )
    return str(code), str(message)


def _read_capped(resp) -> bytes:
    body = resp.read(MAX_BODY_BYTES + 1)
    if len(body) > MAX_BODY_BYTES:
        raise CloudHTTPError(0, "too_large", "La respuesta de la nube es demasiado grande")
    return body


def request(
    method: str,
    url: str,
    *,
    headers: Optional[Mapping[str, str]] = None,
    json_body: object = None,
    timeout: float = DEFAULT_TIMEOUT_S,
    follow_redirects: bool = True,
) -> Tuple[int, Mapping[str, str], bytes]:
    """Send a request; return (status, headers, body) for 2xx (and 3xx when not
    following redirects). Raise CloudOffline / CloudHTTPError otherwise."""
    data = None
    all_headers = {"Accept": "application/json"}
    if headers:
        all_headers.update(headers)
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
        all_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=all_headers, method=method)
    handlers: list = [] if follow_redirects else [_NoRedirect()]
    if urllib.parse.urlsplit(url).hostname in ("127.0.0.1", "localhost", "::1"):
        handlers.append(urllib.request.ProxyHandler({}))  # loopback never goes through a proxy
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers.items()), _read_capped(resp)
    except urllib.error.HTTPError as err:
        status = err.code
        try:
            body = err.read(64 * 1024) or b""
        except Exception:
            body = b""
        if not follow_redirects and 300 <= status < 400:
            return status, dict(err.headers.items()) if err.headers else {}, body
        code, message = _error_fields(body)
        if not message:
            message = f"HTTP {status}"
        raise CloudHTTPError(status, code, message) from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError) as err:
        reason = getattr(err, "reason", err)
        raise CloudOffline(f"Sin conexión con la nube ({reason})") from None


def request_json(method: str, url: str, **kwargs) -> object:
    """Like ``request`` but decodes a JSON body (``None`` for an empty body)."""
    status, _headers, body = request(method, url, **kwargs)
    if not body.strip():
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise CloudHTTPError(status, "bad_json", "La nube respondió algo que no es JSON") from None
