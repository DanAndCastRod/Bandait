"""Runtime configuration loaded from environment or defaults."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    api_key: str | None
    db_path: str
    audio_channels_out: int
    audio_channels_in: int
    audio_blocksize: int
    audio_latency: str

    @classmethod
    def from_env(cls) -> "Config":
        import sounddevice as sd
        
        # Auto-detect audio hardware capabilities
        try:
            default_out = sd.query_devices(kind="output")
            max_out = default_out.get("max_output_channels", 2)
            default_in = sd.query_devices(kind="input")
            max_in = default_in.get("max_input_channels", 2)
        except Exception:
            max_out = 2
            max_in = 2
        
        # Clamp to hardware limits (default 4, but hardware may only support 2)
        channels_out = min(
            int(os.getenv("BANDAIT_AUDIO_CHANNELS_OUT", "4")),
            max_out
        )
        channels_in = min(
            int(os.getenv("BANDAIT_AUDIO_CHANNELS_IN", "4")),
            max_in
        )
        
        return cls(
            host=os.getenv("BANDAIT_HOST", "0.0.0.0"),
            port=int(os.getenv("BANDAIT_PORT", "4040")),
            api_key=os.getenv("GOOGLE_API_KEY"),
            db_path=os.getenv("BANDAIT_DB", "bandait.db"),
            audio_channels_out=max(1, channels_out),
            audio_channels_in=max(1, channels_in),
            audio_blocksize=int(os.getenv("BANDAIT_AUDIO_BLOCKSIZE", "256")),
            audio_latency=os.getenv("BANDAIT_AUDIO_LATENCY", "low"),
        )
