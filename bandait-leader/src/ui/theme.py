"""Paleta del líder: Grafito (design-system/tokens.json v3, elegida el 2026-10-30).

Reemplaza a "OLED Noir & Neon": cian y lima puros sobre negro absoluto (16:1 a 19:1)
producían halo y cansaban la vista en escenario. Grafito baja el negro a un gris muy
oscuro, apaga el blanco y desatura los acentos; todo el texto sigue en WCAG AA o mejor.

Los estilos del líder usan estos valores. `tests/test_theme.py` falla si vuelve a aparecer
un color de la paleta neón en la interfaz (salvo el QR, que debe ser blanco y negro puros
para que lo lea la cámara del teléfono).
"""

BG = "#15181C"  # fondo
SURFACE = "#1B1F24"  # paneles
ELEVATED = "#232830"  # tarjetas y campos
RAISED = "#262C34"  # botones en reposo
LINE = "#2E343D"  # bordes
LINE_STRONG = "#363D47"
FAINT = "#4A525D"  # deshabilitado, pistas
MUTED = "#7C8591"  # texto secundario (4.6:1 sobre BG)
SECONDARY = "#8E97A3"
FG = "#D5DAE0"  # texto principal
FG_STRONG = "#E6EAEE"

ACTIVE = "#5CC8C2"  # lo activo: selección, BPM, foco
ACTIVE_HOVER = "#7AD6D1"
SUCCESS = "#B8CF7A"  # pulso, acordes, PLAY
WARNING = "#D9A24E"
DANGER = "#D96459"
DANGER_HOVER = "#E07A70"
SPECIAL = "#B48EDB"

# Equivalencias usadas para migrar la interfaz desde la paleta neón (2026-10-30).
NEON_TO_GRAFITO = {
    "#000000": BG,
    "#0A0A0A": SURFACE,
    "#0F1400": "#1E2318",
    "#1A0505": "#2A1D1D",
    "#141414": ELEVATED,
    "#1A1A1A": ELEVATED,
    "#1E1E1E": RAISED,
    "#262626": "#2B313A",
    "#2A2A2A": LINE,
    "#333333": LINE_STRONG,
    "#444444": FAINT,
    "#4A4A4A": FAINT,
    "#555555": "#5A626E",
    "#666666": MUTED,
    "#888888": SECONDARY,
    "#8A8A8A": SECONDARY,
    "#9A9A9A": SECONDARY,
    "#A0A0A0": "#A3ABB6",
    "#CCCCCC": "#BAC2CC",
    "#F0F0F0": FG,
    "#FFFFFF": FG_STRONG,
    "#00FFFF": ACTIVE,
    "#33FFFF": ACTIVE_HOVER,
    "#7FFFFF": "#9BE0DC",
    "#00CCCC": "#4AB3AD",
    "#00B3B3": "#3E9F9A",
    "#CCFF00": SUCCESS,
    "#FFAA00": WARNING,
    "#FF0000": DANGER,
    "#FF3B3B": DANGER,
    "#FF3B30": DANGER,
    "#FF3333": DANGER,
    "#CC0000": "#B5504A",
    "#FF4D4D": DANGER_HOVER,
    "#FF5A4F": DANGER_HOVER,
    "#FF6B61": "#E68A80",
    "#FF00FF": SPECIAL,
}


def rgb(hex_color: str) -> tuple:
    """'#RRGGBB' -> (r, g, b)."""
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)

# --------------------------------------------------------------------------- Bandait 2.3
# Tonos derivados que el QSS ya usaba (antes como hex sueltos).
RAISED_HOVER = "#2B313A"
FAINT_STRONG = "#5A626E"
ACTIVE_LIGHT = "#9BE0DC"
ACTIVE_DEEP = "#3E9F9A"
DANGER_BG = "#2A1D1D"
DANGER_LIGHT = "#E68A80"
SUCCESS_BG = "#1E2318"
ON_ACCENT = BG  # texto sobre un acento claro
ACTIVE_SOFT = "rgba(92, 200, 194, 0.12)"
ACTIVE_GLOW = "rgba(92, 200, 194, 0.2)"
SUCCESS_SOFT = "rgba(184, 207, 122, 0.12)"
SPECIAL_SOFT = "rgba(180, 142, 219, 0.08)"

# Tipografía: las mismas familias de la PWA y el hub, incluidas en resources/fonts (OFL).
FONT_UI = "Space Grotesk"
FONT_MONO = "IBM Plex Mono"
FONT_UI_STACK = '"Space Grotesk", "Segoe UI", sans-serif'
FONT_MONO_STACK = '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace'
# Escala en px. BASE es el tamaño por defecto de la app (QApplication.setFont), no una regla
# QSS: `QWidget { font-size }` pisaba cualquier tamaño puesto con setFont (2026-10-30).
SIZE_CAPTION = 11
SIZE_SMALL = 12
SIZE_BASE = 14
SIZE_BODY = 15
SIZE_TITLE = 18
SIZE_HEADING = 24
SIZE_DISPLAY = 32
SIZE_HERO = 64
SIZE_GIANT = 88

# Espaciado y radios (px).
SPACE_1, SPACE_2, SPACE_3, SPACE_4, SPACE_5, SPACE_6 = 4, 8, 12, 16, 24, 32
RADIUS = 4
RADIUS_LG = 6

_FONT_FILES = (
    "SpaceGrotesk-Regular.ttf",
    "SpaceGrotesk-Medium.ttf",
    "SpaceGrotesk-Bold.ttf",
    "IBMPlexMono-Regular.ttf",
    "IBMPlexMono-Medium.ttf",
    "IBMPlexMono-SemiBold.ttf",
)
_fonts_loaded = False


def fonts_dir():
    """bandait-leader/resources/fonts in the repo, sys._MEIPASS/resources/fonts in the exe."""
    import sys
    from pathlib import Path

    base = Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[2]
    return base / "resources" / "fonts"


def load_fonts() -> bool:
    """Register the bundled fonts once (needs a QGuiApplication). True if both families exist."""
    global _fonts_loaded
    from PySide6.QtGui import QFont, QFontDatabase

    if not _fonts_loaded:
        for name in _FONT_FILES:
            path = fonts_dir() / name
            if path.is_file():
                QFontDatabase.addApplicationFont(str(path))
        # Older code asks for "Inter" / "JetBrains Mono", which Windows does not have: Qt
        # fell back to Agency FB (a condensed face) and the leader looked hand-made.
        QFont.insertSubstitution("Inter", FONT_UI)
        QFont.insertSubstitution("JetBrains Mono", FONT_MONO)
        _fonts_loaded = True
    families = set(QFontDatabase.families())
    return FONT_UI in families and FONT_MONO in families


def token_values() -> dict:
    """Every UPPER_CASE str/int token of this module, for the QSS template."""
    return {k: v for k, v in globals().items() if k.isupper() and isinstance(v, (str, int)) and not k.startswith("_")}


def render_qss(template: str) -> str:
    """Replace @TOKEN in a QSS template with its value (a typo raises: no silent black)."""
    import re

    values = token_values()

    def sub(m):
        name = m.group(1)
        if name not in values:
            raise KeyError(f"token de QSS desconocido: @{name}")
        value = values[name]
        return f"{value}px" if isinstance(value, int) else str(value)

    return re.sub(r"@([A-Z][A-Z0-9_]*)", sub, template)
