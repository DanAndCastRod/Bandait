"""Vista Banda (Bandait 2.3): integrantes y roles (se editan en el hub), quién está
conectado ahora con su enlace, y el QR para conectar teléfonos.

Los integrantes vienen de la nube (``src.cloud.members.fetch_band_members``); los
conectados, de ``BandaitServer.followers()`` con su ``link_report``. Se cruzan por alias
o nombre sin distinguir mayúsculas; un teléfono que no cruza aparece como "Conectado sin
cuenta". Informativa: nada aquí toca el transporte.
"""

from __future__ import annotations

from typing import Callable, List, Optional

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from src.network.link_report import HEALTH_LABELS, link_health
from src.sync.leader_clock import leader_now_ns
from src.ui import components as ui
from src.ui import theme
from src.ui.dialogs.connect_musicians import qr_pixmap
from src.ui.dialogs.musicians_panel import ROLE_LABELS, _ms

COLUMNS = ["Nombre", "Rol", "Instrumento", "Ahora", "Latencia", "Salida de audio"]
LEAD_ROLES = ("Owner", "MusicDirector")
ROLE_TEXT = {
    "Owner": "Owner", "MusicDirector": "MusicDirector", "Musician": "Musician",
    "Substitute": "Substitute", "SoundEngineer": "SoundEngineer",
}
# Más de esto en la salida de audio del teléfono suele ser Bluetooth: se marca.
BLUETOOTH_MS = 150.0
HEALTH_TAG = {"ok": "ok", "warn": "warn", "bad": "danger", "stale": ""}
QR_PX = 168
QR_PANEL_PX = 252
# A phone whose alias matches no member: the row still shows it, connected without an account.
NO_ACCOUNT = "Sin cuenta"
NO_ACCOUNT_TIP = "Conectado sin cuenta: su alias no coincide con ningún integrante de la banda"


def _key(text) -> str:
    return str(text or "").strip().casefold()


def match_members(members: List[dict], followers: List[dict]) -> List[dict]:
    """Rows for the table: each member with its follower (or None), then the followers
    that matched nobody. Match by alias == name (or e-mail, or its local part), case-insensitive."""
    pool = list(followers or [])
    rows = []
    for m in members or []:
        keys = {k for k in (_key(m.get("name")), _key(m.get("email")),
                            _key(str(m.get("email") or "").split("@")[0])) if k}
        hit = next((f for f in pool if _key(f.get("alias")) in keys), None)
        if hit is not None:
            pool.remove(hit)
        rows.append({"member": m, "follower": hit})
    rows.extend({"member": None, "follower": f} for f in pool)
    return rows


