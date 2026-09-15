import json

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.db.models import Q
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from app_cameras.models import Camera

from .models import CameraAnalyticsSettings, DetectionEvent, all_detectable_classes, default_classes, default_zones
from .services import enqueue_frame, link_recording_to_detection, settings_payload


def _auth_camera(request):
    camera_id = request.headers.get('X-Camera-Id') or request.POST.get('camera_id')
    token = request.headers.get('X-Device-Token') or request.POST.get('device_token')
    if not camera_id or not token:
        return None
    try:
        return Camera.objects.get(id=camera_id, device_token=token)
    except (Camera.DoesNotExist, ValueError):
        return None


def _parse_json(request):
    try:
        return json.loads(request.body.decode('utf-8') or '{}')
    except json.JSONDecodeError:
        return {}


@csrf_exempt
@require_POST
def api_frame(request):
    camera = _auth_camera(request)
    if not camera:
        return JsonResponse({'error': 'unauthorized'}, status=401)

    image = request.FILES.get('frame') or request.FILES.get('thumbnail') or request.FILES.get('file')
    if not image:
        return JsonResponse({'error': 'frame required'}, status=400)

    source = request.POST.get('source') or 'motion'
    motion_event_id = request.POST.get('motion_event_id') or None
    phone_hints = []
    raw_hints = request.POST.get('phone_hints') or ''
    if raw_hints:
        try:
            phone_hints = json.loads(raw_hints)
        except json.JSONDecodeError:
            phone_hints = []

    conf = CameraAnalyticsSettings.for_camera(camera)
    if not conf.enabled:
        return JsonResponse({'ok': True, 'queued': False, 'reason': 'disabled'})

    if conf.trigger_mode == CameraAnalyticsSettings.TriggerMode.MOTION and source == 'continuous':
        return JsonResponse({'ok': True, 'queued': False, 'reason': 'motion_only'})

    job = enqueue_frame(
        camera,
        image,
        source=source,
        motion_event_id=int(motion_event_id) if motion_event_id else None,
        phone_hints=phone_hints if isinstance(phone_hints, list) else [],
    )
    return JsonResponse({
        'ok': True,
        'queued': bool(job),
        'job_id': job.id if job else None,
    })


@csrf_exempt
@require_GET
def api_device_settings(request):
    camera = _auth_camera(request)
    if not camera:
        return JsonResponse({'error': 'unauthorized'}, status=401)
    return JsonResponse(settings_payload(camera))


@login_required
@require_GET
def events_page(request):
    from pathlib import Path
    from django.conf import settings as djsettings
    css = Path(djsettings.BASE_DIR) / 'static' / 'css' / 'homeboard.css'
    try:
        bust = str(int(css.stat().st_mtime))
    except OSError:
        bust = '1'
    cameras = Camera.objects.filter(owner=request.user)
    return render(request, 'app_analytics/events.html', {
        'cameras': cameras,
        'static_bust': bust,
    })


@login_required
@require_GET
def api_events(request):
    qs = DetectionEvent.objects.filter(camera__owner=request.user).select_related('camera', 'recording')
    camera_id = request.GET.get('camera_id') or ''
    cls = (request.GET.get('class') or '').strip().lower()
    q = (request.GET.get('q') or '').strip()
    if camera_id:
        qs = qs.filter(camera_id=camera_id)
    if cls:
        qs = qs.filter(classes__icontains=cls)
    if q:
        qs = qs.filter(Q(summary__icontains=q) | Q(classes__icontains=q))
    limit = min(100, max(1, int(request.GET.get('limit') or 50)))
    events = []
    for e in qs[:limit]:
        events.append({
            'id': e.id,
            'camera_id': str(e.camera_id),
            'camera_name': e.camera.name,
            'started_at': e.started_at.isoformat(),
            'ended_at': e.ended_at.isoformat() if e.ended_at else None,
            'classes': e.classes,
            'track_ids': e.track_ids,
            'score': e.score,
            'summary': e.summary,
            'thumbnail': e.thumbnail.url if e.thumbnail else None,
            'recording_url': e.recording.file.url if e.recording and e.recording.file else None,
            'boxes': e.boxes,
        })
    return JsonResponse({'events': events})


