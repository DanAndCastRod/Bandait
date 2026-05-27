"""NTP-like clock synchronization service."""

import asyncio
import logging
import time
from typing import Callable, List

logger = logging.getLogger(__name__)


class ClockService:
    """Provides monotonic nanosecond timestamps and NTP offset calculation."""

    def __init__(self):
        self._offset_ns: int = 0
        self._listeners: List[Callable[[int], None]] = []

    def monotonic_ns(self) -> int:
        return time.monotonic_ns() + self._offset_ns

    def estimate_offset(self, samples: List[tuple[int, int, int]]) -> int:
        """Calculate median offset from (t0, t1, t2) samples."""
        offsets = []
        for t0, t1, t2 in samples:
            rtt = t2 - t0
            offset = t1 - (t0 + rtt // 2)
            offsets.append(offset)
        offsets.sort()
        return offsets[len(offsets) // 2]

    def set_offset(self, offset_ns: int) -> None:
        self._offset_ns = offset_ns
        logger.info("Clock offset updated: %d ns", offset_ns)

    def add_listener(self, callback: Callable[[int], None]) -> None:
        self._listeners.append(callback)

    async def run(self) -> None:
        """Background task: periodic beacon (if needed)."""
        while True:
            await asyncio.sleep(1.0)
            now = self.monotonic_ns()
            for cb in self._listeners:
                try:
                    cb(now)
                except Exception:
                    logger.exception("Clock listener failed")
