"""Main audio engine: metronome, mixer, recorder, and transport."""

import threading
import queue
from typing import Optional

import numpy as np
import sounddevice as sd
from PySide6.QtCore import QObject, Signal, QTimer

from .track import Track
from .mixer import Mixer
from .recorder import RecordingEngine


class AudioEngine(QObject):
    """Low-latency audio engine with metronome, mixing, and recording."""

    # Transport signals (emitted from main thread only)
    started = Signal()
    stopped = Signal()
    recording_started = Signal(str)
    recording_stopped = Signal()

    # Beat signal (emitted from main thread via queued timer)
    beat = Signal(int, float)  # beat_number (1-4), bpm
    # Audio levels (emitted from main thread)
    levels = Signal(list)  # [ch0_level, ch1_level, ...] 0.0-1.0

    def __init__(
        self,
        sample_rate: int = 48000,
        block_size: int = 256,
        channels: int = 2,
        device: Optional[int] = None,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.sample_rate = sample_rate
        self.block_size = block_size
        self.channels = channels
        self.device = device

        # Detect actual hardware capabilities
        self._input_channels = channels
        self._output_channels = channels
        self._detect_device_channels()

        self.mixer = Mixer(
            input_channels=self._input_channels,
            output_channels=self._output_channels,
            block_size=block_size,
        )
        # Create 4 tracks (DAW standard) — independent of physical channels
        # Each track can be routed to any physical output via output_channels bitmask
        from .track import Track
        for i in range(4):
            # Route to available output (wrap around if fewer physical channels)
            target_ch = min(i, max(0, self._output_channels - 1))
            track = Track(
                name=f"Pista {i+1}",
                volume=1.0,
                output_channels=1 << target_ch,
            )
            self.mixer.add_track(track)
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

        # Thread-safe queues: audio callback -> main thread
        self._beat_queue: queue.Queue = queue.Queue()
        self._levels_queue: queue.Queue = queue.Queue(maxsize=4)
        self._beat_timer = QTimer(self)
        self._beat_timer.timeout.connect(self._process_beat_queue)
        self._beat_timer.start(10)  # 100 Hz beat processing

    def _detect_device_channels(self) -> None:
        """Detect actual input/output channel counts from hardware."""
        try:
            info = sd.query_devices(self.device)
            self._input_channels = info.get("max_input_channels", self.channels)
            self._output_channels = info.get("max_output_channels", self.channels)
            print(f"[AUDIO] Device '{info['name']}': {self._input_channels} in, {self._output_channels} out")
        except Exception:
            print(f"[AUDIO] Could not query device; using defaults: {self._input_channels} in, {self._output_channels} out")
        # Clamp to requested channels
        self._input_channels = min(self._input_channels, self.channels)
        self._output_channels = min(self._output_channels, self.channels)

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

        # Build click output (only for available output channels)
        click_out = np.zeros((frames, self._output_channels), dtype=np.float32)
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

        # Calculate RMS levels for VU meters (from output)
        if self._output_channels > 0:
            levels = []
            for ch in range(min(self._output_channels, 4)):
                rms = np.sqrt(np.mean(mixed[:, ch] ** 2))
                # Convert to 0-1 range (assuming -60dB = 0, 0dB = 1)
                db = 20 * np.log10(max(rms, 1e-10))
                level = max(0.0, min(1.0, (db + 60) / 60))
                levels.append(level)
            # Pad to 4 channels if needed
            while len(levels) < 4:
                levels.append(0.0)
            try:
                self._levels_queue.put_nowait(levels)
            except queue.Full:
                pass

        # Recording (use input channels)
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
            # Queue beat for main thread emission (audio callback thread is NOT Qt)
            try:
                self._beat_queue.put_nowait((self._beat + 1, self._bpm))
            except queue.Full:
                pass

    def _process_beat_queue(self) -> None:
        """Process queued beats and levels from audio callback in main Qt thread."""
        # Process beats
        while not self._beat_queue.empty():
            try:
                beat_num, bpm = self._beat_queue.get_nowait()
                self.beat.emit(beat_num, bpm)
            except queue.Empty:
                break
        # Process levels (take latest only)
        latest_levels = None
        while not self._levels_queue.empty():
            try:
                latest_levels = self._levels_queue.get_nowait()
            except queue.Empty:
                break
        if latest_levels:
            self.levels.emit(latest_levels)

    def start(self) -> None:
        """Start audio stream."""
        if self._running:
            return
        try:
            self._stream = sd.Stream(
                samplerate=self.sample_rate,
                blocksize=self.block_size,
                device=self.device,
                channels=(self._input_channels, self._output_channels),
                dtype=np.float32,
                latency="low",
                callback=self._audio_callback,
            )
            self._stream.start()
            self._running = True
            self.started.emit()
            print(f"[AUDIO] Stream started: {self._input_channels} in / {self._output_channels} out @ {self.sample_rate} Hz")
        except Exception as e:
            print(f"[AUDIO] Failed to start: {e}")
            raise

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

    def start_recording(self, session_name: str, base_dir: str = None) -> str:
        """Start recording to disk."""
        if not self._running:
            self.start()
        self._recording = True
        return self.recorder.start(session_name, self._input_channels, base_dir)

    def stop_recording(self) -> None:
        """Stop recording."""
        self._recording = False
        self.recorder.stop()

    def is_running(self) -> bool:
        return self._running

    def is_recording(self) -> bool:
        return self.recorder.is_recording()
