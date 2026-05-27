"""PyInstaller build script for Bandait Leader (Windows .exe).

Usage:
    cd bandait-leader
    python scripts/build_exe.py

Output:
    dist/BandaitLeader/  — portable folder
    dist/BandaitLeader.exe  — single executable (if --onefile)
"""

import sys
import shutil
from pathlib import Path

# Ensure PyInstaller is available
try:
    import PyInstaller.__main__
except ImportError:
    print("ERROR: PyInstaller not installed. Run: pip install pyinstaller")
    sys.exit(1)


PROJECT_ROOT = Path(__file__).parent.parent.resolve()
SRC = PROJECT_ROOT / "src"
STYLES = SRC / "styles"
RESOURCES = PROJECT_ROOT / "resources"
DIST = PROJECT_ROOT / "dist"
BUILD = PROJECT_ROOT / "build"


def clean() -> None:
    """Remove previous build artifacts."""
    for folder in [DIST, BUILD]:
        if folder.exists():
            shutil.rmtree(folder)
            print(f"Cleaned: {folder}")


def build() -> None:
    """Run PyInstaller with Bandait Leader spec."""
    clean()

    # Collect data files (styles, resources)
    datas = []
    if STYLES.exists():
        datas.append(f"{STYLES}:styles")
    if RESOURCES.exists():
        datas.append(f"{RESOURCES}:resources")

    # Hidden imports for dynamic dependencies
    hidden = [
        "sounddevice",
        "soundfile",
        "numpy",
        "sqlalchemy",
        "alembic",
        "google.generativeai",
        "keyring",
        "qasync",
        "mido",
        "mido.backends.rtmidi",
    ]

    args = [
        str(SRC / "main.py"),
        "--name=BandaitLeader",
        "--windowed",  # No console window
        "--onedir",    # Folder mode (more reliable for audio DLLs)
        "--noconfirm",
        "--clean",
        f"--paths={SRC}",
        f"--icon={RESOURCES / 'icon.ico'}" if (RESOURCES / "icon.ico").exists() else "",
    ]

    # Add datas
    for d in datas:
        args.extend(["--add-data", d])

    # Add hidden imports
    for h in hidden:
        args.extend(["--hidden-import", h])

    # Remove empty strings
    args = [a for a in args if a]

    print("Running PyInstaller with args:")
    for a in args:
        print(f"  {a}")

    PyInstaller.__main__.run(args)

    print(f"\nBuild complete: {DIST / 'BandaitLeader'}")
    print("To create installer, run Inno Setup on scripts/installer.iss")


if __name__ == "__main__":
    build()
