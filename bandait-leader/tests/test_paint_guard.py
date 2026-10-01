"""Paint guard (src/ui/widgets/_paint.py): an exception in a custom paintEvent
must never kill the leader on stage.

Failure mode found on 2026-10-01 (installed exe, PySide6 6.11, Windows 11):
``timeline.py`` called ``drawPolygon`` with a flat list of ints during playback,
the TypeError escaped ``paintEvent`` with the QPainter still active and Qt
aborted the process ("QPaintDevice: Cannot destroy paint device that is being
painted", then faulthandler "Fatal Python error: Aborted").

The process-level checks run in a subprocess, so a native abort cannot take
pytest down with it.
"""

import ast
import json
import logging
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QWidget

from src.ui.widgets._paint import paint_failures, reset_paint_failures, safe_paint

LEADER_ROOT = Path(__file__).resolve().parents[1]

CHILD = textwrap.dedent(
    r'''
    import json
    import logging
    import sys

    kind, guarded, crash_dir = sys.argv[1], sys.argv[2] == "guarded", sys.argv[3]
    logging.basicConfig(level=logging.INFO, stream=sys.stdout,
                        format="%(levelname)s %(name)s: %(message)s")

    from src import main as leader_main

    leader_main._install_crash_handlers(crash_dir)  # the app's excepthook + faulthandler

    from PySide6.QtCore import qInstallMessageHandler
    from PySide6.QtGui import QColor, QPainter
    from PySide6.QtWidgets import QApplication, QWidget

    from src.ui.widgets._paint import paint_failures, safe_paint

    qInstallMessageHandler(lambda _mode, _ctx, msg: print("QT: " + msg, flush=True))


    def broken_paint(painter):
        if kind == "polygon":
            painter.drawPolygon([10, 0, 22, 0, 16, 8])  # timeline.py before the fix
        else:
            raise RuntimeError("fallo de dibujo simulado")


    class Unguarded(QWidget):
        def paintEvent(self, event):
            painter = QPainter(self)
            painter.fillRect(self.rect(), QColor(0, 0, 0))
            broken_paint(painter)
            painter.end()


    class Guarded(QWidget):
        @safe_paint
        def paintEvent(self, event, painter):
            painter.fillRect(self.rect(), QColor(0, 0, 0))
            broken_paint(painter)


    app = QApplication([sys.argv[0]])
    widget = Guarded() if guarded else Unguarded()
    widget.resize(120, 40)
    print("STEP show", flush=True)  # paint from the event loop, as in the app
    widget.show()
    for _ in range(10):
        widget.update()
        app.processEvents()
    widget.repaint()
    app.processEvents()
    print("STEP grab", flush=True)
    try:
        widget.grab()
    except Exception as exc:  # unguarded: PySide re-raises the paint error here
        print("GRAB_RAISED " + type(exc).__name__, flush=True)
    print("STEP delete", flush=True)
    widget.deleteLater()
    app.processEvents()
    print("ALIVE " + json.dumps(paint_failures()), flush=True)
    '''
)


def run_child(tmp_path, kind: str, guarded: bool):
    script = tmp_path / "paint_child.py"
    script.write_text(CHILD, encoding="utf-8")
    crash_dir = tmp_path / f"logs-{kind}-{guarded}"
    crash_dir.mkdir()
    env = dict(os.environ)
    env["QT_QPA_PLATFORM"] = "offscreen"
    env["PYTHONPATH"] = str(LEADER_ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, str(script), kind, "guarded" if guarded else "unguarded", str(crash_dir)],
        cwd=str(LEADER_ROOT), env=env, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=120,
    )
    crash_log = crash_dir / "bandait-leader-crash.log"
    crash = crash_log.read_text(encoding="utf-8", errors="replace") if crash_log.exists() else ""
    return proc, crash


