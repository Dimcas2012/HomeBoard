from django.contrib import admin

from .models import Camera, PairingCode


@admin.register(Camera)
class CameraAdmin(admin.ModelAdmin):
    list_display = ('name', 'owner', 'source_type', 'is_online', 'last_seen')
    list_filter = ('source_type', 'is_online')
    search_fields = ('name', 'owner__username')


@admin.register(PairingCode)
class PairingCodeAdmin(admin.ModelAdmin):
    list_display = ('code', 'owner', 'camera_name', 'expires_at', 'used_at')
    search_fields = ('code', 'owner__username')
