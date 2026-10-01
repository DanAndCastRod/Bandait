"""Paint guard for custom ``paintEvent`` overrides.

Why it exists (observed 2026-10-01 with PySide6 6.11 on Windows 11): when an
exception escapes a Python ``paintEvent``, the local ``QPainter`` is never
ended (the traceback keeps it alive). Qt then logs "QBackingStore::endPaint()
called with active painter" and "QPaintDevice: Cannot destroy paint device that
is being painted", and the process dies with ``abort()`` (faulthandler:
"Fatal Python error: Aborted", ``<no Python frame>``). The excepthook in
``src/main.py`` only logs, so it cannot save the process: the painter must be
ended inside the paint event itself.

``safe_paint`` owns the painter. The decorated method receives it as a third
argument and must not end it::

    @safe_paint
    def paintEvent(self, event, painter):
        painter.fillRect(self.rect(), QColor(0, 0, 0))

Guarantees, on stage:

- the painter is always ended, whatever happens;
- an exception is logged ONCE per widget class, with its traceback, then only
  counted (a paint that fails 30 times per second never floods the log);
- nothing is re-raised: the widget is left with its black background and the
  app keeps running.
"""

from __future__ import annotations

import functools
import logging
from typing import Dict

from PySide6.QtGui import QColor, QPainter

logger = logging.getLogger("bandait.ui.paint")

FALLBACK_BACKGROUND = QColor(0, 0, 0)  # OLED black: the widget's own background

# "module.Class" -> failures since start. Paint only runs on the GUI thread.
_failures: Dict[str, int] = {}


def _widget_key(widget) -> str:
    cls = type(widget)
    return f"{cls.__module__}.{cls.__qualname__}"


def paint_failures() -> Dict[str, int]:
    """Paint failures per widget class since start (or the last reset)."""
    return dict(_failures)


def reset_paint_failures() -> None:
    _failures.clear()


def _report(widget) -> None:
    """Count the failure; log it with its traceback only the first time."""
    try:
        key = _widget_key(widget)
        count = _failures.get(key, 0) + 1
        _failures[key] = count
        if count == 1:
            logger.error(
                "Fallo al dibujar %s: se deja el fondo y la app sigue. "
                "Se registra solo la primera vez por clase.",
                key,
                exc_info=True,
            )
    except Exception:  # logging must never take the paint event down
        pass


def _draw_fallback(painter, widget) -> None:
    """Leave only the background: never a half-drawn playhead or meter."""
    try:
        if painter is not None and painter.isActive():
            painter.resetTransform()
            painter.setClipping(False)
            painter.setOpacity(1.0)
            painter.fillRect(widget.rect(), FALLBACK_BACKGROUND)
    except Exception:
        pass


def _end(painter) -> None:
    try:
        if painter is not None and painter.isActive():
            painter.end()
    except Exception:
        pass


def safe_paint(method):
    """Decorate ``paintEvent(self, event, painter)``; see the module docstring."""

    @functools.wraps(method)
    def paintEvent(self, event):
        painter = None
        try:
            painter = QPainter(self)
            method(self, event, painter)
        except Exception:
            _report(self)
            _draw_fallback(painter, self)
        finally:
            _end(painter)

    paintEvent.__bandait_safe_paint__ = True
    return paintEvent
