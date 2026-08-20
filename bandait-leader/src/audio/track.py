"""Audio track with mixing controls and channel routing."""

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Track:
    """A single audio track with mixing and routing controls."""

    name: str
    volume: float = 1.0  # 0.0 to 1.0
    pan: float = 0.0  # -1.0 (L) to 1.0 (R)
    mute: bool = False
    solo: bool = False
    # Bitmask: which physical output channels to route to (1-4)
    output_channels: int = 0b0001  # Default to channel 1

    # Pre-allocated buffer to avoid allocation in audio callback
    _buffer: np.ndarray = field(init=False, repr=False)
    _buffer_size: int = 1024

    def __post_init__(self):
        self._buffer = np.zeros(self._buffer_size, dtype=np.float32)

    def get_block(self, n_frames: int) -> np.ndarray:
        """Return audio block for this track (placeholder for backing track playback)."""
        if n_frames > len(self._buffer):
            self._buffer = np.zeros(n_frames, dtype=np.float32)
        return self._buffer[:n_frames] * (0.0 if self.mute else self.volume)

    def set_buffer_size(self, size: int) -> None:
        """Resize internal buffer (call when blocksize changes)."""
        if size != len(self._buffer):
            self._buffer = np.zeros(size, dtype=np.float32)
