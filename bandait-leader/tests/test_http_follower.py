"""CONTRACT_V3 section 8: the leader serves the follower and /leader-info.json."""

import asyncio
import http.client
import json
import uuid

import pytest

from src.network.http_app import (
    IMMUTABLE,
    LeaderHttpApp,
    resolve_follower_dir,
    safe_relative_path,
)
from src.network.server import BandaitServer
from src.sync.clock_service import ClockService

INFO = {"protocol_version": 3, "hello": "lider"}
LEADER_INFO_KEYS = {"protocol_version", "leader_instance_id", "session_id", "ip", "port",
                    "follower_url", "director_url"}


@pytest.fixture
def bundle(tmp_path):
    root = tmp_path / "app"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<!doctype html><title>Follower</title>", encoding="utf-8")
    (root / "assets" / "index-AbC123.js").write_text("console.log(1)", encoding="utf-8")
    (root / "assets" / "index-AbC123.css").write_text("body{}", encoding="utf-8")
    (root / "manifest.webmanifest").write_text("{}", encoding="utf-8")
    (root / "manifest.json").write_text("{}", encoding="utf-8")
    (root / "icon.svg").write_text("<svg/>", encoding="utf-8")
    (root / "icon-192x192.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (tmp_path / "secret.txt").write_text("SECRETO", encoding="utf-8")
    return root


def asgi(app, path, method="GET", raw_path=None, decoded=None):
    """Call the ASGI app directly. ``decoded`` = what uvicorn would put in scope['path']."""
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    scope = {
        "type": "http",
        "method": method,
        "path": decoded if decoded is not None else path,
        "raw_path": (raw_path if raw_path is not None else path).encode("latin-1"),
        "query_string": b"",
        "headers": [],
    }
    asyncio.run(app(scope, receive, send))
    start = sent[0]
    headers = {k.decode(): v.decode() for k, v in start["headers"]}
    body = b"".join(m.get("body", b"") for m in sent[1:])
    return start["status"], headers, body


def make_app(bundle_dir):
    return LeaderHttpApp(lambda: INFO, lambda: bundle_dir)


def test_index_and_root_are_no_store(bundle):
    app = make_app(bundle)
    for path in ("/", "/index.html"):
        status, headers, body = asgi(app, path)
        assert status == 200
        assert headers["content-type"].startswith("text/html")
        assert headers["cache-control"] == "no-store"
        assert b"Follower" in body


@pytest.mark.parametrize("path,mime", [
    ("/assets/index-AbC123.js", "text/javascript"),
    ("/assets/index-AbC123.css", "text/css"),
    ("/manifest.webmanifest", "application/manifest+json"),
    ("/manifest.json", "application/json"),
    ("/icon.svg", "image/svg+xml"),
    ("/icon-192x192.png", "image/png"),
])
def test_asset_mime_types(bundle, path, mime):
    status, headers, _ = asgi(make_app(bundle), path)
    assert status == 200
    assert headers["content-type"].split(";")[0] == mime
    assert headers["x-content-type-options"] == "nosniff"


def test_hashed_assets_cacheable_others_revalidate(bundle):
    app = make_app(bundle)
    assert asgi(app, "/assets/index-AbC123.js")[1]["cache-control"] == IMMUTABLE
    assert asgi(app, "/manifest.webmanifest")[1]["cache-control"] == "no-cache"


@pytest.mark.parametrize("raw,decoded", [
    ("/../secret.txt", "/../secret.txt"),
    ("/%2e%2e/secret.txt", "/../secret.txt"),
    ("/%2E%2E/%2e%2e/secret.txt", "/../../secret.txt"),
    ("/assets/..%2f..%2fsecret.txt", "/assets/../../secret.txt"),
    ("/%252e%252e/secret.txt", "/%2e%2e/secret.txt"),
    ("/..\\secret.txt", "/..\\secret.txt"),
    ("/assets\\..\\..\\secret.txt", "/assets\\..\\..\\secret.txt"),
    ("/..%5csecret.txt", "/..\\secret.txt"),
    ("/C:/Windows/win.ini", "/C:/Windows/win.ini"),
    ("/.. /secret.txt", "/.. /secret.txt"),
    ("/index.html::$DATA", "/index.html::$DATA"),
])
def test_path_traversal_is_blocked(bundle, raw, decoded):
    status, _headers, body = asgi(make_app(bundle), raw, raw_path=raw, decoded=decoded)
    assert status == 404
    assert b"SECRETO" not in body
    assert safe_relative_path(raw) is None or safe_relative_path(decoded) is None


def test_spa_fallback_only_for_extensionless_paths(bundle):
    app = make_app(bundle)
    status, headers, body = asgi(app, "/stage/live")
    assert status == 200 and b"Follower" in body and headers["cache-control"] == "no-store"
    assert asgi(app, "/assets/missing-123.js")[0] == 404
    assert asgi(app, "/favicon.ico")[0] == 404


def test_missing_bundle_page(tmp_path):
    app = make_app(None)
    status, headers, body = asgi(app, "/")
    text = body.decode("utf-8")
    assert status == 503
    assert headers["content-type"].startswith("text/html") and headers["cache-control"] == "no-store"
    assert "npm run build:landing" in text and "#000000" in text and 'lang="es"' in text
    assert all(ord(ch) < 0x2000 for ch in text)  # no emoji / pictographs
    assert asgi(app, "/assets/x.js")[0] == 404
    assert asgi(app, "/leader-info.json")[0] == 200  # still answers who the leader is


def test_head_and_methods(bundle):
    app = make_app(bundle)
    status, headers, body = asgi(app, "/", method="HEAD")
    assert status == 200 and body == b"" and int(headers["content-length"]) > 0
    assert asgi(app, "/", method="POST")[0] == 405


def test_bundle_resolution_order(tmp_path, monkeypatch, bundle):
    other = tmp_path / "other"
    other.mkdir()
    (other / "index.html").write_text("x", encoding="utf-8")
    monkeypatch.setenv("BANDAIT_FOLLOWER_DIR", str(bundle))
    assert resolve_follower_dir(str(other)) == bundle.resolve()
    monkeypatch.setenv("BANDAIT_FOLLOWER_DIR", str(tmp_path / "missing"))
    assert resolve_follower_dir(str(other)) == other.resolve()  # env missing: config next
    monkeypatch.delenv("BANDAIT_FOLLOWER_DIR")
    import sys

    monkeypatch.setattr("src.network.http_app.REPO_FOLLOWER_DIR", tmp_path / "no-repo")
    assert resolve_follower_dir(None) is None
    frozen = tmp_path / "meipass"
    (frozen / "follower").mkdir(parents=True)
    (frozen / "follower" / "index.html").write_text("x", encoding="utf-8")
    monkeypatch.setattr(sys, "_MEIPASS", str(frozen), raising=False)
    assert resolve_follower_dir(None) == (frozen / "follower").resolve()


def _get(port, path, method="GET"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.putrequest(method, path, skip_host=False, skip_accept_encoding=True)
        conn.endheaders()
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


def test_real_server_serves_follower_and_leader_info(bundle, monkeypatch):
    monkeypatch.setenv("BANDAIT_FOLLOWER_DIR", str(bundle))
    server = BandaitServer(ClockService(), host="127.0.0.1", port=0, session_id="default")
    assert server.start(), server.status_message
    try:
        status, headers, body = _get(server.port, "/")
        assert status == 200 and b"Follower" in body and headers["cache-control"] == "no-store"
        status, headers, _ = _get(server.port, "/assets/index-AbC123.js")
        assert status == 200 and headers["content-type"].startswith("text/javascript")
        status, headers, body = _get(server.port, "/leader-info.json")
        assert status == 200
        assert headers["content-type"] == "application/json"
        assert headers["cache-control"] == "no-store"
        info = json.loads(body)
        assert set(info) == LEADER_INFO_KEYS
        assert info["protocol_version"] == 3 and info["session_id"] == "default"
        uuid.UUID(info["leader_instance_id"])
        assert info["ip"] == "127.0.0.1" and info["port"] == server.port
        assert info["follower_url"] == (
            f"http://127.0.0.1:{server.port}/?ip=127.0.0.1&port={server.port}&session=default&auto=1"
        )
        assert info["director_url"] == info["follower_url"] + "&role=director"
        assert info == server.leader_info()
        # Raw traversal on the wire (http.client sends the path verbatim).
        for raw in ("/../secret.txt", "/%2e%2e/secret.txt", "/..%5csecret.txt"):
            status, _h, body = _get(server.port, raw)
            assert status in (400, 404) and b"SECRETO" not in body
        # Socket.IO is still mounted at /socket.io/.
        status, _h, body = _get(server.port, "/socket.io/?EIO=4&transport=polling")
        assert status == 200 and body.startswith(b"0{")
    finally:
        server.stop()


def test_leader_info_matches_schema():
    jsonschema = pytest.importorskip("jsonschema")
    from referencing import Registry, Resource

    from v3_shapes import FIXTURES_PATH

    schemas = FIXTURES_PATH.parents[1] / "schemas"
    resources = []
    for path in schemas.glob("*.json"):
        contents = json.loads(path.read_text(encoding="utf-8"))
        resources.append((contents.get("$id", path.name), Resource.from_contents(contents)))
    validator = jsonschema.Draft7Validator(
        {"$ref": "message_types.json#/definitions/leader_info"}, registry=Registry().with_resources(resources)
    )
    server = BandaitServer(ClockService(), host="127.0.0.1", port=4040)
    errors = [e.message for e in validator.iter_errors(server.leader_info())]
    assert errors == []
