"""Real-time hygiene of the audio callback, driven headless.

The PortAudio callback is called directly with fake time info and a fake
leader clock that advances exactly one block per call, so the run is
deterministic (same clicks every time) and needs no audio device. Checked:

- no memory growth over thousands of blocks (tracemalloc);
- no per-block sample-buffer temporaries (transient peak per block stays
  below the size of one block of one channel, measured with big blocks);
- GC-neutral: the callback never triggers a garbage collection by itself;
- bounded per-block time (generous bound: CI machines are noisy);
- still phase-correct and click-correct while doing all of the above.
"""

import gc
import statistics
import time
import tracemalloc

import numpy as np
import pytest

import src.audio.audio_engine as audio_engine
from src.audio.audio_engine import AudioEngine
from src.sync.transport_math import Segment, next_click

SR = 48000
BASE_NS = 1_000_000_000_000
ANCHOR = BASE_NS + 50_000_000
BPM = 180


@pytest.fixture
def fake_devices(monkeypatch):
    import sounddevice as sd

    devices = {
        0: {"name": "Interfaz 8x8", "hostapi": 0, "max_input_channels": 2, "max_output_channels": 8,
            "default_samplerate": SR},
    }

    def query_devices(*args):
        if not args:
            return list(devices.values())
        return devices[args[0]]

    monkeypatch.setattr(sd, "query_devices", query_devices)
    monkeypatch.setattr(sd, "query_hostapis", lambda: [{"name": "ASIO"}])
    return devices


class FakeTimeInfo:
    __slots__ = ("currentTime", "outputBufferDacTime", "inputBufferAdcTime")

    def __init__(self):
        self.currentTime = 0.0
        self.outputBufferDacTime = 0.0
        self.inputBufferAdcTime = 0.0


class Driver:
    """Calls the engine's PortAudio callback like PortAudio would, block after
    block, with a leader clock in lockstep with the stream clock."""

    def __init__(self, engine, monkeypatch, block, nch, duplex):
        self.engine = engine
        self.block = block
        self.block_ns = block * 1e9 / SR
        self.now = BASE_NS
        self.i = 0
        self.ti = FakeTimeInfo()
        self.out = np.zeros((block, nch), dtype=np.float32)
        self.inp = np.zeros((block, 2), dtype=np.float32) if duplex else None
        self.duplex = duplex
        monkeypatch.setattr(audio_engine, "leader_now_ns", lambda: self.now)

    def step(self):
        i = self.i
        self.i = i + 1
        start = BASE_NS + int(i * self.block_ns)
        self.now = start + 40_000  # callback entry 40 us after the stream clock tick
        stream_t = 100.0 + i * self.block_ns / 1e9
        self.ti.currentTime = stream_t
        self.ti.outputBufferDacTime = stream_t + 0.004
        self.ti.inputBufferAdcTime = stream_t - 0.004
        if self.duplex:
            self.engine._duplex_callback(self.inp, self.out, self.block, self.ti, 0)
        else:
            self.engine._output_callback(self.out, self.block, self.ti, 0)

    def run(self, n):
        for _ in range(n):
            self.step()


def make_engine(block):
    engine = AudioEngine(sample_rate=SR, block_size=block, device=0)
    engine.enable_pa_click = True  # worst case: click on Salidas 1, 2 and 3
    engine.set_schedule((Segment(ANCHOR, BPM, 4, 1),))
    return engine


def expected_clicks(n_blocks, block):
    """Clicks whose leader time falls inside the rendered span (DAC time)."""
    sched = (Segment(ANCHOR, BPM, 4, 1),)
    first_dac = BASE_NS + 40_000 + 4_000_000  # mapping: dac = stream dac + (perf - stream)
    end = first_dac + int(n_blocks * block * 1e9 / SR)
    count, t = 0, first_dac - 5_000_000
    while True:
        nxt = next_click(sched, t)
        if nxt is None or nxt[0] >= end:
            return count
        if nxt[0] >= first_dac:
            count += 1
        t = nxt[0] + 1