@pytest.mark.parametrize("kind", ["raise", "polygon"])
def test_without_the_guard_the_process_dies(tmp_path, kind):
    """Control: reproduces the stage failure. Observed on Windows 11 / PySide6 6.11
    (2026-10-01, offscreen): "raise" logs CRITICAL bandait.crash, Qt warns "active
    painter" / "Cannot destroy paint device that is being painted" and the process
    aborts (exit code 3, "Fatal Python error: Aborted"; 8 of 8 runs alone, while
    1 run inside the full suite ended with exit code 1 instead: dead either way);
    "polygon" (the original call) dies with an access violation (0xC0000005).
    Other platforms are recorded, not asserted (not observed here)."""
    proc, crash = run_child(tmp_path, kind, guarded=False)
    out = proc.stdout + proc.stderr
    died = proc.returncode != 0 or "ALIVE" not in proc.stdout
    aborted = "Fatal Python error: Aborted" in crash
    print(f"sin guarda ({kind}, {sys.platform}): returncode={proc.returncode} murio={died} abort={aborted}")
    print("crash log:", crash.strip().splitlines()[:1])
    print("ultimas lineas:", [line for line in out.splitlines() if not line.startswith(" ")][-4:])
    if sys.platform == "win32":
        assert died, f"PySide/Qt changed: an escaped paint error no longer kills the process.\n{out}"
        if kind == "raise":
            assert "Excepcion no controlada" in out  # the app's excepthook ran and could not help


@pytest.mark.parametrize("kind", ["raise", "polygon"])
def test_with_the_guard_the_process_survives_grab_and_keeps_running(tmp_path, kind):
    proc, crash = run_child(tmp_path, kind, guarded=True)
    out = proc.stdout + proc.stderr
    assert proc.returncode == 0, out
    alive = [line for line in proc.stdout.splitlines() if line.startswith("ALIVE ")]
    assert alive, out
    failures = json.loads(alive[0][len("ALIVE "):])
    assert sum(failures.values()) >= 2  # grab + repaints: every one caught
    assert out.count("Fallo al dibujar") == 1  # logged once, with traceback
    assert "Traceback" in out
    assert "Excepcion no controlada" not in out
    assert "Cannot destroy paint device" not in out and "active painter" not in out
    assert "Fatal Python error" not in crash


# --------------------------------------------------------------------------- in-process
class _Broken(QWidget):
    @safe_paint
    def paintEvent(self, event, painter):
        painter.fillRect(self.rect(), QColor(0, 0, 0))
        painter.drawPolygon([1, 0, 2, 0, 1, 8])  # wrong types on purpose


def test_guard_ends_the_painter_logs_once_and_never_raises(qapp, caplog):
    reset_paint_failures()
    caplog.set_level(logging.ERROR, logger="bandait.ui.paint")
    widget = _Broken()
    widget.resize(50, 20)
    try:
        for _ in range(5):
            pixmap = widget.grab()  # would raise (and later abort) without the guard
            assert not pixmap.isNull()
            assert not widget.paintingActive()
        key = f"{_Broken.__module__}.{_Broken.__qualname__}"
        assert paint_failures() == {key: 5}
        records = [r for r in caplog.records if r.name == "bandait.ui.paint"]
        assert len(records) == 1 and records[0].exc_info is not None
        # the fallback leaves the black background
        image = widget.grab().toImage()
        assert image.pixelColor(25, 10) == QColor(0, 0, 0)
    finally:
        widget.deleteLater()
        reset_paint_failures()


def test_every_custom_paint_event_is_guarded():
    """Static check: no paintEvent in src/ui escapes the guard."""
    unguarded, found = [], []
    for path in sorted((LEADER_ROOT / "src" / "ui").rglob("*.py")):
        if path.name == "_paint.py":
            continue  # the guard's own wrapper
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "paintEvent":
                found.append(f"{path.name}:{node.lineno}")
                names = {getattr(d, "id", getattr(d, "attr", None)) for d in node.decorator_list}
                if "safe_paint" not in names:
                    unguarded.append(f"{path.name}:{node.lineno}")
    assert found, "expected at least the timeline and the VU meter"
    assert unguarded == []