class BandView(QWidget):
    open_hub = Signal()

    def __init__(self, now: Callable[[], int] = leader_now_ns, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("bandView")
        self._now = now
        self._band = ""
        self._members: List[dict] = []
        self._followers: List[dict] = []
        self._follower_url = ""
        self._director_url = ""
        self._shown: List[list] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        header, actions = ui.view_header("Banda", "Sin banda · los roles se cambian en el hub")
        self.lede: QLabel = header.findChild(QLabel, "viewLede")
        self.hub_btn = ui.button("Abrir el hub", "secondary")
        self.hub_btn.clicked.connect(self.open_hub.emit)
        actions.addWidget(self.hub_btn)
        root.addWidget(header)

        body = QHBoxLayout()
        body.setContentsMargins(theme.SPACE_5, theme.SPACE_4, theme.SPACE_5, theme.SPACE_4)
        body.setSpacing(theme.SPACE_4)
        root.addLayout(body, 1)

        members_panel, mbody, mhead = ui.panel("Integrantes")
        mbody.setContentsMargins(0, 0, 0, 0)
        self.connected_label = ui.label("", "muted")
        mhead.addWidget(self.connected_label)
        self.table = QTableWidget(0, len(COLUMNS))
        self.table.setProperty("role", "table")
        self.table.setHorizontalHeaderLabels(COLUMNS)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionMode(QAbstractItemView.NoSelection)
        self.table.setFocusPolicy(Qt.NoFocus)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)
        self.table.verticalHeader().setDefaultSectionSize(40)
        head = self.table.horizontalHeader()
        head.setHighlightSections(False)
        head.setDefaultAlignment(Qt.AlignLeft | Qt.AlignVCenter)
        head.setSectionResizeMode(0, QHeaderView.Stretch)
        for col in range(1, len(COLUMNS)):
            head.setSectionResizeMode(col, QHeaderView.Fixed)  # _fit_columns measures the tags too
        head.setMinimumSectionSize(48)
        for col in (4, 5):
            self.table.horizontalHeaderItem(col).setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
        mbody.addWidget(self.table, 1)
        self.empty = ui.label("", "muted", wrap=True)
        self.empty.setContentsMargins(theme.SPACE_4, 0, theme.SPACE_4, theme.SPACE_3)
        mbody.addWidget(self.empty)
        body.addWidget(members_panel, 1)

        qr_panel, qbody, _ = ui.panel()
        qr_panel.setFixedWidth(QR_PANEL_PX)
        qbody.setContentsMargins(theme.SPACE_4, theme.SPACE_5, theme.SPACE_4, theme.SPACE_5)
        qbody.setSpacing(theme.SPACE_3)
        qbody.addWidget(ui.label("Conectar músicos", "label"), 0, Qt.AlignHCenter)
        self.qr = QLabel()
        self.qr.setProperty("role", "qr")
        self.qr.setAlignment(Qt.AlignCenter)
        self.qr.setFixedSize(QR_PX + 8, QR_PX + 8)
        self.qr.setAccessibleName("Código QR para los músicos")
        qbody.addWidget(self.qr, 0, Qt.AlignHCenter)
        self.url_label = ui.label("", "mono")
        self.url_label.setAlignment(Qt.AlignCenter)
        self.url_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        qbody.addWidget(self.url_label)
        note = ui.label("Escanéalo con la cámara del teléfono, en la misma red Wi-Fi del portátil.", "muted", wrap=True)
        note.setAlignment(Qt.AlignCenter)
        qbody.addWidget(note)
        self.copy_btn = ui.button("Copiar enlace del director", "secondary",
                                  "El director controla el transporte desde su teléfono")
        self.copy_btn.clicked.connect(self._copy_director)
        qbody.addWidget(self.copy_btn, 0, Qt.AlignHCenter)
        self.copied = ui.label("", "muted")
        self.copied.setAlignment(Qt.AlignCenter)
        qbody.addWidget(self.copied)
        qbody.addStretch(1)
        body.addWidget(qr_panel)

        # Sin reportes nuevos un teléfono pasa a SIN DATOS: se recalcula aunque nadie reporte.
        self._timer = QTimer(self)
        self._timer.setInterval(2000)
        self._timer.timeout.connect(self._render)

        self.set_urls("", "")
        self._render()

    # ------------------------------------------------------------------ API
    def set_band(self, name: str) -> None:
        self._band = str(name or "").strip()
        self.lede.setText(f"{self._band or 'Sin banda'} · los roles se cambian en el hub")

    def set_members(self, members: List[dict]) -> None:
        """``[{name, email, role, instrument}]`` (``fetch_band_members``)."""
        self._members = [m for m in members or [] if isinstance(m, dict)]
        self._render()

    def set_followers(self, followers: List[dict]) -> None:
        """``BandaitServer.followers()``: alias, role y, si ya reportó, ``link``."""
        self._followers = [f for f in followers or [] if isinstance(f, dict)]
        if self._followers:
            self._timer.start()
        else:
            self._timer.stop()
        self._render()

    def set_urls(self, follower_url: str, director_url: str) -> None:
        self._follower_url = str(follower_url or "")
        self._director_url = str(director_url or "")
        if self._follower_url:
            self.qr.setPixmap(qr_pixmap(self._follower_url, QR_PX))
            self.url_label.setText(self._follower_url)
        else:
            self.qr.clear()
            self.qr.setText("SIN RED")
            self.url_label.setText("El servidor de red no está activo")
        self.copy_btn.setEnabled(bool(self._director_url))
        self.copied.setText("")

    # ------------------------------------------------------------------ internals
    def _copy_director(self) -> None:
        if self._director_url:
            QApplication.clipboard().setText(self._director_url)
            self.copied.setText("Enlace del director copiado")

    def _rows(self, now: int) -> List[list]:
        """Each row as cells: ("text", text, right) or ("tag", text, kind, tooltip, right)."""
        out = []
        for row in match_members(self._members, self._followers):
            m, f = row["member"], row["follower"]
            if m is not None:
                name = str(m.get("name") or m.get("email") or "")
                role = str(m.get("role") or "Musician")
                role_cell = ("tag", ROLE_TEXT.get(role, role), "act" if role in LEAD_ROLES else "", "", False)
                instrument = str(m.get("instrument") or "") or "—"
            else:
                name = str(f.get("alias") or "Sin nombre")
                role_cell = ("tag", ROLE_LABELS.get(f.get("role"), str(f.get("role") or "Músico")), "", "", False)
                instrument = NO_ACCOUNT
            cells = [("text", name, False), role_cell, ("text", instrument, False)]
            if f is None:
                cells += [("tag", "Sin conexión", "", "", False), ("text", "—", True), ("text", "—", True)]
            else:
                link = f.get("link") or {}
                level, reason = link_health(f.get("link"), now)
                # Color and word together (BUENO / REGULAR / MALO / SIN DATOS), like MusiciansPanel.
                cells.append(("tag", HEALTH_LABELS[level], HEALTH_TAG[level], f"Conectado · {reason}", False))
                cells.append(("text", _ms(link.get("rtt_ms")), True))
                out_ms = link.get("output_latency_ms")
                if isinstance(out_ms, (int, float)) and not isinstance(out_ms, bool) and out_ms > BLUETOOTH_MS:
                    cells.append(("tag", f"{_ms(out_ms)} · BT", "warn",
                                  "Latencia de salida alta: suele ser Bluetooth. Se compensa, pero conviene cable.",
                                  True))
                else:
                    cells.append(("text", _ms(out_ms), True))
            out.append(cells)
        return out

    def _render(self) -> None:
        rows = self._rows(self._now())
        connected = len(self._followers)
        self.connected_label.setText(f"{connected} conectado{'s' if connected != 1 else ''} ahora")
        if not rows:
            self.empty.setText("Sin integrantes todavía: inicia sesión y elige una banda compartida, "
                               "o conecta un teléfono con el QR.")
        self.empty.setVisible(not rows)
        if rows == self._shown:
            return  # the 2 s refresh usually changes nothing: keep the widgets
        self._shown = rows
        for r in range(len(rows), self.table.rowCount()):
            for c in range(len(COLUMNS)):
                self._drop_widget(r, c)
        self.table.setRowCount(len(rows))
        for r, cells in enumerate(rows):
            for c, cell in enumerate(cells):
                if cell[0] == "text":
                    self._text(r, c, cell[1], right=cell[2])
                else:
                    _kind, text, tag_kind, tooltip, right = cell
                    widget = ui.tag(text, tag_kind)
                    if tooltip:
                        widget.setToolTip(tooltip)
                    self._widget(r, c, widget, right=right)
        self._fit_columns()

    def _fit_columns(self) -> None:
        """Width of each column but the name: header, texts and tag widgets (ResizeToContents
        measures cell widgets before the style sheet sizes them and clips the tags)."""
        head = self.table.horizontalHeader()
        fm = self.table.fontMetrics()
        # The QSS ::item padding (SPACE_2 per side) shrinks the cell rect for texts and
        # widgets alike; texts also keep the style's own margin before eliding.
        item_pad = 2 * theme.SPACE_2
        text_pad = item_pad + theme.SPACE_3
        for c in range(1, len(COLUMNS)):
            width = head.sectionSizeHint(c)
            for r in range(self.table.rowCount()):
                widget = self.table.cellWidget(r, c)
                if widget is not None:
                    width = max(width, widget.sizeHint().width() + item_pad)
                else:
                    item = self.table.item(r, c)
                    if item is not None:
                        width = max(width, fm.horizontalAdvance(item.text()) + text_pad)
            self.table.setColumnWidth(c, width)

    def _drop_widget(self, row: int, col: int) -> None:
        old = self.table.cellWidget(row, col)
        if old is not None:
            old.hide()  # deleteLater runs on the next loop pass: never paint it meanwhile
            self.table.removeCellWidget(row, col)

    def _text(self, row: int, col: int, text: str, right: bool = False) -> None:
        self._drop_widget(row, col)
        item = QTableWidgetItem(text)
        item.setTextAlignment((Qt.AlignRight if right else Qt.AlignLeft) | Qt.AlignVCenter)
        item.setData(Qt.UserRole, text)
        if col == 0:
            item.setToolTip(text)  # the name column is the one that elides on small screens
        elif text == NO_ACCOUNT:
            item.setToolTip(NO_ACCOUNT_TIP)
        self.table.setItem(row, col, item)

    def cell_text(self, row: int, col: int) -> str:
        """What a cell shows (text item or tag), for tests and accessibility."""
        item = self.table.item(row, col)
        return str(item.data(Qt.UserRole) or "") if item is not None else ""

    def _widget(self, row: int, col: int, widget: QLabel, right: bool = False) -> None:
        self._drop_widget(row, col)
        item = QTableWidgetItem("")  # the tag draws the text; the item keeps it for cell_text
        item.setData(Qt.UserRole, widget.text())
        item.setData(Qt.AccessibleTextRole, widget.text())
        self.table.setItem(row, col, item)
        holder = QWidget()
        holder.setProperty("role", "bare")
        lay = QHBoxLayout(holder)
        lay.setContentsMargins(0, 0, 0, 0)
        if right:
            lay.addStretch()
        lay.addWidget(widget, 0, Qt.AlignVCenter)
        if not right:
            lay.addStretch()
        widget.ensurePolished()  # QSS padding and font count for ResizeToContents
        holder.ensurePolished()
        self.table.setCellWidget(row, col, holder)
