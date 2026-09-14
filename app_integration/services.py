"""High-level Telegram integration helpers."""

from __future__ import annotations

import io
import logging
import re
from typing import TYPE_CHECKING

from django.conf import settings
from django.utils import timezone

from . import telegram as api
from .models import TelegramIntegration

if TYPE_CHECKING:
    from app_motion.models import MotionEvent

logger = logging.getLogger(__name__)

START_RE = re.compile(r'^/start(?:@\w+)?(?:\s+(.+))?$', re.IGNORECASE)


def get_or_create_integration(user) -> TelegramIntegration:
    obj, _ = TelegramIntegration.objects.get_or_create(owner=user)
    return obj


def public_base_url() -> str:
    origins = getattr(settings, 'CSRF_TRUSTED_ORIGINS', []) or []
    for origin in origins:
        origin = (origin or '').rstrip('/')
        if origin.startswith('https://'):
            return origin
    hosts = getattr(settings, 'ALLOWED_HOSTS', []) or []
    for host in hosts:
        if host and host not in ('*', 'localhost', '127.0.0.1'):
            return f'https://{host}'
    return ''


def prepare_telegram_jpeg(path: str, *, quality: int = 70, max_width: int = 1280) -> bytes:
    """Resize/recompress image for Telegram according to user prefs."""
    from PIL import Image

    quality = max(10, min(95, int(quality or 70)))
    max_width = int(max_width or 1280)
    with Image.open(path) as img:
        img = img.convert('RGB')
        w, h = img.size
        if w > max_width > 0:
            nh = max(1, round(h * (max_width / w)))
            img = img.resize((max_width, nh), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality, optimize=True)
        return buf.getvalue()


def motion_prefs_for_camera(camera) -> dict:
    """Prefs for camera client (jpeg quality) based on owner's Telegram settings."""
    integ = TelegramIntegration.objects.filter(owner_id=camera.owner_id).first()
    if not integ or not integ.is_ready or not integ.allows_camera(camera):
        return {
            'telegram_enabled': False,
            'send_screenshot': False,
            'jpeg_quality': 0.7,
            'max_width': 1280,
        }
    return {
        'telegram_enabled': True,
        'send_screenshot': bool(integ.send_screenshot),
        'jpeg_quality': round(integ.clamped_image_quality() / 100, 2),
        'max_width': integ.clamped_image_max_width(),
    }


def verify_bot(integration: TelegramIntegration, token: str | None = None) -> TelegramIntegration:
    token = (token if token is not None else integration.bot_token or '').strip()
    me = api.get_me(token)
    integration.bot_token = token
    integration.bot_username = me.get('username') or ''
    integration.bot_id = me.get('id')
    integration.last_error = ''
    integration.last_ok_at = timezone.now()
    integration.save(update_fields=[
        'bot_token', 'bot_username', 'bot_id', 'last_error', 'last_ok_at', 'updated_at',
    ])
    return integration


def bind_chat(integration: TelegramIntegration, chat_id: str, chat_title: str = '') -> TelegramIntegration:
    integration.chat_id = str(chat_id).strip()
    integration.chat_title = (chat_title or '')[:200]
    if not integration.connected_at:
        integration.connected_at = timezone.now()
    integration.is_enabled = True
    integration.last_error = ''
    integration.last_ok_at = timezone.now()
    integration.save(update_fields=[
        'chat_id', 'chat_title', 'connected_at', 'is_enabled',
        'last_error', 'last_ok_at', 'updated_at',
    ])
    return integration


def extract_start_payload(text: str) -> str:
    match = START_RE.match((text or '').strip())
    if not match:
        return ''
    raw = (match.group(1) or '').strip()
    if raw.lower().startswith('hb_'):
        return raw[3:].strip().upper()
    return raw.upper()


def find_chat_by_link_code(integration: TelegramIntegration) -> TelegramIntegration | None:
    """Scan getUpdates for /start <link_code> and bind chat."""
    if not integration.has_token:
        raise api.TelegramApiError('Спочатку збережіть bot token')
    code = (integration.link_code or '').upper()
    updates = api.get_updates(integration.bot_token, limit=50, timeout=0)
    matched = None
    max_update_id = None
    for upd in updates:
        max_update_id = upd.get('update_id', max_update_id)
        msg = upd.get('message') or upd.get('edited_message') or {}
        text = msg.get('text') or ''
        payload = extract_start_payload(text)
        chat = msg.get('chat') or {}
        if payload and payload == code and chat.get('id') is not None:
            matched = chat
    # Acknowledge updates so they don't pile up
    if max_update_id is not None:
        try:
            api.get_updates(integration.bot_token, offset=int(max_update_id) + 1, limit=1, timeout=0)
        except api.TelegramApiError:
            pass
    if not matched:
        return None
    title = matched.get('title') or matched.get('username') or matched.get('first_name') or ''
    return bind_chat(integration, matched['id'], title)


