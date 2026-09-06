"""Bandait 3.0 — In-Ear Voice Prompt Generator.

Generates structured audio cues and spoken telemetry for musician in-ear monitoring:
- Automatic count-ins (bars, bpm)
- Section cues ("Coro en 2 compases", "Solo de guitarra", "Corte final")
- Setlist jump emergency notifications
- Key change warnings
"""

from typing import List
from dataclasses import dataclass


@dataclass(frozen=True)
class VoiceCue:
    bar_trigger: int
    beat_trigger: int
    spoken_text: str
    cue_type: str  # "count_in", "section", "jump", "key_change"
    priority: int  # 1 (low) to 5 (critical)


class VoicePromptGenerator:
    """Generates voice prompts for musician in-ear monitoring channels."""

    @staticmethod
    def generate_count_in(bars: int = 2, beats_per_bar: int = 4) -> List[VoiceCue]:
        """Generate voice count-in for starting a track."""
        cues: List[VoiceCue] = []
        # Last bar count numbers
        for beat in range(1, beats_per_bar + 1):
            cues.append(VoiceCue(
                bar_trigger=bars,
                beat_trigger=beat,
                spoken_text=str(beat),
                cue_type="count_in",
                priority=4,
            ))
        return cues

    @staticmethod
    def generate_section_cue(section_name: str, target_bar: int, advance_bars: int = 2) -> VoiceCue:
        """Announce upcoming section (e.g. 'Coro en 2 compases')."""
        trigger_bar = max(1, target_bar - advance_bars)
        return VoiceCue(
            bar_trigger=trigger_bar,
            beat_trigger=1,
            spoken_text=f"{section_name} en {advance_bars} compases",
            cue_type="section",
            priority=3,
        )

    @staticmethod
    def generate_jump_cue(song_title: str, order_index: int) -> VoiceCue:
        """Emergency cue for unexpected setlist jump."""
        return VoiceCue(
            bar_trigger=1,
            beat_trigger=1,
            spoken_text=f"Salto a tema {order_index}: {song_title}",
            cue_type="jump",
            priority=5,
        )
