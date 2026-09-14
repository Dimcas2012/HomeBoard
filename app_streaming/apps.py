from django.apps import AppConfig


class AppStreamingConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'app_streaming'

    def ready(self):
        # Channel groups die with the process; in-memory presence must reset too.
        from app_streaming import presence
        presence.clear_all()