@pytest.mark.parametrize("duplex", [False, True], ids=["salida", "entrada+salida"])
def test_callback_does_not_grow_memory_or_feed_the_gc(qapp, fake_devices, monkeypatch, duplex):
    block, nch, n = 256, 8, 6000  # 6000 blocks = 32 s of audio
    engine = make_engine(block)
    drv = Driver(engine, monkeypatch, block, nch, duplex)
    drv.run(1000)  # warm-up: first click, numpy caches, offset filter

    collections = []

    def on_gc(phase, info):
        if phase == "start":
            collections.append(info["generation"])

    gc.collect()
    gc.callbacks.append(on_gc)
    tracemalloc.start()
    try:
        drv.run(500)
        before = tracemalloc.get_traced_memory()[0]
        gen0_before = gc.get_count()[0]
        drv.run(n)
        growth = tracemalloc.get_traced_memory()[0] - before
        gen0_delta = gc.get_count()[0] - gen0_before
    finally:
        tracemalloc.stop()
        gc.callbacks.remove(on_gc)

    assert engine.callback_errors == 0
    assert growth < 1024, f"the callback leaked {growth} bytes over {n} blocks"
    # Net zero container allocations: the collector is never pushed by audio.
    assert collections == [], f"the callback triggered collections {collections}"
    assert abs(gen0_delta) < 50
    assert engine._click_seq == expected_clicks(drv.i, block)


def test_no_per_block_buffer_temporaries(qapp, fake_devices, monkeypatch):
    # Big blocks make any temporary sample buffer obvious: one channel of one
    # block is 4 KB, while views and small ints stay well under 3 KB.
    block, nch = 1024, 8
    engine = make_engine(block)
    drv = Driver(engine, monkeypatch, block, nch, duplex=False)
    drv.run(300)
    one_channel = block * 4
    peaks = []
    tracemalloc.start()
    try:
        for _ in range(400):
            tracemalloc.reset_peak()
            base = tracemalloc.get_traced_memory()[0]
            drv.step()
            peaks.append(tracemalloc.get_traced_memory()[1] - base)
    finally:
        tracemalloc.stop()
    assert engine.callback_errors == 0
    assert engine._click_seq > 10  # clicks were rendered during the measurement
    assert max(peaks) < one_channel, f"per-block transient peak {max(peaks)} B"


def test_per_block_time_is_bounded(qapp, fake_devices, monkeypatch):
    block, nch = 256, 8
    budget_ns = block * 1e9 / SR  # 5.33 ms
    engine = make_engine(block)
    drv = Driver(engine, monkeypatch, block, nch, duplex=True)
    drv.run(500)
    times = []
    for _ in range(4000):
        t0 = time.perf_counter_ns()
        drv.step()
        times.append(time.perf_counter_ns() - t0)
    times.sort()
    median = statistics.median(times)
    p95 = times[int(0.95 * len(times))]
    assert engine.callback_errors == 0
    # Typical laptop: ~40 us median (<1% of the budget). The bounds catch a
    # regression (per-sample Python loops, reductions, logging) without
    # flaking on a busy CI runner.
    assert median < 0.25 * budget_ns, f"median {median / 1e3:.0f} us per block"
    assert p95 < budget_ns, f"p95 {p95 / 1e3:.0f} us per block"


def test_click_waveforms_are_prerendered_and_read_only(qapp, fake_devices):
    engine = make_engine(256)
    for arr in (engine._click_accent, engine._click_normal):
        assert arr.dtype == np.float32 and not arr.flags.writeable
        assert arr.shape == (engine._click_duration,)
    assert engine._click_accent[0] == pytest.approx(0.8)
    assert engine._click_normal[0] == pytest.approx(0.48)


def test_meter_levels_are_computed_on_the_qt_side(qapp, fake_devices, monkeypatch):
    engine = make_engine(256)
    engine.enable_pa_click = False  # click only on Salida 3
    drv = Driver(engine, monkeypatch, 256, 8, duplex=False)
    seen = []
    engine.levels.connect(seen.append)
    # Render until the first click is in the meter buffer.
    while engine._click_seq == 0:
        drv.step()
    engine._poll_callback_state()
    assert seen, "no levels were emitted"
    levels = seen[-1]
    assert len(levels) == 4
    assert levels[2] > 0.3  # the click, Salida 3 (~0.57 for a 256-frame block)
    assert levels[0] == 0.0 and levels[1] == 0.0  # PA click is off
