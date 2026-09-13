from django.urls import path

from . import views

urlpatterns = [
    path('', views.camera_mode, name='camera_mode'),
]
