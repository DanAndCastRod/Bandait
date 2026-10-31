"""ChordPro for the leader's stage view (CONTRACT_V3 9.1). Pure module: no Qt.

A section body like "[Am]Hoy vuelvo a [F]casa" becomes two monospace rows, chords
over their syllables (same rule as the hub preview, services/chordpro.ts). The view
shows them as rich text in a QLabel.
"""

import html
import re
from typing import List, Optional, Sequence, Tuple

from src.ui import theme

_CHORD = re.compile(r"\[([^\]]*)\]")
_DIRECTIVE = re.compile(r"^\{\s*([A-Za-z][\w-]*)\s*(?:[:\s]\s*([\s\S]*?))?\s*\}$")
_COMMENTS = {"c", "comment", "ci", "comment_italic", "cb", "comment_box", "highlight"}

MUSICIAN = "musician"
SINGER = "singer"


def layout_chord_line(line: str) -> Tuple[str, str]:
    """'[Am]Hoy [F]vuelvo' -> ('Am  F', 'Hoy vuelvo'); chords padded over their syllable."""
    chords = ""
    lyrics = ""
    last = 0
    has_chord = False
    for m in _CHORD.finditer(line):
        lyrics += line[last:m.start()]
        last = m.end()
        if chords and len(chords) >= len(lyrics):
            # The previous chord is longer than its syllable: keep one space between chords.
            lyrics = lyrics.ljust(len(chords) + 1)
        chords = chords.ljust(len(lyrics)) + m.group(1).strip()
        has_chord = True
    lyrics += line[last:]
    return (chords if has_chord else ""), lyrics


def parse_lines(body: str) -> List[Tuple[str, str, str]]:
    """Section body -> [(kind, chords, lyrics)]; kind is 'pair' or 'comment'. Blank lines dropped."""
    out: List[Tuple[str, str, str]] = []
    for raw in (body or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        d = _DIRECTIVE.match(line.strip())
        if d:
            value = (d.group(2) or "").strip()
            if d.group(1).lower() in _COMMENTS and value:
                out.append(("comment", "", value))
            continue
        chords, lyrics = layout_chord_line(line)
        out.append(("pair", chords, lyrics))
    return out


def lyric_lines(body: str) -> List[str]:
    """Lyrics only (singer view): chord-only lines are dropped."""
    return [" ".join(lyrics.split()) for kind, _c, lyrics in parse_lines(body) if kind == "pair" and lyrics.strip()]


def section_html(body: str, mode: str = MUSICIAN, cue_text: Optional[str] = None, font_px: int = 0) -> str:
    """Rich text for the prompter QLabel. Empty body: the cue (or INSTRUMENTAL).
    ``font_px`` sizes the monospace block (Qt's <pre> does not inherit the label size)."""
    if mode == SINGER:
        lines = lyric_lines(body)
        if not lines:
            return _placeholder(cue_text or "INSTRUMENTAL")
        return "<br>".join(html.escape(t) for t in lines)
    rows = parse_lines(body)
    if not rows:
        return _placeholder(cue_text or "SIN ACORDES")
    parts = []
    for kind, chords, lyrics in rows:
        if kind == "comment":
            parts.append(f'<span style="color:{theme.WARNING}; font-size:60%;">{html.escape(lyrics)}</span>')
            continue
        block = []
        if chords:
            block.append(f'<span style="color:{theme.SUCCESS}; font-weight:700;">{html.escape(chords)}</span>')
        if lyrics.strip():
            block.append(html.escape(lyrics))
        parts.append("<br>".join(block))
    body_html = "<br>".join(parts)
    size = f" font-size:{font_px}px;" if font_px > 0 else ""
    return f'<pre style="font-family:\'JetBrains Mono\',Consolas,monospace; margin:0;{size}">{body_html}</pre>'


def preview_text(body: str, mode: str = MUSICIAN, cue_text: Optional[str] = None) -> str:
    """First line of a section, plain text, for the 'next section' cue."""
    if mode == SINGER:
        lines = lyric_lines(body)
        return lines[0] if lines else (cue_text or "")
    for kind, chords, lyrics in parse_lines(body):
        if kind != "pair":
            continue
        text = " ".join(lyrics.split())
        return " // ".join(p for p in (" ".join(chords.split()), text) if p)
    return cue_text or ""


def section_index_at(sections: Sequence[dict], bar: Optional[int]) -> int:
    """Section that contains ``bar`` (1-based song bar). Count-in or stopped: 0. Past the end: the last."""
    if not sections:
        return -1
    if bar is None or bar < int(sections[0].get("start_bar", 1)):
        return 0
    index = 0
    for i, s in enumerate(sections):
        if int(s.get("start_bar", 1)) <= bar:
            index = i
        else:
            break
    return index


def _placeholder(text: str) -> str:
    return f'<span style="color:{theme.FAINT};">{html.escape(text.upper())}</span>'
