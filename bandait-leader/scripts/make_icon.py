"""Generate resources/icon.ico (multi-size) for the leader exe and installer.

Usage (from bandait-leader):
    python scripts/make_icon.py            # writes resources/icon.ico
    python scripts/make_icon.py --check    # exit 1 if the .ico is missing or broken

Source, first that is a real image:
1. landing/app/icon-512x512.png (the follower PWA icon). On 2026-10-01 it is
   still a 122-byte text placeholder, so it is skipped.
2. The Bandait app icon kept in the archived Flutter app (1024 px PNG, neon
   metronome on black). Its white outer corners are made transparent.

The .ico is committed, so a normal build does not need this script; rerun it
when the follower icon becomes a real PNG. Needs Pillow (from qrcode[pil]).
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PROJECT_ROOT.parent
# The 1024 px master artwork comes first: the PWA PNGs are generated FROM it
# (`--pwa`), so they must never become the source of the .ico themselves.
SOURCES = [
    REPO_ROOT / "_archive" / "flutter_legacy" / "ios" / "Runner" / "Assets.xcassets"
    / "AppIcon.appiconset" / "Icon-App-1024x1024@1x.png",
    REPO_ROOT / "landing" / "app" / "icon-512x512.png",
]
ICON = PROJECT_ROOT / "resources" / "icon.ico"
# Explorer, taskbar, Start menu, Alt+Tab and the installer use these sizes.
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def pick_source(sources=SOURCES):
    from PIL import Image, UnidentifiedImageError

    for src in sources:
        try:
            with Image.open(src) as img:
                img.load()
            return src
        except (OSError, UnidentifiedImageError):
            continue
    return None


def _transparent_corners(img):
    """Rounded-square app icon on an opaque white canvas: measure the corner
    radius on the diagonal and cut a supersampled rounded mask slightly inside."""
    from PIL import Image, ImageDraw

    rgb = img.convert("RGB")
    w, h = rgb.size
    corner = rgb.getpixel((0, 0))
    if min(corner) < 235:  # not a white canvas: keep as is
        return img.convert("RGBA")
    d = 0
    while d < min(w, h) // 2 and min(rgb.getpixel((d, d))) > 128:
        d += 1
    radius = int(d / (1 - 1 / math.sqrt(2))) if d else 0
    inset = max(2, w // 256)
    scale = 4
    mask = Image.new("L", (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset * scale, inset * scale, (w - inset) * scale - 1, (h - inset) * scale - 1),
        radius=radius * scale, fill=255,
    )
    mask = mask.resize((w, h), Image.LANCZOS)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def build_icon(source: Path, target: Path = ICON) -> Path:
    from PIL import Image

    with Image.open(source) as img:
        img = _transparent_corners(img)
        side = max(img.size)
        if img.size[0] != img.size[1]:  # pad to square, transparent
            square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            square.paste(img, ((side - img.size[0]) // 2, (side - img.size[1]) // 2))
            img = square
        target.parent.mkdir(parents=True, exist_ok=True)
        img.save(target, format="ICO", sizes=[(s, s) for s in SIZES])
    return target


PWA_DIR = REPO_ROOT / "bandait-follower" / "public"
PWA_SIZES = [192, 512]


def build_pwa_icons(source: Path, target_dir: Path = PWA_DIR) -> list:
    """Square, full-bleed PNGs on pure black (OLED) for the follower PWA manifest.

    The rounded-square artwork is placed on #000000, so the icon also works as an
    Android "maskable" icon (no white corners after the launcher's own mask).
    """
    from PIL import Image

    written = []
    with Image.open(source) as img:
        art = _transparent_corners(img)
        side = max(art.size)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 255))
        canvas.alpha_composite(art, ((side - art.size[0]) // 2, (side - art.size[1]) // 2))
        rgb = canvas.convert("RGB")
        target_dir.mkdir(parents=True, exist_ok=True)
        for size in PWA_SIZES:
            out = target_dir / f"icon-{size}x{size}.png"
            rgb.resize((size, size), Image.LANCZOS).save(out, format="PNG", optimize=True)
            written.append(out)
    return written


def icon_sizes(path: Path = ICON) -> list:
    from PIL import Image

    with Image.open(path) as ico:
        return sorted(ico.info.get("sizes", set()))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Genera resources/icon.ico")
    parser.add_argument("--check", action="store_true", help="solo verificar el .ico existente")
    parser.add_argument("--pwa", action="store_true", help="generar tambien los PNG del follower (bandait-follower/public)")
    args = parser.parse_args(argv)
    if args.check:
        if not ICON.is_file():
            print(f"FALTA {ICON}")
            return 1
        sizes = icon_sizes()
        if (256, 256) not in sizes or (16, 16) not in sizes:
            print(f"INCOMPLETO {ICON}: tamanos={sizes}")
            return 1
        print(f"OK {ICON} tamanos={sizes}")
        return 0
    source = pick_source()
    if source is None:
        print("ERROR: ninguna imagen fuente valida: " + ", ".join(map(str, SOURCES)), file=sys.stderr)
        return 1
    out = build_icon(source)
    print(f"Fuente {source}")
    print(f"Escrito {out} ({out.stat().st_size} bytes) tamanos={icon_sizes(out)}")
    if args.pwa:
        for png in build_pwa_icons(source):
            print(f"Escrito {png} ({png.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
