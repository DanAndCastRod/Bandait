"""Google sign-in through Supabase Auth (GoTrue) with PKCE and a loopback redirect.

Flow (RFC 7636 + RFC 8252 section 7.3):

1. A random ``code_verifier`` stays in this process; only its S256 challenge
   travels. The system browser opens ``/auth/v1/authorize?provider=google`` with
   ``redirect_to=http://127.0.0.1:<port>/callback``.
2. A one-shot HTTP server bound to 127.0.0.1 only receives ``?code=...`` (or
   ``?error=...``), answers with a short OLED-black page and stops. It gives up
   after 5 minutes (GoTrue's flow state expires on the same scale).
3. ``POST /auth/v1/token?grant_type=pkce`` exchanges ``auth_code`` and
   ``code_verifier`` for the session.

CSRF / code injection: GoTrue does not pass a client ``state`` through to
``redirect_to`` (its ``state`` goes to Google and back to GoTrue), and adding a
query string to ``redirect_to`` would break exact matching against the Redirect
URLs allow list. Protection comes from PKCE instead: a code injected into the
loopback by anyone else was issued for another challenge and GoTrue rejects it
against our verifier. On top of that the server binds 127.0.0.1 only, checks the
``Host`` header (DNS rebinding), accepts a single result and closes.

Session storage: only the refresh token and the public user fields go to the OS
credential store (Windows Credential Manager through ``keyring``, service
"Bandait Leader"). The access token lives in memory and is refreshed on demand,
``REFRESH_MARGIN_S`` before it expires. Nothing here writes tokens to files or
logs. Refreshes are serialized: GoTrue rotates refresh tokens and treats reuse
of an old one as theft (it revokes the whole session).
"""

from __future__ import annotations

import base64
import hashlib
import html
import http.server
import json
import logging
import secrets
import socket
import socketserver
import threading
import time
import urllib.parse
import webbrowser
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence

from src.cloud.http import DEFAULT_TIMEOUT_S, CloudError, CloudHTTPError, CloudOffline, request, request_json

logger = logging.getLogger(__name__)

SERVICE_NAME = "Bandait Leader"
KEYRING_USERNAME = "supabase_session"
LOOPBACK_HOST = "127.0.0.1"
LOOPBACK_PORTS = (53682, 53683, 53684)
CALLBACK_PATH = "/callback"
LOGIN_TIMEOUT_S = 300.0
REFRESH_MARGIN_S = 120.0
LOGOUT_TIMEOUT_S = 5.0


def redirect_url(port: int) -> str:
    return f"http://{LOOPBACK_HOST}:{int(port)}{CALLBACK_PATH}"


def redirect_urls(ports: Sequence[int] = LOOPBACK_PORTS) -> List[str]:
    """The exact URLs to add in Supabase > Authentication > URL Configuration."""
    return [redirect_url(p) for p in ports]


# --------------------------------------------------------------------------- errors
class AuthError(CloudError):
    pass


class LoginCancelled(AuthError):
    pass


class LoginTimeout(AuthError):
    pass


class LoginRejected(AuthError):
    """Supabase or Google refused the sign-in (message is for the user)."""


class NotSignedIn(AuthError):
    pass


class SessionRevoked(AuthError):
    """The refresh token is no longer valid: the user must sign in again."""


# --------------------------------------------------------------------------- PKCE
def generate_code_verifier(nbytes: int = 48) -> str:
    """43..128 chars of [A-Za-z0-9-_] (RFC 7636 section 4.1). 48 bytes -> 64 chars."""
    verifier = secrets.token_urlsafe(nbytes)
    if not 43 <= len(verifier) <= 128:
        raise ValueError("code_verifier fuera de rango")
    return verifier


def code_challenge_s256(verifier: str) -> str:
    """BASE64URL(SHA256(ASCII(verifier))) without padding (RFC 7636 section 4.2)."""
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


# --------------------------------------------------------------------------- data
@dataclass(frozen=True)
class CloudUser:
    id: str
    email: str = ""
    name: str = ""

    def to_json(self) -> dict:
        return {"id": self.id, "email": self.email, "name": self.name}

    @classmethod
    def from_json(cls, data: object) -> Optional["CloudUser"]:
        if not isinstance(data, dict):
            return None
        uid = data.get("id")
        if not isinstance(uid, str) or not uid.strip():
            return None
        email = data.get("email") if isinstance(data.get("email"), str) else ""
        name = data.get("name") if isinstance(data.get("name"), str) else ""
        return cls(id=uid.strip(), email=email, name=name)


