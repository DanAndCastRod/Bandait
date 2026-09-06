"""Bandait 3.0 — Harmonic Engine: Camelot Wheel & ChordPro Transcriber.

Calculates harmonic key compatibility (Camelot System 1A-12B),
optimal setlist transitions, and converts raw chord annotations into ChordPro format.
"""

from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass


# Standard Camelot mapping: Musical Key -> Camelot Code
KEY_TO_CAMELOT: Dict[str, str] = {
    # Minor Keys (A)
    "Abm": "1A", "G#m": "1A",
    "Ebm": "2A", "D#m": "2A",
    "Bbm": "3A", "A#m": "3A",
    "Fm": "4A",
    "Cm": "5A",
    "Gm": "6A",
    "Dm": "7A",
    "Am": "8A",
    "Em": "9A",
    "Bm": "10A",
    "F#m": "11A", "Gbm": "11A",
    "C#m": "12A", "Dbm": "12A",
    # Major Keys (B)
    "B": "1B", "Cb": "1B",
    "F#": "2B", "Gb": "2B",
    "Db": "3B", "C#": "3B",
    "Ab": "4B", "G#": "4B",
    "Eb": "5B", "D#": "5B",
    "Bb": "6B", "A#": "6B",
    "F": "7B",
    "C": "8B",
    "G": "9B",
    "D": "10B",
    "A": "11B",
    "E": "12B",
}

# Reverse mapping: Camelot Code -> Primary Key Name
CAMELOT_TO_KEY: Dict[str, str] = {
    "1A": "Abm", "1B": "B",
    "2A": "Ebm", "2B": "F#",
    "3A": "Bbm", "3B": "Db",
    "4A": "Fm",  "4B": "Ab",
    "5A": "Cm",  "5B": "Eb",
    "6A": "Gm",  "6B": "Bb",
    "7A": "Dm",  "7B": "F",
    "8A": "Am",  "8B": "C",
    "9A": "Em",  "9B": "G",
    "10A": "Bm", "10B": "D",
    "11A": "F#m","11B": "A",
    "12A": "C#m","12B": "E",
}


@dataclass
class KeyCompatibilityResult:
    compatible: bool
    transition_type: str  # "exact", "relative", "adjacent_step", "energy_boost", "incompatible"
    score: int  # 0 to 100
    description: str


class HarmonicEngine:
    """Provides Camelot wheel harmonic calculations and ChordPro formatting."""

    @staticmethod
    def get_camelot_code(key: str) -> Optional[str]:
        """Convert standard key notation (e.g. 'Am', 'C#m', 'F#') to Camelot code (e.g. '8A')."""
        clean = key.strip()
        return KEY_TO_CAMELOT.get(clean)

    @staticmethod
    def get_key_name(camelot: str) -> Optional[str]:
        """Convert Camelot code (e.g. '8A') to primary key name ('Am')."""
        return CAMELOT_TO_KEY.get(camelot.upper().strip())

    @classmethod
    def evaluate_transition(cls, key_from: str, key_to: str) -> KeyCompatibilityResult:
        """Evaluate musical transition smoothness between two keys using Camelot theory."""
        c1 = cls.get_camelot_code(key_from)
        c2 = cls.get_camelot_code(key_to)

        if not c1 or not c2:
            return KeyCompatibilityResult(
                compatible=False,
                transition_type="unknown_key",
                score=0,
                description=f"Tonalidad desconocida: '{key_from}' o '{key_to}'",
            )

        if c1 == c2:
            return KeyCompatibilityResult(
                compatible=True,
                transition_type="exact",
                score=100,
                description="Misma tonalidad. Transición perfectamente armónica.",
            )

        num1, letter1 = int(c1[:-1]), c1[-1]
        num2, letter2 = int(c2[:-1]), c2[-1]

        # Same number, different letter (Relative Major/Minor): 8A <-> 8B
        if num1 == num2 and letter1 != letter2:
            return KeyCompatibilityResult(
                compatible=True,
                transition_type="relative",
                score=90,
                description="Tonalidad relativa mayor/menor. Transición suave y natural.",
            )

        # Adjacent number, same letter: 8A -> 7A or 8A -> 9A (wrap 12 <-> 1)
        diff = abs(num1 - num2)
        if (diff == 1 or diff == 11) and letter1 == letter2:
            return KeyCompatibilityResult(
                compatible=True,
                transition_type="adjacent_step",
                score=85,
                description="Paso adyacente en rueda Camelot (+/- 1 quinta). Alta compatibilidad.",
            )

        # Energy boost modulation (+2 semitones or +7 on Camelot wheel)
        if (num2 - num1) % 12 == 2:
            return KeyCompatibilityResult(
                compatible=True,
                transition_type="energy_boost",
                score=75,
                description="Modulación de incremento de energía para directo (+2 semitonos).",
            )

        return KeyCompatibilityResult(
            compatible=False,
            transition_type="incompatible",
            score=30,
            description="Tonalidades armónicamente distantes. Requiere silencio o puente de modulación.",
        )

    @staticmethod
    def format_to_chordpro(
        title: str,
        artist: str,
        bpm: int,
        key: str,
        lines: List[Tuple[str, str]],
    ) -> str:
        """Convert list of (chord, lyric_text) pairs into standardized ChordPro syntax."""
        output = [
            f"{{title: {title}}}",
            f"{{artist: {artist}}}",
            f"{{bpm: {bpm}}}",
            f"{{key: {key}}}",
            "",
        ]

        for chord, lyric in lines:
            if chord and lyric:
                output.append(f"[{chord}]{lyric}")
            elif chord:
                output.append(f"[{chord}]")
            elif lyric:
                output.append(lyric)

        return "\n".join(output)
