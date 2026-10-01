"""Qt glue for the cloud account: worker threads in, signals out.

Every network or database operation runs on a daemon ``threading.Thread``; the
results come back to the Qt thread through queued signals. The controller keeps
a generation number: a result that belongs to a session the user already left
(signed out, or signed in again) is dropped instead of being applied.
"""

from __future__ import annotations

import logging
import threading
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Optional

from PySide6.QtCore import QObject, Qt, Signal

from src.cloud.auth import (
    AuthManager,
    CloudUser,
    GoTrueClient,
    LoginCancelled,
    LoginFlow,
    SessionStore,
)
from src.cloud.http import CloudError
from src.cloud.sync import SyncOutcome, import_snapshot, run_sync
from src.cloud.workspace import WorkspaceSnapshot, snapshot_from_cache
from src.core.leader_config import CloudConfig, resolve_cloud_config
from src.core.paths import cloud_workspace_cache_path, get_db_path

logger = logging.getLogger(__name__)

COLOR_OK = "#CCFF00"
COLOR_WARN = "#FFAA00"
COLOR_ERROR = "#FF3B3B"
COLOR_IDLE = "#666666"


def _emit(signal, *args) -> None:
    """Emit from a worker thread; the window may already be gone at shutdown."""
    try:
        signal.emit(*args)
    except RuntimeError:
        pass


@dataclass
class LoginResult:
    ok: bool
    message: str
    user: Optional[CloudUser] = None
    cancelled: bool = False
    persisted: bool = False


def _local_time(iso: Optional[str]) -> Optional[datetime]:
    if not iso:
        return None
    try:
        parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed
    return parsed.astimezone()


def format_cloud_status(
    user: Optional[CloudUser],
    snapshot: Optional[WorkspaceSnapshot],
    *,
    syncing: bool = False,
    revoked_message: Optional[str] = None,
    error: Optional[str] = None,
):
    """(text, color, tooltip) for the status bar."""
    if user is None:
        if revoked_message:
            return "NUBE: sesión cerrada", COLOR_ERROR, revoked_message
        return "NUBE: sin sesión", COLOR_IDLE, "Cuenta > Iniciar sesión con Google"
    who = user.email or user.name or user.id
    if syncing:
        return f"NUBE: {who} // sincronizando...", COLOR_WARN, "Descargando el workspace del hub"
    if snapshot is None:
        if error:
            return "SIN CONEXION // sin copia local", COLOR_ERROR, error
        return f"NUBE: {who}", COLOR_IDLE, "Todavía no se ha sincronizado"
    stamp = _local_time(snapshot.fetched_at)
    if snapshot.source == "cloud":
        when = stamp.strftime("%H:%M") if stamp else "--:--"
        tip = f"Workspace del hub guardado el {snapshot.updated_at or '?'}"
        return f"NUBE: {who} // sincronizado {when}", COLOR_OK, tip
    when = stamp.strftime("%d/%m/%Y %H:%M") if stamp else "fecha desconocida"
    tip = (error or snapshot.error or "Sin conexión con la nube") + ". Se usa la última copia descargada."
    return f"SIN CONEXION // copia del {when}", COLOR_WARN, tip


