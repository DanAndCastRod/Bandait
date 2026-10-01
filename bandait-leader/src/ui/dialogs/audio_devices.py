"""Dialogo "Dispositivos de Audio...": salida, ruteo del clic y ASIO."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QLabel,
    QVBoxLayout,
)

from src.audio.audio_engine import DRUMMER_CHANNEL, AudioEngine


@dataclass(frozen=True)
class AudioDeviceChoice:
    device_id: Optional[int]
    device_name: Optional[str]
    hostapi: Optional[str]
    drummer_click: bool
    pa_click: bool
    enable_asio: bool


class AudioDevicesDialog(QDialog):
    """Elegir dispositivo de salida (todas las APIs, ASIO incluido) y ruteo del clic."""

    def __init__(
        self,
        current_device: Optional[int],
        drummer_click: bool,
        pa_click: bool,
        enable_asio: bool,
        devices: Optional[list] = None,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle("Dispositivos de Audio")
        self.setMinimumWidth(560)
        self.setStyleSheet(
            "QDialog { background: #000000; color: #F0F0F0; }"
            "QLabel { color: #F0F0F0; }"
            "QCheckBox { color: #F0F0F0; }"
        )
        self._devices = devices if devices is not None else AudioEngine.get_output_devices()
        self._asio_loaded = any(d.get("is_asio") for d in self._devices)

        layout = QVBoxLayout(self)
        layout.addWidget(QLabel("Dispositivo de salida"))
        self.device_combo = QComboBox()
        self.device_combo.addItem("Predeterminado del sistema", None)
        select = 0
        for d in self._devices:
            label = f"{d['hostapi']} - {d['name']} ({d['max_outputs']} salidas)"
            if d.get("is_asio"):
                label += " [ASIO]"
            self.device_combo.addItem(label, d["id"])
            if current_device is not None and d["id"] == current_device:
                select = self.device_combo.count() - 1
        self.device_combo.setCurrentIndex(select)
        self.device_combo.currentIndexChanged.connect(self._refresh_info)
        layout.addWidget(self.device_combo)

        self.info_label = QLabel("")
        self.info_label.setWordWrap(True)
        self.info_label.setStyleSheet("color: #666666;")
        layout.addWidget(self.info_label)

        self.drummer_check = QCheckBox("Clic del baterista en Salida 3")
        self.drummer_check.setChecked(drummer_click)
        layout.addWidget(self.drummer_check)

        self.pa_check = QCheckBox("Clic en PA (Salidas 1-2) - solo ensayo o audifonos")
        self.pa_check.setChecked(pa_click)
        layout.addWidget(self.pa_check)

        self.asio_check = QCheckBox("Habilitar ASIO (requiere reiniciar Bandait)")
        self.asio_check.setChecked(enable_asio)
        layout.addWidget(self.asio_check)
        asio_note = QLabel(
            "ASIO detectado." if self._asio_loaded else
            "ASIO no esta cargado en esta sesion. Active la casilla y reinicie para "
            "usar la version de PortAudio con ASIO."
        )
        asio_note.setWordWrap(True)
        asio_note.setStyleSheet("color: #666666;")
        layout.addWidget(asio_note)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Ok).setText("Aplicar")
        buttons.button(QDialogButtonBox.Cancel).setText("Cancelar")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self._refresh_info()

    def _selected(self) -> Optional[dict]:
        dev_id = self.device_combo.currentData()
        for d in self._devices:
            if d["id"] == dev_id:
                return d
        return None

    def _refresh_info(self, *_args) -> None:
        d = self._selected()
        if d is None:
            self.info_label.setText(
                "Se usara la salida predeterminada de Windows con todas sus salidas."
            )
            self.drummer_check.setEnabled(True)
            return
        n = int(d["max_outputs"])
        if n > DRUMMER_CHANNEL:
            self.info_label.setText(
                f"{n} salidas: Salidas 1-2 = PA (FOH), Salida 3 = clic del baterista."
            )
            self.drummer_check.setEnabled(True)
        else:
            self.info_label.setText(
                f"Este dispositivo tiene {n} salidas: no hay Salida 3 para el baterista. "
                "El clic no se envia a la PA salvo que active 'Clic en PA'."
            )
            self.drummer_check.setEnabled(False)

    def choice(self) -> AudioDeviceChoice:
        d = self._selected()
        return AudioDeviceChoice(
            device_id=d["id"] if d else None,
            device_name=d["name"] if d else None,
            hostapi=d["hostapi"] if d else None,
            drummer_click=self.drummer_check.isChecked(),
            pa_click=self.pa_check.isChecked(),
            enable_asio=self.asio_check.isChecked(),
        )
