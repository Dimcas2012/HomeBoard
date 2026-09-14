from django.contrib import admin

from .models import Recording, RecordingStorageSettings


@admin.register(Recording)
class RecordingAdmin(admin.ModelAdmin):
    list_display = ('id', 'camera', 'trigger', 'started_at', 'size_bytes')
    list_filter = ('trigger',)


@admin.register(RecordingStorageSettings)
class RecordingStorageSettingsAdmin(admin.ModelAdmin):
    list_display = ('owner', 'cyclic_overwrite', 'max_gb', 'retention_days', 'updated_at')
    list_filter = ('cyclic_overwrite',)
    search_fields = ('owner__username',)