@login_required
@require_http_methods(['GET', 'POST'])
def api_camera_settings(request, camera_id):
    camera = get_object_or_404(Camera, id=camera_id, owner=request.user)
    conf = CameraAnalyticsSettings.for_camera(camera)
    if request.method == 'GET':
        return JsonResponse(settings_payload(camera))

    data = _parse_json(request)
    if 'enabled' in data:
        conf.enabled = bool(data['enabled'])
    if 'classes' in data and isinstance(data['classes'], list):
        allowed = set(all_detectable_classes())
        conf.classes = [
            str(c).strip().lower()
            for c in data['classes']
            if str(c).strip() and str(c).strip().lower() in allowed
        ] or default_classes()
    if 'min_confidence' in data:
        conf.min_confidence = float(data['min_confidence'])
    if 'fps' in data:
        conf.fps = float(data['fps'])
    if 'zones' in data and isinstance(data['zones'], list):
        zones = [bool(z) for z in data['zones'][:12]]
        while len(zones) < 12:
            zones.append(True)
        conf.zones = zones
    if 'phone_assist' in data:
        conf.phone_assist = bool(data['phone_assist'])
    if 'summarize' in data:
        conf.summarize = bool(data['summarize'])
    if 'trigger_mode' in data and data['trigger_mode'] in dict(CameraAnalyticsSettings.TriggerMode.choices):
        conf.trigger_mode = data['trigger_mode']
    if 'cooldown_sec' in data:
        conf.cooldown_sec = max(3, min(300, int(data['cooldown_sec'])))
    conf.save()
    return JsonResponse(settings_payload(camera))


@login_required
@require_GET
def api_status(request):
    from .inference import model_status
    from .summarize import ollama_available
    pending = __import__('app_analytics.models', fromlist=['AnalyticsFrameJob']).AnalyticsFrameJob.objects.filter(
        status='pending',
        camera__owner=request.user,
    ).count()
    return JsonResponse({
        'model': model_status(),
        'ollama': ollama_available(),
        'pending_jobs': pending,
    })


@csrf_exempt
@require_POST
def api_internal_broadcast(request):
    """Called by analytics worker to push WS payloads into Daphne process."""
    data = _parse_json(request)
    secret = data.get('secret') or ''
    expected = getattr(settings, 'ANALYTICS_RELAY_SECRET', '') or settings.SECRET_KEY[:32]
    if not secret or secret != expected:
        return JsonResponse({'error': 'forbidden'}, status=403)
    owner_id = data.get('owner_id')
    payload = data.get('payload')
    if not owner_id or not isinstance(payload, dict):
        return JsonResponse({'error': 'bad payload'}, status=400)
    layer = get_channel_layer()
    if not layer:
        return JsonResponse({'error': 'no channel layer'}, status=500)
    async_to_sync(layer.group_send)(
        f'owner_{owner_id}',
        {'type': 'relay.message', 'payload': payload},
    )
    return JsonResponse({'ok': True})


@csrf_exempt
@require_POST
def api_link_recording(request):
    """Optional: camera links uploaded clip to detection event."""
    camera = _auth_camera(request)
    if not camera:
        return JsonResponse({'error': 'unauthorized'}, status=401)
    from app_recordings.models import Recording
    rec_id = request.POST.get('recording_id')
    det_id = request.POST.get('detection_event_id')
    try:
        rec = Recording.objects.get(pk=rec_id, camera=camera)
    except (Recording.DoesNotExist, ValueError, TypeError):
        return JsonResponse({'error': 'recording not found'}, status=404)
    event = link_recording_to_detection(rec, det_id)
    return JsonResponse({'ok': True, 'detection_event_id': event.id if event else None})
