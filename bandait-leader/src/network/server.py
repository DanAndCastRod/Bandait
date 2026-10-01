"""Socket.IO server for the Bandait leader (CONTRACT_V3, leader side).

Threads:
- The server runs uvicorn + python-socketio on its own asyncio loop in a
  background thread, so the Qt event loop is never blocked.
- Socket.IO handlers run on that loop. They call the thread-safe
  ``ConcurrentControlManager`` directly (pure computation behind a lock) and
  return the ack without waiting on the Qt thread: a frozen GUI cannot stall
  the phones on stage.
- State changes are published two ways, in ``state_version`` order:
  1. to the room, through a single outbox task on the asyncio loop;
  2. to Qt, through ``ServerSignals.state_changed`` (queued connection), so the
     ClockService and the AudioEngine are updated on the Qt main thread.
- The laptop UI submits commands with ``submit_local_command`` (origin
  ``laptop_foh``); they take exactly the same path.
"""

from __future__ import annotations

import asyncio
import errno
import logging
import math
import socket
import threading
from typing import Any, Iterable, List, Optional

import socketio
from PySide6.QtCore import QObject, Signal

from src.domain.concurrent_control import (
    CommandExecutionResult,
    ConcurrentControlManager,
    StateUpdate,
)
from src.domain.models import LEADER_INSTANCE_ID, PROTOCOL_VERSION, ClientRole, SessionStatus
from src.network.http_app import LeaderHttpApp, resolve_follower_dir
from src.network.lan import (
    LanCandidate,
    env_lan_override,
    follower_url,
    is_usable_ipv4,
    lan_candidates,
    select_lan_ip,
)
from src.sync.transport_math import next_downbeat

logger = logging.getLogger(__name__)

_ROLES = {r.value for r in ClientRole}
_BEACON_LATE_TOLERANCE_NS = 50_000_000
_START_TIMEOUT_S = 15.0


class ServerSignals(QObject):
    """Bridge from the asyncio thread to Qt. Connect with Qt.QueuedConnection."""

    state_changed = Signal(object)  # StateUpdate
    followers_changed = Signal(object)  # list[dict]
    status_changed = Signal(str, str)  # status ("starting"|"running"|"error"|"stopped"), message
    setlist_jump = Signal(object)  # setlist_jump wire dict


def _pick_ws_impl() -> str:
    try:
        import uvicorn.config as uvconfig

        protocols = getattr(uvconfig, "WS_PROTOCOLS", {})
    except Exception:
        protocols = {}
    try:
        import websockets  # noqa: F401

        if "websockets-sansio" in protocols:
            return "websockets-sansio"
    except Exception:
        pass
    try:
        import wsproto  # noqa: F401

        return "wsproto"
    except Exception:
        return "auto"


