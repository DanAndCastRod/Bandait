"""Paleta Grafito (src/ui/theme.py): la interfaz del lider no vuelve a la paleta neon."""

import os
import re

from src.ui.theme import NEON_TO_GRAFITO

ROOT = os.path.join(os.path.dirname(__file__), "..", "src")
NEON = {k.upper() for k in NEON_TO_GRAFITO}
# El QR debe ser blanco y negro puros: lo lee la camara del telefono.
ALLOWED = {("connect_musicians.py", "#FFFFFF"), ("connect_musicians.py", "#000000")}
NEON_RGB = re.compile(r"(QColor|rgba?)\(\s*(0\s*,\s*255\s*,\s*255|204\s*,\s*255\s*,\s*0|255\s*,\s*0\s*,\s*255)\b")


def _ui_files():
    for base in ("ui", "styles"):
        for dirpath, _, files in os.walk(os.path.join(ROOT, base)):
            if "__pycache__" in dirpath:
                continue
            for name in files:
                if name.endswith((".py", ".qss")) and name != "theme.py":
                    yield name, os.path.join(dirpath, name)


def test_no_neon_colors_left_in_the_leader_ui():
    found = []
    for name, path in _ui_files():
        text = open(path, encoding="utf-8").read()
        for m in re.finditer(r"#[0-9A-Fa-f]{6}\b", text):
            color = m.group(0).upper()
            if color in NEON and (name, color) not in ALLOWED:
                found.append(f"{name}: {color}")
        for m in NEON_RGB.finditer(text):
            found.append(f"{name}: {m.group(0)}")
    assert found == []

