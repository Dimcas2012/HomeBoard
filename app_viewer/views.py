from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.shortcuts import render
from django.views.decorators.http import require_GET

from app_cameras.models import Camera, PairingCode


@login_required
@require_GET
def viewer_index(request):
    cameras = Camera.objects.filter(owner=request.user)
    return render(request, 'app_viewer/viewer.html', {
        'cameras': cameras,
        'mediamtx_webrtc_url': settings.MEDIAMTX_WEBRTC_URL,
    })


@require_GET
def camera_mode(request):
    """Phone/PC browser camera page — pairing then stream."""
    return render(request, 'app_viewer/camera.html')


@login_required
@require_GET
def settings_panel(request):
    cameras = Camera.objects.filter(owner=request.user)
    codes = PairingCode.objects.filter(owner=request.user, used_at__isnull=True)
    return render(request, 'app_viewer/settings.html', {
        'cameras': cameras,
        'pairing_codes': codes,
        'mediamtx_webrtc_url': settings.MEDIAMTX_WEBRTC_URL,
    })
