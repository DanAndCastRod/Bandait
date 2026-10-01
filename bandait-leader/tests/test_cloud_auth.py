"""Supabase Auth for the leader: PKCE, loopback receiver, GoTrue calls, keyring
session, refresh and revocation. Everything runs against local fakes."""

import os
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import pytest

from src.cloud import auth as cloud_auth
from src.cloud.auth import (
    SERVICE_NAME,
    KEYRING_USERNAME,
    AuthError,
    AuthManager,
    CallbackResult,
    GoTrueClient,
    LoginCancelled,
    LoginFlow,
    LoginRejected,
    LoginTimeout,
    LoopbackReceiver,
    NotSignedIn,
    SessionRevoked,
    SessionStore,
    code_challenge_s256,
    generate_code_verifier,
    redirect_urls,
)
from src.cloud.http import CloudOffline


def _get(url, host=None, timeout=5):
    req = urllib.request.Request(url)
    if host:
        req.add_header("Host", host)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8"), dict(resp.headers.items())
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8"), dict(err.headers.items())


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# --------------------------------------------------------------------------- PKCE
def test_pkce_s256_matches_rfc7636_appendix_b():
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assert code_challenge_s256(verifier) == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def test_code_verifier_is_long_random_and_url_safe():
    a, b = generate_code_verifier(), generate_code_verifier()
    assert a != b
    for v in (a, b):
        assert 43 <= len(v) <= 128
        assert set(v) <= set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")


def test_authorize_url_carries_pkce_and_exact_loopback_redirect():
    client = GoTrueClient("https://example.supabase.co/", "sb_publishable_x")
    url = client.authorize_url("http://127.0.0.1:53682/callback", "chal")
    parsed = urllib.parse.urlsplit(url)
    q = urllib.parse.parse_qs(parsed.query)
    assert parsed.netloc == "example.supabase.co" and parsed.path == "/auth/v1/authorize"
    assert q == {
        "provider": ["google"],
        "redirect_to": ["http://127.0.0.1:53682/callback"],
        "code_challenge": ["chal"],
        "code_challenge_method": ["s256"],
    }
    assert redirect_urls() == [
        "http://127.0.0.1:53682/callback",
        "http://127.0.0.1:53683/callback",
        "http://127.0.0.1:53684/callback",
    ]


# --------------------------------------------------------------------------- loopback
def test_loopback_receives_a_code_once_and_serves_the_oled_page():
    with LoopbackReceiver(ports=(0,)) as rx:
        assert rx.redirect_uri == f"http://127.0.0.1:{rx.port}/callback"
        # favicon and other paths do not consume the one-shot result
        assert _get(f"http://127.0.0.1:{rx.port}/favicon.ico")[0] == 404
        status, body, headers = _get(f"{rx.redirect_uri}?code=abc123")
        assert status == 200
        assert "Sesión iniciada, vuelve a Bandait" in body
        assert "#000000" in body and 'lang="es"' in body
        assert headers.get("Cache-Control") == "no-store"
        result = rx.wait(timeout=2)
        assert result.code == "abc123" and result.error is None
        # a second callback changes nothing
        status, body, _ = _get(f"{rx.redirect_uri}?code=other")
        assert status == 200 and "ya no hace falta" in body
        assert rx.wait(timeout=1).code == "abc123"


def test_loopback_receives_an_error_from_supabase():
    with LoopbackReceiver(ports=(0,)) as rx:
        query = urllib.parse.urlencode({"error": "access_denied", "error_description": "El usuario canceló <x>"})
        status, body, _ = _get(f"{rx.redirect_uri}?{query}")
        assert status == 200
        assert "No se pudo iniciar sesión" in body
        assert "&lt;x&gt;" in body  # escaped, never raw HTML from the query
        result = rx.wait(timeout=2)
        assert result == CallbackResult(code=None, error="access_denied", error_description="El usuario canceló <x>")


