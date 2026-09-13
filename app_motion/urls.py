from django.urls import path

from . import views

app_name = 'motion'

urlpatterns = [
    path('api/report/', views.report_motion, name='api_report'),
    path('api/recent/', views.recent_motion, name='api_recent'),
]
