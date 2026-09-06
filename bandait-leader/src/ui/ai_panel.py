"""AI Assistant panel — chat interface and analysis results."""

from typing import Optional, List

from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QTextEdit,
    QLineEdit,
    QPushButton,
    QLabel,
    QProgressBar,
    QSplitter,
    QListWidget,
    QListWidgetItem,
)
from PySide6.QtCore import Qt, QThread, Signal

from src.ai.ai_assistant import AIAssistant


class AIWorker(QThread):
    """Background worker for AI calls to avoid blocking UI."""

    result_ready = Signal(str, str)  # request_id, response
    error = Signal(str, str)

    def __init__(self, assistant: AIAssistant, request_id: str, prompt: str, mode: str = "chat"):
        super().__init__()
        self._assistant = assistant
        self._request_id = request_id
        self._prompt = prompt
        self._mode = mode

    def run(self) -> None:
        try:
            if self._mode == "chat":
                response = self._assistant.chat(self._prompt)
            elif self._mode == "setlist":
                response = self._assistant.suggest_setlist([], 60)
            elif self._mode == "analyze":
                response = self._assistant.analyze_rehearsal(self._prompt, [], [])
            else:
                response = self._assistant.chat(self._prompt)
            self.result_ready.emit(self._request_id, response)
        except Exception as e:
            self.error.emit(self._request_id, str(e))


class AIPanel(QWidget):
    """Side panel for AI chat and analysis in the Bandait Leader."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._assistant: Optional[AIAssistant] = None
        self._workers: List[AIWorker] = []
        self._request_counter = 0
        self._build_ui()
        self._init_ai()

    def _build_ui(self) -> None:
        layout = QVBoxLayout(self)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(12)

        # Header
        header = QLabel("🤖 AI ASSISTANT")
        header.setObjectName("sectionTitle")
        layout.addWidget(header)

        # Status
        self._status = QLabel("Ready")
        self._status.setObjectName("infoLabel")
        layout.addWidget(self._status)

        # Progress
        self._progress = QProgressBar()
        self._progress.setRange(0, 0)
        self._progress.setVisible(False)
        layout.addWidget(self._progress)

        # Chat history
        self._chat_history = QTextEdit()
        self._chat_history.setReadOnly(True)
        self._chat_history.setPlaceholderText("AI responses will appear here...")
        layout.addWidget(self._chat_history)

        # Input area
        input_layout = QHBoxLayout()
        self._input = QLineEdit()
        self._input.setPlaceholderText("Ask the AI...")
        self._input.returnPressed.connect(self._send_chat)
        input_layout.addWidget(self._input)

        self._btn_send = QPushButton("Send")
        self._btn_send.setObjectName("actionPad")
        self._btn_send.setMinimumSize(80, 40)
        self._btn_send.clicked.connect(self._send_chat)
        input_layout.addWidget(self._btn_send)

        layout.addLayout(input_layout)

        # Quick actions
        actions = QHBoxLayout()
        self._btn_setlist = QPushButton("Suggest Setlist")
        self._btn_setlist.clicked.connect(self._quick_setlist)
        actions.addWidget(self._btn_setlist)

        self._btn_analyze = QPushButton("Analyze Last")
        self._btn_analyze.clicked.connect(self._quick_analyze)
        actions.addWidget(self._btn_analyze)

        self._btn_clear = QPushButton("Clear")
        self._btn_clear.clicked.connect(self._clear_chat)
        actions.addWidget(self._btn_clear)

        layout.addLayout(actions)

    def _init_ai(self) -> None:
        try:
            self._assistant = AIAssistant()
            self._status.setText("AI: Connected")
            self._status.setStyleSheet("color: #CCFF00;")
        except Exception as e:
            self._status.setText(f"AI: Offline ({e})")
            self._status.setStyleSheet("color: #FFAA00;")

    def _send_chat(self) -> None:
        text = self._input.text().strip()
        if not text or not self._assistant:
            return
        self._request_counter += 1
        rid = f"chat_{self._request_counter}"

        self._chat_history.append(f"<b style='color:#00FFFF'>You:</b> {text}")
        self._input.clear()
        self._progress.setVisible(True)
        self._status.setText("AI: Thinking...")

        worker = AIWorker(self._assistant, rid, text, "chat")
        worker.result_ready.connect(self._on_result)
        worker.error.connect(self._on_error)
        worker.finished.connect(lambda: self._cleanup_worker(worker))
        self._workers.append(worker)
        worker.start()

    def _quick_setlist(self) -> None:
        if not self._assistant:
            return
        self._request_counter += 1
        rid = f"setlist_{self._request_counter}"
        self._chat_history.append("<b style='color:#CCFF00'>System:</b> Requesting setlist suggestion...")
        self._progress.setVisible(True)

        worker = AIWorker(self._assistant, rid, "", "setlist")
        worker.result_ready.connect(self._on_result)
        worker.error.connect(self._on_error)
        worker.finished.connect(lambda: self._cleanup_worker(worker))
        self._workers.append(worker)
        worker.start()

    def _quick_analyze(self) -> None:
        if not self._assistant:
            return
        self._request_counter += 1
        rid = f"analyze_{self._request_counter}"
        self._chat_history.append("<b style='color:#CCFF00'>System:</b> Analyzing rehearsal...")
        self._progress.setVisible(True)

        worker = AIWorker(self._assistant, rid, "No notes provided", "analyze")
        worker.result_ready.connect(self._on_result)
        worker.error.connect(self._on_error)
        worker.finished.connect(lambda: self._cleanup_worker(worker))
        self._workers.append(worker)
        worker.start()

    def _on_result(self, request_id: str, response: str) -> None:
        self._chat_history.append(f"<b style='color:#FF00FF'>AI:</b> {response}")
        self._progress.setVisible(False)
        self._status.setText("AI: Ready")

    def _on_error(self, request_id: str, error: str) -> None:
        self._chat_history.append(f"<b style='color:#FF0000'>Error:</b> {error}")
        self._progress.setVisible(False)
        self._status.setText("AI: Error")

    def _cleanup_worker(self, worker: AIWorker) -> None:
        if worker in self._workers:
            self._workers.remove(worker)
        worker.deleteLater()

    def _clear_chat(self) -> None:
        self._chat_history.clear()
        if self._assistant:
            self._assistant.clear_history()
