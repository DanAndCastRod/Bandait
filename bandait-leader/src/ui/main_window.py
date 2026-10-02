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
    QPushButton, QFrame, QSplitter, QStatusBar, QTabWidget, QMessageBox,
)
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont, QKeyEvent, QAction

from src.audio.audio_engine import AudioEngine, AudioUnavailable
from src.cloud.controller import CloudController
from src.core.leader_config import load_settings, save_settings
from src.core.paths import get_db_path, recordings_dir
from src.db.seed import count_demo_rows, load_demo_data, remove_demo_data
from src.network.server import BandaitServer
from src.sync.clock_service import ClockService
from src.sync.leader_clock import CLOCK_NAME, leader_clock_resolution_ns
from src.ui.views.ai_view import AIView
from src.ui.dialogs.account_select import songs_label
from src.ui.views.library_view import LibraryView
from src.ui.views.stage_view import StageView
from src.ui.widgets.mixer import MixerWidget
from src.ui.widgets.timeline import TimelineWidget
from src.ui.widgets.transport import TransportWidget

logger = logging.getLogger(__name__)

APP_VERSION = "2.1.1"

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

        self._setup_ui()
        self._apply_styles()
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
            self._set_audio_status(f"Audio: no disponible ({e}). Los seguidores siguen sincronizados.", "#FFAA00")
        except Exception as e:  # defensive: PortAudio raises many types
            self._set_audio_status(f"Audio: error al abrir el dispositivo ({e})", "#FF0000")
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

        main_layout = QVBoxLayout(central)
        main_layout.setSpacing(0)
        main_layout.setContentsMargins(0, 0, 0, 0)

        title_bar = self._create_title_bar()
        main_layout.addWidget(title_bar)

        # === TRANSPORTE ===
        self.transport = TransportWidget()
        self.transport.play_clicked.connect(self._on_play)
        self.transport.pause_clicked.connect(self._on_pause)
        self.transport.stop_clicked.connect(self._on_stop)
        self.transport.rec_clicked.connect(self._on_rec)
        self.transport.bpm_changed.connect(self._on_bpm_changed)
        self.transport.tempo_nudge_clicked.connect(self._on_tempo_nudge)
        main_layout.addWidget(self.transport)

        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(2)

        left_panel = self._create_left_panel()
        splitter.addWidget(left_panel)
        splitter.setStretchFactor(0, 3)

        # --- PANEL DERECHO: Mixer ---
        self.mixer = MixerWidget()
        self.mixer.channel_mute.connect(self._on_channel_mute)
        self.mixer.channel_solo.connect(self._on_channel_solo)
        self.mixer.channel_fader.connect(self._on_channel_fader)
        self.mixer.channel_routing.connect(self._on_channel_routing)
        self.mixer.master_fader.connect(self._on_master_fader)

        mixer_container = QFrame()
        mixer_container.setObjectName("panel")
        mixer_layout = QVBoxLayout(mixer_container)
        mixer_layout.setSpacing(0)
        mixer_layout.setContentsMargins(0, 0, 0, 0)

        mixer_title = QLabel("MEZCLADOR")
        mixer_title.setFont(QFont("Inter", 10, QFont.Bold))
        mixer_title.setStyleSheet("color: #666666; padding: 8px 12px;")
        mixer_layout.addWidget(mixer_title)

        mixer_layout.addWidget(self.mixer)
        splitter.addWidget(mixer_container)
        splitter.setStretchFactor(1, 1)

        main_layout.addWidget(splitter, 1)

        # === BARRA DE ESTADO ===
        self.status_bar = QStatusBar()
        self.status_bar.setFont(QFont("Inter", 9))

        self.status_net = QLabel("Red: iniciando...")
        self.status_net.setStyleSheet("color: #666666;")
        self.status_bar.addWidget(self.status_net)

        self.status_audio = QLabel("Audio: iniciando...")
        self.status_audio.setStyleSheet("color: #666666;")
        self.status_bar.addWidget(self.status_audio)

        res_us = leader_clock_resolution_ns() / 1e3
        self.status_sync = QLabel(f"Reloj: {CLOCK_NAME} ({res_us:.3g} us)")
        self.status_sync.setStyleSheet("color: #666666;")
        self.status_sync.setToolTip("Base de tiempo del líder para anchor_ns y sync_request")
        self.status_bar.addWidget(self.status_sync)

        self.status_followers = QLabel("Seguidores: 0")
        self.status_followers.setStyleSheet("color: #666666;")
        self.status_bar.addWidget(self.status_followers)

        self.status_cloud = QLabel("NUBE: sin sesión")
        self.status_cloud.setStyleSheet("color: #666666;")
        self.status_bar.addWidget(self.status_cloud)

        # Persistent: QStatusBar.showMessage() hides normal widgets, not permanent ones.
        self.status_setlist = QLabel("")
        self.status_setlist.setStyleSheet(
            "color: #000000; background: #FFAA00; font-weight: bold; padding: 1px 8px; border-radius: 3px;"
        )
        self.status_setlist.hide()
        self.status_bar.addPermanentWidget(self.status_setlist)

        self.connect_btn = QPushButton("Conectar músicos")
        self.connect_btn.setToolTip("QR para que los teléfonos abran la app desde este líder")
        self.connect_btn.setStyleSheet(
            "QPushButton { border: 1px solid #00FFFF; color: #00FFFF; border-radius: 4px;"
            " padding: 2px 10px; font-size: 11px; }"
            "QPushButton:hover { background: #00FFFF; color: #000000; }"
        )
        self.connect_btn.clicked.connect(self._open_connect_musicians)
        self.status_bar.addPermanentWidget(self.connect_btn)

        self.setStatusBar(self.status_bar)

    def _create_title_bar(self) -> QFrame:
        bar = QFrame()
        bar.setObjectName("titleBar")
        bar.setFixedHeight(40)

        layout = QHBoxLayout(bar)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 0, 16, 0)

        logo = QLabel("◈")
        logo.setFont(QFont("JetBrains Mono", 16, QFont.Bold))
        logo.setStyleSheet("color: #00FFFF;")
        layout.addWidget(logo)

        title = QLabel("BANDAIT DAW")
        title.setFont(QFont("Inter", 13, QFont.Bold))
        title.setStyleSheet("color: #F0F0F0;")
        layout.addWidget(title)

        subtitle = QLabel("— Líder de Sesión")
        subtitle.setObjectName("titleBarSubtitle")
        layout.addWidget(subtitle)

        layout.addStretch()

        self.session_info = QLabel(f"Sesión: {self.server.session_id}")
        self.session_info.setFont(QFont("Inter", 10))
        self.session_info.setStyleSheet("color: #666666;")
        layout.addWidget(self.session_info)

        min_btn = QPushButton("−")
        min_btn.setFixedSize(28, 28)
        min_btn.setStyleSheet("""
            QPushButton { border: 1px solid #333333; color: #666666; border-radius: 4px; font-size: 14px; }
            QPushButton:hover { border-color: #00FFFF; color: #00FFFF; }
        """)
        min_btn.clicked.connect(self.showMinimized)
        layout.addWidget(min_btn)

        close_btn = QPushButton("×")
        close_btn.setFixedSize(28, 28)
        close_btn.setStyleSheet("""
            QPushButton { border: 1px solid #333333; color: #666666; border-radius: 4px; font-size: 14px; }
            QPushButton:hover { background: #FF0000; border-color: #FF0000; color: #000000; }
        """)
        close_btn.clicked.connect(self.close)
        layout.addWidget(close_btn)

        return bar

    def _create_left_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(0)
        layout.setContentsMargins(0, 0, 0, 0)

        self.tabs = QTabWidget()
        self.tabs.setFont(QFont("Inter", 11))
        self.tabs.setTabPosition(QTabWidget.North)

        # Tab 1: Escenario
        self.stage_view = StageView()
        self.stage_view.panic_clicked.connect(self._on_panic)
        self.stage_view.next_song_clicked.connect(self._on_next_song)
        self.stage_view.prev_song_clicked.connect(self._on_prev_song)
        self.stage_view.fullscreen_requested.connect(self._toggle_fullscreen)
        self.tabs.addTab(self.stage_view, "Escenario")

        # Tab 2: Mezcla (Timeline + controles)
        mix_widget = QWidget()
        mix_layout = QVBoxLayout(mix_widget)
        mix_layout.setSpacing(8)
        mix_layout.setContentsMargins(8, 8, 8, 8)

        self.timeline = TimelineWidget()
        self.timeline.setMinimumHeight(200)
        mix_layout.addWidget(self.timeline)

        small_btn = """
            QPushButton {
                border: 1px solid #666666; color: #666666; border-radius: 4px;
                padding: 4px 12px; font-size: 11px;
            }
            QPushButton:hover { border-color: #00FFFF; color: #00FFFF; }
        """
        zoom_layout = QHBoxLayout()
        zoom_out = QPushButton("− Zoom")
        zoom_out.setStyleSheet(small_btn)
        zoom_out.clicked.connect(self.timeline.zoom_out)
        zoom_layout.addWidget(zoom_out)

        zoom_in = QPushButton("Zoom +")
        zoom_in.setStyleSheet(small_btn)
        zoom_in.clicked.connect(self.timeline.zoom_in)
        zoom_layout.addWidget(zoom_in)

        zoom_layout.addStretch()

        add_section_btn = QPushButton("+ Agregar Sección")
        add_section_btn.setObjectName("primary")
        add_section_btn.setStyleSheet("""
            QPushButton {
                border: 1px solid #00FFFF; color: #00FFFF; border-radius: 4px;
                padding: 4px 16px; font-size: 11px;
            }
            QPushButton:hover { background: #00FFFF; color: #000000; }
        """)
        add_section_btn.clicked.connect(self._on_add_section)
        zoom_layout.addWidget(add_section_btn)

        mix_layout.addLayout(zoom_layout)
        self.tabs.addTab(mix_widget, "Mezcla")

        # Tab 3: Biblioteca
        self.library_view = LibraryView()
        self.library_view.song_selected.connect(self._on_song_selected)
        self.library_view.setlist_activated.connect(self._activate_setlist)
        self.library_view.demo_remove_requested.connect(self._remove_demo_data)
        self.tabs.addTab(self.library_view, "Biblioteca")

        # Tab 4: IA
        self.ai_view = AIView()
        self.tabs.addTab(self.ai_view, "IA")

        layout.addWidget(self.tabs)

        mini_timeline = QFrame()
        mini_timeline.setObjectName("panel")
        mini_timeline.setMaximumHeight(60)
        mini_layout = QHBoxLayout(mini_timeline)
        mini_layout.setContentsMargins(12, 8, 12, 8)

        self.mini_label = QLabel("Setlist en vivo: ninguno")
        self.mini_label.setFont(QFont("Inter", 11))
        self.mini_label.setStyleSheet("color: #666666;")
        mini_layout.addWidget(self.mini_label)

        layout.addWidget(mini_timeline)
        return panel

    def _apply_styles(self):
        """Aplicar QSS profesional OLED Noir."""
        script_dir = os.path.dirname(os.path.abspath(__file__))
        possible_paths = [
            os.path.join(script_dir, "..", "styles", "bandait_dark.qss"),
            os.path.join(script_dir, "..", "..", "styles", "bandait_dark.qss"),
            os.path.join(os.path.dirname(sys.argv[0]), "src", "styles", "bandait_dark.qss"),
        ]
        for qss_path in possible_paths:
            qss_path = os.path.abspath(qss_path)
            if os.path.exists(qss_path):
                try:
                    with open(qss_path, "r", encoding="utf-8") as f:
                        self.setStyleSheet(f.read())
                    return
                except Exception as e:
                    print(f"[UI] Error leyendo QSS {qss_path}: {e}")
        print("[UI] WARNING: No se encontró archivo QSS. Usando estilos por defecto.")
        self.setStyleSheet("""
            QMainWindow, QWidget { background-color: #000000; color: #F0F0F0; }
            QPushButton {
                background: transparent; border: 2px solid #00FFFF; color: #00FFFF;
                border-radius: 4px; padding: 8px 20px;
            }
            QPushButton:hover { background: #00FFFF; color: #000000; }
        """)

    def _setup_menu(self):
        menubar = self.menuBar()
        menubar.setStyleSheet("""
            QMenuBar { background: #0A0A0A; color: #F0F0F0; border-bottom: 1px solid #1E1E1E; }
            QMenuBar::item:selected { background: #141414; color: #00FFFF; }
            QMenu::item:disabled { color: #555555; }
        """)

        def unavailable(menu, text):
            action = QAction(f"{text} (no disponible)", self)
            action.setEnabled(False)
            action.setToolTip("No disponible en esta versión")
            menu.addAction(action)
            return action

        file_menu = menubar.addMenu("&Archivo")
        self.action_new = unavailable(file_menu, "Nueva Sesión")
        self.action_open = unavailable(file_menu, "Abrir Sesión...")
        self.action_save = unavailable(file_menu, "Guardar")
        file_menu.addSeparator()
        exit_action = QAction("&Salir", self)
        exit_action.setShortcut("Alt+F4")
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)

        edit_menu = menubar.addMenu("&Editar")
        self.action_preferences = unavailable(edit_menu, "Preferencias...")

        audio_menu = menubar.addMenu("&Audio")
        self.action_audio_devices = QAction("&Dispositivos de Audio...", self)
        self.action_audio_devices.triggered.connect(self._open_audio_devices)
        audio_menu.addAction(self.action_audio_devices)

        net_menu = menubar.addMenu("&Red")
        self.action_retry_server = QAction("&Reintentar servidor", self)
        self.action_retry_server.triggered.connect(self._restart_server)
        net_menu.addAction(self.action_retry_server)
        self.action_connect = QAction("&Conectar músicos...", self)
        self.action_connect.triggered.connect(self._open_connect_musicians)
        net_menu.addAction(self.action_connect)

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
                self._set_audio_status(f"Audio: no se pudo abrir el dispositivo ({e})", "#FF0000")
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

    def _save_settings(self):
        try:
            save_settings(self._settings)
        except Exception as e:
            self.status_bar.showMessage(f"No se pudo guardar la configuración: {e}", 8000)

    # ------------------------------------------------------------------ status callbacks
    def _set_audio_status(self, text: str, color: str):
        self.status_audio.setText(text)
        self.status_audio.setStyleSheet(f"color: {color};")

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
        self._set_audio_status(text, "#CCFF00")

    def _on_audio_stopped(self):
        self._set_audio_status("Audio: detenido", "#666666")

    def _on_server_status(self, status: str, message: str):
        colors = {"running": "#CCFF00", "error": "#FF0000", "starting": "#FFAA00", "stopped": "#666666"}
        self.status_net.setText(f"Red: {message}")
        self.status_net.setStyleSheet(f"color: {colors.get(status, '#666666')};")
        ok = status == "running"
        self.stage_view.set_network_status(ok)
        self.transport.set_network_status(ok, "Red OK" if ok else "Red caída")

    def _on_followers_changed(self, followers):
        followers = followers or []
        self.status_followers.setText(f"Seguidores: {len(followers)}")
        self.status_followers.setToolTip(
            "\n".join(f"{f.get('alias')} ({f.get('role')})" for f in followers) or "Nadie conectado"
        )

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
        last = state.get("last_command") or {}
        if last.get("type") == "PANIC":
            self.status_bar.showMessage(f"PANIC desde {last.get('origin')}: transporte detenido", 8000)
        if status == "IDLE" and self._pending_live_setlist:
            # Una sincronización terminó mientras sonaba: se aplica al detener.
            QTimer.singleShot(0, self._apply_pending_live_reload)

    def _show_live_song(self, song_id, state: dict):
        if not song_id:
            self.stage_view.set_song(title="Sin canción")
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
            return
        title = next((e.get("title") for e in state.get("setlist", []) if e.get("song_id") == song_id), song_id)
        self.stage_view.set_song(title=title)

    def _on_clock_beat(self, bar: int, beat: int, bpm: float):
        self.transport.set_beat(beat)
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
                self._set_audio_status(f"GRABANDO — {session_name}", "#FF0000")
                self.status_bar.showMessage(f"Grabación iniciada: {os.path.basename(folder)}", 5000)
            except Exception as e:
                self.transport.set_recording_state(False)
                self._set_audio_status(f"Audio: no se pudo grabar ({e})", "#FFAA00")
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
        """Vista previa en el timeline. No mueve el transporte de la banda."""
        song_data = self.library_view.get_song_data(song_id)
        if song_data:
            self._load_song_to_timeline(song_data)

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

    def _on_add_section(self):
        from PySide6.QtWidgets import QInputDialog
        label, ok = QInputDialog.getText(self, "Agregar Sección", "Nombre de la sección:")
        if ok and label:
            self.timeline.add_section(label, 0, 16)

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
        self.status_cloud.setStyleSheet(f"color: {color};")
        self.status_cloud.setToolTip(tooltip)

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
            session = getattr(view, "_db_session", None)
            if session is not None:
                session.expire_all()
            view._load_songs_from_db()
            view._load_setlists_from_db()
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
