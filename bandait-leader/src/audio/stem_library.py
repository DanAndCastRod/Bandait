"""Stems of each song on the leader's disk: import, manifest and decoding.

Layout: <BANDAIT_HOME>/Stems/<song folder>/ with the audio files and manifest.json:

    {"version": 1, "song_id": "...", "offset_ms": 0,
     "stems": [{"file": "drums.mp3", "role": "drums", "label": "Bateria",
                "gain_db": 0.0, "muted": false}]}

Importing a ZIP (a Moises export) or loose files replaces the song's stems. Only the
base name of each ZIP member is used (no paths: a member like ../../x.mp3 cannot
escape the folder), and sizes are capped before anything is extracted.

Decoding happens off the audio thread (``decode``): int16 stereo at the engine's
rate, so a 4-minute stem takes about 46 MB instead of 92 MB in float32.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import numpy as np

from src.audio.stem_names import basename, is_audio, stem_label, stem_role
from src.core.paths import bandait_home

logger = logging.getLogger(__name__)

MANIFEST = "manifest.json"
MAX_STEM_BYTES = 400 * 1024 * 1024  # one decoded-size-agnostic cap per file
MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024
MAX_STEMS = 16


class StemImportError(Exception):
    """Readable reason why an import was refused (shown to the user)."""


@dataclass
class StemInfo:
    file: str
    role: str
    label: str
    gain_db: float = 0.0
    muted: bool = False


@dataclass
class StemSet:
    song_id: str
    stems: List[StemInfo] = field(default_factory=list)
    offset_ms: float = 0.0

    def to_json(self) -> dict:
        return {
            "version": 1,
            "song_id": self.song_id,
            "offset_ms": self.offset_ms,
            "stems": [s.__dict__ for s in self.stems],
        }


def stems_root() -> Path:
    return bandait_home() / "Stems"


def song_dir(song_id: str, root: Optional[Path] = None) -> Path:
    """Folder of a song: readable prefix plus a hash, so any song_id is a safe folder name."""
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", str(song_id))[:40].strip("_") or "song"
    digest = hashlib.sha1(str(song_id).encode("utf-8")).hexdigest()[:8]
    return (root or stems_root()) / f"{safe}-{digest}"


def load(song_id: str, root: Optional[Path] = None) -> Optional[StemSet]:
    """The song's stems, or None when it has none (or the manifest is unreadable)."""
    path = song_dir(song_id, root) / MANIFEST
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        stems = [
            StemInfo(
                file=basename(str(s["file"])),
                role=str(s.get("role") or "unknown"),
                label=str(s.get("label") or s["file"]),
                gain_db=float(s.get("gain_db", 0.0)),
                muted=bool(s.get("muted", False)),
            )
            for s in data.get("stems", [])
            if (path.parent / basename(str(s.get("file", "")))).is_file()
        ]
        offset = float(data.get("offset_ms", 0.0))
    except (OSError, ValueError, KeyError, TypeError) as exc:
        logger.warning("Manifiesto de stems ilegible en %s: %s", path, exc)
        return None
    return StemSet(song_id=str(song_id), stems=stems, offset_ms=offset) if stems else None


def has_stems(song_id: str, root: Optional[Path] = None) -> bool:
    return load(song_id, root) is not None


def save(stem_set: StemSet, root: Optional[Path] = None) -> None:
    folder = song_dir(stem_set.song_id, root)
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / (MANIFEST + ".tmp")
    tmp.write_text(json.dumps(stem_set.to_json(), ensure_ascii=False, indent=2), encoding="utf-8")
    _retry(tmp.replace, folder / MANIFEST)


def remove(song_id: str, root: Optional[Path] = None) -> None:
    folder = song_dir(song_id, root)
    if folder.is_dir():
        _retry(shutil.rmtree, folder)


def _retry(fn, *args, attempts: int = 6, delay: float = 0.15):
    """Windows: an antivirus or the indexer may hold a just-written file for a moment,
    and rename/delete then fail with PermissionError. Retry briefly."""
    for i in range(attempts):
        try:
            return fn(*args)
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(delay)


def _unique(name: str, used: set) -> str:
    base, dot, ext = name.rpartition(".")
    candidate, n = name, 2
    while candidate.lower() in used:
        candidate = f"{base} ({n}).{ext}" if dot else f"{name} ({n})"
        n += 1
    used.add(candidate.lower())
    return candidate


