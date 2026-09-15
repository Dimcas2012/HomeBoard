"""Ollama vision/text summarization for detection events."""

from __future__ import annotations

import json
import logging
import urllib.request

from django.conf import settings

logger = logging.getLogger(__name__)


def ollama_available() -> bool:
    base = getattr(settings, 'OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/')
    try:
        req = urllib.request.Request(f'{base}/api/tags', method='GET')
        with urllib.request.urlopen(req, timeout=2) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def summarize_image(path: str, *, classes: list[str], prompt: str | None = None) -> str:
    """
    Ask local Ollama for a short Ukrainian description.
    Falls back to empty string on failure.

    Uses /api/generate — moondream (and some other VLMs) hang/timeout on /api/chat+images on CPU.
    """
    base = getattr(settings, 'OLLAMA_URL', 'http://127.0.0.1:11434').rstrip('/')
    model = getattr(settings, 'OLLAMA_VISION_MODEL', 'moondream')
    labels = ', '.join(classes) if classes else 'object'
    text = prompt or (
        f'Коротко українською (1-2 речення) опиши сцену охорони. '
        f'Детектор вже бачить: {labels}. Без води.'
    )
    payload = {
        'model': model,
        'stream': False,
        'prompt': text,
        'images': [_file_b64_resized(path)],
        'options': {
            'num_predict': int(getattr(settings, 'OLLAMA_NUM_PREDICT', 48) or 48),
            'temperature': 0.2,
        },
    }
    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            f'{base}/api/generate',
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=float(getattr(settings, 'OLLAMA_TIMEOUT', 300))) as resp:
            body = json.loads(resp.read().decode('utf-8'))
        msg = body.get('response') or ''
        return str(msg).strip()[:800]
    except Exception as exc:
        logger.warning('ollama summarize failed: %s', exc)
        return ''


def _file_b64_resized(path: str, max_side: int = 512, quality: int = 60) -> str:
    """Shrink JPEG before vision API — huge speed win on CPU."""
    import base64
    import io

    from PIL import Image

    with Image.open(path) as img:
        img = img.convert('RGB')
        w, h = img.size
        scale = min(1.0, float(max_side) / max(w, h))
        if scale < 1.0:
            img = img.resize(
                (max(1, int(w * scale)), max(1, int(h * scale))),
                Image.Resampling.BILINEAR,
            )
        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode('ascii')
