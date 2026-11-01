"""Analizar con IA desde el líder: mezcla los stems del portátil y la manda al Worker
bandait-stems (Music AI). El borrador queda guardado por canción en R2; se revisa y se
acepta en el hub (Canciones > editar), que es donde viven las canciones de la banda.

Separar desde un audio: sube la canción completa (?separate=1); Music AI separa los stems y
el Worker los copia a la nube de la banda (IMPORTING) antes de dejar el borrador.

Contrato: bandait-stems-worker/README.md (rutas /analysis).
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

from src.audio import stem_library as lib
from src.cloud.http import CloudHTTPError, CloudOffline

ANALYSIS_RATE = 22050
SEPARATE_MAX_BYTES = 95 * 1024 * 1024  # the Worker's limit for the uploaded song
AUDIO_TYPES = {".wav": "audio/wav", ".flac": "audio/flac", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
               ".aac": "audio/aac", ".ogg": "audio/ogg"}
SKIP_ROLES = {"click", "guide"}  # confuse section and chord detection

ERRORS = {
    "analysis_unavailable": "El análisis con IA no está disponible en el servidor",
    "analysis_auth_failed": "Music AI rechazó la clave del servidor",
    "analysis_failed": "Music AI no pudo analizar la canción",
    "analysis_upload_failed": "No se pudo subir la mezcla a Music AI",
    "not_an_editor": "Solo el Owner o el Director musical pueden analizar canciones",
    "not_a_member": "No eres integrante de esta banda",
    "file_too_large": "El audio es demasiado grande (máximo 95 MB)",
    "stems_copy_failed": "No se pudieron copiar los stems a la nube; reintenta en un momento",
    "invalid_token": "La sesión de la nube venció: vuelve a iniciar sesión",
}


def mix_for_analysis(stem_set: lib.StemSet, root: Optional[Path] = None) -> bytes:
    """Mono 16-bit WAV at 22.05 kHz of every stem but the click and the guide (~10 MB for 4 min)."""
    import soundfile as sf

    decoded = lib.decode(stem_set, ANALYSIS_RATE, root)
    tracks = [d for info, d, _err in decoded if d is not None and info.role not in SKIP_ROLES]
    if not tracks:
        raise ValueError("No hay stems que se puedan mezclar")
    n = max(t.shape[0] for t in tracks)
    mix = np.zeros(n, dtype=np.float32)
    for t in tracks:
        mix[: t.shape[0]] += t.astype(np.float32).mean(axis=1) / 32768.0
    peak = float(np.abs(mix).max()) or 1.0
    if peak > 0.89:
        mix *= 0.89 / peak
    buf = io.BytesIO()
    sf.write(buf, mix, ANALYSIS_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class AnalysisCloud:
    def __init__(self, cloud, opener=None):
        """``cloud`` is a StemsCloud (base URL, token and User-Agent)."""
        self._cloud = cloud
        self._open = opener or cloud._open

    def _call(self, method: str, path: str, body: Optional[bytes] = None, content_type: str = "") -> dict:
        headers = {"Authorization": f"Bearer {self._cloud._token()}", "Accept": "application/json",
                   "User-Agent": self._cloud._user_agent}
        if body is not None:
            headers["Content-Type"] = content_type
            headers["Content-Length"] = str(len(body))
        req = urllib.request.Request(f"{self._cloud._base}{path}", data=body, headers=headers, method=method)
        try:
            with self._open(req, 120.0) as resp:
                return json.loads(resp.read(4 * 1024 * 1024) or b"{}")
        except urllib.error.HTTPError as err:
            try:
                code = str(json.loads(err.read(4096) or b"{}").get("error", ""))
            except (ValueError, AttributeError):
                code = ""
            raise CloudHTTPError(err.code, code, ERRORS.get(code, f"HTTP {err.code} {code}".strip())) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as err:
            raise CloudOffline(f"Sin conexión con el servidor de análisis ({getattr(err, 'reason', err)})") from None

    @staticmethod
    def _path(scope: str, song: str) -> str:
        return f"/v1/bands/{urllib.parse.quote(scope, safe='')}/songs/{urllib.parse.quote(song, safe='')}/analysis"

    def _scopes(self, band_cloud_id: Optional[str]):
        return [band_cloud_id, "me"] if band_cloud_id else ["me"]

    def status(self, band_cloud_id: Optional[str], song: str) -> Tuple[str, dict]:
        """(scope, response) of the song's last analysis; response {} when there is none."""
        for scope in self._scopes(band_cloud_id):
            try:
                return scope, self._call("GET", self._path(scope, song))
            except CloudHTTPError as err:
                if err.status == 404:
                    return scope, {}
                if err.status in (400, 403) and scope != "me" and err.error_code != "not_an_editor":
                    continue
                raise
        return "me", {}

    def start(self, band_cloud_id: Optional[str], song: str, wav: bytes,
              content_type: str = "audio/wav", separate: bool = False) -> Tuple[str, dict]:
        query = "?separate=1" if separate else ""
        for scope in self._scopes(band_cloud_id):
            try:
                return scope, self._call("POST", self._path(scope, song) + query, wav, content_type)
            except CloudHTTPError as err:
                if err.status in (400, 403) and scope != "me" and err.error_code == "not_a_member":
                    continue
                raise
        raise CloudHTTPError(403, "not_a_member", ERRORS["not_a_member"])


def read_song_audio(path: str) -> Tuple[bytes, str]:
    """(bytes, content type) of a whole song to separate; ValueError when it cannot go."""
    p = Path(path)
    content_type = AUDIO_TYPES.get(p.suffix.lower())
    if content_type is None:
        raise ValueError("Formato no soportado: usa WAV, FLAC, MP3, M4A u OGG")
    size = p.stat().st_size
    if size > SEPARATE_MAX_BYTES:
        raise ValueError(f"El audio pesa {size // (1024 * 1024)} MB; el máximo es 95 MB (usa FLAC o MP3)")
    if size == 0:
        raise ValueError("El archivo está vacío")
    return p.read_bytes(), content_type


def draft_summary(response: dict) -> str:
    """One readable paragraph about an analysis response (for the Canciones inspector)."""
    status = response.get("status")
    if not response:
        return "Sin análisis todavía."
    if status == "FAILED":
        return f"Falló: {response.get('error') or 'sin detalle'}"
    if status == "IMPORTING":
        return f"Copiando los stems separados a la nube: {response.get('done', 0)}/{response.get('total', '?')}…"
    if status != "SUCCEEDED":
        return "Analizando en Music AI… (unos minutos)"
    draft = response.get("draft") or {}
    sections = draft.get("sections") or []
    bars = sum(int(s.get("bars", 0)) for s in sections)
    bits = [f"{len(sections)} secciones, {bars} compases"]
    if draft.get("bpm"):
        bits.append(f"{draft['bpm']} BPM")
    if draft.get("key"):
        bits.append(f"tono {draft['key']}")
    if draft.get("lyrics_unplaced"):
        bits.append("letra sin ubicar")
    stems = (response.get("stems") or {}).get("stems") or []
    lead = f"{len(stems)} stems separados en la nube. " if stems else ""
    return lead + "Borrador listo: " + ", ".join(bits) + ". Revísalo y acéptalo en el hub (Canciones > editar)."
