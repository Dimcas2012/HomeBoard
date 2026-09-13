import secrets
import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone


def generate_device_token():
    return secrets.token_urlsafe(32)


def generate_pairing_code(length=6):
    # Без неоднозначних символів 0/O, 1/I/L
    alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(length))


class Camera(models.Model):
    class SourceType(models.TextChoices):
        BROWSER = 'browser', 'Browser'
        RTSP = 'rtsp', 'RTSP / IP'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='cameras',
    )
    name = models.CharField(max_length=120)
    device_token = models.CharField(max_length=64, unique=True, default=generate_device_token)
    source_type = models.CharField(
        max_length=20,
        choices=SourceType.choices,
        default=SourceType.BROWSER,
    )
    rtsp_url = models.CharField(max_length=500, blank=True, default='')
    mediamtx_path = models.CharField(max_length=120, blank=True, default='')
    is_online = models.BooleanField(default=False)
    last_seen = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f'{self.name} ({self.owner})'

    def mark_online(self):
        self.is_online = True
        self.last_seen = timezone.now()
        self.save(update_fields=['is_online', 'last_seen'])

    def mark_offline(self):
        self.is_online = False
        self.last_seen = timezone.now()
        self.save(update_fields=['is_online', 'last_seen'])

    @property
    def webrtc_play_url(self):
        """MediaMTX WHEP endpoint for RTSP cameras."""
        if self.source_type != self.SourceType.RTSP:
            return ''
        path = self.mediamtx_path or str(self.id)
        base = settings.MEDIAMTX_WEBRTC_URL.rstrip('/')
        return f'{base}/{path}/whep'


class PairingCode(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='pairing_codes',
    )
    code = models.CharField(max_length=12, unique=True, default=generate_pairing_code)
    camera_name = models.CharField(max_length=120, default='Camera')
    expires_at = models.DateTimeField()
    used_at = models.DateTimeField(null=True, blank=True)
    created_camera = models.ForeignKey(
        Camera,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='pairing_origin',
    )

    class Meta:
        ordering = ['-expires_at']

    def __str__(self):
        return self.code

    @property
    def is_valid(self):
        return self.used_at is None and self.expires_at > timezone.now()

    @classmethod
    def create_for_user(cls, user, camera_name='Camera', minutes=60):
        return cls.objects.create(
            owner=user,
            camera_name=camera_name,
            expires_at=timezone.now() + timedelta(minutes=minutes),
            code=generate_pairing_code(),
        )

    def consume(self):
        """Activate pairing. If already used, re-return existing camera credentials."""
        from django.db import transaction

        with transaction.atomic():
            pairing = (
                PairingCode.objects.select_for_update()
                .select_related('created_camera')
                .get(pk=self.pk)
            )
            if pairing.created_camera_id:
                return pairing.created_camera

            if pairing.used_at is not None:
                raise ValueError('Код уже використано')

            if pairing.expires_at <= timezone.now():
                raise ValueError('Код прострочений — створіть новий у Камерах')

            camera = Camera.objects.create(
                owner=pairing.owner,
                name=pairing.camera_name,
                source_type=Camera.SourceType.BROWSER,
            )
            pairing.used_at = timezone.now()
            pairing.created_camera = camera
            pairing.save(update_fields=['used_at', 'created_camera'])
            return camera
