"""Editors of the leader library: song, setlist and event.

They only collect and validate fields; ``src/db/library_ops`` writes them. A
validation error is shown inside the dialog and the dialog stays open, so nothing
the user typed is lost.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Callable, List, Optional, Sequence, Tuple

from PySide6.QtCore import QDate, QDateTime, QTime, Qt
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QComboBox,
    QDateTimeEdit,
    QDialog,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPlainTextEdit,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
)

from src.db.library_ops import (
    BPM_RANGE,
    METERS,
    GigFields,
    LibraryEditError,
    SongFields,
    format_duration,
    parse_duration,
    parse_meter,
    validate_setlist_name,
    validate_song,
)

CHORDPRO_HINT = (
    "Acordes entre corchetes, justo antes de la sílaba: [Am]Cruzamos la [F]noche. "
    "Cada sección en su propia línea: [Intro], [Estrofa 1], [Coro]."
)


class _EditorDialog(QDialog):
    """Title, form, error line and Cancelar / <verb> buttons."""

    def __init__(self, title: str, heading: str, accept_text: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setModal(True)
        self._layout = QVBoxLayout(self)
        self._layout.setSpacing(12)
        self._layout.setContentsMargins(20, 20, 20, 20)
        head = QLabel(heading)
        head.setFont(QFont("Inter", 13, QFont.Bold))
        head.setStyleSheet("color: #00FFFF; background: transparent;")
        self._layout.addWidget(head)
        self.form = QFormLayout()
        self.form.setSpacing(10)
        self.form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self._layout.addLayout(self.form)
        self.error_label = QLabel("")
        self.error_label.setObjectName("error")
        self.error_label.setStyleSheet("color: #FF5A4F; background: transparent;")
        self.error_label.setWordWrap(True)
        self.error_label.setVisible(False)
        self._buttons = QHBoxLayout()
        self._buttons.addStretch()
        self.cancel_btn = QPushButton("Cancelar")
        self.cancel_btn.clicked.connect(self.reject)
        self._buttons.addWidget(self.cancel_btn)
        self.save_btn = QPushButton(accept_text)
        self.save_btn.setObjectName("primary")
        self.save_btn.setDefault(True)
        self.save_btn.clicked.connect(self.try_accept)
        self._buttons.addWidget(self.save_btn)

    def _finish_layout(self):
        self._layout.addWidget(self.error_label)
        self._layout.addLayout(self._buttons)

    def show_error(self, message: str):
        self.error_label.setText(message)
        self.error_label.setVisible(bool(message))

    def _validate(self):  # pragma: no cover - overridden
        return None

    def try_accept(self) -> bool:
        """Validate; on error keep the dialog open with the message."""
        try:
            self._validate()
        except LibraryEditError as e:
            self.show_error(str(e))
            return False
        self.show_error("")
        self.accept()
        return True


def _hint(text: str) -> QLabel:
    label = QLabel(text)
    label.setWordWrap(True)
    label.setStyleSheet("color: #8A8A8A; background: transparent; font-size: 12px;")
    return label


class SongEditorDialog(_EditorDialog):
    """New or local song. ``fields`` None = new song."""

    def __init__(self, fields: Optional[SongFields] = None, parent=None):
        editing = fields is not None
        super().__init__(
            "Editar canción" if editing else "Nueva canción",
            "EDITAR CANCIÓN" if editing else "NUEVA CANCIÓN",
            "Guardar canción",
            parent,
        )
        self.setMinimumSize(620, 600)
        fields = fields or SongFields(title="")

        self.title_edit = QLineEdit(fields.title)
        self.title_edit.setPlaceholderText("Nombre de la canción")
        self.form.addRow("Título *", self.title_edit)
        self.artist_edit = QLineEdit(fields.artist)
        self.artist_edit.setPlaceholderText("Artista o nota del arreglo")
        self.form.addRow("Artista", self.artist_edit)

        row = QHBoxLayout()
        self.bpm_spin = QSpinBox()
        self.bpm_spin.setRange(*BPM_RANGE)
        self.bpm_spin.setSuffix(" BPM")
        self.bpm_spin.setValue(max(BPM_RANGE[0], min(BPM_RANGE[1], int(fields.bpm or 120))))
        row.addWidget(self.bpm_spin)
        self.meter_combo = QComboBox()
        self.meter_combo.addItems(METERS)
        meter = f"{fields.beats_per_bar}/{fields.beat_unit}"
        if self.meter_combo.findText(meter) < 0:
            self.meter_combo.addItem(meter)
        self.meter_combo.setCurrentText(meter)
        self.meter_combo.setToolTip("Compás")
        row.addWidget(self.meter_combo)
        row.addStretch()
        self.form.addRow("Tempo y compás", row)

        row = QHBoxLayout()
        self.key_edit = QLineEdit(fields.key)
        self.key_edit.setPlaceholderText("D, Am, Re...")
        self.key_edit.setMaximumWidth(160)
        row.addWidget(self.key_edit)
        row.addWidget(QLabel("Duración"))
        self.duration_edit = QLineEdit(format_duration(fields.duration_seconds))
        self.duration_edit.setPlaceholderText("mm:ss")
        self.duration_edit.setMaximumWidth(90)
        self.duration_edit.setToolTip("Duración, por ejemplo 3:45")
        row.addWidget(self.duration_edit)
        row.addStretch()
        self.form.addRow("Tonalidad", row)

        self.text_edit = QPlainTextEdit(fields.text)
        self.text_edit.setFont(QFont("JetBrains Mono", 11))
        self.text_edit.setPlaceholderText(
            "[Intro]\n[Am]  [F]  [C]  [G]\n\n[Estrofa 1]\n[Am]Cruzamos la [F]noche sin [C]mirar a[G]trás"
        )
        self._layout.addWidget(QLabel("Letra y acordes (ChordPro)"))
        self._layout.addWidget(self.text_edit, 1)
        self._layout.addWidget(_hint(CHORDPRO_HINT))
        self._finish_layout()
        self.title_edit.setFocus()

    def fields(self) -> SongFields:
        """Raises LibraryEditError when a field is invalid."""
        beats, unit = parse_meter(self.meter_combo.currentText())
        return validate_song(SongFields(
            title=self.title_edit.text(), artist=self.artist_edit.text(), bpm=self.bpm_spin.value(),
            key=self.key_edit.text(), beats_per_bar=beats, beat_unit=unit,
            duration_seconds=parse_duration(self.duration_edit.text()), text=self.text_edit.toPlainText(),
        ))

    def _validate(self):
        return self.fields()


class SetlistEditorDialog(_EditorDialog):
    """Name and ordered songs of a local setlist.

    ``library``: (song_id, label) of every song that can be added, in display order.
    ``selected``: song ids already in the setlist, in order."""

    def __init__(self, library: Sequence[Tuple[str, str]], name: str = "",
                 selected: Sequence[str] = (), editing: bool = False, parent=None):
        super().__init__(
            "Editar setlist" if editing else "Nuevo setlist",
            "EDITAR SETLIST" if editing else "NUEVO SETLIST",
            "Guardar setlist",
            parent,
        )
        self.setMinimumSize(760, 540)
        self._labels = {sid: label for sid, label in library}
        self._order = [sid for sid, _label in library]

        self.name_edit = QLineEdit(name)
        self.name_edit.setPlaceholderText("Por ejemplo: Viernes 21:00")
        self.form.addRow("Nombre *", self.name_edit)

        lists = QHBoxLayout()
        left = QVBoxLayout()
        left.addWidget(QLabel("Biblioteca"))
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("Buscar canción...")
        self.search_edit.textChanged.connect(self._refresh_available)
        left.addWidget(self.search_edit)
        self.available_list = QListWidget()
        self.available_list.setSelectionMode(QListWidget.ExtendedSelection)
        self.available_list.itemDoubleClicked.connect(lambda _item: self.add_selected())
        left.addWidget(self.available_list, 1)
        lists.addLayout(left, 1)

        middle = QVBoxLayout()
        middle.addStretch()
        self.add_btn = QPushButton("Agregar >")
        self.add_btn.clicked.connect(self.add_selected)
        middle.addWidget(self.add_btn)
        self.remove_btn = QPushButton("< Quitar")
        self.remove_btn.clicked.connect(self.remove_selected)
        middle.addWidget(self.remove_btn)
        middle.addStretch()
        lists.addLayout(middle)

        right = QVBoxLayout()
        self.count_label = QLabel("")
        right.addWidget(self.count_label)
        self.setlist_list = QListWidget()
        self.setlist_list.itemDoubleClicked.connect(lambda _item: self.remove_selected())
        right.addWidget(self.setlist_list, 1)
        order = QHBoxLayout()
        self.up_btn = QPushButton("Subir")
        self.up_btn.clicked.connect(lambda: self.move_selected(-1))
        order.addWidget(self.up_btn)
        self.down_btn = QPushButton("Bajar")
        self.down_btn.clicked.connect(lambda: self.move_selected(1))
        order.addWidget(self.down_btn)
        right.addLayout(order)
        lists.addLayout(right, 1)
        self._layout.addLayout(lists, 1)
        self._layout.addWidget(_hint(
            "Doble clic agrega o quita. El orden de la derecha es el orden del show. "
            "Las canciones que ya estaban conservan su conteo y su forma de entrada."
        ))
        self._finish_layout()

        for sid in selected:
            if sid in self._labels:
                self._append(sid)
        self._refresh_available()
        self.name_edit.setFocus()

    def _append(self, sid: str):
        item = QListWidgetItem(self._labels.get(sid, sid))
        item.setData(Qt.UserRole, sid)
        self.setlist_list.addItem(item)

    def song_ids(self) -> List[str]:
        return [self.setlist_list.item(i).data(Qt.UserRole) for i in range(self.setlist_list.count())]

    def _refresh_available(self):
        query = (self.search_edit.text() or "").strip().lower()
        chosen = set(self.song_ids())
        self.available_list.clear()
        for sid in self._order:
            label = self._labels[sid]
            if sid in chosen or (query and query not in label.lower()):
                continue
            item = QListWidgetItem(label)
            item.setData(Qt.UserRole, sid)
            self.available_list.addItem(item)
        n = self.setlist_list.count()
        self.count_label.setText("En el setlist: 1 canción" if n == 1 else f"En el setlist: {n} canciones")

    def add_selected(self):
        items = self.available_list.selectedItems()
        if not items and self.available_list.currentItem() is not None:
            items = [self.available_list.currentItem()]
        for item in items:
            self._append(item.data(Qt.UserRole))
        self._refresh_available()

    def remove_selected(self):
        row = self.setlist_list.currentRow()
        if row >= 0:
            self.setlist_list.takeItem(row)
            self._refresh_available()

    def move_selected(self, delta: int):
        row = self.setlist_list.currentRow()
        target = row + delta
        if row < 0 or not 0 <= target < self.setlist_list.count():
            return
        item = self.setlist_list.takeItem(row)
        self.setlist_list.insertItem(target, item)
        self.setlist_list.setCurrentRow(target)

    def setlist_name(self) -> str:
        return validate_setlist_name(self.name_edit.text())

    def _validate(self):
        return self.setlist_name()


class GigEditorDialog(_EditorDialog):
    """New or existing event. ``setlists``: (setlist_id, name) to choose from."""

    def __init__(self, setlists: Sequence[Tuple[str, str]], fields: Optional[GigFields] = None,
                 parent=None, now: Optional[Callable[[], datetime]] = None):
        editing = fields is not None
        super().__init__(
            "Editar evento" if editing else "Nuevo evento",
            "EDITAR EVENTO" if editing else "NUEVO EVENTO",
            "Guardar evento",
            parent,
        )
        self.setMinimumSize(520, 420)
        if fields is None:
            start = (now or datetime.now)() + timedelta(days=1)
            fields = GigFields(name="", date=start.replace(hour=21, minute=0, second=0, microsecond=0))

        self.name_edit = QLineEdit(fields.name)
        self.name_edit.setPlaceholderText("Por ejemplo: Bar La Ruta")
        self.form.addRow("Nombre *", self.name_edit)
        d = fields.date
        self.date_edit = QDateTimeEdit(QDateTime(QDate(d.year, d.month, d.day), QTime(d.hour, d.minute)))
        self.date_edit.setCalendarPopup(True)
        self.date_edit.setDisplayFormat("dd/MM/yyyy HH:mm")
        self.form.addRow("Fecha y hora *", self.date_edit)
        self.venue_edit = QLineEdit(fields.venue)
        self.venue_edit.setPlaceholderText("Lugar y ciudad")
        self.form.addRow("Lugar", self.venue_edit)
        self.setlist_combo = QComboBox()
        self.setlist_combo.addItem("Sin setlist", None)
        for sid, name in setlists:
            self.setlist_combo.addItem(name, sid)
        index = self.setlist_combo.findData(fields.setlist_id) if fields.setlist_id else 0
        self.setlist_combo.setCurrentIndex(max(0, index))
        self.form.addRow("Setlist", self.setlist_combo)
        self.notes_edit = QPlainTextEdit(fields.notes)
        self.notes_edit.setPlaceholderText("Prueba de sonido, contacto, backline...")
        self.form.addRow("Notas", self.notes_edit)
        self._finish_layout()
        self.name_edit.setFocus()

    def fields(self) -> GigFields:
        name = (self.name_edit.text() or "").strip()
        if not name:
            raise LibraryEditError("Escribe el nombre del evento.")
        return GigFields(
            name=name, date=self.date_edit.dateTime().toPython(), venue=self.venue_edit.text(),
            setlist_id=self.setlist_combo.currentData(), notes=self.notes_edit.toPlainText(),
        )

    def _validate(self):
        return self.fields()
