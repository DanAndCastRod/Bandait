"""
Test de integración exhaustivo para Bandait Leader.
Verifica cada componente sin necesidad de UI visual.
Ejecutar: cd bandait-leader && pytest tests/test_integration.py -v
"""

import os
import sys
import tempfile
import time

# Asegurar que src/ está en path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import numpy as np
import pytest


# =============================================================================
# TEST 1: Imports de todos los módulos
# =============================================================================
class TestImports:
    """Verificar que todos los módulos se pueden importar."""

    def test_import_main(self):
        from src.main import main
        assert callable(main)

    def test_import_main_window(self):
        from src.ui.main_window import MainWindow
        assert MainWindow is not None

    def test_import_transport(self):
        from src.ui.widgets.transport import TransportWidget
        assert TransportWidget is not None

    def test_import_mixer(self):
        from src.ui.widgets.mixer import ChannelStrip, MixerWidget
        assert MixerWidget is not None
        assert ChannelStrip is not None

    def test_import_fader(self):
        from src.ui.widgets.fader import FaderWidget
        assert FaderWidget is not None

    def test_import_vu_meter(self):
        from src.ui.widgets.vu_meter import VUMeter
        assert VUMeter is not None

    def test_import_timeline(self):
        from src.ui.widgets.timeline import SectionItem, TimelineWidget
        assert TimelineWidget is not None
        assert SectionItem is not None

    def test_import_stage_view(self):
        from src.ui.views.stage_view import StageView
        assert StageView is not None

    def test_import_library_view(self):
        from src.ui.views.library_view import LibraryView
        assert LibraryView is not None

    def test_import_ai_view(self):
        from src.ui.views.ai_view import AIView, AIWorker
        assert AIView is not None
        assert AIWorker is not None

    def test_import_audio_engine(self):
        from src.audio.audio_engine import AudioEngine
        assert AudioEngine is not None

    def test_import_mixer_audio(self):
        from src.audio.mixer import Mixer
        assert Mixer is not None

    def test_import_recorder(self):
        from src.audio.recorder import RecordingEngine
        assert RecordingEngine is not None

    def test_import_track(self):
        from src.audio.track import Track
        assert Track is not None

    def test_import_clock_service(self):
        from src.sync.clock_service import ClockService
        assert ClockService is not None

    def test_import_server(self):
        from src.network.server import BandaitServer
        assert BandaitServer is not None

    def test_import_models(self):
        from src.db.models import Song
        from src.infrastructure.parsers.chordpro_parser import ChordSegment
        from src.infrastructure.parsers.lrc_parser import LyricLine
        assert Song is not None
        assert LyricLine is not None
        assert ChordSegment is not None

    def test_import_parsers(self):
        from src.infrastructure.parsers.chordpro_parser import ChordProParser
        from src.infrastructure.parsers.lrc_parser import LRCParser
        assert LRCParser is not None
        assert ChordProParser is not None


# =============================================================================
# TEST 2: Audio Engine (modo mock sin hardware)
# =============================================================================
class TestAudioEngine:
    """Probar AudioEngine sin tarjeta de sonido."""

    def test_audio_engine_init_mock(self):
        """Crear engine en modo mock (sin abrir stream real)."""
        from src.audio.audio_engine import AudioEngine
        # Crear sin iniciar stream
        engine = AudioEngine(channels=2, block_size=256)
        assert engine.channels == 2
        assert engine.block_size == 256
        assert engine.sample_rate == 48000
        assert not engine.is_running()

    def test_audio_engine_bpm(self):
        from src.audio.audio_engine import AudioEngine
        engine = AudioEngine(channels=2, block_size=256)
        engine.set_bpm(140.0)
        assert engine._bpm == 140.0

    def test_click_generation(self):
        from src.audio.audio_engine import AudioEngine
        engine = AudioEngine(channels=2, block_size=256)
        click = engine._generate_click()
        assert len(click) > 0
        assert click.dtype == np.float32
        assert click[0] == pytest.approx(0.8, abs=0.01)

    def test_mixer_process(self):
        from src.audio.mixer import Mixer
        mixer = Mixer(input_channels=2, output_channels=2, block_size=256)
        # Simular input stereo
        indata = np.random.randn(256, 2).astype(np.float32) * 0.1
        outdata = mixer.process(indata)
        assert outdata.shape == (256, 2)
        assert np.all(np.abs(outdata) <= 1.0)  # Soft clip

    def test_recorder(self):
        from src.audio.recorder import RecordingEngine
        with tempfile.TemporaryDirectory() as tmpdir:
            rec = RecordingEngine(sample_rate=48000)
            path = rec.start("test_session", n_channels=2, base_dir=tmpdir)
            assert path is not None
            assert os.path.exists(path)
            # Escribir bloque de prueba
            block = np.random.randn(256, 2).astype(np.float32) * 0.1
            rec.write_block(block)
            rec.stop()


# =============================================================================
# TEST 3: Sync y Red
# =============================================================================
class TestSyncNetwork:
    """Probar sincronización y red."""

    def test_clock_service(self):
        from PySide6.QtCore import QCoreApplication

        from src.sync.clock_service import ClockService
        QCoreApplication.instance() or QCoreApplication([])
        clock = ClockService()
        t1 = clock.get_leader_time_ns()
        time.sleep(0.05)  # Aumentar para evitar resolución de timer de Windows
        t2 = clock.get_leader_time_ns()
        assert t2 >= t1  # >= en vez de > por si el sleep no avanza

    def test_server_init(self):
        from src.network.server import BandaitServer
        from src.sync.clock_service import ClockService
        clock = ClockService()
        server = BandaitServer(clock_service=clock)
        assert server is not None


