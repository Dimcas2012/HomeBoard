import json

from django.contrib.auth.decorators import login_required
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.urls import reverse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_http_methods, require_POST

from . import telegram as api
from .models import TelegramIntegration
from .services import (
    find_chat_by_link_code,
    get_or_create_integration,
    handle_webhook_update,
    motion_prefs_for_camera,
    public_base_url,
    send_test_message,
    verify_bot,
)


def _owner_cameras(user):
    from app_cameras.models import Camera
    return list(
        Camera.objects.filter(owner=user).order_by('name').values('id', 'name', 'source_type', 'is_online')
    )


def _integration_payload(obj: TelegramIntegration) -> dict:
    base = public_base_url()
    webhook_url = ''
    if base and obj.webhook_secret:
        webhook_url = base + reverse(
            'integration:telegram_webhook',
            kwargs={'secret': obj.webhook_secret},
        )
    selected = [str(cid) for cid in obj.cameras.values_list('id', flat=True)]
    cameras = _owner_cameras(obj.owner)
    for cam in cameras:
        cam['id'] = str(cam['id'])
        cam['selected'] = obj.notify_all_cameras or cam['id'] in selected
    return {
        'bot_token_masked': obj.masked_token(),
        'has_token': obj.has_token,
        'bot_username': obj.bot_username,
        'bot_id': obj.bot_id,
        'chat_id': obj.chat_id,
        'chat_title': obj.chat_title,
        'has_chat': obj.has_chat,
        'link_code': obj.link_code,
        'deep_link': api.deep_link(obj.bot_username, obj.link_code),
        'is_enabled': obj.is_enabled,
        'notify_motion': obj.notify_motion,
        'notify_camera_offline': obj.notify_camera_offline,
        'notify_all_cameras': obj.notify_all_cameras,
        'camera_ids': selected,
        'cameras': cameras,
        'send_screenshot': obj.send_screenshot,
        'send_video_link': obj.send_video_link,
        'image_quality': obj.clamped_image_quality(),
        'image_max_width': obj.clamped_image_max_width(),
        'is_ready': obj.is_ready,
        'last_error': obj.last_error,
        'last_ok_at': obj.last_ok_at.isoformat() if obj.last_ok_at else None,
        'connected_at': obj.connected_at.isoformat() if obj.connected_at else None,
        'webhook_url': webhook_url,
    }


@login_required
@require_GET
def telegram_settings(request):
    integ = get_or_create_integration(request.user)
    return render(request, 'app_integration/telegram.html', {
        'integration': integ,
        'payload': _integration_payload(integ),
        'payload_json': json.dumps(_integration_payload(integ)),
    })


@login_required
@require_http_methods(['GET'])
def api_status(request):
    integ = get_or_create_integration(request.user)
    return JsonResponse({'ok': True, 'integration': _integration_payload(integ)})


@login_required
@require_POST
def api_save(request):
    integ = get_or_create_integration(request.user)
    data = _parse_body(request)

    token = data.get('bot_token')
    if token is not None:
        token = str(token).strip()
        if token and token != integ.masked_token() and '…' not in token:
            try:
                verify_bot(integ, token)
            except api.TelegramApiError as exc:
                integ.mark_error(str(exc))
                return JsonResponse({'ok': False, 'error': str(exc), 'integration': _integration_payload(integ)}, status=400)
        elif token == '':
            integ.bot_token = ''
            integ.bot_username = ''
            integ.bot_id = None
            integ.save(update_fields=['bot_token', 'bot_username', 'bot_id', 'updated_at'])

    if 'chat_id' in data:
        chat_id = str(data.get('chat_id') or '').strip()
        integ.chat_id = chat_id
        if chat_id and not integ.connected_at:
            from django.utils import timezone
            integ.connected_at = timezone.now()
        integ.save(update_fields=['chat_id', 'connected_at', 'updated_at'])

    for flag in (
        'is_enabled', 'notify_motion', 'notify_camera_offline',
        'notify_all_cameras', 'send_screenshot', 'send_video_link',
    ):
        if flag in data:
            setattr(integ, flag, bool(data.get(flag)))

    if 'image_quality' in data:
        try:
            integ.image_quality = max(10, min(95, int(data.get('image_quality'))))
        except (TypeError, ValueError):
            pass
    if 'image_max_width' in data:
        try:
            integ.image_max_width = int(data.get('image_max_width'))
            integ.image_max_width = integ.clamped_image_max_width()
        except (TypeError, ValueError):
            pass

    integ.save()

    if 'camera_ids' in data or 'notify_all_cameras' in data:
        from app_cameras.models import Camera
        if integ.notify_all_cameras:
            integ.cameras.clear()
        else:
            raw_ids = data.get('camera_ids') or []
            if not isinstance(raw_ids, list):
                raw_ids = []
            cams = Camera.objects.filter(owner=request.user, id__in=raw_ids)
            integ.cameras.set(cams)

    return JsonResponse({'ok': True, 'integration': _integration_payload(integ)})


