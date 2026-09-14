from django.urls import path

from . import views

app_name = 'recordings'

urlpatterns = [
    path('', views.recordings_page, name='list'),
    path('api/', views.recordings_api, name='api_list'),
    path('api/upload/', views.upload_recording, name='api_upload'),
    path('api/storage/', views.api_storage_settings, name='api_storage'),
    path('api/purge/', views.api_purge_oldest, name='api_purge'),
    path('<int:recording_id>/', views.playback, name='playback'),
]
