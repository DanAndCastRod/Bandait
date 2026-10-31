"""Vista Ajustes (Bandait 2.3): reúne lo que estaba repartido entre menús y diálogos.

A la izquierda las secciones; a la derecha filas de ajuste (título, descripción, control).
La vista solo emite señales: los diálogos existentes (audio_devices, account_select,
connect_musicians...) los abre la ventana principal. Los setters no emiten señales, así
que la ventana principal puede reflejar su estado sin bucles.
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QButtonGroup,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from src.ui import components as ui
from src.ui import theme

SECTIONS: List[Tuple[str, str]] = [
    ("audio", "Audio"),
    ("clic", "Clic y ruteo"),
    ("red", "Red"),
    ("nube", "Cuenta y nube"),
    ("pantalla", "Pantalla"),
    ("voz", "Voz"),
]
BRIGHTNESS_LEVELS = (100, 85, 70, 55, 40)
VOICE_OUTPUT_LABELS = {"drummer": "Baterista (Salida 3)", "all_in_ear": "Todos los in-ear"}


def _switch(checked: bool = False) -> QPushButton:
    btn = ui.button("", "switch")
    btn.setCheckable(True)
    btn.setChecked(checked)
    btn.setMinimumWidth(110)
    _switch_text(btn)
    btn.toggled.connect(lambda _on, b=btn: _switch_text(b))
    return btn


def _switch_text(btn: QPushButton) -> None:
    btn.setText("ENCENDIDO" if btn.isChecked() else "APAGADO")


def _set_checked_silently(btn: QPushButton, checked: bool) -> None:
    btn.blockSignals(True)
    btn.setChecked(bool(checked))
    btn.blockSignals(False)
    _switch_text(btn)


class SettingsView(QWidget):
    open_audio_devices = Signal()
    test_click = Signal()
    drummer_click_changed = Signal(bool)
    pa_click_changed = Signal(bool)
    brightness_changed = Signal(int)
    open_account_login = Signal()
    cloud_sync = Signal()
    choose_band = Signal()
    sign_out = Signal()
    retry_server = Signal()

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.setObjectName("settingsView")
        self.pages: Dict[str, QWidget] = {}
        self.nav_buttons: Dict[str, QPushButton] = {}

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        header, _actions = ui.view_header("Ajustes", "Lo que antes estaba repartido entre menús y diálogos")
        root.addWidget(header)

        body = QHBoxLayout()
        body.setContentsMargins(theme.SPACE_5, theme.SPACE_4, theme.SPACE_5, theme.SPACE_4)
        body.setSpacing(theme.SPACE_4)
        root.addLayout(body, 1)

        nav_panel, nav_body, _ = ui.panel()
        nav_panel.setFixedWidth(200)
        nav_body.setContentsMargins(theme.SPACE_2, theme.SPACE_2, theme.SPACE_2, theme.SPACE_2)
        nav_body.setSpacing(2)
        self.nav_group = QButtonGroup(self)
        self.nav_group.setExclusive(True)
        self.stack = QStackedWidget()
        self.stack.setProperty("role", "bare")
        for i, (key, text) in enumerate(SECTIONS):
            btn = QPushButton(text)
            btn.setProperty("role", "nav")
            btn.setCheckable(True)
            btn.setCursor(Qt.PointingHandCursor)
            btn.setMinimumHeight(36)
            btn.setObjectName(f"settings_{key}")
            self.nav_group.addButton(btn, i)
            self.nav_buttons[key] = btn
            nav_body.addWidget(btn)
        nav_body.addStretch(1)
        self.nav_group.idClicked.connect(self.stack.setCurrentIndex)
        body.addWidget(nav_panel, 0, Qt.AlignTop)
        body.addWidget(self.stack, 1)

        self._build_audio()
        self._build_click()
        self._build_network()
        self._build_cloud()
        self._build_display()
        self._build_voice()
        self.show_section("clic")

    # ------------------------------------------------------------------ pages
    def _page(self, key: str) -> QVBoxLayout:
        title = dict(SECTIONS)[key]
        panel, body, _ = ui.panel(title)
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)
        holder = QWidget()
        holder.setProperty("role", "bare")
        lay = QVBoxLayout(holder)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(panel)
        lay.addStretch(1)
        scroll = QScrollArea()  # Voz has many rows: scroll instead of growing the window
        scroll.setProperty("role", "bare")
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setWidget(holder)
        scroll.viewport().setProperty("role", "bare")
        self.stack.addWidget(scroll)
        self.pages[key] = scroll
        return body

    def _row(self, page: QVBoxLayout, title: str, description: str, *controls: QWidget) -> QLabel:
        """Una fila de ajuste. Devuelve la etiqueta de descripción (algunas cambian)."""
        row = ui.frame("row")
        lay = QHBoxLayout(row)
        lay.setContentsMargins(theme.SPACE_4, theme.SPACE_3, theme.SPACE_4, theme.SPACE_3)
        lay.setSpacing(theme.SPACE_4)
        text = QVBoxLayout()
        text.setContentsMargins(0, 0, 0, 0)
        text.setSpacing(2)
        text.addWidget(ui.label(title, "strong"))
        desc = ui.label(description, "muted", wrap=True)
        text.addWidget(desc)
        holder = QWidget()
        holder.setProperty("role", "bare")
        holder.setLayout(text)
        holder.setFixedWidth(340)
        lay.addWidget(holder, 0, Qt.AlignVCenter)
        grows = False
        for control in controls:
            wraps = isinstance(control, QLabel) and control.wordWrap()
            grows = grows or wraps  # a long status text takes the free width and wraps
            lay.addWidget(control, 1 if wraps else 0, Qt.AlignVCenter)
        if not grows:
            lay.addStretch(1)
        page.addWidget(row)
        return desc

    def _build_audio(self) -> None:
        page = self._page("audio")
        self.audio_status = ui.label("Sin interfaz de audio", "mono", wrap=True)
        self.audio_status.setMinimumWidth(160)
        choose = ui.button("Elegir interfaz", "secondary")
        choose.clicked.connect(self.open_audio_devices.emit)
        test = ui.button("Probar clic", "secondary", "Un compás por las salidas configuradas")
        test.clicked.connect(self.test_click.emit)
        self.audio_buttons = (choose, test)
        self._row(page, "Interfaz de audio",
                  "El clic usa el reloj del líder; cambiar de interfaz no pierde la fase.",
                  self.audio_status, choose)
        self._row(page, "Probar el clic", "Suena un compás por las salidas encendidas.", test)

    def _build_click(self) -> None:
        page = self._page("clic")
        self.drummer_switch = _switch(True)
        self.drummer_switch.toggled.connect(self.drummer_click_changed.emit)
        self._row(page, "Clic del baterista", "Salida 3 de la interfaz.", self.drummer_switch)
        self.pa_switch = _switch(False)
        self.pa_switch.toggled.connect(self.pa_click_changed.emit)
        self._row(page, "Clic en la PA",
                  "Salidas 1-2. Útil en el portátil con audífonos; en el show suele ir apagado.",
                  self.pa_switch)
        self._row(page, "Stems", "Siempre por las Salidas 1-2, sincronizados con el clic.",
                  ui.tag("PA 1-2", "act"))
        self.click_voice_desc = self._row(page, "Conteo con voz", "Viene de la configuración de Voz del hub.",
                                          ui.tag("Desde el hub", "act"))
        test = ui.button("Probar clic", "secondary", "Un compás por las salidas configuradas")
        test.clicked.connect(self.test_click.emit)
        self._row(page, "Probar el clic", "Suena un compás por las salidas encendidas.", test)

    def _build_network(self) -> None:
        page = self._page("red")
        self.network_status = ui.label("Servidor de red sin iniciar", "body", wrap=True)
        self.network_status.setMinimumWidth(160)
        self._row(page, "Servidor del escenario",
                  "Los teléfonos cargan la app del músico desde este portátil, por la red local.",
                  self.network_status)
        self.network_url = ui.label("—", "mono")
        self.network_url.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self._row(page, "Dirección para los músicos",
                  "La misma que lleva el QR de Banda > Conectar músicos.", self.network_url)
        retry = ui.button("Reintentar", "secondary", "Vuelve a levantar el servidor de red")
        retry.clicked.connect(self.retry_server.emit)
        self.retry_btn = retry
        self._row(page, "Si el servidor no arrancó",
                  "Pasa cuando otro programa ocupa el puerto o cambió la red Wi-Fi.", retry)

    def _build_cloud(self) -> None:
        page = self._page("nube")
        self.cloud_tag = ui.tag("Sin sesión")
        self.cloud_user = ui.label("Sin sesión", "body")
        self.login_btn = ui.button("Iniciar sesión", "primary")
        self.login_btn.clicked.connect(self.open_account_login.emit)
        self.logout_btn = ui.button("Cerrar sesión", "ghost")
        self.logout_btn.clicked.connect(self.sign_out.emit)
        self.cloud_desc = self._row(page, "Cuenta", "Con la cuenta del hub se bajan setlists, canciones y stems.",
                                    self.cloud_tag, self.cloud_user, self.login_btn, self.logout_btn)
        self.band_label = ui.label("Ninguna", "body")
        self.band_btn = ui.button("Elegir banda", "secondary")
        self.band_btn.clicked.connect(self.choose_band.emit)
        self._row(page, "Banda activa", "La banda de la que el líder toma su repertorio.",
                  self.band_label, self.band_btn)
        self.sync_btn = ui.button("Sincronizar ahora", "secondary")
        self.sync_btn.clicked.connect(self.cloud_sync.emit)
        self._row(page, "Sincronizar", "Solo lectura: el líder nunca escribe en la nube.", self.sync_btn)
        self.set_cloud_status(False, "", "")

    def _build_display(self) -> None:
        page = self._page("pantalla")
        seg = QWidget()
        seg.setProperty("role", "bare")
        lay = QHBoxLayout(seg)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(theme.SPACE_1)
        self.brightness_group = QButtonGroup(self)
        self.brightness_group.setExclusive(True)
        for level in BRIGHTNESS_LEVELS:
            chip = ui.button(str(level), "chip", f"Brillo al {level} %")
            chip.setMinimumWidth(48)
            self.brightness_group.addButton(chip, level)
            lay.addWidget(chip)
        self.brightness_group.button(BRIGHTNESS_LEVELS[0]).setChecked(True)
        self.brightness_group.idClicked.connect(self.brightness_changed.emit)
        self._row(page, "Brillo de la pantalla",
                  "Baja la intensidad de toda la ventana en escenarios oscuros.", seg)

    def _build_voice(self) -> None:
        page = self._page("voz")
        self.voice_tag = ui.tag("Desde el hub", "act")
        self._row(page, "Configuración de voz",
                  "Se edita en el hub (Banda > Voz). Aquí solo se consulta.", self.voice_tag)
        self.voice_values: Dict[str, QLabel] = {}
        for key, title, desc in (
            ("enabled", "Avisos de voz", "Conteo y nombres de sección dichos por una voz sintética."),
            ("voice", "Voz", "Proveedor y voz del hub."),
            ("rate", "Velocidad", "Más rápido o más lento que lo normal."),
            ("count_in", "Conteo con voz", "Dice el conteo antes de empezar la canción."),
            ("section_cues", "Avisos de sección", "Anuncia la sección que viene."),
            ("cue_lead_bars", "Anticipación", "Compases antes de la sección en que suena el aviso."),
            ("output", "Salida", "Por dónde suena la voz."),
        ):
            value = ui.label("—", "mono")
            self.voice_values[key] = value
            self._row(page, title, desc, value)
        self.set_voice_config(None)

    # ------------------------------------------------------------------ API
    def show_section(self, key: str) -> None:
        keys = [k for k, _ in SECTIONS]
        if key not in keys:
            return
        i = keys.index(key)
        self.nav_buttons[key].setChecked(True)
        self.stack.setCurrentIndex(i)

    def current_section(self) -> str:
        return SECTIONS[self.stack.currentIndex()][0]

    def set_audio_status(self, text: str) -> None:
        self.audio_status.setText(str(text or "Sin interfaz de audio"))

    def set_click_routing(self, drummer: bool, pa: bool) -> None:
        _set_checked_silently(self.drummer_switch, drummer)
        _set_checked_silently(self.pa_switch, pa)

    def set_network_status(self, text: str, url: str) -> None:
        self.network_status.setText(str(text or "Servidor de red sin iniciar"))
        self.network_url.setText(str(url or "—"))

    def set_cloud_status(self, signed_in: bool, user_label: str, band_label: str) -> None:
        signed_in = bool(signed_in)
        self.cloud_tag.setText("CONECTADA" if signed_in else "SIN SESIÓN")
        ui.set_prop(self.cloud_tag, "tag", "ok" if signed_in else "")
        self.cloud_user.setText(str(user_label or "") if signed_in else "Sin sesión")
        self.cloud_user.setVisible(signed_in and bool(user_label))
        self.login_btn.setVisible(not signed_in)
        self.logout_btn.setVisible(signed_in)
        self.band_label.setText(str(band_label or "Ninguna"))
        self.band_btn.setEnabled(signed_in)
        self.sync_btn.setEnabled(signed_in)

    def set_brightness(self, level: int) -> None:
        """Marca el nivel más cercano sin emitir ``brightness_changed``."""
        try:
            level = int(level)
        except (TypeError, ValueError):
            return
        nearest = min(BRIGHTNESS_LEVELS, key=lambda v: abs(v - level))
        btn = self.brightness_group.button(nearest)
        btn.blockSignals(True)
        btn.setChecked(True)
        btn.blockSignals(False)

    def brightness(self) -> int:
        return self.brightness_group.checkedId()

    def set_voice_config(self, config) -> None:
        """``BandVoiceConfig`` (src.db.models), un dict con las mismas claves o None."""
        if config is None:
            for value in self.voice_values.values():
                value.setText("—")
            self.voice_values["enabled"].setText("Sin configuración del hub")
            self.voice_tag.setText("DESDE EL HUB")
            self.click_voice_desc.setText("El hub no tiene configuración de voz para esta banda.")
            return

        def get(key, default=None):
            if isinstance(config, dict):
                return config.get(key, default)
            return getattr(config, key, default)

        def yes(value) -> str:
            return "Sí" if value else "No"

        provider = str(get("provider", "") or "")
        voice = str(get("voice", "") or "")
        self.voice_values["enabled"].setText("Activados" if get("enabled") else "Apagados")
        self.voice_values["voice"].setText(" · ".join(p for p in (voice, provider) if p) or "—")
        self.voice_values["rate"].setText(str(get("rate", "") or "+0%"))
        self.voice_values["count_in"].setText(yes(get("count_in", True)))
        self.voice_values["section_cues"].setText(yes(get("section_cues", True)))
        lead = get("cue_lead_bars", 1)
        self.voice_values["cue_lead_bars"].setText(f"{lead} compás" if lead == 1 else f"{lead} compases")
        output = str(get("output", "") or "drummer")
        self.voice_values["output"].setText(VOICE_OUTPUT_LABELS.get(output, output))
        self.voice_tag.setText("DESDE EL HUB")
        rate = str(get("rate", "") or "+0%")
        if get("enabled") and get("count_in", True):
            self.click_voice_desc.setText(f"Viene de la configuración de Voz del hub ({voice or 'voz'}, {rate}).")
        else:
            self.click_voice_desc.setText("Apagado en la configuración de Voz del hub.")
