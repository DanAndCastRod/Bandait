"""
Bandait DAW — Ventana Principal
Layout tipo DAW profesional: transporte arriba, mixer derecha, contenido centro, navegación izquierda.
"""

import sys
import os
from PySide6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QLabel,
    QPushButton, QFrame, QSplitter, QStatusBar, QTabWidget,
    QSizePolicy, QApplication
)
from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QFont, QKeyEvent, QAction

from src.sync.clock_service import ClockService
from src.network.server import BandaitServer
from src.audio.audio_engine import AudioEngine
from src.ui.widgets.transport import TransportWidget
from src.ui.widgets.mixer import MixerWidget
from src.ui.widgets.timeline import TimelineWidget
from src.ui.views.stage_view import StageView
from src.ui.views.library_view import LibraryView
from src.ui.views.ai_view import AIView
from src.db.seed import seed_database


class MainWindow(QMainWindow):
    """Ventana principal del DAW Bandait."""

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Bandait DAW — Líder de Sesión")
        self.setMinimumSize(1280, 720)
        self.resize(1600, 900)

        # Estado
        self._bpm = 120
        self._is_playing = False
        self._current_tab = 0
        self._current_song = None

        # Seed database with sample data if empty
        try:
            seed_database()
        except Exception as e:
            print(f"[DB] Seed error (non-critical): {e}")

        # Servicios
        self.clock_service = ClockService()
        self.server = BandaitServer(clock_service=self.clock_service)
        self.audio_engine = AudioEngine(channels=2, block_size=512)

        # Conectar señales de audio
        self.audio_engine.started.connect(self._on_audio_started)
        self.audio_engine.stopped.connect(self._on_audio_stopped)
        self.audio_engine.beat.connect(self._on_audio_beat)
        self.audio_engine.levels.connect(self._on_audio_levels)

        # Timer compartido para UI (30fps)
        self._ui_timer = QTimer(self)
        self._ui_timer.timeout.connect(self._update_ui)
        self._ui_timer.start(33)

        self._setup_ui()
        self._apply_styles()
        self._setup_menu()

    def _setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)

        main_layout = QVBoxLayout(central)
        main_layout.setSpacing(0)
        main_layout.setContentsMargins(0, 0, 0, 0)

        # === BARRA DE TÍTULO PERSONALIZADA ===
        title_bar = self._create_title_bar()
        main_layout.addWidget(title_bar)

        # === TRANSPORTE ===
        self.transport = TransportWidget()
        self.transport.play_clicked.connect(self._on_play)
        self.transport.stop_clicked.connect(self._on_stop)
        self.transport.rec_clicked.connect(self._on_rec)
        self.transport.loop_clicked.connect(self._on_loop)
        self.transport.tap_tempo_clicked.connect(self._on_tap_tempo)
        self.transport.bpm_changed.connect(self._on_bpm_changed)
        main_layout.addWidget(self.transport)

        # === ÁREA PRINCIPAL: Splitter ===
        splitter = QSplitter(Qt.Horizontal)
        splitter.setHandleWidth(2)

        # --- PANEL IZQUIERDO: Navegación y Timeline ---
        left_panel = self._create_left_panel()
        splitter.addWidget(left_panel)
        splitter.setStretchFactor(0, 3)

        # --- PANEL DERECHO: Mixer ---
        self.mixer = MixerWidget()
        self.mixer.channel_mute.connect(self._on_channel_mute)
        self.mixer.channel_solo.connect(self._on_channel_solo)
        self.mixer.channel_fader.connect(self._on_channel_fader)
        self.mixer.channel_pan.connect(self._on_channel_pan)
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

        self.status_net = QLabel("● Red: Servidor activo")
        self.status_net.setStyleSheet("color: #CCFF00;")
        self.status_bar.addWidget(self.status_net)

        self.status_audio = QLabel("Audio: Listo")
        self.status_audio.setStyleSheet("color: #666666;")
        self.status_bar.addWidget(self.status_audio)

        self.status_sync = QLabel("Sync: 0ms offset")
        self.status_sync.setStyleSheet("color: #666666;")
        self.status_bar.addWidget(self.status_sync)

        self.status_followers = QLabel("Seguidores: 0")
        self.status_followers.setStyleSheet("color: #666666;")
        self.status_bar.addWidget(self.status_followers)

        self.setStatusBar(self.status_bar)

    def _create_title_bar(self) -> QFrame:
        """Crear barra de título personalizada."""
        bar = QFrame()
        bar.setObjectName("titleBar")
        bar.setFixedHeight(40)

        layout = QHBoxLayout(bar)
        layout.setSpacing(12)
        layout.setContentsMargins(16, 0, 16, 0)

        # Logo
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

        # Info de sesión
        self.session_info = QLabel("Sesión: Sin nombre")
        self.session_info.setFont(QFont("Inter", 10))
        self.session_info.setStyleSheet("color: #666666;")
        layout.addWidget(self.session_info)

        # Botón minimizar
        min_btn = QPushButton("−")
        min_btn.setFixedSize(28, 28)
        min_btn.setStyleSheet("""
            QPushButton {
                border: 1px solid #333333;
                color: #666666;
                border-radius: 4px;
                font-size: 14px;
            }
            QPushButton:hover {
                border-color: #00FFFF;
                color: #00FFFF;
            }
        """)
        min_btn.clicked.connect(self.showMinimized)
        layout.addWidget(min_btn)

        # Botón cerrar
        close_btn = QPushButton("×")
        close_btn.setFixedSize(28, 28)
        close_btn.setStyleSheet("""
            QPushButton {
                border: 1px solid #333333;
                color: #666666;
                border-radius: 4px;
                font-size: 14px;
            }
            QPushButton:hover {
                background: #FF0000;
                border-color: #FF0000;
                color: #000000;
            }
        """)
        close_btn.clicked.connect(self.close)
        layout.addWidget(close_btn)

        return bar

    def _create_left_panel(self) -> QWidget:
        """Crear panel izquierdo con tabs."""
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(0)
        layout.setContentsMargins(0, 0, 0, 0)

        # Tabs principales
        self.tabs = QTabWidget()
        self.tabs.setFont(QFont("Inter", 11))
        self.tabs.setTabPosition(QTabWidget.North)

        # Tab 1: Escenario
        self.stage_view = StageView()
        self.stage_view.panic_clicked.connect(self._on_panic)
        self.stage_view.next_song_clicked.connect(self._on_next_song)
        self.stage_view.prev_song_clicked.connect(self._on_prev_song)
        self.tabs.addTab(self.stage_view, "Escenario")

        # Tab 2: Mezcla (Timeline + controles)
        mix_widget = QWidget()
        mix_layout = QVBoxLayout(mix_widget)
        mix_layout.setSpacing(8)
        mix_layout.setContentsMargins(8, 8, 8, 8)

        # Timeline
        self.timeline = TimelineWidget()
        self.timeline.setMinimumHeight(200)
        mix_layout.addWidget(self.timeline)

        # Botones de zoom
        zoom_layout = QHBoxLayout()
        zoom_out = QPushButton("− Zoom")
        zoom_out.setStyleSheet("""
            QPushButton {
                border: 1px solid #666666;
                color: #666666;
                border-radius: 4px;
                padding: 4px 12px;
                font-size: 11px;
            }
            QPushButton:hover { border-color: #00FFFF; color: #00FFFF; }
        """)
        zoom_layout.addWidget(zoom_out)

        zoom_in = QPushButton("Zoom +")
        zoom_in.setStyleSheet("""
            QPushButton {
                border: 1px solid #666666;
                color: #666666;
                border-radius: 4px;
                padding: 4px 12px;
                font-size: 11px;
            }
            QPushButton:hover { border-color: #00FFFF; color: #00FFFF; }
        """)
        zoom_layout.addWidget(zoom_in)

        zoom_layout.addStretch()

        add_section_btn = QPushButton("+ Agregar Sección")
        add_section_btn.setObjectName("primary")
        add_section_btn.setStyleSheet("""
            QPushButton {
                border: 1px solid #00FFFF;
                color: #00FFFF;
                border-radius: 4px;
                padding: 4px 16px;
                font-size: 11px;
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
        self.library_view.setlist_selected.connect(self._on_setlist_selected)
        self.library_view.import_requested.connect(self._on_import_song)
        self.tabs.addTab(self.library_view, "Biblioteca")

        # Tab 4: IA
        self.ai_view = AIView()
        self.tabs.addTab(self.ai_view, "IA")

        layout.addWidget(self.tabs)

        # Mini timeline debajo de tabs
        mini_timeline = QFrame()
        mini_timeline.setObjectName("panel")
        mini_timeline.setMaximumHeight(60)
        mini_layout = QHBoxLayout(mini_timeline)
        mini_layout.setContentsMargins(12, 8, 12, 8)

        mini_label = QLabel("Línea de tiempo rápida — Selecciona una canción")
        mini_label.setFont(QFont("Inter", 11))
        mini_label.setStyleSheet("color: #666666;")
        mini_layout.addWidget(mini_label)

        layout.addWidget(mini_timeline)

        return panel

    def _apply_styles(self):
        """Aplicar QSS profesional OLED Noir."""
        import os
        # Buscar el archivo QSS en múltiples ubicaciones posibles
        script_dir = os.path.dirname(os.path.abspath(__file__))
        possible_paths = [
            os.path.join(script_dir, "..", "styles", "bandait_dark.qss"),      # src/ui/../styles/
            os.path.join(script_dir, "..", "..", "styles", "bandait_dark.qss"),  # src/styles/
            os.path.join(os.path.dirname(sys.argv[0]), "src", "styles", "bandait_dark.qss"),  # desde ejecutable
        ]

        qss_loaded = False
        for qss_path in possible_paths:
            qss_path = os.path.abspath(qss_path)
            if os.path.exists(qss_path):
                try:
                    with open(qss_path, "r", encoding="utf-8") as f:
                        qss_content = f.read()
                        self.setStyleSheet(qss_content)
                        print(f"[UI] QSS cargado desde: {qss_path}")
                        qss_loaded = True
                        break
                except Exception as e:
                    print(f"[UI] Error leyendo QSS {qss_path}: {e}")

        if not qss_loaded:
            print("[UI] WARNING: No se encontró archivo QSS. Usando estilos por defecto.")
            # Aplicar estilos mínimos inline como fallback
            self.setStyleSheet("""
                QMainWindow, QWidget {
                    background-color: #000000;
                    color: #F0F0F0;
                }
                QPushButton {
                    background: transparent;
                    border: 2px solid #00FFFF;
                    color: #00FFFF;
                    border-radius: 4px;
                    padding: 8px 20px;
                }
                QPushButton:hover {
                    background: #00FFFF;
                    color: #000000;
                }
            """)

    def _setup_menu(self):
        """Configurar menú de la aplicación."""
        menubar = self.menuBar()
        menubar.setStyleSheet("""
            QMenuBar {
                background: #0A0A0A;
                color: #F0F0F0;
                border-bottom: 1px solid #1E1E1E;
            }
            QMenuBar::item:selected {
                background: #141414;
                color: #00FFFF;
            }
        """)

        # Archivo
        file_menu = menubar.addMenu("&Archivo")

        new_action = QAction("&Nueva Sesión", self)
        new_action.setShortcut("Ctrl+N")
        file_menu.addAction(new_action)

        open_action = QAction("&Abrir Sesión...", self)
        open_action.setShortcut("Ctrl+O")
        file_menu.addAction(open_action)

        save_action = QAction("&Guardar", self)
        save_action.setShortcut("Ctrl+S")
        file_menu.addAction(save_action)

        file_menu.addSeparator()

        exit_action = QAction("&Salir", self)
        exit_action.setShortcut("Alt+F4")
        exit_action.triggered.connect(self.close)
        file_menu.addAction(exit_action)

        # Editar
        edit_menu = menubar.addMenu("&Editar")

        preferences_action = QAction("&Preferencias...", self)
        preferences_action.setShortcut("Ctrl+,")
        edit_menu.addAction(preferences_action)

        # Audio
        audio_menu = menubar.addMenu("&Audio")

        devices_action = QAction("&Dispositivos de Audio...", self)
        audio_menu.addAction(devices_action)

        # Ver
        view_menu = menubar.addMenu("&Ver")

        fullscreen_action = QAction("&Pantalla Completa", self)
        fullscreen_action.setShortcut("F11")
        fullscreen_action.triggered.connect(self._toggle_fullscreen)
        view_menu.addAction(fullscreen_action)

        # Ayuda
        help_menu = menubar.addMenu("A&yuda")

        about_action = QAction("&Acerca de Bandait", self)
        help_menu.addAction(about_action)

    def _toggle_fullscreen(self):
        if self.isFullScreen():
            self.showNormal()
        else:
            self.showFullScreen()

    # === AUDIO ENGINE CALLBACKS ===
    def _on_audio_started(self):
        self.status_audio.setText("Audio: Reproduciendo")
        self.status_audio.setStyleSheet("color: #CCFF00;")

    def _on_audio_stopped(self):
        self.status_audio.setText("Audio: Detenido")
        self.status_audio.setStyleSheet("color: #666666;")

    def _on_audio_beat(self, beat_num: int, bpm: float):
        """Llamado desde el audio engine en cada beat."""
        self.transport.set_beat(beat_num)
        self.stage_view.set_beat(beat_num)

    # === AUDIO LEVELS (from real audio callback) ===
    def _on_audio_levels(self, levels: list):
        """Actualizar VU meters con datos reales del audio callback."""
        for i, level in enumerate(levels[:4]):
            self.mixer.set_channel_level(i, level)
        # Master level = average of all channels
        master = sum(levels[:4]) / len(levels[:4]) if levels else 0.0
        self.mixer.set_master_level(master)

    def _update_timeline_position(self):
        """Actualizar posición del playhead en el timeline."""
        # El tiempo se calcula desde el inicio del playback
        # Usamos el tiempo del transporte como fuente de verdad
        seconds = self.transport._seconds
        self.timeline.set_position(seconds)

    # === UI UPDATE (30fps) ===
    def _update_ui(self):
        """Actualizar UI a 30fps — tiempo, posición, etc."""
        if self._is_playing:
            # Actualizar posición del timeline
            self._update_timeline_position()

    # === TRANSPORT CONTROLS ===
    def _on_play(self):
        """Iniciar reproducción."""
        self._is_playing = True
        try:
            self.audio_engine.start()
        except Exception as e:
            print(f"[AUDIO] No se pudo iniciar audio: {e}")
            # Modo simulación: seguir sin audio
        self.timeline.start_playback()
        self.status_audio.setText("Audio: Reproduciendo")
        self.status_audio.setStyleSheet("color: #CCFF00;")

    def _on_stop(self):
        """Detener reproducción."""
        self._is_playing = False
        try:
            self.audio_engine.stop()
        except Exception as e:
            print(f"[AUDIO] No se pudo detener audio: {e}")
        self.timeline.stop_playback()
        self.timeline.set_position(0.0)
        self.transport.set_time(0.0)
        self.status_audio.setText("Audio: Detenido")
        self.status_audio.setStyleSheet("color: #666666;")

    def _on_rec(self):
        """Toggle grabación con nombre descriptivo y carpeta organizada."""
        import time
        import os

        is_rec = self.transport.rec_btn.isChecked()
        if is_rec:
            # Generar nombre de sesión: fecha_hora + canción actual
            timestamp = time.strftime("%Y%m%d_%H%M%S")
            song_name = ""
            if self._current_song:
                song_name = self._current_song.get("title", "").replace(" ", "_")
            session_name = f"{timestamp}_{song_name}" if song_name else f"{timestamp}_ensayo"

            # Carpeta base: Documents/Bandait/Recordings/
            base_dir = os.path.join(os.path.expanduser("~"), "Documents", "Bandait", "Recordings")
            os.makedirs(base_dir, exist_ok=True)

            try:
                folder = self.audio_engine.start_recording(session_name, base_dir=base_dir)
                self._last_recording_folder = folder
                print(f"[REC] Grabando en: {folder}")
                self.status_audio.setText(f"● GRABANDO — {session_name}")
                self.status_audio.setStyleSheet("color: #FF0000; font-weight: bold;")
                self.status_bar.showMessage(f"Grabación iniciada: {os.path.basename(folder)}", 5000)
            except Exception as e:
                print(f"[AUDIO] No se pudo iniciar grabación: {e}")
                self.transport.rec_btn.setChecked(False)
                self.status_audio.setText("Audio: Error de grabación")
                self.status_audio.setStyleSheet("color: #FFAA00;")
        else:
            try:
                self.audio_engine.stop_recording()
                self.status_audio.setText("Audio: Listo")
                self.status_audio.setStyleSheet("color: #666666;")
                if hasattr(self, '_last_recording_folder'):
                    self.status_bar.showMessage(
                        f"Grabación guardada en: {self._last_recording_folder}", 10000
                    )
            except Exception as e:
                print(f"[AUDIO] No se pudo detener grabación: {e}")

    def _on_loop(self, enabled: bool):
        pass  # TODO: implementar loop

    def _on_tap_tempo(self):
        pass  # Ya manejado en TransportWidget

    def _on_bpm_changed(self, bpm: int):
        self._bpm = bpm
        self.audio_engine.set_bpm(float(bpm))
        self.timeline.set_bpm(bpm)
        self.stage_view.set_bpm(bpm)

    # === MIXER CONTROLS ===
    def _on_channel_mute(self, channel_id: int, muted: bool):
        self.audio_engine.mixer.set_track_mute(channel_id, muted)

    def _on_channel_solo(self, channel_id: int, soloed: bool):
        self.audio_engine.mixer.set_track_solo(channel_id, soloed)

    def _on_channel_fader(self, channel_id: int, db: float):
        self.audio_engine.mixer.set_track_volume(channel_id, db)

    def _on_channel_pan(self, channel_id: int, pan: float):
        # TODO: implementar pan en mixer
        pass

    def _on_master_fader(self, db: float):
        self.audio_engine.mixer.set_master_volume(db)

    # === STAGE CONTROLS ===
    def _on_panic(self):
        self._on_stop()
        # TODO: detener servidor, desconectar seguidores

    def _on_next_song(self):
        self.library_view._on_next_song()

    def _on_prev_song(self):
        self.library_view._on_prev_song()

    # === LIBRARY / SONG SELECTION ===
    def _on_song_selected(self, song_id: int):
        """Cargar canción en timeline y stage."""
        print(f"[MAIN] Canción seleccionada: {song_id}")
        # Obtener datos de la canción desde la library
        song_data = self.library_view.get_song_data(song_id)
        if song_data:
            self._load_song_to_timeline(song_data)
            self._load_song_to_stage(song_data)
            self._current_song = song_data

    def _load_song_to_timeline(self, song_data: dict):
        """Cargar secciones de canción en timeline."""
        self.timeline.clear_sections()
        sections = song_data.get("sections", [])
        beat_pos = 0
        for section in sections:
            label = section.get("label", "Sección")
            bars = section.get("bars", 8)
            beats = bars * 4  # 4/4 por defecto
            self.timeline.add_section(label, beat_pos, beats)
            beat_pos += beats

        # Si no hay secciones, crear una genérica
        if not sections:
            self.timeline.add_section("Completa", 0, 64)

        self.timeline.set_duration(song_data.get("duration_seconds", 180))
        self.timeline.set_bpm(song_data.get("bpm", 120))

    def _load_song_to_stage(self, song_data: dict):
        """Cargar canción en vista de escenario con letras reales."""
        lyrics = song_data.get("lyrics", [])

        # Extraer letras del lyrics_text si no hay lyrics parseadas
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
        self.stage_view.set_bpm(song_data.get("bpm", 120))

    def _on_setlist_selected(self, setlist_id: int):
        print(f"[MAIN] Setlist seleccionado: {setlist_id}")

    def _on_import_song(self, file_path: str):
        print(f"[MAIN] Importando: {file_path}")
        # TODO: parsear LRC/ChordPro y guardar en DB

    def _on_add_section(self):
        from PySide6.QtWidgets import QInputDialog
        label, ok = QInputDialog.getText(self, "Agregar Sección", "Nombre de la sección:")
        if ok and label:
            self.timeline.add_section(label, 0, 16)

    # === KEYBOARD SHORTCUTS ===
    def keyPressEvent(self, event: QKeyEvent):
        if event.key() == Qt.Key_Space:
            # Toggle play/stop
            if self._is_playing:
                self.transport.play_btn.setChecked(False)
                self._on_stop()
            else:
                self.transport.play_btn.setChecked(True)
                self._on_play()
        elif event.key() == Qt.Key_R:
            self.transport.rec_btn.setChecked(not self.transport.rec_btn.isChecked())
            self._on_rec()
        elif event.key() == Qt.Key_F11:
            self._toggle_fullscreen()
        else:
            super().keyPressEvent(event)

    def closeEvent(self, event):
        """Limpiar al cerrar."""
        try:
            self.audio_engine.stop()
        except Exception:
            pass
        try:
            self.server.stop()
        except Exception:
            pass
        event.accept()
