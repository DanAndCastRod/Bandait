"""Vistas 2.3 Ensayo, Banda y Ajustes: señales, setters, pintado y estilo solo por QSS."""

import logging
import re
from pathlib import Path

import pytest

from src.ui import theme
from src.ui.views.band_view import BLUETOOTH_MS, NO_ACCOUNT, BandView, match_members
from src.ui.views.rehearsal_view import RehearsalView, normalize_sections
from src.ui.views.settings_view import BRIGHTNESS_LEVELS, SECTIONS, SettingsView
from src.ui.widgets._paint import paint_failures, reset_paint_failures

SRC = Path(__file__).resolve().parents[1] / "src"
NEW_FILES = [
    SRC / "ui" / "views" / "rehearsal_view.py",
    SRC / "ui" / "views" / "band_view.py",
    SRC / "ui" / "views" / "settings_view.py",
    SRC / "ui" / "widgets" / "flow_layout.py",
]
NOW = 10**15

SONG = {
    "title": "Dame tu aire", "bpm": 92,
    "sections": [
        {"label": "Intro", "kind": "intro", "start_bar": 1, "bars": 2, "chordpro": "[Am]  [F]"},
        {"label": "Estrofa 1", "kind": "verse", "start_bar": 3, "bars": 4, "chordpro": "[Am]Hoy vuelvo a [F]casa"},
        {"label": "Coro", "kind": "chorus", "start_bar": 7, "bars": 4, "chordpro": "[F]Canta con[G]migo"},
    ],
}


def link(rtt=12.0, out=38.0, received=NOW - 1_000_000_000):
    return {"rtt_ms": rtt, "jitter_ms": 1.0, "samples": 10, "output_latency_ms": out,
            "audio": "armed", "muted": False, "received_ns": received}


@pytest.fixture
def themed(qapp):
    """The app as main.py sets it up: bundled fonts, base font and the QSS template."""
    from PySide6.QtGui import QFont

    theme.load_fonts()
    old_font, old_sheet = qapp.font(), qapp.styleSheet()
    font = QFont(theme.FONT_UI)
    font.setPixelSize(theme.SIZE_BASE)
    qapp.setFont(font)
    qapp.setStyleSheet(theme.render_qss((SRC / "styles" / "bandait_dark.qss").read_text(encoding="utf-8")))
    yield qapp
    qapp.setStyleSheet(old_sheet)
    qapp.setFont(old_font)


@pytest.fixture
def no_paint_failures(qapp, caplog):
    reset_paint_failures()
    caplog.set_level(logging.ERROR, logger="bandait.ui.paint")
    yield
    assert paint_failures() == {}
    assert [r.getMessage() for r in caplog.records if r.name == "bandait.ui.paint"] == []


# --------------------------------------------------------------------------- style guard
@pytest.mark.parametrize("path", NEW_FILES, ids=lambda p: p.name)
def test_new_view_files_style_only_through_qss(path):
    text = path.read_text(encoding="utf-8")
    assert "setStyleSheet" not in text
    assert re.findall(r"#[0-9A-Fa-f]{3,8}\b", text) == []
    assert re.findall(r"QFont\(\s*['\"]", text) == []  # the family comes from the app
    assert re.findall(r"QColor\(", text) == []


def test_new_qss_rules_use_tokens_only():
    qss = (SRC / "styles" / "bandait_dark.qss").read_text(encoding="utf-8")
    block = qss[qss.index("Vistas 2.3: Ensayo, Banda y Ajustes"):]
    assert re.findall(r"#[0-9A-Fa-f]{3,8}\b", block) == []
    sizes = re.findall(r"(?<![\d.])\d+px\b", block)
    assert sizes == ["1px"] * len(sizes)  # literal px only for 1 px borders
    theme.render_qss(qss)  # every @TOKEN exists


# --------------------------------------------------------------------------- Ensayo
def test_rehearsal_sections_and_loop_request(qtbot, themed):
    view = RehearsalView()
    qtbot.addWidget(view)
    view.set_song(SONG)
    assert view.lede.text() == "Dame tu aire · repetir secciones con stems y clic"
    assert [b.text() for b in view.chip_group.buttons()] == ["Intro", "Estrofa 1", "Coro"]
    assert view.selected_range() == (1, 2) and view.from_value.text() == "001"
    view.chip_group.button(2).click()
    assert view.selected_range() == (7, 10)
    assert (view.from_value.text(), view.to_value.text()) == ("007", "010")
    assert "Canta" in view.prompt.text()
    view.repeat_buttons[8].click()
    with qtbot.waitSignal(view.loop_requested) as sig:
        view.repeat_btn.click()
    assert sig.args == [7, 10, 8]
    view.repeat_buttons[0].click()
    with qtbot.waitSignal(view.loop_requested) as sig:
        view.repeat_btn.click()
    assert sig.args == [7, 10, 0]