def test_loopback_without_code_keeps_waiting_and_forwards_fragment_errors():
    with LoopbackReceiver(ports=(0,)) as rx:
        status, body, headers = _get(rx.redirect_uri)
        assert status == 400 and "location.hash" in body
        assert "script-src 'unsafe-inline'" in headers.get("Content-Security-Policy", "")
        with pytest.raises(LoginTimeout):
            rx.wait(timeout=0.3)


def test_loopback_rejects_foreign_host_header_dns_rebinding():
    with LoopbackReceiver(ports=(0,)) as rx:
        status, _body, _ = _get(f"{rx.redirect_uri}?code=evil", host="attacker.example:80")
        assert status == 400
        with pytest.raises(LoginTimeout):
            rx.wait(timeout=0.3)


def test_loopback_falls_back_to_the_next_port_when_busy():
    busy = socket.socket()
    busy.bind(("127.0.0.1", 0))
    busy.listen(1)
    taken = busy.getsockname()[1]
    free = _free_port()
    try:
        with LoopbackReceiver(ports=(taken, free)) as rx:
            assert rx.port == free
        with pytest.raises(AuthError, match="ocupados"):
            LoopbackReceiver(ports=(taken,))
    finally:
        busy.close()


def test_loopback_binds_only_loopback_and_honors_cancel():
    with LoopbackReceiver(ports=(0,)) as rx:
        assert rx._httpd.server_address[0] == "127.0.0.1"
        cancel = threading.Event()
        threading.Timer(0.2, cancel.set).start()
        start = time.monotonic()
        with pytest.raises(LoginCancelled):
            rx.wait(timeout=30, cancel=cancel)
        assert time.monotonic() - start < 5


def test_loopback_server_is_closed_after_use():
    rx = LoopbackReceiver(ports=(0,))
    port = rx.port
    rx.close()
    with pytest.raises(OSError):
        socket.create_connection(("127.0.0.1", port), timeout=1).close()


# --------------------------------------------------------------------------- GoTrue
def _pkce_code(fake, verifier):
    """Simulate the browser leg: authorize with the challenge, take the code."""
    client = GoTrueClient(fake.url, fake.api_key)
    url = client.authorize_url("http://127.0.0.1:1/callback", code_challenge_s256(verifier))
    status, headers, _ = cloud_auth.request("GET", url, follow_redirects=False)
    assert status == 302
    location = next(v for k, v in headers.items() if k.lower() == "location")
    return urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)["code"][0]


def test_exchange_refresh_and_logout_against_fake_gotrue(fake_supabase):
    client = GoTrueClient(fake_supabase.url, fake_supabase.api_key)
    verifier = generate_code_verifier()
    code = _pkce_code(fake_supabase, verifier)
    tokens = client.exchange_code(code, verifier)
    assert tokens.user.id == fake_supabase.user["id"]
    assert tokens.user.email == "musico@example.com" and tokens.user.name == "Músico de Prueba"
    assert tokens.expires_at > time.time() + 3000
    assert "at-" not in repr(tokens) and "rt-" not in repr(tokens)  # tokens never in repr/logs

    # the same code cannot be used twice, and a wrong verifier is refused
    with pytest.raises(LoginRejected):
        client.exchange_code(code, verifier)
    code2 = _pkce_code(fake_supabase, verifier)
    with pytest.raises(LoginRejected, match="no aceptó"):
        client.exchange_code(code2, generate_code_verifier())

    refreshed = client.refresh(tokens.refresh_token)
    assert refreshed.refresh_token != tokens.refresh_token
    with pytest.raises(SessionRevoked):
        client.refresh(tokens.refresh_token)  # rotated: the old one is dead

    client.logout(refreshed.access_token)
    assert fake_supabase.logged_out == ["local"]  # only this device, never the hub's session
    with pytest.raises(SessionRevoked):
        client.refresh(refreshed.refresh_token)

    sent = [r for r in fake_supabase.requests if r[0] == "POST"]
    assert sent and all({k.lower(): v for k, v in r[2].items()}.get("apikey") == fake_supabase.api_key
                        for r in sent)
    assert fake_supabase.rest_writes == []


