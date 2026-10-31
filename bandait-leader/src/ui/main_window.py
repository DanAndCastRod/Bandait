"""
Bandait DAW — Ventana Principal
Layout tipo DAW profesional: transporte arriba, mixer derecha, contenido centro,
navegación izquierda.

Transporte: todos los botones (transporte, escenario, teclado) envían comandos
v3 con origin "laptop_foh" por el mismo ConcurrentControlManager que usan los
móviles. La UI solo muestra lo que el líder publica (SessionState): nunca un
estado propio paralelo.
"""

import logging
import os
import sys
import time

from PySide6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QFrame, QSizePolicy, QStackedWidget, QStatusBar, QMessageBox,
)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QActionGroup, QFont, QKeyEvent

from src.audio.audio_engine import AudioEngine, AudioUnavailable
from src.cloud.controller import CloudController
from src.core.leader_config import load_settings, save_settings
from src.core.paths import get_db_path, recordings_dir
from src.db.seed import count_demo_rows, load_demo_data, remove_demo_data
from src.network.server import BandaitServer
from src.sync.clock_service import ClockService
from src.sync.leader_clock import CLOCK_NAME, leader_clock_resolution_ns, leader_now_ns
from src.ui.dialogs.account_select import songs_label
from src.ui.views.library_view import LibraryView
from src.ui.views.stage_view import StageView
from src.ui.widgets.dim_overlay import BRIGHTNESS_LEVELS, DimOverlay, clamp_brightness
from src.cloud.stems_cloud import StemsCloud
from src.ui import components as ui
from src.ui import theme
from src.ui.analysis_controller import AnalysisController
from src.ui.shell import NavRail
from src.ui.views.band_view import BandView
from src.ui.views.rehearsal_view import RehearsalView
from src.ui.views.settings_view import SettingsView
from src.ui.views.song_inspector import SongInspector
from src.ui.stems_controller import StemsController, import_dialog_filter, song_bpm
from src.ui.widgets.mixer import MixerWidget
from src.ui.widgets.stem_mixer import StemMixerWidget
from src.ui.widgets.timeline import TimelineWidget
from src.ui.widgets.transport import TransportWidget

logger = logging.getLogger(__name__)

APP_VERSION = "2.3.0"
# Ancho maximo del texto "Audio: ..." en la barra de estado (el completo va en el tooltip).
AUDIO_STATUS_MAX_PX = 420

# Persistent notices while the live setlist has no songs (stage view + status bar).
EMPTY_SETLIST_NOTICE = (
    "SETLIST VACIO: agrega canciones en bandait.releven.cc/hub (CANCIONES y SETLISTS) "
    "y luego Cuenta > Sincronizar ahora"
)
NO_SETLIST_NOTICE = (
    "SIN SETLIST EN VIVO: elige uno en Cuenta > Elegir setlist "
    "(o créalo en bandait.releven.cc/hub y luego Cuenta > Sincronizar ahora)"
)
NO_SETLIST_SIGNED_OUT_NOTICE = (
    "SIN SETLIST EN VIVO: inicia sesión en Cuenta > Iniciar sesión con Google y elige un setlist"
)
STATUS_EMPTY_SETLIST = "SETLIST VACIO: agrega canciones en el hub y sincroniza"
STATUS_NO_SETLIST = "SIN SETLIST EN VIVO"

# BANDAIT_DEMO=1 loads the demo songs at startup (never automatic otherwise).
DEMO_ENV = "BANDAIT_DEMO"

REJECT_MESSAGES = {
    "conflict": "Otro dispositivo cambió el setlist antes: se ignoró la orden",
    "no_setlist": "No hay setlist en vivo cargado (Biblioteca > Setlists > Cargar en vivo)",
    "out_of_range": "Fuera del setlist",
    "invalid_type": "Orden no válida",
}


def _env_port(default: int = 4040) -> int:
    try:
        port = int(os.environ.get("BANDAIT_PORT", str(default)))
    except ValueError:
        return default
    return port if 0 <= port <= 65535 else default


