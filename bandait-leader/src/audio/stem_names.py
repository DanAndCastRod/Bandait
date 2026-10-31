"""Stem role from a file name (Moises exports and hand-made files).

The rules and the test cases live in bandait-protocol/fixtures/stem_names.json; the
hub implements the same rules (bandait-leader-web/src/services/stemNames.ts). Both
are tested against that file, so a new export format means adding a case there.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Dict, List, Optional, Tuple

AUDIO_EXTENSIONS = ("mp3", "m4a", "wav", "flac", "ogg", "aac")

ROLES: Dict[str, Tuple[str, Tuple[str, ...]]] = {
    "vocals": ("Voz", ("lead vocals", "lead vocal", "vocals", "vocal", "vox", "voz", "voces", "voz principal")),
    "backing_vocals": ("Coros", ("backing vocals", "backing vocal", "back vocals", "backing", "bvs", "coros",
                                 "coro", "segundas voces")),
    "drums": ("Bateria", ("drums", "drum", "bateria", "percussion", "percusion", "perc")),
    "bass": ("Bajo", ("bass", "bajo")),
    "guitar": ("Guitarra", ("guitar", "guitars", "guitarra", "guitarras", "gtr")),
    "keys": ("Teclados", ("piano", "keys", "keyboard", "keyboards", "teclado", "teclados", "synth", "synths",
                          "sintetizador", "organ", "organo")),
    "strings": ("Cuerdas", ("strings", "cuerdas", "violin", "violins")),
    "wind": ("Vientos", ("wind", "winds", "brass", "metales", "vientos", "sax", "trumpet")),
    "other": ("Otros", ("other", "others", "otros", "otro", "rest", "residual")),
    "instrumental": ("Instrumental", ("instrumental", "accompaniment", "karaoke")),
    "click": ("Clic", ("click", "clic", "metronome", "metronomo")),
    "guide": ("Guia", ("guide", "guia", "cues", "cue")),
}

_SEPARATORS = re.compile(r"[_\-.()\[\]]")
_SPACES = re.compile(r"\s+")


def basename(path: str) -> str:
    return re.split(r"[\\/]", path)[-1]


def is_audio(path: str) -> bool:
    """Audio file that counts as a stem (not under __MACOSX/, not a dotfile)."""
    parts = re.split(r"[\\/]", path)
    if any(p == "__MACOSX" for p in parts):
        return False
    name = parts[-1]
    if not name or name.startswith("."):
        return False
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext in AUDIO_EXTENSIONS


def normalize(name: str) -> str:
    """Base name without extension: lower case, no accents, separators as spaces."""
    stem = name.rsplit(".", 1)[0] if "." in name else name
    text = unicodedata.normalize("NFD", stem.lower())
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    return _SPACES.sub(" ", _SEPARATORS.sub(" ", text)).strip()


def stem_role(path: str) -> Optional[str]:
    """Role of a stem file, 'unknown' when no keyword matches, None when it is not a stem."""
    if not is_audio(path):
        return None
    text = normalize(basename(path))
    best: Optional[Tuple[int, int, str]] = None  # (end, keyword length, role)
    for role, (_label, keywords) in ROLES.items():
        for kw in keywords:
            for m in re.finditer(rf"(?<![a-z0-9]){re.escape(kw)}(?![a-z0-9])", text):
                key = (m.end(), len(kw), role)
                if best is None or key[:2] > best[:2]:
                    best = key
    return best[2] if best else "unknown"


def stem_label(role: str, path: str = "") -> str:
    """Display label: the role's name, or the cleaned file name for 'unknown'."""
    if role in ROLES:
        return ROLES[role][0]
    stem = basename(path).rsplit(".", 1)[0]
    return _SPACES.sub(" ", _SEPARATORS.sub(" ", stem)).strip() or "Pista"


def recognize(paths: List[str]) -> List[Tuple[str, str, str]]:
    """[(path, role, label)] for the stems among ``paths`` (non-stems dropped)."""
    out = []
    for p in paths:
        role = stem_role(p)
        if role is not None:
            out.append((p, role, stem_label(role, p)))
    return out
