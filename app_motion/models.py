from django.conf import settings
from django.db import models


class MotionEvent(models.Model):
    camera = models.ForeignKey(
        'app_cameras.Camera',
        on_delete=models.CASCADE,
        related_name='motion_events',
    )
    detected_at = models.DateTimeField(auto_now_add=True)
    thumbnail = models.ImageField(upload_to='thumbnails/', blank=True, null=True)
    note = models.CharField(max_length=255, blank=True, default='')

    class Meta:
        ordering = ['-detected_at']

    def __str__(self):
        return f'Motion {self.camera_id} @ {self.detected_at}'
