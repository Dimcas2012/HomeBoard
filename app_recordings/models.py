from django.conf import settings
from django.db import models
from django.db.models import Sum
from django.utils import timezone


class Recording(models.Model):
    class Trigger(models.TextChoices):
        MANUAL = 'manual', 'Manual'
        MOTION = 'motion', 'Motion'
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
    def enforce_retention(cls, owner):
        days = settings.RECORDING_RETENTION_DAYS
        cutoff = timezone.now() - timezone.timedelta(days=days)
        old = cls.objects.filter(camera__owner=owner, started_at__lt=cutoff)
        for rec in old:
            if rec.file:
                rec.file.delete(save=False)
            rec.delete()

        max_bytes = int(settings.RECORDING_MAX_GB * 1024 ** 3)
        qs = cls.objects.filter(camera__owner=owner).order_by('started_at')
        total = qs.aggregate(s=Sum('size_bytes'))['s'] or 0
        for rec in qs:
            if total <= max_bytes:
                break
            total -= rec.size_bytes
            if rec.file:
                rec.file.delete(save=False)
            rec.delete()
