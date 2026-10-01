"""
Bandait DAW — Punto de entrada principal
Líder de sesión profesional para ensayos y eventos en vivo.

    python -m src.main                                  # GUI
    python -m src.main --smoke-test                     # chequeo sin GUI: JSON, codigo 0/1
    BandaitLeader.exe --smoke-test --smoke-out r.json   # idem desde el exe empaquetado

The startup order matters:
1. std streams. A windowed exe (PyInstaller --windowed, pythonw) starts with
   sys.stdout/sys.stderr = None, and uvicorn's logging setup calls
   sys.stdout.isatty(): without a stand-in stream the network server never
   starts and the musicians' phones cannot connect.
2. Logging to bandait_home()/logs (a windowed exe has no console) and
   faulthandler for native crashes (ASIO drivers, PortAudio).
3. PortAudio/ASIO choice, before anything imports sounddevice
   (src/audio/portaudio_setup.py).
4. Real-time policy: GIL switch interval, 1 ms timer, GC freeze
   (src/audio/rt_policy.py).
"""

import argparse
import json
import logging
import logging.handlers
import os
import re
import sys
import threading
import time

# Asegurar que la raíz de bandait-leader está en el path (imports "src.*")
LEADER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, LEADER_ROOT)

APP_USER_MODEL_ID = "Bandait.Leader"  # same as the installer's shortcuts
LOG_FILE_NAME = "bandait-leader.log"
CRASH_FILE_NAME = "bandait-leader-crash.log"
_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"

logger = logging.getLogger("bandait")
_crash_file = None  # kept open for faulthandler


# ---------------------------------------------------------------------- process setup
def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False)) and hasattr(sys, "_MEIPASS")


def resource_path(*parts: str) -> str:
    """bandait-leader/resources in the repo, sys._MEIPASS/resources in the exe."""
    base = sys._MEIPASS if is_frozen() else LEADER_ROOT
    return os.path.join(base, "resources", *parts)


def ensure_std_streams() -> bool:
    """Replace a missing stdout/stderr (windowed exe) with os.devnull."""
    replaced = False
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            try:
                setattr(sys, name, open(os.devnull, "w", encoding="utf-8", errors="replace"))
                replaced = True
            except OSError:
                pass
    return replaced


def logs_dir() -> str:
    from src.core.paths import bandait_home

    return str(bandait_home() / "logs")


def setup_logging(to_file: bool = True, level: int = logging.INFO):
    """Console (if any) plus a rotating file. Returns the log file path or None."""
    root = logging.getLogger()
    root.setLevel(level)
    fmt = logging.Formatter(_LOG_FORMAT)
    if not any(getattr(h, "_bandait", False) for h in root.handlers):
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(fmt)
        stream._bandait = True
        root.addHandler(stream)
    if not to_file:
        return None
    try:
        directory = logs_dir()
        os.makedirs(directory, exist_ok=True)
        path = os.path.join(directory, LOG_FILE_NAME)
        handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=2_000_000, backupCount=5, encoding="utf-8", delay=True
        )
        handler.setFormatter(fmt)
        handler._bandait = True
        root.addHandler(handler)
        _install_crash_handlers(directory)
        return path
    except Exception as exc:  # read-only profile, full disk: run without a file log
        logger.warning("Sin log en archivo: %s", exc)
        return None


def _install_crash_handlers(directory: str) -> None:
    global _crash_file
    import faulthandler

    try:
        _crash_file = open(os.path.join(directory, CRASH_FILE_NAME), "a", encoding="utf-8")
        faulthandler.enable(file=_crash_file, all_threads=True)
    except Exception as exc:
        logger.warning("faulthandler no disponible: %s", exc)

    crash_log = logging.getLogger("bandait.crash")

    def excepthook(exc_type, exc, tb):
        if issubclass(exc_type, KeyboardInterrupt):
            sys.__excepthook__(exc_type, exc, tb)
            return
        crash_log.critical("Excepcion no controlada", exc_info=(exc_type, exc, tb))

    def thread_excepthook(args):
        if args.exc_type is SystemExit:
            return
        crash_log.critical(
            "Excepcion no controlada en el hilo %s", getattr(args.thread, "name", "?"),
            exc_info=(args.exc_type, args.exc_value, args.exc_traceback),
        )

    sys.excepthook = excepthook
    threading.excepthook = thread_excepthook


