import json

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.shortcuts import render
from django.views.decorators.http import require_GET

from app_cameras.models import Camera, PairingCode


def _static_bust() -> str:
    """Query-string version so browsers refetch JS despite nginx immutable cache."""
    files = [
        settings.BASE_DIR / 'static' / 'js' / 'viewer.js',
        settings.BASE_DIR / 'static' / 'js' / 'camera.js',
        settings.BASE_DIR / 'static' / 'js' / 'webrtc_common.js',
        settings.BASE_DIR / 'static' / 'js' / 'local_store.js',
    ]
    latest = 0
    for path in files:
        try:
            latest = max(latest, int(path.stat().st_mtime))
        except OSError:
            pass
    return str(latest or 1)


def _webrtc_ctx():
    return {
        'mediamtx_webrtc_url': settings.MEDIAMTX_WEBRTC_URL,
        'webrtc_ice_servers_json': json.dumps(settings.WEBRTC_ICE_SERVERS),
        'static_bust': _static_bust(),
    }


@login_required
@require_GET
def viewer_index(request):
    cameras = Camera.objects.filter(owner=request.user)
    return render(request, 'app_viewer/viewer.html', {
        'cameras': cameras,
        **_webrtc_ctx(),
    })


@require_GET
def camera_mode(request):
    """Phone/PC browser camera page — pairing then stream."""
    return render(request, 'app_viewer/camera.html', _webrtc_ctx())


@login_required
@require_GET
def settings_panel(request):
    cameras = Camera.objects.filter(owner=request.user)
    codes = [
        p for p in PairingCode.objects.filter(owner=request.user, used_at__isnull=True)
        if p.is_valid
    ]
    return render(request, 'app_viewer/settings.html', {
        'cameras': cameras,
        'pairing_codes': codes,
        **_webrtc_ctx(),
    })
