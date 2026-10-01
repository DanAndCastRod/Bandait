"""Multi-track recording engine with per-channel FLAC writing.

The audio callback only copies into a preallocated single-producer /
single-consumer ring buffer (no locks, no allocation). A writer thread drains
it to disk.
"""

import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
from PySide6.QtCore import QObject, Signal

from src.core.paths import recordings_dir


class _RingBuffer:
    """SPSC ring of float32 frames. Writer: audio thread. Reader: disk thread.

    ``_written`` and ``_read`` are monotonically increasing frame counters; each
    is assigned by exactly one thread (an int rebinding is atomic in CPython).
    """

    def __init__(self, capacity_frames: int, channels: int) -> None:
        self.capacity = capacity_frames
        self.channels = channels
        self._buf = np.zeros((capacity_frames, channels), dtype=np.float32)
        self._written = 0
        self._read = 0
        self.dropped_frames = 0

    def write(self, block: np.ndarray) -> bool:
        n = block.shape[0]
        ch = min(block.shape[1] if block.ndim > 1 else 1, self.channels)
        free = self.capacity - (self._written - self._read)
        if n > free:
            self.dropped_frames += n
            return False
        start = self._written % self.capacity
        first = min(n, self.capacity - start)
        if block.ndim == 1:
            self._buf[start : start + first, 0] = block[:first]
            if first < n:
                self._buf[: n - first, 0] = block[first:n]
        else:
            self._buf[start : start + first, :ch] = block[:first, :ch]
            if first < n:
                self._buf[: n - first, :ch] = block[first:n, :ch]
        self._written += n
        return True

    def read_all(self) -> Optional[np.ndarray]:
        avail = self._written - self._read
        if avail <= 0:
            return None
        start = self._read % self.capacity
        first = min(avail, self.capacity - start)
        out = np.empty((avail, self.channels), dtype=np.float32)
        out[:first] = self._buf[start : start + first]
        if first < avail:
            out[first:] = self._buf[: avail - first]
        self._read += avail
        return out


class RecordingEngine(QObject):
    """Records audio blocks to separate FLAC files per channel."""

    recording_started = Signal(str)  # session folder path
    recording_stopped = Signal()
    recording_error = Signal(str)

    RING_SECONDS = 5

    def __init__(self, sample_rate: int = 48000, parent=None) -> None:
        super().__init__(parent)
        self.sample_rate = sample_rate
        self._recording = False
        self._writers: list[sf.SoundFile] = []
        self._folder: Optional[Path] = None
        self._ring: Optional[_RingBuffer] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def start(self, session_name: str, n_channels: int = 4, base_dir: Optional[str] = None) -> str:
        """Start recording. Returns the output folder path."""
        if self._recording:
            return ""
        n_channels = max(1, int(n_channels))

        timestamp = time.strftime("%Y%m%d_%H%M%S")
        root = Path(base_dir) if base_dir else Path(recordings_dir())
        self._folder = root / f"{session_name}_{timestamp}"
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
                subtype="PCM_16",
            )
            self._writers.append(writer)

        self._ring = _RingBuffer(self.sample_rate * self.RING_SECONDS, n_channels)
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._write_loop, name="bandait-recorder", daemon=True)
        self._thread.start()
        self._recording = True

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
            try:
                writer.close()
            except Exception:
                pass
        self._writers = []
        self._ring = None
        self.recording_stopped.emit()

    def write_block(self, block: np.ndarray) -> None:
        """Copy a block into the ring buffer (called from the audio callback)."""
        ring = self._ring
        if not self._recording or ring is None:
            return
        ring.write(block)  # drops the block if the disk thread fell behind

    def _write_loop(self) -> None:
        """Background thread: drain the ring buffer to FLAC files."""
        while True:
            stopping = self._stop_event.wait(0.05)
            ring = self._ring
            block = ring.read_all() if ring is not None else None
            if block is not None:
                for ch, writer in enumerate(self._writers):
                    if ch < block.shape[1]:
                        try:
                            writer.write(block[:, ch])
                        except Exception as e:
                            self.recording_error.emit(str(e))
            if stopping:
                break

    def dropped_frames(self) -> int:
        ring = self._ring
        return ring.dropped_frames if ring is not None else 0

    def is_recording(self) -> bool:
        return self._recording
