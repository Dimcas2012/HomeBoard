"""YOLO CPU inference wrapper."""

from __future__ import annotations

import logging
import threading
from pathlib import Path

from django.conf import settings

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_model = None
_model_error = ''


def model_status() -> dict:
    return {
        'loaded': _model is not None,
        'error': _model_error,
        'device': getattr(settings, 'ANALYTICS_DEVICE', 'cpu'),
        'weights': getattr(settings, 'ANALYTICS_YOLO_WEIGHTS', 'yolov8n.pt'),
    }


def get_model():
    global _model, _model_error
    if _model is not None:
        return _model
    with _lock:
        if _model is not None:
            return _model
        try:
            from ultralytics import YOLO
            weights = getattr(settings, 'ANALYTICS_YOLO_WEIGHTS', 'yolov8n.pt')
            # Prefer local cache under BASE_DIR/models
            local = Path(settings.BASE_DIR) / 'models' / Path(weights).name
            path = str(local if local.exists() else weights)
            _model = YOLO(path)
            _model_error = ''
            logger.info('analytics YOLO loaded: %s', path)
        except Exception as exc:
            _model = None
            _model_error = str(exc)
            logger.exception('YOLO load failed')
            raise
        return _model


def detect_image(path: str, *, conf: float = 0.45, classes: list[str] | None = None) -> list[dict]:
    """
    Run detection on an image file.
    Returns list of {cls, conf, xyxy:[x1,y1,x2,y2], cx, cy} in pixel coords.
    """
    model = get_model()
    want = {c.lower() for c in (classes or []) if c}
    results = model.predict(
        source=path,
        conf=conf,
        device=getattr(settings, 'ANALYTICS_DEVICE', 'cpu'),
        verbose=False,
        imgsz=int(getattr(settings, 'ANALYTICS_IMGSZ', 640) or 640),
    )
    out = []
    if not results:
        return out
    r0 = results[0]
    names = r0.names or {}
    boxes = getattr(r0, 'boxes', None)
    if boxes is None:
        return out
    for box in boxes:
        cls_id = int(box.cls[0].item()) if box.cls is not None else -1
        label = str(names.get(cls_id, cls_id)).lower()
        if want and label not in want:
            continue
        conf_v = float(box.conf[0].item()) if box.conf is not None else 0.0
        xyxy = box.xyxy[0].tolist()
        x1, y1, x2, y2 = [float(v) for v in xyxy]
        out.append({
            'cls': label,
            'conf': round(conf_v, 4),
            'xyxy': [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            'cx': round((x1 + x2) / 2, 1),
            'cy': round((y1 + y2) / 2, 1),
        })
    return out
