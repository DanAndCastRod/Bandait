"""AI Assistant module — Google Cloud proxy for rehearsal analysis and gig assistance.

The API key is loaded from environment or Windows Credential Manager (keyring).
Never expose the key to the PWA or client-side code.
"""

import os
import json
import time
from dataclasses import dataclass
from typing import List, Dict, Optional, Any
from pathlib import Path

import keyring


@dataclass
class AIConfig:
    api_key: str
    model: str = "gemini-1.5-flash"
    rate_limit_per_minute: int = 10


class RateLimiter:
    """Simple in-memory rate limiter."""

    def __init__(self, max_calls: int, window_seconds: int = 60):
        self.max_calls = max_calls
        self.window = window_seconds
        self._calls: List[float] = []

    def can_call(self) -> bool:
        now = time.time()
        self._calls = [c for c in self._calls if now - c < self.window]
        return len(self._calls) < self.max_calls

    def record_call(self) -> None:
        self._calls.append(time.time())

    def wait_time(self) -> float:
        if self.can_call():
            return 0.0
        now = time.time()
        oldest = min(self._calls)
        return max(0.0, self.window - (now - oldest))


class AIAssistant:
    """Google Cloud AI proxy for Bandait rehearsal and gig assistance."""

    def __init__(self, config: Optional[AIConfig] = None):
        self._config = config or self._load_config()
        self._limiter = RateLimiter(self._config.rate_limit_per_minute)
        self._history: List[Dict[str, str]] = []  # chat history
        self._client: Optional[Any] = None
        self._init_client()

    @staticmethod
    def _load_config() -> AIConfig:
        """Load API key from environment or Windows Credential Manager."""
        # 1. Try environment variable
        api_key = os.environ.get("BANDAIT_GOOGLE_API_KEY", "")
        if not api_key:
            # 2. Try keyring (Windows Credential Manager)
            try:
                api_key = keyring.get_password("bandait", "google_api_key") or ""
            except Exception:
                api_key = ""
        if not api_key:
            raise RuntimeError(
                "Google API key not found. Set BANDAIT_GOOGLE_API_KEY env var "
                "or store via: python -m keyring set bandait google_api_key"
            )
        return AIConfig(api_key=api_key)

    def _init_client(self) -> None:
        try:
            import google.generativeai as genai
            genai.configure(api_key=self._config.api_key)
            self._client = genai.GenerativeModel(self._config.model)
        except ImportError:
            self._client = None

    def _call(self, prompt: str, system: Optional[str] = None) -> str:
        if not self._client:
            return "[AI offline: google-generativeai not installed]"
        if not self._limiter.can_call():
            wait = self._limiter.wait_time()
            return f"[Rate limit exceeded. Wait {wait:.0f}s.]"

        self._limiter.record_call()
        try:
            full_prompt = f"{system or ''}\n\n{prompt}".strip()
            response = self._client.generate_content(full_prompt)
            text = response.text if hasattr(response, "text") else str(response)
            self._history.append({"role": "user", "content": prompt[:200]})
            self._history.append({"role": "assistant", "content": text[:200]})
            return text
        except Exception as e:
            return f"[AI Error: {e}]"

    # --- Public AI functions ---

    def analyze_rehearsal(
        self,
        rehearsal_notes: str,
        bpm_data: List[float],
        song_titles: List[str],
    ) -> str:
        """Analyze a rehearsal for tempo consistency and energy."""
        avg_bpm = sum(bpm_data) / len(bpm_data) if bpm_data else 0
        max_dev = max(abs(b - avg_bpm) for b in bpm_data) if bpm_data else 0
        prompt = (
            f"Analyze this band rehearsal:\n"
            f"Songs played: {', '.join(song_titles)}\n"
            f"Average BPM: {avg_bpm:.1f}\n"
            f"Max BPM deviation: {max_dev:.1f}\n"
            f"Director notes: {rehearsal_notes}\n\n"
            f"Provide 3 actionable improvements for the next rehearsal."
        )
        return self._call(prompt, system="You are a professional music director and rehearsal coach.")

    def suggest_setlist(
        self,
        songs: List[Dict[str, Any]],
        target_duration_minutes: int,
        venue_type: str = "general",
    ) -> str:
        """Suggest an optimal setlist order given constraints."""
        songs_text = "\n".join(
            f"- {s.get('title','?')} ({s.get('bpm',120)} BPM, key {s.get('key','?')}, {s.get('duration_seconds',180)//60}min)"
            for s in songs
        )
        prompt = (
            f"Create an optimal setlist for a {target_duration_minutes}-minute show "
            f"at a {venue_type} venue.\n\n"
            f"Available songs:\n{songs_text}\n\n"
            f"Rules: Start with high energy, vary tempo, group similar keys, "
            f"end with a crowd-pleaser. Return the setlist as a numbered list with BPM and key."
        )
        return self._call(prompt, system="You are an experienced live music producer.")

    def chat(self, message: str) -> str:
        """General chat assistant for rehearsal questions."""
        return self._call(
            message,
            system=(
                "You are Bandait, an AI assistant for live bands. "
                "You help with setlist planning, rehearsal scheduling, "
                "technical troubleshooting, and musical advice. "
                "Keep responses concise and actionable."
            ),
        )

    def get_history(self) -> List[Dict[str, str]]:
        return list(self._history)

    def clear_history(self) -> None:
        self._history.clear()
