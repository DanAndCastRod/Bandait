"""Gig manager: events, venues, setlist assignments, and post-gig notes."""

from datetime import datetime
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
    QDateTimeEdit,
    QTextEdit,
    QComboBox,
    QMessageBox,
    QSplitter,
)
from PySide6.QtCore import Qt, QDateTime, Signal

from src.db.models import Gig, Setlist, BandMember


class GigManagerView(QWidget):
    """CRUD for gigs/events with setlist and band member assignments."""

    gig_selected = Signal(object)  # Gig

    def __init__(self, db_session_factory, parent=None):
        super().__init__(parent)
        self._session_factory = db_session_factory
        self._current_gig: Optional[Gig] = None
        self._build_ui()
        self._load_data()

    def _build_ui(self) -> None:
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        splitter = QSplitter(Qt.Horizontal)
        layout.addWidget(splitter)

        # --- Left: Gig list ---
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(12, 12, 12, 12)

        left_layout.addWidget(QLabel("EVENTS / GIGS"))
        self._gig_list = QListWidget()
        self._gig_list.itemClicked.connect(self._on_gig_selected)
        left_layout.addWidget(self._gig_list)

        btn_new = QPushButton("+ New Event")
        btn_new.clicked.connect(self._create_gig)
        left_layout.addWidget(btn_new)

        splitter.addWidget(left)

        # --- Right: Gig editor ---
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(12, 12, 12, 12)

        right_layout.addWidget(QLabel("EVENT DETAILS"))

        self._gig_name = QLineEdit()
        self._gig_name.setPlaceholderText("Event name")
        right_layout.addWidget(self._gig_name)

        self._gig_venue = QLineEdit()
        self._gig_venue.setPlaceholderText("Venue")
        right_layout.addWidget(self._gig_venue)

        self._gig_date = QDateTimeEdit()
        self._gig_date.setCalendarPopup(True)
        self._gig_date.setDateTime(QDateTime.currentDateTime())
        right_layout.addWidget(QLabel("Date & Time"))
        right_layout.addWidget(self._gig_date)

        self._gig_setlist = QComboBox()
        self._gig_setlist.setPlaceholderText("Select setlist...")
        right_layout.addWidget(QLabel("Setlist"))
        right_layout.addWidget(self._gig_setlist)

        self._gig_status = QComboBox()
        self._gig_status.addItems(["planned", "confirmed", "completed", "cancelled"])
        right_layout.addWidget(QLabel("Status"))
        right_layout.addWidget(self._gig_status)

        self._gig_notes = QTextEdit()
        self._gig_notes.setPlaceholderText("Pre-show checklist, post-show notes...")
        right_layout.addWidget(QLabel("Notes"))
        right_layout.addWidget(self._gig_notes)

        btn_save = QPushButton("Save Event")
        btn_save.clicked.connect(self._save_gig)
        right_layout.addWidget(btn_save)

        btn_load = QPushButton("▶ Load for Session")
        btn_load.setObjectName("actionPad")
        btn_load.clicked.connect(self._load_gig_for_session)
        right_layout.addWidget(btn_load)

        splitter.addWidget(right)
        splitter.setSizes([350, 650])

    def _load_data(self) -> None:
        session = self._session_factory()
        gigs = session.query(Gig).order_by(Gig.date.desc()).all()
        for g in gigs:
            item = QListWidgetItem(f"{g.name} @ {g.venue} ({g.date.strftime('%Y-%m-%d')})")
            item.setData(Qt.UserRole, g.id)
            self._gig_list.addItem(item)

        setlists = session.query(Setlist).all()
        for sl in setlists:
            self._gig_setlist.addItem(sl.name, sl.id)
        session.close()

    def _on_gig_selected(self, item: QListWidgetItem) -> None:
        gig_id = item.data(Qt.UserRole)
        session = self._session_factory()
        gig = session.query(Gig).filter_by(id=gig_id).first()
        if gig:
            self._current_gig = gig
            self._gig_name.setText(gig.name)
            self._gig_venue.setText(gig.venue)
            self._gig_date.setDateTime(QDateTime.fromString(gig.date.isoformat(), Qt.ISODate))
            self._gig_status.setCurrentText(gig.status)
            self._gig_notes.setPlainText(gig.notes or "")
            if gig.setlist_id:
                idx = self._gig_setlist.findData(gig.setlist_id)
                if idx >= 0:
                    self._gig_setlist.setCurrentIndex(idx)
        session.close()

    def _create_gig(self) -> None:
        from PySide6.QtWidgets import QInputDialog, QMessageBox
        import uuid
        name, ok = QInputDialog.getText(self, "New Event", "Event name:")
        if not ok or not name.strip():
            return
        venue, ok = QInputDialog.getText(self, "New Event", "Venue:")
        if not ok:
            venue = ""
        session = self._session_factory()
        gig = Gig(
            id=str(uuid.uuid4())[:8],
            name=name.strip(),
            venue=venue.strip(),
            date=datetime.now(),
            status="planned",
        )
        session.add(gig)
        session.commit()
        item = QListWidgetItem(f"{gig.name} @ {gig.venue} ({gig.date.strftime('%Y-%m-%d')})")
        item.setData(Qt.UserRole, gig.id)
        self._gig_list.addItem(item)
        session.close()

    def _save_gig(self) -> None:
        if not self._current_gig:
            return
        session = self._session_factory()
        gig = session.query(Gig).filter_by(id=self._current_gig.id).first()
        if gig:
            gig.name = self._gig_name.text()
            gig.venue = self._gig_venue.text()
            gig.date = self._gig_date.dateTime().toPython()
            gig.status = self._gig_status.currentText()
            gig.notes = self._gig_notes.toPlainText()
            setlist_id = self._gig_setlist.currentData()
            if setlist_id:
                gig.setlist_id = setlist_id
            session.commit()
        session.close()

    def _load_gig_for_session(self) -> None:
        if self._current_gig:
            self.gig_selected.emit(self._current_gig)
