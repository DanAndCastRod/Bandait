"""Vista Ensayo (Bandait 2.3): repetir una sección con stems y clic.

Solo UI y señales: no toca el transporte. La ventana principal conecta
``loop_requested`` con ``ConcurrentControlManager.set_loop`` y devuelve el estado con
``set_loop_status`` (la vista no se cree activa hasta que se lo dicen).

El tempo de práctica es una señal: cambiarlo mueve el BPM del transporte y los stems no
se estiran, así que la vista avisa que se silencian; la ventana principal decide.
"""

from __future__ import annotations

from typing import List, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QButtonGroup,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from src.ui import components as ui
from src.ui import theme
from src.ui.chordpro_layout import MUSICIAN, section_html
from src.ui.widgets.flow_layout import FlowLayout

REPEAT_OPTIONS = ((2, "2"), (4, "4"), (8, "8"), (0, "∞"))  # 0 = infinito
DEFAULT_REPEATS = 4
PRACTICE_MIN, PRACTICE_MAX, PRACTICE_STEP = 50, 100, 5
PROMPT_PX = theme.SIZE_PROMPT
LEDE_SUFFIX = "repetir secciones con stems y clic"


def _int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_sections(raw) -> List[dict]:
    """Sections with a usable bar range. A missing start_bar follows the previous section."""
    out: List[dict] = []
    next_bar = 1
    for s in raw if isinstance(raw, (list, tuple)) else ():
        if not isinstance(s, dict):
            continue
        bars = _int(s.get("bars"), 0)
        if bars < 1:
            continue
        start = _int(s.get("start_bar"), next_bar)
        if start < 1:
            start = next_bar
        label = str(s.get("label") or s.get("kind") or f"Sección {len(out) + 1}").strip()
        out.append({
            "label": label,
            "kind": str(s.get("kind") or ""),
            "start_bar": start,
            "end_bar": start + bars - 1,
            "chordpro": s.get("chordpro") if isinstance(s.get("chordpro"), str) else "",
            "cue_text": s.get("cue_text") if isinstance(s.get("cue_text"), str) else None,
        })
        next_bar = start + bars
    return out