def test_rehearsal_loop_status_switches_the_button(qtbot, themed):
    view = RehearsalView()
    qtbot.addWidget(view)
    view.set_song(SONG)
    view.chip_group.button(2).click()
    view.repeat_btn.click()
    view.set_loop_status(True, 3, 4)
    assert view.status_tag.text() == "CORO · ×3 DE 4"
    assert view.status_tag.property("tag") == "act"
    assert view.repeat_btn.text() == "Detener bucle" and view.repeat_btn.property("variant") == "secondary"
    with qtbot.waitSignal(view.loop_cancelled):
        view.repeat_btn.click()
    view.set_loop_status(True, 5, 0)
    assert view.status_tag.text().endswith("×5 DE ∞")
    view.set_loop_status(False, 0, 0)
    assert view.status_tag.text() == "SIN BUCLE" and view.repeat_btn.text() == "Repetir sección"
    assert view.repeat_btn.property("variant") == "primary"


def test_rehearsal_back_and_practice_tempo(qtbot, themed):
    view = RehearsalView()
    qtbot.addWidget(view)
    view.set_song(SONG)
    with qtbot.waitSignal(view.back_to_show):
        view.back_btn.click()
    assert view.stems_warning.isHidden()
    with qtbot.waitSignal(view.practice_tempo_changed) as sig:
        view.slider.setValue(80)
    assert sig.args == [80]
    assert view.percent_value.text() == "80 %"
    assert view.tempo_note.text() == "74 BPM · el show sigue en 92"
    assert not view.stems_warning.isHidden()
    with qtbot.waitSignal(view.practice_tempo_changed) as sig:
        view.slider.setValue(73)  # snaps to the 5 % grid
    assert sig.args == [75] and view.practice_percent() == 75
    with qtbot.assertNotEmitted(view.practice_tempo_changed):
        view.set_practice_percent(100)
    assert view.stems_warning.isHidden()


def test_rehearsal_without_song_or_sections(qtbot, themed):
    view = RehearsalView()
    qtbot.addWidget(view)
    assert not view.repeat_btn.isEnabled() and view.selected_range() is None
    view.set_song({"title": "Sin secciones", "bpm": 100, "sections": []})
    assert "no tiene secciones" in view.empty.text()
    assert not view.repeat_btn.isEnabled()
    with qtbot.assertNotEmitted(view.loop_requested):
        view.repeat_btn.click()
    view.set_song(SONG)
    view.set_song(None)
    assert view.chip_group.buttons() == [] and view.lede.text().startswith("Sin canción")


def test_normalize_sections_fills_missing_start_bars_and_skips_garbage():
    out = normalize_sections([
        {"label": "A", "bars": 4}, {"label": "B", "bars": 2, "start_bar": "x"}, {"bars": 0}, "basura",
        {"kind": "chorus", "bars": 8, "start_bar": 20},
    ])
    assert [(s["label"], s["start_bar"], s["end_bar"]) for s in out] == [
        ("A", 1, 4), ("B", 5, 6), ("chorus", 20, 27)]
    assert normalize_sections(None) == []


# --------------------------------------------------------------------------- Banda
MEMBERS = [
    {"name": "Daniel Castaneda", "email": "daniel@example.com", "role": "Owner", "instrument": "Teclados"},
    {"name": "Pipe", "email": "pipe@example.com", "role": "MusicDirector", "instrument": "Guitarra"},
    {"name": "Laura", "email": "laura@example.com", "role": "Musician", "instrument": "Voz"},
]


def test_match_members_by_alias_or_name_case_insensitive():
    followers = [{"alias": "PIPE", "role": "director"}, {"alias": "laura", "role": "musician"},
                 {"alias": "Tablet", "role": "musician"}]
    rows = match_members(MEMBERS, followers)
    assert [(r["member"]["name"] if r["member"] else None, r["follower"]["alias"] if r["follower"] else None)
            for r in rows] == [("Daniel Castaneda", None), ("Pipe", "PIPE"), ("Laura", "laura"), (None, "Tablet")]
    # The e-mail's local part also matches; one phone matches one member only.
    rows = match_members(MEMBERS, [{"alias": "daniel"}, {"alias": "Daniel"}])
    assert rows[0]["follower"] == {"alias": "daniel"} and rows[-1]["follower"] == {"alias": "Daniel"}


