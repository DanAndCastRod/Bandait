"""Inspector de la vista Canciones (2.3): datos de la canción elegida, sus secciones y el
análisis con IA (Music AI). Solo muestra y emite; la ventana hace el trabajo en segundo plano.
"""

from typing import List, Optional

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QFrame, QGridLayout, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from src.ui import components as ui
from src.ui import theme


SEPARATE_TIP = ("Sube la canción completa (un solo audio): Music AI separa los stems, los deja en la "
                "nube de la banda y propone secciones y acordes. Gasta créditos y tarda unos minutos.")


class SongInspector(QWidget):
    analyze_requested = Signal()
    separate_requested = Signal()
    refresh_requested = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedWidth(400)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        box, body, self._actions = ui.panel("Canción")
        outer.addWidget(box)
        self.title = ui.label("Elige una canción", "title", wrap=True)
        body.addWidget(self.title)

        grid = QGridLayout()
        grid.setHorizontalSpacing(theme.SPACE_3)
        grid.setVerticalSpacing(theme.SPACE_1)
        self._values = {}
        for row, (key, caption) in enumerate((("artist", "Artista"), ("tempo", "Tempo"), ("key", "Tono"),
                                               ("stems", "Stems"))):
            grid.addWidget(ui.label(caption, "muted"), row, 0)
            value = ui.label("—", "body")
            grid.addWidget(value, row, 1)
            self._values[key] = value
        grid.setColumnStretch(1, 1)
        body.addLayout(grid)

        # Music AI
        self.ai_box = QFrame()
        self.ai_box.setProperty("role", "callout-ai")
        ai = QVBoxLayout(self.ai_box)
        ai.setContentsMargins(theme.SPACE_3, theme.SPACE_3, theme.SPACE_3, theme.SPACE_3)
        ai.setSpacing(theme.SPACE_2)
        head = QHBoxLayout()
        head.addWidget(ui.tag("Music AI", "ai"))
        self.ai_state = ui.label("", "muted")
        head.addWidget(self.ai_state, 1)
        ai.addLayout(head)
        self.ai_text = ui.label("Analiza los stems de esta canción para proponer secciones, acordes y tempo.",
                                "muted", wrap=True)
        ai.addWidget(self.ai_text)
        buttons = QHBoxLayout()
        self.analyze_btn = ui.button("Analizar con IA", "ai", "Mezcla los stems del portátil y los manda a Music AI")
        self.analyze_btn.clicked.connect(self.analyze_requested.emit)
        self.separate_btn = ui.button("Separar desde un audio…", "secondary", SEPARATE_TIP)
        self.separate_btn.clicked.connect(self.separate_requested.emit)
        self.refresh_btn = ui.button("Actualizar", "ghost", "Consultar el estado del análisis")
        self.refresh_btn.clicked.connect(self.refresh_requested.emit)
        buttons.addWidget(self.analyze_btn)
        buttons.addWidget(self.separate_btn)
        buttons.addWidget(self.refresh_btn)
        buttons.addStretch()
        ai.addLayout(buttons)
        body.addWidget(self.ai_box)

        body.addWidget(ui.label("Secciones", "label"))
        self._sections_box = QVBoxLayout()
        self._sections_box.setSpacing(2)
        body.addLayout(self._sections_box)
        self._section_rows: List[QWidget] = []
        body.addStretch()
        self.set_song(None)

    def set_song(self, song: Optional[dict], sections: Optional[list] = None, stems: str = "",
                 can_analyze: bool = False, reason: str = "", can_separate: bool = False, separate_reason: str = ""):
        """``song``: dict con title, artist, bpm, key. ``sections``: [{label, bars, start_bar}]."""
        has = bool(song)
        self.title.setText(song.get("title", "") if has else "Elige una canción")
        self._values["artist"].setText((song or {}).get("artist") or "—")
        self._values["tempo"].setText(f"{(song or {}).get('bpm')} BPM" if has and song.get("bpm") else "—")
        self._values["key"].setText((song or {}).get("key") or "—")
        self._values["stems"].setText(stems or "—")
        for w in self._section_rows:
            w.setParent(None)
            w.deleteLater()
        self._section_rows = []
        for sec in sections or []:
            row = QWidget()
            h = QHBoxLayout(row)
            h.setContentsMargins(0, 0, 0, 0)
            h.addWidget(ui.label(f"C {sec.get('start_bar', '')}", "mono"))
            h.addWidget(ui.label(str(sec.get("label") or sec.get("kind") or ""), "body"), 1)
            h.addWidget(ui.label(f"{sec.get('bars', '')} c", "muted"))
            self._sections_box.addWidget(row)
            self._section_rows.append(row)
        if has and not sections:
            empty = ui.label("Sin secciones: pégalas en el hub o usa Analizar con IA.", "muted", wrap=True)
            self._sections_box.addWidget(empty)
            self._section_rows.append(empty)
        self.ai_box.setVisible(has)
        self.analyze_btn.setEnabled(can_analyze)
        self.analyze_btn.setToolTip(reason or "Mezcla los stems del portátil y los manda a Music AI")
        self._can = (can_analyze, can_separate)
        self.separate_btn.setEnabled(can_separate)
        self.separate_btn.setToolTip(separate_reason or SEPARATE_TIP)
        self.set_analysis("", "")

    def set_analysis(self, state: str, text: str, busy: bool = False):
        self.ai_state.setText(state)
        if text:
            self.ai_text.setText(text)
        self.refresh_btn.setEnabled(not busy)
        can_analyze, can_separate = getattr(self, "_can", (False, False))
        self.analyze_btn.setEnabled(can_analyze and not busy)
        self.separate_btn.setEnabled(can_separate and not busy)

    def section_count(self) -> int:
        return sum(1 for w in self._section_rows if not isinstance(w, QLabel))
