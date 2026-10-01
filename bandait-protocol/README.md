# Bandait Protocol (v3)

Normative documents, in priority order:

1. `CONTRACT_V3.md`: the contract (transport, time base, events, transport semantics).
2. `fixtures/v3_messages.json`: one canonical example of every message. `"<<name>>"`
   means "the object `name` from the same file". Leader and follower tests validate
   their payloads against these fixtures.
3. `schemas/*.json`: JSON Schema (draft-07) for the same messages:
   - `session_state.json`: `SessionState`, `SetlistEntry`, `LastCommand`.
   - `message_types.json`: event names plus `definitions/` for every payload
     (`join_session`, `join_session_ack`, `sync_request`, `sync_request_ack`,
     `control_command`, `command_ack`, `beat_beacon`, `setlist_jump`, `follower_event`,
     `leader_info`).
   - `song.json`: library entity; not sent as-is on the wire.

If code and contract disagree, the contract and fixtures are fixed first.

## Summary

- Socket.IO v4, leader on port 4040, one room per `session_id`. snake_case keys only.
- Every `*_ns` field is the leader's high-resolution clock, `time.perf_counter_ns()`, in integer
  nanoseconds (never `time.monotonic_ns`: 15.6 ms resolution on Windows with Python < 3.13).
- Client to leader: `join_session` (ack + `full_state` always), `sync_request`
  (ack echoes `client_send_ms` and adds `leader_time_ns`), `control_command`
  (ack is `command_ack`).
- Leader to clients: `full_state`, `state_update`, `beat_beacon` (once per bar while
  PLAYING), `setlist_jump`, `follower_joined`, `follower_left`.
- There is no `broadcast_state`: no client can write the session state.
- HTTP on the same port (section 8): the leader serves the follower bundle at `/` and
  `GET /leader-info.json` (`definitions/leader_info`). QR links:
  `http://<ip>:<port>/?ip=<ip>&port=<port>&session=<session_id>&auto=1` (director adds
  `&role=director`), opened with the phone's native camera.
- Commands: `PLAY STOP PAUSE RESUME CUE_NEXT CUE_PREV JUMP_SONG TEMPO_NUDGE PANIC`.
  Unknown types are rejected (`invalid_type`), retries with the same `command_id`
  return the cached ack with `duplicate: true` (60 s), ordering is by leader receipt time.
- Beat math: `beat_ns = 60e9 / bpm`, click `k` at `anchor_ns + k * beat_ns`,
  `bar = bar_offset + floor(k / beats_per_bar)`. Every new anchor is at least 250 ms
  after `leader_time_ns` and never rewrites the past.

## Validating

The leader suite checks fixtures and live payloads against the schemas
(`bandait-leader/tests/test_protocol_schemas.py`) and runs real Socket.IO sessions
against the fixtures (`bandait-leader/tests/test_protocol_v3.py`).