@dataclass(frozen=True)
class TokenSet:
    access_token: str = field(repr=False)
    refresh_token: str = field(repr=False)
    expires_at: float
    user: CloudUser


@dataclass(frozen=True)
class CallbackResult:
    code: Optional[str] = field(default=None, repr=False)
    error: Optional[str] = None
    error_description: Optional[str] = None


def _user_from_gotrue(data: object) -> Optional[CloudUser]:
    if not isinstance(data, dict):
        return None
    uid = data.get("id")
    if not isinstance(uid, str) or not uid:
        return None
    email = data.get("email") if isinstance(data.get("email"), str) else ""
    meta = data.get("user_metadata") if isinstance(data.get("user_metadata"), dict) else {}
    name = ""
    for key in ("full_name", "name"):
        if isinstance(meta.get(key), str) and meta[key].strip():
            name = meta[key].strip()
            break
    return CloudUser(id=uid, email=email or "", name=name)


def parse_token_response(data: object, now: float) -> TokenSet:
    if not isinstance(data, dict):
        raise AuthError("Respuesta de sesión inválida")
    access = data.get("access_token")
    refresh = data.get("refresh_token")
    user = _user_from_gotrue(data.get("user"))
    if not isinstance(access, str) or not access or not isinstance(refresh, str) or not refresh:
        raise AuthError("La respuesta de Supabase no trae los tokens de sesión")
    if user is None:
        raise AuthError("La respuesta de Supabase no trae el usuario")
    expires_at = data.get("expires_at")
    if isinstance(expires_at, (int, float)) and not isinstance(expires_at, bool) and expires_at > now:
        exp = float(expires_at)
    else:
        expires_in = data.get("expires_in")
        if not isinstance(expires_in, (int, float)) or isinstance(expires_in, bool) or expires_in <= 0:
            expires_in = 3600
        exp = now + float(expires_in)
    return TokenSet(access_token=access, refresh_token=refresh, expires_at=exp, user=user)


# --------------------------------------------------------------------------- loopback
_PAGE = """<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bandait</title>
<style>
html,body{{margin:0;height:100%;background:#000000;color:#F0F0F0;
font-family:system-ui,-apple-system,"Segoe UI",sans-serif}}
main{{min-height:100%;display:flex;flex-direction:column;align-items:center;
justify-content:center;padding:24px;box-sizing:border-box;text-align:center}}
h1{{font-size:22px;letter-spacing:.04em;margin:0 0 12px;color:{color}}}
p{{margin:4px 0;color:#A0A0A0;max-width:520px;line-height:1.4}}
</style></head>
<body><main><h1>{title}</h1>{body}</main>{script}</body></html>
"""

# GoTrue sends errors in the query string and, deprecated, in the fragment. The
# fragment never reaches a server, so this forwards only error fields, never tokens.
_FRAGMENT_SCRIPT = """<script>
(function(){var h=location.hash.replace(/^#/,'');if(!h)return;
var p=new URLSearchParams(h);var e=p.get('error');if(!e)return;
var q=new URLSearchParams();q.set('error',e);
var d=p.get('error_description');if(d)q.set('error_description',d);
location.replace('/callback?'+q.toString());})();
</script>"""


def _page(title: str, lines: Sequence[str], ok: bool, script: str = "") -> bytes:
    body = "".join(f"<p>{html.escape(line)}</p>" for line in lines)
    color = "#00FFFF" if ok else "#FF3B3B"
    return _PAGE.format(title=html.escape(title), body=body, color=color, script=script).encode("utf-8")


class _LoopbackHTTPServer(http.server.ThreadingHTTPServer):
    # SO_REUSEADDR on Windows lets a second socket bind a busy port: never.
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        # TCPServer.server_bind, skipping HTTPServer's getfqdn() (slow reverse DNS).
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