class CloudController(QObject):
    login_progress = Signal(str, str)  # stage, message
    login_finished = Signal(object)  # LoginResult
    sync_started = Signal()
    sync_finished = Signal(object)  # SyncOutcome
    signed_out = Signal(str)  # message for the status bar

    _login_progress_bg = Signal(int, str, str)
    _login_done_bg = Signal(int, object)
    _sync_done_bg = Signal(int, object)

    def __init__(
        self,
        settings=None,
        *,
        config: Optional[CloudConfig] = None,
        store: Optional[SessionStore] = None,
        open_browser: Callable[[str], bool] = webbrowser.open,
        db_path: Optional[Callable[[], str]] = None,
        cache_path: Optional[Callable[[], str]] = None,
        login_ports=None,
        login_timeout: Optional[float] = None,
        parent=None,
    ):
        super().__init__(parent)
        self.config = config or resolve_cloud_config(settings)
        self.auth = AuthManager(GoTrueClient(self.config.url, self.config.key), store or SessionStore())
        self._open_browser = open_browser
        self._db_path = db_path or get_db_path
        self._cache_path = cache_path or cloud_workspace_cache_path
        self._login_ports = login_ports
        self._login_timeout = login_timeout
        self._lock = threading.Lock()
        self._generation = 0
        self._login_thread: Optional[threading.Thread] = None
        self._login_cancel: Optional[threading.Event] = None
        self._login_flow: Optional[LoginFlow] = None
        self._sync_thread: Optional[threading.Thread] = None
        self._closed = False
        self.last_snapshot: Optional[WorkspaceSnapshot] = None
        self.last_outcome: Optional[SyncOutcome] = None
        self.last_error: Optional[str] = None
        self._login_progress_bg.connect(self._relay_progress, Qt.QueuedConnection)
        self._login_done_bg.connect(self._on_login_done, Qt.QueuedConnection)
        self._sync_done_bg.connect(self._on_sync_done, Qt.QueuedConnection)

    # ------------------------------------------------------------------ state
    @property
    def user(self) -> Optional[CloudUser]:
        return self.auth.user

    def is_signed_in(self) -> bool:
        return self.auth.is_signed_in()

    def login_running(self) -> bool:
        return self._login_thread is not None and self._login_thread.is_alive()

    def sync_running(self) -> bool:
        return self._sync_thread is not None and self._sync_thread.is_alive()

    @property
    def authorize_url(self) -> Optional[str]:
        flow = self._login_flow
        return flow.authorize_url if flow else None

    def status(self, syncing: Optional[bool] = None):
        return format_cloud_status(
            self.user,
            self.last_snapshot,
            syncing=self.sync_running() if syncing is None else syncing,
            revoked_message=self.auth.last_revoked_message,
            error=self.last_error,
        )

    def restore(self) -> Optional[CloudUser]:
        """Saved session and cached snapshot, without network (startup)."""
        user = self.auth.restore()
        if user is not None and self.last_snapshot is None:
            self.last_snapshot = snapshot_from_cache(self._cache_path(), user.id)
        return user

    # ------------------------------------------------------------------ login
    def start_login(self) -> bool:
        if self._closed or self.login_running():
            return False
        cancel = threading.Event()
        kwargs = {"open_browser": self._open_browser}
        if self._login_ports is not None:
            kwargs["ports"] = self._login_ports
        if self._login_timeout is not None:
            kwargs["timeout"] = self._login_timeout
        flow = LoginFlow(self.auth, **kwargs)
        with self._lock:
            generation = self._generation
        self._login_cancel = cancel
        self._login_flow = flow

        def work():
            try:
                user = flow.run(cancel, lambda stage, msg: _emit(self._login_progress_bg, generation, stage, msg))
                result = LoginResult(ok=True, message=f"Sesión iniciada: {user.email or user.name}",
                                     user=user, persisted=self.auth.persisted)
            except LoginCancelled as err:
                result = LoginResult(ok=False, message=str(err), cancelled=True)
            except CloudError as err:
                result = LoginResult(ok=False, message=str(err))
            except Exception as err:  # defensive: report, never die silently
                logger.exception("Login fallido")
                result = LoginResult(ok=False, message=f"Error inesperado al iniciar sesión: {err}")
            _emit(self._login_done_bg, generation, result)

        self._login_thread = threading.Thread(target=work, name="bandait-cloud-login", daemon=True)
        self._login_thread.start()
        return True

    def cancel_login(self) -> None:
        if self._login_cancel is not None:
            self._login_cancel.set()

    def reopen_browser(self) -> bool:
        url = self.authorize_url
        if not url or not self.login_running():
            return False
        try:
            return bool(self._open_browser(url))
        except Exception:
            return False

    def _relay_progress(self, generation: int, stage: str, message: str) -> None:
        if not self._closed:
            self.login_progress.emit(stage, message)

    def _on_login_done(self, generation: int, result: LoginResult) -> None:
        if self._closed:
            return
        with self._lock:
            stale = generation != self._generation
        if result.ok and stale:
            # Signed out while the browser was still open: do not keep that session.
            handle = self.auth.sign_out_local()
            threading.Thread(target=self.auth.revoke, args=(handle,), daemon=True).start()
            result = LoginResult(ok=False, message="Inicio de sesión descartado", cancelled=True)
        if result.ok:
            with self._lock:
                self._generation += 1
            self.last_error = None
            if self.last_snapshot is not None and result.user and self.last_snapshot.user_id != result.user.id:
                self.last_snapshot = None
        self.login_finished.emit(result)

    # ------------------------------------------------------------------ sync
    def _start_worker(self, target: Callable[[], SyncOutcome]) -> bool:
        if self._closed or self.sync_running():
            return False
        with self._lock:
            generation = self._generation

        def work():
            try:
                outcome = target()
            except Exception as err:  # defensive
                logger.exception("Sincronizacion fallida")
                outcome = SyncOutcome(ok=False, message=f"Error inesperado al sincronizar: {err}", error=str(err))
            _emit(self._sync_done_bg, generation, outcome)

        self._sync_thread = threading.Thread(target=work, name="bandait-cloud-sync", daemon=True)
        self._sync_thread.start()
        self.sync_started.emit()
        return True

    def start_sync(self, band_id: Optional[str], user_initiated: bool = False) -> bool:
        """Download (or use the cache) and import ``band_id`` in the background."""
        if not self.is_signed_in():
            return False
        db_path, cache_path = self._db_path(), self._cache_path()
        cfg = self.config
        return self._start_worker(
            lambda: run_sync(self.auth, cfg.url, cfg.key, band_id=band_id, db_path=db_path,
                             cache_path=cache_path, user_initiated=user_initiated)
        )

    def start_import(self, band_id: str, user_initiated: bool = True) -> bool:
        """Re-import from the last snapshot (no network): band change offline."""
        snapshot = self.last_snapshot
        if snapshot is None:
            return False
        db_path = self._db_path()
        return self._start_worker(lambda: import_snapshot(snapshot, band_id, db_path, user_initiated=user_initiated))

    def _on_sync_done(self, generation: int, outcome: SyncOutcome) -> None:
        if self._closed:
            return
        with self._lock:
            stale = generation != self._generation
        if stale:
            logger.info("Resultado de sincronizacion descartado: la sesion cambio")
            return
        if outcome.snapshot is not None:
            self.last_snapshot = outcome.snapshot
        self.last_error = outcome.error
        self.last_outcome = outcome
        if outcome.revoked:
            with self._lock:
                self._generation += 1
        self.sync_finished.emit(outcome)
        if outcome.revoked:
            self.signed_out.emit(self.auth.last_revoked_message or outcome.message)

    # ------------------------------------------------------------------ sign out
    def sign_out(self) -> None:
        """Forget the session now; revoke it on the server in the background."""
        with self._lock:
            self._generation += 1
        self.cancel_login()
        handle = self.auth.sign_out_local()
        self.last_snapshot = None
        self.last_outcome = None
        self.last_error = None
        if handle.refresh_token or handle.access_token:
            threading.Thread(target=self.auth.revoke, args=(handle,), name="bandait-cloud-logout",
                             daemon=True).start()
        self.signed_out.emit("Sesión de la nube cerrada en este equipo")

    def shutdown(self) -> None:
        self._closed = True
        self.cancel_login()
        for thread in (self._login_thread, self._sync_thread):
            if thread is not None and thread.is_alive():
                thread.join(timeout=1.0)
