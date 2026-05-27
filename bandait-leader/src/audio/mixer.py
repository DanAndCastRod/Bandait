"""Multi-channel mixer with per-track routing."""

import numpy as np
from typing import List
from .track import Track


class Mixer:
    """Mixes multiple tracks into physical output channels."""

    def __init__(self, n_channels: int = 4, block_size: int = 256) -> None:
        self.n_channels = n_channels
        self.block_size = block_size
        self.tracks: List[Track] = []
        self._output = np.zeros((block_size, n_channels), dtype=np.float32)
        self._any_solo = False

    def add_track(self, track: Track) -> None:
        self.tracks.append(track)
        track.set_buffer_size(self.block_size)

    def remove_track(self, name: str) -> None:
        self.tracks = [t for t in self.tracks if t.name != name]

    def process(self, input_block: np.ndarray) -> np.ndarray:
        """
        Mix all tracks into output channels.
        input_block: (n_frames, n_channels) from audio interface input.
        Returns: (n_frames, n_channels) for output.
        """
        n_frames = input_block.shape[0]
        if n_frames > self.block_size:
            self.block_size = n_frames
            self._output = np.zeros((n_frames, self.n_channels), dtype=np.float32)
            for t in self.tracks:
                t.set_buffer_size(n_frames)

        self._output.fill(0.0)
        self._any_solo = any(t.solo for t in self.tracks)

        for track in self.tracks:
            if track.mute:
                continue
            if self._any_solo and not track.solo:
                continue

            block = track.get_block(n_frames)
            # Route to assigned channels
            for ch in range(self.n_channels):
                if track.output_channels & (1 << ch):
                    self._output[:, ch] += block

        # Add input passthrough (for monitoring)
        self._output += input_block

        # Soft clip to prevent hard distortion
        np.tanh(self._output, out=self._output)

        return self._output

    def get_input_raw(self) -> np.ndarray:
        """Return last input block (for recording)."""
        # This is populated by the audio engine
        return getattr(self, '_last_input', np.zeros((self.block_size, self.n_channels), dtype=np.float32))
