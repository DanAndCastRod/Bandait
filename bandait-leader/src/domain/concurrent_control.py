"""Bandait 3.0 — Concurrent Master Control & Setlist Jump Detection.

Handles simultaneous commands from Laptop Desktop and Director Mobile with:
- Last-Write-Wins (LWW) timestamp arbitration
- Non-sequential setlist jump detection and alert generation
- Dynamic tempo nudge (+/- 1 BPM) with safe clamping (40..260 BPM)
- Instant PANIC stop and stage muting
"""

import time
from typing import List, Optional, Dict, Tuple, Protocol
from dataclasses import dataclass

from src.domain.models import (
    CommandType,
    ConcurrentCommand,
    SetlistJumpAlert,
    SessionState,
    SessionStatus,
    Song,
)


class IClockService(Protocol):
    def get_leader_time_ns(self) -> int:
        ...

    def start_playback(self, bpm: int = 120) -> None:
        ...

    def stop_playback(self) -> None:
        ...


@dataclass
class CommandExecutionResult:
    success: bool
    command_id: str
    action_taken: str
    new_state: SessionState
    jump_alert: Optional[SetlistJumpAlert] = None
    reason: Optional[str] = None


class ConcurrentControlManager:
    """Arbitrates concurrent transport commands from desktop and mobile devices."""

    def __init__(self, clock_service: IClockService, session_id: str = "default"):
        self._clock = clock_service
        self._session_id = session_id
        self._last_command_timestamp_ns: int = 0
        self._setlist_sequence: List[Song] = []
        self._current_song_index: int = 0
        self._current_state: SessionState = SessionState(
            session_id=session_id,
            leader_ip="127.0.0.1",
            status=SessionStatus.IDLE,
            current_song_id=None,
            next_event_timestamp=0,
            bpm=120,
            beat=1,
            bar=1,
            jump_alert=None,
        )

    def set_setlist(self, songs: List[Song], start_index: int = 0) -> None:
        """Load setlist sequence for sequential progression and jump detection."""
        self._setlist_sequence = list(songs)
        self._current_song_index = max(0, min(start_index, len(songs) - 1)) if songs else 0

        if self._setlist_sequence:
            active_song = self._setlist_sequence[self._current_song_index]
            self._current_state = SessionState(
                session_id=self._session_id,
                leader_ip=self._current_state.leader_ip,
                status=self._current_state.status,
                current_song_id=active_song.id,
                next_event_timestamp=self._clock.get_leader_time_ns(),
                bpm=active_song.bpm,
                beat=1,
                bar=1,
                jump_alert=None,
            )

    def get_state(self) -> SessionState:
        return self._current_state

    def process_command(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        """Process an incoming command from laptop or director mobile.

        Applies Last-Write-Wins based on monotonic timestamp.
        """
        now_ns = self._clock.get_leader_time_ns()

        # Reject commands with obsolete timestamps (stale network packet)
        if cmd.timestamp_ns > 0 and cmd.timestamp_ns < self._last_command_timestamp_ns:
            return CommandExecutionResult(
                success=False,
                command_id=cmd.command_id,
                action_taken="rejected_stale",
                new_state=self._current_state,
                reason="Command timestamp older than latest executed command.",
            )

        self._last_command_timestamp_ns = cmd.timestamp_ns or now_ns

        if cmd.command_type == CommandType.PLAY:
            return self._handle_play(cmd)
        elif cmd.command_type == CommandType.STOP:
            return self._handle_stop(cmd)
        elif cmd.command_type == CommandType.PAUSE:
            return self._handle_pause(cmd)
        elif cmd.command_type == CommandType.CUE_NEXT:
            return self._handle_cue_next(cmd)
        elif cmd.command_type == CommandType.CUE_PREV:
            return self._handle_cue_prev(cmd)
        elif cmd.command_type == CommandType.JUMP_SONG:
            return self._handle_jump_song(cmd)
        elif cmd.command_type == CommandType.TEMPO_NUDGE:
            return self._handle_tempo_nudge(cmd)
        elif cmd.command_type == CommandType.PANIC:
            return self._handle_panic(cmd)

        return CommandExecutionResult(
            success=False,
            command_id=cmd.command_id,
            action_taken="unknown_command",
            new_state=self._current_state,
            reason=f"Unsupported command type: {cmd.command_type}",
        )

    # -------------------------------------------------------------------------
    # Internal command handlers
    # -------------------------------------------------------------------------
    def _handle_play(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        bpm = cmd.payload.get("bpm", self._current_state.bpm)
        self._clock.start_playback(bpm=bpm)
        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=SessionStatus.PLAYING,
            current_song_id=self._current_state.current_song_id,
            next_event_timestamp=self._clock.get_leader_time_ns(),
            bpm=bpm,
            beat=1,
            bar=1,
            jump_alert=None,
        )
        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken="PLAY",
            new_state=self._current_state,
        )

    def _handle_stop(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        self._clock.stop_playback()
        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=SessionStatus.IDLE,
            current_song_id=self._current_state.current_song_id,
            next_event_timestamp=0,
            bpm=self._current_state.bpm,
            beat=1,
            bar=1,
            jump_alert=None,
        )
        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken="STOP",
            new_state=self._current_state,
        )

    def _handle_pause(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        self._clock.stop_playback()
        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=SessionStatus.PAUSED,
            current_song_id=self._current_state.current_song_id,
            next_event_timestamp=0,
            bpm=self._current_state.bpm,
            beat=self._current_state.beat,
            bar=self._current_state.bar,
            jump_alert=None,
        )
        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken="PAUSE",
            new_state=self._current_state,
        )

    def _handle_cue_next(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        if not self._setlist_sequence:
            return CommandExecutionResult(
                success=False,
                command_id=cmd.command_id,
                action_taken="CUE_NEXT_EMPTY",
                new_state=self._current_state,
                reason="No setlist loaded.",
            )

        next_idx = min(self._current_song_index + 1, len(self._setlist_sequence) - 1)
        self._current_song_index = next_idx
        song = self._setlist_sequence[next_idx]

        self._clock.start_playback(bpm=song.bpm)
        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=SessionStatus.PLAYING,
            current_song_id=song.id,
            next_event_timestamp=self._clock.get_leader_time_ns(),
            bpm=song.bpm,
            beat=1,
            bar=1,
            jump_alert=None,
        )
        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken="CUE_NEXT",
            new_state=self._current_state,
        )

    def _handle_cue_prev(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        if not self._setlist_sequence:
            return CommandExecutionResult(
                success=False,
                command_id=cmd.command_id,
                action_taken="CUE_PREV_EMPTY",
                new_state=self._current_state,
                reason="No setlist loaded.",
            )

        prev_idx = max(0, self._current_song_index - 1)
        self._current_song_index = prev_idx
        song = self._setlist_sequence[prev_idx]

        self._clock.start_playback(bpm=song.bpm)
        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=SessionStatus.PLAYING,
            current_song_id=song.id,
            next_event_timestamp=self._clock.get_leader_time_ns(),
            bpm=song.bpm,
            beat=1,
            bar=1,
            jump_alert=None,
        )
        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken="CUE_PREV",
            new_state=self._current_state,
        )

    def _handle_jump_song(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        """Handle arbitrary jump in setlist and generate high-visibility alert."""
        target_song_id = cmd.payload.get("song_id")
        target_index = cmd.payload.get("order_index")

        # Find song by id or order
        target_song: Optional[Song] = None
        new_index = -1

        if target_song_id:
            for i, s in enumerate(self._setlist_sequence):
                if s.id == target_song_id:
                    target_song = s
                    new_index = i
                    break
        elif target_index is not None and 0 <= target_index < len(self._setlist_sequence):
            new_index = target_index
            target_song = self._setlist_sequence[new_index]

        if not target_song:
            return CommandExecutionResult(
                success=False,
                command_id=cmd.command_id,
                action_taken="JUMP_FAILED",
                new_state=self._current_state,
                reason=f"Target song not found in active setlist: {target_song_id or target_index}",
            )

        previous_idx = self._current_song_index
        previous_song_id = self._current_state.current_song_id
        self._current_song_index = new_index

        # Detect non-sequential jump: if not consecutive next (idx != prev + 1)
        is_jump = (new_index != previous_idx + 1)

        jump_alert = None
        if is_jump:
            jump_alert = SetlistJumpAlert(
                song_id=target_song.id,
                title=target_song.title,
                order_index=new_index + 1,  # 1-indexed for stage display
                previous_song_id=previous_song_id,
                triggered_by=cmd.origin,
                timestamp_ns=self._clock.get_leader_time_ns(),
            )

        # Force beat = 1 and sync tempo
        self._clock.start_playback(bpm=target_song.bpm)
        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=SessionStatus.PLAYING,
            current_song_id=target_song.id,
            next_event_timestamp=self._clock.get_leader_time_ns(),
            bpm=target_song.bpm,
            beat=1,
            bar=1,
            jump_alert=jump_alert,
        )

        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken="JUMP_SONG",
            new_state=self._current_state,
            jump_alert=jump_alert,
        )

    def _handle_tempo_nudge(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        """Nudge BPM up or down with safety limits (40..260 BPM)."""
        delta = cmd.payload.get("delta_bpm", 0)
        target_bpm = cmd.payload.get("target_bpm")

        if target_bpm is not None:
            new_bpm = target_bpm
        else:
            new_bpm = self._current_state.bpm + delta

        # Safety clamping
        clamped_bpm = max(40, min(int(new_bpm), 260))

        if self._current_state.status == SessionStatus.PLAYING:
            self._clock.start_playback(bpm=clamped_bpm)

        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=self._current_state.status,
            current_song_id=self._current_state.current_song_id,
            next_event_timestamp=self._clock.get_leader_time_ns(),
            bpm=clamped_bpm,
            beat=self._current_state.beat,
            bar=self._current_state.bar,
            jump_alert=None,
        )

        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken=f"TEMPO_NUDGE_{clamped_bpm}",
            new_state=self._current_state,
        )

    def _handle_panic(self, cmd: ConcurrentCommand) -> CommandExecutionResult:
        """Emergency PANIC stop and stage mute."""
        self._clock.stop_playback()
        self._current_state = SessionState(
            session_id=self._session_id,
            leader_ip=self._current_state.leader_ip,
            status=SessionStatus.IDLE,
            current_song_id=self._current_state.current_song_id,
            next_event_timestamp=0,
            bpm=self._current_state.bpm,
            beat=1,
            bar=1,
            jump_alert=None,
        )
        return CommandExecutionResult(
            success=True,
            command_id=cmd.command_id,
            action_taken="PANIC",
            new_state=self._current_state,
        )
