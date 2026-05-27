"""Main audio engine: metronome, mixer, recorder, and transport."""

from typing import Optional

import numpy as np
import sounddevice as sd
from PySide6.QtCore import QObject, Signal

from .track import Track
from .mixer import Mixer
from .recorder import RecordingEngine


class AudioEngine(QObject):
    """Low-latency audio engine with metronome, mixing, and recording."""

    # Transport signals
    started = Signal()
    stopped = Signal()
    recording_started = Signal(str)
    recording_stopped = Signal()

    # Beat signal (emitted on audio thread — receivers must be thread-safe)
    beat = Signal(int, float)  # beat_number (1-4), bpm

    def __init__(
        self,
        sample_rate: int = 48000,
        block_size: int = 256,
        channels: int = 4,
        device: Optional[int] = None,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.sample_rate = sample_rate
        self.block_size = block_size
        self.channels = channels
        self.device = device

        self.mixer = Mixer(n_channels=channels, block_size=block_size)
        self.recorder = RecordingEngine(sample_rate=sample_rate)
        self.recorder.recording_started.connect(self.recording_started)
        self.recorder.recording_stopped.connect(self.recording_stopped)

        self._stream: Optional[sd.Stream] = None
        self._running = False
        self._recording = False

        # Metronome state
        self._bpm = 120.0
        self._beat = 0  # 0-3
        self._beat_interval_samples = int(60.0 / self._bpm * sample_rate)
        self._samples_since_beat = 0

        # Pre-generated click (impulse + lowpass)
        self._click_duration = int(0.05 * sample_rate)  # 50ms
        self._click = self._generate_click()
        self._click_idx = 0
        self._click_playing = False

    def _generate_click(self) -> np.ndarray:
        """Generate a short click sound (tick vs tock by filtering)."""
        click = np.zeros(self._click_duration, dtype=np.float32)
        click[0] = 0.8  # Impulse
        # Simple exponential decay lowpass
        alpha = 0.3
        for i in range(1, len(click)):
            click[i] = alpha * click[i - 1]
        return click

    def _audio_callback(
        self,
        indata: np.ndarray,
        outdata: np.ndarray,
        frames: int,
        time_info: dict,
        status: sd.CallbackFlags,
    ) -> None:
        if status:
            print(f"[AUDIO] Status: {status}")

        # Metronome scheduling
        self._schedule_metronome(frames)

        # Build click output
        click_out = np.zeros((frames, self.channels), dtype=np.float32)
        if self._click_playing:
            remaining = min(frames, len(self._click) - self._click_idx)
            if remaining > 0:
                # Beat 1 = louder, higher freq simulated by amplitude
                amplitude = 1.0 if self._beat == 0 else 0.6
                click_out[:remaining, 0] = (
                    self._click[self._click_idx : self._click_idx + remaining] * amplitude
                )
                self._click_idx += remaining
                if self._click_idx >= len(self._click):
                    self._click_playing = False
                    self._click_idx = 0

        # Mix: input monitoring + click + tracks
        mixed = self.mixer.process(indata) + click_out
        outdata[:] = mixed

        # Recording
        if self._recording:
            self.recorder.write_block(indata)

    def _schedule_metronome(self, frames: int) -> None:
        """Schedule metronome beats based on sample count."""
        self._samples_since_beat += frames
        if self._samples_since_beat >= self._beat_interval_samples:
            self._samples_since_beat -= self._beat_interval_samples
            self._beat = (self._beat + 1) % 4
            self._click_playing = True
            self._click_idx = 0
            # Emit on next event loop (don't block audio callback)
            # Note: Signal from audio thread may be unsafe; use queued connection
            self.beat.emit(self._beat + 1, self._bpm)

    def start(self) -> None:
        """Start audio stream."""
        if self._running:
            return
        try:
            self._stream = sd.Stream(
                samplerate=self.sample_rate,
                blocksize=self.block_size,
                device=self.device,
                channels=self.channels,
                dtype=np.float32,
                latency="low",
                callback=self._audio_callback,
            )
            self._stream.start()
            self._running = True
            self.started.emit()
        except Exception as e:
            print(f"[AUDIO] Failed to start: {e}")

    def stop(self) -> None:
        """Stop audio stream."""
        if self._stream:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        self._running = False
        if self._recording:
            self.stop_recording()
        self.stopped.emit()

    def set_bpm(self, bpm: float) -> None:
        """Update metronome BPM."""
        self._bpm = bpm
        self._beat_interval_samples = int(60.0 / bpm * self.sample_rate)

    def start_recording(self, session_name: str) -> str:
        """Start recording to disk."""
        if not self._running:
            self.start()
        self._recording = True
        return self.recorder.start(session_name, self.channels)

    def stop_recording(self) -> None:
        """Stop recording."""
        self._recording = False
        self.recorder.stop()

    def is_running(self) -> bool:
        return self._running

    def is_recording(self) -> bool:
        return self.recorder.is_recording()
