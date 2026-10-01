"""Smoke test: the core leader modules import with the src.* layout."""


def test_imports():
    from src.domain import models
    from src.network import server
    from src.sync import clock_service

    assert models.SessionStatus.PLAYING == "PLAYING"
    assert hasattr(server, "BandaitServer")
    assert hasattr(clock_service, "ClockService")
