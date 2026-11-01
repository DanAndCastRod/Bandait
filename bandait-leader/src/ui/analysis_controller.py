"""Analizar con IA en segundo plano (mezcla, subida y consulta) para el inspector de Canciones."""

from __future__ import annotations

import threading
from typing import Callable, Optional, Tuple

from PySide6.QtCore import QObject, QTimer, Signal

from src.audio import stem_library as lib
from src.cloud.analysis_cloud import AnalysisCloud, draft_summary, mix_for_analysis, read_song_audio
from src.cloud.http import CloudError

POLL_MS = 15000
IMPORT_POLL_MS = 2000  # while the Worker copies stems (one per request)
POLL_LIMIT = 40  # ~10 minutes of analysis; copying stems does not count


class AnalysisController(QObject):
    state = Signal(str, str, bool)  # (short state, text, busy)
    stems_ready = Signal(str)  # local song id: the separated stems are in the cloud, bring them
    _done = Signal(object)  # (token, response or None, error text)

    def __init__(self, cloud_factory: Callable[[], Optional[object]], parent=None):
        super().__init__(parent)
        self._cloud_factory = cloud_factory
        self._token = 0
        self._target: Optional[Tuple[str, Optional[str], str]] = None  # (local id, band, hub song)
        self._polls = 0
        self._separating: Optional[str] = None  # local id whose separation this session started
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.refresh)
        self._done.connect(self._on_done)

    def select(self, local_id: Optional[str], ref) -> None:
        """New song in the inspector: show its last analysis, if any."""
        self._token += 1
        self._timer.stop()
        self._polls = 0
        self._target = (str(local_id), ref[0], ref[1]) if (local_id and ref) else None
        if self._target is not None and self._cloud_factory() is not None:
            self.refresh()

    def song_id(self) -> Optional[str]:
        """Local id of the song in the inspector, or None."""
        return self._target[0] if self._target else None

    def analyze(self) -> None:
        if self._target is None:
            return
        client = self._cloud_factory()
        if client is None:
            self.state.emit("Sin sesión", "Inicia sesión en la nube (Cuenta) para analizar.", False)
            return
        self._token += 1
        self._timer.stop()
        token = self._token
        local_id, band, song = self._target
        self.state.emit("Mezclando", "Mezclando los stems del portátil…", True)

        def work():
            try:
                stem_set = lib.load(local_id)
                if stem_set is None:
                    raise ValueError("Esta canción no tiene stems en el portátil")
                wav = mix_for_analysis(stem_set)
                _scope, response = AnalysisCloud(client).start(band, song, wav)
                self._done.emit((token, response, ""))
            except (CloudError, ValueError, OSError) as exc:
                self._done.emit((token, None, str(exc)))

        threading.Thread(target=work, name="bandait-analysis", daemon=True).start()

    def separate(self, path: str) -> None:
        """Upload a whole song: Music AI separates the stems and the Worker leaves them in the cloud."""
        if self._target is None:
            return
        client = self._cloud_factory()
        if client is None:
            self.state.emit("Sin sesión", "Inicia sesión en la nube (Cuenta) para separar.", False)
            return
        self._token += 1
        self._timer.stop()
        self._polls = 0
        token = self._token
        local_id, band, song = self._target
        self._separating = local_id
        self.state.emit("Subiendo", "Subiendo la canción a Music AI…", True)

        def work():
            try:
                audio, content_type = read_song_audio(path)
                _scope, response = AnalysisCloud(client).start(band, song, audio, content_type, separate=True)
                self._done.emit((token, response, ""))
            except (CloudError, ValueError, OSError) as exc:
                self._done.emit((token, None, str(exc)))

        threading.Thread(target=work, name="bandait-separate", daemon=True).start()

    def refresh(self) -> None:
        if self._target is None:
            return
        client = self._cloud_factory()
        if client is None:
            return
        token = self._token
        _local, band, song = self._target

        def work():
            try:
                _scope, response = AnalysisCloud(client).status(band, song)
                self._done.emit((token, response, ""))
            except CloudError as exc:
                self._done.emit((token, None, str(exc)))

        threading.Thread(target=work, name="bandait-analysis-status", daemon=True).start()

    def _on_done(self, payload) -> None:
        token, response, error = payload
        if token != self._token:
            return  # another song was selected meanwhile
        if error:
            if self._separating and "copiar los stems" in error and self._polls < POLL_LIMIT:
                self._polls += 1  # the copy is idempotent: try again
                self._timer.start(IMPORT_POLL_MS * 3)
            self.state.emit("Error", error, False)
            return
        status = (response or {}).get("status")
        short = {"SUCCEEDED": "Listo", "FAILED": "Falló", "IMPORTING": "Copiando"}
        self.state.emit(short.get(status, "Analizando" if response else ""), draft_summary(response or {}),
                        status == "IMPORTING")
        if status == "SUCCEEDED" and response.get("stems") and self._target and self._separating == self._target[0]:
            self._separating = None
            self.stems_ready.emit(self._target[0])
        if status == "IMPORTING":
            self._timer.start(IMPORT_POLL_MS)
        elif status in ("STARTED", "QUEUED", "RUNNING") or (response and status not in ("SUCCEEDED", "FAILED")):
            self._polls += 1
            if self._polls < POLL_LIMIT:
                self._timer.start(POLL_MS)
