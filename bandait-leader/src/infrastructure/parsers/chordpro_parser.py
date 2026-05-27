"""ChordPro file parser for songs with chords and lyrics."""

import re
from dataclasses import dataclass
from typing import List, Dict, Optional


@dataclass
class ChordSegment:
    chord: str
    position: int  # character position in line


@dataclass
class SongSection:
    label: str  # Verse, Chorus, Intro, etc.
    lines: List[str]
    chords: List[List[ChordSegment]]  # chords per line


class ChordProParser:
    """Parse ChordPro format: [C]lyric [Am]text."""

    CHORD_RE = re.compile(r"\[([^\]]+)\]")

    @classmethod
    def parse(cls, content: str) -> Dict[str, any]:
        sections: List[SongSection] = []
        current_label = "Unknown"
        current_lines: List[str] = []
        current_chords: List[List[ChordSegment]] = []

        directives = {}

        for raw in content.splitlines():
            raw = raw.strip()
            if not raw:
                if current_lines:
                    sections.append(
                        SongSection(current_label, current_lines, current_chords)
                    )
                    current_lines = []
                    current_chords = []
                continue

            # Directives
            if raw.startswith("{") and raw.endswith("}"):
                inner = raw[1:-1].strip()
                if ":" in inner:
                    key, value = inner.split(":", 1)
                    directives[key.strip().lower()] = value.strip()
                elif inner.lower() in ("soc", "start_of_chorus"):
                    current_label = "Chorus"
                elif inner.lower() in ("eoc", "end_of_chorus"):
                    if current_lines:
                        sections.append(
                            SongSection(current_label, current_lines, current_chords)
                        )
                        current_lines = []
                        current_chords = []
                    current_label = "Unknown"
                elif inner.lower().startswith("verse"):
                    current_label = inner
                continue

            # Chords + lyrics line
            chords_in_line: List[ChordSegment] = []
            clean_line = ""
            pos = 0
            for match in cls.CHORD_RE.finditer(raw):
                chord = match.group(1)
                chords_in_line.append(ChordSegment(chord, match.start() - pos))
                clean_line += raw[pos : match.start()]
                pos = match.end()
            clean_line += raw[pos:]

            current_lines.append(clean_line.strip())
            current_chords.append(chords_in_line)

        if current_lines:
            sections.append(SongSection(current_label, current_lines, current_chords))

        return {
            "title": directives.get("title", "Unknown"),
            "artist": directives.get("artist", ""),
            "key": directives.get("key", ""),
            "bpm": int(directives.get("bpm", "120")) if directives.get("bpm") else 120,
            "sections": [
                {
                    "label": s.label,
                    "lines": s.lines,
                    "chords": [
                        [{"chord": c.chord, "position": c.position} for c in line_chords]
                        for line_chords in s.chords
                    ],
                }
                for s in sections
            ],
        }

    @classmethod
    def parse_file(cls, path: str) -> Dict[str, any]:
        with open(path, "r", encoding="utf-8") as f:
            return cls.parse(f.read())
