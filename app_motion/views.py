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
    if request.content_type and 'application/json' in request.content_type:
        try:
            payload = json.loads(request.body.decode('utf-8') or '{}')
            note = payload.get('note', '')
        except json.JSONDecodeError:
            note = ''
    else:
        note = request.POST.get('note', '')

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
            },
        },
    )
    return JsonResponse({'ok': True, 'event_id': event.id})


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
