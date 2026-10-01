"""bandait-protocol/schemas/*.json agree with the normative fixtures and with
what the leader actually emits."""

import json

import pytest

jsonschema = pytest.importorskip("jsonschema")
referencing = pytest.importorskip("referencing")

from src.domain.concurrent_control import ConcurrentControlManager  # noqa: E402
from src.sync.leader_clock import leader_now_ns  # noqa: E402
from v3_shapes import FIXTURES_PATH, load_fixtures  # noqa: E402

SCHEMAS_DIR = FIXTURES_PATH.parents[1] / "schemas"

CASES = {
    "state_playing": "session_state.json",
    "state_idle": "session_state.json",
    "state_paused": "session_state.json",
    "join_session_request": "message_types.json#/definitions/join_session",
    "join_session_ack": "message_types.json#/definitions/join_session_ack",
    "sync_request": "message_types.json#/definitions/sync_request",
    "sync_request_ack": "message_types.json#/definitions/sync_request_ack",
    "control_command_play": "message_types.json#/definitions/control_command",
    "control_command_cue_next": "message_types.json#/definitions/control_command",
    "control_command_jump_song": "message_types.json#/definitions/control_command",
    "control_command_tempo_nudge": "message_types.json#/definitions/control_command",
    "command_ack_accepted": "message_types.json#/definitions/command_ack",
    "command_ack_rejected": "message_types.json#/definitions/command_ack",
    "beat_beacon": "message_types.json#/definitions/beat_beacon",
    "setlist_jump": "message_types.json#/definitions/setlist_jump",
    "follower_joined": "message_types.json#/definitions/follower_event",
    "follower_left": "message_types.json#/definitions/follower_event",
}


def _validator(ref):
    from referencing import Registry, Resource

    resources = []
    for path in SCHEMAS_DIR.glob("*.json"):
        contents = json.loads(path.read_text(encoding="utf-8"))
        resources.append((contents.get("$id", path.name), Resource.from_contents(contents)))
    registry = Registry().with_resources(resources)
    return jsonschema.Draft7Validator({"$ref": ref}, registry=registry)


@pytest.mark.parametrize("fixture_name,ref", sorted(CASES.items()))
def test_fixtures_match_schemas(fixture_name, ref):
    fixtures = load_fixtures()
    errors = list(_validator(ref).iter_errors(fixtures[fixture_name]))
    assert not errors, [e.message for e in errors]


class _Clock:
    def get_leader_time_ns(self):
        return leader_now_ns()


def test_leader_payloads_match_schemas():
    mgr = ConcurrentControlManager(_Clock())
    mgr.set_setlist(load_fixtures()["state_playing"]["setlist"])
    state_v = _validator("session_state.json")
    ack_v = _validator("message_types.json#/definitions/command_ack")
    assert not list(state_v.iter_errors(mgr.wire_state()))
    for type_, payload in (("PLAY", {}), ("TEMPO_NUDGE", {"delta_bpm": 1}), ("PAUSE", {}),
                           ("JUMP_SONG", {"song_id": "song_07"}), ("FOO", {}), ("PANIC", {})):
        ack = mgr.process_raw({"command_id": type_, "type": type_, "origin": "hub", "payload": payload}).ack
        errors = list(ack_v.iter_errors(ack))
        assert not errors, (type_, [e.message for e in errors])
