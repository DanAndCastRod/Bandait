"""Bandait v3 transport authority (CONTRACT_V3 sections 3, 5 and 6).

One instance owns the session state. Every transport change, whether it comes
from the laptop UI (origin ``laptop_foh``) or from a Socket.IO client, goes
through ``process_command`` / ``process_raw``:

- strict ``type`` validation (unknown types are rejected, never mapped to PLAY);
- idempotency by ``command_id`` (60 s window, cached ack with ``duplicate: true``);
- last-write-wins by the leader's own receipt time (client clocks are ignored);
- PLAY/PAUSE/RESUME/STOP/PANIC/CUE/JUMP/TEMPO_NUDGE semantics of section 6.

Thread safety: the manager is called from the Qt main thread (laptop buttons)
and from the asyncio thread (Socket.IO handlers). All state lives behind one
re-entrant lock; the critical sections are pure computation (microseconds), so
holding the lock never blocks the event loop in any meaningful way. Listeners
are invoked after the lock is released; consumers must discard updates whose
``state_version`` is not newer than the last one they applied.
"""

from __future__ import annotations

import logging
import math
import threading
import uuid
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Callable, Iterable, List, Optional, Protocol, Tuple

from src.domain.models import (
    CommandOrigin,
    CommandType,
    ConcurrentCommand,
    LastCommand,
    SessionState,
    SessionStatus,
    SetlistEntry,
    SetlistJumpAlert,
    Song,
    TransitionMode,
)
from src.sync.transport_math import (
    EMPTY_SCHEDULE,
    START_LEAD_NS,
    Schedule,
    Segment,
    active_index,
    add_segment,
    clamp_bpm,
)

logger = logging.getLogger(__name__)

DEDUP_WINDOW_NS = 60_000_000_000
DEDUP_MAX_ENTRIES = 4096
LOCAL_SENDER_ID = "leader-desktop"

_TRANSITION_MODES = {m.value for m in TransitionMode}


class IClockService(Protocol):
    def get_leader_time_ns(self) -> int:
        ...


@dataclass(frozen=True)
class StateUpdate:
    """Published after every accepted state change (in state_version order)."""

    state: SessionState
    wire_state: dict
    schedule: Schedule
    jump_wire: Optional[dict] = None


@dataclass(frozen=True)
class CommandExecutionResult:
    ack: dict
    accepted: bool
    duplicate: bool
    action_taken: str
    reason: Optional[str]
    new_state: SessionState
    changed: bool
    jump_alert: Optional[SetlistJumpAlert] = None

    @property
    def success(self) -> bool:
        return self.accepted


def sanitize_bpm(value: object, default: float = 120) -> float:
    """Song BPM from DB/JSON: finite, positive, kept within a sane range."""
    try:
        bpm = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if not math.isfinite(bpm) or bpm <= 0:
        return default
    bpm = max(20.0, min(400.0, bpm))
    return int(bpm) if bpm.is_integer() else bpm


def _as_int(value: object) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def _clean_str(value: object, limit: int) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    return value[:limit]


def normalize_setlist(items: Iterable[object]) -> Tuple[SetlistEntry, ...]:
    """Accept domain Songs, SetlistEntry or wire dicts; re-index 0..n-1."""
    entries: List[SetlistEntry] = []
    for item in items or ():
        if isinstance(item, SetlistEntry):
            song_id, title, bpm, mode = item.song_id, item.title, item.bpm, item.transition_mode
        elif isinstance(item, Song):
            song_id, title, bpm, mode = item.id, item.title, item.bpm, TransitionMode.MANUAL_CUE.value
        elif isinstance(item, dict):
            song_id = item.get("song_id", item.get("id"))
            title = item.get("title", "")
            bpm = item.get("bpm", 120)
            mode = item.get("transition_mode", TransitionMode.MANUAL_CUE.value)
        else:
            continue
        song_id = _clean_str(song_id, 128) if isinstance(song_id, str) else (
            str(song_id) if song_id is not None else None
        )
        if not song_id:
            continue
        title = title if isinstance(title, str) else str(title)
        if mode not in _TRANSITION_MODES:
            mode = TransitionMode.MANUAL_CUE.value
        entries.append(
            SetlistEntry(
                song_id=song_id,
                title=title,
                bpm=sanitize_bpm(bpm),
                order_index=len(entries),
                transition_mode=mode,
            )
        )
    return tuple(entries)


