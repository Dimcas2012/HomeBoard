from django.urls import path

from . import views

app_name = 'integration'

urlpatterns = [
    path('telegram/', views.telegram_settings, name='telegram'),
    path('api/telegram/status/', views.api_status, name='api_telegram_status'),
    path('api/telegram/save/', views.api_save, name='api_telegram_save'),
    path('api/telegram/verify/', views.api_verify, name='api_telegram_verify'),
    path('api/telegram/find-chat/', views.api_find_chat, name='api_telegram_find_chat'),
    path('api/telegram/test/', views.api_test, name='api_telegram_test'),
    path('api/telegram/rotate-code/', views.api_rotate_code, name='api_telegram_rotate_code'),
    path('api/telegram/disconnect/', views.api_disconnect, name='api_telegram_disconnect'),
    path('api/device/prefs/', views.api_device_prefs, name='api_device_prefs'),
    path('telegram/webhook/<str:secret>/', views.telegram_webhook, name='telegram_webhook'),
]
