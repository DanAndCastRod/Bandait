"""PyInstaller build of Bandait Leader for Windows (onedir).

Usage (from bandait-leader, with requirements.txt and pyinstaller installed):
    python scripts/build_exe.py             # -> dist/BandaitLeader/BandaitLeader.exe
    python scripts/build_exe.py --dry-run   # only print the PyInstaller arguments

Then check it and package it:
    dist/BandaitLeader/BandaitLeader.exe --smoke-test --smoke-out smoke.json
    iscc /DMyAppVersion=X.Y.Z scripts/installer.iss   (the release workflow does both)

Why ``--onedir`` and not ``--onefile``: onefile unpacks the whole app to
%TEMP% on every launch (slow start, antivirus scans it every time, leftovers
after a crash), while onedir loads the audio DLLs from a stable folder.
Nuitka, pyside6-deploy or cx_Freeze give no real-time benefit: the PortAudio
callback runs Python and takes the GIL either way.

Layout inside the bundle (``sys._MEIPASS`` = dist/BandaitLeader/_internal):
- ``follower/``   landing/app, the musicians' app (src/network/http_app.py)
- ``src/styles/`` QSS themes (src/ui/main_window.py looks for ../styles)
- ``resources/``  icon.ico (src/main.py resource_path)
- ``_sounddevice_data/portaudio-binaries/`` both PortAudio DLLs, with and
  without ASIO (PyInstaller's sounddevice hook)
LICENSE, NOTICE.md, build-environment.txt (exact versions of every bundled
Python distribution, read from PyInstaller's TOCs) and third_party_licenses/
(the license texts those distributions publish) go next to BandaitLeader.exe.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPTS.parent  # bandait-leader/
REPO_ROOT = PROJECT_ROOT.parent
SRC = PROJECT_ROOT / "src"
STYLES = SRC / "styles"
RESOURCES = PROJECT_ROOT / "resources"
ICON = RESOURCES / "icon.ico"
# Follower bundle served to phones (CONTRACT_V3 section 8). It is committed;
# rebuild it with `npm run build:landing` at the repo root after follower changes.
FOLLOWER = REPO_ROOT / "landing" / "app"
DIST = PROJECT_ROOT / "dist"
BUILD = PROJECT_ROOT / "build"
APP_NAME = "BandaitLeader"
APP_DIR = DIST / APP_NAME
LEGAL_FILES = [REPO_ROOT / "LICENSE", REPO_ROOT / "NOTICE.md"]

sys.path.insert(0, str(SCRIPTS))
from version import read_app_version, version_tuple  # noqa: E402

# Bundle-relative destinations the runtime expects (checked by tests/test_packaging.py).
DATA_DESTINATIONS = {
    "follower": FOLLOWER,
    "src/styles": STYLES,
    "resources": RESOURCES,
}

# Nothing in src imports these. Qt modules: src only imports QtCore, QtGui and
# QtWidgets (checked by tests/test_packaging.py); the rest is excluded so a
# transitive import can never drag WebEngine (~200 MB) or QML into the bundle.
EXCLUDED_QT = [
    "Qt3DAnimation", "Qt3DCore", "Qt3DExtras", "Qt3DInput", "Qt3DLogic", "Qt3DRender",
    "QtBluetooth", "QtCharts", "QtConcurrent", "QtDataVisualization", "QtDesigner",
    "QtGraphs", "QtGraphsWidgets", "QtHelp", "QtHttpServer", "QtLocation", "QtMultimedia",
    "QtMultimediaWidgets", "QtNetworkAuth", "QtNfc", "QtOpenGL", "QtOpenGLWidgets", "QtPdf",
    "QtPdfWidgets", "QtPositioning", "QtQml", "QtQuick", "QtQuick3D", "QtQuickControls2",
    "QtQuickTest", "QtQuickWidgets", "QtRemoteObjects", "QtScxml", "QtSensors", "QtSerialBus",
    "QtSerialPort", "QtSpatialAudio", "QtSql", "QtStateMachine", "QtTest", "QtTextToSpeech",
    "QtUiTools", "QtWebChannel", "QtWebEngineCore", "QtWebEngineQuick", "QtWebEngineWidgets",
    "QtWebSockets", "QtWebView",
]
EXCLUDED_MODULES = [f"PySide6.{m}" for m in EXCLUDED_QT] + [
    # Tests and dev tools.
    "tests", "pytest", "_pytest", "pytestqt", "ruff", "jsonschema", "IPython", "jupyter",
    # Not used by the leader. aiohttp is only the test-side Socket.IO client;
    # the server runs on uvicorn (ASGI). watchfiles is uvicorn --reload only.
    "tkinter", "_tkinter", "matplotlib", "pandas", "scipy", "aiohttp", "eventlet", "gevent",
    "tornado", "sanic", "watchfiles",
    # google-generativeai reached end of support on 2025-11-30. src/ai imports
    # it inside try/except ImportError and degrades to "AI offline", so it is
    # not shipped (with grpc/protobuf it is tens of MB of dead weight).
    "google.generativeai", "google.ai", "google.api_core", "google.auth", "googleapiclient",
    "grpc", "grpc_status",
    # Optional back ends that python-socketio / engineio / websockets import
    # inside try/except: message queues, HTTP clients and routers the leader
    # never uses. Excluded so a developer machine with them installed (e.g.
    # Django + Celery in the same Python) builds the same bundle as CI; on
    # 2026-10-01 they added ~45 MB (django, kombu, redis, cryptography...).
    "django", "kombu", "celery", "billiard", "redis", "kafka", "zmq", "aio_pika",
    "requests", "websocket", "werkzeug", "OpenSSL", "cryptography",
    # Same story via uvicorn.workers / uvicorn.middleware.wsgi, SQLAlchemy's
    # MySQL dialect and pdb: the leader is ASGI + SQLite only.
    "gunicorn", "a2wsgi", "pymysql", "nacl", "pyreadline3",
    # Build-time only (cffi's distutils shim, pkg_resources' runtime hook).
    "setuptools", "pkg_resources",
]
# Dynamic imports PyInstaller cannot see. uvicorn's own hook already collects
# all uvicorn submodules (protocols, loops, lifespan). Removed on 2026-10-01:
# google.generativeai (see above), mido/rtmidi and qasync/alembic (not imported
# anywhere in src).
HIDDEN_IMPORTS = [
    "engineio.async_drivers.asgi",  # socketio.ASGIApp picks its driver by name
    # keyring finds its back ends through entry points: without them the cloud
    # session (refresh token in Windows Credential Manager) falls back to
    # keyring.backends.fail and dies with the app. --smoke-test checks it.
    "keyring.backends.Windows",
    "win32ctypes.pywin32.pywintypes",
    "win32ctypes.pywin32.win32cred",
]
COLLECT_SUBMODULES = ["keyring.backends", "win32ctypes"]
COPY_METADATA = ["keyring"]  # entry points "keyring.backends"

# Qt files that plugins drag in but a QtWidgets app never loads. Deleted from
# the bundle after PyInstaller (no CLI switch excludes Qt plugins):
# - the virtual keyboard input context pulls Qt Quick/QML (~19 MB);
# - the PDF image format pulls Qt6Pdf (~4.5 MB);
# - opengl32sw.dll is the software OpenGL fallback (~20 MB): widgets paint
#   with the raster engine, nothing in src uses OpenGL;
# - Qt translations other than Spanish and English (~6 MB).
PRUNE_QT = [
    "PySide6/plugins/platforminputcontexts/qtvirtualkeyboardplugin.dll",
    "PySide6/Qt6VirtualKeyboard.dll",
    "PySide6/Qt6Quick.dll",
    "PySide6/Qt6Qml.dll",
    "PySide6/Qt6QmlMeta.dll",
    "PySide6/Qt6QmlModels.dll",
    "PySide6/Qt6QmlWorkerScript.dll",
    "PySide6/plugins/imageformats/qpdf.dll",
    "PySide6/Qt6Pdf.dll",
    "PySide6/opengl32sw.dll",
]
KEEP_TRANSLATION_PREFIXES = ("qt_es", "qtbase_es", "qt_en", "qtbase_en", "qt_help_es")


def version_file_text(version: str) -> str:
    vt = version_tuple(version)
    return f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(filevers={vt}, prodvers={vt}, mask=0x3f, flags=0x0, OS=0x40004,
                    fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('0C0A04B0', [
      StringStruct('CompanyName', 'Bandait'),
      StringStruct('FileDescription', 'Bandait Leader - lider de sesion para bandas en vivo'),
      StringStruct('FileVersion', '{version}'),
      StringStruct('InternalName', '{APP_NAME}'),
      StringStruct('LegalCopyright', 'GPL-3.0-or-later'),
      StringStruct('OriginalFilename', '{APP_NAME}.exe'),
      StringStruct('ProductName', 'Bandait Leader'),
      StringStruct('ProductVersion', '{version}')])]),
    VarFileInfo([VarStruct('Translation', [0x0C0A, 1200])])
  ]
)
"""


