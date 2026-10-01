"""
Bandait DAW — Vista de Biblioteca
Gestión de canciones, setlists y eventos con persistencia SQLite real.

Cada canción y setlist muestra su origen (NUBE / LOCAL / DEMO). Con una banda
del hub elegida, los datos de demostración se ocultan salvo que se pida verlos.
Las canciones de la nube son de solo lectura: se editan en el hub.
"""

import os
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QCheckBox,
    QTableWidget, QTableWidgetItem, QLineEdit, QComboBox,
    QTabWidget, QFrame, QHeaderView, QMessageBox, QFileDialog
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont, QColor

from src.core.paths import get_db_path
from src.db.models import init_db, load_setlist_entries, Song, Setlist
from src.infrastructure.parsers.lrc_parser import LRCParser
from src.infrastructure.parsers.chordpro_parser import ChordProParser

# origin -> (badge text, color)
ORIGIN_BADGES = {
    "cloud": ("NUBE", "#00FFFF"),
    "local": ("LOCAL", "#9A9A9A"),
    "demo": ("DEMO", "#FFAA00"),
}
CLOUD_READ_ONLY_MESSAGE = "Esta canción viene del hub: edítala en bandait.releven.cc/hub y sincroniza."


def song_origin(song) -> str:
    source = getattr(song, "source", None) or "local"
    return source if source in ("cloud", "demo") else "local"


def setlist_origin(setlist) -> str:
    if getattr(setlist, "cloud_id", None):
        return "cloud"  # imported before setlists.source existed: cloud_id decides
    return "demo" if getattr(setlist, "source", None) == "demo" else "local"


