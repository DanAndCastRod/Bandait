"""
Bandait Líder: vista Escenario (2.3).

Tres columnas, como la maqueta aprobada: el setlist en vivo; el prompter con la sección
actual, su ChordPro y el avance por secciones; y a la derecha el pulso, los músicos
conectados y el estado de los stems. PANIC vive en la barra superior de la ventana.
Todo el estilo sale del QSS por propiedades (role, kind, state); nada de setStyleSheet.
"""

import html
from typing import List, Optional

from PySide6.QtCore import QPropertyAnimation, Qt, QTimer, Signal
from PySide6.QtGui import QBrush, QColor, QKeyEvent
from PySide6.QtWidgets import (
    QAbstractItemView, QFrame, QHBoxLayout, QLabel, QListWidget, QListWidgetItem, QPushButton,
    QVBoxLayout, QWidget,
)

from src.ui import components as ui
from src.ui import theme
from src.ui.chordpro_layout import MUSICIAN, SINGER, preview_text, section_html, section_index_at

# Prompter text size by mode (px): the musician view is monospace, so it is smaller.
LYRIC_PX = {SINGER: 40, MUSICIAN: 28}


class StageView(QWidget):
    """Vista de escenario para eventos en vivo."""

    panic_clicked = Signal()
    next_song_clicked = Signal()
    prev_song_clicked = Signal()
    fullscreen_requested = Signal()
    open_tracks = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._bpm = 120
        self._beat = 1
        self._beat_lit = False
        self._song_title = "Sin canción"
        self._section = ""
        self._next_section = ""
        self._is_fullscreen = False
        self._network_ok = True
        self._lyrics = []
        self._current_lyric_idx = 0
        # Song content of the live item (CONTRACT_V3 9.1): sections with ChordPro.
        self._content: Optional[dict] = None
        self._section_idx = -1
        self._prompter_mode = MUSICIAN
        self._strip_labels: List[QLabel] = []
        self._setup_ui()
        self._flash_anim = QPropertyAnimation(self, b"windowOpacity")

    # ------------------------------------------------------------------ layout
    def _setup_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # Network beacon: a thin line, green while the LAN is up.
        self.beacon = ui.frame("beacon")
        self.beacon.setProperty("state", "ok")
        self.beacon.setFixedHeight(3)
        root.addWidget(self.beacon)

        # Avisos: salto no secuencial (temporal) y setlist vacío (persistente).
        self.jump_alert = ui.tag("", "warn")
        self.jump_alert.setAlignment(Qt.AlignCenter)
        self.jump_alert.hide()
        self._jump_timer = QTimer(self)
        self._jump_timer.setSingleShot(True)
        self._jump_timer.timeout.connect(self.jump_alert.hide)
        self.setlist_notice = ui.label("", "body", wrap=True)
        self.setlist_notice.setObjectName("setlistNotice")
        self.setlist_notice.setAlignment(Qt.AlignCenter)
        self.setlist_notice.hide()
        alerts = QVBoxLayout()
        alerts.setContentsMargins(theme.SPACE_4, theme.SPACE_2, theme.SPACE_4, 0)
        alerts.addWidget(self.jump_alert)
        alerts.addWidget(self.setlist_notice)
        root.addLayout(alerts)

        grid = QHBoxLayout()
        grid.setContentsMargins(theme.SPACE_4, theme.SPACE_4, theme.SPACE_4, theme.SPACE_4)
        grid.setSpacing(theme.SPACE_4)
        grid.addWidget(self._build_setlist_panel())
        grid.addWidget(self._build_prompter_panel(), 1)
        grid.addLayout(self._build_right_column())
        root.addLayout(grid, 1)

    def _build_setlist_panel(self) -> QFrame:
        box, body, actions = ui.panel("Setlist")
        box.setFixedWidth(280)
        body.setContentsMargins(0, 0, 0, 0)
        self.prev_btn = ui.button("◀", "ghost", "Canción anterior")
        self.prev_btn.clicked.connect(self.prev_song_clicked.emit)
        self.next_btn = ui.button("▶", "ghost", "Siguiente canción")
        self.next_btn.clicked.connect(self.next_song_clicked.emit)
        actions.addWidget(self.prev_btn)
        actions.addWidget(self.next_btn)
        self.setlist_rail = QListWidget()
        self.setlist_rail.setObjectName("setlistRail")
        self.setlist_rail.setFocusPolicy(Qt.NoFocus)
        self.setlist_rail.setSelectionMode(QAbstractItemView.NoSelection)
        self.setlist_rail.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setlist_rail.setTextElideMode(Qt.ElideRight)
        body.addWidget(self.setlist_rail, 1)
        return box

    def _build_prompter_panel(self) -> QFrame:
        box = ui.frame("panel")
        col = QVBoxLayout(box)
        col.setContentsMargins(theme.SPACE_5, theme.SPACE_4, theme.SPACE_5, theme.SPACE_4)
        col.setSpacing(theme.SPACE_3)

        head = QHBoxLayout()
        head.setSpacing(theme.SPACE_2)
        self.section_head = ui.label("", "section-head")
        head.addWidget(self.section_head)
        head.addStretch()
        self.mode_btn = QPushButton("ACORDES")
        self.mode_btn.setObjectName("prompterMode")
        self.mode_btn.setCursor(Qt.PointingHandCursor)
        self.mode_btn.setToolTip("Alternar entre acordes con letra y solo letra")
        self.mode_btn.clicked.connect(self.toggle_prompter_mode)
        self.mode_btn.hide()
        head.addWidget(self.mode_btn)
        self.fullscreen_btn = ui.button("Pantalla completa", "ghost", "F11")
        self.fullscreen_btn.clicked.connect(self._toggle_fullscreen)
        head.addWidget(self.fullscreen_btn)
        col.addLayout(head)

        title_row = QHBoxLayout()
        title_row.setSpacing(theme.SPACE_3)
        self.song_title = ui.label(self._song_title, "display")
        self.section_label = ui.label("", "muted")
        title_row.addWidget(self.song_title)
        title_row.addWidget(self.section_label, 0, Qt.AlignBottom)
        title_row.addStretch()
        col.addLayout(title_row)

        col.addStretch(1)
        self.current_lyric = QLabel("Esperando canción...")
        self.current_lyric.setWordWrap(True)
        self.current_lyric.setTextFormat(Qt.RichText)
        self._style_lyric(SINGER)
        col.addWidget(self.current_lyric)
        col.addStretch(1)

        sep = ui.frame("divider-h")
        sep.setFixedHeight(1)
        col.addWidget(sep)
        self.next_lyric = ui.label("", "next")
        self.next_lyric.setTextFormat(Qt.PlainText)
        self.next_lyric.setWordWrap(True)
        col.addWidget(self.next_lyric)
        self.section_strip = QWidget()
        self._strip_layout = QHBoxLayout(self.section_strip)
        self._strip_layout.setContentsMargins(0, 0, 0, 0)
        self._strip_layout.setSpacing(3)
        self.section_strip.setFixedHeight(28)
        col.addWidget(self.section_strip)
        return box

    def _build_right_column(self) -> QVBoxLayout:
        col = QVBoxLayout()
        col.setSpacing(theme.SPACE_4)

        pulse, pbody, _ = ui.panel("Pulso")
        pulse.setFixedWidth(300)
        self.bpm_display = ui.label("120", "giant")
        self.bpm_display.setAlignment(Qt.AlignCenter)
        pbody.addWidget(self.bpm_display)
        beats = QHBoxLayout()
        beats.setSpacing(6)
        beats.addStretch()
        self.beat_indicators = []
        for _i in range(4):
            led = QFrame()
            led.setProperty("role", "beat")
            led.setProperty("state", "")
            led.setFixedSize(40, 8)
            beats.addWidget(led)
            self.beat_indicators.append(led)
        beats.addStretch()
        pbody.addLayout(beats)
        stats = QHBoxLayout()
        bar_w, self.bar_label = ui.stat("Compás", "-", "readout-plain")
        next_w, self.next_section_label = ui.stat("Próxima", "-", "next-section")
        stats.addWidget(bar_w)
        stats.addStretch()
        stats.addWidget(next_w)
        pbody.addLayout(stats)
        col.addWidget(pulse)

        musicians, mbody, mactions = ui.panel("Músicos")
        musicians.setFixedWidth(300)
        self.musicians_tag = ui.tag("0 en línea", "")
        mactions.addWidget(self.musicians_tag)
        mbody.setSpacing(theme.SPACE_1)
        self._musicians_body = mbody
        self._musician_rows: List[QWidget] = []
        self.musicians_empty = ui.label("Nadie conectado todavía. Usa Conectar músicos.", "muted", wrap=True)
        mbody.addWidget(self.musicians_empty)
        col.addWidget(musicians, 1)

        stems, sbody, sactions = ui.panel("Stems")
        stems.setFixedWidth(300)
        self.stems_tag = ui.tag("Sin stems", "")
        sactions.addWidget(self.stems_tag)
        self.stems_summary = ui.label("Esta canción no tiene stems.", "muted", wrap=True)
        sbody.addWidget(self.stems_summary)
        go = ui.button("Abrir Pistas", "ghost")
        go.clicked.connect(self.open_tracks.emit)
        sbody.addWidget(go, 0, Qt.AlignLeft)
        col.addWidget(stems)

        # PANIC está en la barra superior; este botón se conserva oculto para atajos y pruebas.
        self.panic_btn = QPushButton("DETENER SESIÓN")
        self.panic_btn.clicked.connect(self.panic_clicked.emit)
        self.panic_btn.hide()
        return col

    # ------------------------------------------------------------------ legacy song path
    def set_song(self, title: str, current_lyric: str = "", next_lyric: str = "",
                 section: str = "", next_section: str = ""):
        """Song without content from the hub: plain lyrics (legacy path)."""
        self._content = None
        self._section_idx = -1
        self.section_head.setText("")
        self.mode_btn.hide()  # only songs with hub sections have chords to toggle
        self._song_title = title
        self.song_title.setText(title)
        self._style_lyric(SINGER)
        self.current_lyric.setText(html.escape(current_lyric or "Esperando canción..."))
        self.next_lyric.setText(next_lyric)
        self.section_label.setText(section)
        self._section = section
        self._next_section = next_section
        self.next_section_label.setText(next_section or "-")
        self._current_lyric_idx = 0
        self._build_strip([])

    def set_lyrics(self, lyrics: list):
        """Guardar lista de letras para scroll sincronizado."""
        self._lyrics = lyrics
        self._current_lyric_idx = 0
        if lyrics and self._content is None:
            self.current_lyric.setText(html.escape(lyrics[0]["text"]))
            self.next_lyric.setText(lyrics[1]["text"] if len(lyrics) > 1 else "")

    # ------------------------------------------------------------------ pulse
    def set_bpm(self, bpm: int):
        self._bpm = bpm
        self.bpm_display.setText(str(bpm))

    def set_beat(self, beat: int):
        """Pulso actual (1-4). Solo repule los dos indicadores que cambian."""
        prev = self._beat if self._beat_lit else None
        self._beat = beat
        self._beat_lit = True
        if prev is not None and 0 < prev <= len(self.beat_indicators) and prev != beat:
            ui.set_prop(self.beat_indicators[prev - 1], "state", "")
        if 0 < beat <= len(self.beat_indicators):
            ui.set_prop(self.beat_indicators[beat - 1], "state", "one" if beat == 1 else "on")

    def clear_beat(self):
        for led in self.beat_indicators:
            ui.set_prop(led, "state", "")
        self._beat_lit = False

    def set_bar(self, bar):
        self.bar_label.setText(str(bar) if bar is not None else "-")
        if self._content is not None:
            self._show_section(section_index_at(self._content.get("sections") or [], bar))

    # ------------------------------------------------------------------ setlist rail and prompter
    def set_setlist(self, entries, current_song_id=None):
        """Live setlist in the rail (dicts with song_id, title, bpm)."""
        self.setlist_rail.clear()
        for i, e in enumerate(entries or []):
            title = e.get("title") or e.get("song_id")
            item = QListWidgetItem(f"{i + 1:02d}   {title}\n        {e.get('bpm', '')} BPM")
            item.setData(Qt.UserRole, e.get("song_id"))
            self.setlist_rail.addItem(item)
        self.set_current_song_id(current_song_id)

    def set_current_song_id(self, song_id):
        live_row = -1
        for i in range(self.setlist_rail.count()):
            item = self.setlist_rail.item(i)
            if song_id is not None and item.data(Qt.UserRole) == song_id:
                live_row = i
        for i in range(self.setlist_rail.count()):
            item = self.setlist_rail.item(i)
            live = i == live_row
            done = live_row >= 0 and i < live_row
            font = item.font()
            font.setBold(live)
            item.setFont(font)
            color = theme.FG_STRONG if live else (theme.MUTED if done else theme.SECONDARY)
            item.setForeground(QBrush(QColor(color)))
            item.setBackground(QBrush(QColor(theme.ELEVATED if live else theme.SURFACE)))
            if live:
                self.setlist_rail.scrollToItem(item, QAbstractItemView.PositionAtCenter)

    def rail_song_ids(self) -> list:
        return [self.setlist_rail.item(i).data(Qt.UserRole) for i in range(self.setlist_rail.count())]

    def set_song_content(self, content: Optional[dict]):
        """Content of the live song (load_setlist_entries dict or GET /songs/<id>.json).
        Without sections the legacy plain lyrics stay."""
        if not content or not content.get("sections"):
            return
        self._content = content
        self._section_idx = -1
        self.mode_btn.show()
        title = content.get("title") or self._song_title
        self._song_title = title
        key = content.get("show_key") or content.get("key") or ""
        artist = content.get("artist") or ""
        self.song_title.setText(title)
        self.section_label.setText(" // ".join(p for p in (artist, key) if p))
        self._build_strip(content.get("sections") or [])
        self._show_section(0)

    def toggle_prompter_mode(self):
        self.set_prompter_mode(SINGER if self._prompter_mode == MUSICIAN else MUSICIAN)

    def set_prompter_mode(self, mode: str):
        self._prompter_mode = SINGER if mode == SINGER else MUSICIAN
        self.mode_btn.setText("LETRA" if self._prompter_mode == SINGER else "ACORDES")
        if self._content is not None:
            idx, self._section_idx = self._section_idx, -1
            self._show_section(max(idx, 0))

    def prompter_mode(self) -> str:
        return self._prompter_mode

    def current_section_index(self) -> int:
        return self._section_idx

    def _style_lyric(self, mode: str):
        """Singer: big centered lyrics. Musician: monospace, left aligned, so chords stay over syllables."""
        ui.set_prop(self.current_lyric, "kind", "prompter-singer" if mode == SINGER else "prompter-musician")
        self.current_lyric.setAlignment(Qt.AlignCenter if mode == SINGER else (Qt.AlignLeft | Qt.AlignVCenter))

    def _build_strip(self, sections: list):
        """Progress through the song: one block per section, as wide as its bars."""
        for lab in self._strip_labels:
            lab.setParent(None)
            lab.deleteLater()
        self._strip_labels = []
        while self._strip_layout.count():
            self._strip_layout.takeAt(0)
        for sec in sections:
            lab = QLabel((sec.get("label") or sec.get("kind") or "").strip())
            lab.setProperty("role", "sec")
            lab.setProperty("state", "")
            lab.setToolTip(f"{sec.get('label', '')} · {sec.get('bars', 0)} compases")
            self._strip_layout.addWidget(lab, max(1, int(sec.get("bars", 1))))
            self._strip_labels.append(lab)
        self.section_strip.setVisible(bool(sections))

    def _show_section(self, idx: int):
        """Re-render only when the section changes (set_bar runs on every beat)."""
        sections = (self._content or {}).get("sections") or []
        if idx == self._section_idx or not (0 <= idx < len(sections)):
            return
        self._section_idx = idx
        sec = sections[idx]
        start = int(sec.get("start_bar", 1))
        bars = int(sec.get("bars", 1))
        name = (sec.get("label") or sec.get("kind") or "").upper()
        self.section_head.setText(f"{name}   C {start}-{start + bars - 1}")
        self._style_lyric(self._prompter_mode)
        self.current_lyric.setText(
            section_html(sec.get("chordpro", ""), self._prompter_mode, sec.get("cue_text"), LYRIC_PX[self._prompter_mode])
        )
        nxt = sections[idx + 1] if idx + 1 < len(sections) else None
        if nxt is not None:
            label = (nxt.get("label") or nxt.get("kind") or "").upper()
            cue = preview_text(nxt.get("chordpro", ""), self._prompter_mode, nxt.get("cue_text"))
            same = cue.strip().upper() == label
            self.next_lyric.setText(f"SIGUE: {label}" + (f"  //  {cue}" if cue and not same else ""))
            self.next_section_label.setText(label.title())
        else:
            self.next_lyric.setText("FIN DE LA CANCION")
            self.next_section_label.setText("-")
        for i, lab in enumerate(self._strip_labels):
            ui.set_prop(lab, "state", "now" if i == idx else ("done" if i < idx else ""))

    # ------------------------------------------------------------------ right column
    def set_followers(self, rows: List[dict]):
        """Músicos conectados: [{alias, detail, latency, health}] ya formateados por la ventana."""
        for w in self._musician_rows:
            w.setParent(None)
            w.deleteLater()
        self._musician_rows = []
        self.musicians_empty.setVisible(not rows)
        for r in rows[:8]:
            row = QWidget()
            h = QHBoxLayout(row)
            h.setContentsMargins(0, 2, 0, 2)
            h.setSpacing(theme.SPACE_2)
            dot = QFrame()
            dot.setProperty("role", "dot")
            dot.setProperty("health", r.get("health") or "stale")
            dot.setFixedSize(8, 8)
            h.addWidget(dot)
            col = QVBoxLayout()
            col.setSpacing(0)
            col.addWidget(ui.label(str(r.get("alias", "")), "body"))
            col.addWidget(ui.label(str(r.get("detail", "")), "muted"))
            h.addLayout(col, 1)
            h.addWidget(ui.label(str(r.get("latency", "—")), "mono"))
            self._musicians_body.addWidget(row)
            self._musician_rows.append(row)
        self.musicians_tag.setText(f"{len(rows)} EN LÍNEA")
        ui.set_prop(self.musicians_tag, "tag", "ok" if rows else "")

    def set_stems_status(self, labels: List[str], cloud: str = ""):
        """Stems of the live song (names) and where they come from."""
        if labels:
            self.stems_summary.setText(", ".join(labels))
            self.stems_tag.setText(cloud or f"{len(labels)} PISTAS")
            ui.set_prop(self.stems_tag, "tag", "ok")
        else:
            self.stems_summary.setText("Esta canción no tiene stems.")
            self.stems_tag.setText("SIN STEMS")
            ui.set_prop(self.stems_tag, "tag", "")

    # ------------------------------------------------------------------ alerts and window
    def show_jump_alert(self, title: str, order_index: int):
        """Aviso grande de salto no secuencial (order_index 0-based)."""
        self.jump_alert.setText(f"SALTO: {title} (tema {order_index + 1})")
        self.jump_alert.show()
        self._jump_timer.start(5000)

    def set_setlist_notice(self, text):
        """Mostrar (texto) u ocultar (None / "") el aviso de setlist vacío."""
        text = text or ""
        if text == self.setlist_notice.text() and self.setlist_notice.isHidden() != bool(text):
            return  # no re-layout on every state update
        self.setlist_notice.setText(text)
        self.setlist_notice.setVisible(bool(text))

    def setlist_notice_text(self) -> str:
        return self.setlist_notice.text() if not self.setlist_notice.isHidden() else ""

    def set_network_status(self, ok: bool):
        self._network_ok = ok
        ui.set_prop(self.beacon, "state", "ok" if ok else "bad")

    def _toggle_fullscreen(self):
        # Un widget hijo no puede ponerse en pantalla completa por si mismo:
        # la ventana principal lo hace y luego llama a set_fullscreen_state().
        self.fullscreen_requested.emit()

    def set_fullscreen_state(self, fullscreen: bool):
        self._is_fullscreen = fullscreen
        self.fullscreen_btn.setText("Salir de pantalla completa" if fullscreen else "Pantalla completa")

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_Escape and self._is_fullscreen:
            self._toggle_fullscreen()
        super().keyPressEvent(event)
