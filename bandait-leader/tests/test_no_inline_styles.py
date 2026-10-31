"""Bandait 2.3: every look comes from the QSS template and theme tokens, never inline.

Before 2.3 the leader had 142 inline setStyleSheet calls and ~274 loose hex colors, and a
global QWidget font-size that overrode every setFont: the UI looked hand-made.
"""

import re
from pathlib import Path

UI = Path(__file__).resolve().parents[1] / "src" / "ui"
QSS = Path(__file__).resolve().parents[1] / "src" / "styles" / "bandait_dark.qss"
ALLOWED = {"app.setStyleSheet(theme.render_qss(f.read()))"}  # the template itself


def test_no_inline_style_sheets_in_the_ui():
    found = []
    for path in UI.rglob("*.py"):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#", 1)[0]
            if ".setStyleSheet(" in code and code.strip() not in ALLOWED:
                found.append(f"{path.relative_to(UI)}:{n}: {line.strip()}")
    assert found == []


def test_qss_template_has_no_literal_colors_and_renders():
    from src.ui import theme

    template = QSS.read_text(encoding="utf-8")
    assert not re.findall(r"#[0-9A-Fa-f]{6}\b", template), "use @TOKEN from theme.py"
    assert "font-size: 13px;\n}" not in template.split("QFrame#panel")[0], "no global font-size on QWidget"
    rendered = theme.render_qss(template)
    assert "@" not in re.sub(r"@media", "", rendered)