def test_preflight_reports_disabled_provider_and_offline(fake_supabase):
    client = GoTrueClient(fake_supabase.url, fake_supabase.api_key)
    url = client.authorize_url("http://127.0.0.1:1/callback", "x" * 43)
    assert client.preflight(url) is None
    fake_supabase.provider_enabled = False
    assert "Google no está activado" in client.preflight(url)
    offline = GoTrueClient(f"http://127.0.0.1:{_free_port()}", "k")
    with pytest.raises(CloudOffline):
        offline.preflight(offline.authorize_url("http://127.0.0.1:1/callback", "x" * 43))


# --------------------------------------------------------------------------- keyring
def test_session_store_uses_keyring_service_and_never_files(memory_keyring, isolated_user_dirs):
    store = SessionStore()
    user = cloud_auth.CloudUser(id="u1", email="a@b.c", name="A")
    assert store.save("rt-secret-value", user)
    raw = memory_keyring.store[(SERVICE_NAME, KEYRING_USERNAME)]
    assert SERVICE_NAME == "Bandait Leader" and "rt-secret-value" in raw
    loaded = store.load()
    assert loaded.refresh_token == "rt-secret-value" and loaded.user == user
    assert "rt-secret-value" not in repr(loaded)
    for root, _dirs, files in os.walk(isolated_user_dirs):
        for name in files:
            with open(os.path.join(root, name), "rb") as fh:
                assert b"rt-secret-value" not in fh.read()
    store.clear()
    assert store.load() is None
    store.clear()  # idempotent


def test_session_store_survives_a_broken_or_corrupt_keyring(memory_keyring):
    store = SessionStore()
    memory_keyring.store[(SERVICE_NAME, KEYRING_USERNAME)] = "{not json"
    assert store.load() is None
    assert (SERVICE_NAME, KEYRING_USERNAME) not in memory_keyring.store  # discarded
    memory_keyring.fail = True
    assert store.load() is None
    assert store.save("rt", cloud_auth.CloudUser(id="u")) is False
    store.clear()  # never raises


# --------------------------------------------------------------------------- manager
def _signed_in_manager(fake, clock=time.time):
    access, refresh = fake.issue()
    manager = AuthManager(GoTrueClient(fake.url, fake.api_key, clock=clock), SessionStore(), clock=clock)
    tokens = cloud_auth.parse_token_response(fake.token_body(access, refresh), clock())
    assert manager.set_tokens(tokens)
    return manager, tokens


def test_access_token_is_refreshed_before_expiry(fake_supabase):
    now = [time.time()]
    manager, tokens = _signed_in_manager(fake_supabase, clock=lambda: now[0])
    assert manager.access_token() == tokens.access_token  # still valid: no network
    refreshes = lambda: sum(1 for r in fake_supabase.requests if "grant_type=refresh_token" in r[1])  # noqa: E731
    assert refreshes() == 0
    now[0] = tokens.expires_at - 60  # inside the 120 s margin
    fresh = manager.access_token()
    assert fresh != tokens.access_token and refreshes() == 1
    stored = SessionStore().load()
    assert stored.refresh_token != tokens.refresh_token  # rotated token persisted at once


def test_restore_then_refresh_on_first_use(fake_supabase):
    manager, tokens = _signed_in_manager(fake_supabase)
    other = AuthManager(GoTrueClient(fake_supabase.url, fake_supabase.api_key), SessionStore())
    user = other.restore()
    assert user.id == tokens.user.id and other.is_signed_in()
    assert other.access_token().startswith("at-")  # restored sessions refresh before use


def test_revoked_session_goes_back_to_signed_out(fake_supabase, memory_keyring):
    manager, _tokens = _signed_in_manager(fake_supabase)
    fake_supabase.revoke_all()
    with pytest.raises(SessionRevoked):
        manager.access_token(force_refresh=True)
    assert not manager.is_signed_in() and manager.user is None
    assert "Inicia sesión de nuevo" in manager.last_revoked_message
    assert memory_keyring.store == {}
    with pytest.raises(NotSignedIn):
        manager.access_token()


