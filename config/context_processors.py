from django.conf import settings


_STATIC_FILES = (
    ('static', 'css', 'homeboard.css'),
    ('static', 'js', 'viewer.js'),
    ('static', 'js', 'camera.js'),
    ('static', 'js', 'webrtc_common.js'),
    ('static', 'js', 'local_store.js'),
    ('static', 'js', 'analytics_phone.js'),
)


def static_bust_value() -> str:
    latest = 0
    for parts in _STATIC_FILES:
        path = settings.BASE_DIR.joinpath(*parts)
        try:
            latest = max(latest, int(path.stat().st_mtime))
        except OSError:
            pass
    return str(latest or 1)


def static_bust(request):
    return {'static_bust': static_bust_value()}
