"""Multi-channel mixer with per-track routing."""

import numpy as np
from typing import List
from .track import Track


class Mixer:
    """Mixes multiple tracks into physical output channels."""

    def __init__(
        self,
        input_channels: int = 2,
        output_channels: int = 2,
        block_size: int = 256,
    ) -> None:
        self.input_channels = input_channels
        self.output_channels = output_channels
        self.block_size = block_size
        self.tracks: List[Track] = []
        self._output = np.zeros((block_size, output_channels), dtype=np.float32)
        self._any_solo = False

    def add_track(self, track: Track) -> None:
        self.tracks.append(track)
        track.set_buffer_size(self.block_size)

    def remove_track(self, name: str) -> None:
        self.tracks = [t for t in self.tracks if t.name != name]

    def process(self, input_block: np.ndarray) -> np.ndarray:
        """
        Mix all tracks into output channels.
        input_block: (n_frames, n_input_channels) from audio interface input.
        Returns: (n_frames, n_output_channels) for output.
        """
        n_frames = input_block.shape[0]
        n_input_ch = input_block.shape[1] if input_block.ndim > 1 else 1

        if n_frames > self.block_size:
            self.block_size = n_frames
            self._output = np.zeros((n_frames, self.output_channels), dtype=np.float32)
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
            # Route to assigned channels (bitmask)
            for ch in range(self.output_channels):
                if track.output_channels & (1 << ch):
                    self._output[:, ch] += block

        # Add input passthrough (for monitoring) — map input channels to output
        if n_input_ch >= self.output_channels:
            self._output += input_block[:, :self.output_channels]
        elif n_input_ch == 1 and self.output_channels >= 2:
            # Mono input to stereo output
            self._output[:, 0] += input_block[:, 0]
            self._output[:, 1] += input_block[:, 0]
        else:
            self._output[:, :n_input_ch] += input_block

        # Soft clip to prevent hard distortion
        np.tanh(self._output, out=self._output)

        return self._output

    def get_input_raw(self) -> np.ndarray:
        """Return last input block (for recording)."""
        return getattr(self, '_last_input', np.zeros((self.block_size, self.input_channels), dtype=np.float32))
