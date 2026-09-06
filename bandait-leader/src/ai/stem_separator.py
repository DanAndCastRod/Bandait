"""Bandait 3.0 — Stem Separation Pipeline (Demucs / Cloud Worker Interface).

Manages asynchronous stem separation tasks with progress tracking,
manifest generation (drums, bass, vocals, other), and local mock/real execution.
"""

import time
from typing import Dict, Optional
from dataclasses import dataclass, field
from enum import Enum


class StemTaskStatus(str, Enum):
    QUEUED = "QUEUED"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


@dataclass
class StemManifest:
    song_id: str
    status: StemTaskStatus
    progress_percent: int = 0
    stems: Dict[str, str] = field(default_factory=dict)  # stem_name -> file_path_or_url
    error_message: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None


class StemSeparator:
    """Orchestrates stem extraction jobs for live rehearsal and follower playback."""

    def __init__(self, output_dir: str = "stems"):
        self.output_dir = output_dir
        self._tasks: Dict[str, StemManifest] = {}

    def queue_separation(self, song_id: str, audio_file_path: str) -> StemManifest:
        """Queue a song for 4-track stem separation."""
        manifest = StemManifest(
            song_id=song_id,
            status=StemTaskStatus.QUEUED,
            progress_percent=0,
            stems={},
        )
        self._tasks[song_id] = manifest
        return manifest

    def get_task_status(self, song_id: str) -> Optional[StemManifest]:
        return self._tasks.get(song_id)

    def process_mock_separation(self, song_id: str) -> StemManifest:
        """Simulate fast separation pipeline for development and staging."""
        manifest = self._tasks.get(song_id)
        if not manifest:
            manifest = self.queue_separation(song_id, f"audio_{song_id}.wav")

        manifest.status = StemTaskStatus.PROCESSING
        manifest.progress_percent = 50

        # Generate paths for 4 standard stems
        manifest.stems = {
            "drums": f"/stems/{song_id}/drums.wav",
            "bass": f"/stems/{song_id}/bass.wav",
            "vocals": f"/stems/{song_id}/vocals.wav",
            "other": f"/stems/{song_id}/other.wav",
        }
        manifest.status = StemTaskStatus.COMPLETED
        manifest.progress_percent = 100
        manifest.completed_at = time.time()
        return manifest
