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
