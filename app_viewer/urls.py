from django.urls import path

from . import views

app_name = 'viewer'

urlpatterns = [
    path('', views.viewer_index, name='index'),
    path('settings/', views.settings_panel, name='settings'),
]
