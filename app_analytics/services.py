"""Enqueue + process analytics frame jobs."""

from __future__ import annotations

import logging
import time
from datetime import timedelta

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone
from PIL import Image

from .inference import detect_image, model_status
from .models import (
    AnalyticsFrameJob,
    CameraAnalyticsSettings,
    DetectionEvent,
    all_detectable_classes,
    default_classes,
)
from .summarize import ollama_available, summarize_image
from .tracker import tracker_for
from .zones import filter_by_zones, template_summary

logger = logging.getLogger(__name__)

# per-camera last event time for cooldown
_last_event_at: dict[str, float] = {}
_open_events: dict[str, int] = {}


def settings_payload(camera) -> dict:
    s = CameraAnalyticsSettings.for_camera(camera)
    return {
        'enabled': bool(s.enabled),
        'classes': s.class_list(),
        'available_classes': all_detectable_classes(),
        'default_classes': default_classes(),
        'min_confidence': s.clamped_confidence(),
        'fps': s.clamped_fps(),
        'zones': s.zone_list(),
        'phone_assist': bool(s.phone_assist),
        'summarize': bool(s.summarize),
        'trigger_mode': s.trigger_mode,
        'cooldown_sec': int(s.cooldown_sec or 20),
        'model': model_status(),
        'ollama': ollama_available(),
    }


def enqueue_frame(camera, image_file, *, source='motion', motion_event_id=None, phone_hints=None) -> AnalyticsFrameJob | None:
    conf = CameraAnalyticsSettings.for_camera(camera)
    if not conf.enabled:
        return None
    # Rate-limit continuous uploads roughly by fps
    min_gap = 1.0 / conf.clamped_fps()
    recent = (
        AnalyticsFrameJob.objects.filter(camera=camera, created_at__gte=timezone.now() - timedelta(seconds=min_gap + 0.05))
        .exclude(status=AnalyticsFrameJob.Status.FAILED)
        .exists()
    )
    if recent and source == 'continuous':
        return None

    job = AnalyticsFrameJob(
        camera=camera,
        source=source or 'motion',
        motion_event_id=motion_event_id,
        phone_hints=phone_hints if isinstance(phone_hints, list) else [],
    )
    job.image.save(image_file.name or f'frame-{int(time.time())}.jpg', image_file, save=False)
    job.save()
    return job


def process_job(job: AnalyticsFrameJob) -> DetectionEvent | None:
    camera = job.camera
    conf = CameraAnalyticsSettings.for_camera(camera)
    if not conf.enabled:
        job.status = AnalyticsFrameJob.Status.SKIPPED
        job.finished_at = timezone.now()
        job.error = 'analytics disabled'
        job.save(update_fields=['status', 'finished_at', 'error'])
        return None

    job.status = AnalyticsFrameJob.Status.RUNNING
    job.save(update_fields=['status'])

    try:
        path = job.image.path
        with Image.open(path) as im:
            width, height = im.size

        dets = detect_image(
            path,
            conf=conf.clamped_confidence(),
            classes=conf.class_list(),
        )
        dets = filter_by_zones(dets, conf.zone_list(), width, height)
        dets = tracker_for(camera.id).update(dets)

        # Live boxes always broadcast when we have detections (or empty clear)
        _broadcast_live(camera, dets, width, height)

        if not dets:
            job.status = AnalyticsFrameJob.Status.DONE
            job.finished_at = timezone.now()
            job.save(update_fields=['status', 'finished_at'])
            return None

        cam_key = str(camera.id)
        now = time.time()
        cooldown = float(conf.cooldown_sec or 20)
        last = _last_event_at.get(cam_key, 0)
        open_id = _open_events.get(cam_key)

        classes = []
        tracks = []
        for d in dets:
            if d['cls'] not in classes:
                classes.append(d['cls'])
            tid = d.get('track_id')
            if tid is not None and tid not in tracks:
                tracks.append(tid)
        score = max(d['conf'] for d in dets)

        event = None
        if open_id:
            event = DetectionEvent.objects.filter(pk=open_id, camera=camera).first()

        if event and (now - last) < cooldown * 2:
            # Update open event
            event.ended_at = timezone.now()
            event.classes = classes
            event.track_ids = tracks
            event.score = max(event.score, score)
            event.boxes = dets
            event.save(update_fields=['ended_at', 'classes', 'track_ids', 'score', 'boxes'])
        elif (now - last) >= cooldown:
            event = DetectionEvent(
                camera=camera,
                classes=classes,
                track_ids=tracks,
                score=score,
                boxes=dets,
                motion_event_id=job.motion_event_id,
                summary=template_summary(classes, tracks),
            )
            # Copy frame as thumbnail
            with open(path, 'rb') as fh:
                event.thumbnail.save(
                    f'det-{camera.id}-{int(now)}.jpg',
                    ContentFile(fh.read()),
                    save=False,
                )
            event.save()
            _last_event_at[cam_key] = now
            _open_events[cam_key] = event.id

            if conf.summarize:
                try:
                    text = summarize_image(path, classes=classes)
                    if text:
                        event.summary = text
                        event.save(update_fields=['summary'])
                except Exception:
                    logger.exception('summarize failed')

            _broadcast_event(event)
            _notify_telegram(event)
            event.notified = True
            event.save(update_fields=['notified'])
        else:
            # Within cooldown — still update live boxes only
            event = None

        job.status = AnalyticsFrameJob.Status.DONE
        job.finished_at = timezone.now()
        job.save(update_fields=['status', 'finished_at'])
        return event
    except Exception as exc:
        logger.exception('process_job failed')
        job.status = AnalyticsFrameJob.Status.FAILED
        job.error = str(exc)[:1000]
        job.finished_at = timezone.now()
        job.save(update_fields=['status', 'error', 'finished_at'])
        return None


