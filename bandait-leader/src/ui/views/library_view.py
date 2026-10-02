"""
Bandait DAW — Vista de Biblioteca
Canciones, setlists y eventos del líder, con persistencia SQLite real.

Cada canción, setlist y evento muestra su origen (NUBE / LOCAL / DEMO). Con una
banda del hub elegida, los datos de demostración se ocultan salvo que se pida verlos.
Lo del hub es de solo lectura aquí: se edita en el hub y llega al sincronizar.
Lo local y lo DEMO se crea, edita y borra aquí (``src/db/library_ops``).

Ningún botón visible queda sin función: Editar, Duplicar y Eliminar se activan
al elegir una fila, y con una fila del hub explican dónde se edita.
"""

import os
from typing import Callable, List, Optional

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QCheckBox,
    QTableWidget, QTableWidgetItem, QLineEdit, QComboBox, QDialog,
    QTabWidget, QFrame, QHeaderView, QMessageBox, QFileDialog
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont, QColor

from src.core.paths import get_db_path
from src.db import library_ops as ops
from src.db.models import init_db, load_setlist_entries, Song, Setlist
from src.infrastructure.parsers.lrc_parser import LRCParser
from src.infrastructure.parsers.chordpro_parser import ChordProParser
from src.ui.dialogs.library_editors import GigEditorDialog, SetlistEditorDialog, SongEditorDialog

# origin -> (badge text, color)
ORIGIN_BADGES = {
    "cloud": ("NUBE", "#00FFFF"),
    "local": ("LOCAL", "#9A9A9A"),
    "demo": ("DEMO", "#FFAA00"),
}
CLOUD_READ_ONLY_MESSAGE = ops.CLOUD_SONG_EDIT
BUSY_MESSAGE = "La banda está tocando el setlist en vivo: detenla antes de {what}."
LOAD_LIVE_TIP = (
    "Enviar este setlist al transporte (CUE y saltos en todos los dispositivos). "
    "Si la banda está tocando, se carga al detenerla."
)
DUPLICATE_TIP = "Crear una copia local, editable en este equipo (también de un setlist del hub)"
GIG_FILTERS = ("Todos", "Próximos", "Hoy", "Pasados")
_WEEKDAYS = ("lun", "mar", "mié", "jue", "vie", "sáb", "dom")
_GIG_COLORS = {ops.GIG_TODAY: "#CCFF00", ops.GIG_UPCOMING: "#00FFFF", ops.GIG_PAST: "#666666"}


def song_origin(song) -> str:
    source = getattr(song, "source", None) or "local"
    return source if source in ("cloud", "demo") else "local"


def setlist_origin(setlist) -> str:
    if getattr(setlist, "cloud_id", None):
        return "cloud"  # imported before setlists.source existed: cloud_id decides
    return "demo" if getattr(setlist, "source", None) == "demo" else "local"


def gig_origin(gig) -> str:
    return "demo" if getattr(gig, "source", None) == "demo" else "local"


def format_gig_date(date) -> str:
    if date is None:
        return "—"
    return f"{_WEEKDAYS[date.weekday()]} {date:%d/%m/%Y %H:%M}"


def _button(text: str, kind: str = "", tooltip: str = "") -> QPushButton:
    btn = QPushButton(text)
    if kind:
        btn.setObjectName(kind)
    if tooltip:
        btn.setToolTip(tooltip)
    return btn


