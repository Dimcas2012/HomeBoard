"""Minimal Telegram Bot API client (urllib — no extra deps)."""

from __future__ import annotations

import json
import logging
import secrets
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)

API_ROOT = 'https://api.telegram.org'


class TelegramApiError(Exception):
    def __init__(self, message: str, status: int | None = None, payload: dict | None = None):
        super().__init__(message)
        self.status = status
        self.payload = payload or {}


def _request(token: str, method: str, payload: dict | None = None, timeout: int = 20) -> dict[str, Any]:
    if not token or ':' not in token:
        raise TelegramApiError('Невірний bot token')
    url = f'{API_ROOT}/bot{token}/{method}'
    data = None
    headers = {'Accept': 'application/json'}
    if payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method='POST' if data else 'GET')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8')
            parsed = json.loads(body or '{}')
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode('utf-8', errors='replace')
        try:
            parsed = json.loads(raw or '{}')
        except json.JSONDecodeError:
            parsed = {'description': raw or str(exc)}
        raise TelegramApiError(
            parsed.get('description') or f'HTTP {exc.code}',
            status=exc.code,
            payload=parsed,
        ) from exc
    except urllib.error.URLError as exc:
        raise TelegramApiError(f'Мережа: {exc.reason}') from exc
    except TimeoutError as exc:
        raise TelegramApiError('Timeout Telegram API') from exc

    if not parsed.get('ok'):
        raise TelegramApiError(parsed.get('description') or 'Telegram API error', payload=parsed)
    return parsed.get('result')


def get_me(token: str) -> dict[str, Any]:
    return _request(token, 'getMe')


def send_message(token: str, chat_id: str | int, text: str, *, disable_preview: bool = True) -> dict[str, Any]:
    return _request(token, 'sendMessage', {
        'chat_id': chat_id,
        'text': text,
        'disable_web_page_preview': disable_preview,
    })


def send_photo(
    token: str,
    chat_id: str | int,
    photo_url: str | None = None,
    *,
    caption: str = '',
    photo_bytes: bytes | None = None,
    filename: str = 'motion.jpg',
) -> dict[str, Any]:
    if photo_bytes is not None:
        return _send_multipart(
            token,
            'sendPhoto',
            fields={'chat_id': str(chat_id), 'caption': caption[:1024]},
            file_field='photo',
            filename=filename,
            file_bytes=photo_bytes,
            content_type='image/jpeg',
        )
    if not photo_url:
        raise TelegramApiError('Немає фото')
    return _request(token, 'sendPhoto', {
        'chat_id': chat_id,
        'photo': photo_url,
        'caption': caption[:1024],
    })


def get_updates(token: str, *, offset: int | None = None, limit: int = 50, timeout: int = 0) -> list[dict]:
    payload: dict[str, Any] = {'limit': limit, 'timeout': timeout}
    if offset is not None:
        payload['offset'] = offset
    result = _request(token, 'getUpdates', payload, timeout=max(15, timeout + 5))
    return result if isinstance(result, list) else []


def set_webhook(token: str, url: str, secret_token: str = '') -> dict[str, Any]:
    payload: dict[str, Any] = {
        'url': url,
        'allowed_updates': ['message'],
        'drop_pending_updates': False,
    }
    if secret_token:
        payload['secret_token'] = secret_token
    return _request(token, 'setWebhook', payload)


def delete_webhook(token: str) -> dict[str, Any]:
    return _request(token, 'deleteWebhook', {'drop_pending_updates': False})


def _send_multipart(
    token: str,
    method: str,
    *,
    fields: dict[str, str],
    file_field: str,
    filename: str,
    file_bytes: bytes,
    content_type: str,
) -> dict[str, Any]:
    boundary = f'----HomeBoard{secrets_token()}'
    body = bytearray()
    for key, value in fields.items():
        body.extend(f'--{boundary}\r\n'.encode())
        body.extend(f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        body.extend(str(value).encode('utf-8'))
        body.extend(b'\r\n')
    body.extend(f'--{boundary}\r\n'.encode())
    body.extend(
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'.encode()
    )
    body.extend(f'Content-Type: {content_type}\r\n\r\n'.encode())
    body.extend(file_bytes)
    body.extend(b'\r\n')
    body.extend(f'--{boundary}--\r\n'.encode())

    url = f'{API_ROOT}/bot{token}/{method}'
    req = urllib.request.Request(
        url,
        data=bytes(body),
        headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}',
            'Accept': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            parsed = json.loads(resp.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode('utf-8', errors='replace')
        try:
            parsed = json.loads(raw or '{}')
        except json.JSONDecodeError:
            parsed = {'description': raw or str(exc)}
        raise TelegramApiError(parsed.get('description') or f'HTTP {exc.code}', status=exc.code, payload=parsed) from exc

    if not parsed.get('ok'):
        raise TelegramApiError(parsed.get('description') or 'Telegram API error', payload=parsed)
    return parsed.get('result')


def secrets_token() -> str:
    return secrets.token_hex(8)


def deep_link(bot_username: str, link_code: str) -> str:
    user = (bot_username or '').lstrip('@')
    if not user:
        return ''
    start = urllib.parse.quote(f'hb_{link_code}')
    return f'https://t.me/{user}?start={start}'