def test_band_view_table_and_setters(qtbot, themed):
    view = BandView(now=lambda: NOW)
    qtbot.addWidget(view)
    view.set_band("B&O's")
    assert view.lede.text() == "B&O's · los roles se cambian en el hub"
    view.set_members(MEMBERS)
    view.set_followers([
        {"alias": "pipe", "role": "director", "link": link(12.0, 38.0)},
        {"alias": "Laura", "role": "musician", "link": link(18.0, BLUETOOTH_MS + 60)},
        {"alias": "Tablet FOH", "role": "musician", "link": link(35.0, 60.0)},
    ])
    t = view.table
    assert t.rowCount() == 4
    rows = [[view.cell_text(r, c) for c in range(6)] for r in range(4)]
    assert rows[0] == ["Daniel Castaneda", "OWNER", "Teclados", "SIN CONEXIÓN", "—", "—"]
    assert rows[1] == ["Pipe", "MUSICDIRECTOR", "Guitarra", "BUENO", "12.0 ms", "38.0 ms"]
    assert rows[2][5] == "210.0 MS · BT"
    assert rows[3][0] == "Tablet FOH" and rows[3][2] == NO_ACCOUNT
    # Owner and MusicDirector carry the 'act' tag; the Bluetooth output the 'warn' one.
    tag = lambda r, c: t.cellWidget(r, c).findChild(type(view.lede))  # noqa: E731
    assert tag(0, 1).property("tag") == "act" and tag(1, 1).property("tag") == "act"
    assert tag(2, 1).property("tag") == ""
    assert tag(2, 5).property("tag") == "warn"
    assert view.connected_label.text() == "3 conectados ahora"
    assert view.empty.isHidden()


def test_band_view_stale_link_and_empty_state(qtbot, themed):
    view = BandView(now=lambda: NOW)
    qtbot.addWidget(view)
    assert "Sin integrantes" in view.empty.text() and not view.empty.isHidden()
    view.set_followers([{"alias": "Viejo", "role": "musician", "link": link(received=NOW - 60_000_000_000)}])
    assert view.cell_text(0, 3) == "SIN DATOS"
    assert view.connected_label.text() == "1 conectado ahora"
    view.set_followers([])
    assert view.table.rowCount() == 0


def test_band_view_urls_qr_and_signals(qtbot, themed):
    from PySide6.QtWidgets import QApplication

    view = BandView(now=lambda: NOW)
    qtbot.addWidget(view)
    assert view.qr.text() == "SIN RED" and not view.copy_btn.isEnabled()
    view.set_urls("http://192.168.1.6:4040/", "http://192.168.1.6:4040/?role=director")
    assert view.qr.pixmap() is not None and not view.qr.pixmap().isNull()
    assert view.url_label.text() == "http://192.168.1.6:4040/"
    view.copy_btn.click()
    assert QApplication.clipboard().text() == "http://192.168.1.6:4040/?role=director"
    with qtbot.waitSignal(view.open_hub):
        view.hub_btn.click()


# --------------------------------------------------------------------------- Ajustes
def test_settings_sections_and_signals(qtbot, themed):
    view = SettingsView()
    qtbot.addWidget(view)
    assert view.current_section() == "clic"
    for key, _ in SECTIONS:
        view.nav_buttons[key].click()
        assert view.current_section() == key
    with qtbot.waitSignal(view.drummer_click_changed) as sig:
        view.drummer_switch.click()
    assert sig.args == [False] and view.drummer_switch.text() == "APAGADO"
    with qtbot.waitSignal(view.pa_click_changed) as sig:
        view.pa_switch.click()
    assert sig.args == [True] and view.pa_switch.text() == "ENCENDIDO"
    choose, test = view.audio_buttons
    with qtbot.waitSignal(view.open_audio_devices):
        choose.click()
    with qtbot.waitSignal(view.test_click):
        test.click()
    with qtbot.waitSignal(view.retry_server):
        view.retry_btn.click()
    with qtbot.waitSignal(view.brightness_changed) as sig:
        view.brightness_group.button(55).click()
    assert sig.args == [55]
    with qtbot.waitSignal(view.open_account_login):
        view.login_btn.click()
    view.set_cloud_status(True, "Daniel Castaneda", "B&O's")
    for btn, signal in ((view.sync_btn, view.cloud_sync), (view.band_btn, view.choose_band),
                        (view.logout_btn, view.sign_out)):
        with qtbot.waitSignal(signal):
            btn.click()


