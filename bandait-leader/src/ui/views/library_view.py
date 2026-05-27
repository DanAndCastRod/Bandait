"""
Bandait DAW — Vista de Biblioteca
Gestión de canciones, setlists y eventos con persistencia SQLite real.
"""

import os
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTableWidget, QTableWidgetItem, QLineEdit, QComboBox,
    QTabWidget, QFrame, QHeaderView, QMessageBox, QFileDialog
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont, QColor

from src.db.models import init_db, Song, Setlist
from src.infrastructure.parsers.lrc_parser import LRCParser
from src.infrastructure.parsers.chordpro_parser import ChordProParser


class LibraryView(QWidget):
    """Biblioteca musical con canciones, setlists y eventos persistentes."""

    song_selected = Signal(int)
    setlist_selected = Signal(int)
    import_requested = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._db_session = None
        self._setup_db()
        self._setup_ui()
        self._load_songs_from_db()
        self._load_setlists_from_db()

    def _setup_db(self):
        """Inicializar conexión a SQLite."""
        db_path = os.path.join(os.path.expanduser("~"), "Documents", "Bandait", "bandait.db")
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        Session = init_db(db_path)
        self._db_session = Session()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)

        # === TÍTULO ===
        title = QLabel("BIBLIOTECA MUSICAL")
        title.setFont(QFont("Inter", 18, QFont.Bold))
        title.setStyleSheet("color: #F0F0F0;")
        layout.addWidget(title)

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
        add_btn.clicked.connect(self._on_add_song)
        toolbar.addWidget(add_btn)

        delete_btn = QPushButton("Eliminar")
        delete_btn.setObjectName("danger")
        delete_btn.clicked.connect(self._on_delete_song)
        toolbar.addWidget(delete_btn)

        layout.addLayout(toolbar)

        # Tabla de canciones
        self.songs_table = QTableWidget()
        self.songs_table.setColumnCount(6)
        self.songs_table.setHorizontalHeaderLabels([
            "Título", "Artista", "BPM", "Tonalidad", "Duración", "Último uso"
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
        toolbar.addWidget(self.setlist_search)

        toolbar.addStretch()

        new_btn = QPushButton("Nuevo Setlist")
        new_btn.setObjectName("primary")
        new_btn.clicked.connect(self._on_add_setlist)
        toolbar.addWidget(new_btn)

        layout.addLayout(toolbar)

        # Lista de setlists
        self.setlists_table = QTableWidget()
        self.setlists_table.setColumnCount(5)
        self.setlists_table.setHorizontalHeaderLabels([
            "Nombre", "Canciones", "Duración", "Último evento", "Estado"
        ])
        self.setlists_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.setlists_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.setlists_table.itemSelectionChanged.connect(self._on_setlist_selected)

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
        actions.addWidget(edit_btn)

        play_btn = QPushButton("Cargar")
        play_btn.setObjectName("success")
        actions.addWidget(play_btn)

        duplicate_btn = QPushButton("Duplicar")
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
        toolbar.addWidget(self.event_filter)

        toolbar.addStretch()

        new_event_btn = QPushButton("Nuevo Evento")
        new_event_btn.setObjectName("primary")
        new_event_btn.clicked.connect(self._on_add_event)
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
            for i, song in enumerate(songs):
                self.songs_table.setItem(i, 0, self._create_item(song.title))
                self.songs_table.setItem(i, 1, self._create_item(song.artist or ""))
                self.songs_table.setItem(i, 2, self._create_bpm_item(str(song.bpm)))
                self.songs_table.setItem(i, 3, self._create_item(song.key or ""))
                duration_str = f"{int(song.duration_seconds // 60)}:{int(song.duration_seconds % 60):02d}"
                self.songs_table.setItem(i, 4, self._create_item(duration_str))
                self.songs_table.setItem(i, 5, self._create_item("Reciente"))
        except Exception as e:
            print(f"[DB] Error cargando canciones: {e}")
            self.songs_table.setRowCount(0)

    def _load_setlists_from_db(self):
        """Cargar setlists desde SQLite."""
        if not self._db_session:
            return
        setlists = self._db_session.query(Setlist).all()
        self.setlists_table.setRowCount(len(setlists))
        for i, sl in enumerate(setlists):
            self.setlists_table.setItem(i, 0, self._create_item(sl.name))
            n_songs = len(sl.songs) if sl.songs else 0
            self.setlists_table.setItem(i, 1, self._create_item(str(n_songs)))
            self.setlists_table.setItem(i, 2, self._create_item("—"))
            self.setlists_table.setItem(i, 3, self._create_item("—"))
            self.setlists_table.setItem(i, 4, self._create_item("Activo"))

    def _create_item(self, text: str) -> QTableWidgetItem:
        item = QTableWidgetItem(text)
        item.setFont(QFont("Inter", 11))
        return item

    def _create_bpm_item(self, text: str) -> QTableWidgetItem:
        item = QTableWidgetItem(text)
        item.setFont(QFont("JetBrains Mono", 11))
        item.setForeground(QColor(0, 255, 255))
        return item

    # === EVENT HANDLERS ===
    def _on_search_songs(self, text: str):
        """Filtrar canciones por búsqueda."""
        for row in range(self.songs_table.rowCount()):
            match = False
            for col in range(4):
                item = self.songs_table.item(row, col)
                if item and text.lower() in item.text().lower():
                    match = True
                    break
            self.songs_table.setRowHidden(row, not match)

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
            self.setlist_selected.emit(row)

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
                lyrics_text = "\n".join([l.text for l in lines])

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

    def _on_add_song(self):
        QMessageBox.information(self, "Nueva Canción", "Función en desarrollo: Editor de canciones")

    def _on_delete_song(self):
        selected = self.songs_table.selectedItems()
        if selected:
            row = selected[0].row()
            title = self.songs_table.item(row, 0).text()
            reply = QMessageBox.question(
                self, "Confirmar",
                f"¿Eliminar '{title}'?",
                QMessageBox.Yes | QMessageBox.No
            )
            if reply == QMessageBox.Yes:
                self.songs_table.removeRow(row)

    def _on_add_setlist(self):
        QMessageBox.information(self, "Nuevo Setlist", "Función en desarrollo: Editor de setlists")

    def _on_add_event(self):
        QMessageBox.information(self, "Nuevo Evento", "Función en desarrollo: Gestor de eventos")

    def get_song_data(self, row: int) -> dict:
        """Retornar datos de canción seleccionada desde la DB."""
        if row < 0 or row >= self.songs_table.rowCount():
            return {}

        title = self.songs_table.item(row, 0).text()

        # Buscar en DB por título
        if self._db_session:
            song = self._db_session.query(Song).filter(Song.title == title).first()
            if song:
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

    def _on_next_song(self):
        """Seleccionar siguiente canción."""
        current = self.songs_table.currentRow()
        next_row = (current + 1) % self.songs_table.rowCount()
        self.songs_table.selectRow(next_row)
        self._on_song_selected()

    def _on_prev_song(self):
        """Seleccionar canción anterior."""
        current = self.songs_table.currentRow()
        prev_row = (current - 1) % self.songs_table.rowCount()
        self.songs_table.selectRow(prev_row)
        self._on_song_selected()