def handle_webhook_update(integration: TelegramIntegration, update: dict) -> bool:
    msg = update.get('message') or {}
    text = msg.get('text') or ''
    chat = msg.get('chat') or {}
    payload = extract_start_payload(text)
    if not payload or payload != (integration.link_code or '').upper():
        return False
    if chat.get('id') is None:
        return False
    title = chat.get('title') or chat.get('username') or chat.get('first_name') or ''
    bind_chat(integration, chat['id'], title)
    try:
        api.send_message(
            integration.bot_token,
            chat['id'],
            '✅ HomeBoard підключено. Сповіщення про рух будуть приходити сюди.',
        )
    except api.TelegramApiError as exc:
        logger.warning('telegram welcome failed: %s', exc)
    return True


def send_test_message(integration: TelegramIntegration) -> None:
    if not integration.has_token or not integration.has_chat:
        raise api.TelegramApiError('Потрібні bot token і chat_id')
    api.send_message(
        integration.bot_token,
        integration.chat_id,
        '✅ HomeBoard: тестове повідомлення. Інтеграція Telegram працює.',
    )
    integration.mark_ok()


def notify_motion(event: MotionEvent, *, sectors: list | None = None, score=None) -> bool:
    """Send motion alert to the camera owner's Telegram, if configured."""
    try:
        integration = TelegramIntegration.objects.filter(
            owner_id=event.camera.owner_id,
            is_enabled=True,
            notify_motion=True,
        ).exclude(bot_token='').exclude(chat_id='').first()
    except Exception:
        logger.exception('telegram lookup failed')
        return False
    if not integration or not integration.allows_camera(event.camera):
        return False

    camera_name = event.camera.name
    nums = []
    if sectors:
        try:
            nums = [int(s) + 1 for s in sectors if int(s) >= 0]
        except (TypeError, ValueError):
            nums = []
    sector_bit = f' · сектори {", ".join(map(str, nums))}' if nums else ''
    score_bit = f' · score {float(score):.0f}' if score is not None else ''
    base = public_base_url() or 'https://homeboard.secboard.online'
    viewer_url = f'{base}/viewer/'
    recordings_url = f'{base}/recordings/'
    lines = [
        f'🚨 Рух: {camera_name}{sector_bit}{score_bit}',
        event.detected_at.strftime('%H:%M:%S %d.%m.%Y'),
        '',
        f'👁 Live: {viewer_url}',
    ]
    if integration.send_video_link:
        lines.append(f'🎬 Записи: {recordings_url}')
    text = '\n'.join(lines)

    try:
        if integration.send_screenshot and event.thumbnail:
            try:
                photo = prepare_telegram_jpeg(
                    event.thumbnail.path,
                    quality=integration.clamped_image_quality(),
                    max_width=integration.clamped_image_max_width(),
                )
            except Exception:
                logger.exception('telegram image prepare failed; using original')
                with open(event.thumbnail.path, 'rb') as fh:
                    photo = fh.read()
            api.send_photo(
                integration.bot_token,
                integration.chat_id,
                caption=text[:1024],
                photo_bytes=photo,
            )
        else:
            api.send_message(integration.bot_token, integration.chat_id, text)
        integration.mark_ok()
        return True
    except api.TelegramApiError as exc:
        logger.warning('telegram notify failed: %s', exc)
        integration.mark_error(str(exc))
        return False
    except Exception as exc:
        logger.exception('telegram notify failed')
        integration.mark_error(str(exc))
        return False


def notify_recording(recording) -> bool:
    """Send follow-up Telegram message with playback link after clip upload."""
    try:
        integration = TelegramIntegration.objects.filter(
            owner_id=recording.camera.owner_id,
            is_enabled=True,
            notify_motion=True,
        ).exclude(bot_token='').exclude(chat_id='').first()
    except Exception:
        logger.exception('telegram lookup failed')
        return False
    if not integration or not integration.send_video_link:
        return False
    if not integration.allows_camera(recording.camera):
        return False

    base = public_base_url() or 'https://homeboard.secboard.online'
    play_url = f'{base}/recordings/{recording.id}/'
    viewer_url = f'{base}/viewer/'
    text = (
        f'🎬 Відео з камери «{recording.camera.name}»\n'
        f'{recording.started_at.strftime("%H:%M:%S %d.%m.%Y")}\n\n'
        f'▶ Перегляд: {play_url}\n'
        f'👁 Live: {viewer_url}'
    )
    try:
        api.send_message(integration.bot_token, integration.chat_id, text)
        integration.mark_ok()
        return True
    except api.TelegramApiError as exc:
        logger.warning('telegram recording notify failed: %s', exc)
        integration.mark_error(str(exc))
        return False
    except Exception as exc:
        logger.exception('telegram recording notify failed')
        integration.mark_error(str(exc))
        return False
