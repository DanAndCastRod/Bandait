"""link_report (CONTRACT_V3.md section 3): link health of each phone, for the leader's
"Músicos conectados" panel. Informative only: nothing here touches the transport.

Pure functions so the parsing and the health rules are tested without a socket.
"""

from __future__ import annotations

import math
from typing import Mapping, Optional

AUDIO_STATES = ("unarmed", "armed", "suspended", "unsupported")
MAX_MS = 10_000.0
MAX_SAMPLES = 10_000

# Thresholds to validate in a real rehearsal (2026-10-30 proposal).
RTT_OK_MS = 20.0
JITTER_OK_MS = 3.0
RTT_WARN_MS = 50.0
JITTER_WARN_MS = 8.0
# The follower reports every 5 s: three missed reports means the panel data is stale.
STALE_AFTER_NS = 15_000_000_000

HEALTH_LABELS = {"ok": "BUENO", "warn": "REGULAR", "bad": "MALO", "stale": "SIN DATOS"}


def _ms(value: object) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return round(min(MAX_MS, max(0.0, float(value))), 1)


def parse_link_report(data: object, received_ns: int) -> Optional[dict]:
    """A clean report, or None if the payload is not a link_report (ignored, no reply)."""
    if not isinstance(data, Mapping):
        return None
    audio = data.get("audio")
    muted = data.get("muted")
    if audio not in AUDIO_STATES or not isinstance(muted, bool):
        return None
    samples = data.get("samples")
    if isinstance(samples, bool) or not isinstance(samples, int):
        samples = 0
    return {
        "rtt_ms": _ms(data.get("rtt_ms")),
        "jitter_ms": _ms(data.get("jitter_ms")),
        "samples": max(0, min(MAX_SAMPLES, samples)),
        "output_latency_ms": _ms(data.get("output_latency_ms")),
        "audio": audio,
        "muted": muted,
        "received_ns": int(received_ns),
    }


def link_health(report: Optional[Mapping], now_ns: int) -> tuple:
    """(level, reason): level in ok | warn | bad | stale, reason a short phrase for the UI."""
    if not report:
        return "stale", "todavía no reporta"
    if now_ns - int(report.get("received_ns", 0)) > STALE_AFTER_NS:
        return "stale", "sin reportes hace más de 15 s"
    audio = report.get("audio")
    if audio == "unsupported":
        return "bad", "el navegador no tiene audio"
    if audio != "armed":
        return "warn", "falta tocar ACTIVAR AUDIO"
    if report.get("muted"):
        return "warn", "silenciado"
    rtt = report.get("rtt_ms")
    jitter = report.get("jitter_ms")
    if rtt is None or jitter is None:
        return "warn", "midiendo el reloj"
    if rtt > RTT_WARN_MS or jitter > JITTER_WARN_MS:
        return "bad", "red lenta o inestable"
    if rtt > RTT_OK_MS or jitter > JITTER_OK_MS:
        return "warn", "red aceptable"
    return "ok", "enlace estable"