def test_settings_setters_do_not_emit(qtbot, themed):
    view = SettingsView()
    qtbot.addWidget(view)
    with qtbot.assertNotEmitted(view.drummer_click_changed), qtbot.assertNotEmitted(view.pa_click_changed):
        view.set_click_routing(False, True)
    assert not view.drummer_switch.isChecked() and view.pa_switch.isChecked()
    assert view.pa_switch.text() == "ENCENDIDO"
    with qtbot.assertNotEmitted(view.brightness_changed):
        view.set_brightness(72)
    assert view.brightness() == 70
    view.set_brightness("x")
    assert view.brightness() in BRIGHTNESS_LEVELS
    view.set_audio_status("Focusrite USB ASIO · 48 kHz")
    assert view.audio_status.text() == "Focusrite USB ASIO · 48 kHz"
    view.set_network_status("Activo", "http://192.168.1.6:4040/")
    assert view.network_url.text() == "http://192.168.1.6:4040/"
    view.set_cloud_status(False, "", "")
    assert not view.login_btn.isHidden() and view.logout_btn.isHidden()
    assert not view.sync_btn.isEnabled() and view.cloud_tag.text() == "SIN SESIÓN"
    view.set_cloud_status(True, "daniel@example.com", "B&O's")
    assert view.cloud_tag.text() == "CONECTADA" and view.cloud_tag.property("tag") == "ok"
    assert view.band_label.text() == "B&O's" and view.sync_btn.isEnabled()


def test_settings_voice_config_read_only_from_the_hub(qtbot, themed):
    from src.db.models import BandVoiceConfig

    view = SettingsView()
    qtbot.addWidget(view)
    assert view.voice_values["enabled"].text() == "Sin configuración del hub"
    assert view.voice_tag.text() == "DESDE EL HUB"
    cfg = BandVoiceConfig(band_cloud_id="b1", enabled=True, provider="azure", voice="es-CO-SalomeNeural",
                          rate="+10%", count_in=True, section_cues=False, cue_lead_bars=2, output="all_in_ear")
    view.set_voice_config(cfg)
    values = {k: v.text() for k, v in view.voice_values.items()}
    assert values == {
        "enabled": "Activados", "voice": "es-CO-SalomeNeural · azure", "rate": "+10%", "count_in": "Sí",
        "section_cues": "No", "cue_lead_bars": "2 compases", "output": "Todos los in-ear",
    }
    assert "+10%" in view.click_voice_desc.text()
    view.set_voice_config({"enabled": False})
    assert view.voice_values["enabled"].text() == "Apagados"
    assert view.click_voice_desc.text().startswith("Apagado")
    # Read only: no editable control in the Voz page.
    from PySide6.QtWidgets import QAbstractButton, QLineEdit

    page = view.pages["voz"]
    assert page.findChildren(QAbstractButton) == [] and page.findChildren(QLineEdit) == []


# --------------------------------------------------------------------------- paint smoke
def _build(kind):
    if kind == "ensayo":
        v = RehearsalView()
        v.set_song(SONG)
        v.set_loop_status(True, 1, 4)
        v.set_practice_percent(70)
        return v
    if kind == "banda":
        v = BandView(now=lambda: NOW)
        v.set_band("B&O's")
        v.set_members(MEMBERS)
        v.set_followers([{"alias": "pipe", "role": "director", "link": link()},
                         {"alias": "otro", "role": "musician", "link": None}])
        v.set_urls("http://192.168.1.6:4040/", "http://192.168.1.6:4040/?role=director")
        return v
    v = SettingsView()
    v.set_voice_config({"enabled": True})
    return v


@pytest.mark.parametrize("kind", ["ensayo", "banda", "ajustes"])
@pytest.mark.parametrize("size", [(1280, 720), (1920, 1080)], ids=["1280x720", "1920x1080"])
def test_paint_smoke(qtbot, themed, no_paint_failures, kind, size):
    view = _build(kind)
    qtbot.addWidget(view)
    view.resize(*size)
    view.show()
    themed.processEvents()
    pixmap = view.grab()
    assert not pixmap.isNull()
    assert (pixmap.width(), pixmap.height()) == size  # nothing forces the window larger
    if kind == "ajustes":
        for key, _ in SECTIONS:
            view.show_section(key)
            assert not view.grab().isNull()
    view.repaint()
    themed.processEvents()
