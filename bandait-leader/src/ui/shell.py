"""Shell of the 2.3 window: the left navigation rail and its line icons.

Icons are drawn with QPainter (same strokes as the HTML mockup): the installer only ships
QtCore, QtGui and QtWidgets, so there is no SVG plugin to rely on.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPen, QPixmap
from PySide6.QtWidgets import QButtonGroup, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from src.ui import components as ui
from src.ui import theme

# (key, label). Same names and order as the hub (Bandait 2.3).
VIEWS: List[Tuple[str, str]] = [
    ("escenario", "Escenario"),
    ("ensayo", "Ensayo"),
    ("setlists", "Setlists"),
    ("canciones", "Canciones"),
    ("pistas", "Pistas"),
    ("banda", "Banda"),
    ("ajustes", "Ajustes"),
]


# Icons as data: ("line", x1, y1, x2, ...) polylines, ("dot"/"circle", cx, cy, r),
# ("quad", x0, y0, cx, cy, x1, y1) curves and ("arc", x, y, w, h, start, span) arcs.
ICONS = {
    "escenario": [("line", 3, 15, 15, 15), ("line", 4, 15, 4, 7, 9, 3, 14, 7, 14, 15), ("line", 7, 15, 7, 11, 11, 11, 11, 15)],
    "ensayo": [("arc", 4, 4, 10, 10, 160, -320), ("line", 4, 3, 4, 6.5, 7.5, 6.5)],
    "setlists": [("line", 6.5, 5, 15, 5), ("line", 6.5, 9, 15, 9), ("line", 6.5, 13, 15, 13),
                 ("dot", 3.5, 5, 0.6), ("dot", 3.5, 9, 0.6), ("dot", 3.5, 13, 0.6)],
    "canciones": [("line", 7, 14, 7, 4, 15, 2.5, 15, 12.5), ("circle", 5, 14, 2), ("circle", 13, 12.5, 2)],
    "pistas": [("line", 3, 5, 15, 5), ("line", 3, 9, 15, 9), ("line", 3, 13, 15, 13),
               ("line", 6, 3, 6, 7), ("line", 11, 7, 11, 11), ("line", 8, 11, 8, 15)],
    "banda": [("circle", 6.5, 6, 2.5), ("circle", 12.5, 7, 2), ("quad", 2, 15, 3.5, 10.5, 6.5, 10.5),
              ("quad", 6.5, 10.5, 9.5, 10.5, 11, 15), ("quad", 11, 11.5, 14.5, 11, 15.5, 15)],
    "ajustes": [("circle", 9, 9, 2.5), ("line", 9, 2, 9, 4), ("line", 9, 14, 9, 16), ("line", 2, 9, 4, 9),
                ("line", 14, 9, 16, 9), ("line", 4, 4, 5.4, 5.4), ("line", 12.6, 12.6, 14, 14),
                ("line", 4, 14, 5.4, 12.6), ("line", 12.6, 5.4, 14, 4)],
}


def _draw(name: str, p: QPainter) -> None:
    """18x18 line icons, 1.5 px strokes."""
    path = QPainterPath()
    for kind, *v in ICONS.get(name, []):
        if kind == "line":
            path.moveTo(v[0], v[1])
            for i in range(2, len(v), 2):
                path.lineTo(v[i], v[i + 1])
        elif kind in ("dot", "circle"):
            path.addEllipse(QPointF(v[0], v[1]), v[2], v[2])
        elif kind == "quad":
            path.moveTo(v[0], v[1])
            path.quadTo(v[2], v[3], v[4], v[5])
        elif kind == "arc":
            rect = QRectF(v[0], v[1], v[2], v[3])
            path.arcMoveTo(rect, v[4])
            path.arcTo(rect, v[4], v[5])
    p.drawPath(path)


def nav_icon(name: str, size: int = 18) -> QIcon:
    """Icon with a muted and a strong state (QIcon.Off / On for checkable buttons)."""
    icon = QIcon()
    for color, state in ((theme.SECONDARY, QIcon.Off), (theme.ACTIVE, QIcon.On)):
        pm = QPixmap(size * 2, size * 2)
        pm.setDevicePixelRatio(2.0)
        pm.fill(Qt.transparent)
        painter = QPainter(pm)
        painter.setRenderHint(QPainter.Antialiasing)
        pen = QPen(QColor(color), 1.5)
        pen.setCapStyle(Qt.RoundCap)
        pen.setJoinStyle(Qt.RoundJoin)
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)
        painter.scale(size / 18.0, size / 18.0)
        _draw(name, painter)
        painter.end()
        icon.addPixmap(pm, QIcon.Normal, state)
    return icon


class NavRail(QWidget):
    """Left rail: one checkable button per view, the account at the bottom."""

    view_requested = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(200)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        box = ui.frame("rail")
        outer.addWidget(box)
        layout = QVBoxLayout(box)
        layout.setContentsMargins(theme.SPACE_2, theme.SPACE_3, theme.SPACE_2, theme.SPACE_2)
        layout.setSpacing(2)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons: Dict[str, QPushButton] = {}
        self.badges: Dict[str, QLabel] = {}
        for key, text in VIEWS:
            btn = QPushButton(text)
            btn.setProperty("role", "nav")
            btn.setCheckable(True)
            btn.setIcon(nav_icon(key))
            btn.setIconSize(QSize(18, 18))
            btn.setCursor(Qt.PointingHandCursor)
            btn.setMinimumHeight(40)
            btn.setObjectName(f"nav_{key}")
            row = QHBoxLayout(btn)
            row.setContentsMargins(0, 0, theme.SPACE_3, 0)
            row.addStretch()
            badge = ui.label("", "muted")
            badge.setAttribute(Qt.WA_TransparentForMouseEvents)
            row.addWidget(badge)
            self.badges[key] = badge
            btn.clicked.connect(lambda _c=False, k=key: self.view_requested.emit(k))
            self.group.addButton(btn)
            self.buttons[key] = btn
            layout.addWidget(btn)
        layout.addStretch()
        account = ui.frame("panel-head")
        account.setProperty("role", "")
        acc = QHBoxLayout(account)
        acc.setContentsMargins(theme.SPACE_2, theme.SPACE_3, theme.SPACE_2, theme.SPACE_1)
        acc.setSpacing(theme.SPACE_2)
        self.avatar = ui.pill("--")
        acc.addWidget(self.avatar)
        col = QVBoxLayout()
        col.setSpacing(0)
        self.account_name = ui.label("Sin sesión", "body")
        self.account_meta = ui.label("Inicia sesión en Cuenta", "muted")
        col.addWidget(self.account_name)
        col.addWidget(self.account_meta)
        acc.addLayout(col, 1)
        layout.addWidget(account)

    def select(self, key: str) -> None:
        btn = self.buttons.get(key)
        if btn is not None and not btn.isChecked():
            btn.setChecked(True)

    def set_badge(self, key: str, text: str) -> None:
        if key in self.badges:
            self.badges[key].setText(text)

    def set_account(self, name: str, meta: str) -> None:
        initials = "".join(part[0] for part in name.split()[:2]).upper() or "--"
        self.avatar.setText(initials)
        self.account_name.setText(name)
        self.account_meta.setText(meta)
