"""Socket.IO server for leader-follower sync."""

import asyncio
import logging
from typing import Dict, Set

import socketio
from uvicorn import Config as UvicornConfig, Server

from sync.clock_service import ClockService
from domain.models import SessionState, SessionStatus

logger = logging.getLogger(__name__)


class BandaitServer:
    def __init__(self, host: str, port: int, clock: ClockService):
        self.host = host
        self.port = port
        self.clock = clock
        self.sio = socketio.AsyncServer(cors_allowed_origins="*", async_mode="asgi")
        self.app = socketio.ASGIApp(self.sio)
        self._sessions: Dict[str, Set[str]] = {}
        self._current_state: SessionState | None = None
        self._server: Server | None = None

        self._register_handlers()

    def _register_handlers(self) -> None:
        @self.sio.event
        async def connect(sid, environ):
            logger.info("Follower connected: %s", sid)

        @self.sio.event
        async def disconnect(sid):
            logger.info("Follower disconnected: %s", sid)
            for session, sids in self._sessions.items():
                sids.discard(sid)

        @self.sio.event
        async def join_session(sid, data):
            session_id = data.get("sessionId")
            if session_id:
                self._sessions.setdefault(session_id, set()).add(sid)
                await self.sio.enter_room(sid, session_id)
                logger.info("%s joined session %s", sid, session_id)
                if self._current_state and self._current_state.session_id == session_id:
                    await self.sio.emit("full_state", self._current_state.__dict__, room=sid)

        @self.sio.event
        async def sync_request(sid, data):
            t0 = data.get("t0")
            leader_time = self.clock.monotonic_ns()
            await self.sio.emit("sync_response", {"t0": t0, "t1": leader_time}, room=sid)

    async def broadcast_state(self, state: SessionState) -> None:
        self._current_state = state
        room = state.session_id
        if room in self._sessions:
            await self.sio.emit("state_update", state.__dict__, room=room)

    async def start(self) -> None:
        config = UvicornConfig(self.app, host=self.host, port=self.port, log_level="warning")
        self._server = Server(config)
        logger.info("Bandait server starting on %s:%d", self.host, self.port)
        await self._server.serve()

    async def stop(self) -> None:
        if self._server:
            await self._server.shutdown()
