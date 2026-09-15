from django.contrib import admin

from .models import AnalyticsFrameJob, CameraAnalyticsSettings, DetectionEvent


@admin.register(CameraAnalyticsSettings)
class CameraAnalyticsSettingsAdmin(admin.ModelAdmin):
    list_display = ('camera', 'enabled', 'trigger_mode', 'phone_assist', 'summarize', 'fps', 'updated_at')
    list_filter = ('enabled', 'trigger_mode', 'phone_assist', 'summarize')


@admin.register(AnalyticsFrameJob)
class AnalyticsFrameJobAdmin(admin.ModelAdmin):
    list_display = ('id', 'camera', 'status', 'source', 'created_at', 'finished_at')
    list_filter = ('status', 'source')
    readonly_fields = ('created_at', 'finished_at')


@admin.register(DetectionEvent)
class DetectionEventAdmin(admin.ModelAdmin):
    list_display = ('id', 'camera', 'classes', 'score', 'started_at', 'notified')
    list_filter = ('notified',)
    search_fields = ('summary',)