class LibraryView(QWidget):
    """Biblioteca musical con canciones, setlists y eventos persistentes."""

    song_selected = Signal(int)
    setlist_selected = Signal(str)  # setlist id (solo muestra detalle)
    setlist_activated = Signal(str)  # setlist id cargado como setlist en vivo
    import_requested = Signal(str)
    demo_remove_requested = Signal()  # la ventana confirma, respalda y borra

    NOT_AVAILABLE = "No disponible en esta version"

    def __init__(self, parent=None):
        super().__init__(parent)
        self._db_session = None
        self._setlist_ids: list = []
        self._setlist_meta: dict = {}  # id -> {"name", "origin", "band_cloud_id", "songs"}
        self._song_ids: list = []
        self._song_origins: list = []
        self._song_query = ""
        self._setlist_query = ""
        self._cloud_mode = False  # signed in with a hub band: demo hidden by default
        self._active_setlist_id = None
        self._setup_db()
        self._setup_ui()
        self._load_songs_from_db()
        self._load_setlists_from_db()

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
        self.show_demo_check.setToolTip("Mostrar las canciones y setlists marcados DEMO")
        self.show_demo_check.setStyleSheet("color: #FFAA00;")
        self.show_demo_check.toggled.connect(lambda _on: self._apply_filters())
        self.show_demo_check.setVisible(False)
        header.addWidget(self.show_demo_check)

        self.remove_demo_btn = QPushButton("Quitar datos de demostración")
        self.remove_demo_btn.setObjectName("danger")
        self.remove_demo_btn.setToolTip(
            "Borra solo lo marcado DEMO (antes guarda una copia de la base). Lo del hub y lo tuyo no se toca."
        )
        self.remove_demo_btn.clicked.connect(self.demo_remove_requested.emit)
        self.remove_demo_btn.setVisible(False)
        header.addWidget(self.remove_demo_btn)
        layout.addLayout(header)

        # === TABS ===
        self.tabs = QTabWidget()
        self.tabs.setFont(QFont("Inter", 12))

        # --- TAB: CANCIONES ---
        songs_widget = self._create_songs_tab()
        self.tabs.addTab(songs_widget, "Canciones")

        # --- TAB: SETLISTS ---
        setlists_widget = self._create_setlists_tab()
        self.tabs.addTab(setlists_widget, "Setlists")

        # --- TAB: EVENTOS ---
        events_widget = self._create_events_tab()
        self.tabs.addTab(events_widget, "Eventos")

        layout.addWidget(self.tabs)

    def _create_songs_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(12)
        layout.setContentsMargins(12, 12, 12, 12)

        # Barra de herramientas
        toolbar = QHBoxLayout()

        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("Buscar canción...")
        self.search_input.setMinimumWidth(200)
        self.search_input.textChanged.connect(self._on_search_songs)
        toolbar.addWidget(self.search_input)

        toolbar.addStretch()

        import_btn = QPushButton("Importar")
        import_btn.setObjectName("primary")
        import_btn.setToolTip("Importar archivo LRC, ChordPro o MP3")
        import_btn.clicked.connect(self._on_import)
        toolbar.addWidget(import_btn)

        add_btn = QPushButton("Nueva")
        add_btn.setObjectName("primary")
        add_btn.setEnabled(False)
        add_btn.setToolTip(self.NOT_AVAILABLE)
        toolbar.addWidget(add_btn)

        delete_btn = QPushButton("Eliminar")
        delete_btn.setObjectName("danger")
        # Solo quitaba la fila de la tabla, no de la base: deshabilitado.
        delete_btn.setEnabled(False)
        delete_btn.setToolTip(self.NOT_AVAILABLE)
        toolbar.addWidget(delete_btn)

        layout.addLayout(toolbar)

        # Tabla de canciones
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
        self.songs_table.itemSelectionChanged.connect(self._on_song_selected)
        self.songs_table.setMinimumHeight(300)

        layout.addWidget(self.songs_table)

        # Info de canción seleccionada
        self.song_info = QLabel("Selecciona una canción para ver detalles")
        self.song_info.setFont(QFont("Inter", 11))
        self.song_info.setStyleSheet("color: #666666; padding: 8px;")
        self.song_info.setWordWrap(True)
        layout.addWidget(self.song_info)

        return widget

    def _create_setlists_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(12)
        layout.setContentsMargins(12, 12, 12, 12)

        # Toolbar
        toolbar = QHBoxLayout()

        self.setlist_search = QLineEdit()
        self.setlist_search.setPlaceholderText("Buscar setlist...")
        self.setlist_search.textChanged.connect(self._on_search_setlists)
        toolbar.addWidget(self.setlist_search)

        toolbar.addStretch()

        new_btn = QPushButton("Nuevo Setlist")
        new_btn.setObjectName("primary")
        new_btn.setEnabled(False)
        new_btn.setToolTip(self.NOT_AVAILABLE)
        toolbar.addWidget(new_btn)

        layout.addLayout(toolbar)

        # Lista de setlists
        self.setlists_table = QTableWidget()
        self.setlists_table.setColumnCount(5)
        self.setlists_table.setHorizontalHeaderLabels([
            "Nombre", "Canciones", "Duración", "Origen", "Estado"
        ])
        self.setlists_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.setlists_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.setlists_table.setSelectionMode(QTableWidget.SingleSelection)
        self.setlists_table.itemSelectionChanged.connect(self._on_setlist_selected)
        self.setlists_table.cellDoubleClicked.connect(lambda _r, _c: self._on_load_setlist())

        layout.addWidget(self.setlists_table)

        # Detalle del setlist
        detail_frame = QFrame()
        detail_frame.setObjectName("panel")
        detail_layout = QVBoxLayout(detail_frame)

        self.setlist_detail = QLabel("Selecciona un setlist")
        self.setlist_detail.setFont(QFont("Inter", 12))
        self.setlist_detail.setStyleSheet("color: #F0F0F0;")
        detail_layout.addWidget(self.setlist_detail)

        # Botones de acción
        actions = QHBoxLayout()

        edit_btn = QPushButton("Editar")
        edit_btn.setObjectName("primary")
        edit_btn.setEnabled(False)
        edit_btn.setToolTip(self.NOT_AVAILABLE)
        actions.addWidget(edit_btn)

        self.load_setlist_btn = QPushButton("Cargar en vivo")
        self.load_setlist_btn.setObjectName("success")
        self.load_setlist_btn.setToolTip(
            "Enviar este setlist al transporte (CUE y saltos en todos los dispositivos)"
        )
        self.load_setlist_btn.clicked.connect(self._on_load_setlist)
        actions.addWidget(self.load_setlist_btn)

        duplicate_btn = QPushButton("Duplicar")
        duplicate_btn.setEnabled(False)
        duplicate_btn.setToolTip(self.NOT_AVAILABLE)
        actions.addWidget(duplicate_btn)

        detail_layout.addLayout(actions)
        layout.addWidget(detail_frame)

        return widget

    def _create_events_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.setSpacing(12)
        layout.setContentsMargins(12, 12, 12, 12)

        # Toolbar
        toolbar = QHBoxLayout()

        self.event_filter = QComboBox()
        self.event_filter.addItems(["Todos", "Próximos", "Pasados", "Hoy"])
        self.event_filter.setEnabled(False)
        self.event_filter.setToolTip(self.NOT_AVAILABLE)
        toolbar.addWidget(self.event_filter)

        toolbar.addStretch()

        new_event_btn = QPushButton("Nuevo Evento")
        new_event_btn.setObjectName("primary")
        new_event_btn.setEnabled(False)
        new_event_btn.setToolTip(self.NOT_AVAILABLE)
        toolbar.addWidget(new_event_btn)

        layout.addLayout(toolbar)

        # Tabla de eventos
        self.events_table = QTableWidget()
        self.events_table.setColumnCount(6)
        self.events_table.setHorizontalHeaderLabels([
            "Fecha", "Nombre", "Lugar", "Setlist", "Estado", "Acciones"
        ])
        self.events_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.events_table.setSelectionBehavior(QTableWidget.SelectRows)

        layout.addWidget(self.events_table)

        # Resumen
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

        return widget

    # === DB OPERATIONS ===
    def _load_songs_from_db(self):
        """Cargar canciones desde SQLite."""
        if not self._db_session:
            return
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

    def _load_setlists_from_db(self):
        """Cargar setlists desde SQLite."""
        if not self._db_session:
            return
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
            self._setlist_meta[sl.id] = {
                "name": sl.name or "", "origin": origin, "band_cloud_id": sl.band_cloud_id, "songs": n_songs,
            }
            self.setlists_table.setItem(i, 0, self._create_item(sl.name))
            self.setlists_table.setItem(i, 1, self._create_item(str(n_songs)))
            self.setlists_table.setItem(i, 2, self._create_item("—"))
            self.setlists_table.setItem(i, 3, self._create_badge_item(origin))
            self.setlists_table.setItem(i, 4, self._create_item(""))
        self._refresh_active_marker()
        self._apply_filters()

    # === ORIGEN Y DATOS DE DEMOSTRACIÓN ===
    def set_cloud_mode(self, active: bool):
        """Con sesión y banda del hub, lo DEMO se oculta (salvo "Mostrar demostración")."""
        active = bool(active)
        if active != self._cloud_mode:
            self._cloud_mode = active
            self.show_demo_check.setChecked(False)
        self._apply_filters()

    def set_show_demo(self, show: bool):
        self.show_demo_check.setChecked(bool(show))
        self._apply_filters()

    def demo_hidden(self) -> bool:
        return self._cloud_mode and not self.show_demo_check.isChecked()

    def has_demo_rows(self) -> bool:
        return "demo" in self._song_origins or any(
            meta["origin"] == "demo" for meta in self._setlist_meta.values()
        )

    def song_ids(self) -> list:
        return list(self._song_ids)

    def visible_song_ids(self) -> list:
        return [sid for row, sid in enumerate(self._song_ids) if not self.songs_table.isRowHidden(row)]

    def visible_setlist_ids(self) -> list:
        return [sid for row, sid in enumerate(self._setlist_ids) if not self.setlists_table.isRowHidden(row)]

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
        has_demo = self.has_demo_rows()
        self.show_demo_check.setVisible(has_demo and self._cloud_mode)
        self.remove_demo_btn.setVisible(has_demo)

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
        selected = self.setlists_table.selectedItems()
        if not selected:
            return None
        row = selected[0].row()
        if 0 <= row < len(self._setlist_ids):
            return self._setlist_ids[row]
        return None

    def _on_load_setlist(self):
        setlist_id = self._selected_setlist_id()
        if setlist_id:
            self.setlist_activated.emit(setlist_id)

    def _on_search_setlists(self, text: str):
        self._setlist_query = text or ""
        self._apply_filters()

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
        selected = self.songs_table.selectedItems()
        if selected:
            row = selected[0].row()
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
        selected = self.setlists_table.selectedItems()
        if selected:
            row = selected[0].row()
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
