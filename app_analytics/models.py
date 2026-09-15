import json

from django.conf import settings
from django.db import models
from django.utils import timezone


DEFAULT_CLASSES = ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'dog', 'cat']

# Full YOLOv8 / COCO-80 class list (selectable in UI).
COCO_CLASSES = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
    'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
]


def default_classes():
    return list(DEFAULT_CLASSES)


def all_detectable_classes():
    return list(COCO_CLASSES)


def default_zones():
    # 4x3 sectors, all on (same layout as Motion)
    return [True] * 12


class CameraAnalyticsSettings(models.Model):
    class TriggerMode(models.TextChoices):
        MOTION = 'motion', 'Після motion/sound'
        CONTINUOUS = 'continuous', 'Постійно (низький fps)'

    camera = models.OneToOneField(
        'app_cameras.Camera',
        on_delete=models.CASCADE,
        related_name='analytics_settings',
    )
    enabled = models.BooleanField(default=False)
    classes = models.JSONField(default=default_classes)
    min_confidence = models.FloatField(default=0.45)
    fps = models.FloatField(
        default=1.0,
        help_text='Цільовий fps ingest на CPU (0.5–2).',
    )
    zones = models.JSONField(default=default_zones)
    phone_assist = models.BooleanField(
        default=False,
        help_text='Легка on-device детекція перед upload.',
    )
    summarize = models.BooleanField(
        default=False,
        help_text='AI-опис події через Ollama (якщо доступний).',
    )
    trigger_mode = models.CharField(
        max_length=20,
        choices=TriggerMode.choices,
        default=TriggerMode.MOTION,
    )
    cooldown_sec = models.PositiveIntegerField(default=20)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Camera analytics settings'
        verbose_name_plural = 'Camera analytics settings'

    def __str__(self):
        return f'Analytics({self.camera_id}, on={self.enabled})'

    @classmethod
    def for_camera(cls, camera):
        obj, _ = cls.objects.get_or_create(camera=camera)
        return obj

    def clamped_fps(self) -> float:
        return max(0.5, min(2.0, float(self.fps or 1.0)))

    def clamped_confidence(self) -> float:
        return max(0.15, min(0.95, float(self.min_confidence or 0.45)))

    def class_list(self) -> list[str]:
        raw = self.classes if isinstance(self.classes, list) else default_classes()
        return [str(c).strip().lower() for c in raw if str(c).strip()]

    def zone_list(self) -> list[bool]:
        raw = self.zones if isinstance(self.zones, list) else default_zones()
        zones = [bool(z) for z in raw[:12]]
        while len(zones) < 12:
            zones.append(True)
        return zones


class AnalyticsFrameJob(models.Model):
    class Status(models.TextChoices):
        PENDING = 'pending', 'Pending'
        RUNNING = 'running', 'Running'
        DONE = 'done', 'Done'
        FAILED = 'failed', 'Failed'
        SKIPPED = 'skipped', 'Skipped'

    camera = models.ForeignKey(
        'app_cameras.Camera',
        on_delete=models.CASCADE,
        related_name='analytics_jobs',
    )
    image = models.FileField(upload_to='analytics/frames/')
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING, db_index=True)
    source = models.CharField(max_length=32, blank=True, default='motion')
    motion_event_id = models.BigIntegerField(null=True, blank=True)
    phone_hints = models.JSONField(default=list, blank=True)
    error = models.TextField(blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['created_at']
        indexes = [
            models.Index(fields=['status', 'created_at']),
        ]

    def __str__(self):
        return f'Job {self.id} {self.status} cam={self.camera_id}'


class DetectionEvent(models.Model):
    camera = models.ForeignKey(
        'app_cameras.Camera',
        on_delete=models.CASCADE,
        related_name='detection_events',
    )
    started_at = models.DateTimeField(default=timezone.now, db_index=True)
    ended_at = models.DateTimeField(null=True, blank=True)
    classes = models.JSONField(default=list)
    track_ids = models.JSONField(default=list)
    score = models.FloatField(default=0)
    boxes = models.JSONField(default=list)
    thumbnail = models.FileField(upload_to='analytics/thumbs/', blank=True, null=True)
    recording = models.ForeignKey(
        'app_recordings.Recording',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='detection_events',
    )
    motion_event = models.ForeignKey(
        'app_motion.MotionEvent',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='detection_events',
    )
    summary = models.TextField(blank=True, default='')
    notified = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-started_at']

    def __str__(self):
        return f'Detection {self.id} {self.classes} @ {self.started_at}'

    def classes_label(self) -> str:
        if isinstance(self.classes, list) and self.classes:
            return ', '.join(str(c) for c in self.classes)
        return 'object'

    def boxes_json(self) -> str:
        try:
            return json.dumps(self.boxes or [])
        except (TypeError, ValueError):
            return '[]'