class LoopbackReceiver:
    """One-shot OAuth redirect receiver on 127.0.0.1.

    The first ``/callback`` request carrying ``code`` or ``error`` wins; later
    ones get an informational page and change nothing. Other paths (favicon)
    get 404 and do not count.
    """

    def __init__(self, ports: Sequence[int] = LOOPBACK_PORTS, host: str = LOOPBACK_HOST):
        self._lock = threading.Lock()
        self._done = threading.Event()
        self._result: Optional[CallbackResult] = None
        self._httpd = self._bind(host, ports)
        self.port: int = self._httpd.server_address[1]
        self.redirect_uri = redirect_url(self.port)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever, kwargs={"poll_interval": 0.1},
            name="bandait-oauth-loopback", daemon=True,
        )
        self._thread.start()

    def _bind(self, host: str, ports: Sequence[int]) -> _LoopbackHTTPServer:
        handler = self._make_handler()
        last_error: Optional[OSError] = None
        for port in ports:
            try:
                return _LoopbackHTTPServer((host, int(port)), handler)
            except OSError as err:
                last_error = err
        listed = ", ".join(str(p) for p in ports)
        raise AuthError(
            f"Los puertos {listed} de este equipo están ocupados: cierra el programa que los usa "
            f"e intenta de nuevo ({last_error})"
        )

    def _offer(self, result: CallbackResult) -> bool:
        with self._lock:
            if self._result is not None:
                return False
            self._result = result
        self._done.set()
        return True

    def _make_handler(self):
        receiver = self

        class Handler(http.server.BaseHTTPRequestHandler):
            timeout = 10  # a speculative browser connection that never sends a request
            server_version = "Bandait"
            sys_version = ""

            def log_message(self, fmt, *args):  # the request line carries the auth code
                pass

            def _send(self, status: int, body: bytes, script: bool = False):
                self.send_response(status)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                csp = "default-src 'none'; style-src 'unsafe-inline'"
                if script:
                    csp += "; script-src 'unsafe-inline'"
                self.send_header("Content-Security-Policy", csp)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path != CALLBACK_PATH:
                    self._send(404, _page("No encontrado", ["Esta dirección no es de Bandait."], False))
                    return
                port = receiver.port
                if self.headers.get("Host", "") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
                    self._send(400, _page("Solicitud rechazada", ["Origen no válido."], False))
                    return
                query = urllib.parse.parse_qs(parsed.query, keep_blank_values=False)

                def first(name: str) -> Optional[str]:
                    values = query.get(name)
                    return values[0][:4096] if values else None

                code, error = first("code"), first("error")
                if not code and not error:
                    self._send(
                        400,
                        _page("Falta el código", ["La respuesta no trae el código de acceso.",
                                                   "Vuelve a Bandait e intenta de nuevo."], False,
                              _FRAGMENT_SCRIPT),
                        script=True,
                    )
                    return
                result = CallbackResult(
                    code=code if not error else None,
                    error=error,
                    error_description=first("error_description"),
                )
                if not receiver._offer(result):
                    self._send(200, _page("Bandait", ["Esta ventana ya no hace falta: puedes cerrarla."], True))
                elif error:
                    detail = result.error_description or error
                    self._send(200, _page("No se pudo iniciar sesión",
                                          [detail, "Vuelve a Bandait para ver qué hacer."], False))
                else:
                    self._send(200, _page("Sesión iniciada, vuelve a Bandait",
                                          ["Ya puedes cerrar esta pestaña."], True))

            def do_HEAD(self):
                self.do_GET()

            def do_POST(self):
                self._send(405, _page("Método no permitido", [], False))

        return Handler

    def wait(self, timeout: float = LOGIN_TIMEOUT_S, cancel: Optional[threading.Event] = None) -> CallbackResult:
        deadline = time.perf_counter() + timeout  # perf_counter: see src/sync/leader_clock.py
        while True:
            if self._done.wait(0.1):
                with self._lock:
                    assert self._result is not None
                    return self._result
            if cancel is not None and cancel.is_set():
                raise LoginCancelled("Inicio de sesión cancelado")
            if time.perf_counter() >= deadline:
                raise LoginTimeout(
                    "El navegador no volvió a Bandait en 5 minutos. Si terminó en "
                    "bandait.releven.cc/hub, Supabase no aceptó la dirección de retorno "
                    "(ver Cuenta y sincronización en el README)."
                )

    def close(self) -> None:
        try:
            self._httpd.shutdown()
        except Exception:
            pass
        try:
            self._httpd.server_close()
        except Exception:
            pass
        self._thread.join(timeout=2.0)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


# --------------------------------------------------------------------------- GoTrue
_PROVIDER_DISABLED_HINT = (
    "Google no está activado en Supabase (Authentication > Sign In / Providers > Google)."
)