class RehearsalView(QWidget):
    loop_requested = Signal(int, int, int)  # start_bar, end_bar, repeats (0 = infinito)
    loop_cancelled = Signal()
    practice_tempo_changed = Signal(int)  # porcentaje 50..100
    back_to_show = Signal()

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("rehearsalView")
        self._title = ""
        self._bpm: Optional[float] = None
        self._sections: List[dict] = []
        self._loop_active = False
        self._loop_label = ""

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        header, actions = ui.view_header("Ensayo", f"Sin canción · {LEDE_SUFFIX}")
        self.lede: QLabel = header.findChild(QLabel, "viewLede")
        self.back_btn = ui.button("Volver al show", "ghost")
        self.back_btn.clicked.connect(self.back_to_show.emit)
        self.repeat_btn = ui.button("Repetir sección", "primary")
        self.repeat_btn.clicked.connect(self._on_repeat_clicked)
        actions.addWidget(self.back_btn)
        actions.addWidget(self.repeat_btn)
        root.addWidget(header)

        body = QHBoxLayout()
        body.setContentsMargins(theme.SPACE_5, theme.SPACE_4, theme.SPACE_5, theme.SPACE_4)
        body.setSpacing(theme.SPACE_4)
        root.addLayout(body, 1)

        # ---- Sección en bucle
        loop_panel, lbody, lhead = ui.panel("Sección en bucle")
        self.status_tag = ui.tag("Sin bucle")
        lhead.addWidget(self.status_tag)
        lbody.setSpacing(theme.SPACE_4)

        self.chips_box = QWidget()
        self.chips_box.setProperty("role", "bare")
        self.chips = FlowLayout(self.chips_box, spacing=theme.SPACE_2)
        self.chip_group = QButtonGroup(self)
        self.chip_group.setExclusive(True)
        self.chip_group.idClicked.connect(self._select)
        lbody.addWidget(self.chips_box)

        self.empty = ui.label("", "muted", wrap=True)
        lbody.addWidget(self.empty)

        ranges = QHBoxLayout()
        ranges.setSpacing(theme.SPACE_6)
        from_w, self.from_value = ui.stat("Desde", "---", "readout-strong")
        to_w, self.to_value = ui.stat("Hasta", "---", "readout-strong")
        for w in (from_w, to_w):
            w.setProperty("role", "bare")
            ranges.addWidget(w)
        reps = QVBoxLayout()
        reps.setSpacing(theme.SPACE_1)
        reps.addWidget(ui.label("Repeticiones", "label"))
        reps_row = QHBoxLayout()
        reps_row.setSpacing(theme.SPACE_1)
        self.repeat_group = QButtonGroup(self)
        self.repeat_group.setExclusive(True)
        self.repeat_buttons = {}
        for value, text in REPEAT_OPTIONS:
            chip = ui.button(text, "chip", "Hasta que se detenga" if value == 0 else f"{value} veces más")
            chip.setMinimumWidth(40)
            self.repeat_group.addButton(chip, value)
            self.repeat_buttons[value] = chip
            reps_row.addWidget(chip)
        self.repeat_buttons[DEFAULT_REPEATS].setChecked(True)
        reps.addLayout(reps_row)
        ranges.addLayout(reps)
        ranges.addStretch()
        lbody.addLayout(ranges)

        self.prompt = ui.label("", "prompt")
        self.prompt.setTextFormat(Qt.RichText)
        self.prompt.setAlignment(Qt.AlignLeft | Qt.AlignTop)
        self.prompt.setTextInteractionFlags(Qt.NoTextInteraction)
        scroll = QScrollArea()
        scroll.setProperty("role", "bare")
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setWidgetResizable(True)
        scroll.setWidget(self.prompt)
        scroll.viewport().setProperty("role", "bare")
        self.prompt_scroll = scroll
        lbody.addWidget(scroll, 1)
        body.addWidget(loop_panel, 1)

        # ---- Columna derecha: tempo de práctica (+ lo que agregue la ventana principal)
        side_w = QWidget()
        side_w.setProperty("role", "bare")
        side_w.setFixedWidth(360)
        self.side = QVBoxLayout(side_w)
        self.side.setContentsMargins(0, 0, 0, 0)
        self.side.setSpacing(theme.SPACE_4)

        tempo_panel, tbody, _ = ui.panel()
        tbody.setContentsMargins(theme.SPACE_4, theme.SPACE_4, theme.SPACE_4, theme.SPACE_4)
        tbody.addWidget(ui.label("Tempo de práctica", "label"))
        row = QHBoxLayout()
        row.setSpacing(theme.SPACE_3)
        self.percent_value = ui.label("100 %", "readout-active")
        self.tempo_note = ui.label("", "muted", wrap=True)
        row.addWidget(self.percent_value)
        row.addWidget(self.tempo_note, 1)
        tbody.addLayout(row)
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(PRACTICE_MIN, PRACTICE_MAX)
        self.slider.setSingleStep(PRACTICE_STEP)
        self.slider.setPageStep(PRACTICE_STEP * 2)
        self.slider.setValue(PRACTICE_MAX)
        self.slider.setAccessibleName("Tempo de práctica")
        self.slider.valueChanged.connect(self._on_slider_value)
        self.slider.sliderReleased.connect(lambda: self.practice_tempo_changed.emit(self.slider.value()))
        tbody.addWidget(self.slider)
        ends = QHBoxLayout()
        ends.addWidget(ui.label(f"{PRACTICE_MIN} %", "muted"))
        ends.addStretch()
        ends.addWidget(ui.label(f"{PRACTICE_MAX} %", "muted"))
        tbody.addLayout(ends)
        self.stems_warning = ui.label(
            "Con tempo de práctica los stems se silencian: no se estiran al cambiar el BPM.", "warn", wrap=True)
        tbody.addWidget(self.stems_warning)
        self.side.addWidget(tempo_panel)
        self.side.addStretch(1)
        body.addWidget(side_w)

        self._update_tempo_text()
        self.set_song(None)

    # ------------------------------------------------------------------ API
    def set_song(self, content: Optional[dict]) -> None:
        """Canción del ensayo: dict con title, bpm y sections (start_bar, bars, chordpro, label, kind)."""
        content = content if isinstance(content, dict) else None
        self._title = str(content.get("title") or "").strip() if content else ""
        bpm = content.get("bpm") if content else None
        self._bpm = float(bpm) if isinstance(bpm, (int, float)) and not isinstance(bpm, bool) and bpm > 0 else None
        self._sections = normalize_sections(content.get("sections") if content else None)
        self.lede.setText(f"{self._title or 'Sin canción'} · {LEDE_SUFFIX}")

        for btn in list(self.chip_group.buttons()):
            self.chip_group.removeButton(btn)
            self.chips.removeWidget(btn)
            btn.deleteLater()
        for i, sec in enumerate(self._sections):
            chip = ui.button(sec["label"], "chip", f"Compases {sec['start_bar']} a {sec['end_bar']}")
            self.chip_group.addButton(chip, i)
            self.chips.addWidget(chip)
        if content is None:
            self.empty.setText("Carga una canción en Escenario para ensayar sus secciones.")
        elif not self._sections:
            self.empty.setText("Esta canción no tiene secciones. Añádelas en el hub o en Canciones.")
        self.empty.setVisible(not self._sections)
        self.chips_box.setVisible(bool(self._sections))
        self._select(0 if self._sections else -1)
        self._update_tempo_text()

    def set_loop_status(self, active: bool, current_repeat: int, total: int) -> None:
        """Lo que hace el bucle del transporte. ``total`` 0 = infinito."""
        self._loop_active = bool(active)
        if active:
            name = (self._loop_label or "Sección").upper()
            of = "∞" if total <= 0 else str(total)
            self.status_tag.setText(f"{name} · ×{max(0, current_repeat)} DE {of}")
            ui.set_prop(self.status_tag, "tag", "act")
            self.repeat_btn.setText("Detener bucle")
            ui.set_prop(self.repeat_btn, "variant", "secondary")
        else:
            self.status_tag.setText("SIN BUCLE")
            ui.set_prop(self.status_tag, "tag", "")
            self.repeat_btn.setText("Repetir sección")
            ui.set_prop(self.repeat_btn, "variant", "primary")
        self._update_repeat_enabled()

    def selected_range(self) -> Optional[tuple]:
        sec = self._current_section()
        return (sec["start_bar"], sec["end_bar"]) if sec else None

    def repeats(self) -> int:
        checked = self.repeat_group.checkedId()
        return checked if checked >= 0 else DEFAULT_REPEATS

    def practice_percent(self) -> int:
        return self.slider.value()

    def set_practice_percent(self, percent: int) -> None:
        """Sin emitir señal (la ventana principal restaura su valor)."""
        self.slider.blockSignals(True)
        self.slider.setValue(max(PRACTICE_MIN, min(PRACTICE_MAX, int(percent))))
        self.slider.blockSignals(False)
        self._update_tempo_text()

    # ------------------------------------------------------------------ internals
    def _current_section(self) -> Optional[dict]:
        idx = self.chip_group.checkedId()
        return self._sections[idx] if 0 <= idx < len(self._sections) else None

    def _select(self, index: int) -> None:
        btn = self.chip_group.button(index)
        if btn is not None and not btn.isChecked():
            btn.setChecked(True)
        sec = self._current_section()
        if sec is None:
            self.from_value.setText("---")
            self.to_value.setText("---")
            self.prompt.setText("")
        else:
            self.from_value.setText(f"{sec['start_bar']:03d}")
            self.to_value.setText(f"{sec['end_bar']:03d}")
            self.prompt.setText(section_html(sec["chordpro"], MUSICIAN, sec["cue_text"] or sec["label"], PROMPT_PX))
        self._update_repeat_enabled()

    def _update_repeat_enabled(self) -> None:
        enabled = self._loop_active or self._current_section() is not None
        self.repeat_btn.setEnabled(enabled)
        self.repeat_btn.setToolTip(
            "Repite la sección elegida con stems y clic" if enabled
            else "Selecciona una canción con secciones en el setlist en vivo para repetir una de ellas"
        )

    def _on_repeat_clicked(self) -> None:
        if self._loop_active:
            self.loop_cancelled.emit()
            return
        sec = self._current_section()
        if sec is None:
            return
        self._loop_label = sec["label"]
        self.loop_requested.emit(sec["start_bar"], sec["end_bar"], self.repeats())

    def _on_slider_value(self, value: int) -> None:
        snapped = int(round(value / PRACTICE_STEP) * PRACTICE_STEP)
        if snapped != value:
            self.slider.setValue(snapped)  # re-enters with the snapped value
            return
        self._update_tempo_text()
        if not self.slider.isSliderDown():
            self.practice_tempo_changed.emit(value)

    def _update_tempo_text(self) -> None:
        pct = self.slider.value()
        self.percent_value.setText(f"{pct} %")
        if self._bpm:
            show = int(round(self._bpm))
            practice = int(round(self._bpm * pct / 100.0))
            self.tempo_note.setText(f"{practice} BPM · el show sigue en {show}")
        else:
            self.tempo_note.setText("El BPM del show no cambia")
        self.stems_warning.setVisible(pct < PRACTICE_MAX)
