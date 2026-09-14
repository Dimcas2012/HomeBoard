import secrets

from django.conf import settings
from django.db import models
from django.utils import timezone


def generate_link_code(length=8):
    alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def generate_webhook_secret():
    return secrets.token_urlsafe(24)


class TelegramIntegration(models.Model):
    """Per-user Telegram bot connection for HomeBoard alerts."""

    owner = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='telegram_integration',
    )
    bot_token = models.CharField(max_length=120, blank=True, default='')
    bot_username = models.CharField(max_length=120, blank=True, default='')
    bot_id = models.BigIntegerField(null=True, blank=True)
    chat_id = models.CharField(max_length=64, blank=True, default='')
    chat_title = models.CharField(max_length=200, blank=True, default='')
    link_code = models.CharField(max_length=16, default=generate_link_code, db_index=True)
    webhook_secret = models.CharField(max_length=64, default=generate_webhook_secret, unique=True)

    is_enabled = models.BooleanField(default=False)
    notify_motion = models.BooleanField(default=True)
    notify_camera_offline = models.BooleanField(default=False)
    notify_all_cameras = models.BooleanField(
        default=True,
        help_text='Якщо увімкнено — сповіщення з усіх камер; інакше лише вибрані.',
    )
    cameras = models.ManyToManyField(
        'app_cameras.Camera',
        blank=True,
        related_name='telegram_integrations',
        help_text='Камери для сповіщень (якщо не «усі»).',
    )
    send_screenshot = models.BooleanField(default=True)
    send_video_link = models.BooleanField(default=True)
    image_quality = models.PositiveSmallIntegerField(
        default=70,
        help_text='JPEG якість для Telegram (10–95).',
    )
    image_max_width = models.PositiveIntegerField(
        default=1280,
        help_text='Максимальна ширина скріна в пікселях.',
    )

    last_error = models.TextField(blank=True, default='')
    last_ok_at = models.DateTimeField(null=True, blank=True)
    connected_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = 'Telegram integration'
        verbose_name_plural = 'Telegram integrations'

    def __str__(self):
        user = getattr(self.owner, 'username', self.owner_id)
        status = 'on' if self.is_ready else 'off'
        return f'Telegram({user}, {status})'

    @property
    def has_token(self):
        return bool(self.bot_token and ':' in self.bot_token)

    @property
    def has_chat(self):
        return bool(str(self.chat_id or '').strip())

    @property
    def is_ready(self):
        return self.is_enabled and self.has_token and self.has_chat

    def allows_camera(self, camera) -> bool:
        if not self.notify_motion:
            return False
        if self.notify_all_cameras:
            return True
        camera_id = getattr(camera, 'pk', camera)
        return self.cameras.filter(pk=camera_id).exists()

    def clamped_image_quality(self) -> int:
        return max(10, min(95, int(self.image_quality or 70)))

    def clamped_image_max_width(self) -> int:
        allowed = {640, 960, 1280, 1600, 1920}
        width = int(self.image_max_width or 1280)
        if width in allowed:
            return width
        # nearest
        return min(allowed, key=lambda x: abs(x - width))

    def masked_token(self):
        token = self.bot_token or ''
        if len(token) < 12:
            return '—' if not token else '••••'
        return f'{token[:6]}…{token[-4:]}'

    def rotate_link_code(self):
        self.link_code = generate_link_code()
        self.save(update_fields=['link_code', 'updated_at'])
        return self.link_code

    def mark_ok(self):
        self.last_error = ''
        self.last_ok_at = timezone.now()
        self.save(update_fields=['last_error', 'last_ok_at', 'updated_at'])

    def mark_error(self, message: str):
        self.last_error = (message or 'Telegram error')[:1000]
        self.save(update_fields=['last_error', 'updated_at'])
