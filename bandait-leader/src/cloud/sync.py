"""One sync: workspace (cloud, else cache) -> import of the chosen band into SQLite.

Blocking and Qt-free: the controller runs it on a worker thread. Safety rules:

- Nothing is imported when the chosen band is missing from the workspace or the
  account has no row: a hub-side accident never empties the show.
- Offline, the cached snapshot is re-imported (idempotent), so the database is
  always the last good copy even if a previous import was interrupted.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import List, Optional

from src.cloud.http import CloudError
from src.cloud.workspace import (
    Workspace,
    WorkspaceSnapshot,
    WorkspaceUnavailable,
    obtain_workspace,
)

logger = logging.getLogger(__name__)


@dataclass
class SyncOutcome:
    ok: bool
    message: str
    snapshot: Optional[WorkspaceSnapshot] = None
    band_id: Optional[str] = None
    band_name: str = ""
    report: object = None  # db.cloud_import.ImportReport
    error: Optional[str] = None
    revoked: bool = False
    needs_band_choice: bool = False
    user_initiated: bool = False
    warnings: List[str] = field(default_factory=list)

    @property
    def source(self) -> Optional[str]:
        return self.snapshot.source if self.snapshot else None


def choose_band(workspace: Workspace, wanted: Optional[str]):
    """(band_id or None, needs_choice, message)."""
    if wanted and workspace.band(wanted) is not None:
        return wanted, False, ""
    if not workspace.bands:
        return None, False, "Tu workspace del hub no tiene bandas todavía"
    if wanted:
        return None, True, "La banda elegida ya no está en el hub: elige otra en Cuenta > Elegir banda"
    if len(workspace.bands) == 1:
        return workspace.bands[0].id, False, ""
    return None, True, "Elige qué banda toca este equipo (Cuenta > Elegir banda)"


def import_snapshot(
    snapshot: WorkspaceSnapshot, band_id: Optional[str], db_path: str, *, user_initiated: bool = False
) -> SyncOutcome:
    """Import ``band_id`` from an already obtained snapshot (no network)."""
    from src.db.cloud_import import import_band

    chosen, needs_choice, message = choose_band(snapshot.workspace, band_id)
    outcome = SyncOutcome(
        ok=False, message=message, snapshot=snapshot, band_id=chosen, error=snapshot.error,
        revoked=snapshot.revoked, needs_band_choice=needs_choice, user_initiated=user_initiated,
        warnings=list(snapshot.workspace.warnings),
    )
    if chosen is None:
        return outcome
    content = snapshot.workspace.band(chosen)
    outcome.band_name = content.band.name
    try:
        report = import_band(db_path, content)
    except Exception as err:  # SQLite locked, disk full...: the previous data stays
        logger.exception("Importacion de la nube fallida")
        outcome.message = f"No se pudo guardar el workspace en la base local: {err}"
        outcome.error = outcome.message
        return outcome
    outcome.report = report
    outcome.warnings.extend(report.warnings)
    outcome.ok = True
    outcome.message = (
        f"{content.band.name}: {report.songs_upserted} canciones, {report.setlists_upserted} setlists"
    )
    return outcome


def run_sync(
    auth, base_url: str, api_key: str, *, band_id: Optional[str], db_path: str, cache_path: str,
    user_initiated: bool = False,
) -> SyncOutcome:
    """Fetch (or fall back to the cache) and import. Never raises."""
    try:
        snapshot = obtain_workspace(auth, base_url, api_key, cache_path)
    except WorkspaceUnavailable as err:
        return SyncOutcome(ok=False, message=str(err), error=str(err), revoked=err.revoked,
                           user_initiated=user_initiated)
    except CloudError as err:
        return SyncOutcome(ok=False, message=str(err), error=str(err), user_initiated=user_initiated)
    except Exception as err:  # defensive: a bug here must not kill the worker silently
        logger.exception("Sincronizacion fallida")
        return SyncOutcome(ok=False, message=f"Error inesperado al sincronizar: {err}", error=str(err),
                           user_initiated=user_initiated)
    return import_snapshot(snapshot, band_id, db_path, user_initiated=user_initiated)