def _is_addr_in_use(exc: OSError) -> bool:
    codes = {errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", 10048), 10048, 10013}
    return getattr(exc, "errno", None) in codes or getattr(exc, "winerror", None) in codes


class BandaitServer:
    """Async Socket.IO server with one session room, owned by the leader."""

    def __init__(
        self,
        clock_service: Any,
        host: str = "0.0.0.0",
        port: int = 4040,
        session_id: str = "default",
        lan_ip: Optional[str] = None,
        follower_dir: Optional[str] = None,
    ) -> None:
        self._clock = clock_service
        self._now = clock_service.get_leader_time_ns
        self._host = host
        self._port = int(port)
        self._session_id = session_id
        self.signals = ServerSignals()
        self._control_manager = ConcurrentControlManager(clock_service, session_id=session_id)
        self._control_manager.add_listener(self._on_state_update)

        self._clients: dict[str, dict] = {}
        self._clients_lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._uvicorn: Any = None
        self._ready = threading.Event()
        self._failure: Optional[str] = None
        self._stopping = False
        self._bound_port: Optional[int] = None
        self._status = "stopped"
        self._status_message = "Servidor detenido"
        self._outbox: Optional[asyncio.Queue] = None
        self._state_event: Optional[asyncio.Event] = None
        self._last_sent_version = 0
        # LAN address advertised to phones (section 8). Runtime choice > env > config.
        self._lan_config = lan_ip
        self._lan_runtime: Optional[str] = None
        self._lan_cache: Optional[List[LanCandidate]] = None
        self._lan_lock = threading.Lock()
        self._follower_dir_config = follower_dir
        self._http_app = LeaderHttpApp(
            self.leader_info, lambda: resolve_follower_dir(self._follower_dir_config)
        )
        self._sio: socketio.AsyncServer = self._build_sio()
        self._app = socketio.ASGIApp(self._sio, other_asgi_app=self._http_app)

    # ------------------------------------------------------------------ public API
    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def host(self) -> str:
        return self._host

    @property
    def port(self) -> int:
        return self._bound_port if self._bound_port is not None else self._port

    @property
    def status(self) -> str:
        return self._status

    @property
    def status_message(self) -> str:
        return self._status_message

    def is_running(self) -> bool:
        return self._status == "running" and self._thread is not None and self._thread.is_alive()

    def get_control_manager(self) -> ConcurrentControlManager:
        return self._control_manager

    def get_state(self) -> dict:
        return self._control_manager.wire_state()

    def set_setlist(self, songs: Iterable[object], start_index: Optional[int] = None) -> None:
        """Load the live setlist (desktop internal API; never exposed on the wire)."""
        self._control_manager.set_setlist(songs, start_index=start_index)

    def submit_local_command(
        self, command_type: str, payload: Optional[dict] = None, command_id: Optional[str] = None
    ) -> CommandExecutionResult:
        """Laptop FOH command (origin ``laptop_foh``). Safe from any thread."""
        return self._control_manager.process_local(command_type, payload, command_id)

    def followers(self) -> List[dict]:
        with self._clients_lock:
            return [dict(info) for info in self._clients.values() if info.get("joined")]

    def get_app(self) -> Any:
        return self._app

    def get_url(self) -> str:
        return f"http://{self._host}:{self.port}"

    def lan_url(self) -> str:
        return f"http://{self.lan_ip()}:{self.port}"

    # ------------------------------------------------------------------ LAN / follower links
    def lan_candidates(self, refresh: bool = False) -> List[LanCandidate]:
        """Usable IPv4 candidates, best first (cached; refresh re-reads the OS)."""
        with self._lan_lock:
            if refresh or self._lan_cache is None:
                try:
                    self._lan_cache = lan_candidates()
                except Exception:
                    logger.exception("LAN enumeration failed")
                    self._lan_cache = []
            return list(self._lan_cache)

    def lan_ip(self) -> str:
        if self._host not in ("0.0.0.0", "", "::"):
            return self._host  # bound to one interface: that is the only reachable IP
        override = self._lan_runtime or env_lan_override() or self._lan_config
        return select_lan_ip(self.lan_candidates(), override)

    def set_lan_ip(self, ip: Optional[str]) -> None:
        """UI choice of the advertised IP (None = automatic)."""
        self._lan_runtime = ip if ip and is_usable_ipv4(ip) else None

    def set_follower_dir(self, path: Optional[str]) -> None:
        self._follower_dir_config = path

    def follower_dir(self):
        return resolve_follower_dir(self._follower_dir_config)

    def follower_url(self) -> str:
        return follower_url(self.lan_ip(), self.port, self._session_id)

    def director_url(self) -> str:
        return follower_url(self.lan_ip(), self.port, self._session_id, director=True)

    def leader_info(self) -> dict:
        """GET /leader-info.json (section 8)."""
        ip = self.lan_ip()
        port = self.port
        return {
            "protocol_version": PROTOCOL_VERSION,
            "leader_instance_id": LEADER_INSTANCE_ID,
            "session_id": self._session_id,
            "ip": ip,
            "port": port,
            "follower_url": follower_url(ip, port, self._session_id),
            "director_url": follower_url(ip, port, self._session_id, director=True),
        }

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> bool:
        """Bind and start in a background thread. Returns False (and reports the
        reason through ``status_changed``) if the port is busy or startup fails."""
        if self._thread is not None and self._thread.is_alive():
            return self._status == "running"
        self._stopping = False
        self._failure = None
        self._ready.clear()
        self._set_status("starting", f"Iniciando servidor en {self._host}:{self._port}...")
        try:
            sock = self._bind_socket()
        except OSError as exc:
            if _is_addr_in_use(exc):
                msg = (
                    f"Puerto {self._port} ocupado. Cierre el otro programa (u otro lider Bandait) "
                    "y use Red > Reintentar servidor."
                )
            else:
                msg = f"No se pudo abrir el puerto {self._port}: {exc}"
            logger.error(msg)
            self._set_status("error", msg)
            return False
        self._bound_port = sock.getsockname()[1]
        # Pre-warm the import outside the server thread: on a cold or loaded laptop
        # (antivirus scan, low memory) importing uvicorn alone can take seconds.
        import uvicorn  # noqa: F401

        self.lan_candidates(refresh=True)  # enumerate here, not on the event loop
        with self._clients_lock:
            self._clients.clear()
        self._last_sent_version = 0
        self._sio = self._build_sio()
        self._app = socketio.ASGIApp(self._sio, other_asgi_app=self._http_app)
        self._thread = threading.Thread(
            target=self._run, args=(sock,), name="bandait-socketio", daemon=True
        )
        self._thread.start()
        self._ready.wait(_START_TIMEOUT_S)
        if self._failure is not None:
            reason = self._failure
            self.stop()
            self._set_status("error", f"El servidor de red no pudo arrancar: {reason}")
            return False
        if not self._ready.is_set():
            # Slow machine, not a failure: never kill a server that is still coming up
            # (that would leave the band without sync). The socket is already listening,
            # so early clients just wait in the backlog; _mark_running() flips the status
            # from the server thread once uvicorn is up, and _run() reports a crash.
            logger.warning("Socket.IO server still starting after %.0fs", _START_TIMEOUT_S)
            self._set_status("starting", "Servidor de red iniciando (equipo lento)...")
            return True
        self._mark_running()
        return True

    def _mark_running(self) -> None:
        if self._stopping or self._status == "running":
            return
        self._set_status("running", f"Escuchando en {self.lan_url()} (sesion {self._session_id})")
        logger.info("Bandait server listening on %s:%s", self._host, self.port)

    def stop(self, timeout: float = 5.0) -> None:
        """Graceful uvicorn shutdown, then join the server thread (bounded)."""
        self._stopping = True
        loop = self._loop
        server = self._uvicorn
        thread = self._thread
        if loop is not None and server is not None:
            try:
                loop.call_soon_threadsafe(setattr, server, "should_exit", True)
            except RuntimeError:
                pass  # loop already closed
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout)
            if thread.is_alive() and server is not None:
                server.force_exit = True
                thread.join(2.0)
            if thread.is_alive():
                logger.error("Socket.IO thread did not stop within %.1fs", timeout + 2.0)
                self._set_status("error", "El servidor de red no se detuvo a tiempo")
                return
        self._thread = None
        self._uvicorn = None
        with self._clients_lock:
            self._clients.clear()
        self._set_status("stopped", "Servidor detenido")
        self.signals.followers_changed.emit([])

    # ------------------------------------------------------------------ internals
    def _set_status(self, status: str, message: str) -> None:
        self._status = status
        self._status_message = message
        try:
            self.signals.status_changed.emit(status, message)
        except RuntimeError:
            pass  # Qt object already deleted at interpreter exit

    def _bind_socket(self) -> socket.socket:
        family = socket.AF_INET6 if ":" in self._host else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                # Windows: SO_REUSEADDR would let a second leader steal the port silently.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            else:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((self._host, self._port))
            sock.listen(128)
            sock.setblocking(False)
        except OSError:
            sock.close()
            raise
        return sock

    def _run(self, sock: socket.socket) -> None:
        import uvicorn

        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        ready = self._ready
        outer = self

        class _Server(uvicorn.Server):
            async def startup(self, sockets=None):  # type: ignore[override]
                await super().startup(sockets=sockets)
                if self.started:
                    ready.set()
                    outer._mark_running()

        try:
            config = uvicorn.Config(
                self._app,
                log_level="warning",
                access_log=False,
                lifespan="off",
                ws=_pick_ws_impl(),
                timeout_graceful_shutdown=2,
            )
            server = _Server(config)
            self._uvicorn = server
            self._outbox = asyncio.Queue()
            self._state_event = asyncio.Event()
            loop.create_task(self._outbox_worker(), name="bandait-outbox")
            loop.create_task(self._beacon_loop(), name="bandait-beacon")
            loop.run_until_complete(server.serve(sockets=[sock]))
        except BaseException as exc:  # SystemExit from uvicorn included
            self._failure = repr(exc)
            logger.exception("Socket.IO server crashed")
            if not self._stopping:
                self._set_status("error", f"El servidor de red se detuvo: {exc!r}")
        finally:
            try:
                pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
                for task in pending:
                    task.cancel()
                if pending:
                    loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                logger.exception("Error while closing the server loop")
            finally:
                self._loop = None
                self._outbox = None
                self._state_event = None
                loop.close()
                try:
                    sock.close()
                except OSError:
                    pass
                ready.set()
            if not self._stopping:
                self._set_status("error", "El servidor de red se detuvo inesperadamente")

    def _on_state_update(self, update: StateUpdate) -> None:
        """Manager listener. Runs on whichever thread processed the command."""
        loop = self._loop
        if loop is not None and not self._stopping:
            try:
                loop.call_soon_threadsafe(self._enqueue, update)
            except RuntimeError:
                pass  # loop closing: followers will get full_state on reconnect
        try:
            self.signals.state_changed.emit(update)
            if update.jump_wire:
                self.signals.setlist_jump.emit(update.jump_wire)
        except RuntimeError:
            pass

    def _enqueue(self, update: StateUpdate) -> None:
        if self._outbox is not None:
            self._outbox.put_nowait(update)
        if self._state_event is not None:
            self._state_event.set()

    async def _outbox_worker(self) -> None:
        assert self._outbox is not None
        outbox = self._outbox
        while True:
            update = await outbox.get()
            try:
                version = update.wire_state["state_version"]
                if version > self._last_sent_version:
                    self._last_sent_version = version
                    await self._sio.emit("state_update", update.wire_state, room=self._session_id)
                if update.jump_wire:
                    await self._sio.emit("setlist_jump", update.jump_wire, room=self._session_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Failed to broadcast state_update")

    async def _beacon_loop(self) -> None:
        """beat_beacon once per bar, at each downbeat, while PLAYING."""
        assert self._state_event is not None
        event = self._state_event
        last_downbeat: Optional[int] = None
        while True:
            try:
                event.clear()
                state, schedule = self._control_manager.snapshot()
                if state.status is not SessionStatus.PLAYING or not schedule:
                    last_downbeat = None
                    await self._wait(event, 1.0)
                    continue
                now = self._now()
                search_from = now - _BEACON_LATE_TOLERANCE_NS
                if last_downbeat is not None:
                    search_from = max(search_from, last_downbeat + 1)
                nxt = next_downbeat(schedule, search_from)
                if nxt is None:
                    await self._wait(event, 1.0)
                    continue
                target = nxt[0]
                delay = (target - self._now()) / 1e9
                if delay > 0:
                    if await self._wait(event, min(delay, 1.0)):
                        continue  # state changed: re-plan
                    if self._now() < target:
                        continue
                current, _ = self._control_manager.snapshot()
                if current.state_version != state.state_version:
                    continue
                payload = {
                    "session_id": self._session_id,
                    "state_version": current.state_version,
                    "anchor_ns": current.anchor_ns,
                    "bpm": current.bpm,
                    "beats_per_bar": current.beats_per_bar,
                    "bar_offset": current.bar_offset,
                    "leader_time_ns": self._now(),
                }
                last_downbeat = target
                await self._sio.emit("beat_beacon", payload, room=self._session_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("beat_beacon loop error")
                await asyncio.sleep(0.5)

    @staticmethod
    async def _wait(event: asyncio.Event, timeout: float) -> bool:
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    def _build_sio(self) -> socketio.AsyncServer:
        sio = socketio.AsyncServer(
            cors_allowed_origins="*",
            async_mode="asgi",
            logger=False,
            engineio_logger=False,
            ping_interval=10,
            ping_timeout=10,
        )
        session = self._session_id

        @sio.event
        async def connect(sid, environ, auth=None):
            logger.info("Client connected: %s", sid)

        @sio.event
        async def disconnect(sid, reason=None):
            with self._clients_lock:
                info = self._clients.pop(sid, None)
            if info and info.get("joined"):
                try:
                    await sio.emit("follower_left", self._follower_wire(sid, info), room=session)
                except Exception:
                    logger.exception("follower_left emit failed")
                self.signals.followers_changed.emit(self.followers())

        @sio.on("join_session")
        async def join_session(sid, data=None):
            if not isinstance(data, dict):
                data = {}
            client_id = data.get("client_id")
            client_id = client_id.strip()[:128] if isinstance(client_id, str) and client_id.strip() else sid
            alias = data.get("alias")
            alias = alias.strip()[:64] if isinstance(alias, str) and alias.strip() else client_id[:8]
            role = data.get("role")
            role = role if role in _ROLES else ClientRole.MUSICIAN.value
            requested = data.get("session_id")
            if isinstance(requested, str) and requested and requested != session:
                logger.warning("Client %s asked for session %r; leader serves %r", sid, requested, session)
            info = {"client_id": client_id, "alias": alias, "role": role, "joined": True}
            await sio.enter_room(sid, session)
            with self._clients_lock:
                self._clients[sid] = info
            # full_state ALWAYS, even when IDLE.
            await sio.emit("full_state", self._control_manager.wire_state(), to=sid)
            await sio.emit("follower_joined", self._follower_wire(sid, info), room=session)
            self.signals.followers_changed.emit(self.followers())
            return {
                "status": "joined",
                "session_id": session,
                "protocol_version": PROTOCOL_VERSION,
                "leader_instance_id": LEADER_INSTANCE_ID,
                "leader_time_ns": self._now(),
            }

        @sio.on("sync_request")
        async def sync_request(sid, data=None):
            leader_time_ns = self._now()
            echo = data.get("client_send_ms") if isinstance(data, dict) else None
            if isinstance(echo, bool) or not isinstance(echo, (int, float)) or not math.isfinite(echo):
                echo = None
            return {"client_send_ms": echo, "leader_time_ns": leader_time_ns}

        @sio.on("control_command")
        async def control_command(sid, data=None):
            received_ns = self._now()
            result = self._control_manager.process_raw(data, received_ns=received_ns)
            return result.ack

        return sio

    @staticmethod
    def _follower_wire(sid: str, info: dict) -> dict:
        return {
            "sid": sid,
            "client_id": info.get("client_id"),
            "alias": info.get("alias"),
            "role": info.get("role"),
        }
