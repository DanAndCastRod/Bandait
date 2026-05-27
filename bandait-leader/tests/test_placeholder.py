"""Placeholder until real tests are implemented."""


def test_imports():
    from domain import models
    from sync import clock_service
    from network import bandait_server
    assert models.SessionStatus.PLAYING == "PLAYING"
