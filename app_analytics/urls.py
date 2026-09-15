from django.urls import path

from . import views

app_name = 'analytics'

urlpatterns = [
    path('', views.events_page, name='events'),
    path('api/frame/', views.api_frame, name='api_frame'),
    path('api/events/', views.api_events, name='api_events'),
    path('api/status/', views.api_status, name='api_status'),
    path('api/device/settings/', views.api_device_settings, name='api_device_settings'),
    path('api/cameras/<uuid:camera_id>/settings/', views.api_camera_settings, name='api_camera_settings'),
    path('api/internal_broadcast/', views.api_internal_broadcast, name='api_internal_broadcast'),
    path('api/link_recording/', views.api_link_recording, name='api_link_recording'),
]
