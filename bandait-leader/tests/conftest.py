"""Test isolation: no test may read or write the user's real files.

Environment overrides are applied at import time (before any ``src`` module
computes a path) and again per test with a fresh tmp folder:

- BANDAIT_HOME / BANDAIT_DB -> tmp (database, recordings, leader config)
- HOME / USERPROFILE        -> tmp (anything still using ``~`` lands in tmp)
- BANDAIT_PORT=0            -> MainWindow binds an ephemeral port
- BANDAIT_AUDIO_DISABLED=1  -> no PortAudio stream is ever opened
- keyring                   -> an in-memory backend (never Windows Credential Manager)
- BANDAIT_SUPABASE_URL      -> a closed loopback port: no test can reach the real
                               Supabase project by accident (cloud tests start
                               their own fake GoTrue/PostgREST server)
"""

import json
import os
import tempfile

import keyring
import keyring.backend
import keyring.errors
import pytest


class MemoryKeyring(keyring.backend.KeyringBackend):
    """In-memory keyring for tests; ``fail`` simulates a broken backend."""

    priority = 1

    def __init__(self):
        super().__init__()
        self.store = {}
        self.fail = False

    def _check(self):
        if self.fail:
            raise keyring.errors.KeyringError("backend roto (simulado)")

    def get_password(self, service, username):
        self._check()
        return self.store.get((service, username))

    def set_password(self, service, username, password):
        self._check()
        self.store[(service, username)] = password

    def delete_password(self, service, username):
        self._check()
        try:
            del self.store[(service, username)]
        except KeyError:
            raise keyring.errors.PasswordDeleteError("no existe") from None


keyring.set_keyring(MemoryKeyring())

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
os.environ["BANDAIT_SUPABASE_URL"] = "http://127.0.0.1:9"
os.environ["BANDAIT_SUPABASE_KEY"] = "sb_publishable_test"
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.makedirs(os.environ["HOME"], exist_ok=True)


