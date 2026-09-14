from django.contrib import admin

from .models import TelegramIntegration


@admin.register(TelegramIntegration)
class TelegramIntegrationAdmin(admin.ModelAdmin):
    list_display = (
        'owner', 'bot_username', 'chat_id', 'is_enabled',
        'notify_motion', 'notify_all_cameras', 'image_quality', 'last_ok_at',
    )
    list_filter = ('is_enabled', 'notify_motion', 'notify_all_cameras', 'send_screenshot')
    search_fields = ('owner__username', 'bot_username', 'chat_id', 'link_code')
    filter_horizontal = ('cameras',)
    readonly_fields = (
        'link_code', 'webhook_secret', 'bot_id', 'connected_at',
        'last_ok_at', 'last_error', 'created_at', 'updated_at',
    )
