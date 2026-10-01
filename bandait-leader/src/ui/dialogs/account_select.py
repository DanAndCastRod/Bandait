"""Band and setlist pickers for the hub account (which band and show this laptop plays)."""

from __future__ import annotations

from typing import List, Optional

from PySide6.QtCore import Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
)

from src.ui.dialogs.account_login import DIALOG_QSS

EMPTY_SETLIST_WARNING = (
    "Este setlist está vacío: agrega canciones en bandait.releven.cc/hub "
    "(CANCIONES y SETLISTS) y luego Cuenta > Sincronizar ahora."
)


def songs_label(count: int) -> str:
    return "1 canción" if count == 1 else f"{count} canciones"


class _PickerDialog(QDialog):
    def __init__(self, title: str, heading: str, explanation: str, accept_text: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setMinimumSize(460, 360)
        self.setStyleSheet(DIALOG_QSS)
        layout = QVBoxLayout(self)
        layout.setSpacing(10)
        layout.setContentsMargins(20, 20, 20, 20)
        head = QLabel(heading)
        head.setFont(QFont("Inter", 13, QFont.Bold))
        head.setStyleSheet("color: #00FFFF;")
        layout.addWidget(head)
        info = QLabel(explanation)
        info.setObjectName("detail")
        info.setWordWrap(True)
        layout.addWidget(info)
        self.list = QListWidget()
        self.list.setFont(QFont("Inter", 11))
        self.list.itemDoubleClicked.connect(lambda _item: self.accept())
        self.list.currentRowChanged.connect(lambda row: self.accept_btn.setEnabled(row >= 0))
        layout.addWidget(self.list, 1)
        self.empty_label = QLabel("")
        self.empty_label.setObjectName("detail")
        self.empty_label.setWordWrap(True)
        self.empty_label.setVisible(False)
        layout.addWidget(self.empty_label)
        buttons = QHBoxLayout()
        buttons.addStretch()
        cancel = QPushButton("Cancelar")
        cancel.clicked.connect(self.reject)
        buttons.addWidget(cancel)
        self.accept_btn = QPushButton(accept_text)
        self.accept_btn.setEnabled(False)
        self.accept_btn.setStyleSheet(
            "QPushButton { border: 1px solid #00FFFF; color: #00FFFF; }"
            "QPushButton:hover { background: #00FFFF; color: #000000; }"
            "QPushButton:disabled { border-color: #333333; color: #444444; }"
        )
        self.accept_btn.clicked.connect(self.accept)
        buttons.addWidget(self.accept_btn)
        layout.addLayout(buttons)

    def _add(self, text: str, value: str, selected: bool):
        item = QListWidgetItem(text)
        item.setData(Qt.UserRole, value)
        self.list.addItem(item)
        if selected:
            self.list.setCurrentItem(item)

    def _show_empty(self, message: str):
        self.empty_label.setText(message)
        self.empty_label.setVisible(True)

    def selected_value(self) -> Optional[str]:
        item = self.list.currentItem()
        return item.data(Qt.UserRole) if item is not None else None


class BandSelectorDialog(_PickerDialog):
    """``bands``: dicts from ``workspace.band_summaries`` (id, name, genre, songs, setlists)."""

    def __init__(self, bands: List[dict], current: Optional[str] = None, parent=None):
        super().__init__(
            "Elegir banda",
            "¿QUÉ BANDA TOCA ESTE EQUIPO?",
            "Bandait descarga las canciones y setlists de esa banda y los deja en este equipo "
            "para tocar sin Internet. Las canciones de la nube se editan en el hub.",
            "Usar esta banda",
            parent,
        )
        for band in bands:
            genre = f" ({band['genre']})" if band.get("genre") else ""
            text = f"{band['name']}{genre}  -  {band['songs']} canciones, {band['setlists']} setlists"
            self._add(text, band["id"], band["id"] == current)
        if not bands:
            self._show_empty("Tu cuenta no tiene bandas en el hub. Créalas en bandait.releven.cc/hub.")
        elif self.list.currentRow() < 0:
            self.list.setCurrentRow(0)

    def selected_band_id(self) -> Optional[str]:
        return self.selected_value()


class SetlistSelectorDialog(_PickerDialog):
    """``setlists``: dicts from ``db.models.list_cloud_setlists`` (id, name, songs)."""

    def __init__(self, setlists: List[dict], band_name: str = "", current: Optional[str] = None, parent=None):
        super().__init__(
            "Elegir setlist",
            f"SETLIST DEL SHOW{(' - ' + band_name.upper()) if band_name else ''}",
            "El setlist elegido se carga en vivo para los músicos. Si la banda está tocando, "
            "el cambio se aplica al detener.",
            "Cargar en vivo",
            parent,
        )
        self._song_counts = {}
        for setlist in setlists:
            try:
                count = max(0, int(setlist.get("songs") or 0))
            except (TypeError, ValueError):
                count = 0
            self._song_counts[setlist["id"]] = count
            self._add(f"{setlist['name']} ({songs_label(count)})", setlist["id"], setlist["id"] == current)
        # Inline warning for an empty setlist (it can still be chosen).
        self.empty_warning = QLabel(EMPTY_SETLIST_WARNING)
        self.empty_warning.setWordWrap(True)
        self.empty_warning.setStyleSheet(
            "color: #000000; background: #FFAA00; padding: 6px 10px; font-weight: bold;"
        )
        self.empty_warning.setVisible(False)
        layout = self.layout()
        layout.insertWidget(layout.indexOf(self.empty_label) + 1, self.empty_warning)
        self.list.currentRowChanged.connect(lambda _row: self._update_empty_warning())
        if not setlists:
            self._show_empty("Esta banda no tiene setlists en el hub todavía.")
        elif self.list.currentRow() < 0:
            self.list.setCurrentRow(0)
        self._update_empty_warning()

    def _update_empty_warning(self):
        setlist_id = self.selected_value()
        self.empty_warning.setVisible(setlist_id is not None and self._song_counts.get(setlist_id, 0) == 0)

    def selected_is_empty(self) -> bool:
        return not self.empty_warning.isHidden()

    def selected_setlist_id(self) -> Optional[str]:
        return self.selected_value()
