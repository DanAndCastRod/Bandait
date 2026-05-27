"""
Bandait DAW — Asistente de IA
Integración con Google Cloud para análisis de ensayos y sugerencias.
"""

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QTextEdit, QLineEdit, QScrollArea, QFrame, QMessageBox,
    QComboBox, QProgressBar
)
from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtGui import QFont, QColor


class AIWorker(QThread):
    """Worker thread para llamadas a IA sin bloquear UI."""

    response_ready = Signal(str)
    error = Signal(str)

    def __init__(self, prompt: str, mode: str = "chat"):
        super().__init__()
        self.prompt = prompt
        self.mode = mode

    def run(self):
        try:
            # Simulación de respuesta de IA
            # En producción: import google.generativeai as genai
            import time
            time.sleep(1.5)

            responses = {
                "chat": f"🤖 **Asistente Bandait**: Entiendo que preguntas sobre '{self.prompt[:50]}...'. "
                        f"\n\nComo asistente musical, te sugiero:\n"
                        f"\n1. Revisar el tempo actual de {120} BPM\n"
                        f"2. Practicar con metrónomo a velocidad reducida\n"
                        f"3. Grabar el ensayo para análisis posterior",
                "analyze": "📊 **Análisis del último ensayo**:\n\n"
                          "✅ Tempo estable en 90% de la canción\n"
                          "⚠️ Desaceleración detectada en el puente (-5 BPM)\n"
                          "💡 Sugerencia: Practicar transición Verso→Coro con click",
                "setlist": "🎵 **Setlist sugerido para evento de 45 min**:\n\n"
                          "1. Intro (0:45) - Calentamiento\n"
                          "2. Medianoche en Pereira (4:32)\n"
                          "3. Volver a Verte (3:45)\n"
                          "4. Cover: Smells Like (4:18)\n"
                          "5. [DESCANSO - 2 min]\n"
                          "6. Ensayo #1 (5:12) - Cierre energético",
            }

            response = responses.get(self.mode, responses["chat"])
            self.response_ready.emit(response)
        except Exception as e:
            self.error.emit(str(e))


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

        # Llamar a IA en thread
        self.worker = AIWorker(text, mode)
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
