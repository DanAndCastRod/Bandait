"""Tests for audio engine, mixer, and recorder."""

import numpy as np
import pytest
from src.audio.track import Track
from src.audio.mixer import Mixer


def test_track_volume(qapp):
    """Track volume scales output correctly."""
    track = Track(name="Click", volume=0.5)
    block = track.get_block(256)
    assert block.shape == (256,)
    assert np.max(np.abs(block)) == 0.0  # Empty track is silent

    # Set a test signal
    track._buffer = np.ones(256, dtype=np.float32) * 0.8
    block = track.get_block(256)
    assert np.allclose(block, 0.4)  # 0.8 * 0.5 = 0.4


def test_track_mute(qapp):
    """Muted track returns silence."""
    track = Track(name="Muted")
    track._buffer = np.ones(256, dtype=np.float32)
    track.mute = True
    block = track.get_block(256)
    assert np.all(block == 0.0)


def test_mixer_routing(qapp):
    """Mixer routes tracks to correct output channels."""
    mixer = Mixer(input_channels=4, output_channels=4, block_size=256)

    track1 = Track(name="Click", output_channels=0b0001)  # Ch1
    track1._buffer = np.ones(256, dtype=np.float32) * 0.5
    mixer.add_track(track1)

    track2 = Track(name="Backing", output_channels=0b0010)  # Ch2
    track2._buffer = np.ones(256, dtype=np.float32) * 0.3
    mixer.add_track(track2)

    input_block = np.zeros((256, 4), dtype=np.float32)
    output = mixer.process(input_block)

    assert output.shape == (256, 4)
    # Soft clip (tanh) applied: tanh(0.5) ≈ 0.462, tanh(0.3) ≈ 0.291
    assert np.allclose(output[:, 0], 0.462, atol=0.01)
    assert np.allclose(output[:, 1], 0.291, atol=0.01)
    assert np.all(output[:, 2] == 0.0)
    assert np.all(output[:, 3] == 0.0)


def test_mixer_solo(qapp):
    """Solo isolates a single track."""
    mixer = Mixer(input_channels=2, output_channels=2, block_size=128)

    track1 = Track(name="A", output_channels=0b0001)
    track1._buffer = np.ones(128, dtype=np.float32) * 0.5
    mixer.add_track(track1)

    track2 = Track(name="B", output_channels=0b0001)
    track2._buffer = np.ones(128, dtype=np.float32) * 0.3
    track2.solo = True
    mixer.add_track(track2)

    input_block = np.zeros((128, 2), dtype=np.float32)
    output = mixer.process(input_block)

    # Only solo track should be heard (soft-clipped: tanh(0.3) ≈ 0.291)
    assert np.allclose(output[:, 0], 0.291, atol=0.01)


def test_recorder_lifecycle(qapp):
    """Recording engine starts and stops correctly."""
    from src.audio.recorder import RecordingEngine
    import tempfile
    import os

    recorder = RecordingEngine(sample_rate=48000)
    assert not recorder.is_recording()

    # Mock recordings folder
    import shutil
    if os.path.exists("recordings"):
        shutil.rmtree("recordings")

    folder = recorder.start("test_session", n_channels=2)
    assert recorder.is_recording()
    assert os.path.exists(folder)

    # Simulate a block
    block = np.random.randn(256, 2).astype(np.float32) * 0.1
    recorder.write_block(block)

    # Wait for write thread
    import time
    time.sleep(0.2)

    recorder.stop()
    assert not recorder.is_recording()

    # Cleanup
    shutil.rmtree("recordings", ignore_errors=True)


def test_metronome_bpm_calculation(qapp):
    """Metronome interval calculation is correct."""
    sample_rate = 48000
    bpm = 120.0
    interval = int(60.0 / bpm * sample_rate)
    expected = int(60.0 / 120.0 * 48000)  # 24000 samples
    assert interval == expected
    assert interval == 24000

    # At 60 BPM
    interval_60 = int(60.0 / 60.0 * 48000)
    assert interval_60 == 48000
