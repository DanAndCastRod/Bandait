"""The leader's own click is phase-locked to the transport anchor."""

import numpy as np
import pytest

from src.audio.audio_engine import AudioEngine
from src.sync.transport_math import Segment

SR = 48000
NSPF = 1e9 / SR
BLOCK = 256
ANCHOR = 3_000_000_000_000


@pytest.fixture
def fake_devices(monkeypatch):
    import sounddevice as sd

    devices = {
        0: {"name": "Interfaz 4x4", "hostapi": 0, "max_input_channels": 0, "max_output_channels": 4,
            "default_samplerate": 48000},
        1: {"name": "Laptop", "hostapi": 0, "max_input_channels": 0, "max_output_channels": 2,
            "default_samplerate": 48000},
    }

    def query_devices(*args):
        if not args:
            return list(devices.values())
        return devices[args[0]]

    monkeypatch.setattr(sd, "query_devices", query_devices)
    monkeypatch.setattr(sd, "query_hostapis", lambda: [{"name": "Windows WASAPI"}])
    return devices


def render(engine, start_ns, n_blocks, nch):
    out = []
    for i in range(n_blocks):
        block = np.zeros((BLOCK, nch), dtype=np.float32)
        engine._render(None, block, BLOCK, start_ns + int(round(i * BLOCK * NSPF)))
        out.append(block)
    return np.concatenate(out)


def onsets(signal):
    idx = np.flatnonzero(np.abs(signal) > 1e-6)
    starts = [int(idx[0])] if len(idx) else []
    for a, b in zip(idx[:-1], idx[1:]):
        if b - a > 100:
            starts.append(int(b))
    return starts


def test_click_lands_on_anchor_plus_k_beats(qapp, fake_devices):
    engine = AudioEngine(sample_rate=SR, block_size=BLOCK, device=0)
    assert engine.output_channels == 4
    seg = Segment(ANCHOR, 120, 4, 1)
    engine.set_schedule((seg,))
    start = ANCHOR - 100_000_000  # 100 ms of silence before the first downbeat
    data = render(engine, start, int(2.2e9 / NSPF / BLOCK), 4)
    drummer = data[:, 2]
    found = onsets(drummer)
    assert len(found) >= 4
    for k, frame in enumerate(found[:4]):
        t = start + frame * NSPF
        assert abs(t - seg.click_time(k)) <= 0.51 * NSPF, f"click {k} off by {(t - seg.click_time(k)) / 1e3:.1f} us"
    # Accent on beat 1, normal level on the others.
    assert drummer[found[0]] == pytest.approx(0.8, abs=1e-4)
    assert drummer[found[1]] == pytest.approx(0.48, abs=1e-4)
    # PA disabled by default: nothing on Salidas 1-2.
    assert np.max(np.abs(data[:, :2])) == 0.0


def test_stop_cuts_the_click_immediately(qapp, fake_devices):
    engine = AudioEngine(sample_rate=SR, block_size=BLOCK, device=0)
    engine.set_schedule((Segment(ANCHOR, 120, 4, 1),))
    block = np.zeros((BLOCK, 4), dtype=np.float32)
    engine._render(None, block, BLOCK, ANCHOR)  # click starts
    assert np.max(block[:, 2]) > 0
    engine.set_schedule(())
    block2 = np.zeros((BLOCK, 4), dtype=np.float32)
    engine._render(None, block2, BLOCK, ANCHOR + int(BLOCK * NSPF))
    assert np.max(np.abs(block2)) == 0.0


def test_two_channel_device_never_leaks_click_to_pa(qapp, fake_devices):
    engine = AudioEngine(sample_rate=SR, block_size=BLOCK, device=1)
    assert engine.output_channels == 2 and not engine.drummer_click_available
    engine.set_schedule((Segment(ANCHOR, 120, 4, 1),))
    data = render(engine, ANCHOR - 1_000_000, 8, 2)
    assert np.max(np.abs(data)) == 0.0  # drummer click has no Out 3, PA click is off
    engine.enable_pa_click = True
    engine._last_click_ns = -1
    data = render(engine, ANCHOR - 1_000_000, 8, 2)
    assert np.max(data[:, 0]) > 0 and np.max(data[:, 1]) > 0


def test_tempo_change_switches_at_new_anchor_without_double_click(qapp, fake_devices):
    engine = AudioEngine(sample_rate=SR, block_size=BLOCK, device=0)
    old = Segment(ANCHOR, 120, 4, 1)
    new = Segment(ANCHOR + 2_000_000_000, 121, 4, 2)
    engine.set_schedule((old, new))
    start = ANCHOR + 1_400_000_000
    data = render(engine, start, int(1.2e9 / NSPF / BLOCK), 4)
    times = [start + f * NSPF for f in onsets(data[:, 2])]
    expected = [old.click_time(3), new.click_time(0), new.click_time(1)]
    assert len(times) >= 3
    for got, want in zip(times, expected):
        assert abs(got - want) <= 0.51 * NSPF


def test_callback_maps_stream_time_and_survives_bad_time_info(qapp, fake_devices):
    engine = AudioEngine(sample_rate=SR, block_size=BLOCK, device=0)

    class TimeInfo:
        currentTime = 0.0
        outputBufferDacTime = 0.0

    out = np.zeros((BLOCK, 4), dtype=np.float32)
    engine._output_callback(out, BLOCK, TimeInfo(), 0)  # zeros: falls back to perf + latency
    engine._output_callback(out, BLOCK, None, 0)
    assert engine.callback_errors == 0
    import time as _time

    ti = TimeInfo()
    ti.currentTime = _time.perf_counter()
    ti.outputBufferDacTime = ti.currentTime + 0.01
    engine._output_callback(out, BLOCK, ti, 0)
    assert engine.callback_errors == 0
    assert engine._stream_perf_offset_ns is not None
    # currentTime was taken from perf_counter: the estimated offset must be ~0.
    assert abs(engine._stream_perf_offset_ns) < 50_000_000