def preflight() -> list:
    """Problems that make the build pointless. Empty list = go."""
    problems = []
    if not (FOLLOWER / "index.html").is_file():
        problems.append(
            f"falta el follower compilado en {FOLLOWER} (ejecute `npm run build:landing` en la raiz)"
        )
    if not ICON.is_file():
        problems.append(f"falta {ICON} (ejecute `python scripts/make_icon.py`)")
    if not (STYLES / "bandait_dark.qss").is_file():
        problems.append(f"falta {STYLES / 'bandait_dark.qss'}")
    for f in LEGAL_FILES:
        if not f.is_file():
            problems.append(f"falta {f}")
    return problems


def pyinstaller_args(version_file: Path) -> list:
    sep = os.pathsep  # ';' on Windows
    args = [
        str(SRC / "main.py"),
        f"--name={APP_NAME}",
        "--windowed",  # no console window; src/main.py replaces the missing std streams
        "--onedir",
        "--noconfirm",
        "--clean",
        f"--distpath={DIST}",
        f"--workpath={BUILD}",
        f"--specpath={BUILD}",
        f"--paths={PROJECT_ROOT}",  # imports are "src.*"
        f"--icon={ICON}",
        f"--version-file={version_file}",
    ]
    for dest, source in DATA_DESTINATIONS.items():
        args += ["--add-data", f"{source}{sep}{dest}"]
    for mod in HIDDEN_IMPORTS:
        args += ["--hidden-import", mod]
    for mod in COLLECT_SUBMODULES:
        args += ["--collect-submodules", mod]
    for dist in COPY_METADATA:
        args += ["--copy-metadata", dist]
    for mod in EXCLUDED_MODULES:
        args += ["--exclude-module", mod]
    return args


