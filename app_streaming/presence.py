"""In-process presence for camera WebSocket connections.

Used with InMemoryChannelLayer (single Daphne worker): DB is_online can go stale
after process restart, while channel groups are empty.
"""

from __future__ import annotations

from threading import Lock

_lock = Lock()
_live: set[str] = set()


def mark_live(camera_id: str) -> None:
    with _lock:
        _live.add(str(camera_id))


def mark_dead(camera_id: str) -> None:
    with _lock:
        _live.discard(str(camera_id))


def is_live(camera_id: str) -> bool:
    with _lock:
        return str(camera_id) in _live


def live_ids() -> set[str]:
    with _lock:
        return set(_live)


def clear_all() -> None:
    with _lock:
        _live.clear()