@pytest.fixture(autouse=True)
def memory_keyring():
    """A fresh in-memory keyring per test (the real one is never touched)."""
    previous = keyring.get_keyring()
    backend = MemoryKeyring()
    keyring.set_keyring(backend)
    yield backend
    keyring.set_keyring(previous if isinstance(previous, MemoryKeyring) else MemoryKeyring())


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
    monkeypatch.setenv("BANDAIT_SUPABASE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("BANDAIT_SUPABASE_KEY", "sb_publishable_test")
    yield home


# --------------------------------------------------------------------------- fake Supabase
FAKE_USER = {
    "id": "11111111-1111-4111-8111-111111111111",
    "email": "musico@example.com",
    "user_metadata": {"full_name": "Músico de Prueba"},
}


class FakeSupabase:
    """Local stand-in for GoTrue (authorize, token pkce/refresh, logout) and
    PostgREST (bandait_workspaces read). Records every request. Any write to
    /rest/v1 is answered 405 and recorded in ``rest_writes``."""

    api_key = "sb_publishable_test"

    def __init__(self):
        import threading

        self.lock = threading.Lock()
        self.user = dict(FAKE_USER)
        self.provider_enabled = True
        self.authorize_error = None  # (error, description) -> redirect with error
        self.flows = {}  # auth code -> challenge
        self.access = {}  # access token -> (user id, expires_at, refresh token)
        self.refresh_valid = set()
        self.logged_out = []
        self.expires_in = 3600
        self.workspace = None
        self.updated_at = "2026-10-01T12:00:00+00:00"
        self.has_row = True
        self.requests = []
        self.rest_writes = []
        # Optional threading.Event: when set to an Event, workspace reads wait on it
        # before answering. Lets a test prove the UI does not block on the network
        # without relying on wall-clock bounds (flaky on a loaded CI machine).
        self.rest_gate = None
        self.server = None
        self.thread = None

    # ---- helpers for tests
    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def issue(self, user_id=None):
        import secrets
        import time

        with self.lock:
            access = "at-" + secrets.token_hex(16)
            refresh = "rt-" + secrets.token_hex(8)
            self.access[access] = (user_id or self.user["id"], time.time() + self.expires_in, refresh)
            self.refresh_valid.add(refresh)
        return access, refresh

    def expire_access_tokens(self):
        with self.lock:
            self.access = {k: (u, 0.0, r) for k, (u, _e, r) in self.access.items()}

    def revoke_all(self):
        with self.lock:
            self.refresh_valid.clear()
            self.access.clear()

    def token_body(self, access, refresh):
        return {
            "access_token": access, "token_type": "bearer", "expires_in": self.expires_in,
            "refresh_token": refresh, "user": self.user,
        }

    # ---- server
    def start(self):
        import http.server
        import threading

        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, status, payload, headers=None):
                body = json.dumps(payload).encode("utf-8") if payload is not None else b""
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def _body(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    return json.loads(raw or b"null")
                except ValueError:
                    return None

            def _bearer(self):
                import time

                auth = self.headers.get("Authorization", "")
                token = auth[7:] if auth.startswith("Bearer ") else ""
                with fake.lock:
                    entry = fake.access.get(token)
                if entry is None or entry[1] <= time.time():
                    return None, token
                return entry, token

            def _record(self, body=None):
                fake.requests.append((self.command, self.path, dict(self.headers.items()), body))

            def do_GET(self):
                import secrets
                import urllib.parse

                parsed = urllib.parse.urlsplit(self.path)
                query = urllib.parse.parse_qs(parsed.query)
                self._record()
                if parsed.path == "/auth/v1/authorize":
                    if not fake.provider_enabled:
                        return self._json(400, {"code": 400, "error_code": "validation_failed",
                                                "msg": "Unsupported provider: provider is not enabled"})
                    redirect_to = query["redirect_to"][0]
                    if query.get("code_challenge_method", [""])[0].lower() != "s256":
                        return self._json(400, {"msg": "bad method"})
                    if fake.authorize_error:
                        error, desc = fake.authorize_error
                        location = redirect_to + "?" + urllib.parse.urlencode(
                            {"error": error, "error_description": desc})
                    else:
                        code = secrets.token_hex(8)
                        with fake.lock:
                            fake.flows[code] = query["code_challenge"][0]
                        location = f"{redirect_to}?code={code}"
                    self.send_response(302)
                    self.send_header("Location", location)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if parsed.path == "/rest/v1/bandait_workspaces":
                    gate = fake.rest_gate
                    if gate is not None:
                        gate.wait(60)
                    if self.headers.get("apikey") != fake.api_key:
                        return self._json(401, {"message": "No API key found in request"})
                    entry, _token = self._bearer()
                    if entry is None:
                        return self._json(401, {"code": "PGRST301", "message": "JWT expired"})
                    wanted = query.get("user_id", [""])[0]
                    if query.get("select", [""])[0] != "workspace,updated_at":
                        return self._json(400, {"message": "bad select"})
                    if wanted != f"eq.{entry[0]}" or not fake.has_row:
                        return self._json(200, [])  # RLS: only the caller's own row
                    return self._json(200, [{"workspace": fake.workspace, "updated_at": fake.updated_at}])
                return self._json(404, {"message": "not found"})

            def do_POST(self):
                import base64
                import hashlib
                import urllib.parse

                parsed = urllib.parse.urlsplit(self.path)
                query = urllib.parse.parse_qs(parsed.query)
                body = self._body()
                self._record(body)
                if parsed.path.startswith("/rest/v1/"):
                    fake.rest_writes.append((self.command, self.path))
                    return self._json(405, {"message": "read only fake"})
                if self.headers.get("apikey") != fake.api_key:
                    return self._json(401, {"message": "No API key found in request"})
                if parsed.path == "/auth/v1/token":
                    grant = query.get("grant_type", [""])[0]
                    if grant == "pkce":
                        code = (body or {}).get("auth_code")
                        verifier = (body or {}).get("code_verifier") or ""
                        with fake.lock:
                            challenge = fake.flows.pop(code, None)
                        if challenge is None:
                            return self._json(404, {"code": 404, "error_code": "flow_state_not_found",
                                                    "msg": "invalid flow state, no valid flow state found"})
                        digest = hashlib.sha256(verifier.encode("ascii")).digest()
                        if base64.urlsafe_b64encode(digest).rstrip(b"=").decode() != challenge:
                            return self._json(400, {"code": 400, "error_code": "bad_code_verifier",
                                                    "msg": "code challenge does not match previously saved code verifier"})
                        return self._json(200, fake.token_body(*fake.issue()))
                    if grant == "refresh_token":
                        token = (body or {}).get("refresh_token")
                        with fake.lock:
                            valid = token in fake.refresh_valid
                            fake.refresh_valid.discard(token)
                        if not valid:
                            return self._json(400, {"code": 400, "error_code": "refresh_token_not_found",
                                                    "msg": "Invalid Refresh Token: Refresh Token Not Found"})
                        return self._json(200, fake.token_body(*fake.issue()))
                    return self._json(400, {"msg": "unsupported_grant_type"})
                if parsed.path == "/auth/v1/logout":
                    entry, token = self._bearer()
                    if entry is None:
                        return self._json(401, {"msg": "invalid JWT"})
                    with fake.lock:
                        fake.refresh_valid.discard(entry[2])
                        fake.access.pop(token, None)
                        fake.logged_out.append(query.get("scope", [""])[0])
                    self.send_response(204)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                return self._json(404, {"message": "not found"})

            def do_PATCH(self):
                self.do_POST()

            def do_PUT(self):
                self.do_POST()

            def do_DELETE(self):
                self.do_POST()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                                       daemon=True)
        self.thread.start()
        return self

    def stop(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            self.server = None


@pytest.fixture
def fake_supabase(monkeypatch):
    fake = FakeSupabase().start()
    monkeypatch.setenv("BANDAIT_SUPABASE_URL", fake.url)
    monkeypatch.setenv("BANDAIT_SUPABASE_KEY", fake.api_key)
    try:
        yield fake
    finally:
        fake.stop()


@pytest.fixture
def fake_browser():
    """webbrowser.open stand-in: follows the authorize redirect to the loopback
    in a background thread, like a real browser would, and returns at once."""
    import threading
    import urllib.request

    visits = []
    threads = []

    def open_url(url):
        visits.append(url)

        def go():
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            try:
                with opener.open(url, timeout=10) as resp:
                    visits.append(("final", resp.status, resp.read().decode("utf-8", "replace")))
            except Exception as err:  # the test asserts on what the leader saw
                visits.append(("error", repr(err)))

        thread = threading.Thread(target=go, daemon=True)
        threads.append(thread)
        thread.start()
        return True

    open_url.visits = visits
    yield open_url
    for thread in threads:
        thread.join(timeout=5)


def pytest_sessionfinish(session, exitstatus):
    """Fail loudly if anything touched the user's real database."""
    if _stat(_REAL_DB) != _REAL_DB_BEFORE:
        session.exitstatus = 1
        print(f"\nERROR: la suite modifico la base real del usuario: {_REAL_DB}")