def prune_qt(internal: Path) -> int:
    """Delete the Qt files listed in PRUNE_QT and foreign translations.
    Returns the bytes freed."""
    freed = 0
    targets = [internal / rel for rel in PRUNE_QT]
    tr = internal / "PySide6" / "translations"
    if tr.is_dir():
        targets += [f for f in tr.glob("*.qm") if not f.name.startswith(KEEP_TRANSLATION_PREFIXES)]
    for f in targets:
        if f.is_file():
            freed += f.stat().st_size
            f.unlink()
    return freed


def _toc_source_files(toc_text: str) -> set:
    """Absolute source paths found in a PyInstaller TOC file (a Python literal)."""
    import ast

    found = set()
    stack = [ast.literal_eval(toc_text)]
    while stack:
        item = stack.pop()
        if isinstance(item, (list, tuple)):
            stack.extend(item)
        elif isinstance(item, str) and os.path.isabs(item) and os.path.isfile(item):
            found.add(os.path.normcase(os.path.abspath(item)))
    return found


def bundled_distributions() -> dict:
    """{distribution: (version, dist)} for every installed distribution that
    owns at least one file PyInstaller collected (modules and binaries, read
    from the build TOCs). Empty if the TOCs cannot be read."""
    import importlib.metadata as md

    sources = set()
    for toc in ("PYZ-00.toc", "COLLECT-00.toc"):
        path = BUILD / APP_NAME / toc
        try:
            sources |= _toc_source_files(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, SyntaxError):
            return {}
    owners = {}
    for dist in md.distributions():
        name = dist.metadata.get("Name")
        if not name or name in owners:
            continue
        for f in dist.files or []:
            if os.path.normcase(os.path.abspath(dist.locate_file(f))) in sources:
                owners[name] = (dist.version, dist)
                break
    return owners


def build_environment_text(version: str, bundled: dict) -> str:
    """Exact versions of the bundled distributions (NOTICE.md points here to
    identify the corresponding source of each component)."""
    import importlib.metadata as md
    import platform

    try:
        pyinstaller = md.version("pyinstaller")
    except md.PackageNotFoundError:
        pyinstaller = "?"
    lines = [
        f"Bandait Leader {version}",
        f"Python {platform.python_version()} ({platform.python_implementation()}, {platform.machine()})",
        f"PyInstaller {pyinstaller}",
        "",
        "Paquetes Python incluidos en este paquete (nombre==version):",
    ]
    lines += [f"{name}=={bundled[name][0]}" for name in sorted(bundled, key=str.lower)]
    return "\n".join(lines) + "\n"