# =============================================================================
# TEST 4: Parsers
# =============================================================================
class TestParsers:
    """Probar parsers de archivos."""

    def test_lrc_parser(self):
        from src.infrastructure.parsers.lrc_parser import LRCParser
        lrc_content = """[ti:Test Song]
[ar:Test Artist]
[00:12.50]Primera línea
[00:15.20]Segunda línea
[00:18.00]Tercera línea"""
        result = LRCParser.parse(lrc_content)
        # parse() retorna List[LyricLine]
        assert len(result) == 3
        assert result[0].text == "Primera línea"
        assert result[0].time_ms == 12500

    def test_chordpro_parser(self):
        from src.infrastructure.parsers.chordpro_parser import ChordProParser
        pro_content = """{title: Mi Canción}
{artist: Artista}
{key: Am}
{capo: 2}

[Am]Primera línea con acorde
Segunda línea sin acorde"""
        result = ChordProParser.parse(pro_content)
        assert result["title"] == "Mi Canción"
        assert result["key"] == "Am"


# =============================================================================
# TEST 5: Base de datos
# =============================================================================
class TestDatabase:
    """Probar base de datos SQLite."""

    def test_db_init(self):
        from src.db.models import init_db
        tmpdir = tempfile.mkdtemp()
        try:
            db_path = os.path.join(tmpdir, "test.db")
            Session = init_db(db_path)
            session = Session()
            assert session is not None
            session.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def test_song_crud(self):
        from src.db.models import Song, init_db
        tmpdir = tempfile.mkdtemp()
        try:
            db_path = os.path.join(tmpdir, "test.db")
            Session = init_db(db_path)
            session = Session()
            song = Song(id="test-1", title="Test", bpm=120, key="C", duration_seconds=180)
            session.add(song)
            session.commit()
            assert song.id is not None
            fetched = session.query(Song).first()
            assert fetched.title == "Test"
            session.close()
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)


# =============================================================================
# TEST 6: Flujo de datos end-to-end
# =============================================================================
class TestDataFlow:
    """Probar flujo completo: Song → Timeline → Stage."""

    @pytest.fixture(autouse=True)
    def setup_qapp(self):
        from PySide6.QtWidgets import QApplication
        self.app = QApplication.instance() or QApplication([])

    def test_song_to_timeline(self):
        from src.ui.widgets.timeline import TimelineWidget
        timeline = TimelineWidget()
        timeline.set_bpm(124)
        timeline.set_duration(240)
        timeline.add_section("Intro", 0, 8)
        timeline.add_section("Verso", 8, 16)
        timeline.add_section("Coro", 24, 16)
        assert len(timeline._sections) == 3
        assert timeline._bpm == 124
        # No iniciar playback en test — el timer requiere event loop

    def test_stage_set_song(self):
        from src.ui.views.stage_view import StageView
        stage = StageView()
        stage.set_song(
            title="Medianoche en Pereira",
            current_lyric="Las luces de la ciudad...",
            next_lyric="Brillan como estrellas...",
            section="Verso A",
            next_section="Coro"
        )
        assert stage._song_title == "Medianoche en Pereira"


# =============================================================================
# TEST 7: UI Widgets (sin mostrar)
# =============================================================================
class TestUIWidgets:
    """Probar que los widgets se pueden construir."""

    def test_transport_widget(self):
        from PySide6.QtWidgets import QApplication

        from src.ui.widgets.transport import TransportWidget
        QApplication.instance() or QApplication([])
        transport = TransportWidget()
        assert transport is not None
        assert transport.time_display.text() == "00:00.000"

    def test_fader_widget(self):
        from PySide6.QtWidgets import QApplication

        from src.ui.widgets.fader import FaderWidget
        QApplication.instance() or QApplication([])
        fader = FaderWidget("Test")
        fader.set_db(-12.0)
        assert fader.get_db() == pytest.approx(-12.0, abs=1.0)

    def test_vu_meter(self):
        from PySide6.QtWidgets import QApplication

        from src.ui.widgets.vu_meter import VUMeter
        QApplication.instance() or QApplication([])
        vu = VUMeter("CH1")
        vu.set_level(0.5)
        assert vu._level == 0.5

    def test_channel_strip(self):
        from PySide6.QtWidgets import QApplication

        from src.ui.widgets.mixer import ChannelStrip
        QApplication.instance() or QApplication([])
        ch = ChannelStrip(0, "Voz")
        assert ch.channel_id == 0
        ch.set_name("Guitarra")
        assert ch._name == "Guitarra"


# =============================================================================
# TEST 8: Configuración y utilidades
# =============================================================================
class TestConfig:
    """Probar configuración."""

    def test_config_load(self):
        from src.core.config import Config
        config = Config(
            host="localhost",
            port=4040,
            api_key="",
            db_path="bandait.db",
            audio_channels_out=2,
            audio_channels_in=2,
            audio_blocksize=256,
            audio_latency="low",
        )
        assert hasattr(config, "host")
        assert config.host == "localhost"


# =============================================================================
# MAIN
# =============================================================================
if __name__ == "__main__":
    pytest.main([__file__, "-v", "--tb=short"])
