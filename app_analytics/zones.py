"""Zone helpers and event processing utilities."""

from __future__ import annotations

SECTOR_COLS = 4
SECTOR_ROWS = 3


def sector_for_point(cx: float, cy: float, width: float, height: float) -> int:
    if width <= 0 or height <= 0:
        return 0
    col = min(SECTOR_COLS - 1, max(0, int((cx / width) * SECTOR_COLS)))
    row = min(SECTOR_ROWS - 1, max(0, int((cy / height) * SECTOR_ROWS)))
    return row * SECTOR_COLS + col


def filter_by_zones(dets: list[dict], zones: list[bool], width: int, height: int) -> list[dict]:
    if not zones or all(zones):
        return dets
    out = []
    for d in dets:
        idx = sector_for_point(d.get('cx', 0), d.get('cy', 0), width, height)
        if 0 <= idx < len(zones) and zones[idx]:
            out.append({**d, 'sector': idx})
        elif idx >= len(zones):
            out.append(d)
    return out


def template_summary(classes: list[str], tracks: list[int] | None = None) -> str:
    if not classes:
        return 'Обʼєкт у кадрі'
    uniq = []
    for c in classes:
        if c not in uniq:
            uniq.append(c)
    label = ', '.join(uniq)
    if tracks:
        return f'Виявлено: {label} (треки {", ".join(map(str, tracks))})'
    return f'Виявлено: {label}'
