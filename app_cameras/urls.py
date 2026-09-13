from django.urls import path

from . import views

app_name = 'cameras'

urlpatterns = [
    path('api/', views.camera_list_api, name='api_list'),
    path('api/pairing/', views.create_pairing_code, name='api_pairing'),
    path('api/pair/', views.pair_camera, name='api_pair'),
    path('api/rtsp/', views.create_rtsp_camera, name='api_rtsp'),
    path('api/<uuid:camera_id>/delete/', views.delete_camera, name='api_delete'),
]
