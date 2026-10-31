"""Stems of the live song in the leader (phase 3): load, mix, import, remove.

Decoding and importing run on a worker thread; the result comes back to the Qt
thread through a queued signal and is dropped if the live song changed meanwhile.
The audio engine only ever receives finished int16 arrays (tuple swap).
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Callable, List, Optional, Tuple

from PySide6.QtCore import QObject, QTimer, Signal

from src.audio import stem_library as lib
from src.cloud.http import CloudError
from src.cloud.stems_cloud import StemsCloud, sync_song

# song_id -> (band_cloud_id, song_cloud_id) of the hub song, or None for a local-only song.
CloudRef = Callable[[str], Optional[Tuple[Optional[str], str]]]

logger = logging.getLogger(__name__)

SAVE_DEBOUNCE_MS = 800


class StemsController(QObject):
    _loaded = Signal(object)  # (token, song_id, stem_set or None, decoded list, error text)
    stems_shown = Signal(bool)  # the live song has playable stems
    message = Signal(str)

    def __init__(self, engine, mixer, container, root: Optional[Path] = None, parent=None,
                 cloud: Callable[[], Optional[StemsCloud]] = lambda: None, cloud_ref: CloudRef = lambda _s: None):
        super().__init__(parent)
        self._cloud = cloud
        self._cloud_ref = cloud_ref
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

    def show_song(self, song_id: Optional[str], title: str = "", ref_bpm: float = 120.0,
                  allow_network: bool = False) -> None:
        """Live song changed: drop the old stems at once, load the new ones in the background.
        ``allow_network`` (band stopped): first bring newer stems from the cloud, if any."""
        self._flush()
        self._token += 1
        self._song_id = str(song_id) if song_id else None
        self._title = title or (self._song_id or "")
        self._ref_bpm = float(ref_bpm or 120.0)
        self._set = None
        self._index = []
        self._engine.clear_stems()
        self._show(False)
        if not self._song_id:
            return
        ref = self._cloud_ref(self._song_id) if allow_network else None
        client = self._cloud() if ref else None
        if client is not None and not self._busy:
            self._start(self._worker_sync_load, self._token, self._song_id, client, ref)
            return
        if lib.has_stems(self._song_id, self._root):
            self._start(self._worker_load, self._token, self._song_id)

    def download_setlist(self, songs: List[Tuple[str, str]]) -> bool:
        """Download (replacing hand-imported ones) the cloud stems of every (song_id, title).
        False when there is no cloud session or a job is running."""
        client = self._cloud()
        if client is None or self._busy:
            return False
        self._flush()
        self._token += 1
        self._start(self._worker_setlist, self._token, self._song_id, client, list(songs))
        return True

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

    def _sync(self, client: StemsCloud, song_id: str, ref, title: str, force: bool) -> str:
        band, song = ref
        return sync_song(
            client, song_id, band, song, self._root, force=force,
            progress=lambda i, n: self.message.emit(f"Descargando stems de {title}: {i}/{n}") if i < n else None,
        )

    def _worker_sync_load(self, token: int, song_id: str, client: StemsCloud, ref) -> None:
        try:
            if self._sync(client, song_id, ref, self._title, force=False) == "updated":
                self.message.emit(f"Stems actualizados desde la nube: {self._title}")
        except CloudError as exc:
            self.message.emit(f"Nube de stems: {exc}. Se usan los del portátil.")
        except lib.StemImportError as exc:
            self.message.emit(f"Nube de stems: {exc}")
        self._worker_load(token, song_id)

    def _worker_setlist(self, token: int, live_song: Optional[str], client: StemsCloud, songs) -> None:
        counts = {"updated": 0, "current": 0, "none": 0, "local": 0, "error": 0, "no_cloud": 0}
        first_error = ""
        for i, (song_id, title) in enumerate(songs):
            ref = self._cloud_ref(song_id)
            if ref is None:
                counts["no_cloud"] += 1
                continue
            self.message.emit(f"Stems del setlist {i + 1}/{len(songs)}: {title}")
            try:
                counts[self._sync(client, song_id, ref, title, force=True)] += 1
            except (CloudError, lib.StemImportError) as exc:
                counts["error"] += 1
                first_error = first_error or f"{title}: {exc}"
                logger.warning("Stems de %s: %s", title, exc)
        self.message.emit(setlist_summary(counts, first_error))
        if live_song:
            self._worker_load(token, live_song)
        else:
            self._loaded.emit((token, None, None, None, ""))

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


def setlist_summary(counts: dict, first_error: str = "") -> str:
    """One status-bar line for Descargar stems del setlist. Every outcome is counted:
    "0 descargadas" alone used to hide that a song was already up to date (2026-10-31)."""
    parts = [f"{counts.get('updated', 0)} descargadas"]
    for key, text in (("current", "ya al día"), ("none", "sin stems en la nube"),
                      ("no_cloud", "solo locales (sin id del hub)")):
        if counts.get(key):
            parts.append(f"{counts[key]} {text}")
    if counts.get("error"):
        parts.append(f"{counts['error']} con error (primero: {first_error})")
    return "Stems del setlist: " + ", ".join(parts)
