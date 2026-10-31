"""Stems of the live song in the leader (phase 3): load, mix, import, remove.

Decoding and importing run on a worker thread; the result comes back to the Qt
thread through a queued signal and is dropped if the live song changed meanwhile.
The audio engine only ever receives finished int16 arrays (tuple swap).
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import List, Optional

from PySide6.QtCore import QObject, QTimer, Signal

from src.audio import stem_library as lib

logger = logging.getLogger(__name__)

SAVE_DEBOUNCE_MS = 800


class StemsController(QObject):
    _loaded = Signal(object)  # (token, song_id, stem_set or None, decoded list, error text)
    stems_shown = Signal(bool)  # the live song has playable stems
    message = Signal(str)

    def __init__(self, engine, mixer, container, root: Optional[Path] = None, parent=None):
        super().__init__(parent)
        self._engine = engine
        self._mixer = mixer
        self._container = container
        self._root = root
        self._token = 0
        self._song_id: Optional[str] = None
        self._title = ""
        self._ref_bpm = 120.0
        self._set: Optional[lib.StemSet] = None
        self._index: List[int] = []  # mixer strip -> index in self._set.stems
        self._busy = False
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(SAVE_DEBOUNCE_MS)
        self._save_timer.timeout.connect(self._save)
        self._loaded.connect(self._on_loaded)
        mixer.gains_changed.connect(engine.set_stem_gains)
        mixer.stem_changed.connect(self._on_stem_changed)
        mixer.offset_changed.connect(self._on_offset_changed)
        container.setVisible(False)

    # ------------------------------------------------------------------ public
    def song_id(self) -> Optional[str]:
        return self._song_id

    def has_stems(self) -> bool:
        return self._engine.has_stems()

    def busy(self) -> bool:
        return self._busy

    def show_song(self, song_id: Optional[str], title: str = "", ref_bpm: float = 120.0) -> None:
        """Live song changed: drop the old stems at once, load the new ones in the background."""
        self._flush()
        self._token += 1
        self._song_id = str(song_id) if song_id else None
        self._title = title or (self._song_id or "")
        self._ref_bpm = float(ref_bpm or 120.0)
        self._set = None
        self._index = []
        self._engine.clear_stems()
        self._show(False)
        if not self._song_id or not lib.has_stems(self._song_id, self._root):
            return
        self._start(self._worker_load, self._token, self._song_id)

    def import_paths(self, paths: List[str]) -> bool:
        """Replace the live song's stems with ``paths``. False when it cannot start now."""
        if not self._song_id or not paths or self._busy:
            return False
        self._flush()
        self._token += 1
        self.message.emit("Importando stems...")
        self._start(self._worker_import, self._token, self._song_id, list(paths))
        return True

    def remove_live(self) -> None:
        if not self._song_id:
            return
        self._save_timer.stop()
        self._token += 1
        self._engine.clear_stems()
        lib.remove(self._song_id, self._root)
        self._set = None
        self._show(False)
        self.message.emit("Stems quitados de esta canción")

    def wait_idle(self, timeout_s: float = 10.0) -> bool:
        """Tests: wait for the worker thread (the result still needs the Qt event loop)."""
        t = getattr(self, "_thread", None)
        if t is not None:
            t.join(timeout_s)
            return not t.is_alive()
        return True

    # ------------------------------------------------------------------ worker
    def _start(self, fn, *args) -> None:
        self._busy = True
        self._thread = threading.Thread(target=fn, args=args, name="bandait-stems", daemon=True)
        self._thread.start()

    def _worker_load(self, token: int, song_id: str) -> None:
        stem_set = lib.load(song_id, self._root)
        decoded = lib.decode(stem_set, self._engine.sample_rate, self._root) if stem_set else []
        self._loaded.emit((token, song_id, stem_set, decoded, ""))

    def _worker_import(self, token: int, song_id: str, paths: List[str]) -> None:
        try:
            stem_set = lib.import_stems(song_id, paths, self._root)
        except lib.StemImportError as exc:
            self._loaded.emit((token, song_id, lib.load(song_id, self._root), None, str(exc)))
            return
        except OSError as exc:
            self._loaded.emit((token, song_id, lib.load(song_id, self._root), None, f"No se pudo copiar: {exc}"))
            return
        decoded = lib.decode(stem_set, self._engine.sample_rate, self._root)
        self._loaded.emit((token, song_id, stem_set, decoded, ""))

    # ------------------------------------------------------------------ Qt thread
    def _on_loaded(self, payload) -> None:
        token, song_id, stem_set, decoded, error = payload
        self._busy = False
        if token != self._token or song_id != self._song_id:
            return  # the live song changed while decoding
        if error:
            self.message.emit(error)
            if stem_set is not None:  # import failed: keep (reload) what the song had
                self._token += 1
                self._start(self._worker_load, self._token, song_id)
            return
        if stem_set is None or decoded is None:
            self._show(False)
            return
        ok = [(i, info, data) for i, (info, data, _err) in enumerate(decoded) if data is not None]
        errors = [err for _info, data, err in decoded if data is None]
        self._set = stem_set
        self._index = [i for i, _info, _data in ok]
        infos = [info for _i, info, _data in ok]
        self._mixer.set_stems(self._title, infos, stem_set.offset_ms, errors)
        if not ok:
            self._engine.clear_stems()
            self._show(True)  # visible to show why nothing plays
            return
        self._engine.set_stems([d for _i, _info, d in ok], self._mixer.gains(), self._ref_bpm, stem_set.offset_ms)
        self._show(True)
        roles = ", ".join(info.label for info in infos)
        self.message.emit(f"Stems listos: {roles}")

    def _show(self, visible: bool) -> None:
        self._container.setVisible(visible)
        self.stems_shown.emit(visible and self._engine.has_stems())

    def _on_stem_changed(self, strip: int, gain_db: float, muted: bool) -> None:
        if self._set is None or not (0 <= strip < len(self._index)):
            return
        info = self._set.stems[self._index[strip]]
        info.gain_db = round(float(gain_db), 1)
        info.muted = bool(muted)
        self._save_timer.start()

    def _on_offset_changed(self, ms: float) -> None:
        self._engine.set_stem_offset(ms)
        if self._set is not None:
            self._set.offset_ms = float(ms)
            self._save_timer.start()

    def _flush(self) -> None:
        if self._save_timer.isActive():
            self._save_timer.stop()
            self._save()

    def _save(self) -> None:
        if self._set is None:
            return
        try:
            lib.save(self._set, self._root)
        except OSError as exc:
            logger.warning("No se pudieron guardar los ajustes de stems: %s", exc)


def import_dialog_filter() -> str:
    return "Stems (*.zip *.mp3 *.wav *.flac *.ogg *.m4a *.aac);;Todos los archivos (*)"


def song_bpm(entry: Optional[dict], fallback: float) -> float:
    try:
        bpm = float((entry or {}).get("bpm") or 0)
    except (TypeError, ValueError):
        bpm = 0.0
    return bpm if bpm > 0 else float(fallback or 120.0)
