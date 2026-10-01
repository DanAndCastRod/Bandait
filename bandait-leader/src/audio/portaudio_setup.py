"""Load PortAudio (through ``sounddevice``) the way the leader needs it on stage.

Three traps, all silent without this module:

1. sounddevice loads its ASIO build whenever ``SD_ENABLE_ASIO`` merely EXISTS
   in the environment, even as "0" or "". The variable is set to "1" only when
   ASIO is wanted and removed otherwise, before the first ``import sounddevice``.
2. sounddevice first calls ``ctypes.util.find_library("portaudio")``, which on
   Windows walks PATH (an empty PATH entry means the current folder). Any
   ``portaudio.dll`` found there (old Audacity/REAPER/conda installs, a dev
   folder) wins over the bundled build and the ASIO choice is ignored. The
   import runs with those PATH entries hidden, PATH is restored right after,
   and the fact is reported (log + audio dialog) so FOH knows.
3. Once sounddevice is imported the DLL is fixed for the process: changing
   ASIO needs a restart. ``last_setup()`` tells the UI what was loaded.

``ensure_sounddevice`` never raises. On any failure the leader runs without
local audio (followers keep their sync) and the reason is in ``error``.
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator, List, MutableMapping, Optional, Tuple

logger = logging.getLogger(__name__)

_TRUE = ("1", "true", "yes", "on", "si")
_FALSE = ("0", "false", "no", "off")

# Same names, same order as sounddevice's own find_library loop.
_FIND_LIBRARY_NAMES = ("portaudio", "bin\\libportaudio-2.dll", "lib/libportaudio.dylib")


def env_flag(value: Optional[str]) -> Optional[bool]:
    """"1/true/yes/on" -> True, "0/false/no/off" -> False, anything else -> None."""
    if value is None:
        return None
    v = value.strip().lower()
    if v in _TRUE:
        return True
    if v in _FALSE:
        return False
    return None


def asio_wanted(setting: Optional[bool], environ: Optional[MutableMapping[str, str]] = None) -> bool:
    """``BANDAIT_ASIO=1`` forces ASIO on, ``BANDAIT_ASIO=0`` forces it off
    (troubleshooting a driver at a gig), otherwise the saved setting decides.
    With no setting (``None``: headless, tests) a truthy ``SD_ENABLE_ASIO`` set
    by hand is honored too."""
    env = os.environ if environ is None else environ
    forced = env_flag(env.get("BANDAIT_ASIO"))
    if forced is not None:
        return forced
    if setting is None:
        return env_flag(env.get("SD_ENABLE_ASIO")) is True
    return bool(setting)


def configure_asio_env(enable: bool, environ: Optional[MutableMapping[str, str]] = None) -> None:
    """Set ``SD_ENABLE_ASIO=1`` or remove it: its mere presence enables ASIO."""
    env = os.environ if environ is None else environ
    if enable:
        env["SD_ENABLE_ASIO"] = "1"
    else:
        env.pop("SD_ENABLE_ASIO", None)


def _dll_in_dir(directory: str) -> Optional[str]:
    """Mirror of ``ctypes.util.find_library`` on Windows for one PATH entry."""
    for name in _FIND_LIBRARY_NAMES:
        fname = os.path.join(directory, name)
        candidates = [fname] if fname.lower().endswith(".dll") else [fname, fname + ".dll"]
        for cand in candidates:
            try:
                if os.path.isfile(cand):
                    return cand
            except (OSError, ValueError):
                continue
    return None


def find_shadowing_portaudio(
    environ: Optional[MutableMapping[str, str]] = None, platform: Optional[str] = None
) -> List[Tuple[str, str]]:
    """``(PATH entry, DLL path)`` pairs that sounddevice would load instead of
    its bundled PortAudio. Windows only: elsewhere find_library is the normal
    way to get the system PortAudio (e.g. libportaudio2 on the Linux CI)."""
    if (platform or sys.platform) != "win32":
        return []
    env = os.environ if environ is None else environ
    found = []
    for entry in env.get("PATH", "").split(os.pathsep):
        dll = _dll_in_dir(entry)
        if dll is not None:
            found.append((entry, os.path.abspath(dll)))
    return found


def _norm(entry: str) -> str:
    return os.path.normcase(os.path.normpath(entry)) if entry else ""


def path_without(path_value: str, entries: List[str]) -> str:
    drop = {_norm(e) for e in entries}
    return os.pathsep.join(e for e in path_value.split(os.pathsep) if _norm(e) not in drop)


@contextmanager
def _hidden_path_entries(entries: List[str], environ: MutableMapping[str, str]) -> Iterator[None]:
    old = environ.get("PATH")
    if not entries or old is None:
        yield
        return
    environ["PATH"] = path_without(old, entries)
    try:
        yield
    finally:
        environ["PATH"] = old


@dataclass
class PortAudioSetup:
    asio_requested: bool = False
    shadowing: List[str] = field(default_factory=list)  # foreign PortAudio DLLs on PATH
    shadow_avoided: bool = False
    library: Optional[str] = None  # DLL that sounddevice actually loaded
    asio_loaded: bool = False  # the loaded build exposes the ASIO host API
    hostapis: List[str] = field(default_factory=list)
    already_imported: bool = False  # sounddevice was imported before this module ran
    error: Optional[str] = None
    module: Any = field(default=None, repr=False)

    @property
    def available(self) -> bool:
        return self.module is not None

    def warnings(self) -> List[str]:
        """Messages for FOH, in Spanish (log, status bar, audio dialog)."""
        msgs = []
        if self.shadowing:
            dlls = "; ".join(self.shadowing)
            if self.shadow_avoided:
                msgs.append(
                    f"Se ignoro un PortAudio ajeno en el PATH ({dlls}); Bandait usa el suyo."
                )
            else:
                msgs.append(
                    f"Un PortAudio ajeno en el PATH ({dlls}) reemplaza al de Bandait y puede "
                    "dejar ASIO sin efecto. Quitelo del PATH y reinicie Bandait."
                )
        if self.module is None:
            msgs.append(
                f"PortAudio no disponible ({self.error}). Los musicos siguen sincronizados, "
                "pero no hay audio local."
            )
        elif self.asio_requested and not self.asio_loaded:
            msgs.append(
                "ASIO esta activado pero el PortAudio cargado no tiene ASIO. Reinicie Bandait; "
                "si persiste, reinstale."
            )
        return msgs

    def as_dict(self) -> dict:
        return {
            "available": self.available,
            "library": self.library,
            "asio_requested": self.asio_requested,
            "asio_loaded": self.asio_loaded,
            "hostapis": list(self.hostapis),
            "sd_enable_asio_env": os.environ.get("SD_ENABLE_ASIO"),
            "shadowing_dlls": list(self.shadowing),
            "shadow_avoided": self.shadow_avoided,
            "already_imported": self.already_imported,
            "error": self.error,
            "warnings": self.warnings(),
        }


_LOCK = threading.Lock()
_SETUP: Optional[PortAudioSetup] = None


def last_setup() -> Optional[PortAudioSetup]:
    return _SETUP


def _describe_loaded(setup: PortAudioSetup, sd: Any) -> None:
    setup.module = sd
    lib = getattr(sd, "_libname", None)
    setup.library = str(lib) if lib else None
    try:
        setup.hostapis = [str(h.get("name", "")) for h in sd.query_hostapis()]
    except Exception:
        setup.hostapis = []
    base = os.path.basename(setup.library or "").lower()
    setup.asio_loaded = "-asio" in base or any(h.upper() == "ASIO" for h in setup.hostapis)


def ensure_sounddevice(
    asio: Optional[bool] = None, environ: Optional[MutableMapping[str, str]] = None
) -> PortAudioSetup:
    """Import sounddevice once, with the right PortAudio build. Idempotent.

    ``asio``: the saved leader setting (``None`` = no setting, environment only).
    The first call decides; later calls return the same result.
    """
    global _SETUP
    with _LOCK:
        if _SETUP is not None:
            return _SETUP
        env = os.environ if environ is None else environ
        setup = PortAudioSetup(asio_requested=asio_wanted(asio, env))
        existing = sys.modules.get("sounddevice")
        if existing is not None:
            setup.already_imported = True
            _describe_loaded(setup, existing)
        else:
            configure_asio_env(setup.asio_requested, env)
            shadow = find_shadowing_portaudio(env)
            setup.shadowing = [dll for _entry, dll in shadow]
            try:
                with _hidden_path_entries([entry for entry, _dll in shadow], env):
                    import sounddevice as sd
                _describe_loaded(setup, sd)
            except Exception as exc:  # OSError (missing/broken DLL), ImportError, cffi errors
                setup.error = f"{type(exc).__name__}: {exc}"
            if shadow and setup.library:
                loaded = _norm(os.path.abspath(setup.library))
                setup.shadow_avoided = all(_norm(dll) != loaded for dll in setup.shadowing)
        _SETUP = setup
    if setup.available:
        logger.info(
            "PortAudio: %s (ASIO pedido=%s, cargado=%s, host APIs=%s)",
            setup.library, setup.asio_requested, setup.asio_loaded, ", ".join(setup.hostapis),
        )
    for msg in setup.warnings():
        logger.warning("%s", msg)
    return setup


def _reset_for_tests() -> None:
    global _SETUP
    with _LOCK:
        _SETUP = None