class GoTrueClient:
    """The few Supabase Auth endpoints the leader uses."""

    def __init__(self, base_url: str, api_key: str, timeout: float = DEFAULT_TIMEOUT_S, clock=time.time):
        self.base_url = base_url.rstrip("/")
        self._key = api_key
        self.timeout = timeout
        self._clock = clock

    def _headers(self, bearer: Optional[str] = None) -> dict:
        headers = {"apikey": self._key}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        return headers

    def authorize_url(self, redirect_to: str, code_challenge: str, provider: str = "google") -> str:
        query = urllib.parse.urlencode(
            {
                "provider": provider,
                "redirect_to": redirect_to,
                "code_challenge": code_challenge,
                "code_challenge_method": "s256",
            }
        )
        return f"{self.base_url}/auth/v1/authorize?{query}"

    def preflight(self, authorize_url: str) -> Optional[str]:
        """Ask /authorize without following the redirect. Returns a message when
        sign-in cannot work (provider disabled, bad configuration), None when it
        looks fine or cannot be told. Raises CloudOffline without network."""
        try:
            status, headers, _body = request(
                "GET", authorize_url, headers=self._headers(), timeout=min(self.timeout, 8.0),
                follow_redirects=False,
            )
        except CloudHTTPError as err:
            if "provider is not enabled" in str(err).lower() or "unsupported provider" in str(err).lower():
                return _PROVIDER_DISABLED_HINT
            if err.temporary:
                return None  # let the browser try; GoTrue may be momentarily busy
            return f"Supabase rechazó el inicio de sesión: {err}"
        location = ""
        for key, value in headers.items():
            if key.lower() == "location":
                location = value
        if 300 <= status < 400 and location:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
            if "error" in query:
                detail = (query.get("error_description") or query["error"])[0]
                return f"Supabase rechazó el inicio de sesión: {detail}"
        return None

    def exchange_code(self, code: str, code_verifier: str) -> TokenSet:
        try:
            data = request_json(
                "POST", f"{self.base_url}/auth/v1/token?grant_type=pkce",
                headers=self._headers(), json_body={"auth_code": code, "code_verifier": code_verifier},
                timeout=self.timeout,
            )
        except CloudHTTPError as err:
            if err.temporary:
                raise
            raise LoginRejected(f"Supabase no aceptó el código de acceso: {err}") from None
        return parse_token_response(data, self._clock())

    def refresh(self, refresh_token: str) -> TokenSet:
        try:
            data = request_json(
                "POST", f"{self.base_url}/auth/v1/token?grant_type=refresh_token",
                headers=self._headers(), json_body={"refresh_token": refresh_token},
                timeout=self.timeout,
            )
        except CloudHTTPError as err:
            if err.temporary:
                raise
            raise SessionRevoked(
                f"La sesión de la nube ya no es válida ({err}). Inicia sesión de nuevo."
            ) from None
        return parse_token_response(data, self._clock())

    def logout(self, access_token: str) -> None:
        """Revoke this session only (scope=local): the hub open in a browser keeps
        its own session. Best effort; raises CloudError on failure."""
        request(
            "POST", f"{self.base_url}/auth/v1/logout?scope=local",
            headers=self._headers(access_token), timeout=min(self.timeout, LOGOUT_TIMEOUT_S),
        )


# --------------------------------------------------------------------------- keyring
@dataclass(frozen=True)
class StoredSession:
    refresh_token: str = field(repr=False)
    user: CloudUser
    saved_at: float = 0.0


class SessionStore:
    """The session in the OS credential store. Never raises: a missing or broken
    backend means the session lasts until Bandait closes."""

    def __init__(self, service: str = SERVICE_NAME, username: str = KEYRING_USERNAME):
        self.service = service
        self.username = username
        self.available = True

    def load(self) -> Optional[StoredSession]:
        try:
            import keyring

            raw = keyring.get_password(self.service, self.username)
        except Exception as err:
            self.available = False
            logger.warning("Almacen de credenciales no disponible: %s", type(err).__name__)
            return None
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except ValueError:
            data = None
        user = CloudUser.from_json(data.get("user")) if isinstance(data, dict) else None
        token = data.get("refresh_token") if isinstance(data, dict) else None
        if user is None or not isinstance(token, str) or not token:
            logger.warning("Sesion guardada ilegible: se descarta")
            self.clear()
            return None
        saved_at = data.get("saved_at")
        return StoredSession(
            refresh_token=token, user=user,
            saved_at=float(saved_at) if isinstance(saved_at, (int, float)) else 0.0,
        )

    def save(self, refresh_token: str, user: CloudUser) -> bool:
        payload = json.dumps(
            {"v": 1, "refresh_token": refresh_token, "user": user.to_json(), "saved_at": time.time()},
            ensure_ascii=False,
        )
        try:
            import keyring

            keyring.set_password(self.service, self.username, payload)
        except Exception as err:
            self.available = False
            logger.warning("No se pudo guardar la sesion en el almacen de credenciales: %s", type(err).__name__)
            return False
        self.available = True
        return True

    def clear(self) -> None:
        try:
            import keyring

            keyring.delete_password(self.service, self.username)
        except Exception:
            pass  # nothing stored, or no backend: either way nothing is left


