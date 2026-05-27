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
        return cls(
            host=os.getenv("BANDAIT_HOST", "0.0.0.0"),
            port=int(os.getenv("BANDAIT_PORT", "4040")),
            api_key=os.getenv("GOOGLE_API_KEY"),
            db_path=os.getenv("BANDAIT_DB", "bandait.db"),
            audio_channels_out=int(os.getenv("BANDAIT_AUDIO_CHANNELS_OUT", "4")),
            audio_channels_in=int(os.getenv("BANDAIT_AUDIO_CHANNELS_IN", "4")),
            audio_blocksize=int(os.getenv("BANDAIT_AUDIO_BLOCKSIZE", "256")),
            audio_latency=os.getenv("BANDAIT_AUDIO_LATENCY", "low"),
        )
