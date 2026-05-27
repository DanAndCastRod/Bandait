# Bandait Protocol

Shared JSON Schemas and message definitions for the Bandait synchronization system.

## Message Flow

### Sync (NTP-lite)
1. Follower emits `sync_request` with `t0` (local performance.now() in ns).
2. Leader responds with `sync_response` containing `t0` (echoed) and `t1` (leader monotonic_ns).
3. Follower records `t2` upon receipt.
4. Follower calculates: `offset = t1 - (t0 + (t2 - t0) / 2)`.
5. Repeat 10x, discard outliers, use median.

### Transport
- `play_at`: `{ leader_timestamp, bpm, song_id }`
- `stop_at`: `{ leader_timestamp }`
- `panic`: Immediate stop from any follower. Leader broadcasts `panic_ack`.

### State
- `state_update`: Full `SessionState` object (see `session_state.json`).
- `full_state`: Sent to reconnecting followers to catch up.
- `song_load`: `{ song: Song }` pushes setlist content to followers.
