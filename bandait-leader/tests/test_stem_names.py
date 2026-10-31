"""Stem recognition by file name against bandait-protocol/fixtures/stem_names.json."""

import json
from pathlib import Path

import pytest

from src.audio.stem_names import AUDIO_EXTENSIONS, ROLES, recognize, stem_label, stem_role

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "stem_names.json").read_text(
        encoding="utf-8"
    )
)


def test_rules_match_the_fixture():
    assert list(AUDIO_EXTENSIONS) == FIXTURE["extensions"]
    assert set(ROLES) == set(FIXTURE["roles"])
    for role, spec in FIXTURE["roles"].items():
        assert ROLES[role][0] == spec["label"], role
        assert list(ROLES[role][1]) == spec["keywords"], role


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["file"])
def test_fixture_case(case):
    assert stem_role(case["file"]) == case["role"]


def test_labels_and_recognize():
    assert stem_label("drums") == "Bateria"
    assert stem_label("unknown", "C:/x/Track_7.mp3") == "Track 7"
    found = recognize(["a/vocals.mp3", "a/notes.txt", "a/Track 7.wav"])
    assert found == [("a/vocals.mp3", "vocals", "Voz"), ("a/Track 7.wav", "unknown", "Track 7")]
