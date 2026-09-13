"""Створення Django-додатка з обов'язковим префіксом app_."""

from django.conf import settings
from django.core.management import CommandError, call_command
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Створює додаток з префіксом app_ (наприклад: python manage.py start_app board)'

    def add_arguments(self, parser):
        parser.add_argument(
            'name',
            type=str,
            help='Назва додатка без префікса або з префіксом app_',
        )

    def handle(self, *args, **options):
        prefix = getattr(settings, 'APP_PREFIX', 'app_')
        name = options['name'].strip()

        if not name:
            raise CommandError('Вкажіть назву додатка.')

        if name.startswith(prefix):
            app_name = name
        else:
            app_name = f'{prefix}{name}'

        if not app_name.startswith(prefix):
            raise CommandError(f'Додаток має починатися з "{prefix}".')

        self.stdout.write(f'Створюю додаток: {app_name}')
        call_command('startapp', app_name)
        self.stdout.write(self.style.SUCCESS(
            f'Готово. Додайте "{app_name}" до INSTALLED_APPS у config/settings.py'
        ))
