"""Login progress: the browser does the Google part; this dialog waits with Cancel."""

from __future__ import annotations

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont, QGuiApplication
from PySide6.QtWidgets import (
    QDialog,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
)

from src.cloud.auth import redirect_urls

HINT_AFTER_MS = 20000

DIALOG_QSS = """
QDialog { background: #000000; color: #F0F0F0; }
QLabel { color: #F0F0F0; background: transparent; }
QLabel#detail { color: #A0A0A0; }
QLabel#hint { color: #FFAA00; border: 1px solid #333333; border-radius: 4px; padding: 8px; }
QLabel#error { color: #FF3B3B; }
QPushButton { background: transparent; border: 1px solid #666666; color: #CCCCCC;
              border-radius: 4px; padding: 6px 14px; }
QPushButton:hover { border-color: #00FFFF; color: #00FFFF; }
QPushButton:disabled { border-color: #333333; color: #444444; }
QProgressBar { background: #0A0A0A; border: 1px solid #1E1E1E; height: 6px; border-radius: 3px; }
QProgressBar::chunk { background: #00FFFF; }
QListWidget { background: #0A0A0A; color: #F0F0F0; border: 1px solid #1E1E1E; }
QListWidget::item:selected { background: #00FFFF; color: #000000; }
"""


def redirect_hint() -> str:
    urls = "\n".join(redirect_urls())
    return (
        "Si el navegador terminó en bandait.releven.cc/hub en vez de mostrar "
        "\"Sesión iniciada, vuelve a Bandait\", Supabase no aceptó la dirección de "
        "retorno de este equipo. En Supabase > Authentication > URL Configuration > "
        f"Redirect URLs agrega exactamente:\n{urls}"
    )


class LoginDialog(QDialog):
    """Modal while the system browser handles Google. Closing it cancels."""

    def __init__(self, controller, parent=None):
        super().__init__(parent)
        self._controller = controller
        self._running = False
        self.result = None
        self.setWindowTitle("Iniciar sesión con Google")
        self.setMinimumWidth(520)
        self.setStyleSheet(DIALOG_QSS)

        layout = QVBoxLayout(self)
        layout.setSpacing(10)
        layout.setContentsMargins(20, 20, 20, 20)

        title = QLabel("CUENTA DEL HUB")
        title.setFont(QFont("Inter", 13, QFont.Bold))
        title.setStyleSheet("color: #00FFFF;")
        layout.addWidget(title)

        self.status_label = QLabel("Preparando...")
        self.status_label.setWordWrap(True)
        self.status_label.setFont(QFont("Inter", 11))
        layout.addWidget(self.status_label)

        self.detail_label = QLabel("")
        self.detail_label.setObjectName("detail")
        self.detail_label.setWordWrap(True)
        self.detail_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        layout.addWidget(self.detail_label)

        self.progress = QProgressBar()
        self.progress.setRange(0, 0)  # busy
        self.progress.setTextVisible(False)
        layout.addWidget(self.progress)

        self.hint_label = QLabel(redirect_hint())
        self.hint_label.setObjectName("hint")
        self.hint_label.setWordWrap(True)
        self.hint_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.hint_label.setVisible(False)
        layout.addWidget(self.hint_label)

        buttons = QHBoxLayout()
        self.reopen_btn = QPushButton("Abrir de nuevo")
        self.reopen_btn.setToolTip("Vuelve a abrir la página de Google en el navegador")
        self.reopen_btn.setEnabled(False)
        self.reopen_btn.clicked.connect(self._reopen)
        buttons.addWidget(self.reopen_btn)
        self.copy_btn = QPushButton("Copiar URLs de retorno")
        self.copy_btn.setToolTip("Las tres URL que van en Supabase > Redirect URLs")
        self.copy_btn.clicked.connect(self._copy_urls)
        buttons.addWidget(self.copy_btn)
        buttons.addStretch()
        self.cancel_btn = QPushButton("Cancelar")
        self.cancel_btn.clicked.connect(self.reject)
        buttons.addWidget(self.cancel_btn)
        layout.addLayout(buttons)

        controller.login_progress.connect(self._on_progress)
        controller.login_finished.connect(self._on_finished)
        self._hint_timer = QTimer(self)
        self._hint_timer.setSingleShot(True)
        self._hint_timer.timeout.connect(lambda: self.hint_label.setVisible(True))

    def start(self) -> bool:
        if not self._controller.start_login():
            self._show_error("Ya hay un inicio de sesión en curso.")
            return False
        self._running = True
        self._hint_timer.start(HINT_AFTER_MS)
        return True

    # ------------------------------------------------------------------ slots
    def _on_progress(self, stage: str, message: str):
        if stage in ("waiting", "browser", "browser_failed"):
            self.reopen_btn.setEnabled(True)
        if stage == "waiting":
            self.status_label.setText("Termina el inicio de sesión en el navegador.")
            self.detail_label.setText(message)
        elif stage == "browser_failed":
            self.detail_label.setText(message)
        else:
            self.status_label.setText(message)

    def _on_finished(self, result):
        self._running = False
        self._hint_timer.stop()
        self.result = result
        if result.ok:
            self.accept()
            return
        if result.cancelled:
            super().reject()
            return
        self._show_error(result.message)
        if "5 minutos" in result.message or "retorno" in result.message:
            self.hint_label.setVisible(True)

    def _show_error(self, message: str):
        self.progress.setRange(0, 1)
        self.progress.setValue(0)
        self.status_label.setText("No se pudo iniciar sesión")
        self.status_label.setObjectName("error")
        self.status_label.setStyleSheet("color: #FF3B3B;")
        self.detail_label.setText(message)
        self.reopen_btn.setEnabled(False)
        self.cancel_btn.setText("Cerrar")

    def _reopen(self):
        if not self._controller.reopen_browser():
            self.detail_label.setText("No se pudo abrir el navegador. Copia el enlace a mano:\n"
                                      + (self._controller.authorize_url or ""))

    def _copy_urls(self):
        clipboard = QGuiApplication.clipboard()
        if clipboard is not None:
            clipboard.setText("\n".join(redirect_urls()))
        self.hint_label.setVisible(True)

    def reject(self):
        if self._running:
            self._controller.cancel_login()  # login_finished(cancelled) closes the dialog
            self.status_label.setText("Cancelando...")
            self.cancel_btn.setEnabled(False)
            return
        super().reject()
