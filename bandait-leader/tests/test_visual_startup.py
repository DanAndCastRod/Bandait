"""Test visual startup — verifies the app initializes without crashing."""

import sys
import os

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import pytest
from PySide6.QtWidgets import QApplication
from PySide6.QtCore import Qt

from ui.main_window import MainWindow


@pytest.fixture(scope="module")
def app():
    """Create QApplication for tests."""
    app = QApplication.instance()
    if app is None:
        app = QApplication(sys.argv)
    yield app


class TestVisualStartup:
    """Verify the app starts and all components are accessible."""

    def test_main_window_creates(self, app):
        """MainWindow initializes without exception."""
        window = MainWindow()
        assert window is not None
        assert window.windowTitle() == "Bandait DAW — Líder de Sesión"
        window.close()

    def test_all_tabs_exist(self, app):
        """All tabs are created and accessible."""
        window = MainWindow()

        # Check tabs exist
        assert window.tabs is not None
        assert window.tabs.count() >= 4

        # Check each major view
        assert window.stage_view is not None
        assert window.timeline is not None
        assert window.library_view is not None
        assert window.ai_view is not None
        assert window.transport is not None
        assert window.mixer is not None

        window.close()

    def test_transport_buttons(self, app):
        """Transport buttons are created."""
        window = MainWindow()
        t = window.transport

        assert t.play_btn is not None
        assert t.stop_btn is not None
        assert t.rec_btn is not None
        assert t.loop_btn is not None
        assert t.bpm_display is not None
        assert t.time_display is not None

        window.close()

    def test_mixer_channels(self, app):
        """Mixer has 4 channel strips."""
        window = MainWindow()
        m = window.mixer

        assert len(m.channels) == 4
        for ch in m.channels:
            assert ch.vu is not None
            assert ch.fader is not None
            assert ch.mute_btn is not None
            assert ch.solo_btn is not None

        window.close()

    def test_timeline_interactive(self, app):
        """Timeline accepts sections and updates."""
        window = MainWindow()
        tl = window.timeline

        tl.add_section("Intro", 0, 16)
        tl.add_section("Verso", 16, 32)
        tl.add_section("Coro", 48, 32)

        assert len(tl._sections) == 3
        assert tl._sections[0].label == "Intro"
        assert tl._sections[1].label == "Verso"
        assert tl._sections[2].label == "Coro"

        window.close()

    def test_library_has_seed_data(self, app):
        """Library loads seed data from DB."""
        window = MainWindow()
        lv = window.library_view

        # Should have at least 3 seed songs
        assert lv.songs_table.rowCount() >= 3

        # Check first song
        first_title = lv.songs_table.item(0, 0).text()
        assert len(first_title) > 0

        window.close()

    def test_qss_loaded(self, app):
        """QSS stylesheet is applied (not empty)."""
        window = MainWindow()
        style = window.styleSheet()

        # Should have substantial QSS content
        assert len(style) > 500
        assert "background-color" in style
        assert "#000000" in style

        window.close()

    def test_audio_engine_connected(self, app):
        """Audio engine is connected to UI."""
        window = MainWindow()

        assert window.audio_engine is not None
        assert window.audio_engine.mixer is not None
        assert len(window.audio_engine.mixer.tracks) == 4

        window.close()
