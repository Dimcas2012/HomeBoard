import json

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404, render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from app_cameras.models import Camera

from .models import Recording


def _auth_camera(request):
    camera_id = request.headers.get('X-Camera-Id') or request.POST.get('camera_id')
    token = request.headers.get('X-Device-Token') or request.POST.get('device_token')
    if not camera_id or not token:
        return None
    try:
        return Camera.objects.get(id=camera_id, device_token=token)
    except (Camera.DoesNotExist, ValueError):
        return None


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
    return JsonResponse({'ok': True, 'id': rec.id, 'url': rec.file.url})


@login_required
@require_GET
def recordings_page(request):
    recordings = (
        Recording.objects.filter(camera__owner=request.user)
        .select_related('camera')[:100]
    )
    return render(request, 'app_recordings/list.html', {'recordings': recordings})


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
        ]
    })


@login_required
@require_GET
def playback(request, recording_id):
    recording = get_object_or_404(
        Recording.objects.select_related('camera'),
        id=recording_id,
        camera__owner=request.user,
    )
    return render(request, 'app_recordings/playback.html', {'recording': recording})
