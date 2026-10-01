"""Validate leader payloads against bandait-protocol/fixtures/v3_messages.json.

Shape rules: exactly the fixture's keys; each value's JSON type must be one of
the types seen for that key across the fixture examples of that message.
``<<name>>`` in a fixture means "the object ``name`` from the same file".
"""

import json
import uuid
from pathlib import Path

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "bandait-protocol" / "fixtures" / "v3_messages.json"

# Contract types that the fixtures can't fully express with one example.
NUMBER_KEYS = {"bpm", "client_send_ms"}  # "number": int or float
NULLABLE_KEYS = {"previous_song_id", "client_send_ms"}

# Required by CONTRACT_V3 section 4 but not (yet) present in the fixtures file:
# validated here explicitly (string UUID).
LEADER_ADDED_KEYS = {
    "session_state": {"leader_instance_id"},
    "join_session_ack": {"leader_instance_id"},
}

KINDS = {
    "session_state": ["state_playing", "state_idle", "state_paused"],
    "command_ack": ["command_ack_accepted", "command_ack_rejected"],
    "join_session_ack": ["join_session_ack"],
    "sync_request_ack": ["sync_request_ack"],
    "beat_beacon": ["beat_beacon"],
    "setlist_jump": ["setlist_jump"],
    "follower_joined": ["follower_joined"],
    "follower_left": ["follower_left"],
}


def _resolve(value, root):
    if isinstance(value, str) and value.startswith("<<") and value.endswith(">>"):
        return _resolve(root[value[2:-2]], root)
    if isinstance(value, dict):
        return {k: _resolve(v, root) for k, v in value.items()}
    if isinstance(value, list):
        return [_resolve(v, root) for v in value]
    return value


def load_fixtures() -> dict:
    with open(FIXTURES_PATH, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    return {k: _resolve(v, raw) for k, v in raw.items() if not k.startswith("_")}


def _type_name(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return "str"
    if isinstance(v, list):
        return "list"
    if isinstance(v, dict):
        return "dict"
    return type(v).__name__


def _check(payload, examples, path, fixtures, added=frozenset()):
    assert isinstance(payload, dict), f"{path}: expected object, got {type(payload).__name__}"
    expected_keys = set(examples[0].keys())
    for ex in examples[1:]:
        assert set(ex.keys()) == expected_keys, f"fixture inconsistency at {path}"
    for key in added:
        value = payload.get(key)
        assert isinstance(value, str), f"{path}.{key}: required string, got {value!r}"
        uuid.UUID(value)  # raises if not a UUID
    expected_keys |= set(added)
    assert set(payload.keys()) == expected_keys, (
        f"{path}: keys differ. extra={sorted(set(payload) - expected_keys)} "
        f"missing={sorted(expected_keys - set(payload))}"
    )
    for key in expected_keys - set(added):
        values = [ex[key] for ex in examples]
        allowed = {_type_name(v) for v in values}
        if key in NUMBER_KEYS:
            allowed |= {"int", "float"}
        if key in NULLABLE_KEYS:
            allowed.add("null")
        got = _type_name(payload[key])
        assert got in allowed, f"{path}.{key}: type {got} not in {sorted(allowed)}"
        if key == "state" and got == "dict":
            _check(
                payload[key],
                [fixtures[n] for n in KINDS["session_state"]],
                f"{path}.state",
                fixtures,
                LEADER_ADDED_KEYS["session_state"],
            )
        elif got == "dict":
            dict_examples = [v for v in values if isinstance(v, dict)]
            if dict_examples:
                _check(payload[key], dict_examples, f"{path}.{key}", fixtures)
        elif got == "list":
            items = [item for v in values if isinstance(v, list) for item in v if isinstance(item, dict)]
            if items:
                for i, item in enumerate(payload[key]):
                    _check(item, items, f"{path}.{key}[{i}]", fixtures)


def validate(kind: str, payload, fixtures=None) -> None:
    fixtures = fixtures or load_fixtures()
    examples = [fixtures[name] for name in KINDS[kind]]
    _check(payload, examples, kind, fixtures, LEADER_ADDED_KEYS.get(kind, frozenset()))
