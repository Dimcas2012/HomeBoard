import json

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from app_cameras.models import Camera

from .models import Recording, RecordingStorageSettings


def _auth_camera(request):
    camera_id = request.headers.get('X-Camera-Id') or request.POST.get('camera_id')
    token = request.headers.get('X-Device-Token') or request.POST.get('device_token')
    if not camera_id or not token:
        return None
    try:
        return Camera.objects.get(id=camera_id, device_token=token)
    except (Camera.DoesNotExist, ValueError):
        return None


def _storage_payload(user):
    storage = RecordingStorageSettings.for_user(user)
    used = Recording.usage_bytes(user)
    max_bytes = storage.max_bytes()
    count = Recording.objects.filter(camera__owner=user).count()
    return {
        'cyclic_overwrite': storage.cyclic_overwrite,
        'max_gb': storage.clamped_max_gb(),
        'retention_days': int(storage.retention_days or 0),
        'used_bytes': used,
        'max_bytes': max_bytes,
        'used_gb': round(used / (1024 ** 3), 3),
        'free_gb': round(max(0, max_bytes - used) / (1024 ** 3), 3),
        'usage_percent': round((used / max_bytes) * 100, 1) if max_bytes else 0,
        'count': count,
    }


@csrf_exempt
@require_POST
def upload_recording(request):
    camera = _auth_camera(request)
    if not camera:
        return JsonResponse({'error': 'unauthorized'}, status=401)

    video = request.FILES.get('file')
    if not video:
        return JsonResponse({'error': 'file required'}, status=400)

    trigger = request.POST.get('trigger', Recording.Trigger.MOTION)
    motion_event_id = request.POST.get('motion_event_id') or None

    rec = Recording(
        camera=camera,
        trigger=trigger,
        file=video,
        size_bytes=video.size,
    )
    if motion_event_id:
        rec.motion_event_id = motion_event_id
    rec.save()
    Recording.enforce_retention(camera.owner)
    # If the just-uploaded clip was deleted by retention (edge case), skip notify
    still_exists = Recording.objects.filter(pk=rec.pk).exists()
    if still_exists:
        try:
            from app_integration.services import notify_recording
            notify_recording(rec)
        except Exception:
            pass
    return JsonResponse({'ok': True, 'id': rec.id if still_exists else None, 'url': rec.file.url if still_exists and rec.file else None})


@login_required
@require_GET
def recordings_page(request):
    recordings = (
        Recording.objects.filter(camera__owner=request.user)
        .select_related('camera')[:100]
    )
    storage = _storage_payload(request.user)
    return render(request, 'app_recordings/list.html', {
        'recordings': recordings,
        'storage': storage,
        'storage_json': json.dumps(storage),
    })


@login_required
@require_GET
def recordings_api(request):
    recordings = (
        Recording.objects.filter(camera__owner=request.user)
        .select_related('camera')[:100]
    )
    return JsonResponse({
        'recordings': [
            {
                'id': r.id,
                'camera_id': str(r.camera_id),
                'camera_name': r.camera.name,
                'trigger': r.trigger,
                'started_at': r.started_at.isoformat(),
                'url': r.file.url if r.file else None,
                'size_bytes': r.size_bytes,
            }
            for r in recordings
        ],
        'storage': _storage_payload(request.user),
    })


@login_required
@require_http_methods(['GET', 'POST'])
def api_storage_settings(request):
    storage = RecordingStorageSettings.for_user(request.user)
    if request.method == 'GET':
        return JsonResponse({'ok': True, 'storage': _storage_payload(request.user)})

    if request.content_type and 'application/json' in request.content_type:
        try:
            data = json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            data = {}
    else:
        data = request.POST.dict()

    if 'cyclic_overwrite' in data:
        storage.cyclic_overwrite = bool(data.get('cyclic_overwrite'))
    if 'max_gb' in data:
        try:
            storage.max_gb = max(0.5, min(500.0, float(data.get('max_gb'))))
        except (TypeError, ValueError):
            return JsonResponse({'ok': False, 'error': 'Невірний ліміт ГБ'}, status=400)
    if 'retention_days' in data:
        try:
            storage.retention_days = max(0, min(3650, int(data.get('retention_days'))))
        except (TypeError, ValueError):
            return JsonResponse({'ok': False, 'error': 'Невірна кількість днів'}, status=400)

    storage.save()
    # Apply immediately so UI reflects freed space
    Recording.enforce_retention(request.user)
    return JsonResponse({'ok': True, 'storage': _storage_payload(request.user)})


@login_required
@require_POST
def api_purge_oldest(request):
    """Manual cleanup: delete oldest until under limit (or all if force)."""
    if request.content_type and 'application/json' in request.content_type:
        try:
            data = json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            data = {}
    else:
        data = {}
    force_all = bool(data.get('all'))
    if force_all:
        qs = Recording.objects.filter(camera__owner=request.user)
        for rec in qs:
            if rec.file:
                rec.file.delete(save=False)
            rec.delete()
    else:
        Recording.enforce_retention(request.user)
    return JsonResponse({'ok': True, 'storage': _storage_payload(request.user)})


@login_required
@require_GET
def playback(request, recording_id):
    recording = get_object_or_404(
        Recording.objects.select_related('camera'),
        id=recording_id,
        camera__owner=request.user,
    )
    return render(request, 'app_recordings/playback.html', {'recording': recording})