class ConcurrentControlManager:
    """Arbitrates concurrent transport commands from desktop and mobile devices."""

    def __init__(self, clock_service: IClockService, session_id: str = "default") -> None:
        self._now: Callable[[], int] = clock_service.get_leader_time_ns
        self._lock = threading.RLock()
        self._session_id = session_id
        self._state = SessionState(session_id=session_id)
        self._schedule: Schedule = EMPTY_SCHEDULE
        self._last_applied_receipt_ns = 0
        self._acks: "OrderedDict[str, Tuple[int, dict]]" = OrderedDict()
        self._listeners: List[Callable[[StateUpdate], None]] = []

    # ------------------------------------------------------------------ queries
    @property
    def session_id(self) -> str:
        return self._session_id

    def get_state(self) -> SessionState:
        with self._lock:
            return self._state

    def get_schedule(self) -> Schedule:
        with self._lock:
            return self._schedule

    def snapshot(self) -> Tuple[SessionState, Schedule]:
        with self._lock:
            return self._state, self._schedule

    def wire_state(self, leader_time_ns: Optional[int] = None) -> dict:
        with self._lock:
            now = self._now() if leader_time_ns is None else leader_time_ns
            return self._state.to_wire(now)

    def add_listener(self, listener: Callable[[StateUpdate], None]) -> None:
        with self._lock:
            self._listeners.append(listener)

    def remove_listener(self, listener: Callable[[StateUpdate], None]) -> None:
        with self._lock:
            if listener in self._listeners:
                self._listeners.remove(listener)

    # ------------------------------------------------------------------ setlist
    def set_setlist(self, songs: Iterable[object], start_index: Optional[int] = None) -> SessionState:
        """Replace the live setlist (internal API of the desktop leader)."""
        entries = normalize_setlist(songs)
        with self._lock:
            now = self._now()
            st = self._state
            idx: Optional[int] = None
            if start_index is not None and entries:
                idx = max(0, min(int(start_index), len(entries) - 1))
            elif st.current_song_id is not None:
                for e in entries:
                    if e.song_id == st.current_song_id:
                        idx = e.order_index
                        break
            changes: dict = {"setlist": entries}
            # While a song is sounding (or paused) the transport keeps its tempo
            # and anchor: loading a setlist never moves the band.
            playing = st.status in (SessionStatus.PLAYING, SessionStatus.COUNTING, SessionStatus.PAUSED)
            if idx is not None:
                entry = entries[idx]
                changes["current_order_index"] = idx
                changes["current_song_id"] = entry.song_id
                if not playing and entry.song_id != st.current_song_id:
                    changes["bpm"] = entry.bpm
            elif not playing:
                if entries:
                    changes.update(current_song_id=entries[0].song_id, current_order_index=0, bpm=entries[0].bpm)
                else:
                    changes.update(current_song_id=None, current_order_index=None)
            else:
                # Song kept sounding but it is not in the new setlist.
                changes["current_order_index"] = None
            new_state = replace(st, state_version=st.state_version + 1, **changes)
            self._state = new_state
            update = StateUpdate(new_state, new_state.to_wire(now), self._schedule, None)
            listeners = list(self._listeners)
        self._notify(listeners, update)
        return new_state

    # ------------------------------------------------------------------ commands
    def process_local(
        self, command_type: str, payload: Optional[dict] = None, command_id: Optional[str] = None
    ) -> CommandExecutionResult:
        """Laptop UI path: same validation and semantics as a remote command."""
        data = {
            "session_id": self._session_id,
            "command_id": command_id or str(uuid.uuid4()),
            "type": command_type,
            "origin": CommandOrigin.LAPTOP_FOH.value,
            "sender_id": LOCAL_SENDER_ID,
            "payload": payload or {},
        }
        return self.process_raw(data, received_ns=self._now())

    def process_raw(self, data: object, received_ns: Optional[int] = None) -> CommandExecutionResult:
        """Validate a wire ``control_command`` payload and process it."""
        if received_ns is None:
            received_ns = self._now()
        if not isinstance(data, dict):
            data = {}
        command_id = _clean_str(data.get("command_id"), 128) or f"leader-{uuid.uuid4()}"
        origin = _clean_str(data.get("origin"), 32) or CommandOrigin.DIRECTOR_MOBILE.value
        sender_id = _clean_str(data.get("sender_id"), 128) or ""
        session_id = _clean_str(data.get("session_id"), 128) or self._session_id
        payload = data.get("payload")
        if not isinstance(payload, dict):
            payload = {}
        cmd_type = CommandType.parse(data.get("type"))
        with self._lock:
            cached = self._cached_ack(command_id, received_ns)
            if cached is not None:
                return cached
            if cmd_type is None:
                return self._finish_rejected(command_id, received_ns, "invalid_type")
        cmd = ConcurrentCommand(
            command_id=command_id,
            command_type=cmd_type,
            origin=origin,
            sender_id=sender_id,
            session_id=session_id,
            received_ns=received_ns,
            payload=payload,
        )
        return self.process_command(cmd)

    def process_command(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        update: Optional[StateUpdate] = None
        with self._lock:
            cached = self._cached_ack(cmd.command_id, cmd.received_ns)
            if cached is not None:
                return cached
            if cmd.received_ns < self._last_applied_receipt_ns:
                # Received before the last applied command but processed after it
                # (cross-thread race). Applying it would let an older write win.
                return self._finish_rejected(cmd.command_id, cmd.received_ns, "conflict", "rejected_stale")
            now = max(self._now(), cmd.received_ns)
            try:
                outcome = self._dispatch(cmd, now)
            except Exception:  # defensive: a bad payload must never kill the transport
                logger.exception("Error processing command %s", cmd.command_id)
                return self._finish_rejected(cmd.command_id, cmd.received_ns, "out_of_range")
            action, reason, changes, schedule, jump = outcome
            if reason is not None:
                return self._finish_rejected(cmd.command_id, cmd.received_ns, reason)
            changed = changes is not None
            st = self._state
            if changed:
                st = replace(
                    st,
                    state_version=st.state_version + 1,
                    last_command=LastCommand(cmd.command_id, cmd.command_type.value, cmd.origin),
                    **changes,
                )
                self._state = st
                if schedule is not None:
                    self._schedule = schedule
                self._last_applied_receipt_ns = cmd.received_ns
            wire = st.to_wire(now)
            ack = self._make_ack(cmd.command_id, True, action, None, wire)
            self._store_ack(cmd.command_id, cmd.received_ns, ack)
            if changed:
                update = StateUpdate(
                    st, wire, self._schedule, jump.to_wire(self._session_id) if jump else None
                )
            listeners = list(self._listeners)
            result = CommandExecutionResult(
                ack=ack,
                accepted=True,
                duplicate=False,
                action_taken=action,
                reason=None,
                new_state=st,
                changed=changed,
                jump_alert=jump,
            )
        if update is not None:
            self._notify(listeners, update)
        return result

    # ------------------------------------------------------------------ internals
    def _notify(self, listeners: List[Callable[[StateUpdate], None]], update: StateUpdate) -> None:
        for listener in listeners:
            try:
                listener(update)
            except Exception:
                logger.exception("State listener failed")

    @staticmethod
    def _make_ack(command_id: str, accepted: bool, action: str, reason: Optional[str], wire: dict) -> dict:
        return {
            "command_id": command_id,
            "accepted": accepted,
            "duplicate": False,
            "action_taken": action,
            "reason": reason,
            "state_version": wire["state_version"],
            "state": wire,
        }

    def _cached_ack(self, command_id: str, received_ns: int) -> Optional[CommandExecutionResult]:
        self._prune_acks(received_ns)
        hit = self._acks.get(command_id)
        if hit is None:
            return None
        ack = dict(hit[1])
        ack["duplicate"] = True
        return CommandExecutionResult(
            ack=ack,
            accepted=bool(ack["accepted"]),
            duplicate=True,
            action_taken=ack["action_taken"],
            reason=ack["reason"],
            new_state=self._state,
            changed=False,
        )

    def _store_ack(self, command_id: str, received_ns: int, ack: dict) -> None:
        self._acks[command_id] = (received_ns, ack)
        self._acks.move_to_end(command_id)
        while len(self._acks) > DEDUP_MAX_ENTRIES:
            self._acks.popitem(last=False)

    def _prune_acks(self, now_ns: int) -> None:
        limit = now_ns - DEDUP_WINDOW_NS
        while self._acks:
            key, (ts, _ack) = next(iter(self._acks.items()))
            if ts >= limit:
                break
            self._acks.popitem(last=False)

    def _finish_rejected(
        self, command_id: str, received_ns: int, reason: str, action: str = "none"
    ) -> CommandExecutionResult:
        wire = self._state.to_wire(max(self._now(), received_ns))
        ack = self._make_ack(command_id, False, action, reason, wire)
        self._store_ack(command_id, received_ns, ack)
        return CommandExecutionResult(
            ack=ack,
            accepted=False,
            duplicate=False,
            action_taken=action,
            reason=reason,
            new_state=self._state,
            changed=False,
        )

    # Each handler returns (action, reason, changes|None, schedule|None, jump|None).
    def _dispatch(self, cmd: ConcurrentCommand, now: int):
        t = cmd.command_type
        if t is CommandType.PLAY:
            return self._play(now)
        if t is CommandType.PAUSE:
            return self._pause(now)
        if t is CommandType.RESUME:
            return self._resume(now, "RESUME")
        if t is CommandType.STOP:
            return self._stop("STOP")
        if t is CommandType.PANIC:
            return self._stop("PANIC")
        if t is CommandType.CUE_NEXT:
            return self._cue(cmd, now, +1)
        if t is CommandType.CUE_PREV:
            return self._cue(cmd, now, -1)
        if t is CommandType.JUMP_SONG:
            return self._jump(cmd, now)
        if t is CommandType.TEMPO_NUDGE:
            return self._tempo_nudge(cmd, now)
        return ("none", "invalid_type", None, None, None)

    @staticmethod
    def _noop(action: str):
        return (action, None, None, None, None)

    def _is_running(self) -> bool:
        return self._state.status in (SessionStatus.PLAYING, SessionStatus.COUNTING)

    def _play(self, now: int):
        st = self._state
        if self._is_running():
            return self._noop("noop_already_playing")
        if st.status is SessionStatus.PAUSED:
            # PLAY while PAUSED continues the song: same semantics as RESUME.
            return self._resume(now, "RESUME")
        changes: dict = {}
        bpm = st.bpm
        if st.current_song_id is None and st.setlist:
            first = st.setlist[0]
            changes.update(current_song_id=first.song_id, current_order_index=0)
            bpm = first.bpm
        anchor = now + START_LEAD_NS
        seg = Segment(anchor, bpm, st.beats_per_bar, 1)
        changes.update(
            status=SessionStatus.PLAYING, bpm=bpm, anchor_ns=anchor, bar_offset=1, paused_bar=None
        )
        return ("PLAY", None, changes, (seg,), None)

    def _pause(self, now: int):
        st = self._state
        if st.status is SessionStatus.PAUSED:
            return self._noop("noop_already_paused")
        if not self._is_running():
            return self._noop("noop_not_playing")
        sched = self._schedule
        idx = active_index(sched, now)
        if idx >= 0:
            pos = sched[idx].bar_beat_at(now)
            paused_bar = pos[0] if pos else sched[idx].bar_offset
        elif sched:
            # Paused inside the start lead: the first bar never sounded.
            paused_bar = sched[0].bar_offset - 1
        else:
            paused_bar = st.bar_offset - 1
        changes = dict(status=SessionStatus.PAUSED, anchor_ns=None, paused_bar=max(0, paused_bar))
        return ("PAUSE", None, changes, EMPTY_SCHEDULE, None)

    def _resume(self, now: int, action: str):
        st = self._state
        if self._is_running():
            return self._noop("noop_already_playing")
        if st.status is not SessionStatus.PAUSED:
            return self._noop("noop_not_paused")
        bar_offset = (st.paused_bar if st.paused_bar is not None else 0) + 1
        anchor = now + START_LEAD_NS
        seg = Segment(anchor, st.bpm, st.beats_per_bar, bar_offset)
        changes = dict(
            status=SessionStatus.PLAYING, anchor_ns=anchor, bar_offset=bar_offset, paused_bar=None
        )
        return (action, None, changes, (seg,), None)

    def _stop(self, action: str):
        changes = dict(status=SessionStatus.IDLE, anchor_ns=None, bar_offset=1, paused_bar=None)
        return (action, None, changes, EMPTY_SCHEDULE, None)

    def _cue(self, cmd: ConcurrentCommand, now: int, direction: int):
        st = self._state
        if not st.setlist:
            return ("none", "no_setlist", None, None, None)
        if "expected_song_id" in cmd.payload:
            expected = cmd.payload.get("expected_song_id")
            if expected is not None and expected != st.current_song_id:
                return ("none", "conflict", None, None, None)
        cur = st.current_order_index
        if cur is None:
            target = 0 if direction > 0 else -1
        else:
            target = cur + direction
        if target < 0 or target >= len(st.setlist):
            return ("none", "out_of_range", None, None, None)
        return self._change_song(cmd, now, target, start_playing=self._is_running())

    def _jump(self, cmd: ConcurrentCommand, now: int):
        st = self._state
        if not st.setlist:
            return ("none", "no_setlist", None, None, None)
        target: Optional[int] = None
        song_id = cmd.payload.get("song_id")
        if song_id is not None:
            for entry in st.setlist:
                if entry.song_id == song_id:
                    target = entry.order_index
                    break
        else:
            idx = _as_int(cmd.payload.get("order_index"))
            if idx is not None and 0 <= idx < len(st.setlist):
                target = idx
        if target is None:
            return ("none", "out_of_range", None, None, None)
        return self._change_song(cmd, now, target, start_playing=True)

    def _change_song(self, cmd: ConcurrentCommand, now: int, target: int, start_playing: bool):
        st = self._state
        entry = st.setlist[target]
        prev = st.current_order_index
        sequential = (prev is None and target == 0) or (prev is not None and target == prev + 1)
        jump = None
        if not sequential:
            jump = SetlistJumpAlert(
                song_id=entry.song_id,
                title=entry.title,
                order_index=target,
                previous_song_id=st.current_song_id,
                triggered_by=cmd.origin,
                timestamp_ns=now,
            )
        changes: dict = dict(
            current_song_id=entry.song_id, current_order_index=target, bpm=entry.bpm, paused_bar=None
        )
        if start_playing:
            anchor = now + START_LEAD_NS
            seg = Segment(anchor, entry.bpm, st.beats_per_bar, 1)
            if self._is_running():
                schedule = add_segment(self._schedule, seg, now)  # rule 2: no retroactive change
            else:
                schedule = (seg,)
            changes.update(status=SessionStatus.PLAYING, anchor_ns=anchor, bar_offset=1)
        else:
            schedule = EMPTY_SCHEDULE
            changes.update(status=SessionStatus.IDLE, anchor_ns=None, bar_offset=1)
        return (cmd.command_type.value, None, changes, schedule, jump)

    def _tempo_nudge(self, cmd: ConcurrentCommand, now: int):
        st = self._state
        delta = _as_int(cmd.payload.get("delta_bpm"))
        if delta is None:
            return ("none", "out_of_range", None, None, None)
        new_bpm = clamp_bpm(st.bpm + delta)
        if new_bpm == st.bpm:
            return self._noop("noop_tempo_unchanged")
        if self._is_running() and self._schedule:
            latest = self._schedule[-1]
            bars, boundary = latest.next_bar_boundary(now + START_LEAD_NS)
            bar_offset = latest.bar_offset + bars
            seg = Segment(boundary, new_bpm, latest.beats_per_bar, bar_offset)
            schedule = add_segment(self._schedule, seg, now)
            changes = dict(bpm=new_bpm, anchor_ns=boundary, bar_offset=bar_offset)
            return ("TEMPO_NUDGE", None, changes, schedule, None)
        return ("TEMPO_NUDGE", None, dict(bpm=new_bpm), None, None)
