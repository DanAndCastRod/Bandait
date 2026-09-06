"""Socket.IO server for Bandait leader-follower synchronization."""

import asyncio
import threading
import queue
import socketio
from dataclasses import asdict
from typing import Any, Optional

import time
from src.sync.clock_service import ClockService
from src.domain.models import SessionState, MessageType, CommandType, ConcurrentCommand, Song
from src.domain.concurrent_control import ConcurrentControlManager, IClockService


class BandaitServer:
    """Async Socket.IO server with room-based session management.

    Thread-safe for Qt integration: use ``broadcast_state_sync()`` from any thread.
    """

    def __init__(
        self,
        clock_service: ClockService,
        host: str = "0.0.0.0",
        port: int = 4040,
    ) -> None:
        self._clock = clock_service
        self._host = host
        self._port = port
        self._sio = socketio.AsyncServer(
            cors_allowed_origins="*",
            async_mode="asgi",
        )
        self._app = socketio.ASGIApp(self._sio)
        self._sessions: dict[str, dict[str, Any]] = {}
        self._thread: Optional[threading.Thread] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._control_manager = ConcurrentControlManager(self._clock)
        self._setup_handlers()

        # Thread-safe broadcast queue
        self._broadcast_queue: queue.Queue = queue.Queue()

    def _setup_handlers(self) -> None:
        @self._sio.event
        async def connect(sid: str, environ: dict) -> None:
            print(f"[NET] Client connected: {sid}")

        @self._sio.event
        async def disconnect(sid: str) -> None:
            print(f"[NET] Client disconnected: {sid}")
            for session_id, data in list(self._sessions.items()):
                if sid in data.get("followers", set()):
                    data["followers"].discard(sid)
                    await self._sio.emit(
                        "follower_left",
                        {"sid": sid},
                        room=session_id,
                        skip_sid=sid,
                    )

        @self._sio.on("join_session")
        async def join_session(sid: str, data: dict) -> dict:
            session_id = data.get("sessionId", "default")
            await self._sio.enter_room(sid, session_id)
            if session_id not in self._sessions:
                self._sessions[session_id] = {
                    "followers": set(),
                    "state": None,
                }
            self._sessions[session_id]["followers"].add(sid)
            print(f"[NET] {sid} joined session {session_id}")

            # Send current full state if available
            current_state = self._sessions[session_id]["state"]
            if current_state:
                await self._sio.emit(
                    "full_state",
                    current_state,
                    room=sid,
                )
            return {"status": "joined", "sessionId": session_id}

        @self._sio.on("sync_request")
        async def sync_request(sid: str, data: dict) -> dict:
            """NTP-style sync: follower sends t0, leader responds with t1."""
            leader_time_ns = self._clock.get_leader_time_ns()
            return {
                "type": MessageType.SYNC_BEACON.value,
                "leaderTimeNs": leader_time_ns,
            }

        @self._sio.on("broadcast_state")
        async def broadcast_state(sid: str, data: dict) -> None:
            """Leader broadcasts session state to all followers."""
            session_id = data.get("sessionId", "default")
            state = data.get("state", {})
            if session_id in self._sessions:
                self._sessions[session_id]["state"] = state
                await self._sio.emit(
                    "state_update",
                    state,
                    room=session_id,
                    skip_sid=sid,
                )

        @self._sio.on("control_command")
        async def control_command(sid: str, data: dict) -> dict:
            """Transport commands: PLAY, STOP, JUMP_SONG, TEMPO_NUDGE, PANIC."""
            session_id = data.get("sessionId", "default")
            cmd_type_str = data.get("type", "PLAY")
            try:
                cmd_type = CommandType(cmd_type_str)
            except ValueError:
                cmd_type = CommandType.PLAY

            cmd = ConcurrentCommand(
                command_id=data.get("commandId", f"cmd_{time.monotonic_ns()}"),
                command_type=cmd_type,
                origin=data.get("origin", "director_mobile"),
                sender_user_id=data.get("userId", sid),
                session_id=session_id,
                timestamp_ns=data.get("timestampNs", time.monotonic_ns()),
                payload=data.get("payload", {}),
            )

            result = self._control_manager.process_command(cmd)

            ack_data = {
                "type": MessageType.COMMAND_ACK.value,
                "commandId": cmd.command_id,
                "success": result.success,
                "actionTaken": result.action_taken,
                "state": asdict(result.new_state),
            }

            if result.success:
                if session_id in self._sessions:
                    self._sessions[session_id]["state"] = asdict(result.new_state)

                await self._sio.emit(
                    "state_update",
                    asdict(result.new_state),
                    room=session_id,
                )

                if result.jump_alert:
                    await self._sio.emit(
                        "setlist_jump",
                        asdict(result.jump_alert),
                        room=session_id,
                    )

            return ack_data

    def set_setlist(self, songs: List[Song]) -> None:
        """Update active setlist in concurrent control manager."""
        self._control_manager.set_setlist(songs)

    def get_control_manager(self) -> ConcurrentControlManager:
        return self._control_manager

    def start(self) -> None:
        """Start server in a background thread (non-blocking for Qt event loop)."""
        import uvicorn

        def _run():
            self._loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self._loop)
            # Start broadcast processor
            self._loop.create_task(self._broadcast_processor())
            config = uvicorn.Config(
                self._app,
                host=self._host,
                port=self._port,
                log_level="info",
                loop="asyncio",
            )
            server = uvicorn.Server(config)
            self._loop.run_until_complete(server.serve())

        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()
        print(f"[NET] Server starting on {self._host}:{self._port}")

    async def _broadcast_processor(self) -> None:
        """Process broadcast queue from other threads."""
        while True:
            try:
                event, data, room = self._broadcast_queue.get_nowait()
                await self._sio.emit(event, data, room=room)
            except queue.Empty:
                await asyncio.sleep(0.05)

    def broadcast_state_sync(self, state: dict, room: str = "default") -> None:
        """Thread-safe broadcast from Qt or any other thread."""
        self._broadcast_queue.put(("state_update", state, room))
        # Also store in session cache
        if room in self._sessions:
            self._sessions[room]["state"] = state

    def get_app(self) -> Any:
        return self._app

    def get_url(self) -> str:
        return f"http://{self._host}:{self._port}"
