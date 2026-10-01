"""Leader audio engine: phase-locked click, mixer and recorder.

Phase lock
----------
The click is not a free-running sample counter. ClockService hands the engine
the transport ``Schedule`` (anchor_ns, bpm, beats_per_bar, bar_offset, as
published to followers). In every callback the engine computes the leader time
at which the first frame of the buffer reaches the DAC:

    dac_leader_ns = outputBufferDacTime (PortAudio stream clock)
                    + stream->leader offset (min-filtered per callback)

(the leader clock is time.perf_counter_ns(); on Windows PortAudio's stream
clock is QueryPerformanceCounter too, so the offset is ~0 plus the callback
entry delay that the min filter removes)

and starts click k at the frame where ``anchor_ns + k * beat_ns`` falls, so the
FOH click and the followers' clicks land on the same leader instant.

Realtime rules for the callback: no locks, no queues, no logging, no prints,
no sample-buffer allocation (everything is preallocated). Python itself still
creates small int/float objects; that is unavoidable in a Python callback.
Communication with the Qt thread uses single-writer attributes and counters
that the Qt thread polls.

Routing: Salidas 1-2 = PA (FOH), Salida 3 (channel index 2) = drummer click.
Fallback on devices with fewer than 3 outputs: the drummer click has nowhere to
go and is NOT sent to Salidas 1-2 (that would put the click in the PA). Enable
"Clic en PA (Salidas 1-2)" to hear it there, e.g. on a laptop with headphones.
"""

from __future__ import annotations

import os
from typing import Optional

import numpy as np
from PySide6.QtCore import QObject, QTimer, Signal

from src.sync.leader_clock import leader_now_ns
from src.sync.transport_math import EMPTY_SCHEDULE, Schedule, next_click

from .mixer import Mixer
from .recorder import RecordingEngine
from .track import Track

try:  # PortAudio may be missing on CI machines; the leader must still start.
    import sounddevice as sd
except Exception:  # pragma: no cover - depends on the host
    sd = None

MAX_OPEN_OUTPUTS = 64
DRUMMER_CHANNEL = 2  # Salida 3
_LATE_TOLERANCE_NS = 5_000_000
_OFFSET_LEAK_NS = 2_000
_OFFSET_RESET_NS = 50_000_000


class AudioUnavailable(RuntimeError):
    """The audio stream cannot be opened (no PortAudio, no device, disabled)."""


def audio_disabled_by_env() -> bool:
    return os.environ.get("BANDAIT_AUDIO_DISABLED", "").strip().lower() in ("1", "true", "yes")


