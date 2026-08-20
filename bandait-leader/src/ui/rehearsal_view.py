"""Rehearsal view: recordings, analysis, and AI-assisted feedback."""

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from src.db.models import Rehearsal


class RehearsalView(QWidget):
    """Browse past rehearsals, play recordings, view AI analysis."""

    rehearsal_selected = Signal(object)  # Rehearsal

    def __init__(self, db_session_factory, parent=None):
        super().__init__(parent)
        self._session_factory = db_session_factory
        self._current_rehearsal: Rehearsal | None = None
        self._build_ui()
        self._load_data()

    def _build_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        splitter = QSplitter(Qt.Horizontal)
        layout.addWidget(splitter)

        # --- Left: Rehearsal list ---
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(12, 12, 12, 12)

        left_layout.addWidget(QLabel("REHEARSALS"))
        self._rehearsal_list = QListWidget()
        self._rehearsal_list.itemClicked.connect(self._on_rehearsal_selected)
        left_layout.addWidget(self._rehearsal_list)

        btn_import = QPushButton("Import Folder...")
        btn_import.clicked.connect(self._import_folder)
        left_layout.addWidget(btn_import)

        splitter.addWidget(left)

        # --- Right: Details & analysis ---
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(12, 12, 12, 12)

        self._title_label = QLabel("No rehearsal selected")
        self._title_label.setObjectName("sectionTitle")
        right_layout.addWidget(self._title_label)

        self._info_label = QLabel("")
        right_layout.addWidget(self._info_label)

        self._notes = QTextEdit()
        self._notes.setPlaceholderText("Director notes, AI analysis, tempo deviations...")
        right_layout.addWidget(QLabel("Notes / Analysis"))
        right_layout.addWidget(self._notes)

        self._ai_summary = QTextEdit()
        self._ai_summary.setReadOnly(True)
        self._ai_summary.setPlaceholderText("AI analysis will appear here...")
        right_layout.addWidget(QLabel("AI Summary"))
        right_layout.addWidget(self._ai_summary)

        btn_analyze = QPushButton("🤖 Analyze with AI")
        btn_analyze.setObjectName("actionPad")
        btn_analyze.clicked.connect(self._request_ai_analysis)
        right_layout.addWidget(btn_analyze)

        btn_open_folder = QPushButton("Open Recording Folder")
        btn_open_folder.clicked.connect(self._open_recording_folder)
        right_layout.addWidget(btn_open_folder)

        splitter.addWidget(right)
        splitter.setSizes([350, 650])

    def _load_data(self) -> None:
        session = self._session_factory()
        rehearsals = session.query(Rehearsal).order_by(Rehearsal.date.desc()).all()
        for r in rehearsals:
            item = QListWidgetItem(
                f"{r.date.strftime('%Y-%m-%d %H:%M')} — {r.duration_minutes}min"
            )
            item.setData(Qt.UserRole, r.id)
            self._rehearsal_list.addItem(item)
        session.close()

    def _on_rehearsal_selected(self, item: QListWidgetItem) -> None:
        rid = item.data(Qt.UserRole)
        session = self._session_factory()
        r = session.query(Rehearsal).filter_by(id=rid).first()
        if r:
            self._current_rehearsal = r
            self._title_label.setText(f"Rehearsal {r.date.strftime('%Y-%m-%d')}")
            self._info_label.setText(
                f"Duration: {r.duration_minutes}min | Folder: {r.recording_folder}"
            )
            self._notes.setPlainText(r.notes or "")
        session.close()

    def _import_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Select Recording Folder")
        if not folder:
            return
        import uuid
        audio_files = list(Path(folder).glob("*.flac")) + list(Path(folder).glob("*.wav"))
        if not audio_files:
            QMessageBox.information(self, "Import", "No audio files found in folder.")
            return
        session = self._session_factory()
        r = Rehearsal(
            id=str(uuid.uuid4())[:8],
            recording_folder=folder,
            notes=f"Imported {len(audio_files)} tracks",
        )
        session.add(r)
        session.commit()
        item = QListWidgetItem(f"{r.date.strftime('%Y-%m-%d %H:%M')} — {len(audio_files)} tracks")
        item.setData(Qt.UserRole, r.id)
        self._rehearsal_list.addItem(item)
        session.close()

    def _request_ai_analysis(self) -> None:
        if not self._current_rehearsal:
            QMessageBox.information(self, "AI", "Select a rehearsal first.")
            return
        self._ai_summary.setPlainText(
            f"Analysis for rehearsal {self._current_rehearsal.date.strftime('%Y-%m-%d')}:\n"
            f"- Duration: {self._current_rehearsal.duration_minutes}min\n"
            f"- Tracks: {self._current_rehearsal.recording_folder}\n"
            f"\nConnect Google Cloud API key for AI-powered analysis."
        )

    def _open_recording_folder(self) -> None:
        if self._current_rehearsal and self._current_rehearsal.recording_folder:
            import os
            os.startfile(self._current_rehearsal.recording_folder)
