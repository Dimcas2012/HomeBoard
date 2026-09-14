from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from django.views.generic import RedirectView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('favicon.ico', RedirectView.as_view(url='/static/favicon.ico', permanent=True)),
    path('', RedirectView.as_view(pattern_name='viewer:index', permanent=False)),
    path('accounts/', include('app_accounts.urls')),
    path('cameras/', include('app_cameras.urls')),
    path('viewer/', include('app_viewer.urls')),
    path('camera/', include('app_viewer.camera_urls')),
    path('motion/', include('app_motion.urls')),
    path('recordings/', include('app_recordings.urls')),
    path('integration/', include('app_integration.urls')),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATICFILES_DIRS[0])