class AudioEngine(QObject):
    """Low-latency audio engine with phase-locked click, mixing and recording."""

    started = Signal()
    stopped = Signal()
    recording_started = Signal(str)
    recording_stopped = Signal()
    error = Signal(str)

    # Emitted from the Qt thread when the callback has started an audible click.
    beat = Signal(int, float)  # beat number (1..beats_per_bar), bpm
    levels = Signal(list)  # [ch0_level, ch1_level, ch2_level, ch3_level] 0.0-1.0

    def __init__(
        self,
        sample_rate: int = 48000,
        block_size: int = 256,
        channels: Optional[int] = None,
        device: Optional[int] = None,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.sample_rate = sample_rate
        self.block_size = block_size
        # ``channels`` caps the outputs opened; None = everything the device has.
        self.channels = channels
        self.device = device
        self.input_device: Optional[int] = None

        # Stage routing flags: Salidas 1-2 PA (FOH), Salida 3 cable a baterista
        self.enable_drummer_click = True
        self.enable_pa_click = False

        self._input_channels = 0
        self._output_channels = 2
        self._device_name = "Sin dispositivo"
        self._hostapi_name = ""
        self._detect_device_channels()

        self.mixer = self._build_mixer()
        self.recorder = RecordingEngine(sample_rate=sample_rate)
        self.recorder.recording_started.connect(self.recording_started)
        self.recorder.recording_stopped.connect(self.recording_stopped)

        self._stream = None
        self._stream_has_input = False
        self._running = False
        self._recording = False

        # Transport schedule (tuple swap = atomic, read once per callback).
        self._schedule: Schedule = EMPTY_SCHEDULE
        self._bpm = 120.0

        # Clock mapping: stream time -> leader time (perf_counter_ns)
        self._stream_perf_offset_ns: Optional[int] = None
        self._out_latency_ns = 0
        self._ns_per_frame = 1e9 / float(sample_rate)

        # Click waveforms (accent on beat 1) and playback state.
        self._click_duration = int(0.05 * sample_rate)  # 50 ms
        self._click = self._generate_click()
        self._click_accent = self._click.copy()
        self._click_normal = (self._click * 0.6).astype(np.float32)
        self._click_arr = self._click_normal
        self._click_pos = self._click_duration  # >= len means idle
        self._last_click_ns = -1
        self._schedule_was_set = False

        # Callback -> Qt thread (single writer each, polled by a timer).
        self._levels_ms = np.zeros(4, dtype=np.float64)
        self._scratch = np.zeros((max(block_size, 4096), 4), dtype=np.float32)
        self._zero_input = np.zeros((max(block_size, 4096), 1), dtype=np.float32)
        self._levels_seq = 0
        self._levels_seen = 0
        self._click_seq = 0
        self._click_seen = 0
        self._click_beat = 1
        self.xruns = 0
        self.callback_errors = 0

        self._poll_timer = QTimer(self)
        self._poll_timer.timeout.connect(self._poll_callback_state)
        self._poll_timer.start(20)

    # ------------------------------------------------------------------ devices
    @staticmethod
    def get_audio_devices() -> list[dict]:
        """Query all available host audio devices."""
        if sd is None:
            return []
        try:
            devices = sd.query_devices()
            hostapis = sd.query_hostapis()
            results = []
            for idx, dev in enumerate(devices):
                api_idx = dev.get("hostapi")
                api_name = hostapis[api_idx]["name"] if api_idx is not None else "Unknown"
                results.append({
                    "id": idx,
                    "name": dev["name"],
                    "hostapi": api_name,
                    "max_inputs": dev.get("max_input_channels", 0),
                    "max_outputs": dev.get("max_output_channels", 0),
                    "default_samplerate": dev.get("default_samplerate", 48000),
                    "is_asio": "asio" in api_name.lower() or "asio" in dev["name"].lower(),
                })
            return results
        except Exception:
            return []

    @classmethod
    def get_output_devices(cls) -> list[dict]:
        return [d for d in cls.get_audio_devices() if d["max_outputs"] > 0]

    @classmethod
    def get_asio_devices(cls) -> list[dict]:
        """Return ASIO interfaces, or multi-channel devices (>= 3 outputs) if none."""
        all_devs = cls.get_audio_devices()
        asio_devs = [d for d in all_devs if d["is_asio"]]
        if asio_devs:
            return asio_devs
        return [d for d in all_devs if d["max_outputs"] >= 3]

    @classmethod
    def find_output_device(cls, name: Optional[str], hostapi: Optional[str]) -> Optional[int]:
        """Resolve a persisted (name, host API) pair to the current PortAudio index."""
        if not name:
            return None
        candidates = [d for d in cls.get_output_devices() if d["name"] == name]
        if hostapi:
            exact = [d for d in candidates if d["hostapi"] == hostapi]
            if exact:
                return exact[0]["id"]
        return candidates[0]["id"] if candidates else None

    def _default_output_index(self) -> Optional[int]:
        if sd is None:
            return None
        try:
            idx = sd.default.device[1]
            return int(idx) if idx is not None and int(idx) >= 0 else None
        except Exception:
            return None

    def _default_input_index(self) -> Optional[int]:
        if sd is None:
            return None
        try:
            idx = sd.default.device[0]
            return int(idx) if idx is not None and int(idx) >= 0 else None
        except Exception:
            return None

    def _detect_device_channels(self) -> None:
        """Open as many outputs as the device has (capped), plus a usable input."""
        self._input_channels = 0
        self.input_device = None
        if sd is None:
            self._output_channels = 2
            self._device_name = "Sin PortAudio"
            return
        out_idx = self.device if self.device is not None else self._default_output_index()
        try:
            info = sd.query_devices(out_idx) if out_idx is not None else None
        except Exception:
            info = None
        if not info:
            self._output_channels = 2
            self._device_name = "Sin dispositivo"
            return
        max_out = int(info.get("max_output_channels", 2) or 0)
        cap = self.channels if self.channels else MAX_OPEN_OUTPUTS
        self._output_channels = max(1, min(max_out, cap, MAX_OPEN_OUTPUTS)) if max_out else 0
        self._device_name = str(info.get("name", "Dispositivo"))
        hostapi_idx = info.get("hostapi")
        try:
            self._hostapi_name = sd.query_hostapis()[hostapi_idx]["name"] if hostapi_idx is not None else ""
        except Exception:
            self._hostapi_name = ""
        # Input: the same device if it has inputs, else the default input of the
        # same host API (PortAudio cannot open duplex across host APIs).
        max_in = int(info.get("max_input_channels", 0) or 0)
        if max_in > 0:
            self.input_device = out_idx
            self._input_channels = min(max_in, cap, 8)
            return
        in_idx = self._default_input_index()
        if in_idx is None:
            return
        try:
            in_info = sd.query_devices(in_idx)
        except Exception:
            return
        if in_info and in_info.get("hostapi") == hostapi_idx:
            self.input_device = in_idx
            self._input_channels = min(int(in_info.get("max_input_channels", 0) or 0), 8)

    def _build_mixer(self) -> Mixer:
        mixer = Mixer(
            input_channels=max(1, self._input_channels),
            output_channels=max(1, self._output_channels),
            block_size=self.block_size,
        )
        # 4 tracks (DAW standard), routed to the physical outputs available.
        for i in range(4):
            target_ch = min(i, max(0, self._output_channels - 1))
            mixer.add_track(Track(name=f"Pista {i+1}", volume=1.0, output_channels=1 << target_ch))
        return mixer

    def set_device(self, device_id: Optional[int], channels: Optional[int] = None) -> None:
        """Select an output device. Restarts the stream if it was running; the
        schedule is absolute leader time, so the click stays phase-locked."""
        was_running = self._running
        if was_running:
            self.stop()
        self.device = device_id
        self.channels = channels
        self._detect_device_channels()
        self.mixer = self._build_mixer()
        if was_running:
            self.start()

    @property
    def output_channels(self) -> int:
        return self._output_channels

    @property
    def input_channels(self) -> int:
        return self._input_channels if self._stream_has_input or not self._running else 0

    @property
    def device_name(self) -> str:
        return self._device_name

    @property
    def hostapi_name(self) -> str:
        return self._hostapi_name

    @property
    def drummer_click_available(self) -> bool:
        return self._output_channels > DRUMMER_CHANNEL

    # ------------------------------------------------------------------ click
    def _generate_click(self) -> np.ndarray:
        """Short click (impulse + exponential decay)."""
        n = np.arange(self._click_duration, dtype=np.float32)
        click = (0.8 * np.power(0.3, n)).astype(np.float32)
        return click

    def set_schedule(self, schedule: Schedule) -> None:
        """Called on the Qt thread. A single reference swap: the callback reads
        the tuple once per block, so it never sees a half-updated schedule."""
        sched = tuple(schedule) if schedule else EMPTY_SCHEDULE
        if sched:
            self._bpm = float(sched[-1].bpm)
        self._schedule = sched

    def set_bpm(self, bpm: float) -> None:
        """Display BPM only. Tempo changes go through TEMPO_NUDGE."""
        self._bpm = float(bpm)

    # ------------------------------------------------------------------ callback
    def _duplex_callback(self, indata, outdata, frames, time_info, status) -> None:
        self._process(indata, outdata, frames, time_info, status)

    def _output_callback(self, outdata, frames, time_info, status) -> None:
        self._process(None, outdata, frames, time_info, status)

    def _process(self, indata, outdata, frames, time_info, status) -> None:
        try:
            if status:
                self.xruns += 1
            perf_now = leader_now_ns()
            cur = 0.0
            dac = 0.0
            if time_info is not None:
                cur = time_info.currentTime
                dac = time_info.outputBufferDacTime
            if cur > 0.0 and dac > 0.0:
                sample = perf_now - int(cur * 1e9)
                est = self._stream_perf_offset_ns
                if est is None or sample < est + _OFFSET_LEAK_NS or sample - est > _OFFSET_RESET_NS:
                    est = sample
                else:
                    est = est + _OFFSET_LEAK_NS
                self._stream_perf_offset_ns = est
                dac_perf = int(dac * 1e9) + est
            else:
                dac_perf = perf_now + self._out_latency_ns
            self._render(indata, outdata, frames, dac_perf)
        except Exception:
            self.callback_errors += 1
            outdata.fill(0.0)

    def _render(self, indata, outdata, frames: int, block_start_ns: int) -> None:
        """Fill ``outdata`` for a block whose first frame plays at block_start_ns
        (leader time). Separated from the callback so tests can drive it."""
        nch = outdata.shape[1]
        if indata is None:
            if self._zero_input.shape[0] < frames:
                self._zero_input = np.zeros((frames, 1), dtype=np.float32)
            src = self._zero_input[:frames]
        else:
            src = indata
        mixed = self.mixer.process(src)
        if mixed.shape[1] == nch:
            outdata[:] = mixed
        else:
            outdata.fill(0.0)
            k = min(nch, mixed.shape[1])
            outdata[:, :k] = mixed[:, :k]

        drummer = self.enable_drummer_click and nch > DRUMMER_CHANNEL
        pa = self.enable_pa_click

        # Tail of a click that started in a previous block.
        click_len = self._click_duration
        if self._click_pos < click_len:
            n = min(frames, click_len - self._click_pos)
            self._write_click(outdata, 0, self._click_arr, self._click_pos, n, drummer, pa)
            self._click_pos += n

        sched = self._schedule
        if sched:
            self._schedule_was_set = True
            nspf = self._ns_per_frame
            block_end = block_start_ns + int(frames * nspf)
            search = block_start_ns - _LATE_TOLERANCE_NS
            if self._last_click_ns >= search:
                search = self._last_click_ns + 1
            for _ in range(4):
                nxt = next_click(sched, search)
                if nxt is None or nxt[0] >= block_end:
                    break
                when, beat, downbeat = nxt
                # Nearest frame (error <= half a sample). A click that rounds
                # past the end of this block starts at frame 0 of the next one.
                start = int(round((when - block_start_ns) / nspf))
                if start >= frames:
                    break
                if start < 0:
                    start = 0
                arr = self._click_accent if downbeat else self._click_normal
                n = min(click_len, frames - start)
                if n > 0:
                    self._write_click(outdata, start, arr, 0, n, drummer, pa)
                self._click_arr = arr
                self._click_pos = n
                self._last_click_ns = when
                self._click_beat = beat
                self._click_seq += 1
                search = when + 1
        elif self._schedule_was_set:
            # STOP / PAUSE / PANIC: cut the ringing click immediately.
            self._schedule_was_set = False
            self._click_pos = click_len

        np.clip(outdata, -1.0, 1.0, out=outdata)

        # Levels (mean square of up to 4 outputs) for the VU meters.
        k = nch if nch < 4 else 4
        if self._scratch.shape[0] >= frames:
            sq = self._scratch[:frames, :k]
            np.square(outdata[:, :k], out=sq)
            np.mean(sq, axis=0, out=self._levels_ms[:k])
            self._levels_seq += 1

        if self._recording and indata is not None:
            self.recorder.write_block(indata)

    @staticmethod
    def _write_click(outdata, start: int, arr, offset: int, n: int, drummer: bool, pa: bool) -> None:
        chunk = arr[offset : offset + n]
        if drummer:
            outdata[start : start + n, DRUMMER_CHANNEL] += chunk
        if pa:
            outdata[start : start + n, 0] += chunk
            if outdata.shape[1] > 1:
                outdata[start : start + n, 1] += chunk

    # ------------------------------------------------------------------ Qt-side polling
    def _poll_callback_state(self) -> None:
        if self._click_seq != self._click_seen:
            self._click_seen = self._click_seq
            self.beat.emit(int(self._click_beat), float(self._bpm))
        if self._levels_seq != self._levels_seen:
            self._levels_seen = self._levels_seq
            out = []
            for ms in self._levels_ms:
                rms = float(np.sqrt(ms)) if ms > 0 else 0.0
                db = 20 * np.log10(max(rms, 1e-10))
                out.append(max(0.0, min(1.0, (db + 60) / 60)))
            self.levels.emit(out)

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        """Open and start the stream. Raises AudioUnavailable on failure."""
        if self._running:
            return
        if audio_disabled_by_env():
            raise AudioUnavailable("Audio deshabilitado (BANDAIT_AUDIO_DISABLED)")
        if sd is None:
            raise AudioUnavailable("PortAudio no esta disponible en este equipo")
        if self._output_channels <= 0:
            raise AudioUnavailable(f"'{self._device_name}' no tiene salidas")
        out_idx = self.device if self.device is not None else self._default_output_index()
        stream = None
        errors = []
        if self._input_channels > 0:
            try:
                stream = sd.Stream(
                    samplerate=self.sample_rate,
                    blocksize=self.block_size,
                    device=(self.input_device, out_idx),
                    channels=(self._input_channels, self._output_channels),
                    dtype="float32",
                    latency="low",
                    callback=self._duplex_callback,
                )
                self._stream_has_input = True
            except Exception as exc:
                errors.append(f"entrada+salida: {exc}")
                stream = None
        if stream is None:
            try:
                stream = sd.OutputStream(
                    samplerate=self.sample_rate,
                    blocksize=self.block_size,
                    device=out_idx,
                    channels=self._output_channels,
                    dtype="float32",
                    latency="low",
                    callback=self._output_callback,
                )
                self._stream_has_input = False
            except Exception as exc:
                errors.append(f"salida: {exc}")
                raise AudioUnavailable("; ".join(errors)) from exc
        self._ns_per_frame = 1e9 / float(stream.samplerate)
        try:
            latency = stream.latency
            out_latency = latency[1] if isinstance(latency, (tuple, list)) else latency
            self._out_latency_ns = int(float(out_latency) * 1e9)
        except Exception:
            self._out_latency_ns = 0
        self._stream_perf_offset_ns = None
        self._last_click_ns = -1
        self._click_pos = self._click_duration
        try:
            stream.start()
        except Exception as exc:
            try:
                stream.close()
            except Exception:
                pass
            raise AudioUnavailable(str(exc)) from exc
        self._stream = stream
        self._running = True
        self.started.emit()

    def stop(self) -> None:
        """Stop and close the audio stream."""
        stream = self._stream
        self._stream = None
        if stream is not None:
            try:
                stream.stop()
            except Exception:
                pass
            try:
                stream.close()
            except Exception:
                pass
        was_running = self._running
        self._running = False
        if self._recording:
            self.stop_recording()
        if was_running:
            self.stopped.emit()

    def shutdown(self) -> None:
        self._poll_timer.stop()
        self.stop()

    def start_recording(self, session_name: str, base_dir: str = None) -> str:
        """Start recording the input channels to disk."""
        if not self._running:
            self.start()
        if not self._stream_has_input or self._input_channels <= 0:
            raise AudioUnavailable("El dispositivo actual no tiene entradas para grabar")
        folder = self.recorder.start(session_name, self._input_channels, base_dir)
        self._recording = True
        return folder

    def stop_recording(self) -> None:
        self._recording = False
        self.recorder.stop()

    def is_running(self) -> bool:
        return self._running

    def is_recording(self) -> bool:
        return self.recorder.is_recording()
