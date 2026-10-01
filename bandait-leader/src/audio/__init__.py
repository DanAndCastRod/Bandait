"""Leader audio package.

Imports are lazy (PEP 562) so that ``src.audio.portaudio_setup`` can run before
anything imports ``sounddevice``: the PortAudio DLL (ASIO or not) is chosen at
that first import and cannot change afterwards. ``from src.audio import
AudioEngine`` keeps working.
"""

__all__ = ["AudioEngine", "Track", "Mixer", "RecordingEngine"]


def __getattr__(name):
    if name == "AudioEngine":
        from .audio_engine import AudioEngine

        return AudioEngine
    if name == "Track":
        from .track import Track

        return Track
    if name == "Mixer":
        from .mixer import Mixer

        return Mixer
    if name == "RecordingEngine":
        from .recorder import RecordingEngine

        return RecordingEngine
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
