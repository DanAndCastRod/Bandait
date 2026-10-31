"""Stems in the audio engine: sample-accurate against the schedule, gains, realtime hygiene."""

import tracemalloc

import numpy as np
import pytest

from src.audio.audio_engine import AudioEngine
from src.sync.transport_math import Segment

SR = 48000
BLOCK = 256
ANCHOR = 10_000_000_000  # leader ns of beat 0 of the segment
BPM = 120.0  # 0.5 s per beat, 2 s per 4/4 bar


@pytest.fixture
def engine(monkeypatch):
    import sounddevice as sd

    dev = {"name": "Interfaz 8x8", "hostapi": 0, "max_input_channels": 2, "max_output_channels": 8,
           "default_samplerate": SR}
    monkeypatch.setattr(sd, "query_devices", lambda *a: dev if a else [dev])
    monkeypatch.setattr(sd, "query_hostapis", lambda: [{"name": "ASIO"}])
    eng = AudioEngine(sample_rate=SR, block_size=BLOCK, device=0)
    eng.enable_pa_click = False
    eng.enable_drummer_click = False
    return eng


def impulse_stem(at_frame, n=SR * 20, value=16000):
    data = np.zeros((n, 2), dtype=np.int16)
    data[at_frame] = value
    return data


def render(engine, start_ns, seconds):
    """Render consecutive blocks from leader time start_ns; returns Salida 1 and its first frame's time."""
    frames = int(seconds * SR)
    out = np.zeros((frames // BLOCK * BLOCK, 8), dtype=np.float32)
    ns_per_frame = 1e9 / SR
    for b in range(out.shape[0] // BLOCK):
        block = np.zeros((BLOCK, 8), dtype=np.float32)
        engine._render(None, block, BLOCK, start_ns + int(b * BLOCK * ns_per_frame))
        out[b * BLOCK:(b + 1) * BLOCK] = block
    return out


def first_hit(channel):
    hits = np.flatnonzero(np.abs(channel) > 0.1)
    return int(hits[0]) if hits.size else None


def test_stem_starts_on_bar_one_after_the_count_in(engine):
    # Two bars of count-in: bar_offset = 1 - 2, so bar 1 starts 2 bars (4 s) after the anchor.
    engine.set_schedule((Segment(ANCHOR, BPM, 4, -1),))
    engine.set_stems([impulse_stem(SR)], [1.0], ref_bpm=BPM)  # 1 s into the song
    start = ANCHOR - 500_000_000
    out = render(engine, start, 6.0)
    expected = int(round((4.0 + 1.0 + 0.5) * SR))  # from start: 0.5 s lead + 4 s count-in + 1 s
    assert first_hit(out[:, 0]) == expected
    assert first_hit(out[:, 1]) == expected
    assert np.all(out[:, 2] == 0)  # never on the drummer output
    assert out[expected, 0] == pytest.approx(16000 / 32768, abs=1e-4)


def test_resume_from_a_paused_bar_and_offset(engine):
    # PLAY after PAUSE at bar 3: the segment starts at bar 3 -> song time 4 s at the anchor.
    engine.set_schedule((Segment(ANCHOR, BPM, 4, 3),))
    engine.set_stems([impulse_stem(int(4.25 * SR))], [1.0], ref_bpm=BPM, offset_ms=-250)
    out = render(engine, ANCHOR, 1.0)
    # With -250 ms of offset the impulse at 4.25 s of audio plays at song time 4.5 s.
    assert first_hit(out[:, 0]) == int(0.5 * SR)


def test_gains_mute_and_stop(engine):
    engine.set_schedule((Segment(ANCHOR, BPM, 4, 1),))
    a, b = impulse_stem(SR // 2), impulse_stem(SR // 2, value=8000)
    engine.set_stems([a, b], [1.0, 0.0], ref_bpm=BPM)  # b muted
    out = render(engine, ANCHOR, 1.0)
    assert out[SR // 2, 0] == pytest.approx(16000 / 32768, abs=1e-4)
    engine.set_stem_gains([0.5, 1.0])
    engine.set_schedule((Segment(ANCHOR, BPM, 4, 1),))  # PLAY again from bar 1 (new schedule)
    out = render(engine, ANCHOR, 1.0)
    assert out[SR // 2, 0] == pytest.approx((8000 + 8000) / 32768, abs=1e-4)
    engine.set_schedule(())  # STOP: stems go silent with the click
    assert not np.any(render(engine, ANCHOR, 1.0))
    engine.clear_stems()
    engine.set_schedule((Segment(ANCHOR, BPM, 4, 1),))
    assert not engine.has_stems() and not np.any(render(engine, ANCHOR, 1.0))


def test_free_run_without_jumps_when_bpm_differs(engine):
    # Song BPM 120 in the hub, recording really at 121: the stem must play smoothly
    # (no realignment mid-song), and realign on the next schedule change.
    ramp = (np.arange(SR * 10, dtype=np.int64) % 30000).astype(np.int16)
    engine.set_schedule((Segment(ANCHOR, BPM, 4, 1),))
    engine.set_stems([np.stack([ramp, ramp], axis=1)], [1.0], ref_bpm=121.0)
    out = render(engine, ANCHOR, 4.0)[:, 0]
    steps = np.diff(np.round(out * 32768).astype(np.int64))
    assert set(np.unique(steps)) <= {1, -29999}  # consecutive samples, wrap of the ramp only
    # A new schedule (PLAY again from bar 1) realigns the pointer.
    engine.set_schedule((Segment(ANCHOR + 10_000_000_000, BPM, 4, 1),))
    out2 = render(engine, ANCHOR + 10_000_000_000, 0.1)[:, 0]
    assert round(out2[0] * 32768) == 0


def test_stems_do_not_allocate_per_block(engine):
    engine.set_schedule((Segment(ANCHOR, BPM, 4, 1),))
    stems = [np.random.default_rng(i).integers(-8000, 8000, (SR * 60, 2), dtype=np.int16) for i in range(5)]
    engine.set_stems(stems, [1.0, 0.8, 0.6, 0.4, 0.2], ref_bpm=BPM)
    block = np.zeros((1024, 8), dtype=np.float32)
    t = ANCHOR
    step = int(1024 * 1e9 / SR)
    for _ in range(200):  # warm-up
        engine._render(None, block, 1024, t)
        t += step
    one_channel = 1024 * 4
    peaks = np.zeros(500, dtype=np.int64)  # preallocated: appending to a list would be measured too
    tracemalloc.start()
    try:
        for i in range(500):
            tracemalloc.reset_peak()
            base = tracemalloc.get_traced_memory()[0]
            engine._render(None, block, 1024, t)
            t += step
            peaks[i] = tracemalloc.get_traced_memory()[1] - base
        before = tracemalloc.get_traced_memory()[0]
        for _ in range(1500):
            engine._render(None, block, 1024, t)
            t += step
        growth = tracemalloc.get_traced_memory()[0] - before
    finally:
        tracemalloc.stop()
    assert engine.stem_frames_played > 0
    assert max(peaks) < one_channel, f"per-block transient peak {max(peaks)} B"
    assert growth < 1024