def _sources(paths: Iterable[str]) -> List[Tuple[str, object]]:
    """[(name, source)]: source is a Path or (ZipFile, ZipInfo). Size limits enforced."""
    out: List[Tuple[str, object]] = []
    total = 0
    for raw in paths:
        p = Path(raw)
        if p.suffix.lower() == ".zip":
            try:
                zf = zipfile.ZipFile(p)
            except (OSError, zipfile.BadZipFile) as exc:
                raise StemImportError(f"No se pudo abrir el ZIP {p.name}: {exc}") from exc
            for info in zf.infolist():
                if info.is_dir() or not is_audio(info.filename):
                    continue
                if info.file_size > MAX_STEM_BYTES:
                    raise StemImportError(f"{basename(info.filename)} pesa demasiado ({info.file_size // 2**20} MB)")
                total += info.file_size
                out.append((basename(info.filename), (zf, info)))
        elif p.is_file() and is_audio(p.name):
            size = p.stat().st_size
            if size > MAX_STEM_BYTES:
                raise StemImportError(f"{p.name} pesa demasiado ({size // 2**20} MB)")
            total += size
            out.append((p.name, p))
        if total > MAX_IMPORT_BYTES:
            raise StemImportError("La importación supera 2 GB")
    if len(out) > MAX_STEMS:
        raise StemImportError(f"Demasiadas pistas ({len(out)}); el máximo es {MAX_STEMS}")
    return out


def import_stems(song_id: str, paths: Iterable[str], root: Optional[Path] = None) -> StemSet:
    """Replace the song's stems with the audio files in ``paths`` (ZIPs and loose files).
    Keeps the previous offset. Raises StemImportError with a readable reason."""
    sources = _sources(paths)
    if not sources:
        raise StemImportError("No se encontraron archivos de audio (mp3, m4a, wav, flac, ogg, aac)")
    previous = load(song_id, root)
    folder = song_dir(song_id, root)
    staging = folder.with_name(folder.name + ".importando")
    if staging.exists():
        _retry(shutil.rmtree, staging)
    staging.mkdir(parents=True)
    used: set = set()
    stems: List[StemInfo] = []
    try:
        for name, src in sources:
            target = staging / _unique(name, used)
            if isinstance(src, Path):
                shutil.copyfile(src, target)
            else:
                zf, info = src
                with zf.open(info) as fin, open(target, "wb") as fout:
                    shutil.copyfileobj(fin, fout, 1024 * 1024)
            role = stem_role(name) or "unknown"
            stems.append(StemInfo(file=target.name, role=role, label=stem_label(role, name)))
        stem_set = StemSet(song_id=str(song_id), stems=stems, offset_ms=previous.offset_ms if previous else 0.0)
        (staging / MANIFEST).write_text(json.dumps(stem_set.to_json(), ensure_ascii=False, indent=2), encoding="utf-8")
        if folder.exists():
            _retry(shutil.rmtree, folder)
        _retry(staging.replace, folder)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    finally:
        for _name, src in sources:
            if not isinstance(src, Path):
                src[0].close()
    return stem_set


# --------------------------------------------------------------------------- decoding
def _resample(data: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """float32 (n, ch) to ``dst_rate``. scipy's polyphase filter when available; otherwise
    linear interpolation (audible only as a slight loss of highs, fine for rehearsal)."""
    if src_rate == dst_rate or data.shape[0] == 0:
        return data
    try:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(int(src_rate), int(dst_rate))
        return resample_poly(data, dst_rate // g, src_rate // g, axis=0).astype(np.float32)
    except ImportError:
        n_out = int(round(data.shape[0] * dst_rate / src_rate))
        x_old = np.arange(data.shape[0], dtype=np.float64)
        x_new = np.linspace(0, data.shape[0] - 1, n_out)
        return np.stack([np.interp(x_new, x_old, data[:, c]) for c in range(data.shape[1])], axis=1).astype(
            np.float32
        )


def decode_file(path: Path, sample_rate: int) -> np.ndarray:
    """int16 stereo (n, 2) at ``sample_rate``. Mono is duplicated, extra channels dropped."""
    import soundfile as sf

    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    if data.shape[1] == 1:
        data = np.repeat(data, 2, axis=1)
    elif data.shape[1] > 2:
        data = data[:, :2]
    data = _resample(data, int(rate), int(sample_rate))
    np.clip(data, -1.0, 1.0, out=data)
    return np.ascontiguousarray((data * 32767.0).astype(np.int16))


def decode(stem_set: StemSet, sample_rate: int, root: Optional[Path] = None) -> List[Tuple[StemInfo, Optional[np.ndarray], str]]:
    """[(info, int16 data or None, error)] for every stem. A bad file does not stop the rest."""
    folder = song_dir(stem_set.song_id, root)
    out = []
    for info in stem_set.stems:
        try:
            out.append((info, decode_file(folder / info.file, sample_rate), ""))
        except Exception as exc:  # corrupt or unsupported file: reported per stem
            if info.file.lower().endswith((".m4a", ".aac")):
                reason = "M4A/AAC no se puede leer en el líder; exporta los stems en MP3"
            else:
                reason = str(exc)
            out.append((info, None, f"{info.file}: {reason}"))
    return out
