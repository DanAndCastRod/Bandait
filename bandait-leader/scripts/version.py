"""The leader version, from its single constant.

The constant is ``APP_VERSION`` in ``src/ui/main_window.py`` (shown in
Ayuda > Acerca de). It is read with ``ast``, without importing Qt, by:
- ``scripts/build_exe.py`` (Windows version resource of BandaitLeader.exe),
- the release workflow (installer version, tag check),
- ``tests/test_packaging.py`` (pyproject.toml must match).

Usage:
    python scripts/version.py              # prints 2.1.0
    python scripts/version.py --check-tag v2.1.0   # exit 1 if the tag differs
"""

from __future__ import annotations

import argparse
import ast
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
VERSION_FILE = PROJECT_ROOT / "src" / "ui" / "main_window.py"
VERSION_NAME = "APP_VERSION"
_SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def read_app_version(path: Path = VERSION_FILE) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == VERSION_NAME for t in node.targets
        ):
            value = node.value
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                version = value.value.strip()
                if not _SEMVER.match(version):
                    raise ValueError(f"{VERSION_NAME}={version!r} no es X.Y.Z")
                return version
    raise ValueError(f"{VERSION_NAME} no encontrado en {path}")


def version_tuple(version: str) -> tuple:
    """(major, minor, patch, 0) for the Windows VERSIONINFO resource."""
    m = _SEMVER.match(version)
    if not m:
        raise ValueError(f"{version!r} no es X.Y.Z")
    return tuple(int(x) for x in m.groups()) + (0,)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Version del lider Bandait")
    parser.add_argument("--check-tag", help="tag git (vX.Y.Z) que debe coincidir")
    args = parser.parse_args(argv)
    version = read_app_version()
    if args.check_tag is not None:
        tag = args.check_tag.strip()
        if tag.startswith("refs/tags/"):
            tag = tag[len("refs/tags/"):]
        if tag != f"v{version}":
            print(
                f"ERROR: el tag {tag} no coincide con {VERSION_NAME}={version} "
                f"({VERSION_FILE.relative_to(PROJECT_ROOT)})",
                file=sys.stderr,
            )
            return 1
    print(version)
    return 0


if __name__ == "__main__":
    sys.exit(main())
