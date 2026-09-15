from datetime import timedelta

from django.conf import settings
from django.db import models
from django.db.models import Sum
from django.utils import timezone


class RecordingStorageSettings(models.Model):
    """Per-user cyclic overwrite + storage quota for server-side recordings."""

    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='recording_storage',
    )
    cyclic_overwrite = models.BooleanField(
        default=True,
        help_text='Видаляти найстаріші записи при перевищенні ліміту.',
    )
    max_gb = models.FloatField(
        default=10.0,
        help_text='Максимальний обсяг записів на сервері (ГБ).',
    )
    retention_days = models.PositiveIntegerField(
        default=14,
        help_text='Автовидалення записів старших за N днів (0 = вимкнено).',
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = 'Recording storage settings'
        verbose_name_plural = 'Recording storage settings'

    def __str__(self):
        return f'Storage({self.owner_id}, {self.max_gb}GB, cyclic={self.cyclic_overwrite})'

    @classmethod
    def for_user(cls, user):
        defaults = {
            'cyclic_overwrite': True,
            'max_gb': float(getattr(settings, 'RECORDING_MAX_GB', 10) or 10),
            'retention_days': int(getattr(settings, 'RECORDING_RETENTION_DAYS', 14) or 14),
        }
        obj, _ = cls.objects.get_or_create(owner=user, defaults=defaults)
        return obj

    def clamped_max_gb(self) -> float:
        return max(0.5, min(500.0, float(self.max_gb or 10)))

    def max_bytes(self) -> int:
        return int(self.clamped_max_gb() * 1024 ** 3)


class Recording(models.Model):
    class Trigger(models.TextChoices):
        MANUAL = 'manual', 'Manual'
        MOTION = 'motion', 'Motion'
        DETECTION = 'detection', 'AI Detection'
        CONTINUOUS = 'continuous', 'Continuous'

    camera = models.ForeignKey(
        'app_cameras.Camera',
        on_delete=models.CASCADE,
        related_name='recordings',
    )
    started_at = models.DateTimeField(default=timezone.now)
    ended_at = models.DateTimeField(null=True, blank=True)
    file = models.FileField(upload_to='recordings/')
    trigger = models.CharField(max_length=20, choices=Trigger.choices, default=Trigger.MOTION)
    motion_event = models.ForeignKey(
        'app_motion.MotionEvent',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='recordings',
    )
    size_bytes = models.BigIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-started_at']

    def __str__(self):
        return f'Recording {self.id} ({self.camera})'

    @classmethod
    def usage_bytes(cls, owner) -> int:
        return cls.objects.filter(camera__owner=owner).aggregate(s=Sum('size_bytes'))['s'] or 0

    @classmethod
    def enforce_retention(cls, owner):
        storage = RecordingStorageSettings.for_user(owner)

        days = int(storage.retention_days or 0)
        if days > 0:
            cutoff = timezone.now() - timedelta(days=days)
            old = cls.objects.filter(camera__owner=owner, started_at__lt=cutoff)
            for rec in old:
                if rec.file:
                    rec.file.delete(save=False)
                rec.delete()

        if not storage.cyclic_overwrite:
            return

        max_bytes = storage.max_bytes()
        qs = cls.objects.filter(camera__owner=owner).order_by('started_at')
        total = qs.aggregate(s=Sum('size_bytes'))['s'] or 0
        for rec in qs:
            if total <= max_bytes:
                break
            total -= rec.size_bytes
            if rec.file:
                rec.file.delete(save=False)
            rec.delete()
