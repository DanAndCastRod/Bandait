"""Packaging contract: version, license files, PyInstaller layout, installer
and release workflow, plus the --smoke-test entry point (run from source).

These run on the Linux CI too: nothing here needs PyInstaller, Inno Setup or
Windows (the few Windows-only checks skip themselves)."""

import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

LEADER = Path(__file__).resolve().parents[1]
REPO = LEADER.parent
SCRIPTS = LEADER / "scripts"
sys.path.insert(0, str(SCRIPTS))

import build_exe  # noqa: E402
import version as version_mod  # noqa: E402

GPL3_SHA256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986"
DEV_ONLY = {"ruff", "pytest", "pytest-qt", "aiohttp", "jsonschema"}


def _requirements():
    names = []
    for line in (LEADER / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.append(re.split(r"[\[<>=!~ ]", line, 1)[0])
    return names


# ---------------------------------------------------------------- version and legal
def test_single_version_constant_matches_pyproject():
    version = version_mod.read_app_version()
    assert re.fullmatch(r"\d+\.\d+\.\d+", version)
    pyproject = tomllib.loads((LEADER / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == version
    assert version_mod.version_tuple(version) == tuple(int(x) for x in version.split(".")) + (0,)


def test_tag_check(capsys):
    version = version_mod.read_app_version()
    assert version_mod.main(["--check-tag", f"v{version}"]) == 0
    assert version_mod.main(["--check-tag", f"refs/tags/v{version}"]) == 0
    assert version_mod.main(["--check-tag", "v0.0.0-otra"]) == 1


def test_license_is_the_full_gpl3_text():
    # Compare the text, not the checkout's line endings: a Windows checkout with
    # core.autocrlf turns LF into CRLF (CI failed on exactly that on 2026-10-01).
    # .gitattributes pins LICENSE to LF; this keeps the test honest either way.
    data = (REPO / "LICENSE").read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(data).hexdigest() == GPL3_SHA256
    assert data.lstrip().startswith(b"GNU GENERAL PUBLIC LICENSE")


def test_notice_lists_every_runtime_requirement_and_the_copyleft_parts():
    notice = (REPO / "NOTICE.md").read_text(encoding="utf-8").lower()
    for name in _requirements():
        if name.lower() in DEV_ONLY:
            continue
        assert name.lower() in notice, f"NOTICE.md no menciona {name}"
    for needle in ("lgpl-3.0", "portaudio", "asio sdk", "gpl-3.0", "libsndfile",
                   "portaudio-binaries", "steinberg.net", "source code"):
        assert needle in notice, needle


def test_readme_states_the_license():
    readme = (LEADER / "README.md").read_text(encoding="utf-8")
    assert "GPL-3.0-or-later" in readme
    assert "## Instalador y releases" in readme


def test_icon_is_multi_size():
    pytest.importorskip("PIL")
    from make_icon import ICON, icon_sizes

    sizes = icon_sizes(ICON)
    for s in (16, 32, 48, 256):
        assert (s, s) in sizes


# ---------------------------------------------------------------- PyInstaller layout
def test_bundle_paths_match_what_the_runtime_looks_for(monkeypatch, tmp_path):
    from src import main
    from src.network import http_app

    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    meipass = tmp_path
    # Follower bundle: src/network/http_app.py frozen_follower_dir().
    follower_dest = http_app.frozen_follower_dir().relative_to(meipass).as_posix()
    assert build_exe.DATA_DESTINATIONS[follower_dest] == build_exe.FOLLOWER
    # Resources: src/main.py resource_path().
    res = Path(main.resource_path("icon.ico")).relative_to(meipass).parent.as_posix()
    assert build_exe.DATA_DESTINATIONS[res] == build_exe.RESOURCES
    # QSS: src/ui/main_window.py looks in <its folder>/../styles first.
    assert build_exe.DATA_DESTINATIONS["src/styles"] == LEADER / "src" / "styles"


def test_build_preflight_and_arguments():
    assert build_exe.preflight() == []
    args = build_exe.pyinstaller_args(Path("version_info.txt"))
    assert "--onedir" in args and "--windowed" in args and "--onefile" not in args
    assert f"--paths={LEADER}" in args
    assert f"--icon={build_exe.ICON}" in args
    assert any(a.startswith("--version-file=") for a in args)
    joined = " ".join(args)
    for mod in ("keyring.backends.Windows", "engineio.async_drivers.asgi"):
        assert f"--hidden-import {mod}" in joined
    assert "--collect-submodules keyring.backends" in joined
    assert "--copy-metadata keyring" in joined


def test_no_dead_hidden_imports():
    for dead in ("google.generativeai", "mido", "mido.backends.rtmidi", "qasync", "alembic"):
        assert dead not in build_exe.HIDDEN_IMPORTS
    assert "google.generativeai" in build_exe.EXCLUDED_MODULES
    for mod in build_exe.HIDDEN_IMPORTS:
        if mod.startswith("win32ctypes") and sys.platform != "win32":
            continue
        assert importlib.util.find_spec(mod) is not None, mod


def test_optional_ai_import_degrades_without_the_sdk():
    # Excluding google.generativeai is only safe while src/ai keeps it optional.
    src = (LEADER / "src" / "ai" / "ai_assistant.py").read_text(encoding="utf-8")
    block = src[src.index("import google.generativeai"):]
    assert "except ImportError" in block[:400]


def test_excluded_qt_modules_are_not_used_by_src():
    used = set()
    for path in (LEADER / "src").rglob("*.py"):
        used |= set(re.findall(r"PySide6\.(Qt\w+)", path.read_text(encoding="utf-8")))
    assert used, "no PySide6 imports found"
    assert not used & set(build_exe.EXCLUDED_QT), used & set(build_exe.EXCLUDED_QT)


def test_version_resource_text():
    text = build_exe.version_file_text("2.1.0")
    assert "filevers=(2, 1, 0, 0)" in text and "StringStruct('ProductVersion', '2.1.0')" in text
    pytest.importorskip("PyInstaller")
    from PyInstaller.utils.win32 import versioninfo

    info = eval(text, vars(versioninfo))  # what PyInstaller does with --version-file
    assert info.ffi.fileVersionMS == (2 << 16) | 1


# ---------------------------------------------------------------- installer
def _iss():
    return (SCRIPTS / "installer.iss").read_text(encoding="utf-8")


def _iss_value(key):
    m = re.search(rf"^{key}=(.+)$", _iss(), re.M)
    assert m, key
    return m.group(1).strip()


def test_installer_references_existing_files():
    for key in ("LicenseFile", "SetupIconFile"):
        rel = _iss_value(key).replace("\\", "/")
        assert (SCRIPTS / rel).resolve().is_file(), f"{key}={rel}"
    assert (SCRIPTS / _iss_value("LicenseFile").replace("\\", "/")).resolve() == REPO / "LICENSE"
    build_dir = re.search(r'#define BuildDir "(.+)"', _iss()).group(1).replace("\\", "/")
    assert (SCRIPTS / build_dir).resolve() == build_exe.APP_DIR
    assert re.search(r'#define MyAppExeName "BandaitLeader.exe"', _iss())


def test_installer_is_per_machine_x64_and_versioned():
    assert _iss_value("PrivilegesRequired") == "admin"
    assert _iss_value("ArchitecturesInstallIn64BitMode") == "x64compatible"
    assert _iss_value("DefaultDirName").startswith("{autopf}")
    assert _iss_value("AppVersion") == "{#MyAppVersion}"
    assert "{#MyAppVersion}" in _iss_value("OutputBaseFilename")
    assert "compiler:Languages\\Spanish.isl" in _iss()
    assert re.search(r'Name: "desktopicon".*Flags: unchecked', _iss())
    assert "{autoprograms}" in _iss()


def test_installer_firewall_rule_private_tcp_and_removed_on_uninstall():
    text = _iss()
    run = text[text.index("[Run]"):text.index("[UninstallRun]")]
    uninstall = text[text.index("[UninstallRun]"):]
    add = [line for line in run.splitlines() if "firewall add rule" in line]
    assert len(add) == 1
    rule = add[0]
    for part in ("dir=in", "action=allow", "protocol=TCP", "profile=private",
                 'program=""{app}\\{#MyAppExeName}""'):
        assert part in rule, part
    assert "profile=public" not in text and "profile=any" not in text
    assert "firewall delete rule" in run.split("firewall add rule")[0]  # no duplicates on upgrade
    assert "firewall delete rule" in uninstall


def test_installer_downloads_nothing():
    text = _iss().lower()
    assert "downloadtemporaryfile" not in text and "createdownloadpage" not in text
    assert "[code]" not in text


# ---------------------------------------------------------------- release workflow
def test_release_workflow():
    raw = (REPO / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    assert "secrets." not in raw  # only the automatic github.token
    yaml = pytest.importorskip("yaml")
    wf = yaml.safe_load(raw)
    on = wf.get("on", wf.get(True))
    assert on["push"]["tags"] == ["v*"] and "workflow_dispatch" in on
    job = wf["jobs"]["windows"]
    assert job["runs-on"] == "windows-latest"
    steps = job["steps"]
    py = [s for s in steps if s.get("uses", "").startswith("actions/setup-python")][0]
    assert py["with"]["python-version"] == "3.11"
    runs = "\n".join(s.get("run", "") for s in steps)
    assert "pip install -r requirements.txt pyinstaller" in runs
    assert "scripts/build_exe.py" in runs and "--smoke-test" in runs
    assert "ISCC.exe" in runs and "choco install innosetup" in runs
    assert "SHA256SUMS" in runs and "Source code" in runs
    release = [s for s in steps if s.get("name") == "GitHub Release"][0]
    assert release["if"] == "github.ref_type == 'tag'"
    assert any(s.get("uses", "").startswith("actions/upload-artifact") for s in steps)


# ---------------------------------------------------------------- smoke test entry point
def test_smoke_test_from_source_with_missing_std_streams(tmp_path):
    """What a windowed exe sees (sys.stdout/stderr = None): the smoke test must
    still start the server (uvicorn calls sys.stdout.isatty()) and pass."""
    out = tmp_path / "smoke.json"
    code = (
        "import sys; sys.stdout = None; sys.stderr = None\n"
        "from src.main import main\n"
        f"sys.exit(main(['--smoke-test', '--smoke-out', {str(out)!r}, '--smoke-timeout', '200']))\n"
    )
    proc = subprocess.run([sys.executable, "-c", code], cwd=str(LEADER), timeout=240,
                          capture_output=True, env=dict(os.environ))
    assert out.is_file(), proc.stderr.decode("utf-8", "replace")[-2000:]
    summary = json.loads(out.read_text(encoding="utf-8"))
    assert proc.returncode == 0, json.dumps(summary, indent=2)[:4000]
    assert summary["ok"] is True
    server = summary["checks"]["server"]
    assert server["leader_info"]["status"] == 200
    assert server["index"]["status"] == 200
    assert server["socketio_websocket"].startswith("HTTP/1.1 101")
    assert Path(server["follower_dir"]) == (REPO / "landing" / "app").resolve()
    assert summary["checks"]["audio_devices"]["ok"] is True  # may be degraded, never fails
    assert summary["version"] == version_mod.read_app_version()


def test_notice_gate_names_and_toc_parsing(tmp_path):
    notice = tmp_path / "NOTICE.md"
    notice.write_text("| PySide6-Essentials | x |\n| pywin32-ctypes | x |\n| jaraco.context | x |\n",
                      encoding="utf-8")
    bundled = {n: ("1", None) for n in ("PySide6_Essentials", "pywin32", "jaraco.context")}
    # pywin32 is not "named" just because pywin32-ctypes is.
    assert build_exe.notice_missing(bundled, notice) == ["pywin32"]
    src = tmp_path / "mod.py"
    src.write_text("", encoding="utf-8")
    toc = repr(("out.pyz", [("mod", str(src), "PYMODULE"), ("gone", str(tmp_path / "x.py"), "PYMODULE")]))
    assert build_exe._toc_source_files(toc) == {os.path.normcase(os.path.abspath(str(src)))}
