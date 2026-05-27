"""Multi-track recording engine with per-channel FLAC writing."""

import time
import queue
import threading
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
from PySide6.QtCore import QObject, Signal


class RecordingEngine(QObject):
    """Records audio blocks to separate FLAC files per channel."""

    recording_started = Signal(str)  # session folder path
    recording_stopped = Signal()
    recording_error = Signal(str)

    def __init__(self, sample_rate: int = 48000, parent=None) -> None:
        super().__init__(parent)
        self.sample_rate = sample_rate
        self._recording = False
        self._writers: list[sf.SoundFile] = []
        self._folder: Optional[Path] = None
        self._queue: queue.Queue = queue.Queue(maxsize=100)
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def start(self, session_name: str, n_channels: int = 4) -> str:
        """Start recording. Returns the output folder path."""
        if self._recording:
            return ""

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        self._folder = Path("recordings") / f"{session_name}_{timestamp}"
        self._folder.mkdir(parents=True, exist_ok=True)

        self._writers = []
        for ch in range(n_channels):
            path = self._folder / f"track_ch{ch+1}.flac"
            writer = sf.SoundFile(
                str(path),
                mode="w",
                samplerate=self.sample_rate,
                channels=1,
                format="FLAC",
                subtype="PCM_24",
            )
            self._writers.append(writer)

        self._recording = True
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._write_loop, daemon=True)
        self._thread.start()

        folder_str = str(self._folder)
        self.recording_started.emit(folder_str)
        return folder_str

    def stop(self) -> None:
        """Stop recording and close all files."""
        if not self._recording:
            return
        self._recording = False
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5.0)
        for writer in self._writers:
            writer.close()
        self._writers = []
        self.recording_stopped.emit()

    def write_block(self, block: np.ndarray) -> None:
        """Queue a block for writing (called from audio callback)."""
        if not self._recording:
            return
        try:
            self._queue.put_nowait(block.copy())
        except queue.Full:
            pass  # Drop frame rather than block audio thread

    def _write_loop(self) -> None:
        """Background thread: dequeue and write to FLAC files."""
        while not self._stop_event.is_set() or not self._queue.empty():
            try:
                block = self._queue.get(timeout=0.1)
            except queue.Empty:
                continue

            n_frames = block.shape[0]
            for ch, writer in enumerate(self._writers):
                if ch < block.shape[1]:
                    try:
                        writer.write(block[:, ch])
                    except Exception as e:
                        self.recording_error.emit(str(e))

    def is_recording(self) -> bool:
        return self._recording