def claim_next_job() -> AnalyticsFrameJob | None:
    with transaction.atomic():
        job = (
            AnalyticsFrameJob.objects
            .select_for_update()
            .filter(status=AnalyticsFrameJob.Status.PENDING)
            .order_by('created_at')
            .first()
        )
        return job


def cleanup_old_frames(hours: int = 24):
    cutoff = timezone.now() - timedelta(hours=hours)
    qs = AnalyticsFrameJob.objects.filter(
        created_at__lt=cutoff,
        status__in=[
            AnalyticsFrameJob.Status.DONE,
            AnalyticsFrameJob.Status.FAILED,
            AnalyticsFrameJob.Status.SKIPPED,
        ],
    )
    for job in qs[:200]:
        try:
            if job.image:
                job.image.delete(save=False)
        except Exception:
            pass
        job.delete()


def _broadcast_live(camera, dets, width, height):
    payload = {
        'type': 'detection',
        'camera_id': str(camera.id),
        'camera_name': camera.name,
        'live': True,
        'boxes': dets,
        'width': width,
        'height': height,
        'detected_at': timezone.now().isoformat(),
    }
    _relay_payload(camera.owner_id, payload)


def _broadcast_event(event: DetectionEvent):
    payload = {
        'type': 'detection',
        'camera_id': str(event.camera_id),
        'camera_name': event.camera.name,
        'live': False,
        'event_id': event.id,
        'classes': event.classes,
        'track_ids': event.track_ids,
        'score': event.score,
        'boxes': event.boxes,
        'summary': event.summary,
        'thumbnail': event.thumbnail.url if event.thumbnail else None,
        'detected_at': event.started_at.isoformat(),
    }
    _relay_payload(event.camera.owner_id, payload)


def _relay_payload(owner_id, payload: dict):
    """
    Prefer Redis channel layer when configured; otherwise HTTP-poke Daphne
    so InMemoryChannelLayer in the web process can deliver to viewers.
    """
    backend = (getattr(__import__('django.conf', fromlist=['settings']).settings, 'CHANNEL_LAYER', 'memory') or 'memory')
    # CHANNEL_LAYER env is mirrored in settings as CHANNEL_LAYERS backend choice
    from django.conf import settings as djsettings
    use_redis = 'Redis' in str(djsettings.CHANNEL_LAYERS.get('default', {}).get('BACKEND', ''))
    if use_redis:
        layer = get_channel_layer()
        if layer:
            try:
                async_to_sync(layer.group_send)(
                    f'owner_{owner_id}',
                    {'type': 'relay.message', 'payload': payload},
                )
                return
            except Exception:
                logger.exception('redis broadcast failed')
    _http_relay(owner_id, payload)


def _http_relay(owner_id, payload: dict):
    import json
    import urllib.request
    from django.conf import settings as djsettings

    url = getattr(djsettings, 'ANALYTICS_RELAY_URL', 'http://127.0.0.1:9011/analytics/api/internal_broadcast/')
    secret = getattr(djsettings, 'ANALYTICS_RELAY_SECRET', '') or getattr(djsettings, 'SECRET_KEY', '')[:32]
    body = json.dumps({'owner_id': owner_id, 'payload': payload, 'secret': secret}).encode('utf-8')
    req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=3) as resp:
            resp.read()
    except Exception as exc:
        logger.warning('analytics http relay failed: %s', exc)


def _notify_telegram(event: DetectionEvent):
    try:
        from app_integration.services import notify_detection
        notify_detection(event)
    except Exception:
        logger.exception('telegram detection notify failed')


def link_recording_to_detection(recording, detection_event_id=None):
    if not detection_event_id:
        # attach to latest open-ish event for camera within 2 minutes
        cutoff = timezone.now() - timedelta(minutes=2)
        event = (
            DetectionEvent.objects.filter(camera=recording.camera, started_at__gte=cutoff)
            .order_by('-started_at')
            .first()
        )
    else:
        event = DetectionEvent.objects.filter(pk=detection_event_id, camera=recording.camera).first()
    if not event:
        return None
    event.recording = recording
    event.save(update_fields=['recording'])
    return event
