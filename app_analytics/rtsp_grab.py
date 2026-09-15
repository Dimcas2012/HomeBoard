"""Optional RTSP frame grab for IP cameras (MediaMTX / direct RTSP)."""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from django.core.files import File

from app_cameras.models import Camera

from .models import CameraAnalyticsSettings
from .services import enqueue_frame

logger = logging.getLogger(__name__)


def grab_rtsp_jpeg(url: str, out_path: Path, timeout: float = 8.0) -> bool:
    if not url:
        return False
    cmd = [
        'ffmpeg', '-y',
        '-rtsp_transport', 'tcp',
        '-i', url,
        '-frames:v', '1',
        '-q:v', '3',
        str(out_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=timeout)
        return out_path.exists() and out_path.stat().st_size > 0
    except Exception as exc:
        logger.warning('rtsp grab failed: %s', exc)
        return False


def enqueue_rtsp_cameras(limit: int = 4):
    """Enqueue one frame for up to N RTSP cameras with analytics enabled."""
    qs = (
        Camera.objects.filter(source_type=Camera.SourceType.RTSP)
        .select_related('analytics_settings')
    )
    count = 0
    for cam in qs:
        try:
            conf = cam.analytics_settings
        except CameraAnalyticsSettings.DoesNotExist:
            continue
        if not conf.enabled:
            continue
        if conf.trigger_mode != CameraAnalyticsSettings.TriggerMode.CONTINUOUS:
            continue
        url = (cam.rtsp_url or '').strip()
        if not url:
            continue
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            path = Path(tmp.name)
        try:
            if not grab_rtsp_jpeg(url, path):
                continue
            with path.open('rb') as fh:
                enqueue_frame(cam, File(fh, name=f'rtsp-{cam.id}.jpg'), source='continuous')
            count += 1
            if count >= limit:
                break
        finally:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass
    return count
