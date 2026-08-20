"""LRC (LyRiCs) file parser for synchronized lyrics."""

import re
from dataclasses import dataclass


@dataclass
class LyricLine:
    time_ms: int
    text: str


class LRCParser:
    """Parse .lrc files with [mm:ss.xx] timestamps."""

    TIME_RE = re.compile(r"\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)")

    @classmethod
    def parse(cls, content: str) -> list[LyricLine]:
        lines: list[LyricLine] = []
        for raw in content.splitlines():
            raw = raw.strip()
            if not raw or raw.startswith("[ar:") or raw.startswith("[ti:"):
                continue
            match = cls.TIME_RE.match(raw)
            if match:
                mm, ss, xx, text = match.groups()
                time_ms = int(mm) * 60_000 + int(ss) * 1000 + int(xx.ljust(3, "0")[:3])
                lines.append(LyricLine(time_ms=time_ms, text=text.strip()))
        return sorted(lines, key=lambda x: x.time_ms)

    @classmethod
    def parse_file(cls, path: str) -> list[LyricLine]:
        with open(path, encoding="utf-8") as f:
            return cls.parse(f.read())
