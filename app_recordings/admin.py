from django.contrib import admin

from .models import Recording


@admin.register(Recording)
class RecordingAdmin(admin.ModelAdmin):
    list_display = ('id', 'camera', 'trigger', 'started_at', 'size_bytes')
    list_filter = ('trigger',)
