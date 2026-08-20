"""
Bandait DAW — Asistente de IA
Integración con Google Cloud para análisis de ensayos y sugerencias.
"""

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)


class AIWorker(QThread):
    """Worker thread para llamadas a IA sin bloquear UI."""

    response_ready = Signal(str)
    error = Signal(str)

    def __init__(self, prompt: str, mode: str = "chat", songs_data: list = None):
        super().__init__()
        self.prompt = prompt
        self.mode = mode
        self.songs_data = songs_data or []
        self._assistant = None

    def run(self):
        try:
            # Intentar usar AIAssistant real
            try:
                from src.ai.ai_assistant import AIAssistant
                self._assistant = AIAssistant()
            except Exception as e:
                print(f"[AI] Usando modo offline: {e}")
                self._assistant = None

            if self._assistant and not getattr(self._assistant, '_offline', True):
                # Modo online con Google Cloud
                if self.mode == "analyze":
                    response = self._assistant.analyze_rehearsal(
                        rehearsal_notes=self.prompt,
                        bpm_data=[120, 118, 121, 119, 120],  # TODO: real data
                        song_titles=[s.get("title", "?") for s in self.songs_data[:5]],
                    )
                elif self.mode == "setlist":
                    response = self._assistant.suggest_setlist(
                        songs=self.songs_data,
                        target_duration_minutes=45,
                    )
                else:
                    response = self._assistant.chat(self.prompt)

                self.response_ready.emit(f"🤖 **Asistente Bandait**:\n\n{response}")
            else:
                # Modo offline — respuestas locales inteligentes
                self._offline_response()

        except Exception as e:
            self.error.emit(str(e))

    def _offline_response(self):
        """Respuestas locales cuando no hay conexión a Google Cloud."""
        import time
        time.sleep(0.5)  # Simular procesamiento

        if self.mode == "analyze":
            response = (
                "📊 **Análisis de Ensayo (Modo Offline)**\n\n"
                "Basado en los datos locales disponibles:\n\n"
                "✅ Tempo general estable\n"
                "💡 Consejo: Practicar transiciones entre secciones\n"
                "📝 Nota: Conecta una API key de Google Cloud para análisis avanzado"
            )
        elif self.mode == "setlist":
            if self.songs_data:
                songs_list = "\n".join(f"{i+1}. {s.get('title', '?')} ({s.get('bpm', 120)} BPM)"
                                        for i, s in enumerate(self.songs_data[:8]))
                response = (
                    f"🎵 **Setlist Sugerido (Modo Offline)**\n\n"
                    f"Canciones disponibles:\n{songs_list}\n\n"
                    f"💡 Consejo: Alternar tempos para mantener energía\n"
                    f"📝 Conecta Google Cloud para sugerencias inteligentes"
                )
            else:
                response = (
                    "🎵 **Setlist (Modo Offline)**\n\n"
                    "No hay canciones en la biblioteca.\n"
                    "Importa canciones primero para generar setlists."
                )
        else:
            response = (
                f"🤖 **Asistente Bandait (Modo Offline)**\n\n"
                f"Entiendo: *{self.prompt[:60]}...*\n\n"
                f"Como asistente musical, te sugiero:\n"
                f"1. Revisar el tempo actual con el metrónomo\n"
                f"2. Practicar secciones difíciles a velocidad reducida\n"
                f"3. Grabar el ensayo para revisión posterior\n\n"
                f"📝 Para análisis avanzado, configura tu API key de Google Cloud:\n"
                f"   `set BANDAIT_GOOGLE_API_KEY=tu-clave`"
            )

        self.response_ready.emit(response)