def setup_portaudio():
    """Pick the PortAudio build (ASIO or not) before sounddevice is imported."""
    from src.audio.portaudio_setup import ensure_sounddevice

    try:
        from src.core.leader_config import load_settings

        wants_asio = load_settings().enable_asio
    except Exception:
        wants_asio = False
    return ensure_sounddevice(asio=wants_asio)


def _set_app_user_model_id() -> None:
    """Taskbar grouping and icon follow the app, not python.exe (dev runs)."""
    if sys.platform != "win32":
        return
    try:
        import ctypes

        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
    except Exception:
        pass


def load_fonts():
    """Cargar fuentes personalizadas si están disponibles."""
    from PySide6.QtGui import QFontDatabase

    for name in ("JetBrainsMono-Regular.ttf", "Inter-Regular.ttf"):
        path = resource_path("fonts", name)
        if os.path.exists(path):
            QFontDatabase.addApplicationFont(path)


# ---------------------------------------------------------------------- GUI
def run_gui(qt_argv) -> int:
    from src.audio import rt_policy

    log_path = setup_logging(to_file=True)
    pa = setup_portaudio()
    rt_report = rt_policy.apply_realtime_policy()
    _set_app_user_model_id()

    from PySide6.QtCore import Qt, QTimer
    from PySide6.QtGui import QIcon
    from PySide6.QtWidgets import QApplication

    from src.ui.main_window import APP_VERSION, MainWindow

    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(qt_argv)
    app.setApplicationName("Bandait DAW")
    app.setApplicationVersion(APP_VERSION)
    app.setOrganizationName("Bandait")
    icon_path = resource_path("icon.ico")
    if os.path.isfile(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    load_fonts()
    logger.info(
        "Bandait DAW %s (exe=%s, Python %s) log=%s tiempo_real=%s",
        APP_VERSION, is_frozen(), sys.version.split()[0], log_path, rt_report,
    )

    # Collect the import garbage now, before MainWindow opens the audio stream.
    logger.info("GC antes de la ventana: %s", rt_policy.freeze_startup_heap(collect=True))
    window = MainWindow()
    app.aboutToQuit.connect(window.shutdown)
    window.show()
    # Freeze what the window created too (O(1), safe with audio running).
    QTimer.singleShot(
        0, lambda: logger.info("GC tras la ventana: %s", rt_policy.freeze_startup_heap(collect=False))
    )
    warnings = pa.warnings()
    if warnings:
        message = " | ".join(warnings)
        QTimer.singleShot(800, lambda: window.statusBar().showMessage(message, 30000))

    return app.exec()


# ---------------------------------------------------------------------- smoke test
def _http_get(url: str, timeout: float = 10.0):
    import urllib.error
    import urllib.request

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers or {}), err.read() or b""


def _websocket_upgrade(port: int, timeout: float = 10.0) -> str:
    """Raw RFC 6455 handshake on /socket.io/ (what the phones use). Returns the
    status line."""
    import base64
    import socket

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        "GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        sock.sendall(request.encode("ascii"))
        data = b""
        while b"\r\n" not in data and len(data) < 4096:
            chunk = sock.recv(1024)
            if not chunk:
                break
            data += chunk
    return data.split(b"\r\n", 1)[0].decode("latin-1")