@login_required
@require_POST
def api_verify(request):
    integ = get_or_create_integration(request.user)
    data = _parse_body(request)
    token = str(data.get('bot_token') or integ.bot_token or '').strip()
    try:
        verify_bot(integ, token)
    except api.TelegramApiError as exc:
        integ.mark_error(str(exc))
        return JsonResponse({'ok': False, 'error': str(exc), 'integration': _integration_payload(integ)}, status=400)
    return JsonResponse({'ok': True, 'integration': _integration_payload(integ)})


@login_required
@require_POST
def api_find_chat(request):
    integ = get_or_create_integration(request.user)
    try:
        found = find_chat_by_link_code(integ)
    except api.TelegramApiError as exc:
        integ.mark_error(str(exc))
        return JsonResponse({'ok': False, 'error': str(exc), 'integration': _integration_payload(integ)}, status=400)
    if not found:
        return JsonResponse({
            'ok': False,
            'error': f'Чат не знайдено. Відкрийте бота і надішліть /start {integ.link_code}, потім натисніть знову.',
            'integration': _integration_payload(integ),
        }, status=404)
    try:
        api.send_message(
            integ.bot_token,
            integ.chat_id,
            '✅ HomeBoard підключено. Сповіщення про рух будуть приходити сюди.',
        )
    except api.TelegramApiError:
        pass
    return JsonResponse({'ok': True, 'integration': _integration_payload(integ)})


@login_required
@require_POST
def api_test(request):
    integ = get_or_create_integration(request.user)
    try:
        send_test_message(integ)
    except api.TelegramApiError as exc:
        integ.mark_error(str(exc))
        return JsonResponse({'ok': False, 'error': str(exc), 'integration': _integration_payload(integ)}, status=400)
    return JsonResponse({'ok': True, 'integration': _integration_payload(integ)})


@login_required
@require_POST
def api_rotate_code(request):
    integ = get_or_create_integration(request.user)
    integ.rotate_link_code()
    return JsonResponse({'ok': True, 'integration': _integration_payload(integ)})


@login_required
@require_POST
def api_disconnect(request):
    integ = get_or_create_integration(request.user)
    integ.chat_id = ''
    integ.chat_title = ''
    integ.is_enabled = False
    integ.connected_at = None
    integ.save(update_fields=['chat_id', 'chat_title', 'is_enabled', 'connected_at', 'updated_at'])
    return JsonResponse({'ok': True, 'integration': _integration_payload(integ)})


@csrf_exempt
@require_GET
def api_device_prefs(request):
    """Camera device asks for Telegram snapshot prefs (auth by device token)."""
    from app_cameras.models import Camera

    camera_id = request.headers.get('X-Camera-Id') or request.GET.get('camera_id')
    token = request.headers.get('X-Device-Token') or request.GET.get('device_token')
    if not camera_id or not token:
        return JsonResponse({'error': 'unauthorized'}, status=401)
    try:
        camera = Camera.objects.get(id=camera_id, device_token=token)
    except (Camera.DoesNotExist, ValueError):
        return JsonResponse({'error': 'unauthorized'}, status=401)
    return JsonResponse({'ok': True, **motion_prefs_for_camera(camera)})


@csrf_exempt
@require_POST
def telegram_webhook(request, secret: str):
    try:
        integ = TelegramIntegration.objects.get(webhook_secret=secret)
    except TelegramIntegration.DoesNotExist:
        return HttpResponse(status=404)

    header_secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token', '')
    if header_secret and header_secret != integ.webhook_secret:
        return HttpResponse(status=403)

    try:
        update = json.loads(request.body.decode('utf-8') or '{}')
    except json.JSONDecodeError:
        return HttpResponse(status=400)

    handle_webhook_update(integ, update)
    return JsonResponse({'ok': True})


def _parse_body(request) -> dict:
    if request.content_type and 'application/json' in request.content_type:
        try:
            return json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return {}
    return request.POST.dict()
