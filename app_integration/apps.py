from django.apps import AppConfig


class AppIntegrationConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'app_integration'
    verbose_name = 'Integrations'