def test_offline_refresh_keeps_the_session(fake_supabase):
    manager, tokens = _signed_in_manager(fake_supabase)
    fake_supabase.stop()
    with pytest.raises(CloudOffline):
        manager.access_token(force_refresh=True)
    assert manager.is_signed_in() and SessionStore().load() is not None


def test_concurrent_refreshes_are_serialized(fake_supabase):
    """Rotation: two parallel refreshes with the same token would revoke the session."""
    manager, _ = _signed_in_manager(fake_supabase)
    fake_supabase.expire_access_tokens()
    manager._expires_at = 0
    errors = []

    def worker():
        try:
            manager.access_token()
        except Exception as err:
            errors.append(err)

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert errors == []
    assert sum(1 for r in fake_supabase.requests if "grant_type=refresh_token" in r[1]) == 1


def test_sign_out_is_local_first_then_revokes_remotely(fake_supabase, memory_keyring):
    manager, tokens = _signed_in_manager(fake_supabase)
    handle = manager.sign_out_local()
    assert not manager.is_signed_in() and memory_keyring.store == {}
    assert manager.revoke(handle) is True
    assert fake_supabase.logged_out == ["local"]
    # revoking offline is best effort and never raises
    fake_supabase.stop()
    assert manager.revoke(handle) is False


# --------------------------------------------------------------------------- full flow
def test_login_flow_end_to_end_with_fake_browser(fake_supabase, fake_browser, memory_keyring):
    manager = AuthManager(GoTrueClient(fake_supabase.url, fake_supabase.api_key), SessionStore())
    stages = []
    flow = LoginFlow(manager, open_browser=fake_browser, ports=(0,), timeout=10)
    user = flow.run(progress=lambda stage, msg: stages.append(stage))
    assert user.email == "musico@example.com"
    assert manager.is_signed_in() and (SERVICE_NAME, KEYRING_USERNAME) in memory_keyring.store
    assert [s for s in stages if s in ("preflight", "browser", "waiting", "exchange")] == [
        "preflight", "browser", "waiting", "exchange"]
    final = [v for v in fake_browser.visits if isinstance(v, tuple) and v[0] == "final"]
    assert final and "Sesión iniciada, vuelve a Bandait" in final[0][2]
    # the verifier never left the process: only the challenge did
    authorize = fake_browser.visits[0]
    assert "code_challenge=" in authorize and "code_verifier" not in authorize


def test_login_flow_reports_provider_error(fake_supabase, fake_browser):
    fake_supabase.authorize_error = ("access_denied", "El usuario canceló")
    manager = AuthManager(GoTrueClient(fake_supabase.url, fake_supabase.api_key), SessionStore())
    with pytest.raises(LoginRejected, match="El usuario canceló"):
        LoginFlow(manager, open_browser=fake_browser, ports=(0,), timeout=10).run()
    assert not manager.is_signed_in()


def test_login_flow_offline_fails_fast_without_opening_the_browser(fake_browser):
    manager = AuthManager(GoTrueClient(f"http://127.0.0.1:{_free_port()}", "k"), SessionStore())
    start = time.monotonic()
    with pytest.raises(CloudOffline):
        LoginFlow(manager, open_browser=fake_browser, ports=(0,), timeout=10).run()
    assert fake_browser.visits == [] and time.monotonic() - start < 8


def test_login_flow_can_be_cancelled(fake_supabase):
    manager = AuthManager(GoTrueClient(fake_supabase.url, fake_supabase.api_key), SessionStore())
    cancel = threading.Event()
    flow = LoginFlow(manager, open_browser=lambda url: True, ports=(0,), timeout=30)
    threading.Timer(0.3, cancel.set).start()
    with pytest.raises(LoginCancelled):
        flow.run(cancel)
    assert not manager.is_signed_in()
