"""
Bandait DAW — Vista de Biblioteca
Gestión de canciones, setlists y eventos en español.
"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTableWidget, QTableWidgetItem, QLineEdit, QComboBox,
    QTabWidget, QFrame, QHeaderView, QMessageBox, QFileDialog
)
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QFont, QColor


class LibraryView(QWidget):
    """Biblioteca musical con canciones, setlists y eventos."""

    song_selected = Signal(int)
    setlist_selected = Signal(int)
    import_requested = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_ui()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)

        # === TÍTULO ===
        title = QLabel("📚 BIBLIOTECA MUSICAL")
        title.setFont(QFont("Inter", 18, QFont.Bold))
        title.setStyleSheet("color: #F0F0F0;")
        layout.addWidget(title)

        # === TABS ===
        self.tabs = QTabWidget()
        self.tabs.setFont(QFont("Inter", 12))

        # --- TAB: CANCIONES ---
        songs_widget = self._create_songs_tab()
        self.tabs.addTab(songs_widget, "🎵 Canciones")

        # --- TAB: SETLISTS ---
        setlists_widget = self._create_setlists_tab()
        self.tabs.addTab(setlists_widget, "📋 Setlists")

        # --- TAB: EVENTOS ---
        events_widget = self._create_events_tab()
        self.tabs.addTab(events_widget, "🎤 Eventos")

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
        toolbar.addWidget(self.search_input)

        toolbar.addStretch()

        import_btn = QPushButton("⬆ Importar")
        import_btn.setObjectName("primary")
        import_btn.setToolTip("Importar archivo LRC, ChordPro o MP3")
        import_btn.clicked.connect(self._on_import)
        toolbar.addWidget(import_btn)

        add_btn = QPushButton("➕ Nueva")
        add_btn.setObjectName("primary")
        add_btn.clicked.connect(self._on_add_song)
        toolbar.addWidget(add_btn)

        delete_btn = QPushButton("🗑 Eliminar")
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

        # Datos de ejemplo
        self._load_sample_songs()

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

        new_btn = QPushButton("➕ Nuevo Setlist")
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

        self._load_sample_setlists()

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

        edit_btn = QPushButton("✏ Editar")
        edit_btn.setObjectName("primary")
        actions.addWidget(edit_btn)

        play_btn = QPushButton("▶ Cargar")
        play_btn.setObjectName("success")
        actions.addWidget(play_btn)

        duplicate_btn = QPushButton("📋 Duplicar")
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

        new_event_btn = QPushButton("➕ Nuevo Evento")
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

        self._load_sample_events()

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

    def _load_sample_songs(self):
        """Cargar canciones de ejemplo."""
        sample_data = [
            ["Medianoche en Pereira", "Los Rolling Ruanas", "124", "Am", "4:32", "Hace 2 días"],
            ["Volver a Verte", "Banda Local", "118", "C", "3:45", "Hace 1 semana"],
            ["Ensayo #1", "Instrumental", "135", "Em", "5:12", "Ayer"],
            ["Cover: Smells Like", "Nirvana (Cover)", "140", "F#m", "4:18", "Hace 3 días"],
            ["Intro del Set", "Personal", "90", "Dm", "0:45", "Hoy"],
        ]
        self.songs_table.setRowCount(len(sample_data))
        for i, row_data in enumerate(sample_data):
            for j, value in enumerate(row_data):
                item = QTableWidgetItem(value)
                item.setFont(QFont("Inter", 11))
                if j == 2:  # BPM
                    item.setFont(QFont("JetBrains Mono", 11))
                    item.setForeground(QColor(0, 255, 255))
                self.songs_table.setItem(i, j, item)

    def _load_sample_setlists(self):
        sample_data = [
            ["Set Ensayo Mayo", "12", "48 min", "2024-05-20", "Activo"],
            ["Evento Bar La Esquina", "8", "35 min", "2024-05-15", "Completado"],
            ["Práctica Covers", "15", "62 min", "2024-05-18", "Activo"],
        ]
        self.setlists_table.setRowCount(len(sample_data))
        for i, row_data in enumerate(sample_data):
            for j, value in enumerate(row_data):
                item = QTableWidgetItem(value)
                item.setFont(QFont("Inter", 11))
                if j == 4:  # Estado
                    if value == "Activo":
                        item.setForeground(QColor(204, 255, 0))
                    else:
                        item.setForeground(QColor(102, 102, 102))
                self.setlists_table.setItem(i, j, item)

    def _load_sample_events(self):
        sample_data = [
            ["2024-05-30", "Festival de Rock Local", "Plaza Central", "Set Ensayo Mayo", "Confirmado", ""],
            ["2024-06-15", "Concierto Privado", "Casa del Manager", "Evento Bar La Esquina", "Pendiente", ""],
            ["2024-05-10", "Ensayo General", "Estudio", "Práctica Covers", "Completado", ""],
        ]
        self.events_table.setRowCount(len(sample_data))
        for i, row_data in enumerate(sample_data):
            for j, value in enumerate(row_data):
                item = QTableWidgetItem(value)
                item.setFont(QFont("Inter", 11))
                if j == 4:  # Estado
                    if value == "Confirmado":
                        item.setForeground(QColor(204, 255, 0))
                    elif value == "Pendiente":
                        item.setForeground(QColor(255, 170, 0))
                    else:
                        item.setForeground(QColor(102, 102, 102))
                self.events_table.setItem(i, j, item)

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
            self.import_requested.emit(file_path)
            QMessageBox.information(self, "Importar", f"Importando: {file_path}")

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
        """Retornar datos de canción seleccionada como dict."""
        if row < 0 or row >= self.songs_table.rowCount():
            return {}
        return {
            "title": self.songs_table.item(row, 0).text(),
            "artist": self.songs_table.item(row, 1).text(),
            "bpm": int(self.songs_table.item(row, 2).text()),
            "key": self.songs_table.item(row, 3).text(),
            "duration_seconds": self._parse_duration(self.songs_table.item(row, 4).text()),
            "lyrics": [],
            "sections": [
                {"label": "Intro", "bars": 4},
                {"label": "Verso", "bars": 16},
                {"label": "Coro", "bars": 16},
            ],
        }

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
