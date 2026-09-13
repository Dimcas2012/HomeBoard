from django.contrib import admin

from .models import MotionEvent


@admin.register(MotionEvent)
class MotionEventAdmin(admin.ModelAdmin):
    list_display = ('camera', 'detected_at', 'note')
    list_filter = ('detected_at',)
