"""Multi-channel mixer with per-track routing.

``process`` runs inside the audio callback: it works on preallocated buffers
and never allocates sample buffers (block sizes up to ``block_size``; a larger
block grows the buffers once, outside the steady state).
"""

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
        monitor_input: bool = False,
    ) -> None:
        self.input_channels = input_channels
        self.output_channels = max(1, output_channels)
        self.block_size = block_size
        self.tracks: List[Track] = []
        # Input passthrough is OFF by default: on stage, routing the laptop
        # microphone to the outputs is a feedback loop waiting to happen.
        self.monitor_input = monitor_input
        self._output = np.zeros((block_size, self.output_channels), dtype=np.float32)
        self._scratch = np.zeros(block_size, dtype=np.float32)
        self._any_solo = False
        self._master_gain = 1.0  # 0 dB default

    def add_track(self, track: Track) -> None:
        self.tracks.append(track)
        track.set_buffer_size(self.block_size)
        self._refresh_solo()

    def remove_track(self, name: str) -> None:
        self.tracks = [t for t in self.tracks if t.name != name]
        self._refresh_solo()

    def _refresh_solo(self) -> None:
        any_solo = False
        for t in self.tracks:
            if t.solo:
                any_solo = True
                break
        self._any_solo = any_solo

    def _grow(self, n_frames: int) -> None:
        self.block_size = n_frames
        self._output = np.zeros((n_frames, self.output_channels), dtype=np.float32)
        self._scratch = np.zeros(n_frames, dtype=np.float32)
        for t in self.tracks:
            t.set_buffer_size(n_frames)

    def process(self, input_block: np.ndarray) -> np.ndarray:
        """Mix all tracks into output channels.

        input_block: (n_frames, n_input_channels) from the audio interface.
        Returns a view (n_frames, n_output_channels) of an internal buffer.
        """
        n_frames = input_block.shape[0]
        n_input_ch = input_block.shape[1] if input_block.ndim > 1 else 1

        if n_frames > self.block_size:
            self._grow(n_frames)

        out = self._output[:n_frames]
        out.fill(0.0)
        scratch = self._scratch[:n_frames]
        self._refresh_solo()
        any_solo = self._any_solo

        for track in self.tracks:
            if track.mute:
                continue
            if any_solo and not track.solo:
                continue
            buf = track._buffer
            if buf.shape[0] < n_frames:
                continue
            np.multiply(buf[:n_frames], track.volume, out=scratch)
            mask = track.output_channels
            for ch in range(self.output_channels):
                if mask & (1 << ch):
                    out[:, ch] += scratch

        if self.monitor_input and n_input_ch > 0:
            if input_block.ndim == 1:
                out[:, 0] += input_block
            elif n_input_ch >= self.output_channels:
                out += input_block[:, : self.output_channels]
            elif n_input_ch == 1 and self.output_channels >= 2:
                out[:, 0] += input_block[:, 0]
                out[:, 1] += input_block[:, 0]
            else:
                out[:, :n_input_ch] += input_block

        if self._master_gain != 1.0:
            out *= self._master_gain

        # Soft clip to prevent hard distortion
        np.tanh(out, out=out)
        return out

    def get_input_raw(self) -> np.ndarray:
        """Return last input block (for recording)."""
        return getattr(self, '_last_input', np.zeros((self.block_size, self.input_channels), dtype=np.float32))

    def set_track_volume(self, track_idx: int, db: float) -> None:
        """Set volume of a track by index (-60 to +6 dB)."""
        if 0 <= track_idx < len(self.tracks):
            gain = 10 ** (db / 20.0)
            self.tracks[track_idx].volume = gain

    def set_track_mute(self, track_idx: int, muted: bool) -> None:
        if 0 <= track_idx < len(self.tracks):
            self.tracks[track_idx].mute = muted

    def set_track_solo(self, track_idx: int, soloed: bool) -> None:
        if 0 <= track_idx < len(self.tracks):
            self.tracks[track_idx].solo = soloed
            self._refresh_solo()

    def set_track_output(self, track_idx: int, mask: int) -> None:
        """Route a track to physical outputs (bitmask, bit 0 = Salida 1)."""
        if 0 <= track_idx < len(self.tracks):
            valid = (1 << self.output_channels) - 1
            self.tracks[track_idx].output_channels = (mask & valid) or 1

    def set_master_volume(self, db: float) -> None:
        """Set master volume (-60 to +6 dB)."""
        self._master_gain = 10 ** (db / 20.0)

    def get_track(self, idx: int):
        if 0 <= idx < len(self.tracks):
            return self.tracks[idx]
        return None
