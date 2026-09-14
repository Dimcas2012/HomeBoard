import json

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

from app_cameras.models import Camera

from .models import MotionEvent


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
def report_motion(request):
    camera = _auth_camera(request)
    if not camera:
        return JsonResponse({'error': 'unauthorized'}, status=401)

    note = ''
    score = None
    threshold = None
    sectors = []
    if request.content_type and 'application/json' in request.content_type:
        try:
            payload = json.loads(request.body.decode('utf-8') or '{}')
            note = payload.get('note', '')
            score = payload.get('score')
            threshold = payload.get('threshold')
            sectors = payload.get('sectors') or []
        except json.JSONDecodeError:
            note = ''
    else:
        note = request.POST.get('note', '')
        score = request.POST.get('score')
        threshold = request.POST.get('threshold')
        raw_sectors = request.POST.get('sectors', '')
        if raw_sectors:
            try:
                sectors = json.loads(raw_sectors)
            except json.JSONDecodeError:
                sectors = []

    if not isinstance(sectors, list):
        sectors = []
    try:
        sectors = [int(s) for s in sectors if str(s).strip() != '']
    except (TypeError, ValueError):
        sectors = []

    try:
        score_f = float(score) if score is not None and score != '' else None
    except (TypeError, ValueError):
        score_f = None
    try:
        thr_f = float(threshold) if threshold is not None and threshold != '' else None
    except (TypeError, ValueError):
        thr_f = None

    event = MotionEvent.objects.create(camera=camera, note=note)
    if request.FILES.get('thumbnail'):
        event.thumbnail = request.FILES['thumbnail']
        event.save(update_fields=['thumbnail'])

    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        f'owner_{camera.owner_id}',
        {
            'type': 'relay.message',
            'payload': {
                'type': 'motion',
                'camera_id': str(camera.id),
                'camera_name': camera.name,
                'event_id': event.id,
                'detected_at': event.detected_at.isoformat(),
                'sectors': sectors,
                'score': score_f,
                'threshold': thr_f,
            },
        },
    )
    return JsonResponse({'ok': True, 'event_id': event.id, 'sectors': sectors})


@require_GET
def recent_motion(request):
    if not request.user.is_authenticated:
        return JsonResponse({'error': 'auth required'}, status=401)
    events = (
        MotionEvent.objects.filter(camera__owner=request.user)
        .select_related('camera')[:50]
    )
    return JsonResponse({
        'events': [
            {
                'id': e.id,
                'camera_id': str(e.camera_id),
                'camera_name': e.camera.name,
                'detected_at': e.detected_at.isoformat(),
                'thumbnail': e.thumbnail.url if e.thumbnail else None,
            }
            for e in events
        ]
    })
