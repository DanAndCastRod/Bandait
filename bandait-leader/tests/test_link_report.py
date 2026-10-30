"""link_report: parsing and the health rules of the leader's 'Músicos conectados' panel."""

from src.network.link_report import STALE_AFTER_NS, link_health, parse_link_report

NOW = 5_000_000_000_000


def report(**kw):
    base = {"rtt_ms": 9.8, "jitter_ms": 1.2, "samples": 12, "output_latency_ms": 142, "audio": "armed", "muted": False}
    base.update(kw)
    return parse_link_report(base, NOW)


def test_parse_clamps_and_rejects():
    r = report(rtt_ms=-3, jitter_ms=float("inf"), output_latency_ms=99_999, samples=True)
    assert (r["rtt_ms"], r["jitter_ms"], r["output_latency_ms"], r["samples"]) == (0.0, None, 10_000.0, 0)
    assert parse_link_report({"audio": "armed", "muted": "no"}, NOW) is None
    assert parse_link_report({"audio": "loud", "muted": False}, NOW) is None
    assert parse_link_report(["armed"], NOW) is None


def test_health_levels():
    assert link_health(report(), NOW)[0] == "ok"
    assert link_health(report(rtt_ms=35), NOW) == ("warn", "red aceptable")
    assert link_health(report(jitter_ms=12), NOW) == ("bad", "red lenta o inestable")
    assert link_health(report(audio="unarmed"), NOW) == ("warn", "falta tocar ACTIVAR AUDIO")
    assert link_health(report(audio="unsupported"), NOW)[0] == "bad"
    assert link_health(report(muted=True), NOW) == ("warn", "silenciado")
    assert link_health(report(rtt_ms=None), NOW) == ("warn", "midiendo el reloj")
    assert link_health(None, NOW)[0] == "stale"
    assert link_health(report(), NOW + STALE_AFTER_NS + 1)[0] == "stale"
