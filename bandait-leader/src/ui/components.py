"""Building blocks of the 2.3 layout. Every look comes from the QSS template through dynamic
properties (role, text, variant, tag); these helpers only set them, never a style sheet.
"""

from __future__ import annotations

from typing import Optional, Tuple

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QVBoxLayout, QWidget

from src.ui import theme


def repolish(widget: QWidget) -> None:
    """Re-apply the style sheet after changing a property used by a selector."""
    style = widget.style()
    style.unpolish(widget)
    style.polish(widget)
    widget.update()


def set_prop(widget: QWidget, name: str, value) -> None:
    if widget.property(name) != value:
        widget.setProperty(name, value)
        repolish(widget)


def label(text: str = "", kind: str = "body", wrap: bool = False, parent: Optional[QWidget] = None) -> QLabel:
    """kind: giant, hero, display, heading, title, body, muted, label (UPPERCASE mono), panel-title, mono, readout."""
    lab = QLabel(text.upper() if kind in ("label", "panel-title") else text, parent)
    lab.setProperty("kind", kind)
    lab.setWordWrap(wrap)
    return lab


def button(text: str, variant: str = "secondary", tooltip: str = "", parent: Optional[QWidget] = None) -> QPushButton:
    """variant: primary, secondary, ghost, ai, panic, chip."""
    btn = QPushButton(text, parent)
    btn.setProperty("variant", variant)
    btn.setCursor(Qt.PointingHandCursor)
    if tooltip:
        btn.setToolTip(tooltip)
    if variant == "chip":
        btn.setCheckable(True)
    return btn


def tag(text: str, kind: str = "", parent: Optional[QWidget] = None) -> QLabel:
    """Small status tag. kind: ok, act, warn, danger, ai or '' (neutral)."""
    lab = QLabel(text.upper(), parent)
    lab.setProperty("role", "tag")
    lab.setProperty("tag", kind)
    return lab


def pill(text: str, parent: Optional[QWidget] = None) -> QLabel:
    lab = QLabel(text, parent)
    lab.setProperty("role", "pill")
    return lab


def frame(role: str, parent: Optional[QWidget] = None) -> QFrame:
    f = QFrame(parent)
    f.setProperty("role", role)
    return f


def panel(title: str = "", parent: Optional[QWidget] = None) -> Tuple[QFrame, QVBoxLayout, Optional[QHBoxLayout]]:
    """A bordered panel with an optional header row. Returns (panel, body layout, header actions layout)."""
    box = frame("panel", parent)
    outer = QVBoxLayout(box)
    outer.setContentsMargins(0, 0, 0, 0)
    outer.setSpacing(0)
    actions = None
    if title:
        head = frame("panel-head")
        hl = QHBoxLayout(head)
        hl.setContentsMargins(theme.SPACE_4, theme.SPACE_3, theme.SPACE_4, theme.SPACE_3)
        hl.setSpacing(theme.SPACE_2)
        hl.addWidget(label(title, "panel-title"))
        hl.addStretch()
        actions = hl
        outer.addWidget(head)
    body = QVBoxLayout()
    body.setContentsMargins(theme.SPACE_4, theme.SPACE_3, theme.SPACE_4, theme.SPACE_3)
    body.setSpacing(theme.SPACE_3)
    outer.addLayout(body, 1)
    return box, body, actions


def view_header(title: str, lede: str = "") -> Tuple[QWidget, QHBoxLayout]:
    """Top of a view: title, one line of context and an actions area on the right."""
    w = QWidget()
    row = QHBoxLayout(w)
    row.setContentsMargins(theme.SPACE_5, theme.SPACE_5, theme.SPACE_5, 0)
    row.setSpacing(theme.SPACE_3)
    col = QVBoxLayout()
    col.setSpacing(2)
    col.addWidget(label(title, "heading"))
    lede_label = label(lede, "muted")
    lede_label.setObjectName("viewLede")
    col.addWidget(lede_label)
    row.addLayout(col)
    row.addStretch()
    return w, row


def stat(caption: str, value: str, kind: str = "readout") -> Tuple[QWidget, QLabel]:
    """Caption over a big number. Returns (widget, value label)."""
    w = QWidget()
    col = QVBoxLayout(w)
    col.setContentsMargins(0, 0, 0, 0)
    col.setSpacing(2)
    col.addWidget(label(caption, "label"))
    val = label(value, kind)
    col.addWidget(val)
    return w, val


def expanding(widget: QWidget) -> QWidget:
    widget.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
    return widget
