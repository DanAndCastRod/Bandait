"""
Bandait DAW — Vista de Escenario (Modo Evento en Vivo)
Pantalla fullscreen minimalista para performance en vivo.
Flash de bordes para metrónomo, letras grandes, beacon de red.
"""

import html
from typing import Optional

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QFrame, QListWidget, QListWidgetItem, QAbstractItemView
)
from PySide6.QtCore import Qt, QTimer, Signal, QPropertyAnimation, QEasingCurve
from PySide6.QtGui import QBrush, QColor, QFont, QKeyEvent

from src.ui import theme
from src.ui.chordpro_layout import MUSICIAN, SINGER, preview_text, section_html, section_index_at


# Prompter text size by mode (px): the musician view is monospace, so it is smaller.
LYRIC_PX = {SINGER: 40, MUSICIAN: 28}


class StageView(QWidget):
    """Vista de escenario para eventos en vivo. Pantalla completa, minimalista."""

    panic_clicked = Signal()
    next_song_clicked = Signal()
    prev_song_clicked = Signal()
    fullscreen_requested = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._bpm = 120
        self._beat = 1
        self._song_title = "Sin canción"
        self._section = "Intro"
        self._next_section = "Verso"
        self._is_fullscreen = False
        self._network_ok = True
        self._beat_flash = False
        self._lyrics = []
        self._current_lyric_idx = 0
        # Song content of the live item (CONTRACT_V3 9.1): sections with ChordPro.
        self._content: Optional[dict] = None
        self._section_idx = -1
        self._prompter_mode = MUSICIAN

        self._setup_ui()
        self._setup_animations()
        self._setup_timer()

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(0)
        layout.setContentsMargins(0, 0, 0, 0)

        # === BEACON DE RED (barra superior) ===
        self.beacon = QFrame()
        self.beacon.setFixedHeight(6)
        self.beacon.setStyleSheet("background-color: #B8CF7A;")
        layout.addWidget(self.beacon)

        # === HEADER: Título y controles ===
        header = QHBoxLayout()
        header.setContentsMargins(24, 16, 24, 16)

        # Botón anterior
        self.prev_btn = QPushButton("◀ Anterior")
        self.prev_btn.setFont(QFont("Inter", 12, QFont.Bold))
        self.prev_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: 2px solid #7C8591;
                color: #7C8591;
                border-radius: 8px;
                padding: 12px 24px;
                font-size: 14px;
            }
            QPushButton:hover {
                border-color: #5CC8C2;
                color: #5CC8C2;
            }
        """)
        self.prev_btn.clicked.connect(self.prev_song_clicked.emit)
        header.addWidget(self.prev_btn)

        header.addStretch()

        # Info de canción
        info_layout = QVBoxLayout()
        self.song_title = QLabel(self._song_title)
        self.song_title.setFont(QFont("Inter", 18, QFont.Bold))
        self.song_title.setStyleSheet(f"color: {theme.FG}; font-size: 26px; font-weight: 700;")
        self.song_title.setAlignment(Qt.AlignCenter)
        info_layout.addWidget(self.song_title)

        self.section_label = QLabel(self._section)
        self.section_label.setFont(QFont("Inter", 14))
        self.section_label.setStyleSheet(f"color: {theme.ACTIVE}; font-size: 15px;")
        self.section_label.setAlignment(Qt.AlignCenter)
        info_layout.addWidget(self.section_label)

        header.addLayout(info_layout)
        header.addStretch()

        # Botón siguiente
        self.next_btn = QPushButton("Siguiente ▶")
        self.next_btn.setFont(QFont("Inter", 12, QFont.Bold))
        self.next_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: 2px solid #7C8591;
                color: #7C8591;
                border-radius: 8px;
                padding: 12px 24px;
                font-size: 14px;
            }
            QPushButton:hover {
                border-color: #5CC8C2;
                color: #5CC8C2;
            }
        """)
        self.next_btn.clicked.connect(self.next_song_clicked.emit)
        header.addWidget(self.next_btn)

        layout.addLayout(header)

        # Aviso de salto de setlist (setlist_jump): visible unos segundos.
        self.jump_alert = QLabel("")
        self.jump_alert.setFont(QFont("Inter", 16, QFont.Bold))
        self.jump_alert.setAlignment(Qt.AlignCenter)
        self.jump_alert.setStyleSheet("color: #15181C; background: #D9A24E; padding: 8px;")
        self.jump_alert.hide()
        layout.addWidget(self.jump_alert)
        self._jump_timer = QTimer(self)
        self._jump_timer.setSingleShot(True)
        self._jump_timer.timeout.connect(self.jump_alert.hide)

        # Aviso persistente mientras el setlist en vivo está vacío (no se borra solo).
        self.setlist_notice = QLabel("")
        self.setlist_notice.setObjectName("setlistNotice")
        self.setlist_notice.setFont(QFont("Inter", 15, QFont.Bold))
        self.setlist_notice.setAlignment(Qt.AlignCenter)
        self.setlist_notice.setWordWrap(True)
        self.setlist_notice.setStyleSheet(
            "color: #15181C; background: #D9A24E; padding: 10px 16px;"
        )
        self.setlist_notice.hide()
        layout.addWidget(self.setlist_notice)

        # === ÁREA PRINCIPAL: setlist, letra y acordes, metrónomo ===
        main_area = QHBoxLayout()
        main_area.setContentsMargins(24, 16, 24, 16)
        main_area.setSpacing(20)

        # Riel del setlist en vivo (solo lectura: el transporte se mueve con Anterior/Siguiente).
        rail_layout = QVBoxLayout()
        rail_layout.setSpacing(6)
        rail_title = QLabel("SETLIST")
        rail_title.setFont(QFont("JetBrains Mono", 10, QFont.Bold))
        rail_title.setStyleSheet(f"color: {theme.MUTED}; letter-spacing: 2px; font-size: 12px; font-weight: 700;")
        rail_layout.addWidget(rail_title)
        self.setlist_rail = QListWidget()
        self.setlist_rail.setObjectName("setlistRail")
        self.setlist_rail.setFocusPolicy(Qt.NoFocus)
        self.setlist_rail.setSelectionMode(QAbstractItemView.NoSelection)
        self.setlist_rail.setFixedWidth(230)
        self.setlist_rail.setFont(QFont("Inter", 11))
        self.setlist_rail.setStyleSheet(
            f"QListWidget {{ background: {theme.SURFACE}; border: 1px solid {theme.LINE};"
            f" border-radius: 4px; color: {theme.SECONDARY}; font-size: 15px; }}"
            f"QListWidget::item {{ padding: 8px 10px; border-bottom: 1px solid {theme.LINE}; }}"
        )
        rail_layout.addWidget(self.setlist_rail, 1)
        main_area.addLayout(rail_layout)

        # Letra y acordes de la sección actual (centro, grande)
        lyrics_layout = QVBoxLayout()
        lyrics_layout.setSpacing(10)

        head = QHBoxLayout()
        self.section_head = QLabel("")
        self.section_head.setFont(QFont("JetBrains Mono", 13, QFont.Bold))
        self.section_head.setStyleSheet(
            f"color: {theme.ACTIVE}; letter-spacing: 2px; font-size: 16px; font-weight: 700;"
            " font-family: 'JetBrains Mono', Consolas, monospace;"
        )
        head.addWidget(self.section_head)
        head.addStretch()
        self.mode_btn = QPushButton("ACORDES")
        self.mode_btn.setObjectName("prompterMode")
        self.mode_btn.setFont(QFont("JetBrains Mono", 10, QFont.Bold))
        self.mode_btn.setCursor(Qt.PointingHandCursor)
        self.mode_btn.setToolTip("Alternar entre acordes con letra y solo letra")
        self.mode_btn.clicked.connect(self.toggle_prompter_mode)
        head.addWidget(self.mode_btn)
        lyrics_layout.addLayout(head)

        lyrics_layout.addStretch(1)
        self.current_lyric = QLabel("Esperando canción...")
        self._style_lyric(SINGER)
        self.current_lyric.setAlignment(Qt.AlignCenter)
        self.current_lyric.setWordWrap(True)
        self.current_lyric.setTextFormat(Qt.RichText)
        lyrics_layout.addWidget(self.current_lyric)
        lyrics_layout.addStretch(1)

        # Próxima sección (o próxima línea, sin contenido del hub)
        self.next_lyric = QLabel("")
        self.next_lyric.setFont(QFont("Inter", 16))
        self.next_lyric.setStyleSheet(
            f"color: {theme.MUTED}; border-top: 1px solid {theme.LINE}; padding-top: 8px; font-size: 18px;"
        )
        self.next_lyric.setAlignment(Qt.AlignCenter)
        self.next_lyric.setWordWrap(True)
        self.next_lyric.setTextFormat(Qt.PlainText)
        lyrics_layout.addWidget(self.next_lyric)

        main_area.addLayout(lyrics_layout, 3)

        # Separador
        sep = QFrame()
        sep.setStyleSheet("background: #262C34; max-width: 2px; min-width: 2px;")
        main_area.addWidget(sep)

        # Panel derecho: BPM, beat, controles
        right_panel = QVBoxLayout()
        right_panel.setAlignment(Qt.AlignCenter)
        right_panel.setSpacing(20)

        # BPM grande
        bpm_label = QLabel("BPM")
        bpm_label.setFont(QFont("Inter", 12))
        bpm_label.setStyleSheet(f"color: {theme.MUTED}; font-size: 13px; letter-spacing: 2px;")
        bpm_label.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(bpm_label)

        self.bpm_display = QLabel("120")
        self.bpm_display.setFont(QFont("JetBrains Mono", 72, QFont.Bold))
        self.bpm_display.setStyleSheet(
            f"color: {theme.ACTIVE}; font-size: 88px; font-weight: 700;"
            " font-family: 'JetBrains Mono', Consolas, monospace;"
        )
        self.bpm_display.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(self.bpm_display)

        # Indicadores de beat
        beat_layout = QHBoxLayout()
        beat_layout.setSpacing(16)
        self.beat_indicators = []
        for i in range(4):
            led = QLabel("●")
            led.setFont(QFont("JetBrains Mono", 32))
            led.setStyleSheet("color: #363D47;")
            led.setAlignment(Qt.AlignCenter)
            self.beat_indicators.append(led)
            beat_layout.addWidget(led)
        right_panel.addLayout(beat_layout)

        self.bar_label = QLabel("COMPÁS -")
        self.bar_label.setFont(QFont("JetBrains Mono", 14, QFont.Bold))
        self.bar_label.setStyleSheet(
            f"color: {theme.SECONDARY}; font-size: 20px; font-weight: 700;"
            " font-family: 'JetBrains Mono', Consolas, monospace;"
        )
        self.bar_label.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(self.bar_label)

        # Próxima sección
        next_sec_label = QLabel("PRÓXIMA")
        next_sec_label.setFont(QFont("Inter", 10))
        next_sec_label.setStyleSheet(f"color: {theme.MUTED}; font-size: 13px; letter-spacing: 2px;")
        next_sec_label.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(next_sec_label)

        self.next_section_label = QLabel(self._next_section)
        self.next_section_label.setFont(QFont("Inter", 16, QFont.Bold))
        self.next_section_label.setStyleSheet(f"color: {theme.SUCCESS}; font-size: 24px; font-weight: 700;")
        self.next_section_label.setAlignment(Qt.AlignCenter)
        right_panel.addWidget(self.next_section_label)

        right_panel.addStretch()
        main_area.addLayout(right_panel, 1)

        layout.addLayout(main_area, 1)

        # === CONTROLES INFERIORES ===
        bottom = QHBoxLayout()
        bottom.setContentsMargins(24, 16, 24, 16)

        # Botón pantalla completa
        self.fullscreen_btn = QPushButton("Pantalla Completa")
        self.fullscreen_btn.setFont(QFont("Inter", 11))
        self.fullscreen_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: 1px solid #7C8591;
                color: #7C8591;
                border-radius: 4px;
                padding: 8px 16px;
            }
            QPushButton:hover {
                border-color: #5CC8C2;
                color: #5CC8C2;
            }
        """)
        self.fullscreen_btn.clicked.connect(self._toggle_fullscreen)
        bottom.addWidget(self.fullscreen_btn)

        bottom.addStretch()

        # Botón pánico (slide to stop)
        self.panic_btn = QPushButton("DETENER SESIÓN")
        self.panic_btn.setFont(QFont("Inter", 14, QFont.Bold))
        self.panic_btn.setStyleSheet("""
            QPushButton {
                background: #D96459;
                border: none;
                color: #15181C;
                border-radius: 8px;
                padding: 16px 32px;
                font-size: 16px;
            }
            QPushButton:hover {
                background: #D96459;
            }
            QPushButton:pressed {
                background: #B5504A;
            }
        """)
        self.panic_btn.clicked.connect(self.panic_clicked.emit)
        bottom.addWidget(self.panic_btn)

        layout.addLayout(bottom)

    def _setup_animations(self):
        """Configurar animaciones de flash para metrónomo."""
        self._flash_anim = QPropertyAnimation(self, b"styleSheet")
        self._flash_anim.setDuration(100)
        self._flash_anim.setEasingCurve(QEasingCurve.OutQuad)

    def _setup_timer(self):
        """Timer solo para decay de UI, no para generar beats."""
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._update_ui)
        self._timer.start(33)  # 30fps para animaciones suaves

    def _update_ui(self):
        """Actualizar animaciones de UI (flash decay, etc)."""
        pass  # Las animaciones de beat se manejan en set_beat

    def set_song(self, title: str, current_lyric: str = "", next_lyric: str = "",
                 section: str = "", next_section: str = ""):
        """Song without content from the hub: plain lyrics (legacy path)."""
        self._content = None
        self._section_idx = -1
        self.section_head.setText("")
        self._song_title = title
        self.song_title.setText(title)
        self._style_lyric(SINGER)
        self.current_lyric.setText(html.escape(current_lyric or "Esperando canción..."))
        self.next_lyric.setText(next_lyric)
        self.section_label.setText(section)
        self._section = section
        self._next_section = next_section
        self.next_section_label.setText(next_section)
        self._current_lyric_idx = 0

    def set_lyrics(self, lyrics: list):
        """Guardar lista de letras para scroll sincronizado."""
        self._lyrics = lyrics
        self._current_lyric_idx = 0
        if lyrics and self._content is None:
            self.current_lyric.setText(html.escape(lyrics[0]["text"]))
            if len(lyrics) > 1:
                self.next_lyric.setText(lyrics[1]["text"])
            else:
                self.next_lyric.setText("")

    def set_bpm(self, bpm: int):
        self._bpm = bpm
        self.bpm_display.setText(str(bpm))

    def set_beat(self, beat: int):
        """Actualizar indicador de beat (1-4) con flash visual en el beat 1.

        Solo se reestilizan los dos LEDs que cambian (sin reconstruir widgets)."""
        prev = self._beat if getattr(self, "_beat_lit", False) else None
        self._beat = beat
        self._beat_lit = True
        if prev is not None and 0 < prev <= len(self.beat_indicators) and prev != beat:
            self.beat_indicators[prev - 1].setStyleSheet("color: #363D47; font-size: 32px;")
        if 0 < beat <= len(self.beat_indicators):
            led = self.beat_indicators[beat - 1]
            if beat == 1:
                led.setStyleSheet("color: #5CC8C2; font-size: 40px; font-weight: bold;")
            else:
                led.setStyleSheet("color: #B8CF7A; font-size: 32px;")
        if beat == 1:
            self._flash_border()

    def clear_beat(self):
        for led in self.beat_indicators:
            led.setStyleSheet("color: #363D47; font-size: 32px;")
        self._beat_lit = False

    def set_bar(self, bar):
        self.bar_label.setText(f"COMPÁS {bar}" if bar is not None else "COMPÁS -")
        if self._content is not None:
            self._show_section(section_index_at(self._content.get("sections") or [], bar))

    # ------------------------------------------------------------------ setlist rail and prompter
    def set_setlist(self, entries, current_song_id=None):
        """Live setlist in the rail (dicts with song_id, title, bpm)."""
        self.setlist_rail.clear()
        for i, e in enumerate(entries or []):
            title = e.get("title") or e.get("song_id")
            item = QListWidgetItem(f"{i + 1:02d}  {title}\n      {e.get('bpm', '')} BPM")
            item.setData(Qt.UserRole, e.get("song_id"))
            self.setlist_rail.addItem(item)
        self.set_current_song_id(current_song_id)

    def set_current_song_id(self, song_id):
        for i in range(self.setlist_rail.count()):
            item = self.setlist_rail.item(i)
            live = song_id is not None and item.data(Qt.UserRole) == song_id
            font = item.font()
            font.setBold(live)
            item.setFont(font)
            item.setForeground(QBrush(QColor(theme.ACTIVE if live else theme.SECONDARY)))
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
        title = content.get("title") or self._song_title
        self._song_title = title
        key = content.get("show_key") or content.get("key") or ""
        artist = content.get("artist") or ""
        self.song_title.setText(title)
        self.section_label.setText(" // ".join(p for p in (artist, key) if p))
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
        singer = mode == SINGER
        family = "'Inter', 'Segoe UI', sans-serif" if singer else "'JetBrains Mono', Consolas, monospace"
        self.current_lyric.setStyleSheet(
            f"color: {theme.FG}; font-size: {LYRIC_PX[mode]}px; font-weight: 700; font-family: {family};"
        )
        self.current_lyric.setAlignment(Qt.AlignCenter if singer else (Qt.AlignLeft | Qt.AlignVCenter))

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

    def _flash_border(self):
        """Flash de borde en beat 1 — simulación de frame OLED."""
        # Usar un widget overlay para el flash en vez de cambiar stylesheet completo
        if not hasattr(self, '_flash_widget'):
            self._flash_widget = QFrame(self)
            self._flash_widget.setStyleSheet("""
                QFrame {
                    border: 4px solid #5CC8C2;
                    background: transparent;
                }
            """)
            self._flash_widget.setGeometry(self.rect())
            self._flash_widget.setAttribute(Qt.WA_TransparentForMouseEvents)
            self._flash_widget.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint)
            self._flash_widget.hide()

        self._flash_widget.setGeometry(self.rect())
        self._flash_widget.show()
        self._flash_widget.raise_()
        QTimer.singleShot(100, lambda: self._flash_widget.hide() if hasattr(self, '_flash_widget') else None)

    def set_network_status(self, ok: bool):
        self._network_ok = ok
        if ok:
            self.beacon.setStyleSheet("background-color: #B8CF7A;")
        else:
            self.beacon.setStyleSheet("background-color: #D96459;")

    def _toggle_fullscreen(self):
        # Un widget hijo no puede ponerse en pantalla completa por si mismo:
        # la ventana principal lo hace y luego llama a set_fullscreen_state().
        self.fullscreen_requested.emit()

    def set_fullscreen_state(self, fullscreen: bool):
        self._is_fullscreen = fullscreen
        self.fullscreen_btn.setText("Salir de Pantalla Completa" if fullscreen else "Pantalla Completa")

    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_Escape and self._is_fullscreen:
            self._toggle_fullscreen()
        super().keyPressEvent(event)