def _norm_dist(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def notice_missing(bundled: dict, notice: Path = REPO_ROOT / "NOTICE.md") -> list:
    """Bundled distributions that NOTICE.md does not name (GPL/LGPL compliance:
    every shipped component must be listed with its license and source)."""
    text = _norm_dist(notice.read_text(encoding="utf-8"))
    def named(n: str) -> bool:
        return re.search(rf"(?<![a-z0-9-]){re.escape(_norm_dist(n))}(?![a-z0-9-])", text) is not None

    return sorted((n for n in bundled if not named(n)), key=str.lower)


_LICENSE_PREFIXES = ("license", "licence", "copying", "notice", "authors")


def collect_license_files(target: Path, bundled: dict) -> int:
    """Copy the license texts each bundled distribution ships in its .dist-info
    (LICENSE*, COPYING*, NOTICE*, AUTHORS*, licenses/) to target. Returns the
    number of files copied."""
    count = 0
    for name, (dist_version, dist) in bundled.items():
        for f in dist.files or []:
            parts = f.parts
            if len(parts) < 2 or not parts[0].lower().endswith(".dist-info"):
                continue
            if not (f.name.lower().startswith(_LICENSE_PREFIXES)
                    or any(p.lower() == "licenses" for p in parts[1:-1])):
                continue
            src = Path(dist.locate_file(f))
            if not src.is_file():
                continue
            dest = target / f"{name}-{dist_version}" / Path(*parts[1:])
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            count += 1
    return count


def clean() -> None:
    for folder in (DIST, BUILD):
        if folder.exists():
            shutil.rmtree(folder)
            print(f"Limpio: {folder}")


def folder_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def build(dry_run: bool = False) -> int:
    version = read_app_version()
    problems = preflight()
    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        return 1
    version_file = BUILD / "version_info.txt"
    args = pyinstaller_args(version_file)
    print(f"Bandait Leader {version}: PyInstaller con:")
    for a in args:
        print(f"  {a}")
    if dry_run:
        return 0
    try:
        import PyInstaller.__main__
    except ImportError:
        print("ERROR: PyInstaller no esta instalado. Ejecute: pip install pyinstaller", file=sys.stderr)
        return 1

    clean()
    BUILD.mkdir(parents=True, exist_ok=True)
    version_file.write_text(version_file_text(version), encoding="utf-8")
    PyInstaller.__main__.run(args)

    exe = APP_DIR / f"{APP_NAME}.exe"
    if not exe.is_file():
        print(f"ERROR: PyInstaller no produjo {exe}", file=sys.stderr)
        return 1
    for f in LEGAL_FILES:
        shutil.copy2(f, APP_DIR / f.name)
    bundled = bundled_distributions()
    if not bundled:
        print("ERROR: no se pudo leer la lista de paquetes incluidos (build/*.toc)", file=sys.stderr)
        return 1
    (APP_DIR / "build-environment.txt").write_text(
        build_environment_text(version, bundled), encoding="utf-8"
    )
    n_licenses = collect_license_files(APP_DIR / "third_party_licenses", bundled)
    print(f"Paquetes incluidos: {', '.join(sorted(bundled, key=str.lower))}")
    print(f"Textos de licencia de terceros: {n_licenses} archivos en third_party_licenses/")
    missing = notice_missing(bundled)
    if missing:
        # The release workflow sets BANDAIT_STRICT_NOTICE=1: a new transitive
        # dependency must be added to NOTICE.md before it ships. A developer
        # machine may bundle extra packages from its global Python: warning only.
        level = "ERROR" if os.environ.get("BANDAIT_STRICT_NOTICE") == "1" else "AVISO"
        print(f"{level}: NOTICE.md no menciona: {', '.join(missing)}", file=sys.stderr)
        if level == "ERROR":
            return 1
    internal = APP_DIR / "_internal"
    freed = prune_qt(internal)
    print(f"Qt sin usar eliminado: {freed / (1024 * 1024):.1f} MB")
    for rel in ("follower/index.html", "src/styles/bandait_dark.qss", "resources/icon.ico",
                "_sounddevice_data/portaudio-binaries/libportaudio64bit.dll",
                "_sounddevice_data/portaudio-binaries/libportaudio64bit-asio.dll"):
        if not (internal / rel).is_file():
            print(f"ERROR: falta {rel} dentro de {internal}", file=sys.stderr)
            return 1
    size_mb = folder_size(APP_DIR) / (1024 * 1024)
    print(f"\nBuild listo: {exe} (version {version}, {size_mb:.1f} MB)")
    print(f"Verifique: \"{exe}\" --smoke-test --smoke-out smoke.json")
    print(f"Instalador: iscc /DMyAppVersion={version} scripts\\installer.iss")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Empaqueta Bandait Leader con PyInstaller (onedir)")
    parser.add_argument("--dry-run", action="store_true", help="solo mostrar los argumentos")
    args = parser.parse_args(argv)
    return build(dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
