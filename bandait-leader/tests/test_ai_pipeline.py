"""Tests for Sprint 4 AI Pipeline: Camelot Engine, Stems, and Voice Prompts."""

from src.ai.harmonic_engine import HarmonicEngine
from src.ai.stem_separator import StemSeparator, StemTaskStatus
from src.ai.voice_prompts import VoicePromptGenerator


def test_camelot_wheel_evaluations():
    # Test Camelot codes
    assert HarmonicEngine.get_camelot_code("Am") == "8A"
    assert HarmonicEngine.get_camelot_code("C") == "8B"
    assert HarmonicEngine.get_camelot_code("Em") == "9A"
    assert HarmonicEngine.get_camelot_code("Dm") == "7A"

    # Exact transition
    exact = HarmonicEngine.evaluate_transition("Am", "Am")
    assert exact.compatible is True
    assert exact.transition_type == "exact"
    assert exact.score == 100

    # Relative Major/Minor (8A <-> 8B)
    relative = HarmonicEngine.evaluate_transition("Am", "C")
    assert relative.compatible is True
    assert relative.transition_type == "relative"
    assert relative.score == 90

    # Adjacent Step (8A -> 9A)
    adjacent = HarmonicEngine.evaluate_transition("Am", "Em")
    assert adjacent.compatible is True
    assert adjacent.transition_type == "adjacent_step"
    assert adjacent.score == 85

    # Incompatible transition (e.g. Am to F#)
    incompatible = HarmonicEngine.evaluate_transition("Am", "F#")
    assert incompatible.compatible is False
    assert incompatible.transition_type == "incompatible"


def test_chordpro_formatter():
    formatted = HarmonicEngine.format_to_chordpro(
        title="Noche en Pereira",
        artist="Los Inquietos",
        bpm=124,
        key="Am",
        lines=[
            ("Am", "Noche de neón"),
            ("F", "Caminando lento"),
        ],
    )
    assert "{title: Noche en Pereira}" in formatted
    assert "{bpm: 124}" in formatted
    assert "[Am]Noche de neón" in formatted
    assert "[F]Caminando lento" in formatted


def test_stem_separation_pipeline():
    separator = StemSeparator()
    manifest = separator.queue_separation("song_100", "path/to/song_100.wav")
    assert manifest.status == StemTaskStatus.QUEUED

    completed = separator.process_mock_separation("song_100")
    assert completed.status == StemTaskStatus.COMPLETED
    assert completed.progress_percent == 100
    assert "drums" in completed.stems
    assert "bass" in completed.stems
    assert "vocals" in completed.stems
    assert "other" in completed.stems


def test_voice_prompt_generator():
    count_in = VoicePromptGenerator.generate_count_in(bars=2, beats_per_bar=4)
    assert len(count_in) == 4
    assert count_in[0].spoken_text == "1"
    assert count_in[-1].spoken_text == "4"

    cue = VoicePromptGenerator.generate_section_cue("Coro", target_bar=16, advance_bars=2)
    assert cue.bar_trigger == 14
    assert "Coro en 2 compases" in cue.spoken_text

    jump_cue = VoicePromptGenerator.generate_jump_cue("Medianoche en Pereira", 7)
    assert "Salto a tema 7" in jump_cue.spoken_text


if __name__ == "__main__":
    test_camelot_wheel_evaluations()
    test_chordpro_formatter()
    test_stem_separation_pipeline()
    test_voice_prompt_generator()
    print("ALL AI PIPELINE TESTS PASSED OK")