def _check(checks: dict, name: str, fn) -> dict:
    t0 = time.perf_counter()
    try:
        result = fn() or {}
    except Exception as exc:
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    result.setdefault("ok", True)
    result["ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
    checks[name] = result
    return result


def _emit(summary: dict, out_path) -> None:
    try:
        text = json.dumps(summary, indent=2, ensure_ascii=False, default=str)
    except Exception as exc:  # never lose the verdict
        text = json.dumps({"ok": False, "error": f"no serializable: {exc}"})
    try:
        print(text, flush=True)
    except Exception:
        pass
    if out_path:
        try:
            with open(out_path, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
        except OSError as exc:
            try:
                print(f"No se pudo escribir {out_path}: {exc}", file=sys.stderr, flush=True)
            except Exception:
                pass


def run_smoke_test(out_path=None, timeout_s: float = 90.0, measure_gc: bool = True) -> int:
    """Headless self-check of a build: server on an ephemeral loopback port,
    /leader-info.json, /, a hashed asset, the Socket.IO polling and WebSocket
    handshakes, the follower bundle, PortAudio and audio enumeration (which may
    degrade: CI has no sound card). Prints a JSON summary; 0 = all good."""
    t0 = time.perf_counter()
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    setup_logging(to_file=False, level=logging.WARNING)
    frozen = is_frozen()
    summary = {
        "ok": False,
        "app": "BandaitLeader",
        "version": None,
        "frozen": frozen,
        "executable": sys.executable,
        "meipass": getattr(sys, "_MEIPASS", None),
        "python": sys.version.split()[0],
        "checks": {},
        "warnings": [],
    }
    checks = summary["checks"]
    done = threading.Event()

    def watchdog():
        if done.wait(timeout_s):
            return
        summary["error"] = f"tiempo agotado tras {timeout_s:.0f} s"
        _emit(summary, out_path)
        os._exit(1)

    threading.Thread(target=watchdog, name="bandait-smoke-watchdog", daemon=True).start()
    ctx = {}

    def portaudio():
        setup = setup_portaudio()
        info = setup.as_dict()
        info["ok"] = setup.available or not frozen
        if frozen:
            folder = os.path.join(sys._MEIPASS, "_sounddevice_data", "portaudio-binaries")
            bundled = {}
            for dll in ("libportaudio64bit.dll", "libportaudio64bit-asio.dll"):
                bundled[dll] = os.path.isfile(os.path.join(folder, dll))
            info["bundled_dlls"] = bundled
            info["ok"] = info["ok"] and all(bundled.values())
        summary["warnings"].extend(setup.warnings())
        return info

    def realtime():
        from src.audio import rt_policy

        return rt_policy.apply_realtime_policy()

    def imports():
        import src.ui.main_window as main_window

        summary["version"] = main_window.APP_VERSION
        return {"version": main_window.APP_VERSION}

    def audio_devices():
        from src.audio.audio_engine import AudioEngine, sd

        devices = AudioEngine.get_audio_devices()
        hostapis = sorted({d["hostapi"] for d in devices})
        return {
            "portaudio": sd is not None,
            "devices": len(devices),
            "outputs": sum(1 for d in devices if d["max_outputs"] > 0),
            "asio_devices": sum(1 for d in devices if d["is_asio"]),
            "hostapis": hostapis,
            "degraded": sd is None or not devices,
        }

    def keyring_backend():
        # The cloud session (refresh token) lives in keyring. In a frozen exe
        # PyInstaller can miss keyring's entry-point backends: then keyring
        # falls back to fail/null and sessions silently die with the app.
        import keyring

        backend = keyring.get_keyring()
        names = [f"{type(backend).__module__}.{type(backend).__name__}"]
        for inner in getattr(backend, "backends", None) or []:  # ChainerBackend
            names.append(f"{type(inner).__module__}.{type(inner).__name__}")
        bad = any(n.split(".")[-2:-1] in (["fail"], ["null"]) for n in names[:1])
        result = {"backend": names[0], "chain": names[1:]}
        if sys.platform == "win32":
            result["ok"] = not bad and any(n.endswith(".WinVaultKeyring") for n in names)
        else:  # Linux CI has no Secret Service: report only
            result["ok"] = True
        if bad or not result["ok"]:
            summary["warnings"].append(f"keyring sin almacen de credenciales del sistema ({names[0]})")
        return result

    def server_check():
        from PySide6.QtCore import QCoreApplication

        from src.network.http_app import frozen_follower_dir
        from src.network.server import BandaitServer
        from src.sync.clock_service import ClockService

        ctx["app"] = QCoreApplication.instance() or QCoreApplication([sys.argv[0]])
        clock = ClockService()
        clock.start()
        server = BandaitServer(clock, host="127.0.0.1", port=0, session_id="smoke")
        result = {"ok": False}
        try:
            if not server.start():
                result["error"] = server.status_message
                return result
            deadline = time.perf_counter() + 30.0
            while not server.is_running() and time.perf_counter() < deadline:
                time.sleep(0.05)
            result["running"] = server.is_running()
            try:
                import psutil

                created = psutil.Process().create_time()
                result["process_start_to_ready_ms"] = round((time.time() - created) * 1000.0)
            except Exception:
                pass
            port = server.port
            base = f"http://127.0.0.1:{port}"
            result["port"] = port

            status, _headers, body = _http_get(base + "/leader-info.json")
            info = json.loads(body.decode("utf-8")) if status == 200 else {}
            result["leader_info"] = {"status": status, **{k: info.get(k) for k in (
                "protocol_version", "session_id", "port", "follower_url")}}
            info_ok = status == 200 and info.get("port") == port and bool(info.get("protocol_version"))

            bundle = server.follower_dir()
            result["follower_dir"] = str(bundle) if bundle else None
            frozen_dir = frozen_follower_dir()
            in_exe = bool(frozen_dir and (frozen_dir / "index.html").is_file())
            result["follower_in_exe"] = in_exe if frozen else None

            status, _headers, body = _http_get(base + "/")
            index_ok = bool(
                status == 200 and bundle is not None
                and body == (bundle / "index.html").read_bytes()
            )
            result["index"] = {"status": status, "bytes": len(body)}

            asset = re.search(rb'(?:src|href)="\.?/?(assets/[^"]+\.js)"', body or b"")
            asset_ok = False
            if asset:
                a_status, a_headers, a_body = _http_get(base + "/" + asset.group(1).decode())
                ctype = {k.lower(): v for k, v in a_headers.items()}.get("content-type", "")
                asset_ok = a_status == 200 and len(a_body) > 0 and "javascript" in ctype
                result["asset"] = {"path": asset.group(1).decode(), "status": a_status, "type": ctype}

            status, _headers, body = _http_get(base + "/socket.io/?EIO=4&transport=polling")
            polling_ok = status == 200 and body[:2] == b"0{"
            result["socketio_polling"] = {"status": status, "open_packet": body[:2] == b"0{"}

            ws_line = _websocket_upgrade(port)
            ws_ok = " 101 " in f"{ws_line} "
            result["socketio_websocket"] = ws_line

            result["ok"] = bool(
                result["running"] and info_ok and index_ok and asset_ok and polling_ok and ws_ok
                and (in_exe or not frozen)
            )
            return result
        finally:
            server.stop()
            clock.stop()

    def gc_policy():
        from src.audio import rt_policy

        before = rt_policy.measure_full_collection_ms()
        frozen_report = rt_policy.freeze_startup_heap(collect=True)
        after = rt_policy.measure_full_collection_ms()
        return {"full_collect_ms_before_freeze": before, "full_collect_ms_after_freeze": after,
                **frozen_report}

    try:
        _check(checks, "portaudio", portaudio)
        _check(checks, "realtime_policy", realtime)
        _check(checks, "imports", imports)
        _check(checks, "audio_devices", audio_devices)
        _check(checks, "keyring", keyring_backend)
        _check(checks, "server", server_check)
        if measure_gc:
            _check(checks, "gc", gc_policy)
        summary["ok"] = all(c.get("ok") for c in checks.values())
    except BaseException as exc:  # pragma: no cover - last resort, keep the JSON
        summary["error"] = f"{type(exc).__name__}: {exc}"
        summary["ok"] = False
    finally:
        done.set()
    summary["elapsed_ms"] = round((time.perf_counter() - t0) * 1000.0)
    _emit(summary, out_path)
    return 0 if summary["ok"] else 1


# ---------------------------------------------------------------------- entry point
def main(argv=None) -> int:
    ensure_std_streams()
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(prog="BandaitLeader", description="Lider Bandait")
    parser.add_argument("--smoke-test", action="store_true",
                        help="chequeo sin interfaz (servidor, follower, audio); imprime JSON")
    parser.add_argument("--smoke-out", metavar="ARCHIVO",
                        help="ademas escribir el JSON del --smoke-test en ARCHIVO")
    parser.add_argument("--smoke-timeout", type=float, default=90.0, metavar="S",
                        help="abortar el --smoke-test tras S segundos (por defecto 90)")
    args, qt_args = parser.parse_known_args(argv)
    if args.smoke_test:
        return run_smoke_test(out_path=args.smoke_out, timeout_s=args.smoke_timeout)
    return run_gui([sys.argv[0]] + qt_args)


if __name__ == "__main__":
    sys.exit(main())