# --------------------------------------------------------------------------- manager
@dataclass(frozen=True)
class RevokeHandle:
    """What sign-out needs to revoke the session on the server, after the local
    state is already gone."""

    access_token: Optional[str] = field(default=None, repr=False)
    expires_at: float = 0.0
    refresh_token: Optional[str] = field(default=None, repr=False)


class AuthManager:
    """Thread-safe session holder.

    Two locks: ``_lock`` guards the fields for microseconds (the Qt thread reads
    ``user`` / ``is_signed_in`` without ever waiting on the network) and
    ``_refresh_lock`` serializes refreshes, which do network I/O. Network calls
    happen only in ``access_token`` (refresh), ``revoke`` and the login flow.
    """

    def __init__(
        self,
        client: GoTrueClient,
        store: Optional[SessionStore] = None,
        clock: Callable[[], float] = time.time,
        refresh_margin: float = REFRESH_MARGIN_S,
    ):
        self.client = client
        self.store = store or SessionStore()
        self._clock = clock
        self._margin = refresh_margin
        self._lock = threading.RLock()
        self._refresh_lock = threading.Lock()
        self._generation = 0  # bumps on login and sign-out
        self._user: Optional[CloudUser] = None
        self._refresh_token: Optional[str] = None
        self._access_token: Optional[str] = None
        self._expires_at = 0.0
        self.persisted = False
        self.last_revoked_message: Optional[str] = None

    @property
    def user(self) -> Optional[CloudUser]:
        with self._lock:
            return self._user

    def is_signed_in(self) -> bool:
        with self._lock:
            return self._refresh_token is not None

    def restore(self) -> Optional[CloudUser]:
        """Load the saved session (no network). Returns the user or None."""
        stored = self.store.load()
        with self._lock:
            if stored is None or self._refresh_token is not None:
                return self._user
            self._generation += 1
            self._user = stored.user
            self._refresh_token = stored.refresh_token
            self._access_token = None
            self._expires_at = 0.0
            self.persisted = True
            return self._user

    def set_tokens(self, tokens: TokenSet) -> bool:
        """Adopt a fresh session (login). Returns whether it was persisted."""
        with self._lock:
            self._generation += 1
            self._user = tokens.user
            self._refresh_token = tokens.refresh_token
            self._access_token = tokens.access_token
            self._expires_at = tokens.expires_at
            self.last_revoked_message = None
        persisted = self.store.save(tokens.refresh_token, tokens.user)
        with self._lock:
            self.persisted = persisted
        return persisted

    def access_token(self, force_refresh: bool = False) -> str:
        """A valid access token, refreshing it when it expires within the margin.

        Raises NotSignedIn, SessionRevoked (state is cleared), CloudOffline or a
        temporary CloudHTTPError (session kept)."""
        with self._refresh_lock:
            with self._lock:
                if self._refresh_token is None:
                    raise NotSignedIn("No hay sesión de la nube")
                if (
                    not force_refresh
                    and self._access_token
                    and self._expires_at - self._margin > self._clock()
                ):
                    return self._access_token
                refresh_token = self._refresh_token
                user_id = self._user.id if self._user else None
                generation = self._generation
            try:
                tokens = self.client.refresh(refresh_token)
            except SessionRevoked as err:
                with self._lock:
                    if self._generation == generation:
                        self._clear_locked()
                        self.last_revoked_message = str(err)
                        cleared = True
                    else:
                        cleared = False
                if cleared:
                    self.store.clear()
                raise
            with self._lock:
                stale = self._generation != generation
                other_account = user_id is not None and tokens.user.id != user_id
                if not stale and other_account:
                    self._clear_locked()
                if not stale and not other_account:
                    self._user = tokens.user
                    self._refresh_token = tokens.refresh_token
                    self._access_token = tokens.access_token
                    self._expires_at = tokens.expires_at
            if stale or other_account:
                # Signed out (or switched) while refreshing: do not keep a live
                # session nobody holds any more.
                self.revoke(RevokeHandle(tokens.access_token, tokens.expires_at, None))
                if other_account and not stale:
                    self.store.clear()
                    raise SessionRevoked("La nube devolvió otra cuenta: inicia sesión de nuevo.")
                raise NotSignedIn("La sesión cambió mientras se renovaba")
            persisted = self.store.save(tokens.refresh_token, tokens.user)
            with self._lock:
                self.persisted = persisted
            return tokens.access_token

    def _clear_locked(self) -> None:
        self._generation += 1
        self._user = None
        self._refresh_token = None
        self._access_token = None
        self._expires_at = 0.0
        self.persisted = False

    def sign_out_local(self) -> RevokeHandle:
        """Forget the session here, immediately (no network)."""
        with self._lock:
            handle = RevokeHandle(self._access_token, self._expires_at, self._refresh_token)
            self._clear_locked()
            self.last_revoked_message = None
        self.store.clear()
        return handle

    def revoke(self, handle: RevokeHandle) -> bool:
        """Best-effort server-side logout of a session already forgotten locally."""
        try:
            token = handle.access_token
            if not token or handle.expires_at - 5 <= self._clock():
                if not handle.refresh_token:
                    return False
                token = self.client.refresh(handle.refresh_token).access_token
            self.client.logout(token)
            return True
        except CloudError as err:
            logger.info("Cierre de sesion remoto no confirmado: %s", type(err).__name__)
            return False


