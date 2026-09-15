"""Simple IoU multi-object tracker per camera (CPU-friendly)."""

from __future__ import annotations

import time
from dataclasses import dataclass, field


def _iou(a, b) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


@dataclass
class Track:
    track_id: int
    cls: str
    xyxy: list[float]
    conf: float
    hits: int = 1
    misses: int = 0
    updated_at: float = field(default_factory=time.time)


class CameraTracker:
    def __init__(self, iou_thresh: float = 0.3, max_misses: int = 8):
        self.iou_thresh = iou_thresh
        self.max_misses = max_misses
        self._next_id = 1
        self.tracks: dict[int, Track] = {}

    def update(self, detections: list[dict]) -> list[dict]:
        """Assign track_id to each detection; prune stale tracks."""
        assigned = set()
        used_det = set()
        enriched = []

        # Match existing tracks greedily by IoU + same class
        pairs = []
        for tid, tr in self.tracks.items():
            for i, det in enumerate(detections):
                if det.get('cls') != tr.cls:
                    continue
                score = _iou(tr.xyxy, det['xyxy'])
                if score >= self.iou_thresh:
                    pairs.append((score, tid, i))
        pairs.sort(reverse=True)

        for score, tid, i in pairs:
            if tid in assigned or i in used_det:
                continue
            det = detections[i]
            tr = self.tracks[tid]
            tr.xyxy = det['xyxy']
            tr.conf = det['conf']
            tr.hits += 1
            tr.misses = 0
            tr.updated_at = time.time()
            assigned.add(tid)
            used_det.add(i)
            enriched.append({**det, 'track_id': tid})

        # New tracks
        for i, det in enumerate(detections):
            if i in used_det:
                continue
            tid = self._next_id
            self._next_id += 1
            self.tracks[tid] = Track(
                track_id=tid,
                cls=det['cls'],
                xyxy=det['xyxy'],
                conf=det['conf'],
            )
            enriched.append({**det, 'track_id': tid})

        # Missed tracks
        for tid, tr in list(self.tracks.items()):
            if tid in assigned:
                continue
            tr.misses += 1
            if tr.misses > self.max_misses:
                del self.tracks[tid]

        return enriched


_trackers: dict[str, CameraTracker] = {}


def tracker_for(camera_id) -> CameraTracker:
    key = str(camera_id)
    if key not in _trackers:
        _trackers[key] = CameraTracker()
    return _trackers[key]
