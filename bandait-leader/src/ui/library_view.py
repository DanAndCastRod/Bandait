"""Library view: song management, setlist editor, and content browser."""

from typing import Optional

from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QLabel,
    QLineEdit,
    QSpinBox,
    QTextEdit,
    QSplitter,
    QMenu,
    QFileDialog,
    QMessageBox,
)
from PySide6.QtCore import Qt, Signal

from src.db.models import Song, Setlist
from src.infrastructure.parsers.lrc_parser import LRCParser
from src.infrastructure.parsers.chordpro_parser import ChordProParser


class LibraryView(QWidget):
    """Song library, setlist editor, and import interface."""

    setlist_loaded = Signal(object)  # Setlist

    def __init__(self, db_session_factory, parent=None):
        super().__init__(parent)
        self._session_factory = db_session_factory
        self._current_setlist: Optional[Setlist] = None
        self._build_ui()
        self._load_data()

    def _build_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        splitter = QSplitter(Qt.Horizontal)
        layout.addWidget(splitter)

        # --- Left: Setlists ---
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(12, 12, 12, 12)

        left_layout.addWidget(QLabel("SETLISTS"))
        self._setlist_list = QListWidget()
        self._setlist_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self._setlist_list.customContextMenuRequested.connect(self._show_setlist_menu)
        self._setlist_list.itemClicked.connect(self._on_setlist_selected)
        left_layout.addWidget(self._setlist_list)

        btn_new = QPushButton("+ New Setlist")
        btn_new.clicked.connect(self._create_setlist)
        left_layout.addWidget(btn_new)

        splitter.addWidget(left)

        # --- Center: Songs in setlist ---
        center = QWidget()
        center_layout = QVBoxLayout(center)
        center_layout.setContentsMargins(12, 12, 12, 12)

        self._setlist_name_label = QLabel("No setlist selected")
        self._setlist_name_label.setObjectName("sectionTitle")
        center_layout.addWidget(self._setlist_name_label)

        self._song_list = QListWidget()
        self._song_list.setDragDropMode(QListWidget.InternalMove)
        self._song_list.model().rowsMoved.connect(self._on_songs_reordered)
        center_layout.addWidget(self._song_list)

        btn_add = QPushButton("+ Add Song")
        btn_add.clicked.connect(self._add_song_to_setlist)
        center_layout.addWidget(btn_add)

        btn_load = QPushButton("▶ Load for Session")
        btn_load.setObjectName("actionPad")
        btn_load.clicked.connect(self._load_setlist_for_session)
        center_layout.addWidget(btn_load)

        splitter.addWidget(center)

        # --- Right: Song editor ---
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(12, 12, 12, 12)

        right_layout.addWidget(QLabel("SONG EDITOR"))

        self._song_title = QLineEdit()
        self._song_title.setPlaceholderText("Title")
        right_layout.addWidget(self._song_title)

        self._song_bpm = QSpinBox()
        self._song_bpm.setRange(20, 300)
        self._song_bpm.setValue(120)
        right_layout.addWidget(QLabel("BPM"))
        right_layout.addWidget(self._song_bpm)

        self._song_key = QLineEdit()
        self._song_key.setPlaceholderText("Key (e.g., Am, F#)")
        right_layout.addWidget(self._song_key)

        self._song_lyrics = QTextEdit()
        self._song_lyrics.setPlaceholderText("Lyrics / ChordPro...")
        right_layout.addWidget(QLabel("Lyrics / Chords"))
        right_layout.addWidget(self._song_lyrics)

        btn_save = QPushButton("Save Song")
        btn_save.clicked.connect(self._save_song)
        right_layout.addWidget(btn_save)

        btn_import = QPushButton("Import LRC / ChordPro...")
        btn_import.clicked.connect(self._import_file)
        right_layout.addWidget(btn_import)

        splitter.addWidget(right)
        splitter.setSizes([250, 400, 350])

    def _load_data(self) -> None:
        session = self._session_factory()
        setlists = session.query(Setlist).all()
        for sl in setlists:
            item = QListWidgetItem(sl.name)
            item.setData(Qt.UserRole, sl.id)
            self._setlist_list.addItem(item)
        session.close()

    def _show_setlist_menu(self, pos) -> None:
        item = self._setlist_list.itemAt(pos)
        if not item:
            return
        menu = QMenu(self)
        menu.addAction("Rename", lambda: self._rename_setlist(item))
        menu.addAction("Delete", lambda: self._delete_setlist(item))
        menu.exec(self._setlist_list.mapToGlobal(pos))

    def _on_setlist_selected(self, item: QListWidgetItem) -> None:
        setlist_id = item.data(Qt.UserRole)
        session = self._session_factory()
        self._current_setlist = session.query(Setlist).filter_by(id=setlist_id).first()
        if self._current_setlist:
            self._setlist_name_label.setText(self._current_setlist.name)
            self._song_list.clear()
            for song in self._current_setlist.songs:
                si = QListWidgetItem(f"{song.title} ({song.bpm} BPM)")
                si.setData(Qt.UserRole, song.id)
                self._song_list.addItem(si)
        session.close()

    def _on_songs_reordered(self) -> None:
        # TODO: persist new order to association table
        pass

    def _create_setlist(self) -> None:
        # TODO: prompt for name, create in DB, refresh list
        pass

    def _rename_setlist(self, item: QListWidgetItem) -> None:
        # TODO: inline edit or dialog
        pass

    def _delete_setlist(self, item: QListWidgetItem) -> None:
        # TODO: confirm, delete from DB
        pass

    def _add_song_to_setlist(self) -> None:
        # TODO: dialog to select existing song or create new
        pass

    def _save_song(self) -> None:
        # TODO: create/update Song in DB
        pass

    def _import_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "Import Song", "", "LRC (*.lrc);;ChordPro (*.pro *.cho *.crd);;All Files (*.*)"
        )
        if not path:
            return
        try:
            if path.lower().endswith(".lrc"):
                lines = LRCParser.parse_file(path)
                text = "\n".join([l.text for l in lines])
                self._song_lyrics.setPlainText(text)
            else:
                data = ChordProParser.parse_file(path)
                self._song_title.setText(data["title"])
                self._song_bpm.setValue(data.get("bpm", 120))
                self._song_key.setText(data.get("key", ""))
                lines_text = "\n\n".join(
                    f"[{s['label']}]\n" + "\n".join(s["lines"]) for s in data["sections"]
                )
                self._song_lyrics.setPlainText(lines_text)
        except Exception as e:
            QMessageBox.critical(self, "Import Error", str(e))

    def _load_setlist_for_session(self) -> None:
        if self._current_setlist:
            self.setlist_loaded.emit(self._current_setlist)
