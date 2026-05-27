"""QR-based session discovery for Bandait leader."""

import json
import socket
import qrcode
from io import BytesIO
from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QPixmap


class DiscoveryService(QObject):
    """Generates QR codes containing session connection info."""

    qr_generated = Signal(QPixmap)

    def __init__(self, port: int = 4040, parent=None) -> None:
        super().__init__(parent)
        self._port = port
        self._session_id: str = "default"

    def set_session_id(self, session_id: str) -> None:
        self._session_id = session_id

    def get_local_ip(self) -> str:
        """Get the local IP address for LAN connections."""
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except Exception:
            return "127.0.0.1"

    def generate_qr_data(self) -> dict:
        """Generate the connection payload for QR encoding."""
        return {
            "v": 2,
            "ip": self.get_local_ip(),
            "port": self._port,
            "sessionId": self._session_id,
            "proto": "ws",
        }

    def generate_qr_pixmap(self, size: int = 256) -> QPixmap:
        """Generate a QR code as QPixmap for display in UI."""
        data = json.dumps(self.generate_qr_data())
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=2,
        )
        qr.add_data(data)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#00FFFF", back_color="#000000")

        buffer = BytesIO()
        img.save(buffer, format="PNG")
        buffer.seek(0)

        pixmap = QPixmap()
        pixmap.loadFromData(buffer.getvalue())
        pixmap = pixmap.scaled(size, size)
        self.qr_generated.emit(pixmap)
        return pixmap

    def get_connection_url(self) -> str:
        """Get the WebSocket URL for manual entry."""
        ip = self.get_local_ip()
        return f"ws://{ip}:{self._port}"