class AIView(QWidget):
    """Vista del asistente de inteligencia artificial."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._setup_ui()
        self._chat_history = []

    def _setup_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)
        layout.setContentsMargins(16, 16, 16, 16)

        # === HEADER ===
        header = QHBoxLayout()

        title = QLabel("🤖 ASISTENTE DE ENSAYOS")
        title.setFont(QFont("Inter", 18, QFont.Bold))
        title.setStyleSheet("color: #FF00FF;")
        header.addWidget(title)

        header.addStretch()

        # Selector de modo
        self.mode_combo = QComboBox()
        self.mode_combo.addItems([
            "💬 Chat General",
            "📊 Análisis de Ensayo",
            "🎵 Sugerir Setlist",
            "📝 Transcribir Notas"
        ])
        self.mode_combo.setMinimumWidth(200)
        header.addWidget(self.mode_combo)

        layout.addLayout(header)

        # === ÁREA DE CHAT ===
        chat_frame = QFrame()
        chat_frame.setObjectName("panel")
        chat_layout = QVBoxLayout(chat_frame)
        chat_layout.setSpacing(8)
        chat_layout.setContentsMargins(12, 12, 12, 12)

        # Scroll area para mensajes
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setStyleSheet("background: transparent; border: none;")

        self.messages_widget = QWidget()
        self.messages_layout = QVBoxLayout(self.messages_widget)
        self.messages_layout.setSpacing(12)
        self.messages_layout.setAlignment(Qt.AlignTop)
        self.messages_layout.addStretch()

        scroll.setWidget(self.messages_widget)
        chat_layout.addWidget(scroll)

        # Input de mensaje
        input_layout = QHBoxLayout()

        self.message_input = QLineEdit()
        self.message_input.setPlaceholderText("Escribe tu pregunta o solicitud...")
        self.message_input.setFont(QFont("Inter", 12))
        self.message_input.returnPressed.connect(self._send_message)
        input_layout.addWidget(self.message_input)

        send_btn = QPushButton("➤ Enviar")
        send_btn.setObjectName("primary")
        send_btn.setMinimumWidth(100)
        send_btn.clicked.connect(self._send_message)
        input_layout.addWidget(send_btn)

        chat_layout.addLayout(input_layout)
        layout.addWidget(chat_frame)

        # === ACCIONES RÁPIDAS ===
        actions_frame = QFrame()
        actions_frame.setObjectName("panel")
        actions_layout = QHBoxLayout(actions_frame)
        actions_layout.setSpacing(8)

        quick_actions = [
            ("📊 Analizar último ensayo", "analyze"),
            ("🎵 Sugerir setlist", "setlist"),
            ("📝 Crear notas de ensayo", "notes"),
            ("🎚 Revisar tempo", "tempo"),
        ]

        for label, mode in quick_actions:
            btn = QPushButton(label)
            btn.setStyleSheet("""
                QPushButton {
                    border: 1px solid #FF00FF;
                    color: #FF00FF;
                    border-radius: 4px;
                    padding: 8px 16px;
                    font-size: 11px;
                }
                QPushButton:hover {
                    background: rgba(255, 0, 255, 30);
                }
            """)
            btn.clicked.connect(lambda checked, m=mode: self._quick_action(m))
            actions_layout.addWidget(btn)

        layout.addWidget(actions_frame)

        # === ESTADO ===
        self.status_label = QLabel("🟢 Listo - Conectado a Google Cloud")
        self.status_label.setFont(QFont("Inter", 10))
        self.status_label.setStyleSheet("color: #666666;")
        layout.addWidget(self.status_label)

        # Mensaje de bienvenida
        self._add_message(
            "🤖 **Asistente Bandait**\n\n"
            "¡Hola! Soy tu asistente musical. Puedo ayudarte con:\n"
            "• Analizar grabaciones de ensayo\n"
            "• Sugerir setlists para eventos\n"
            "• Revisar tempo y sincronización\n"
            "• Transcribir notas de voz\n\n"
            "¿Qué necesitas hoy?",
            is_user=False
        )

    def _add_message(self, text: str, is_user: bool = False):
        """Agregar mensaje al chat."""
        msg_frame = QFrame()
        msg_frame.setObjectName("panel")
        msg_layout = QVBoxLayout(msg_frame)
        msg_layout.setContentsMargins(12, 8, 12, 8)

        label = QLabel(text)
        label.setWordWrap(True)
        label.setFont(QFont("Inter", 11))
        label.setTextFormat(Qt.RichText)

        if is_user:
            msg_frame.setStyleSheet("""
                QFrame {
                    background: #141414;
                    border: 1px solid #1E1E1E;
                    border-radius: 8px;
                    border-left: 3px solid #00FFFF;
                }
            """)
            label.setStyleSheet("color: #F0F0F0;")
        else:
            msg_frame.setStyleSheet("""
                QFrame {
                    background: #0A0A0A;
                    border: 1px solid #1E1E1E;
                    border-radius: 8px;
                    border-left: 3px solid #FF00FF;
                }
            """)
            label.setStyleSheet("color: #F0F0F0;")

        msg_layout.addWidget(label)

        # Insertar antes del stretch
        self.messages_layout.insertWidget(
            self.messages_layout.count() - 1, msg_frame
        )

    def _send_message(self):
        text = self.message_input.text().strip()
        if not text:
            return

        self._add_message(f"👤 **Tú**: {text}", is_user=True)
        self.message_input.clear()

        # Determinar modo
        mode = "chat"
        current_mode = self.mode_combo.currentIndex()
        if current_mode == 1:
            mode = "analyze"
        elif current_mode == 2:
            mode = "setlist"

        self.status_label.setText("🟡 Pensando...")
        self.status_label.setStyleSheet("color: #FFAA00;")

        # Obtener canciones disponibles para contexto
        songs_data = []
        try:
            import os

            from src.db.models import Song, init_db
            db_path = os.path.join(os.path.expanduser("~"), "Documents", "Bandait", "bandait.db")
            Session = init_db(db_path)
            session = Session()
            songs = session.query(Song).limit(20).all()
            songs_data = [s.to_dict() for s in songs]
            session.close()
        except Exception as e:
            print(f"[AI] No se pudieron cargar canciones: {e}")

        # Llamar a IA en thread
        self.worker = AIWorker(text, mode, songs_data)
        self.worker.response_ready.connect(self._on_response)
        self.worker.error.connect(self._on_error)
        self.worker.start()

    def _on_response(self, response: str):
        self._add_message(response, is_user=False)
        self.status_label.setText("🟢 Listo")
        self.status_label.setStyleSheet("color: #666666;")

    def _on_error(self, error: str):
        self._add_message(
            f"❌ **Error**: {error}\n\n"
            f"Verifica tu conexión a internet y la configuración de la API key.",
            is_user=False
        )
        self.status_label.setText("🔴 Error de conexión")
        self.status_label.setStyleSheet("color: #FF0000;")

    def _quick_action(self, mode: str):
        prompts = {
            "analyze": "Analiza nuestro último ensayo",
            "setlist": "Sugiere un setlist para nuestro próximo evento",
            "notes": "Crea notas del ensayo de hoy",
            "tempo": "Revisa si nuestro tempo es estable",
        }
        self.message_input.setText(prompts.get(mode, ""))
        self._send_message()
