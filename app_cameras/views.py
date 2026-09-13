import json

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods, require_POST

from .models import Camera, PairingCode


@login_required
@require_POST
def create_pairing_code(request):
    name = request.POST.get('name') or 'Camera'
    pairing = PairingCode.create_for_user(request.user, camera_name=name)
    return JsonResponse({
        'code': pairing.code,
        'expires_at': pairing.expires_at.isoformat(),
        'camera_name': pairing.camera_name,
    })


@csrf_exempt
@require_POST
def pair_camera(request):
    """Public endpoint: phone uses pairing code to register as a camera."""
    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
    except json.JSONDecodeError:
        payload = request.POST

    code = (payload.get('code') or '').strip().upper()
    if not code:
        return JsonResponse({'error': 'Введіть код pairing'}, status=400)

    pairing = PairingCode.objects.filter(code=code).select_related('created_camera').first()
    if not pairing:
        return JsonResponse({'error': 'Код не знайдено'}, status=404)

    try:
        camera = pairing.consume()
    except ValueError as exc:
        return JsonResponse({'error': str(exc)}, status=400)

    return JsonResponse({
        'camera_id': str(camera.id),
        'device_token': camera.device_token,
        'name': camera.name,
        'owner': camera.owner.username,
    })


@login_required
@require_http_methods(['GET'])
def camera_list_api(request):
    cameras = Camera.objects.filter(owner=request.user)
    data = [
        {
            'id': str(c.id),
            'name': c.name,
            'source_type': c.source_type,
            'is_online': c.is_online,
            'last_seen': c.last_seen.isoformat() if c.last_seen else None,
            'webrtc_play_url': c.webrtc_play_url,
            'mediamtx_path': c.mediamtx_path,
        }
        for c in cameras
    ]
    return JsonResponse({'cameras': data})


@login_required
@require_POST
def create_rtsp_camera(request):
    try:
        payload = json.loads(request.body.decode('utf-8') or '{}')
    except json.JSONDecodeError:
        payload = request.POST

    name = (payload.get('name') or 'IP Camera').strip()
    rtsp_url = (payload.get('rtsp_url') or '').strip()
    mediamtx_path = (payload.get('mediamtx_path') or '').strip()
    if not rtsp_url:
        return JsonResponse({'error': 'rtsp_url обовʼязковий'}, status=400)

    camera = Camera.objects.create(
        owner=request.user,
        name=name,
        source_type=Camera.SourceType.RTSP,
        rtsp_url=rtsp_url,
        mediamtx_path=mediamtx_path or name.lower().replace(' ', '-'),
        is_online=True,
    )
    # Regenerate MediaMTX config so path matches DB
    try:
        from django.core.management import call_command
        call_command('sync_mediamtx')
    except Exception:
        pass
    return JsonResponse({
        'id': str(camera.id),
        'name': camera.name,
        'webrtc_play_url': camera.webrtc_play_url,
        'mediamtx_path': camera.mediamtx_path,
        'rtsp_url': camera.rtsp_url,
        'hint': 'Перезапустіть MediaMTX після зміни RTSP-камер (mediamtx\\run.bat)',
    })


@login_required
@require_POST
def delete_camera(request, camera_id):
    camera = get_object_or_404(Camera, id=camera_id, owner=request.user)
    camera.delete()
    return JsonResponse({'ok': True})