class MainWindow(QMainWindow):
    """Ventana principal del DAW Bandait."""

    def __init__(self, start_services: bool = True):
        super().__init__()
        self.setWindowTitle("Bandait DAW — Líder de Sesión")
        self.setMinimumSize(1280, 720)
        self.resize(1600, 900)

        # Estado de UI (espejo de lo publicado por el líder)
        self._bpm = 120
        self._status = "IDLE"
        self._current_song = None
        self._live_song_id = None
        self._shutdown_done = False
        self._settings = load_settings()
        # Entries of the live setlist as loaded (transition + section data for wave 2).
        self._live_entries: list = []
        self._live_setlist_id = None
        # Setlist to load at the next IDLE (a sync or a choice arrived while playing).
        self._pending_live_setlist = None

        # Demo data only on request (BANDAIT_DEMO=1 or Ayuda > Cargar canciones de
        # demostración). Seeding every empty database made an empty hub setlist
        # look like "the songs did not sync" (DB path honors BANDAIT_DB).
        if os.environ.get(DEMO_ENV) == "1":
            try:
                load_demo_data()
            except Exception as e:
                logger.warning("No se pudieron cargar los datos de demostración: %s", e)

        # Servicios
        self.clock_service = ClockService()
        self.server = BandaitServer(
            clock_service=self.clock_service,
            host=os.environ.get("BANDAIT_HOST", "0.0.0.0"),
            port=_env_port(),
            lan_ip=self._settings.lan_ip,
            follower_dir=self._settings.follower_dir,
        )
        saved_device = AudioEngine.find_output_device(
            self._settings.audio_output_device_name, self._settings.audio_output_hostapi
        )
        self._saved_device_missing = bool(self._settings.audio_output_device_name) and saved_device is None
        self.audio_engine = AudioEngine(block_size=512, device=saved_device)
        self.audio_engine.enable_drummer_click = self._settings.drummer_click_enabled
        self.audio_engine.enable_pa_click = self._settings.pa_click_enabled

        # Un solo camino: manager -> (señal encolada) -> ClockService -> AudioEngine
        sig = self.server.signals
        sig.state_changed.connect(self.clock_service.apply_update, Qt.QueuedConnection)
        sig.followers_changed.connect(self._on_followers_changed, Qt.QueuedConnection)
        sig.status_changed.connect(self._on_server_status, Qt.QueuedConnection)
        sig.setlist_jump.connect(self._on_setlist_jump, Qt.QueuedConnection)
        self.clock_service.schedule_changed.connect(self.audio_engine.set_schedule)
        self.clock_service.session_state_changed.connect(self._on_session_state)
        self.clock_service.beat_updated.connect(self._on_clock_beat)

        self.audio_engine.started.connect(self._on_audio_started)
        self.audio_engine.stopped.connect(self._on_audio_stopped)
        self.audio_engine.levels.connect(self._on_audio_levels)

        # Cuenta del hub: red y base de datos en hilos propios, resultados por señal.
        self.cloud = CloudController(self._settings, parent=self)
        self.cloud.sync_started.connect(self._refresh_cloud_status)
        self.cloud.sync_finished.connect(self._on_cloud_sync_finished)
        self.cloud.signed_out.connect(self._on_cloud_signed_out)

        # Timer compartido para UI (30fps)
        self._ui_timer = QTimer(self)
        self._ui_timer.timeout.connect(self._update_ui)
        self._ui_timer.start(33)

        # Styles first: widgets built before QApplication.setFont keep the default family.
        self._apply_styles()
        self._setup_ui()
        self._setup_stems()
        self._setup_menu()
        self._update_setlist_notice()

        if start_services:
            self.start_services()

    # ------------------------------------------------------------------ lifecycle
    def start_services(self):
        """Arrancar reloj, setlist en vivo, servidor de red y audio. Nada aquí
        tumba la ventana: cada fallo queda visible en la barra de estado."""
        self.clock_service.start()
        self._load_initial_setlist()  # local DB first: the show never waits for the network
        self.server.start()
        self._on_server_status(self.server.status, self.server.status_message)
        self._start_audio()
        self._cloud_startup()

    def _start_audio(self):
        try:
            self.audio_engine.start()
        except AudioUnavailable as e:
            self._set_audio_status(f"Audio: no disponible ({e}). Los seguidores siguen sincronizados.", theme.WARNING)
        except Exception as e:  # defensive: PortAudio raises many types
            self._set_audio_status(f"Audio: error al abrir el dispositivo ({e})", theme.DANGER)
        else:
            self._on_audio_started()

    def shutdown(self):
        """Detener audio, servidor y reloj. Idempotente."""
        if self._shutdown_done:
            return
        self._shutdown_done = True
        self._ui_timer.stop()
        try:
            self.cloud.shutdown()
        except Exception as e:
            print(f"[NUBE] Error al detener: {e}")
        try:
            self.audio_engine.shutdown()
        except Exception as e:
            print(f"[AUDIO] Error al detener: {e}")
        try:
            self.server.stop()
        except Exception as e:
            print(f"[NET] Error al detener el servidor: {e}")
        try:
            self.clock_service.stop()
        except Exception:
            pass

    def closeEvent(self, event):
        """Limpiar al cerrar."""
        self.shutdown()
        event.accept()

    # ------------------------------------------------------------------ UI
    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        # Ver > Brillo: veladura encima de toda la ventana (no recibe clics).
        self.dim_overlay = DimOverlay(self)
        self.dim_overlay.set_brightness(self._settings.brightness)

        root = QVBoxLayout(central)
        root.setSpacing(0)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(self._create_title_bar())
        root.addWidget(self._create_top_bar())

        body = QHBoxLayout()
        body.setSpacing(0)
        body.setContentsMargins(0, 0, 0, 0)
        self.nav = NavRail()
        self.nav.view_requested.connect(self.show_view)
        body.addWidget(self.nav)
        self.views = QStackedWidget()
        body.addWidget(self.views, 1)
        root.addLayout(body, 1)

        self._view_widgets = {}
        self._build_views()
        self._create_status_bar()
        self.show_view("escenario")

    def _create_top_bar(self) -> QFrame:
        """Banda, transporte, canción en vivo, músicos y PANIC: siempre a la vista."""
        bar = ui.frame("topbar")
        bar.setFixedHeight(76)
        row = QHBoxLayout(bar)
        row.setContentsMargins(0, 0, theme.SPACE_4, 0)
        row.setSpacing(theme.SPACE_5)

        brand = ui.frame("brand")
        brand.setFixedWidth(200)
        bl = QVBoxLayout(brand)
        bl.setContentsMargins(theme.SPACE_4, theme.SPACE_2, theme.SPACE_4, theme.SPACE_2)
        bl.setSpacing(2)
        bl.addWidget(ui.label("Banda", "label"))
        self.band_label = ui.label("Sin banda", "title")
        bl.addWidget(self.band_label)
        row.addWidget(brand)

        self.transport = TransportWidget()
        self.transport.play_clicked.connect(self._on_play)
        self.transport.pause_clicked.connect(self._on_pause)
        self.transport.stop_clicked.connect(self._on_stop)
        self.transport.rec_clicked.connect(self._on_rec)
        self.transport.bpm_changed.connect(self._on_bpm_changed)
        self.transport.tempo_nudge_clicked.connect(self._on_tempo_nudge)
        self.transport.setMinimumWidth(self.transport.sizeHint().width())
        row.addWidget(self.transport)

        now = QVBoxLayout()
        now.setSpacing(2)
        self.now_caption = ui.label("En vivo", "label")
        self.now_song = ui.label("Sin canción", "title")
        self.now_next = ui.label("", "muted")
        for w in (self.now_caption, self.now_song, self.now_next):
            # Long titles shrink instead of squeezing the transport.
            w.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
            w.setMinimumWidth(160)
            now.addWidget(w)
        row.addLayout(now, 1)

        # Clic: panel "Músicos conectados" (link_report de cada teléfono).
        self.status_followers = ui.button("Músicos: 0", "chip", "Músicos conectados y su latencia")
        self.status_followers.setCheckable(False)
        self.status_followers.setProperty("health", "")
        self.status_followers.clicked.connect(self._open_musicians_panel)
        self._followers = []
        self._musicians_panel = None
        row.addWidget(self.status_followers)

        self.panic_btn = ui.button("PANIC", "panic", "Detiene a toda la banda al instante")
        self.panic_btn.clicked.connect(self._on_panic)
        row.addWidget(self.panic_btn)
        return bar

    def _create_status_bar(self):
        self.status_bar = QStatusBar()
        self.status_net = ui.label("Red: iniciando...", "muted")
        self.status_bar.addWidget(self.status_net)
        # El reloj es un dato técnico: va en el tooltip de "Red" para no desbordar la barra.
        res_us = leader_clock_resolution_ns() / 1e3
        self._clock_tooltip = f"Reloj del líder: {CLOCK_NAME} ({res_us:.3g} us), base de anchor_ns y sync_request"
        self.status_net.setToolTip(self._clock_tooltip)
        self.status_audio = ui.label("Audio: iniciando...", "muted")
        self.status_bar.addWidget(self.status_audio)
        self.status_cloud = ui.label("NUBE: sin sesión", "muted")
        self.status_cloud.setProperty("health", "")
        self.status_bar.addWidget(self.status_cloud)
        self.mini_label = ui.label("Setlist en vivo: ninguno", "muted")
        self.status_bar.addWidget(self.mini_label)

        # Persistent: QStatusBar.showMessage() hides normal widgets, not permanent ones.
        self.status_setlist = ui.tag("", "warn")
        self.status_setlist.hide()
        self.status_bar.addPermanentWidget(self.status_setlist)
        self.connect_btn = ui.button("Conectar músicos", "secondary",
                                     "QR para que los teléfonos abran la app desde este líder")
        self.connect_btn.clicked.connect(self._open_connect_musicians)
        self.status_bar.addPermanentWidget(self.connect_btn)
        self.test_click_btn = ui.button("Probar click", "secondary",
                                        "Un compás de click por las salidas configuradas, sin arrancar la canción")
        self.test_click_btn.clicked.connect(self._test_click)
        self.status_bar.addPermanentWidget(self.test_click_btn)
        self.setStatusBar(self.status_bar)
        # A temporary message is painted by the bar under its normal widgets: hide them meanwhile.
        self._status_normal = [self.status_net, self.status_audio, self.status_cloud, self.mini_label]
        self.status_bar.messageChanged.connect(
            lambda text: [w.setVisible(not text) for w in self._status_normal]
        )

    def _create_title_bar(self) -> QFrame:
        bar = QFrame()
        bar.setObjectName("titleBar")
        bar.setFixedHeight(36)
        layout = QHBoxLayout(bar)
        layout.setSpacing(theme.SPACE_3)
        layout.setContentsMargins(theme.SPACE_3, 0, theme.SPACE_3, 0)
        logo = ui.label("◈", "title")
        logo.setObjectName("titleLogo")
        layout.addWidget(logo)
        layout.addWidget(ui.label("BANDAIT", "title"))
        layout.addWidget(ui.label("Líder", "muted"))
        self.session_info = ui.pill(f"Sesión {self.server.session_id}")
        layout.addWidget(self.session_info)
        layout.addStretch()
        min_btn = QPushButton("−")
        min_btn.setObjectName("winbtn")
        min_btn.setFixedSize(28, 24)
        min_btn.setToolTip("Minimizar")
        min_btn.clicked.connect(self.showMinimized)
        layout.addWidget(min_btn)
        close_btn = QPushButton("×")
        close_btn.setObjectName("winclose")
        close_btn.setFixedSize(28, 24)
        close_btn.setToolTip("Cerrar")
        close_btn.clicked.connect(self.close)
        layout.addWidget(close_btn)
        return bar

    def _build_views(self):
        """One page per rail entry. Setlists and Canciones share the library (two of its pages)."""
        # Escenario
        self.stage_view = StageView()
        self.stage_view.panic_clicked.connect(self._on_panic)
        self.stage_view.next_song_clicked.connect(self._on_next_song)
        self.stage_view.prev_song_clicked.connect(self._on_prev_song)
        self.stage_view.fullscreen_requested.connect(self._toggle_fullscreen)
        self.stage_view.open_tracks.connect(lambda: self.show_view("pistas"))
        self._add_view("escenario", self.stage_view)

        # Ensayo: bucle de sección en el transporte (los teléfonos lo siguen como un re-anclaje).
        self.rehearsal_view = RehearsalView()
        manager = self.server.get_control_manager()
        self.rehearsal_view.loop_requested.connect(self._on_loop_requested)
        self.rehearsal_view.loop_cancelled.connect(manager.clear_loop)
        self.rehearsal_view.back_to_show.connect(lambda: self.show_view("escenario"))
        self.rehearsal_view.practice_tempo_changed.connect(self._on_practice_tempo)
        self._loop_timer = QTimer(self)
        self._loop_timer.setInterval(100)
        self._loop_timer.timeout.connect(self._tick_loop)
        self._loop_timer.start()
        self._add_view("ensayo", self.rehearsal_view)

        # Setlists y Canciones: la biblioteca, sin su barra de pestañas propia.
        self.library_view = LibraryView()
        self.library_view.set_transport_busy(lambda: not self._transport_idle())
        self.library_view.song_selected.connect(self._on_song_selected)
        self.library_view.setlist_activated.connect(self._on_library_setlist_chosen)
        self.library_view.demo_remove_requested.connect(self._remove_demo_data)
        self.library_view.setlist_saved.connect(self._on_library_setlist_saved)
        self.library_view.setlist_removed.connect(self._on_library_setlist_removed)
        self.library_view.song_saved.connect(self._on_library_song_changed)
        self.library_view.song_removed.connect(self._on_library_song_changed)
        self.library_view.status_message.connect(lambda text: self.status_bar.showMessage(text, 8000))
        library_page = QWidget()
        lcol = QVBoxLayout(library_page)
        lcol.setContentsMargins(0, 0, 0, 0)
        lcol.setSpacing(0)
        header, actions = ui.view_header("Setlists", "")
        self.library_title = header.findChild(QLabel)
        self.library_lede = header.findChild(QLabel, "viewLede")
        self.events_btn = ui.button("Eventos", "ghost", "Fechas de presentación y su setlist")
        self.events_btn.clicked.connect(lambda: self._show_library_page("eventos"))
        actions.addWidget(self.events_btn)
        lcol.addWidget(header)
        lrow = QHBoxLayout()
        lrow.setContentsMargins(0, 0, theme.SPACE_5, theme.SPACE_4)
        lrow.setSpacing(0)
        lrow.addWidget(self.library_view, 1)
        self.song_inspector = SongInspector()
        lrow.addWidget(self.song_inspector)
        lcol.addLayout(lrow, 1)
        self.analysis = AnalysisController(self._stems_cloud_client, parent=self)
        self.analysis.state.connect(self.song_inspector.set_analysis)
        self.song_inspector.analyze_requested.connect(self.analysis.analyze)
        self.song_inspector.refresh_requested.connect(self.analysis.refresh)
        self.library_view.tabs.tabBar().hide()
        self._library_page = library_page
        self._add_view("setlists", library_page)
        self._view_widgets["canciones"] = library_page

        # Pistas: secciones, stems de la canción en vivo y el mezclador de entradas plegado.
        self._add_view("pistas", self._create_tracks_view())

        self.band_view = BandView()
        self.band_view.open_hub.connect(self._open_hub)
        self._add_view("banda", self.band_view)

        self.settings_view = SettingsView()
        sv = self.settings_view
        sv.open_audio_devices.connect(self._open_audio_devices)
        sv.test_click.connect(self._test_click)
        sv.drummer_click_changed.connect(lambda on: self._set_click_routing(drummer=on))
        sv.pa_click_changed.connect(lambda on: self._set_click_routing(pa=on))
        sv.brightness_changed.connect(self._set_brightness)
        sv.open_account_login.connect(self._cloud_login)
        sv.cloud_sync.connect(self._cloud_sync_now)
        sv.choose_band.connect(self._cloud_choose_band)
        sv.sign_out.connect(self._cloud_logout)
        sv.retry_server.connect(self._restart_server)
        sv.set_click_routing(self._settings.drummer_click_enabled, self._settings.pa_click_enabled)
        sv.set_brightness(clamp_brightness(self._settings.brightness))
        self._add_view("ajustes", sv)

    # ------------------------------------------------------------------ Ensayo, Banda, Ajustes
    def _on_loop_requested(self, start_bar: int, end_bar: int, repeats: int):
        try:
            self.server.get_control_manager().set_loop(start_bar, end_bar, repeats)
        except ValueError as e:
            self.status_bar.showMessage(f"No se pudo repetir la sección: {e}", 8000)
            return
        self.status_bar.showMessage(
            f"Repitiendo compases {start_bar}-{end_bar}" + (f" ({repeats} veces)" if repeats else " sin fin"), 6000)

    def _tick_loop(self):
        manager = self.server.get_control_manager()
        manager.tick()
        info = manager.loop_info()
        self.rehearsal_view.set_loop_status(info.active, info.current_repeat, info.repeats)

    def _on_practice_tempo(self, percent: int):
        # Stems are not time-stretched: practice tempo is announced, not applied (pending).
        if percent != 100:
            self.status_bar.showMessage(
                f"Tempo de práctica {percent} %: todavía no cambia el transporte (los stems no se estiran)", 8000)

    def _set_click_routing(self, drummer=None, pa=None):
        if drummer is not None:
            self.audio_engine.enable_drummer_click = bool(drummer)
            self._settings.drummer_click_enabled = bool(drummer)
        if pa is not None:
            self.audio_engine.enable_pa_click = bool(pa)
            self._settings.pa_click_enabled = bool(pa)
        self._save_settings()

    def _open_hub(self):
        from PySide6.QtCore import QUrl
        from PySide6.QtGui import QDesktopServices

        band = self._settings.cloud_band_id
        url = "https://bandait.releven.cc/hub/" + (f"?banda={band}" if band else "")
        QDesktopServices.openUrl(QUrl(url))

    def _refresh_band_members(self):
        """Integrantes de la banda compartida (en segundo plano; RLS filtra)."""
        import threading

        band_id = self._settings.cloud_band_id
        if not band_id or not self.cloud.is_signed_in():
            self.band_view.set_members([])
            return
        from src.cloud.members import fetch_band_members

        def work():
            try:
                members = fetch_band_members(self.cloud.config, self.cloud.auth.access_token(), band_id)
            except Exception as e:  # sin red o sesión vencida: la vista queda con lo que tenía
                logger.info("No se pudieron leer los integrantes: %s", e)
                return
            QTimer.singleShot(0, self, lambda: self.band_view.set_members(members))

        threading.Thread(target=work, name="bandait-members", daemon=True).start()

    def _add_view(self, key: str, widget: QWidget):
        self.views.addWidget(widget)
        self._view_widgets[key] = widget

    def _create_tracks_view(self) -> QWidget:
        page = QWidget()
        col = QVBoxLayout(page)
        col.setContentsMargins(0, 0, 0, theme.SPACE_4)
        col.setSpacing(theme.SPACE_3)
        header, actions = ui.view_header("Pistas", "Secciones y stems de la canción en vivo")
        self.tracks_lede = header.findChild(QLabel, "viewLede")
        zoom_out = ui.button("− Zoom", "ghost")
        zoom_in = ui.button("Zoom +", "ghost")
        actions.addWidget(zoom_out)
        actions.addWidget(zoom_in)
        self.inputs_btn = ui.button("Mezclador de entradas", "ghost",
                                    "Entradas de la interfaz (el clic no pasa por aquí)")
        actions.addWidget(self.inputs_btn)
        col.addWidget(header)

        body = QHBoxLayout()
        body.setContentsMargins(theme.SPACE_5, 0, theme.SPACE_5, 0)
        body.setSpacing(theme.SPACE_3)
        left = QVBoxLayout()
        left.setSpacing(theme.SPACE_3)
        tl_panel, tl_body, _ = ui.panel("Secciones")
        self.timeline = TimelineWidget()
        self.timeline.setMinimumHeight(180)
        tl_body.addWidget(self.timeline)
        zoom_out.clicked.connect(self.timeline.zoom_out)
        zoom_in.clicked.connect(self.timeline.zoom_in)
        left.addWidget(tl_panel, 1)

        # Mezclador de entradas: oculto por defecto (Ver > Mezclador o el botón de arriba).
        self.mixer = MixerWidget()
        self.mixer.channel_mute.connect(self._on_channel_mute)
        self.mixer.channel_solo.connect(self._on_channel_solo)
        self.mixer.channel_fader.connect(self._on_channel_fader)
        self.mixer.channel_routing.connect(self._on_channel_routing)
        self.mixer.master_fader.connect(self._on_master_fader)
        mixer_container, mixer_body, _ = ui.panel("Mezclador de entradas")
        mixer_body.addWidget(self.mixer)
        self.mixer_container = mixer_container
        mixer_container.setVisible(False)
        self.inputs_btn.clicked.connect(lambda: self.set_mixer_visible(self.mixer_container.isHidden()))
        left.addWidget(mixer_container, 1)
        body.addLayout(left, 3)

        # Stems de la canción en vivo: solo visible cuando la canción los tiene.
        self.stem_mixer = StemMixerWidget()
        stems_container, stems_body, _ = ui.panel("")
        stems_body.setContentsMargins(0, 0, 0, 0)
        stems_body.addWidget(self.stem_mixer)
        self.stems_container = stems_container
        body.addWidget(stems_container, 2)
        col.addLayout(body, 1)
        return page

    def show_view(self, key: str):
        """Rail navigation. Setlists and Canciones are two pages of the library."""
        if key not in self._view_widgets:
            key = "escenario"
        self.views.setCurrentWidget(self._view_widgets[key])
        self.nav.select(key)
        if key in ("setlists", "canciones"):
            self._show_library_page(key)
        if key == "banda":
            self.band_view.set_urls(self.server.follower_url(), self.server.director_url())
            self._refresh_band_members()
        self._current_view = key

    def current_view(self) -> str:
        return getattr(self, "_current_view", "escenario")

    def _show_library_page(self, page: str):
        index = {"canciones": 0, "setlists": 1, "eventos": 2}[page]
        self.library_view.tabs.setCurrentIndex(index)
        titles = {
            "canciones": ("Canciones", "Biblioteca de la banda"),
            "setlists": ("Setlists", "Orden, transiciones y conteo de cada show"),
            "eventos": ("Eventos", "Fechas de presentación y su setlist"),
        }
        title, lede = titles[page]
        if self.library_title is not None:
            self.library_title.setText(title)
        if self.library_lede is not None:
            self.library_lede.setText(lede)
        self.events_btn.setVisible(page != "canciones")
        self.song_inspector.setVisible(page == "canciones")
        if page != "eventos":
            self.nav.select(page)

    def _apply_styles(self):
        """Fuentes incluidas, fuente base y la plantilla QSS Grafito rellenada con los tokens
        de theme.py. Se aplica a la aplicación entera para que los diálogos también la tengan."""
        from PySide6.QtWidgets import QApplication

        theme.load_fonts()
        app = QApplication.instance()
        base = QFont(theme.FONT_UI)
        base.setPixelSize(theme.SIZE_BASE)
        app.setFont(base)
        script_dir = os.path.dirname(os.path.abspath(__file__))
        for qss_path in (
            os.path.join(script_dir, "..", "styles", "bandait_dark.qss"),
            os.path.join(os.path.dirname(sys.argv[0]), "src", "styles", "bandait_dark.qss"),
        ):
            qss_path = os.path.abspath(qss_path)
            if os.path.exists(qss_path):
                try:
                    with open(qss_path, "r", encoding="utf-8") as f:
                        app.setStyleSheet(theme.render_qss(f.read()))
                    return
                except Exception as e:  # a broken style must not stop the show
                    logger.error("No se pudo aplicar el QSS %s: %s", qss_path, e)
        logger.warning("No se encontró bandait_dark.qss: estilos por defecto de Qt")

    def _setup_menu(self):
        menubar = self.menuBar()
        # Every action does something. The library saves on its own (SQLite), so
        # there is no "Guardar" and no session file to open.
        def library_action(text, tab, run):
            action = QAction(text, self)
            action.triggered.connect(lambda _checked=False: self._run_library_action(tab, run))
            file_menu.addAction(action)
            return action

        file_menu = menubar.addMenu("&Archivo")
        lv = self.library_view
        self.action_new_song = library_action("Nueva &canción...", 0, lv.new_song)
        self.action_import_song = library_action("&Importar archivo...", 0, lv._on_import)
        self.action_new_setlist = library_action("Nuevo &setlist...", 1, lv.new_setlist)
        self.action_new_gig = library_action("Nuevo &evento...", 2, lv.new_gig)
        file_menu.addSeparator()
        exit_action = QAction("&Salir", self)
        exit_action.setShortcut("Alt+F4")
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)

        audio_menu = menubar.addMenu("&Audio")
        self.action_audio_devices = QAction("&Dispositivos de Audio...", self)
        self.action_audio_devices.triggered.connect(self._open_audio_devices)
        audio_menu.addAction(self.action_audio_devices)
        self.action_test_click = QAction("&Probar click", self)
        self.action_test_click.triggered.connect(self._test_click)
        audio_menu.addAction(self.action_test_click)
        audio_menu.addSeparator()
        self.action_import_stems = QAction("&Importar stems de la canción en vivo...", self)
        self.action_import_stems.setToolTip("ZIP de Moises (MP3) o archivos sueltos; reemplaza los stems de la canción")
        self.action_import_stems.triggered.connect(self._import_stems_dialog)
        audio_menu.addAction(self.action_import_stems)
        self.action_download_stems = QAction("&Descargar stems del setlist (nube)", self)
        self.action_download_stems.setToolTip("Baja de la nube los stems que la banda subió desde el hub")
        self.action_download_stems.triggered.connect(self._download_setlist_stems)
        audio_menu.addAction(self.action_download_stems)

        net_menu = menubar.addMenu("&Red")
        self.action_retry_server = QAction("&Reintentar servidor", self)
        self.action_retry_server.triggered.connect(self._restart_server)
        net_menu.addAction(self.action_retry_server)
        self.action_connect = QAction("&Conectar músicos...", self)
        self.action_connect.triggered.connect(self._open_connect_musicians)
        net_menu.addAction(self.action_connect)
        self.action_musicians = QAction("&Músicos conectados...", self)
        self.action_musicians.triggered.connect(self._open_musicians_panel)
        net_menu.addAction(self.action_musicians)

        # The menu holds only what makes sense for the session (rebuilt on every
        # change). Every action also guards itself: a click at the wrong moment
        # only shows a message.
        self.account_menu = menubar.addMenu("&Cuenta")
        self.action_cloud_login = QAction("Iniciar sesión con &Google", self)
        self.action_cloud_login.triggered.connect(self._cloud_login)
        self.action_cloud_sync = QAction("&Sincronizar ahora", self)
        self.action_cloud_sync.triggered.connect(self._cloud_sync_now)
        self.action_cloud_band = QAction("Elegir &banda...", self)
        self.action_cloud_band.triggered.connect(self._cloud_choose_band)
        self.action_cloud_setlist = QAction("Elegir se&tlist...", self)
        self.action_cloud_setlist.triggered.connect(self._cloud_choose_setlist)
        self.action_cloud_logout = QAction("&Cerrar sesión", self)
        self.action_cloud_logout.triggered.connect(self._cloud_logout)
        self._refresh_cloud_menu()

        view_menu = menubar.addMenu("&Ver")
        fullscreen_action = QAction("&Pantalla Completa", self)
        fullscreen_action.setShortcut("F11")
        fullscreen_action.triggered.connect(self._toggle_fullscreen)
        view_menu.addAction(fullscreen_action)
        self.action_show_mixer = QAction("&Mezclador", self, checkable=True)
        self.action_show_mixer.setToolTip("Mezclador de entradas de la interfaz (el clic no pasa por aquí)")
        self.action_show_mixer.toggled.connect(self.set_mixer_visible)
        view_menu.addAction(self.action_show_mixer)
        brightness_menu = view_menu.addMenu("&Brillo")
        self.brightness_group = QActionGroup(self)
        self.brightness_actions = {}
        for level in BRIGHTNESS_LEVELS:
            action = QAction(f"{level} %", self, checkable=True)
            action.setChecked(level == clamp_brightness(self._settings.brightness))
            action.triggered.connect(lambda _checked=False, v=level: self._set_brightness(v))
            self.brightness_group.addAction(action)
            brightness_menu.addAction(action)
            self.brightness_actions[level] = action

        help_menu = menubar.addMenu("A&yuda")
        self.action_demo_load = QAction("Cargar canciones de &demostración...", self)
        self.action_demo_load.setToolTip("3 canciones, 1 setlist y 1 evento marcados DEMO, para probar Bandait")
        self.action_demo_load.triggered.connect(self._load_demo_data)
        help_menu.addAction(self.action_demo_load)
        self.action_demo_remove = QAction("&Quitar datos de demostración...", self)
        self.action_demo_remove.triggered.connect(self._remove_demo_data)
        help_menu.addAction(self.action_demo_remove)
        help_menu.addSeparator()
        self.action_about = QAction("&Acerca de Bandait", self)
        self.action_about.triggered.connect(self._show_about)
        help_menu.addAction(self.action_about)

    # ------------------------------------------------------------------ stems (fase 3)
    def _setup_stems(self):
        self.stems = StemsController(
            self.audio_engine, self.stem_mixer, self.stems_container, parent=self,
            cloud=self._stems_cloud_client, cloud_ref=self.library_view.song_cloud_ref,
        )
        self.stems.message.connect(lambda text: self.status_bar.showMessage(text, 8000))
        self.stems.stems_shown.connect(self._on_stems_shown)
        self.stems.lanes_changed.connect(self.timeline.set_lanes)
        self.stem_mixer.import_requested.connect(self._import_stems_dialog)
        self.stem_mixer.remove_requested.connect(self._remove_live_stems)

    def _on_stems_shown(self, visible: bool):
        labels = [strip.name_label.text().title() for strip in self.stem_mixer.strips] if visible else []
        self.stage_view.set_stems_status(labels)

    def _update_now_playing(self, state: dict):
        """Top bar: live song, its position in the setlist and what comes next."""
        setlist = sorted((state or {}).get("setlist") or [], key=lambda e: e.get("order_index", 0))
        song_id = (state or {}).get("current_song_id")
        idx = next((i for i, e in enumerate(setlist) if e.get("song_id") == song_id), -1)
        if idx < 0:
            self.now_caption.setText("EN VIVO")
            self.now_song.setText("Sin canción")
            self.now_next.setText("")
            return
        entry = setlist[idx]
        live = self._live_entry(song_id) or {}
        artist = live.get("artist") or ""
        self.now_caption.setText(f"EN VIVO · TEMA {idx + 1} DE {len(setlist)}")
        self.now_song.setText(entry.get("title", "") + (f" — {artist}" if artist else ""))
        if idx + 1 < len(setlist):
            nxt = setlist[idx + 1]
            mode = {"auto_count_in": "conteo", "gapless": "sin pausa"}.get(nxt.get("transition_mode"), "manual")
            self.now_next.setText(f"Sigue: {nxt.get('title', '')} · {nxt.get('bpm', '')} BPM · entrada {mode}")
        else:
            self.now_next.setText("Última canción del setlist")

    def _show_live_in_rehearsal(self, song_id):
        entry = self._live_entry(song_id) if song_id else None
        self.rehearsal_view.set_song(entry if entry and entry.get("sections") else None)

    def _show_live_stems(self, song_id, state: dict):
        title = next((e.get("title") for e in (state or {}).get("setlist", []) if e.get("song_id") == song_id), "")
        # Network only with the band stopped: during the show the laptop's stems are used as they are.
        idle = (state or {}).get("status", "IDLE") == "IDLE"
        self.stems.show_song(song_id, title, song_bpm(self._live_entry(song_id), self._bpm), allow_network=idle)

    def _stems_cloud_client(self):
        if not self.cloud.is_signed_in():
            return None
        return StemsCloud(self.cloud.auth.access_token, user_agent=f"Bandait-Leader/{APP_VERSION}")

    def _download_setlist_stems(self):
        if self._status != "IDLE":
            QMessageBox.information(self, "Stems", "Detén la banda para descargar stems.")
            return
        if not self.cloud.is_signed_in():
            QMessageBox.information(self, "Stems", "Inicia sesión en la nube (menú Cuenta) para descargar stems.")
            return
        songs = [(str(e.get("song_id")), str(e.get("title") or "")) for e in self._live_entries if e.get("song_id")]
        if not songs:
            QMessageBox.information(self, "Stems", "El setlist en vivo está vacío.")
            return
        if not self.stems.download_setlist(songs):
            self.status_bar.showMessage("Ya hay una operación de stems en curso", 6000)

    def _import_stems_dialog(self):
        from PySide6.QtWidgets import QFileDialog

        if not self._live_song_id:
            QMessageBox.information(self, "Stems", "Primero elige una canción del setlist en vivo.")
            return
        if self._status != "IDLE":
            QMessageBox.information(self, "Stems", "Detén la banda para importar stems.")
            return
        paths, _ = QFileDialog.getOpenFileNames(
            self, "Importar stems de la canción en vivo", "", import_dialog_filter()
        )
        if paths and not self.stems.import_paths(paths):
            self.status_bar.showMessage("Ya hay una importación de stems en curso", 6000)

    def _remove_live_stems(self):
        if self._status != "IDLE":
            QMessageBox.information(self, "Stems", "Detén la banda para quitar los stems.")
            return
        answer = QMessageBox.question(
            self, "Quitar stems", "¿Borrar del portátil los stems de esta canción?",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No,
        )
        if answer == QMessageBox.Yes:
            self.stems.remove_live()

    def set_mixer_visible(self, visible: bool):
        """Ver > Mezclador. Hidden by default while no song has stems."""
        self.mixer_container.setVisible(bool(visible))
        if self.action_show_mixer.isChecked() != bool(visible):
            self.action_show_mixer.setChecked(bool(visible))

    def _toggle_fullscreen(self):
        if self.isFullScreen():
            self.showNormal()
        else:
            self.showFullScreen()
        self.stage_view.set_fullscreen_state(self.isFullScreen())

    # ------------------------------------------------------------------ menu actions
    def _open_audio_devices(self):
        from src.ui.dialogs.audio_devices import AudioDevicesDialog

        dialog = AudioDevicesDialog(
            current_device=self.audio_engine.device,
            drummer_click=self.audio_engine.enable_drummer_click,
            pa_click=self.audio_engine.enable_pa_click,
            enable_asio=self._settings.enable_asio,
            parent=self,
        )
        if dialog.exec():
            self.apply_audio_choice(dialog.choice())

    def apply_audio_choice(self, choice):
        """Aplicar y persistir la elección del diálogo de audio."""
        asio_changed = choice.enable_asio != self._settings.enable_asio
        self.audio_engine.enable_drummer_click = choice.drummer_click
        self.audio_engine.enable_pa_click = choice.pa_click
        if choice.device_id != self.audio_engine.device:
            was_running = self.audio_engine.is_running()
            try:
                self.audio_engine.set_device(choice.device_id)
            except Exception as e:
                self._set_audio_status(f"Audio: no se pudo abrir el dispositivo ({e})", theme.DANGER)
            else:
                if not was_running:
                    self._start_audio()
        self._settings.audio_output_device_name = choice.device_name
        self._settings.audio_output_hostapi = choice.hostapi
        self._settings.drummer_click_enabled = choice.drummer_click
        self._settings.pa_click_enabled = choice.pa_click
        self._settings.enable_asio = choice.enable_asio
        self._save_settings()
        if self.audio_engine.is_running():
            self._on_audio_started()
        if asio_changed:
            self.status_bar.showMessage("ASIO cambiará al reiniciar Bandait", 8000)

    def _restart_server(self):
        self.server.stop()
        self.server.start()
        self._on_server_status(self.server.status, self.server.status_message)

    def _open_connect_musicians(self):
        from src.ui.dialogs.connect_musicians import ConnectMusiciansDialog

        dialog = ConnectMusiciansDialog(
            self.server, on_ip_selected=self._remember_lan_ip, saved_ip=self._settings.lan_ip, parent=self
        )
        dialog.exec()
        self._on_server_status(self.server.status, self.server.status_message)

    def _remember_lan_ip(self, ip):
        self._settings.lan_ip = ip
        self._save_settings()

    def _show_about(self):
        QMessageBox.about(
            self,
            "Acerca de Bandait",
            f"Bandait DAW {APP_VERSION}\nLíder de sesión, protocolo v3.\n\n"
            f"Servidor: {self.server.lan_url()}\nBase de datos: {get_db_path()}\n"
            f"Reloj del líder: {CLOCK_NAME}",
        )

    def _set_brightness(self, percent: int):
        """Ver > Brillo: baja la intensidad de toda la ventana y la recuerda."""
        self._settings.brightness = self.dim_overlay.set_brightness(percent)
        action = self.brightness_actions.get(self._settings.brightness)
        if action is not None:
            action.setChecked(True)
        self.settings_view.set_brightness(self._settings.brightness)
        self._save_settings()

    def _save_settings(self):
        try:
            save_settings(self._settings)
        except Exception as e:
            self.status_bar.showMessage(f"No se pudo guardar la configuración: {e}", 8000)

    # ------------------------------------------------------------------ status callbacks
    def _set_audio_status(self, text: str, color: str):
        # Texto acortado con "..." para que la barra no se desborde; el completo, en el tooltip.
        metrics = self.status_audio.fontMetrics()
        self.status_audio.setText(metrics.elidedText(text, Qt.ElideRight, AUDIO_STATUS_MAX_PX))
        self.status_audio.setToolTip(text)
        if hasattr(self, "settings_view"):
            self.settings_view.set_audio_status(text)
        ui.set_prop(self.status_audio, "health", {theme.SUCCESS: "ok", theme.DANGER: "bad", theme.WARNING: "warn"}
                    .get(color.upper(), ""))

    def _test_click(self):
        """Audio > Probar click: says where it should sound, or why it cannot."""
        reason = self.audio_engine.test_click()
        if reason:
            self.status_bar.showMessage(f"Probar click: {reason}", 10000)
            return
        eng = self.audio_engine
        outputs = []
        if eng.enable_pa_click:
            outputs.append("Salidas 1-2 (PA)")
        if eng.enable_drummer_click and eng.drummer_click_available:
            outputs.append("Salida 3 (baterista)")
        self.status_bar.showMessage(
            f"Probar click: un compás por {eng.device_name}, {' y '.join(outputs)}. Si no lo oyes, revisa el volumen de Windows y ese dispositivo.",
            10000,
        )

    def _on_audio_started(self):
        eng = self.audio_engine
        routing = "clic baterista Salida 3" if (eng.enable_drummer_click and eng.drummer_click_available) else (
            "sin Salida 3: clic baterista no disponible" if eng.enable_drummer_click else "clic baterista apagado"
        )
        if eng.enable_pa_click:
            routing += ", clic en PA"
        text = f"Audio: {eng.device_name} ({eng.output_channels} salidas; {routing})"
        if self._saved_device_missing:
            text += " - el dispositivo guardado no está conectado"
        self._set_audio_status(text, theme.SUCCESS)

    def _on_audio_stopped(self):
        self._set_audio_status("Audio: detenido", theme.MUTED)

    def _on_server_status(self, status: str, message: str):
        self.status_net.setText(f"Red: {message}")
        if hasattr(self, "settings_view"):
            self.settings_view.set_network_status(message, self.server.follower_url() if status == "running" else "")
        ui.set_prop(self.status_net, "health", {"running": "ok", "error": "bad", "starting": "warn"}.get(status, ""))
        ok = status == "running"
        self.stage_view.set_network_status(ok)
        self.transport.set_network_status(ok, "Red OK" if ok else "Red caída")

    def _on_followers_changed(self, followers):
        from src.ui.dialogs.musicians_panel import HEALTH_COLORS, summary_text, worst_health

        followers = followers or []
        self._followers = followers
        now = leader_now_ns()
        self.status_followers.setText(summary_text(followers, now))
        worst = worst_health(followers, now)
        ui.set_prop(self.status_followers, "health", worst if worst in HEALTH_COLORS else "")
        self.status_followers.setToolTip(
            "\n".join(f"{f.get('alias')} ({f.get('role')})" for f in followers) or "Nadie conectado"
        )
        if self._musicians_panel is not None:
            self._musicians_panel.set_followers(followers)
        self.stage_view.set_followers(_stage_follower_rows(followers, now))
        self.band_view.set_followers(followers)

    def _open_musicians_panel(self):
        from src.ui.dialogs.musicians_panel import MusiciansPanel

        if self._musicians_panel is None:
            self._musicians_panel = MusiciansPanel(self._followers, parent=self)
        else:
            self._musicians_panel.set_followers(self._followers)
        self._musicians_panel.show()
        self._musicians_panel.raise_()

    def _on_setlist_jump(self, jump: dict):
        try:
            self.stage_view.show_jump_alert(str(jump.get("title", "")), int(jump.get("order_index", 0)))
        except Exception:
            pass

    # ------------------------------------------------------------------ transport mirror
    def _on_session_state(self, state: dict):
        """SessionState publicado por el líder (hilo Qt)."""
        status = state.get("status", "IDLE")
        self._status = status
        self._bpm = state.get("bpm", self._bpm)
        self.transport.set_transport_status(status)
        self.transport.display_bpm(self._bpm)
        self.stage_view.set_bpm(int(round(self._bpm)))
        self.timeline.set_bpm(int(round(self._bpm)))
        if status != "PLAYING":
            self.transport.clear_beat()
            self.stage_view.clear_beat()
            self.stage_view.set_bar(state.get("paused_bar") if status == "PAUSED" else None)
        if status == "IDLE":
            self.transport.set_time(0.0)
            self.timeline.set_position(0.0)
        song_id = state.get("current_song_id")
        if song_id != self._live_song_id:
            self._live_song_id = song_id
            self._show_live_song(song_id, state)
            self.stage_view.set_current_song_id(song_id)
        self._update_now_playing(state)
        last = state.get("last_command") or {}
        if last.get("type") == "PANIC":
            self.status_bar.showMessage(f"PANIC desde {last.get('origin')}: transporte detenido", 8000)
        if status == "IDLE" and self._pending_live_setlist:
            # Una sincronización terminó mientras sonaba: se aplica al detener.
            QTimer.singleShot(0, self._apply_pending_live_reload)

    def _show_live_song(self, song_id, state: dict):
        if not song_id:
            self.stage_view.set_song(title="Sin canción")
            self._show_live_stems(None, state)
            return
        data = self.library_view.get_song_data_by_id(song_id)
        entry = self._live_entry(song_id)
        if data and entry and entry.get("sections"):
            # Secciones reales del hub (compases), no las adivinadas del texto.
            data = dict(data)
            data["sections"] = [{"label": s["label"], "bars": s["bars"]} for s in entry["sections"]]
            data["beats_per_bar"] = entry.get("beats_per_bar", 4)
        if data:
            self._current_song = data
            self._load_song_to_timeline(data)
            self._load_song_to_stage(data)
        else:
            title = next((e.get("title") for e in state.get("setlist", []) if e.get("song_id") == song_id), song_id)
            self.stage_view.set_song(title=title)
        # Lyrics and chords by section, the same content phones get (CONTRACT_V3 9.1).
        self.stage_view.set_song_content(entry)
        self._show_live_in_rehearsal(song_id)
        self._show_live_stems(song_id, state)

    def _on_clock_beat(self, bar: int, beat: int, bpm: float):
        self.transport.set_beat(beat)
        self.transport.set_bar(bar, beat)
        self.stage_view.set_beat(beat)
        self.stage_view.set_bar(bar)

    def _on_audio_levels(self, levels: list):
        for i, level in enumerate(levels[:4]):
            self.mixer.set_channel_level(i, level)
        master = sum(levels[:4]) / len(levels[:4]) if levels else 0.0
        self.mixer.set_master_level(master)

    def _update_ui(self):
        """30 fps: posición derivada del anchor (no de un contador propio)."""
        if self._status in ("PLAYING", "PAUSED"):
            seconds = self.clock_service.position_seconds()
            self.transport.set_time(seconds)
            self.timeline.set_position(seconds)

    # ------------------------------------------------------------------ commands
    def send_command(self, command_type: str, payload: dict = None):
        """Enviar un comando laptop_foh por el mismo camino que los remotos."""
        try:
            result = self.server.submit_local_command(command_type, payload or {})
        except Exception as e:
            logger.exception("Local command failed")
            self.status_bar.showMessage(f"Error de transporte: {e}", 8000)
            return None
        if not result.accepted:
            self.status_bar.showMessage(REJECT_MESSAGES.get(result.reason, str(result.reason)), 6000)
        return result

    def _live_state(self) -> dict:
        return self.clock_service.session_state or self.server.get_state()

    def _on_play(self):
        status = self._live_state().get("status")
        self.send_command("RESUME" if status == "PAUSED" else "PLAY")

    def _on_pause(self):
        self.send_command("PAUSE")

    def _on_stop(self):
        self.send_command("STOP")

    def _on_panic(self):
        self.send_command("PANIC")

    def _on_next_song(self):
        self.send_command("CUE_NEXT", {"expected_song_id": self._live_state().get("current_song_id")})

    def _on_prev_song(self):
        self.send_command("CUE_PREV", {"expected_song_id": self._live_state().get("current_song_id")})

    def _on_tempo_nudge(self, delta: int):
        self.send_command("TEMPO_NUDGE", {"delta_bpm": int(delta)})

    def _on_bpm_changed(self, bpm: int):
        """TAP tempo: se traduce a TEMPO_NUDGE (delta) para no saltarse el contrato."""
        current = self._live_state().get("bpm", self._bpm)
        delta = int(round(bpm - float(current)))
        if delta:
            self.send_command("TEMPO_NUDGE", {"delta_bpm": delta})

    def _on_rec(self):
        is_rec = self.transport.rec_btn.isChecked()
        if is_rec:
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            song_name = ""
            if self._current_song:
                song_name = self._current_song.get("title", "").replace(" ", "_")
            session_name = f"{timestamp}_{song_name}" if song_name else f"{timestamp}_ensayo"
            base_dir = recordings_dir()
            try:
                os.makedirs(base_dir, exist_ok=True)
                folder = self.audio_engine.start_recording(session_name, base_dir=base_dir)
                self._last_recording_folder = folder
                self._set_audio_status(f"GRABANDO — {session_name}", theme.DANGER)
                self.status_bar.showMessage(f"Grabación iniciada: {os.path.basename(folder)}", 5000)
            except Exception as e:
                self.transport.set_recording_state(False)
                self._set_audio_status(f"Audio: no se pudo grabar ({e})", theme.WARNING)
        else:
            try:
                self.audio_engine.stop_recording()
                if self.audio_engine.is_running():
                    self._on_audio_started()
                if hasattr(self, "_last_recording_folder"):
                    self.status_bar.showMessage(f"Grabación guardada en: {self._last_recording_folder}", 10000)
            except Exception as e:
                print(f"[AUDIO] No se pudo detener grabación: {e}")

    # ------------------------------------------------------------------ mixer
    def _on_channel_mute(self, channel_id: int, muted: bool):
        self.audio_engine.mixer.set_track_mute(channel_id, muted)

    def _on_channel_solo(self, channel_id: int, soloed: bool):
        self.audio_engine.mixer.set_track_solo(channel_id, soloed)

    def _on_channel_fader(self, channel_id: int, db: float):
        self.audio_engine.mixer.set_track_volume(channel_id, db)

    def _on_channel_routing(self, channel_id: int, text: str):
        if text.startswith("Salida "):
            try:
                mask = 1 << (int(text.split()[1]) - 1)
            except (IndexError, ValueError):
                return
        else:  # "Master" = Salidas 1-2
            mask = 0b11
        self.audio_engine.mixer.set_track_output(channel_id, mask)

    def _on_master_fader(self, db: float):
        self.audio_engine.mixer.set_master_volume(db)

    # ------------------------------------------------------------------ setlist / songs
    def _initial_setlist_target(self):
        """Setlist for startup (and after removing the demo data).

        With a hub band chosen only that band's setlists count: the chosen one,
        even when it is empty, else the band's first one; never a demo or local
        setlist. Without a band: the saved one, else the first in the library."""
        wanted = self._settings.active_setlist_id
        band_id = self._settings.cloud_band_id
        if band_id:
            band_setlists = self.library_view.cloud_setlist_ids(band_id)
            if wanted in band_setlists:
                return wanted
            return band_setlists[0] if band_setlists else None
        ids = self.library_view.setlist_ids()
        return wanted if wanted in ids else (ids[0] if ids else None)

    def _load_initial_setlist(self):
        setlist_id = self._initial_setlist_target()
        if setlist_id:
            self._activate_setlist(setlist_id, persist=False)
        else:
            self._clear_live_setlist()

    def _activate_setlist(self, setlist_id: str, persist: bool = True):
        """Único camino al setlist en vivo: DB -> entradas -> server.set_setlist.
        Las entradas llevan transición, conteo y secciones (CONTRACT_V3 9)."""
        entries = self.library_view.get_setlist_entries(setlist_id)
        self._live_entries = entries
        self._live_setlist_id = setlist_id
        self._pending_live_setlist = None
        self.server.set_setlist(entries)
        self.stage_view.set_setlist(entries, self._live_song_id)
        if self._live_song_id:
            # Same live song, new content (a hub sync while stopped): refresh the prompter.
            self.stage_view.set_song_content(self._live_entry(self._live_song_id))
        self.library_view.mark_active_setlist(setlist_id)
        name = self.library_view.setlist_name(setlist_id)
        count = songs_label(len(entries))
        self.mini_label.setText(f"Setlist en vivo: {name} ({count})" if name else f"Setlist en vivo: {count}")
        self._update_setlist_notice()
        if persist:
            self._settings.active_setlist_id = setlist_id
            self._save_settings()

    def _clear_live_setlist(self):
        """No live setlist (call it with the band stopped): phones show no songs
        and the persistent notice says what to do."""
        self._live_entries = []
        self._live_setlist_id = None
        self._pending_live_setlist = None
        self.server.set_setlist([])
        self.stage_view.set_setlist([])
        self.library_view.mark_active_setlist(None)
        self.mini_label.setText("Setlist en vivo: ninguno")
        self._update_setlist_notice()

    def _update_setlist_notice(self):
        """Persistent notice (stage view + status bar) while the live setlist is
        empty. Never a timed message: it stays until there are songs."""
        if self._live_setlist_id is None:
            stage = NO_SETLIST_NOTICE if self.cloud.is_signed_in() else NO_SETLIST_SIGNED_OUT_NOTICE
            status = STATUS_NO_SETLIST
        elif not self._live_entries:
            stage, status = EMPTY_SETLIST_NOTICE, STATUS_EMPTY_SETLIST
        else:
            stage = status = ""
        try:
            self.stage_view.set_setlist_notice(stage)
            self.status_setlist.setText(status)
            self.status_setlist.setToolTip(stage)
            self.status_setlist.setVisible(bool(status))
        except Exception as e:  # a notice must never break loading a setlist
            logger.warning("No se pudo mostrar el aviso de setlist: %s", e)

    def setlist_notice(self) -> str:
        """Text of the persistent notice ("" when the live setlist has songs)."""
        return self.stage_view.setlist_notice_text()

    def _live_entry(self, song_id):
        return next((e for e in self._live_entries if e.get("song_id") == song_id), None)

    def _on_song_selected(self, song_id: int):
        """Vista previa en el timeline e inspector de Canciones. No mueve el transporte."""
        song_data = self.library_view.get_song_data(song_id)
        if song_data:
            self._load_song_to_timeline(song_data)
        local_id = self.library_view.song_id_at(song_id)
        self._show_in_inspector(local_id, song_data)

    def _show_in_inspector(self, local_id, song_data):
        from src.audio import stem_library

        ref = self.library_view.song_cloud_ref(local_id) if local_id else None
        stem_set = stem_library.load(local_id) if local_id else None
        stems = ", ".join(s.label for s in stem_set.stems) if stem_set else ""
        if not self.cloud.is_signed_in():
            can, reason = False, "Inicia sesión en la nube (Cuenta) para analizar"
        elif ref is None:
            can, reason = False, "Solo canciones del hub se pueden analizar"
        elif stem_set is None:
            can, reason = False, "Esta canción no tiene stems en el portátil"
        else:
            can, reason = True, ""
        self.song_inspector.set_song(song_data or None, self.library_view.song_sections(local_id) if local_id else [],
                                     stems, can, reason)
        self.analysis.select(local_id, ref)

    def _load_song_to_timeline(self, song_data: dict):
        self.timeline.clear_sections()
        sections = song_data.get("sections", [])
        beats_per_bar = song_data.get("beats_per_bar", 4) or 4
        beat_pos = 0
        for section in sections:
            label = section.get("label", "Sección")
            bars = section.get("bars", 8)
            beats = bars * beats_per_bar
            self.timeline.add_section(label, beat_pos, beats)
            beat_pos += beats
        if not sections:
            self.timeline.add_section("Completa", 0, 64)
        self.timeline.set_duration(song_data.get("duration_seconds", 180))
        self.timeline.set_bpm(song_data.get("bpm", 120))

    def _load_song_to_stage(self, song_data: dict):
        lyrics = song_data.get("lyrics", [])
        if not lyrics and song_data.get("lyrics_text"):
            lines = song_data["lyrics_text"].strip().split("\n")
            lyrics = [{"time": i * 5.0, "text": line.strip()} for i, line in enumerate(lines) if line.strip()]

        current_lyric = lyrics[0]["text"] if lyrics else ""
        next_lyric = lyrics[1]["text"] if len(lyrics) > 1 else ""
        sections = song_data.get("sections", [])
        current_section = sections[0]["label"] if sections else "Intro"
        next_section = sections[1]["label"] if len(sections) > 1 else ""

        self.stage_view.set_song(
            title=song_data.get("title", "Sin título"),
            current_lyric=current_lyric,
            next_lyric=next_lyric,
            section=current_section,
            next_section=next_section,
        )
        self.stage_view.set_lyrics(lyrics)

    # ------------------------------------------------------------------ live setlist changes
    def _transport_idle(self) -> bool:
        return self._live_state().get("status", "IDLE") == "IDLE"

    def _request_live_setlist(self, setlist_id: str, persist: bool, reason: str = ""):
        """Cargar ahora si la banda está detenida; si suena, al próximo IDLE.
        Nunca se cambia el setlist debajo de una canción que está sonando."""
        if persist:
            self._settings.active_setlist_id = setlist_id
            self._save_settings()
        if self._transport_idle():
            self._activate_setlist(setlist_id, persist=False)
            return
        self._pending_live_setlist = setlist_id
        self.status_bar.showMessage(f"{reason or 'Setlist actualizado'}: se carga al detener la banda", 10000)

    # ------------------------------------------------------------------ library edits
    def _run_library_action(self, tab: int, run):
        """Archivo > Nueva canción / setlist / evento: show the library, then run it."""
        self.show_view({0: "canciones", 1: "setlists"}.get(tab, "setlists"))
        if tab == 2:
            self._show_library_page("eventos")
        run()

    def _on_library_setlist_chosen(self, setlist_id: str):
        """Cargar en vivo (biblioteca o evento): same path as the hub picker, so the
        setlist never changes under a song that is playing."""
        self._request_live_setlist(setlist_id, persist=True, reason="Setlist elegido")

    def _on_library_setlist_saved(self, setlist_id: str):
        if setlist_id == self._live_setlist_id:
            self._request_live_setlist(setlist_id, persist=False, reason="Setlist editado")

    def _on_library_setlist_removed(self, setlist_id: str):
        if self._settings.active_setlist_id == setlist_id:
            self._settings.active_setlist_id = None
            self._save_settings()
        if self._pending_live_setlist == setlist_id:
            self._pending_live_setlist = None
        if setlist_id == self._live_setlist_id:
            self._load_initial_setlist()  # the view refuses this while the band plays

    def _on_library_song_changed(self, song_id: str):
        """A song of the live setlist was edited or removed: phones get the new
        tempo and lyrics, at once if the band is stopped, else when it stops."""
        if self._live_setlist_id and self._live_entry(song_id) is not None:
            self._request_live_setlist(self._live_setlist_id, persist=False, reason="Canción editada")

    def _apply_pending_live_reload(self):
        setlist_id = self._pending_live_setlist
        if not setlist_id or not self._transport_idle():
            return
        if setlist_id in self.library_view.setlist_ids():
            self._activate_setlist(setlist_id, persist=False)
            self.status_bar.showMessage("Setlist en vivo actualizado", 6000)
        else:
            self._pending_live_setlist = None

    # ------------------------------------------------------------------ cuenta (nube)
    def _cloud_startup(self):
        """Con sesión guardada: sincronizar en segundo plano. Sin red, la copia local
        ya está en la base y el show arranca igual."""
        user = self.cloud.restore()
        if user is not None and self._settings.cloud_user_id not in (None, user.id):
            # The saved band belongs to another account.
            self._settings.cloud_band_id = None
            self._settings.cloud_user_id = user.id
            self._save_settings()
        self._refresh_cloud_menu()
        self._refresh_cloud_status()
        if user is not None:
            self.cloud.start_sync(self._settings.cloud_band_id, user_initiated=False)
            self._refresh_cloud_status()

    def _cloud_band_mode(self) -> bool:
        """Signed in with a hub band chosen: the library hides the demo rows."""
        return bool(self._settings.cloud_band_id) and self.cloud.is_signed_in()

    def _refresh_library_mode(self):
        try:
            self.library_view.set_cloud_mode(self._cloud_band_mode())
        except Exception as e:
            logger.warning("No se pudo actualizar la biblioteca: %s", e)

    def _refresh_cloud_menu(self):
        """Signed out: only "Iniciar sesión". Signed in: sync, pickers, sign out.
        The actions belong to the window, so clear() never deletes them."""
        self._refresh_library_mode()
        self._update_setlist_notice()
        menu = self.account_menu
        menu.clear()
        if not self.cloud.is_signed_in():
            menu.addAction(self.action_cloud_login)
            return
        user = self.cloud.user
        who = (user.email or user.name) if user else ""
        self.action_cloud_logout.setText(f"&Cerrar sesión ({who})" if who else "&Cerrar sesión")
        for action in (self.action_cloud_sync, self.action_cloud_band, self.action_cloud_setlist):
            menu.addAction(action)
        menu.addSeparator()
        menu.addAction(self.action_cloud_logout)

    def _refresh_cloud_status(self):
        text, color, tooltip = self.cloud.status()
        self.status_cloud.setText(text)
        ui.set_prop(self.status_cloud, "health", _cloud_health(color))
        self.status_cloud.setToolTip(tooltip)
        self._refresh_identity()

    def _refresh_identity(self):
        """Band name in the top bar and the account at the bottom of the rail."""
        snapshot = self.cloud.last_snapshot
        band_id = self._settings.cloud_band_id
        band = snapshot.workspace.band(band_id) if (snapshot and band_id) else None
        band_name = band.band.name if band else ""
        self.band_label.setText(band_name or "Sin banda")
        self.band_view.set_band(band_name or "Sin banda")
        user_label = (self.cloud.user.email or self.cloud.user.name) if self.cloud.user else ""
        self.settings_view.set_cloud_status(self.cloud.is_signed_in(), user_label, band_name)
        user = self.cloud.user
        if user is None:
            self.nav.set_account("Sin sesión", "Menú Cuenta")
        else:
            self.nav.set_account(user.name or user.email or "Cuenta", band_name or (user.email or ""))

    def _require_cloud_session(self) -> bool:
        if self.cloud.is_signed_in():
            return True
        self.status_bar.showMessage("Primero inicia sesión: Cuenta > Iniciar sesión con Google", 8000)
        return False

    def _cloud_login(self):
        if self.cloud.is_signed_in():
            self.status_bar.showMessage("Ya hay una sesión iniciada", 5000)
            return
        from src.ui.dialogs.account_login import LoginDialog

        dialog = LoginDialog(self.cloud, parent=self)
        dialog.start()
        dialog.exec()
        result = dialog.result
        self._refresh_cloud_menu()
        self._refresh_cloud_status()
        if result is None or not result.ok or result.user is None:
            return
        if self._settings.cloud_user_id != result.user.id:
            self._settings.cloud_user_id = result.user.id
            self._settings.cloud_band_id = None
            self._save_settings()
        if not result.persisted:
            self.status_bar.showMessage(
                "No se pudo guardar la sesión en el Administrador de credenciales: dura hasta cerrar Bandait",
                12000,
            )
        self.cloud.start_sync(self._settings.cloud_band_id, user_initiated=True)
        self._refresh_cloud_status()

    def _cloud_sync_now(self):
        if not self._require_cloud_session():
            return
        if self.cloud.sync_running():
            self.status_bar.showMessage("Ya hay una sincronización en curso", 5000)
            return
        self.cloud.start_sync(self._settings.cloud_band_id, user_initiated=True)
        self._refresh_cloud_status()

    def _refresh_library(self):
        """La importación escribe con su propia conexión: releer la biblioteca."""
        view = self.library_view
        self._refresh_library_mode()
        try:
            view.reload()
            view.mark_active_setlist(self._live_setlist_id)
        except Exception as e:
            logger.warning("No se pudo refrescar la biblioteca: %s", e)

    def _on_cloud_sync_finished(self, outcome):
        self._refresh_cloud_menu()
        self._refresh_cloud_status()
        if outcome.revoked:
            return  # _on_cloud_signed_out shows the message
        report = outcome.report
        if report is None:
            if outcome.needs_band_choice and outcome.user_initiated and outcome.snapshot is not None:
                QTimer.singleShot(0, self._cloud_choose_band)
            else:
                self.status_bar.showMessage(outcome.message, 12000)
            return
        user = self.cloud.user
        if outcome.band_id and (outcome.band_id != self._settings.cloud_band_id
                                or (user and self._settings.cloud_user_id != user.id)):
            self._settings.cloud_band_id = outcome.band_id
            self._settings.cloud_user_id = user.id if user else self._settings.cloud_user_id
            self._save_settings()
        self._refresh_library()
        message = outcome.message
        if outcome.source == "cache":
            message += " (copia local: sin conexión)"
        if outcome.warnings:
            message += f" - {len(outcome.warnings)} avisos (ver la barra NUBE)"
            self.status_cloud.setToolTip(
                self.status_cloud.toolTip() + "\n\nAvisos:\n" + "\n".join(outcome.warnings[:15])
            )
        self.status_bar.showMessage(message, 10000)

        # Setlist to (re)load: the one chosen for the show if it is in this band,
        # else the live one when it came from the hub (its content may have changed).
        # A hub band is chosen now: a demo or local setlist never stays live.
        band_setlists = set(report.setlist_ids.values())
        live = self._live_setlist_id
        wanted = self._settings.active_setlist_id
        target = wanted if wanted in band_setlists else (live if live in band_setlists else None)
        ask = bool(outcome.user_initiated and band_setlists and target is None)
        if target is None and band_setlists:
            ordered = [sid for sid in self.library_view.cloud_setlist_ids(outcome.band_id) if sid in band_setlists]
            target = ordered[0] if ordered else sorted(band_setlists)[0]
        if target:
            self._request_live_setlist(target, persist=False, reason="Setlist actualizado desde el hub")
        elif live is not None and self._transport_idle():
            self._clear_live_setlist()
            self.status_bar.showMessage(
                "Esta banda no tiene setlists en el hub: créalos en bandait.releven.cc/hub y sincroniza", 12000,
            )
        elif live and live not in self.library_view.setlist_ids():
            self.status_bar.showMessage(
                "El setlist en vivo ya no está en la biblioteca: sigue cargado hasta que elijas otro "
                "(Cuenta > Elegir setlist)", 12000,
            )
        if ask:
            QTimer.singleShot(0, self._cloud_choose_setlist)

    # ------------------------------------------------------------------ demo data
    def _load_demo_data(self):
        answer = QMessageBox.question(
            self,
            "Canciones de demostración",
            "¿Cargar 3 canciones, 1 setlist y 1 evento de demostración?\n\n"
            "Quedan marcados DEMO en la Biblioteca y no se mezclan con las canciones del hub. "
            "Se quitan con Ayuda > Quitar datos de demostración.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if answer != QMessageBox.Yes:
            return
        try:
            added = load_demo_data(get_db_path())
        except Exception as e:
            logger.exception("No se pudieron cargar los datos de demostración")
            self.status_bar.showMessage(f"No se pudieron cargar los datos de demostración: {e}", 10000)
            return
        self._refresh_library()
        self.library_view.set_show_demo(True)  # the user just asked for them
        if added:
            self.status_bar.showMessage(f"Datos de demostración cargados ({added} filas, marcadas DEMO)", 8000)
        else:
            self.status_bar.showMessage("Los datos de demostración ya estaban cargados", 6000)

    def _remove_demo_data(self):
        try:
            counts = count_demo_rows(get_db_path())
        except Exception as e:
            self.status_bar.showMessage(f"No se pudo leer la base de datos: {e}", 10000)
            return
        if counts.total == 0:
            self.status_bar.showMessage("No hay datos de demostración", 6000)
            return
        live_is_demo = bool(self._live_setlist_id) and (
            self.library_view.setlist_origin_of(self._live_setlist_id) == "demo"
        )
        live_uses_demo = live_is_demo or any(e.get("source") == "demo" for e in self._live_entries)
        if live_uses_demo and not self._transport_idle():
            self.status_bar.showMessage(
                "El setlist en vivo usa canciones de demostración: detén la banda antes de quitarlas", 10000
            )
            return
        answer = QMessageBox.question(
            self,
            "Quitar datos de demostración",
            f"Se borran {counts.songs} canciones, {counts.setlists} setlists, {counts.gigs} eventos y "
            f"{counts.members} miembros marcados DEMO.\n\n"
            "Antes se guarda una copia de la base de datos. Las canciones del hub y las tuyas no se tocan.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if answer != QMessageBox.Yes:
            return
        try:
            result = remove_demo_data(get_db_path())
        except Exception as e:
            logger.exception("No se pudieron quitar los datos de demostración")
            self.status_bar.showMessage(f"No se pudieron quitar los datos de demostración: {e}", 10000)
            return
        self._refresh_library()
        if live_is_demo:
            self._load_initial_setlist()
        elif live_uses_demo:
            self._activate_setlist(self._live_setlist_id, persist=False)  # drop the removed songs
        backup = os.path.basename(result.backup) if result.backup else "-"
        self.status_bar.showMessage(
            f"Datos de demostración quitados ({result.total} filas). Copia de la base: {backup}", 10000
        )

    def _on_cloud_signed_out(self, message: str):
        self._refresh_cloud_menu()
        self._refresh_cloud_status()
        self.status_bar.showMessage(message, 12000)

    def _cloud_choose_band(self):
        if not self._require_cloud_session():
            return
        snapshot = self.cloud.last_snapshot
        if snapshot is None:
            self.status_bar.showMessage("Todavía no hay datos del hub en este equipo: sincronizando...", 8000)
            self._cloud_sync_now()
            return
        from src.cloud.workspace import band_summaries
        from src.ui.dialogs.account_select import BandSelectorDialog

        current = self._settings.cloud_band_id or snapshot.workspace.active_band_id
        dialog = BandSelectorDialog(band_summaries(snapshot.workspace), current=current, parent=self)
        if not dialog.exec():
            return
        band_id = dialog.selected_band_id()
        if not band_id:
            return
        if self.cloud.sync_running():
            self.status_bar.showMessage("Espera a que termine la sincronización e intenta de nuevo", 8000)
            return
        user = self.cloud.user
        self._settings.cloud_band_id = band_id
        self._settings.cloud_user_id = user.id if user else None
        self._save_settings()
        self.cloud.start_import(band_id, user_initiated=True)
        self._refresh_cloud_status()

    def _cloud_choose_setlist(self):
        if not self._require_cloud_session():
            return
        band_id = self._settings.cloud_band_id
        if not band_id:
            self._cloud_choose_band()
            return
        from src.db.cloud_import import read_cloud_setlists
        from src.ui.dialogs.account_select import SetlistSelectorDialog

        try:
            setlists = read_cloud_setlists(get_db_path(), band_id)
        except Exception as e:
            self.status_bar.showMessage(f"No se pudieron leer los setlists: {e}", 8000)
            return
        snapshot = self.cloud.last_snapshot
        content = snapshot.workspace.band(band_id) if snapshot else None
        band_name = content.band.name if content else ""
        dialog = SetlistSelectorDialog(setlists, band_name=band_name,
                                       current=self._live_setlist_id, parent=self)
        if not dialog.exec():
            return
        setlist_id = dialog.selected_setlist_id()
        if not setlist_id:
            return
        if setlist_id not in self.library_view.setlist_ids():
            self._refresh_library()
        self._request_live_setlist(setlist_id, persist=True, reason="Setlist elegido")

    def _cloud_logout(self):
        if not self._require_cloud_session():
            return
        user = self.cloud.user
        who = (user.email or user.name) if user else "esta cuenta"
        answer = QMessageBox.question(
            self,
            "Cerrar sesión",
            f"¿Cerrar la sesión de {who} en este equipo?\n\n"
            "Las canciones y setlists ya descargados se quedan aquí para tocar. "
            "La sesión del hub en el navegador no se cierra.",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if answer == QMessageBox.Yes:
            self.cloud.sign_out()

    # ------------------------------------------------------------------ keyboard
    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_Space:
            # Espacio: PLAY / PAUSE (PAUSE retoma en el compás siguiente).
            if self._live_state().get("status") == "PLAYING":
                self._on_pause()
            else:
                self._on_play()
        elif event.key() == Qt.Key_R:
            self.transport.rec_btn.setChecked(not self.transport.rec_btn.isChecked())
            self.transport._on_rec()
        elif event.key() == Qt.Key_F11:
            self._toggle_fullscreen()
        else:
            super().keyPressEvent(event)


def _cloud_health(color: str) -> str:
    """Status color of format_cloud_status -> QSS property (no inline colors)."""
    from src.cloud import controller

    return {
        getattr(controller, "COLOR_ERROR", None): "bad",
        getattr(controller, "COLOR_WARN", None): "warn",
        getattr(controller, "COLOR_OK", None): "ok",
    }.get(color, "")


def _stage_follower_rows(followers, now_ns):
    """Connected phones as rows for the Escenario panel: alias, role, latency and health."""
    from src.network.link_report import link_health
    from src.ui.dialogs.musicians_panel import HEALTH_ORDER, ROLE_LABELS

    rows = []
    for f in followers or []:
        link = f.get("link") or {}
        level, _reason = link_health(f.get("link"), now_ns)
        out = link.get("output_latency_ms")
        detail = ROLE_LABELS.get(f.get("role"), str(f.get("role", "")))
        if out is not None:
            detail += f" · salida {out:.0f} ms"
        rtt = link.get("rtt_ms")
        rows.append({
            "alias": f.get("alias", ""),
            "detail": detail,
            "latency": "—" if rtt is None else f"{rtt:.0f} ms",
            "health": level,
            "_order": HEALTH_ORDER.get(level, 9),
        })
    return sorted(rows, key=lambda r: (r["_order"], str(r["alias"]).lower()))
