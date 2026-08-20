"""Library view: song management, setlist editor, and content browser."""


from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from src.db.models import Setlist, Song, setlist_song_association
from src.infrastructure.parsers.chordpro_parser import ChordProParser
from src.infrastructure.parsers.lrc_parser import LRCParser


class LibraryView(QWidget):
    """Song library, setlist editor, and import interface."""

    setlist_loaded = Signal(object)  # Setlist

    def __init__(self, db_session_factory, parent=None):
        super().__init__(parent)
        self._session_factory = db_session_factory
        self._current_setlist: Setlist | None = None
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
        if not self._current_setlist:
            return
        session = self._session_factory()
        setlist = session.query(Setlist).filter_by(id=self._current_setlist.id).first()
        if setlist:
            # Update positions in association table
            for i in range(self._song_list.count()):
                item = self._song_list.item(i)
                song_id = item.data(Qt.UserRole)
                # Update position via raw SQL since SQLAlchemy association table
                session.execute(
                    setlist_song_association.update()
                    .where(
                        (setlist_song_association.c.setlist_id == setlist.id) &
                        (setlist_song_association.c.song_id == song_id)
                    )
                    .values(position=i)
                )
            session.commit()
        session.close()

    def _create_setlist(self) -> None:
        from PySide6.QtWidgets import QInputDialog
        name, ok = QInputDialog.getText(self, "New Setlist", "Setlist name:")
        if not ok or not name.strip():
            return
        import uuid
        session = self._session_factory()
        sl = Setlist(id=str(uuid.uuid4())[:8], name=name.strip())
        session.add(sl)
        session.commit()
        item = QListWidgetItem(sl.name)
        item.setData(Qt.UserRole, sl.id)
        self._setlist_list.addItem(item)
        session.close()

    def _rename_setlist(self, item: QListWidgetItem) -> None:
        from PySide6.QtWidgets import QInputDialog
        setlist_id = item.data(Qt.UserRole)
        new_name, ok = QInputDialog.getText(self, "Rename Setlist", "New name:", text=item.text())
        if not ok or not new_name.strip():
            return
        session = self._session_factory()
        sl = session.query(Setlist).filter_by(id=setlist_id).first()
        if sl:
            sl.name = new_name.strip()
            session.commit()
            item.setText(sl.name)
        session.close()

    def _delete_setlist(self, item: QListWidgetItem) -> None:
        from PySide6.QtWidgets import QMessageBox
        ret = QMessageBox.question(self, "Delete Setlist", f"Delete '{item.text()}'?")
        if ret != QMessageBox.Yes:
            return
        setlist_id = item.data(Qt.UserRole)
        session = self._session_factory()
        sl = session.query(Setlist).filter_by(id=setlist_id).first()
        if sl:
            session.delete(sl)
            session.commit()
            self._setlist_list.takeItem(self._setlist_list.row(item))
        session.close()

    def _add_song_to_setlist(self) -> None:
        if not self._current_setlist:
            QMessageBox.information(self, "Add Song", "Select a setlist first.")
            return
        from PySide6.QtWidgets import QInputDialog
        title, ok = QInputDialog.getText(self, "New Song", "Song title:")
        if not ok or not title.strip():
            return
        import uuid
        session = self._session_factory()
        song = Song(
            id=str(uuid.uuid4())[:8],
            title=title.strip(),
            bpm=self._song_bpm.value(),
            key=self._song_key.text(),
            lyrics_text=self._song_lyrics.toPlainText(),
        )
        session.add(song)
        # Add to current setlist with next position
        max_pos = session.query(setlist_song_association.c.position).filter_by(
            setlist_id=self._current_setlist.id
        ).order_by(setlist_song_association.c.position.desc()).first()
        next_pos = (max_pos[0] + 1) if max_pos else 0
        session.execute(
            setlist_song_association.insert().values(
                setlist_id=self._current_setlist.id,
                song_id=song.id,
                position=next_pos,
            )
        )
        session.commit()
        si = QListWidgetItem(f"{song.title} ({song.bpm} BPM)")
        si.setData(Qt.UserRole, song.id)
        self._song_list.addItem(si)
        session.close()

    def _save_song(self) -> None:
        import uuid
        session = self._session_factory()
        song = Song(
            id=str(uuid.uuid4())[:8],
            title=self._song_title.text() or "Untitled",
            bpm=self._song_bpm.value(),
            key=self._song_key.text(),
            lyrics_text=self._song_lyrics.toPlainText(),
        )
        session.add(song)
        session.commit()
        QMessageBox.information(self, "Saved", f"Song '{song.title}' saved to library.")
        session.close()

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