class LibraryView(QWidget):
    """Biblioteca musical con canciones, setlists y eventos persistentes."""

    song_selected = Signal(int)
    setlist_selected = Signal(str)  # setlist id (solo muestra detalle)
    setlist_activated = Signal(str)  # setlist id pedido como setlist en vivo
    import_requested = Signal(str)
    demo_remove_requested = Signal()  # la ventana confirma, respalda y borra
    song_saved = Signal(str)  # song id creada o editada
    song_removed = Signal(str)
    setlist_saved = Signal(str)  # setlist id creado, editado o duplicado
    setlist_removed = Signal(str)
    status_message = Signal(str)  # texto para la barra de estado

    def __init__(self, parent=None):
        super().__init__(parent)
        self._db_session = None
        self._setlist_ids: list = []
        self._setlist_meta: dict = {}  # id -> {"name", "origin", "band_cloud_id", "songs"}
        self._song_ids: list = []
        self._song_origins: list = []
        self._gig_ids: list = []
        self._gig_rows: dict = {}  # id -> {"name", "setlist_id", "origin"}
        self._has_demo_gigs = False
        self._song_query = ""
        self._setlist_query = ""
        self._cloud_mode = False  # signed in with a hub band: demo hidden by default
        self._active_setlist_id = None
        self._transport_busy: Callable[[], bool] = lambda: False
        self._setup_db()
        self._setup_ui()
        self.reload()

    def _setup_db(self):
        """Abrir SQLite en get_db_path() (respeta BANDAIT_DB).

        init_db aplica migraciones aditivas con respaldo previo; nunca borra la
        base del usuario."""
        try:
            Session = init_db(get_db_path())
            self._db_session = Session()
        except Exception as e:
            print(f"[DB] No se pudo abrir la base de datos: {e}")
            self._db_session = None

    def set_transport_busy(self, busy: Callable[[], bool]):
        """``busy()`` True mientras la banda toca: no se borra lo que está sonando."""
        self._transport_busy = busy

    def reload(self):
        """Releer todo desde la base (otra conexión pudo escribir: sincronización)."""
        if self._db_session is not None:
            try:
                self._db_session.expire_all()
            except Exception as e:
                print(f"[DB] No se pudo refrescar la sesión: {e}")
        self._load_songs_from_db()
        self._load_setlists_from_db()
        self._load_gigs_from_db()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)

        # === TÍTULO ===
        header = QHBoxLayout()
        title = QLabel("BIBLIOTECA MUSICAL")
        title.setFont(QFont("Inter", 18, QFont.Bold))
        title.setStyleSheet("color: #F0F0F0;")
        header.addWidget(title)
        header.addStretch()

        # Datos de demostración: los controles solo aparecen cuando existen.
        self.show_demo_check = QCheckBox("Mostrar demostración")
        self.show_demo_check.setToolTip("Mostrar las canciones, setlists y eventos marcados DEMO")
        self.show_demo_check.setStyleSheet("color: #FFAA00;")
        self.show_demo_check.toggled.connect(lambda _on: self._on_demo_visibility())
        self.show_demo_check.setVisible(False)
        header.addWidget(self.show_demo_check)

        self.remove_demo_btn = _button(
            "Quitar datos de demostración", "danger",
            "Borra solo lo marcado DEMO (antes guarda una copia de la base). Lo del hub y lo tuyo no se toca.",
        )
        self.remove_demo_btn.clicked.connect(self.demo_remove_requested.emit)
        self.remove_demo_btn.setVisible(False)
        header.addWidget(self.remove_demo_btn)
        layout.addLayout(header)

        # === TABS ===
        self.tabs = QTabWidget()
        self.tabs.setFont(QFont("Inter", 12))
        self.tabs.addTab(self._create_songs_tab(), "Canciones")
        self.tabs.addTab(self._create_setlists_tab(), "Setlists")
        self.tabs.addTab(self._create_events_tab(), "Eventos")
        layout.addWidget(self.tabs)

    def _create_songs_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(12)
        layout.setContentsMargins(12, 12, 12, 12)

        toolbar = QHBoxLayout()
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("Buscar canción...")
        self.search_input.setMinimumWidth(200)
        self.search_input.textChanged.connect(self._on_search_songs)
        toolbar.addWidget(self.search_input)
        toolbar.addStretch()

        self.import_btn = _button("Importar archivo...", "", "Importar un archivo LRC, ChordPro o de audio")
        self.import_btn.clicked.connect(self._on_import)
        toolbar.addWidget(self.import_btn)
        self.new_song_btn = _button("Nueva canción", "primary", "Escribir una canción con su letra y acordes")
        self.new_song_btn.clicked.connect(self.new_song)
        toolbar.addWidget(self.new_song_btn)
        self.edit_song_btn = _button("Editar")
        self.edit_song_btn.clicked.connect(self.edit_song)
        toolbar.addWidget(self.edit_song_btn)
        self.delete_song_btn = _button("Eliminar", "danger")
        self.delete_song_btn.clicked.connect(self.delete_song)
        toolbar.addWidget(self.delete_song_btn)
        layout.addLayout(toolbar)

        self.songs_table = QTableWidget()
        self.songs_table.setColumnCount(6)
        self.songs_table.setHorizontalHeaderLabels([
            "Título", "Artista", "BPM", "Tonalidad", "Duración", "Origen"
        ])
        self.songs_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.songs_table.horizontalHeader().setSectionResizeMode(2, QHeaderView.Fixed)
        self.songs_table.horizontalHeader().setSectionResizeMode(3, QHeaderView.Fixed)
        self.songs_table.setColumnWidth(2, 60)
        self.songs_table.setColumnWidth(3, 80)
        self.songs_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.songs_table.setSelectionMode(QTableWidget.SingleSelection)
        self.songs_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.songs_table.itemSelectionChanged.connect(self._on_song_selected)
        self.songs_table.cellDoubleClicked.connect(lambda _r, _c: self.edit_song())
        self.songs_table.setMinimumHeight(300)
        layout.addWidget(self.songs_table)

        self.song_info = QLabel("Selecciona una canción para ver detalles")
        self.song_info.setFont(QFont("Inter", 11))
        self.song_info.setStyleSheet("color: #666666; padding: 8px;")
        self.song_info.setWordWrap(True)
        layout.addWidget(self.song_info)
        self._update_song_actions()
        return widget

    def _create_setlists_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(12)
        layout.setContentsMargins(12, 12, 12, 12)

        toolbar = QHBoxLayout()
        self.setlist_search = QLineEdit()
        self.setlist_search.setPlaceholderText("Buscar setlist...")
        self.setlist_search.textChanged.connect(self._on_search_setlists)
        toolbar.addWidget(self.setlist_search)
        toolbar.addStretch()
        self.new_setlist_btn = _button("Nuevo setlist", "primary", "Armar un setlist con canciones de la biblioteca")
        self.new_setlist_btn.clicked.connect(self.new_setlist)
        toolbar.addWidget(self.new_setlist_btn)
        layout.addLayout(toolbar)

        self.setlists_table = QTableWidget()
        self.setlists_table.setColumnCount(5)
        self.setlists_table.setHorizontalHeaderLabels([
            "Nombre", "Canciones", "Duración", "Origen", "Estado"
        ])
        self.setlists_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.setlists_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.setlists_table.setSelectionMode(QTableWidget.SingleSelection)
        self.setlists_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.setlists_table.itemSelectionChanged.connect(self._on_setlist_selected)
        self.setlists_table.cellDoubleClicked.connect(lambda _r, _c: self._on_load_setlist())
        layout.addWidget(self.setlists_table)

        detail_frame = QFrame()
        detail_frame.setObjectName("panel")
        detail_layout = QVBoxLayout(detail_frame)
        self.setlist_detail = QLabel("Selecciona un setlist")
        self.setlist_detail.setFont(QFont("Inter", 12))
        self.setlist_detail.setStyleSheet("color: #F0F0F0;")
        self.setlist_detail.setMinimumHeight(44)  # name + song count, never clipped
        detail_layout.addWidget(self.setlist_detail)

        actions = QHBoxLayout()
        self.load_setlist_btn = _button("Cargar en vivo", "success", LOAD_LIVE_TIP)
        self.load_setlist_btn.clicked.connect(self._on_load_setlist)
        actions.addWidget(self.load_setlist_btn)
        self.edit_setlist_btn = _button("Editar")
        self.edit_setlist_btn.clicked.connect(self.edit_setlist)
        actions.addWidget(self.edit_setlist_btn)
        self.duplicate_setlist_btn = _button("Duplicar", "", DUPLICATE_TIP)
        self.duplicate_setlist_btn.clicked.connect(self.duplicate_setlist)
        actions.addWidget(self.duplicate_setlist_btn)
        actions.addStretch()
        self.delete_setlist_btn = _button("Eliminar", "danger")
        self.delete_setlist_btn.clicked.connect(self.delete_setlist)
        actions.addWidget(self.delete_setlist_btn)
        detail_layout.addLayout(actions)
        layout.addWidget(detail_frame)
        self._update_setlist_actions()
        return widget

    def _create_events_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(12)
        layout.setContentsMargins(12, 12, 12, 12)

        toolbar = QHBoxLayout()
        self.event_filter = QComboBox()
        self.event_filter.addItems(GIG_FILTERS)
        self.event_filter.setToolTip("Mostrar todos los eventos, los próximos, los de hoy o los pasados")
        self.event_filter.currentIndexChanged.connect(lambda _i: self._load_gigs_from_db())
        toolbar.addWidget(self.event_filter)
        toolbar.addStretch()
        self.new_gig_btn = _button("Nuevo evento", "primary", "Agendar un show o un ensayo con su setlist")
        self.new_gig_btn.clicked.connect(self.new_gig)
        toolbar.addWidget(self.new_gig_btn)
        layout.addLayout(toolbar)

        self.events_table = QTableWidget()
        self.events_table.setColumnCount(6)
        self.events_table.setHorizontalHeaderLabels([
            "Fecha", "Nombre", "Lugar", "Setlist", "Estado", "Origen"
        ])
        self.events_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.events_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.events_table.setSelectionMode(QTableWidget.SingleSelection)
        self.events_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.events_table.itemSelectionChanged.connect(self._update_gig_actions)
        self.events_table.cellDoubleClicked.connect(lambda _r, _c: self.edit_gig())
        layout.addWidget(self.events_table)

        actions = QHBoxLayout()
        self.load_gig_btn = _button(
            "Cargar su setlist en vivo", "success", "Enviar el setlist de este evento al transporte"
        )
        self.load_gig_btn.clicked.connect(self.load_gig_setlist)
        actions.addWidget(self.load_gig_btn)
        self.edit_gig_btn = _button("Editar")
        self.edit_gig_btn.clicked.connect(self.edit_gig)
        actions.addWidget(self.edit_gig_btn)
        actions.addStretch()
        self.delete_gig_btn = _button("Eliminar", "danger")
        self.delete_gig_btn.clicked.connect(self.delete_gig)
        actions.addWidget(self.delete_gig_btn)
        layout.addLayout(actions)

        summary = QFrame()
        summary.setObjectName("panel")
        summary_layout = QHBoxLayout(summary)
        self.total_events = QLabel("Total: 0")
        self.total_events.setStyleSheet("color: #666666;")
        summary_layout.addWidget(self.total_events)
        self.upcoming_events = QLabel("Próximos: 0")
        self.upcoming_events.setStyleSheet("color: #00FFFF;")
        summary_layout.addWidget(self.upcoming_events)
        summary_layout.addStretch()
        layout.addWidget(summary)
        self._update_gig_actions()
        return widget

    # === MENSAJES (un solo lugar: las pruebas los sustituyen) ===
    def _confirm(self, title: str, text: str, verb: str) -> bool:
        """Confirmación con el verbo en el botón; el foco empieza en Cancelar."""
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Warning)
        box.setWindowTitle(title)
        box.setText(text)
        yes = box.addButton(verb, QMessageBox.DestructiveRole)
        cancel = box.addButton("Cancelar", QMessageBox.RejectRole)
        box.setDefaultButton(cancel)
        box.setEscapeButton(cancel)
        box.exec()
        return box.clickedButton() is yes

    def _inform(self, title: str, text: str):
        QMessageBox.information(self, title, text)

    def _fail(self, what: str, error: Exception):
        message = str(error) if isinstance(error, ops.LibraryEditError) else f"No se pudo {what}: {error}"
        QMessageBox.warning(self, "Biblioteca", message)

    def _run_dialog(self, dialog: QDialog) -> bool:
        return dialog.exec() == QDialog.Accepted

    # === DB OPERATIONS ===
    def _load_songs_from_db(self):
        """Cargar canciones desde SQLite."""
        if not self._db_session:
            return
        selected = self.selected_song_id()
        try:
            songs = self._db_session.query(Song).all()
            self.songs_table.setRowCount(len(songs))
            self._song_ids = [song.id for song in songs]
            self._song_origins = [song_origin(song) for song in songs]
            for i, song in enumerate(songs):
                self.songs_table.setItem(i, 0, self._create_item(song.title))
                self.songs_table.setItem(i, 1, self._create_item(song.artist or ""))
                self.songs_table.setItem(i, 2, self._create_bpm_item(str(song.bpm)))
                self.songs_table.setItem(i, 3, self._create_item(song.key or ""))
                seconds = song.duration_seconds or 0
                duration_str = f"{int(seconds // 60)}:{int(seconds % 60):02d}"
                self.songs_table.setItem(i, 4, self._create_item(duration_str))
                self.songs_table.setItem(i, 5, self._create_badge_item(self._song_origins[i]))
        except Exception as e:
            print(f"[DB] Error cargando canciones: {e}")
            self.songs_table.setRowCount(0)
            self._song_ids = []
            self._song_origins = []
        self._apply_filters()
        if selected:
            self.select_song(selected)
        self._update_song_actions()

    def _load_setlists_from_db(self):
        """Cargar setlists desde SQLite."""
        if not self._db_session:
            return
        selected = self.selected_setlist_id()
        try:
            setlists = self._db_session.query(Setlist).all()
        except Exception as e:
            print(f"[DB] Error cargando setlists: {e}")
            setlists = []
        self._setlist_ids = [sl.id for sl in setlists]
        self._setlist_meta = {}
        self.setlists_table.setRowCount(len(setlists))
        for i, sl in enumerate(setlists):
            n_songs = len(sl.songs) if sl.songs else 0
            origin = setlist_origin(sl)
            total = sum(float(s.duration_seconds or 0) for s in (sl.songs or []))
            self._setlist_meta[sl.id] = {
                "name": sl.name or "", "origin": origin, "band_cloud_id": sl.band_cloud_id, "songs": n_songs,
            }
            self.setlists_table.setItem(i, 0, self._create_item(sl.name))
            self.setlists_table.setItem(i, 1, self._create_item(str(n_songs)))
            self.setlists_table.setItem(i, 2, self._create_item(ops.format_duration(total) or "—"))
            self.setlists_table.setItem(i, 3, self._create_badge_item(origin))
            self.setlists_table.setItem(i, 4, self._create_item(""))
        self._refresh_active_marker()
        self._apply_filters()
        if selected:
            self.select_setlist(selected)
        self._update_setlist_actions()

    def _load_gigs_from_db(self):
        """Cargar eventos, con el filtro elegido y sin lo DEMO cuando está oculto."""
        if not self._db_session or not hasattr(self, "events_table"):
            return
        selected = self.selected_gig_id()
        try:
            gigs = ops.list_gigs(self._db_session)
        except Exception as e:
            print(f"[DB] Error cargando eventos: {e}")
            gigs = []
        self._has_demo_gigs = any(gig_origin(g) == "demo" for g in gigs)
        wanted = {0: None, 1: {ops.GIG_TODAY, ops.GIG_UPCOMING}, 2: {ops.GIG_TODAY}, 3: {ops.GIG_PAST}}.get(
            self.event_filter.currentIndex()
        )
        hide_demo = self.demo_hidden()
        shown, total, upcoming = [], 0, 0
        for gig in gigs:
            origin = gig_origin(gig)
            if hide_demo and origin == "demo":
                continue
            when = ops.gig_when(gig.date)
            total += 1
            upcoming += when in (ops.GIG_TODAY, ops.GIG_UPCOMING)
            if wanted is None or when in wanted:
                shown.append((gig, when, origin))
        self._gig_ids = [g.id for g, _w, _o in shown]
        self._gig_rows = {}
        self.events_table.setRowCount(len(shown))
        for i, (gig, when, origin) in enumerate(shown):
            setlist_name = self._setlist_meta.get(gig.setlist_id, {}).get("name") if gig.setlist_id else ""
            self._gig_rows[gig.id] = {"name": gig.name or "", "setlist_id": gig.setlist_id, "origin": origin}
            self.events_table.setItem(i, 0, self._create_item(format_gig_date(gig.date)))
            self.events_table.setItem(i, 1, self._create_item(gig.name or ""))
            self.events_table.setItem(i, 2, self._create_item(gig.venue or ""))
            self.events_table.setItem(i, 3, self._create_item(setlist_name or "—"))
            status = self._create_item(ops.GIG_LABELS[when])
            status.setForeground(QColor(_GIG_COLORS[when]))
            self.events_table.setItem(i, 4, status)
            self.events_table.setItem(i, 5, self._create_badge_item(origin))
        self.total_events.setText(f"Total: {total}")
        self.upcoming_events.setText(f"Próximos: {upcoming}")
        if selected:
            self.select_gig(selected)
        self._update_demo_controls()
        self._update_gig_actions()

    # === ORIGEN Y DATOS DE DEMOSTRACIÓN ===
    def set_cloud_mode(self, active: bool):
        """Con sesión y banda del hub, lo DEMO se oculta (salvo "Mostrar demostración")."""
        active = bool(active)
        if active != self._cloud_mode:
            self._cloud_mode = active
            self.show_demo_check.setChecked(False)
        self._on_demo_visibility()

    def set_show_demo(self, show: bool):
        self.show_demo_check.setChecked(bool(show))
        self._on_demo_visibility()

    def _on_demo_visibility(self):
        self._apply_filters()
        self._load_gigs_from_db()

    def demo_hidden(self) -> bool:
        return self._cloud_mode and not self.show_demo_check.isChecked()

    def has_demo_rows(self) -> bool:
        return self._has_demo_gigs or "demo" in self._song_origins or any(
            meta["origin"] == "demo" for meta in self._setlist_meta.values()
        )

    def song_ids(self) -> list:
        return list(self._song_ids)

    def visible_song_ids(self) -> list:
        return [sid for row, sid in enumerate(self._song_ids) if not self.songs_table.isRowHidden(row)]

    def visible_setlist_ids(self) -> list:
        return [sid for row, sid in enumerate(self._setlist_ids) if not self.setlists_table.isRowHidden(row)]

    def gig_ids(self) -> list:
        """Eventos que muestra la tabla (con el filtro aplicado)."""
        return list(self._gig_ids)

    def song_origin_of(self, song_id: str):
        try:
            return self._song_origins[self._song_ids.index(song_id)]
        except ValueError:
            return None

    def setlist_origin_of(self, setlist_id: str):
        meta = self._setlist_meta.get(setlist_id)
        return meta["origin"] if meta else None

    def setlist_name(self, setlist_id: str) -> str:
        meta = self._setlist_meta.get(setlist_id)
        return meta["name"] if meta else ""

    def cloud_setlist_ids(self, band_cloud_id: str) -> list:
        """Hub setlists of one band, in the picker's order (name, id)."""
        rows = [
            (meta["name"], sid) for sid, meta in self._setlist_meta.items()
            if meta["origin"] == "cloud" and meta["band_cloud_id"] == band_cloud_id
        ]
        return [sid for _name, sid in sorted(rows)]

    def _row_matches(self, table, row: int, query: str, columns) -> bool:
        if not query:
            return True
        for col in columns:
            item = table.item(row, col)
            if item is not None and query in item.text().lower():
                return True
        return False

    def _apply_filters(self):
        """Búsqueda + ocultar DEMO. Solo oculta filas: los índices siguen valiendo."""
        hide_demo = self.demo_hidden()
        song_query = self._song_query.lower()
        for row in range(self.songs_table.rowCount()):
            demo = row < len(self._song_origins) and self._song_origins[row] == "demo"
            match = self._row_matches(self.songs_table, row, song_query, range(4))
            self.songs_table.setRowHidden(row, (hide_demo and demo) or not match)
        setlist_query = self._setlist_query.lower()
        for row, sid in enumerate(self._setlist_ids):
            demo = self.setlist_origin_of(sid) == "demo"
            match = self._row_matches(self.setlists_table, row, setlist_query, (0,))
            self.setlists_table.setRowHidden(row, (hide_demo and demo) or not match)
        self._update_demo_controls()

    def _update_demo_controls(self):
        has_demo = self.has_demo_rows()
        self.show_demo_check.setVisible(has_demo and self._cloud_mode)
        self.remove_demo_btn.setVisible(has_demo)

    # === SELECCIÓN ===
    def _selected_row(self, table) -> int:
        rows = table.selectionModel().selectedRows() if table.selectionModel() else []
        if rows:
            return rows[0].row()
        items = table.selectedItems()
        return items[0].row() if items else -1

    def selected_song_id(self) -> Optional[str]:
        if not hasattr(self, "songs_table"):
            return None
        row = self._selected_row(self.songs_table)
        return self._song_ids[row] if 0 <= row < len(self._song_ids) else None

    def selected_setlist_id(self) -> Optional[str]:
        if not hasattr(self, "setlists_table"):
            return None
        row = self._selected_row(self.setlists_table)
        return self._setlist_ids[row] if 0 <= row < len(self._setlist_ids) else None

    def selected_gig_id(self) -> Optional[str]:
        if not hasattr(self, "events_table"):
            return None
        row = self._selected_row(self.events_table)
        return self._gig_ids[row] if 0 <= row < len(self._gig_ids) else None

    def _select(self, table, ids: list, wanted: str) -> bool:
        if wanted in ids:
            row = ids.index(wanted)
            if not table.isRowHidden(row):
                table.selectRow(row)
                return True
        return False

    def select_song(self, song_id: str) -> bool:
        return self._select(self.songs_table, self._song_ids, song_id)

    def select_setlist(self, setlist_id: str) -> bool:
        return self._select(self.setlists_table, self._setlist_ids, setlist_id)

    def select_gig(self, gig_id: str) -> bool:
        return self._select(self.events_table, self._gig_ids, gig_id)

    def _update_song_actions(self):
        if not hasattr(self, "edit_song_btn"):
            return
        sid = self.selected_song_id()
        cloud = sid is not None and self.song_origin_of(sid) == "cloud"
        for btn in (self.edit_song_btn, self.delete_song_btn):
            btn.setEnabled(sid is not None)
        if sid is None:
            tip = "Selecciona una canción"
            self.edit_song_btn.setToolTip(tip)
            self.delete_song_btn.setToolTip(tip)
        elif cloud:
            self.edit_song_btn.setToolTip("Viene del hub: se edita en bandait.releven.cc/hub")
            self.delete_song_btn.setToolTip("Viene del hub: se borra en bandait.releven.cc/hub")
        else:
            self.edit_song_btn.setToolTip("Editar título, tempo, compás, letra y acordes (doble clic)")
            self.delete_song_btn.setToolTip("Borrar esta canción de este equipo")

    def _update_setlist_actions(self):
        if not hasattr(self, "edit_setlist_btn"):
            return
        sid = self.selected_setlist_id()
        cloud = sid is not None and self.setlist_origin_of(sid) == "cloud"
        for btn in (self.load_setlist_btn, self.edit_setlist_btn, self.duplicate_setlist_btn, self.delete_setlist_btn):
            btn.setEnabled(sid is not None)
        if sid is None:
            for btn in (self.load_setlist_btn, self.edit_setlist_btn, self.duplicate_setlist_btn,
                        self.delete_setlist_btn):
                btn.setToolTip("Selecciona un setlist")
            return
        self.load_setlist_btn.setToolTip(LOAD_LIVE_TIP)
        self.duplicate_setlist_btn.setToolTip(DUPLICATE_TIP)
        if cloud:
            self.edit_setlist_btn.setToolTip("Viene del hub: se edita en el hub, o usa Duplicar")
            self.delete_setlist_btn.setToolTip("Viene del hub: se borra en bandait.releven.cc/hub")
        else:
            self.edit_setlist_btn.setToolTip("Cambiar el nombre, las canciones y el orden")
            self.delete_setlist_btn.setToolTip("Borrar este setlist de este equipo (las canciones se quedan)")

    def _update_gig_actions(self):
        if not hasattr(self, "edit_gig_btn"):
            return
        gid = self.selected_gig_id()
        for btn in (self.load_gig_btn, self.edit_gig_btn, self.delete_gig_btn):
            btn.setEnabled(gid is not None)
        if gid is None:
            for btn in (self.load_gig_btn, self.edit_gig_btn, self.delete_gig_btn):
                btn.setToolTip("Selecciona un evento")
        else:
            has_setlist = bool(self._gig_rows.get(gid, {}).get("setlist_id"))
            self.load_gig_btn.setToolTip(
                "Enviar el setlist de este evento al transporte" if has_setlist
                else "Este evento no tiene setlist: edítalo y elige uno"
            )
            self.edit_gig_btn.setToolTip("Cambiar nombre, fecha, lugar, setlist y notas (doble clic)")
            self.delete_gig_btn.setToolTip("Borrar este evento (el setlist se queda)")

    # === SETLIST EN VIVO ===
    def setlist_ids(self) -> list:
        return list(self._setlist_ids)

    def get_setlist_entries(self, setlist_id: str) -> list:
        """Canciones del setlist en orden, como entradas del protocolo v3."""
        if not self._db_session or not setlist_id:
            return []
        try:
            return load_setlist_entries(self._db_session, setlist_id)
        except Exception as e:
            print(f"[DB] Error leyendo setlist {setlist_id}: {e}")
            return []

    def mark_active_setlist(self, setlist_id):
        self._active_setlist_id = setlist_id
        self._refresh_active_marker()

    def _refresh_active_marker(self):
        for row, sid in enumerate(self._setlist_ids):
            item = self.setlists_table.item(row, 4)
            if item is not None:
                item.setText("EN VIVO" if sid == self._active_setlist_id else "")

    def _selected_setlist_id(self):
        return self.selected_setlist_id()

    def _on_load_setlist(self):
        setlist_id = self.selected_setlist_id()
        if setlist_id:
            self.setlist_activated.emit(setlist_id)

    def _on_search_setlists(self, text: str):
        self._setlist_query = text or ""
        self._apply_filters()

    def _live_song_ids(self) -> List[str]:
        if not self._active_setlist_id or not self._db_session:
            return []
        try:
            return ops.setlist_song_ids(self._db_session, self._active_setlist_id)
        except Exception:
            return []

    def _busy(self) -> bool:
        try:
            return bool(self._transport_busy())
        except Exception:
            return True  # in doubt, never delete what may be sounding

    # === CANCIONES: NUEVA / EDITAR / ELIMINAR ===
    def new_song(self):
        if not self._db_session:
            return self._fail("crear la canción", RuntimeError("la base de datos no está disponible"))
        dialog = SongEditorDialog(parent=self)
        if not self._run_dialog(dialog):
            return
        try:
            song = ops.create_song(self._db_session, dialog.fields())
        except Exception as e:
            return self._fail("crear la canción", e)
        self._after_song_change(song.id, f"Canción creada: {song.title}")

    def edit_song(self):
        song_id = self.selected_song_id()
        if not song_id or not self._db_session:
            return
        if self.song_origin_of(song_id) == "cloud":
            return self._inform("Canción del hub", ops.CLOUD_SONG_EDIT)
        song = self._db_session.get(Song, song_id)
        if song is None:
            return self.reload()
        dialog = SongEditorDialog(ops.song_fields(song), parent=self)
        if not self._run_dialog(dialog):
            return
        try:
            song = ops.update_song(self._db_session, song_id, dialog.fields())
        except Exception as e:
            return self._fail("guardar la canción", e)
        self._after_song_change(song_id, f"Canción guardada: {song.title}")

    def _after_song_change(self, song_id: str, message: str):
        self._load_songs_from_db()
        self._load_setlists_from_db()  # durations and counts
        self.select_song(song_id)
        self.song_saved.emit(song_id)
        self.status_message.emit(message)

    def delete_song(self):
        song_id = self.selected_song_id()
        if not song_id or not self._db_session:
            return
        if self.song_origin_of(song_id) == "cloud":
            return self._inform("Canción del hub", ops.CLOUD_SONG_DELETE)
        song = self._db_session.get(Song, song_id)
        if song is None:
            return self.reload()
        title = song.title or "sin título"
        if song_id in self._live_song_ids() and self._busy():
            return self._inform("Eliminar canción", BUSY_MESSAGE.format(what="borrar una de sus canciones"))
        names = ops.song_setlist_names(self._db_session, song_id)
        text = f"Se borra «{title}» de este equipo, con su letra y acordes."
        if names:
            text += "\n\nTambién sale de estos setlists: " + ", ".join(names) + "."
        text += "\n\nNo se puede deshacer."
        if not self._confirm("Eliminar canción", text, "Borrar canción"):
            return
        try:
            ops.delete_song(self._db_session, song_id)
        except Exception as e:
            return self._fail("borrar la canción", e)
        self.reload()
        self.song_info.setText("Selecciona una canción para ver detalles")
        self.song_removed.emit(song_id)
        self.status_message.emit(f"Canción borrada: {title}")

    # === SETLISTS: NUEVO / EDITAR / DUPLICAR / ELIMINAR ===
    def _song_choices(self) -> list:
        """(id, etiqueta) de las canciones que se pueden agregar a un setlist."""
        hide_demo = self.demo_hidden()
        out = []
        try:
            songs = self._db_session.query(Song).order_by(Song.title).all()
        except Exception as e:
            print(f"[DB] Error leyendo canciones: {e}")
            return out
        for song in songs:
            origin = song_origin(song)
            if hide_demo and origin == "demo":
                continue
            parts = [song.title or "sin título"]
            if song.artist:
                parts.append(song.artist)
            meta = " · ".join(x for x in (song.key or "", f"{song.bpm} BPM" if song.bpm else "") if x)
            label = " — ".join(parts) + (f"   ({meta})" if meta else "") + f"   [{ORIGIN_BADGES[origin][0]}]"
            out.append((song.id, label))
        return out

    def new_setlist(self):
        if not self._db_session:
            return self._fail("crear el setlist", RuntimeError("la base de datos no está disponible"))
        dialog = SetlistEditorDialog(self._song_choices(), parent=self)
        if not self._run_dialog(dialog):
            return
        try:
            setlist = ops.create_setlist(self._db_session, dialog.setlist_name(), dialog.song_ids())
        except Exception as e:
            return self._fail("crear el setlist", e)
        self._after_setlist_change(setlist.id, f"Setlist creado: {setlist.name}")

    def edit_setlist(self):
        setlist_id = self.selected_setlist_id()
        if not setlist_id or not self._db_session:
            return
        if self.setlist_origin_of(setlist_id) == "cloud":
            return self._inform("Setlist del hub", ops.CLOUD_SETLIST_EDIT)
        setlist = self._db_session.get(Setlist, setlist_id)
        if setlist is None:
            return self.reload()
        dialog = SetlistEditorDialog(
            self._song_choices(), name=setlist.name or "",
            selected=ops.setlist_song_ids(self._db_session, setlist_id), editing=True, parent=self,
        )
        if not self._run_dialog(dialog):
            return
        try:
            setlist = ops.update_setlist(self._db_session, setlist_id, dialog.setlist_name(), dialog.song_ids())
        except Exception as e:
            return self._fail("guardar el setlist", e)
        self._after_setlist_change(setlist_id, f"Setlist guardado: {setlist.name}")

    def duplicate_setlist(self):
        setlist_id = self.selected_setlist_id()
        if not setlist_id or not self._db_session:
            return
        try:
            copy = ops.duplicate_setlist(self._db_session, setlist_id)
        except Exception as e:
            return self._fail("duplicar el setlist", e)
        self._after_setlist_change(copy.id, f"Copia creada: {copy.name}. Ya la puedes editar.")

    def _after_setlist_change(self, setlist_id: str, message: str):
        self._load_setlists_from_db()
        self._load_gigs_from_db()
        self.select_setlist(setlist_id)
        self.setlist_saved.emit(setlist_id)
        self.status_message.emit(message)

    def delete_setlist(self):
        setlist_id = self.selected_setlist_id()
        if not setlist_id or not self._db_session:
            return
        if self.setlist_origin_of(setlist_id) == "cloud":
            return self._inform("Setlist del hub", ops.CLOUD_SETLIST_DELETE)
        is_live = setlist_id == self._active_setlist_id
        if is_live and self._busy():
            return self._inform("Eliminar setlist", BUSY_MESSAGE.format(what="borrarlo"))
        meta = self._setlist_meta.get(setlist_id, {})
        name = meta.get("name") or "sin nombre"
        n = int(meta.get("songs") or 0)
        text = f"Se borra el setlist «{name}» ({'1 canción' if n == 1 else f'{n} canciones'}) de este equipo."
        text += " Las canciones siguen en la biblioteca."
        gigs = ops.gigs_using_setlist(self._db_session, setlist_id)
        if gigs:
            text += f"\n\n{'1 evento queda' if gigs == 1 else f'{gigs} eventos quedan'} sin setlist."
        if is_live:
            text += "\n\nEs el setlist en vivo: los teléfonos dejan de verlo."
        text += "\n\nNo se puede deshacer."
        if not self._confirm("Eliminar setlist", text, "Borrar setlist"):
            return
        try:
            ops.delete_setlist(self._db_session, setlist_id)
        except Exception as e:
            return self._fail("borrar el setlist", e)
        self.reload()
        self.setlist_detail.setText("Selecciona un setlist")
        self.setlist_removed.emit(setlist_id)
        self.status_message.emit(f"Setlist borrado: {name}")

    # === EVENTOS: NUEVO / EDITAR / ELIMINAR / CARGAR ===
    def _setlist_choices(self) -> list:
        hide_demo = self.demo_hidden()
        rows = [
            (meta["name"] + (" [NUBE]" if meta["origin"] == "cloud" else ""), sid)
            for sid, meta in self._setlist_meta.items()
            if not (hide_demo and meta["origin"] == "demo")
        ]
        return [(sid, label) for label, sid in sorted(rows)]

    def new_gig(self):
        if not self._db_session:
            return self._fail("crear el evento", RuntimeError("la base de datos no está disponible"))
        dialog = GigEditorDialog(self._setlist_choices(), parent=self)
        if not self._run_dialog(dialog):
            return
        try:
            gig = ops.create_gig(self._db_session, dialog.fields())
        except Exception as e:
            return self._fail("crear el evento", e)
        self._after_gig_change(gig.id, f"Evento creado: {gig.name}")

    def edit_gig(self):
        gig_id = self.selected_gig_id()
        if not gig_id or not self._db_session:
            return
        from src.db.models import Gig

        gig = self._db_session.get(Gig, gig_id)
        if gig is None:
            return self.reload()
        dialog = GigEditorDialog(self._setlist_choices(), ops.gig_fields(gig), parent=self)
        if not self._run_dialog(dialog):
            return
        try:
            gig = ops.update_gig(self._db_session, gig_id, dialog.fields())
        except Exception as e:
            return self._fail("guardar el evento", e)
        self._after_gig_change(gig_id, f"Evento guardado: {gig.name}")

    def _after_gig_change(self, gig_id: str, message: str):
        if self.event_filter.currentIndex() != 0:
            self.event_filter.setCurrentIndex(0)  # the new event must be visible
        self._load_gigs_from_db()
        self.select_gig(gig_id)
        self.status_message.emit(message)

    def delete_gig(self):
        gig_id = self.selected_gig_id()
        if not gig_id or not self._db_session:
            return
        name = self._gig_rows.get(gig_id, {}).get("name") or "sin nombre"
        text = f"Se borra el evento «{name}». Su setlist se queda en la biblioteca.\n\nNo se puede deshacer."
        if not self._confirm("Eliminar evento", text, "Borrar evento"):
            return
        try:
            ops.delete_gig(self._db_session, gig_id)
        except Exception as e:
            return self._fail("borrar el evento", e)
        self._load_gigs_from_db()
        self.status_message.emit(f"Evento borrado: {name}")

    def load_gig_setlist(self):
        gig_id = self.selected_gig_id()
        if not gig_id:
            return
        setlist_id = self._gig_rows.get(gig_id, {}).get("setlist_id")
        if not setlist_id or setlist_id not in self._setlist_meta:
            return self._inform("Cargar setlist", "Este evento no tiene setlist: edítalo y elige uno.")
        self.setlist_activated.emit(setlist_id)

    def get_song_data_by_id(self, song_id: str) -> dict:
        """Datos de una cancion por id (cancion actual del transporte)."""
        if not self._db_session or not song_id:
            return {}
        try:
            song = self._db_session.get(Song, song_id)
        except Exception as e:
            print(f"[DB] Error leyendo cancion {song_id}: {e}")
            return {}
        if not song:
            return {}
        return self._song_to_dict(song)

    def _song_to_dict(self, song) -> dict:
        return {
            "id": song.id,
            "title": song.title,
            "artist": song.artist or "",
            "bpm": song.bpm,
            "key": song.key or "",
            "duration_seconds": song.duration_seconds or 180,
            "lyrics_text": song.lyrics_text or "",
            "chords_text": song.chords_text or "",
            "audio_path": song.audio_path or "",
            "lyrics": self._parse_lyrics(song.lyrics_text),
            "sections": self._parse_sections(song.chords_text or song.lyrics_text),
        }

    def _create_item(self, text: str) -> QTableWidgetItem:
        item = QTableWidgetItem(text)
        item.setFont(QFont("Inter", 11))
        return item

    def _create_bpm_item(self, text: str) -> QTableWidgetItem:
        item = QTableWidgetItem(text)
        item.setFont(QFont("JetBrains Mono", 11))
        item.setForeground(QColor(0, 255, 255))
        return item

    def _create_badge_item(self, origin: str) -> QTableWidgetItem:
        text, color = ORIGIN_BADGES.get(origin, ORIGIN_BADGES["local"])
        item = QTableWidgetItem(text)
        item.setFont(QFont("JetBrains Mono", 10, QFont.Bold))
        item.setForeground(QColor(color))
        item.setTextAlignment(Qt.AlignCenter)
        item.setToolTip({
            "cloud": "Viene del hub (solo lectura): se edita en bandait.releven.cc/hub",
            "demo": "Dato de demostración: se quita con 'Quitar datos de demostración'",
        }.get(origin, "Solo en este equipo"))
        return item

    # === EVENT HANDLERS ===
    def _on_search_songs(self, text: str):
        """Filtrar canciones por búsqueda."""
        self._song_query = text or ""
        self._apply_filters()

    def _on_song_selected(self):
        self._update_song_actions()
        row = self._selected_row(self.songs_table)
        if row < 0:
            return
        title = self.songs_table.item(row, 0).text()
        bpm = self.songs_table.item(row, 2).text()
        key = self.songs_table.item(row, 3).text()
        duration = self.songs_table.item(row, 4).text()
        self.song_info.setText(
            f"<b>{title}</b><br>"
            f"BPM: <span style='color:#00FFFF'>{bpm}</span> | "
            f"Tonalidad: {key} | Duración: {duration}"
        )
        self.song_selected.emit(row)

    def _on_setlist_selected(self):
        self._update_setlist_actions()
        row = self._selected_row(self.setlists_table)
        if row < 0:
            return
        name = self.setlists_table.item(row, 0).text()
        songs = self.setlists_table.item(row, 1).text()
        self.setlist_detail.setText(f"<b>{name}</b><br>{songs} canciones")
        setlist_id = self._setlist_ids[row] if 0 <= row < len(self._setlist_ids) else ""
        self.setlist_selected.emit(setlist_id)

    def _on_import(self):
        file_path, _ = QFileDialog.getOpenFileName(
            self, "Importar Canción", "",
            "Archivos de audio (*.mp3 *.wav *.flac);;"
            "Letras (*.lrc *.txt);;"
            "ChordPro (*.pro *.cho *.chopro);;"
            "Todos los archivos (*.*)"
        )
        if file_path:
            self._import_file(file_path)
            self.import_requested.emit(file_path)

    def _import_file(self, file_path: str):
        """Importar archivo y guardar en DB con metadata extraída."""
        import re
        ext = os.path.splitext(file_path)[1].lower()
        base_name = os.path.splitext(os.path.basename(file_path))[0]

        try:
            if ext in (".lrc", ".txt"):
                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read()

                # Extraer título y artista de metadatos LRC
                title = base_name
                artist = ""
                for line in content.splitlines():
                    if line.startswith("[ti:"):
                        title = line[4:-1].strip()
                    elif line.startswith("[ar:"):
                        artist = line[4:-1].strip()

                lines = LRCParser.parse(content)
                lyrics_text = "\n".join([line_item.text for line_item in lines])

                # Estimar BPM y duración
                if lines:
                    last_time = lines[-1].time_ms / 1000.0
                    duration = max(last_time + 30, 180)  # mínimo 3 min
                else:
                    duration = 180

                song = Song(
                    id=f"song-{base_name}-{hash(file_path) % 10000:04d}",
                    title=title,
                    artist=artist,
                    bpm=120,
                    duration_seconds=duration,
                    lyrics_text=lyrics_text,
                )

            elif ext in (".pro", ".cho", ".chopro"):
                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read()
                result = ChordProParser.parse(content)

                # Extraer duración estimada de las secciones
                sections = result.get("sections", [])
                total_bars = sum(len(s.get("lines", [])) for s in sections)
                bpm = result.get("bpm", 120)
                duration = (total_bars * 4 * 60) / max(bpm, 60) if total_bars > 0 else 180

                song = Song(
                    id=f"song-{result.get('title', base_name)}-{hash(file_path) % 10000:04d}",
                    title=result.get("title", base_name),
                    artist=result.get("artist", ""),
                    bpm=bpm,
                    key=result.get("key", ""),
                    duration_seconds=duration,
                    chords_text=content,
                    lyrics_text="\n".join(
                        line for s in sections for line in s.get("lines", [])
                    ),
                )

            elif ext in (".mp3", ".wav", ".flac", ".ogg"):
                # Audio file — try to extract metadata
                duration = 180  # default
                try:
                    import mutagen
                    from mutagen.mp3 import MP3
                    audio = MP3(file_path)
                    duration = audio.info.length
                    tags = audio.tags
                    title = tags.get("TIT2", base_name) if tags else base_name
                    artist = tags.get("TPE1", "") if tags else ""
                except Exception:
                    title = base_name
                    artist = ""

                song = Song(
                    id=f"song-{base_name}-{hash(file_path) % 10000:04d}",
                    title=title,
                    artist=artist,
                    duration_seconds=duration,
                    audio_path=file_path,
                )

            else:
                song = Song(
                    id=f"song-{base_name}-{hash(file_path) % 10000:04d}",
                    title=base_name,
                    audio_path=file_path,
                )

            if self._db_session:
                # Check for duplicate by title+artist
                existing = self._db_session.query(Song).filter(
                    Song.title == song.title,
                    Song.artist == song.artist
                ).first()
                if existing is not None and song_origin(existing) == "cloud":
                    # The hub is the source of truth: refuse before asking, never
                    # say "actualizada" for an edit the ORM guard would discard.
                    QMessageBox.information(self, "Canción del hub", CLOUD_READ_ONLY_MESSAGE)
                    return
                if existing:
                    reply = QMessageBox.question(
                        self, "Canción existente",
                        f"'{song.title}' ya existe. ¿Reemplazar?",
                        QMessageBox.Yes | QMessageBox.No
                    )
                    if reply == QMessageBox.Yes:
                        existing.lyrics_text = song.lyrics_text or existing.lyrics_text
                        existing.chords_text = song.chords_text or existing.chords_text
                        existing.audio_path = song.audio_path or existing.audio_path
                        existing.bpm = song.bpm or existing.bpm
                        self._db_session.commit()
                        QMessageBox.information(self, "Importar", f"Canción actualizada: {song.title}")
                else:
                    self._db_session.add(song)
                    self._db_session.commit()
                    QMessageBox.information(self, "Importar", f"Canción importada: {song.title}")

                self._load_songs_from_db()

        except Exception as e:
            QMessageBox.warning(self, "Error", f"No se pudo importar:\n{e}")
            import traceback
            traceback.print_exc()

    def get_song_data(self, row: int) -> dict:
        """Retornar datos de canción seleccionada desde la DB."""
        if row < 0 or row >= self.songs_table.rowCount():
            return {}

        title = self.songs_table.item(row, 0).text()

        # Por el id de la fila (dos canciones pueden tener el mismo título)
        if row < len(self._song_ids):
            data = self.get_song_data_by_id(self._song_ids[row])
            if data:
                return data
        if self._db_session:
            song = self._db_session.query(Song).filter(Song.title == title).first()
            if song:
                return self._song_to_dict(song)

        # Fallback: datos de la tabla
        return {
            "title": title,
            "artist": self.songs_table.item(row, 1).text() if self.songs_table.item(row, 1) else "",
            "bpm": int(self.songs_table.item(row, 2).text()) if self.songs_table.item(row, 2) else 120,
            "key": self.songs_table.item(row, 3).text() if self.songs_table.item(row, 3) else "",
            "duration_seconds": self._parse_duration(
                self.songs_table.item(row, 4).text() if self.songs_table.item(row, 4) else "3:00"
            ),
            "lyrics": [],
            "sections": [
                {"label": "Intro", "bars": 4},
                {"label": "Verso", "bars": 16},
                {"label": "Coro", "bars": 16},
            ],
        }

    def _parse_lyrics(self, text: str) -> list:
        """Parsear texto de letras a lista de dicts."""
        if not text:
            return []
        lines = text.strip().split("\n")
        return [{"time": i * 5.0, "text": line.strip()} for i, line in enumerate(lines) if line.strip()]

    def _parse_sections(self, text: str) -> list:
        """Intentar extraer secciones del texto."""
        if not text:
            return [{"label": "Intro", "bars": 4}, {"label": "Verso", "bars": 16}, {"label": "Coro", "bars": 16}]

        # Buscar patrones como [Intro], [Verso], etc.
        import re
        sections = []
        section_re = re.compile(r'\[(Intro|Verso?|Pre-Coro|Coro|Chorus|Puente|Bridge|Solo|Outro)\]', re.IGNORECASE)
        matches = list(section_re.finditer(text))
        for i, match in enumerate(matches):
            label = match.group(1).capitalize()
            if label.lower() in ("chorus", "coro"):
                label = "Coro"
            elif label.lower() in ("verse", "verso"):
                label = "Verso"
            elif label.lower() == "bridge":
                label = "Puente"
            sections.append({"label": label, "bars": 8})

        if not sections:
            return [{"label": "Intro", "bars": 4}, {"label": "Verso", "bars": 16}, {"label": "Coro", "bars": 16}]
        return sections

    def _parse_duration(self, text: str) -> int:
        """Convertir '4:32' a segundos."""
        try:
            parts = text.split(":")
            return int(parts[0]) * 60 + int(parts[1])
        except Exception:
            return 180