# --------------------------------------------------------------------------- login flow
ProgressFn = Callable[[str, str], None]


class LoginFlow:
    """One sign-in attempt. ``run`` blocks: call it from a worker thread."""

    def __init__(
        self,
        auth: AuthManager,
        *,
        open_browser: Callable[[str], bool] = webbrowser.open,
        ports: Sequence[int] = LOOPBACK_PORTS,
        timeout: float = LOGIN_TIMEOUT_S,
        preflight: bool = True,
    ):
        self.auth = auth
        self._open_browser = open_browser
        self._ports = tuple(ports)
        self._timeout = timeout
        self._preflight = preflight
        self.authorize_url: Optional[str] = None
        self.redirect_uri: Optional[str] = None

    def run(self, cancel: Optional[threading.Event] = None, progress: Optional[ProgressFn] = None) -> CloudUser:
        cancel = cancel or threading.Event()

        def report(stage: str, message: str) -> None:
            if progress is not None:
                try:
                    progress(stage, message)
                except Exception:
                    logger.exception("progress callback failed")

        def check_cancel() -> None:
            if cancel.is_set():
                raise LoginCancelled("Inicio de sesión cancelado")

        client = self.auth.client
        verifier = generate_code_verifier()
        challenge = code_challenge_s256(verifier)
        receiver = LoopbackReceiver(self._ports)
        try:
            self.redirect_uri = receiver.redirect_uri
            self.authorize_url = client.authorize_url(receiver.redirect_uri, challenge)
            if self._preflight:
                report("preflight", "Comprobando la conexión con Supabase...")
                problem = client.preflight(self.authorize_url)
                if problem:
                    raise LoginRejected(problem)
            check_cancel()
            report("browser", "Abriendo el navegador. Elige tu cuenta de Google.")
            try:
                opened = bool(self._open_browser(self.authorize_url))
            except Exception:
                opened = False
            if not opened:
                report("browser_failed", "No se pudo abrir el navegador: usa 'Abrir de nuevo' o copia el enlace.")
            report("waiting", f"Esperando la respuesta del navegador en {receiver.redirect_uri}")
            result = receiver.wait(self._timeout, cancel)
        finally:
            receiver.close()
        if result.error:
            detail = result.error_description or result.error
            raise LoginRejected(f"Google o Supabase rechazaron el inicio de sesión: {detail}")
        if not result.code:
            raise LoginRejected("La respuesta no trae el código de acceso")
        check_cancel()
        report("exchange", "Validando la sesión con Supabase...")
        tokens = client.exchange_code(result.code, verifier)
        self.auth.set_tokens(tokens)
        return tokens.user
